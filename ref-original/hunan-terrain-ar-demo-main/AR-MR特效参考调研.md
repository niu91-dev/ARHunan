# 湖南沙盘扫描 Demo：AR / MR 特效参考

检索日期：2026-09-28。当前网页是“固定 Pad 视角 + 三维沙盘”的模拟画面，还没有接入真实摄像头或物理沙盘定位。下面区分视觉特效素材与真正的 AR/MR 跟踪框架。

| 参考 | 能借鉴的部分 | 与当前 Web Demo 的关系 |
| --- | --- | --- |
| [Snap Lens Studio：Hologram 材质库](https://developers.snap.com/lens-studio/features/graphics/materials/material-editor/material-library) | 已成型的全息材质，含扫描线、闪烁与故障动画；可作为线条、亮度与动效节奏参考 | 素材在 Lens Studio 生态中，不能直接把材质文件丢进当前 Three.js 网页 |
| [Snap Lens Studio：VFX 模板工程](https://developers.snap.com/lens-studio/features/graphics/particles/vfx-editor/introduction-and-concepts) | 一整套可编辑粒子图与世界空间交互示例，可参考“扫描后局部浮起颗粒、边缘解构、热点确认”的组合 | 更适合拆解视觉语言与事件编排，再在网页重做 |
| [Zapworks Mattercraft：AR/VR/MR 起始模板](https://docs.zap.works/mattercraft/webxr/getting-started/) | 有 AR 与 MR passthrough 模板，包含相机与空间内容布置 | 若后续真的让 Pad 摄像头对准实体沙盘，可评估转到这个体系；需要账号和设备验证 |
| [Zapworks Mattercraft：粒子与状态/时间线](https://docs.zap.works/mattercraft/particles/using-particles/) | 内置粒子、行为动作、状态和时间线，适合做完整的“待机→定位→扫描→结果”效果链 | 属于平台内工作流，不是可直接复制到现有网页的特效包 |
| [pmndrs/postprocessing](https://github.com/pmndrs/postprocessing) | Three.js 的完整后处理库，含 Bloom、Grid、Scanline、Outline、Shock Wave、色差等；有[交互 Demo](https://pmndrs.github.io/postprocessing/public/demo/) | 最接近当前代码，可分步接入；点击波建议仍贴着地形做主效果，再用后处理做柔和辉光 |
| [Microsoft MRTK3：空间 UI](https://learn.microsoft.com/en-us/windows/mixed-reality/mrtk-unity/mrtk3-overview/) | Slate、近场菜单、空间按钮/滑杆等成体系的 MR 信息层级 | 更适合借鉴 UI 布局和交互距离，不适合直接作为 Web UI 代码包 |
| [8th Wall 开源示例](https://github.com/8thwall/8thwall/blob/main/examples/README.md) | 现有 World Effects / Image Targets 工程，可看真实摄像头画面上的定位、触地与叠加流程 | 原云平台已结束服务；开源框架可用，World Tracking 的 SLAM 在单独的二进制许可中，选型前要核对许可 |

## 对当前画面的建议

这份 Demo 的“僵硬”主要来自所有网格线始终同样亮、扫描波像一个匀速圆环、地形与环境之间缺少真实相机画面的融合线索。建议下一版按一个完整动作链设计：

1. **待机：** 网格只保留很淡的局部线段，间歇出现沿地形表面移动的短扫光；大部分时间让实体沙盘底图清楚可见。
2. **落点：** 点击后先用短促的定位环和细小粒子确认落点，避免扫描波直接突兀出现。
3. **扫描：** 一条有宽度、拖尾和衰减的波沿高程表面扩散；波经过时局部网格被点亮，波后迅速恢复；只让发亮部分参与 Bloom。
4. **结果：** 扫描结束留下短暂的高度等值线或局部信息卡，再收回到待机态。
5. **实景融合：** 将来接入物理 Pad 相机时，必须另做沙盘定位/标定、透视匹配和遮挡处理；视觉特效包本身无法解决这些问题。[Unity AR Foundation 的遮挡示例](https://docs.unity.cn/Packages/com.unity.xr.arfoundation%406.5/manual/samples/features/occlusion.html)可以参考处理思路。

**优先建议：** 保留现有 Three.js 沙盘和相机交互，先用 `postprocessing` 的局部 Bloom / Scanline 与贴地形的扫描材质做一版更成熟的视觉节奏；Snap 的 Hologram 与 VFX 模板作为美术参照。等固定支架和实体沙盘尺寸确定，再选择 Mattercraft 或其他跟踪方案做真实摄像头叠加。
