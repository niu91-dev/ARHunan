/**
 * 参照公式自检 —— 纯数学，不起浏览器，< 1 秒。
 *
 * 为什么需要它：
 *   验证「陀螺仪角度映射」时必须拿一个**独立于页面实现**的参照物。
 *   我对 W3C 规范公式的记忆并不可靠（R_enu 是 Rz·Rx·Ry 还是别的？
 *   相机约定 −90° 该乘在哪一侧？），**参照公式写错就会得出假结论**。
 *
 *   做法：把几个候选公式都算一遍，看哪一个能让
 *       K = Q_page · Q_ref⁻¹
 *   在所有 (姿态 × 屏幕角) 上都恒定 —— 恒定的那个才是对的。
 *
 * 结论（本脚本会打印出来）：
 *   ✅ M(−90°)·Rz(α)Rx(β)Ry(γ)·q0   → K 恒定【且等于单位四元数】
 *      （即页面实现与规范公式逐分量一致）
 *   ❌ 把 q1 = Rx(−90°) 也塞进参照的写法（B/D/F/G）→ K 随姿态漂到 166°+
 *   ⚠ 漏掉 q0（把 o 当 0）→ K 随屏幕角漂 180°
 *
 * 用法：node tools/reference-formula-check.mjs
 */

/* ---------------- 四元数工具（独立实现） ---------------- */
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
/* three.js Euler(x,y,z,'YXZ') → Ry(y)·Rx(x)·Rz(z) */
const eulerYXZ = (x, y, z) => qnorm(qmul(qaxis(0, 1, 0, y), qmul(qaxis(1, 0, 0, x), qaxis(0, 0, 1, z))));

/* ---------------- 页面公式（three.js DeviceOrientationControls 原样复刻） ---------------- */
const Q1 = qaxis(1, 0, 0, -90);                       // 相机朝设备背面
const pageQuat = (a, b, g, o) =>
  qnorm(qmul(eulerYXZ(b, a, -g), qmul(Q1, qaxis(0, 0, 1, -o))));

/* ---------------- 候选参照公式 ---------------- */
const rEnuSpec = (a, b, g) => qmul(qaxis(0, 0, 1, a), qmul(qaxis(1, 0, 0, b), qaxis(0, 1, 0, g))); // Rz·Rx·Ry
const rEnuT = (a, b, g) => qmul(qaxis(0, 1, 0, g), qmul(qaxis(1, 0, 0, b), qaxis(0, 0, 1, a)));    // 转置
const MXn = qaxis(1, 0, 0, -90);   // 东北天 → 页面世界（Y 朝上、Z 朝南）
const MXp = qaxis(1, 0, 0, 90);
const q0Of = (o) => qaxis(0, 0, 1, -o);

const CANDS = {
  'M(-90)·Rz(α)Rx(β)Ry(γ)·q0':       (a, b, g, o) => qmul(MXn, qmul(rEnuSpec(a, b, g), q0Of(o))),
  'M(-90)·Rz(α)Rx(β)Ry(γ)·q1·q0':    (a, b, g, o) => qmul(MXn, qmul(rEnuSpec(a, b, g), qmul(Q1, q0Of(o)))),
  'M(+90)·Rz(α)Rx(β)Ry(γ)·q1·q0':    (a, b, g, o) => qmul(MXp, qmul(rEnuSpec(a, b, g), qmul(Q1, q0Of(o)))),
  'Rz(α)Rx(β)Ry(γ)·q0（无 M）':       (a, b, g, o) => qmul(rEnuSpec(a, b, g), q0Of(o)),
  'Rz(α)Rx(β)Ry(γ)·q1·q0（无 M）':    (a, b, g, o) => qmul(rEnuSpec(a, b, g), qmul(Q1, q0Of(o))),
  'Ry(γ)Rx(β)Rz(α)·q1·q0（转置）':    (a, b, g, o) => qmul(rEnuT(a, b, g), qmul(Q1, q0Of(o))),
  '漏掉 q0（把 o 当 0）':              (a, b, g, o) => qmul(MXn, rEnuSpec(a, b, g)),
};

const POSES = [
  [0, 0, 0], [0, 30, 0], [0, 0, 25], [45, 55, 0],
  [90, 60, 20], [180, 85, -40], [270, 20, 35], [33, -20, 70],
];
const OS = [0, 90, 180, 270];

console.log('=== 参照公式候选：K = Q_page · Q_ref⁻¹ 的离散度 ===');
console.log('（越小越好；≈0 说明该候选与页面一致，可作独立参照）\n');

let best = null;
for (const [name, fn] of Object.entries(CANDS)) {
  let worst = 0, K0 = null;
  for (const o of OS) for (const [a, b, g] of POSES) {
    const K = qnorm(qmul(pageQuat(a, b, g, o), qconj(fn(a, b, g, o))));
    if (!K0) K0 = K;
    worst = Math.max(worst, qAngleDeg(K0, K));
  }
  const tag = worst < 0.01 ? '✅ 恒定' : worst < 1 ? '⚠ 近似' : '❌ 随姿态/屏幕角漂';
  console.log(`  ${name.padEnd(34)} 最大偏差 ${worst.toFixed(4).padStart(9)}°   ${tag}`);
  if (!best || worst < best.worst) best = { name, worst, K0 };
}

const kIdentity = qAngleDeg(best.K0, { x: 0, y: 0, z: 0, w: 1 });
console.log(`\n最佳参照：${best.name}`);
console.log(`  K 与单位四元数夹角 ${kIdentity.toFixed(6)}°` +
  (kIdentity < 0.01 ? '  → 页面实现与规范公式【逐分量一致】' : '  → 只差一个固定旋转'));

/* ---------------- 反解往返自检（构造「平面内转 φ」的姿态要用它） ---------------- */
function rEnuToAngles(q) {
  const m = qToMat(q);
  return {
    alpha: Math.atan2(-m[0][1], m[1][1]) * R2D,
    beta: Math.asin(Math.max(-1, Math.min(1, m[2][1]))) * R2D,
    gamma: Math.atan2(-m[2][0], m[2][2]) * R2D,
  };
}
let rt = 0;
for (const [a, b, g] of POSES) {
  const q = rEnuSpec(a, b, g);
  const p = rEnuToAngles(q);
  rt = Math.max(rt, qAngleDeg(q, rEnuSpec(p.alpha, p.beta, p.gamma)));
}
console.log(`\nR_enu 反解往返最大差 ${rt.toFixed(6)}°  ` +
  (rt < 1e-4 ? '✅ 反解正确（landscape-map-test 用它构造物理不变量）' : '❌ 反解有问题'));

const ok = best.worst < 0.01 && kIdentity < 0.01 && rt < 1e-4;
console.log(ok ? '\n参照公式确认无误 ✅' : '\n参照公式仍有问题 ❌');

/* ================= α / β / γ 各对应哪根【世界轴】 =================
 *
 * 为什么要单独验这个：
 *   我凭直觉判断过「α 是绕屏幕法线的滚转，所以横屏下左右转平板改的是 β，
 *   页面用 α 判静止在横屏下用错了轴」—— 并据此改了代码。**那是错的**，
 *   因为把矩阵乘法的左右顺序想反了。
 *
 *   R_enu = Rz(α)·Rx(β)·Ry(γ) 是【外旋】复合（最右边的先作用到向量上），
 *   所以 α 作用在【最后】= 绕世界竖直轴的偏航，与设备怎么摆、屏幕朝哪都无关。
 *
 *   结论直接决定「静止/漂移判定能不能用 α」：能用，而且是跨屏幕方向成立的。
 *   这个测试把结论锁住，避免以后又按直觉去改。
 */
function worldAxisOfPerturb(pose, which, o) {
  const d = 10;
  const [a, b, g] = pose;
  const p2 = which === 'a' ? [a + d, b, g] : which === 'b' ? [a, b + d, g] : [a, b, g + d];
  const dq = qnorm(qmul(pageQuat(p2[0], p2[1], p2[2], o), qconj(pageQuat(a, b, g, o))));
  const ang = 2 * Math.acos(Math.min(1, Math.abs(dq.w))) * R2D;
  const s = Math.hypot(dq.x, dq.y, dq.z);
  if (s < 1e-9) return { ang, axis: null };
  const sg = dq.w < 0 ? -1 : 1;
  return { ang, axis: [dq.x / s * sg, dq.y / s * sg, dq.z / s * sg] };
}

console.log('\n=== α / β / γ 各对应哪根世界轴（单独扰动 10°）===');
console.log('世界轴：+上 = 竖直向上（偏航）· +东 / +北 = 水平轴\n');

const AXIS_POSES = [[0, 0, 0], [0, 45, 0], [0, 90, 0], [30, 70, 0], [30, 70, 25], [45, 90, 90]];
let alphaIsYawWorst = 0;
for (const o of [0, 90, 180, 270]) {
  const parts = [];
  for (const p of AXIS_POSES) {
    const r = worldAxisOfPerturb(p, 'a', o);
    /* α 的旋转轴必须与世界竖直轴平行（|轴·(0,1,0)| = 1） */
    alphaIsYawWorst = Math.max(alphaIsYawWorst, 1 - Math.abs(r.axis ? r.axis[1] : 0));
    parts.push(`β=${String(p[1]).padStart(3)} γ=${String(p[2]).padStart(3)} → ${r.axis ? r.axis.map(v => (Math.abs(v) < 1e-9 ? 0 : v).toFixed(2)).join(',') : '退化'}`);
  }
  console.log(`  o=${String(o).padStart(3)}°  α+10° 的旋转轴：${parts.join('   |   ')}`);
}
console.log(`\n  α 的旋转轴与世界竖直轴的最大偏离量 ${alphaIsYawWorst.toExponential(2)}  ` +
  (alphaIsYawWorst < 1e-6 ? '✅ α 恒等于世界偏航 —— 「用 α 判静止」跨屏幕方向成立' : '❌ α 不总是世界偏航'));

/* β / γ 只是顺带打印，说明「它们在不同姿态下对应不同世界轴」——
   这正是不能用它们当稳定判据的原因。 */
for (const which of ['b', 'g']) {
  const parts = [];
  for (const p of AXIS_POSES) {
    const r = worldAxisOfPerturb(p, which, 90);
    parts.push(`${(which === 'b' ? 'β' : 'γ')}+10 @ β=${String(p[1]).padStart(3)} γ=${String(p[2]).padStart(3)} → ${r.axis ? r.axis.map(v => (Math.abs(v) < 1e-9 ? 0 : v).toFixed(2)).join(',') : '退化'}`);
  }
  console.log(`\n  o=90° 时：\n    ${parts.join('\n    ')}`);
}

const ok2 = ok && alphaIsYawWorst < 1e-6;
console.log(ok2 ? '\n全部确认 ✅' : '\n仍有问题 ❌');
process.exit(ok2 ? 0 : 1);
