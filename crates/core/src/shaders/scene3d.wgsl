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
// is made by `scene3d_shadow.wgsl`. An environment map adds image-based
// light: the diffuse map for the diffuse term, the specular map (read at the
// level of the roughness) for the specular one, weighted by an analytic fit
// of the split-sum table; both are made by `environment.wgsl`. It can also be
// drawn as the background, before the meshes.

struct Light {
    // xyz: the direction toward a directional light, or a point/spot light's
    // position. w: 0 for directional, 1 for point, 2 for spot.
    vector: vec4<f32>,
    // rgb: colour times intensity. a: a point/spot light's range, 0 for none.
    color: vec4<f32>,
    // x: the light's shadow map, 0 to 3, or -1 for none.
    // y: cos_outer (spot). z: cos_inner (spot).
    shadow: vec4<f32>,
    // xyz: a spot light's direction.
    spot: vec4<f32>,
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
    // Clip space to world space, for the background's view rays.
    inverse_view_proj: mat4x4<f32>,
    // World directions to the environment's: the turn of the picture, undone.
    env_rotation: mat3x3<f32>,
    // x: the intensity of the lighting from the environment, 0 for none.
    // y: the last level of the specular map. z: the intensity of the
    // background. w: the level of the specular map the background reads.
    env: vec4<f32>,
    // rgb: fog colour in linear light. a: 0 for none, 1 for linear, 2 for exp2.
    fog_color: vec4<f32>,
    // x: near (or density for exp2). y: far.
    fog_params: vec4<f32>,
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
    // bit 2 mirrored by the model matrix, bit 3 receives shadows, bit 4 has a
    // normal map). w: the normal map's scale.
    params: vec4<f32>,
}

@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var shadow_map_0: texture_depth_2d;
@group(0) @binding(2) var shadow_map_1: texture_depth_2d;
@group(0) @binding(3) var shadow_map_2: texture_depth_2d;
@group(0) @binding(4) var shadow_map_3: texture_depth_2d;
@group(0) @binding(5) var shadow_sampler: sampler_comparison;
@group(0) @binding(6) var env_specular: texture_cube<f32>;
@group(0) @binding(7) var env_diffuse: texture_cube<f32>;
@group(0) @binding(8) var env_sampler: sampler;
@group(1) @binding(0) var<uniform> draw: Draw;
@group(2) @binding(0) var base_texture: texture_2d<f32>;
@group(2) @binding(1) var base_sampler: sampler;
@group(2) @binding(2) var normal_texture: texture_2d<f32>;
@group(2) @binding(3) var metal_rough_texture: texture_2d<f32>;

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

// Schlick's Fresnel for light from the environment, with the grazing
// reflectance lowered by the roughness (Lagarde).
fn fresnel_roughness(f0: vec3<f32>, n_dot_v: f32, roughness: f32) -> vec3<f32> {
    let grazing = max(vec3<f32>(1.0 - roughness), f0);
    return f0 + (grazing - f0) * pow(1.0 - n_dot_v, 5.0);
}

// The scale and the bias of the specular reflectance, the integral of the
// BRDF over the environment that the split-sum approximation tabulates, as
// the analytic fit of Karis, "Physically Based Shading on Mobile".
fn env_brdf(n_dot_v: f32, roughness: f32) -> vec2<f32> {
    let c0 = vec4<f32>(-1.0, -0.0275, -0.572, 0.022);
    let c1 = vec4<f32>(1.0, 0.0425, 1.04, -0.04);
    let r = roughness * c0 + c1;
    let a004 = min(r.x * r.x, exp2(-9.28 * n_dot_v)) * r.x + r.y;
    return vec2<f32>(-1.04, 1.04) * a004 + r.zw;
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
    let c = s.view_proj * vec4<f32>(world + n * (s.params.y * sin_theta), 1.0);
    if c.w <= 0.0 {
        return 1.0;
    }
    let ndc = c.xyz / c.w;
    let uv = vec2<f32>(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
    // A point beyond the map's far plane (the casters end there, the ground
    // may not) is compared at depth 1, where an empty texel also is: lit,
    // unless something nearer is in the way.
    let depth = min(ndc.z - s.params.x, 1.0);
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

// `n` turned by the tangent-space normal `tn` of a normal map (green up, the
// texture's v running down). The tangent frame comes from the derivatives of
// the position and the uv, so the mesh needs no tangents; they are passed in
// because they can only be taken in uniform control flow.
fn perturb_normal(
    n: vec3<f32>,
    dp1: vec3<f32>,
    dp2: vec3<f32>,
    duv1: vec2<f32>,
    duv2: vec2<f32>,
    tn: vec3<f32>,
) -> vec3<f32> {
    let dp2perp = cross(dp2, n);
    let dp1perp = cross(n, dp1);
    // The screen's y runs down here, where the formula's runs up: both flip.
    let t = -(dp2perp * duv1.x + dp1perp * duv2.x);
    // v runs down the image, and green is up: flipped again.
    let b = dp2perp * duv1.y + dp1perp * duv2.y;
    let scale = inverseSqrt(max(max(dot(t, t), dot(b, b)), 1e-20));
    return normalize(t * scale * tn.x + b * scale * tn.y + n * tn.z);
}

@fragment
fn fs_main(
    in: Varying,
    @builtin(front_facing) front_facing: bool,
) -> @location(0) vec4<f32> {
    // Sampled before anything can discard, so the derivatives are uniform.
    let texel = textureSample(base_texture, base_sampler, in.uv);
    let normal_texel = textureSample(normal_texture, base_sampler, in.uv).rgb;
    let metal_rough = textureSample(metal_rough_texture, base_sampler, in.uv);
    // The normal map's normal, in world space for the front of the face:
    // made here because it needs derivatives. The back's is its opposite.
    let has_normal_map = (u32(draw.params.z) & 16u) != 0u;
    var mapped = normalize(in.normal);
    if has_normal_map {
        let tangent_normal = vec3<f32>(
            (normal_texel.xy * 2.0 - vec2<f32>(1.0)) * draw.params.w,
            normal_texel.z * 2.0 - 1.0,
        );
        mapped = perturb_normal(
            mapped, dpdx(in.world), dpdy(in.world), dpdx(in.uv), dpdy(in.uv), tangent_normal,
        );
    }
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
        var n = mapped;
        if !front {
            n = -n;
        }
        let v = normalize(frame.eye.xyz - in.world);
        let n_dot_v = max(dot(n, v), 1e-4);
        let metallic = clamp(draw.params.x * metal_rough.b, 0.0, 1.0);
        let roughness = clamp(draw.params.y * metal_rough.g, 0.045, 1.0);
        let alpha = roughness * roughness;
        let albedo = base.rgb;
        let diffuse_colour = albedo * (1.0 - metallic);
        let f0 = mix(vec3<f32>(0.04), albedo, metallic);

        // Ambient light has no direction: all diffuse, and a little
        // specular so that a metal is not black in it.
        rgb += frame.ambient.rgb * (diffuse_colour + f0 * (1.0 - roughness) * 0.5);

        if frame.env.x > 0.0 {
            let reflected = frame.env_rotation * reflect(-v, n);
            let irradiance = textureSampleLevel(
                env_diffuse, env_sampler, frame.env_rotation * n, 0.0,
            ).rgb;
            let prefiltered = textureSampleLevel(
                env_specular, env_sampler, reflected, roughness * frame.env.y,
            ).rgb;
            let f = fresnel_roughness(f0, n_dot_v, roughness);
            let ab = env_brdf(n_dot_v, roughness);
            rgb += frame.env.x * ((vec3<f32>(1.0) - f) * diffuse_colour * irradiance
                + prefiltered * (f0 * ab.x + ab.y));
        }

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
                if light.vector.w > 1.5 {
                    let cos_angle = dot(-l, light.spot.xyz);
                    let cos_outer = light.shadow.y;
                    let cos_inner = max(light.shadow.z, cos_outer + 1e-5);
                    radiance *= smoothstep(cos_outer, cos_inner, cos_angle);
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
    if frame.fog_color.w > 0.5 {
        let dist = length(in.world - frame.eye.xyz);
        var factor = 0.0;
        if frame.fog_color.w < 1.5 {
            factor = clamp(
                (dist - frame.fog_params.x) / (frame.fog_params.y - frame.fog_params.x),
                0.0,
                1.0,
            );
        } else {
            let d = frame.fog_params.x * dist;
            factor = 1.0 - exp(-(d * d));
        }
        rgb = mix(rgb, frame.fog_color.rgb, factor);
    }
    let a = base.a;
    return vec4<f32>(rgb * a, a);
}

struct BackgroundVarying {
    @builtin(position) position: vec4<f32>,
    // Where the pixel is in the layer's box: -1 to 1 on each side.
    @location(0) box_clip: vec2<f32>,
}

// One triangle that covers the layer's box, at depth 0 (it is drawn first,
// and writes no depth).
@vertex
fn vs_background(@builtin(vertex_index) i: u32) -> BackgroundVarying {
    let x = f32((i << 1u) & 2u) * 2.0 - 1.0;
    let y = f32(i & 2u) * 2.0 - 1.0;
    var out: BackgroundVarying;
    out.position = frame.place * vec4<f32>(x, y, 0.0, 1.0);
    out.box_clip = vec2<f32>(x, y);
    return out;
}

// The environment in the direction the camera sees through the pixel: the
// line through the same point of the near and the far plane, which is also
// right for an orthographic camera.
@fragment
fn fs_background(in: BackgroundVarying) -> @location(0) vec4<f32> {
    if abs(in.box_clip.x) > 1.0 || abs(in.box_clip.y) > 1.0 {
        discard;
    }
    let near = frame.inverse_view_proj * vec4<f32>(in.box_clip, 0.0, 1.0);
    let far = frame.inverse_view_proj * vec4<f32>(in.box_clip, 1.0, 1.0);
    let direction = normalize(far.xyz / far.w - near.xyz / near.w);
    let rgb = textureSampleLevel(
        env_specular, env_sampler, frame.env_rotation * direction, frame.env.w,
    ).rgb;
    return vec4<f32>(rgb * frame.env.z, 1.0);
}
