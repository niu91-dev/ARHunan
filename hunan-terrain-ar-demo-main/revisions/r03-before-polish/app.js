import * as THREE from 'three';
import { SITES, GEO_BOUNDS } from './sites.js';

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
let renderer, camera, terrain, scanSheet, maskPixels, maskWidth, maskHeight, uniforms;
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
const PHOTO_ATLASES = ['./assets/location-photos-atlas.png', './assets/location-photos-atlas-b.png', './assets/location-photos-atlas-c.png'];
// Approximate visual footprints in scene metres, aligned to the map's main relief or watercourse.
const FOCUS_AREAS = {
  zhangjiajie: [0.85, 0.80, 0.15], yuelu: [0.55, 0.55, 0], langshan: [0.78, 0.82, -0.16],
  hengshan: [0.86, 0.82, 0.15], hills: [1.28, 1.02, -0.12], xuefeng: [0.80, 1.48, 0.32],
  'dongting-plain': [1.32, 0.98, 0.08], liyang: [0.86, 0.72, 0], 'dongting-lake': [1.04, 0.87, 0.10],
  yuan: [1.42, 0.64, 0.18], xiang: [0.65, 1.50, -0.10]
};
let wasFocusActive = false;

const SCAN_GLSL = `
  uniform float uTime; uniform sampler2D uMask;
  uniform vec2 uClickPos; uniform float uClickStart;
  uniform float uSweepX; uniform float uSweepDir; uniform float uSweepActive;
  uniform vec2 uFocusPos; uniform vec2 uFocusRadius; uniform float uFocusAngle;
  uniform float uFocusAmount; uniform float uFocusStart;
  float focusDistance(vec2 uv) {
    vec2 delta=(uv-uFocusPos)*vec2(4.8,5.5);
    float c=cos(uFocusAngle), s=sin(uFocusAngle);
    vec2 aligned=vec2(delta.x*c+delta.y*s,-delta.x*s+delta.y*c);
    return length(aligned/uFocusRadius);
  }
  vec2 scanSignal(vec2 uv) {
    float irregular = 0.025*sin(uv.y*31.0+sin(uv.y*97.0)*0.7)+0.008*sin(uv.y*119.0);
    float behind = (uSweepX + irregular - uv.x) * uSweepDir;
    float sweepFront = exp(-pow(behind / 0.075, 2.0)) * uSweepActive;
    float sweepTrail = smoothstep(-0.09, 0.12, behind) * exp(-max(behind, 0.0) * 4.1) * uSweepActive;
    float age = uTime - uClickStart;
    float clickEnabled = step(0.0, age) * step(age, 3.8);
    float radius = age * 1.42;
    float dist = length((uv - uClickPos) * vec2(4.8, 5.5));
    float clickFront = exp(-pow((dist - radius) / 0.31, 2.0)) * clickEnabled;
    float clickTrail = (1.0 - smoothstep(radius - 0.30, radius + 0.13, dist)) * exp(-age * 1.1) * clickEnabled;
    return vec2(sweepTrail * 0.72 + clickTrail*0.67, sweepFront + clickFront);
  }
`;

function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }

function geoUv(lon, lat) {
  const mercator = degrees => Math.log(Math.tan(Math.PI / 4 + degrees * Math.PI / 360));
  return new THREE.Vector2(
    (lon - GEO_BOUNDS.west) / (GEO_BOUNDS.east - GEO_BOUNDS.west),
    (mercator(lat) - mercator(GEO_BOUNDS.south)) / (mercator(GEO_BOUNDS.north) - mercator(GEO_BOUNDS.south))
  );
}

function setFocusArea(site, time) {
  const [radiusX, radiusY, angle] = FOCUS_AREAS[site.id] || [0.9, 0.9, 0];
  uniforms.uFocusPos.value.copy(geoUv(site.lon, site.lat));
  uniforms.uFocusRadius.value.set(radiusX, radiusY);
  uniforms.uFocusAngle.value = angle;
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
  const stack = textElement('div', 'story-photo-stack', '');
  for (const atlas of PHOTO_ATLASES) {
    const layer = textElement('div', 'story-photo-layer', '');
    layer.style.backgroundImage = `url('${atlas}')`;
    layer.style.backgroundPosition = atlasPosition(index);
    stack.append(layer);
  }
  const caption = textElement('div', 'story-photo-caption', '');
  caption.append(textElement('b', '', site.name), textElement('small', '', '概念影像 · 01 / 03'));
  card.append(stack, caption);
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
    introPages = [...splitIntro(site.summary), ...splitIntro(site.mechanism)];
    cards.replaceChildren();
    const index = SITES.indexOf(site);
    const intro = textElement('article', 'story-card story-intro story-tr', '');
    intro.append(textElement('small', 'story-kicker', ''), textElement('h3', '', site.name), textElement('p', 'story-intro-copy', ''));
    const facts = textElement('article', 'story-card story-facts story-bl', '');
    facts.append(textElement('small', 'story-kicker', ''), textElement('div', 'story-fact-rows', ''));
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
  for (const card of cards.children) void getComputedStyle(card).transform;
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
  for (const [corner, offset, initial] of [['tl', 0, 0], ['br', 3, 1]]) {
    const card = story.querySelector(`.story-${corner}`);
    if (!card) continue;
    const index = (Math.floor((elapsed + offset) / 6) + initial) % PHOTO_ATLASES.length;
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
  const sideOffset = width < 570 ? 70 : 88;
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
    card.style.setProperty('--x', `${x}px`);
    card.style.setProperty('--y', `${y}px`);
    const ex = side < 0 ? x + cardW : x;
    const ey = y + cardH / 2;
    card.style.setProperty('--entry-x', `${ex - x}px`);
    card.style.setProperty('--entry-y', `${ey - y}px`);
    const sx = cx + side * 35;
    const bend = ex - side * 13;
    paths[index]?.setAttribute('d', `M ${sx.toFixed(1)} ${cy.toFixed(1)} Q ${(sx + side * 13).toFixed(1)} ${cy.toFixed(1)} ${(sx + side * 20).toFixed(1)} ${(cy + (ey - cy) * .18).toFixed(1)} L ${bend.toFixed(1)} ${(ey - (ey - cy) * .18).toFixed(1)} Q ${ex.toFixed(1)} ${ey.toFixed(1)} ${ex.toFixed(1)} ${ey.toFixed(1)}`);
  });
  const svg = story.querySelector('.story-links');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
}

function buildSites() {
  const layer = document.getElementById('site-markers');
  const list = document.getElementById('site-list');
  siteMarkers = SITES.map((site, index) => {
    const uv = geoUv(site.lon, site.lat);
    const point = new THREE.Vector3((uv.x - 0.5) * TERRAIN_WIDTH, terrainHeightAt(uv) + 0.115, (0.5 - uv.y) * TERRAIN_DEPTH);
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
    return { site, uv, point, button, listButton, x: 0, y: 0, visible: false };
  });
}

function updateSites(time) {
  const width = sceneHost.clientWidth, height = sceneHost.clientHeight;
  let nearest = null, nearestDistance = 18;
  for (const marker of siteMarkers) {
    const projected = marker.point.clone().project(camera);
    marker.x = (projected.x * 0.5 + 0.5) * width;
    marker.y = (-projected.y * 0.5 + 0.5) * height;
    marker.visible = projected.z > -1 && projected.z < 1 && marker.x > 18 && marker.x < width - 22 && marker.y > 62 && marker.y < height - 48;
    marker.button.classList.toggle('is-hidden', !marker.visible);
    if (marker.visible) {
      marker.button.style.left = `${marker.x}px`;
      marker.button.style.top = `${marker.y}px`;
      const distance = Math.hypot(marker.x - width / 2, marker.y - height / 2);
      if (distance < nearestDistance) { nearest = marker; nearestDistance = distance; }
    }
  }
  const held = siteMarkers.find(marker => marker.site === aimedSite && marker.visible);
  if (held && Math.hypot(held.x - width / 2, held.y - height / 2) <= 36) nearest = held;
  if (aimedSite !== nearest?.site) {
    aimedSite = nearest?.site ?? null;
    aimStart = time;
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
    marker.button.classList.toggle('is-dimmed', !!aimedSite && marker.site !== aimedSite);
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
  document.querySelector('.reticle').classList.toggle('aimed', !!aimedSite);
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
  setStatus.timeout = setTimeout(() => { readout.textContent = aimedSite || manualSite ? '地点聚焦 · 待机扫光暂停' : settings.idle ? '待机扫描中' : '待机扫描已暂停'; }, duration);
}

function maskAt(uv) {
  const x = clamp(Math.floor(uv.x * maskWidth), 0, maskWidth - 1);
  const y = clamp(Math.floor((1 - uv.y) * maskHeight), 0, maskHeight - 1);
  return maskPixels[(y * maskWidth + x) * 4] > 127;
}

function scanAt(uv) {
  uniforms.uClickPos.value.copy(uv);
  uniforms.uClickStart.value = clock.getElapsedTime();
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
    const dirs = { ArrowUp: [0, 3], ArrowDown: [0, -3], ArrowLeft: [-3, 0], ArrowRight: [3, 0] };
    if (!dirs[event.key]) return;
    event.preventDefault();
    setAngle(settings.yaw + dirs[event.key][0], settings.pitch + dirs[event.key][1]);
  });
  document.getElementById('idle-toggle').addEventListener('change', event => {
    settings.idle = event.target.checked;
    readout.textContent = aimedSite || manualSite ? '地点聚焦 · 待机扫光暂停' : settings.idle ? '待机扫描中' : '待机扫描已暂停';
    if (settings.idle) nextIdle = clock.getElapsedTime() + 0.3;
  });
  document.getElementById('center-scan').addEventListener('click', () => { clearManualFocus(); scanAt(new THREE.Vector2(0.5, 0.5)); });

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
    const marker = siteMarkers.find(item => item.visible && Math.hypot(item.x - localX, item.y - localY) < 23);
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
  terrain = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ map: colorTexture, alphaTest: 0.5, roughness: 0.96, metalness: 0.0, side: THREE.DoubleSide }));
  terrain.name = 'HunanTerrain';
  scene.add(terrain);

  uniforms = {
    uTime: { value: 0 },
    uMask: { value: maskTexture },
    uClickPos: { value: new THREE.Vector2(0.5, 0.5) },
    uClickStart: { value: -100 },
    uSweepX: { value: -0.1 },
    uSweepDir: { value: 1 },
    uSweepActive: { value: 0 },
    uFocusPos: { value: new THREE.Vector2(0.5, 0.5) },
    uFocusRadius: { value: new THREE.Vector2(0.9, 0.9) },
    uFocusAngle: { value: 0 },
    uFocusAmount: { value: 0 },
    uFocusStart: { value: -100 },
  };

  function heightAt(uv) {
    const px = clamp(uv.x * (meta.width - 1), 0, meta.width - 1);
    const py = clamp((1 - uv.y) * (meta.height - 1), 0, meta.height - 1);
    const x0 = Math.floor(px), y0 = Math.floor(py);
    const x1 = Math.min(x0 + 1, meta.width - 1), y1 = Math.min(y0 + 1, meta.height - 1);
    const fx = px - x0, fy = py - y0;
    const top = heightGrid[y0 * meta.width + x0] * (1 - fx) + heightGrid[y0 * meta.width + x1] * fx;
    const bottom = heightGrid[y1 * meta.width + x0] * (1 - fx) + heightGrid[y1 * meta.width + x1] * fx;
    return 0.025 + Math.max(0, top * (1 - fy) + bottom * fy) / 2076 * 0.29;
  }
  terrainHeightAt = heightAt;

  // Sparse luminous registration points float just above measured surface relief.
  const pointCount = 11500;
  const pointPositions = new Float32Array(pointCount * 3);
  const pointUvs = new Float32Array(pointCount * 2);
  const pointSeeds = new Float32Array(pointCount);
  const pointSizes = new Float32Array(pointCount);
  let count = 0, attempts = 0;
  while (count < pointCount && attempts < pointCount * 5) {
    attempts++;
    const uv = new THREE.Vector2(Math.random(), Math.random());
    if (!maskAt(uv)) continue;
    pointPositions[count * 3] = (uv.x - 0.5) * TERRAIN_WIDTH;
    pointPositions[count * 3 + 1] = heightAt(uv) + 0.008 + Math.random() * 0.010;
    pointPositions[count * 3 + 2] = (0.5 - uv.y) * TERRAIN_DEPTH;
    pointUvs[count * 2] = uv.x;
    pointUvs[count * 2 + 1] = uv.y;
    pointSeeds[count] = Math.random();
    pointSizes[count] = 0.6 + Math.random() * 1.15;
    count++;
  }
  const pointGeometry = new THREE.BufferGeometry();
  pointGeometry.setAttribute('position', new THREE.BufferAttribute(pointPositions.subarray(0, count * 3), 3));
  pointGeometry.setAttribute('aUv', new THREE.BufferAttribute(pointUvs.subarray(0, count * 2), 2));
  pointGeometry.setAttribute('aSeed', new THREE.BufferAttribute(pointSeeds.subarray(0, count), 1));
  pointGeometry.setAttribute('aSize', new THREE.BufferAttribute(pointSizes.subarray(0, count), 1));
  const pointMaterial = new THREE.ShaderMaterial({
    uniforms, transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending,
    vertexShader: `attribute vec2 aUv; attribute float aSeed; attribute float aSize;
      varying vec2 vUv; varying float vSeed;
      void main(){vUv=aUv;vSeed=aSeed;vec4 mv=modelViewMatrix*vec4(position,1.0);gl_Position=projectionMatrix*mv;gl_PointSize=clamp(aSize*14.0/-mv.z,1.5,3.8);}`,
    fragmentShader: `${SCAN_GLSL}
      varying vec2 vUv; varying float vSeed;
      void main(){
        vec2 s=scanSignal(vUv);
        float twinkle=0.38+0.62*pow(0.5+0.5*sin(uTime*(2.1+vSeed*4.0)+vSeed*113.0),2.0);
        float focusDist=focusDistance(vUv);
        float core=exp(-pow(focusDist/1.04,2.0));
        float pulseRadius=mod(max(uTime-uFocusStart,0.0)*0.45,2.3);
        float pulse=exp(-pow((focusDist-pulseRadius)/0.22,2.0))*(0.68+0.32*sin(uTime*2.5));
        float focusLight=uFocusAmount*(core*0.70+pulse*0.23);
        float energy=clamp((s.x*0.48+s.y*0.68)*mix(1.0,0.28,uFocusAmount)+focusLight,0.0,0.86);
        vec2 p=gl_PointCoord-0.5;
        float solid=1.0-smoothstep(0.19,0.24,dot(p,p));
        float alpha=solid*energy*twinkle*(0.42+vSeed*0.58);
        vec3 cyan=vec3(0.28,0.87,0.91);
        vec3 gold=vec3(1.0,0.79,0.46);
        vec3 color=mix(cyan,gold,step(0.965,vSeed));
        gl_FragColor=vec4(color,alpha);
      }`,
  });
  const points = new THREE.Points(pointGeometry, pointMaterial);
  points.renderOrder = 3;
  scene.add(points);

  // One short, terrain-following bridge per sample at most. No valley-spanning chords.
  const cellSize = 0.016;
  const cells = new Map();
  const key = (x, y) => `${x},${y}`;
  for (let i = 0; i < count; i++) {
    const cx = Math.floor(pointUvs[i * 2] / cellSize);
    const cy = Math.floor(pointUvs[i * 2 + 1] / cellSize);
    const cellKey = key(cx, cy);
    if (!cells.has(cellKey)) cells.set(cellKey, []);
    cells.get(cellKey).push(i);
  }
  const maxLinks = 2800;
  const linkPositions = new Float32Array(maxLinks * 12);
  const linkUvs = new Float32Array(maxLinks * 8);
  const linkStrengths = new Float32Array(maxLinks * 4);
  const linkSeeds = new Float32Array(maxLinks * 4);
  const degree = new Uint8Array(count);
  let linkCount = 0;
  for (let i = 0; i < count && linkCount < maxLinks; i++) {
    if (degree[i] || Math.random() > 0.56) continue;
    const cx = Math.floor(pointUvs[i * 2] / cellSize);
    const cy = Math.floor(pointUvs[i * 2 + 1] / cellSize);
    let neighbor = -1, nearest = 0.068;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const j of cells.get(key(cx + dx, cy + dy)) || []) {
        if (j <= i || degree[j]) continue;
        const deltaX = pointPositions[i * 3] - pointPositions[j * 3];
        const deltaZ = pointPositions[i * 3 + 2] - pointPositions[j * 3 + 2];
        const distance = Math.hypot(deltaX, deltaZ);
        const heightDelta = Math.abs(pointPositions[i * 3 + 1] - pointPositions[j * 3 + 1]);
        if (distance > 0.014 && distance < nearest && heightDelta < 0.025) { neighbor = j; nearest = distance; }
      }
    }
    if (neighbor < 0) continue;
    const startUv = new THREE.Vector2(pointUvs[i * 2], pointUvs[i * 2 + 1]);
    const endUv = new THREE.Vector2(pointUvs[neighbor * 2], pointUvs[neighbor * 2 + 1]);
    const midUv = startUv.clone().lerp(endUv, 0.5);
    if (!maskAt(midUv)) continue;
    const midpoint = new THREE.Vector3(
      (midUv.x - 0.5) * TERRAIN_WIDTH,
      heightAt(midUv) + 0.012,
      (0.5 - midUv.y) * TERRAIN_DEPTH
    );
    const positions = [
      pointPositions.subarray(i * 3, i * 3 + 3),
      [midpoint.x, midpoint.y, midpoint.z],
      pointPositions.subarray(neighbor * 3, neighbor * 3 + 3)
    ];
    const uvs = [startUv, midUv, endUv];
    for (let segment = 0; segment < 2; segment++) {
      for (let vertex = 0; vertex < 2; vertex++) {
        const index = segment * 2 + vertex;
        const source = positions[segment + vertex];
        const sourceUv = uvs[segment + vertex];
        linkPositions.set(source, linkCount * 12 + index * 3);
        linkUvs.set([sourceUv.x, sourceUv.y], linkCount * 8 + index * 2);
      }
    }
    const strength = 0.32 + Math.pow(Math.random(), 1.9) * 0.68;
    const seed = Math.random();
    linkStrengths.fill(strength, linkCount * 4, linkCount * 4 + 4);
    linkSeeds.fill(seed, linkCount * 4, linkCount * 4 + 4);
    degree[i]++;
    degree[neighbor]++;
    linkCount++;
  }
  const linkGeometry = new THREE.BufferGeometry();
  linkGeometry.setAttribute('position', new THREE.BufferAttribute(linkPositions.subarray(0, linkCount * 12), 3));
  linkGeometry.setAttribute('aUv', new THREE.BufferAttribute(linkUvs.subarray(0, linkCount * 8), 2));
  linkGeometry.setAttribute('aStrength', new THREE.BufferAttribute(linkStrengths.subarray(0, linkCount * 4), 1));
  linkGeometry.setAttribute('aSeed', new THREE.BufferAttribute(linkSeeds.subarray(0, linkCount * 4), 1));
  const linkMaterial = new THREE.ShaderMaterial({
    uniforms, transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending,
    vertexShader: `attribute vec2 aUv; attribute float aStrength; attribute float aSeed;
      varying vec2 vUv; varying float vStrength; varying float vSeed;
      void main(){vUv=aUv;vStrength=aStrength;vSeed=aSeed;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`,
    fragmentShader: `${SCAN_GLSL}
      varying vec2 vUv; varying float vStrength; varying float vSeed;
      void main(){
        vec2 scan=scanSignal(vUv);
        float flicker=pow(0.5+0.5*sin(uTime*(1.6+vSeed*3.5)+vSeed*72.0),2.0);
        float focus=exp(-pow(focusDistance(vUv)/1.04,2.0))*uFocusAmount;
        float light=(scan.x*0.16+scan.y*0.95+focus*0.29)*vStrength;
        float alpha=clamp(light*(0.32+0.68*flicker),0.0,0.52);
        vec3 color=mix(vec3(0.19,0.64,0.68),vec3(0.55,0.96,0.91),clamp(scan.y+focus*0.45,0.0,1.0));
        gl_FragColor=vec4(color,alpha);
      }`,
  });
  const links = new THREE.LineSegments(linkGeometry, linkMaterial);
  links.renderOrder = 2;
  scene.add(links);

  const sheetGeometry = new THREE.PlaneGeometry(TERRAIN_DEPTH, 0.82);
  sheetGeometry.rotateY(Math.PI / 2);
  const sheetMaterial = new THREE.ShaderMaterial({
    uniforms, transparent: true, depthWrite: false, depthTest: true, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
    vertexShader: `varying vec2 vUv; void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`,
    fragmentShader: `uniform sampler2D uMask; uniform float uSweepX; varying vec2 vUv;
      void main(){
        if(texture2D(uMask,vec2(uSweepX,vUv.x)).r<0.5) discard;
        float vertical=pow(1.0-vUv.y,1.8);
        float glint=exp(-pow((vUv.y-0.12)/0.14,2.0));
        float edge=0.68+0.32*sin(vUv.x*31.0);
        float alpha=(vertical*0.045+glint*0.018)*edge;
        gl_FragColor=vec4(0.42,0.96,0.94,alpha);
      }`,
  });
  scanSheet = new THREE.Mesh(sheetGeometry, sheetMaterial);
  scanSheet.position.y = 0.43;
  scanSheet.visible = false;
  scanSheet.renderOrder = 4;
  scene.add(scanSheet);
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
    nextIdle = time + 1.2;
    readout.textContent = focusActive ? '地点聚焦 · 待机扫光暂停' : settings.idle ? '待机扫描中' : '待机扫描已暂停';
  }
  const idleEnabled = settings.idle && !focusActive;
  if (idleEnabled && time >= nextIdle) {
    sweepStart = time;
    sweepDirection = Math.random() < 0.5 ? 1 : -1;
    nextIdle = time + SWEEP_DURATION + 1.6 + Math.random() * 1.8;
  }
  const progress = (time - sweepStart) / SWEEP_DURATION;
  const sweepActive = idleEnabled && progress >= 0 && progress <= 1;
  const sweepX = sweepDirection > 0 ? -0.06 + progress * 1.12 : 1.06 - progress * 1.12;
  uniforms.uSweepX.value = sweepX;
  uniforms.uSweepDir.value = sweepDirection;
  uniforms.uSweepActive.value = sweepActive ? 1 : 0;
  scanSheet.visible = sweepActive && sweepX > 0 && sweepX < 1;
  if (scanSheet.visible) scanSheet.position.x = (sweepX - 0.5) * TERRAIN_WIDTH;
  updateStoryPages(time);
  renderer.render(scene, camera);
}

async function load() {
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
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
    nextIdle = clock.getElapsedTime() + 0.6;
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
