// A model part's mesh in one pose (`scene3d/model.rs`, `DeformData` and
// `PoseDeform`): each vertex moved by the morph targets at their weights,
// then by the blend of its skin's four joints, as glTF says. The result is a
// vertex buffer of the layout `scene3d.wgsl` reads (position, normal, uv: 8
// floats a vertex), drawn in place of the rest mesh.
//
// A mesh the file gave no normals has flat ones, each triangle with three
// vertices of its own: one invocation a triangle makes its three and gives
// them the deformed triangle's normal. Otherwise one invocation a vertex.

struct Params {
    vertex_count: u32,
    target_count: u32,
    // Bit 0: skinned. Bit 1: flat normals.
    flags: u32,
    // Invocations a row of workgroups: a big mesh is dispatched in rows.
    row: u32,
}

@group(0) @binding(0) var<uniform> params: Params;
// 8 floats a vertex: position, normal, uv.
@group(0) @binding(1) var<storage, read> rest: array<f32>;
// For each target, then each vertex: the position's displacement, then the normal's.
@group(0) @binding(2) var<storage, read> targets: array<f32>;
// 8 words a vertex: four joints, then the bits of their four weights.
@group(0) @binding(3) var<storage, read> influences: array<u32>;
// One a target.
@group(0) @binding(4) var<storage, read> weights: array<f32>;
// Each joint in the model's space times its inverse bind matrix.
@group(0) @binding(5) var<storage, read> joints: array<mat4x4<f32>>;
@group(0) @binding(6) var<storage, read_write> out: array<f32>;

struct Moved {
    position: vec3<f32>,
    normal: vec3<f32>,
}

fn unit_or_zero(v: vec3<f32>) -> vec3<f32> {
    let len2 = dot(v, v);
    if len2 > 0.0 && len2 < 3.0e38 {
        return v * inverseSqrt(len2);
    }
    return vec3<f32>(0.0);
}

fn moved(i: u32) -> Moved {
    let r = i * 8u;
    var p = vec3<f32>(rest[r], rest[r + 1u], rest[r + 2u]);
    var n = vec3<f32>(rest[r + 3u], rest[r + 4u], rest[r + 5u]);
    for (var t = 0u; t < params.target_count; t++) {
        let w = weights[t];
        if w != 0.0 {
            let d = (t * params.vertex_count + i) * 6u;
            p += vec3<f32>(targets[d], targets[d + 1u], targets[d + 2u]) * w;
            n += vec3<f32>(targets[d + 3u], targets[d + 4u], targets[d + 5u]) * w;
        }
    }
    if (params.flags & 1u) != 0u {
        let k = i * 8u;
        var m = mat4x4<f32>(vec4<f32>(0.0), vec4<f32>(0.0), vec4<f32>(0.0), vec4<f32>(0.0));
        for (var j = 0u; j < 4u; j++) {
            let w = bitcast<f32>(influences[k + 4u + j]);
            if w > 0.0 {
                m += joints[influences[k + j]] * w;
            }
        }
        p = (m * vec4<f32>(p, 1.0)).xyz;
        n = mat3x3<f32>(m[0].xyz, m[1].xyz, m[2].xyz) * n;
    }
    return Moved(p, unit_or_zero(n));
}

fn write(i: u32, position: vec3<f32>, normal: vec3<f32>) {
    let o = i * 8u;
    out[o] = position.x;
    out[o + 1u] = position.y;
    out[o + 2u] = position.z;
    out[o + 3u] = normal.x;
    out[o + 4u] = normal.y;
    out[o + 5u] = normal.z;
    out[o + 6u] = rest[o + 6u];
    out[o + 7u] = rest[o + 7u];
}

@compute @workgroup_size(64)
fn deform(@builtin(global_invocation_id) id: vec3<u32>) {
    let at = id.y * params.row + id.x;
    if (params.flags & 2u) == 0u {
        if at >= params.vertex_count {
            return;
        }
        let v = moved(at);
        write(at, v.position, v.normal);
        return;
    }
    let first = at * 3u;
    if first + 2u >= params.vertex_count {
        return;
    }
    let a = moved(first);
    let b = moved(first + 1u);
    let c = moved(first + 2u);
    let normal = unit_or_zero(cross(b.position - a.position, c.position - a.position));
    write(first, a.position, normal);
    write(first + 1u, b.position, normal);
    write(first + 2u, c.position, normal);
}
