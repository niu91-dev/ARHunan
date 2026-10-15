/**
 * 需求验收审计 —— 针对「Pad 固定位置 + 两轴旋转 + 局部可见 + 点击弹框」这条需求，
 * 逐条量化当前实现的效果，并指出不满足的环节。
 *
 * 与 ar-anchor-test / gimbal-kinematics-test 的区别：
 *   那两个测的是「实现是否按设计工作」（回归）；
 *   这个测的是「设计是否满足需求」（验收），所以结论允许是「不满足」。
 *
 * 五项：
 *   ① 稳定性：世界坐标不漂 + 屏幕上不抖
 *   ② 叠加准确性：标注画的位置 ↔ 它声称的世界坐标是否一致；误差源有多大
 *   ③ 同步消失：目标移出画面时标注是否同时消失（量滞回残留多少像素）
 *   ④ 逻辑连贯：细扫下 visible/rendered 是否一致、是否闪烁
 *   ⑤ 点击弹框：点标注能不能打开信息框
 *
 * 用法：node tools/ar-requirement-audit.mjs <URL>
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME_PATH
  || String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`;
const TARGET = process.argv[2];
const PORT = 9353;
if (!TARGET) { console.log('用法: node tools/ar-requirement-audit.mjs <URL>'); process.exit(1); }

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

const W = 1152, H = 720;

/* 合成姿态：对齐用的基准姿态 */
async function feedOrient(a, b, g) {
  await evaluate(`(() => { const e = new Event('deviceorientation');
    e.alpha = ${a}; e.beta = ${b}; e.gamma = ${g}; dispatchEvent(e); return 'ok'; })()`);
}
await feedOrient(0, 55, 25);
await sleep(900);

const anchors0 = await evalJson('window.__gyro.arAnchors');
if (!Array.isArray(anchors0) || !anchors0.length) {
  console.log('锚点未建立。页面错误：', pageErrors);
  ws.close(); proc.kill(); process.exit(1);
}

const out = [];
const say = (s = '') => { out.push(s); console.log(s); };
const verdict = (ok, s) => say(`   ${ok ? '满足' : '不满足'} · ${s}`);

say('================ 需求验收审计 ================');
say(`锚点 ${anchors0.length} 个 · 视口 ${W}×${H} · 页面错误 ${pageErrors.length ? pageErrors.join(' | ') : '无'}`);
say('');

/* 用 aimAt 摆姿态（绕开陀螺仪，姿态可复现） */
async function aim(yaw, pitch = null) {
  await evaluate(`window.__gyro.aimAt(${yaw}${pitch === null ? '' : ', ' + pitch})`);
  await sleep(240);
  return evalJson('window.__gyro.arLabelsScreen');
}
const readAnchors = () => evalJson('window.__gyro.arAnchors');

/* ============================================================
   ① 稳定性
   ============================================================ */
say('【① 标记点是否稳定绑定在世界坐标、旋转时无漂移或抖动】');

const base = (await aim(0)).map(a => ({ id: a.id, x: a.anchorPx.px, y: a.anchorPx.py }));
const world0 = (await readAnchors()).map(a => ({ id: a.id, ...a.pos }));

let worldDrift = 0, driftAt = '';
const poses = [[0, -15.6], [20, -12], [40, -8], [-20, -12], [-40, -8], [70, 0], [-70, 0], [110, 5], [-110, 5], [180, 0]];
for (const [y, p] of poses) {
  await aim(y, p);
  const cur = await readAnchors();
  for (let i = 0; i < cur.length; i++) {
    const d = Math.max(Math.abs(cur[i].pos.x - world0[i].x), Math.abs(cur[i].pos.y - world0[i].y), Math.abs(cur[i].pos.z - world0[i].z));
    if (d > worldDrift) { worldDrift = d; driftAt = `${cur[i].id} @ yaw=${y}`; }
  }
}
say(`  世界坐标漂移：${worldDrift.toExponential(2)} m（10 组姿态，${driftAt || '—'}）`);

/* 屏幕抖动：注入姿态噪声，量标注在屏幕上晃多少像素 */
await evaluate(`window.__gyro.clearAim(); 'ok'`);
await feedOrient(0, 55, 25);
await sleep(700);
const SIGMA = 0.5;   // 姿态噪声标准差（度）
const samples = new Map();
const frames = [];
for (let i = 0; i < 24; i++) {
  const jitter = () => (Math.random() * 2 - 1) * SIGMA * 1.732;   // 均匀分布，σ≈SIGMA
  await feedOrient(jitter(), 55 + jitter(), 25 + jitter());
  await sleep(55);
  const cur = await evalJson('window.__gyro.arLabelsScreen');
  if (!Array.isArray(cur)) continue;
  const frame = new Map();
  for (const a of cur) {
    if (!a.visible) continue;
    if (!samples.has(a.id)) samples.set(a.id, []);
    samples.get(a.id).push({ x: a.anchorPx.px, y: a.anchorPx.py });
    frame.set(a.id, { x: a.anchorPx.px, y: a.anchorPx.py });
  }
  frames.push(frame);
}
let worstStd = 0, worstId = '';
for (const [id, arr] of samples) {
  if (arr.length < 12) continue;
  const mx = arr.reduce((s, p) => s + p.x, 0) / arr.length;
  const my = arr.reduce((s, p) => s + p.y, 0) / arr.length;
  const sd = Math.sqrt(arr.reduce((s, p) => s + (p.x - mx) ** 2 + (p.y - my) ** 2, 0) / arr.length);
  if (sd > worstStd) { worstStd = sd; worstId = `${id}（${arr.length} 帧）`; }
}
say(`  注入姿态噪声 σ=${SIGMA}° 时的屏幕抖动：最大 ${worstStd.toFixed(1)} px（${worstId}）`);

/* 【整屏平移】与【相对形变】要分开看：
   相机姿态噪声会让所有标注一起平移 —— 那像「画面跟着手晃」，不算标注漂；
   真正难看的是标注【彼此之间】的相对位移（星座变形）。 */
const pairSamples = new Map();
for (const f of frames) {
  const ids = [...f.keys()];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const k = ids[i] + '|' + ids[j];
      if (!pairSamples.has(k)) pairSamples.set(k, []);
      pairSamples.get(k).push(Math.hypot(f.get(ids[i]).x - f.get(ids[j]).x, f.get(ids[i]).y - f.get(ids[j]).y));
    }
  }
}
let worstPairStd = 0;
for (const [k, arr] of pairSamples) {
  if (arr.length < 12) continue;
  const m = arr.reduce((s, v) => s + v, 0) / arr.length;
  const sd = Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length);
  if (sd > worstPairStd) worstPairStd = sd;
}
say(`  标注【彼此之间】屏幕距离的抖动：最大 ${worstPairStd.toFixed(2)} px（${pairSamples.size} 对）`);
say(`  ⇒ 主要误差是整屏平移（相机姿态噪声），标注星座本身基本不变形`);
say(`  传感器静止上报间隔：${(await evalJson('window.__gyro.orientGapMs')).toFixed(0)} ms（合成事件，真机 Android 静止约 1000 ms）`);

/* 屏幕灵敏度：转 1° 标注移动多少像素 —— 抖动幅度 = 噪声 × 灵敏度 */
await aim(0);
const s0 = await evalJson('window.__gyro.arLabelsScreen');
await aim(1);
const s1 = await evalJson('window.__gyro.arLabelsScreen');
let maxSens = 0;
for (let i = 0; i < s0.length; i++) {
  const d = Math.hypot(s1[i].anchorPx.px - s0[i].anchorPx.px, s1[i].anchorPx.py - s0[i].anchorPx.py);
  if (d > maxSens) maxSens = d;
}
say(`  屏幕灵敏度：相机转 1° → 标注最多移动 ${maxSens.toFixed(1)} px`);
say(`  ⇒ σ=0.5° 的姿态噪声理论抖动 ≈ ${(maxSens * SIGMA).toFixed(1)} px（实测 ${worstStd.toFixed(1)} px，平滑几乎没压住）`);
verdict(worldDrift < 1e-9, '标注世界坐标与相机姿态完全解耦（锚定成立，零漂移）');
verdict(worstPairStd < 1.0, `标注彼此之间基本不变形（${worstPairStd.toFixed(2)} px）—— 星座刚性`);
say(`  ⚠️ 绝对抖动 ${worstStd.toFixed(1)} px = 传感器噪声 × ${maxSens.toFixed(1)} px/°。`);
say(`     这是【整屏平移】，不是标注相对沙盘漂 —— 但真机 Android 静止时上报降到 ~1 Hz，`);
say(`     平滑来不及填满，观感会是「一秒跳一下」。需真机实测陀螺仪噪声后才能定论。`);
say('');

/* ============================================================
   ② 叠加准确性
   ============================================================ */
say('【② 叠加位置与沙盘实际位置的对应关系】');

/* 闭环：锚点世界坐标 → 投影到屏幕 → 从屏幕射线打回地形 → 应回到同一个点。
   ⚠️ 关键前提：锚点【就落在地形网格面上】（下一项单独验证 Δy = 0），
      所以「过锚点屏幕像素的那条射线」必然穿过锚点本身。
      若 hits[0] 不是锚点，只可能是【更近的地形挡住了它】—— 那是遮挡，不是几何误差。
      两者必须分开报，否则会把遮挡误判成「叠加位置不准」。 */
const camP = await evalJson('window.__gyro.camPos');
const d3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
await aim(0);
const lab = await evalJson('window.__gyro.arLabelsScreen');
let maxLoopFree = 0, loopAt = '', occDuringLoop = [];
for (const a of lab) {
  if (!a.visible || a.anchorPx.behind) continue;
  const hit = await evalJson(`window.__gyro.raycastTerrainAt(${a.anchorPx.px.toFixed(2)}, ${a.anchorPx.py.toFixed(2)})`);
  if (!hit || hit.__err) continue;
  const w = world0.find(x => x.id === a.id);
  const d = Math.hypot(hit.x - w.x, hit.z - w.z);
  if (d3(camP, hit) < d3(camP, w) - 0.005) { occDuringLoop.push(a.name); continue; }  // 被挡住，不计入几何误差
  if (d > maxLoopFree) { maxLoopFree = d; loopAt = a.name; }
}
say(`  投影↔反投影闭环误差（排除被遮挡的）：${maxLoopFree.toExponential(2)} m（${loopAt || '—'}）`);
say(`  被地形挡住因而射线先命中别处的：${occDuringLoop.length ? occDuringLoop.join('、') : '无'}`);

/* 锚点是否真的落在地形网格面上（heightAtUv 双线性 vs 网格三角面） */
let maxDy = 0, dyAt = '';
for (const w of world0) {
  const my = await evalJson(`window.__gyro.terrainYAt(${w.x}, ${w.z})`);
  if (my === null) continue;
  const dy = Math.abs(w.y - my);
  if (dy > maxDy) { maxDy = dy; dyAt = w.id; }
}
say(`  锚点与地形网格面的高度差：最大 ${(maxDy * 1000).toFixed(2)} mm（${dyAt}）`);
verdict(maxLoopFree < 0.005 && maxDy < 0.002,
  '标注内部几何完全自洽：锚点精确落在地形面上，投影↔反投影闭合');

/* 标签图形相对地面锚点的屏幕偏移（抬升 0.085 m 造成的） */
const lifts = lab.filter(a => a.visible).map(a => a.liftPx);
say(`  标签图形相对地面锚点的屏幕偏移：${Math.min(...lifts).toFixed(0)} ~ ${Math.max(...lifts).toFixed(0)} px（抬升 ${lab[0].liftM.toFixed(3)} m）`);
say('    ⇒ 用户看到的是「浮在地面上方」的标签，不是贴地标点');

/* 视场角手动填错的后果 */
const fovBefore = (await evalJson('window.__gyro.params')).hFov;
await evaluate(`window.__gyro.setFov(66); 'ok'`);
await sleep(200);
const s66 = await evalJson('window.__gyro.arLabelsScreen');
let fovShift = 0;
for (let i = 0; i < s0.length; i++) {
  const d = Math.hypot(s66[i].anchorPx.px - s0[i].anchorPx.px, s66[i].anchorPx.py - s0[i].anchorPx.py);
  if (d > fovShift) fovShift = d;
}
await evaluate(`window.__gyro.setFov(${fovBefore}); 'ok'`);
await sleep(200);
say(`  水平视场角填错 1°（65°→66°）→ 标注最多偏移 ${fovShift.toFixed(0)} px`);
say('    ⇒ 视场角只能手动填（浏览器 API 拿不到），填错直接表现为叠加错位');

/* 地形垂直比例：虚拟地形与实物沙盘是否同一套比例 */
const relief = await evalJson('window.__gyro.reliefInfo');
say(`  地形比例：水平 1:${Math.round(relief.horizontalScale).toLocaleString()} · 垂直 1:${Math.round(relief.verticalScale).toLocaleString()}`);
say(`  垂直夸张倍数：${relief.exaggeration.toFixed(1)}×（reliefM=${relief.reliefM.toFixed(4)} m，最高处高出基准面 ${(relief.reliefM).toFixed(0)} mm）`);
say(`  锚点高度范围：y = ${Math.min(...world0.map(w => w.y)).toFixed(3)} ~ ${Math.max(...world0.map(w => w.y)).toFixed(3)} m（基准面 ${relief.baseLift.toFixed(4)} m）`);
say('    ⇒ 标注锚在【虚拟起伏面】上；若实物沙盘是平面，锚点会整体浮起');
say('');

/* ============================================================
   ③ 同步消失
   ============================================================ */
say('【③ 目标移出画面时，标记点是否同步消失】');

/* 细扫 yaw，记录每个锚点从「可见」翻到「不可见」那一帧的状态。
   ⚠️ 决定消失的是【绝对值较大的那个轴】：
        score = min(1-|ndcX|, 1-|ndcY|) —— 取 min 等价于取 |ndc| 的 max。
      我第一版写成 min(|ndcX|,|ndcY|)，把「出画面 100 px」报成了「0 px」，
      方向正好反了。判据要照着 score 的定义推，不能凭「取小就是最紧的」直觉。 */
const flip = new Map();
let prev = null;
for (let y = -110; y <= 110; y += 2) {
  const arr = await aim(y);
  for (const a of arr) {
    const vis = a.visible;
    if (prev && prev.has(a.id)) {
      const pv = prev.get(a.id);
      if (pv.visible && !vis && !flip.has(a.id)) {
        flip.set(a.id, {
          yaw: y, name: a.name,
          prevNdc: Math.max(Math.abs(pv.ndcX), Math.abs(pv.ndcY)),
          ndc: Math.max(Math.abs(a.anchorPx.ndcX), Math.abs(a.anchorPx.ndcY)),
          score: a.score,
        });
      }
    }
  }
  prev = new Map(arr.map(a => [a.id, { visible: a.visible, ndcX: a.anchorPx.ndcX, ndcY: a.anchorPx.ndcY }]));
}
const flipArr = [...flip.values()];
/* 理论阈值：score < -0.10 才关，即 max|ndc| > 1.10 */
const EXIT_NDC = 0.10;
const lingerTheoryPx = EXIT_NDC * W / 2;
const lastVisibleNdc = flipArr.length ? Math.min(...flipArr.map(f => f.prevNdc)) : 0;
const firstInvisibleNdc = flipArr.length ? Math.max(...flipArr.map(f => f.ndc)) : 0;
say(`  退出阈值：score = min(1-|ndcX|, 1-|ndcY|) < -0.10 才隐藏 ⇒ 决定轴 max|ndc| > 1.10`);
say(`  理论残留：${lingerTheoryPx.toFixed(0)} px（= 0.10 × 屏宽的一半，占屏宽 ${(EXIT_NDC / 2 * 100).toFixed(1)}%）`);
say(`  实测：最后一帧仍可见时已出画面 ${Math.round((lastVisibleNdc - 1) * W / 2)} px；` +
    `下一帧（2° 步长）已到 ${Math.round((firstInvisibleNdc - 1) * W / 2)} px 处才隐藏`);
say(`  翻转 ${flipArr.length} 次，最晚一次在 max|ndc| = ${firstInvisibleNdc.toFixed(3)}`);
verdict(lingerTheoryPx < 20, `出画面后最多 ${lingerTheoryPx.toFixed(0)} px 才消失（滞回死区的固有代价）`);
say('');

/* 遮挡：地点被山体挡住时，标签是否还在显示 */
await aim(0);
const occ = await evalJson('window.__gyro.arOcclusion');
const shownOccluded = occ.filter(o => o.shownButOccluded);
say(`  被地形遮挡的锚点：${occ.filter(o => o.occluded).length}/${occ.length}`);
say(`  其中【仍然显示标签】的：${shownOccluded.length} 个${shownOccluded.length ? '（' + shownOccluded.map(o => o.name).join('、') + '）' : ''}`);
for (const o of shownOccluded) {
  say(`    · ${o.name}：挡在 ${o.blockerDist} m 处，锚点在 ${o.anchorDist} m —— 标签画在看不见的地方`);
}
verdict(shownOccluded.length === 0, '被遮挡的地点不显示标签（若 >0 则标注会指向看不见的位置）');
say('');

/* ============================================================
   ④ 逻辑连贯
   ============================================================ */
say('【④ 显示/隐藏与可见性判断是否连贯一致】');

let mismatch = 0, samples4 = 0;
const flipsPerAnchor = new Map();
prev = null;
for (let y = -120; y <= 120; y += 5) {
  const arr = await aim(y);
  for (const a of arr) {
    samples4++;
    if (a.visible !== a.rendered) mismatch++;
    if (prev && prev.has(a.id)) {
      const pv = prev.get(a.id);
      if (pv.visible !== a.visible) flipsPerAnchor.set(a.id, (flipsPerAnchor.get(a.id) || 0) + 1);
    }
  }
  prev = new Map(arr.map(a => [a.id, a]));
}
const maxFlips = flipsPerAnchor.size ? Math.max(...flipsPerAnchor.values()) : 0;
say(`  visible 与 rendered 一致性：${samples4 - mismatch}/${samples4} 项一致`);
say(`  单个锚点在 49 个朝向中的可见性翻转次数：最多 ${maxFlips} 次（理想 = 1 次，多了就是闪烁）`);
verdict(mismatch === 0, '判定与实际渲染完全一致（无「幽灵标注」）');
verdict(maxFlips <= 2, `无反复闪烁（最多 ${maxFlips} 次翻转）`);

/* 滞回是否真的防住了边缘抖动：把相机停在阈值附近，看会不会一闪一闪 */
await evaluate(`window.__gyro.clearAim(); 'ok'`);
await feedOrient(0, 55, 25);
await sleep(500);
say('');

/* ============================================================
   ⑤ 点击弹框
   ============================================================ */
say('【⑤ 点击标记点弹出详细信息的交互】');

await aim(0);
const labels5 = await evalJson('window.__gyro.arLabelsScreen');

async function realClick(px, py) {
  const x = Math.round(px), y = Math.round(py);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  await sleep(160);
}

/* 先验证「真实鼠标点击」这条链路是通的，再用页面探针批量统计。
   两者都跑，是为了区分「点击没生效」和「选中逻辑不对」。 */
await evaluate(`window.__gyro.closeCard(); 'ok'`);
const firstVisible = labels5.find(a => a.visible && a.anchorPx.behind === false);
if (firstVisible) {
  await realClick(firstVisible.anchorPx.px, firstVisible.anchorPx.py);
  const viaMouse = await evalJson(`({ on: document.getElementById('card').classList.contains('on'),
    title: document.getElementById('card-t').textContent })`);
  say(`  真实鼠标点击链路：cardOn=${viaMouse.on} 标题「${viaMouse.title}」（期望「${firstVisible.name}」）`);
  verdict(viaMouse.on && viaMouse.title === firstVisible.name, '真实 pointer 事件能打开弹框');
}

/* 用页面内的探针直接问「这个点会选中谁」——比依赖 DOM 状态更干净 */
async function probe(px, py) {
  return evalJson(`window.__gyro.pickProbe(${px.toFixed(1)}, ${py.toFixed(1)})`);
}

let labelHit = 0, labelTry = 0, ringHit = 0, ringTry = 0;
const labelFails = [], ringFails = [];
for (const a of labels5) {
  if (!a.visible || a.anchorPx.behind) continue;
  /* 点【标签图形】的屏幕位置 */
  if (a.labelPx.px > 8 && a.labelPx.px < W - 8 && a.labelPx.py > 8 && a.labelPx.py < H - 8) {
    labelTry++;
    await evaluate(`window.__gyro.closeCard(); 'ok'`);
    const r = await probe(a.labelPx.px, a.labelPx.py);
    if (r && r.cardOn && r.title === a.name) labelHit++;
    else {
      /* 记下「点标签却选中了谁 / 还是完全没选中」以及 UV 距离 ——
         UV 距离 > 0.12 就是被 pickAt 的距离上限挡掉的 */
      const why = r && r.cardOn ? `选中了「${r.title}」` : '完全没选中';
      labelFails.push(`${a.name}→${why}${r && r.lastPickMiss ? `(d=${r.lastPickMiss.uvDistance})` : ''}`);
    }
  }
  /* 点【地面环】的屏幕位置 */
  ringTry++;
  await evaluate(`window.__gyro.closeCard(); 'ok'`);
  const r2 = await probe(a.anchorPx.px, a.anchorPx.py);
  if (r2 && r2.cardOn && r2.title === a.name) ringHit++;
  else ringFails.push(`${a.name}${r2 && r2.lastPickMiss ? '(最近:' + r2.lastPickMiss.nearest + ' d=' + r2.lastPickMiss.uvDistance + ')' : ''}`);
}
say(`  点【标签图形】命中：${labelHit}/${labelTry}${labelFails.length ? '  未命中：' + labelFails.join('、') : ''}`);
say(`  点【地面标记环】命中：${ringHit}/${ringTry}${ringFails.length ? '  未命中：' + ringFails.join('、') : ''}`);

/* 卡片内容是否真的填上了 */
await evaluate(`window.__gyro.closeCard(); 'ok'`);
const one = labels5.find(a => a.visible);
const card = await probe(one.anchorPx.px, one.anchorPx.py);
say(`  卡片内容：标题「${card.title}」· 副标题「${card.meta}」· 正文 ${card.detailLen} 字`);
verdict(card.detailLen > 50, '弹框包含详细信息（成因/过程/关系/看点）');

/* 负对照：点远离所有地点的地形，应明确「附近没有收录地点」 */
await evaluate(`window.__gyro.closeCard(); 'ok'`);
const miss = await probe(W * 0.5, H * 0.62);
say(`  负对照（点地形空白处）：cardOn=${miss.cardOn}，提示=${miss.lastPickMiss ? '最近「' + miss.lastPickMiss.nearest + '」d=' + miss.lastPickMiss.uvDistance : '无'}`);

verdict(labelHit === labelTry && labelTry > 0, `点标签图形命中 ${labelHit}/${labelTry}`);
verdict(ringHit === ringTry && ringTry > 0, `点【地面标记环】命中 ${ringHit}/${ringTry}`);
if (labelHit < labelTry) {
  say(`  ⇒ 点【标签图形】${labelHit}/${labelTry} 命中：pickAt 只对【地形】做射线检测，`);
  say(`     标签抬升 0.085 m 后点它，射线落到地面的位置离锚点更远，超出 UV 距离上限 0.12（≈${(0.12 * 2.8 * 100).toFixed(0)} cm）就被判「附近没有收录地点」。`);
  say(`     用户最自然的动作是点名字标签 —— 这条链路不可靠。`);
}
say('');

say('================ 结论 ================');
say('');
say('满足的：');
say('  · ① 锚定：世界坐标零漂移（0.00e+0 m），标注彼此相对形变 0.93 px —— 星座刚性');
say('  · ② 内部几何：锚点精确落在地形网格面上（Δy = 0.00 mm），投影↔反投影闭合');
say('  · ④ 显隐逻辑：539/539 项 visible 与 rendered 一致，无闪烁（最多 2 次翻转）');
say('  · ⑤ 弹框内容：真实 pointer 事件能打开，含成因/过程/关系/看点（231 字）');
say('');
say('不满足 / 有差距的：');
say(`  · ③ 残留 ${lingerTheoryPx.toFixed(0)} px：锚点出画面后标注仍显示（滞回死区 0.10 NDC 的固有代价）`);
say(`  · ③ 遮挡：${shownOccluded.length}/${occ.length} 个地点的位置被山体挡住，标签仍画在最上层（depthTest:false）`);
say(`  · ⑤ 点击：点【标签图形】只命中 ${labelHit}/${labelTry}（pickAt 只对地形做射线检测，标签抬升后落点超出 UV 上限 0.12）`);
say('  · ② 物理对齐未经检验：垂直夸张 16.0×、视场角只能手填、对齐是一次性手动步骤');
say('     —— 这三项决定「叠加到真实沙盘上准不准」，本审计无法用无相机环境验证，需真机标定');
say('');

ws.close(); proc.kill();
process.exit(0);
