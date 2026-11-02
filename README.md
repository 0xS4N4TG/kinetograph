<p align="center">
  <img src="docs/readme/hero.webp" alt="Shots from the Kinetograph launch film: an 1891 Edison film with tracked captions, a film camera, printing receipts, 3D, isometric, shader, canvas and glass shots, then the kinetograph. wordmark" width="100%">
</p>

<h1 align="center">kinetograph.</h1>

<p align="center"><b>A blazingly fast programmatic video engine, made for agents.</b></p>

Kinetograph makes videos from code, without a browser. You (or an agent) write a video in TypeScript with Remotion's
API, or as a plain HTML page. Node runs the code, and a Rust GPU compositor draws every frame: CSS, SVG, Canvas 2D,
WebGL shaders, 3D and Web Audio. Existing Remotion projects render as they are, and so do
[HyperFrames](https://github.com/heygen-com/hyperframes) projects. The film above is one TypeScript project in
[`examples/launch`](examples/launch).

Kinetograph is in beta (version 0.2.5). APIs can still change between versions.

## Install

```sh
npm install kinetograph
npx kinetograph doctor
```

You need Node.js 22 or newer. The prebuilt addon covers macOS (arm64), Linux (x64) and Windows (x64).

## Make a video

Save this as `index.tsx`:

```tsx
import React from 'react';
import { AbsoluteFill, Composition, Text, registerRoot } from '@kinetographdev/core';
import { loadFont } from '@remotion/google-fonts/Inter';

const { fontFamily } = loadFont('normal', { weights: ['400'] });

const Title: React.FC = () => (
  <AbsoluteFill style={{ backgroundColor: '#14171f' }}>
    <Text x={320} y={300} font={fontFamily} size={96} color="#ffffff">Hello, Kinetograph</Text>
  </AbsoluteFill>
);

registerRoot(() => (
  <Composition id="Title" component={Title} durationInFrames={60} fps={30} width={1280} height={720} />
));
```

Render a TSX project:

```sh
npx kinetograph render index.tsx -o out.mp4
```

Render an HTML page or a HyperFrames project:

```sh
npx kinetograph render index.html -o out.mp4
```

## Docs

Everything else is on the docs site, [kinetograph.dev/docs](https://kinetograph.dev/docs/):

- [Installation](https://kinetograph.dev/docs/getting-started/installation/) and [First video](https://kinetograph.dev/docs/getting-started/first-video/)
- [Authoring](https://kinetograph.dev/docs/guides/authoring/) and [Remotion compatibility](https://kinetograph.dev/docs/compat/)
- [Studio](https://kinetograph.dev/docs/guides/studio/), the local editor
- [Use with agents](https://kinetograph.dev/docs/guides/agents/)
- [Engine](https://kinetograph.dev/docs/internals/engine/) and [What works](https://kinetograph.dev/docs/compat/)
- [Changelog](CHANGELOG.md) and [Contributing](https://kinetograph.dev/docs/contributing/)

<details>
<summary>Credits for the film's footage</summary>

- "Blacksmith Scene" (Edison, 1893) and "Fred Ott's Sneeze" (Edison, 1894), public domain.
- "Armistice Day Parade, Columbus, Ohio, 1927", US National Archives
  ([archive.org/details/111-h-1555](https://archive.org/details/111-h-1555)), a US government work.
- SMPTE Universal Leader, public domain.
- The handwritten "FILM" and the 16mm film burn are from licensed overlay packs ("Text Animation Overlays" and
  "Custom Transitions: Film Burns"); they are not in the repo.

</details>

## License

[PolyForm Small Business License 1.0.0](LICENSE.md). Kinetograph is source-available: free for individuals,
non-profits, and companies with fewer than 100 people and under 1,000,000 USD (2019) revenue. Larger companies need a
commercial licence; see [COMMERCIAL.md](COMMERCIAL.md). Vendored crates keep their own licences
([vendor/README.md](vendor/README.md)).

Required Notice: Copyright 2026 Sanat Gupta (https://github.com/0xS4N4TG)
