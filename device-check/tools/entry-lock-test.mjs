/**
 * 「进入时模型不能有旋转」回归测试 —— 零依赖，直连 Chrome CDP。
 *
 * 背景：
 *   真机录屏里「进入一瞬间模型转了一下」，根因不是对齐算法算错了，
 *   而是【延迟 1.2 秒再对齐】这个流程本身：
 *     对齐前：相机 = 固定视角（up = 世界竖直）
 *     对齐后：相机 = 设备视角（up = 设备 up）
 *   两套滚转约定不同，延迟多久用户就看着一个滚转不对的模型多久，然后看它转过去。
 *
 * 现在的约束（本测试锁住的三条）：
 *   ① 第一次拿到姿态就对齐，【没有延迟】
 *   ② 对齐前【不渲染模型】（不给用户看中间态）
 *   ③ 对齐那一刻【直接吸附】，不走 slerp（否则等于把跳变换成 140 ms 的滑动）
 *
 * 判定方式用【像素】而不是数字 —— 用户看到的症状是「转了一下」，
 * 那就直接比「对齐后第一帧」和「对齐后 0.9 秒那帧」是否逐像素相同。
 *
 * 用法：node tools/entry-lock-test.mjs <URL>
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CHROME = process.env.CHROME_PATH
  || String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`;
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const TARGET = process.argv[2];
const PORT = 9340;
const OUT = process.env.ENTRY_TEST_OUT || join(process.cwd(), '_entry');

if (!TARGET) { console.log('用法: node tools/entry-lock-test.mjs <URL>'); process.exit(1); }
mkdirSync(OUT, { recursive: true });

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

const evaluate = (expression) => send('Runtime.evaluate', { expression, returnByValue: true, userGesture: true });
const state = async () => JSON.parse((await evaluate(`JSON.stringify(window.__gyro.state)`)).result.value);
const quat = async () => JSON.parse((await evaluate(`JSON.stringify(window.__gyro.camQuat)`)).result.value);

let shotN = 0;
async function shot(name) {
  const s = await send('Page.captureScreenshot', { format: 'png' });
  const f = join(OUT, `_${name}.png`);
  writeFileSync(f, Buffer.from(s.data, 'base64'));
  return f;
}
/* 用 ffmpeg 的 psnr 滤镜比较两张图；完全相同 → Infinity。
   ⚠️ 必须用【异步 spawn】，不能用 spawnSync / execFileSync / execSync ——
   实测（Windows + Node 22 + 受限沙箱）里，三种【同步】创建子进程的 API 都会
   返回 `EBUSY`（status=null、stderr 为空），于是正则匹配不到 `average:`，
   psnr() 静默返回 NaN → 4 项判定全红，**看起来像「画面坏了」，其实是探针失效**。
   异步 spawn 正常（本脚本启动 Chrome 用的也是它）。
   教训：探针的失败必须能和被测对象的失败区分开 —— 所以每个判定都先要求
   Number.isFinite()，NaN 一律判失败而不是「碰巧满足」。 */
function psnr(a, b) {
  return new Promise((resolve) => {
    const p = spawn(FFMPEG, [
      '-i', a, '-i', b, '-lavfi', 'psnr', '-f', 'null', '-',
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', () => resolve(NaN));
    p.on('close', () => {
      const m = /average:([\d.]+|inf)/.exec(err);
      resolve(m ? (m[1] === 'inf' ? Infinity : Number(m[1])) : NaN);
    });
  });
}

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1152, height: 720, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: TARGET });
await sleep(4500);
await evaluate(`document.getElementById('start')?.click(); 'ok'`);
await sleep(1500);

/* 只藏会让两张截图必然不同的东西，其余 UI 保留：
   - 相机视频：滚动的假相机图案
   - 顶部状态条：帧率数字每帧都在变
   - flash 提示气泡：有存活时间，会在两张截图之间自己消失（这个坑踩过一次，
     PSNR 卡在 29 dB 上不去，查了半天才发现是气泡没了） */
await evaluate(`(() => {
  for (const id of ['cam', 'topbar', 'flash', 'alignhint']) {
    const el = document.getElementById(id); if (el) el.style.display = 'none';
  }
  return 'ok';
})()`);
await sleep(300);

console.log('=== 进入锁定测试 ===\n');
const checks = [];
const chk = (name, pass, detail) => checks.push({ name, pass, detail });

/* ---------- ① 对齐前：不渲染模型 ---------- */
const s0 = await state();
await sleep(400);
const s0b = await state();
const preShot = await shot('pre');
console.log(`对齐前：aligned=${s0.aligned}  clearedFrames ${s0.clearedFrames} → ${s0b.clearedFrames}`);
chk('对齐前不渲染模型（只清屏）', s0b.clearedFrames > s0.clearedFrames + 5,
  `清屏帧数持续增长 ${s0.clearedFrames} → ${s0b.clearedFrames}`);
chk('对齐前 aligned=false', s0.aligned === false, `aligned=${s0.aligned}`);

/* ---------- ② 第一次姿态事件后立刻对齐（没有 1200 ms 延迟）---------- */
const tEvent = Date.now();
await evaluate(`(() => {
  const e = new Event('deviceorientation');
  e.alpha = 0; e.beta = 55; e.gamma = 25;      // 带侧倾的姿态
  dispatchEvent(e);
  return 'ok';
})()`);
await sleep(250);                                 // 旧实现要等 1200 ms 才会对齐
const s1 = await state();
const elapsed = Date.now() - tEvent;
console.log(`\n首次姿态事件后 ${elapsed} ms：aligned=${s1.aligned}  alignCount=${s1.alignCount}`);
chk('首次姿态事件后 250 ms 内已完成对齐（无延迟）', s1.aligned === true && s1.alignCount === 1,
  `aligned=${s1.aligned} alignCount=${s1.alignCount} (${elapsed} ms)`);

/* ---------- ③ 对齐那一刻直接吸附：第一帧 == 0.9 秒后的那一帧 ---------- */
const t1Shot = await shot('t1');
const q1 = await quat();
await sleep(900);
const t2Shot = await shot('t2');
const q2 = await quat();
const p12 = await psnr(t1Shot, t2Shot);
const dq = Math.hypot(q1.x - q2.x, q1.y - q2.y, q1.z - q2.z, q1.w - q2.w);
console.log(`\n对齐后第一帧 vs 0.9 s 后：PSNR=${p12}  四元数差=${dq.toFixed(6)}`);
chk('对齐后姿态不漂移（没有 slerp 滑动）', p12 === Infinity || p12 >= 45,
  `PSNR=${p12 === Infinity ? '∞（逐像素相同）' : p12.toFixed(2) + ' dB'}`);

/* ---------- ④ 模型确实是在「对齐那一刻」出现的（对齐前是空画面）---------- */
const pPre = await psnr(preShot, t1Shot);
console.log(`\n对齐前 vs 对齐后第一帧：PSNR=${pPre}`);
chk('模型在对齐那一刻才出现（对齐前是空画面）', Number.isFinite(pPre) && pPre < 30,
  `PSNR=${pPre.toFixed(2)} dB`);

/* ---------- ⑤ 模型锁定在世界里：同一个设备姿态 → 同一个画面 ---------- */
const feed = (a, b, g) => evaluate(`(() => {
  const e = new Event('deviceorientation');
  e.alpha = ${a}; e.beta = ${b}; e.gamma = ${g};
  dispatchEvent(e);
  return 'ok';
})()`);

await feed(0, 40, 10);                            // 换个姿态
await sleep(2000);                                // 等姿态平滑（τ=140 ms）完全收敛
const t3Shot = await shot('t3');
const p23 = await psnr(t2Shot, t3Shot);

await feed(0, 55, 25);                            // 转回原姿态
await sleep(2000);
const t4Shot = await shot('t4');
const p24 = await psnr(t2Shot, t4Shot);

console.log(`\n换姿态后 PSNR(旧,新)=${p23}   转回原姿态 PSNR(原,回)=${p24}`);
chk('转动设备时画面确实跟着变（不是被冻住）', Number.isFinite(p23) && p23 < 30,
  `PSNR=${p23.toFixed(2)} dB`);
chk('同一设备姿态 → 同一画面（模型锁在世界里，不是跟设备走）',
  p24 === Infinity || p24 >= 40,
  `PSNR=${p24 === Infinity ? '∞（逐像素相同）' : p24.toFixed(2) + ' dB'}`);

console.log('\n=== 判定 ===');
let failed = 0;
for (const c of checks) {
  console.log((c.pass ? '  [PASS] ' : '  [FAIL] ') + c.name + '   (' + c.detail + ')');
  if (!c.pass) failed++;
}
console.log(failed === 0
  ? '\n全部通过 ✅ —— 进入时模型直接出现在最终姿态，之后锁在世界里'
  : `\n${failed} 项未通过 ❌`);

ws.close(); proc.kill();
process.exit(failed === 0 ? 0 : 1);
