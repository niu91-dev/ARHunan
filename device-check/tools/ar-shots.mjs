/**
 * 截取不同朝向下的 AR 画面，用于人工核对「视野裁剪」的视觉效果。
 *
 * 输出：tools/_ar/yaw-<角度>.png
 * 用法：node tools/ar-shots.mjs <URL>
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHROME = process.env.CHROME_PATH
  || String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`;
const TARGET = process.argv[2] || 'http://127.0.0.1:8080/ar-gyro-demo.html';
const OUT = join(HERE, '_ar');
const PORT = 9351;
mkdirSync(OUT, { recursive: true });

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
const send = (method, params = {}) => {
  const mid = ++msgId;
  ws.send(JSON.stringify({ id: mid, method, params }));
  return new Promise(res => pending.set(mid, res));
};
await new Promise(r => ws.addEventListener('open', r));
ws.addEventListener('message', ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
});
const evaluate = (expression) => send('Runtime.evaluate', { expression, returnByValue: true, userGesture: true });

await send('Runtime.enable');
await send('Page.enable');
await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Emulation.setDeviceMetricsOverride', { width: 1152, height: 720, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: TARGET + (TARGET.includes('?') ? '&' : '?') + 'cb=' + Date.now() });
await sleep(6000);
await evaluate(`document.getElementById('start')?.click(); 'ok'`);
await sleep(1500);
await evaluate(`(() => { const e = new Event('deviceorientation');
  e.alpha = 0; e.beta = 55; e.gamma = 25; dispatchEvent(e); return 'ok'; })()`);
await sleep(1200);
/* 藏掉会遮挡画面的浮层：假相机图案 / 状态条 / 提示气泡 */
await evaluate(`(() => { for (const id of ['cam','topbar','flash','alignhint','crosshair'])
  { const el = document.getElementById(id); if (el) el.style.display='none'; } return 'ok'; })()`);

for (const yaw of [0, 45, -45]) {
  await evaluate(`window.__gyro.aimAt(${yaw})`);
  await sleep(500);
  /* ⚠️ 名单要用 rendered（真的提交渲染），不能用 visible（裁剪判定）——
     visible=true 但被遮挡剔除掉的锚点，屏幕上其实看不见。
     混用两者会得到「写着 3/11 却列出 4 个名字」这种自相矛盾的取证材料。 */
  const st = await evaluate(`JSON.stringify({n: window.__gyro.arVisibleCount,
    occ: window.__gyro.arOccludedCount, cov: window.__gyro.arCoverage,
    drawn: window.__gyro.arAnchors.filter(a=>a.labelRendered).map(a=>a.name),
    hiddenByOcclusion: window.__gyro.arAnchors.filter(a=>a.occluded).map(a=>a.name)})`);
  const s = await send('Page.captureScreenshot', { format: 'png' });
  const f = join(OUT, `yaw-${yaw >= 0 ? 'p' : 'm'}${Math.abs(yaw)}.png`);
  writeFileSync(f, Buffer.from(s.data, 'base64'));
  const d = JSON.parse(st.result.value);
  console.log(`yaw=${String(yaw).padStart(4)}°  渲染 ${d.n}/11  覆盖 ${(d.cov * 100).toFixed(1)}%  → ${f}`);
  console.log(`            ${d.drawn.join(' ')}`);
  if (d.hiddenByOcclusion.length) {
    console.log(`            （被地形遮挡而隐藏：${d.hiddenByOcclusion.join(' ')}）`);
  }
}

/* ---------- 遮挡剔除 A/B 对照 ----------
   同一朝向，只切「遮挡剔除」开关。这是「标签到底有没有浮在山脊上」最直接的证据：
   两图相减，差异区域就是那几个本来画在挡住它的山体之上的标签。
   不开对照的话，看单张图只能说「少了一个标签」，说不出「它本来画错了地方」。 */
console.log('\n=== 遮挡剔除 A/B 对照（朝向 0°）===');
const ab = {};
for (const on of [true, false]) {
  await evaluate(`window.__gyro.setArOcclusion(${on}); window.__gyro.aimAt(0); 'ok'`);
  await sleep(500);
  const st = await evaluate(`JSON.stringify({
    drawn: window.__gyro.arAnchors.filter(a=>a.labelRendered).map(a=>a.name),
    occ: window.__gyro.arAnchors.filter(a=>a.occluded).map(a=>a.name)})`);
  const d = JSON.parse(st.result.value);
  ab[on ? 'on' : 'off'] = d;
  const s = await send('Page.captureScreenshot', { format: 'png' });
  const f = join(OUT, `occlusion-${on ? 'on' : 'off'}.png`);
  writeFileSync(f, Buffer.from(s.data, 'base64'));
  console.log(`遮挡剔除 ${on ? '开' : '关'}：渲染 ${d.drawn.length}/11  → ${f}`);
  if (d.occ.length) console.log(`            判为被遮挡：${d.occ.join(' ')}`);
}
const onlyOff = ab.off.drawn.filter(n => !ab.on.drawn.includes(n));
console.log(`\n差异：关掉遮挡后多出来的标签 = ${onlyOff.join('、') || '（无）'}`);
console.log('这几张就是「锚点在山背后、标签却浮在山脊上」的直接证据。');

ws.close(); proc.kill();
process.exit(0);
