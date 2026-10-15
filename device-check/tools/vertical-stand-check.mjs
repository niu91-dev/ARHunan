/**
 * 「平板装在支架上必然有仰角」带来的问题 —— 万向锁（gimbal lock）体检。
 *
 * 为什么必须查这件事：
 *   展项里平板固定在支架上，屏幕不可能平放 —— 一定有仰角。
 *   而 W3C DeviceOrientation 用的是【内旋 Z-X'-Y''】欧拉序：
 *       R_enu = Rz(α)·Rx(β)·Ry(γ)
 *   中间那一步是 Rx(β)。内旋欧拉序在【中间角 = ±90°】处退化：
 *   β = 90°（平板完全竖直，像一块立起来的相框）时 α 与 γ 的旋转轴重合，
 *   两个角只剩「和 / 差」有意义，各自单独失去意义。
 *
 *   所以真问题是：支架仰角要到多少度才会踩到地雷？踩到之后是
 *   【画面坏掉】还是【只是遥测坏掉】？
 *
 * 本脚本纯数学、不起浏览器、< 1 秒，回答六件事：
 *   ① 世界竖直轴平移（用户转支架看四周）在任意 β 下是否无损
 *      —— 判据用【四元数直接比较】，不经欧拉角反解，避免把测试自身的退化算成页面问题
 *   ② β 接近 90° 时，底层姿态的一点点误差会被 α / γ 放大多少倍 —— 条件数 ≈ 1/cos(β)
 *      （只影响把 α 当标量用的遥测，不影响画面）
 *   ③ 欧拉角反解在 β 附近有【两个分支】，它们是不是同一个姿态
 *      —— 是则传感器偶尔跳分支也无害
 *   ④ 反解 → 重建 的保真度（这才是渲染路径的答案）
 *   ⑤ 支架仰角建议
 *   ⑥ 一个本脚本无法替你排除的真机风险
 *
 * 用法：node tools/vertical-stand-check.mjs
 *
 * ⚠️ 本脚本踩过并已修正的两个坑（写测试时容易重犯）：
 *   A. 判据阈值卡到 1e-9，比浮点噪声还紧 → 报假失败。实测往返噪声就是 2.4e-6°，阈值取 1e-4。
 *   B. 用【反解】构造测试输入时，忘了 β 越过 90° 要翻分支 → β=90 处报出 4.5° 的假失败。
 *      页面本身【不做反解】（只由 (α,β,γ) 复合），所以那个失败是测试的，不是页面的。
 */

const R2D = 180 / Math.PI;
const EPS = 1e-4;                  // 浮点噪声量级 ~2.4e-6°，阈值取 1e-4

/* ---------------- 四元数工具（独立实现） ---------------- */
function qmul(a, b) {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}
function qaxis(x, y, z, deg) {
  const r = deg * Math.PI / 360, s = Math.sin(r);
  return { x: x * s, y: y * s, z: z * s, w: Math.cos(r) };
}
function qnorm(q) { const l = Math.hypot(q.x, q.y, q.z, q.w) || 1; return { x: q.x / l, y: q.y / l, z: q.z / l, w: q.w / l }; }
function qAngleDeg(a, b) {
  const d = Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w);
  return 2 * Math.acos(Math.min(1, d)) * R2D;
}
function qToMat(q) {
  const { x, y, z, w } = q;
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
    [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
    [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
  ];
}

/* W3C：R_enu = Rz(α)·Rx(β)·Ry(γ)  —— 复合，永远精确，无奇点 */
function rEnu(a, b, g) {
  return qnorm(qmul(qaxis(0, 0, 1, a), qmul(qaxis(1, 0, 0, b), qaxis(0, 1, 0, g))));
}
/* 反解（分支 0，仅对 β ∈ [−90°, 90°] 有效）。
   矩阵第 2 行 = [-cβ sγ, sβ, cβ cγ]
   ⚠️ β → ±90° 时 cβ → 0，下面两个 atan2 的两个参数【同时】趋近 0，比值被噪声支配
      —— 这就是 α / γ 退化的来源。
   ⚠️ β 越过 90° 时 asin 只能给 [−90,90] 里的值，必须翻到分支 1（见 ③），
      否则会静默返回一个【不同】的姿态。 */
function dec0(q) {
  const m = qToMat(q);
  return {
    alpha: Math.atan2(-m[0][1], m[1][1]) * R2D,
    beta: Math.asin(Math.max(-1, Math.min(1, m[2][1]))) * R2D,
    gamma: Math.atan2(-m[2][0], m[2][2]) * R2D,
  };
}
/* 分支 1：(α+180°, 180°−β, γ+180°) */
function dec1(q) {
  const d = dec0(q);
  return { alpha: d.alpha + 180, beta: 180 - d.beta, gamma: d.gamma + 180 };
}
function angDiff(a, b) {
  let d = a - b;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return Math.abs(d);
}

const A0 = 37, G0 = 12;                     // 一组「支架装歪了一点」的偏航 / 侧倾
const BETAS = [0, 15, 30, 45, 60, 70, 75, 80, 85, 88, 89, 89.9, 90];

console.log('=== 平板支架仰角 vs 万向锁（gimbal lock）体检 ===');
console.log('W3C 内旋欧拉序 Z-X\'-Y\'\'：R_enu = Rz(α)·Rx(β)·Ry(γ)');
console.log('β 的含义：0° = 屏幕平放朝上，90° = 平板完全竖直（像立起来的相框）');
console.log(`基准姿态取 α=${A0}° γ=${G0}°，逐 β 扫\n`);

/* ================= ① 世界竖直轴平移：应当严格等于 α += Δ ================= */
console.log('--- ① 用户转支架看四周（绕世界竖直轴平移 Δ=10°）---');
console.log('   判据：Rz(Δ)·Rz(α)Rx(β)Ry(γ) 与 Rz(α+Δ)Rx(β)Ry(γ) 是否【逐位相同】');
console.log('   ⚠️ 这里【不能】经欧拉角反解再比较 —— β=90° 时反解本身就不唯一，');
console.log('      那会把测试自身的退化误报成页面的问题。（第一版就是这么写错的）\n');
let worstPan = 0;
for (const b of BETAS) {
  const lhs = qnorm(qmul(qaxis(0, 0, 1, 10), rEnu(A0, b, G0)));
  const rhs = rEnu(A0 + 10, b, G0);
  const d = qAngleDeg(lhs, rhs);
  worstPan = Math.max(worstPan, d);
  console.log(`   β=${String(b).padStart(4)}°   四元数偏差 ${d.toExponential(2).padStart(9)}°`);
}
console.log(`\n   最大偏差 ${worstPan.toExponential(2)}°  ` +
  `${worstPan < EPS ? '✅ 平移映射在 β=90° 也是无损的' : '❌ 有损'}\n`);

/* ================= ② 条件数：底层姿态的误差被 α / γ 放大多少倍 ================= */
/* 物理上真实的噪声模型：不是「给 α 加噪声」，而是「真实姿态被扰动了一点点」。
   所以扰动乘在四元数上（右乘 = 绕设备自身某轴的小旋转），再反解回 (α,β,γ)。 */
const DELTA = 0.5;                          // 底层姿态扰动 0.5°（典型 MEMS 融合残差量级）
const AXES = [];
for (let i = 0; i < 12; i++) {
  const t = i / 12 * Math.PI * 2;
  AXES.push([Math.cos(t), Math.sin(t), 0.35]);
}
AXES.push([0, 0, 1], [1, 0, 0], [0, 1, 0]);

console.log(`--- ② 底层姿态扰动 ${DELTA}°，α / γ 会被放大多少倍（只影响遥测，不影响画面）---`);
console.log('   噪声模型：真实姿态 Q_true 右乘一个 0.5° 的小旋转 → 反解 (α,β,γ)');
console.log('   理论条件数 ≈ 1/cos(β)：cβ→0 时两个 atan2 的参数同时趋近 0，绝对噪声盖过信号\n');
console.log('     β     最大|Δα|   放大倍数   理论 1/cosβ   最大|Δγ|');
for (const b of BETAS) {
  const qTrue = rEnu(A0, b, G0);
  let mA = 0, mG = 0;
  for (const ax of AXES) {
    const qNoisy = qnorm(qmul(qTrue, qaxis(ax[0], ax[1], ax[2], DELTA)));
    const d = dec0(qNoisy);
    mA = Math.max(mA, angDiff(d.alpha, A0));
    mG = Math.max(mG, angDiff(d.gamma, G0));
  }
  const amp = mA / DELTA;
  const theory = 1 / Math.cos(b * Math.PI / 180);
  console.log(`   ${String(b).padStart(4)}°   ${mA.toFixed(4).padStart(8)}°   ${amp.toFixed(1).padStart(7)}×   ` +
    `${(b >= 90 ? '∞' : theory.toFixed(1)).padStart(9)}×   ${mG.toFixed(4).padStart(8)}°`);
}
console.log('\n   ⇒ 这一项与「画面是否正确」无关：页面渲染由 (α,β,γ) 复合，不把 α 当标量。');
console.log('     它影响的是 HUD 上的「静止漂移」「相对对齐偏转」两个读数 ——');
console.log('     β 越大，这两个读数越会乱跳，现场人员容易误判成设备坏了。');

/* ================= ③ 反解的两个分支是不是同一个姿态 ================= */
/* ⚠️ 这一段【不能】写成「对同一个 q 反解出分支0、再把分支0 变换成分支1、比两者」——
      那是重言式：分支1 就是按恒等式从分支0 造出来的，必然相等，什么也验不出来。
      要验的是恒等式本身，所以两边都要【独立构造】。 */
console.log('\n--- ③ 反解的两个分支是不是同一个姿态（独立构造两边，非重言） ---');
console.log('   分支0：(α, β, γ)      分支1：(α+180°, 180°−β, γ+180°)');
console.log('   若 Rz(α)Rx(β)Ry(γ) ≡ Rz(α+180)Rx(180−β)Ry(γ+180)，');
console.log('   则传感器偶尔跳分支【无害】—— 两者只是同一姿态的两种写法\n');
console.log('     β     两分支【独立构造】出的姿态之差');
let worstBranch = 0;
for (const b of BETAS) {
  const q0 = rEnu(A0, b, G0);
  const q1 = rEnu(A0 + 180, 180 - b, G0 + 180);      // ← 独立构造，不经反解
  const err = qAngleDeg(q0, q1);
  worstBranch = Math.max(worstBranch, err);
  console.log(`   ${String(b).padStart(4)}°   ${err.toExponential(2).padStart(9)}°`);
}
console.log(`\n   最大差 ${worstBranch.toExponential(2)}°  ` +
  `${worstBranch < EPS ? '✅ 恒等 —— 跳分支无害' : '❌ 跳分支会让画面歪'}`);

/* ================= ④ 反解 → 重建 的保真度（渲染路径的答案） ================= */
console.log('\n--- ④ 反解 → 重建 的保真度（这才是渲染路径的答案）---');
console.log('   做法：真实姿态 → 加 0.5° 物理扰动 → 反解 (α,β,γ) → 页面那样重建 → 比');
console.log('   若差为浮点噪声，则「传感器反解 → 页面重建」这条链无损\n');
console.log('     β     反解→重建 与真实姿态最大差');
let worstFid = 0, worstFidBeta = null;
for (const b of BETAS) {
  let worst = 0;
  for (const ax of AXES) {
    const qt = qnorm(qmul(rEnu(A0, b, G0), qaxis(ax[0], ax[1], ax[2], DELTA)));
    const d = dec0(qt);
    worst = Math.max(worst, qAngleDeg(rEnu(d.alpha, d.beta, d.gamma), qt));
  }
  /* β=90° 恰好是欧拉角表示的固有奇点（cβ=0 → 两个 atan2 都是 0/0），单独标注 */
  const singular = Math.abs(b) >= 90;
  if (!singular && worst > worstFid) { worstFid = worst; worstFidBeta = b; }
  console.log(`   ${String(b).padStart(4)}°   ${worst.toExponential(2).padStart(9)}°` +
    (singular ? '   ← 固有奇点（见下）' : ''));
}
console.log(`\n   非奇点最大差 ${worstFid.toExponential(2)}°（β=${worstFidBeta}°）  ` +
  `${worstFid < EPS ? '✅ 保真 —— 任意仰角下画面都不会因万向锁而错' : '❌ 有损'}`);
console.log('\n   ⚠️ β 恰为 ±90° 时反解【必然】丢信息，这是欧拉角表示的固有缺陷，不是页面的：');
console.log('      cβ = 0 时 α 与 γ 的两组 atan2 参数【同时】变成 0，0/0 无解 ——');
console.log('      「绕竖直轴的朝向」这份信息在 (α,β,γ) 表示里被抹掉了。');
console.log('      实测 β=90.0° 时误差 4.5°（β=89.99° 时仍是 2.4e-6° 的浮点噪声，刀锋一样窄）。');
console.log('      页面不受影响：它由 (α,β,γ) 直接复合 Euler(β,α,−γ,\'YXZ\')，【从不反解】，');
console.log('      β 取任意值（含 >90°）都正确。');
console.log('      受影响的只有「反解」这一侧 —— 包括本脚本这类测试工具，');
console.log('      以及任何未来把姿态改存成欧拉角的改动。');
console.log('      ⇒ 实用结论：别把平板装成完全竖直（β=90°），与 ⑤ 的建议一致。');

/* ================= ⑤ 结论表 ================= */
console.log('\n--- ⑤ 结论：支架仰角怎么选 ---');
const REC = [
  { b: 60, amp: '2.0×', note: '遥测基本可用' },
  { b: 70, amp: '2.9×', note: '可用' },
  { b: 75, amp: '3.9×', note: '可用' },
  { b: 80, amp: '5.8×', note: '遥测开始明显跳动' },
  { b: 85, amp: '11.5×', note: '静止漂移读数乱跳（画面仍正常）' },
  { b: 90, amp: '∞', note: 'α 完全失去意义（画面仍正常）' },
];
console.log('   β（仰角）    α 放大倍数   影响');
for (const r of REC) console.log(`   ${String(r.b).padStart(3)}°       ${r.amp.padStart(7)}      ${r.note}`);
console.log('\n   → 支架仰角建议控制在 β ≤ 80°（平板与水平面夹角 ≥ 10°）：');
console.log('     ① α 放大 ≤ 5.8×，HUD 读数可信；');
console.log('     ② 远离 β=90° 这个让现场人员困惑的退化点。');
console.log('     画面在任意 β 下都正确 —— 这一条已由 ① 与 ④ 分别验证。');

/* ================= ⑥ 真机才能查的前提 ================= */
console.log('\n--- ⑥ 一个本脚本【无法】替你排除的真机风险 ---');
console.log('   上面「保真」的前提是：传感器给出的 (α,β,γ) 来自同一个一致的姿态。');
console.log('   但部分平台是【分开融合】的：β/γ 来自加速度计、α 来自磁力计。');
console.log('   平板接近竖直时加速度计定不出绕竖直轴的朝向；若磁力计又被支架');
console.log('   （金属件 / 扬声器磁铁）干扰，α 就会偏 —— 这时 (α,β,γ) 互相矛盾，');
console.log('   重建出的四元数就是错的，画面会歪。这一条只能真机验。');
console.log('   ⇒ 真机验证项：把平板摆到【实际安装仰角】，缓慢左右平移，看画面是否连续无跳变；');
console.log('     再把仰角改掉 20° 重试。若只在某个仰角附近跳，就是这个问题 ——');
console.log('     对策是换支架材质/位置（远离金属与磁铁），而不是改代码。');

console.log('\n全部检查完成 ✅');

/* 退出码 —— 让聚合运行器（tools/run-all.mjs）能用退出状态判成败，
   而不是去 grep 输出。⚠️ 这一点很重要：本脚本（以及 reference-formula-check）
   会为【被否决的候选】打印 ❌，grep ❌ 会把故意的否定标记算成失败。
   判成败只能看退出码。 */
const okAll = worstPan < EPS && worstBranch < EPS && worstFid < EPS;
if (!okAll) {
  console.log(`\n❌ 有项未通过：平移 ${worstPan.toExponential(2)}° / 分支 ${worstBranch.toExponential(2)}° / ` +
    `反解保真 ${worstFid.toExponential(2)}°（阈值 ${EPS}）`);
}
process.exit(okAll ? 0 : 1);
