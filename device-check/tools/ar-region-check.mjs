/**
 * 检查各朝向下「视野多边形」是否越出沙盘圆周。
 * 用法：node tools/ar-region-check.mjs [URL]
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME_PATH
  || String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`;
const TARGET = process.argv[2] || 'http://127.0.0.1:8080/ar-gyro-demo.html';
const PORT = 9355;

const proc = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--user-data-dir=' + join(tmpdir(), 'wb-cdp-' + PORT),
  '--ignore-certificate-errors',
  /* ⚠️ 这两个 fake media 开关不能省：页面启动流程要开摄像头，
     拿不到流就会中断，于是地形、锚点全都不会建 ——
     现象是「锚点一直是 0」，和「AR 逻辑写错了」分不清。 */
  '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
  '--autoplay-policy=no-user-gesture-required',
  '--remote-debugging-port=' + PORT, '--window-size=1152,720', 'about:blank',
], { stdio: 'ignore' });

let ok = false;
for (let i = 0; i < 80; i++) {
  try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) { ok = true; break; } } catch (e) {}
  await sleep(250);
}
if (!ok) { console.log('CHROME_START_FAIL'); proc.kill(); process.exit(1); }

const tab = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(TARGET)}`, { method: 'PUT' })).json();
const ws = new WebSocket(tab.webSocketDebuggerUrl);
let msgId = 0; const pending = new Map();
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
const evaluate = (e) => send('Runtime.evaluate', { expression: e, returnByValue: true, userGesture: true });
const evalJson = async (e) => {
  const r = await evaluate(`JSON.stringify(${e})`);
  return r && r.result && r.result.value ? JSON.parse(r.result.value) : null;
};

await send('Runtime.enable');
await send('Page.enable');
await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });
/* 固定视口 —— 覆盖率对垂直视场角敏感，而垂直视场角由宽高比推出来。
   不固定的话，`--window-size` 给出的实际视口可能不是精确的 1152×720，
   于是同一朝向算出的覆盖率和测试脚本对不上（实测差 1.2%），
   看起来像「算法不稳定」，其实只是两个脚本的宽高比不同。 */
await send('Emulation.setDeviceMetricsOverride',
  { width: 1152, height: 720, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: TARGET + (TARGET.includes('?') ? '&' : '?') + 'cb=' + Date.now() });

/* ⚠️ 不能只 sleep 固定时长就点 start。
   `#start` 在地形加载完成前是 disabled 的，点它等于没点 ——
   于是渲染循环一直停在「对齐前只清屏」的早退分支，
   updateArVisibility() 从不执行，_arProj 还是单位阵，
   读出来就是【所有朝向 coverage 都是 0、多边形全空】。
   这个现象和「映射算错了」长得一模一样，很容易查错方向。
   所以：等按钮真的可用 + 等锚点建好，再点。 */
async function waitFor(expr, timeoutMs, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = await evaluate(`!!(${expr})`);
    if (r && r.result && r.result.value === true) return true;
    await sleep(250);
  }
  console.log(`⚠ 等待超时：${label}`);
  return false;
}

await waitFor(`document.getElementById('start') && !document.getElementById('start').disabled`,
  30000, '#start 可点击');
await evaluate(`document.getElementById('start').click(); 'ok'`);
await waitFor(`window.__gyro && window.__gyro.arAnchors && window.__gyro.arAnchors.length > 0`,
  20000, '锚点建立');
await evaluate(`(() => { const e = new Event('deviceorientation');
  e.alpha = 0; e.beta = 55; e.gamma = 25; dispatchEvent(e); return 'ok'; })()`);
await waitFor(`window.__gyro.state.aligned === true`, 10000, '对齐完成');
await sleep(400);

for (const yaw of [0, 20, 45, -20, -45, 60, -60, 90, 180]) {
  await evaluate(`window.__gyro.aimAt(${yaw})`);
  await sleep(400);
  const d = await evalJson(`({ poly: window.__gyro.arRegionPolygon,
    cov: window.__gyro.arCoverage, R: window.__gyro.params.tableW / 2 })`);
  if (!d) { console.log(`yaw=${yaw}  读取失败`); continue; }
  const radii = d.poly.map(p => Math.hypot(p.x, p.z));
  const maxR = radii.length ? Math.max(...radii) : 0;
  const over = radii.filter(r => r > d.R + 0.01).length;
  console.log(`yaw=${String(yaw).padStart(4)}°  n=${String(d.poly.length).padStart(3)}  `
    + `cov=${(d.cov * 100).toFixed(1).padStart(5)}%  maxR=${maxR.toFixed(3)} (R=${d.R})  `
    + `${over ? '❌ ' + over + ' 个顶点越界' : '✅ 全在圆内'}`);
}

ws.close(); proc.kill();
process.exit(0);
