// Image-based lighting, made once per environment map
// (`compositor/environment.rs`). Each entry point draws one face of a cube map
// with a full-screen triangle:
//
//   fs_equirect    the equirectangular picture as a cube face
//   fs_downsample  a mip level of that cube from the level above it
//   fs_irradiance  the diffuse map: the picture's average over the hemisphere
//                  around each direction, weighted by the cosine
//   fs_prefilter   a level of the specular map: the picture blurred by the GGX
//                  lobe of one roughness, by importance sampling
//
// The sampling levels of the last two are picked from the solid angle each
// sample stands for (filtered importance sampling), so a bright spot in the
// picture does not make them noisy. The sampling is a Hammersley sequence:
// the same samples every time.

struct Params {
    // x: the face, 0 to 5 (+x -x +y -y +z -z). y: its size in texels.
    // z: the roughness (fs_prefilter). w: the level to read (fs_downsample).
    face: vec4<f32>,
    // x: the size of the cube that is read, at level 0. y: how many samples.
    source: vec4<f32>,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var source_sampler: sampler;
@group(1) @binding(0) var equirect: texture_2d<f32>;
@group(2) @binding(0) var sky: texture_cube<f32>;

const PI: f32 = 3.14159265358979;

@vertex
fn vs_fullscreen(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
    // One triangle that covers the target: (-1, -1), (3, -1), (-1, 3).
    let x = f32((i << 1u) & 2u);
    let y = f32(i & 2u);
    return vec4<f32>(x * 2.0 - 1.0, y * 2.0 - 1.0, 0.0, 1.0);
}

// The direction a texel of a face looks at, `uv` from -1 to 1 with y down.
// The faces are the ones texture sampling picks.
fn face_direction(face: u32, uv: vec2<f32>) -> vec3<f32> {
    switch face {
        case 0u: {
            return normalize(vec3<f32>(1.0, -uv.y, -uv.x));
        }
        case 1u: {
            return normalize(vec3<f32>(-1.0, -uv.y, uv.x));
        }
        case 2u: {
            return normalize(vec3<f32>(uv.x, 1.0, uv.y));
        }
        case 3u: {
            return normalize(vec3<f32>(uv.x, -1.0, -uv.y));
        }
        case 4u: {
            return normalize(vec3<f32>(uv.x, -uv.y, 1.0));
        }
        default: {
            return normalize(vec3<f32>(-uv.x, -uv.y, -1.0));
        }
    }
}

fn texel_direction(position: vec4<f32>) -> vec3<f32> {
    let uv = position.xy / params.face.y * 2.0 - vec2<f32>(1.0);
    return face_direction(u32(params.face.x), uv);
}

// The picture's centre is toward +x, its top is +y, and it runs
// counter-clockwise seen from above, as three.js reads it.
fn equirect_uv(d: vec3<f32>) -> vec2<f32> {
    return vec2<f32>(
        atan2(d.z, d.x) * (0.5 / PI) + 0.5,
        0.5 - asin(clamp(d.y, -1.0, 1.0)) / PI,
    );
}

@fragment
fn fs_equirect(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
    let uv = equirect_uv(texel_direction(position));
    return vec4<f32>(textureSampleLevel(equirect, source_sampler, uv, 0.0).rgb, 1.0);
}

@fragment
fn fs_downsample(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
    let d = texel_direction(position);
    return vec4<f32>(textureSampleLevel(sky, source_sampler, d, params.face.w).rgb, 1.0);
}

fn radical_inverse(index: u32) -> f32 {
    var bits = index;
    bits = (bits << 16u) | (bits >> 16u);
    bits = ((bits & 0x55555555u) << 1u) | ((bits & 0xAAAAAAAAu) >> 1u);
    bits = ((bits & 0x33333333u) << 2u) | ((bits & 0xCCCCCCCCu) >> 2u);
    bits = ((bits & 0x0F0F0F0Fu) << 4u) | ((bits & 0xF0F0F0F0u) >> 4u);
    bits = ((bits & 0x00FF00FFu) << 8u) | ((bits & 0xFF00FF00u) >> 8u);
    return f32(bits) * 2.3283064365386963e-10;
}

fn hammersley(index: u32, count: u32) -> vec2<f32> {
    return vec2<f32>(f32(index) / f32(count), radical_inverse(index));
}

// The level of `sky` whose texels are as wide as the solid angle `omega` that
// one sample stands for, plus one for a smoother result.
fn sample_level(omega: f32) -> f32 {
    let texel = 4.0 * PI / (6.0 * params.source.x * params.source.x);
    return max(0.5 * log2(omega / texel) + 1.0, 0.0);
}

fn tangent_to_world(local: vec3<f32>, n: vec3<f32>) -> vec3<f32> {
    let up = select(vec3<f32>(0.0, 1.0, 0.0), vec3<f32>(1.0, 0.0, 0.0), abs(n.y) > 0.999);
    let tangent = normalize(cross(up, n));
    let bitangent = cross(n, tangent);
    return tangent * local.x + bitangent * local.y + n * local.z;
}

@fragment
fn fs_irradiance(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
    let n = texel_direction(position);
    let count = u32(params.source.y);
    var sum = vec3<f32>(0.0);
    for (var i = 0u; i < count; i++) {
        let xi = hammersley(i, count);
        // Cosine-weighted: the pdf is cos / pi, which cancels the cosine of
        // the integral, so the mean of the samples is the irradiance over pi.
        let phi = 2.0 * PI * xi.x;
        let cos_theta = sqrt(1.0 - xi.y);
        let sin_theta = sqrt(xi.y);
        let l = tangent_to_world(vec3<f32>(sin_theta * cos(phi), sin_theta * sin(phi), cos_theta), n);
        let pdf = cos_theta / PI;
        let level = sample_level(1.0 / (f32(count) * pdf));
        sum += textureSampleLevel(sky, source_sampler, l, level).rgb;
    }
    return vec4<f32>(sum / f32(count), 1.0);
}

@fragment
fn fs_prefilter(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
    // The view is the normal, which is what a reflection map can know.
    let n = texel_direction(position);
    let alpha = params.face.z * params.face.z;
    let a2 = alpha * alpha;
    let count = u32(params.source.y);
    var sum = vec3<f32>(0.0);
    var weight = 0.0;
    for (var i = 0u; i < count; i++) {
        let xi = hammersley(i, count);
        let phi = 2.0 * PI * xi.x;
        let cos_theta = sqrt((1.0 - xi.y) / (1.0 + (a2 - 1.0) * xi.y));
        let sin_theta = sqrt(1.0 - cos_theta * cos_theta);
        let h = tangent_to_world(vec3<f32>(sin_theta * cos(phi), sin_theta * sin(phi), cos_theta), n);
        let l = 2.0 * dot(n, h) * h - n;
        let n_dot_l = dot(n, l);
        if n_dot_l > 0.0 {
            // GGX's distribution; with the view along the normal the pdf of
            // the reflected direction is D / 4.
            let d = cos_theta * cos_theta * (a2 - 1.0) + 1.0;
            let pdf = a2 / (PI * d * d) / 4.0;
            let level = sample_level(1.0 / (f32(count) * pdf + 1e-4));
            sum += textureSampleLevel(sky, source_sampler, l, level).rgb * n_dot_l;
            weight += n_dot_l;
        }
    }
    return vec4<f32>(sum / max(weight, 1e-4), 1.0);
}
