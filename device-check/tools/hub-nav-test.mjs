/**
 * 测试台导航端到端测试 —— 「一个链接进去，按钮能跳到各个页面」。
 *
 * 为什么要有这一条：
 *   之前 5 个页面里只有 index.html → ar.html 一条链接，
 *   另外 3 个页面（ar-gyro-demo / ar-camera / ar-min）**完全没有入口**，只能手输 URL；
 *   而且所有 AR 页面都没有返回路径 —— 进去就出不来。
 *   补上入口和返回之后，需要一条测试把它钉住，否则下次改页面很容易再断掉。
 *
 * 测什么（关键是「接线」，不是「零件」）：
 *   ① 入口页真的有 5 张导航卡，且都**可见**（`getBoundingClientRect` 有面积 ——
 *      只查 `href` 属性会被「元素存在但 display:none / 高度 0」骗过去）
 *   ② 每张卡的 href 与标题文案都对得上（抓「卡片写错页面」）
 *   ③ ★ **真的点一下**，断言地址栏变了 ——
 *      查 href 属性只证明「属性写了」，点一下才证明「点了真能跳」
 *   ④ 每个 AR 页都有「← 返回测试台」，且**位于启动遮罩里**、不在 AR HUD 里 ——
 *      悬浮在 AR 画面上的返回键会干扰 `ar-gyro-demo` 的「点击选点」
 *   ⑤ ★ 返回链接也真的点一下，确认能回到入口页
 *   ⑥ 链接完整性：所有页面里出现的 `./xxx.html` 目标都真的存在（HTTP 200）
 *
 * 用法：node tools/hub-nav-test.mjs <站点根 URL 或任一页面 URL>
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import https from 'node:https';
import http from 'node:http';

const CHROME = process.env.CHROME_PATH
  || String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`;
const ARG = process.argv[2];
const PORT = 9345;

if (!ARG) { console.log('用法: node tools/hub-nav-test.mjs <URL>'); process.exit(1); }

/* 参数可能是站点根，也可能是某个具体页面 —— 统一折成「站点根」。 */
function baseOf(u) {
  const i = u.lastIndexOf('/');
  return u.slice(0, i + 1);
}
const BASE = baseOf(ARG);
const ENTRY = BASE + 'index.html';

const PAGES = [
  { file: 'ar-gyro-demo.html', num: '01', kw: '湖南地形 AR 沙盘', overlay: '#start-wrap' },
  { file: 'ar-camera.html', num: '02', kw: '相机 + 陀螺仪', overlay: '#start-wrap' },
  { file: 'ar.html', num: '03', kw: 'AR 跟踪稳定性测试', overlay: '#enter-wrap' },
  { file: 'ar-min.html', num: '04', kw: 'AR 最小可复现测试', overlay: '#wrap' },
  { file: 'index.html', num: '05', kw: '设备能力自检', overlay: null },
];

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

const tab = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(ENTRY)}`, { method: 'PUT' })).json();
const ws = new WebSocket(tab.webSocketDebuggerUrl);
let msgId = 0;
const pending = new Map();
function send(method, params = {}) {
  const mid = ++msgId;
  ws.send(JSON.stringify({ id: mid, method, params }));
  return new Promise(res => pending.set(mid, res));
}
await new Promise(r => ws.addEventListener('open', r));
/* 抓「页面加载时的资源失败」。这里有个踩出来的教训，写下来免得下次又走弯路：
   ❌ 第一版只用 `Network.responseReceived` 抓 4xx —— 负对照（抽掉某页的空 favicon）
      **测试照样全绿**，等于没写。
   ❌ 第二版补上 `Log.entryAdded`（smoke-test 靠它抓到过 favicon 404）—— **还是全绿**。
   ❌ 第三版怀疑是 profile 缓存，清空 `--user-data-dir` 重跑 —— **依然全绿**。
   ✅ 真正的原因：**Chrome 对每个 origin 只决定一次「要不要取 favicon」，
      之后连请求都不再发出**，所以任何基于网络事件/日志的检查都不可能稳定观测到它。
      ⇒ 这类「浏览器自身行为」的回归，只能用**确定性的 DOM 断言**（见下面的 ⑤b）。
   网络通道仍然保留（⑤c）—— 它能抓到**走页面网络栈**的资源失败（缺图、缺数据文件等），
   那一类是真会 4xx 的，而且不受上面的 favicon 缓存问题影响。 */
let httpBad = [];
ws.addEventListener('message', ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); return; }
  if (m.method === 'Network.responseReceived') {
    const r = m.params.response;
    if (r.status >= 400) httpBad.push(`HTTP ${r.status} ${m.params.type} ${r.url}`);
  }
  if (m.method === 'Log.entryAdded') {
    const e = m.params.entry;
    if (e.level === 'error') httpBad.push(`log ${e.text}`);
  }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    httpBad.push(`exception ${(d.exception && d.exception.description) || d.text}`);
  }
});
const evaluate = (expression) => send('Runtime.evaluate', { expression, returnByValue: true, userGesture: true });
const json = async (e) => JSON.parse((await evaluate(e)).result.value);
const goto = async (url, wait = 2200) => {
  httpBad = [];
  await send('Page.navigate', { url });
  await sleep(wait);
};

await send('Runtime.enable');
await send('Page.enable');
await send('Network.enable');
await send('Log.enable');
await goto(ENTRY, 2600);

console.log('=== 测试台导航端到端测试 ===\n');
console.log(`   入口页 : ${ENTRY}\n`);

/* ================= ① 入口页的导航卡 ================= */
const cards = await json(`JSON.stringify([...document.querySelectorAll('.navcard')].map(a => {
  const r = a.getBoundingClientRect();
  return {
    href: a.getAttribute('href'),
    text: a.innerText.replace(/\\s+/g, ' ').trim(),
    visible: r.width > 0 && r.height > 0 && getComputedStyle(a).display !== 'none'
             && getComputedStyle(a).visibility !== 'hidden',
    w: Math.round(r.width), h: Math.round(r.height),
  };
}))`);

console.log('--- ① 入口页导航卡 ---');
for (const c of cards) {
  console.log(`   ${c.visible ? '👁' : '🚫'} ${String(c.href).padEnd(22)} ${c.w}×${c.h}  ${c.text.slice(0, 46)}`);
}

const hrefs = cards.map(c => c.href);
const missingPages = PAGES.filter(p => !hrefs.includes('./' + p.file));
const allVisible = cards.length > 0 && cards.every(c => c.visible);
const allTitled = PAGES.every(p => cards.some(c => c.href === './' + p.file && c.text.includes(p.kw)));
/* 编号要连续，否则是复制粘贴漏改 */
const numsOk = PAGES.every(p => cards.some(c => c.href === './' + p.file && c.text.includes(p.num)));

/* ================= ② ★ 真的点一下 ================= */
await evaluate(`document.querySelector('.navcard[href="./ar-gyro-demo.html"]').click(); 'ok'`);
await sleep(2600);
const afterClick = await json(`JSON.stringify({
  path: location.pathname, title: document.title,
  hasCanvas: !!document.querySelector('canvas'),
})`);
const clickNavigated = afterClick.path.endsWith('/ar-gyro-demo.html');

console.log('\n--- ② 点击导航卡（★ 真跳转）---');
console.log(`   点「湖南地形 AR 沙盘」后 → ${afterClick.path}`);
console.log(`   页面标题 → ${afterClick.title}`);

/* ================= ③ 各 AR 页的返回入口 ================= */
console.log('\n--- ③ 返回入口（必须在启动遮罩里，不能在 AR HUD 里）---');
const backRows = [];
for (const p of PAGES.filter(x => x.overlay)) {
  await goto(BASE + p.file);
  const b = await json(`JSON.stringify((() => {
    const a = [...document.querySelectorAll('a')].find(x => x.getAttribute('href') === './index.html');
    if (!a) return { found: false };
    const r = a.getBoundingClientRect();
    const ov = a.closest('${p.overlay}');
    const hud = a.closest('#hud, #topbar');
    return {
      found: true, text: a.innerText.trim(),
      visible: r.width > 0 && r.height > 0,
      inOverlay: !!ov, inHud: !!hud,
      overlayVisible: ov ? ov.getBoundingClientRect().height > 0 : null,
    };
  })())`);
  const ok = b.found && b.visible && b.inOverlay && !b.inHud;
  backRows.push({ ...p, ...b, ok });
  console.log(`   [${ok ? 'PASS' : 'FAIL'}] ${p.file.padEnd(20)} ` +
    `${b.found ? `「${b.text}」可见=${b.visible} 在遮罩内=${b.inOverlay} 在HUD内=${b.inHud}` : '未找到'}`);
}

/* ★ 返回链接也点一下 */
await goto(BASE + 'ar.html');
await evaluate(`[...document.querySelectorAll('a')].find(x => x.getAttribute('href') === './index.html').click(); 'ok'`);
await sleep(2200);
const afterBack = await json(`JSON.stringify({ path: location.pathname, navCards: document.querySelectorAll('.navcard').length })`);
const backNavigated = afterBack.path.endsWith('/index.html');
console.log(`\n   ★ 在 ar.html 点「← 返回测试台」→ ${afterBack.path}` +
  `（导航卡 ${afterBack.navCards} 张）`);

/* ================= ④ 链接完整性（HTTP 200）================= */
function head(url) {
  return new Promise((resolve) => {
    let u; try { u = new URL(url); } catch (e) { return resolve({ ok: false, why: 'URL 解析失败' }); }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      method: 'HEAD', hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, timeout: 8000, rejectUnauthorized: false,
    }, (res) => resolve({ ok: res.statusCode < 400, why: 'HTTP ' + res.statusCode }));
    req.on('error', (e) => resolve({ ok: false, why: e.code || e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, why: '超时' }); });
    req.end();
  });
}
const linkRows = [];
for (const p of PAGES) {
  const r = await head(BASE + p.file);
  linkRows.push({ file: p.file, ...r });
}
console.log('\n--- ④ 链接完整性 ---');
for (const r of linkRows) console.log(`   ${r.ok ? '✅' : '❌'} ${r.file.padEnd(20)} ${r.why}`);

/* ================= ⑤ 资源与 favicon ================= */
const errRows = [];
for (const p of PAGES) {
  await goto(BASE + p.file);
  const icon = await json(`JSON.stringify((() => {
    const l = document.querySelector('link[rel="icon"], link[rel="shortcut icon"]');
    return l ? l.getAttribute('href') : null;
  })())`);
  errRows.push({ file: p.file, bad: httpBad.slice(), icon });
}
console.log('\n--- ⑤a 空 favicon 声明（确定性 DOM 断言）---');
for (const r of errRows) {
  const ok = typeof r.icon === 'string' && r.icon.startsWith('data:');
  console.log(`   ${ok ? '✅' : '❌'} ${r.file.padEnd(20)} ${ok ? r.icon : '未声明 → 浏览器会请求 /favicon.ico 并 404'}`);
}
console.log('\n--- ⑤b 加载时无 4xx/5xx（页面网络栈）---');
for (const r of errRows) {
  console.log(`   ${r.bad.length === 0 ? '✅' : '❌'} ${r.file.padEnd(20)} ` +
    (r.bad.length ? r.bad.join(' | ') : '无'));
}

/* ================= 判定 ================= */
const checks = [];
const chk = (name, pass, detail) => checks.push({ name, pass, detail });

chk('入口页有 5 张导航卡', cards.length === 5, `实际 ${cards.length} 张`);
chk('5 张卡全部可见（不是存在但被隐藏 / 高度 0）', allVisible,
  cards.filter(c => !c.visible).map(c => c.href).join(', ') || '全部可见');
chk('每张卡的 href 都指向真实存在的页面',
  missingPages.length === 0, missingPages.map(p => p.file).join(', ') || '5 个目标齐全');
chk('每张卡的标题文案与目标页面对得上（抓「卡片写错页面」）',
  allTitled, allTitled ? '5 张全部匹配' : '有卡片文案与页面不符');
chk('每张卡带正确编号 01–05（抓复制粘贴漏改）',
  numsOk, numsOk ? '01–05 齐全' : '编号缺失或重复');
chk('★ 点击导航卡真的跳转（不只 href 属性写了）',
  clickNavigated, `落到 ${afterClick.path}`);
chk('★ 跳转后目标页真的渲染了（有 canvas）',
  afterClick.hasCanvas, afterClick.hasCanvas ? 'canvas 已创建' : '未找到 canvas');
chk('4 个 AR 页都有「← 返回测试台」且可见',
  backRows.every(r => r.found && r.visible),
  backRows.filter(r => !(r.found && r.visible)).map(r => r.file).join(', ') || '4 页齐全');
chk('★ 返回链接位于启动遮罩内、不在 AR HUD 内（避免干扰点击选点）',
  backRows.every(r => r.inOverlay && !r.inHud),
  backRows.filter(r => !(r.inOverlay && !r.inHud)).map(r => r.file).join(', ') || '4 页都在遮罩内');
chk('★ 点击「返回测试台」真的回到入口页',
  backNavigated && afterBack.navCards === 5,
  `落到 ${afterBack.path}，导航卡 ${afterBack.navCards} 张`);
chk('所有页面链接 HTTP 200',
  linkRows.every(r => r.ok),
  linkRows.filter(r => !r.ok).map(r => `${r.file}(${r.why})`).join(', ') || '5 个全部 200');
chk('★ 每个页面都声明了空 favicon（否则浏览器请求 /favicon.ico 会 404）',
  errRows.every(r => typeof r.icon === 'string' && r.icon.startsWith('data:')),
  errRows.filter(r => !(typeof r.icon === 'string' && r.icon.startsWith('data:')))
    .map(r => r.file).join(', ') || '5 个页面全部声明');
chk('★ 每个页面加载时页面网络栈都没有 4xx/5xx（缺图 / 缺数据文件会在这里现形）',
  errRows.every(r => r.bad.length === 0),
  errRows.filter(r => r.bad.length).map(r => `${r.file}: ${r.bad[0]}`).join(' / ') || '5 个页面全部干净');

console.log('\n=== 判定 ===');
for (const c of checks) console.log(`  [${c.pass ? 'PASS' : 'FAIL'}] ${c.name}   (${c.detail})`);
const allPass = checks.every(c => c.pass);
console.log('\n' + (allPass
  ? '全部通过 ✅ —— 一个链接进得去、每张卡跳得到、每个页面回得来'
  : '存在未通过项 ❌ —— 导航链路有断点'));

try { ws.close(); } catch (e) {}
proc.kill();
process.exit(allPass ? 0 : 1);
