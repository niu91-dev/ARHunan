/**
 * ar-holo-demo.html（参考项目外观 + 我们的相机 AR 逻辑）运行截图。
 *
 * 页面默认进入手动拖拽模式（桌面无陀螺仪），用 CDP 合成拖拽转向。
 *
 * 输出：tools/_holo/00-default.png、01-turn.png、02-turn2.png、03-scan.png
 * 用法：node tools/holo-shots.mjs [URL]
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
const TARGET = process.argv[2] || 'http://127.0.0.1:8090/ar-holo-demo.html';
const OUT = join(HERE, '_holo');
const PORT = 9357;
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
await send('Emulation.setDeviceMetricsOverride', { width: 1152, height: 720, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: TARGET + (TARGET.includes('?') ? '&' : '?') + 'cb=' + Date.now() });

/* 等页面 ready：loading 覆盖层消失 + 场景里出现 canvas */
await sleep(3000);
for (let i = 0; i < 40; i++) {
  const st = await evaluate(`(() => {
    const loading = document.getElementById('loading');
    const canvas = document.querySelector('#scene canvas');
    return JSON.stringify({
      loadingOff: !loading || !loading.classList.contains('on'),
      hasCanvas: !!canvas,
      markers: document.querySelectorAll('.site-markers button').length,
    });
  })()`);
  const d = JSON.parse(st.result.value);
  if (d.loadingOff && d.hasCanvas && d.markers >= 11) break;
  await sleep(500);
}
console.log('页面加载完成');

/* 页面遥测读数（DOM 状态，不依赖内部全局对象） */
const readState = async () => {
  const st = await evaluate(`JSON.stringify({
    visibleMarkers: Array.from(document.querySelectorAll('.site-markers button')).filter(b => !b.classList.contains('is-hidden')).length,
    stems: Array.from(document.querySelectorAll('#site-stems > *')).filter(s => s.style.display !== 'none').length,
    listButtons: document.querySelectorAll('.site-list button').length,
    yaw: (document.getElementById('yaw-value-ar') || {}).textContent || '',
    tel: (document.getElementById('ar-telemetry') || {}).textContent || '',
    hint: (document.getElementById('hint') || {}).textContent || '',
    brand: !!document.querySelector('.brand') || !!document.querySelector('[class*=brand]'),
  })`);
  return JSON.parse(st.result.value);
};

const shot = async (name) => {
  const s = await send('Page.captureScreenshot', { format: 'png' });
  const f = join(OUT, name + '.png');
  writeFileSync(f, Buffer.from(s.data, 'base64'));
  return f;
};

const drag = async (dx, dy) => {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 576, y: 400, button: 'left', clickCount: 1 });
  const STEPS = 12;
  for (let i = 1; i <= STEPS; i++) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 576 + Math.round(dx * i / STEPS), y: 400 + Math.round(dy * i / STEPS), button: 'left' });
    await sleep(16);
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 576 + dx, y: 400 + dy, button: 'left', clickCount: 1 });
  await sleep(600);
};

/* 00 默认视角 */
await sleep(1500);
let d = await readState();
console.log(`默认视角：可见标记 ${d.visibleMarkers}/11，stem ${d.stems}，名单 ${d.listButtons} 项`);
console.log(`   遥测条：${d.tel.trim().replace(/\s+/g, ' ')}`);
console.log(`   底部提示：${d.hint}`);
console.log('   → ' + await shot('00-default'));

/* 01 拖拽右转（向左拖 = 场景右转） */
await drag(-260, 0);
d = await readState();
console.log(`\n拖拽转向①：可见标记 ${d.visibleMarkers}/11，yaw ${d.yaw}`);
console.log('   → ' + await shot('01-turn'));

/* 02 继续拖拽 + 抬头 */
await drag(-220, -120);
d = await readState();
console.log(`\n拖拽转向②：可见标记 ${d.visibleMarkers}/11，yaw ${d.yaw}`);
console.log('   → ' + await shot('02-turn2'));

/* 03 点画面中心 → 触发扫描涟漪 */
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 576, y: 400, button: 'left', clickCount: 1 });
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 576, y: 400, button: 'left', clickCount: 1 });
await sleep(400);
const scan = await evaluate(`(document.getElementById('scan-readout')||{}).textContent||''`);
console.log(`\n中心扫描涟漪：${scan}`);
console.log('   → ' + await shot('03-scan'));

ws.close(); proc.kill();
process.exit(0);
