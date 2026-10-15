/**
 * 探针：打印 AR 锚点几何与不同朝向下的显隐结果。
 * 目的 —— 在写断言之前先看清「左/右」的符号约定和实际角度，
 * 避免凭直觉写测试然后被自己的符号错误骗过去。
 *
 * 用法：node tools/ar-probe.mjs <URL>
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME_PATH
  || String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`;
const TARGET = process.argv[2] || 'http://127.0.0.1:8080/ar-gyro-demo.html';
const PORT = 9349;   // 避开 hub-nav-test 的 9345

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
const consoleErrs = [];
ws.addEventListener('message', ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    consoleErrs.push(m.params.args.map(a => a.value ?? a.description).join(' '));
  }
  if (m.method === 'Runtime.exceptionThrown') {
    consoleErrs.push('EXC: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
  }
});

const evaluate = (expression) => send('Runtime.evaluate', { expression, returnByValue: true, userGesture: true });
/* 求值可能返回 undefined（键不存在）或抛异常，两种都不能让 JSON.parse 崩掉 ——
   否则报错会指向探针自己，而不是「页面到底缺了什么」。 */
const evalJson = async (expr) => {
  const r = await evaluate(`JSON.stringify(${expr} === undefined ? null : ${expr})`);
  if (!r) return { __err: 'no result' };
  if (r.exceptionDetails) {
    return { __err: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
  }
  if (!r.result || r.result.value === undefined) return { __err: 'undefined value' };
  try { return JSON.parse(r.result.value); } catch (e) { return { __raw: r.result.value }; }
};

await send('Runtime.enable');
await send('Page.enable');
/* ⚠️ 必须禁缓存。实测：profile 里残留的旧副本会让 Chrome 直接吃缓存，
   于是「页面明明改好了，测试却读到上一版的参数」—— 而且没有任何报错，
   现象是 __gyro 存在、但新加的 getter 全是 undefined。
   排查方向会被带偏到「导出写错了」，实际是缓存。 */
await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Emulation.setDeviceMetricsOverride', { width: 1152, height: 720, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: TARGET + (TARGET.includes('?') ? '&' : '?') + 'cb=' + Date.now() });
await sleep(6000);
await evaluate(`document.getElementById('start')?.click(); 'ok'`);
await sleep(1500);
/* 合成一次姿态事件让对齐完成（headless 没有真陀螺仪） */
await evaluate(`(() => { const e = new Event('deviceorientation'); e.alpha = 0; e.beta = 55; e.gamma = 25; dispatchEvent(e); return 'ok'; })()`);
await sleep(800);

console.log('=== 页面状态 ===');
console.log('typeof __gyro        :', (await evaluate('typeof window.__gyro')).result.value);
/* 注意：`R` 是页面内部对象，【没有】挂到 __gyro 上。
   想判断「地形是否加载完」，看 arAnchors.length 就够了 —— 锚点是在
   buildTerrain() 之后由 buildSites() 建的。 */
console.log('camPos               :', JSON.stringify(await evalJson('window.__gyro.camPos')));
console.log('params               :', JSON.stringify(await evalJson('window.__gyro.params')));
console.log('anchors.length       :', (await evalJson('window.__gyro.arAnchors.length')));
console.log('cullEnabled          :', (await evalJson('window.__gyro.arCullEnabled')));
console.log('console errors       :', consoleErrs.length ? consoleErrs : '（无）');

const anchors = await evalJson('window.__gyro.arAnchors');
console.log('\n=== 锚点（世界坐标）===');
const eye = await evalJson('window.__gyro.camPos');
for (const a of anchors.slice().sort((p, q) => p.pos.x - q.pos.x)) {
  /* 相对「看向中心」方向的水平角：正 = 偏左（相机前方为 -Z，左为 -X） */
  const ang = Math.atan2(-(a.pos.x - eye.x), (eye.z - a.pos.z)) * 180 / Math.PI;
  console.log(`  ${a.name.padEnd(6)} x=${a.pos.x.toFixed(3).padStart(7)} z=${a.pos.z.toFixed(3).padStart(7)}  `
    + `偏左角=${ang.toFixed(1).padStart(6)}°`);
}

console.log('\n=== 不同朝向下的可见集合 ===');
for (const yaw of [0, 20, -20, 45, -45, 90, -90, 180]) {
  await evaluate(`window.__gyro.aimAt(${yaw})`);
  await sleep(260);
  const st = await evalJson('({n: window.__gyro.arVisibleCount, cov: window.__gyro.arCoverage, list: window.__gyro.arAnchors})');
  const vis = st.list.filter(a => a.visible).map(a => a.name);
  const meanX = st.list.filter(a => a.visible).reduce((s, a) => s + a.pos.x, 0) / (vis.length || 1);
  console.log(`  yaw=${String(yaw).padStart(4)}°  可见 ${String(st.n).padStart(2)}/${st.list.length}  `
    + `覆盖 ${(st.cov * 100).toFixed(1).padStart(5)}%  可见均值x=${vis.length ? meanX.toFixed(3).padStart(7) : '   —   '}  [${vis.join(' ')}]`);
}

console.log('\n=== 视野多边形（yaw=0）===');
await evaluate(`window.__gyro.aimAt(0)`);
await sleep(260);
const poly = await evalJson('window.__gyro.arRegionPolygon');
console.log('  顶点数 =', poly.length);
console.log('  ' + poly.map(p => `(${p.x.toFixed(2)},${p.z.toFixed(2)})`).join(' '));

ws.close(); proc.kill();
process.exit(0);
