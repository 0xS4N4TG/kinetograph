# @kinetographdev/motion

Ties [Motion](https://motion.dev)'s clock to the frame, and seeks `animate()` controls to it.

Part of [Kinetograph](https://github.com/0xS4N4TG/kinetograph), a programmatic video engine. `motion` (14.6 or later, for `processFrame`) is a peer dependency and is used as it is.

```sh
npm install @kinetographdev/motion motion
```

```tsx
import { MotionFrame, useAnimateAt, useMotionTime, useSpringAt } from '@kinetographdev/motion';

// Motion components: children mount at Motion time 0 and its loop is run to the frame's time.
<MotionFrame><motion.div initial={{ x: 0 }} animate={{ x: 600 }} transition={{ type: 'spring' }} /></MotionFrame>

// animate(), seeked: paused, controls.time = frame / fps.
useAnimateAt(() => animate(ref.current!, { x: [0, 400] }, { duration: 1.5 }));

// No frame loop at all: a MotionValue and a spring that are functions of the frame.
const x = useTransform(useMotionTime(), [0, 1000], [0, 400]);
const y = useSpringAt({ to: 120, stiffness: 60, damping: 8, delay: 10 });
```

- `<MotionFrame>` sets `MotionGlobalConfig.useManualTiming` and calls `processFrame` (Motion's documented way to drive it from your own timeline) in a passive effect, after the children have started their animations.
- `useAnimateAt(start, deps?)` pauses what `start` returns and sets `controls.time` every frame.
- Kinetograph's engine already gives Motion's own loop the same frame alone and in sequence; these make it explicit and keep the project the same under Remotion.
- A `useSpring` that follows a changing value depends on the frames visited before it. Use `useSpringAt` or `useMotionTime` + `useTransform` for those.

Licensed under the PolyForm Small Business License 1.0.0, see `LICENSE.md`.
