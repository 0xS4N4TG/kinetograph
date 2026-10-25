# @kinetographdev/p5-brush

A canvas that [p5.brush](https://github.com/acamposuribe/p5.brush) draws into, reseeded and redrawn from the frame number, so a frame is the same alone and in sequence.

Part of [Kinetograph](https://github.com/0xS4N4TG/kinetograph), a programmatic video engine. `p5.brush` is a peer dependency, used through `p5.brush/standalone`, and is used as it is.

```sh
npm install @kinetographdev/p5-brush p5.brush
```

```tsx
import { BrushCanvas } from '@kinetographdev/p5-brush';

<BrushCanvas seed={7} background="#f4efe6" origin="top-left" draw={(brush, frame, { width }) => {
  brush.set('HB', '#2f2a26', 1.4);
  brush.line(120, 140, 120 + frame * 10, 260);
}} />
```

- Each frame: `brush.load(canvas)`, `clear`, `seed(seed)`, `noiseSeed(seed)`, `draw`, `render`, inside `push`/`pop` so fill, hatch and brush settings do not carry to the next frame.
- The canvas is the composition's size unless `width` and `height` are given.
- p5.brush's origin is the centre of the canvas, y down. `origin="top-left"` translates so that (0, 0) is the top left corner.
- A render waits (`delayRender`) until the first frame is drawn.
- Needs the WebGL support of Kinetograph (a `webgl2` canvas context that the engine draws).

Licensed under the PolyForm Small Business License 1.0.0, see `LICENSE.md`.
