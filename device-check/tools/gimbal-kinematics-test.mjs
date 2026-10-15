/**
 * 云台（台子）运动学回归测试 —— 零依赖，直连 Chrome CDP。
 *
 * 现场约束（被测对象）：
 *   pad 固定在台子上、台子底座不动；台子可绕【竖直轴】水平转、绕【水平轴】上下转。
 *   两轴【交点】是唯一不动的点，所以
 *
 *       camPos(θ, φ) = pivot + R_y(θ) · R_x(φ) · off
 *       camQuat(θ, φ) = R_y(θ) · R_x(φ)              （零位光轴水平时 qMount = I）
 *
 * 被测的三条结论：
 *   ① off = 0 → 位置对转角【完全不变】（纯旋转，现有 3DoF 代码即正确）
 *   ② off ≠ 0 → 位置严格等于解析式，且落在「以交点为心、半径 |off|」的球面上
 *   ③ 位置变了，锚点世界坐标【仍然不变】—— 锚定与相机平移解耦
 *
 * ⚠️ 期望值【在 Node 侧用矩阵独立算一遍】，不复用页面里的实现。
 *    否则页面写错了测试也会跟着错 —— 那是自证，不是验证。
 *
 * 用法：node tools/gimbal-kinematics-test.mjs <URL>
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME_PATH
  || String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`;
const TARGET = process.argv[2];
const PORT = 9351;

if (!TARGET) { console.log('用法: node tools/gimbal-kinematics-test.mjs <URL>'); process.exit(1); }

/* ---------- Node 侧独立实现（矩阵版，与页面的四元数版互不相关）---------- */
const D2R = Math.PI / 180;
/** R_y(θ) · R_x(φ) —— 外轴(偏航) × 内轴(俯仰) */
function rotYx(yawDeg, pitchDeg) {
  const c = Math.cos(yawDeg * D2R), s = Math.sin(yawDeg * D2R);
  const cp = Math.cos(pitchDeg * D2R), sp = Math.sin(pitchDeg * D2R);
  // Ry = [[c,0,s],[0,1,0],[-s,0,c]]，Rx = [[1,0,0],[0,cp,-sp],[0,sp,cp]]
  return [
    [c, s * sp, s * cp],
    [0, cp, -sp],
    [-s, c * sp, c * cp],
  ];
}
const applyM = (M, v) => ({
  x: M[0][0] * v.x + M[0][1] * v.y + M[0][2] * v.z,
  y: M[1][0] * v.x + M[1][1] * v.y + M[1][2] * v.z,
  z: M[2][0] * v.x + M[2][1] * v.y + M[2][2] * v.z,
});
const maxAbsDiff = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.z - b.z));

/* ---------- CDP 启动 ---------- */
const proc = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
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
const pageErrors = [];
ws.addEventListener('message', ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
  if (m.method === 'Runtime.exceptionThrown') {
    pageErrors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    pageErrors.push(m.params.args.map(a => a.value ?? a.description).join(' '));
  }
});

const evaluate = (expression) => send('Runtime.evaluate', { expression, returnByValue: true, userGesture: true });
const evalJson = async (expr) => {
  const r = await evaluate(`JSON.stringify(${expr} === undefined ? null : ${expr})`);
  if (!r) return null;
  if (r.exceptionDetails) return { __err: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
  if (!r.result || r.result.value === undefined) return null;
  try { return JSON.parse(r.result.value); } catch (e) { return null; }
};

await send('Runtime.enable');
await send('Page.enable');
await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Emulation.setDeviceMetricsOverride', { width: 1152, height: 720, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: TARGET + (TARGET.includes('?') ? '&' : '?') + 'cb=' + Date.now() });
await sleep(6000);
await evaluate(`document.getElementById('start')?.click(); 'ok'`);
await sleep(1500);
/* headless 无陀螺仪：喂一个合成姿态，让对齐完成、锚点建立 */
await evaluate(`(() => { const e = new Event('deviceorientation');
  e.alpha = 0; e.beta = 55; e.gamma = 25; dispatchEvent(e); return 'ok'; })()`);
await sleep(1000);

const checks = [];
const chk = (name, pass, detail) => checks.push({ name, pass, detail });

const readGimbal = () => evalJson('window.__gyro.gimbal');
const readCamPos = () => evalJson('window.__gyro.camPos');
const readCamQuat = () => evalJson('window.__gyro.camQuat');
const readCamBasis = () => evalJson('window.__gyro.camBasis');
const readAnchors = () => evalJson('window.__gyro.arAnchors');
const readCoverage = () => evalJson('window.__gyro.arCoverage');

/** 设角度 → 读相机位置（等两帧让渲染循环把位置写进去） */
async function setAngles(yaw, pitch) {
  await evaluate(`window.__gyro.setGimbalAngles(${yaw}, ${pitch})`);
  await sleep(120);
  return { pos: await readCamPos(), quat: await readCamQuat() };
}

console.log('=== 云台（台子）运动学测试 ===\n');

const g0 = await readGimbal();
if (!g0 || g0.off === undefined) {
  console.log('云台接口不存在，页面可能是旧版。页面错误：', pageErrors);
  ws.close(); proc.kill(); process.exit(1);
}
const nominal = await evalJson('window.__gyro.params');
const NOMINAL = { x: 0, y: nominal.camHeight, z: nominal.camDist };
console.log(`标称相机位置 (0, ${NOMINAL.y}, ${NOMINAL.z})，页面错误：${pageErrors.length ? pageErrors.join(' | ') : '（无）'}\n`);
chk('页面无未捕获错误', pageErrors.length === 0,
  pageErrors.length ? pageErrors[0].slice(0, 90) : '无');
chk('默认状态：云台关、偏移为 0（= 原有行为）', g0.on === false && g0.offLen < 1e-12,
  `on=${g0.on} offLen=${g0.offLen}`);

/* ================= ① off = 0：位置对转角完全不变 ================= */
await evaluate(`window.__gyro.setGimbalOffset(0, 0, 0); window.__gyro.setGimbalOn(true); 'ok'`);
await sleep(150);
const pivot0 = (await readGimbal()).pivot;

const sweep = [];
for (const [y, p] of [[0, 0], [0, -15.6], [45, 0], [45, -20], [90, 10], [-90, -10], [180, 0], [135, 30], [-135, -30], [180, 60]]) {
  const r = await setAngles(y, p);
  sweep.push({ y, p, pos: r.pos });
}
let drift0 = 0, drift0At = '';
for (const s of sweep) {
  const d = maxAbsDiff(s.pos, NOMINAL);
  if (d > drift0) { drift0 = d; drift0At = `yaw=${s.y} pitch=${s.p}`; }
}
chk('off=0：转 10 组角度后相机位置逐分量不变（纯旋转）', drift0 < 1e-9,
  `最大漂移 ${drift0.toExponential(2)} m（${drift0At || '—'}）`);
chk('off=0：相机位置恒等于两轴交点', maxAbsDiff((await readCamPos()), pivot0) < 1e-9,
  `pivot=(${pivot0.x.toFixed(3)}, ${pivot0.y.toFixed(3)}, ${pivot0.z.toFixed(3)})`);

/* 朝向必须【确实变了】—— 否则「位置不变」可能只是因为什么都没动 */
await setAngles(0, 0);
const qZero = await readCamQuat();
await setAngles(60, 0);
const qYaw = await readCamQuat();
const quatDiff = Math.max(Math.abs(qZero.x - qYaw.x), Math.abs(qZero.y - qYaw.y),
  Math.abs(qZero.z - qYaw.z), Math.abs(qZero.w - qYaw.w));
chk('off=0：朝向仍随转角变化（位置不变 ≠ 什么都没动）', quatDiff > 0.1,
  `yaw 60° 后四元数最大分量差 ${quatDiff.toFixed(3)}`);

/* ================= ② off ≠ 0：位置严格等于解析式 ================= */
const OFF = { x: 0.08, y: 0.05, z: -0.03 };   // 后摄光心偏离交点 8/5/−3 cm
await evaluate(`window.__gyro.setGimbalOffset(${OFF.x}, ${OFF.y}, ${OFF.z}); 'ok'`);
await sleep(150);
const pivot1 = (await readGimbal()).pivot;
const offLen = Math.hypot(OFF.x, OFF.y, OFF.z);

let maxKinErr = 0, kinAt = '';
let maxRadiusErr = 0;
const poses2 = [[0, 0], [30, 0], [30, -20], [90, 15], [-90, -15], [180, 0], [150, 40], [-120, -40]];
for (const [y, p] of poses2) {
  const { pos } = await setAngles(y, p);
  /* 期望值在 Node 侧独立算：pivot + R_y(θ)R_x(φ)·off */
  const exp = applyM(rotYx(y, p), OFF);
  const want = { x: pivot1.x + exp.x, y: pivot1.y + exp.y, z: pivot1.z + exp.z };
  const d = maxAbsDiff(pos, want);
  if (d > maxKinErr) { maxKinErr = d; kinAt = `yaw=${y} pitch=${p}`; }
  /* 距离交点的距离必须恒等于 |off| —— 位置落在球面上 */
  const rr = Math.hypot(pos.x - pivot1.x, pos.y - pivot1.y, pos.z - pivot1.z);
  maxRadiusErr = Math.max(maxRadiusErr, Math.abs(rr - offLen));
}
chk('off≠0：位置与解析式 pivot+R_y(θ)R_x(φ)·off 逐分量吻合', maxKinErr < 1e-9,
  `最大误差 ${maxKinErr.toExponential(2)} m（${kinAt}）`);
chk('off≠0：位置到交点的距离恒等于 |off|（落在球面上）', maxRadiusErr < 1e-9,
  `|off|=${offLen.toFixed(4)} m，最大偏差 ${maxRadiusErr.toExponential(2)} m`);

/* 水平旋转一圈：位置应扫出一个【圆】，半径 = off 的水平分量，高度恒定 */
let maxCircleErr = 0, maxYErr = 0;
const rHoriz = Math.hypot(OFF.x, OFF.z);
for (const y of [0, 30, 60, 90, 120, 150, 180, -150, -120, -90, -60, -30]) {
  const { pos } = await setAngles(y, 0);
  maxCircleErr = Math.max(maxCircleErr, Math.abs(Math.hypot(pos.x - pivot1.x, pos.z - pivot1.z) - rHoriz));
  maxYErr = Math.max(maxYErr, Math.abs(pos.y - (pivot1.y + OFF.y)));
}
chk('水平转一圈：位置扫出半径 = |off 水平分量| 的圆，高度恒定',
  maxCircleErr < 1e-9 && maxYErr < 1e-9,
  `半径 ${rHoriz.toFixed(4)} m（误差 ${maxCircleErr.toExponential(2)}），高度误差 ${maxYErr.toExponential(2)}`);

/* 转动一圈的【平移幅度】—— 这是「off 必须建模」的量化依据 */
const arcSwing = 2 * Math.hypot(OFF.x, OFF.z);
const angErrDeg = Math.atan2(arcSwing, 2.0) * 180 / Math.PI;
console.log(`\n  · |off| = ${offLen.toFixed(3)} m → 水平转 180° 时光心横移 ${arcSwing.toFixed(3)} m`);
console.log(`  · 折算到 2.00 m 深的地物：角误差 ${angErrDeg.toFixed(2)}°，` +
  `水平视场 65° 铺 1152 px 时约 ${(angErrDeg / 65 * 1152).toFixed(0)} px\n`);

/* ================= 朝向与 off 无关；两轴云台不产生滚转 ================= */
const qWithOff = (await setAngles(37, 21)).quat;
await evaluate(`window.__gyro.setGimbalOffset(0, 0, 0); 'ok'`);
await sleep(150);
const qNoOff = (await setAngles(37, 21)).quat;
const qOffDiff = Math.max(Math.abs(qWithOff.x - qNoOff.x), Math.abs(qWithOff.y - qNoOff.y),
  Math.abs(qWithOff.z - qNoOff.z), Math.abs(qWithOff.w - qNoOff.w));
chk('朝向只由两轴角度决定，与 off 无关', qOffDiff < 1e-9,
  `off=0 与 off≠0 的四元数最大分量差 ${qOffDiff.toExponential(2)}`);

await evaluate(`window.__gyro.setGimbalOffset(${OFF.x}, ${OFF.y}, ${OFF.z}); 'ok'`);
await sleep(120);
let maxRightY = 0, maxRightVar = 0;
const rightAtYaw60 = [];
for (const [y, p] of [[0, 0], [45, 0], [45, 20], [45, -20], [45, 40], [45, -40], [90, 0], [-90, 0], [180, 0]]) {
  const b = (await setAngles(y, p)).quat && await readCamBasis();
  maxRightY = Math.max(maxRightY, Math.abs(b.right.y));
  if (y === 45) rightAtYaw60.push(b.right);
}
chk('两轴云台不产生滚转：相机右向量恒在水平面内（right.y ≡ 0）', maxRightY < 1e-9,
  `max|right.y| = ${maxRightY.toExponential(2)}`);

/* 外轴×内轴的指纹：固定 yaw 扫 pitch，右向量必须【逐分量不变】。
   反过来的 R_x(φ)R_y(θ) 会让右向量随 pitch 变化 —— 这条能把它区分开。 */
const ref = rightAtYaw60[0];
for (const r of rightAtYaw60) maxRightVar = Math.max(maxRightVar, maxDiff3(r, ref));
/* 再和 Node 侧解析值比：right = R_y(θ)·(1,0,0) = (cosθ, 0, −sinθ) */
const wantRight = { x: Math.cos(45 * D2R), y: 0, z: -Math.sin(45 * D2R) };
const rightAbsErr = maxDiff3(ref, wantRight);
chk('旋转顺序是外轴(偏航)×内轴(俯仰)：pitch 不改变右向量', maxRightVar < 1e-9,
  `固定 yaw=45° 扫 5 个 pitch，右向量最大变化 ${maxRightVar.toExponential(2)}`);
chk('右向量与解析式 (cosθ, 0, −sinθ) 吻合', rightAbsErr < 1e-9,
  `误差 ${rightAbsErr.toExponential(2)}`);
function maxDiff3(a, b) { return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.z - b.z)); }

/* ================= 「对准中心」解算 ================= */
await evaluate(`window.__gyro.setGimbalOffset(0, 0, 0); window.__gyro.setGimbalOn(true); 'ok'`);
await sleep(120);
const aimSol = await evalJson(`window.__gyro.gimbalAnglesToCenter({x:0, y:${NOMINAL.y}, z:${NOMINAL.z}})`);
const aimed = await setAngles(aimSol.yawDeg, aimSol.pitchDeg);
const fwd = (await readCamBasis()).fwd;
/* 从相机位置指向原点的单位向量 */
const toO = { x: -aimed.pos.x, y: -aimed.pos.y, z: -aimed.pos.z };
const toOlen = Math.hypot(toO.x, toO.y, toO.z);
const toOu = { x: toO.x / toOlen, y: toO.y / toOlen, z: toO.z / toOlen };
const aimErrDeg = Math.acos(Math.min(1, fwd.x * toOu.x + fwd.y * toOu.y + fwd.z * toOu.z)) * 180 / Math.PI;
chk('「对准中心」解出的角度确实指向原点', aimErrDeg < 0.01,
  `水平 ${aimSol.yawDeg.toFixed(2)}° / 上下 ${aimSol.pitchDeg.toFixed(2)}° → 偏差 ${aimErrDeg.toFixed(4)}°`);

/* ================= ③ 相机平移不影响锚点（锚定与相机解耦）================= */
await evaluate(`window.__gyro.setGimbalOffset(${OFF.x}, ${OFF.y}, ${OFF.z}); 'ok'`);
await sleep(150);
const anchorBase = (await readAnchors()).map(a => ({ id: a.id, ...a.pos }));
let maxAnchorDrift = 0, anchorAt = '';
const covByYaw = [];
for (const y of [0, 30, 60, 90, 120, 180, -30, -60, -90, -120, -180]) {
  await setAngles(y, -15.6);
  const arr = await readAnchors();
  covByYaw.push({ y, cov: await readCoverage(), n: arr.filter(a => a.visible).length });
  for (let i = 0; i < arr.length; i++) {
    const d = maxDiff3(arr[i].pos, anchorBase[i]);
    if (d > maxAnchorDrift) { maxAnchorDrift = d; anchorAt = `${arr[i].id} @ yaw=${y}`; }
  }
}
chk('相机绕交点平移 11 个方位后，锚点世界坐标仍不动', maxAnchorDrift < 1e-9,
  `最大漂移 ${maxAnchorDrift.toExponential(2)} m（${anchorAt || '—'}）`);

/* 位置变了 → 视野区域必须跟着变（说明裁剪用的是真实相机，不是写死的） */
const covSet = new Set(covByYaw.map(c => c.cov.toFixed(4)));
chk('相机平移后视野覆盖率随之变化（裁剪跟随真实相机）', covSet.size > 3,
  covByYaw.map(c => `y${c.y}:${(c.cov * 100).toFixed(0)}%`).join(' '));

/* ================= 真机路径：drive='gyro' 用姿态增量推位置 =================

   标定基准的前提是「此刻相机的位姿已知」。所以不能随便切到 gyro 就标定，
   必须先在 manual 模式下把台子摆到零位 —— 那里位置 = pivot + off、
   朝向 = 单位四元数，两个量都是确定的。之后再切 gyro 标定，
   r0 就严格等于 off、q0 严格等于 I，期望值可以直接写 pivot + R_y(θ)R_x(φ)·off。

   ⚠️ 这里踩过两次，都是同一个根因「基准取到了非零位姿态」：
      · 先切 gyro 再标定 → 陀螺仪已经把朝向写成任意值，q0 ≠ I，Δq 全错
      · 带着上一轮转角去标定 → r0 带上一段多余平移，位置整体偏掉
   页面据此把基准标定也挪进了 alignNow（对齐那一刻位姿才是确定的）。 */
async function zeroThenCapture() {
  await evaluate(`window.__gyro.clearAim(); 'ok'`);
  await evaluate(`window.__gyro.setGimbalDrive('manual'); 'ok'`);
  await evaluate(`window.__gyro.setGimbalOn(true); 'ok'`);
  await evaluate(`window.__gyro.setGimbalAngles(0, 0); 'ok'`);
  await sleep(320);                                  // 等 manual 渲染分支写入零位位姿
  /* ⚠️ 零位位姿必须在【切 gyro 之前】读 —— 切过去之后陀螺仪立刻接管朝向，
     再读到的就不是标定用的 q0 了（这一版就踩了：读到 0.9929 的 w）。 */
  const pose = { pos: await readCamPos(), quat: await readCamQuat() };
  await evaluate(`window.__gyro.setGimbalDrive('gyro'); 'ok'`);   // 此刻标定基准
  await sleep(160);
  return { pos: pose.pos, quat: pose.quat, info: await readGimbal() };
}

await evaluate(`window.__gyro.setGimbalOffset(${OFF.x}, ${OFF.y}, ${OFF.z}); 'ok'`);
const z1 = await zeroThenCapture();
chk('gyro 驱动：切换时已标定基准', z1.info.hasGyroRef === true,
  `drive=${z1.info.drive} hasGyroRef=${z1.info.hasGyroRef}`);
chk('gyro 驱动：零位标定后 |r0| = |off|', Math.abs(z1.info.r0Len - offLen) < 1e-9,
  `|r0|=${z1.info.r0Len.toFixed(4)} vs |off|=${offLen.toFixed(4)}`);
chk('gyro 驱动：零位时相机朝向为单位四元数（q0 = I）', Math.abs(z1.quat.w - 1) < 1e-9,
  `q0.w=${z1.quat.w.toFixed(6)}`);

/* 强制一个已知姿态，再让页面用 Δq·r0 推位置 */
let maxGyroErr = 0, gyroAt = '';
for (const [y, p] of [[25, 10], [-40, -12], [70, 8], [160, 0], [-100, 20]]) {
  const t = await evalJson(`window.__gyro.gimbalPoseAt(${y}, ${p})`);
  await evaluate(`window.__gyro.setCamQuat(${t.quat.x}, ${t.quat.y}, ${t.quat.z}, ${t.quat.w}); 'ok'`);
  await evaluate(`window.__gyro.updateCamPos(); 'ok'`);
  await sleep(60);
  const pos = await readCamPos();
  const exp = applyM(rotYx(y, p), OFF);
  const want = { x: pivot1.x + exp.x, y: pivot1.y + exp.y, z: pivot1.z + exp.z };
  const d = maxDiff3(pos, want);
  if (d > maxGyroErr) { maxGyroErr = d; gyroAt = `yaw=${y} pitch=${p}`; }
}
chk('gyro 驱动：Δq·r0 推出的位置与运动学解析式一致', maxGyroErr < 1e-6,
  `最大误差 ${maxGyroErr.toExponential(2)} m（${gyroAt}）`);

/* off = 0 时 gyro 路径退化为「位置恒定」—— 与原行为完全等价 */
await evaluate(`window.__gyro.setGimbalOffset(0, 0, 0); 'ok'`);
const z2 = await zeroThenCapture();
chk('gyro 驱动 + off=0：基准 r0 为 0（标定在标称位置）', z2.info.r0Len < 1e-12,
  `|r0| = ${z2.info.r0Len.toExponential(2)} m`);
let maxDegErr = 0;
for (const [y, p] of [[35, 5], [-55, -15], [120, 25]]) {
  const t = await evalJson(`window.__gyro.gimbalPoseAt(${y}, ${p})`);
  await evaluate(`window.__gyro.setCamQuat(${t.quat.x}, ${t.quat.y}, ${t.quat.z}, ${t.quat.w}); 'ok'`);
  await evaluate(`window.__gyro.updateCamPos(); 'ok'`);
  await sleep(60);
  maxDegErr = Math.max(maxDegErr, maxDiff3(await readCamPos(), NOMINAL));
}
chk('gyro 驱动 + off=0：退化为位置恒定（与原有 3DoF 行为等价）', maxDegErr < 1e-9,
  `最大漂移 ${maxDegErr.toExponential(2)} m`);

/* ================= 关掉云台 → 回到固定位置 ================= */
await evaluate(`window.__gyro.clearAim(); window.__gyro.setGimbalOn(false); 'ok'`);
await sleep(200);
chk('关闭云台后回到标称固定位置', maxDiff3(await readCamPos(), NOMINAL) < 1e-9,
  `camPos=(${NOMINAL.x}, ${NOMINAL.y}, ${NOMINAL.z})`);

/* ---------- 判定汇总 ---------- */
console.log('=== 判定 ===');
let failed = 0;
for (const c of checks) {
  console.log((c.pass ? '  [PASS] ' : '  [FAIL] ') + c.name + '   (' + c.detail + ')');
  if (!c.pass) failed++;
}
console.log(failed === 0
  ? '\n全部通过 ✅ —— 台子两轴旋转的位置/朝向关系与解析式一致，且不影响 AR 锚定'
  : `\n${failed} 项未通过 ❌`);

ws.close(); proc.kill();
process.exit(failed === 0 ? 0 : 1);
