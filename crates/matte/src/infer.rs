//! One model loaded in ONNX Runtime. `modnet` runs on the CPU; `ben2-base` runs on the GPU where this build reaches one
//! (DirectML on Windows, CUDA or WebGPU when built with them) and on the CPU otherwise.
//!
//! Measured on an M4 Mac, the only machine this was run on: CoreML cannot load BEN2's fp16 model ("Error in building
//! plan"). For MODNet, whose input has open height and width, CoreML's ML Program format gave the CPU's matte exactly
//! and was not faster on the one frame timed, and its NeuralNetwork format gave a wrong matte; the CPU runs it at video
//! speed, so it stays there and CoreML is not used. BEN2 on WebGPU (a build with the `webgpu` feature) was right and about 4 times faster than the
//! CPU, whose fp16 kernels are slow.

use std::path::Path;
use std::sync::OnceLock;

use ort::environment::Environment;
#[cfg(any(feature = "cuda", feature = "webgpu", target_os = "windows"))]
use ort::ep::ExecutionProvider;
use ort::session::Session;
use ort::value::Tensor;

use crate::model::Model;

/// The GPU back end this build has, by the name `mattingSupport()` and the result of `matteVideo()` use. A feature picks
/// it (`cuda`, then `webgpu`); without one it is DirectML on Windows and none elsewhere.
pub const GPU_BACKEND: Option<&str> = if cfg!(feature = "cuda") {
    Some("cuda")
} else if cfg!(feature = "webgpu") {
    Some("webgpu")
} else if cfg!(target_os = "windows") {
    Some("directml")
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
    #[cfg(not(any(feature = "cuda", feature = "webgpu", target_os = "windows")))]
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
    /// build has one that works, else the CPU, using
    /// `threads` for the CPU's share of the work. (MODNet's input has open dimensions; pinning them with ONNX
    /// Runtime's dimension overrides changes its output, so they stay open.)
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
