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
