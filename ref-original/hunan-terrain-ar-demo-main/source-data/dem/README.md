# 湖南高程数据（全息扫描特效版）

这是一份只有地形起伏的湖南省数据，没有道路、地名或卫星影像。按 Mapzen Terrain Tiles 的 Terrarium 高程瓦片拼接，使用 geoBoundaries 的湖南省轮廓裁剪。输出采用 Web Mercator，约 2027 × 2318 像素；这版适合视觉特效，不用于测绘或工程设计。

## 文件

- `湖南高程_16位高度图.png`：16 位灰度高度图。黑色低，白色高；省界外为 0，需要搭配遮罩。
- `湖南轮廓_遮罩.png`：白色是湖南省，黑色是省界外。
- `湖南高程_米.npy`：原始高程数组，单位米，省界外为 NaN；适合 Python/三维程序读取。
- `湖南高程_预览.png`：便于查看的对比度增强预览，不应当用作真实高度图。
- `数据说明.json`：坐标范围、高度映射和来源。
- `build_hunan_heightmap.py`：可重复生成上述文件的脚本；`tile_cache/` 是原始瓦片缓存。

## 特效使用

将 16 位高度图作为位移贴图，高度乘数可从 2–5 倍视觉夸张开始调；以遮罩裁出省形。若需要真实米数：`高程米 = 像素值 / 65535 × 2076`。北部洞庭湖平原较低，西、南、东三侧山地较高。

## 来源与处理

- 高程：[Mapzen Terrain Tiles / AWS Open Data](https://registry.opendata.aws/terrain-tiles/)，Terrarium 格式，zoom 9；来源说明和致谢见 [Mapzen attribution](https://github.com/tilezen/joerd/blob/master/docs/attribution.md)。湖南所在区域主要基于全球 SRTM 高程。
- 轮廓：[geoBoundaries gbOpen 中国 ADM1](https://www.geoboundaries.org/api/current/gbOpen/CHN/ADM1/)，取 Hunan Province，Public Domain。
- 处理：把 Terrarium RGB 解码为米，拼接 90 张瓦片，以省界裁切；源数据中 236 个孤立的负高程尖点用邻域中位数修正。未叠加交通或地名图层。

如用于公开作品，建议在项目资料或片尾注明“Terrain data: Mapzen / USGS SRTM; boundary: geoBoundaries”。
