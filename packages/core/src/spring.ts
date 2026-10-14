// `spring` and `measureSpring`: a damped harmonic oscillator stepped once per
// frame. Written from Remotion's documented parameters (mass, damping,
// stiffness, overshootClamping, from, to, durationInFrames, delay, reverse) and
// checked against values recorded from the published package
// (test/fixtures/spring.json). Each frame advances the closed-form solution of
// the oscillator by one frame's time (capped at 64 ms), starting from the
// position and velocity the previous frame ended on; a fractional frame
// advances the last step by the fraction.

export interface SpringConfig {
  damping: number;
  mass: number;
  stiffness: number;
  overshootClamping: boolean;
}

const DEFAULT_CONFIG: SpringConfig = {
  damping: 10,
  mass: 1,
  stiffness: 100,
  overshootClamping: false,
};

interface Motion {
  current: number;
  velocity: number;
  toValue: number;
  lastTimestamp: number;
}

function step(motion: Motion, now: number, config: SpringConfig): Motion {
  const { toValue, lastTimestamp, current, velocity } = motion;
  const deltaTime = Math.min(now - lastTimestamp, 64);

  const c = config.damping;
  const m = config.mass;
  const k = config.stiffness;

  const v0 = -velocity;
  const x0 = toValue - current;

  const zeta = c / (2 * Math.sqrt(k * m));
  const omega0 = Math.sqrt(k / m);
  const omega1 = omega0 * Math.sqrt(1 - zeta ** 2);
  const t = deltaTime / 1000;

  let position: number;
  let speed: number;
  if (zeta < 1) {
    // underdamped
    const envelope = Math.exp(-zeta * omega0 * t);
    const sin1 = Math.sin(omega1 * t);
    const cos1 = Math.cos(omega1 * t);
    const underDampedPosition = envelope * (((v0 + zeta * omega0 * x0) / omega1) * sin1 + x0 * cos1);
    const underDampedVelocity =
      zeta * omega0 * underDampedPosition -
      envelope * (cos1 * (v0 + zeta * omega0 * x0) - omega1 * x0 * sin1);
    position = toValue - underDampedPosition;
    speed = underDampedVelocity;
  } else {
    // critically damped; also used for overdamped springs
    const envelope = Math.exp(-omega0 * t);
    position = toValue - envelope * (x0 + (v0 + omega0 * x0) * t);
    speed = envelope * (v0 * (t * omega0 - 1) + t * x0 * omega0 * omega0);
  }

  return { current: position, velocity: speed, toValue, lastTimestamp: now };
}

function calculate(frame: number, fps: number, config: SpringConfig, from: number, to: number): Motion {
  let motion: Motion = { current: from, velocity: 0, toValue: to, lastTimestamp: 0 };
  const clamped = Math.max(0, frame);
  const wholeFrames = Math.floor(clamped);
  const fraction = clamped - wholeFrames;
  for (let f = 0; f <= wholeFrames; f++) {
    motion = step(motion, (f / fps) * 1000, config);
  }
  if (fraction > 0) motion = step(motion, ((wholeFrames + fraction) / fps) * 1000, config);
  return motion;
}

/** How many frames the spring takes to settle within `threshold` of its range. */
export function measureSpring({
  fps,
  config = {},
  threshold = 0.005,
  from = 0,
  to = 1,
}: {
  fps: number;
  config?: Partial<SpringConfig>;
  threshold?: number;
  from?: number;
  to?: number;
}): number {
  if (typeof threshold !== 'number') {
    throw new TypeError(`threshold must be a number, got ${threshold} of type ${typeof threshold}`);
  }
  if (threshold === 0) return Infinity;
  if (threshold === 1) return 0;
  if (!Number.isFinite(threshold)) return 0;

  // Settling is judged on the free oscillation, with or without clamping.
  const full: SpringConfig = { ...DEFAULT_CONFIG, ...config, overshootClamping: false };
  const range = Math.abs(from - to);
  const settled = (frame: number) => Math.abs(calculate(frame, fps, full, from, to).current - to) < threshold * range;

  let frame = 0;
  while (!settled(frame)) frame++;
  // A spring crosses its target on the way, so it must stay settled for a while.
  let finishedFrame = frame;
  for (let i = 0; i < 20; i++) {
    frame++;
    if (!settled(frame)) {
      i = 0;
      finishedFrame = frame + 1;
    }
  }
  return finishedFrame;
}

export function spring({
  frame: passedFrame,
  fps,
  config = {},
  from = 0,
  to = 1,
  durationInFrames: passedDuration,
  durationRestThreshold,
  delay = 0,
  reverse = false,
}: {
  frame: number;
  fps: number;
  config?: Partial<SpringConfig>;
  from?: number;
  to?: number;
  durationInFrames?: number;
  durationRestThreshold?: number;
  delay?: number;
  reverse?: boolean;
}): number {
  if (typeof passedFrame === 'undefined') throw new TypeError('Argument missing for parameter "frame"');
  if (typeof fps !== 'number') {
    throw new TypeError(`"fps" must be a number, but you passed a value of type ${typeof fps} to spring()`);
  }
  if (fps <= 0) throw new TypeError(`"fps" must be positive, but got ${fps} to spring()`);
  const full: SpringConfig = { ...DEFAULT_CONFIG, ...config };
  if (full.damping <= 0) {
    throw new Error(
      'Spring damping must be greater than 0, otherwise the spring() animation will never end, causing an infinite loop.',
    );
  }
  if (typeof passedDuration === 'number' && passedDuration <= 0) {
    throw new TypeError(`A "duration" of a spring must be positive, but is ${passedDuration}`);
  }

  const needsNaturalDuration = reverse || typeof passedDuration !== 'undefined';
  const naturalDuration = needsNaturalDuration
    ? measureSpring({ fps, threshold: durationRestThreshold, config: full })
    : undefined;

  // The delay shifts the start; reversing then plays the animation backwards from its end.
  const delayed = passedFrame - delay;
  const frame = reverse ? (passedDuration ?? naturalDuration!) - delayed : delayed;

  // With a duration the animation is stretched so its natural length fits it.
  const scaled = passedDuration === undefined ? frame : frame / (passedDuration / naturalDuration!);

  if (passedDuration !== undefined && frame > passedDuration) return to;
  const value = calculate(scaled, fps, full, from, to).current;
  // Clamping only limits what is returned (the oscillator underneath keeps swinging), and
  // the published package only applies it to a rising spring.
  if (full.overshootClamping && from < to && value > to) return to;
  return value;
}
