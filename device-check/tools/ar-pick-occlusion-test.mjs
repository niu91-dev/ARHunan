/**
 * 两个 P0 缺陷的回归测试（由 tools/ar-requirement-audit.mjs 审出来的）。
 *
 *  P0-① 点标签命中率
 *    缺陷：pickAt 只对【地形】做射线，拿命中点的 uv 找最近地点。
 *          标签抬高 0.085 m，掠射角下这个抬升会把「标签背后的地形 uv」
 *          推离锚点很远 ⇒ 实测 11 个标签只有 2 个能点中，
 *          4 个提示「附近没有收录地点」，5 个【弹错地点】。
 *    修法：先打标签本身（Sprite），打不中才退回打地形。
 *
 *  P0-② 遮挡剔除
 *    缺陷：标签 depthTest:false + renderOrder:999，永远画在最上层 ⇒
 *          锚点躲在山背后时标签仍浮在山脊上（实测 3/11）。
 *    修法：每帧沿视线做高度场步进，被地形挡住就一并隐藏。
 *
 * 验证策略：
 *  · P0-① 用「标签投影中心点下去，必须选中该标签自己的地点」当判据，
 *    并用【旧行为】做负对照（证明这个判据真的能抓出旧 bug，不是白写的）。
 *  · P0-② 用两种【互相独立】的方法交叉验证：页面里的高度场步进 vs
 *    网格射线（raycastTerrainAt）。两个方法不一致就说明有一个是错的 ——
 *    只信页面自己报的数，等于让被测对象自己批改自己的卷子。
 *
 * 用法：node tools/ar-pick-occlusion-test.mjs <URL>
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME_PATH || String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`;
const TARGET = process.argv[2];
const PORT = 9357;
if (!TARGET) { console.log('用法: node tools/ar-pick-occlusion-test.mjs <URL>'); process.exit(1); }

let fails = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) fails++;
};

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
const send = (method, params = {}) => {
  const mid = ++msgId; ws.send(JSON.stringify({ id: mid, method, params }));
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
  if (!r || r.exceptionDetails || !r.result) return null;
  try { return JSON.parse(r.result.value); } catch (e) { return null; }
};

await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Emulation.setDeviceMetricsOverride', { width: 1152, height: 720, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: TARGET + (TARGET.includes('?') ? '&' : '?') + 'cb=' + Date.now() });
await sleep(6000);
await evaluate(`document.getElementById('start')?.click(); 'ok'`);
await sleep(1500);
await evaluate(`(() => { const e = new Event('deviceorientation');
  e.alpha = 0; e.beta = 55; e.gamma = 25; dispatchEvent(e); return 'ok'; })()`);
await sleep(1200);

/* 固定朝向，让两次运行的判据完全可比 */
await evaluate(`window.__gyro.setArOcclusion(true); window.__gyro.setArCull(true); window.__gyro.aimAt(0); 'ok'`);
await sleep(500);

/* 一个在 Node 侧独立实现的「点地形找最近地点」—— 也就是【旧行为】。
   不复用页面代码：页面里那段已经改了，用它当对照等于自己跟自己比。 */
const NODE_TERRAIN_PICK = `
(function (px, py) {
  const g = window.__gyro;
  const hit = g.raycastTerrainAt(px, py);
  if (!hit || !hit.uv) return { hit: false };
  let best = null, bestD = Infinity;
  for (const s of g.sites) {
    const suv = g.geoUv(s.lon, s.lat);
    const d = Math.hypot(suv.x - hit.uv.x, suv.y - hit.uv.y);
    if (d < bestD) { bestD = d; best = s; }
  }
  return { hit: true, name: best ? best.name : null, uvDistance: bestD,
           miss: bestD > 0.12 };
})`;

console.log('=== P0-① 点标签命中率 ===\n');

const labelsScreen = await evalJson('window.__gyro.arLabelsScreen');
const shown = labelsScreen.filter(l => l.rendered && !l.anchorPx.behind);
console.log(`  当前朝向可见标签：${shown.length}/${labelsScreen.length}\n`);
console.log('  | 地点 | 标签屏幕位置 | 新行为（打标签） | 旧行为（只打地形） |');
console.log('  |---|---|---|---|');

let newOk = 0, newWrong = 0, newMiss = 0, oldOk = 0;
const newWrongList = [];
for (const l of shown) {
  const px = l.labelPx.px, py = l.labelPx.py;
  const res = await evalJson(`window.__gyro.pickProbe(${px.toFixed(2)}, ${py.toFixed(2)})`);
  const oldWay = await evalJson(`${NODE_TERRAIN_PICK}(${px.toFixed(2)}, ${py.toFixed(2)})`);

  const got = res?.cardOn ? res.title : null;
  const ok = got === l.name;
  if (ok) newOk++;
  else if (got) { newWrong++; newWrongList.push(`${l.name}→${got}`); }
  else newMiss++;

  const oldOkHere = oldWay?.hit && !oldWay.miss && oldWay.name === l.name;
  if (oldOkHere) oldOk++;

  const newTxt = ok ? '✅ ' + got
    : got ? '❌ 弹了「' + got + '」' : '❌ 无弹出';
  const oldTxt = !oldWay?.hit ? '打不到地形'
    : oldWay.miss ? '附近无收录地点'
    : oldWay.name === l.name ? '✅ ' + oldWay.name : '❌ 弹了「' + oldWay.name + '」';
  console.log(`  | ${l.name} | ${px.toFixed(0)},${py.toFixed(0)} | ${newTxt} | ${oldTxt} |`);
}
console.log('');
check(`点标签必中自己的地点（${newOk}/${shown.length}）`, newOk === shown.length,
  newWrong || newMiss ? `弹错 ${newWrong} 个、无弹出 ${newMiss} 个：${newWrongList.join(' ')}` : '');
check('命中来源应记为 label（不是凑巧打中地形）',
  (await evalJson(`window.__gyro.pickProbe(${shown[0].labelPx.px.toFixed(2)}, ${shown[0].labelPx.py.toFixed(2)})`))?.source === 'label');
/* 负对照：如果旧行为也全对，说明这条判据抓不出这个 bug，那它就是白写的 */
check('【负对照】旧行为（只打地形）确实会错 —— 否则判据无效',
  oldOk < shown.length, `旧行为只对 ${oldOk}/${shown.length}`);

/* 空白区域仍应走地形路径：在画面角落点一下（远离所有标签） */
const corner = await evalJson(`(() => {
  const g = window.__gyro;
  // 找一个离所有标签投影都最远的屏幕点
  let best = null, bestD = -1;
  const ls = g.arLabelsScreen.filter(l => l.rendered && !l.anchorPx.behind);
  for (let x = 40; x < innerWidth - 40; x += 40) {
    for (let y = 90; y < innerHeight - 80; y += 40) {
      let d = Infinity;
      for (const l of ls) d = Math.min(d, Math.hypot(l.labelPx.px - x, l.labelPx.py - y));
      if (d > bestD) { bestD = d; best = { x, y }; }
    }
  }
  return { ...best, clearance: bestD };
})()`);
const cornerPick = await evalJson(`window.__gyro.pickProbe(${corner.x}, ${corner.y})`);
check('远离标签处点击仍走地形路径（标签射线没过度捕获）',
  cornerPick?.source === null || cornerPick?.source === 'terrain' || cornerPick?.source === 'terrain-miss',
  `source=${cornerPick?.source} title=${cornerPick?.title}`);

console.log('\n=== P0-② 遮挡剔除 ===\n');

/* 两种独立方法交叉验证。两者【判据必须相同】（都用「射线高度 < 地形高度 − 4 mm」），
   差别只在「地形高度从哪来」：
     · 页面里的 isAnchorOccluded 用 heightAtUv（双线性插值，每帧 48 次查表，便宜）
     · 这里用 terrainYAt（竖直射线打三角网格，贵但精确）
   两个方法不一致，就说明那个便宜的双线性近似不能替代网格 —— 那才是要查的问题。

   ⚠️ 不要用「网格首交点比锚点近 N 毫米」当第二意见（第一版就是那么写的）。
      那是【距离】判据，而掠射角下 5 mm 距离只对应亚毫米的高度差：
      实测 0.1 rad 的掠射角下，0.5 mm 的起伏就能凑出 5 mm 的距离差。
      于是它会把 1 mm 的起伏报成「遮挡」—— 判据过敏，和真正的遮挡混在一起，
      反而掩盖了要查的东西。判据统一到【高度】之后两者才能对话。 */
const THR = await evalJson('window.__gyro.occlusionThresholds');
const EPS_IN = THR.in;      // 进入遮挡的阈值（从页面读，不写死）
console.log(`  判据阈值（读自页面）：进入 >${(EPS_IN * 1000).toFixed(0)} mm · ` +
  `解除 <${(THR.out * 1000).toFixed(0)} mm · 步数 ${THR.steps}\n`);

const crossCheck = async (yaw) => {
  await evaluate(`window.__gyro.setArOcclusion(false); window.__gyro.setArCull(true); window.__gyro.aimAt(${yaw}); 'ok'`);
  await sleep(350);
  const rows = await evalJson(`(() => {
    const g = window.__gyro;
    return g.arAnchors.map(a => ({ id: a.id, name: a.name, visible: a.visible }));
  })()`);
  const out = [];
  for (const r of rows) {
    if (!r.visible) continue;
    const probe = await evalJson(`(() => { const g = window.__gyro;
      const an = g.arAnchors.find(x => x.id === '${r.id}');
      const cam = g.camPos;
      const samples = g.occlusionRay(cam, an.pos, ${THR.steps});
      let fieldOver = -Infinity, meshOver = -Infinity;
      for (const s of samples) {
        if (s.meshY === null) continue;
        fieldOver = Math.max(fieldOver, s.fieldY - s.rayY);
        meshOver = Math.max(meshOver, s.meshY - s.rayY);
      }
      return { fieldOver, meshOver, n: samples.length,
               march: g.isAnchorOccluded(cam, an.pos) };
    })()`);
    if (!probe) continue;
    out.push({
      ...r,
      fieldOver: probe.fieldOver, meshOver: probe.meshOver, samples: probe.n,
      fieldOcc: probe.fieldOver > EPS_IN,    // 双线性场判定（= 页面实现）
      meshOcc: probe.meshOver > EPS_IN,      // 网格判定（第二意见）
      march: probe.march,
    });
  }
  return out;
};

for (const yaw of [0, 25, -25]) {
  const rows = await crossCheck(yaw);
  console.log(`  —— 朝向 ${yaw}°（视野内 ${rows.length} 个）——`);
  console.log('  | 地点 | 最大超出 双线性 | 最大超出 网格 | 双线性判定 | 网格判定 | 一致 |');
  console.log('  |---|---|---|---|---|---|');
  let agree = 0;
  for (const r of rows) {
    const same = r.fieldOcc === r.meshOcc;
    if (same) agree++;
    console.log(`  | ${r.name} | ${(r.fieldOver * 1000).toFixed(1)} mm | ${(r.meshOver * 1000).toFixed(1)} mm | ` +
      `${r.fieldOcc ? '**遮挡**' : '可见'} | ${r.meshOcc ? '**遮挡**' : '可见'} | ${same ? '✅' : '❌'} |`);
  }
  check(`朝向 ${yaw}°：双线性场与三角网格判定一致（${agree}/${rows.length}）`,
    rows.length > 0 && agree === rows.length);
  /* 页面实现的布尔值必须和「双线性场的判据」对得上 ——
     否则说明 isAnchorOccluded 里还有别的逻辑（或者阈值被改过没同步）。 */
  const mismatched = rows.filter(r => r.march !== r.fieldOcc).map(r => r.name);
  check(`朝向 ${yaw}°：页面 isAnchorOccluded 与其判据一致`, mismatched.length === 0,
    mismatched.length ? '不一致：' + mismatched.join('、') : '');

  /* 遮挡剔除打开后，被遮挡的锚点标签必须真的没渲染 */
  await evaluate(`window.__gyro.setArOcclusion(true); window.__gyro.setArCull(true); window.__gyro.aimAt(${yaw}); 'ok'`);
  await sleep(350);
  const after = await evalJson(`window.__gyro.arAnchors`);
  const occNames = after.filter(a => a.occluded).map(a => a.name);
  const badRender = after.filter(a => a.occluded && a.labelRendered).map(a => a.name);
  const expectOcc = rows.filter(r => r.fieldOcc).map(r => r.name).sort().join(',');
  check(`朝向 ${yaw}°：被遮挡的标签确实没有渲染`,
    badRender.length === 0,
    occNames.length ? `遮挡 ${occNames.length} 个（${occNames.join('、')}）` : '本朝向无遮挡');
  check(`朝向 ${yaw}°：实际遮挡集合 = 判据预测的集合`,
    occNames.slice().sort().join(',') === expectOcc,
    `实际[${occNames.join('、')}] 预测[${rows.filter(r => r.fieldOcc).map(r => r.name).join('、')}]`);
}

/* ---------- 滞回：死区必须真的起作用 ----------
   怎么造出一个落在死区里的样本：把锚点【向下】平移 h 米。
   目标点越低，视线在靠近锚点的那一段就越低，地形高出量单调增大 ——
   于是扫一遍 h 就能扫过「进入阈值」和「解除阈值」之间的整段窗口。
   然后要求：
     · 从「可见」出发：只有超出量 > IN 才判遮挡
     · 从「已遮挡」出发：只有超出量 < OUT 才解除
   这两条同时成立才说明 wasOccluded 真的被传进去了。
   （不传的话两个调用会完全相同 —— 这是很容易在重构里丢掉的参数。） */
const hyst = await evalJson(`(() => {
  const g = window.__gyro;
  const an = g.arAnchors.find(x => x.id === 'hengshan');
  const cam = g.camPos;
  const res = [];
  for (let i = 0; i <= 150; i++) {
    const h = i * 0.002;
    const t = { x: an.pos.x, y: an.pos.y - h, z: an.pos.z };
    const sam = g.occlusionRay(cam, t, ${THR.steps});
    let over = -Infinity;
    for (const s of sam) { if (s.meshY !== null) over = Math.max(over, s.fieldY - s.rayY); }
    res.push({ h: Number(h.toFixed(4)), over, fromVis: g.isAnchorOccluded(cam, t, false),
               fromOcc: g.isAnchorOccluded(cam, t, true) });
  }
  return res;
})()`);

if (!hyst || !hyst.length) {
  check('滞回死区测试能取到样本', false, 'occlusionRay 返回空');
} else {
  const inBand = hyst.filter(s => s.over > THR.out && s.over < THR.in);
  const inBandCorrect = inBand.every(s => s.fromVis === false && s.fromOcc === true);
  const aboveIn = hyst.filter(s => s.over > THR.in);
  const aboveInCorrect = aboveIn.every(s => s.fromVis === true && s.fromOcc === true);
  const belowOut = hyst.filter(s => s.over < THR.out);
  const belowOutCorrect = belowOut.every(s => s.fromVis === false && s.fromOcc === false);
  console.log('');
  console.log(`  死区窗口 ${(THR.out * 1000).toFixed(0)} … +${(THR.in * 1000).toFixed(0)} mm：` +
    `落在其中的样本 ${inBand.length} 个（超出量 ${inBand.length ? (inBand[0].over * 1000).toFixed(1) + '…' + (inBand[inBand.length - 1].over * 1000).toFixed(1) : '—'} mm）`);
  console.log(`  超出量 > ${(THR.in * 1000).toFixed(0)} mm：${aboveIn.length} 个样本 → 应判遮挡`);
  console.log(`  超出量 < ${(THR.out * 1000).toFixed(0)} mm：${belowOut.length} 个样本 → 应判可见`);
  check('滞回死区内：从「可见」判可见、从「已遮挡」判遮挡（保持原状）',
    inBand.length > 0 && inBandCorrect, inBand.length ? '' : '没扫到死区内的样本');
  check('超出量 > 进入阈值 → 两种出发状态都判遮挡', aboveIn.length > 0 && aboveInCorrect);
  check('超出量 < 解除阈值 → 两种出发状态都判可见', belowOut.length > 0 && belowOutCorrect);
}

/* 开关的耦合与独立性 */
await evaluate(`window.__gyro.setArOcclusion(true); window.__gyro.setArCull(true); window.__gyro.aimAt(0); 'ok'`);
await sleep(350);
const onBoth = await evalJson(`window.__gyro.arAnchors.filter(a=>a.labelRendered).length`);
await evaluate(`window.__gyro.setArOcclusion(false); 'ok'`);
await sleep(350);
const occOff = await evalJson(`window.__gyro.arAnchors.filter(a=>a.labelRendered).length`);
await evaluate(`window.__gyro.setArCull(false); 'ok'`);
await sleep(350);
const cullOff = await evalJson(`window.__gyro.arAnchors.filter(a=>a.labelRendered).length`);
await evaluate(`window.__gyro.setArOcclusion(true); window.__gyro.setArCull(true); 'ok'`);
await sleep(300);

console.log('');
check('关掉遮挡剔除 → 被遮挡的标签重新出现', occOff > onBoth, `${onBoth} → ${occOff}`);
check('关掉视野裁剪 → 遮挡一并失效（全渲染对比模式，11 个全出现）',
  cullOff === 11, `裁剪关掉后渲染 ${cullOff}/11`);
check('遮挡数有独立读数（HUD / 报告要用）',
  (await evalJson('window.__gyro.arOccludedCount')) !== undefined);

check('全程无控制台报错', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

console.log(`\n${fails === 0 ? '全部通过 ✅' : fails + ' 项未通过 ❌'}`);
ws.close(); proc.kill();
process.exit(fails === 0 ? 0 : 1);
