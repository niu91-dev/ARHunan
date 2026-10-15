#!/usr/bin/env node
/**
 * 现场取景核算 —— 判断「虚拟地形张角」是否与「真实沙盘」匹配。
 *
 * 为什么要单独算：
 *   AR 叠加成立的前提是【虚拟相机位置 = 真实相机位置】。
 *   相机位置 = (camHeight, camDist)，沙盘尺寸 = tableW。
 *   camDist 一旦接近沙盘半径，近端边缘张角会急剧增大 ——
 *   这是【物理必然】（真实相机同样拍不到近端），不是参数填错。
 *   本脚本把「出画多少」「哪一段看不到」算清楚，供现场判断。
 *
 * 用法：
 *   node tools/framing-params.mjs --tableW 2.8 --circle --dist 1.4 --height 0.6
 *   node tools/framing-params.mjs --tableW 2.8 --circle --dist 1.4 --height 0.6 --solve
 *   node tools/framing-params.mjs --tableW 2.8 --circle --sweep
 *
 * 参数：
 *   --tableW  沙盘宽度 / 直径（m）
 *   --dist    相机到沙盘中心的水平距离（m）
 *   --height  相机相对【沙盘面】的高度（m）
 *   --circle  沙盘为圆形（tableW = 直径），按圆周采样
 *   --square  沙盘为正方形
 *             （两者都不给 = 矩形，深度 = 宽度 × 湖南地形比例 5.5/4.8）
 *   --hFov    水平视场角（默认 65，平板后摄）
 *   --aspect  屏幕宽高比（默认 1.6 = 16:10 横屏）
 *   --solve   反算「边缘全部入画」所需的最小 camDist（保持当前俯角）
 *   --sweep   扫描一组 (dist, height) 组合，打印取景表
 */
const D2R = Math.PI / 180, R2D = 180 / Math.PI;

/* ---------- 极简参数解析 ---------- */
const argv = process.argv.slice(2);
const opt = { tableW: null, dist: null, height: null, hFov: 65, aspect: 1.6,
              square: false, circle: false, solve: false, sweep: false };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--square') { opt.square = true; continue; }
  if (a === '--circle') { opt.circle = true; continue; }
  if (a === '--solve') { opt.solve = true; continue; }
  if (a === '--sweep') { opt.sweep = true; continue; }
  if (a.startsWith('--')) {
    const k = a.slice(2);
    if (!(k in opt)) { console.error('未知参数: ' + a); process.exit(2); }
    opt[k] = Number(argv[++i]);
    continue;
  }
  console.error('无法识别的参数: ' + a); process.exit(2);
}
if (opt.tableW == null || (!opt.sweep && (opt.dist == null || opt.height == null))) {
  console.error('用法: node tools/framing-params.mjs --tableW 2.8 [--circle|--square] --dist 1.4 --height 0.6 [--solve|--sweep]');
  process.exit(2);
}

const TERRAIN_ASPECT = 5.5 / 4.8;
const tableD = opt.circle ? opt.tableW : (opt.square ? opt.tableW : opt.tableW * TERRAIN_ASPECT);
const hw = opt.tableW / 2, hd = tableD / 2;
const R = opt.tableW / 2;                    // 圆形半径（circle 时用）

const vFovOf = (hFov, aspect) => 2 * Math.atan(Math.tan(hFov * D2R / 2) / aspect) * R2D;
const vFov = vFovOf(opt.hFov, opt.aspect);

/* ---------- 待判定的沙盘边缘点 ----------
   矩形：最不利点必在四个角上，取四角即可。
   圆形：没有角，最不利点在【近端（相机正下方）】与【左右两侧】，
         沿圆周等间隔采样（72 点 = 每 5° 一个，足够密）。 */
function edgePoints() {
  if (opt.circle) {
    const N = 72, pts = [];
    for (let i = 0; i < N; i++) {
      const th = (i / N) * Math.PI * 2;
      pts.push([R * Math.sin(th), R * Math.cos(th)]);   // [x, z]
    }
    return pts;
  }
  const out = [];
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) out.push([sx * hw, sz * hd]);
  return out;
}

/* ---------- 张角 / 半视场 ----------
   ⚠️ 必须与页面 cornerFractions 【完全一致】：任一边缘点落在相机后方，
      页面是立即 `return { hFrac: Infinity, vFrac: Infinity }`。
      不一致会得出相反结论（本脚本第一版就踩过：脚本报「出画 3.73 倍」，
      页面报 degenerate，因为我把该点跳过、继续算了其余三点）。 */
function framing(h, d) {
  const L = Math.hypot(h, d);
  if (L < 1e-9) return null;
  const fy = -h / L, fz = -d / L;
  const uy = d / L, uz = -h / L;
  const tanH = Math.tan(opt.hFov * D2R / 2), tanV = Math.tan(vFov * D2R / 2);
  let hFrac = 0, vFrac = 0, aHmax = 0, aVmax = 0, behind = 0;
  for (const [px, pz] of edgePoints()) {
    const dx = px, dy = -h, dz = pz - d;
    const depth = dy * fy + dz * fz;
    if (depth <= 0.05) { behind++; continue; }
    const aH = Math.atan2(Math.abs(dx), depth) * R2D;
    const aV = Math.atan2(Math.abs(dy * uy + dz * uz), depth) * R2D;
    hFrac = Math.max(hFrac, Math.tan(aH * D2R) / tanH);
    vFrac = Math.max(vFrac, Math.tan(aV * D2R) / tanV);
    aHmax = Math.max(aHmax, aH); aVmax = Math.max(aVmax, aV);
  }
  if (behind > 0) return { hFrac: Infinity, vFrac: Infinity, aHmax, aVmax, behind };
  return { hFrac, vFrac, aHmax, aVmax, behind: 0 };
}

/* 画面上下边缘落在地面的 z 坐标（相机在 z = d，朝 -z 看） */
function visibleZ(h, d) {
  const axis = Math.atan2(h, d) * R2D;
  const up = axis - vFov / 2, dn = axis + vFov / 2;
  const zOf = (th) => th <= 0 ? -Infinity : th >= 90 ? d : d - h / Math.tan(th * D2R);
  return { axis, up, dn, zFar: zOf(up), zNear: zOf(dn) };
}

const fmt = (v, n = 3) => Number.isFinite(v) ? v.toFixed(n) : '∞';
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/* 在给定的 z 处，画面水平能覆盖到多宽（判断「左右够不够」） */
function halfWidthAt(h, d, z) {
  const L = Math.hypot(h, d);
  const depth = (h * h + d * (d - z)) / L;
  return depth * Math.tan(opt.hFov * D2R / 2);
}

function shapeName() {
  if (opt.circle) return `圆形，直径 ${opt.tableW.toFixed(2)} m`;
  if (opt.square) return `正方形 ${opt.tableW.toFixed(2)} × ${tableD.toFixed(2)} m`;
  return `矩形 ${opt.tableW.toFixed(2)} × ${tableD.toFixed(2)} m（按湖南地形比例 ${TERRAIN_ASPECT.toFixed(4)}）`;
}

/* ---------- 单个组合的完整报告 ---------- */
function report(h, d) {
  console.log('=== 现场取景核算 ===');
  console.log(`沙盘   ${shapeName()}`);
  console.log(`相机   高 ${h.toFixed(2)} m（相对沙盘面） · 距中心 ${d.toFixed(2)} m` +
    `  → 俯角 ${(Math.atan2(h, d) * R2D).toFixed(2)}°`);
  console.log(`视场   水平 ${opt.hFov}° · 垂直 ${vFov.toFixed(2)}° · 宽高比 ${opt.aspect}`);
  console.log(`相机水平投影在沙盘内？ ${d < hd ? '是' : '否'}  [|dist| = ${d.toFixed(2)} vs 半深 ${hd.toFixed(2)}]`);
  console.log('');

  const c = framing(h, d);
  if (!c) { console.error('相机与中心重合，无法计算'); process.exit(2); }
  console.log('--- 边缘是否入画（比值 > 1 表示超出画面）---');
  console.log(`  水平 ${fmt(c.hFrac)}   最大半张角 ${c.aHmax.toFixed(2)}° vs 半视场 ${(opt.hFov / 2).toFixed(2)}°`);
  console.log(`  垂直 ${fmt(c.vFrac)}   最大半张角 ${c.aVmax.toFixed(2)}° vs 半视场 ${(vFov / 2).toFixed(2)}°`);
  const worst = Math.max(c.hFrac, c.vFrac);
  if (!Number.isFinite(worst)) {
    console.log(`  → ⛔ ${c.behind} 个边缘点落在相机【后方】（相机水平投影已进到沙盘内）`);
    console.log('     页面 framingInfo 把这种情况单独报为 degenerate。');
  } else {
    console.log(`  → ${worst <= 1 ? '✅ 边缘全部入画' : `❌ 出画 ${worst.toFixed(2)} 倍（${c.hFrac >= c.vFrac ? '左右' : '上下'}方向）`}`);
  }
  console.log('');

  const vz = visibleZ(h, d);
  console.log('--- 画面上下边缘覆盖的沙盘深度（z 轴，中心 = 0）---');
  console.log(`  远端边缘 z = ${(-hd).toFixed(2)}  →  画面能看到的远端 z = ${fmt(vz.zFar, 2)}`);
  console.log(`  近端边缘 z = ${(+hd).toFixed(2)}  →  画面能看到的近端 z = ${fmt(vz.zNear, 2)}`);
  const lostNear = clamp(hd - vz.zNear, 0, tableD);
  const lostFar = clamp(vz.zFar + hd, 0, tableD);
  console.log(`  看不到：近端 ${lostNear.toFixed(2)} m` +
    (lostFar > 0.005 ? ` + 远端 ${lostFar.toFixed(2)} m` : '（远端完整可见）') +
    `  ≈ 总深的 ${(((lostNear + lostFar) / tableD) * 100).toFixed(1)}%`);

  const hwc = halfWidthAt(h, d, 0);
  console.log(`  中心处水平可见半宽 ${hwc.toFixed(2)} m vs 沙盘半宽 ${hw.toFixed(2)} m` +
    `  → ${hwc >= hw ? '左右完整' : `左右各缺 ${(hw - hwc).toFixed(2)} m`}`);
  console.log('');
  return { worst, lostNear, lostFar, hwc };
}

/* ---------- 主流程 ---------- */
if (opt.sweep) {
  console.log('=== 扫描：圆形沙盘 直径 ' + opt.tableW.toFixed(2) + ' m ===');
  console.log('   相机在圆周上（dist = 半径）时，不同「相对沙盘面高度」的取景：\n');
  console.log('   height  俯角    垂直比值  水平比值  近端看不到      中心可见半宽');
  for (const h of [0.30, 0.40, 0.50, 0.55, 0.60, 0.70, 0.80, 0.90, 1.00, 1.10, 1.30]) {
    const d = R;
    const c = framing(h, d);
    const vz = visibleZ(h, d);
    const lost = clamp(hd - vz.zNear, 0, tableD);
    const hwc = halfWidthAt(h, d, 0);
    console.log(`   ${h.toFixed(2)} m  ${(Math.atan2(h, d) * R2D).toFixed(1)}°   ` +
      `${Number.isFinite(c.vFrac) ? c.vFrac.toFixed(2) : '⛔'}      ` +
      `${Number.isFinite(c.hFrac) ? c.hFrac.toFixed(2) : '⛔'}      ` +
      `${lost.toFixed(2)} m (${((lost / tableD) * 100).toFixed(0)}%)   ${hwc.toFixed(2)} m`);
  }
  console.log('\n  注：⛔ = 近端边缘点落在相机后方（相机水平投影在沙盘内）。');
  console.log('      「中心可见半宽」< 1.40 m 表示画面左右两侧看不全。');
  process.exit(0);
}

const res = report(opt.height, opt.dist);

if (opt.solve) {
  const pitch = Math.atan2(opt.height, opt.dist);
  let found = null;
  for (let d = hd + 0.05; d <= 40; d += 0.01) {
    const h = d * Math.tan(pitch);
    const cc = framing(h, d);
    if (cc && cc.behind === 0 && cc.hFrac <= 0.96 && cc.vFrac <= 0.96) { found = { d, h }; break; }
  }
  console.log(`--- 反算：保持俯角 ${(pitch * R2D).toFixed(2)}°，边缘全部入画（留 4% 余量）所需 ---`);
  if (found) {
    console.log(`  camDist   ≥ ${found.d.toFixed(2)} m`);
    console.log(`  camHeight = ${found.h.toFixed(2)} m（相对沙盘面）`);
    console.log(`  （当前 ${opt.dist.toFixed(2)} / ${opt.height.toFixed(2)} —— 距离还差 ${(found.d - opt.dist).toFixed(2)} m）`);
  } else {
    console.log('  在 40 m 内无解（视场太窄，边缘无论如何都进不来）');
  }
}
