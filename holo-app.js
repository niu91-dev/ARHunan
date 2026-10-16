/* ============================================================================
   湖南地形全息扫描 · 沙盘视角 Demo（AR 版）
   ----------------------------------------------------------------------------
   ★ 展示层【逐行照搬】参考项目 hunan-terrain-ar-demo 的 app.js：
       环境（暗底 / 雾 / 半球光 + 双向光 / 台座 / 地面 / 网格）
       地形（0xa3b4a8 材质、baseLift 0.025、relief 0.29、DoubleSide）
       空间扫描（scan-surface.js 的 HoloLens 点云 + 局部三角连接）
       地面定位光柱（buildGroundBeacon 的着色器）
       地点图标 / 引线 / 准心 / 资料卡 / 中心涟漪（sites.css 全套）

   ★ 只有「相机」这一块换成了我们自己的 3DoF 陀螺仪方案（holo-ar.js）：
       姿态 deviceorientation + devicemotion 融合
       首次拿到姿态即对齐（滚转由 lookAt 决定）
       视野裁剪（NDC 边距 + 滞回）+ 遮挡剔除（高度场 48 步行军）

   ★ 视图裁剪 / 遮挡的结论必须【同时】驱动 Three 网格（光柱）与 DOM（图标、引线），
     否则会出现「图标还在、光柱没了」这种自相矛盾的画面。
============================================================================ */
import * as THREE from 'three';
import { SITES, GEO_BOUNDS } from './sites.js';
import { createTerrainScan } from './scan-surface.js';
import { setupCameraPreview } from './camera-preview.js';
import { createArCamera, OCCLUSION_THRESHOLDS } from './holo-ar.js?v=20261015-fovgimbal1';

const scanReview = new URLSearchParams(location.search).get('review') === 'scan';
document.body.classList.toggle('scan-review', scanReview);

const sceneHost = document.getElementById('scene');
const readout = document.getElementById('scan-readout');
const hint = document.getElementById('hint');
const errorBox = document.getElementById('error');
const settings = { idle: true };
const BASE_VERTICAL_FOV = 48;
const TERRAIN_ASPECT = 5.5 / 4.8;
const DWELL_SECONDS = 0.5;
const clock = new THREE.Clock();
const UP_Y = new THREE.Vector3(0, 1, 0);
let terrain, scanSurface, maskPixels, maskWidth, maskHeight, uniforms;
let clickCount = 0;
let nextIdle = 0;
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

/* ---------- 相机 AR 的参数表（基于现场实物实拍视觉纠偏）----------
   ★ 2026-10-15 依据实装固定支架 Pad 实拍反解校正：
     1. 沙盘为 φ2800 mm 正圆台面，实际制作的湖南起伏地形收容于圆内（长宽约 2.45m × 2.15m）；
     2. 地形相对圆盘中心向南微移 12 cm、向东微调 4 cm，使洞庭湖与南岭对称落入圆周；
     3. 支架离地高度实测高出台面 0.58 m，距圆心水平距离 1.93 m（离外沿约 0.53 m）；
     4. 支架夹具初始机械倾角使相机光学基准俯角为 20.2°；后摄水平视场 65°。 */
const P = {
  tableW: 1.88,                                 // 实际湖南地形东西向物理跨度（1.88 m，与实物沙盘东西跨度一致）
  tableD: 2.22,                                 // 实际湖南地形南北向物理跨度（2.22 m，与实物沙盘南北跨度一致）
  shiftX: 0.00,                                 // 东西向横向居中（0 cm）
  shiftZ: 0.38,                                 // 沿视线向南平移 38 cm（匹配实物沙盘在圆盘中的真实质心）
  camHeight: 0.58,                              // 相机离沙盘台面高度（实测 0.58 m）
  camDist: 1.93,                                // 相机离沙盘中心水平距离（实测 1.93 m）
  lateral: 0,                                   // 沿边左右位置（m）
  nominalPitch: 20.2,                           // 支架实物初始俯角（20.2°）
  /* 镜头：zoom 设为 1.0 消除旋转角速度差异，
     使虚拟边界与真实摄像头背景物体在旋转时保持 1:1 同步不拉扯。 */
  zoom: 1.0,
  smoothMs: 140,                                // 姿态平滑时间常数（ms），0 = 直通
  cull: true,                                   // 视野裁剪总开关
  occlusion: false,                             // 遮挡剔除开关（默认关闭，保持全息地标稳定常驻，消除山脊闪烁）
  heightAtUv: () => 0,                          // 地形高度（buildTerrain 里填）
  meshYAt: null,                                // 网格高度（诊断用第二个独立高度源）
  gimbal: {
    on: false,
    drive: 'gyro',
    off: new THREE.Vector3(-0.10, 0.06, 0.02),
    arm: 0.11,
    yawDeg: 0,
    pitchDeg: 0,
  },
};

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
let nextGazeWave = 0;
const GAZE_WAVE_INTERVAL = 6.8; // Shader reaches zero at 6.0 s; allow a quiet gap.
let lastCameraMotion = 0;
/* 相机「动过」——对齐原版的【事件型】语义：只在用户真正改变视角/位置时调用，
   对应原版 updateCamera()/updateLens() 里那句 `lastCameraMotion = now`。
   ⚠️ 绝不能写成「状态型」每帧刷新（如 `if (manualLook) lastCameraMotion = time`）：
   桌面默认就是手动模式，恒为真的条件会让 updateAmbientFeedback 的
   `time - lastCameraMotion < .20` 永远成立，中心扫描涟漪被永久屏蔽。 */
function noteCameraMotion() { lastCameraMotion = clock.getElapsedTime(); }
const gazeRaycaster = new THREE.Raycaster();
const gazeNdc = new THREE.Vector2(0, 0);

/* ---------- 遥测 / 报告用的量 ---------- */
const R = {};
let frameN = 0, fpsFrames = 0, fpsT0 = 0, fps = 0;

function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }

function geoUv(lon, lat) {
  const mercator = degrees => Math.log(Math.tan(Math.PI / 4 + degrees * Math.PI / 360));
  return new THREE.Vector2(
    (lon - GEO_BOUNDS.west) / (GEO_BOUNDS.east - GEO_BOUNDS.west),
    (mercator(lat) - mercator(GEO_BOUNDS.south)) / (mercator(GEO_BOUNDS.north) - mercator(GEO_BOUNDS.south))
  );
}

  /* ---------- 空间朝向变换（顺时针旋转90°，严格匹配现场物理沙盘：右北、左南、上西、下东）---------- */
  function uvToWorld(u, v, y = 0.0) {
    const p = new THREE.Vector3((u - 0.5) * P.tableW, y, (0.5 - v) * P.tableD);
    p.applyAxisAngle(UP_Y, -Math.PI / 2);
    p.add(new THREE.Vector3(P.shiftX || 0, 0, P.shiftZ || 0));
    return p;
  }

/* 世界坐标 → 地形 uv。与 holo-ar.js 里那份是同一个映射，这里再写一份是为了
   让 buildSites / 诊断出口不必依赖 ar 实例（加载顺序更简单）。 */
function worldToUv(x, z, out) {
    const p = new THREE.Vector3(x - (P.shiftX || 0), 0, z - (P.shiftZ || 0));
    p.applyAxisAngle(UP_Y, +Math.PI / 2);
    const u = p.x / P.tableW + 0.5;
    const v = 0.5 - p.z / P.tableD;
    return (out || new THREE.Vector2()).set(u, v);
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

/* ============================================================================
   渲染器 / 相机 / 相机 AR 实例
   ----------------------------------------------------------------------------
   ★ 必须先建相机再建 ar —— createArCamera 在创建时就把 camera 收进闭包了，
     之后再给 ar.camera 赋值是没用的（改的只是一个没人读的属性）。
   ============================================================================ */
const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setClearColor(0x000000, 0);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.2;
sceneHost.appendChild(renderer.domElement);
const camera = new THREE.PerspectiveCamera(BASE_VERTICAL_FOV, 1, 0.05, 100);

const ar = createArCamera({
  camera,
  params: () => P,
  hooks: {
    flash: showToast,
    onAligned() {
      const el = document.getElementById('ar-gate');
      if (el) el.hidden = true;
      syncArStatus();
    },
    onFirstOrient() { syncArStatus(); },
    onFallbackShow() { syncArStatus(); },
  },
});

/* ============================================================================
   提示条
   ============================================================================ */
let toastTimer = 0;
function showToast(message, duration = 2200) {
  const el = document.getElementById('ar-toast');
  if (!el) return;
  el.textContent = message;
  el.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('on'), duration);
}

function setStatus(message, duration = 2200) {
  readout.textContent = message;
  clearTimeout(setStatus.timeout);
  setStatus.timeout = setTimeout(() => {
    readout.textContent = aimedSite || manualSite ? '地点聚焦 · 中心涟漪暂停'
      : settings.idle ? '中心涟漪待机' : '中心涟漪已暂停';
  }, duration);
}

/* ============================================================================
   聚焦区 / 中心涟漪
   ============================================================================ */
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

function emitLocalPulse(uv,time,strength=.35,source='ambient') {
  const key = `${source}Pulses`;
  sceneHost.dataset[key] = String(Number(sceneHost.dataset[key] || 0) + 1);
  uniforms.uLocalPulses.value[localPulseIndex].set(uv.x,uv.y,time,strength);
  localPulseIndex=(localPulseIndex+1)%uniforms.uLocalPulses.value.length;
}
let localPulseIndex = 0;

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

/* ============================================================================
   资料卡（照搬参考项目）
   ============================================================================ */
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
  R.selectedSiteId = site.id;
  R.selectedSiteName = site.name;
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

/* ============================================================================
   地面定位光柱（照搬参考项目 buildGroundBeacon）
   ============================================================================ */
function buildGroundBeacon(uv,index) {
  const radius=.17;
  const geometry=new THREE.PlaneGeometry(radius*2,radius*2,28,28);
  const positions=geometry.attributes.position;
  for(let i=0;i<positions.count;i++){
    const localX=positions.getX(i),localY=positions.getY(i);
    const sample=new THREE.Vector2(uv.x+localX/P.tableW,uv.y+localY/P.tableD);
      const worldP = uvToWorld(sample.x, sample.y, terrainHeightAt(sample) + 0.004);
      positions.setXYZ(i, worldP.x, worldP.y, worldP.z);
  }
  geometry.computeBoundingSphere();
  const material=new THREE.ShaderMaterial({
    uniforms:{uTime:uniforms.uTime,uEffectGain:uniforms.uEffectGain,uSelected:{value:0},uOtherFocused:{value:0},uPhase:{value:index*.71},uMask:uniforms.uMask,uMapCenter:{value:uv.clone()},uMapSize:{value:new THREE.Vector2(radius*2/P.tableW,radius*2/P.tableD)}},
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
    const centerWorld = uvToWorld(uv.x, uv.y, terrainHeightAt(uv) + 0.124);
    beam.position.copy(centerWorld);
  beam.renderOrder=5;mesh.add(beam);scene.add(mesh);return mesh;
}

/* ============================================================================
   地点：图标 / 引线 / 光柱 / 右侧列表
   ============================================================================ */
function disposeSites() {
  for (const marker of siteMarkers) {
    marker.groundBeacon.geometry.dispose();
    marker.groundBeacon.material.dispose();
    scene.remove(marker.groundBeacon);
  }
  siteMarkers = [];
  document.getElementById('site-markers').replaceChildren();
  document.getElementById('site-stems').replaceChildren();
  document.getElementById('site-list').replaceChildren();
  document.getElementById('site-detail').replaceChildren(
    textElement('p', 'detail-empty', '选择地形上的光点，查看地点档案。'));
}

function buildSites() {
  const layer = document.getElementById('site-markers');
  const list = document.getElementById('site-list');
  siteMarkers = SITES.map((site, index) => {
    const uv = geoUv(site.lon, site.lat);
    const groundPoint = uvToWorld(uv.x, uv.y, terrainHeightAt(uv) + 0.004);
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
    return {
      site, uv, point, groundPoint, groundBeacon, stem, button, listButton,
      x: 0, y: 0, rawX: 0, rawY: 0, initialized: false, visible: false,
      /* 我们的两条判据的状态（滞回要上一帧的值） */
      inView: false, occluded: false, score: 0, screenOn: false,
    };
  });
}

function updateSites(time) {
  const width = sceneHost.clientWidth, height = sceneHost.clientHeight;
  document.getElementById('site-stems').setAttribute('viewBox',`0 0 ${width} ${height}`);
  const dt = Math.min(.1, Math.max(.001, time - previousSiteTime));
  previousSiteTime = time;
  let nearest = null, nearestDistance = 18;
  let visibleN = 0, occludedN = 0;
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

    /* ---------- 平滑出画判据：只要在相机前方，允许其自然滑过屏幕边缘 ---------- */
    const inFrontOfCamera = projected.z > 0 && projected.z < 1;
    /* 只有当中心完全滑出视野外较远距离时才彻底关闭，避免边缘露出半边时突然闪现猝死 */
    const onScreen = inFrontOfCamera && marker.x > -60 && marker.x < width + 60 && marker.y > -40 && marker.y < height + 40;

    /* ---------- 我们的两条判据 ----------
       ① 视野裁剪：NDC 边距 score + 滞回（holo-ar.js）
       ② 遮挡剔除：沿视线 48 步高度场行军，判据用【高度】不用【距离】
       ★ 判的是 groundPoint（真正贴在地形上的那个点）而不是抬高 0.27 m 的图标点 ——
         图标浮在空中，拿它去比地形高度会把「图标脚下那格地形」当成障碍物。 */
    const j = ar.judge(marker.groundPoint, marker.inView, marker.occluded);
    marker.inView = j.inView;
    marker.occluded = j.occluded;
    marker.score = j.score;
    marker.screenOn = onScreen;
    /* 只要在相机正面且在屏幕视口范围内即可渲染；关闭遮挡剔除后光柱与标牌稳定常驻 */
    const on = inFrontOfCamera && (!P.cull || onScreen) && (!P.occlusion || !j.occluded);

    marker.visible = on;
    marker.button.classList.toggle('is-hidden', !on);
    marker.stem.style.display = on && !scanReview ? '' : 'none';
    marker.groundBeacon.visible = on && !scanReview;
    if (on) visibleN++;
    if (marker.occluded) occludedN++;
    if (on) {
      marker.button.style.left = `${marker.x}px`;
      marker.button.style.top = `${marker.y}px`;
      const active = marker.site === (manualSite || aimedSite);
      marker.stem.setAttribute('d',`M ${marker.x} ${marker.y + (active ? 57 : 37)} L ${marker.groundX} ${marker.groundY - 4}`);
      marker.stem.classList.toggle('is-active', active);
      const distance = Math.hypot(marker.x - width / 2, marker.y - height / 2);
      if (!scanReview && distance < nearestDistance) { nearest = marker; nearestDistance = distance; }
    }
  }
  R.markerVisible = visibleN;
  R.markerOccluded = occludedN;
  R.markerTotal = siteMarkers.length;

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
  const focusAmount = focusSite ? 1 : 0;
  uniforms.uFocusAmount.value += (focusAmount - uniforms.uFocusAmount.value) * 0.08;
  for (const marker of siteMarkers) {
    marker.button.classList.toggle('is-aimed', marker.site === aimedSite);
    marker.button.classList.toggle('is-selected', marker.site === selectedSite);
    marker.button.classList.toggle('is-focused', marker.site === focusSite);
    const beaconFocus = marker.site === focusSite ? 1 : 0;
    marker.groundBeacon.material.uniforms.uSelected.value += (beaconFocus-marker.groundBeacon.material.uniforms.uSelected.value)*(1-Math.exp(-dt/.12));
    marker.groundBeacon.material.uniforms.uOtherFocused.value = focusSite && !beaconFocus ? 1 : 0;
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
  const active = focusSite ?? selectedSite;
  callout.hidden = true;
  if (active) {
    document.getElementById('callout-mode').textContent = focusSite ? 'GAZE / 已瞄准' : 'SELECTED / 已选择';
    document.getElementById('callout-name').textContent = active.name;
    document.getElementById('callout-anchor').textContent = active.anchor;
  }
}

/* ============================================================================
   地形 / 环境（照搬参考项目）
   ============================================================================ */
function maskAt(uv) {
  const x = clamp(Math.floor(uv.x * maskWidth), 0, maskWidth - 1);
  const y = clamp(Math.floor((1 - uv.y) * maskHeight), 0, maskHeight - 1);
  return maskPixels[(y * maskWidth + x) * 4] > 127;
}

function buildTerrain(heightGrid, meta, colorTexture, maskTexture) {
  const geometry = new THREE.PlaneGeometry(P.tableW, P.tableD, meta.width - 1, meta.height - 1);
  geometry.rotateX(-Math.PI / 2);
  const vertices = geometry.attributes.position;
  for (let i = 0; i < vertices.count; i++) {
    const elevation = Math.max(0, heightGrid[i]);
      vertices.setY(i, 0.025 + elevation / 2076 * 0.22 * (P.tableW / 4.8));
  }
  vertices.needsUpdate = true;
  geometry.computeVertexNormals();
  colorTexture.colorSpace = THREE.SRGBColorSpace;
  colorTexture.anisotropy = Math.min(renderer.capabilities.getMaxAnisotropy(), 8);
    terrain = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ map: colorTexture, color: 0xffffff, alphaTest: 0.5, roughness: 0.90, metalness: 0.0, side: THREE.DoubleSide }));
  terrain.name = 'HunanTerrain';
    terrain.rotation.y = -Math.PI / 2;
    terrain.position.set(P.shiftX || 0, 0, P.shiftZ || 0);
  scene.add(terrain);
    referenceObjects.push(terrain);

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
    /* 移动端适配：gl_PointSize / 屏幕空间线宽的 offset 都以 framebuffer 像素为单位，
       高 DPR 屏（DPR 2~3）不补偿的话点云只有 0.7 CSS px ≈ 0.2 mm，肉眼不可见。 */
    uPixelRatio: { value: 1 },
    uViewport: { value: new THREE.Vector2(1, 1) },
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
    /* ★ 起伏按沙盘尺寸比例缩放（对齐旧页面的 reliefM = 0.29×tableW/4.8）：
       4.8 m 参考盘上 2076 m → 0.29 m；2.8 m 现场盘按比例降到 0.169 m，
       山体高径比与现场实物一致（≈直径 6%）。不缩放的话小沙盘上的山会偏高变陡。 */
      return 0.025 + height / 2076 * 0.22 * (P.tableW / 4.8);
  }
  terrainHeightAt = heightAt;
  P.heightAtUv = heightAt;

  /* 第二个【独立】的高度源：直接读渲染网格的顶点，不走 heightAt 的插值公式。
     遮挡剔除的自动化验证拿它做交叉比对 —— 两个独立来源给出同一个结论，
     才能排除「查表函数自己写错了」这种可能。 */
  P.meshYAt = (x, z) => {
    const rc = new THREE.Raycaster(
      new THREE.Vector3(x, 3, z), new THREE.Vector3(0, -1, 0), 0, 6);
    const hit = rc.intersectObject(terrain, false);
    return hit.length ? hit[0].point.y : null;
  };

  scanSurface = createTerrainScan({ THREE, scene: scene, uniforms, heightAt, maskAt, width: P.tableW, depth: P.tableD });
  scanSurface.points.rotation.y = -Math.PI / 2;
  scanSurface.points.position.set(P.shiftX || 0, 0, P.shiftZ || 0);
  scanSurface.links.rotation.y = -Math.PI / 2;
  scanSurface.links.position.set(P.shiftX || 0, 0, P.shiftZ || 0);
}

function buildEnvironment() {
  scene = new THREE.Scene();
  scene.background = null;
  scene.fog = null;
  scene.add(new THREE.HemisphereLight(0xd1e7dc, 0x314d41, 2.15));
  const sun = new THREE.DirectionalLight(0xf4f0d5, 2.2);
  sun.position.set(-3, 8, 4);
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0x50baa3, 0.7);
  fill.position.set(3, 4, -5);
  scene.add(fill);



    /* 圆形沙盘边界线（外径 φ2800 + 内径 φ2750，与实物台面 1:1 对齐） */
    function makeCircleLine(radius, color, opacity) {
      const pts = [];
      for (let i = 0; i <= 128; i++) {
        const t = (i / 128) * Math.PI * 2;
        pts.push(new THREE.Vector3(Math.cos(t) * radius, 0.003, Math.sin(t) * radius));
      }
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity });
      const line = new THREE.Line(geo, mat);
      line.name = `TableCircle_${radius}`;
      return line;
    }
    const circleOuter = makeCircleLine(1.40, 0x50baa3, 0.65);
    const circleInner = makeCircleLine(1.375, 0x50baa3, 0.35);
    scene.add(circleOuter);
    scene.add(circleInner);
    referenceObjects.push(circleOuter, circleInner);
}
const referenceObjects = [];

let scene;

/* ============================================================================
   镜头：照抄参考项目（BASE_VERTICAL_FOV + zoom），
   保证默认取景与参考项目逐像素一致。相机 AR 块只管【位姿】，不管镜头参数。
   ============================================================================ */
function updateLens() {
  if (!camera) return;
  const baseHorizontal = 2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(BASE_VERTICAL_FOV) / 2) * camera.aspect);
  const targetHorizontal = baseHorizontal / P.zoom;

  // 摄像头画幅适配：如果摄像头正在运行，根据其真实分辨率与当前视口宽高比，计算 object-fit: cover 裁切比例
  const video = document.getElementById('camera-feed');
  let aspectScaleX = 1.0;
  let hasActiveVideo = false;
  if (video && !video.hidden && video.videoWidth && video.videoHeight) {
    hasActiveVideo = true;
    const videoAspect = video.videoWidth / video.videoHeight;
    const screenAspect = camera.aspect;
    if (videoAspect > screenAspect) {
      // 视频（如 16:9）比视口（如 16:10）更宽：object-fit: cover 裁切左右，水平视场角按比例收缩
      aspectScaleX = screenAspect / videoAspect;
    }
  }

  const tanHalfTargetH = Math.tan(targetHorizontal / 2);
  const tanHalfEffectiveH = tanHalfTargetH * aspectScaleX;
  const effectiveHorizontal = 2 * Math.atan(tanHalfEffectiveH);

  // Three.js 的 camera.fov 是垂直视场角，由等效水平视场角推导
  camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(tanHalfEffectiveH / camera.aspect));
  camera.updateProjectionMatrix();

  const zv = document.getElementById('zoom-value');
  const hFovDeg = Number(THREE.MathUtils.radToDeg(effectiveHorizontal).toFixed(1));
  const nominalHFovDeg = Number(THREE.MathUtils.radToDeg(targetHorizontal).toFixed(1));
  if (zv) {
    if (hasActiveVideo && aspectScaleX < 0.999) {
      zv.textContent = `${P.zoom.toFixed(2)}× (等效 ${hFovDeg}° / 标称 ${nominalHFovDeg}°)`;
    } else {
      zv.textContent = `${P.zoom.toFixed(2)}× (${hFovDeg}°)`;
    }
  }
  R.zoom = P.zoom;
  R.hFovDeg = hFovDeg;
  R.nominalHFovDeg = nominalHFovDeg;
  R.vFovDeg = Number(camera.fov.toFixed(2));
  R.aspect = Number(camera.aspect.toFixed(4));
  R.videoAspectScale = aspectScaleX;
}

function resize() {
  const width = sceneHost.clientWidth, height = sceneHost.clientHeight;
  if (!width || !height) return;
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  /* 点云 / 连线的屏幕空间着色要知道 framebuffer 实际像素数，否则高 DPR 屏上
     gl_PointSize 与线 offset 会被除以 DPR，视觉元素缩到 0.2 mm 级不可见 */
  uniforms.uPixelRatio.value = renderer.getPixelRatio();
  renderer.getDrawingBufferSize(uniforms.uViewport.value);
  updateLens();
}

/* ============================================================================
   控件
   ============================================================================ */
const dragger = new THREE.Raycaster();
const pointer = new THREE.Vector2();

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
  for (const [key, prop] of [['height', 'camHeight'], ['distance', 'camDist'], ['lateral', 'lateral']]) {
    const input = document.getElementById(key);
    input.addEventListener('input', () => {
      clearManualFocus();
      P[prop] = Number(input.value);
      document.getElementById(`${key}-value`).textContent = `${P[prop].toFixed(1)} m`;
      if (ar.isManualLook()) ar.resetLook();
      noteCameraMotion();
      syncArStatus();
    });
  }
  document.getElementById('zoom').addEventListener('input', event => {
    clearManualFocus();
    P.zoom = Number(event.target.value);
    updateLens();
    noteCameraMotion();
  });
  document.querySelectorAll('[data-dir]').forEach(button => button.addEventListener('click', () => {
    const dir = button.dataset.dir;
    /* 方向键的语义与参考项目一致（← 让画面左移 = 相机右转），
       而我们的 nudgeLook 正号 = 向左转、正号俯角 = 低头，所以两处都取负。 */
    if (dir === 'reset') ar.resetLook();
    if (dir === 'up') ar.nudgeLook(0, -3);
    if (dir === 'down') ar.nudgeLook(0, 3);
    if (dir === 'left') ar.nudgeLook(-3, 0);
    if (dir === 'right') ar.nudgeLook(3, 0);
    noteCameraMotion();
  }));
  window.addEventListener('keydown', event => {
    if (event.target instanceof HTMLInputElement) return;
    const step = event.shiftKey ? 0.25 : 3;
    const dirs = { ArrowUp: [0, -step], ArrowDown: [0, step], ArrowLeft: [-step, 0], ArrowRight: [step, 0] };
    if (!dirs[event.key]) return;
    event.preventDefault();
    ar.nudgeLook(dirs[event.key][0], dirs[event.key][1]);
    noteCameraMotion();
  });
  document.getElementById('idle-toggle').addEventListener('change', event => {
    settings.idle = event.target.checked;
    readout.textContent = aimedSite || manualSite ? '地点聚焦 · 中心涟漪暂停' : settings.idle ? '中心涟漪待机' : '中心涟漪已暂停';
    if (!settings.idle) uniforms.uClickStart.value = -100;
    else nextGazeWave = Math.max(nextGazeWave,clock.getElapsedTime()+.3);
  });
  document.getElementById('center-scan').addEventListener('click', () => { clearManualFocus(); scanFromReticle(); });

  const canvas = renderer.domElement;
  let down = null;
  canvas.addEventListener('pointerdown', event => {
    canvas.setPointerCapture(event.pointerId);
    /* ★ from.x/from.y 是拖动位移的基准点，必须填成【按下瞬间的真实指针坐标】。
       dragStart() 返回的 x/y 是 0；若不覆写，dragLook 里 `clientX - from.x`
       会把指针的绝对屏幕坐标当成位移——画布中央（x≈576）按下后随便一动
       视角就瞬间跳 576×0.075 ≈ 43°，拖动完全失真。 */
    const from = ar.dragStart();
    from.x = event.clientX; from.y = event.clientY;
    down = { x: event.clientX, y: event.clientY, from, dragged: false };
  });
  canvas.addEventListener('pointermove', event => {
    if (!down) return;
    const dx = event.clientX - down.x, dy = event.clientY - down.y;
    if (Math.hypot(dx, dy) > 5) down.dragged = true;
    /* ★ 拖动只在【手动转视角】模式下转相机。
       陀螺仪接管的真机上，姿态由平板决定，拖动再改姿态会让两者打架。 */
    if (down.dragged && ar.isManualLook()) { ar.dragLook(event.clientX, event.clientY, down.from); noteCameraMotion(); }
  });
  canvas.addEventListener('pointerup', event => {
    if (!down) return;
    const dragged = down.dragged;
    down = null;
    if (dragged) return;
    const bounds = canvas.getBoundingClientRect();
    const localX = event.clientX - bounds.left, localY = event.clientY - bounds.top;
    /* 先打图标（DOM 里就是按钮，命中判定用它的屏幕坐标），
       打不中再退回打地形 —— 与参考项目一致。 */
    const marker = !scanReview && siteMarkers.find(item =>
      item.visible && Math.hypot(item.x - localX, item.y - localY) < 23);
    if (marker) { selectSite(marker.site); return; }
    pointer.set(((event.clientX - bounds.left) / bounds.width) * 2 - 1, -((event.clientY - bounds.top) / bounds.height) * 2 + 1);
    dragger.setFromCamera(pointer, camera);
    const hit = dragger.intersectObject(terrain, false).find(item => item.uv && maskAt(item.uv));
    if (hit) { clearManualFocus(); scanAt(hit.uv); }
  });
  canvas.addEventListener('pointercancel', () => { down = null; });
  canvas.addEventListener('wheel', event => {
    event.preventDefault();
    clearManualFocus();
    P.camDist = clamp(P.camDist + Math.sign(event.deltaY) * 0.2, 4.2, 9.5);
    const di = document.getElementById('distance');
    di.value = P.camDist;
    document.getElementById('distance-value').textContent = `${P.camDist.toFixed(1)} m`;
    if (ar.isManualLook()) ar.resetLook();
  }, { passive: false });
}

function setupScanReview() {
  const rw = document.getElementById('review-wave');
  if (rw) rw.addEventListener('click', scanFromReticle);
  const rl = document.getElementById('review-layer');
  if (rl) {
    rl.addEventListener('change', event => {
      scanSurface.points.visible = event.target.value !== 'lines';
      scanSurface.links.visible = event.target.value !== 'points';
    });
  }
  for (const [id, uniform] of [['review-light', 'uEffectGain'], ['review-ripple', 'uRippleGain']]) {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('input', event => {
        uniforms[uniform].value = Number(event.target.value);
        const out = document.getElementById(`${id}-value`);
        if (out) out.textContent = Number(event.target.value).toFixed(2);
      });
    }
  }
  if (scanReview) {
    document.title = '空间扫描效果确认 · 湖南沙盘 R06';
    P.camHeight = 3.5; P.camDist = 5.4; P.zoom = 1.4;
    document.getElementById('height').value = P.camHeight;
    document.getElementById('distance').value = P.camDist;
    document.getElementById('zoom').value = P.zoom;
    updateLens();
    document.querySelector('.panel-header h1').innerHTML = '空间扫描<br><em>效果确认</em>';
    document.querySelector('.panel-header p').textContent = '仅显示贴地形点线与柔和涟漪。拖动检查贴合，点击任意地形发起扩散。';
    hint.textContent = '拖动观察 · 点击地形发起柔和扩散';
  }
}

/* ============================================================================
   相机 AR 的控件
   ============================================================================ */
function setSwitch(id, on) {
  const el = document.getElementById(id);
  if (el) el.checked = !!on;
}
function setBtn(id, text, pressed) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  el.setAttribute('aria-pressed', String(!!pressed));
}

function syncArStatus() {
  const st = document.getElementById('ar-status');
  if (!st) return;
  const d = ar.debug;
  const parts = [];
  parts.push(d.aligned ? '已对齐' : d.haveOrient ? '等待对齐' : '无陀螺仪数据');
  parts.push(ar.isManualLook() ? '未开启陀螺仪' : '陀螺仪跟随中');
  parts.push(`视野内 ${R.markerVisible ?? 0}/${R.markerTotal ?? SITES.length}`);
  if (R.markerOccluded) parts.push(`被遮挡 ${R.markerOccluded}`);
  st.textContent = parts.join(' · ');
  setBtn('gyro-toggle', ar.isManualLook() ? '开启陀螺仪跟随' : '陀螺仪跟随中', !ar.isManualLook());
  setSwitch('ar-cull', P.cull);
  setSwitch('ar-occl', P.occlusion);
  setSwitch('ar-fusion', ar.debug.motionFusion);
  setSwitch('gimbal-toggle', P.gimbal ? P.gimbal.on : false);
}


function setupArControls() {

  const gyroBtn = document.getElementById('gyro-toggle');
  if (gyroBtn) {
    gyroBtn.addEventListener('click', async () => {
      if (!ar.isManualLook()) { ar.setManualLook(true); syncArStatus(); return; }
      const perm = await ar.requestPermission();
      if (!perm.ok) { showToast('陀螺仪权限未授予：' + perm.reason); syncArStatus(); return; }
      ar.attach();
      ar.setManualLook(false);
      hint.textContent = '转动平板改变视线 · 点击地形触发扫描';
      const gate = document.getElementById('ar-gate');
      if (gate) gate.hidden = true;
      syncArStatus();
    });
  }
  document.getElementById('ar-align').addEventListener('click', () => { ar.align(false); noteCameraMotion(); });
  document.getElementById('ar-zero').addEventListener('click', () => { ar.zeroDrift(); noteCameraMotion(); });
  const rz = document.getElementById('ar-reset-view');
  if (rz) rz.addEventListener('click', () => { ar.resetLook(); noteCameraMotion(); });
  document.getElementById('ar-cull').addEventListener('change', e => { P.cull = e.target.checked; syncArStatus(); });
  document.getElementById('ar-occl').addEventListener('change', e => { P.occlusion = e.target.checked; syncArStatus(); });
  document.getElementById('ar-fusion').addEventListener('change', e => { ar.setMotionFusion(e.target.checked); syncArStatus(); });
  const gt = document.getElementById('gimbal-toggle');
  const gar = document.getElementById('gimbal-arm');
  const garRow = document.getElementById('gimbal-arm-row');
  const garVal = document.getElementById('gimbal-arm-value');
  if (gt) {
    gt.addEventListener('change', e => {
      P.gimbal.on = e.target.checked;
      if (gar) gar.style.display = P.gimbal.on ? 'block' : 'none';
      if (garRow) garRow.style.display = P.gimbal.on ? 'flex' : 'none';
      ar.syncGimbalPivot();
      noteCameraMotion();
      syncArStatus();
    });
  }
  if (gar) {
    gar.addEventListener('input', e => {
      const arm = Number(e.target.value);
      P.gimbal.arm = arm;
      P.gimbal.off.set(-arm * 0.9, arm * 0.5, arm * 0.2);
      if (garVal) garVal.textContent = `${arm.toFixed(2)} m`;
      ar.syncGimbalPivot();
      noteCameraMotion();
    });
  }
  const gate = document.getElementById('ar-gate');
  if (gate) {
    gate.addEventListener('click', async () => {
      const perm = await ar.requestPermission();
      if (perm.ok) {
        ar.attach();
        ar.setManualLook(false);
        hint.textContent = '转动平板改变视线 · 点击地形触发扫描';
        gate.hidden = true;
        syncArStatus();
      }
    });
  }
}

/* ============================================================================
   抽屉式面板开关
   ============================================================================ */
function setupPanelDrawer() {
  const panel = document.getElementById('panel');
  const btnOpen = document.getElementById('btn-open-panel');
  const btnClose = document.getElementById('btn-close-panel');

  function openPanel() {
    if (panel) {
      panel.classList.add('is-open');
      btnOpen?.setAttribute('aria-expanded', 'true');
    }
  }

  function closePanel() {
    if (panel) {
      panel.classList.remove('is-open');
      btnOpen?.setAttribute('aria-expanded', 'false');
    }
  }

  if (btnOpen) btnOpen.addEventListener('click', openPanel);
  if (btnClose) btnClose.addEventListener('click', closePanel);

  window.addEventListener('keydown', event => {
    if (event.key === 'Escape') closePanel();
  });

  const params = new URLSearchParams(location.search);
  if (params.get('panel') === 'open' || params.has('settings')) {
    openPanel();
  }

  return { open: openPanel, close: closePanel };
}

/* ============================================================================
   标定设置持久化（本地保存与恢复）
   ============================================================================ */
  const SETTINGS_STORAGE_KEY = 'hunan_holo_ar_settings_v1';

  /* 3D 边界下切断崖裙边（匹配实物沙盘四周 40~60mm 高的立体岩土剖面） */
  function buildBoundarySkirt(uvList) {
    const positions = [];
    const uvs = [];
    const N = uvList.length;
    for (let i = 0; i < N; i++) {
      const nextIdx = (i + 1) % N;
      const [u0, v0] = uvList[i];
      const [u1, v1] = uvList[nextIdx];
      const pTop0 = uvToWorld(u0, v0, terrainHeightAt({ x: u0, y: v0 }));
      const pTop1 = uvToWorld(u1, v1, terrainHeightAt({ x: u1, y: v1 }));
      const yBottom = 0.002;
      positions.push(
        pTop0.x, pTop0.y, pTop0.z,  pTop0.x, yBottom, pTop0.z,  pTop1.x, yBottom, pTop1.z,
        pTop0.x, pTop0.y, pTop0.z,  pTop1.x, yBottom, pTop1.z,  pTop1.x, pTop1.y, pTop1.z
      );
      uvs.push(
        u0, v0,  u0, 0.0,  u1, 0.0,
        u0, v0,  u1, 0.0,  u1, v1
      );
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.computeVertexNormals();
    const skirtMat = new THREE.MeshStandardMaterial({
      color: 0x826c54, // 温暖的黄褐岩土层剖面质感，与实物切面匹配
      roughness: 0.94,
      metalness: 0.04,
      side: THREE.DoubleSide
    });
    const skirt = new THREE.Mesh(geo, skirtMat);
    skirt.name = 'HunanBoundarySkirt';
    scene.add(skirt);
    referenceObjects.push(skirt);
    return skirt;
  }

const DEFAULT_SETTINGS = {
    camHeight: 0.58,
    camDist: 1.93,
    zoom: 1.0,
  lateral: 0.0,
  idle: true,
  cull: true,
  occlusion: false,
};

function applySettingsToUI(s) {
  if (s.camHeight !== undefined) {
    P.camHeight = Number(s.camHeight);
    const el = document.getElementById('height');
    if (el) el.value = P.camHeight;
    const out = document.getElementById('height-value');
    if (out) out.textContent = `${P.camHeight.toFixed(2)} m`;
  }
  if (s.camDist !== undefined) {
    P.camDist = Number(s.camDist);
    const el = document.getElementById('distance');
    if (el) el.value = P.camDist;
    const out = document.getElementById('distance-value');
    if (out) out.textContent = `${P.camDist.toFixed(1)} m`;
  }
  if (s.zoom !== undefined) {
    P.zoom = Number(s.zoom);
    const el = document.getElementById('zoom');
    if (el) el.value = P.zoom;
    const out = document.getElementById('zoom-value');
    if (out) out.textContent = `${P.zoom.toFixed(1)}×`;
    updateLens();
  }
  if (s.lateral !== undefined) {
    P.lateral = Number(s.lateral);
    const el = document.getElementById('lateral');
    if (el) el.value = P.lateral;
    const out = document.getElementById('lateral-value');
    if (out) out.textContent = `${P.lateral.toFixed(1)} m`;
  }
  if (s.idle !== undefined) {
    settings.idle = !!s.idle;
    const el = document.getElementById('idle-toggle');
    if (el) el.checked = settings.idle;
  }
  if (s.cull !== undefined) {
    P.cull = !!s.cull;
    setSwitch('ar-cull', P.cull);
  }
  if (s.occlusion !== undefined) {
    P.occlusion = !!s.occlusion;
    setSwitch('ar-occl', P.occlusion);
  }
  if (s.gimbalOn !== undefined && P.gimbal) {
    P.gimbal.on = !!s.gimbalOn;
    setSwitch('gimbal-toggle', P.gimbal.on);
    const gar = document.getElementById('gimbal-arm');
    const garRow = document.getElementById('gimbal-arm-row');
    if (gar) gar.style.display = P.gimbal.on ? 'block' : 'none';
    if (garRow) garRow.style.display = P.gimbal.on ? 'flex' : 'none';
  }
  if (s.gimbalArm !== undefined && P.gimbal) {
    P.gimbal.arm = Number(s.gimbalArm);
    P.gimbal.off.set(-P.gimbal.arm * 0.9, P.gimbal.arm * 0.5, P.gimbal.arm * 0.2);
    const gar = document.getElementById('gimbal-arm');
    const garVal = document.getElementById('gimbal-arm-value');
    if (gar) gar.value = P.gimbal.arm;
    if (garVal) garVal.textContent = `${P.gimbal.arm.toFixed(2)} m`;
  }
  syncArStatus();
}

function loadSavedSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return false;
    const data = JSON.parse(raw);
    applySettingsToUI(data);
    return true;
  } catch (err) {
    console.warn('读取本地设置失败：', err);
    return false;
  }
}

function setupSettingsPersistence() {
  const btnSave = document.getElementById('btn-save-settings');
  const btnReset = document.getElementById('btn-reset-settings');

  function saveCurrent() {
    const data = {
      camHeight: P.camHeight,
      camDist: P.camDist,
      zoom: P.zoom,
      lateral: P.lateral,
      idle: settings.idle,
      cull: P.cull,
      occlusion: P.occlusion,
      gimbalOn: P.gimbal ? P.gimbal.on : false,
      gimbalArm: P.gimbal ? P.gimbal.arm : 0.11,
      savedAt: new Date().toISOString(),
    };
    try {
      localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(data));
      showToast('✓ 设置参数已保存到本地');
      if (btnSave) {
        const origText = btnSave.innerHTML;
        btnSave.innerHTML = '<span style="font-size:14px;vertical-align:0">✓</span><span>已保存</span>';
        btnSave.style.background = '#286b55';
        setTimeout(() => {
          btnSave.innerHTML = origText;
          btnSave.style.background = '';
        }, 1800);
      }
      return true;
    } catch (err) {
      showToast('保存失败：' + (err.message || '存储空间不足'));
      return false;
    }
  }

  function resetCurrent() {
    try {
      localStorage.removeItem(SETTINGS_STORAGE_KEY);
    } catch (e) {}
    applySettingsToUI(DEFAULT_SETTINGS);
    showToast('已恢复默认参数');
  }

  if (btnSave) btnSave.addEventListener('click', saveCurrent);
  if (btnReset) btnReset.addEventListener('click', resetCurrent);

  loadSavedSettings();

  return { save: saveCurrent, reset: resetCurrent, load: loadSavedSettings };
}

/* ============================================================================
   遥测条
   ============================================================================ */
let hudT0 = 0;
function updateHud(now) {
  if (now - hudT0 < 200) return;
  hudT0 = now;
  const d = ar.debug;
  const va = ar.viewAnglesDeg();
  const set = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
  /* 两处读数（AR 区块 + 参考项目的「02 Pad 视线」）同步 —— 同一份数据，两个入口 */
  for (const id of ['yaw-value', 'yaw-value-ar']) set(id, `${Math.round(va.yaw)}°`);
  for (const id of ['pitch-value', 'pitch-value-ar']) set(id, `${Math.round(va.pitch)}°`);
  set('tel-align', d.aligned ? '已对齐' : d.haveOrient ? '待对齐' : '无数据');
  set('tel-gyro', d.haveOrient ? `${ar.currentHz().toFixed(1)} Hz` : '—');
  set('tel-view', `${R.markerVisible ?? 0}/${R.markerTotal ?? SITES.length}` +
    (R.markerOccluded ? ` (遮${R.markerOccluded})` : ''));
  set('tel-drift', ar.staticDriftTxt());
  /* 支架示意图里的小方块跟着安装高度动 —— 参考项目也有这个反馈 */
  const padIcon = document.getElementById('pad-icon');
    if (padIcon) padIcon.style.transform = `translateY(${-((P.camHeight - 0.58) * 12)}px)`;
  const tel = document.getElementById('ar-telemetry');
  if (tel) tel.classList.toggle('is-warn', !d.aligned && !ar.isManualLook());
  syncArStatus();
}

/* ============================================================================
   渲染循环
   ============================================================================ */
const qIdentity = new THREE.Quaternion();
let lastRenderT = 0;

function animate() {
  requestAnimationFrame(animate);
  frameN++; fpsFrames++;
  const now = performance.now();
  const dtSec = lastRenderT ? Math.min((now - lastRenderT) / 1000, 0.1) : 1 / 60;
  lastRenderT = now;
  if (now - fpsT0 >= 1000) { fps = fpsFrames * 1000 / (now - fpsT0); fpsFrames = 0; fpsT0 = now; }

  const time = clock.getElapsedTime();
  uniforms.uTime.value = time;

  /* ---------- ① 位姿 ----------
     顺序不能反：裁剪依赖当前帧的相机姿态，而云台位置又依赖当前帧的姿态。 */
  const canRender = ar.updatePose(dtSec);
  /* lastCameraMotion 只由用户操作事件刷新（见 noteCameraMotion），
     这里【不要】按状态每帧刷——会把中心涟漪永久屏蔽（见函数注释）。 */

  if (!canRender) {
    /* 对齐前【只清屏不渲染模型】—— 对齐前后是两套滚转约定，
       照常渲染会让用户先看到一个滚转不对的模型，再眼睁睁看它「转过去」。 */
    renderer.clear();
    updateHud(now);
    return;
  }

  /* ---------- ② 裁剪 + 遮挡：先把矩阵算好，再逐锚点判 ---------- */
  ar.prepare();
  updateSites(time);

  const focusActive = !!(aimedSite || manualSite);
  if (focusActive !== wasFocusActive) {
    wasFocusActive = focusActive;
    uniforms.uClickStart.value = -100;
    nextGazeWave = time + .6;
    readout.textContent = focusActive ? '地点聚焦 · 中心涟漪暂停' : settings.idle ? '中心涟漪待机' : '中心涟漪已暂停';
  }
  uniforms.uSweepActive.value = 0; // Legacy sweep disabled; all idle light is centre-origin ripple.
  updateAmbientFeedback(time,focusActive);
  updateStoryPages(time);
  updateHud(now);
  renderer.render(scene, camera);
}

/* ============================================================================
   启动
   ============================================================================ */
async function load() {
  try {
    buildEnvironment();
    const textureLoader = new THREE.TextureLoader();
      const [meta, buffer, color, maskTexture, maskImage, boundaryUvs] = await Promise.all([
      fetch('./assets/terrain-meta.json').then(r => r.json()),
      fetch('./assets/terrain-height.f32').then(r => r.arrayBuffer()),
      textureLoader.loadAsync('./assets/terrain-color.png'),
      textureLoader.loadAsync('./assets/terrain-mask.png'),
      new Promise((resolve, reject) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = reject; image.src = './assets/terrain-mask.png'; }),
        fetch('./assets/province-boundary.json').then(r => r.json()).catch(() => null),
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
      if (boundaryUvs && boundaryUvs.length > 2) {
        buildBoundarySkirt(boundaryUvs);
      }
    buildSites();
    /* 默认开启陀螺仪跟随与真实姿态绑定：
       有传感器的平板即开即用；桌面环境 1.5s 无数据后自动降级为手动拖拽。 */
    ar.attach();
    ar.setManualLook(false);
    hint.textContent = '转动平板改变视线 · 点击地形触发扫描';
    const gate = document.getElementById('ar-gate');
    if (gate) gate.hidden = true;
    setTimeout(() => {
      if (!ar.hasGyro()) {
        ar.setManualLook(true);
        hint.textContent = '拖动改变视线 · 点击地形触发扫描';
        syncArStatus();
      }
    }, 1500);
    ar.syncGimbalPivot();
    const feed = document.getElementById('camera-feed');
    if (feed) {
      feed.addEventListener('loadedmetadata', () => updateLens());
      feed.addEventListener('playing', () => updateLens());
    }
    resize();
    new ResizeObserver(resize).observe(sceneHost);
    setupControls();
    setupScanReview();
    setupArControls();
    const drawer = setupPanelDrawer();
    const persistence = setupSettingsPersistence();
    syncArStatus();
    setupCameraPreview({
      onCameraChange(active) {
        scene.background = null;
        renderer.setClearColor(0x000000, 0);
        updateLens();
      },
      onReferenceChange(visible) {
        /* 地形、边界裙边和圆形边界线作为参考模型一起显隐。 */
        for (const object of referenceObjects) object.visible = visible;
      }
    });
    nextIdle = clock.getElapsedTime() + 0.6;

    /* ---------- 自动化验证出口 ----------
       `<script type="module">` 的顶层变量不会挂到 window 上，
       而 CDP / 控制台只能访问全局作用域 —— 没有这个出口就没法做回归验证。 */
    window.__holo = {
      openPanel: drawer.open,
      closePanel: drawer.close,
      saveSettings: persistence.save,
      resetSettings: persistence.reset,
      ar,
      get state() {
        return {
          ready: true, fps: Number(fps.toFixed(1)), frames: frameN,
          zoom: P.zoom, hFovDeg: R.hFovDeg, vFovDeg: R.vFovDeg, aspect: R.aspect,
          tableW: P.tableW, tableD: P.tableD,
          camHeight: P.camHeight, camDist: P.camDist, lateral: P.lateral,
          cull: P.cull, occlusion: P.occlusion,
          markerVisible: R.markerVisible, markerOccluded: R.markerOccluded, markerTotal: R.markerTotal,
          selectedSiteId: R.selectedSiteId ?? null,
          clickCount,
          occlusionThresholds: OCCLUSION_THRESHOLDS,
          sites: SITES.map(s => ({ id: s.id, name: s.name, lon: s.lon, lat: s.lat })),
          camera: { pos: camera.position.toArray(), quat: camera.quaternion.toArray() },
          viewAngles: ar.viewAnglesDeg(),
          ...ar.debug,
        };
      },
      get markers() {
        return siteMarkers.map(m => ({
          id: m.site.id, name: m.site.name,
          visible: m.visible, inView: m.inView, occluded: m.occluded,
          screenOn: m.screenOn, score: Number.isFinite(m.score) ? Number(m.score.toFixed(4)) : null,
          x: Number(m.x.toFixed(1)), y: Number(m.y.toFixed(1)),
          beaconVisible: m.groundBeacon.visible,
          iconHidden: m.button.classList.contains('is-hidden'),
          stemShown: m.stem.style.display !== 'none',
          ground: m.groundPoint.toArray().map(v => Number(v.toFixed(4))),
        }));
      },
      setCull(v) { P.cull = !!v; syncArStatus(); return P.cull; },
      setOcclusion(v) { P.occlusion = !!v; syncArStatus(); return P.occlusion; },
      setManualLook: v => ar.setManualLook(v),
      nudgeLook: (y, p) => ar.nudgeLook(y, p),
      resetLook: () => ar.resetLook(),
      align: () => ar.align(false),
      occlusionRay: (from, to, n) => ar.occlusionRay(
        new THREE.Vector3().fromArray(from), new THREE.Vector3().fromArray(to), n),
      markerWorld: id => {
        const m = siteMarkers.find(x => x.site.id === id);
        return m ? { point: m.point.toArray(), ground: m.groundPoint.toArray() } : null;
      },
      /* 判据诊断：把「像素投影」与「NDC 边距」两条路径的中间量都吐出来。
         两者本该一致（同一套矩阵），不一致就说明有一步算错了。 */
      probe(id) {
        const m = siteMarkers.find(x => x.site.id === id);
        if (!m) return null;
        const inv = new THREE.Matrix4().copy(camera.matrixWorld).invert();
        const proj = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, inv);
        const view = m.groundPoint.clone().applyMatrix4(inv);
        const ndc = m.groundPoint.clone().applyMatrix4(proj);
        const px = m.groundPoint.clone().project(camera);
        return {
          ground: m.groundPoint.toArray().map(v => Number(v.toFixed(5))),
          view: view.toArray().map(v => Number(v.toFixed(5))),
          ndcByMatrix: ndc.toArray().map(v => Number(v.toFixed(5))),
          ndcByProject: px.toArray().map(v => Number(v.toFixed(5))),
          scoreByFn: ar.scoreAt(m.groundPoint),
          scoreAfterPrepare: (() => { ar.prepare(); return ar.scoreAt(m.groundPoint); })(),
          matrices: ar.debugMatrices(),
          camPos: camera.position.toArray(),
          camQuat: camera.quaternion.toArray(),
          fov: camera.fov, aspect: camera.aspect, near: camera.near,
          projEl: camera.projectionMatrix.elements.slice(0, 6),
        };
      },
      sites: SITES,
    };
    document.getElementById('loading')?.classList.remove('on');
    animate();
  } catch (error) {
    console.error(error);
    errorBox.hidden = false;
    errorBox.textContent = `地形加载失败：${error.message}`;
    hint.textContent = '请通过本地 HTTP 服务打开此页面';
  }
}

load();
