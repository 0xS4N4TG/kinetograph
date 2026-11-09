# @kinetographdev/video-matting

Separates a video into an opaque base and a foreground with alpha, with the API of `@remotion/video-matting`. The models run natively through ONNX Runtime, which the addon opens at run time and downloads on first use (8 to 83 MB, by platform); no browser, no WebGPU.

`import ... from '@remotion/video-matting'` in a Kinetograph project resolves to this package. Models are downloaded from Hugging Face on first use and cached outside the package; see `THIRD-PARTY-NOTICES.md`.

Part of [Kinetograph](https://github.com/0xS4N4TG/kinetograph), a programmatic video engine with no browser in it. See the repository for the documentation.

Licensed under the Apache License 2.0, see `LICENSE.md` and `NOTICE`.
