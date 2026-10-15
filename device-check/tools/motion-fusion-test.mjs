/**
 * devicemotion 融合的【方向正确性】测试 —— 零依赖，直连 Chrome CDP。
 *
 * 为什么必须先测方向：
 *   `deviceorientation` 的 alpha/beta/gamma 是 Z-X'-Y'' 内旋欧拉角，
 *   而 `devicemotion` 的 rotationRate 是绕【设备本体轴】的角速度。
 *   两者的轴定义【不是一回事】，把 rotationRate 直接当欧拉角速率用
 *   （即 qBase 右乘一个由 rotationRate 构造的增量）在数学上是有前提的，
 *   方向或符号一旦搞反，融合会让姿态越转越歪 —— 比不加融合更糟。
 *
 * 所以这里用「设备平放」这个已知姿态做基准，喂已知角速度，检查旋转结果。
 *
 * 期望（设备平放屏幕朝上，alpha=beta=gamma=0，此时设备轴 = 世界轴）：
 *   绕设备 X 转 +90°  →  设备 Z 轴 (0,0,1) 变成 (0,-1,0)
 *   绕设备 Y 转 +90°  →  设备 Z 轴 (0,0,1) 变成 ( 1, 0,0)
 *   绕设备 Z 转 +90°  →  设备 Z 轴 (0,0,1) 保持 (0, 0,1)
 *
 * 用法：node tools/motion-fusion-test.mjs "https://127.0.0.1:8443/ar-gyro-demo.html"
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`;
const TARGET = process.argv[2];
const PORT = 9337;

if (!TARGET) { console.log('用法: node tools/motion-fusion-test.mjs <URL>'); process.exit(1); }

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

const hasHook = await send('Runtime.evaluate', {
  expression: `typeof window.__gyro?.feedMotion === 'function'`,
  returnByValue: true,
});
if (!hasHook.result?.value) {
  console.log('HOOK_MISSING —— 页面没有 window.__gyro.feedMotion');
  ws.close(); proc.kill(); process.exit(1);
}

/* 用页面里的三段逻辑跑一次：喂绝对姿态 → 喂角速度 → 读基座四元数。
   注意 feedMotion 的参数顺序是 (alpha, beta, gamma, dtSec)，
   而 alpha 绕设备 Z 轴、beta 绕设备 X 轴、gamma 绕设备 Y 轴 —— 别按 x/y/z 顺次传。 */
const RUN = (axis, degPerSec, dtSec) => `(() => {
  const fire = (a, b, g) => {
    const e = new Event('deviceorientation');
    e.alpha = a; e.beta = b; e.gamma = g;
    dispatchEvent(e);
  };
  /* 基准：设备平放屏幕朝上，此时设备轴 = 世界轴 */
  fire(0, 0, 0);
  const before = window.__gyro.baseQuat;
  /* 绕设备 X = rotationRate.beta，绕设备 Y = rotationRate.gamma，绕设备 Z = rotationRate.alpha */
  const rates = {
    x: [0, ${degPerSec}, 0],
    y: [0, 0, ${degPerSec}],
    z: [${degPerSec}, 0, 0],
  };
  const r = rates['${axis}'];
  const after = window.__gyro.feedMotion(r[0], r[1], r[2], ${dtSec});
  return JSON.stringify({ before, after });
})()`;

/* 纯 JS 四元数旋转向量（页面里的 THREE 在模块作用域，取不到） */
function rotateVec(q, v) {
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  return {
    x: v.x + q.w * tx + (q.y * tz - q.z * ty),
    y: v.y + q.w * ty + (q.z * tx - q.x * tz),
    z: v.z + q.w * tz + (q.x * ty - q.y * tx),
  };
}

const checks = [];
function chk(name, pass, detail) { checks.push({ name, pass, detail }); }

async function axisTest(axis, degPerSec, expect, label) {
  const r = await send('Runtime.evaluate', {
    expression: RUN(axis, degPerSec, 1.0), returnByValue: true,
  });
  const o = JSON.parse(r.result.value);
  const v = rotateVec(o.after, { x: 0, y: 0, z: 1 });
  const err = Math.hypot(v.x - expect[0], v.y - expect[1], v.z - expect[2]);
  console.log(`\n--- ${label} ---`);
  console.log(`  设备 Z 轴 (0,0,1) → (${v.x.toFixed(3)}, ${v.y.toFixed(3)}, ${v.z.toFixed(3)})`);
  console.log(`  期望              → (${expect.map(n => n.toFixed(3)).join(', ')})   误差 ${err.toFixed(4)}`);
  return err;
}

console.log('=== devicemotion 融合方向测试 ===');
/* 说明：页面里 onMotion 把 dt 限制在 0.1 s（防事件断流后一步跳太远），
   所以用 300 °/s × 0.1 s = 30° 作为测试量。 */
const S30 = Math.sin(Math.PI / 6);        // 0.5
const C30 = Math.cos(Math.PI / 6);        // 0.866

/* qBase 与设备本体系之间存在 q1 = Rx(-90°) 映射：
   设备 X 映射为 qBase 的 X，设备 Y 映射为 qBase 的 -Z，设备 Z 映射为 qBase 的 Y。
   因此在 qBase 坐标系中：
   绕设备 X 转动 → 绕 qBase X 轴旋转：(0,0,1) 变为 (0, -S30, C30)
   绕设备 Y 转动 → 绕 qBase -Z 轴旋转：(0,0,1) 保持 (0, 0, 1)
   绕设备 Z 转动 → 绕 qBase Y 轴旋转：(0,0,1) 变为 (S30, 0, C30) */
const eX = await axisTest('x', 300, [0, -S30, C30], '绕设备 X 轴 +300°/s × 0.1s（=30°）');
chk('绕 X 轴积分方向正确', eX < 0.02, `误差 ${eX.toFixed(4)}`);

const eY = await axisTest('y', 300, [0, 0, 1], '绕设备 Y 轴 +300°/s × 0.1s（绕 -Z 轴，Z 分量保持）');
chk('绕 Y 轴积分方向正确', eY < 0.02, `误差 ${eY.toFixed(4)}`);

const eZ = await axisTest('z', 300, [S30, 0, C30], '绕设备 Z 轴 +300°/s × 0.1s（绕 Y 轴旋转）');
chk('绕 Z 轴积分方向正确', eZ < 0.02, `误差 ${eZ.toFixed(4)}`);

/* 反向验证：负角速度应该朝反方向转 */
const eNeg = await axisTest('x', -300, [0, S30, C30], '绕设备 X 轴 -300°/s × 0.1s（反向）');
chk('负角速度方向正确', eNeg < 0.02, `误差 ${eNeg.toFixed(4)}`);

/* 累计一致性：分 10 步走完 30°，结果应与一步走完相同（验证四元数右乘的复合性） */
const stepRes = await send('Runtime.evaluate', {
  expression: `(() => {
    const fire = () => {
      const e = new Event('deviceorientation');
      e.alpha = 0; e.beta = 0; e.gamma = 0;
      dispatchEvent(e);
    };
    fire();
    for (let i = 0; i < 10; i++) window.__gyro.feedMotion(0, 30, 0, 0.1);   // 绕设备 X，每步 3°
    return JSON.stringify(window.__gyro.baseQuat);
  })()`,
  returnByValue: true,
});
const sv = rotateVec(JSON.parse(stepRes.result.value), { x: 0, y: 0, z: 1 });
const eStep = Math.hypot(sv.x - 0, sv.y - (-S30), sv.z - C30);
console.log(`\n--- 分 10 步各 30°/s×0.1s（合计 30°）---`);
console.log(`  设备 Z 轴 → (${sv.x.toFixed(3)}, ${sv.y.toFixed(3)}, ${sv.z.toFixed(3)})   期望 (0.000, ${(-S30).toFixed(3)}, ${C30.toFixed(3)})`);
chk('分步积分与单步结果一致', eStep < 0.02, `误差 ${eStep.toFixed(4)}`);

console.log('\n=== 判定 ===');
let failed = 0;
for (const c of checks) {
  console.log((c.pass ? '  [PASS] ' : '  [FAIL] ') + c.name + '   (' + c.detail + ')');
  if (!c.pass) failed++;
}
console.log(failed === 0
  ? '\n全部通过 ✅ —— 融合的轴映射与符号都正确'
  : `\n${failed} 项未通过 ❌ —— 融合方向有问题，应先关闭「运动融合」再修`);

ws.close();
proc.kill();
process.exit(failed === 0 ? 0 : 1);
