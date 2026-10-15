"""Convert the downloaded Hunan elevation array into compact web demo assets."""

from pathlib import Path
import json

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent
DEM = ROOT / "source-data" / "dem"
if not DEM.exists():
    DEM = ROOT.parent / "dem"
SOURCE = DEM / "湖南高程_米.npy"
MASK = DEM / "湖南轮廓_遮罩.png"
OUT = ROOT / "assets"
OUT.mkdir(exist_ok=True)

height = np.load(SOURCE)
mask = np.asarray(Image.open(MASK).convert("L")) > 0
safe = np.where(np.isfinite(height), height, 0)

# A restrained terrain tint with actual elevation and slope relief, no map labels.
gy, gx = np.gradient(safe)
shade = np.clip(0.82 + (-gx * 0.025 + gy * 0.018), 0.55, 1.22)
stops = np.array([0, 80, 300, 700, 1300, 2076], dtype=float)
colors = np.array([
    [71, 88, 72], [89, 107, 78], [110, 120, 86],
    [139, 139, 105], [166, 156, 125], [192, 188, 163]
], dtype=float)
rgb = np.stack([np.interp(safe, stops, colors[:, c]) for c in range(3)], axis=2)
rgb = np.uint8(np.clip(rgb * shade[..., None], 0, 255))
rgba = np.dstack([rgb, np.uint8(mask) * 255])
Image.fromarray(rgba).resize((1014, 1159), Image.Resampling.LANCZOS).save(OUT / "terrain-color.png", optimize=True)

# Vertex heights in row-major image order, from north to south.
grid_width, grid_height = 256, 292
small = Image.fromarray(safe.astype(np.float32), mode="F").resize(
    (grid_width, grid_height), Image.Resampling.BILINEAR
)
grid = np.asarray(small, dtype="<f4")
grid.tofile(OUT / "terrain-height.f32")

small_mask = Image.fromarray(np.uint8(mask) * 255).resize(
    (grid_width, grid_height), Image.Resampling.NEAREST
)
small_mask.save(OUT / "terrain-mask.png")

(OUT / "terrain-meta.json").write_text(json.dumps({
    "width": grid_width,
    "height": grid_height,
    "elevation_min_m": float(np.nanmin(height)),
    "elevation_max_m": float(np.nanmax(height)),
    "source": "../dem/数据说明.json",
}, ensure_ascii=False, indent=2) + "\n")
print(f"Created {grid_width}x{grid_height} terrain grid and color texture in {OUT}")
