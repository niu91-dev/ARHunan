/**
 * 现场判据回归测试 —— 「支架仰角安全吗」与「α 有绝对参考吗」。
 *
 * 为什么要有这两个判据：
 *   展项部署时有两个问题只能到现场才知道答案，而且都决定「要不要动手调整」：
 *     ① 支架仰角 β 到多少了？画面在任意 β 下都对，但 β→90° 时
 *        HUD 上的 α 派生读数会被 1/cos(β) 放大、开始乱跳，
 *        现场人员容易误判成「设备坏了」。
 *     ② `deviceorientation.alpha` 是绝对参考（地磁北）还是相对参考（任意起点）？
 *        绝对 → 长时间漂移有界，展项不用管；
 *        相对 → 零偏一直累积（实测约 0.1 °/min → 8 小时约 48°），必须定期归零。
 *   把这两个问题做成页面自带的判据，下次真机测试一轮就能答完，不用来回问。
 *
 * 测试要点：
 *   - 判据必须有【反面对照】：一个永远返回「安全 / 绝对」的判据毫无价值。
 *   - 「α 是否绝对」的判定需要设备【真的转过向】才有意义 ——
 *     一直不动时 offset 恒定是必然的，所以还要有「样本不足」这一档。
 *
 * 用法：node tools/field-verdict-test.mjs <URL>
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME_PATH
  || String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`;
const TARGET = process.argv[2];
const PORT = 9343;

if (!TARGET) { console.log('用法: node tools/field-verdict-test.mjs <URL>'); process.exit(1); }

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
await evaluate(`document.getElementById('start')?.click(); 'ok'`);
await sleep(2500);

/* 同时喂 deviceorientation 与（可选的）deviceorientationabsolute。
   absAlpha 传 null 表示「这个平台不发绝对事件」。 */
async function feed(a, b, g, absAlpha) {
  const absPart = absAlpha === null || absAlpha === undefined
    ? `/* 不发绝对事件 */`
    : `(() => { const e2 = new Event('deviceorientationabsolute');
                 e2.alpha = ${absAlpha}; e2.beta = ${b}; e2.gamma = ${g};
                 dispatchEvent(e2); })();`;
  await evaluate(`(() => {
    const e = new Event('deviceorientation');
    e.alpha = ${a}; e.beta = ${b}; e.gamma = ${g};
    dispatchEvent(e);
    ${absPart}
    return 'ok';
  })()`);
}
const tilt = () => json(`JSON.stringify(window.__gyro.standTiltVerdict())`);
const absv = () => json(`JSON.stringify(window.__gyro.alphaAbsoluteVerdict())`);

console.log('=== 现场判据回归测试 ===\n');

/* ================= ① 支架仰角判据 ================= */
console.log('--- ① 支架仰角 β 判据 ---');
console.log('   画面在任意 β 下都正确；这条判据是给「α 派生读数可不可信」用的\n');
const TILT_CASES = [
  { b: 0, want: 'ok', label: '屏幕平放' },
  { b: 30, want: 'ok', label: '微仰 30°' },
  { b: 60, want: 'ok', label: '典型支架 60°' },
  { b: 75, want: 'ok', label: '较陡支架 75°' },
  { b: 80, want: 'ok', label: '临界 80°（建议上限）' },
  { b: 82, want: 'warn', label: '超限 82°' },
  { b: 88, want: 'unsafe', label: '近竖直 88°' },
  { b: 90, want: 'unsafe', label: '完全竖直 90°（万向锁）' },
  { b: -70, want: 'ok', label: '倒扣 -70°（取绝对值）' },
];
const tiltRows = [];
for (const c of TILT_CASES) {
  await feed(45, c.b, 0, null);
  await sleep(120);
  const v = await tilt();
  const pass = v.verdict === c.want;
  tiltRows.push({ ...c, got: v.verdict, label2: v.label, amp: v.amp, pass });
  console.log(`   ${c.label.padEnd(22)} β=${String(c.b).padStart(4)}°  判定 ${String(v.verdict).padEnd(8)} ` +
    `期望 ${c.want.padEnd(8)} ${pass ? '✅' : '❌'}   ${v.label}`);
}
/* 反面对照：如果判据恒返回 ok，上面 82°/88°/90° 三条就会红 —— 说明它真的在分辨 */
const tiltDiscriminates = tiltRows.some(r => r.got !== 'ok') && tiltRows.some(r => r.got === 'ok');

/* 放大倍数是否符合 1/cos(β) */
console.log('\n   放大倍数核对（应等于 1/cos(β)）：');
let ampWorst = 0;
for (const c of [{ b: 60 }, { b: 75 }, { b: 80 }, { b: 82 }]) {
  await feed(45, c.b, 0, null);
  await sleep(120);
  const v = await tilt();
  const expect = 1 / Math.cos(c.b * Math.PI / 180);
  const err = Math.abs(v.amp - expect);
  ampWorst = Math.max(ampWorst, err);
  console.log(`     β=${String(c.b).padStart(3)}°  报告 ${String(v.amp).padStart(6)}  期望 ${expect.toFixed(3).padStart(6)}  差 ${err.toFixed(4)}`);
}

/* ================= ② α 参考系判据 ================= */
console.log('\n--- ② α 参考系判据（两者参考系是否一致）---');
console.log('   判据：offset = wrap(α_abs − α_dev) 的【均值大小】');
console.log('   ⚠️ 不是看 offset 是否恒定 —— 那区分不出来：');
console.log('      α_dev 若是相对的，它同样由陀螺积分得到，设备偏航时也一起变，');
console.log('      所以 offset 本来就是「两个参考系的固定差」，恒定是必然的。');
console.log('      能分辨的是 offset 的【大小】：都绝对 → 测同一个地磁北 → ≈0\n');

/* 场景 A：平台不发绝对事件 */
await evaluate(`location.reload(); 'ok'`);
await sleep(4500);
await evaluate(`document.getElementById('start')?.click(); 'ok'`);
await sleep(2500);
await feed(45, 60, 0, null);
await sleep(300);
const vA = await absv();
console.log(`   A 平台不发 deviceorientationabsolute → ${vA.verdict}  ${vA.verdict === 'no-absolute-event' ? '✅' : '❌'}`);
console.log(`     ${vA.label}`);

/* 场景 B：两者参考系一致（α_dev 与 α_abs 始终相同） */
await evaluate(`location.reload(); 'ok'`);
await sleep(4500);
await evaluate(`document.getElementById('start')?.click(); 'ok'`);
await sleep(2500);
{
  let a = 0;
  /* 先转动（此时不采 offset —— 角速度大），再静止（此时才采） */
  for (let i = 0; i < 20; i++) { a = (a + 14) % 360; await feed(a, 60, 0, a); await sleep(60); }
  for (let i = 0; i < 8; i++) { await feed(a, 60, 0, a); await sleep(60); }
}
const vB = await absv();
console.log(`\n   B 两者始终一致 → ${vB.verdict}  ${vB.verdict === 'same-reference' ? '✅' : '❌'}`);
console.log(`     ${vB.label}｜offset 均值 ${vB.meanOffsetDeg ?? '—'}° · 累计转向 ${vB.yawTravelledDeg ?? '—'}°`);

/* 场景 C：两者参考系不同（α_abs 始终比 α_dev 大 120°）—— 这才是「α_dev 非绝对」的证据 */
await evaluate(`location.reload(); 'ok'`);
await sleep(4500);
await evaluate(`document.getElementById('start')?.click(); 'ok'`);
await sleep(2500);
{
  let d = 0;
  for (let i = 0; i < 20; i++) { d = (d + 14) % 360; await feed(d, 60, 0, (d + 120) % 360); await sleep(60); }
  for (let i = 0; i < 8; i++) { await feed(d, 60, 0, (d + 120) % 360); await sleep(60); }
}
const vC = await absv();
console.log(`\n   C α_abs 恒比 α_dev 大 120°（= 参考系不同）→ ${vC.verdict}  ${vC.verdict === 'different-reference' ? '✅' : '❌'}`);
console.log(`     ${vC.label}｜offset 均值 ${vC.meanOffsetDeg ?? '—'}°`);

/* 场景 D：转过向但一直没静止 → 应给「样本不足」，不能瞎下结论 */
await evaluate(`location.reload(); 'ok'`);
await sleep(4500);
await evaluate(`document.getElementById('start')?.click(); 'ok'`);
await sleep(2500);
{
  let e2 = 0;
  for (let i = 0; i < 16; i++) { e2 = (e2 + 25) % 360; await feed(e2, 60, 0, e2); await sleep(60); }
}
const vD = await absv();
console.log(`\n   D 一直在转、没有静止样本 → ${vD.verdict}  ` +
  `${vD.verdict === 'insufficient' || vD.verdict === 'insufficient-yaw' ? '✅ 不瞎下结论' : '❌ 无样本却给了结论'}`);
console.log(`     ${vD.label}`);

/* 场景 E：静止但没转过向 → 也应给「样本不足」（offset≈0 可能只是因为没转向） */
await evaluate(`location.reload(); 'ok'`);
await sleep(4500);
await evaluate(`document.getElementById('start')?.click(); 'ok'`);
await sleep(2500);
for (let i = 0; i < 8; i++) { await feed(30, 60, 0, 30); await sleep(60); }
const vE = await absv();
console.log(`\n   E 静止但从未转向 → ${vE.verdict}  ` +
  `${vE.verdict === 'insufficient-yaw' ? '✅ 识别出「没转向无法区分」' : '❌ ' + vE.verdict}`);
console.log(`     ${vE.label}｜累计转向 ${vE.yawTravelledDeg ?? '—'}°`);

/* 场景 F：★ 回归 —— offset 缓慢漂过 ±180（样本会跨环绕）。
   这是审计时发现的一个真 bug：判据量原本用「offset 的算术平均」，
   而一组跨 ±180 的样本（约 +175 … −175）均值会抵消到 ≈0
   → 被误判成「参考系一致」。那是【危险方向】的错：
   用户会以为不用定期归零，实际模型会一直歪。
   改成用「偏离 0 最远的样本」后应当正确判成 different-reference。

   ⚠️ 构造这条用例时踩了一次：一开始让 offset 在 ±180 两侧【交替跳】，
      结果一个样本都没采到 —— 因为绝对事件的角速度超过了 2 °/s 的静止阈值。
      真实物理里 offset 跨 ±180 是【缓慢漂】过去的（相对 α 在漂、绝对的不漂），
      所以必须用小步长 + 足够的间隔让它被判成「静止」。 */
await evaluate(`location.reload(); 'ok'`);
await sleep(4500);
await evaluate(`document.getElementById('start')?.click(); 'ok'`);
await sleep(2500);
{
  /* 先快速转一大圈，满足「累计转向 ≥ 45°」这道闸 */
  let d = 0;
  for (let i = 0; i < 8; i++) { d = (d + 20) % 360; await feed(d, 60, 0, d); await sleep(60); }
  /* 然后 dev α 保持不动，让 abs α 以 0.5°/步 从 dev+170 缓慢漂到 dev+190
     （约 1.6 °/s < 2 °/s，仍判静止）。
     ★ 关键：让样本【对称地跨过 ±180】—— 前 21 个在 +170…+180，
       后 20 个在 −179.5…−170。这样算术平均会抵消到 ≈ +4.4°（落在 10° 阈值内），
       于是「用均值判」会错误地给出 same-reference，而「用最大偏离」给 180° → 正确。
       这才是一条能真正证明修正是必要的用例。 */
  for (let i = 0; i <= 40; i++) {
    await feed(d, 60, 0, (d + 170 + i * 0.5 + 360) % 360);
    await sleep(300);
  }
}
const vF = await absv();
console.log(`\n   F ★回归 offset 对称跨过 ±180（样本跨环绕，均值会抵消）→ ${vF.verdict}  ` +
  `${vF.verdict === 'different-reference' ? '✅ 未被环绕骗过' : '❌ 误判成 ' + vF.verdict}`);
console.log(`     最大偏离 ${vF.offsetMaxAbsDeg ?? '—'}°（正确证据）· 算术均值 ${vF.meanOffsetDeg ?? '—'}°` +
  `（若用均值判会得到 ${Math.abs(vF.meanOffsetDeg ?? 99) >= 10 ? 'different-reference' : 'same-reference ← 错的'}）`);

/* 场景 G：★ 回归 —— α 跨 0/360 环绕但实际几乎没转。
   判据量原本用「α 的 max − min」判断「有没有转过向」：
   α 从 358° 走到 2°（其实只转了 4°）→ min=2 / max=358 → 跨度 356°，
   会被当成「转过一大圈」而放行。改成累计路径长度后应正确判成「没转向」。 */
await evaluate(`location.reload(); 'ok'`);
await sleep(4500);
await evaluate(`document.getElementById('start')?.click(); 'ok'`);
await sleep(2500);
{
  for (let i = 0; i < 8; i++) { await feed(30, 60, 0, 30); await sleep(60); }   // 静止样本
  for (const a of [358, 0, 2]) { await feed(a, 60, 0, a); await sleep(60); }    // 只跨了 4°
}
const vG = await absv();
const naiveRange = 358 - 0;                      // 若用 max−min 会得到的「跨度」
console.log(`\n   G ★回归 α 跨 0/360 但实际只转了 4°（朴素 max−min 跨度 = ${naiveRange}°）`);
console.log(`     → ${vG.verdict}  ${vG.verdict === 'insufficient-yaw' ? '✅ 累计路径长度没被环绕骗过' : '❌ 误判成 ' + vG.verdict}`);
console.log(`     累计转向 ${vG.yawTravelledDeg ?? '—'}°（朴素算法会报 ${naiveRange}°）`);

/* ================= 判定 ================= */
const checks = [];
const chk = (name, pass, detail) => checks.push({ name, pass, detail });

chk('支架仰角判据：β ≤ 80° 判安全、82° 警告、88°/90° 判不安全',
  tiltRows.every(r => r.pass),
  tiltRows.filter(r => !r.pass).map(r => `β=${r.b}° 得到 ${r.got} 期望 ${r.want}`).join(' / ') || '9 个 β 全部符合');
chk('反面对照：仰角判据确实在分辨（不是恒返回「安全」）',
  tiltDiscriminates,
  `出现的判定值：${[...new Set(tiltRows.map(r => r.got))].join(' / ')}`);
chk('放大倍数 = 1/cos(β)',
  ampWorst < 0.01, `最大偏差 ${ampWorst.toFixed(4)}`);
chk('反面对照：倒扣姿态按 |β| 判定（-70° 判安全）',
  tiltRows.find(r => r.b === -70)?.pass === true, 'β=-70° → ok');
chk('平台不发绝对事件时给出 no-absolute-event（不瞎猜）',
  vA.verdict === 'no-absolute-event', vA.verdict);
chk('两者参考系一致（offset≈0）→ same-reference，且措辞标明「只是证据不是证明」',
  vB.verdict === 'same-reference' && /证据/.test(vB.hint),
  `${vB.verdict}，最大偏离 ${vB.offsetMaxAbsDeg ?? '—'}°`);
chk('反面对照：两者参考系不同（offset 恒 120°）→ different-reference',
  vC.verdict === 'different-reference', `${vC.verdict}，最大偏离 ${vC.offsetMaxAbsDeg ?? '—'}°`);
chk('样本不足时不下结论（一直在转、没有静止样本）',
  vD.verdict === 'insufficient' || vD.verdict === 'insufficient-yaw', vD.verdict);
chk('静止但没转向时识别出「无法区分参考系」',
  vE.verdict === 'insufficient-yaw', `${vE.verdict}，累计转向 ${vE.yawTravelledDeg ?? '—'}°`);
chk('★ 回归：offset 对称跨过 ±180（均值抵消到阈值内）仍判 different-reference',
  vF.verdict === 'different-reference' && Math.abs(vF.meanOffsetDeg) < 10,
  `${vF.verdict}｜最大偏离 ${vF.offsetMaxAbsDeg ?? '—'}° · 均值 ${vF.meanOffsetDeg ?? '—'}°` +
  `（若用均值判会错判成 same-reference）`);
chk('★ 回归：α 跨 0/360 但实际几乎没转 → 判「没转向」而不是被 max−min 骗过',
  vG.verdict === 'insufficient-yaw' && vG.yawTravelledDeg < 45,
  `${vG.verdict}｜累计转向 ${vG.yawTravelledDeg ?? '—'}°（朴素 max−min 会报 ${naiveRange}°）`);

console.log('\n=== 判定 ===');
for (const c of checks) {
  console.log(`  [${c.pass ? 'PASS' : 'FAIL'}] ${c.name}   (${c.detail})`);
}
const allPass = checks.every(c => c.pass);
console.log('\n' + (allPass ? '全部通过 ✅ —— 现场判据可用：仰角安全区与 α 参考系都能在真机上一轮测出'
                           : '存在未通过项 ❌'));

try { ws.close(); } catch (e) {}
proc.kill();
process.exit(allPass ? 0 : 1);
