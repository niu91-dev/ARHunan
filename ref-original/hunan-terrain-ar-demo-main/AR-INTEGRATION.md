# AR 接入必须复核：稳定性与内容跟踪

本网页是鼠标驱动的几何预览，不能代表真实 AR 识别稳定性。画面左下角红字保留此提醒。

## 当前已做的界面处理

- 进入图标原始半径 18 px 才计时；退出使用放大后的 36 px 半径。
- 持续停留 0.5 秒展开；移出后给予 160 ms 短时容错，避免边缘抖动反复开关。
- 已聚焦图标和资料连线共用同一个屏幕锚点：0.7 px 微动死区，65 ms 帧率无关平滑。大幅移动立即跟随。
- 卡片根节点与 SVG 曲线末端使用同一坐标。图片从该根节点放大，回收顺序相反。

## 最终设备接入时的工作

1. 地形、地点图标、连线及资料根节点绑定同一稳定世界锚点。不要分别滤波造成互相漂移。
2. 对识别测得的沙盘锚点位置、旋转评估 One Euro 等自适应滤波与 quaternion slerp；保留平台的相机预测与重投影，避免直接平滑相机造成观察延迟。
3. 跟踪短暂丢失可短时保持最后可靠位姿；持续丢失应淡出并提示重新定位，不能一直显示过期锚点。
4. 在实际 Pad、观察距离和光照下测量抖动、延迟、坐标漂移、重定位跳变，再决定上述阈值；网页像素参数不直接等于设备角度阈值。
5. 现场验收须包含小幅手抖、快速转动、地点边界停留、遮挡识别物、重新入镜以及低帧率情形。当前未完成硬件测试。

相关实现：`app.js` 的 `AR_UI_STABILITY`、`updateSites()` 和 `layoutStory()`。

微软参考：
- [Hologram stability](https://learn.microsoft.com/en-us/windows/mixed-reality/develop/advanced-concepts/hologram-stability)
- [Room scan visualization](https://learn.microsoft.com/en-us/windows/mixed-reality/design/room-scan-visualization)

视觉借鉴其空间表面扫描语言；本 Demo 的亮度和动效参数是自定义设计，不代表官方组件或已通过 HoloLens 认证。
