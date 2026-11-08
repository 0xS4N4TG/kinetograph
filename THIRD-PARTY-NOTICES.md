# Third-party notices

## HyperFrames (Apache License 2.0)

The colour grade and its 18 look effects (`crates/core/src/shaders/color_grade.wgsl`, `grade_prepass.wgsl`, `crates/core/src/grade.rs`,
`packages/core/src/hyperframes/grading.ts`) port the shader maths, the effect controls with their defaults and limits, and the
presets of HyperFrames' colour grading runtime (`packages/core/src/colorGrading.ts`, `packages/core/src/runtime/colorGrading.ts`,
`packages/parsers/src/colorGradingContract.ts`), rewritten in WGSL, Rust and TypeScript. Copyright HeyGen and the HyperFrames
contributors, https://github.com/heygen-com/hyperframes, licensed under the Apache License, Version 2.0
(http://www.apache.org/licenses/LICENSE-2.0). The ports are changed from the original: the shader is WGSL on the engine's GPU
passes, and the effects read the layer's texture instead of a video element.

The audio effects (`packages/audio/src/hf-fx/`: `chain.ts`, `automation.ts`, `graph.ts`, `worklets.ts`) port the effect
registry with its parameters and ranges, the chain and automation readers, the lane scheduler, the Web Audio graph builders,
the reverb impulse, the tail and latency rules and the AudioWorklet processors (compressor, limiter, true-peak limiter, gate,
bitcrush, pitch shift) of HyperFrames' audio effects (`packages/core/src/audioFx.ts`, `audioAutomation.ts`,
`packages/core/src/audio/audioFxGraph.ts`, `audioFxAutomation.ts`, `audioFxTail.ts`, `audioFxWorklets.ts`, `audioFxTruePeak.ts`,
`packages/core/stubs/audio-fx-runtime-entry.ts`), and follow the mix order of its `packages/engine/src/services/audioMixer.ts`.
Copyright HeyGen and the HyperFrames contributors, same licence. The port is changed from the original: it runs on
node-web-audio-api's OfflineAudioContext instead of Chrome's, builds each graph once (no live updates), and adds what
Chrome's Web Audio does that node-web-audio-api does not (a delay's feedback a render quantum late, Chrome's 2x and 4x
WaveShaper oversampling).

## Kalam (SIL Open Font License 1.1)

The engine diagram on the docs site and in the README is lettered in Kalam, Copyright (c) 2014 Indian Type Foundry
(info@indiantypefoundry.com), licensed under the SIL Open Font License, Version 1.1 (https://openfontlicense.org). The
site serves the font files unchanged from the `@fontsource/kalam` package, which carries the full licence text; the
README images have the text converted to outlines.

## roughjs (MIT)

The sketched strokes and hatching of the engine diagram are made with roughjs. Copyright (c) 2019 Preet Shihn,
https://github.com/rough-stuff/rough, licensed under the MIT License: permission is granted, free of charge, to deal in
the software without restriction, provided the copyright notice and permission notice are included in all copies or
substantial portions; the software is provided "as is", without warranty of any kind.

## opentype.js (MIT)

`packages/site/scripts/engine-diagram.mjs` uses opentype.js, a build-time tool only (nothing from it ships), to turn the
diagram's text into outlines. Copyright (c) 2020 Frederik De Bleser and the opentype.js contributors,
https://github.com/opentypejs/opentype.js, licensed under the MIT License, on the same terms as above.

## MODNet and BEN2 (video matting models)

`kinetograph matte` and `@kinetographdev/video-matting` download two models on request, from Hugging Face, into the
user's cache directory. They are never bundled in the packages or the repository, and are downloaded unchanged.

- `modnet`: the ONNX export `Xenova/modnet` (https://huggingface.co/Xenova/modnet, `onnx/model.onnx`) of MODNet
  (https://github.com/ZHKKKe/MODNet), licensed under the Apache License, Version 2.0
  (http://www.apache.org/licenses/LICENSE-2.0).
- `ben2-base`: the ONNX export `onnx-community/BEN2-ONNX` (https://huggingface.co/onnx-community/BEN2-ONNX,
  `onnx/model_fp16.onnx`) of BEN2 Base by PramaLLC (https://huggingface.co/PramaLLC/BEN2), licensed under the MIT
  License.
