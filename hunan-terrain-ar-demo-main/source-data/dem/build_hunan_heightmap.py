"""Build a Hunan-only heightmap from public Mapzen Terrarium elevation tiles."""

import concurrent.futures
import io
import json
import math
import time
from pathlib import Path

import numpy as np
import requests
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent
ZOOM = 9
TILE_SIZE = 256
MARGIN = 0.08  # degrees around the province
BOUNDARY_API = "https://www.geoboundaries.org/api/current/gbOpen/CHN/ADM1/"
TILE_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"


def pixel(lon, lat):
    n = 2**ZOOM * TILE_SIZE
    lat = max(min(lat, 85.05112878), -85.05112878)
    return (
        (lon + 180) / 360 * n,
        (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n,
    )


def get_tile(tile):
    x, y = tile
    url = TILE_URL.format(z=ZOOM, x=x, y=y)
    cache = OUT / "tile_cache" / str(ZOOM) / str(x) / f"{y}.png"
    if cache.exists():
        content = cache.read_bytes()
    else:
        for attempt in range(5):
            try:
                response = requests.get(url, timeout=45)
                response.raise_for_status()
                content = response.content
                Image.open(io.BytesIO(content)).verify()
                cache.parent.mkdir(parents=True, exist_ok=True)
                cache.write_bytes(content)
                break
            except (requests.RequestException, OSError):
                if attempt == 4:
                    raise
                time.sleep(attempt + 1)
    image = Image.open(io.BytesIO(content)).convert("RGB")
    if image.size != (TILE_SIZE, TILE_SIZE):
        raise ValueError(f"Unexpected tile size: {url}: {image.size}")
    return tile, np.asarray(image, dtype=np.float32)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    boundary_meta = requests.get(BOUNDARY_API, timeout=30).json()
    features = requests.get(boundary_meta["gjDownloadURL"], timeout=45).json()["features"]
    province = next(f for f in features if f["properties"]["shapeName"] == "Hunan Province")
    rings = province["geometry"]["coordinates"]
    points = [p for ring in rings for p in ring]
    west, east = min(p[0] for p in points) - MARGIN, max(p[0] for p in points) + MARGIN
    south, north = min(p[1] for p in points) - MARGIN, max(p[1] for p in points) + MARGIN
    left, top = pixel(west, north)
    right, bottom = pixel(east, south)
    x0, y0 = math.floor(left), math.floor(top)
    x1, y1 = math.ceil(right), math.ceil(bottom)
    width, height = x1 - x0, y1 - y0

    tile_x = range(x0 // TILE_SIZE, (x1 - 1) // TILE_SIZE + 1)
    tile_y = range(y0 // TILE_SIZE, (y1 - 1) // TILE_SIZE + 1)
    tiles = [(x, y) for y in tile_y for x in tile_x]
    rgb = np.zeros((height, width, 3), dtype=np.float32)
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        for (tx, ty), data in pool.map(get_tile, tiles):
            sx, sy = tx * TILE_SIZE - x0, ty * TILE_SIZE - y0
            dx0, dy0 = max(0, sx), max(0, sy)
            dx1, dy1 = min(width, sx + TILE_SIZE), min(height, sy + TILE_SIZE)
            rgb[dy0:dy1, dx0:dx1] = data[dy0 - sy:dy1 - sy, dx0 - sx:dx1 - sx]

    # Terrarium: meters = R * 256 + G + B / 256 - 32768.
    elevation = rgb[:, :, 0] * 256 + rgb[:, :, 1] + rgb[:, :, 2] / 256 - 32768
    mask_image = Image.new("L", (width, height), 0)
    draw = ImageDraw.Draw(mask_image)
    for index, ring in enumerate(rings):
        polygon = [(pixel(lon, lat)[0] - x0, pixel(lon, lat)[1] - y0) for lon, lat in ring]
        draw.polygon(polygon, fill=255 if index == 0 else 0)
    mask = np.asarray(mask_image) > 0
    if not mask.any():
        raise ValueError("Province mask is empty")
    # A few isolated negative pits in the source tiles are data artifacts in inland Hunan.
    bad = mask & (elevation < 0)
    bad_count = int(bad.sum())
    for y, x in np.argwhere(bad):
        y0n, y1n = max(0, y - 2), min(height, y + 3)
        x0n, x1n = max(0, x - 2), min(width, x + 3)
        nearby = elevation[y0n:y1n, x0n:x1n]
        valid = mask[y0n:y1n, x0n:x1n] & (nearby >= 0)
        if valid.any():
            elevation[y, x] = float(np.median(nearby[valid]))
    inside = elevation[mask]
    minimum, maximum = float(inside.min()), float(inside.max())
    normalized = np.clip((elevation - minimum) / (maximum - minimum), 0, 1)
    height16 = np.rint(normalized * 65535).astype(np.uint16)
    height16[~mask] = 0
    Image.fromarray(height16).save(OUT / "湖南高程_16位高度图.png")
    mask_image.save(OUT / "湖南轮廓_遮罩.png")
    np.save(OUT / "湖南高程_米.npy", np.where(mask, elevation, np.nan).astype(np.float32))
    preview_gray = np.uint8(np.sqrt(normalized) * 255)
    preview_gray[~mask] = 0
    preview = Image.fromarray(preview_gray, mode="L").convert("RGBA")
    preview.putalpha(mask_image)
    preview.save(OUT / "湖南高程_预览.png")
    metadata = {
        "source": "Mapzen Terrain Tiles (Terrarium) via AWS Open Data",
        "source_url": "https://registry.opendata.aws/terrain-tiles/",
        "boundary_source": "geoBoundaries gbOpen CHN ADM1, Hunan Province",
        "boundary_url": BOUNDARY_API,
        "zoom": ZOOM,
        "tile_count": len(tiles),
        "size_pixels": [width, height],
        "extent_lonlat": [west, south, east, north],
        "projection": "Web Mercator / EPSG:3857",
        "pixel_origin_global": [x0, y0],
        "elevation_min_m": minimum,
        "elevation_max_m": maximum,
        "negative_source_spikes_replaced": bad_count,
        "heightmap_decode_m": "png_value / 65535 * (elevation_max_m - elevation_min_m) + elevation_min_m",
        "outside_province": "Use the separate mask PNG; zero in heightmap alone is ambiguous",
    }
    (OUT / "数据说明.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(metadata, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
