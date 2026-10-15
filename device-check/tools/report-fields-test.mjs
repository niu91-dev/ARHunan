/**
 * 报告字段端到端测试 —— 「用户真机上最后点的那颗按钮」到底能不能用。
 *
 * 为什么必须有这一条：
 *   真机测试的最后一句话是「点『生成报告 JSON』发我」。
 *   但在此之前，所有测试都只验证判据【函数】本身（通过 `window.__gyro` 调试出口调用），
 *   **没有任何一条验证报告链路**：
 *     - `#b-report` 点了之后报告界面到底出没出来？
 *     - 报告 HTML 里那几行（支架仰角 / α 参考系 / 屏幕常亮 / 显卡上下文 / 未捕获错误）
 *       渲染的是不是**同一份数据**？（UI 读错变量是经典 bug）
 *     - `#r-json` 点完之后 `#r-out` 里是不是**合法 JSON**？
 *       （若 R 里混进了循环引用或 THREE 对象，`JSON.stringify` 会抛错，
 *         而抛错被 click 回调吞掉后，`#r-out` 会**静静地**停在占位文案上 ——
 *         用户看到的就是「点了没反应」）
 *     - `JSON.stringify` 会**静默丢弃**值为 `undefined` 的键。
 *       所以「字段全不全」不能靠肉眼看，必须断言键存在。
 *
 *   这些全都能在无头环境测出来，不需要真机。漏掉就是让用户白跑一趟。
 *
 * 测试要点：
 *   - 必须**交叉核对**：报告里的值要和 `__gyro` 调试出口的值一致（UI ↔ 数据）。
 *   - 必须**防空转**：断言 `#r-out` 确实从占位文案变成了 JSON，
 *     否则「JSON 里有 standTilt」这条断言可能只是在读一个从没被写过的元素。
 *
 * 用法：node tools/report-fields-test.mjs <URL>
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME_PATH
  || String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`;
const TARGET = process.argv[2];
const PORT = 9344;

if (!TARGET) { console.log('用法: node tools/report-fields-test.mjs <URL>'); process.exit(1); }

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

console.log('=== 报告字段端到端测试 ===\n');
console.log('   目标：真机上点「生成报告 JSON」产出的是【可用】的 ——');
console.log('   界面渲染的是同一份数据、JSON 合法、字段没被 stringify 静默丢掉。\n');

/* ================= 准备数据 =================
   喂一段能同时满足两个判据的样本：
   ① 先转动（满足「累计转向 ≥ 45°」这道闸）
   ② 再静止并持续发绝对事件（满足「静止样本 ≥ 5」）
   支架仰角取 60°（典型支架，判 ok） */
{
  let d = 0;
  for (let i = 0; i < 12; i++) { d = (d + 16) % 360; await feed(d, 60, 0, d); await sleep(60); }
  for (let i = 0; i < 8; i++) { await feed(d, 60, 0, d); await sleep(70); }
}

/* 真值来源：调试出口。报告必须与它一致 —— 这是 UI ↔ 数据的交叉核对。 */
const truth = {
  standTilt: await json(`JSON.stringify(window.__gyro.standTiltVerdict())`),
  alphaAbsolute: await json(`JSON.stringify(window.__gyro.alphaAbsoluteVerdict())`),
  kiosk: await json(`JSON.stringify(window.__gyro.kioskInfo())`),
};
console.log('   真值（来自 __gyro 调试出口）：');
console.log(`     支架仰角 → ${truth.standTilt.verdict}｜${truth.standTilt.label}`);
console.log(`     α 参考系 → ${truth.alphaAbsolute.verdict}｜${truth.alphaAbsolute.label}`);
console.log(`     常亮锁   → supported=${truth.kiosk.wakeLockSupported} held=${truth.kiosk.wakeLockHeld}\n`);

/* ================= ① 点「报告」→ 界面出来了吗 ================= */
const before = await json(`JSON.stringify({
  arActive: document.body.classList.contains('ar-active'),
  wrapDisplay: getComputedStyle(document.getElementById('start-wrap')).display,
})`);
await evaluate(`document.getElementById('b-report').click(); 'ok'`);
await sleep(600);

const after = await json(`JSON.stringify({
  arActive: document.body.classList.contains('ar-active'),
  wrapDisplay: getComputedStyle(document.getElementById('start-wrap')).display,
  hasJsonBtn: !!document.getElementById('r-json'),
  hasOut: !!document.getElementById('r-out'),
  hasCopyBtn: !!document.getElementById('r-copy'),
  hasBackBtn: !!document.getElementById('r-back'),
  outText: document.getElementById('r-out') ? document.getElementById('r-out').textContent : null,
  reportText: document.getElementById('start-wrap').innerText,
})`);

console.log('--- ① 报告界面 ---');
console.log(`   点之前：ar-active=${before.arActive} · wrap.display=${before.wrapDisplay}`);
console.log(`   点之后：ar-active=${after.arActive} · wrap.display=${after.wrapDisplay}`);

/* 报告 HTML 必须含那 5 行新字段 */
const NEED_ROWS = ['支架仰角', 'α 参考系', '屏幕常亮', '显卡上下文', '未捕获错误'];
const missingRows = NEED_ROWS.filter(k => !after.reportText.includes(k));

/* 「undefined」漏进界面是经典接线 bug —— 值没算出来却照样拼进字符串 */
const undefinedHits = (after.reportText.match(/undefined/g) || []).length;
/* NaN 同理：算错了不会抛错，只会安静地显示 NaN */
const nanHits = (after.reportText.match(/NaN/g) || []).length;

/* ================= ② 点「生成报告 JSON」→ 合法 JSON 吗 ================= */
const placeholder = after.outText;
await evaluate(`document.getElementById('r-json').click(); 'ok'`);
await sleep(400);
const outText = (await evaluate(`document.getElementById('r-out').textContent`)).result.value;

let report = null, parseErr = '';
try { report = JSON.parse(outText); } catch (e) { parseErr = e.message; }

console.log('\n--- ② 生成报告 JSON ---');
console.log(`   点击前 #r-out 是占位文案吗：${/点击/.test(placeholder || '') ? '是 ✅' : '否 ⚠️（' + String(placeholder).slice(0, 40) + '）'}`);
console.log(`   点击后 JSON 可解析：${report ? '是 ✅' : '否 ❌ ' + parseErr}`);
console.log(`   长度 ${outText ? outText.length : 0} 字符`);

/* 防空转：必须确认内容真的换了 —— 否则下面「JSON 里有 standTilt」可能只是在读一个
   从没被写过的元素（比如 click 回调抛错被吞掉，元素停在占位文案上）。 */
const contentChanged = !!outText && outText !== placeholder && outText !== '点击「生成报告 JSON」…';

/* ================= ③ 字段完整性 + 交叉核对 ================= */
const need = ['standTilt', 'alphaAbsolute', 'kiosk', 'pose', 'motion', 'terrain', 'viewport', 'framing'];
const missingKeys = report ? need.filter(k => !(k in report)) : need;

const xc = [];   // 交叉核对结果
if (report) {
  xc.push({
    name: '支架仰角 label',
    ui: report.standTilt && report.standTilt.label,
    truth: truth.standTilt.label,
  });
  xc.push({
    name: '支架仰角 verdict',
    ui: report.standTilt && report.standTilt.verdict,
    truth: truth.standTilt.verdict,
  });
  xc.push({
    name: 'α 参考系 verdict',
    ui: report.alphaAbsolute && report.alphaAbsolute.verdict,
    truth: truth.alphaAbsolute.verdict,
  });
  xc.push({
    name: 'α 参考系 offsetMaxAbs',
    ui: report.alphaAbsolute && report.alphaAbsolute.offsetMaxAbsDeg,
    truth: truth.alphaAbsolute.offsetMaxAbsDeg,
  });
  xc.push({
    name: 'α 参考系 累计转向',
    ui: report.alphaAbsolute && report.alphaAbsolute.yawTravelledDeg,
    truth: truth.alphaAbsolute.yawTravelledDeg,
  });
  xc.push({
    name: '常亮锁 支持与否',
    ui: report.kiosk && report.kiosk.wakeLockSupported,
    truth: truth.kiosk.wakeLockSupported,
  });
  xc.push({
    name: '常亮锁 申请次数',
    ui: report.kiosk && report.kiosk.wakeLockRequests,
    truth: truth.kiosk.wakeLockRequests,
  });
  xc.push({
    name: '显卡上下文 丢失次数',
    ui: report.kiosk && report.kiosk.ctxLostN,
    truth: truth.kiosk.ctxLostN,
  });
}

console.log('\n--- ③ 字段完整性 + 交叉核对（UI ↔ 数据）---');
if (missingKeys.length) console.log(`   ❌ JSON 缺少顶层键：${missingKeys.join(', ')}`);
else console.log('   ✅ 8 个顶层键都在');
for (const r of xc) {
  const ok = JSON.stringify(r.ui) === JSON.stringify(r.truth);
  console.log(`   [${ok ? 'PASS' : 'FAIL'}] ${r.name.padEnd(20)} 报告 ${JSON.stringify(r.ui)} · 真值 ${JSON.stringify(r.truth)}`);
}

/* 报告里的 HTML 行文本必须包含判据 label —— 抓「UI 读错变量」 */
const labelInUi = !!(report && report.standTilt && after.reportText.includes(report.standTilt.label));

/* ================= 判定 ================= */
const checks = [];
const chk = (name, pass, detail) => checks.push({ name, pass, detail });

chk('点「报告」后报告界面出现（body 去掉 ar-active、wrap 显示）',
  after.arActive === false && after.wrapDisplay !== 'none',
  `ar-active=${after.arActive} · wrap.display=${after.wrapDisplay}`);
chk('报告界面有 JSON / 复制 / 返回 三颗按钮',
  after.hasJsonBtn && after.hasCopyBtn && after.hasBackBtn,
  `json=${after.hasJsonBtn} copy=${after.hasCopyBtn} back=${after.hasBackBtn}`);
chk('报告含 5 行新字段（支架仰角 / α 参考系 / 屏幕常亮 / 显卡上下文 / 未捕获错误）',
  missingRows.length === 0, missingRows.length ? '缺：' + missingRows.join(', ') : '5 行齐全');
chk('报告界面没有把 undefined 漏出来（接线 bug）',
  undefinedHits === 0, `出现 ${undefinedHits} 次`);
chk('报告界面没有把 NaN 漏出来（算错不会抛错，只会安静地显示 NaN）',
  nanHits === 0, `出现 ${nanHits} 次`);
chk('★ 防空转：点「生成报告 JSON」后 #r-out 内容确实变了（不是停在占位文案）',
  contentChanged, `长度 ${outText ? outText.length : 0} 字符`);
chk('★ 报告是合法 JSON（若 R 混进循环引用 / THREE 对象，stringify 会抛错被回调吞掉）',
  !!report, report ? `${Object.keys(report).length} 个顶层键` : parseErr);
chk('★ 8 个顶层键齐全（JSON.stringify 会静默丢弃 undefined 的键）',
  missingKeys.length === 0, missingKeys.length ? '缺：' + missingKeys.join(', ') : '齐全');
chk('★ 交叉核对：报告里的判据值与 __gyro 调试出口一致（UI ↔ 数据）',
  xc.length > 0 && xc.every(r => JSON.stringify(r.ui) === JSON.stringify(r.truth)),
  xc.filter(r => JSON.stringify(r.ui) !== JSON.stringify(r.truth)).map(r => r.name).join(', ') || `${xc.length} 项全部一致`);
chk('★ 报告界面文字里含判据 label（抓「UI 读错变量」）',
  labelInUi, labelInUi ? `含「${report && report.standTilt && report.standTilt.label}」` : '界面文字里找不到该 label');

console.log('\n=== 判定 ===');
for (const c of checks) console.log(`  [${c.pass ? 'PASS' : 'FAIL'}] ${c.name}   (${c.detail})`);
const allPass = checks.every(c => c.pass);
console.log('\n' + (allPass
  ? '全部通过 ✅ —— 真机点「生成报告 JSON」产出的东西可用：界面与数据一致、JSON 合法、字段齐全'
  : '存在未通过项 ❌ —— 用户真机上可能拿不到可用的报告'));

try { ws.close(); } catch (e) {}
proc.kill();
process.exit(allPass ? 0 : 1);
