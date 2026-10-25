# hf-nyt

A HyperFrames project used by `test/hyperframes-*.test.ts`: the "NYT Graph" example of the HyperFrames catalog
(`registry/examples/nyt-graph`), an `index.html` that mounts `compositions/nyt-chart.html`, whose GSAP timeline draws
a bar and line chart over 15 s at 1920x1080, 30 fps.

HyperFrames is copyright HeyGen, licensed under the Apache License 2.0 (https://github.com/heygen-com/hyperframes).
The two HTML files are copied from it. One change: the Google Fonts `<link>` elements of `nyt-chart.html` are removed,
so the tests need no network (the text is then drawn in the engine's built-in font).

The page loads GSAP from `https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js`; the tests resolve it to the
`gsap@3.14.2` in the workspace's `node_modules` (a dev dependency of `packages/cli`).
