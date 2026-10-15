#!/usr/bin/env node
/**
 * 万向支架俯角核算：给定固定相机位置，求最优俯角。
 *
 * 背景：平板通过万向支架固定，位置不动（高 0.56m，距中心 2.00m），
 * 但俯角可以机械调节。本脚本回答：调到什么俯角能让圆形沙盘全部入画。
 */
const D2R = Math.PI / 180, R2D = 180 / Math.PI;

const opt = {
  camHeight: 0.56,   // 相对沙盘面高度
  camDist: 2.00,     // 距沙盘中心水平距离
  tableW: 2.80,      // 沙盘直径
  hFov: 65,          // 水平视场角
  aspect: 1.6,       // 屏幕宽高比
};

const R = opt.tableW / 2;
const hFov2 = opt.hFov * D2R / 2;
const vFov2 = Math.atan(Math.tan(hFov2) / opt.aspect);

/* 给定俯角 θ（度，向下为正），计算圆形沙盘边缘最不利的张角比值 */
function framingAtPitch(thetaDeg) {
  const theta = thetaDeg * D2R;
  const sinT = Math.sin(theta), cosT = Math.cos(theta);
  // 光轴 f = (0, -sinθ, -cosθ)，up = (0, cosθ, -sinθ)
  // 沙盘边缘参数化：(R·cosφ, 0, R·sinφ)
  let maxH = 0, maxV = 0, minDepth = Infinity;
  const N = 360;
  for (let i = 0; i < N; i++) {
    const phi = (i / N) * Math.PI * 2;
    const px = R * Math.cos(phi);
    const pz = R * Math.sin(phi);
    const dx = px;              // 边缘点 x - 相机 x（相机 x = 0）
    const dy = -opt.camHeight;  // 边缘点 y - 相机 y（边缘 y = 0，相机 y = h）
    const dz = pz - opt.camDist;// 边缘点 z - 相机 z
    // depth = (P - eye)·(-f) = -(dx·0 + dy·(-sinT) + dz·(-cosT))
    //       = dy·sinT + dz·cosT   （注意 dy = -h，dz = pz - d）
    const depth = dy * (-sinT) + dz * (-cosT);
    // 等一下，向量 (dx, dy, dz) 点乘光轴 (0, -sinT, -cosT)
    const depth2 = dx * 0 + dy * (-sinT) + dz * (-cosT);
    // 这等于 (-h)·(-sinT) + (pz - d)·(-cosT) = h·sinT + (d - pz)·cosT
    if (depth2 < 0.001) return { hFrac: Infinity, vFrac: Infinity, thetaDeg, behind: true };
    // 水平 = |dx|（X 轴与光轴垂直）
    const angH = Math.atan2(Math.abs(dx), depth2);
    // 垂直 = (P - eye)·up = dx·0 + dy·cosT + dz·(-sinT)
    const vert = dy * cosT + dz * (-sinT);
    const angV = Math.atan2(Math.abs(vert), depth2);
    maxH = Math.max(maxH, angH / hFov2);
    maxV = Math.max(maxV, angV / vFov2);
    minDepth = Math.min(minDepth, depth2);
  }
  return { hFrac: maxH, vFrac: maxV, worst: Math.max(maxH, maxV), thetaDeg, minDepth };
}

/* 扫描俯角范围 */
console.log('=== 万向支架俯角扫描 ===');
console.log(`相机位置：高 ${opt.camHeight} m · 距中心 ${opt.camDist} m`);
console.log(`沙盘：圆形，直径 ${opt.tableW} m`);
console.log(`视场：水平 ${opt.hFov}° · 垂直 ${(vFov2 * 2 * R2D).toFixed(1)}°\n`);
console.log('  俯角    水平比   垂直比   最坏比   结果');
let best = null;
for (let t = 5; t <= 60; t += 1) {
  const f = framingAtPitch(t);
  const ok = f.worst <= 1;
  const mark = ok ? '✅ 入画' : (f.worst <= 1.15 ? '⚠️ 微出' : '❌ 出画');
  console.log(`  ${t.toString().padStart(2)}°    ${f.hFrac.toFixed(3)}    ${f.vFrac.toFixed(3)}    ${f.worst.toFixed(3)}   ${mark}`);
  if (ok && (!best || f.worst < best.worst)) best = f;
}

console.log('');
if (best) {
  console.log(`最优俯角：${best.thetaDeg}°（裕量 ${((1 - best.worst) * 100).toFixed(1)}%）`);
} else {
  console.log('警告：5°~60° 范围内没有完全入画的俯角——这个位置/高度下，物理上装不下整个沙盘。');
}

/* 二分找精确最优 */
function findBest() {
  let lo = 5, hi = 60, bestT = null, bestW = Infinity;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    const f = framingAtPitch(mid);
    if (f.worst < bestW) { bestW = f.worst; bestT = mid; }
    // 如果 worse 在增大，调整搜索方向
    const fL = framingAtPitch(mid - 0.1);
    const fR = framingAtPitch(mid + 0.1);
    if (fL.worst < fR.worst) hi = mid; else lo = mid;
  }
  return { theta: bestT, worst: bestW, f: framingAtPitch(bestT) };
}

const precise = findBest();
console.log(`\n精确最优：俯角 ${precise.theta.toFixed(2)}°`);
console.log(`  水平比 ${precise.f.hFrac.toFixed(4)} · 垂直比 ${precise.f.vFrac.toFixed(4)} · 最坏比 ${precise.f.worst.toFixed(4)}`);
if (precise.f.worst > 1) {
  const needDist = opt.camDist * precise.f.worst;
  console.log(`  当前位置无法完全入画。若要入画，需退到距中心 ${needDist.toFixed(2)} m 或抬高到 ${(opt.camHeight * precise.f.worst).toFixed(2)} m`);
}
