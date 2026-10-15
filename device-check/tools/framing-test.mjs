/**
 * 取景几何回归测试 —— 零依赖，直连 Chrome CDP。
 *
 * 为什么需要它：
 *   「地形是否四角入画」是纯几何问题，但它极易算错 ——
 *   我最初用「相机到地形中心的距离」估张角，得出结论「65° 视场里有 16° 余量」，
 *   真机一跑地形直接撑出画面。原因：**俯视时近端角点比中心近得多**，
 *   它的张角远大于中心估算法给出的值。
 *
 * 本脚本用四组参数验证算法，包括「旧参数必须判为超出」这条反面对照。
 *
 * 用法：node tools/framing-test.mjs "https://127.0.0.1:8443/ar-gyro-demo.html"
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`;
const TARGET = process.argv[2];
const PORT = 9336;

if (!TARGET) { console.log('用法: node tools/framing-test.mjs <URL>'); process.exit(1); }

const proc = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  // 独立 profile —— 否则用户自己开着 Chrome 时会交接给已有实例、调试端口不生效
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
ws.addEventListener('message', ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
});

await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url: TARGET });
await sleep(4500);
await send('Runtime.evaluate', {
  expression: `document.getElementById('start')?.click(); 'ok'`,
  returnByValue: true, userGesture: true,
});
await sleep(2500);

/* 页面必须提供 window.__gyro 出口 */
const hasHook = await send('Runtime.evaluate', {
  expression: `typeof window.__gyro?.framingInfo === 'function'`,
  returnByValue: true,
});
if (!hasHook.result?.value) {
  console.log('HOOK_MISSING —— 页面没有 window.__gyro.framingInfo');
  ws.close(); proc.kill(); process.exit(1);
}

/* 用滑块设置参数，走完整链路（而不是直接改内部对象） */
const SET = (tableW, h, d, fov) => `(() => {
  const put = (id, val) => {
    const el = document.getElementById(id);
    el.value = val; el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  put('s-table', ${tableW});
  put('s-fov', ${fov});
  put('s-height', ${h});
  put('s-dist', ${d});
  return 'set';
})()`;

async function probe(label, tableW, h, d, fov) {
  await send('Runtime.evaluate', { expression: SET(tableW, h, d, fov), returnByValue: true });
  await sleep(400);
  const r = await send('Runtime.evaluate', {
    expression: `JSON.stringify({
      framing: window.__gyro.framingInfo(),
      params: window.__gyro.params,
      auto: window.__gyro.autoFrame(),
    })`,
    returnByValue: true,
  });
  const o = JSON.parse(r.result.value);
  console.log(`\n--- ${label} ---`);
  console.log(`  参数: 沙盘 ${tableW}m · 高 ${h}m · 距 ${d}m · 水平视场 ${fov}°`);
  console.log(`  取景: ok=${o.framing.ok}  水平比=${o.framing.hFrac}  垂直比=${o.framing.vFrac}  (${o.framing.axis} 最紧)`);
  console.log(`  自动取景解: ${o.auto ? '高 ' + o.auto.camHeight + ' m · 距 ' + o.auto.camDist + ' m' : '无解'}`);
  return o;
}

console.log('=== 取景几何测试 ===');

const checks = [];
function chk(name, pass, detail) { checks.push({ name, pass, detail }); }

/* 1. 当前默认值应四角入画 */
const a = await probe('默认参数', 1.8, 1.15, 2.35, 65);
chk('默认参数四角入画', a.framing.ok === true,
  `水平 ${a.framing.hFrac} / 垂直 ${a.framing.vFrac}`);

/* 2. 反面对照：旧默认值必须判为超出（证明算法真的在算角点） */
const b = await probe('旧默认参数（反面对照）', 1.8, 1.5, 1.3, 65);
chk('旧参数被判超出（反面对照）', b.framing.ok === false,
  `水平 ${b.framing.hFrac} / 垂直 ${b.framing.vFrac} —— 都 >1 才说明逐角点算法生效`);
chk('旧参数两个方向都超出', b.framing.hFrac > 1 && b.framing.vFrac > 1,
  `水平 ${b.framing.hFrac} / 垂直 ${b.framing.vFrac}`);

/* 3. 自动取景解出的参数，验证后必须真的四角入画 */
await send('Runtime.evaluate', {
  expression: `(() => {
    const f = window.__gyro.autoFrame();
    if (!f) return 'none';
    const put = (id, val) => {
      const el = document.getElementById(id);
      el.value = val; el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    put('s-height', f.camHeight); put('s-dist', f.camDist);
    return JSON.stringify(f);
  })()`,
  returnByValue: true,
});
await sleep(400);
const c = await send('Runtime.evaluate', {
  expression: `JSON.stringify(window.__gyro.framingInfo())`, returnByValue: true,
});
const ci = JSON.parse(c.result.value);
chk('自动取景解出的参数确实四角入画', ci.ok === true,
  `水平 ${ci.hFrac} / 垂直 ${ci.vFrac}`);

/* 4. 沙盘调大 → 需要的距离必须变远 */
const d1 = await probe('沙盘 1.8 m', 1.8, 1.15, 2.35, 65);
const d2 = await probe('沙盘 3.0 m', 3.0, 1.15, 2.35, 65);
chk('沙盘调大后自动取景距离变远',
  d2.auto && d1.auto && d2.auto.camDist > d1.auto.camDist,
  `${d1.auto?.camDist} m → ${d2.auto?.camDist} m`);

/* 5. 视场角调小 → 需要的距离必须变远（同样的场景，看得越窄站得越远） */
const e1 = await probe('视场 90°', 1.8, 1.15, 2.35, 90);
const e2 = await probe('视场 45°', 1.8, 1.15, 2.35, 45);
chk('视场角调小后自动取景距离变远',
  e2.auto && e1.auto && e2.auto.camDist > e1.auto.camDist,
  `${e1.auto?.camDist} m (90°) → ${e2.auto?.camDist} m (45°)`);

/* 6. 极端组合应给出「无解」而不是崩掉 */
const f = await probe('极端：沙盘 5 m + 视场 40°', 5.0, 1.15, 2.35, 40);
chk('极端组合返回无解而非崩溃', f.auto === null || f.auto.camDist > 0,
  `auto=${f.auto ? JSON.stringify(f.auto) : 'null'}`);

console.log('\n=== 判定 ===');
let bad = 0;
for (const c2 of checks) {
  console.log((c2.pass ? '  [PASS] ' : '  [FAIL] ') + c2.name + '   (' + c2.detail + ')');
  if (!c2.pass) bad++;
}
console.log(bad === 0 ? '\n全部通过 ✅' : `\n${bad} 项未通过 ❌`);

ws.close();
proc.kill();
process.exit(bad === 0 ? 0 : 1);
