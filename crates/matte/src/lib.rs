//! Video matting: a subject cut out of a video with MODNet (people) or BEN2 (any foreground subject), run through
//! ONNX Runtime, written as a video with alpha. A preparation step that writes files once; a render only reads them.

mod audio;
mod infer;
mod join;
pub mod model;
mod pipeline;
pub mod resize;

pub use model::Model;
pub use pipeline::{
    AudioTarget, CANCELLED, Options, Output, Progress, Quality, Support, matte_video, split,
    support,
};
