/**
 * 对齐跳变的【像素级对比】截图 —— 零依赖，直连 Chrome CDP。
 *
 * 复现视频里「进入 AR 后一瞬间地形转了一下」的现象。
 *
 * 三块面板：
 *   ① 进入后 · 未对齐 —— 相机是固定视角：位置 (0,camHeight,camDist) + lookAt(0,0,0)
 *      + up = 世界 +Y。这是用户在自动对齐触发前看到的样子（视频 3.3~4.3 s）。
 *   ② 旧对齐 setFromUnitVectors —— 视频 4.5 s 之后的样子（旧版本）。
 *   ③ 新对齐 设备系 lookAt —— 现在的样子。
 *
 * 为什么 ② 会「歪」：
 *   对齐必须把相机光轴掰到地形中心，同时还得决定「滚转」。
 *   `setFromUnitVectors` 给的是绕 (0,0,-1)×bLocal 的【最小旋转】——
 *   它只保证光轴对，滚转是"顺带"的，设备越偏离正对、歪得越离谱。
 *   而 ①③ 的滚转都是「相机 up ≈ 世界竖直」这一族，所以 ①≈③，② 独自歪掉。
 *
 * 用法：
 *   node tools/align-roll-shot.mjs <URL> auto              # 自动搜一个旧算法歪得最狠的姿态
 *   node tools/align-roll-shot.mjs <URL> 120 60 30         # 指定 α β γ
 */
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CHROME = process.env.CHROME_PATH
  || String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`;
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const TARGET = process.argv[2];
const PORT = 9339;
/* 输出目录：默认落在当前工作目录下，可用 GYRO_SHOT_OUT 覆盖 */
const OUT = process.env.GYRO_SHOT_OUT || join(process.cwd(), '_shot');

if (!TARGET) { console.log('用法: node tools/align-roll-shot.mjs <URL> [auto | alpha beta gamma]'); process.exit(1); }
mkdirSync(OUT, { recursive: true });

/* ---------- 与页面无关的本地四元数工具 ---------- */
function rotateVec(q, v) {
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  return {
    x: v.x + q.w * tx + (q.y * tz - q.z * ty),
    y: v.y + q.w * ty + (q.z * tx - q.x * tz),
    z: v.z + q.w * tz + (q.x * ty - q.y * tx),
  };
}
function qmul(a, b) {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}
function qconj(q) { return { x: -q.x, y: -q.y, z: -q.z, w: q.w }; }
function vnorm(v) { const l = Math.hypot(v.x, v.y, v.z) || 1; return { x: v.x / l, y: v.y / l, z: v.z / l }; }
function vdot(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
function quatFromUnitVectors(a, b) {
  let r = vdot(a, b) + 1;
  let x, y, z, w;
  if (r < 1e-8) {
    r = 0;
    if (Math.abs(a.x) > Math.abs(a.z)) { x = -a.y; y = a.x; z = 0; w = 0; }
    else { x = 0; y = -a.z; z = a.y; w = 0; }
  } else {
    x = a.y * b.z - a.z * b.y; y = a.z * b.x - a.x * b.z; z = a.x * b.y - a.y * b.x; w = r;
  }
  const l = Math.hypot(x, y, z, w) || 1;
  return { x: x / l, y: y / l, z: z / l, w: w / l };
}
function rollErrDeg(camQ, devQ) {
  const fwd = vnorm(rotateVec(camQ, { x: 0, y: 0, z: -1 }));
  const upCam = vnorm(rotateVec(camQ, { x: 0, y: 1, z: 0 }));
  const upDev = vnorm(rotateVec(devQ, { x: 0, y: 1, z: 0 }));
  const d = vdot(upDev, fwd);
  const p = vnorm({ x: upDev.x - d * fwd.x, y: upDev.y - d * fwd.y, z: upDev.z - d * fwd.z });
  return Math.acos(Math.max(-1, Math.min(1, vdot(upCam, p)))) * 180 / Math.PI;
}

/* ---------- 起 Chrome ---------- */
const proc = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  // 独立 profile —— 否则用户自己开着 Chrome 时会交接给已有实例、调试端口不生效
  '--user-data-dir=' + join(tmpdir(), 'wb-cdp-' + PORT),
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
function send(method, params = {}) {
  const mid = ++msgId;
  ws.send(JSON.stringify({ id: mid, method, params }));
  return new Promise(res => pending.set(mid, res));
}
await new Promise(r => ws.addEventListener('open', r));
ws.addEventListener('message', ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
});

const evaluate = (expression) => send('Runtime.evaluate', { expression, returnByValue: true, userGesture: true });
const json = async (expression) => JSON.parse((await evaluate(expression)).result.value);

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1152, height: 720, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: TARGET });
await sleep(4500);
await evaluate(`document.getElementById('start')?.click(); 'ok'`);
await sleep(3000);

/* ---------- 干净画布：藏掉相机视频与所有 UI ---------- */
await evaluate(`(() => {
  document.getElementById('cam').style.display = 'none';
  for (const id of ['topbar','alignhint','crosshair','card','panel','loading','start-wrap','rotate','flash']) {
    const el = document.getElementById(id); if (el) el.style.display = 'none';
  }
  document.body.style.background = '#12161b';
  const tag = document.createElement('div');
  tag.id = '__tag';
  tag.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:9999;'
    + 'font:600 21px/1.5 system-ui,"Microsoft YaHei",sans-serif;color:#e8eef5;'
    + 'background:rgba(10,14,18,.82);text-align:center;padding:6px 0';
  document.body.appendChild(tag);
  return 'ok';
})()`);

const shots = [];
async function shot(label, quat) {
  await evaluate(`(() => {
    document.getElementById('__tag').textContent = ${JSON.stringify(label)};
    ${quat ? `window.__gyro.setCamQuat(${quat.x}, ${quat.y}, ${quat.z}, ${quat.w});`
           : `window.__gyro.setCamQuat(null, null, null, null);`}
    return 'ok';
  })()`);
  await sleep(700);
  const s = await send('Page.captureScreenshot', { format: 'png' });
  const f = `${OUT}\\_p${shots.length}.png`;
  writeFileSync(f, Buffer.from(s.data, 'base64'));
  shots.push(f);
  console.log('  ' + label);
}

/* ---------- ① 进入后、自动对齐之前（固定视角）----------
   必须在派发任何 deviceorientation 之前拍 —— 一旦派发，1.2 s 后 maybeAutoAlign 会动手。 */
console.log('三块面板：');
await shot('① 进入后 · 未对齐（固定视角：lookAt 中心 + up = 世界竖直）', null);

/* ---------- 搜索一个有说服力的姿态 ---------- */
async function probePose(a, b, g) {
  await evaluate(`(() => {
    const e = new Event('deviceorientation');
    e.alpha = ${a}; e.beta = ${b}; e.gamma = ${g};
    dispatchEvent(e);
    return 'ok';
  })()`);
  const Q = await json(`JSON.stringify(window.__gyro.deviceQuat)`);
  const params = await json(`JSON.stringify(window.__gyro.params)`);
  const eye = { x: 0, y: params.camHeight, z: params.camDist };
  const t = vnorm({ x: -eye.x, y: -eye.y, z: -eye.z });
  const bLocal = vnorm(rotateVec(qconj(Q), t));
  const camOld = qmul(Q, quatFromUnitVectors({ x: 0, y: 0, z: -1 }, bLocal));
  const fwdRaw = vnorm(rotateVec(Q, { x: 0, y: 0, z: -1 }));
  return {
    rawAim: Math.acos(Math.max(-1, Math.min(1, vdot(fwdRaw, t)))) * 180 / Math.PI,
    oldRoll: rollErrDeg(camOld, Q),
  };
}

let pose;
if (process.argv[3] === 'auto') {
  const cands = [];
  for (const a of [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330]) {
    for (const b of [10, 25, 40, 55, 70, 85]) {
      for (const g of [-40, -25, -10, 0, 10, 25, 40]) cands.push({ a, b, g });
    }
  }
  const all = [];
  for (const c of cands) {
    const p = await probePose(c.a, c.b, c.g);
    all.push({ ...c, ...p });
  }
  /* 挑「典型」而不是「极端」：
     - rawAim ≥ 15°  —— 用户还没转过去对准沙盘（自动对齐就是这样触发的）
     - oldRoll ≤ 75° —— 排除 180° 反足退化翻转，那不是用户看到的常态
     - 取 oldRoll 最大者，最直观 */
  const ok = all.filter(p => p.rawAim >= 15 && p.oldRoll <= 75);
  ok.sort((x, y) => y.oldRoll - x.oldRoll);
  console.log('候选（旧算法滚转最狠的前 5 个）：');
  for (const p of ok.slice(0, 5)) {
    console.log(`  α=${String(p.a).padStart(3)} β=${String(p.b).padStart(2)} γ=${String(p.g).padStart(3)}`
      + `  → 未对齐偏角 ${p.rawAim.toFixed(1).padStart(5)}° · 旧算法滚转 ${p.oldRoll.toFixed(1).padStart(5)}°`);
  }
  pose = ok[0];
  console.log(`\n选用 α=${pose.a} β=${pose.b} γ=${pose.g}`
    + `（未对齐偏角 ${pose.rawAim.toFixed(1)}° · 旧算法滚转 ${pose.oldRoll.toFixed(1)}°）\n`);
} else {
  pose = { a: Number(process.argv[3] ?? 120), b: Number(process.argv[4] ?? 60), g: Number(process.argv[5] ?? 30) };
  console.log(`\n使用指定姿态 α=${pose.a} β=${pose.b} γ=${pose.g}\n`);
}

/* ---------- 喂入该姿态并做新旧两种对齐 ---------- */
const info = await json(`(() => {
  const e = new Event('deviceorientation');
  e.alpha = ${pose.a}; e.beta = ${pose.b}; e.gamma = ${pose.g};
  dispatchEvent(e);
  window.__gyro.alignNow(true);
  return JSON.stringify({ deviceQuat: window.__gyro.deviceQuat, params: window.__gyro.params });
})()`);
await sleep(1200);
const cur = await json(`JSON.stringify({ camQuat: window.__gyro.camQuat, rollErrDeg: window.__gyro.rollErrDeg })`);

const eye = { x: 0, y: info.params.camHeight, z: info.params.camDist };
const t = vnorm({ x: -eye.x, y: -eye.y, z: -eye.z });
const camOld = qmul(info.deviceQuat, quatFromUnitVectors({ x: 0, y: 0, z: -1 }, vnorm(rotateVec(qconj(info.deviceQuat), t))));

await shot(`② 旧对齐 setFromUnitVectors — 滚转误差 ${rollErrDeg(camOld, info.deviceQuat).toFixed(1)}°`, camOld);
/* ③ 必须用 camQuat（= Q·alignQuat），不是 alignQuat 本身 —— 喂错会把相机甩到别处、拍成空白 */
await shot(`③ 新对齐 设备系 lookAt — 滚转误差 ${cur.rollErrDeg.toFixed(1)}°`, cur.camQuat);

await evaluate(`window.__gyro.setCamQuat(null,null,null,null); 'ok'`);
ws.close(); proc.kill();

/* ---------- 三图横拼 ---------- */
const out = `${OUT}\\align_jump.png`;
const res = spawnSync(FFMPEG, [
  '-y', '-loglevel', 'error',
  '-i', shots[0], '-i', shots[1], '-i', shots[2],
  '-filter_complex', '[0:v][1:v][2:v]hstack=inputs=3[o]',
  '-map', '[o]', out,
], { encoding: 'utf8' });
if (res.status !== 0) { console.log('FFMPEG_FAIL', res.stderr); process.exit(1); }
console.log('\n拼图: ' + out);
