/* ============================================================================
   湖南地形 AR 沙盘 · 相机 AR 模块
   ----------------------------------------------------------------------------
   这个文件是「相机 AR 块」的【全部】逻辑，从 ar-gyro-demo.html 原样抽出：

     · 姿态：deviceorientation（绝对，用来校正） + devicemotion（高频，用来积分）
     · 对齐：把「设备坐标系里看向沙盘中心」锁成相机的光轴，滚转由 lookAt 定
     · 云台：两轴运动学（外轴偏航 × 内轴俯仰），可选陀螺仪增量驱动位置
     · 视野裁剪：NDC 边距 score + 滞回
     · 遮挡剔除：沿视线 48 步高度场行军，判据用【高度】不用【距离】

   ★ 展示层（地形 / 点云 / 标记 / 扫描 / 资料卡 / 面板）完全不在这里，
     在 holo-app.js。两边只通过 createArCamera() 返回的对象通信。
     这样「外观对齐参考项目」和「相机逻辑用我们自己的」可以各自独立改动。

   ★ 为什么遮挡判据必须用【高度】而不是【距离】——
     同一个错误在这个项目里踩过两次（见 README「同一件事第二次踩」）：
       ❌ 「地形网格的第一个交点比锚点近 5 mm 就算被挡」
          掠射角下 5 mm 的距离差对应的【高度差】不到 1 mm，
          于是大片明明露在外面的锚点被判成被挡。
       ✅ 「视线在某处低于地形表面」才是「被挡住」的定义，量纲是长度（m），
          与视角无关。阈值 8 mm 是实物沙盘的尺度（沙盘起伏 0.29 m）。
============================================================================ */
import * as THREE from 'three';

/* ---------- 姿态解算用的常量（DeviceOrientationControls 的经典算法）---------- */
const zee = new THREE.Vector3(0, 0, 1);
const _e2 = new THREE.Euler();
const q0 = new THREE.Quaternion();
const q1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5));

const UP_Y = new THREE.Vector3(0, 1, 0);
const ORIGIN = new THREE.Vector3(0, 0, 0);

/* 世界坐标里 +X = 相机右侧、−X = 相机左侧；+Z = 朝向 pad 的方向。
   零位时 pad 看向 −Z（沙盘中心方向），up = +Y —— 正好是 three.js 相机的默认姿态，
   所以「俯仰台零位」的安装四元数 qMount = 单位四元数，下面直接用 R_y·R_x。 */
const AXIS_Y = new THREE.Vector3(0, 1, 0);   // 水平旋转轴（竖直）
const AXIS_X = new THREE.Vector3(1, 0, 0);   // 上下旋转轴（水平，零位时垂直于视线）

/* ---------- 视野裁剪的滞回 ----------
   score = min(1-|ndc.x|, 1-|ndc.y|)：>0 在画面内，=1 正好在画面中心，<0 出画。
   进入用 +0.02、退出用 −0.10（死区 0.12）——
   没有滞回的话，锚点压在画面边缘时陀螺仪的微小抖动会让它每帧闪一次。 */
const AR_NDC_IN = 0.02;
const AR_NDC_OUT = -0.10;

/* ---------- 遮挡剔除的参数 ---------- */
const OCC_STEPS = 48;        // 沿视线采样的步数
const OCC_EPS_IN = 0.008;    // 进入遮挡：地形高出视线 > 8 mm
const OCC_EPS_OUT = -0.004;  // 解除遮挡：地形高出视线 < −4 mm（死区 12 mm）
const OCC_T0 = 0.02, OCC_T1 = 0.98;   // 只查锚点与相机之间的中段，避开两端自遮挡

/* 相邻两次 deviceorientation 的最大有效间隔（秒）。超过就丢弃 —— 低功耗门控下
   间隔可以到 1 s，拿它算角速度会得到假的小数值，污染静止漂移估计。 */
const DT_MAX_SEC = 5.0;
const STILL_RATE_DPS = 2.0;   // °/s，低于此视为「静止」
const STILL_MIN_MS = 4000;    // 静止样本不足 4 秒不给结论

/* 陀螺仪迟迟不来时的兜底：按固定视角先把模型显示出来，总比空白好 */
const FALLBACK_SHOW_MS = 3000;

export function createArCamera({ camera, params, hooks = {} }) {
  const {
    flash = () => {},
    onAligned = () => {},
    onFirstOrient = () => {},
    onFallbackShow = () => {},
  } = hooks;

  /* ========================================================================
     ① 姿态
     ======================================================================== */
  let haveOrient = false, orientN = 0;
  let lastOrientT = 0, orientGapMs = 0;
  const evTimes = [];
  let lastA = null, lastB = null, lastG = null;
  let alpha = 0;

  /* ---------- α 是「绝对」还是「相对」—— 决定「开一整天会不会歪」----------
     W3C 允许 deviceorientation.alpha 有两种实现：
       · 绝对：相对【地磁北】。长时间漂移有界（磁力计会把零偏拉回来）。
       · 相对：相对【任意起始朝向】。α 退化成「陀螺积分」，零偏会一直累积。
     实测静止漂移约 0.1 °/min，若 α 是相对的就意味着 8 小时累计约 48°。

     ⚠️ 这里有一个我一开始想错、差点发出一个测不出东西的判据的地方：
     ❌ 「offset = wrap(α_abs − α_dev) 是否恒定」——恒定就说明 α_dev 也是绝对的。
     但这是错的：α_dev 是相对的话，它同样由陀螺积分得到，设备偏航 θ 时 α_dev 也变 θ，
     所以 offset 只是两个参考系的固定差，本来就是恒定的。**区分不出绝对与相对。**
     ✅ 真正能分辨的是 offset 的【大小】：两者都是绝对 → 测的是同一个地磁北 →
        offset ≈ 0（只差磁偏角，几度）；α_dev 是相对 → offset 取决于任意起点 → 任意值。
        ⚠️ 反向不成立：|offset| ≈ 0 只是「可能是绝对」，不是证明。
        决定性判据要【长时间看 offset 是否持续增长】，那需要跑几分钟以上。 */
  let absEventN = 0, absPrevA = null, absPrevT = 0;
  /* 判据量用 offMaxAbs 而不是均值 —— offset 是角度，取算术平均在 ±180° 附近会出错：
     真实 offset 若是 180°，样本会跨 ±180（{179,−179,178,−178} 均值≈0），
     被判成「参考系一致」—— 那是【危险方向】的错，用户会以为不用定期归零。 */
  let offMin = null, offMax = null, offMaxAbs = 0, offN = 0, offSum = 0;

  /* 累计转向路径长度 —— 判定「α 是否绝对」时要确认设备真的转过向
     （一直不动的话 offset 恒定是必然的，不能据此下结论） */
  let yawTravelledDeg = 0;

  let sPrevA = null, sPrevT = 0;
  let stillDriftDeg = 0, stillMs = 0, movingMs = 0;
  let droppedN = 0;

  function wrap180(d) { while (d > 180) d -= 360; while (d < -180) d += 360; return d; }

  function screenAngleDeg() {
    const a = (screen.orientation && typeof screen.orientation.angle === 'number')
      ? screen.orientation.angle
      : (typeof window.orientation === 'number' ? window.orientation : 0);
    return a;
  }
  function isLandscape() {
    return (screen.orientation && screen.orientation.type)
      ? screen.orientation.type.indexOf('landscape') === 0
      : innerWidth >= innerHeight;
  }

  /* 用当前 deviceorientation 数据重置基座 —— 这是【绝对】姿态，没有累积漂移 */
  const qBase = new THREE.Quaternion();
  const _dq = new THREE.Quaternion();
  const _w = new THREE.Vector3();
  const qDev = new THREE.Quaternion();

  /* ---------- 姿态的「基座」----------
     设备系 → 世界系的旋转，【不含】q1 / q0 修正。
     为什么要把这一层单独拿出来：devicemotion 的 rotationRate 轴是【设备本体轴】，
     积分必须作用在这一层上。如果把 q1（相机朝设备背面的约定）和 q0（屏幕旋转补偿）
     一起卷进积分，每帧都会把这两个固定补偿也「转」一次，结果是姿态越积越歪。 */
  function resetBaseFromOrient() {
    const a = THREE.MathUtils.degToRad(lastA);
    const b = THREE.MathUtils.degToRad(lastB);
    const g = THREE.MathUtils.degToRad(lastG);
    qBase.setFromEuler(_e2.set(b, a, -g, 'YXZ'));
  }

  /* 设备四元数：基座 × 相机朝背面的约定 × 屏幕方向补偿。
     横屏时 screen.orientation.angle = 90 或 270，必须靠最后一步补偿，
     否则叠加层会整体偏 90°。 */
  function readDeviceQuat(out) {
    const o = THREE.MathUtils.degToRad(screenAngleDeg());
    out.copy(qBase);
    out.multiply(q1);
    out.multiply(q0.setFromAxisAngle(zee, -o));
    return out;
  }

  function onOrient(e) {
    if (e.alpha === null || e.alpha === undefined) return;
    const first = !haveOrient;
    if (first) haveOrient = true;
    orientN++;
    const t = performance.now();
    /* 相邻两次上报的间隔 —— 「静止时会不会一跳一跳」要看这个：
       Android 静止时会把 deviceorientation 降到 ~1 Hz，
       此时平滑根本来不及把两次之间填满，观感就是「一秒跳一格」。 */
    if (lastOrientT) {
      const gap = t - lastOrientT;
      if (gap > 0 && gap < 5000) orientGapMs = orientGapMs ? orientGapMs * 0.85 + gap * 0.15 : gap;
    }
    lastOrientT = t;
    evTimes.push(t);
    alpha = e.alpha; lastA = e.alpha; lastB = e.beta; lastG = e.gamma;
    /* 每次拿到绝对姿态就校正一次积分结果 —— 这是「高频但不累积漂移」的关键 */
    resetBaseFromOrient();
    /* 必须在 resetBaseFromOrient() 之后才能对齐（对齐要读 qBase） */
    if (first) { onFirstOrient(); alignNow(true); }

    if (sPrevA !== null) {
      const dt = (t - sPrevT) / 1000;
      if (dt > 0 && dt <= DT_MAX_SEC) {
        const da = wrap180(e.alpha - sPrevA);
        yawTravelledDeg += Math.abs(da);
        const dps = Math.abs(da) / dt;
        if (dps < STILL_RATE_DPS) { stillDriftDeg += da; stillMs += dt * 1000; }
        else { movingMs += dt * 1000; }
      } else {
        droppedN++;
      }
    }
    sPrevA = e.alpha; sPrevT = t;
  }

  function onOrientAbs(e) {
    if (e.alpha === null || e.alpha === undefined) return;
    absEventN++;
    const t = performance.now();
    /* 用【绝对事件自己】的角速度判静止，不蹭 onOrient 的样本（两者频率可能不同）。
       只在静止时采样：两个事件不是同一 tick 发出的，设备转动时 offset 会带上
       与角速度成正比的采样偏差（30 °/s × 16 ms ≈ 0.5°）。 */
    if (absPrevA !== null) {
      const dt = (t - absPrevT) / 1000;
      if (dt > 0 && dt <= DT_MAX_SEC) {
        const da = wrap180(e.alpha - absPrevA);
        if (Math.abs(da) / dt < STILL_RATE_DPS) {
          const off = wrap180(e.alpha - (lastA === null ? e.alpha : lastA));
          offN++; offSum += off;
          offMin = offMin === null ? off : Math.min(offMin, off);
          offMax = offMax === null ? off : Math.max(offMax, off);
          offMaxAbs = Math.max(offMaxAbs, Math.abs(off));
        }
      }
    }
    absPrevA = e.alpha; absPrevT = t;
  }

  /* ---------- devicemotion：高频补充 ----------
     Android 静止时会把 deviceorientation 降到 ~1 Hz（实测 124 秒只有 102 个事件
     = 0.82 Hz），视角每秒只更新一次 —— 用户看到的就是「转动平板但画面不动」。
     devicemotion 的 rotationRate 频率高得多。做法是：
       ① deviceorientation 到来 → 用绝对姿态【重置】qBase（校正累积误差）
       ② devicemotion 到来     → 用角速度【积分推进】qBase（补足高频）
     这样既有高频、又不会累积漂移。 */
  let haveMotion = false, motionN = 0, motionHz = 0;
  let motionFrames = 0, motionHzT0 = 0, lastMotionT = 0;
  let lastMotionGapMs = 0, lastMotionUsedDtMs = 0;
  let lastRateAlpha = null, lastRateBeta = null, lastRateGamma = null;
  let motionFusion = true;       // 设置面板可切换，方便 A/B 对比
  let motionGain = 1.0;          // 角速度增益，1.0 为标称值

  function onMotion(e) {
    const rr = e.rotationRate;
    if (!rr) return;
    if (rr.alpha === null && rr.beta === null && rr.gamma === null) return;
    if (!haveMotion) { haveMotion = true; }

    motionN++;
    const now = performance.now();
    motionFrames++;
    if (now - motionHzT0 >= 1000) {
      motionHz = motionFrames * 1000 / (now - motionHzT0);
      motionFrames = 0; motionHzT0 = now;
    }

    const gapMs = lastMotionT ? now - lastMotionT : 0;
    const dt = gapMs ? Math.min(gapMs / 1000, 0.1) : 0;
    lastMotionT = now;
    lastMotionGapMs = gapMs;
    lastMotionUsedDtMs = dt * 1000;
    lastRateAlpha = rr.alpha ?? null;
    lastRateBeta = rr.beta ?? null;
    lastRateGamma = rr.gamma ?? null;
    if (!motionFusion || !haveOrient || dt <= 0) return;

    /* rotationRate 分量对应设备本体轴（deg/s）：
         alpha → 绕设备 Z（屏幕法线）、beta → 绕设备 X（屏幕右向）、
         gamma → 绕设备 Y（屏幕上向）
       注意：qBase 是由 Euler(b, a, -g, 'YXZ') 构造的中间四元数，
       其与设备本体轴之间存在固定的 q1 = Rx(-90°) 变换（Y 轴映为 -Z 轴，Z 轴映为 +Y 轴）。
       因此设备本体角速度 (beta, gamma, alpha) 映射到 qBase 的旋转矢量为：
         X = beta, Y = alpha, Z = -gamma
       这样在任何屏幕旋转角（横屏 90°/270°、竖屏 0°/180°）下，
       qBase · q1 · q0(-o) 解算出的最终相机姿态角速度都完全等于真实物理旋转，
       消除了横屏上下俯仰时产生的滚转错位。 */
    _w.set(
      THREE.MathUtils.degToRad(rr.beta || 0),
      THREE.MathUtils.degToRad(rr.alpha || 0),
      -THREE.MathUtils.degToRad(rr.gamma || 0)
    );
    const len = _w.length();
    /* 只按【角速度】挡异常跳变（人转动很少超过 1500 °/s），
       不要按「角度增量」挡 —— 事件间隔稍大时（低功耗门控下可达 1 s），
       正常的 90 °/s 转动会产生 1.57 rad 的增量，用增量阈值会把正常转动也丢掉。 */
    const lenDps = len * 57.29578;
    if (dt > 0 && lenDps < 1500) {
      const ang = len * dt * motionGain;
      if (ang > 1e-6) {
        _dq.setFromAxisAngle(_w.divideScalar(len), ang);
        qBase.multiply(_dq);
      }
    }
  }

  /* 最近 2 秒的【瞬时】频率。
     注意：静止时 Android 会把传感器降到 2~7 Hz 甚至暂停，
     所以用户一点按钮（手不动）这里就会掉到 0 —— 这不是传感器坏了。
     报告里必须同时给「平均频率」，否则会严重误判。 */
  function currentHz() {
    const now = performance.now();
    while (evTimes.length && now - evTimes[0] > 2000) evTimes.shift();
    return evTimes.length / 2;
  }

  /* ========================================================================
     ② 对齐
     ======================================================================== */
  const alignQuat = new THREE.Quaternion();
  let aligned = false, alignAlpha = null, alignT = 0, alignCount = 0;
  let firstAlign = null;
  let snapPose = false;        // 对齐时直接吸附（不走 slerp）
  let fallbackShow = false;    // 陀螺仪迟迟不来时的兜底
  let clearedFrames = 0;       // 对齐前「只清屏不渲染」的帧数（调试出口用）

  const _m4 = new THREE.Matrix4();

  /* ---------- 为什么【第一次拿到姿态就立刻对齐】 ----------
     「进去后延迟 N 秒再自动对齐」看起来更稳妥，其实是「进入一瞬间模型转一下」的
     直接原因。因为对齐前后用的是【两套不同的滚转约定】：
       对齐前：相机 = 固定视角 —— 位置 (0,camHeight,camDist) + lookAt(中心) + up = 世界竖直
       对齐后：相机 = 设备视角 —— camQuat = readDeviceQuat() · alignQuat，up = 设备 up
     两者都指向地形中心，所以差别【只在滚转】。而设备只要有侧倾，
     这两套滚转就差那么多度 —— 延迟多久，用户就盯着一个滚转不对的模型看多久。

     正确做法：启动时就已经要求「把平板装到支架上、镜头对准沙盘中心」，
     也就是【进入之前就已经对准了】。所以第一次拿到姿态就是最佳对齐时机 ——
     模型从第一帧起就是最终姿态，根本不存在中间态。
     配套：对齐前不渲染模型（见 updatePose 的返回 false），并且首次对齐直接吸附。 */
  function alignNow(silent) {
    if (!haveOrient) { flash('还没收到陀螺仪数据'); return false; }
    applyNominalPosition();
    /* 云台 drive='gyro' 的基准必须在【对齐这一刻】标定 ——
       因为只有对齐时我们才确信相机真的在标称位置上（r0 才算得对）。
       放在别处标定（比如「切到 gyro 驱动的那一下」）会取到一个转过角的
       陈旧位置，r0 就带上一段多余的平移，之后每一帧的位置都是错的。
       实测后果：off=0（本该位置恒定）也会漂 8.0 cm。 */
    const P = params();
    if (P.gimbal.on && P.gimbal.drive === 'gyro') captureGyroPosRef();
    const q = readDeviceQuat(qDev.clone());
    const target = new THREE.Vector3(0, 0, 0).sub(camera.position).normalize();

    /* ---------- 世界系航向对齐（彻底消除俯仰引发的滚转错位）----------
       为什么不能在设备局部系里做 lookAt 并右乘：
       右乘 alignQuat 会把相机的局部俯仰轴扭转一个偏航角。
       一旦设备处于任意朝向（例如 alpha ≠ 90°），横屏上下俯仰平板时，
       物理俯仰就会被投影到相机的视线 Roll 轴上，产生剧烈滚转打转。
       正确做法：在【世界坐标系】中做水平航向对齐（左乘 alignQuat · qDev）。
       世界 Y 轴是铅垂轴，绕世界 Y 轴的航向对齐严格保持水平面平行，
       使平板在任何角度下的上下俯仰都 100% 保持为纯俯仰，滚转误差恒为 0。 */
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
    const yawAngle = Math.atan2(fwd.x, -fwd.z);
    alignQuat.setFromAxisAngle(UP_Y, yawAngle);

    aligned = true;
    snapPose = true;
    alignCount++;
    alignAlpha = alpha;
    alignT = performance.now();
    if (!firstAlign) firstAlign = {
      qDev: q.clone(), alignQuat: alignQuat.clone(),
      alpha: lastA, beta: lastB, gamma: lastG, screenAngle: screenAngleDeg(),
    };
    onAligned();
    if (!silent) flash('已对齐：地形中心锁在正前方');
    return true;
  }

  /* 漂移归零：把当前设备姿态当作「首次对齐时的姿态」。
     等价于 qNow · alignQuat_new = qDev₀ · alignQuat₀
     —— 只适用于平板本身没被动过、纯粹是陀螺仪漂了的情况。 */
  function zeroDrift() {
    if (!haveOrient || !firstAlign) { flash('先做一次对齐'); return false; }
    const qNow = readDeviceQuat(new THREE.Quaternion());
    alignQuat.copy(firstAlign.alignQuat).multiply(firstAlign.qDev).multiply(qNow.clone().invert());
    alignAlpha = alpha;
    alignT = performance.now();
    alignCount++;
    flash('已按「平板未移动」前提归零漂移');
    return true;
  }

  /* ========================================================================
     ③ 云台（台子）运动学

     现场约束：pad 用夹具固定在台子上 —— 相对台子【不动】；台子底座固定在桌面 ——
     底座位置【始终不变】；台子本身可操作，能绕垂直轴水平转、绕水平轴上下转。
     所以这不是「手持平板」，是【两轴云台】。

     ---------- 唯一不动的点 ----------
     刚体绕一根轴转，轴上的点不动。台子有两根轴，那么【两轴的交点】就是唯一
     位置不变的点。把「零位时相机所在的位置」当作标称位置（由两个滑块决定），
     交点 = 标称位置 − off。于是
       off = 0 → 交点就在光心上，转多少度位置都不动（推荐装法）
       off ≠ 0 → 光心偏离交点 |off|，转动时沿圆弧平移
     ======================================================================== */
  const GIMBAL = {
    pivot: new THREE.Vector3(),
    off: new THREE.Vector3(0, 0, 0),
  };
  const _gqYaw = new THREE.Quaternion();
  const _gqPitch = new THREE.Quaternion();
  const _gqAll = new THREE.Quaternion();
  const _gqTmp = new THREE.Quaternion();
  const _gv = new THREE.Vector3();

  /* 标称位置（零位时 pad 光心的世界坐标）—— 所有「看向中心」的三角函数都从它出发 */
  function nominalPosition(out) {
    const P = params();
    return (out || new THREE.Vector3()).set(P.lateral, P.camHeight, P.camDist);
  }
  function applyNominalPosition() {
    camera.position.copy(nominalPosition(_gv));
    camera.updateMatrixWorld();
  }
  function syncGimbalPivot() {
    const P = params();
    if (P && P.gimbal && P.gimbal.off) {
      GIMBAL.off.copy(P.gimbal.off);
    }
    GIMBAL.pivot.copy(nominalPosition(_gv)).sub(GIMBAL.off);
  }

  /* 纯函数：给定台子两轴角度，返回 pad 的位姿。
     ★ 顺序是【外轴(偏航) × 内轴(俯仰)】—— 俯仰台挂在偏航台上，不能反。
       反了的话「先俯仰再偏航」会让水平轴跟着倾斜，得到的不是两轴云台、而是球铰。 */
  function gimbalPoseAt(yawDeg, pitchDeg, outPos, outQuat) {
    _gqYaw.setFromAxisAngle(AXIS_Y, THREE.MathUtils.degToRad(yawDeg));
    _gqPitch.setFromAxisAngle(AXIS_X, THREE.MathUtils.degToRad(pitchDeg));
    _gqAll.copy(_gqYaw).multiply(_gqPitch);
    if (outPos) outPos.copy(GIMBAL.off).applyQuaternion(_gqAll).add(GIMBAL.pivot);
    if (outQuat) outQuat.copy(_gqAll);
    return _gqAll;
  }

  /* drive='gyro'：用陀螺仪姿态增量推位置。对齐（或手动标定）时刻记下基准。 */
  let gyroPosRef = null;
  function captureGyroPosRef() {
    syncGimbalPivot();
    gyroPosRef = { r0: camera.position.clone().sub(GIMBAL.pivot), q0: camera.quaternion.clone() };
    return { r0: { x: gyroPosRef.r0.x, y: gyroPosRef.r0.y, z: gyroPosRef.r0.z } };
  }
  function updateCamPosFromGyro() {
    if (!gyroPosRef) return false;
    /* Δq = q_now · q_align⁻¹（世界系里的旋转增量） */
    _gqTmp.copy(gyroPosRef.q0).invert();
    _gqAll.copy(camera.quaternion).multiply(_gqTmp);
    camera.position.copy(_gv.copy(gyroPosRef.r0).applyQuaternion(_gqAll)).add(GIMBAL.pivot);
    return true;
  }

  /* ========================================================================
     ④ 桌面 / 预览环境：手动转视角

     真机靠陀螺仪转视角；桌面没有陀螺仪，就没有任何办法把
     「转向哪边只显示哪边」看出来。开启后：在画面上拖动 = 转动平板。
       yaw   = 0  → 看向沙盘中心；>0 → 向左转
       pitch = 向下俯角（度）；传 null 则沿用「看向中心」的俯角
     ======================================================================== */
  let manualLook = false;
  let lookYawDeg = 0, lookPitchDeg = null;
  let overrideQuat = null;

  function setAim(yawDeg, pitchDeg) {
    /* 用【标称位置】算，而不是读 camera.position —— 后者依赖调用顺序
       （对齐前 position 还是初始值），会出现「同一组角度在不同时刻看出不同方向」。
       另外：相机 → 沙盘中心 的方向是 (-eye.x, -eye.z)，写 atan2(eye.x, eye.z)
       会得到【背离中心】的方位（相机在 +Z 时算成 0 而不是 π），
       于是 yaw=0 反而看向沙盘外侧。这个坑踩过一次。 */
    const eye = nominalPosition();
    const horiz = Math.hypot(eye.x, eye.z);
    const baseYaw = Math.atan2(-eye.x, -eye.z);
    const P = params();
    const basePitch = (P && typeof P.nominalPitch === 'number')
      ? P.nominalPitch
      : THREE.MathUtils.radToDeg(Math.atan2(eye.y, horiz));
    const yaw = baseYaw + THREE.MathUtils.degToRad(yawDeg);
    const pitch = THREE.MathUtils.degToRad(pitchDeg === null ? basePitch : pitchDeg);
    const dir = new THREE.Vector3(
      Math.sin(yaw) * Math.cos(pitch),
      -Math.sin(pitch),
      Math.cos(yaw) * Math.cos(pitch)
    );
    _m4.lookAt(eye, eye.clone().add(dir), UP_Y);
    overrideQuat = new THREE.Quaternion().setFromRotationMatrix(_m4);
    camera.quaternion.copy(overrideQuat);
    return { yawDeg, pitchDeg: THREE.MathUtils.radToDeg(pitch) };
  }

  function setManualLook(on) {
    manualLook = !!on;
    if (manualLook) { lookYawDeg = 0; lookPitchDeg = null; setAim(lookYawDeg, lookPitchDeg); }
    else overrideQuat = null;
    return manualLook;
  }
  function nudgeLook(dYawDeg, dPitchDeg) {
    if (!manualLook) setManualLook(true);
    lookYawDeg += dYawDeg;
    const eye = nominalPosition();
    const P = params();
    const basePitch = (P && typeof P.nominalPitch === 'number')
      ? P.nominalPitch
      : THREE.MathUtils.radToDeg(Math.atan2(eye.y, Math.hypot(eye.x, eye.z)));
    if (lookPitchDeg === null) lookPitchDeg = basePitch;
    lookPitchDeg = Math.max(-80, Math.min(80, lookPitchDeg + dPitchDeg));
    setAim(lookYawDeg, lookPitchDeg);
    return { yawDeg: lookYawDeg, pitchDeg: lookPitchDeg };
  }
  function resetLook() {
    lookYawDeg = 0; lookPitchDeg = null;
    if (manualLook) setAim(0, null);
    else if (aligned) alignNow(true);
  }

  /* 拖动 = 转视角。
     ★ 语义与灵敏度都照抄参考项目：0.075 °/px，且是「把世界抓过来」——
       向右拖 = 向左转、向下拖 = 抬头。这样和参考项目的手感一致：
       参考项目里 setAngle(yaw + dx·.075, pitch + dy·.075)，其中它自己的
       pitch 是「抬头为正」，而我们的 lookPitchDeg 是「俯角为正」，所以差一个负号。 */
  const DRAG_DEG_PER_PX = 0.075;
  function dragLook(clientX, clientY, from) {
    const dYaw = (clientX - from.x) * DRAG_DEG_PER_PX;         // 正 = 向左转
    const eye = nominalPosition();
    const P = params();
    const basePitch = (P && typeof P.nominalPitch === 'number')
      ? P.nominalPitch
      : THREE.MathUtils.radToDeg(Math.atan2(eye.y, Math.hypot(eye.x, eye.z)));
    const p0 = from.pitch === null ? basePitch : from.pitch;   // 俯角
    const dPitchUp = (clientY - from.y) * DRAG_DEG_PER_PX;     // 正 = 抬头
    lookYawDeg = from.yaw + dYaw;
    lookPitchDeg = Math.max(-80, Math.min(80, p0 - dPitchUp));
    setAim(lookYawDeg, lookPitchDeg);
    return { yawDeg: lookYawDeg, pitchDeg: lookPitchDeg };
  }
  function dragStart() {
    return { x: 0, y: 0, yaw: lookYawDeg, pitch: lookPitchDeg };
  }

  /* ========================================================================
     ⑤ 每帧位姿
     ======================================================================== */
  const _qGoal = new THREE.Quaternion();

  /* 返回值：本帧是否可以渲染模型。
     false = 对齐前（或等陀螺仪时的兜底窗口内），调用方只清屏、不画模型。 */
  function updatePose(dtSec) {
    const P = params();

    /* 云台角度驱动（drive='manual'）：位置和朝向【都由两个角度决定】，与陀螺仪无关。
       放在对齐门槛之前：它本来就不依赖陀螺仪，没理由等对齐。 */
    if (P.gimbal.on && P.gimbal.drive === 'manual') {
      syncGimbalPivot();
      gimbalPoseAt(P.gimbal.yawDeg, P.gimbal.pitchDeg, camera.position, camera.quaternion);
      camera.updateMatrixWorld();
      return true;
    }

    /* 手动转视角（桌面演示）：姿态完全由拖动决定，与陀螺仪无关，
       同样不该等对齐 —— 桌面本来就没有陀螺仪，等下去就是永远空白。 */
    if (manualLook && overrideQuat) {
      applyNominalPosition();
      camera.quaternion.copy(overrideQuat);
      camera.updateMatrixWorld();
      return true;
    }

    applyNominalPosition();

    if (!aligned && !fallbackShow) { clearedFrames++; return false; }

    if (haveOrient && aligned) {
      readDeviceQuat(qDev);
      _qGoal.copy(alignQuat).multiply(qDev);
      /* ---------- 姿态平滑 ----------
         静止时 Android 把 deviceorientation 降到 ~1 Hz，直接 copy 会让视角
         「一跳一跳」。用 slerp 按帧率做指数平滑，时间常数 τ = smoothMs：
         k = 1 - exp(-dt/τ)。τ 越大越顺滑但延迟越大；设 0 则直通（对比用）。
         注意不能用固定系数 —— 帧率变化时固定系数会改变手感。
         但【对齐那一刻必须吸附】：否则第一帧还会从旧姿态平滑过去，
         等于把「一次跳变」换成「一次 140 ms 的滑动」，观感上照样是「转了一下」。 */
      if (snapPose || P.smoothMs <= 0) {
        camera.quaternion.copy(_qGoal);
        snapPose = false;
      } else {
        const k = 1 - Math.exp(-dtSec * 1000 / P.smoothMs);
        camera.quaternion.slerp(_qGoal, k);
      }
    }

    /* 云台 drive='gyro'：位置必须【在姿态之后】推 —— 它依赖本帧的相机四元数。
       顺序写反的话位置永远滞后一帧，转动时会看到标注在画面上抖。 */
    if (P.gimbal && P.gimbal.on && P.gimbal.drive === 'gyro') {
      if (!gyroPosRef) captureGyroPosRef();
      syncGimbalPivot();
      updateCamPosFromGyro();
    }

    camera.updateMatrixWorld();
    return true;
  }

  /* ========================================================================
     ⑥ 视野裁剪 + 遮挡剔除
     ======================================================================== */
  const _viewInv = new THREE.Matrix4();
  const _proj = new THREE.Matrix4();
  const _v = new THREE.Vector3();
  const _occUv = new THREE.Vector2();

  /* 每帧调一次：把矩阵算好，judge() 里就不用重复求逆 */
  let prepareN = 0;
  function prepare() {
    camera.updateMatrixWorld();
    _viewInv.copy(camera.matrixWorld).invert();
    _proj.multiplyMatrices(camera.projectionMatrix, _viewInv);
    prepareN++;
  }

  /* NDC 边距。相机后方的点（视空间 z >= -near）直接判 -Infinity，
     避免透视除法翻号 —— 翻号会让「相机背后的点」看起来像在画面正中。

     ⚠️⚠️ 这里有一个【必须分开乘两次】的地方，我把它写成一次合并矩阵时踩过：

       ❌ 错误写法（合并矩阵 + 已变换的向量）：
          _v.copy(target).applyMatrix4(_viewInv);     // 已经进了视空间
          _v.applyMatrix4(_proj);                     // _proj = P·V → V 又乘了一遍！
        等价于 P·V·V·target。实测后果：11 个锚点只剩 2 个判成「在视野内」，
        而且它和同一帧里 `.project(camera)` 算出的像素位置【互相矛盾】——
        一个说在画面里、一个说在画面外。正是这个矛盾把它暴露出来的。

       ✅ 正确：视变换之后只能再乘【投影矩阵本身】。或者像 ar-gyro-demo 那样
          从【原始世界坐标】一次乘 P·V。两条路都对，混着用就错。 */
  function scoreAt(target) {
    _v.copy(target).applyMatrix4(_viewInv);
    if (_v.z > -camera.near) return -Infinity;
    _v.applyMatrix4(camera.projectionMatrix);
    return Math.min(1 - Math.abs(_v.x), 1 - Math.abs(_v.y));
  }

  /* 判据交叉验证 —— 用【三条独立路径】重算同一个 NDC，必须逐分量一致：
       路径 A：scoreAt —— 先 V 后 P（复用 _v）
       路径 B：合并矩阵 P·V 一次乘到【原始世界坐标】上
       路径 C：.project(camera) —— Three 内置路径（先 viewInv 后 projection）
     三条路径对同一个点给出同一个 NDC；一旦有人把合并矩阵和视空间向量混用
     （P·V·V 的双重变换），这里立刻就能发现。 */
  function crossCheck(target) {
    const view = target.clone().applyMatrix4(_viewInv);
    const behind = view.z > -camera.near;
    if (behind) return { behind: true, score: scoreAt(target), allNdc: null };
    const a = target.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, _viewInv)); // 合并一次
    const b = view.clone().applyMatrix4(camera.projectionMatrix);                              // 先 V 后 P（scoreAt 走的路径）
    const c = target.clone().project(camera);                                                   // 相机自带路径
    return {
      behind: false,
      score: scoreAt(target),
      ndcCombined: a.toArray(),
      ndcTwoStep: b.toArray(),
      ndcProject: c.toArray(),
    };
  }

  /* 世界坐标 → 地形 uv。⚠️ 这里【不涉及墨卡托】：
     geoUv(lon,lat) 已经把经纬度变成了 uv，地形网格的 uv 直接线性映射到 x/z。 */
  function worldToUv(x, z, out) {
    const P = params();
    const scale = P.terrainScale || 1.0;
    const p = new THREE.Vector3(x - (P.shiftX || 0), 0, z - (P.shiftZ || 0));
    p.applyAxisAngle(UP_Y, +Math.PI / 2);
    const u = p.x / (P.tableW * scale) + 0.5;
    const v = 0.5 - p.z / (P.tableD * scale);
    return (out || new THREE.Vector2()).set(u, v);
  }

  /* ---------- 遮挡：沿视线 48 步高度场行军 ----------
     为什么不用 raycaster.intersectObject(terrain)：
     15 万三角形 × 11 个锚点 × 60 fps ≈ 每秒 1 亿次求交，扛不住。
     高度场查表 O(1)，48 步 × 11 个锚点 = 每帧 528 次采样，可以忽略。 */
  function isAnchorOccluded(camPos, target, wasOccluded) {
    const P = params();
    const thr = wasOccluded ? OCC_EPS_OUT : OCC_EPS_IN;
    const dx = target.x - camPos.x, dy = target.y - camPos.y, dz = target.z - camPos.z;
    const scale = P.terrainScale || 1.0;
    const halfW = P.tableW * scale * 0.5, halfD = P.tableD * scale * 0.5;
    const centerX = P.shiftX || 0, centerZ = P.shiftZ || 0;
    const yOff = P.terrainYOffset || 0;
    for (let i = 1; i <= OCC_STEPS; i++) {
      const t = OCC_T0 + (OCC_T1 - OCC_T0) * (i / OCC_STEPS);
      const x = camPos.x + dx * t, y = camPos.y + dy * t, z = camPos.z + dz * t;
      /* 采样点跑到沙盘外就不比了 —— 外面没有地形，比出来的都是假的 */
      const p = new THREE.Vector3(x - centerX, 0, z - centerZ);
      p.applyAxisAngle(UP_Y, +Math.PI / 2);
      if (Math.abs(p.x) > halfW || Math.abs(p.z) > halfD) continue;
      const u = p.x / (P.tableW * scale) + 0.5;
      const v = 0.5 - p.z / (P.tableD * scale);
      _occUv.set(u, v);
      const fieldY = P.heightAtUv(_occUv) * scale + yOff;
      if (fieldY - y > thr) return true;
    }
    return false;
  }

  /* 一个锚点的完整判定。prev 传上一帧的结论，滞回才生效。 */
  function judge(target, prevInView, prevOccluded) {
    const P = params();
    const score = scoreAt(target);
    /* 滞回：已显示的容忍到 AR_NDC_OUT，未显示的必须到 AR_NDC_IN */
    const inView = prevInView ? score > AR_NDC_OUT : score > AR_NDC_IN;
    /* 遮挡只在「视野内」才查 —— 出画的锚点本来就该藏，再花 48 步算它是否被挡纯属浪费。
       而且遮挡开关与裁剪开关联动：关掉裁剪就是「一次性全渲染」对比模式，
       此时一并关掉遮挡，否则 A/B 对比组不干净。 */
    const occluded = (P.cull && P.occlusion && inView)
      ? isAnchorOccluded(camera.position, target, prevOccluded) : false;
    return { score, inView, occluded, visible: (P.cull ? inView : true) && !occluded };
  }

  /* 诊断用：把整条视线上的采样点吐出来，供自动化验证比对两个独立的高度源 */
  function occlusionRay(camPos, target, n = OCC_STEPS) {
    const P = params();
    const out = [];
    const dx = target.x - camPos.x, dy = target.y - camPos.y, dz = target.z - camPos.z;
    const scale = P.terrainScale || 1.0;
    const halfW = P.tableW * scale * 0.5, halfD = P.tableD * scale * 0.5;
    const centerX = P.shiftX || 0, centerZ = P.shiftZ || 0;
    const yOff = P.terrainYOffset || 0;
    for (let i = 1; i <= n; i++) {
      const t = OCC_T0 + (OCC_T1 - OCC_T0) * (i / n);
      const x = camPos.x + dx * t, y = camPos.y + dy * t, z = camPos.z + dz * t;
      const p = new THREE.Vector3(x - centerX, 0, z - centerZ);
      p.applyAxisAngle(UP_Y, +Math.PI / 2);
      if (Math.abs(p.x) > halfW || Math.abs(p.z) > halfD) continue;
      const u = p.x / (P.tableW * scale) + 0.5;
      const v = 0.5 - p.z / (P.tableD * scale);
      _occUv.set(u, v);
      const fieldY = P.heightAtUv(_occUv) * scale + yOff;
      out.push({
        t: Number(t.toFixed(5)), rayY: y,
        fieldY,
        meshY: P.meshYAt ? P.meshYAt(x, z) : null,
      });
    }
    return out;
  }

  /* ========================================================================
     ⑦ 遥测
     ======================================================================== */
  function sampleCoverage() {
    const total = stillMs + movingMs;
    const secs = t0 ? (performance.now() - t0) / 1000 : 0;
    return {
      effectiveSec: Number((total / 1000).toFixed(1)),
      droppedN,
      coverage: secs > 0 ? Number((total / 1000 / secs).toFixed(3)) : 0,
    };
  }
  function staticDriftPerMin() {
    if (stillMs < STILL_MIN_MS) return null;
    return stillDriftDeg / (stillMs / 60000);
  }
  function staticDriftTxt() {
    const r = staticDriftPerMin();
    return r === null ? '采样中 ' + (stillMs / 1000).toFixed(0) + 's' : r.toFixed(2) + ' °/min';
  }
  /* 相对对齐时刻的偏转角（转动 + 漂移的混合，不能当漂移用）。
     用 α 之差是【跨屏幕方向成立】的：α 恒等于「绕世界竖直轴的偏航」，
     与屏幕方向无关。曾经怀疑「横屏下应该用 β」，那是把 Rz(α)Rx(β)Ry(γ) 的
     乘法顺序想反了 —— α 作用在最后，所以它始终是世界偏航。 */
  function yawFromAlign() {
    if (alignAlpha === null) return null;
    return wrap180(alpha - alignAlpha);
  }
  function alphaAbsoluteVerdict() {
    if (offN < 20) return { verdict: 'no-data', samples: offN, offMaxAbs: null };
    if (offMaxAbs > 20) return { verdict: 'relative', samples: offN, offMaxAbs: Number(offMaxAbs.toFixed(2)) };
    if (offMaxAbs < 5 && yawTravelledDeg > 120) return { verdict: 'likely-absolute', samples: offN, offMaxAbs: Number(offMaxAbs.toFixed(2)) };
    return { verdict: 'inconclusive', samples: offN, offMaxAbs: Number(offMaxAbs.toFixed(2)) };
  }
  /* 支架仰角是否落在安全区（现场装支架时就要能看出「这个角度行不行」） */
  function standTiltVerdict() {
    if (lastB === null) return { verdict: 'no-data' };
    const pitch = lastB;
    const ok = pitch > 0 && pitch < 75;
    return { verdict: ok ? 'ok' : 'warn', pitch: Number(pitch.toFixed(1)), safe: [0, 75] };
  }

  /* 相机实际朝向相对「看向沙盘中心」的偏角 —— 面板上「水平 / 垂直」两个读数。
     ★ 符号约定与参考项目一致：水平 >0 = 向左转，垂直 >0 = 抬头（它自己的
       settings.yaw / settings.pitch 就是这个方向）。而 lookPitchDeg 是俯角、
       且相机转向左侧时 atan2(dir.x,dir.z) 是【减小】的，所以两处都要取负。 */
  function viewAnglesDeg() {
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    const eye = camera.position;
    const toCenter = new THREE.Vector3(-eye.x, -eye.y, -eye.z).normalize();
    const yaw = THREE.MathUtils.radToDeg(
      Math.atan2(toCenter.x, toCenter.z) - Math.atan2(dir.x, dir.z)
    );
    const pitch = THREE.MathUtils.radToDeg(
      Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1)) - Math.asin(THREE.MathUtils.clamp(toCenter.y, -1, 1))
    );
    return { yaw: wrap180(yaw), pitch };
  }

  /* ========================================================================
     ⑧ 事件绑定
     ======================================================================== */
  let t0 = 0;
  let fallbackTimer = 0;
  let attached = false;

  function attach() {
    if (attached) return;
    attached = true;
    t0 = performance.now();
    addEventListener('deviceorientation', onOrient);
    addEventListener('devicemotion', onMotion);
    addEventListener('deviceorientationabsolute', onOrientAbs);
    /* 陀螺仪迟迟不来时先把模型按固定视角显示出来，总比一直空白好 */
    fallbackTimer = setTimeout(() => {
      if (!haveOrient && !fallbackShow) { fallbackShow = true; onFallbackShow(); }
    }, FALLBACK_SHOW_MS);
  }
  function detach() {
    if (!attached) return;
    attached = false;
    removeEventListener('deviceorientation', onOrient);
    removeEventListener('devicemotion', onMotion);
    removeEventListener('deviceorientationabsolute', onOrientAbs);
    clearTimeout(fallbackTimer);
  }

  /* iOS 13+ 必须在【用户手势】里申请权限，且只能申请一次 */
  async function requestPermission() {
    const D = window.DeviceOrientationEvent;
    const M = window.DeviceMotionEvent;
    try {
      if (D && typeof D.requestPermission === 'function') {
        const r = await D.requestPermission();
        if (r !== 'granted') return { ok: false, reason: 'deviceorientation: ' + r };
      }
      if (M && typeof M.requestPermission === 'function') {
        const r = await M.requestPermission();
        if (r !== 'granted') return { ok: false, reason: 'devicemotion: ' + r };
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: e.name + ': ' + (e.message || '') };
    }
  }

  return {
    attach, detach, requestPermission,
    align: alignNow, zeroDrift,
    updatePose, prepare, judge, scoreAt, isAnchorOccluded, occlusionRay, worldToUv,
    setManualLook, nudgeLook, resetLook, dragLook, dragStart,
    isManualLook: () => manualLook,
    isAligned: () => aligned,
    hasGyro: () => haveOrient,
    poseReady: () => manualLook || (aligned || fallbackShow),
    nominalPosition,
    syncGimbalPivot,
    captureGyroPosRef,
    viewAnglesDeg,
    crossCheck,
    get prepareCount() { return prepareN; },
    staticDriftTxt,
    currentHz,
    isLandscape,
    screenAngleDeg,
    setMotionFusion: v => { motionFusion = !!v; },
    setMotionGain: v => { motionGain = Number(v) || 0; },
    /* 直接注入姿态 —— 自动化测试用合成姿态驱动相机，不依赖真实传感器 */
    pushOrient({ alpha: a, beta: b, gamma: g }) {
      onOrient({ alpha: a, beta: b, gamma: g });
    },
    get debug() {
      return {
        haveOrient, aligned, alignCount, clearedFrames, snapPose, fallbackShow,
        orientN, orientGapMs: Number(orientGapMs.toFixed(1)),
        stillMs: Number(stillMs.toFixed(1)),
        movingMs: Number(movingMs.toFixed(1)),
        stillDriftDeg: Number(stillDriftDeg.toFixed(4)),
        staticDriftPerMin: staticDriftPerMin(),
        yawFromAlignDeg: yawFromAlign(),
        yawTravelledDeg: Number(yawTravelledDeg.toFixed(1)),
        haveMotion, motionN, motionHz: Number(motionHz.toFixed(2)),
        motionGapMs: Number(lastMotionGapMs.toFixed(1)),
        motionUsedDtMs: Number(lastMotionUsedDtMs.toFixed(1)),
        rawMotion: { alpha: lastRateAlpha, beta: lastRateBeta, gamma: lastRateGamma },
        motionFusion, motionGain,
        raw: { alpha: lastA, beta: lastB, gamma: lastG, screenAngle: screenAngleDeg() },
        standTilt: standTiltVerdict(),
        alphaAbsolute: alphaAbsoluteVerdict(),
        absEventN,
        manualLook,
        ...sampleCoverage(),
      };
    },
  };
}

/* 把阈值也导出去 —— 自动化验证必须【从模块读】而不是在测试里写死，
   否则改了阈值测试还是绿的，等于没测。 */
export const AR_CULL_THRESHOLDS = { in: AR_NDC_IN, out: AR_NDC_OUT };
export const OCCLUSION_THRESHOLDS = { steps: OCC_STEPS, in: OCC_EPS_IN, out: OCC_EPS_OUT };
