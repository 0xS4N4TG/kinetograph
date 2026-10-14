// The feTurbulence noise of the W3C Filter Effects spec (Perlin noise, fractal
// or turbulence). Not a module on its own: the compositor puts it in front of
// every shader that calls `turbulence_value` (displace, noise), and
// src/turbulence.rs builds the tables, mirrors this maths in Rust and tests it,
// so the CPU and the GPU agree by construction.
//
// The tables of one seed are the storage buffer at group 1, binding 0: the
// lattice selector (256 entries and the 258 the reference copies past them),
// then the four channels' (R, G, B, A) gradient vectors, channel after
// channel. The noise is a pure function of the seed (which picked the tables)
// and the point, which is in LAYER space, so it sticks to the layer.

const GRADIENT_STRIDE: u32 = 514u;

struct Tables {
    lattice: array<u32, 514>,
    gradient: array<vec2<f32>, 2056>,
}

@group(1) @binding(0) var<storage, read> tables: Tables;

fn s_curve(t: f32) -> f32 {
    return t * t * (3.0 - 2.0 * t);
}

// The reference's lerp, which is not `mix`'s rounding.
fn lerp(t: f32, a: f32, b: f32) -> f32 {
    return a + t * (b - a);
}

fn gradient_at(channel: u32, index: u32) -> vec2<f32> {
    return tables.gradient[channel * GRADIENT_STRIDE + index];
}

// One octave of Perlin noise in -1..1 (the reference's `noise2`). The reference
// adds 4096 to the coordinate and truncates; 4096 is a multiple of the lattice
// size, so for v above -4096 that is floor(v) wrapped to the lattice and
// v - floor(v), computed here directly because an f32 holds twelve bits less
// of the fraction after the addition. `&` on an i32 is two's complement, so
// the wrap-around also holds for negative cells.
fn noise2(channel: u32, v: vec2<f32>) -> f32 {
    let cell = floor(v);
    let b0 = vec2<u32>(vec2<i32>(cell) & vec2<i32>(255));
    let b1 = (b0 + vec2<u32>(1u)) & vec2<u32>(255u);
    let r0 = v - cell;
    let r1 = r0 - vec2<f32>(1.0);

    let i = tables.lattice[b0.x];
    let j = tables.lattice[b1.x];
    let b00 = tables.lattice[i + b0.y];
    let b10 = tables.lattice[j + b0.y];
    let b01 = tables.lattice[i + b1.y];
    let b11 = tables.lattice[j + b1.y];

    let sx = s_curve(r0.x);
    let sy = s_curve(r0.y);
    let u0 = dot(vec2<f32>(r0.x, r0.y), gradient_at(channel, b00));
    let v0 = dot(vec2<f32>(r1.x, r0.y), gradient_at(channel, b10));
    let a = lerp(sx, u0, v0);
    let u1 = dot(vec2<f32>(r0.x, r1.y), gradient_at(channel, b01));
    let v1 = dot(vec2<f32>(r1.x, r1.y), gradient_at(channel, b11));
    let b = lerp(sx, u1, v1);
    return lerp(sy, a, b);
}

// A channel's value in 0..1 at `point` (layer space), from `octaves` octaves of
// noise starting at `frequency` per axis. `fractal` is fractalNoise,
// (sum + 1) / 2; otherwise turbulence, the sum of absolute values. No octaves
// is transparent black, as the spec says of numOctaves = 0.
fn turbulence_value(channel: u32, point: vec2<f32>, frequency: vec2<f32>, octaves: u32, fractal: bool) -> f32 {
    if octaves == 0u {
        return 0.0;
    }
    var sum = 0.0;
    var v = point * frequency;
    var ratio = 1.0;
    for (var o = 0u; o < octaves; o++) {
        let n = noise2(channel, v);
        sum += select(abs(n), n, fractal) / ratio;
        v *= 2.0;
        ratio *= 2.0;
    }
    return clamp(select(sum, (sum + 1.0) * 0.5, fractal), 0.0, 1.0);
}
