/**
 * 陀螺仪「静止漂移」算法回归测试 —— 零依赖，直连 Chrome CDP。
 *
 * 为什么需要它：
 *   真实陀螺仪漂移只能靠真机测，但**算法本身是否正确**可以在无头环境里用
 *   合成 deviceorientation 事件验证。而算法恰恰是最容易写错的地方 ——
 *   曾经把「用户转动平板」当成「漂移」，报出 -3.9 °/min 的假数字。
 *
 * 做法：注入一条时间线，用 setInterval 按真实 16 ms 间隔派发事件：
 *   阶段 A（0–6.0 s）：alpha 以 0.1 °/min 缓慢变化  → 应判为【静止】，计入漂移
 *   阶段 B（6.0–9.5 s）：alpha 以 30 °/s 快速变化   → 应判为【转动】，不计入漂移
 *
 * 期望：
 *   stillMs  ≈ 6000      movingMs ≈ 3500
 *   stillDriftDeg ≈ 0.01  staticDriftPerMin ≈ 0.1
 *
 * 用法：node tools/gyro-drift-test.mjs "https://127.0.0.1:8443/ar-gyro-demo.html"
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`;
const TARGET = process.argv[2];
const PORT = 9335;
const STILL_SEC = 6.0;      // 阶段 A 时长
const MOVE_DPS = 30;        // 阶段 B 角速度
const TOTAL_SEC = 9.5;

if (!TARGET) { console.log('用法: node tools/gyro-drift-test.mjs <URL>'); process.exit(1); }

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

/* 页面必须先把 AR 跑起来 —— __gyro 出口是在模块里定义的，
   而模块里的 onOrient 只在启动后才会被事件驱动。 */
await send('Runtime.evaluate', {
  expression: `document.getElementById('start')?.click(); 'clicked'`,
  returnByValue: true, userGesture: true,
});
await sleep(2500);

const hasHook = await send('Runtime.evaluate', {
  expression: `typeof window.__gyro === 'object' && window.__gyro !== null`,
  returnByValue: true,
});
if (!hasHook.result || !hasHook.result.value) {
  console.log('HOOK_MISSING —— 页面里没有 window.__gyro 调试出口，无法验证');
  ws.close(); proc.kill(); process.exit(1);
}

/* ---------- 注入时间线 ---------- */
await send('Runtime.evaluate', {
  expression: `(() => {
    window.__fired = 0;
    window.__t0 = performance.now();
    const fire = (a, b, g) => {
      /* 用普通 Event + 挂属性，比 new DeviceOrientationEvent 更可靠 */
      const e = new Event('deviceorientation');
      e.alpha = a; e.beta = b; e.gamma = g;
      dispatchEvent(e);
      window.__fired++;
    };
    window.__iv = setInterval(() => {
      const el = (performance.now() - window.__t0) / 1000;
      let a;
      if (el < ${STILL_SEC}) {
        a = 0.1 * (el / 60);                       // 0.1 °/min 缓慢漂移
      } else {
        a = 0.1 * (${STILL_SEC} / 60) + ${MOVE_DPS} * (el - ${STILL_SEC});  // 快速转动
      }
      fire(a, 0, 0);
    }, 16);
    return 'started';
  })()`,
  returnByValue: true,
});

console.log(`注入时间线：0–${STILL_SEC}s 静止漂移 0.1°/min，之后 ${MOVE_DPS}°/s 转动…`);
await sleep(TOTAL_SEC * 1000 + 700);

const r = await send('Runtime.evaluate', {
  expression: `(() => {
    clearInterval(window.__iv);
    const s = window.__gyro.state;
    const secs = (performance.now() - window.__t0) / 1000;
    return JSON.stringify({
      state: s,
      fired: window.__fired,
      elapsedSec: Number(secs.toFixed(2)),
      /* 旧算法的结果，用来对照它有多离谱 */
      oldWrongRatePerMin: Number((s.yawFromAlignDeg / (secs / 60)).toFixed(1)),
    }, null, 1);
  })()`,
  returnByValue: true,
});

const out = JSON.parse(r.result.value);
const s = out.state;

console.log('\n=== 结果 ===');
console.log(JSON.stringify(out, null, 1));

/* ---------- 判定 ---------- */
/* 转动样本的期望值必须按【实际】经过时长算：
   setInterval 在 headless 下会抖动，加上收尾的 sleep，实际总时长总比设定值长。 */
const expectMovingMs = Math.max(0, (out.elapsedSec - STILL_SEC) * 1000);

const checks = [];
function chk(name, pass, detail) { checks.push({ name, pass, detail }); }

chk('静止样本 ≈ 6 s', Math.abs(s.stillMs - STILL_SEC * 1000) < 700, `stillMs=${s.stillMs}`);
chk(`转动样本 ≈ ${(expectMovingMs / 1000).toFixed(1)} s（按实际时长 ${out.elapsedSec}s 推算）`,
  Math.abs(s.movingMs - expectMovingMs) < 700, `movingMs=${s.movingMs} 期望≈${expectMovingMs.toFixed(0)}`);
chk('静止漂移量 ≈ 0.01°', Math.abs(s.stillDriftDeg - 0.01) < 0.004, `stillDriftDeg=${s.stillDriftDeg}`);
chk('静止漂移率 ≈ 0.1 °/min',
  s.staticDriftPerMin !== null && Math.abs(s.staticDriftPerMin - 0.1) < 0.05,
  `staticDriftPerMin=${s.staticDriftPerMin}`);
chk('转动【没有】被算进漂移', s.movingMs > 2000 && Math.abs(s.stillDriftDeg) < 0.02,
  `stillDriftDeg=${s.stillDriftDeg} 而偏转已达 ${s.yawFromAlignDeg}°`);
chk('旧算法会严重虚高（反面对照）', Math.abs(out.oldWrongRatePerMin) > 50,
  `旧口径=${out.oldWrongRatePerMin} °/min`);

/* ================================================================
   场景 2：低功耗门控（复现真机问题）
   ================================================================
   真机实测：124 秒只有 102 个事件 = 0.82 Hz，平均间隔 1.22 秒。
   早期版本把 dt 上限卡在 0.6 秒，导致 94% 的样本被丢弃 ——
   124 秒里只累计到 7.4 秒静止样本，漂移结论完全不可信。
   这里用 1.2 秒间隔复现，验证放宽后的阈值能正确累计。 */
console.log('\n=== 场景 2：低功耗门控（1.2 s 间隔）===');

const base = JSON.parse((await send('Runtime.evaluate', {
  expression: `JSON.stringify(window.__gyro.state)`, returnByValue: true,
})).result.value);

const LP_SEC = 20, LP_INTERVAL = 1200;
await send('Runtime.evaluate', {
  expression: `(() => {
    window.__fired2 = 0;
    window.__t2 = performance.now();
    const fire = (a) => {
      const e = new Event('deviceorientation');
      e.alpha = a; e.beta = 0; e.gamma = 0;
      dispatchEvent(e); window.__fired2++;
    };
    window.__iv2 = setInterval(() => {
      const el = (performance.now() - window.__t2) / 1000;
      fire(0.1 * (el / 60));            // 0.1 °/min 缓慢漂移，全程都该判为静止
    }, ${LP_INTERVAL});
    return 'started';
  })()`,
  returnByValue: true,
});

await sleep(LP_SEC * 1000 + 500);
const after = JSON.parse((await send('Runtime.evaluate', {
  expression: `(() => {
    clearInterval(window.__iv2);
    return JSON.stringify({ state: window.__gyro.state, fired: window.__fired2 });
  })()`,
  returnByValue: true,
})).result.value);

const dStill = after.state.stillMs - base.stillMs;
const dDrift = after.state.stillDriftDeg - base.stillDriftDeg;
const dDropped = after.state.droppedN - base.droppedN;
const expectSec = LP_SEC;
console.log(`  派发 ${after.fired} 个事件（间隔 ${LP_INTERVAL} ms，共 ${LP_SEC} s）`);
console.log(`  静止样本增量 ${dStill.toFixed(1)} ms，丢弃增量 ${dDropped}`);
console.log(`  漂移量增量 ${dDrift.toFixed(4)}°`);

chk('低功耗间隔也能累计样本（不再被丢弃）',
  dStill > expectSec * 1000 * 0.85 && dDropped === 0,
  `stillMs +${dStill.toFixed(0)}（期望 ≈${expectSec * 1000}）· 丢弃 +${dDropped}`);
chk('低功耗下漂移量估算仍准确',
  Math.abs(dDrift - 0.1 * (expectSec / 60)) < 0.006,
  `+${dDrift.toFixed(4)}° 期望 ≈${(0.1 * expectSec / 60).toFixed(4)}°`);

/* ================================================================
   场景 3：姿态平滑是否真的在插值
   ================================================================
   低功耗下传感器 ~1 Hz，直接赋值会让视角一跳一跳。
   这里派发一个 90° 的突变，验证相机四元数不是瞬间到位。 */
console.log('\n=== 场景 3：姿态平滑插值 ===');

await send('Runtime.evaluate', {
  expression: `(() => {
    const e = new Event('deviceorientation');
    e.alpha = 90; e.beta = 0; e.gamma = 0;
    dispatchEvent(e);
    window.__qImmediate = window.__gyro.camQuat;
    return 'fired';
  })()`,
  returnByValue: true,
});

/* 等 600 ms（约 4 个时间常数），应该已经收敛 */
await sleep(600);
const settled = JSON.parse((await send('Runtime.evaluate', {
  expression: `(() => {
    const a = window.__qImmediate, b = window.__gyro.camQuat;
    const dot = Math.abs(a.x*b.x + a.y*b.y + a.z*b.z + a.w*b.w);
    const ang = 2 * Math.acos(Math.min(1, dot)) * 180 / Math.PI;
    return JSON.stringify({ movedDeg: ang, smoothMs: window.__gyro.params.smoothMs });
  })()`,
  returnByValue: true,
})).result.value);

console.log(`  突变后立即 vs 600 ms 后：姿态变化 ${settled.movedDeg.toFixed(1)}°（平滑时间常数 ${settled.smoothMs} ms）`);
chk('姿态平滑在生效（不是瞬间到位）',
  settled.movedDeg > 1 && settled.movedDeg < 180,
  `变化 ${settled.movedDeg.toFixed(1)}°`);

console.log('\n=== 判定 ===');
let failed = 0;
for (const c of checks) {
  console.log((c.pass ? '  [PASS] ' : '  [FAIL] ') + c.name + '   (' + c.detail + ')');
  if (!c.pass) failed++;
}
console.log(failed === 0 ? '\n全部通过 ✅' : `\n${failed} 项未通过 ❌`);

ws.close();
proc.kill();
process.exit(failed === 0 ? 0 : 1);

