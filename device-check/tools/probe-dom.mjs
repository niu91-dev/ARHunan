/**
 * 通用 DOM 探针 —— 零依赖，直连 Chrome CDP。
 *
 * 用途：页面出现「文字错位 / 有不该出现的方块 / 元素被裁切」时，
 *      不要靠看截图猜，直接把所有 fixed/absolute 可见元素的
 *      几何信息 + 文本 + 背景色抓出来。
 *
 * 用法：
 *   node tools/probe-dom.mjs "https://127.0.0.1:8443/ar-gyro-demo.html" [等待毫秒] [点击选择器] [WxH]
 *
 * 第三个参数是可选的选择器：给了就先点它（带 userGesture），再探针。
 * 第四个参数是可选视口尺寸，例如 "720x1152"（竖屏）—— 用来验证 orientation 媒体查询。
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`;
const TARGET = process.argv[2];
const WAIT_MS = Number(process.argv[3] || 5000);
const CLICK = process.argv[4] || null;
const VIEWPORT = process.argv[5] || null;   // "720x1152"
const PORT = 9334;

const proc = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  // 独立 profile —— 否则用户自己开着 Chrome 时会交接给已有实例、调试端口不生效
  '--user-data-dir=' + join(tmpdir(), 'wb-cdp-' + PORT),
  '--ignore-certificate-errors', '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required',
  '--remote-debugging-port=' + PORT, '--window-size=1280,800', 'about:blank',
], { stdio: 'ignore' });

let ver = null;
for (let i = 0; i < 80; i++) {
  try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) { ver = await r.json(); break; } } catch (e) {}
  await sleep(250);
}
if (!ver) { console.log('CHROME_START_FAIL'); proc.kill(); process.exit(1); }

const tabRes = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(TARGET)}`, { method: 'PUT' });
const tab = await tabRes.json();
const ws = new WebSocket(tab.webSocketDebuggerUrl);

let msgId = 0;
const pending = new Map();
function send(method, params = {}) {
  const mid = ++msgId;
  ws.send(JSON.stringify({ id: mid, method, params }));
  return new Promise(res => pending.set(mid, res));
}
await new Promise(r => ws.addEventListener('open', r));
ws.addEventListener('message', ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
});

await send('Runtime.enable');
await send('Page.enable');

/* 可选：覆盖视口尺寸，用来验证 @media (orientation: ...) 分支 */
if (VIEWPORT) {
  const [w, h] = VIEWPORT.toLowerCase().split('x').map(Number);
  await send('Emulation.setDeviceMetricsOverride', {
    width: w, height: h, deviceScaleFactor: 1, mobile: true,
    screenOrientation: { type: w > h ? 'landscapePrimary' : 'portraitPrimary', angle: w > h ? 90 : 0 },
  });
}

await send('Page.navigate', { url: TARGET });
await sleep(WAIT_MS);

if (CLICK) {
  await send('Runtime.evaluate', {
    expression: `document.querySelector(${JSON.stringify(CLICK)})?.click(); 'ok'`,
    returnByValue: true, userGesture: true,
  });
  await sleep(1800);
}

/* ---------- 探针 1：所有可见的 fixed / absolute 元素 ---------- */
const r1 = await send('Runtime.evaluate', {
  expression: `(() => {
    const out = [];
    for (const el of document.querySelectorAll('body *')) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) < 0.02) continue;
      if (cs.position !== 'fixed' && cs.position !== 'absolute') continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      out.push({
        tag: el.tagName.toLowerCase(),
        id: el.id || '',
        cls: (el.className && String(el.className).slice(0, 40)) || '',
        pos: cs.position,
        rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
        bg: cs.backgroundColor,
        z: cs.zIndex,
        text: (el.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 46),
        offscreen: r.left < 0 || r.top < 0 || r.right > innerWidth + 1 || r.bottom > innerHeight + 1,
      });
    }
    return JSON.stringify({ vw: innerWidth, vh: innerHeight, n: out.length, els: out }, null, 1);
  })()`,
  returnByValue: true,
});
console.log('=== 可见的定位元素 ===');
console.log(r1.result && r1.result.value);

/* ---------- 探针 2：顶部状态条逐格实际几何 ---------- */
const r2 = await send('Runtime.evaluate', {
  expression: `(() => {
    const strip = document.querySelector('#topbar .strip');
    if (!strip) return '（没有 #topbar .strip）';
    const sr = strip.getBoundingClientRect();
    const cells = [...strip.children].map(c => {
      const r = c.getBoundingClientRect();
      const k = c.querySelector('.k'), v = c.querySelector('.v');
      return {
        k: k ? k.innerText : '',
        v: v ? v.innerText : '',
        x: Math.round(r.left), w: Math.round(r.width),
        scrollW: Math.round(v ? v.scrollWidth : 0),
        clientW: Math.round(v ? v.clientWidth : 0),
        clipped: v ? v.scrollWidth > v.clientWidth + 1 : false,
      };
    });
    return JSON.stringify({
      stripRect: [Math.round(sr.left), Math.round(sr.width)],
      vw: innerWidth,
      overflow: sr.right > innerWidth + 1 || sr.left < -1,
      cells,
    }, null, 1);
  })()`,
  returnByValue: true,
});
console.log('=== 顶部状态条 ===');
console.log(r2.result && r2.result.value);

ws.close();
proc.kill();
process.exit(0);
