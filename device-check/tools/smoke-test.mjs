import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`;
const TARGET = process.argv[2];
const OUTPNG = process.argv[3] || '_smoke.png';
const WAIT_MS = Number(process.argv[4] || 7000);
const WIN = process.argv[5] || '1280,800';   // 例如 "1152,720" 对应小米平板6 横屏
const PORT = 9333;

const proc = spawn(CHROME, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  // 独立 profile —— 否则用户自己开着 Chrome 时会交接给已有实例、调试端口不生效
  '--user-data-dir=' + join(tmpdir(), 'wb-cdp-' + PORT),
  '--ignore-certificate-errors',
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
  '--autoplay-policy=no-user-gesture-required',
  '--remote-debugging-port=' + PORT,
  '--window-size=' + WIN,
  'about:blank',
], { stdio: 'ignore' });

let ver = null;
for (let i = 0; i < 80; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
    if (r.ok) { ver = await r.json(); break; }
  } catch (e) { /* not up yet */ }
  await sleep(250);
}
if (!ver) { console.log('CHROME_START_FAIL'); proc.kill(); process.exit(1); }

const tabRes = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(TARGET)}`, { method: 'PUT' });
const tab = await tabRes.json();
const ws = new WebSocket(tab.webSocketDebuggerUrl);

let msgId = 0;
const pending = new Map();
const logs = [];
const errors = [];

function send(method, params = {}) {
  const mid = ++msgId;
  ws.send(JSON.stringify({ id: mid, method, params }));
  return new Promise(res => pending.set(mid, res));
}

await new Promise(r => ws.addEventListener('open', r));
ws.addEventListener('message', ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); return; }
  if (m.method === 'Runtime.consoleAPICalled') {
    const txt = (m.params.args || []).map(a => a.value ?? a.description ?? a.type).join(' ');
    logs.push(m.params.type + ': ' + txt);
    if (m.params.type === 'error') errors.push('console.error: ' + txt);
  }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    errors.push('exception: ' + ((d.exception && (d.exception.description || d.exception.value)) || d.text));
  }
  if (m.method === 'Log.entryAdded') {
    const e = m.params.entry;
    if (e.level === 'error') errors.push('log: ' + e.text + '  ' + (e.url || ''));
    logs.push(e.level + ': ' + e.text);
  }
});

await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');
await send('Page.navigate', { url: TARGET });
await sleep(WAIT_MS);

const p1 = await send('Runtime.evaluate', {
  expression: `JSON.stringify({
    title: document.title,
    startDisabled: document.getElementById('start') ? document.getElementById('start').disabled : null,
    precheck: document.getElementById('precheck') ? document.getElementById('precheck').innerText.replace(/\\s+/g,' ').slice(0,320) : null,
    glDisplay: document.getElementById('gl') ? getComputedStyle(document.getElementById('gl')).display : null
  })`,
  returnByValue: true,
});
console.log('PROBE_PRE  ', p1.result && p1.result.value);

await send('Runtime.evaluate', {
  expression: `document.getElementById('start') && document.getElementById('start').click(); 'clicked'`,
  returnByValue: true,
  userGesture: true,
});
await sleep(WAIT_MS);

const p2 = await send('Runtime.evaluate', {
  expression: `JSON.stringify({
    glDisplay: getComputedStyle(document.getElementById('gl')).display,
    camDisplay: getComputedStyle(document.getElementById('cam')).display,
    barOn: document.getElementById('bar').classList.contains('on'),
    loadingOn: document.getElementById('loading').classList.contains('on'),
    precheck: document.getElementById('precheck').innerText.replace(/\\s+/g,' ').slice(0,200),
    align: document.getElementById('t-align').innerText,
    orient: document.getElementById('t-orient').innerText,
    fps: document.getElementById('t-fps').innerText,
    hz: document.getElementById('t-hz').innerText
  })`,
  returnByValue: true,
});
console.log('PROBE_POST ', p2.result && p2.result.value);

/* 模拟点击地形，验证「点选地点」链路 */
const p3 = await send('Runtime.evaluate', {
  expression: `(() => {
    const c = document.getElementById('gl');
    const r = c.getBoundingClientRect();
    const x = r.left + r.width * 0.36, y = r.top + r.height * 0.44;
    const opt = { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, isPrimary: true, pointerType: 'touch' };
    c.dispatchEvent(new PointerEvent('pointerdown', opt));
    c.dispatchEvent(new PointerEvent('pointerup', opt));
    return JSON.stringify({ x: Math.round(x), y: Math.round(y) });
  })()`,
  returnByValue: true,
});
console.log('TAP_AT     ', p3.result && p3.result.value);
await sleep(1200);

const p4 = await send('Runtime.evaluate', {
  expression: `JSON.stringify({
    cardOn: document.getElementById('card').classList.contains('on'),
    cardName: document.getElementById('card-t').innerText,
    cardMeta: document.getElementById('card-m').innerText,
    cardBodyLen: document.getElementById('card-d').innerText.length,
    topSite: document.getElementById('t-site').innerText
  })`,
  returnByValue: true,
});
console.log('PICK_RESULT', p4.result && p4.result.value);

const shot = await send('Page.captureScreenshot', { format: 'png' });
if (shot && shot.data) fs.writeFileSync(OUTPNG, Buffer.from(shot.data, 'base64'));
console.log('SCREENSHOT ', OUTPNG, shot && shot.data ? Buffer.from(shot.data, 'base64').length + ' bytes' : 'none');
console.log('ERRORS     ', errors.length ? JSON.stringify(errors, null, 2) : '（无）');
console.log('LOGS_TAIL  ', JSON.stringify(logs.slice(-20), null, 2));

ws.close();
proc.kill();
process.exit(0);
