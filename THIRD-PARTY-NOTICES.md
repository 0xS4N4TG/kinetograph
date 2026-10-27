# Third-party notices

## HyperFrames (Apache License 2.0)

The colour grade and its 18 look effects (`crates/core/src/shaders/color_grade.wgsl`, `grade_prepass.wgsl`, `crates/core/src/grade.rs`,
`packages/core/src/hyperframes/grading.ts`) port the shader maths, the effect controls with their defaults and limits, and the
presets of HyperFrames' colour grading runtime (`packages/core/src/colorGrading.ts`, `packages/core/src/runtime/colorGrading.ts`,
`packages/parsers/src/colorGradingContract.ts`), rewritten in WGSL, Rust and TypeScript. Copyright HeyGen and the HyperFrames
contributors, https://github.com/heygen-com/hyperframes, licensed under the Apache License, Version 2.0
(http://www.apache.org/licenses/LICENSE-2.0). The ports are changed from the original: the shader is WGSL on the engine's GPU
passes, the effects read the layer's texture instead of a video element, and the half-size bloom runs at full size.
