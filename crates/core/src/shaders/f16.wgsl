// `x` as an Rgba16Float render target holds it. The store rounds towards zero
// (checked on Apple GPUs against every case of a million random values, the
// halves below the normal range included), where `pack2x16float` rounds to
// the nearest, so this steps down one half float when that rounded up.
fn store_f16(x: f32) -> f32 {
    let h = pack2x16float(vec2<f32>(x, 0.0)) & 0xffffu;
    let r = unpack2x16float(h).x;
    if abs(r) > abs(x) {
        return unpack2x16float(h - 1u).x;
    }
    return r;
}
