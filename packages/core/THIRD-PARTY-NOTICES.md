# Third-party notices

The rest of this package is licensed under the PolyForm Small Business License 1.0.0 (`LICENSE.md`). The files below
are derived from Apache-2.0 work.

## HyperFrames (Apache License 2.0)

`dist/hyperframes/grading.js` ports the colour grade's contract (the controls with their defaults and limits, the
effect controls, the presets) of HyperFrames (`packages/core/src/colorGrading.ts`,
`packages/parsers/src/colorGradingContract.ts`); `dist/hyperframes/automation.js` ports its automation curves
(`packages/core/src/audioAutomation.ts`, `speedRamp.ts`). Copyright HeyGen, Inc. and the HyperFrames contributors, https://github.com/heygen-com/hyperframes, licensed under the Apache License, Version 2.0, whose text is in `LICENSE-APACHE-2.0.txt` in this package (also at http://www.apache.org/licenses/LICENSE-2.0). The shader the grade runs through is in the
`@kinetographdev/native` addon, whose notices name it.

Changes from the original: rewritten for the Kinetograph engine (the grade is written as a scene effect the GPU
compositor applies; automation is read for clips and speed ramps).
