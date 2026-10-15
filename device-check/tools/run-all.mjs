/**
 * 一键跑全部回归 —— 用【退出码】判成败。
 *
 * ⚠️ 为什么不 grep 输出：
 *   `reference-formula-check.mjs` 和 `vertical-stand-check.mjs` 会【故意】为
 *   被否决的候选公式/分支打印 ❌（那是负对照在工作，是好事）。
 *   靠 `grep -c ❌` 统计会把这些故意的否定标记算成失败 —— 我就这么误报过一次
 *   「reference-formula-check 5 处 ❌」，白查一遍才发现全是设计内的。
 *   判成败只能看退出码。
 *
 * 用法：
 *   node tools/run-all.mjs                          # 用默认 URL
 *   node tools/run-all.mjs "https://127.0.0.1:8443/ar-gyro-demo.html"
 *
 * 前置：本地 HTTPS 服务已在跑（start-lan.bat 或 python serve-lan.py）。
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/* ⚠️ 这个常量【不要】命名为 `URL`。
   第一版就叫 `const URL = ...`，于是 probe() 里的 `new URL(url)`
   调到的不是全局 URL 构造函数、而是这个字符串 → 抛错 → 打印「URL 解析失败」。
   变量遮蔽内置全局对象，报错信息还会指向完全无关的方向。 */
const TARGET_URL = process.argv[2] || 'http://127.0.0.1:8080/ar-gyro-demo.html';

/* ⚠️ 传给浏览器套件的 URL 要带一个「每次运行都不同」的查询串。
   原因：每个套件用的是【持久化】的临时 profile，Chrome 会把上一次的页面
   缓存下来。实测后果是「页面明明改好了，测试却读到上一版的参数」，
   而且【没有任何报错】—— 现象是 __gyro 在、但新加的导出全是 undefined，
   排查方向会被带偏到「导出写错了」。
   查询串不影响任何套件：hub-nav-test 的 baseOf() 只取到最后一个 '/' 为止。 */
const SUITE_URL = TARGET_URL + (TARGET_URL.includes('?') ? '&' : '?') + 'cb=' + Date.now();

/* 纯数学脚本不需要 URL，也不需要服务在跑；浏览器脚本需要。 */
const SUITES = [
  { name: 'reference-formula-check', args: [], math: true,
    what: '参照公式自检（7 个候选 + α/β/γ 轴归属）' },
  { name: 'vertical-stand-check', args: [], math: true,
    what: '支架仰角 / 万向锁体检（四问四答）' },
  { name: 'smoke-test', args: [SUITE_URL, '_smoke.png', '7000'],
    what: '冒烟：控制台报错 / 启动 / 帧率 / 点选链路' },
  { name: 'gyro-drift-test', args: [SUITE_URL],
    what: '漂移算法：只把真漂移计入' },
  { name: 'framing-test', args: [SUITE_URL],
    what: '取景几何：四角入画 + 自动取景单调性' },
  { name: 'motion-fusion-test', args: [SUITE_URL],
    what: '运动融合：角速度积分的轴映射与符号' },
  { name: 'align-roll-test', args: [SUITE_URL],
    what: '对齐滚转：新算法 vs 旧算法反面参照' },
  { name: 'entry-lock-test', args: [SUITE_URL],
    what: '进入锁定：模型不旋转、之后锁在世界里' },
  { name: 'landscape-map-test', args: [SUITE_URL],
    what: '横屏角度映射（含欧拉角奇点姿态）' },
  { name: 'kiosk-robustness-test', args: [SUITE_URL],
    what: '展项健壮性：常亮锁 / 显卡上下文 / 错误留痕' },
  { name: 'field-verdict-test', args: [SUITE_URL],
    what: '现场判据：支架仰角安全区 / α 参考系（含反面对照）' },
  { name: 'report-fields-test', args: [SUITE_URL],
    what: '报告端到端：界面↔数据一致 / JSON 合法 / 字段齐全' },
  { name: 'ar-anchor-test', args: [SUITE_URL],
    what: 'AR 锚定与视野裁剪：标注不动 + 只显示照到的那一块' },
  { name: 'ar-pick-occlusion-test', args: [SUITE_URL],
    what: '两个 P0 缺陷：点标签必中自己（含旧行为负对照）/ 遮挡剔除（双线性场 vs 三角网格双验 + 滞回死区）' },
  { name: 'gimbal-kinematics-test', args: [SUITE_URL],
    what: '云台两轴旋转：off=0 位置恒定 / off≠0 位置=解析式 / 不影响锚定' },
  { name: 'relief-match-test', args: [SUITE_URL],
    what: '起伏比例对齐：垂直夸张 16× 与尺寸无关 / 按实物峰高反算 reliefScale / 锚点跟随' },
  /* ⚠️ 这一套【故意】不注入假摄像头：headless 里 getUserMedia 会真失败，
     才能把「无相机 / 无陀螺仪」的桌面降级路径走通。它自带 Chrome 启动，
     不接受 URL 之外的参数。 */
  { name: 'ar-desktop-shots', args: [TARGET_URL],
    what: '桌面降级路径：相机失败不致命 / 无陀螺仪自动开拖动转视角 / 转向只显示照到的那一块' },
  { name: 'hub-nav-test', args: [SUITE_URL],
    what: '测试台导航：5 张卡可见 / 点击真跳转 / 返回入口不在 HUD 内' },
  { name: 'holo-smoke', args: [SUITE_URL],
    what: 'ar-holo-demo 冒烟：外观对齐参考 / 相机 AR 裁切 + 遮挡 / 转向只显示照到的那一块' },
];

function run(s) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(HERE, s.name + '.mjs'), ...s.args],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { out += d; });
    p.on('close', (code) => resolve({ ...s, code, out }));
  });
}

/* 先确认服务在跑，否则浏览器脚本会全部超时，白等几分钟。
   ⚠️ 不能直接用 fetch：本项目用的是【自签证书】，Node 的 fetch 会因
      证书校验失败而抛错 —— 于是所有测试都通过了、却先打印一句「服务不可达」，
      把人误导到错的方向去。用 https.request 显式关掉证书校验。 */
import https from 'node:https';
import http from 'node:http';

function probe(url) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch (e) { return resolve({ ok: false, why: 'URL 解析失败' }); }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      method: 'HEAD', hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, timeout: 5000,
      rejectUnauthorized: false,          // 自签证书
    }, (res) => resolve({ ok: res.statusCode < 400, why: 'HTTP ' + res.statusCode }));
    req.on('error', (e) => resolve({ ok: false, why: e.code || e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, why: '超时' }); });
    req.end();
  });
}

const pr = await probe(TARGET_URL);
if (pr.ok) {
  console.log(`服务可达：${TARGET_URL}\n`);
} else {
  console.log(`⚠ 本地服务不可达（${TARGET_URL}）：${pr.why}`);
  console.log('  浏览器类脚本会失败。先启动服务：start-lan.bat 或 python serve-lan.py');
  console.log('  （纯数学的两个脚本仍会跑）\n');
}

console.log('=== 全量回归 ===\n');
const results = [];
for (const s of SUITES) {
  process.stdout.write(`${s.name.padEnd(26)} 运行中…`);
  const t = Date.now();
  const r = await run(s);
  const ms = Date.now() - t;
  /* 从输出里取「判定行」的条数与失败条数（仅用于显示，成败以退出码为准） */
  const passN = (r.out.match(/\[PASS\]/g) || []).length;
  const failN = (r.out.match(/\[FAIL\]/g) || []).length;
  const mark = r.code === 0 ? 'OK  ' : 'FAIL';
  process.stdout.write(`\r${s.name.padEnd(26)} ${mark}  ` +
    `${String(ms).padStart(6)} ms  ${passN ? passN + ' PASS' : ''}${failN ? ' / ' + failN + ' FAIL' : ''}\n`);
  results.push({ ...r, ms, passN, failN });
}

console.log('\n=== 汇总 ===');
for (const r of results) {
  console.log(`  ${r.code === 0 ? '✅' : '❌'} ${r.name.padEnd(26)} ${r.what}`);
}
const bad = results.filter(r => r.code !== 0);
if (bad.length) {
  console.log('\n--- 失败脚本的末尾输出 ---');
  for (const r of bad) {
    console.log(`\n### ${r.name}（退出码 ${r.code}）`);
    console.log(r.out.split('\n').slice(-25).join('\n'));
  }
}
console.log(`\n${results.length - bad.length}/${results.length} 通过` +
  (bad.length ? ` —— 失败：${bad.map(r => r.name).join(', ')}` : '  ✅'));
process.exit(bad.length ? 1 : 0);
