# @kinetographdev/video-matting

Separates a video into an opaque base and a foreground with alpha, with the API of `@remotion/video-matting`. The models run natively (ONNX Runtime in the addon); no browser, no WebGPU.

`import ... from '@remotion/video-matting'` in a Kinetograph project resolves to this package. Models are downloaded from Hugging Face on first use and cached outside the package; see `THIRD-PARTY-NOTICES.md`.

Part of [Kinetograph](https://github.com/0xS4N4TG/kinetograph), a programmatic video engine with no browser in it. See the repository for the documentation.

Licensed under the Apache License 2.0, see `LICENSE.md` and `NOTICE`.
