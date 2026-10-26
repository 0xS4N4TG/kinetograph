//! The pieces of the `kinetograph` command that do not need a GPU to test:
//! the ffmpeg encoder and the `render` driver around it. The commands
//! themselves are in `main.rs`.

pub mod encode;
pub mod external;
pub mod render;
