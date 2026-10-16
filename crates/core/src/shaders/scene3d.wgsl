// The 3D layer (`scene3d.rs`, `compositor/scene3d.rs`). Meshes are drawn with
// a depth buffer into a multisampled Rgba16Float target, which resolves into
// a plain layer texture: linear light, premultiplied.
//
// The vertex stage runs the camera (`view_proj`), then `place`: the layer's
// 2D matrix, from the layer box to the texels of the padded canvas, written
// as a clip-space matrix that leaves z and w alone. The part of the scene
// outside the box is cut off in the fragment stage, from the clip position
// before `place`, so a rotated or scaled layer is cut along its own edges.
//
// Shading is metallic-roughness, lean: Lambert diffuse plus GGX specular for
// each directional and point light, a flat ambient term, and emission. A
// light's colour is already times its intensity; a point light's falls off as
// 1 / d^2 and, with a range, fades to nothing at it. A directional light with
// a shadow map is dimmed where the map says something is in the way; the map
// is made by `scene3d_shadow.wgsl`.

struct Light {
    // xyz: the direction toward a directional light, or a point light's
    // position. w: 0 for directional, 1 for point.
    vector: vec4<f32>,
    // rgb: colour times intensity. a: a point light's range, 0 for none.
    color: vec4<f32>,
    // x: the light's shadow map, 0 to 3, or -1 for none.
    shadow: vec4<f32>,
}

struct Shadow {
    // World space to the map's clip space.
    view_proj: mat4x4<f32>,
    // x: depth bias. y: normal bias in world units. z: filter radius in
    // texels. w: the size of a texel, in uv.
    params: vec4<f32>,
}

struct Frame {
    view_proj: mat4x4<f32>,
    place: mat4x4<f32>,
    // xyz: the eye. w: 1 when `place` mirrors the picture.
    eye: vec4<f32>,
    // rgb: ambient light. a: how many of `lights` are lit.
    ambient: vec4<f32>,
    lights: array<Light, 8>,
    shadows: array<Shadow, 4>,
}

struct Draw {
    model: mat4x4<f32>,
    // The inverse transpose of the model matrix's upper 3x3, as columns of
    // a mat4.
    normal: mat4x4<f32>,
    // Linear, straight alpha; multiplied by the texture.
    color: vec4<f32>,
    emissive: vec4<f32>,
    // x: metallic. y: roughness. z: flags (bit 0 unlit, bit 1 double sided,
    // bit 2 mirrored by the model matrix, bit 3 receives shadows).
    params: vec4<f32>,
}

@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var shadow_map_0: texture_depth_2d;
@group(0) @binding(2) var shadow_map_1: texture_depth_2d;
@group(0) @binding(3) var shadow_map_2: texture_depth_2d;
@group(0) @binding(4) var shadow_map_3: texture_depth_2d;
@group(0) @binding(5) var shadow_sampler: sampler_comparison;
@group(1) @binding(0) var<uniform> draw: Draw;
@group(2) @binding(0) var base_texture: texture_2d<f32>;
@group(2) @binding(1) var base_sampler: sampler;

struct Vertex {
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) uv: vec2<f32>,
}

struct Varying {
    @builtin(position) position: vec4<f32>,
    @location(0) world: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) uv: vec2<f32>,
    // The clip position before `place`: inside the layer's box while
    // |x| <= w and |y| <= w.
    @location(3) box_clip: vec4<f32>,
}

@vertex
fn vs_main(v: Vertex) -> Varying {
    let world = draw.model * vec4<f32>(v.position, 1.0);
    let clip = frame.view_proj * world;
    var out: Varying;
    out.position = frame.place * clip;
    out.world = world.xyz;
    out.normal = (draw.normal * vec4<f32>(v.normal, 0.0)).xyz;
    out.uv = v.uv;
    out.box_clip = clip;
    return out;
}

const PI: f32 = 3.14159265358979;

fn distribution_ggx(n_dot_h: f32, alpha: f32) -> f32 {
    let a2 = alpha * alpha;
    let d = n_dot_h * n_dot_h * (a2 - 1.0) + 1.0;
    return a2 / (PI * d * d);
}

// Smith's visibility term with Schlick-GGX, divided by 4 n.l n.v.
fn visibility(n_dot_l: f32, n_dot_v: f32, alpha: f32) -> f32 {
    let k = alpha / 2.0;
    let gl = n_dot_l * (1.0 - k) + k;
    let gv = n_dot_v * (1.0 - k) + k;
    return 0.25 / (gl * gv);
}

fn fresnel(f0: vec3<f32>, v_dot_h: f32) -> vec3<f32> {
    return f0 + (vec3<f32>(1.0) - f0) * pow(1.0 - v_dot_h, 5.0);
}

// How much of a light reaches a point: the mean of 3 x 3 compares of the
// point's depth with the map's, each a bilinear one, spread `radius` texels
// apart. The level-0 kind of compare may run in any control flow.
fn filter_shadow(
    map: texture_depth_2d,
    uv: vec2<f32>,
    depth: f32,
    texel: f32,
    radius: f32,
) -> f32 {
    var sum = 0.0;
    for (var y = -1; y <= 1; y++) {
        for (var x = -1; x <= 1; x++) {
            let at = uv + vec2<f32>(f32(x), f32(y)) * radius * texel;
            sum += textureSampleCompareLevel(map, shadow_sampler, at, depth);
        }
    }
    return sum / 9.0;
}

// The share of the light that reaches `world`, in 0..1. The point is moved
// along its normal first, by more the more the surface leans away from the
// light, and its depth is lowered by the bias. Outside the map's sides nothing
// casts onto it: lit.
fn shadow_visibility(slot: i32, world: vec3<f32>, n: vec3<f32>, n_dot_l: f32) -> f32 {
    let s = frame.shadows[slot];
    let sin_theta = sqrt(max(1.0 - n_dot_l * n_dot_l, 0.0));
    let clip = s.view_proj * vec4<f32>(world + n * (s.params.y * sin_theta), 1.0);
    let uv = vec2<f32>(clip.x * 0.5 + 0.5, 0.5 - clip.y * 0.5);
    // A point beyond the map's far plane (the casters end there, the ground
    // may not) is compared at depth 1, where an empty texel also is: lit,
    // unless something nearer is in the way.
    let depth = min(clip.z - s.params.x, 1.0);
    if any(uv < vec2<f32>(0.0)) || any(uv > vec2<f32>(1.0)) {
        return 1.0;
    }
    switch slot {
        case 0: {
            return filter_shadow(shadow_map_0, uv, depth, s.params.w, s.params.z);
        }
        case 1: {
            return filter_shadow(shadow_map_1, uv, depth, s.params.w, s.params.z);
        }
        case 2: {
            return filter_shadow(shadow_map_2, uv, depth, s.params.w, s.params.z);
        }
        default: {
            return filter_shadow(shadow_map_3, uv, depth, s.params.w, s.params.z);
        }
    }
}

@fragment
fn fs_main(
    in: Varying,
    @builtin(front_facing) front_facing: bool,
) -> @location(0) vec4<f32> {
    // Sampled before anything can discard, so the derivatives are uniform.
    let texel = textureSample(base_texture, base_sampler, in.uv);
    let flags = u32(draw.params.z);
    let unlit = (flags & 1u) != 0u;
    let double_sided = (flags & 2u) != 0u;
    let receives_shadow = (flags & 8u) != 0u;

    // Cut to the layer's box.
    if abs(in.box_clip.x) > in.box_clip.w || abs(in.box_clip.y) > in.box_clip.w {
        discard;
    }
    // A mirrored matrix (the model's, or the layer's) turns faces inside out
    // on screen; undo it to tell the front from the back.
    let mirrored = (frame.eye.w > 0.5) != ((flags & 4u) != 0u);
    let front = front_facing != mirrored;
    if !front && !double_sided {
        discard;
    }

    let base = draw.color * texel;
    var rgb = draw.emissive.rgb;
    if !unlit {
        var n = normalize(in.normal);
        if !front {
            n = -n;
        }
        let v = normalize(frame.eye.xyz - in.world);
        let n_dot_v = max(dot(n, v), 1e-4);
        let metallic = draw.params.x;
        let roughness = clamp(draw.params.y, 0.045, 1.0);
        let alpha = roughness * roughness;
        let albedo = base.rgb;
        let diffuse_colour = albedo * (1.0 - metallic);
        let f0 = mix(vec3<f32>(0.04), albedo, metallic);

        // Ambient light has no direction: all diffuse, and a little
        // specular so that a metal is not black in it.
        rgb += frame.ambient.rgb * (diffuse_colour + f0 * (1.0 - roughness) * 0.5);

        let count = u32(frame.ambient.a);
        for (var i = 0u; i < count; i++) {
            let light = frame.lights[i];
            var l: vec3<f32>;
            var radiance = light.color.rgb;
            if light.vector.w < 0.5 {
                l = normalize(light.vector.xyz);
            } else {
                let to_light = light.vector.xyz - in.world;
                let d2 = max(dot(to_light, to_light), 1e-4);
                l = to_light * inverseSqrt(d2);
                radiance *= 1.0 / d2;
                if light.color.a > 0.0 {
                    let ratio = sqrt(d2) / light.color.a;
                    let fade = clamp(1.0 - ratio * ratio * ratio * ratio, 0.0, 1.0);
                    radiance *= fade * fade;
                }
            }
            let n_dot_l = dot(n, l);
            if n_dot_l <= 0.0 {
                continue;
            }
            let h = normalize(l + v);
            let n_dot_h = max(dot(n, h), 0.0);
            let v_dot_h = max(dot(v, h), 0.0);
            let spec = distribution_ggx(n_dot_h, alpha) * visibility(n_dot_l, n_dot_v, alpha)
                * fresnel(f0, v_dot_h);
            // The diffuse term loses what the specular reflects.
            let kd = (vec3<f32>(1.0) - fresnel(f0, v_dot_h));
            let slot = i32(light.shadow.x);
            if receives_shadow && slot >= 0 {
                radiance *= shadow_visibility(slot, in.world, n, n_dot_l);
            }
            rgb += (kd * diffuse_colour + spec * PI) * radiance * n_dot_l;
        }
    } else {
        rgb += base.rgb;
    }
    let a = base.a;
    return vec4<f32>(rgb * a, a);
}
