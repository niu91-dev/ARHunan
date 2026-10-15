"""
校验 11 个地点的「经纬度 → UV → 世界坐标」是否越界，并打印各自的 DEM 高程。

用法：
    python tools/check-sites.py                 # 用页面里的默认沙盘宽度
    python tools/check-sites.py 2.40            # 按真实沙盘宽度算（★ 推荐）

⚠️ 为什么沙盘宽度要从页面读、而不是在这里写死：
    之前这里硬编码 `TABLE_W = 2.40`，而页面 `P.tableW` 默认 1.80 —— 两个真相来源
    悄悄分叉了，打印出来的「世界X / 世界Z」和页面实际渲染的对不上。

    `tableW` 不是随手可改的显示参数：**它必须等于真实沙盘的物理宽度**。
    虚拟地形的张角 = 2·atan((tableW/2) / camDist)，真实沙盘张角 = 2·atan((W_real/2) / d_real)。
    两者不等，虚拟地形和真实沙盘就对不上，AR 叠加会整体错位（缩放错）。
    所以现场校准时，这个值应当照着尺子量出来的沙盘宽度填。
"""
import re, math, pathlib, json, array, sys

pub = pathlib.Path(__file__).resolve().parent.parent / "public"
src = (pub / "sites.js").read_text(encoding="utf-8")

bounds = {k: float(v) for k, v in re.findall(r"(west|south|east|north):\s*([-\d.]+)", src)}
pat = re.compile(r"id:\s*'([^']+)'\s*,\s*name:\s*'([^']+)'[\s\S]*?lon:\s*([\d.]+)\s*,\s*lat:\s*([\d.]+)")
sites = pat.findall(src)

# ---------- 沙盘尺寸：以页面为唯一真相来源 ----------
html = (pub / "ar-gyro-demo.html").read_text(encoding="utf-8")
m_tw = re.search(r"tableW:\s*([\d.]+)", html)
m_asp = re.search(r"TERRAIN_ASPECT\s*=\s*([\d.]+)\s*/\s*([\d.]+)", html)
if not m_tw or not m_asp:
    sys.exit("从 public/ar-gyro-demo.html 里读不到 tableW / TERRAIN_ASPECT，脚本需要同步更新")

PAGE_TABLE_W = float(m_tw.group(1))
ASPECT = float(m_asp.group(1)) / float(m_asp.group(2))

if len(sys.argv) > 1:
    TABLE_W = float(sys.argv[1])
    src_note = "命令行指定"
else:
    TABLE_W = PAGE_TABLE_W
    src_note = "页面 P.tableW 默认值"
TABLE_D = TABLE_W * ASPECT


def merc(d):
    return math.log(math.tan(math.pi / 4 + d * math.pi / 360))


def geo_uv(lon, lat):
    return ((lon - bounds["west"]) / (bounds["east"] - bounds["west"]),
            (merc(lat) - merc(bounds["south"])) / (merc(bounds["north"]) - merc(bounds["south"])))


meta = json.loads((pub / "assets/terrain-meta.json").read_text())
g = array.array("f")
g.frombytes((pub / "assets/terrain-height.f32").read_bytes())
W, H = meta["width"], meta["height"]

print("地点数 = %d" % len(sites))
print("经纬范围 = %.4f~%.4f E, %.4f~%.4f N"
      % (bounds["west"], bounds["east"], bounds["south"], bounds["north"]))
print("沙盘 %.2f x %.2f m（%s；长宽比 %.4f 取自页面 TERRAIN_ASPECT）"
      % (TABLE_W, TABLE_D, src_note, ASPECT))
print("网格 %dx%d，高程上限 %s m" % (W, H, meta["elevation_max_m"]))
if abs(TABLE_W - PAGE_TABLE_W) > 1e-9:
    print("提示：页面默认是 %.2f m，本次按 %.2f m 计算 —— 现场请以量出来的真实宽度为准"
          % (PAGE_TABLE_W, TABLE_W))
print("⚠ tableW 必须等于【真实沙盘的物理宽度】，否则虚拟地形与真实沙盘张角不匹配、叠加会错位")

def sample(u, v):
    """UV → (世界X, 世界Z, DEM高程)。只写一份，避免两处各写各的写错。"""
    x = (u - 0.5) * TABLE_W
    z = (0.5 - v) * TABLE_D
    px = min(int(u * (W - 1)), W - 1)
    py = min(int((1 - v) * (H - 1)), H - 1)          # v 的 0 在下边，行号要翻过来
    return x, z, g[py * W + px]


print("\n%-14s %7s %7s %9s %9s %9s  %s" % ("地点", "u", "v", "世界X", "世界Z", "DEM高程", "越界"))
bad = []
for sid, name, lon, lat in sites:
    u, v = geo_uv(float(lon), float(lat))
    x, z, elev = sample(u, v)
    # 越界判据 |x| <= TABLE_W/2 等价于 |u-0.5| <= 0.5，与 TABLE_W 无关
    oob = ""
    if not (0.0 <= u <= 1.0 and 0.0 <= v <= 1.0):
        oob = "越界!"
        bad.append(name)
    print("%-14s %7.3f %7.3f %9.3f %9.3f %9.1f  %s" % (name, u, v, x, z, elev, oob))

print("\n越界地点:", bad if bad else "无")

rows = sorted((sample(*geo_uv(float(lo), float(la)))[2], nm) for _sid, nm, lo, la in sites)
print("\n各地点 DEM 高程排序（低 → 高）：")
for e, nm in rows:
    print("   %8.1f m  %s" % (e, nm))

km_per_cell = 111.32 * (bounds["east"] - bounds["west"]) / W
print("\n注意：网格约 %.1f km/格（东西向），孤立尖峰会被平滑压低 ——"
      % km_per_cell)
print("      所以山峰普遍偏低、平原与湖区准确，这是网格分辨率的必然结果，不是数据错误。")
