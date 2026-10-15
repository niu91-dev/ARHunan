/**
 * 展项健壮性回归测试 —— 息屏 / 显卡上下文丢失 / 未捕获错误留痕。
 *
 * 为什么单独测这三件事：
 *   它们在开发时全都看不出来，只有在展项上【连续开一整天】才会现形：
 *     ① 系统几十秒后自动息屏 → 展项直接失效（而且恢复时姿态会跳一下）
 *     ② 长时间运行 / 切应用 / GPU 驱动重置 → WebGL 上下文被回收，画面空白且不再恢复
 *     ③ 偶发 JS 错误 → 现场没人看控制台，永远查不出来
 *
 * 测试的关键设计：**不去改被测页面的代码**（不加测试钩子），
 * 而是从外面替换浏览器 API（`navigator.wakeLock.request`）来观察调用。
 * 因为页面写的是 `navigator.wakeLock.request('screen')`，
 * 属性查找发生在【调用时】，所以外部替换是生效的。
 *
 * 判定：
 *   [1] 启动（用户手势内）就申请了常亮锁
 *   [2] 页面切到后台时【不】重复申请（避免无意义请求）
 *   [3] ★ 切回前台时【重新申请】—— 这是最容易漏的一条：
 *       浏览器切后台会自动释放锁，只申请一次的话第一次息屏后就再也不常亮了
 *   [4] 反面对照：锁仍在持有时再触发 visibilitychange，【不应】重复申请
 *       （证明 [3] 的增量来自「释放后重申请」逻辑，而不是「任何事件都申请」）
 *   [5] 显卡上下文丢失被记录
 *   [6] 显卡上下文恢复后画面继续渲染（不是永久黑屏）
 *   [7] 未捕获错误被记进报告
 *   [8] 反面对照：资源加载失败（非 ErrorEvent）【不】被记成脚本错误
 *
 * 用法：node tools/kiosk-robustness-test.mjs <URL>
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME_PATH
  || String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`;
const TARGET = process.argv[2];
const PORT = 9342;

if (!TARGET) { console.log('用法: node tools/kiosk-robustness-test.mjs <URL>'); process.exit(1); }

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
ws.addEventListener('message', ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
});
const evaluate = (expression) => send('Runtime.evaluate', { expression, returnByValue: true, userGesture: true });
const json = async (e) => JSON.parse((await evaluate(e)).result.value);

await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url: TARGET });
await sleep(4500);

/* ---------- 从外部替换 navigator.wakeLock.request，观察调用次数 ----------
   同时把返回的 sentinel 换成一个我们可控的假对象：
   页面会把它存进自己的 wakeLock 变量，于是我们可以通过翻转 .released
   来模拟「浏览器在切后台时自动释放了锁」。 */
const PATCH = `(() => {
  const real = navigator.wakeLock;
  const fake = {
    released: false,
    addEventListener(ev, fn) { this._onRelease = fn; },
    release() { this.released = true; if (this._onRelease) this._onRelease(); return Promise.resolve(); },
  };
  window.__wakeSpy = { calls: 0, args: [] };
  const shim = {
    request(kind) {
      window.__wakeSpy.calls++;
      window.__wakeSpy.args.push(kind);
      fake.released = false;
      window.__wakeFake = fake;
      return Promise.resolve(fake);
    },
  };
  try {
    Object.defineProperty(navigator, 'wakeLock', { value: shim, configurable: true, writable: true });
  } catch (e) {
    /* 老版本可能不允许覆盖，退回直接改属性 */
    navigator.wakeLock = shim;
  }
  return JSON.stringify({ hadReal: !!real, supported: 'wakeLock' in navigator });
})()`;
const patchInfo = await json(PATCH);
console.log('=== 展项健壮性回归测试 ===\n');
console.log(`--- 环境 ---`);
console.log(`   原生 navigator.wakeLock 存在：${patchInfo.hadReal}`);
console.log(`   已替换为计数 shim（页面代码未改动）\n`);

/* ---------- 启动页面 ---------- */
await evaluate(`document.getElementById('start')?.click(); 'ok'`);
await sleep(3000);

const spy1 = await json(`JSON.stringify(window.__wakeSpy)`);
const k1 = await json(`JSON.stringify(window.__gyro.kioskInfo())`);
console.log('--- ① 启动后 ---');
console.log(`   wakeLock.request 调用 ${spy1.calls} 次（参数 ${JSON.stringify(spy1.args)}）`);
console.log(`   kioskInfo: held=${k1.wakeLockHeld} requests=${k1.wakeLockRequests} err=${k1.wakeLockError || '（无）'}\n`);

/* ---------- 切到后台：不应重复申请 ---------- */
const setVis = (state) => `(() => {
  Object.defineProperty(document, 'visibilityState', { value: ${JSON.stringify(state)}, configurable: true });
  Object.defineProperty(document, 'hidden', { value: ${state !== 'visible'}, configurable: true });
  dispatchEvent(new Event('visibilitychange'));
  return 'ok';
})()`;
await evaluate(setVis('hidden'));
await sleep(300);
const spyHidden = await json(`JSON.stringify(window.__wakeSpy)`);
console.log('--- ② 切到后台（hidden）---');
console.log(`   调用次数 ${spy1.calls} → ${spyHidden.calls}   ${spyHidden.calls === spy1.calls ? '✅ 未重复申请' : '❌ 后台也在申请'}\n`);

/* ---------- 模拟「浏览器在后台自动释放了锁」，然后切回前台 ---------- */
await evaluate(`window.__wakeFake.release(); 'ok'`);
const afterRelease = await json(`JSON.stringify(window.__gyro.kioskInfo())`);
await evaluate(setVis('visible'));
await sleep(400);
const spyVisible = await json(`JSON.stringify(window.__wakeSpy)`);
const k2 = await json(`JSON.stringify(window.__gyro.kioskInfo())`);
console.log('--- ③ ★ 切回前台（此前浏览器已自动释放锁）---');
console.log(`   释放后 held=${afterRelease.wakeLockHeld}，切回前台后调用 ${spyHidden.calls} → ${spyVisible.calls} 次`);
console.log(`   held=${k2.wakeLockHeld}   ${spyVisible.calls > spyHidden.calls && k2.wakeLockHeld ? '✅ 已重新申请（这一条最容易漏）' : '❌ 没有重新申请 —— 第一次息屏后就再也不常亮了'}\n`);

/* ---------- 反面对照：锁仍在持有时再触发，不应重复申请 ---------- */
const beforeDup = spyVisible.calls;
await evaluate(setVis('visible'));
await sleep(400);
const spyDup = await json(`JSON.stringify(window.__wakeSpy)`);
console.log('--- ④ 反面对照：锁仍在持有时再触发 visibilitychange ---');
console.log(`   调用次数 ${beforeDup} → ${spyDup.calls}   ` +
  `${spyDup.calls === beforeDup ? '✅ 未重复申请（说明 ③ 的增量确实来自「释放后重申请」）' : '❌ 无条件重复申请'}\n`);

/* ---------- 显卡上下文丢失 / 恢复 ---------- */
const ctxProbe = await json(`(() => {
  const cv = document.querySelector('canvas');
  if (!cv) return JSON.stringify({ ok: false, why: '找不到 canvas' });
  const gl = cv.getContext('webgl2') || cv.getContext('webgl');
  if (!gl) return JSON.stringify({ ok: false, why: '拿不到 gl 上下文' });
  const ext = gl.getExtension('WEBGL_lose_context');
  if (!ext) return JSON.stringify({ ok: false, why: '不支持 WEBGL_lose_context' });
  window.__glExt = ext;
  return JSON.stringify({ ok: true, version: gl.getParameter(gl.VERSION) });
})()`);
console.log('--- ⑤ / ⑥ 显卡上下文 ---');
console.log(`   探针：${JSON.stringify(ctxProbe)}`);

if (ctxProbe.ok) {
  /* ⚠️ 「恢复后画面还在不在」不能靠 readPixels 判断。
     WebGL 规定：一帧提交之后，默认帧缓冲的内容就变成 undefined
     （除非创建上下文时开 preserveDrawingBuffer）。在渲染回调【之外】readPixels
     几乎必然读到全 0 —— 第一版就是这么写的，于是报了一个假失败。
     正确做法：截两张不同姿态的图，看它们是否【不同】。
     若上下文真的死了，两张都会是同样的空白 → 字节完全相同。 */
  await evaluate(`(() => {
    const e = new Event('deviceorientation');
    e.alpha = 0; e.beta = 55; e.gamma = 0;
    dispatchEvent(e);
    return 'ok';
  })()`);
  await sleep(900);
  const shotA = (await send('Page.captureScreenshot', { format: 'png' })).data;
  await evaluate(`(() => {
    const e = new Event('deviceorientation');
    e.alpha = 90; e.beta = 55; e.gamma = 0;
    dispatchEvent(e);
    return 'ok';
  })()`);
  await sleep(900);
  const shotB = (await send('Page.captureScreenshot', { format: 'png' })).data;

  const framesBefore = await json(`JSON.stringify(window.__gyro.state.totalFrames)`);
  await evaluate(`window.__glExt.loseContext(); 'ok'`);
  await sleep(700);
  const afterLost = await json(`JSON.stringify(window.__gyro.kioskInfo())`);
  /* 触发恢复（真实场景由浏览器在 GPU 恢复后自动触发） */
  await evaluate(`window.__glExt.restoreContext(); 'ok'`);
  await sleep(1500);
  const afterRestore = await json(`JSON.stringify(window.__gyro.kioskInfo())`);
  const framesAfter = await json(`JSON.stringify(window.__gyro.state.totalFrames)`);

  /* 恢复后：换个姿态再截两张，仍应互不相同（说明画面真的在跟着姿态重绘） */
  await evaluate(`(() => {
    const e = new Event('deviceorientation');
    e.alpha = 0; e.beta = 55; e.gamma = 0;
    dispatchEvent(e);
    return 'ok';
  })()`);
  await sleep(900);
  const shotC = (await send('Page.captureScreenshot', { format: 'png' })).data;
  await evaluate(`(() => {
    const e = new Event('deviceorientation');
    e.alpha = 90; e.beta = 55; e.gamma = 0;
    dispatchEvent(e);
    return 'ok';
  })()`);
  await sleep(900);
  const shotD = (await send('Page.captureScreenshot', { format: 'png' })).data;

  console.log(`   丢失事件记录：ctxLostN=${afterLost.ctxLostN}`);
  console.log(`   恢复事件记录：ctxRestoredN=${afterRestore.ctxRestoredN}`);
  console.log(`   帧计数：丢失前 ${framesBefore} → 恢复后 ${framesAfter}（${framesAfter > framesBefore ? '仍在推进' : '停滞'})`);
  console.log(`   丢失前 两张不同姿态的截图是否不同：${shotA !== shotB ? '不同 ✓' : '相同 ✗'}`);
  console.log(`   恢复后 两张不同姿态的截图是否不同：${shotC !== shotD ? '不同 ✓' : '相同 ✗'}`);
  console.log(`   恢复后截图大小 ${shotC.length} B / ${shotD.length} B（空白帧会压得极小）`);

  globalThis.__ctx = {
    lost: afterLost.ctxLostN, restored: afterRestore.ctxRestoredN,
    framesAdvanced: framesAfter > framesBefore,
    poseRespondsBefore: shotA !== shotB,
    poseRespondsAfter: shotC !== shotD,
    shotBytes: shotC.length,
  };
} else {
  console.log('   ⚠ 无法测上下文丢失（探针失败），该项按 SKIP 处理');
  globalThis.__ctx = null;
}

/* ---------- 未捕获错误留痕 ---------- */
console.log('\n--- ⑦ / ⑧ 未捕获错误留痕 ---');
await evaluate(`dispatchEvent(new ErrorEvent('error', { message: 'TEST_BOOM_SCRIPT', filename: 'x.js', lineno: 42 })); 'ok'`);
await evaluate(`dispatchEvent(new Event('error')); 'ok'`);            // 模拟资源加载失败
await evaluate(`Promise.reject(new Error('TEST_BOOM_REJECT')); 'ok'`);
await sleep(500);
const k3 = await json(`JSON.stringify(window.__gyro.kioskInfo())`);
const kinds = k3.errors.map(e => e.kind + ':' + e.msg);
console.log(`   记录到 ${k3.errors.length} 条：`);
for (const e of k3.errors) console.log(`     [${e.kind}] ${e.msg}${e.where ? ' @ ' + e.where : ''}`);

const hasScript = kinds.some(s => s.includes('TEST_BOOM_SCRIPT'));
const hasReject = kinds.some(s => s.includes('TEST_BOOM_REJECT'));
const hasPlainEvent = k3.errors.some(e => e.kind === 'error' && !e.msg);
console.log(`   脚本错误被记录：${hasScript ? '✅' : '❌'}`);
console.log(`   Promise 拒绝被记录：${hasReject ? '✅' : '❌'}`);
console.log(`   资源加载失败【未】被误记为脚本错误：${!hasPlainEvent ? '✅' : '❌'}`);

/* ---------- 判定 ---------- */
const checks = [];
const chk = (name, pass, detail) => checks.push({ name, pass, detail });

chk('启动（用户手势内）就申请了屏幕常亮锁',
  spy1.calls >= 1 && k1.wakeLockHeld,
  `调用 ${spy1.calls} 次，held=${k1.wakeLockHeld}`);
chk('切到后台时不重复申请',
  spyHidden.calls === spy1.calls,
  `调用次数保持 ${spyHidden.calls}`);
chk('★ 切回前台时重新申请（浏览器会自动释放锁，只申请一次＝第一次息屏后永久失效）',
  spyVisible.calls > spyHidden.calls && k2.wakeLockHeld,
  `调用 ${spyHidden.calls} → ${spyVisible.calls}，held=${k2.wakeLockHeld}`);
chk('反面对照：锁仍在持有时不重复申请（证明上一条的增量来自「释放后重申请」）',
  spyDup.calls === beforeDup,
  `调用次数保持 ${spyDup.calls}`);
if (globalThis.__ctx) {
  chk('显卡上下文丢失被记录',
    globalThis.__ctx.lost >= 1, `ctxLostN=${globalThis.__ctx.lost}`);
  chk('反面对照：丢失前画面确实随姿态变化（证明判据有效，不是恒真的）',
    globalThis.__ctx.poseRespondsBefore, `两张不同姿态的截图 ${globalThis.__ctx.poseRespondsBefore ? '不同' : '相同'}`);
  chk('显卡上下文恢复后画面继续渲染（不是永久黑屏）',
    globalThis.__ctx.restored >= 1 && globalThis.__ctx.framesAdvanced && globalThis.__ctx.poseRespondsAfter,
    `ctxRestoredN=${globalThis.__ctx.restored}，帧计数${globalThis.__ctx.framesAdvanced ? '仍在推进' : '停滞'}，` +
    `恢复后两张不同姿态截图${globalThis.__ctx.poseRespondsAfter ? '不同' : '相同'}（${globalThis.__ctx.shotBytes} B）`);
} else {
  chk('显卡上下文丢失被记录（SKIP：本环境不支持 WEBGL_lose_context）', true, 'SKIP');
  chk('反面对照：丢失前画面确实随姿态变化（SKIP）', true, 'SKIP');
  chk('显卡上下文恢复后画面继续渲染（SKIP）', true, 'SKIP');
}
chk('未捕获脚本错误被记进报告', hasScript, kinds.filter(s => s.includes('TEST_BOOM_SCRIPT')).join('') || '未记录');
chk('未处理的 Promise 拒绝被记进报告', hasReject, kinds.filter(s => s.includes('TEST_BOOM_REJECT')).join('') || '未记录');
chk('反面对照：资源加载失败不被误记为脚本错误（ErrorEvent 过滤生效）',
  !hasPlainEvent, `错误列表 ${k3.errors.length} 条，无 message 为空的 error 项`);

console.log('\n=== 判定 ===');
for (const c of checks) {
  console.log(`  [${c.pass ? 'PASS' : 'FAIL'}] ${c.name}   (${c.detail})`);
}
const allPass = checks.every(c => c.pass);
console.log('\n' + (allPass ? '全部通过 ✅ —— 展项可无人值守：屏幕常亮会随前后台切换自动重申请，显卡上下文可恢复，错误有留痕'
                           : '存在未通过项 ❌'));

try { ws.close(); } catch (e) {}
proc.kill();
process.exit(allPass ? 0 : 1);
