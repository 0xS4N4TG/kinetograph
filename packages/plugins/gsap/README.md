# @kinetographdev/gsap

A paused GSAP timeline that is seeked to the current frame, so a frame looks the same rendered alone, in sequence or in parallel.

Part of [Kinetograph](https://github.com/0xS4N4TG/kinetograph), a programmatic video engine. `gsap` is a peer dependency and is used as it is.

```sh
npm install @kinetographdev/gsap gsap
```

```tsx
import { useGsapTimeline } from '@kinetographdev/gsap';

const scope = useGsapTimeline((tl) => {
  tl.fromTo('.box', { y: 120, opacity: 0 }, { y: 0, opacity: 1, stagger: 0.08, ease: 'back.out(1.7)' }, 0.1);
});
return <div ref={scope}>{/* elements with className="box" */}</div>;
```

- `useGsapTimeline(build, deps?)` builds the tweens once inside `gsap.context` (reverted on unmount) and calls `tl.seek(frame / fps, false)` every frame. `suppressEvents` is `false`, so `onUpdate`, `onStart` and `onComplete` run on a seek. The returned ref scopes string selectors; `ref.timeline` is the timeline.
- `<GsapTimeline build={...} deps={...}>` is the same as a `<div>`.
- A tween made in `build` that is not on `tl` (`gsap.to(...)` instead of `tl.to(...)`) plays on GSAP's root clock, which the engine moves with the frame, so it is right in a render too. The timeline is the pattern that does not depend on when the tween was made.

Licensed under the PolyForm Small Business License 1.0.0, see `LICENSE.md`.
