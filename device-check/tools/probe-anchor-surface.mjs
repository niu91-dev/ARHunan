/**
 * 一次性诊断：锚点是否落在【可见地形网格表面】上。
 *
 * 背景：锚点高度用 heightAtUv()（双线性插值），而地形网格是 PlaneGeometry
 * 逐顶点设高（三角形平面插值）。两者在顶点处相等、在格内不等。
 * 若差异可观，标注就会浮在地形面上方或陷入下方 —— 直接表现为「叠加不准」。
 *
 * 用法：node tools/probe-anchor-surface.mjs <URL>
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME_PATH || String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`;
const TARGET = process.argv[2];
const PORT = 9355;
if (!TARGET) { console.log('用法: node tools/probe-anchor-surface.mjs <URL>'); process.exit(1); }

const proc = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--user-data-dir=' + join(tmpdir(), 'wb-cdp-' + PORT),
  '--ignore-certificate-errors', '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream', '--remote-debugging-port=' + PORT,
  '--window-size=1152,720', 'about:blank',
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
  const mid = ++msgId; ws.send(JSON.stringify({ id: mid, method, params }));
  return new Promise(res => pending.set(mid, res));
};
await new Promise(r => ws.addEventListener('open', r));
ws.addEventListener('message', ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
});
const evaluate = (expression) => send('Runtime.evaluate', { expression, returnByValue: true, userGesture: true });
const evalJson = async (expr) => {
  const r = await evaluate(`JSON.stringify(${expr} === undefined ? null : ${expr})`);
  if (!r || r.exceptionDetails || !r.result || r.result.value === undefined) return null;
  try { return JSON.parse(r.result.value); } catch (e) { return null; }
};

await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Emulation.setDeviceMetricsOverride', { width: 1152, height: 720, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: TARGET + (TARGET.includes('?') ? '&' : '?') + 'cb=' + Date.now() });
await sleep(6000);
await evaluate(`document.getElementById('start')?.click(); 'ok'`);
await sleep(1500);
await evaluate(`(() => { const e = new Event('deviceorientation');
  e.alpha = 0; e.beta = 55; e.gamma = 25; dispatchEvent(e); return 'ok'; })()`);
await sleep(900);

const relief = await evalJson('window.__gyro.reliefInfo');
console.log('=== 锚点 vs 地形网格表面 ===\n');
console.log(`reliefM=${relief.reliefM.toFixed(4)} m  baseLift=${relief.baseLift.toFixed(4)} m  maxElev=${relief.maxElev}`);

const sites = await evalJson(`(() => {
  const out = [];
  for (const a of window.__gyro.arAnchors) out.push({ id: a.id, name: a.name, x: a.pos.x, y: a.pos.y, z: a.pos.z });
  return out;
})()`);

console.log('\n| 地点 | 锚点 y | 网格面 y | Δy (mm) | 双线性-网格 (mm) |');
console.log('|---|---|---|---|---|');
let maxDy = 0;
for (const s of sites) {
  const meshY = await evalJson(`window.__gyro.terrainYAt(${s.x}, ${s.z})`);
  const dy = (s.y - meshY) * 1000;
  if (Math.abs(dy) > Math.abs(maxDy)) maxDy = dy;
  console.log(`| ${s.name} | ${s.y.toFixed(4)} | ${meshY === null ? 'null' : meshY.toFixed(4)} | ${dy.toFixed(2)} |`);
}
console.log(`\n最大 Δy = ${maxDy.toFixed(2)} mm（正 = 锚点浮在网格面上方）`);

/* 顺带量一下：把锚点投影到屏幕再打回地形，横向差多少 */
await evaluate(`window.__gyro.aimAt(0); 'ok'`);
await sleep(300);
const camPos = await evalJson('window.__gyro.camPos');
const lab = await evalJson('window.__gyro.arLabelsScreen');
const d3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
console.log(`\n相机位置 (${camPos.x}, ${camPos.y.toFixed(3)}, ${camPos.z})`);
console.log('\n| 地点 | 投影 px | 反投影命中 (x,z) | 横向误差 (mm) | 命中距离 | 锚点距离 | 判定 |');
console.log('|---|---|---|---|---|---|---|');
let maxLat = 0, occluded = [];
for (const a of lab) {
  if (!a.visible || a.anchorPx.behind) continue;
  const hit = await evalJson(`window.__gyro.raycastTerrainAt(${a.anchorPx.px.toFixed(2)}, ${a.anchorPx.py.toFixed(2)})`);
  const w = sites.find(s => s.id === a.id);
  if (!hit) { console.log(`| ${a.name} | — | 未命中 | — | — | — | — |`); continue; }
  const lat = Math.hypot(hit.x - w.x, hit.z - w.z) * 1000;
  if (lat > maxLat) maxLat = lat;
  const dHit = d3(camPos, hit), dAnchor = d3(camPos, w);
  /* 射线一定穿过锚点（锚点就在网格面上，Δy=0）。若 hits[0] 不是锚点，
     说明【锚点被更近的地形挡住了】—— 也就是被山体遮挡。 */
  const isOcc = dAnchor - dHit > 0.005;
  if (isOcc) occluded.push(a.name);
  console.log(`| ${a.name} | ${a.anchorPx.px.toFixed(0)},${a.anchorPx.py.toFixed(0)} | ${hit.x.toFixed(3)}, ${hit.z.toFixed(3)} | ${lat.toFixed(1)} | ${dHit.toFixed(3)} | ${dAnchor.toFixed(3)} | ${isOcc ? '**被遮挡**' : '正常'} |`);
}
console.log(`\n最大横向误差 = ${maxLat.toFixed(1)} mm`);
console.log(`被地形遮挡的锚点（但标签仍然显示）：${occluded.length ? occluded.join('、') : '无'}`);

ws.close(); proc.kill();
process.exit(0);
