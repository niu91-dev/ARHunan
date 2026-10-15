# 湖南地形沙盘：扫描与锚点说明

## 视觉处理

- 采用暗色背景、小面积发光点、在实际相邻点云样本之间生成短连线。线段具有独立的随机强度和明灭节奏，扫光中心局部增强，扫过后逐渐退暗。扫光边缘用宽渐变与轻微形变打散。
- 中心瞄准点靠近地点锚点时，只调整点云亮度产生局部呼吸与扩散；没有实心光圈叠加到实体地形上。
- 地点文字放在深色背板内；地形上的标签尽量小，相互碰撞时仅保留光点，仍可通过右侧列表选择。
- 这些是参考 HoloLens 官方混合现实设计原则的网页视觉模拟，并非 HoloLens 原生应用或其官方组件。参考原则包括：控制大面积高亮、使用深色背板与较粗文字、把内容锚定于空间表面、在配准误差存在时保持交互可用。

参考：

- [Microsoft：Designing content for holographic display](https://learn.microsoft.com/en-us/windows/mixed-reality/design/designing-content-for-holographic-display)
- [Microsoft：Spatial mapping](https://learn.microsoft.com/en-us/windows/mixed-reality/design/spatial-mapping)
- [Microsoft：Room scan visualization](https://learn.microsoft.com/en-us/windows/mixed-reality/design/room-scan-visualization)
- [Microsoft：Comfort](https://learn.microsoft.com/en-us/windows/mixed-reality/design/comfort)

## 坐标与内容边界

经纬度由 Web Mercator 投到 DEM 范围。一个点不能表达整片平原、山脉、湖泊或河流，所以这些对象选取具有代表性的地点。崀山常见景区中心点处于当前省界蒙版以外，本版改用新宁侧的省内代表点；因此图上标注不用于精确地理定位。

| 地点 | 示意锚点 | 经度 | 纬度 |
|---|---|---:|---:|
| 张家界 | 张家界国家森林公园 | 110.4352 | 29.3499 |
| 岳麓山 | 岳麓山 | 112.9433 | 28.1947 |
| 崀山 | 崀山—新宁代表点 | 110.8600 | 26.4300 |
| 衡山 | 祝融峰 | 112.6847 | 27.3017 |
| 湘中丘陵 | 娄底以东丘陵代表点 | 112.1600 | 27.7400 |
| 雪峰山脉 | 苏宝顶主峰区域 | 110.3900 | 27.3000 |
| 洞庭湖平原 | 南县—安乡平原代表点 | 112.4000 | 29.3400 |
| 澧阳平原 | 澧县中部平原 | 111.7500 | 29.6400 |
| 洞庭湖 | 东洞庭湖水域代表点 | 112.9000 | 29.1800 |
| 沅水 | 沅陵段河道代表点 | 110.4100 | 28.4600 |
| 湘江 | 株洲段河道代表点 | 113.1500 | 27.8300 |

定位依据包括：[湖南衡山自然保护区范围](https://lyj.hunan.gov.cn/lyj/ztzl/gdzt/zrbhq/201512/t20151227_2587456.html)、[雪峰山风景名胜区规划](https://www.hjs.gov.cn/hjs/c123552/202209/ed1f10dc65f84b06ac44929ebe9766b6.shtml)、[澧县地理概况](https://www.li-xian.gov.cn/zjxs)、[东洞庭湖保护区范围](https://www.zgbk.com/ecph/words?ID=77010&SiteID=1&SubID=43370&Type=bkzyb)、[崀山景区位置](https://www.xnrongmei.com.cn/content/2011/09/30/10619436.html)。其余大范围要素按地貌区分布选取近似点。展项文案按用户草稿录入，科学表述和数值仍需单独审校。
