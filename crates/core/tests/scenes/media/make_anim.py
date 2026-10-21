#!/usr/bin/env python3
"""Writes the 3D layer's animation test models. Self-made, CC0.

    animated.glb     two cubes. "mover" has the clip "move" (translation and
                     rotation LINEAR, scale STEP) and the clip "spin" (2 s). "cubic" has
                     a CUBICSPLINE translation in "move".
    morph.glb        a quad with one morph target (the top corners move +x), a
                     default weight of 0.5 and the clip "grow" (weight 0 to 1 in 1 s);
                     and, below it, a triangle with no normals whose morph target lifts
                     one corner (the flat normals follow).
    skin.glb         a bar of two segments skinned to two joints, and the clip
                     "bend" (the upper joint turns 90 degrees about z in 1 s).
    unsupported.glb  what the loader reports and does not read: a points
                     primitive, an occlusion texture, alphaMode MASK and the
                     extension KHR_materials_clearcoat.

    maps.glb         four 4 x 4 quads in a 2 x 2 grid, for the normal and metallic-roughness
                     textures: top left has a normal map (1x1, tilted toward +x and +y) and
                     top right has none; bottom left is metallic 1 with a texture whose blue
                     (metallic) is 0, bottom right is metallic 1 with no texture.

    python3 make_anim.py
"""
import json
import math
import os
import struct
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
FLOAT, USHORT, UBYTE = 5126, 5123, 5121


class Glb:
    """One buffer with a view and an accessor for each thing put in it."""

    def __init__(self):
        self.blob = b""
        self.views = []
        self.accessors = []

    def view(self, data, target=None):
        while len(self.blob) % 4:
            self.blob += b"\0"
        view = {"buffer": 0, "byteOffset": len(self.blob), "byteLength": len(data)}
        if target:
            view["target"] = target
        self.views.append(view)
        self.blob += data
        return len(self.views) - 1

    def accessor(self, values, kind, component=FLOAT, target=None, bounds=False):
        """`values` is a list of tuples (or numbers for SCALAR)."""
        width = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}[kind]
        flat = [v for item in values for v in (item if isinstance(item, tuple) else (item,))]
        code = {FLOAT: "f", USHORT: "H", UBYTE: "B"}[component]
        data = struct.pack("<%d%s" % (len(flat), code), *flat)
        accessor = {
            "bufferView": self.view(data, target),
            "componentType": component,
            "count": len(values),
            "type": kind,
        }
        if bounds:
            rows = [flat[i : i + width] for i in range(0, len(flat), width)]
            accessor["min"] = [min(r[k] for r in rows) for k in range(width)]
            accessor["max"] = [max(r[k] for r in rows) for k in range(width)]
        self.accessors.append(accessor)
        return len(self.accessors) - 1

    def write(self, name, **document):
        document.update(
            asset={"version": "2.0", "generator": "kinetograph make_anim.py"},
            accessors=self.accessors,
            bufferViews=self.views,
            buffers=[{"byteLength": len(self.blob)}],
        )
        text = json.dumps(document, separators=(",", ":")).encode()
        while len(text) % 4:
            text += b" "
        blob = self.blob + b"\0" * (-len(self.blob) % 4)
        total = 12 + 8 + len(text) + 8 + len(blob)
        glb = struct.pack("<4sII", b"glTF", 2, total)
        glb += struct.pack("<I4s", len(text), b"JSON") + text
        glb += struct.pack("<I4s", len(blob), b"BIN\0") + blob
        path = os.path.join(HERE, name)
        open(path, "wb").write(glb)
        print(path, len(glb), "bytes")


def sampler(g, times, values, kind, interpolation="LINEAR"):
    return {
        "input": g.accessor(times, "SCALAR", bounds=True),
        "output": g.accessor(values, kind),
        "interpolation": interpolation,
    }


def cube():
    """Positions, normals and indices of a unit cube with flat faces."""
    faces = [
        ((0, 0, 1), [(-1, -1, 1), (1, -1, 1), (1, 1, 1), (-1, 1, 1)]),
        ((0, 0, -1), [(1, -1, -1), (-1, -1, -1), (-1, 1, -1), (1, 1, -1)]),
        ((1, 0, 0), [(1, -1, 1), (1, -1, -1), (1, 1, -1), (1, 1, 1)]),
        ((-1, 0, 0), [(-1, -1, -1), (-1, -1, 1), (-1, 1, 1), (-1, 1, -1)]),
        ((0, 1, 0), [(-1, 1, 1), (1, 1, 1), (1, 1, -1), (-1, 1, -1)]),
        ((0, -1, 0), [(-1, -1, -1), (1, -1, -1), (1, -1, 1), (-1, -1, 1)]),
    ]
    positions, normals, indices = [], [], []
    for n, corners in faces:
        base = len(positions)
        positions += [tuple(c / 2 for c in p) for p in corners]
        normals += [n] * 4
        indices += [base, base + 1, base + 2, base, base + 2, base + 3]
    return positions, normals, indices


def quat_y(degrees):
    h = math.radians(degrees) / 2
    return (0.0, math.sin(h), 0.0, math.cos(h))


def quat_z(degrees):
    h = math.radians(degrees) / 2
    return (0.0, 0.0, math.sin(h), math.cos(h))


# --- animated.glb --------------------------------------------------------------
g = Glb()
positions, normals, indices = cube()
pos = g.accessor(positions, "VEC3", target=34962, bounds=True)
nrm = g.accessor(normals, "VEC3", target=34962)
idx = g.accessor(indices, "SCALAR", USHORT, target=34963)
move = {
    "name": "move",
    "samplers": [
        sampler(g, [0.0, 1.0], [(0.0, 0.0, 0.0), (2.0, 0.0, 0.0)], "VEC3"),
        sampler(g, [0.0, 1.0], [quat_y(0), quat_y(90)], "VEC4"),
        sampler(g, [0.0, 0.5, 1.0], [(1.0, 1.0, 1.0), (2.0, 2.0, 2.0), (1.0, 1.0, 1.0)], "VEC3", "STEP"),
        # Per keyframe: in-tangent, value, out-tangent.
        sampler(
            g,
            [0.0, 1.0],
            [
                (0.0, 0.0, 0.0), (0.0, 2.0, 0.0), (2.0, 0.0, 0.0),
                (0.0, 0.0, 0.0), (1.0, 2.0, 0.0), (0.0, 0.0, 0.0),
            ],
            "VEC3",
            "CUBICSPLINE",
        ),
    ],
    "channels": [
        {"sampler": 0, "target": {"node": 0, "path": "translation"}},
        {"sampler": 1, "target": {"node": 0, "path": "rotation"}},
        {"sampler": 2, "target": {"node": 0, "path": "scale"}},
        {"sampler": 3, "target": {"node": 1, "path": "translation"}},
    ],
}
spin = {
    "name": "spin",
    "samplers": [sampler(g, [0.0, 2.0], [quat_y(0), quat_y(90)], "VEC4")],
    "channels": [{"sampler": 0, "target": {"node": 0, "path": "rotation"}}],
}
g.write(
    "animated.glb",
    scene=0,
    scenes=[{"nodes": [0, 1]}],
    nodes=[{"name": "mover", "mesh": 0}, {"name": "cubic", "mesh": 0, "translation": [0, 2, 0]}],
    meshes=[{"primitives": [{"attributes": {"POSITION": pos, "NORMAL": nrm}, "indices": idx, "material": 0}]}],
    materials=[{"pbrMetallicRoughness": {"baseColorFactor": [0.9, 0.5, 0.2, 1], "metallicFactor": 0, "roughnessFactor": 0.6}}],
    animations=[move, spin],
)

# --- morph.glb -----------------------------------------------------------------
g = Glb()
quad = [(-0.5, 0.0, 0.0), (0.5, 0.0, 0.0), (0.5, 1.0, 0.0), (-0.5, 1.0, 0.0)]
pos = g.accessor(quad, "VEC3", target=34962, bounds=True)
nrm = g.accessor([(0.0, 0.0, 1.0)] * 4, "VEC3", target=34962)
idx = g.accessor([0, 1, 2, 0, 2, 3], "SCALAR", USHORT, target=34963)
shift = g.accessor([(0.0, 0.0, 0.0), (0.0, 0.0, 0.0), (1.0, 0.0, 0.0), (1.0, 0.0, 0.0)], "VEC3", bounds=True)
tri = [(0.0, 0.0, 0.0), (1.0, 0.0, 0.0), (0.0, 1.0, 0.0)]
tri_pos = g.accessor(tri, "VEC3", target=34962, bounds=True)
lift = g.accessor([(0.0, 0.0, 0.0), (0.0, 0.0, 0.0), (0.0, 0.0, 1.0)], "VEC3", bounds=True)
g.write(
    "morph.glb",
    scene=0,
    scenes=[{"nodes": [0, 1]}],
    nodes=[{"name": "quad", "mesh": 0}, {"name": "flat", "mesh": 1, "translation": [0, -3, 0]}],
    meshes=[
        {
            "weights": [0.5],
            "primitives": [
                {
                    "attributes": {"POSITION": pos, "NORMAL": nrm},
                    "indices": idx,
                    "targets": [{"POSITION": shift}],
                    "material": 0,
                }
            ],
        },
        {
            "weights": [1.0],
            "primitives": [{"attributes": {"POSITION": tri_pos}, "targets": [{"POSITION": lift}], "material": 0}],
        },
    ],
    materials=[{"doubleSided": True}],
    animations=[
        {
            "name": "grow",
            "samplers": [sampler(g, [0.0, 1.0], [0.0, 1.0], "SCALAR")],
            "channels": [{"sampler": 0, "target": {"node": 0, "path": "weights"}}],
        }
    ],
)

# --- skin.glb ------------------------------------------------------------------
g = Glb()
bar = [(x, y, 0.0) for y in (0.0, 1.0, 2.0) for x in (-0.25, 0.25)]
pos = g.accessor(bar, "VEC3", target=34962, bounds=True)
nrm = g.accessor([(0.0, 0.0, 1.0)] * 6, "VEC3", target=34962)
idx = g.accessor([0, 1, 3, 0, 3, 2, 2, 3, 5, 2, 5, 4], "SCALAR", USHORT, target=34963)
joints = g.accessor([(0, 0, 0, 0)] * 2 + [(0, 1, 0, 0)] * 2 + [(1, 0, 0, 0)] * 2, "VEC4", UBYTE, target=34962)
weights = g.accessor(
    [(1.0, 0.0, 0.0, 0.0)] * 2 + [(0.5, 0.5, 0.0, 0.0)] * 2 + [(1.0, 0.0, 0.0, 0.0)] * 2,
    "VEC4",
    target=34962,
)
inverse_bind = g.accessor(
    [
        (1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0),
        (1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, -1.0, 0.0, 1.0),
    ],
    "MAT4",
)
g.write(
    "skin.glb",
    scene=0,
    scenes=[{"nodes": [0, 2]}],
    nodes=[
        {"name": "base", "children": [1]},
        {"name": "tip", "translation": [0, 1, 0]},
        {"name": "bar", "mesh": 0, "skin": 0},
    ],
    meshes=[
        {
            "primitives": [
                {
                    "attributes": {"POSITION": pos, "NORMAL": nrm, "JOINTS_0": joints, "WEIGHTS_0": weights},
                    "indices": idx,
                    "material": 0,
                }
            ]
        }
    ],
    materials=[{"doubleSided": True}],
    skins=[{"joints": [0, 1], "inverseBindMatrices": inverse_bind, "skeleton": 0}],
    animations=[
        {
            "name": "bend",
            "samplers": [sampler(g, [0.0, 1.0], [quat_z(0), quat_z(90)], "VEC4")],
            "channels": [{"sampler": 0, "target": {"node": 1, "path": "rotation"}}],
        }
    ],
)

# --- unsupported.glb -----------------------------------------------------------
g = Glb()


def png():
    def chunk(kind, data):
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    raw = b"\x00" + bytes([128, 128, 255]) * 2
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", 2, 1, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


tri = [(0.0, 0.0, 0.0), (1.0, 0.0, 0.0), (0.0, 1.0, 0.0)]
pos = g.accessor(tri, "VEC3", target=34962, bounds=True)
nrm = g.accessor([(0.0, 0.0, 1.0)] * 3, "VEC3", target=34962)
dots = g.accessor([(0.0, 0.0, 1.0), (1.0, 1.0, 1.0)], "VEC3", target=34962, bounds=True)
image = g.view(png())
g.write(
    "unsupported.glb",
    scene=0,
    scenes=[{"nodes": [0]}],
    nodes=[{"mesh": 0}],
    meshes=[
        {
            "primitives": [
                {"attributes": {"POSITION": pos, "NORMAL": nrm}, "material": 0},
                {"attributes": {"POSITION": dots}, "mode": 0},
            ]
        }
    ],
    materials=[{"alphaMode": "MASK", "alphaCutoff": 0.5, "occlusionTexture": {"index": 0}}],
    textures=[{"source": 0}],
    images=[{"bufferView": image, "mimeType": "image/png"}],
    extensionsUsed=["KHR_materials_clearcoat"],
)

# --- maps.glb ------------------------------------------------------------------
g = Glb()


def png1(rgb):
    """A 1 x 1 PNG."""

    def chunk(kind, data):
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(b"\x00" + bytes(rgb), 9))
        + chunk(b"IEND", b"")
    )


quad_pos = [(-2.0, -2.0, 0.0), (2.0, -2.0, 0.0), (2.0, 2.0, 0.0), (-2.0, 2.0, 0.0)]
quad_uv = [(0.0, 1.0), (1.0, 1.0), (1.0, 0.0), (0.0, 0.0)]
pos = g.accessor(quad_pos, "VEC3", target=34962, bounds=True)
nrm = g.accessor([(0.0, 0.0, 1.0)] * 4, "VEC3", target=34962)
uv = g.accessor(quad_uv, "VEC2", target=34962)
idx = g.accessor([0, 1, 2, 0, 2, 3], "SCALAR", component=USHORT, target=34963)
normal_image = g.view(png1([230, 230, 160]))
rough_image = g.view(png1([0, 255, 0]))
spot = {"POSITION": pos, "NORMAL": nrm, "TEXCOORD_0": uv}
g.write(
    "maps.glb",
    scene=0,
    scenes=[{"nodes": [0, 1, 2, 3]}],
    nodes=[
        {"mesh": 0, "translation": [-3, 3, 0]},
        {"mesh": 1, "translation": [3, 3, 0]},
        {"mesh": 2, "translation": [-3, -3, 0]},
        {"mesh": 3, "translation": [3, -3, 0]},
    ],
    meshes=[
        {"primitives": [{"attributes": spot, "indices": idx, "material": m}]}
        for m in (0, 1, 2, 3)
    ],
    materials=[
        {"pbrMetallicRoughness": {"metallicFactor": 0, "roughnessFactor": 1},
         "normalTexture": {"index": 0}},
        {"pbrMetallicRoughness": {"metallicFactor": 0, "roughnessFactor": 1}},
        {"pbrMetallicRoughness": {"metallicFactor": 1, "roughnessFactor": 1,
                                  "metallicRoughnessTexture": {"index": 1}}},
        {"pbrMetallicRoughness": {"metallicFactor": 1, "roughnessFactor": 1}},
    ],
    textures=[{"source": 0}, {"source": 1}],
    images=[
        {"bufferView": normal_image, "mimeType": "image/png"},
        {"bufferView": rough_image, "mimeType": "image/png"},
    ],
)
