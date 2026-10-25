# @kinetographdev/anime

An [anime.js](https://animejs.com) v4 timeline that does not autoplay and is seeked to the current frame, so a frame looks the same rendered alone, in sequence or in parallel.

Part of [Kinetograph](https://github.com/0xS4N4TG/kinetograph), a programmatic video engine. `animejs` is a peer dependency and is used as it is.

```sh
npm install @kinetographdev/anime animejs
```

```tsx
import { useAnimeTimeline } from '@kinetographdev/anime';

const scope = useAnimeTimeline((tl) => {
  tl.add('.box', { translateX: [0, 700], rotate: 360, ease: 'outExpo', duration: 900 }, 0)
    .add('.dot', { opacity: [0, 1], duration: 600 }, 300);
});
return <div ref={scope}>{/* elements with className="box" and "dot" */}</div>;
```

- `useAnimeTimeline(build, deps?)` creates `createTimeline({ autoplay: false })`, runs `build(tl)` inside `createScope` (selectors look inside the returned ref's element, and everything is reverted on unmount) and calls `tl.seek(frame / fps * 1000)` every frame. Callbacks run on a seek. `ref.timeline` is the timeline.
- `<AnimeTimeline build={...} deps={...}>` is the same as a `<div>`.
- An animation made in `build` that is not on `tl` (`animate(...)` instead of `tl.add(...)`) is warned about once: it would play on anime.js's own loop.

Licensed under the PolyForm Small Business License 1.0.0, see `LICENSE.md`.
