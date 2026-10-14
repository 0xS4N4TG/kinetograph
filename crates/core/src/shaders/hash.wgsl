// Integer hashing for seeded noise (grain, dither, dot matrix). Not a module
// on its own: the compositor puts it in front of every shader that calls
// `hash` or `cell_hash`, and src/hash.rs mirrors it in Rust, with tests, so
// the CPU and the GPU agree by construction.
//
// The pattern is a pure function of (seed, pixel, frame): nothing reads a
// clock or a random generator. `x` and `y` are canvas pixels (the texel minus
// the scene's margin), so a pattern does not move when the margin changes.

// PCG hash of one u32.
fn hash(v: u32) -> u32 {
    let s = v * 747796405u + 2891336453u;
    let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
    return (w >> 22u) ^ w;
}

// One hash per (seed, pixel, frame).
fn cell_hash(seed: u32, x: u32, y: u32, frame: u32) -> u32 {
    return hash(seed ^ hash(x ^ hash(y ^ hash(frame))));
}

// A hash as a float in [0, 1): the top 24 bits, which a f32 holds exactly.
fn unit_float(h: u32) -> f32 {
    return f32(h >> 8u) * (1.0 / 16777216.0);
}

// A canvas pixel coordinate as a hash input. Pixels in the margin are
// negative, which wraps; it only has to be the same every time.
fn pixel_coord(texel: i32, margin: u32) -> u32 {
    return bitcast<u32>(texel - i32(margin));
}
