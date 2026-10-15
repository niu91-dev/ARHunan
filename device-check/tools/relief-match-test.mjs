/**
 * 起伏比例对齐回归测试 —— 实物沙盘是【起伏模型】时，虚拟地形的垂直比例必须与它一致。
 *
 * 被测的三条：
 *   ① 垂直夸张倍数 = 16.0×，且【与沙盘尺寸无关】（reliefM 与 tableW 同比缩放）
 *   ② setReliefFromPeak(mm) 反算后，实测峰高 == mm（峰高严格正比于 reliefScale）
 *   ③ 改 reliefScale 后锚点仍精确落在地形面上（Δy = 0），且 y 线性跟随
 *
 * 为什么重要：垂直比例不一致时【整个叠加都错位】，不只是标注 ——
 * 虚拟地形本身就贴不上实物模型。量化：50 mm 的垂直偏差在 2 m 深处
 * 约等于 24 px 的屏幕错位（掠射角下 cos15.6°/2.077 m）。
 *
 * 用法：node tools/relief-match-test.mjs <URL>
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME_PATH || String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`;
const TARGET = process.argv[2];
const PORT = 9359;
if (!TARGET) { console.log('用法: node tools/relief-match-test.mjs <URL>'); process.exit(1); }

const proc = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--user-data-dir=' + join(tmpdir(), 'wb-cdp-' + PORT),
  '--ignore-certificate-errors', '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream', '--remote-debugging-port=' + PORT,
  '--window-size=1152,720', 'about:blank',
], { stdio: 'ignore' });

let ver = null;
for (let i = 0; i < 80; i++) {
  try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) { ver = await r.json(); break; } } catch (e) {}
  await sleep(250);
}
if (!ver) { console.log('CHROME_START_FAIL'); proc.kill(); process.exit(1); }

const tab = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(TARGET)}`, { method: 'PUT' })).json();
const ws = new WebSocket(tab.webSocketDebuggerUrl);
let msgId = 0; const pending = new Map();
const send = (method, params = {}) => { const mid = ++msgId; ws.send(JSON.stringify({ id: mid, method, params })); return new Promise(res => pending.set(mid, res)); };
await new Promise(r => ws.addEventListener('open', r));
const pageErrors = [];
ws.addEventListener('message', ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
  if (m.method === 'Runtime.exceptionThrown') pageErrors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') pageErrors.push(m.params.args.map(a => a.value ?? a.description).join(' '));
});
const evaluate = (expression) => send('Runtime.evaluate', { expression, returnByValue: true, userGesture: true });
const evalJson = async (expr) => {
  const r = await evaluate(`JSON.stringify(${expr} === undefined ? null : ${expr})`);
  if (!r || r.exceptionDetails || !r.result || r.result.value === undefined) return null;
  try { return JSON.parse(r.result.value); } catch (e) { return null; }
};

await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Emulation.setDeviceMetricsOverride', { width: 1152, height: 720, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: TARGET + (TARGET.includes('?') ? '&' : '?') + 'cb=' + Date.now() });
await sleep(6000);
await evaluate(`document.getElementById('start')?.click(); 'ok'`);
await sleep(2000);
await evaluate(`(() => { const e = new Event('deviceorientation');
  e.alpha = 0; e.beta = 55; e.gamma = 25; dispatchEvent(e); return 'ok'; })()`);
await sleep(900);

const checks = [];
const chk = (name, pass, detail) => checks.push({ name, pass, detail });
const readStats = () => evalJson('window.__gyro.terrainStats');
const readAnchors = () => evalJson('window.__gyro.arAnchors');

console.log('=== 起伏比例对齐测试 ===\n');
const st0 = await readStats();
if (!st0) { console.log('terrainStats 不存在，页面可能是旧版。页面错误：', pageErrors); ws.close(); proc.kill(); process.exit(1); }
console.log(`数据最大高程 ${st0.dataMaxElev.toFixed(1)} m（声明上限 ${st0.maxElev}）`);
console.log(`reliefScale=1 时的峰高 = ${st0.peakAt1Mm.toFixed(1)} mm\n`);
chk('页面无未捕获错误', pageErrors.length === 0, pageErrors.length ? pageErrors[0].slice(0, 90) : '无');

/* ---------- ① 夸张倍数与尺寸无关 ---------- */
chk('垂直夸张 = 16.0×', Math.abs(st0.exaggeration - 16.0) < 0.1,
  `${st0.exaggeration.toFixed(2)}×（水平 1:${Math.round(st0.horizontalScale).toLocaleString()} / 垂直 1:${Math.round(st0.verticalScale).toLocaleString()}）`);
chk('峰高 = 直径的 5.1%', Math.abs(st0.peakPctOfDiameter - 5.1) < 0.2,
  `${st0.peakPctOfDiameter.toFixed(2)}%（${st0.peakMm.toFixed(0)} mm / ${(st0.peakMm / st0.peakPctOfDiameter * 100).toFixed(0)} mm）`);

const exagBySize = [];
for (const w of [1.8, 2.4, 2.8, 3.6, 4.0]) {
  await evaluate(`window.__gyro.setTableW(${w}); 'ok'`);
  await sleep(500);
  const s = await readStats();
  exagBySize.push({ w, exag: s.exaggeration, peakPct: s.peakPctOfDiameter });
}
const exagSpread = Math.max(...exagBySize.map(e => e.exag)) - Math.min(...exagBySize.map(e => e.exag));
chk('夸张倍数与沙盘尺寸无关（1.8~4.0 m 全都 16.0×）', exagSpread < 0.02,
  exagBySize.map(e => `${e.w}m:${e.exag.toFixed(2)}×`).join(' '));
chk('峰高/直径比值也与尺寸无关（都是 5.1%）',
  Math.max(...exagBySize.map(e => e.peakPct)) - Math.min(...exagBySize.map(e => e.peakPct)) < 0.02,
  exagBySize.map(e => `${e.peakPct.toFixed(2)}%`).join(' '));

/* 回到 2.8 m */
await evaluate(`window.__gyro.setTableW(2.8); 'ok'`);
await sleep(600);

/* ---------- ② 按实物峰高反算 ---------- */
const cases = [60, 100, 142, 200, 300];
const results = [];
for (const mm of cases) {
  const r = await evalJson(`window.__gyro.setReliefFromPeak(${mm})`);
  await sleep(500);
  const s = await readStats();
  results.push({ want: mm, got: s.peakMm, reliefScale: s.reliefScale, exag: s.exaggeration, clamp: r && r.sliderClamped });
}
let maxErr = 0;
for (const r of results) maxErr = Math.max(maxErr, Math.abs(r.got - r.want));
chk('setReliefFromPeak(mm) 后实测峰高 == 目标值', maxErr < 0.5,
  results.map(r => `${r.want}→${r.got.toFixed(1)}mm`).join(' '));
chk('反算出的 reliefScale 与峰高成正比', (() => {
  const k = results.map(r => r.reliefScale / r.want);
  return Math.max(...k) - Math.min(...k) < 1e-9;
})(), results.map(r => `${r.reliefScale.toFixed(3)}`).join(' '));

/* 拍平（reliefScale = 0）之后还能反解回来 —— 平面沙盘用得上 */
await evaluate(`window.__gyro.setReliefFromPeak(0.0001); 'ok'`);
await sleep(500);
const flat = await readStats();
chk('reliefScale≈0 时地形确实被拍平', flat.peakMm < 0.01,
  `峰高 ${flat.peakMm.toFixed(4)} mm`);
const back = await evalJson(`window.__gyro.setReliefFromPeak(142)`);
await sleep(500);
const stBack = await readStats();
chk('地形拍平后仍能反解回 142 mm（不除零）', Math.abs(stBack.peakMm - 142) < 0.5,
  `reliefScale=${back ? back.reliefScale.toFixed(3) : '—'} → 峰高 ${stBack.peakMm.toFixed(1)} mm`);

/* ---------- ③ 锚点跟随起伏且仍在地形面上 ---------- */
await evaluate(`window.__gyro.setReliefFromPeak(142); 'ok'`);
await sleep(600);
const a142 = await readAnchors();
await evaluate(`window.__gyro.setReliefFromPeak(284); 'ok'`);
await sleep(600);
const a284 = await readAnchors();

/* 锚点 y 应线性跟随：y − baseLift 翻倍 */
const st142 = await readStats();
const base = st142.baseLift;
let maxLin = 0, linAt = '';
for (let i = 0; i < a142.length; i++) {
  const h1 = a142[i].pos.y - base, h2 = a284[i].pos.y - base;
  if (h1 > 1e-6) {
    const e = Math.abs(h2 / h1 - 2);
    if (e > maxLin) { maxLin = e; linAt = a142[i].name; }
  }
}
chk('reliefScale 翻倍 → 锚点高出基准面的高度也翻倍', maxLin < 1e-6,
  `最大比值偏差 ${maxLin.toExponential(2)}（${linAt}）`);

/* 锚点仍精确落在地形网格面上 */
let maxDy = 0, dyAt = '';
for (const a of a284) {
  const my = await evalJson(`window.__gyro.terrainYAt(${a.pos.x}, ${a.pos.z})`);
  if (my === null) continue;
  const d = Math.abs(a.pos.y - my);
  if (d > maxDy) { maxDy = d; dyAt = a.name; }
}
chk('改起伏后锚点仍精确落在地形网格面上', maxDy < 0.002,
  `最大 Δy ${(maxDy * 1000).toFixed(3)} mm（${dyAt}）`);

/* 平面沙盘（reliefScale=0）时锚点全部落到基准面 —— 退化情形可用 */
await evaluate(`window.__gyro.setReliefFromPeak(0.0001); 'ok'`);
await sleep(600);
const aFlat = await readAnchors();
const flatSpread = Math.max(...aFlat.map(a => a.pos.y)) - Math.min(...aFlat.map(a => a.pos.y));
chk('reliefScale≈0（平面沙盘）时锚点全部落在同一基准面', flatSpread < 0.001,
  `锚点 y 极差 ${(flatSpread * 1000).toFixed(3)} mm`);

/* 收尾：回到默认 142 mm */
await evaluate(`window.__gyro.setReliefFromPeak(142); 'ok'`);
await sleep(500);

console.log('=== 判定 ===');
let failed = 0;
for (const c of checks) {
  console.log((c.pass ? '  [PASS] ' : '  [FAIL] ') + c.name + '   (' + c.detail + ')');
  if (!c.pass) failed++;
}
console.log(failed === 0
  ? '\n全部通过 ✅ —— 虚拟地形垂直比例可按实物峰高对齐，锚点跟随且不脱离地形面'
  : `\n${failed} 项未通过 ❌`);

ws.close(); proc.kill();
process.exit(failed === 0 ? 0 : 1);
