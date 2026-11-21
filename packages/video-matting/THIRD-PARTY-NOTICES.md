# Third-party notices

The package is licensed under the Apache License 2.0 (`LICENSE.md`). It ships no model files: it downloads the models below, on request, from Hugging Face into the user's cache directory. The models keep their licences.

## MODNet, as exported by Xenova (Apache License 2.0)

`modnet`: https://huggingface.co/Xenova/modnet, the ONNX export of MODNet (Ke et al., "MODNet: Real-Time Trimap-Free Portrait Matting via Objective Decomposition"), licensed under the Apache License, Version 2.0 (http://www.apache.org/licenses/LICENSE-2.0). Downloaded unchanged (`onnx/model.onnx`, revision `fa2fa546052fba4c08921230a26cc69a333fca12`).

## BEN2 Base, as exported by onnx-community (MIT)

`ben2-base`: https://huggingface.co/onnx-community/BEN2-ONNX, the ONNX export of BEN2 Base by PramaLLC (https://huggingface.co/PramaLLC/BEN2), licensed under the MIT License. Downloaded unchanged (`onnx/model_fp16.onnx`, revision `c552aa82688edce09f0ac9d2e31ad53d9d629010`).

## ONNX Runtime (MIT)

ONNX Runtime (https://github.com/microsoft/onnxruntime), Copyright (c) Microsoft Corporation, licensed under the MIT License. It is not part of this package: the first use of matting downloads Microsoft's NuGet package `Microsoft.ML.OnnxRuntime` 1.31.0 from nuget.org, checks it against a pinned SHA-512, and keeps this platform's library in the model cache.
