/**
 * 桌面演示路径：验证「相机打不开」时不是死路，并出图让人真看见效果。
 *
 * 为什么单独一个脚本（而不是并进 ar-shots.mjs）：
 *   ar-shots.mjs 传了 `--use-fake-device-for-media-stream`，headless 里相机
 *   【一定成功】，于是 `#nocam` 分支永远走不到 —— 恰恰是我这次要验证的那条。
 *   这里【故意不注入假摄像头】，让 getUserMedia 真失败，把降级路径走通。
 *
 * 验证项：
 *   1. 相机失败时页面不空白：出现「无相机继续」出口，而不是卡在 loading
 *   2. 点它之后地形 / 标注 / HUD 真的渲染出来（帧率 > 0、锚点有投影）
 *   3. 3 秒无陀螺仪兜底会自动打开「拖动转视角」
 *   4. 拖动/方向键（nudgeLook）确实改变朝向，且标注随朝向此消彼长
 *   5. 转向沙盘外侧时标注全部消失（不是「一直显示」）
 *   6. resetLook / setManualLook(false) 能干净回退
 *
 * 输出：tools/_ar/desk-*.png
 * 用法：node tools/ar-desktop-shots.mjs [URL]
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
const PORT = 9361;
mkdirSync(OUT, { recursive: true });

let fails = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) fails++;
};

const proc = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--user-data-dir=' + join(tmpdir(), 'wb-cdp-' + PORT),
  '--ignore-certificate-errors', '--autoplay-policy=no-user-gesture-required',
  /* ⚠️ 这里【没有】--use-fake-device-for-media-stream，是故意的。 */
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
const consoleErrors = [];
ws.addEventListener('message', ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') {
    consoleErrors.push(m.params?.exceptionDetails?.exception?.description
      || m.params?.exceptionDetails?.text || 'exception');
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    consoleErrors.push((m.params.args || []).map(a => a.value ?? a.description).join(' '));
  }
});
const evaluate = (expression) => send('Runtime.evaluate', {
  expression, returnByValue: true, awaitPromise: true, userGesture: true,
});
const evalJson = async (expr) => {
  const r = await evaluate(`JSON.stringify(${expr})`);
  try { return JSON.parse(r.result.value); } catch (e) { return null; }
};
const shot = async (name) => {
  const s = await send('Page.captureScreenshot', { format: 'png' });
  const f = join(OUT, `desk-${name}.png`);
  writeFileSync(f, Buffer.from(s.data, 'base64'));
  return f;
};

await send('Runtime.enable');
await send('Page.enable');
await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Emulation.setDeviceMetricsOverride', { width: 1152, height: 720, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: TARGET + (TARGET.includes('?') ? '&' : '?') + 'cb=' + Date.now() });
await sleep(6000);

console.log('=== 桌面演示路径（无相机 / 无陀螺仪）===\n');

/* --- 1. 点「进入」，相机应当失败，且不是死路 --- */
await evaluate(`document.getElementById('start')?.click(); 'ok'`);
await sleep(4000);
const camState = await evalJson(`(() => {
  const n = document.getElementById('nocam');
  const l = document.getElementById('loading');
  const p = document.getElementById('precheck');
  return { nocamShown: !!n && n.style.display !== 'none',
           loadingOn: !!l && l.classList.contains('on'),
           startDisabled: document.getElementById('start')?.disabled,
           precheckHasFail: !!p && /失败/.test(p.textContent || '') };
})()`);
check('相机失败时给出「无相机继续」出口', camState?.nocamShown === true, JSON.stringify(camState));
check('失败时不再卡在 loading', camState?.loadingOn === false);
check('失败时「进入」按钮可再次点击（没被永久禁用）', camState?.startDisabled === false);

/* --- 2. 走降级路径 --- */
await evaluate(`document.getElementById('nocam').click(); 'ok'`);
await sleep(6000);
const alive = await evalJson(`(() => {
  const g = window.__gyro;
  if (!g) return { err: 'no __gyro' };
  return { camOk: g.cameraTestOk, frames: g.state.totalFrames, anchors: g.arAnchors.length,
           hasCanvas: !!document.querySelector('canvas'),
           barOn: document.getElementById('bar')?.classList.contains('on') };
})()`);
check('降级后 __gyro 可用、渲染循环在跑', (alive?.frames ?? 0) > 0, `frames=${alive?.frames}`);
check('相机确实没出图（走的是降级路径）', alive?.camOk === false, `cameraTestOk=${alive?.camOk}`);
check('地形与标注已建好（11 个锚点）', alive?.anchors === 11, `anchors=${alive?.anchors}`);
check('底部操作条已出现', alive?.barOn === true);

/* --- 3. 无陀螺仪兜底应自动开启「拖动转视角」--- */
const lookAuto = await evalJson(`(() => {
  const g = window.__gyro;
  return { manual: g.manualLookOn, angles: g.lookAngles,
           btn: document.getElementById('b-look')?.textContent,
           bodyCls: document.body.classList.contains('look-mode'),
           hintShown: getComputedStyle(document.getElementById('lookhint')).display !== 'none' };
})()`);
check('3 秒无陀螺仪 → 自动开启「拖动转视角」', lookAuto?.manual === true, JSON.stringify(lookAuto));
check('按钮文案同步为「开」', /开$/.test(lookAuto?.btn || ''), lookAuto?.btn);
check('body 带上 look-mode（光标变抓取）', lookAuto?.bodyCls === true);
check('屏内出现操作提示条', lookAuto?.hintShown === true);

await shot('01-auto-look');

/* --- 4. 拖动（nudgeLook 就是拖动/方向键走的同一条路）确实改变朝向 ---
   先扫一遍找「边界」：从 11 个全显示到 0 个之间必然有一段【部分可见】。
   那一段才是「转向哪边只显示哪边」最有说服力的画面 ——
   只看 0° 和 60° 两个点的话，效果看起来像「要么全有要么全无」，
   反而会让人怀疑中间是不是也在全量渲染。 */
const toYaw = async (targetYaw) => {
  await evaluate(`window.__gyro.setManualLook(true); 'ok'`);
  await evaluate(`(() => { const g = window.__gyro; g.resetLook();
    const a = g.lookAngles; g.nudgeLook(${targetYaw} - a.yawDeg, 0); return 'ok'; })()`);
  await sleep(400);
  return evalJson(`(() => { const g = window.__gyro;
    return { yaw: g.lookAngles.yawDeg, n: g.arVisibleCount, cov: g.arCoverage,
             vis: g.arAnchors.filter(a=>a.visible).map(a=>a.name) }; })()`);
};

console.log('      —— 朝向扫描（找「部分可见」区间）——');
const scan = [];
for (let y = 0; y <= 90; y += 5) {
  const st = await toYaw(y);
  scan.push({ targetYaw: y, ...st });
  const bar = '█'.repeat(st.n) + '·'.repeat(11 - st.n);
  console.log(`      yaw=${String(y).padStart(3)}°  [${bar}] ${String(st.n).padStart(2)}/11  覆盖 ${(st.cov * 100).toFixed(1)}%`);
}
const partial = scan.filter(s => s.n > 0 && s.n < 11);
const zero = scan.find(s => s.n === 0);
check('存在「部分可见」的中间朝向（不是全有/全无）', partial.length > 0,
  partial.length ? `yaw=${partial.map(s => s.targetYaw).join(',')}° 区间` : '未出现部分可见');
check('朝向改变 → 可见标注单调减少（无「转过去反而更多」的抖动）',
  scan.every((s, i) => i === 0 || s.n <= scan[i - 1].n),
  '可见数：' + scan.map(s => s.n).join(' '));
check('转到一定角度后标注全部消失', !!zero, zero ? `yaw≥${zero.targetYaw}° 起为 0` : '（未出现 n=0）');

/* 出图：全显示 / 部分可见 / 全消失，三张就够说明问题 */
const shots = [
  { name: '01-all', st: scan[0], note: '全显示' },
  { name: '02-partial', st: partial[Math.floor(partial.length / 2)] || scan[0], note: '部分可见' },
  { name: '03-none', st: zero || scan[scan.length - 1], note: '全消失' },
];
console.log('\n      —— 出图 ——');
for (const { name, st, note } of shots) {
  await toYaw(st.targetYaw);
  const f = await shot(name);
  console.log(`      ${note.padEnd(5)} yaw=${String(st.targetYaw).padStart(3)}°  可见 ${st.n}/11  覆盖 ${(st.cov * 100).toFixed(1)}%  → ${f}`);
  if (st.vis.length) console.log(`              ${st.vis.join(' ')}`);
}

/* --- 5. 关闭 / 回正 --- */
const back = await evalJson(`(() => { const g = window.__gyro;
  g.resetLook();
  const a = g.lookAngles;
  g.setManualLook(false);
  return { afterResetYaw: a.yawDeg, manual: g.manualLookOn,
           override: g.overrideActive, btn: document.getElementById('b-look')?.textContent }; })()`);
check('resetLook 把 yaw 归零', Math.abs(back?.afterResetYaw ?? 1e9) < 1e-6, `yaw=${back?.afterResetYaw}`);
check('setManualLook(false) 释放姿态覆盖（交还陀螺仪）', back?.manual === false && back?.override === false,
  JSON.stringify(back));

check('全程无控制台报错', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

console.log(`\n${fails === 0 ? '全部通过 ✅' : fails + ' 项未通过 ❌'}   截图目录：${OUT}`);
ws.close(); proc.kill();
process.exit(fails === 0 ? 0 : 1);
