/**
 * 一次性诊断：细扫 yaw，打印每个锚点【可见性翻转】那一刻的完整状态。
 * 用途：核实「出画面多少像素后标注才消失」这个数到底是多少。
 *
 * 用法：node tools/probe-cull-flip.mjs <URL>
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME_PATH || String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`;
const TARGET = process.argv[2];
const PORT = 9357;
if (!TARGET) { console.log('用法: node tools/probe-cull-flip.mjs <URL>'); process.exit(1); }

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
ws.addEventListener('message', ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } });
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
await sleep(1500);
await evaluate(`(() => { const e = new Event('deviceorientation');
  e.alpha = 0; e.beta = 55; e.gamma = 25; dispatchEvent(e); return 'ok'; })()`);
await sleep(900);

const W = 1152;
console.log('=== 可见性翻转诊断 ===\n');
console.log('扫 yaw，记录每个锚点 true→false 那一帧的状态（score / ndc / 判定轴）\n');

const flips = [];
const prevState = new Map();
for (let y = -110; y <= 110; y += 2) {
  await evaluate(`window.__gyro.aimAt(${y})`);
  await sleep(200);
  const arr = await evalJson('window.__gyro.arLabelsScreen');
  if (!Array.isArray(arr)) continue;
  for (const a of arr) {
    const pv = prevState.get(a.id);
    if (pv && pv.visible && !a.visible) {
      /* score = min(1-|x|,1-|y|) ⇒ 取 min 等价于取 |ndc| 的 max。
         所以「决定轴」是绝对值【较大】的那个。 */
      const dec = Math.max(Math.abs(a.anchorPx.ndcX), Math.abs(a.anchorPx.ndcY));
      flips.push({
        name: a.name, yaw: y,
        prevNdc: Math.max(Math.abs(pv.ndcX), Math.abs(pv.ndcY)),
        prevScore: pv.score,
        ndcX: a.anchorPx.ndcX, ndcY: a.anchorPx.ndcY,
        dec, score: a.score, behind: a.anchorPx.behind,
      });
    }
    prevState.set(a.id, { visible: a.visible, ndcX: a.anchorPx.ndcX, ndcY: a.anchorPx.ndcY, score: a.score });
  }
}

console.log('| 地点 | yaw | 上一帧 max|ndc| | 上一帧 score | 本帧 ndcX | 本帧 ndcY | 决定轴 max|ndc| | 本帧 score |');
console.log('|---|---|---|---|---|---|---|---|');
for (const f of flips) {
  console.log(`| ${f.name} | ${f.yaw} | ${f.prevNdc.toFixed(3)} | ${f.prevScore} | ${f.ndcX.toFixed(3)} | ${f.ndcY.toFixed(3)} | ${f.dec.toFixed(3)} | ${f.score} |`);
}

const decs = flips.map(f => f.dec);
const prevs = flips.map(f => f.prevNdc);
console.log(`\n翻转共 ${flips.length} 次`);
if (decs.length) {
  console.log(`最后一帧【仍可见】时的 max|ndc|：${Math.min(...prevs).toFixed(3)} ~ ${Math.max(...prevs).toFixed(3)}` +
    `（已出画面 ${Math.round((Math.min(...prevs) - 1) * W / 2)} ~ ${Math.round((Math.max(...prevs) - 1) * W / 2)} px）`);
  console.log(`翻到【不可见】时的 max|ndc|：${Math.min(...decs).toFixed(3)} ~ ${Math.max(...decs).toFixed(3)}` +
    `（出画面 ${Math.round((Math.min(...decs) - 1) * W / 2)} ~ ${Math.round((Math.max(...decs) - 1) * W / 2)} px）`);
  console.log(`\n退出阈值 score < -0.10 ⇔ max|ndc| > 1.10 ⇔ 出画面 58 px —— 这就是残留的理论上界。`);
  console.log(`实测比 58 px 更大，是因为扫掠步长 2°，锚点在边缘附近 2° 就能移动 0.03~0.07 NDC。`);
}

ws.close(); proc.kill();
process.exit(0);
