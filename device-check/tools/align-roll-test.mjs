/**
 * 对齐「滚转正确性」测试 —— 零依赖，直连 Chrome CDP。
 *
 * 为什么需要它：
 *   对齐要同时满足两件事：
 *     ① 相机光轴指向地形中心（否则地形不在画面正中）
 *     ② 滚转正确 —— 相机 up 应当等于「设备 up 在垂直于光轴平面上的投影」
 *        （否则「地平线」会歪：地形像一张贴在屏幕上的图片，而不是斜贴在真实桌面上）
 *
 *   原实现用 `setFromUnitVectors((0,0,-1), bLocal)`。
 *   它是绕 (0,0,-1)×bLocal 的【最小旋转】（swing，绕光轴无扭转）——
 *   听上去像是"不带滚转"，其实不是：
 *   当 bLocal 有偏离「光轴–设备up」所在平面的分量（即需要带一点偏航）时，
 *   swing 会把 up 甩出正确位置。实测一个 45° 偏航姿态就甩出 9.8° 滚转。
 *
 *   新实现改用设备坐标系里的 lookAt（up 钉在设备 +Y），
 *   数学上可以证明 camQuat·(0,1,0) 恰好等于理想投影向量 —— 滚转误差恒为 0。
 *
 * 判据（重要）：
 *   ⚠️ 不能用「相机 up 与设备 up 的夹角」—— 设备 up 一般不在垂直于光轴的平面内，
 *      纯俯仰修正也会改变这个夹角，会把俯仰误报成滚转
 *      （水平正对姿态就会报 63.9° 的假误差）。
 *   ✅ 正确判据：把设备 up 投影到【垂直于光轴】的平面上，再与相机 up 比夹角。
 *
 * 本测试做三件事：
 *   1. 光轴指向误差（应 ≈ 0°）
 *   2. 滚转误差（应 ≈ 0°）—— 读页面里的 window.__gyro.rollErrDeg
 *   3. 反面参照：在测试脚本里【自己实现旧的 setFromUnitVectors 算法】，
 *      证明它在需要偏航的姿态下确实会引入明显滚转。
 *      这一条是本次修复的证据链核心 —— 没有它，"新算法通过"不能说明任何问题。
 *
 * 用法：node tools/align-roll-test.mjs "https://127.0.0.1:8443/ar-gyro-demo.html"
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`;
const TARGET = process.argv[2];
const PORT = 9338;

if (!TARGET) { console.log('用法: node tools/align-roll-test.mjs <URL>'); process.exit(1); }

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

await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url: TARGET });
await sleep(4500);
await send('Runtime.evaluate', {
  expression: `document.getElementById('start')?.click(); 'ok'`,
  returnByValue: true, userGesture: true,
});
await sleep(2500);

const hasHook = await send('Runtime.evaluate', {
  expression: `typeof window.__gyro?.alignNow === 'function' && typeof window.__gyro?.rollErrDeg === 'number'`,
  returnByValue: true,
});
if (!hasHook.result?.value) {
  console.log('HOOK_MISSING —— 页面没有 window.__gyro.alignNow / rollErrDeg');
  ws.close(); proc.kill(); process.exit(1);
}

/* ============ 本地四元数/向量工具（页面里的 THREE 在模块作用域，取不到） ============ */

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

/* three.js Quaternion.setFromUnitVectors —— 旧算法。原样复刻，用于反面参照。 */
function quatFromUnitVectors(a, b) {
  let r = vdot(a, b) + 1;
  let x, y, z, w;
  if (r < 1e-8) {
    r = 0;
    if (Math.abs(a.x) > Math.abs(a.z)) { x = -a.y; y = a.x; z = 0; w = 0; }
    else { x = 0; y = -a.z; z = a.y; w = 0; }
  } else {
    x = a.y * b.z - a.z * b.y;
    y = a.z * b.x - a.x * b.z;
    z = a.x * b.y - a.y * b.x;
    w = r;
  }
  const l = Math.hypot(x, y, z, w) || 1;
  return { x: x / l, y: y / l, z: z / l, w: w / l };
}

/* 滚转误差：设备 up 投影到 ⊥光轴 的平面上，与相机 up 比夹角 */
function rollErrDeg(camQ, devQ) {
  const fwd = vnorm(rotateVec(camQ, { x: 0, y: 0, z: -1 }));
  const upCam = vnorm(rotateVec(camQ, { x: 0, y: 1, z: 0 }));
  const upDev = vnorm(rotateVec(devQ, { x: 0, y: 1, z: 0 }));
  const d = vdot(upDev, fwd);
  const p = vnorm({ x: upDev.x - d * fwd.x, y: upDev.y - d * fwd.y, z: upDev.z - d * fwd.z });
  const dot = Math.max(-1, Math.min(1, vdot(upCam, p)));
  return Math.acos(dot) * 180 / Math.PI;
}

/* ============ 姿态样本 ============
   特意包含「需要偏航」的姿态 —— swing 只在纯俯仰时不出错，
   一旦带上偏航就会把 up 甩偏。 */
const POSES = [
  { a: 0, b: 0, g: 0, label: '水平正对（纯俯仰）' },
  { a: 0, b: 30, g: 0, label: '前后倾 30°（纯俯仰）' },
  { a: 0, b: 0, g: 25, label: '左右倾 25°' },
  { a: 0, b: 35, g: 25, label: '前后 35° + 左右 25°' },
  { a: 45, b: 20, g: -15, label: '偏航 45° + 前后 20° + 左右 -15°' },
  { a: 120, b: 60, g: 30, label: '大角度复合' },
  { a: -80, b: 55, g: -40, label: '反向大角度复合' },
];

console.log('=== 对齐滚转测试 ===\n');

const rows = [];
for (const p of POSES) {
  const r = await send('Runtime.evaluate', {
    expression: `(() => {
      const e = new Event('deviceorientation');
      e.alpha = ${p.a}; e.beta = ${p.b}; e.gamma = ${p.g};
      dispatchEvent(e);
      const ok = window.__gyro.alignNow(true);
      return JSON.stringify({ ok, params: window.__gyro.params });
    })()`,
    returnByValue: true,
  });
  const info = JSON.parse(r.result.value);
  await sleep(1200);   // 等 slerp 平滑收敛（τ=140ms，1.2s → 残差 <0.03%）

  const s = await send('Runtime.evaluate', {
    expression: `JSON.stringify({
      camQuat: window.__gyro.camQuat,
      deviceQuat: window.__gyro.deviceQuat,
      rollErrDeg: window.__gyro.rollErrDeg,
    })`,
    returnByValue: true,
  });
  const o = JSON.parse(s.result.value);

  /* --- ① 光轴是否仍指向地形中心 --- */
  const fwd = vnorm(rotateVec(o.camQuat, { x: 0, y: 0, z: -1 }));
  const eye = { x: 0, y: info.params.camHeight, z: info.params.camDist };
  const t = vnorm({ x: -eye.x, y: -eye.y, z: -eye.z });
  const aimErr = Math.acos(Math.max(-1, Math.min(1, vdot(fwd, t)))) * 180 / Math.PI;

  /* --- ② 页面报告的滚转误差 --- */
  const newRoll = o.rollErrDeg;

  /* --- ③ 反面参照：同样的设备姿态，用旧的 setFromUnitVectors 会歪多少 --- */
  const bLocal = vnorm(rotateVec(qconj(o.deviceQuat), t));
  const aOld = quatFromUnitVectors({ x: 0, y: 0, z: -1 }, bLocal);
  const camOld = qmul(o.deviceQuat, aOld);
  const oldRoll = rollErrDeg(camOld, o.deviceQuat);

  rows.push({ label: p.label, aimErr, newRoll, oldRoll });
  console.log(`--- ${p.label}  (α=${p.a} β=${p.b} γ=${p.g}) ---`);
  console.log(`  光轴指向误差 ${aimErr.toFixed(2)}°    滚转误差 新 ${newRoll.toFixed(2)}° / 旧 ${oldRoll.toFixed(2)}°`);
}

const checks = [];
function chk(name, pass, detail) { checks.push({ name, pass, detail }); }

const worstAim = Math.max(...rows.map(r => r.aimErr));
const worstNew = Math.max(...rows.map(r => r.newRoll));
const worstOld = Math.max(...rows.map(r => r.oldRoll));

chk('所有姿态下光轴都指向地形中心', worstAim < 3,
  `最大 ${worstAim.toFixed(2)}°`);
chk('所有姿态下滚转误差 ≈ 0（新算法）', worstNew < 1,
  `最大 ${worstNew.toFixed(2)}°`);
/* 反面参照：旧算法必须在「需要偏航」的姿态上明显出错，否则本测试没有区分力 */
const yawed = rows.filter(r => /偏航|复合/.test(r.label));
const worstYawOld = Math.max(...yawed.map(r => r.oldRoll));
chk('反面参照：旧算法（setFromUnitVectors）在带偏航的姿态上确实引入滚转',
  worstYawOld > 5, `带偏航姿态下旧算法最大 ${worstYawOld.toFixed(2)}°`);
chk('新算法比旧算法严格更好（每一个姿态都不差）',
  rows.every(r => r.newRoll <= r.oldRoll + 1e-6),
  `新最大 ${worstNew.toFixed(2)}° vs 旧最大 ${worstOld.toFixed(2)}°`);

console.log('\n=== 判定 ===');
let failed = 0;
for (const c of checks) {
  console.log((c.pass ? '  [PASS] ' : '  [FAIL] ') + c.name + '   (' + c.detail + ')');
  if (!c.pass) failed++;
}
console.log(failed === 0
  ? '\n全部通过 ✅ —— 对齐只修正偏航/俯仰，不再带进滚转'
  : `\n${failed} 项未通过 ❌`);

ws.close();
proc.kill();
process.exit(failed === 0 ? 0 : 1);
