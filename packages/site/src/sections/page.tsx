'use client';

import { useEffect, useRef, useState } from 'react';
import { PlayIcon } from 'lucide-react';

import { CodeBlock, CommandBar } from '@/components/code';
import { Reveal } from '@/components/reveal';
import { cn } from '@/lib/utils';
import { doc } from '@/sections/links';
import { body, H2, shell } from '@/sections/shared';

/** True once the element has scrolled into view (and stays true). */
function useSeen<T extends Element>() {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => e?.isIntersecting && setSeen(true), { threshold: 0.35 });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return [ref, seen] as const;
}

// ---- measured ----

export function Proof() {
  const [ref, seen] = useSeen<HTMLDivElement>();
  const reduce = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const bars = [
    { name: 'Kinetograph', s: 1.28, main: true },
    { name: 'Remotion', s: 8.96, main: false },
  ];
  return (
    <section id="proof" className={cn(shell, 'border-t border-cobalt/15 py-[clamp(72px,9vw,128px)]')}>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-14 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] md:gap-20">
        <Reveal>
          <div className="font-serif text-[clamp(96px,14vw,200px)] leading-[0.9] font-light tracking-[-0.03em] text-cobalt tabular-nums">7.0×</div>
          <p className={cn(body, 'mt-6 max-w-[48ch] text-night/75')}>
            faster than Remotion on the same scene, S04: 89 frames at 1080p. Median of runs on an Apple M4, measured with{' '}
            <code className="font-mono text-[13px]">kinetograph bench</code>.
          </p>
          <div ref={ref} className="mt-9 max-w-xl space-y-4">
            {bars.map((b) => (
              <div key={b.name} className="grid grid-cols-[7.5rem_minmax(0,1fr)_4.5rem] items-center gap-4">
                <span className={cn('font-serif text-lg', b.main ? 'text-cobalt' : 'text-night/60')}>{b.name}</span>
                <span className="h-2.5">
                  <span
                    className={cn('block h-full origin-left', b.main ? 'bg-cobalt' : 'bg-night/25')}
                    style={{
                      width: `${(b.s / 8.96) * 100}%`,
                      transform: `scaleX(${seen || reduce ? 1 : 0})`,
                      transition: reduce ? undefined : `transform ${b.s * 0.25}s linear`,
                    }}
                  />
                </span>
                <span className={cn('text-right font-mono tabular-nums', b.main ? 'text-cobalt' : 'text-night/60')}>{b.s.toFixed(2)} s</span>
              </div>
            ))}
          </div>
          <p className="mt-4 text-xs text-night/50">
            The bars fill at a quarter of real time. Method in{' '}
            <a className="underline decoration-cobalt/40 underline-offset-2 hover:text-cobalt" href={doc('README.md#build-and-run')} target="_blank" rel="noreferrer">the README</a>.
          </p>
        </Reveal>

        <div className="divide-y divide-cobalt/15 self-end border-y border-cobalt/15">
          {[
            ['988 / 988', 'frames of papercut, the first real Remotion project we tried, render natively. None are skipped.'],
            ['0', 'browsers. Chrome only runs in the test suite, where we compare our frames against it.'],
          ].map(([n, t], i) => (
            <Reveal key={n} delay={0.1 + i * 0.08} className="py-8">
              <div className="font-serif text-[clamp(52px,5.4vw,76px)] leading-none font-light whitespace-nowrap text-cobalt tabular-nums">{n}</div>
              <p className={cn(body, 'mt-3 max-w-[38ch] text-night/75')}>{t}</p>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

// ---- the film ----

const STILLS = [
  ['s02-66', 'The question'],
  ['s05-30', 'The camera, in 3D'],
  ['m1-85', 'Extruded type in Scene3D'],
  ['m2-40', 'An orthographic camera'],
  ['m3-40', 'A GLSL shader'],
  ['m4-40', 'Canvas 2D strokes'],
  ['m5-60', 'Ray-traced glass'],
  ['s08-200', 'Remotion code, unchanged'],
  ['s09-150', 'The benchmark'],
  ['s10-70', 'Just pixels'],
] as const;

export function Film() {
  const video = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  return (
    <section id="film" className="py-[clamp(72px,9vw,128px)]">
      <div className={shell}>
        <Reveal className="max-w-[65ch]">
          <H2 className="text-night">
            This film was rendered by <em className="text-cobalt">Kinetograph.</em>
          </H2>
          <p className={cn(body, 'mt-5 text-night/75')}>
            1,521 frames, rendered in 297 seconds on a laptop. Everything in it, sound effects included, comes from one
            TypeScript project in the repo: <code className="font-mono text-[13px]">examples/launch</code>.
          </p>
        </Reveal>

        <Reveal delay={0.1} className="relative mt-12 border border-cobalt/40 p-2 sm:p-3">
          <span className="pointer-events-none absolute -top-px -left-px size-5 border-t-2 border-l-2 border-cobalt" />
          <span className="pointer-events-none absolute -top-px -right-px size-5 border-t-2 border-r-2 border-cobalt" />
          <span className="pointer-events-none absolute -bottom-px -left-px size-5 border-b-2 border-l-2 border-cobalt" />
          <span className="pointer-events-none absolute -right-px -bottom-px size-5 border-r-2 border-b-2 border-cobalt" />
          <div className="relative aspect-video overflow-hidden bg-night">
            <video
              ref={video}
              className="size-full object-cover"
              src="/film/launch.mp4"
              poster="/film/poster.jpg"
              preload="none"
              playsInline
              controls={playing}
              onPlay={() => setPlaying(true)}
            />
            {!playing && (
              <button
                type="button"
                onClick={() => void video.current?.play()}
                className="group absolute inset-0 flex items-center justify-center"
                aria-label="Play the launch film"
              >
                <span className="flex size-20 items-center justify-center rounded-full bg-cobalt text-paper shadow-[0_18px_50px_-12px_rgb(34_56_196/0.6)] transition-transform duration-300 group-hover:scale-105 group-active:scale-[0.97]">
                  <PlayIcon className="ml-1 size-7 fill-current" />
                </span>
              </button>
            )}
          </div>
        </Reveal>
      </div>

      {/* Stills from the film on a strip of film: the page's one marquee, there to show how much the one project holds. */}
      <div className="relative mt-16 overflow-hidden bg-cobalt py-6">
        <div className="absolute inset-x-0 top-2 h-2 bg-[repeating-linear-gradient(90deg,transparent_0_10px,rgb(247_244_236/0.6)_10px_22px)]" />
        <div className="absolute inset-x-0 bottom-2 h-2 bg-[repeating-linear-gradient(90deg,transparent_0_10px,rgb(247_244_236/0.6)_10px_22px)]" />
        <div className="flex w-max animate-marquee gap-3 [animation-duration:70s] hover:[animation-play-state:paused]">
          {[...STILLS, ...STILLS].map(([n, label], i) => (
            <figure key={i} className="w-[min(300px,62vw)] shrink-0" aria-hidden={i >= STILLS.length}>
              <img src={`/film/${n}.jpg`} alt={i < STILLS.length ? `Launch film still: ${label}` : ''} width={960} height={540} loading="lazy" className="aspect-video w-full object-cover" />
              <figcaption className="mt-2 text-xs text-paper/75">{label}</figcaption>
            </figure>
          ))}
        </div>
      </div>
    </section>
  );
}

// ---- every surface ----

const SURFACES = [
  {
    api: '<Scene3D>', title: '3D in the same pass', still: 'm1-85',
    text: 'Meshes, extruded type and glTF models, lit by an HDR image and casting shadows. They composite with the 2D layers around them.',
    code: `<Scene3D width={W} height={H} environment={{ src: HDRI }}>
  <Camera3D fov={fov} position={pos} target={[0, 0.6, 0]} />
  <DirectionalLight direction={[0.5, -0.9, -0.55]} castShadow />
  <Text3D size={1.55} depth={0.55} material={{ color: RED }}>
    kinetograph
  </Text3D>
</Scene3D>`,
  },
  {
    api: '<Camera3D type="orthographic">', title: 'Isometric scenes', still: 'm2-40',
    text: 'An orthographic camera turns the same 3D layer into an isometric diorama. In the film it dives into one of 81 blocks.',
    code: `<Camera3D
  type="orthographic"
  height={10.5 * (1 - dive) + 0.25 * dive}
  position={eye}
  target={look}
/>`,
  },
  {
    api: '<GlslShader>', title: 'WebGL shaders', still: 'm3-40',
    text: 'GLSL ES fragment shaders, translated for the GPU by naga. Uniforms and textures are props, so they animate like anything else.',
    code: `<GlslShader
  width={W} height={H}
  fragment={MARBLE}
  uniforms={{ u_t: frame / 30, u_red: red }}
/>`,
  },
  {
    api: '<Canvas>', title: 'Canvas 2D', still: 'm4-40',
    text: 'A recording 2D context: each call becomes a draw command, and Skia paints them. This frame has 2,000 strokes.',
    code: `<Canvas width={W} height={H} draw={(ctx) => {
  ctx.lineWidth = 2.6;
  for (const p of field) {
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x + p.dx, p.y + p.dy);
  }
  ctx.stroke();
}} />`,
  },
  {
    api: '<GlslShader textures>', title: 'Glass that bends light', still: 'm5-60',
    text: 'Three spheres, ray-traced per pixel, refract a plate of the wordmark and split it into colour. It is one shader, sampled four times a pixel.',
    code: `<GlslShader
  fragment={GLASS}
  textures={{ u_plate: { src: staticFile('mg/glass-plate.png') } }}
  uniforms={{ u_cam: [0, 0, cz] }}
/>`,
  },
];

export function Surfaces() {
  const [active, setActive] = useState(0);
  const s = SURFACES[active]!;
  return (
    <section id="engine" className="bg-cobalt py-[clamp(72px,10vw,140px)] text-paper">
      <div className={cn(shell, 'grid grid-cols-[minmax(0,1fr)] gap-12 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.4fr)] lg:gap-16')}>
        <Reveal>
          <H2>
            It all draws on <em>one GPU.</em>
          </H2>
          <p className={cn(body, 'mt-5 max-w-[46ch] text-paper/80')}>
            HTML and CSS go through Stylo, Firefox's style engine, and taffy and Parley lay them out. SVG goes through
            usvg. It all ends up in one layer tree, and wgpu composites that together with these native elements.
          </p>
          <div className="mt-8 border-y border-paper/20" role="tablist" aria-label="Native elements">
            {SURFACES.map((x, i) => (
              <button
                key={x.title}
                type="button"
                role="tab"
                aria-selected={i === active}
                onClick={() => setActive(i)}
                className={cn(
                  'flex w-full items-baseline gap-4 border-l-2 py-3.5 pl-4 text-left transition-colors',
                  i === active ? 'border-paper text-paper' : 'border-transparent text-paper/60 hover:text-paper/90',
                )}
              >
                <span className="font-serif text-xl">{x.title}</span>
                <span className="ml-auto hidden font-mono text-[11px] text-paper/55 sm:inline">{x.api}</span>
              </button>
            ))}
          </div>
        </Reveal>

        <div className="grid gap-5" role="tabpanel">
          <img
            key={s.still}
            src={`/film/${s.still}.jpg`}
            alt={`${s.title}, a frame from the launch film`}
            width={960}
            height={540}
            className="aspect-video w-full border border-paper/20 object-cover animate-in fade-in duration-500"
          />
          <p className={cn(body, 'max-w-[60ch] text-paper/85')}>{s.text}</p>
          <CodeBlock key={s.api} title={s.api} code={s.code} className="border-paper/20 text-[12px]" />
        </div>
      </div>
    </section>
  );
}


// ---- agents ----

const COMMANDS = [
  ['still', 'Render one frame to a PNG, to look at what you made.', 'npx kinetograph still index.tsx 120 -o frame.png --json'],
  ['strip', 'A contact sheet of evenly spaced frames, labelled with frame and time.', 'npx kinetograph strip index.tsx -n 12 -o strip.png'],
  ['inspect', 'The scene graph at a frame: layers, bounds and resolved styles.', 'npx kinetograph inspect index.tsx --frame 60 --json'],
  ['lint', 'Text overflowing its box, layers off the canvas, missing fonts and assets.', 'npx kinetograph lint index.tsx --json'],
  ['render', 'Frames to a video, with audio.', 'npx kinetograph render index.tsx -o out.mp4'],
  ['mcp', 'The same commands as an MCP server on stdio, one tool each.', 'npx kinetograph mcp'],
] as const;

export function Agents() {
  const [i, setI] = useState(0);
  const c = COMMANDS[i]!;
  return (
    <section id="agents" className="border-y border-cobalt/15 py-[clamp(72px,10vw,140px)]">
      <div className={shell}>
        <Reveal className="max-w-[65ch]">
          <H2 className="text-night">
            An agent can <em className="text-cobalt">see its own work.</em>
          </H2>
          <p className={cn(body, 'mt-5 text-night/75')}>
            Every command takes <code className="font-mono text-[13px]">--json</code>, and{' '}
            <code className="font-mono text-[13px]">kinetograph mcp</code> serves them as tools. An agent writes the TSX,
            renders a still, reads the scene graph and fixes what it finds. This film was made that way.
          </p>
        </Reveal>

        <Reveal delay={0.1} className="mt-12 grid grid-cols-[minmax(0,1fr)] border border-cobalt/25 bg-paper md:grid-cols-[12rem_minmax(0,1fr)]">
          <div className="flex overflow-x-auto border-b border-cobalt/20 md:flex-col md:border-r md:border-b-0" role="tablist" aria-label="Commands">
            {COMMANDS.map(([name], k) => (
              <button
                key={name}
                type="button"
                role="tab"
                aria-selected={k === i}
                onClick={() => setI(k)}
                className={cn(
                  'shrink-0 px-5 py-3.5 text-left font-mono text-sm transition-colors',
                  k === i ? 'bg-cobalt text-paper' : 'text-night/70 hover:bg-cobalt/8 hover:text-cobalt',
                )}
              >
                {name}
              </button>
            ))}
          </div>
          <div className="flex flex-col justify-center p-6 sm:p-10" role="tabpanel">
            <p className="font-serif text-[clamp(24px,2.4vw,32px)] leading-snug text-night">{c[1]}</p>
            <CommandBar command={c[2]} className="mt-7 border-cobalt/30" />
            <p className="mt-7 text-sm leading-relaxed text-night/60">
              There is more: compositions, onion, check, bench, audio analyze, snapshot, effects and studio.
            </p>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

