/**
 * AR 锚定 + 视野裁剪回归测试 —— 零依赖，直连 Chrome CDP。
 *
 * 被测的三条约束（对应需求原文）：
 *   ① 锚定    AR 标点必须【相对沙盘绝对静止】—— 空间位置与沙盘实体绑定。
 *             验证方式：把相机转到 5 个方位 × 3 个俯角，要求每个锚点的
 *             世界坐标逐分量不变（容差 1e-9）。相机不许写锚点坐标。
 *   ② 映射    相机视野 ↔ 沙盘区域要有确定的映射关系。
 *             验证方式：读回「视野落点多边形」，要求
 *               · 看向沙盘中心时覆盖率 > 60%、顶点数 >= 3
 *               · 所有顶点都裁在沙盘圆周内（半径 <= 1.41）
 *               · 背对沙盘时覆盖率 = 0、多边形为空
 *   ③ 裁剪    相机照到哪一块，就只显示那一块的标注。
 *             验证方式（需求里举的例子）：
 *               · 转向左 → 最左标点可见、最右标点不可见
 *               · 转向右 → 最右标点可见、最左标点不可见
 *               · 可见集合的平均 x 随转向单调变化
 *               · rendered = (裁剪判定) && !被遮挡 —— 逐项一致
 *               · 关掉裁剪开关 → 全部渲染（对比组）
 *
 * 用法：node tools/ar-anchor-test.mjs <URL>
 *
 * ⚠️ 必须禁缓存：profile 里残留的旧副本会让 Chrome 直接吃缓存，
 *    现象是「页面明明改好了，测试却读到上一版参数」且【没有任何报错】。
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME_PATH
  || String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`;
const TARGET = process.argv[2];
const PORT = 9347;

if (!TARGET) { console.log('用法: node tools/ar-anchor-test.mjs <URL>'); process.exit(1); }

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
/* headless 没有真陀螺仪：喂一个合成姿态让「对齐」完成，
   否则渲染循环会停在「对齐前只清屏」那条早退分支上，裁剪根本不会跑。 */
await evaluate(`(() => { const e = new Event('deviceorientation');
  e.alpha = 0; e.beta = 55; e.gamma = 25; dispatchEvent(e); return 'ok'; })()`);
await sleep(800);

const checks = [];
const chk = (name, pass, detail) => checks.push({ name, pass, detail });

const readAnchors = () => evalJson('window.__gyro.arAnchors');
const readCoverage = () => evalJson('window.__gyro.arCoverage');
const readVisibleN = () => evalJson('window.__gyro.arVisibleCount');
const readPolygon = () => evalJson('window.__gyro.arRegionPolygon');

/* 把相机转到指定方位，等几帧让裁剪稳定（60fps 下 250ms ≈ 15 帧） */
async function aim(yaw, pitch = null) {
  await evaluate(`window.__gyro.aimAt(${yaw}${pitch === null ? '' : ', ' + pitch})`);
  await sleep(260);
  return readAnchors();
}

console.log('=== AR 锚定 / 视野裁剪测试 ===\n');

/* ---------- 前置：页面与锚点就绪 ---------- */
const a0 = await readAnchors();
if (!Array.isArray(a0) || !a0.length) {
  console.log('锚点未建立，无法继续。页面错误：', pageErrors);
  ws.close(); proc.kill(); process.exit(1);
}
console.log(`锚点数 ${a0.length}，页面错误：${pageErrors.length ? pageErrors.join(' | ') : '（无）'}\n`);
chk('页面无未捕获错误', pageErrors.length === 0,
  pageErrors.length ? pageErrors[0].slice(0, 80) : '无');

/* ---------- ① 锚定：位置只由 (lon,lat) 决定，与相机无关 ---------- */
const base = (await aim(0)).map(a => ({ id: a.id, x: a.pos.x, y: a.pos.y, z: a.pos.z }));
const poses = [[0, 15], [30, 25], [-30, 25], [60, 40], [-60, 40], [90, 20], [180, 20], [0, 60]];
let maxDrift = 0, driftAt = '';
for (const [y, p] of poses) {
  const cur = await aim(y, p);
  for (let i = 0; i < cur.length; i++) {
    const d = Math.max(
      Math.abs(cur[i].pos.x - base[i].x),
      Math.abs(cur[i].pos.y - base[i].y),
      Math.abs(cur[i].pos.z - base[i].z));
    if (d > maxDrift) { maxDrift = d; driftAt = `${cur[i].id} @ yaw=${y} pitch=${p}`; }
  }
}
chk('锚定不变：转 8 组方位后锚点世界坐标不动', maxDrift < 1e-9,
  `最大漂移 ${maxDrift.toExponential(2)} m（${driftAt || '—'}）`);

/* 锚点必须落在沙盘圆周内 —— 否则「与沙盘实体绑定」无从谈起 */
const R = (await evalJson('window.__gyro.params')).tableW / 2;
const outside = (await aim(0)).filter(a => Math.hypot(a.pos.x, a.pos.z) > R + 1e-6);
chk('所有锚点落在沙盘圆周内', outside.length === 0,
  outside.length ? `${outside.map(a => a.id).join(',')} 超出半径 ${R}` : `${a0.length} 个锚点全部在半径 ${R} m 内`);

/* ---------- ② 映射：视野落点区域 ---------- */
await aim(0);
const covCenter = await readCoverage();
const polyCenter = await readPolygon();
chk('看向沙盘中心时视野覆盖 > 60%', covCenter > 0.60,
  `覆盖 ${(covCenter * 100).toFixed(1)}%`);
chk('视野多边形有效（>= 3 顶点）', Array.isArray(polyCenter) && polyCenter.length >= 3,
  `${Array.isArray(polyCenter) ? polyCenter.length : 0} 个顶点`);
const polyOut = Array.isArray(polyCenter)
  ? polyCenter.filter(p => Math.hypot(p.x, p.z) > R + 0.01) : [];
chk('视野多边形已裁在沙盘圆周内', polyOut.length === 0,
  polyOut.length ? `${polyOut.length} 个顶点越界` : '全部顶点半径 <= ' + (R + 0.01) + ' m');

await aim(180);
const covAway = await readCoverage();
const polyAway = await readPolygon();
chk('背对沙盘时覆盖率归零', covAway === 0,
  `覆盖 ${(covAway * 100).toFixed(1)}%，多边形 ${Array.isArray(polyAway) ? polyAway.length : 0} 顶点`);

/* ---------- ③ 裁剪：需求里举的「最左 / 最右」例子 ---------- */
const sorted = (await aim(0)).slice().sort((p, q) => p.pos.x - q.pos.x);
const leftmost = sorted[0], rightmost = sorted[sorted.length - 1];

const leftTurn = await aim(45);    // 向左转
const rightTurn = await aim(-45);  // 向右转
const byId = (arr, id) => arr.find(a => a.id === id);

chk('转向左：最左标点可见', byId(leftTurn, leftmost.id).visible === true,
  `${leftmost.name}（x=${leftmost.pos.x.toFixed(3)}）visible=${byId(leftTurn, leftmost.id).visible}`);
chk('转向左：最右标点隐藏', byId(leftTurn, rightmost.id).visible === false,
  `${rightmost.name}（x=${rightmost.pos.x.toFixed(3)}）visible=${byId(leftTurn, rightmost.id).visible}`);
chk('转向右：最右标点可见', byId(rightTurn, rightmost.id).visible === true,
  `${rightmost.name} visible=${byId(rightTurn, rightmost.id).visible}`);
chk('转向右：最左标点隐藏', byId(rightTurn, leftmost.id).visible === false,
  `${leftmost.name} visible=${byId(rightTurn, leftmost.id).visible}`);

const meanX = (arr) => {
  const v = arr.filter(a => a.visible);
  return v.length ? v.reduce((s, a) => s + a.pos.x, 0) / v.length : NaN;
};
const mL = meanX(leftTurn), mR = meanX(rightTurn);
chk('可见集合随转向偏移：左转均值 x < 右转均值 x', mL < mR,
  `左转 ${mL.toFixed(3)} < 右转 ${mR.toFixed(3)}`);

/* 单调性：从右往左扫，可见集合应整体左移，且中段不应出现「全灭」 */
const sweep = [];
for (const y of [-50, -30, -15, 0, 15, 30, 50]) {
  const arr = await aim(y);
  sweep.push({ y, n: arr.filter(a => a.visible).length, mx: meanX(arr) });
}
const midAlive = sweep.filter(s => Math.abs(s.y) <= 30).every(s => s.n > 0);
chk('扫掠中段不出现「全灭」（裁剪不是整块开关）', midAlive,
  sweep.map(s => `yaw${s.y}:${s.n}个`).join(' '));
let monoOk = true;
for (let i = 1; i < sweep.length; i++) if (!(sweep[i].mx < sweep[i - 1].mx + 1e-9)) monoOk = false;
chk('可见集合均值 x 随 yaw 单调左移', monoOk,
  sweep.map(s => s.mx.toFixed(2)).join(' → '));

/* 背对沙盘：一个都不显示 */
const away = await aim(180);
chk('背对沙盘时零标注显示', away.every(a => !a.visible) && away.every(a => !a.rendered),
  `${away.filter(a => a.visible).length} 个可见`);

/* ---------- 判定与渲染必须一致（防「别处覆写 .visible」）----------

   ⚠️ 这条不变式【扩展过一次】，不要再退回成「visible === rendered」：
      遮挡剔除（P0-② 的修法）是一个【合法】的额外隐藏机制 ——
      锚点被山挡住时 visible = true（它确实在画面内）但 rendered = false（不该画）。
      旧的等式会把这种正确行为报成「有别的代码在覆写 .visible」。

   现在的不变式（terrainOn 恒为 true）：
       rendered === (arCull ? visible : true) && !occluded
   也就是说 rendered = false 必须能由「出画」或「被遮挡」之一解释完；
   出现第三种原因才是「别处覆写 .visible」的真信号。 */
const inconsistent = [];
const unexplained = [];
for (const y of [0, 30, -30, 45, -45, 90]) {
  const arr = await aim(y);
  const cull = await evalJson('window.__gyro.arCullEnabled');
  for (const a of arr) {
    const expect = (cull ? a.visible : true) && !a.occluded;
    if (expect !== a.rendered) inconsistent.push(`${a.id}@${y}(期望${expect}实际${a.rendered})`);
    if (!a.rendered && a.visible && !a.occluded) unexplained.push(`${a.id}@${y}`);
  }
}
chk('rendered = (裁剪判定) && !被遮挡 —— 逐项一致', inconsistent.length === 0,
  inconsistent.length ? inconsistent.join(', ') : '66 项全部一致');
chk('rendered=false 必须由「出画」或「被遮挡」解释（无第三种原因）', unexplained.length === 0,
  unexplained.length ? '无法解释：' + unexplained.join(', ') : '');

/* ---------- 裁剪开关（对比组）---------- */
await evaluate(`window.__gyro.setArCull(false)`);
const cullOff = await aim(45);
chk('关闭裁剪后全部标注渲染（对比组）', cullOff.every(a => a.rendered),
  `可见 ${cullOff.filter(a => a.rendered).length}/${cullOff.length}`);
await evaluate(`window.__gyro.setArCull(true)`);
const cullOn = await aim(45);
chk('重新开启裁剪后恢复按视野显隐', cullOn.filter(a => a.rendered).length < cullOn.length,
  `可见 ${cullOn.filter(a => a.rendered).length}/${cullOn.length}`);

/* ---------- 判定汇总 ---------- */
console.log('=== 判定 ===');
let failed = 0;
for (const c of checks) {
  console.log((c.pass ? '  [PASS] ' : '  [FAIL] ') + c.name + '   (' + c.detail + ')');
  if (!c.pass) failed++;
}
console.log(failed === 0
  ? '\n全部通过 ✅ —— 标注锚定在沙盘上，且只显示相机照到的那一部分'
  : `\n${failed} 项未通过 ❌`);

ws.close(); proc.kill();
process.exit(failed === 0 ? 0 : 1);
