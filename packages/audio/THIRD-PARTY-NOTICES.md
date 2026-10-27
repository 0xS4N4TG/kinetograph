# Third-party notices

The rest of this package is licensed under the PolyForm Small Business License 1.0.0 (`LICENSE.md`). The files below
are derived from Apache-2.0 work.

## HyperFrames (Apache License 2.0)

The HyperFrames audio effects in `dist/hf-fx/` (`chain.js`, `automation.js`, `graph.js`, `worklets.js`) port the effect
registry with its parameters and ranges, the chain and automation readers, the lane scheduler, the Web Audio graph
builders, the reverb impulse, the tail and latency rules and the AudioWorklet processors (compressor, limiter,
true-peak limiter, gate, bitcrush, pitch shift) of HyperFrames (`packages/core/src/audioFx.ts`, `audioAutomation.ts`,
`packages/core/src/audio/audioFxGraph.ts`, `audioFxAutomation.ts`, `audioFxTail.ts`, `audioFxWorklets.ts`,
`audioFxTruePeak.ts`, `packages/core/stubs/audio-fx-runtime-entry.ts`), and `dist/render.js` follows the mix order of
its `packages/engine/src/services/audioMixer.ts`. Copyright HeyGen, Inc. and the HyperFrames contributors, https://github.com/heygen-com/hyperframes, licensed under the Apache License, Version 2.0, whose text is in `LICENSE-APACHE-2.0.txt` in this package (also at http://www.apache.org/licenses/LICENSE-2.0).

Changes from the original: rewritten for node-web-audio-api's OfflineAudioContext instead of Chrome's; each graph is
built once (no live updates); Chrome's behaviour where node-web-audio-api differs is added (a feedback delay repeats a
render quantum late; the saturation's 2x and 4x oversampling uses Chrome's resamplers); a bus's fader is baked as
HyperFrames' mixer bakes it.
