//! Shared by the tests that depend on Vello's pass structure or pixels. The default backend is Skia, so they pin
//! Vello; the rest of the suite runs on whichever backend the environment picks.
#![allow(dead_code)]

/// Selects Vello for this test process unless `KINETOGRAPH_BACKEND` is already set. Call it first in the test,
/// before any renderer exists.
pub fn pin_vello() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        if std::env::var_os("KINETOGRAPH_BACKEND").is_none() {
            // SAFETY: runs once, first thing in the test, before a renderer reads the variable.
            unsafe { std::env::set_var("KINETOGRAPH_BACKEND", "vello") };
        }
    });
}
