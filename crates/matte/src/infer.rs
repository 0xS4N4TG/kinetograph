//! One model loaded in ONNX Runtime. `modnet` runs on the CPU; `ben2-base` runs on the GPU or neural engine where this
//! build reaches one (CoreML on a Mac, DirectML on Windows, CUDA or WebGPU when built with them) and on the CPU
//! otherwise.
//!
//! Measured on an M4 Mac, the only machine this was run on:
//! - BEN2 on CoreML (ML Program format, all compute units) runs in 3.3 to 4.4 s a frame, about 2.5 times faster than
//!   the CPU's 8.2 to 9.5 s. It does not load with the CPU-and-GPU units alone ("Error in building plan"). CoreML
//!   compiles the model on every load (12 s), so the compiled form is kept beside the model file.
//! - MODNet, whose input has open height and width, gains nothing from CoreML: the ML Program format gave the CPU's
//!   matte exactly and the NeuralNetwork format took 2 to 3 times as long. The CPU runs it at video speed, so it stays
//!   there. (On dark, grainy film MODNet's matte differs between providers: it is unstable there, see
//!   `tests/person.rs`.)
//! - Not used: `api-22` and later make a session pick a provider by itself (it chose CoreML), so the crate sticks to
//!   `api-17` (Cargo.toml).

use std::path::Path;
use std::sync::OnceLock;

use ort::environment::Environment;
#[cfg(any(
    feature = "cuda",
    feature = "webgpu",
    target_os = "windows",
    target_os = "macos"
))]
use ort::ep::ExecutionProvider;
use ort::session::Session;
use ort::value::Tensor;

use crate::model::Model;

/// The GPU back end this build has, by the name `mattingSupport()` and the result of `matteVideo()` use. A feature picks
/// it (`cuda`, then `webgpu`); without one it is DirectML on Windows, CoreML on a Mac and none elsewhere.
pub const GPU_BACKEND: Option<&str> = if cfg!(feature = "cuda") {
    Some("cuda")
} else if cfg!(feature = "webgpu") {
    Some("webgpu")
} else if cfg!(target_os = "windows") {
    Some("directml")
} else if cfg!(target_os = "macos") {
    Some("coreml")
} else {
    None
};

fn environment() -> Result<&'static Environment, String> {
    static ENV: OnceLock<Result<Environment, String>> = OnceLock::new();
    ENV.get_or_init(|| {
        ort::init()
            .with_name("kinetograph")
            .build()
            .map_err(|e| e.to_string())
    })
    .as_ref()
    .map_err(|e| format!("cannot start ONNX Runtime: {e}"))
}

/// Why the GPU back end cannot be used, or `None` when this build has one and ONNX Runtime was compiled with it.
pub fn gpu_unavailable() -> Option<String> {
    let Some(name) = GPU_BACKEND else {
        return Some("no GPU back end in this build for this platform: ben2-base runs on the CPU (slowly), and modnet always does".into());
    };
    #[cfg(feature = "cuda")]
    let present = ort::ep::CUDA::is_available();
    #[cfg(all(feature = "webgpu", not(feature = "cuda")))]
    let present = ort::ep::WebGPU::is_available();
    #[cfg(all(target_os = "windows", not(any(feature = "cuda", feature = "webgpu"))))]
    let present = ort::ep::DirectML::is_available();
    #[cfg(all(target_os = "macos", not(any(feature = "cuda", feature = "webgpu"))))]
    let present = ort::ep::CoreML::is_available();
    #[cfg(not(any(
        feature = "cuda",
        feature = "webgpu",
        target_os = "windows",
        target_os = "macos"
    )))]
    let present: ort::Result<bool> = Ok(false);
    match present {
        Ok(true) => None,
        Ok(false) => Some(format!("ONNX Runtime was built without {name}")),
        Err(e) => Some(format!("cannot ask ONNX Runtime about {name}: {e}")),
    }
}

/// Whether ONNX Runtime starts at all (its library loads and the environment opens).
pub fn runtime_unavailable() -> Option<String> {
    environment().err()
}

pub struct Matter {
    session: Session,
    model: Model,
    /// The input's size: width, height.
    size: (u32, u32),
    backend: &'static str,
}

impl Matter {
    /// Loads the model file for frames resized to `size`, on the GPU when the model uses one (`Model::uses_gpu`) and this
    /// build has one that works, else the CPU, using `threads` for the CPU's share of the work.
    pub fn load(
        path: &Path,
        model: Model,
        size: (u32, u32),
        threads: usize,
    ) -> Result<Matter, String> {
        let env = environment()?;
        if model.uses_gpu()
            && let Some(backend) = GPU_BACKEND
        {
            match Self::open(env, path, Some(backend), threads) {
                Ok(session) => {
                    return Ok(Matter {
                        session,
                        model,
                        size,
                        backend,
                    });
                }
                // The GPU back end refused this model or machine: say so on the way to the CPU's answer, not silently.
                Err(e) => eprintln!(
                    "kinetograph-matte: {backend} did not load {}: {e}; using the CPU",
                    path.display()
                ),
            }
        }
        let session = Self::open(env, path, None, threads)?;
        Ok(Matter {
            session,
            model,
            size,
            backend: "cpu",
        })
    }

    fn open(
        env: &Environment,
        path: &Path,
        gpu: Option<&str>,
        threads: usize,
    ) -> Result<Session, String> {
        // The builder's errors carry the builder, which cannot cross threads: keep the message.
        fn msg<T>(e: ort::Error<T>) -> String {
            e.to_string()
        }
        let mut builder = Session::builder(env)
            .map_err(msg)?
            .with_intra_threads(threads)
            .map_err(msg)?;
        if gpu.is_some() {
            #[cfg(all(target_os = "macos", not(any(feature = "cuda", feature = "webgpu"))))]
            {
                use ort::ep::coreml::{ComputeUnits, ModelFormat};
                // CoreML compiles the model on load (12 s for BEN2): keep the compiled form beside the model file.
                let cache = path.with_extension("coreml-cache");
                let ep = ort::ep::CoreML::default()
                    .with_model_format(ModelFormat::MLProgram)
                    .with_compute_units(ComputeUnits::All)
                    .with_model_cache_dir(cache.to_string_lossy());
                builder = builder
                    .with_execution_providers([ep.build().error_on_failure()])
                    .map_err(msg)?;
            }
            #[cfg(feature = "cuda")]
            {
                builder = builder
                    .with_execution_providers([ort::ep::CUDA::default().build().error_on_failure()])
                    .map_err(msg)?;
            }
            #[cfg(all(feature = "webgpu", not(feature = "cuda")))]
            {
                builder = builder
                    .with_execution_providers([ort::ep::WebGPU::default()
                        .build()
                        .error_on_failure()])
                    .map_err(msg)?;
            }
            #[cfg(all(target_os = "windows", not(any(feature = "cuda", feature = "webgpu"))))]
            {
                builder = builder
                    .with_execution_providers([ort::ep::DirectML::default()
                        .build()
                        .error_on_failure()])
                    .map_err(msg)?;
            }
        }
        builder.commit_from_file(path).map_err(msg)
    }

    pub fn backend(&self) -> &'static str {
        self.backend
    }

    /// The matte of one preprocessed frame (`Model::preprocess`): `ih x iw` floats.
    pub fn run(&mut self, input: Vec<f32>) -> Result<Vec<f32>, String> {
        let (iw, ih) = self.size;
        let (input_name, output_name) = self.model.io();
        let tensor = Tensor::from_array((vec![1i64, 3, i64::from(ih), i64::from(iw)], input))
            .map_err(|e| e.to_string())?;
        let outputs = self
            .session
            .run(ort::inputs![input_name => tensor])
            .map_err(|e| e.to_string())?;
        let (shape, data) = outputs[output_name]
            .try_extract_tensor::<f32>()
            .map_err(|e| e.to_string())?;
        if data.len() != iw as usize * ih as usize {
            return Err(format!(
                "the model gave a matte of shape {shape:?}, expected {iw}x{ih}"
            ));
        }
        Ok(data.to_vec())
    }
}
