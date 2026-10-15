/**
 * 陀螺仪角度映射的「横屏正确性」验证 —— 零依赖，直连 Chrome CDP。
 *
 * 为什么必须单独验这件事：
 *   平板是【横屏】固定在支架上使用的，此时 screen.orientation.angle = 90（或 270）。
 *   陀螺仪给的是【设备本体坐标】下的欧拉角，必须先做屏幕旋转补偿 q0，
 *   才变成「屏幕内容坐标系」下的姿态。这一步错了，模型就会整体歪 90°。
 *
 * 为什么不能只看「页面好像是对的」：
 *   必须拿一个**独立于页面实现**的参照物。这里用 W3C DeviceOrientation 规范公式：
 *     设备 → 东北天：  R_enu = Rz(α)·Rx(β)·Ry(γ)
 *     东北天 → 页面世界：M     = Rx(-90°)      （Y 轴朝上、Z 轴朝南）
 *     屏幕 → 设备：     q0    = Rz(-o)
 *   于是「真实相机在页面世界里应有的姿态」= M · R_enu · q0。
 *
 *   （这条参照公式本身也先被验证过：见 tools/_explore-map.mjs —— 用 7 个候选公式
 *     互相印证，只有这一条能让 K 恒定；把 q1 塞进参照的写法都会随姿态漂。）
 *
 * 关键判据（为什么是「差一个固定旋转」而不是直接比大小）：
 *   页面世界的**偏航是任意的**（地形放在哪由第一次对齐决定），所以不能比绝对值。
 *   正确性判据是：页面给出的相机姿态 Q 与参照值之间只差一个【固定】旋转
 *     K = Q · (M·R_enu·q0)⁻¹     必须对所有 (α,β,γ,o) 都是同一个 K
 *   这条判据很严，能抓到：轴映射错、符号错、**屏幕补偿 q0 错（含漏补）**。
 *   本测试还额外要求 K ≈ 单位四元数（即页面与规范公式逐分量一致）。
 *
 * 用法：node tools/landscape-map-test.mjs <URL>
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME_PATH
  || String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`;
const TARGET = process.argv[2];
const PORT = 9341;

if (!TARGET) { console.log('用法: node tools/landscape-map-test.mjs <URL>'); process.exit(1); }

/* ================= 本地四元数工具（独立实现，不依赖页面） ================= */
function qmul(a, b) {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}
function qconj(q) { return { x: -q.x, y: -q.y, z: -q.z, w: q.w }; }
function qaxis(x, y, z, deg) {
  const r = deg * Math.PI / 360, s = Math.sin(r);
  return { x: x * s, y: y * s, z: z * s, w: Math.cos(r) };
}
function qnorm(q) { const l = Math.hypot(q.x, q.y, q.z, q.w) || 1; return { x: q.x / l, y: q.y / l, z: q.z / l, w: q.w / l }; }
/* 两个旋转之间的夹角（度）。四元数双覆盖用 |dot| 处理 */
function qAngleDeg(a, b) {
  const d = Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w);
  return 2 * Math.acos(Math.min(1, d)) * 180 / Math.PI;
}
function qToMat(q) {
  const { x, y, z, w } = q;
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
    [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
    [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
  ];
}
const R2D = 180 / Math.PI;

/* ================= 参照物：W3C 规范 ================= */
/* 设备 → 东北天：R_enu = Rz(α)·Rx(β)·Ry(γ) */
function rEnu(alpha, beta, gamma) {
  return qnorm(qmul(qaxis(0, 0, 1, alpha), qmul(qaxis(1, 0, 0, beta), qaxis(0, 1, 0, gamma))));
}
/* 反解（用于构造「平板在平面内转 φ」后的欧拉角）：R_enu 第 2 行 = [-cβ sγ, sβ, cβ cγ]
   ⚠️ β 越过 90° 时 asin 只能给 [−90,90] 里的值，必须翻到另一分支，
      否则会静默返回一个【不同】的姿态。这里用「重建回去比对」来自我验证，
      自动挑出真正对得上 q 的那一支 —— 比按公式硬推分支更不容易错。
      （第一版没做这件事，于是在 β=90° 处报出假失败。） */
function decOnce(q, alt) {
  const m = qToMat(q);
  const sb = Math.max(-1, Math.min(1, m[2][1]));
  const b0 = Math.asin(sb) * R2D;
  const a0 = Math.atan2(-m[0][1], m[1][1]) * R2D;
  const g0 = Math.atan2(-m[2][0], m[2][2]) * R2D;
  return alt ? { alpha: a0 + 180, beta: 180 - b0, gamma: g0 + 180 }
             : { alpha: a0, beta: b0, gamma: g0 };
}
function rEnuToAngles(q) {
  let best = decOnce(q, false), bestErr = Infinity;
  for (const alt of [false, true]) {
    const d = decOnce(q, alt);
    const err = qAngleDeg(rEnu(d.alpha, d.beta, d.gamma), q);
    if (err < bestErr) { bestErr = err; best = d; }
  }
  return best;
}
const MXn = qaxis(1, 0, 0, -90);            // 东北天 → 页面世界
const q0Of = (o) => qaxis(0, 0, 1, -o);     // 屏幕 → 设备
const refQuat = (a, b, g, o) => qnorm(qmul(MXn, qmul(rEnu(a, b, g), q0Of(o))));

/* ================= 起 Chrome ================= */
const proc = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  /* 独立 profile —— 否则用户自己开着 Chrome 时会「交接」给已有实例、调试端口不生效 */
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
const json = async (e) => JSON.parse((await evaluate(e)).result.value);

await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url: TARGET });
await sleep(4500);
await evaluate(`document.getElementById('start')?.click(); 'ok'`);
await sleep(2500);

/* 喂一个合成 deviceorientation 事件，并取回页面算出的设备姿态 */
async function feedPose(a, b, g) {
  await evaluate(`(() => {
    const e = new Event('deviceorientation');
    e.alpha = ${a}; e.beta = ${b}; e.gamma = ${g};
    dispatchEvent(e);
    return 'ok';
  })()`);
  return json(`JSON.stringify(window.__gyro.deviceQuat)`);
}
async function setOrientation(o) {
  const type = o === 90 ? 'landscapePrimary' : o === 270 ? 'landscapeSecondary'
    : o === 180 ? 'portraitSecondary' : 'portraitPrimary';
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1152, height: 720, deviceScaleFactor: 1, mobile: true,
    screenOrientation: { type, angle: o },
  });
  await sleep(350);
}

const POSES = [
  { a: 0, b: 0, g: 0, label: '平放 · 屏幕朝上' },
  { a: 0, b: 30, g: 0, label: '前后倾 30°' },
  { a: 0, b: 0, g: 25, label: '左右倾 25°' },
  { a: 45, b: 55, g: 0, label: '支架姿态：偏航45° 后仰55°' },
  { a: 90, b: 60, g: 20, label: '偏航90° 后仰60° 侧倾20°' },
  { a: 180, b: 85, g: -40, label: '偏航180° 近直立 侧倾-40°' },
  { a: 270, b: 20, g: 35, label: '偏航270° 微后仰 侧倾35°' },
];

/* ★ 欧拉角奇点姿态：内旋 Z-X'-Y'' 在 β=±90° 处 α 与 γ 退化。
   页面由 (α,β,γ) 直接【复合】、从不反解，所以这些姿态下它【必须】仍然逐分量正确。
   加这一组是把「页面在奇点上也对」钉进回归 —— 若哪天有人把姿态改成
   「反解成欧拉角再存」，这一组会立刻变红。

   ⚠️ 这一组【不参与】下面的物理不变量测试：那个测试要用【反解】构造输入，
      而反解在 β=±90° 本身就丢信息（0/0）。让它参与，测的是测试自己的奇点。 */
const SINGULAR_POSES = [
  { a: 90, b: 90, g: 0, label: '★ 完全竖直 β=90°' },
  { a: 200, b: 100, g: -30, label: '★ 仰过竖直 β=100°' },
  { a: 0, b: -85, g: 45, label: '★ 倒扣近竖直 β=-85°' },
];
const SCREEN_ANGLES = [0, 90, 180, 270];

console.log('=== 陀螺仪角度映射 · 横屏正确性验证 ===\n');
console.log('参照物：W3C  R_enu = Rz(α)·Rx(β)·Ry(γ)，M = Rx(-90°)，q0 = Rz(-o)');
console.log('判据：  K = Q · (M·R_enu·q0)⁻¹ 必须对所有 (姿态 × 屏幕角) 恒定，且 K ≈ 单位四元数\n');

/* ---------- 逐屏幕角采样（用 CDP 覆盖 screen.orientation 来模拟横屏/竖屏） ---------- */
const rows = [];
const readback = [];
for (const o of SCREEN_ANGLES) {
  await setOrientation(o);
  const seen = await json(`JSON.stringify({
    pageAngle: window.__gyro.state.raw.screenAngle,
    pageType: (screen.orientation && screen.orientation.type) || '',
    w: innerWidth, h: innerHeight,
  })`);
  readback.push({ o, ...seen });
  console.log(`--- 覆盖 screen.orientation.angle = ${o}°（页面读到 ${seen.pageAngle}° / ${seen.pageType}，视口 ${seen.w}×${seen.h}）---`);

  for (const p of POSES) {
    const Q = await feedPose(p.a, p.b, p.g);
    const K = qnorm(qmul(Q, qconj(refQuat(p.a, p.b, p.g, o))));
    rows.push({ o, pose: p.label, Q, K });
    const dev = qAngleDeg(Q, refQuat(p.a, p.b, p.g, o));
    console.log(`   ${p.label.padEnd(26)} 页面姿态 vs 规范参照 ${dev.toFixed(4).padStart(8)}°` +
      `   （K 绕轴夹角 ${(rows.length === 1 ? 0 : qAngleDeg(rows[0].K, K)).toFixed(4)}°）`);
  }

  /* 欧拉角奇点姿态 —— 只做「与规范公式比对」，不参与物理不变量（见 SINGULAR_POSES 注释） */
  for (const p of SINGULAR_POSES) {
    const Q = await feedPose(p.a, p.b, p.g);
    const K = qnorm(qmul(Q, qconj(refQuat(p.a, p.b, p.g, o))));
    rows.push({ o, pose: p.label, Q, K, singular: true });
    const dev = qAngleDeg(Q, refQuat(p.a, p.b, p.g, o));
    console.log(`   ${p.label.padEnd(26)} 页面姿态 vs 规范参照 ${dev.toFixed(4).padStart(8)}°` +
      `   （K 绕轴夹角 ${(rows.length === 1 ? 0 : qAngleDeg(rows[0].K, K)).toFixed(4)}°）`);
  }
}

/* ---------- 判定 ---------- */
const K0 = rows[0].K;
let worstK = 0, worstRow = null;
for (const r of rows) {
  const d = qAngleDeg(K0, r.K);
  if (d > worstK) { worstK = d; worstRow = r; }
}
const kIsIdentity = qAngleDeg(K0, { x: 0, y: 0, z: 0, w: 1 });

/* 负对照：如果把 o 当 0（漏掉屏幕补偿），K 会不会漂？会漂才说明判据抓得住 */
const ALL_POSES = [...POSES, ...SINGULAR_POSES];
let worstNoQ0 = 0;
{
  let base = null;
  for (const r of rows) {
    const p = ALL_POSES.find(p => p.label === r.pose);
    const K = qnorm(qmul(r.Q, qconj(refQuat(p.a, p.b, p.g, 0))));
    if (!base) base = K;
    worstNoQ0 = Math.max(worstNoQ0, qAngleDeg(base, K));
  }
}

/* 物理不变量：平板绕屏幕法线转 φ，系统把 o 也改 φ → 相机应【逐位不变】
   （注意：两次喂姿态的【屏幕角必须不同】，否则测的是「同一个 o 下换了姿态」，
     那当然会变 —— 第一版就是这么写错的，报了 180° 的假失败。） */
const inv = [];
for (const p of POSES) {
  for (const phi of [90, 180, 270, -90]) {
    const rot = rEnuToAngles(qmul(rEnu(p.a, p.b, p.g), qaxis(0, 0, 1, phi)));
    const oB = ((0 + phi) % 360 + 360) % 360;
    await setOrientation(0);
    const qA = await feedPose(p.a, p.b, p.g);
    await setOrientation(oB);
    const qB = await feedPose(rot.alpha, rot.beta, rot.gamma);
    inv.push({ pose: p.label, phi, oB, d: qAngleDeg(qA, qB) });
  }
}
console.log('\n--- 物理不变量：平面内转 φ + 屏幕角改 φ → 相机应逐位不变 ---');
for (const r of inv.slice(0, 8)) {
  console.log(`   ${r.pose.padEnd(26)} φ=${String(r.phi).padStart(4)}° → o=${String(r.oB).padStart(3)}°   相机差 ${r.d.toFixed(4)}°`);
}
console.log(`   …（共 ${inv.length} 组，最大偏差 ${Math.max(...inv.map(r => r.d)).toFixed(4)}°）`);

/* 屏幕方向变化（设备没动）时，alignQuat 不应被改写。
   —— 「设备没动、系统自己转屏」在固定支架上是会发生的：浏览器可能先按竖屏起、
   随后系统才转成横屏。此时【规范公式本身】就已经给出正确结果（相机随内容坐标系
   一起转，用户看到的画面不变），不需要、也不应该去重锚 alignQuat。
   一旦重锚，相机就不再等于内容坐标系，模型会相对屏幕歪掉 Δ。 */
await setOrientation(0);
await feedPose(45, 55, 0);
await sleep(400);
await evaluate(`window.__gyro.alignNow(true); 'ok'`);
await sleep(900);
const before = await json(`JSON.stringify({
  align: window.__gyro.alignQuat, cam: window.__gyro.camQuat,
  dev: window.__gyro.deviceQuat, o: window.__gyro.state.raw.screenAngle,
})`);
await setOrientation(90);
await sleep(900);
const after = await json(`JSON.stringify({
  align: window.__gyro.alignQuat, cam: window.__gyro.camQuat,
  dev: window.__gyro.deviceQuat, o: window.__gyro.state.raw.screenAngle,
})`);
const dAlign = qAngleDeg(before.align, after.align);
const camShould = qnorm(qmul(after.dev, before.align));   // 规范公式给出的正确相机
const dCam = qAngleDeg(after.cam, camShould);
/* 顺带看看「重锚」到底把相机扭了多少（= 模型相对屏幕歪了多少） */
const dCamVsOld = qAngleDeg(after.cam, before.cam);

console.log('\n--- 屏幕方向 0° → 90°（设备姿态不变）---');
console.log(`   alignQuat 变化 ${dAlign.toFixed(4)}°   （应为 0：不重锚）`);
console.log(`   实时相机 vs 规范公式给出的正确相机 ${dCam.toFixed(4)}°   （应为 0）`);
console.log(`   实时相机 vs 转屏前相机 ${dCamVsOld.toFixed(4)}°   （≠0 说明相机被改过）`);

const checks = [];
const chk = (name, pass, detail) => checks.push({ name, pass, detail });

chk('所有 (姿态 × 屏幕角) 下，页面姿态与 W3C 参照只差一个固定旋转',
  worstK < 0.01,
  worstK < 0.01 ? `最大偏差 ${worstK.toFixed(4)}°（${rows.length} 个采样）`
                : `最大偏差 ${worstK.toFixed(4)}°，出现在「${worstRow.pose}」@ o=${worstRow.o}°`);
chk('该固定旋转 ≈ 单位四元数（页面与规范公式逐分量一致，含屏幕补偿 q0）',
  kIsIdentity < 0.01, `K 与单位四元数夹角 ${kIsIdentity.toFixed(4)}°`);
chk('页面确实读到了被覆盖的屏幕角（防止测试空转）',
  readback.every(r => r.pageAngle === r.o),
  readback.map(r => `o=${r.o}→读到${r.pageAngle}°`).join(' / '));
chk('负对照：忽略屏幕补偿 q0 会让 K 漂起来（判据确实抓得住漏补）',
  worstNoQ0 > 1, `漏补 q0 时最大偏差 ${worstNoQ0.toFixed(3)}°`);
chk('横屏下物理不变量成立：平板在平面内转 φ、系统把 o 改 φ → 相机逐位不变',
  inv.every(r => r.d < 0.01),
  `最大偏差 ${Math.max(...inv.map(r => r.d)).toFixed(4)}°（${inv.length} 组）`);
chk('屏幕方向变化（设备不动）时不重锚 alignQuat —— 相机仍等于规范公式结果',
  dAlign < 0.5 && dCam < 1.0,
  `alignQuat 变化 ${dAlign.toFixed(4)}°，相机偏差 ${dCam.toFixed(4)}°`);
/* 欧拉角奇点：内旋 Z-X'-Y'' 在 β=±90° 处 α 与 γ 退化。
   页面由 (α,β,γ) 复合、从不反解，所以这里必须仍然逐分量一致。 */
{
  const srows = rows.filter(r => r.singular);
  const worstS = Math.max(...srows.map(r => qAngleDeg(r.K, K0)));
  chk('欧拉角奇点姿态（β=90° / 100° / −85°）下页面仍与规范公式逐分量一致',
    worstS < 0.01,
    `最大偏差 ${worstS.toFixed(4)}°（${srows.length} 个采样：${SINGULAR_POSES.map(p => p.label.replace('★ ', '')).join(' / ')}）`);
}

console.log('\n=== 判定 ===');
let failed = 0;
for (const c of checks) {
  console.log((c.pass ? '  [PASS] ' : '  [FAIL] ') + c.name + '   (' + c.detail + ')');
  if (!c.pass) failed++;
}
console.log(failed === 0
  ? '\n全部通过 ✅ —— 陀螺仪角度已按屏幕方向正确映射，横屏 / 竖屏都成立'
  : `\n${failed} 项未通过 ❌`);

ws.close(); proc.kill();
process.exit(failed === 0 ? 0 : 1);
