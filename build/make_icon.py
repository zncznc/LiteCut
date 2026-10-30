#!/usr/bin/env python3
"""生成 LiteCut 的应用图标（纯标准库，无第三方依赖）。

设计：深色圆角方块（与应用 UI 的 --bg #1b1b1c 一致）+ 两条轨道条（蓝 #3b82f6 / 绿 #22c55e）
+ 红色播放头竖线（占宽约 9%，小尺寸也看得见）+ 白色播放三角（只在中大尺寸出现）。
按尺寸分级简化：16/24px 去掉三角、加粗播放头，避免小尺寸糊成一团；>=32px 用完整构图。
全部按 2x 超采样后降采样，边缘干净。
输出：build/icon.ico（多尺寸 PNG 内嵌）+ build/icon-256.png（预览）+ build/icon-16-zoom.png（16px 放大 8 倍自查）。
用法：python build/make_icon.py
"""
import os
import struct
import zlib

OUT_DIR = os.path.dirname(os.path.abspath(__file__))
BG = (27, 27, 28)          # --bg
BLUE = (59, 130, 246)      # --accent
GREEN = (34, 197, 94)      # --accent2
RED = (239, 68, 68)        # --danger
WHITE = (245, 245, 248)
SIZES = [16, 24, 32, 48, 64, 128, 256]
SS = 2                     # 超采样倍数


def blank(n):
    return bytearray(n * n * 3)


def put(buf, n, x, y, color):
    if 0 <= x < n and 0 <= y < n:
        i = (y * n + x) * 3
        buf[i:i + 3] = bytes(color)


def rrect(buf, n, x0, y0, x1, y1, r, color):
    """圆角矩形（归一化坐标 0..1）"""
    X0, Y0, X1, Y1 = x0 * n, y0 * n, x1 * n, y1 * n
    R = r * n
    for y in range(int(Y0), int(Y1) + 1):
        if not (0 <= y < n):
            continue
        cy = min(max(y, Y0 + R), Y1 - R)
        for x in range(int(X0), int(X1) + 1):
            if not (0 <= x < n):
                continue
            cx = min(max(x, X0 + R), X1 - R)
            dx, dy = x - cx, y - cy
            if dx * dx + dy * dy <= R * R or (X0 <= x <= X1 and Y0 + R <= y <= Y1 - R) \
                    or (X0 + R <= x <= X1 - R and Y0 <= y <= Y1):
                put(buf, n, x, y, color)


def tri(buf, n, pts, color):
    (ax, ay), (bx, by), (cx, cy) = [(p[0] * n, p[1] * n) for p in pts]
    minx, maxx = int(min(ax, bx, cx)), int(max(ax, bx, cx)) + 1
    miny, maxy = int(min(ay, by, cy)), int(max(ay, by, cy)) + 1
    d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
    if d == 0:
        return
    for y in range(miny, maxy):
        for x in range(minx, maxx):
            a = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / d
            b = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / d
            c = 1 - a - b
            if a >= 0 and b >= 0 and c >= 0:
                put(buf, n, x, y, color)


def render(size):
    n = size * SS
    buf = blank(n)
    rrect(buf, n, 0.06, 0.06, 0.94, 0.94, 0.18, BG)              # 底板
    small = size <= 24
    if small:
        # 小尺寸：只留两条轨道 + 加粗播放头（三角在 16px 下不足 3px，反而糊）
        rrect(buf, n, 0.13, 0.280, 0.87, 0.460, 0.075, BLUE)
        rrect(buf, n, 0.13, 0.540, 0.56, 0.720, 0.075, GREEN)
        rrect(buf, n, 0.440, 0.140, 0.560, 0.860, 0.028, RED)
    else:
        rrect(buf, n, 0.13, 0.290, 0.87, 0.450, 0.07, BLUE)      # 轨道条 1（长）
        rrect(buf, n, 0.13, 0.550, 0.4675, 0.710, 0.07, GREEN)   # 轨道条 2（短）：右端正好停在播放头左缘
        # 播放三角在两条轨道之间、播放头右侧留一条小缝（读作“从这里播放”）
        tri(buf, n, [(0.575, 0.375), (0.77, 0.50), (0.575, 0.625)], WHITE)
        # 播放头：暗色描边 + 红色主体（红压在绿条上也能分清，对红绿色觉障碍更稳）
        o = max(1.0 / size, 0.010)                               # 描边 ≈ 该尺寸下 1px
        rrect(buf, n, 0.4675 - o, 0.150, 0.5325 + o, 0.850, 0.026, BG)
        rrect(buf, n, 0.4675, 0.160, 0.5325, 0.840, 0.023, RED)  # 播放头主体：占宽 6.5%
    # 降采样
    out = bytearray(size * size * 3)
    for y in range(size):
        for x in range(size):
            r = g = b = 0
            for dy in range(SS):
                for dx in range(SS):
                    i = ((y * SS + dy) * n + (x * SS + dx)) * 3
                    r += buf[i]; g += buf[i + 1]; b += buf[i + 2]
            k = SS * SS
            j = (y * size + x) * 3
            out[j] = r // k; out[j + 1] = g // k; out[j + 2] = b // k
    return bytes(out)


def png(size, rgb):
    """把 RGB 缓冲编码成 PNG（每行 filter=0）"""
    raw = bytearray()
    for y in range(size):
        raw.append(0)
        raw += rgb[y * size * 3:(y + 1) * size * 3]

    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data +
                struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) +
            chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b""))


def main():
    blobs = [(s, png(s, render(s))) for s in SIZES]
    # ICO 容器：ICONDIR + 每个尺寸的 ICONDIRENTRY + PNG 数据
    header = struct.pack("<HHH", 0, 1, len(blobs))
    offset = 6 + 16 * len(blobs)
    entries, data = b"", b""
    for s, blob in blobs:
        entries += struct.pack("<BBBBHHII", s if s < 256 else 0, s if s < 256 else 0,
                               0, 0, 1, 32, len(blob), offset)
        data += blob
        offset += len(blob)
    ico = os.path.join(OUT_DIR, "icon.ico")
    with open(ico, "wb") as f:
        f.write(header + entries + data)
    big = [b for s, b in blobs if s == 256][0]
    with open(os.path.join(OUT_DIR, "icon-256.png"), "wb") as f:
        f.write(big)
    # 16px 放大 8 倍（最近邻），方便肉眼/视觉模型检查最小尺寸是否还认得出
    z = 8
    src = render(16)
    zoom = bytearray(16 * z * 16 * z * 3)
    for y in range(16 * z):
        for x in range(16 * z):
            i = ((y // z) * 16 + (x // z)) * 3
            j = (y * 16 * z + x) * 3
            zoom[j:j + 3] = src[i:i + 3]
    with open(os.path.join(OUT_DIR, "icon-16-zoom.png"), "wb") as f:
        f.write(png(16 * z, bytes(zoom)))
    print("ok %s (%d bytes, %d 尺寸: %s)" % (ico, os.path.getsize(ico), len(blobs), SIZES))


if __name__ == "__main__":
    main()