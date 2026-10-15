import * as THREE from 'three';
import { SITES, GEO_BOUNDS } from './sites.js';

const sceneHost = document.getElementById('scene');
const readout = document.getElementById('scan-readout');
const hint = document.getElementById('hint');
const errorBox = document.getElementById('error');
const settings = { height: 1.8, distance: 4.4, lateral: 0, yaw: 0, pitch: 0, idle: true };
const limits = { yaw: 18, pitch: 12 };
const TERRAIN_WIDTH = 4.8;
const TERRAIN_DEPTH = 5.5;
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

const SCAN_GLSL = `
  uniform float uTime; uniform sampler2D uMask;
  uniform vec2 uClickPos; uniform float uClickStart;
  uniform float uSweepX; uniform float uSweepDir; uniform float uSweepActive;
  uniform vec2 uFocusPos; uniform float uFocusAmount; uniform float uFocusStart;
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

function buildSites() {
  const layer = document.getElementById('site-markers');
  const list = document.getElementById('site-list');
  siteMarkers = SITES.map(site => {
    const uv = geoUv(site.lon, site.lat);
    const point = new THREE.Vector3((uv.x - 0.5) * TERRAIN_WIDTH, terrainHeightAt(uv) + 0.115, (0.5 - uv.y) * TERRAIN_DEPTH);
    const button = textElement('button', 'site-marker', site.name);
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
  let nearest = null, nearestDistance = 27;
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
  if (aimedSite !== nearest?.site) {
    aimedSite = nearest?.site ?? null;
    if (nearest) {
      uniforms.uFocusPos.value.copy(nearest.uv);
      uniforms.uFocusStart.value = time;
    }
  }
  const focus = aimedSite ? siteMarkers.find(marker => marker.site === aimedSite) : null;
  const focusAmount = aimedSite ? 1 : 0;
  uniforms.uFocusAmount.value += (focusAmount - uniforms.uFocusAmount.value) * 0.08;
  for (const marker of siteMarkers) {
    marker.button.classList.toggle('is-aimed', marker.site === aimedSite);
    marker.button.classList.toggle('is-selected', marker.site === selectedSite);
    marker.button.classList.toggle('is-dimmed', !!aimedSite && marker.site !== aimedSite);
  }
  const occupied = [];
  const ordered = [...siteMarkers].filter(marker => marker.visible).sort((a, b) =>
    Number(b.site === aimedSite) - Number(a.site === aimedSite) ||
    Number(b.site === selectedSite) - Number(a.site === selectedSite)
  );
  for (const marker of ordered) {
    const box = { left: marker.x - 8, right: marker.x + 21 + marker.site.name.length * 12, top: marker.y - 12, bottom: marker.y + 12 };
    const overlaps = occupied.some(other => box.left < other.right + 4 && box.right > other.left - 4 && box.top < other.bottom + 3 && box.bottom > other.top - 3);
    marker.button.classList.toggle('is-compact', overlaps);
    if (!overlaps) occupied.push(box);
  }
  document.querySelector('.reticle').classList.toggle('aimed', !!aimedSite);
  const callout = document.getElementById('site-callout');
  const active = focus?.site ?? selectedSite;
  callout.hidden = !active;
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

function setAngle(yaw, pitch) {
  settings.yaw = clamp(yaw, -limits.yaw, limits.yaw);
  settings.pitch = clamp(pitch, -limits.pitch, limits.pitch);
  updateCamera();
}

function setStatus(message, duration = 2200) {
  readout.textContent = message;
  clearTimeout(setStatus.timeout);
  setStatus.timeout = setTimeout(() => { readout.textContent = settings.idle ? '待机扫描中' : '待机扫描已暂停'; }, duration);
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
      settings[key] = Number(input.value);
      document.getElementById(`${key}-value`).textContent = `${settings[key].toFixed(1)} m`;
      updateCamera();
    });
  }
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
    readout.textContent = settings.idle ? '待机扫描中' : '待机扫描已暂停';
    if (settings.idle) nextIdle = clock.getElapsedTime() + 0.3;
  });
  document.getElementById('center-scan').addEventListener('click', () => scanAt(new THREE.Vector2(0.5, 0.5)));

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
    if (down.dragged) setAngle(down.yaw - dx * 0.075, down.pitch + dy * 0.075);
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
    if (hit) scanAt(hit.uv);
  });
  canvas.addEventListener('pointercancel', () => { down = null; });
  canvas.addEventListener('wheel', event => {
    event.preventDefault();
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

  // A physical triangular wire mesh follows the terrain instead of a screen-space square grid.
  const meshGeometry = new THREE.PlaneGeometry(TERRAIN_WIDTH, TERRAIN_DEPTH, 86, 99);
  meshGeometry.rotateX(-Math.PI / 2);
  const meshPositions = meshGeometry.attributes.position;
  const meshUvs = meshGeometry.attributes.uv;
  for (let i = 0; i < meshPositions.count; i++) {
    meshPositions.setY(i, heightAt(new THREE.Vector2(meshUvs.getX(i), meshUvs.getY(i))) + 0.018);
  }
  const wireGeometry = new THREE.WireframeGeometry(meshGeometry);
  const lineStrength = new Float32Array(wireGeometry.attributes.position.count);
  for (let i = 0; i < lineStrength.length; i += 2) {
    const value = Math.random() < 0.59 ? 0 : 0.17 + Math.pow(Math.random(), 2.2) * 0.83;
    lineStrength[i] = lineStrength[i + 1] = value;
  }
  wireGeometry.setAttribute('aStrength', new THREE.BufferAttribute(lineStrength, 1));
  const wireMaterial = new THREE.ShaderMaterial({
    uniforms, transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending,
    vertexShader: `attribute float aStrength; varying vec2 vUv; varying float vStrength; void main(){ vUv=vec2((position.x+2.4)/4.8,(2.75-position.z)/5.5); vStrength=aStrength; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
    fragmentShader: `${SCAN_GLSL}
      varying vec2 vUv; varying float vStrength;
      void main(){
        if(texture2D(uMask,vUv).r<0.5) discard;
        vec2 s=scanSignal(vUv);
        float alpha=clamp((s.x*0.065+s.y*0.14)*vStrength,0.0,0.15);
        vec3 color=mix(vec3(0.24,0.69,0.73),vec3(0.49,0.91,0.91),clamp(s.y,0.0,1.0));
        gl_FragColor=vec4(color,alpha);
      }`,
  });
  const wire = new THREE.LineSegments(wireGeometry, wireMaterial);
  wire.renderOrder = 2;
  scene.add(wire);

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
    pointPositions[count * 3 + 1] = heightAt(uv) + 0.026 + Math.random() * 0.095;
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
      void main(){vUv=aUv;vSeed=aSeed;vec4 mv=modelViewMatrix*vec4(position,1.0);gl_Position=projectionMatrix*mv;gl_PointSize=clamp(aSize*23.0/-mv.z,1.2,6.5);}`,
    fragmentShader: `${SCAN_GLSL}
      varying vec2 vUv; varying float vSeed;
      void main(){
        vec2 s=scanSignal(vUv);
        float twinkle=0.38+0.62*pow(0.5+0.5*sin(uTime*(2.1+vSeed*4.0)+vSeed*113.0),2.0);
        float focusDist=length((vUv-uFocusPos)*vec2(4.8,5.5));
        float core=exp(-pow(focusDist/0.72,2.0));
        float pulseRadius=mod(max(uTime-uFocusStart,0.0)*0.43,1.65);
        float pulse=exp(-pow((focusDist-pulseRadius)/0.28,2.0))*(0.6+0.4*sin(uTime*2.5));
        float focusLight=uFocusAmount*(core*0.57+pulse*0.25);
        float energy=clamp((s.x*0.48+s.y*0.68)*mix(1.0,0.34,uFocusAmount)+focusLight,0.0,0.75);
        vec2 p=gl_PointCoord-0.5;
        float glow=exp(-dot(p,p)*12.0);
        float alpha=glow*energy*twinkle*(0.24+vSeed*0.76);
        vec3 cyan=vec3(0.28,0.87,0.91);
        vec3 gold=vec3(1.0,0.79,0.46);
        vec3 color=mix(cyan,gold,step(0.965,vSeed));
        gl_FragColor=vec4(color,alpha);
      }`,
  });
  const points = new THREE.Points(pointGeometry, pointMaterial);
  points.renderOrder = 3;
  scene.add(points);

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
  camera.updateProjectionMatrix();
}

function animate() {
  requestAnimationFrame(animate);
  const time = clock.getElapsedTime();
  uniforms.uTime.value = time;
  if (settings.idle && time >= nextIdle) {
    sweepStart = time;
    sweepDirection = Math.random() < 0.5 ? 1 : -1;
    nextIdle = time + SWEEP_DURATION + 1.6 + Math.random() * 1.8;
  }
  const progress = (time - sweepStart) / SWEEP_DURATION;
  const sweepActive = settings.idle && progress >= 0 && progress <= 1;
  const sweepX = sweepDirection > 0 ? -0.06 + progress * 1.12 : 1.06 - progress * 1.12;
  uniforms.uSweepX.value = sweepX;
  uniforms.uSweepDir.value = sweepDirection;
  uniforms.uSweepActive.value = sweepActive ? 1 : 0;
  scanSheet.visible = sweepActive && sweepX > 0 && sweepX < 1;
  if (scanSheet.visible) scanSheet.position.x = (sweepX - 0.5) * TERRAIN_WIDTH;
  updateSites(time);
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
    camera = new THREE.PerspectiveCamera(48, 1, 0.05, 100);
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
