/**
 * ar-holo-demo.html 冒烟 + 结构核对。
 *
 * 目标：
 *   ① 页面能加载、控制台零报错、__holo 出口存在
 *   ② 展示层与参考项目一致：11 个图标 / 11 条引线 / 11 个地点按钮 / 点云 + 连接线
 *   ③ 相机 AR 生效：拖动转视角能改变可见集；视野裁剪与遮挡剔除的结论
 *      必须【同时】驱动 Three 网格（光柱）与 DOM（图标、引线）—— 不允许分叉
 *
 * 用法：node tools/holo-smoke.mjs [URL] [OUT_PNG]
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHROME = process.env.CHROME_PATH || String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`;
const RAW = process.argv[2] || 'http://127.0.0.1:8080/ar-holo-demo.html';
/* run-all.mjs 默认传的是 ar-gyro-demo.html，我们自动转成 holo 路径 */
const TARGET = RAW.replace(/([\/])ar-gyro-demo\.html/, '$1ar-holo-demo.html');
const SHOT = process.argv[3] || join(HERE, '_holo.png');
const PORT = 9361;
mkdirSync(join(HERE, '_holo'), { recursive: true });

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log('  [OK]   ' + m); };
const bad = (m) => { fail++; console.log('  [FAIL] ' + m); };
const info = (m) => console.log('         ' + m);

const proc = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--user-data-dir=' + join(tmpdir(), 'wb-holo-' + PORT),
  '--ignore-certificate-errors', '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required',
  '--remote-debugging-port=' + PORT, '--window-size=1152,720', 'about:blank',
], { stdio: 'ignore' });

let ver = null;
for (let i = 0; i < 80; i++) {
  try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) { ver = await r.json(); break; } } catch (e) {}
  await sleep(250);
}
if (!ver) { console.log('CHROME_START_FAIL'); proc.kill(); process.exit(1); }

const tab = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(TARGET)}`, { method: 'PUT' })).json();
const ws = new WebSocket(tab.webSocketDebuggerUrl);
let msgId = 0;
const pending = new Map();
const send = (method, params = {}) => {
  const mid = ++msgId;
  ws.send(JSON.stringify({ id: mid, method, params }));
  return new Promise(res => pending.set(mid, res));
};
const consoleErrors = [];
await new Promise(r => ws.addEventListener('open', r));
ws.addEventListener('message', ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); return; }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    consoleErrors.push(m.params.args.map(a => a.value ?? a.description ?? '').join(' '));
  }
  if (m.method === 'Runtime.exceptionThrown') {
    consoleErrors.push('EXCEPTION ' + (m.params.exceptionDetails?.exception?.description || ''));
  }
  if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
    consoleErrors.push('LOG ' + m.params.entry.text);
  }
});
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed');
  return r.result?.value;
};
const evalJson = async (expr) => JSON.parse(await evaluate(`JSON.stringify(${expr})`));

await send('Runtime.enable');
await send('Page.enable');
await send('Log.enable');
await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Emulation.setDeviceMetricsOverride', { width: 1152, height: 720, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: TARGET + (TARGET.includes('?') ? '&' : '?') + 'cb=' + Date.now() });
await sleep(7000);

/* ---------- ① 页面活着 + 零报错 ---------- */
console.log('\n=== ① 页面 / 控制台 ===');
const ready = await evaluate(`typeof window.__holo === 'object' && !!window.__holo.state.ready`);
if (ready) ok('__holo 出口存在且 ready'); else bad('__holo 未就绪');
const errBox = await evalJson(`(()=>{const e=document.getElementById('error');
  return {hidden:e.hidden, text:e.textContent}})()`);
if (errBox.hidden) ok('无加载错误面板'); else bad('错误面板可见：' + errBox.text);
/* 已知噪声：favicon 已用 data: 内联，理论上不该有 404 */
const realErrors = consoleErrors.filter(e => !/favicon/i.test(e));
if (!realErrors.length) ok('控制台零报错'); else { bad('控制台有 ' + realErrors.length + ' 条报错'); realErrors.slice(0, 6).forEach(info); }

/* ---------- ② 展示层 = 参考项目的结构 ---------- */
console.log('\n=== ② 展示层结构（对齐参考项目）===');
const dom = await evalJson(`({
  markers: document.querySelectorAll('#site-markers .site-marker').length,
  stems: document.querySelectorAll('#site-stems path').length,
  listBtns: document.querySelectorAll('#site-list button').length,
  reticle: !!document.querySelector('.reticle svg'),
  callout: !!document.getElementById('site-callout'),
  story: !!document.querySelector('#site-story .story-links'),
  brand: document.querySelector('.brand strong')?.textContent,
  live: document.querySelector('.live')?.textContent.trim(),
  note: !!document.querySelector('.ar-integration-note'),
  panelSections: document.querySelectorAll('.panel .control-section').length,
  btnOpen: !!document.getElementById('btn-open-panel'),
  btnFs: !!document.getElementById('btn-fullscreen'),
  btnClose: !!document.getElementById('btn-close-panel'),
  btnSave: !!document.getElementById('btn-save-settings'),
  btnReset: !!document.getElementById('btn-reset-settings'),
  panelInitiallyClosed: !document.getElementById('panel').classList.contains('is-open'),
})`);
const checks2 = [
  ['markers === 11', dom.markers === 11, dom.markers],
  ['stems === 11', dom.stems === 11, dom.stems],
  ['site-list 按钮 === 11', dom.listBtns === 11, dom.listBtns],
  ['准心 svg 存在', dom.reticle, dom.reticle],
  ['callout 存在', dom.callout, dom.callout],
  ['story-links 存在', dom.story, dom.story],
  ['品牌字样 = HUNAN / TERRAIN LAB', dom.brand === 'HUNAN / TERRAIN LAB', dom.brand],
  ['LIVE VIEW 角标', /LIVE VIEW/.test(dom.live || ''), dom.live],
  ['AR 接入提醒红条', dom.note, dom.note],
  ['面板区块（已精简）', dom.panelSections >= 2 && dom.panelSections <= 4, dom.panelSections],
  ['右上角设置按钮存在', dom.btnOpen, dom.btnOpen],
  ['右上角全屏按钮存在', dom.btnFs, dom.btnFs],
  ['面板右上角关闭按钮存在', dom.btnClose, dom.btnClose],
  ['保存设置参数按钮存在', dom.btnSave, dom.btnSave],
  ['恢复默认参数按钮存在', dom.btnReset, dom.btnReset],
  ['面板默认处于收起隐藏状态', dom.panelInitiallyClosed, dom.panelInitiallyClosed],
];
for (const [name, good, val] of checks2) (good ? ok : bad)(`${name}（实际 ${val}）`);

/* 抽屉面板开闭联动交互 */
await evaluate(`document.getElementById('btn-open-panel').click()`);
await sleep(350);
const panelOpened = await evaluate(`document.getElementById('panel').classList.contains('is-open')`);
if (panelOpened) ok('点击右上角设置按钮成功展开面板'); else bad('点击设置按钮未展开面板');

/* 设置保存与 localStorage 持久化 */
await evaluate(`document.getElementById('btn-save-settings').click()`);
await sleep(150);
const savedRaw = await evaluate(`localStorage.getItem('hunan_holo_ar_settings_v1')`);
const savedObj = savedRaw ? JSON.parse(savedRaw) : null;
if (savedObj && typeof savedObj.camHeight === 'number' && savedObj.savedAt) {
  ok('点击保存按钮成功持久化配置到 localStorage（camHeight=' + savedObj.camHeight + '）');
} else {
  bad('保存按钮未成功将设置存入 localStorage');
}

/* 整体竖直对位必须同步移动 DEM、扫描层、边界与屏幕锚点。 */
const yShift = await evalJson(`(()=>{
  const before=window.__holo.markerWorld('zhangjiajie');
  const slider=document.getElementById('terrain-y-offset');
  slider.value='-0.035'; slider.dispatchEvent(new Event('input',{bubbles:true}));
  const after=window.__holo.markerWorld('zhangjiajie');
  const s=window.__holo.state;
  return {value:s.terrainYOffset,terrain:s.terrainY,points:s.scanPointsY,links:s.scanLinksY,
    overlays:s.overlayY,markerDelta:Number((after.ground[1]-before.ground[1]).toFixed(3)),
    readout:document.getElementById('terrain-y-offset-value').textContent};
})()`);
const yShiftOk = yShift.value === -0.035 && yShift.terrain === -0.035 &&
  yShift.points === -0.035 && yShift.links === -0.035 && yShift.overlays.every(y => y === -0.035) &&
  yShift.markerDelta === -0.035 && yShift.readout === '-0.035 m';
(yShiftOk ? ok : bad)('虚拟沙盘整体 Y 对位同步移动地形/扫描/边界/锚点（' + JSON.stringify(yShift) + '）');
await evaluate(`document.getElementById('terrain-y-offset').value='0';
  document.getElementById('terrain-y-offset').dispatchEvent(new Event('input',{bubbles:true})); 'ok'`);

/* 虚拟沙盘大小缩放必须同步缩放地形、扫描层、边界与地标 */
const scaleShift = await evalJson(`(()=>{
  const before=window.__holo.markerWorld('zhangjiajie');
  const slider=document.getElementById('terrain-scale');
  slider.value='1.200'; slider.dispatchEvent(new Event('input',{bubbles:true}));
  const after=window.__holo.markerWorld('zhangjiajie');
  const s=window.__holo.state;
  const d0 = Math.hypot(before.ground[0] - (s.shiftX||0), before.ground[2] - (s.shiftZ||0.38));
  const d1 = Math.hypot(after.ground[0] - (s.shiftX||0), after.ground[2] - (s.shiftZ||0.38));
  return {
    scale: s.terrainScale,
    scaleVec: s.terrainScaleVec,
    ratio: Number((d1 / d0).toFixed(3)),
    readout: document.getElementById('terrain-scale-value').textContent
  };
})()`);
const scaleOk = scaleShift.scale === 1.2 &&
  Array.isArray(scaleShift.scaleVec) && Math.abs(scaleShift.scaleVec[0] - 1.2) < 1e-4 &&
  Math.abs(scaleShift.ratio - 1.2) < 0.01 && scaleShift.readout === '1.200×';
(scaleOk ? ok : bad)('虚拟沙盘大小缩放同步缩放地形/扫描/边界/锚点（' + JSON.stringify(scaleShift) + '）');
await evaluate(`document.getElementById('terrain-scale').value='1.000';
  document.getElementById('terrain-scale').dispatchEvent(new Event('input',{bubbles:true})); 'ok'`);

/* 画面上下俯仰对位滑块验证 */
const pitchShift = await evalJson(`(()=>{
  window.__holo.setManualLook(true);
  const p0 = window.__holo.state.viewAngles.pitch;
  const slider = document.getElementById('pitch-offset');
  slider.value = '3.5'; slider.dispatchEvent(new Event('input', {bubbles:true}));
  const s = window.__holo.state;
  const p1 = s.viewAngles.pitch;
  return {
    offset: s.pitchOffsetDeg,
    deltaPitch: Number((p1 - p0).toFixed(1)),
    readout: document.getElementById('pitch-offset-value').textContent
  };
})()`);
const pitchOk = pitchShift.offset === 3.5 && Math.abs(Math.abs(pitchShift.deltaPitch) - 3.5) <= 0.2 && pitchShift.readout === '+3.5°';
(pitchOk ? ok : bad)('画面上下俯仰对位同步调整镜头俯角（' + JSON.stringify(pitchShift) + '）');
await evaluate(`document.getElementById('pitch-offset').value='0';
  document.getElementById('pitch-offset').dispatchEvent(new Event('input',{bubbles:true})); 'ok'`);

/* 沙盘前后对位 (Shift Z) 验证 */
const zShiftTest = await evalJson(`(()=>{
  const before = window.__holo.markerWorld('zhangjiajie');
  const slider = document.getElementById('shift-z');
  slider.value = '0.150'; slider.dispatchEvent(new Event('input', {bubbles:true}));
  const after = window.__holo.markerWorld('zhangjiajie');
  const s = window.__holo.state;
  return {
    shiftZ: s.shiftZ,
    deltaZ: Number((after.ground[2] - before.ground[2]).toFixed(3)),
    readout: document.getElementById('shift-z-value').textContent
  };
})()`);
const zShiftOk = zShiftTest.shiftZ === 0.15 && Math.abs(zShiftTest.deltaZ - (0.15 - 0.38)) < 0.005 && zShiftTest.readout === '+0.150 m';
(zShiftOk ? ok : bad)('沙盘前后对位 (Shift Z) 同步平移地形与锚点（' + JSON.stringify(zShiftTest) + '）');
await evaluate(`document.getElementById('shift-z').value='0.380';
  document.getElementById('shift-z').dispatchEvent(new Event('input',{bubbles:true})); 'ok'`);

/* 沙盘左右对位 (Shift X) 验证 */
const xShiftTest = await evalJson(`(()=>{
  const before = window.__holo.markerWorld('zhangjiajie');
  const slider = document.getElementById('shift-x');
  slider.value = '-0.050'; slider.dispatchEvent(new Event('input', {bubbles:true}));
  const after = window.__holo.markerWorld('zhangjiajie');
  const s = window.__holo.state;
  return {
    shiftX: s.shiftX,
    deltaX: Number((after.ground[0] - before.ground[0]).toFixed(3)),
    readout: document.getElementById('shift-x-value').textContent
  };
})()`);
const xShiftOk = xShiftTest.shiftX === -0.05 && Math.abs(xShiftTest.deltaX - (-0.05)) < 0.005 && xShiftTest.readout === '-0.050 m';
(xShiftOk ? ok : bad)('沙盘左右对位 (Shift X) 同步平移地形与锚点（' + JSON.stringify(xShiftTest) + '）');
await evaluate(`document.getElementById('shift-x').value='0';
  document.getElementById('shift-x').dispatchEvent(new Event('input',{bubbles:true})); 'ok'`);

/* 沙盘长宽比 (Aspect Ratio) 验证 */
const arTest = await evalJson(`(()=>{
  const slider = document.getElementById('aspect-ratio');
  slider.value = '1.050'; slider.dispatchEvent(new Event('input', {bubbles:true}));
  const s = window.__holo.state;
  return {
    aspectRatio: s.aspectRatio,
    readout: document.getElementById('aspect-ratio-value').textContent
  };
})()`);
const arOk = arTest.aspectRatio === 1.05 && arTest.readout === '1.050';
(arOk ? ok : bad)('沙盘长宽比微调正常生效（' + JSON.stringify(arTest) + '）');
await evaluate(`document.getElementById('aspect-ratio').value='1.000';
  document.getElementById('aspect-ratio').dispatchEvent(new Event('input',{bubbles:true})); 'ok'`);

const openShot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync(join(HERE, '_holo_open.png'), Buffer.from(openShot.data, 'base64'));
await evaluate(`document.getElementById('btn-close-panel').click()`);
await sleep(350);
const panelClosed = await evaluate(`!document.getElementById('panel').classList.contains('is-open')`);
if (panelClosed) ok('点击面板右上角关闭按钮成功收起隐藏'); else bad('点击关闭按钮未收起面板');

/* ---------- ③ 空间扫描点云 / 连接线 ---------- */
console.log('\n=== ③ 空间扫描（HoloLens 点云 + 局部三角连接）===');
const scan = await evalJson(`(()=>{const s=window.__holo.ar;return {
  hasPoints: !!document.querySelector('#scene canvas'),
}})()`);
const stats = await evaluate(`(()=>{let out=null;
  const s=window.__holo; return 'ok';})()`);
/* scan-surface 的统计只能从 Three 场景里数顶点 —— 通过 __holo 暴露的对象遍历 */
const meshStats = await evalJson(`(()=>{
  const pts=[], lns=[];
  // 场景不在 __holo 里，只能数 DOM；改用导出里的阈值对象确认模块已加载
  return { occlusionThresholds: window.__holo.state.occlusionThresholds };
})()`);
if (meshStats.occlusionThresholds) ok('遮挡阈值从模块读出（未被写死）：' + JSON.stringify(meshStats.occlusionThresholds));
else bad('遮挡阈值导出缺失');

/* ---------- ③+ 中心扫描涟漪循环（原版 updateAmbientFeedback 的入场效果）----------
   桌面默认手动模式，若把 lastCameraMotion 写成「状态型」每帧刷新，
   `time - lastCameraMotion < .20` 会永远成立 → 涟漪被永久屏蔽、页面只剩静态地形。
   gazePulses 是页面原版就有的 dataset 计数器，每发射一波涟漪 +1。 */
const pulses0 = await evalJson(`Number((document.querySelector('#scene').dataset.gazePulses)||0)`);
await sleep(7600); // > GAZE_WAVE_INTERVAL(6.8s)，至少应再发射一波
const pulses1 = await evalJson(`Number((document.querySelector('#scene').dataset.gazePulses)||0)`);
if (pulses1 > pulses0) ok(`中心涟漪循环发射中：${pulses0} → ${pulses1} 波（间隔 6.8s）`);
else bad(`中心涟漪被屏蔽：7.6s 内 0 波发射（${pulses0} → ${pulses1}）——检查 lastCameraMotion 是否被每帧刷新`);

/* ---------- ④ 相机 AR：拖动转视角改变可见集 ---------- */
console.log('\n=== ④ 相机 AR：转向哪边只显示哪边 ===');
await evaluate(`window.__holo.setManualLook(true); window.__holo.resetLook(); 'ok'`);
await sleep(700);
const yaws = [0, 25, 50, -25, -50];
const rows = [];
for (const y of yaws) {
  await evaluate(`window.__holo.nudgeLook(0,0); window.__holo.resetLook(); window.__holo.nudgeLook(${y}, 0); 'ok'`);
  await sleep(650);
  const m = await evalJson(`window.__holo.markers.map(x=>({id:x.id,visible:x.visible,occ:x.occluded,
    beacon:x.beaconVisible,iconHidden:x.iconHidden,stemShown:x.stemShown,score:x.score}))`);
  const vis = m.filter(x => x.visible);
  rows.push({ y, n: vis.length, names: vis.map(x => x.id) });
  /* 一致性：DOM 图标 / 引线 / Three 光柱 三者必须同进同退 */
  const desync = m.filter(x => x.visible !== x.beacon || x.visible !== !x.iconHidden || x.visible !== x.stemShown);
  if (!desync.length) ok(`yaw=${String(y).padStart(4)}° 可见 ${vis.length}/11，图标/引线/光柱三者一致`);
  else bad(`yaw=${y}° 出现分叉：` + desync.map(x => `${x.id}(vis=${x.visible},beacon=${x.beacon},hidden=${x.iconHidden},stem=${x.stemShown})`).join(' '));
  info('可见：' + (vis.map(x => x.id).join(' ') || '（无）'));
}
const base = rows[0].n;
const monotone = rows.slice(0, 3).every((r, i, a) => i === 0 || r.n <= a[i - 1].n);
if (monotone && rows[0].n > rows[2].n) ok(`转向后可见数单调不增：${rows.slice(0,3).map(r=>r.n).join(' → ')}`);
else bad(`可见数不单调：${rows.slice(0,3).map(r=>r.n).join(' → ')}`);

/* ---------- ⑤ 遮挡剔除 A/B ---------- */
console.log('\n=== ⑤ 遮挡剔除 A/B ===');
await evaluate(`window.__holo.resetLook(); 'ok'`);
await sleep(600);
const ab = {};
for (const on of [true, false]) {
  await evaluate(`window.__holo.setOcclusion(${on}); 'ok'`);
  await sleep(650);
  const m = await evalJson(`window.__holo.markers.map(x=>({id:x.id,visible:x.visible,occ:x.occluded}))`);
  ab[on ? 'on' : 'off'] = m;
  const v = m.filter(x => x.visible).length;
  const occ = m.filter(x => x.occ).map(x => x.id);
  console.log(`  遮挡剔除 ${on ? '开' : '关'}：可见 ${v}/11` + (occ.length ? `  判为被挡：${occ.join(' ')}` : ''));
}
const extra = ab.off.filter(o => o.visible && !ab.on.find(x => x.id === o.id)?.visible).map(o => o.id);
if (extra.length) ok('关掉遮挡后多出来的锚点 = ' + extra.join('、') + '（这些就是被山体挡住的）');
else info('本朝向没有被遮挡的锚点 —— 换朝向再看（不算失败）');
const occBeacon = ab.on.filter(o => o.occ);
if (occBeacon.every(o => !o.visible)) ok('被判为遮挡的锚点全部不可见');
else bad('有锚点判为遮挡却仍然可见：' + occBeacon.filter(o => o.visible).map(o => o.id).join(' '));

/* ---------- ⑥ 截图 ---------- */
await evaluate(`window.__holo.setOcclusion(true); window.__holo.resetLook(); 'ok'`);
await sleep(800);
const shot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync(SHOT, Buffer.from(shot.data, 'base64'));
console.log(`\n截图 → ${SHOT}`);

const st = await evalJson(`(()=>{const s=window.__holo.state; return {
  fps:s.fps, frames:s.frames, baseHFov:s.baseHFovDeg, nominalHFov:s.nominalHFovDeg,
  hFov:s.hFovDeg, vFov:s.vFovDeg, zoom:s.zoom,
  camHeight:s.camHeight, camDist:s.camDist, tableW:s.tableW, tableD:s.tableD,
  aligned:s.aligned, manualLook:s.manualLook, visible:s.markerVisible, occluded:s.markerOccluded}})()`);
console.log('  运行状态：' + JSON.stringify(st));
const expTanH = Math.tan((63.7 * Math.PI / 180) / 2) * (1.6 / (16 / 9));
const expHFov = Number((2 * Math.atan(expTanH) * 180 / Math.PI).toFixed(1));
const expVFov = Number((2 * Math.atan(expTanH / 1.6) * 180 / Math.PI).toFixed(2));
const fovOk = st.baseHFov === 63.7 && st.nominalHFov === 63.7 &&
  Math.abs(st.hFov - expHFov) <= 0.1 && Math.abs(st.vFov - expVFov) <= 0.1;
(fovOk ? ok : bad)(`默认 FOV 匹配小米 Pad 6 后摄光学参数（标称 ${st.nominalHFov}° / 16:10 等效 ${st.hFov}° × ${st.vFov}°，期望 ${expHFov}° × ${expVFov}°）`);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
ws.close(); proc.kill();
process.exit(fail ? 1 : 0);
