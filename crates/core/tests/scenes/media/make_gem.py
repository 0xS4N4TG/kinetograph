#!/usr/bin/env python3
"""Writes gem.glb, the 3D layer's test model: a metallic octahedron and, on a
node above it, a quad textured with an 8x8 checkerboard. Self-made, CC0.

    python3 make_gem.py
"""
import json
import os
import struct
import zlib

# --- the octahedron: 8 faces, flat normals, 24 vertices ----------------------
tips = {"+x": (1, 0, 0), "-x": (-1, 0, 0), "+y": (0, 1.4, 0), "-y": (0, -1.4, 0), "+z": (0, 0, 1), "-z": (0, 0, -1)}
ring = ["+x", "+z", "-x", "-z"]
faces = []
for i in range(4):
    a, b = ring[i], ring[(i + 1) % 4]
    faces.append([tips["+y"], tips[b], tips[a]])
    faces.append([tips["-y"], tips[a], tips[b]])


def normal(tri):
    (ax, ay, az), (bx, by, bz), (cx, cy, cz) = tri
    u, v = (bx - ax, by - ay, bz - az), (cx - ax, cy - ay, cz - az)
    n = (u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0])
    length = sum(c * c for c in n) ** 0.5
    return tuple(c / length for c in n)


gem_pos, gem_nrm = b"", b""
for tri in faces:
    n = normal(tri)
    for p in tri:
        gem_pos += struct.pack("<3f", *p)
        gem_nrm += struct.pack("<3f", *n)

# --- the quad ---------------------------------------------------------------
quad_pos = b"".join(struct.pack("<3f", *p) for p in [(-0.6, 0, 0), (0.6, 0, 0), (0.6, 0.6, 0), (-0.6, 0.6, 0)])
quad_nrm = b"".join(struct.pack("<3f", 0, 0, 1) for _ in range(4))
quad_uv = b"".join(struct.pack("<2f", *p) for p in [(0, 1), (1, 1), (1, 0), (0, 0)])
quad_idx = struct.pack("<6H", 0, 1, 2, 0, 2, 3)


def png(width, height, rgb):
    def chunk(kind, data):
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    rows = b"".join(b"\x00" + b"".join(bytes(rgb(x, y)) for x in range(width)) for y in range(height))
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(rows, 9))
        + chunk(b"IEND", b"")
    )


image = png(8, 8, lambda x, y: (240, 90, 60) if (x // 2 + y // 2) % 2 == 0 else (250, 240, 220))

# --- one buffer, a view for each piece ---------------------------------------
blob, views = b"", []


def add(data, target=None):
    global blob
    while len(blob) % 4:
        blob += b"\0"
    view = {"buffer": 0, "byteOffset": len(blob), "byteLength": len(data)}
    if target:
        view["target"] = target
    views.append(view)
    blob += data
    return len(views) - 1


def extent(data):
    values = struct.unpack("<%df" % (len(data) // 4), data)
    pts = [values[i : i + 3] for i in range(0, len(values), 3)]
    return [min(p[k] for p in pts) for k in range(3)], [max(p[k] for p in pts) for k in range(3)]


v_gpos, v_gnrm = add(gem_pos, 34962), add(gem_nrm, 34962)
v_qpos, v_qnrm, v_quv = add(quad_pos, 34962), add(quad_nrm, 34962), add(quad_uv, 34962)
v_qidx, v_img = add(quad_idx, 34963), add(image)
lo, hi = extent(gem_pos)
qlo, qhi = extent(quad_pos)

doc = {
    "asset": {"version": "2.0", "generator": "kinetograph make_gem.py"},
    "scene": 0,
    "scenes": [{"nodes": [0]}],
    "nodes": [
        {"name": "gem", "children": [1, 2]},
        {"name": "octahedron", "mesh": 0},
        {"name": "plate", "mesh": 1, "translation": [0, 1.2, 0]},
    ],
    "meshes": [
        {"name": "octahedron", "primitives": [{"attributes": {"POSITION": 0, "NORMAL": 1}, "material": 0}]},
        {"name": "plate", "primitives": [{"attributes": {"POSITION": 2, "NORMAL": 3, "TEXCOORD_0": 4}, "indices": 5, "material": 1}]},
    ],
    "materials": [
        {"name": "steel", "pbrMetallicRoughness": {"baseColorFactor": [0.30, 0.79, 0.94, 1], "metallicFactor": 0.6, "roughnessFactor": 0.3}},
        {"name": "checker", "pbrMetallicRoughness": {"baseColorTexture": {"index": 0}, "metallicFactor": 0, "roughnessFactor": 0.6}, "doubleSided": True},
    ],
    "textures": [{"source": 0, "sampler": 0}],
    "samplers": [{"magFilter": 9728, "minFilter": 9728, "wrapS": 33071, "wrapT": 33071}],
    "images": [{"bufferView": v_img, "mimeType": "image/png"}],
    "accessors": [
        {"bufferView": v_gpos, "componentType": 5126, "count": 24, "type": "VEC3", "min": lo, "max": hi},
        {"bufferView": v_gnrm, "componentType": 5126, "count": 24, "type": "VEC3"},
        {"bufferView": v_qpos, "componentType": 5126, "count": 4, "type": "VEC3", "min": qlo, "max": qhi},
        {"bufferView": v_qnrm, "componentType": 5126, "count": 4, "type": "VEC3"},
        {"bufferView": v_quv, "componentType": 5126, "count": 4, "type": "VEC2"},
        {"bufferView": v_qidx, "componentType": 5123, "count": 6, "type": "SCALAR"},
    ],
    "bufferViews": views,
    "buffers": [{"byteLength": len(blob)}],
}

text = json.dumps(doc, separators=(",", ":")).encode()
while len(text) % 4:
    text += b" "
while len(blob) % 4:
    blob += b"\0"
total = 12 + 8 + len(text) + 8 + len(blob)
glb = struct.pack("<4sII", b"glTF", 2, total)
glb += struct.pack("<I4s", len(text), b"JSON") + text
glb += struct.pack("<I4s", len(blob), b"BIN\0") + blob
out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "gem.glb")
open(out, "wb").write(glb)
print(out, len(glb), "bytes")

# checker.png: the texture of scene3d-materials-kinds.json, 64x64 with a
# translucent bottom half to show that textures' alpha is blended.
def checker(x, y):
    on = (x // 8 + y // 8) % 2 == 0
    return (42, 157, 143) if on else (244, 241, 222)


rows = b"".join(
    b"\x00" + b"".join(bytes(checker(x, y)) + bytes([255 if y < 32 else 140]) for x in range(64)) for y in range(64)
)


def chunk(kind, data):
    body = kind + data
    return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))


checker_png = (
    b"\x89PNG\r\n\x1a\n"
    + chunk(b"IHDR", struct.pack(">IIBBBBB", 64, 64, 8, 6, 0, 0, 0))
    + chunk(b"IDAT", zlib.compress(rows, 9))
    + chunk(b"IEND", b"")
)
open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "checker.png"), "wb").write(checker_png)
