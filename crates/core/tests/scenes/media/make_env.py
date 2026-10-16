#!/usr/bin/env python3
"""Writes the 3D layer's test environment maps. Self-made, CC0.

    studio.hdr  128x64 equirectangular Radiance picture, linear light: a dim
                blue sky over a warm dark floor, a bright key softbox above and
                toward +x, a blue fill toward -x and a thin rim light behind.
    flat.png    16x8 equirectangular sRGB picture of plain white: a white
                furnace, which lights a white surface to its own colour.
    bands.png   64x32 equirectangular sRGB picture of four vertical bands, one
                centred on each horizontal direction: red toward -x, green
                toward -z, blue toward +x, yellow toward +z.

    python3 make_env.py

The layout is the one `scene3d::environment` documents: the centre of the
picture is toward +x, the top is +y, and the picture runs counter-clockwise
seen from above.
"""
import math
import struct
import zlib


def direction(x, y, w, h):
    """The world direction the texel (x, y) of a w x h picture looks at."""
    u, v = (x + 0.5) / w, (y + 0.5) / h
    azimuth = (u - 0.5) * 2 * math.pi
    elevation = (0.5 - v) * math.pi
    return (
        math.cos(elevation) * math.cos(azimuth),
        math.sin(elevation),
        math.cos(elevation) * math.sin(azimuth),
    )


def rgbe(r, g, b):
    m = max(r, g, b)
    if m < 1e-32:
        return (0, 0, 0, 0)
    mantissa, exponent = math.frexp(m)
    scale = mantissa * 256.0 / m
    return (int(r * scale), int(g * scale), int(b * scale), exponent + 128)


def softbox(d, centre, size, power):
    """1 inside a soft round light toward `centre` of angular radius `size`."""
    dot = sum(a * b for a, b in zip(d, centre))
    angle = math.acos(max(-1.0, min(1.0, dot)))
    return power * max(0.0, 1.0 - angle / size) ** 0.5 if angle < size else 0.0


def normalised(v):
    n = math.sqrt(sum(c * c for c in v))
    return tuple(c / n for c in v)


def studio(w=128, h=64):
    key = normalised((1.0, 0.9, 0.4))
    fill = normalised((-1.0, 0.2, -0.3))
    rim = normalised((-0.2, 0.4, 1.0))
    rows = []
    for y in range(h):
        row = b""
        for x in range(w):
            d = direction(x, y, w, h)
            up = d[1]
            if up >= 0:
                t = up ** 0.6
                r, g, b = 0.55 * (1 - t) + 0.12 * t, 0.62 * (1 - t) + 0.2 * t, 0.75 * (1 - t) + 0.45 * t
            else:
                t = (-up) ** 0.5
                r, g, b = 0.35 * (1 - t) + 0.05 * t, 0.3 * (1 - t) + 0.04 * t, 0.26 * (1 - t) + 0.035 * t
            k = softbox(d, key, 0.5, 14.0)
            f = softbox(d, fill, 0.6, 2.5)
            m = softbox(d, rim, 0.25, 6.0)
            r, g, b = r + k + 0.35 * f + m, g + 0.95 * k + 0.55 * f + m, b + 0.8 * k + f + m
            px = rgbe(r, g, b)
            # A flat scanline must not start like a run-length encoded one.
            if x == 0 and px[0] == 2 and px[1] == 2 and px[2] < 128:
                px = (px[0], px[1] + 1, px[2], px[3])
            row += bytes(px)
        rows.append(row)
    header = b"#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n" + f"-Y {h} +X {w}\n".encode()
    return header + b"".join(rows)


def png(w, h, rgb_rows):
    def chunk(kind, data):
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    raw = b"".join(b"\x00" + row for row in rgb_rows)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def bands(w=64, h=32):
    colours = [(230, 40, 40), (40, 200, 60), (50, 80, 235), (240, 220, 50)]
    row = b""
    for x in range(w):
        u = (x + 0.5) / w
        # Band k is centred on u = k / 4: -x (0), -z (0.25), +x (0.5), +z (0.75).
        row += bytes(colours[int((u + 0.125) * 4) % 4])
    return png(w, h, [row] * h)


def flat(w=16, h=8):
    return png(w, h, [b"\xff" * 3 * w] * h)


if __name__ == "__main__":
    open("studio.hdr", "wb").write(studio())
    open("flat.png", "wb").write(flat())
    open("bands.png", "wb").write(bands())
