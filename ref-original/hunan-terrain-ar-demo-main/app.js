import * as THREE from 'three';
import { SITES, GEO_BOUNDS } from './sites.js';
import { createTerrainScan } from './scan-surface.js';
import { setupCameraPreview } from './camera-preview.js';
const referenceObjects = [];

const scanReview = new URLSearchParams(location.search).get('review') === 'scan';
document.body.classList.toggle('scan-review', scanReview);

const sceneHost = document.getElementById('scene');
const readout = document.getElementById('scan-readout');
const hint = document.getElementById('hint');
const errorBox = document.getElementById('error');
const settings = { height: 1.8, distance: 4.4, zoom: 2, lateral: 0, yaw: 0, pitch: 0, idle: true };
const limits = { yaw: 18, pitch: 12 };
const TERRAIN_WIDTH = 4.8;
const TERRAIN_DEPTH = 5.5;
const BASE_VERTICAL_FOV = 48;
const DWELL_SECONDS = 0.5;
const clock = new THREE.Clock();
let renderer, camera, terrain, scanSurface, maskPixels, maskWidth, maskHeight, uniforms;
let clickCount = 0;
let nextIdle = 0;
let sweepStart = -100;
let sweepDirection = 1;
const SWEEP_DURATION = 4.3;
let siteMarkers = [];
let selectedSite = null;
let aimedSite = null;
let terrainHeightAt;
let aimStart = 0;
let storySite = null;
let manualSite = null;
let storyCloseTimer;
let storyStart = 0;
let introPages = [];
const PHOTO_SETS = {
  tl: ['./assets/location-photos-atlas.png', './assets/location-photos-atlas-b.png', './assets/location-photos-atlas-c.png'],
  br: ['./assets/location-photos-atlas-d.png', './assets/location-photos-atlas-e.png', './assets/location-photos-atlas-f.png']
};
// Visual envelopes of the landmark / representative river reach, NOT GIS boundaries.
// Local landmarks are compact; plains are lowland patches; long features are narrow.
// Last two values are DEM elevation metres used to feather away unrelated relief.
const FOCUS_AREAS = {
  zhangjiajie: [.36,.32,.15,100,1500], yuelu: [.20,.23,0,0,700], langshan: [.25,.30,-.16,0,1200],
  hengshan: [.28,.36,-.15,100,1600], hills: [.68,.53,-.12,0,850], xuefeng: [.30,.94,-.32,150,1900],
  'dongting-plain': [.65,.42,.08,0,180], liyang: [.32,.25,0,0,180], 'dongting-lake': [.32,.42,-.18,0,130],
  yuan: [.56,.17,.18,0,1000], xiang: [.16,.57,-.10,0,650]
};
let wasFocusActive = false;

// AR INTEGRATION REQUIRED / 接入 AR 时必须处理真实跟踪位姿抖动：
// 1. Use a shared world/spatial anchor for terrain, icons and card roots.
// 2. Filter the measured anchor position + quaternion (e.g. One Euro + slerp),
//    preserve low-latency camera prediction; do not filter each overlay separately.
// 3. Freeze only brief tracking dropouts, then fade content and request relocalization.
// 4. This browser demo only stabilizes screen-space UI and gaze exit. It does NOT
//    validate actual tracking accuracy. Tune on the final Pad/camera at real scale.
// See AR-INTEGRATION.md and the permanent red reminder in the lower-left corner.
const AR_UI_STABILITY = { deadzonePx: 0.7, responseSeconds: 0.065, exitGraceSeconds: 0.16 };
let aimExitStart = null, previousSiteTime = 0;
let nextReviewRipple = 0;
let localPulseIndex = 0;
let nextGazeWave = 0;
const GAZE_WAVE_INTERVAL = 6.8; // Shader reaches zero at 6.0 s; allow a quiet gap.
let lastCameraMotion = 0, pendingGazeRipple = false;
const gazeRaycaster = new THREE.Raycaster();
const gazeNdc = new THREE.Vector2(0, 0);


function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }

function geoUv(lon, lat) {
  const mercator = degrees => Math.log(Math.tan(Math.PI / 4 + degrees * Math.PI / 360));
  return new THREE.Vector2(
    (lon - GEO_BOUNDS.west) / (GEO_BOUNDS.east - GEO_BOUNDS.west),
    (mercator(lat) - mercator(GEO_BOUNDS.south)) / (mercator(GEO_BOUNDS.north) - mercator(GEO_BOUNDS.south))
  );
}

function setFocusArea(site, time) {
  const [radiusX, radiusY, angle, minHeight, maxHeight] = FOCUS_AREAS[site.id] || [.4,.4,0,0,2076];
  uniforms.uFocusPos.value.copy(geoUv(site.lon, site.lat));
  uniforms.uFocusReach.value = scanSurface.radiusFrom(uniforms.uFocusPos.value);
  sceneHost.dataset.focusReach = uniforms.uFocusReach.value.toFixed(3);
  sceneHost.dataset.focusWavePeriod = ((uniforms.uFocusReach.value+.40)/.68+.85).toFixed(3);
  uniforms.uFocusRadius.value.set(radiusX, radiusY);
  uniforms.uFocusAngle.value = angle;
  uniforms.uFocusBand.value.set(minHeight,maxHeight);
  uniforms.uFocusStart.value = time;
}

function clearManualFocus() {
  if (!manualSite) return;
  manualSite = null;
  if (aimedSite) setFocusArea(aimedSite, clock.getElapsedTime());
}

function textElement(tag, className, value) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  el.textContent = value;
  return el;
}

function detailField(label, value, className = 'detail-block') {
  const block = document.createElement('div');
  block.className = className;
  block.append(textElement('b', '', label), textElement('p', '', value));
  return block;
}

function selectSite(site) {
  selectedSite = site;
  manualSite = site;
  // A click keeps the atlas readable through its carousel; moving the Pad clears it.
  setFocusArea(site, clock.getElapsedTime());
  openStory(site);
  const detail = document.getElementById('site-detail');
  detail.replaceChildren();
  detail.append(
    textElement('span', 'detail-kind', `${site.kind} / REGION ${String(SITES.indexOf(site) + 1).padStart(2, '0')}`),
    textElement('h3', '', site.name),
    textElement('p', 'detail-anchor', `${site.anchor} · ${site.lon.toFixed(3)}° E / ${site.lat.toFixed(3)}° N`),
    textElement('p', 'detail-summary', site.summary)
  );
  const grid = document.createElement('div');
  grid.className = 'detail-grid';
  for (const [label, value] of [['区域角色', site.role], ['自然形态', site.form], ['空间尺度', site.scale], ['自然功能', site.function]]) grid.append(detailField(label, value, ''));
  detail.append(grid);
  for (const [label, value] of [['关键机制', site.mechanism], ['主导过程', site.process], ['系统联系', site.relation], ['科学价值', site.science]]) detail.append(detailField(label, value));
  for (const marker of siteMarkers) marker.listButton.classList.toggle('is-selected', marker.site === site);
  const uv = geoUv(site.lon, site.lat);
  scanAt(uv);
}

function atlasPosition(index) {
  return `${(index % 4) * 100 / 3}% ${Math.floor(index / 4) * 50}%`;
}

function makePhotoCard(site, index, corner) {
  const card = textElement('article', `story-card story-photo story-${corner}`, '');
  const surface = textElement('div', 'story-surface', '');
  const stack = textElement('div', 'story-photo-stack', '');
  for (const atlas of PHOTO_SETS[corner]) {
    const layer = textElement('div', 'story-photo-layer', '');
    layer.style.backgroundImage = `url('${atlas}')`;
    layer.style.backgroundPosition = atlasPosition(index);
    stack.append(layer);
  }
  const caption = textElement('div', 'story-photo-caption', '');
  caption.append(textElement('b', '', site.name), textElement('small', '', '概念影像 · 01 / 03'));
  surface.append(stack, caption);
  card.append(surface);
  return card;
}

function splitIntro(text, limit = 58) {
  const sentences = text.match(/[^。！？；]+[。！？；]?/g) || [text];
  const pages = [];
  let page = '';
  for (const sentence of sentences) {
    if (page && page.length + sentence.length > limit) { pages.push(page); page = ''; }
    if (sentence.length > limit) {
      if (page) { pages.push(page); page = ''; }
      for (let start = 0; start < sentence.length; start += limit) pages.push(sentence.slice(start, start + limit));
    } else page += sentence;
  }
  if (page) pages.push(page);
  return pages;
}

function openStory(site) {
  const story = document.getElementById('site-story');
  const cards = story.querySelector('.story-cards');
  story.classList.toggle('is-narrow', sceneHost.clientWidth < 570);
  clearTimeout(storyCloseTimer);
  story.classList.remove('is-closing');
  if (storySite !== site) {
    story.classList.remove('is-open');
    storySite = site;
    storyStart = clock.getElapsedTime();
    uniforms.uFocusStart.value = storyStart;
    emitLocalPulse(geoUv(site.lon,site.lat),storyStart,.85,'selection');
    introPages = [...splitIntro(site.summary), ...splitIntro(site.mechanism)];
    cards.replaceChildren();
    const index = SITES.indexOf(site);
    const intro = textElement('article', 'story-card story-intro story-tr', '');
    const introSurface = textElement('div', 'story-surface', '');
    introSurface.append(textElement('small', 'story-kicker', ''), textElement('h3', '', site.name), textElement('p', 'story-intro-copy', ''));
    intro.append(introSurface);
    const facts = textElement('article', 'story-card story-facts story-bl', '');
    const factSurface = textElement('div', 'story-surface', '');
    factSurface.append(textElement('small', 'story-kicker', ''), textElement('div', 'story-fact-rows', ''));
    facts.append(factSurface);
    cards.append(makePhotoCard(site, index, 'tl'), intro, facts, makePhotoCard(site, index, 'br'));
    updateStoryPages(storyStart, true);
  }
  const svg = story.querySelector('.story-links');
  if (svg.childElementCount !== 4) {
    svg.replaceChildren(...Array.from({ length: 4 }, () => {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('pathLength', '1');
      return path;
    }));
  }
  const marker = siteMarkers.find(item => item.site === site && item.visible);
  if (marker) layoutStory(marker);
  for (const card of cards.children) void getComputedStyle(card.firstElementChild).transform;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (storySite === site) story.classList.add('is-open');
  }));
}

function closeStory() {
  const story = document.getElementById('site-story');
  story.classList.add('is-closing');
  story.classList.remove('is-open');
  clearTimeout(storyCloseTimer);
  storyCloseTimer = setTimeout(() => {
    if (!story.classList.contains('is-open')) { storySite = null; story.classList.remove('is-closing'); }
  }, 720);
}

function updateStoryPages(time, force = false) {
  if (!storySite) return;
  const story = document.getElementById('site-story');
  const elapsed = Math.max(0, time - storyStart);
  for (const [corner, offset] of [['tl', 0], ['br', 3]]) {
    const card = story.querySelector(`.story-${corner}`);
    if (!card) continue;
    const index = Math.floor((elapsed + offset) / 6) % PHOTO_SETS[corner].length;
    if (force || card.dataset.frame !== String(index)) {
      card.dataset.frame = String(index);
      [...card.querySelectorAll('.story-photo-layer')].forEach((layer, i) => layer.classList.toggle('is-active', i === index));
      card.querySelector('.story-photo-caption small').textContent = `概念影像 · ${String(index + 1).padStart(2, '0')} / 03`;
    }
  }
  const introIndex = Math.floor(elapsed / 6) % introPages.length;
  const intro = story.querySelector('.story-intro');
  if (intro && (force || intro.dataset.page !== String(introIndex))) {
    intro.dataset.page = String(introIndex);
    intro.querySelector('.story-kicker').textContent = `地点介绍 · ${String(introIndex + 1).padStart(2, '0')} / ${String(introPages.length).padStart(2, '0')}`;
    intro.querySelector('.story-intro-copy').textContent = introPages[introIndex];
    intro.classList.remove('page-enter'); void intro.offsetWidth; intro.classList.add('page-enter');
  }
  const facts = story.querySelector('.story-facts');
  const factIndex = Math.floor(elapsed / 6) % 2;
  if (facts && (force || facts.dataset.page !== String(factIndex))) {
    facts.dataset.page = String(factIndex);
    facts.querySelector('.story-kicker').textContent = `关键读数 · 0${factIndex + 1} / 02`;
    const fields = [
      ['◇', '自然形态', storySite.form], ['↗', '空间尺度', storySite.scale],
      ['⌖', '区域角色', storySite.role], ['◎', '自然功能', storySite.function]
    ];
    const rows = facts.querySelector('.story-fact-rows');
    rows.replaceChildren();
    for (const [symbol, label, value] of fields.slice(factIndex * 2, factIndex * 2 + 2)) {
      const row = textElement('div', 'story-fact-row', '');
      row.append(textElement('span', 'story-fact-icon', symbol));
      const copy = textElement('span', 'story-fact-copy', '');
      copy.append(textElement('b', '', label), textElement('span', '', value));
      row.append(copy);
      rows.append(row);
    }
    facts.classList.remove('page-enter'); void facts.offsetWidth; facts.classList.add('page-enter');
  }
}

function layoutStory(marker) {
  const story = document.getElementById('site-story');
  story.classList.toggle('is-narrow', sceneHost.clientWidth < 570);
  const cards = [...story.querySelectorAll('.story-card')];
  if (!cards.length) return;
  const width = sceneHost.clientWidth, height = sceneHost.clientHeight;
  const cx = marker.x, cy = marker.y;
  const cardW = width < 570 ? 138 : 186;
  const cardH = width < 570 ? 112 : 142;
  const margin = width < 570 ? 12 : 22;
  const gap = width < 570 ? 12 : 28;
  const sideOffset = width < 570 ? 62 : 82;
  const minX = margin, maxX = width - cardW - margin;
  let leftX = clamp(cx - cardW - sideOffset, minX, maxX);
  let rightX = clamp(cx + sideOffset, minX, maxX);
  if (rightX < leftX + cardW + gap) {
    if (cx < width / 2) rightX = clamp(leftX + cardW + gap, minX, maxX);
    else leftX = clamp(rightX - cardW - gap, minX, maxX);
  }
  const minY = 80, maxY = height - cardH - 48;
  let topY = clamp(cy - cardH - 66, minY, maxY);
  let bottomY = clamp(cy + 66, minY, maxY);
  if (bottomY < topY + cardH + 12) {
    if (cy < height / 2) bottomY = clamp(topY + cardH + 12, minY, maxY);
    else topY = clamp(bottomY - cardH - 12, minY, maxY);
  }
  const paths = [...story.querySelector('.story-links').children];
  cards.forEach((card, index) => {
    const side = index % 2 === 0 ? -1 : 1;
    const x = side < 0 ? leftX : rightX;
    const y = index < 2 ? topY : bottomY;
    // The card root IS the Bézier endpoint. The surface grows around this
    // shared point, avoiding transform-order/static-position offsets.
    const ex = side < 0 ? x + cardW : x;
    const entryY = index < 2 ? cardH - 22 : 22;
    const ey = y + entryY;
    card.style.transform = `translate3d(${ex}px,${ey}px,0)`;
    card.style.setProperty('--surface-x', `${side < 0 ? -cardW : 0}px`);
    card.style.setProperty('--surface-y', `${-entryY}px`);
    card.style.setProperty('--entry-x', `${side < 0 ? cardW : 0}px`);
    card.style.setProperty('--entry-y', `${entryY}px`);
    card.style.setProperty('--tilt-y', `${side * -3}deg`);
    card.style.setProperty('--tilt-x', `${index < 2 ? -1.5 : 1.5}deg`);
    card.style.setProperty('--delay', `${index * .035}s`);
    card.style.setProperty('--grow-delay', `${.38 + index * .035}s`);
    const sx = cx + side * 34;
    const handle = Math.max(4, Math.abs(ex - sx) * .44);
    const path = paths[index];
    path?.style.setProperty('--delay', `${index * .035}s`);
    // One cubic, horizontal tangents at both endpoints: no Q/L joins or corners.
    path?.setAttribute('d', `M ${sx} ${cy} C ${sx + side * handle} ${cy}, ${ex - side * handle} ${ey}, ${ex} ${ey}`);

  });
  const svg = story.querySelector('.story-links');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
}

function emitLocalPulse(uv,time,strength=.35,source='ambient') {
  const key = `${source}Pulses`;
  sceneHost.dataset[key] = String(Number(sceneHost.dataset[key] || 0) + 1);
  uniforms.uLocalPulses.value[localPulseIndex].set(uv.x,uv.y,time,strength);
  localPulseIndex=(localPulseIndex+1)%uniforms.uLocalPulses.value.length;
}

function updateAmbientFeedback(time,focusActive) {
  // Each wave fixes its origin at the current screen-centre DEM hit. No random
  // sweep or random origin. Previous wave is fully gone before the next begins.
  const enabled = settings.idle && (!scanReview || document.getElementById('review-ripples').checked);
  if (focusActive || !enabled || time < nextGazeWave || time-lastCameraMotion < .20) return;
  gazeRaycaster.setFromCamera(gazeNdc,camera);
  const hit=gazeRaycaster.intersectObject(terrain,false).find(item=>item.uv&&maskAt(item.uv));
  if (!hit) { nextGazeWave=time+.15; return; }
  uniforms.uClickPos.value.copy(hit.uv);
  uniforms.uClickStart.value=time;
  nextGazeWave=time+GAZE_WAVE_INTERVAL;
  sceneHost.dataset.gazePulses=String(Number(sceneHost.dataset.gazePulses||0)+1);
  sceneHost.dataset.waveStarted=time.toFixed(3);
  sceneHost.dataset.waveOrigin=`${hit.uv.x.toFixed(4)},${hit.uv.y.toFixed(4)}`;
}

function buildGroundBeacon(uv,index) {
  const radius=.17;
  const geometry=new THREE.PlaneGeometry(radius*2,radius*2,28,28);
  const positions=geometry.attributes.position;
  for(let i=0;i<positions.count;i++){
    const localX=positions.getX(i),localY=positions.getY(i);
    const sample=new THREE.Vector2(uv.x+localX/TERRAIN_WIDTH,uv.y+localY/TERRAIN_DEPTH);
    positions.setXYZ(i,(sample.x-.5)*TERRAIN_WIDTH,terrainHeightAt(sample)+.004,(.5-sample.y)*TERRAIN_DEPTH);
  }
  geometry.computeBoundingSphere();
  const material=new THREE.ShaderMaterial({
    uniforms:{uTime:uniforms.uTime,uEffectGain:uniforms.uEffectGain,uSelected:{value:0},uOtherFocused:{value:0},uPhase:{value:index*.71},uMask:uniforms.uMask,uMapCenter:{value:uv.clone()},uMapSize:{value:new THREE.Vector2(radius*2/TERRAIN_WIDTH,radius*2/TERRAIN_DEPTH)}},
    transparent:true,depthWrite:false,depthTest:true,side:THREE.DoubleSide,blending:THREE.AdditiveBlending,
    vertexShader:`varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`,
    fragmentShader:`uniform float uTime,uSelected,uOtherFocused,uPhase,uEffectGain;uniform sampler2D uMask;uniform vec2 uMapCenter,uMapSize;varying vec2 vUv;
      void main(){if(texture2D(uMask,uMapCenter+(vUv-.5)*uMapSize).r<.5)discard;float r=length((vUv-.5)*2.0);if(r>1.0)discard;
      float breath=.82+.18*sin(uTime*1.8+uPhase);
      float ring=exp(-pow((r-.30)/.028,2.0));
      float outer=exp(-pow((r-.48)/.016,2.0));
      float core=1.0-smoothstep(.055,.12,r);
      float glow=exp(-pow(r/.25,2.0));
      float phase=fract(uTime*.28+uPhase);
      float outward=exp(-pow((r-(.28+phase*.64))/.045,2.0))*(1.0-smoothstep(.65,1.0,phase));
      float light=(core+ring*.65*breath+outer*.22+glow*.22+outward*(.32+.35*uSelected))*mix(1.0,.18,uOtherFocused);
      vec3 color=mix(vec3(.56,1.02,1.18),vec3(1.25,.95,.38),uSelected);
      color=mix(color,vec3(1.4,1.4,1.4),core*.75);
      gl_FragColor=vec4(color,min(light*uEffectGain*.64,.95));}`
  });
  const mesh=new THREE.Mesh(geometry,material);mesh.renderOrder=4;
  // A slim world-space light column joins the floating icon to the actual DEM.
  const beamMaterial=new THREE.ShaderMaterial({
    uniforms:material.uniforms,transparent:true,depthWrite:false,depthTest:true,side:THREE.DoubleSide,blending:THREE.AdditiveBlending,
    vertexShader:`varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`,
    fragmentShader:`uniform float uSelected,uOtherFocused,uEffectGain;varying vec2 vUv;
      void main(){float fade=pow(1.0-vUv.y,1.1);float alpha=fade*(.28+.24*uSelected)*mix(1.0,.15,uOtherFocused);
      gl_FragColor=vec4(mix(vec3(.65,1.05,1.2),vec3(1.3,1.03,.53),uSelected),min(alpha*uEffectGain,.8));}`
  });
  const beam=new THREE.Mesh(new THREE.CylinderGeometry(.0025,.008,.24,12,1,true),beamMaterial);
  beam.position.set((uv.x-.5)*TERRAIN_WIDTH,terrainHeightAt(uv)+.124,(.5-uv.y)*TERRAIN_DEPTH);
  beam.renderOrder=5;mesh.add(beam);scene.add(mesh);return mesh;
}

function buildSites() {
  const layer = document.getElementById('site-markers');
  const list = document.getElementById('site-list');
  siteMarkers = SITES.map((site, index) => {
    const uv = geoUv(site.lon, site.lat);
    const groundPoint = new THREE.Vector3((uv.x - 0.5) * TERRAIN_WIDTH, terrainHeightAt(uv) + .004, (0.5 - uv.y) * TERRAIN_DEPTH);
    const point = groundPoint.clone(); point.y += .27;
    const groundBeacon = buildGroundBeacon(uv, index);
    const stem = document.createElementNS('http://www.w3.org/2000/svg','path');
    document.getElementById('site-stems').append(stem);
    const button = document.createElement('button');
    button.className = 'site-marker';
    const ring = document.createElement('span');
    ring.className = 'site-ring';
    const art = document.createElement('span');
    art.className = 'site-art';
    art.style.backgroundPosition = atlasPosition(index);
    ring.append(art);
    button.append(ring, textElement('span', 'site-name', site.name));
    button.type = 'button';
    button.setAttribute('aria-label', `${site.name}，${site.anchor}`);
    button.addEventListener('click', event => { event.stopPropagation(); selectSite(site); });
    layer.append(button);
    const listButton = textElement('button', '', site.name);
    listButton.type = 'button';
    listButton.addEventListener('click', () => { selectSite(site); document.getElementById('site-detail').scrollIntoView({ block: 'nearest' }); });
    list.append(listButton);
    return { site, uv, point, groundPoint, groundBeacon, stem, button, listButton, x: 0, y: 0, rawX: 0, rawY: 0, initialized: false, visible: false };
  });
}

function updateSites(time) {
  const width = sceneHost.clientWidth, height = sceneHost.clientHeight;
  document.getElementById('site-stems').setAttribute('viewBox',`0 0 ${width} ${height}`);
  const dt = Math.min(.1, Math.max(.001, time - previousSiteTime));
  previousSiteTime = time;
  let nearest = null, nearestDistance = 18;
  for (const marker of siteMarkers) {
    const projected = marker.point.clone().project(camera);
    marker.rawX = (projected.x * 0.5 + 0.5) * width;
    const ground = marker.groundPoint.clone().project(camera);
    marker.groundX = (ground.x * .5 + .5) * width;
    marker.groundY = (-ground.y * .5 + .5) * height;
    // Keep the expanded icon and its label clear of the ground locator.
    marker.rawY = Math.min((-projected.y * .5 + .5) * height, marker.groundY - 76);
    const movement = Math.hypot(marker.rawX - marker.x, marker.rawY - marker.y);
    const stable = marker.site === aimedSite || marker.site === manualSite;
    if (!marker.initialized || !stable || movement > 32) {
      marker.x = marker.rawX; marker.y = marker.rawY; marker.initialized = true;
    } else if (movement > AR_UI_STABILITY.deadzonePx) {
      const blend = 1 - Math.exp(-dt / AR_UI_STABILITY.responseSeconds);
      marker.x += (marker.rawX - marker.x) * blend;
      marker.y += (marker.rawY - marker.y) * blend;
    }
    marker.visible = projected.z > -1 && projected.z < 1 && marker.x > 18 && marker.x < width - 22 && marker.y > 62 && marker.y < height - 48;
    marker.button.classList.toggle('is-hidden', !marker.visible);
    marker.stem.style.display = marker.visible && !scanReview ? '' : 'none';
    if (marker.visible) {
      marker.button.style.left = `${marker.x}px`;
      marker.button.style.top = `${marker.y}px`;
      const active = marker.site === (manualSite || aimedSite);
      marker.stem.setAttribute('d',`M ${marker.x} ${marker.y + (active ? 57 : 37)} L ${marker.groundX} ${marker.groundY - 4}`);
      marker.stem.classList.toggle('is-active', active);
      const distance = Math.hypot(marker.x - width / 2, marker.y - height / 2);
      if (!scanReview && distance < nearestDistance) { nearest = marker; nearestDistance = distance; }
    }
  }
  const held = siteMarkers.find(marker => marker.site === aimedSite && marker.visible);
  if (held) {
    const insideExit = Math.hypot(held.rawX - width / 2, held.rawY - height / 2) <= 36;
    if (insideExit) aimExitStart = null;
    else if (aimExitStart === null) aimExitStart = time;
    // 160 ms exit grace avoids repeated open/close during a short tracking spike.
    if (insideExit || time - aimExitStart < AR_UI_STABILITY.exitGraceSeconds) nearest = held;
  }
  if (aimedSite !== nearest?.site) {
    aimedSite = nearest?.site ?? null;
    aimStart = time;
    aimExitStart = null;
    if (nearest && !manualSite) setFocusArea(nearest.site, time);
  }
  const dwell = aimedSite ? clamp((time - aimStart) / DWELL_SECONDS, 0, 1) : 0;
  if (aimedSite && dwell >= 1 && !manualSite && storySite !== aimedSite) openStory(aimedSite);
  const activeStory = manualSite || (aimedSite && dwell >= 1 ? aimedSite : null);
  if (!activeStory && storySite && document.getElementById('site-story').classList.contains('is-open')) closeStory();
  const storyMarker = siteMarkers.find(marker => marker.site === storySite && marker.visible);
  if (storyMarker && activeStory === storySite) layoutStory(storyMarker);
  const focusSite = manualSite || aimedSite;
  const focus = aimedSite ? siteMarkers.find(marker => marker.site === aimedSite) : null;
  const focusAmount = focusSite ? 1 : 0;
  uniforms.uFocusAmount.value += (focusAmount - uniforms.uFocusAmount.value) * 0.08;
  for (const marker of siteMarkers) {
    marker.button.classList.toggle('is-aimed', marker.site === aimedSite);
    marker.button.classList.toggle('is-selected', marker.site === selectedSite);
    marker.button.classList.toggle('is-focused', marker.site === focusSite);
    const beaconFocus = marker.site === focusSite ? 1 : 0;
    marker.groundBeacon.material.uniforms.uSelected.value += (beaconFocus-marker.groundBeacon.material.uniforms.uSelected.value)*(1-Math.exp(-dt/.12));
    marker.groundBeacon.material.uniforms.uOtherFocused.value = focusSite && !beaconFocus ? 1 : 0;
    marker.groundBeacon.visible = !scanReview;
    marker.button.classList.toggle('is-dimmed', !!focusSite && marker.site !== focusSite);
    marker.button.style.setProperty('--dwell-angle', `${marker.site === aimedSite ? dwell * 360 : 0}deg`);
  }
  const occupied = [];
  const ordered = [...siteMarkers].filter(marker => marker.visible).sort((a, b) =>
    Number(b.site === aimedSite) - Number(a.site === aimedSite) ||
    Number(b.site === selectedSite) - Number(a.site === selectedSite)
  );
  for (const marker of ordered) {
    const box = { left: marker.x - 30, right: marker.x + 30, top: marker.y - 33, bottom: marker.y + 43 };
    const overlaps = occupied.some(other => box.left < other.right + 4 && box.right > other.left - 4 && box.top < other.bottom + 3 && box.bottom > other.top - 3);
    marker.button.classList.toggle('is-compact', overlaps);
    if (!overlaps) occupied.push(box);
  }
  const reticle = document.querySelector('.reticle');
  reticle.classList.toggle('aimed', !!focusSite);
  reticle.classList.toggle('locked', !!manualSite || (!!aimedSite && dwell >= 1));
  reticle.style.setProperty('--acquire', dwell);
  reticle.dataset.state = manualSite ? 'locked' : aimedSite ? dwell >= 1 ? 'locked' : 'acquiring' : 'idle';
  const callout = document.getElementById('site-callout');
  const active = focus?.site ?? selectedSite;
  callout.hidden = true;
  if (active) {
    document.getElementById('callout-mode').textContent = focus ? 'GAZE / 已瞄准' : 'SELECTED / 已选择';
    document.getElementById('callout-name').textContent = active.name;
    document.getElementById('callout-anchor').textContent = active.anchor;
  }
}

function updateCamera() {
  if (!camera) return;
  camera.position.set(settings.lateral, settings.height, settings.distance);
  camera.lookAt(0, 0.12, 0);
  camera.rotateY(THREE.MathUtils.degToRad(settings.yaw));
  camera.rotateX(THREE.MathUtils.degToRad(settings.pitch));
  camera.updateMatrixWorld();
  lastCameraMotion = clock.getElapsedTime();
  pendingGazeRipple = true;
  document.getElementById('yaw-value').textContent = `${Math.round(settings.yaw)}°`;
  document.getElementById('pitch-value').textContent = `${Math.round(settings.pitch)}°`;
  document.getElementById('pad-icon').style.transform = `translateY(${-((settings.height - 1.8) * 3)}px)`;
}

function updateLens() {
  if (!camera) return;
  const baseHorizontal = 2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(BASE_VERTICAL_FOV) / 2) * camera.aspect);
  const targetHorizontal = baseHorizontal / settings.zoom;
  camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(targetHorizontal / 2) / camera.aspect));
  camera.updateProjectionMatrix();
  lastCameraMotion = clock.getElapsedTime();
  pendingGazeRipple = true;
  document.getElementById('zoom-value').textContent = `${settings.zoom.toFixed(1)}×`;
}

function setAngle(yaw, pitch) {
  if (yaw !== settings.yaw || pitch !== settings.pitch) clearManualFocus();
  settings.yaw = clamp(yaw, -limits.yaw, limits.yaw);
  settings.pitch = clamp(pitch, -limits.pitch, limits.pitch);
  updateCamera();
}

function setStatus(message, duration = 2200) {
  readout.textContent = message;
  clearTimeout(setStatus.timeout);
  setStatus.timeout = setTimeout(() => { readout.textContent = aimedSite || manualSite ? '地点聚焦 · 中心涟漪暂停' : settings.idle ? '中心涟漪待机' : '中心涟漪已暂停'; }, duration);
}

function maskAt(uv) {
  const x = clamp(Math.floor(uv.x * maskWidth), 0, maskWidth - 1);
  const y = clamp(Math.floor((1 - uv.y) * maskHeight), 0, maskHeight - 1);
  return maskPixels[(y * maskWidth + x) * 4] > 127;
}

function scanFromReticle() {
  gazeRaycaster.setFromCamera(gazeNdc,camera);
  const hit=gazeRaycaster.intersectObject(terrain,false).find(item=>item.uv&&maskAt(item.uv));
  if (hit) scanAt(hit.uv);
  else setStatus('准心未落在参考地形内');
}

function scanAt(uv) {
  uniforms.uClickPos.value.copy(uv);
  uniforms.uClickStart.value = clock.getElapsedTime();
  nextGazeWave = uniforms.uClickStart.value + GAZE_WAVE_INTERVAL;
  clickCount += 1;
  setStatus(`定点扫描  /  第 ${String(clickCount).padStart(2, '0')} 次`);
}

function setupControls() {
  for (const key of ['height', 'distance', 'lateral']) {
    const input = document.getElementById(key);
    input.addEventListener('input', () => {
      clearManualFocus();
      settings[key] = Number(input.value);
      document.getElementById(`${key}-value`).textContent = `${settings[key].toFixed(1)} m`;
      updateCamera();
    });
  }
  document.getElementById('zoom').addEventListener('input', event => {
    clearManualFocus();
    settings.zoom = Number(event.target.value);
    updateLens();
  });
  document.querySelectorAll('[data-dir]').forEach(button => button.addEventListener('click', () => {
    const dir = button.dataset.dir;
    if (dir === 'reset') setAngle(0, 0);
    if (dir === 'up') setAngle(settings.yaw, settings.pitch + 3);
    if (dir === 'down') setAngle(settings.yaw, settings.pitch - 3);
    if (dir === 'left') setAngle(settings.yaw - 3, settings.pitch);
    if (dir === 'right') setAngle(settings.yaw + 3, settings.pitch);
  }));
  window.addEventListener('keydown', event => {
    if (event.target instanceof HTMLInputElement) return;
    const step = event.shiftKey ? 0.25 : 3;
    const dirs = { ArrowUp: [0, step], ArrowDown: [0, -step], ArrowLeft: [-step, 0], ArrowRight: [step, 0] };
    if (!dirs[event.key]) return;
    event.preventDefault();
    setAngle(settings.yaw + dirs[event.key][0], settings.pitch + dirs[event.key][1]);
  });
  document.getElementById('idle-toggle').addEventListener('change', event => {
    settings.idle = event.target.checked;
    readout.textContent = aimedSite || manualSite ? '地点聚焦 · 中心涟漪暂停' : settings.idle ? '中心涟漪待机' : '中心涟漪已暂停';
    if (!settings.idle) uniforms.uClickStart.value = -100;
    else nextGazeWave = Math.max(nextGazeWave,clock.getElapsedTime()+.3);
  });
  document.getElementById('center-scan').addEventListener('click', () => { clearManualFocus(); scanFromReticle(); });

  const canvas = renderer.domElement;
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let down = null;
  canvas.addEventListener('pointerdown', event => {
    canvas.setPointerCapture(event.pointerId);
    down = { x: event.clientX, y: event.clientY, yaw: settings.yaw, pitch: settings.pitch, dragged: false };
  });
  canvas.addEventListener('pointermove', event => {
    if (!down) return;
    const dx = event.clientX - down.x;
    const dy = event.clientY - down.y;
    if (Math.hypot(dx, dy) > 5) down.dragged = true;
    if (down.dragged) setAngle(down.yaw + dx * 0.075, down.pitch + dy * 0.075);
  });
  canvas.addEventListener('pointerup', event => {
    if (!down) return;
    const dragged = down.dragged;
    down = null;
    if (dragged) return;
    const bounds = canvas.getBoundingClientRect();
    const localX = event.clientX - bounds.left, localY = event.clientY - bounds.top;
    const marker = !scanReview && siteMarkers.find(item => item.visible && Math.hypot(item.x - localX, item.y - localY) < 23);
    if (marker) { selectSite(marker.site); return; }
    pointer.set(((event.clientX - bounds.left) / bounds.width) * 2 - 1, -((event.clientY - bounds.top) / bounds.height) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObject(terrain, false).find(item => item.uv && maskAt(item.uv));
    if (hit) { clearManualFocus(); scanAt(hit.uv); }
  });
  canvas.addEventListener('pointercancel', () => { down = null; });
  canvas.addEventListener('wheel', event => {
    event.preventDefault();
    clearManualFocus();
    settings.distance = clamp(settings.distance + Math.sign(event.deltaY) * 0.2, 4.2, 9.5);
    document.getElementById('distance').value = settings.distance;
    document.getElementById('distance-value').textContent = `${settings.distance.toFixed(1)} m`;
    updateCamera();
  }, { passive: false });
}

function setupScanReview() {
  document.getElementById('review-wave').addEventListener('click', scanFromReticle);
  document.getElementById('review-layer').addEventListener('change', event => {
    scanSurface.points.visible = event.target.value !== 'lines';
    scanSurface.links.visible = event.target.value !== 'points';
  });
  for (const [id, uniform] of [['review-light', 'uEffectGain'], ['review-ripple', 'uRippleGain']]) {
    document.getElementById(id).addEventListener('input', event => {
      uniforms[uniform].value = Number(event.target.value);
      document.getElementById(`${id}-value`).textContent = Number(event.target.value).toFixed(2);
    });
  }
  if (scanReview) {
    document.title = '空间扫描效果确认 · 湖南沙盘 R06';
    settings.height = 3.5; settings.distance = 5.4; settings.zoom = 1.4;
    updateCamera(); updateLens();
    document.querySelector('.panel-header h1').innerHTML = '空间扫描<br><em>效果确认</em>';
    document.querySelector('.panel-header p').textContent = '仅显示贴地形点线与柔和涟漪。拖动检查贴合，点击任意地形发起扩散。';
    hint.textContent = '拖动观察 · 点击地形发起柔和涟漪';
  }
}

function buildTerrain(heightGrid, meta, colorTexture, maskTexture) {
  const geometry = new THREE.PlaneGeometry(TERRAIN_WIDTH, TERRAIN_DEPTH, meta.width - 1, meta.height - 1);
  geometry.rotateX(-Math.PI / 2);
  const vertices = geometry.attributes.position;
  for (let i = 0; i < vertices.count; i++) {
    const elevation = Math.max(0, heightGrid[i]);
    vertices.setY(i, 0.025 + elevation / 2076 * 0.29);
  }
  vertices.needsUpdate = true;
  geometry.computeVertexNormals();
  colorTexture.colorSpace = THREE.SRGBColorSpace;
  colorTexture.anisotropy = Math.min(renderer.capabilities.getMaxAnisotropy(), 8);
  terrain = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ map: colorTexture, color: 0xa3b4a8, alphaTest: 0.5, roughness: 0.96, metalness: 0.0, side: THREE.DoubleSide }));
  terrain.name = 'HunanTerrain';
  scene.add(terrain);

  uniforms = {
    uTime: { value: 0 },
    uEffectGain: { value: 2.4 },
    uRippleGain: { value: 1.05 },
    uMask: { value: maskTexture },
    uClickPos: { value: new THREE.Vector2(0.5, 0.5) },
    uClickStart: { value: -100 },
    uSweepX: { value: -0.1 },
    uSweepDir: { value: 1 },
    uSweepActive: { value: 0 },
    uFocusPos: { value: new THREE.Vector2(0.5, 0.5) },
    uFocusRadius: { value: new THREE.Vector2(0.9, 0.9) },
    uFocusAngle: { value: 0 },
    uFocusBand: { value: new THREE.Vector2(0,2076) },
    uLocalPulses: { value: Array.from({length:4},()=>new THREE.Vector4(.5,.5,-100,0)) },
    uFocusAmount: { value: 0 },
    uFocusStart: { value: -100 },
    uFocusReach: { value: 5.5 },
  };

  function heightAt(uv) {
    const px = clamp(uv.x * (meta.width - 1), 0, meta.width - 1);
    const py = clamp((1 - uv.y) * (meta.height - 1), 0, meta.height - 1);
    const x0 = Math.floor(px), y0 = Math.floor(py);
    const x1 = Math.min(x0 + 1, meta.width - 1), y1 = Math.min(y0 + 1, meta.height - 1);
    const fx = px - x0, fy = py - y0;
    // Match PlaneGeometry's (a,b,d)/(b,c,d) diagonal, not a bilinear patch.
    const a = Math.max(0, heightGrid[y0 * meta.width + x0]);
    const b = Math.max(0, heightGrid[y1 * meta.width + x0]);
    const d = Math.max(0, heightGrid[y0 * meta.width + x1]);
    const c = Math.max(0, heightGrid[y1 * meta.width + x1]);
    const height = fx + fy <= 1 ? a + (d-a)*fx + (b-a)*fy
      : c + (b-c)*(1-fx) + (d-c)*(1-fy);
    return 0.025 + height / 2076 * 0.29;
  }
  terrainHeightAt = heightAt;

  scanSurface = createTerrainScan({ THREE, scene, uniforms, heightAt, maskAt, width: TERRAIN_WIDTH, depth: TERRAIN_DEPTH });
}

function buildEnvironment() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color('#0a1512');
  scene.fog = new THREE.Fog('#0a1512', 13, 25);
  scene.add(new THREE.HemisphereLight(0xd1e7dc, 0x314d41, 2.15));
  const sun = new THREE.DirectionalLight(0xf4f0d5, 2.2);
  sun.position.set(-3, 8, 4);
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0x50baa3, 0.7);
  fill.position.set(3, 4, -5);
  scene.add(fill);

  const slab = new THREE.Mesh(new THREE.BoxGeometry(5.12, 0.25, 5.82), new THREE.MeshStandardMaterial({ color: 0x172721, roughness: 0.83, metalness: 0.1 }));
  slab.position.y = -0.105;
  scene.add(slab);
  const edge = new THREE.LineSegments(new THREE.EdgesGeometry(slab.geometry), new THREE.LineBasicMaterial({ color: 0x537768, transparent: true, opacity: 0.6 }));
  edge.position.copy(slab.position);
  scene.add(edge);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshStandardMaterial({ color: 0x0c1915, roughness: 1 }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.25;
  scene.add(floor);
  const floorGrid = new THREE.GridHelper(18, 48, 0x24463b, 0x1a352d);
  floorGrid.position.y = -0.244;
  scene.add(floorGrid);
  referenceObjects.push(slab, edge, floor, floorGrid);
}

let scene;
function resize() {
  const width = sceneHost.clientWidth, height = sceneHost.clientHeight;
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  updateLens();
}

function animate() {
  requestAnimationFrame(animate);
  const time = clock.getElapsedTime();
  uniforms.uTime.value = time;
  updateSites(time);
  const focusActive = !!(aimedSite || manualSite);
  if (focusActive !== wasFocusActive) {
    wasFocusActive = focusActive;
    sweepStart = -100;
    uniforms.uClickStart.value = -100;
    nextGazeWave = time + .6;
    readout.textContent = focusActive ? '地点聚焦 · 中心涟漪暂停' : settings.idle ? '中心涟漪待机' : '中心涟漪已暂停';
  }
  uniforms.uSweepActive.value = 0; // Legacy sweep disabled; all idle light is centre-origin ripple.
  updateAmbientFeedback(time,focusActive);
  updateStoryPages(time);
  renderer.render(scene, camera);
}

async function load() {
  try {
    renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.2;
    sceneHost.appendChild(renderer.domElement);
    camera = new THREE.PerspectiveCamera(BASE_VERTICAL_FOV, 1, 0.05, 100);
    buildEnvironment();
    const textureLoader = new THREE.TextureLoader();
    const [meta, buffer, color, maskTexture, maskImage] = await Promise.all([
      fetch('./assets/terrain-meta.json').then(r => r.json()),
      fetch('./assets/terrain-height.f32').then(r => r.arrayBuffer()),
      textureLoader.loadAsync('./assets/terrain-color.png'),
      textureLoader.loadAsync('./assets/terrain-mask.png'),
      new Promise((resolve, reject) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = reject; image.src = './assets/terrain-mask.png'; }),
    ]);
    const heightGrid = new Float32Array(buffer);
    if (heightGrid.length !== meta.width * meta.height) throw new Error('地形网格尺寸与数据不匹配');
    const canvas = document.createElement('canvas');
    canvas.width = maskImage.width; canvas.height = maskImage.height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(maskImage, 0, 0);
    maskPixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    maskWidth = canvas.width; maskHeight = canvas.height;
    buildTerrain(heightGrid, meta, color, maskTexture);
    buildSites();
    updateCamera();
    resize();
    new ResizeObserver(resize).observe(sceneHost);
    setupControls();
    setupScanReview();
    setupCameraPreview({
      onCameraChange(active) {
        scene.background = active ? null : new THREE.Color('#0a1512');
        renderer.setClearColor('#0a1512', active ? 0 : 1);
      },
      onReferenceChange(visible) {
        // Retain the DEM for raycasting/scan coordinates; only disable rendering.
        terrain.visible = visible;
        for (const object of referenceObjects) object.visible = visible;
      }
    });
    nextIdle = clock.getElapsedTime() + 0.6;
    pendingGazeRipple = false;
    window.__demoState = () => ({ ...settings, clickCount, terrainReady: true, sweepActive: uniforms.uSweepActive.value > 0, sweepX: uniforms.uSweepX.value, canvasSize: [sceneHost.clientWidth, sceneHost.clientHeight] });
    animate();
  } catch (error) {
    console.error(error);
    errorBox.hidden = false;
    errorBox.textContent = `地形加载失败：${error.message}`;
    hint.textContent = '请通过本地 HTTP 服务打开此页面';
  }
}

load();
