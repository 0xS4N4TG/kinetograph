import { useEffect, useRef, useState, type ReactNode } from 'react';
import { PlayIcon } from 'lucide-react';

import { CodeBlock, CommandBar } from '@/components/code';
import { Reveal } from '@/components/reveal';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { cn } from '@/lib/utils';
import { doc } from '@/sections/links';

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

/** Section headline. Leading 1.1 and a bottom reserve keep italic descenders (g, p, y) from clipping. */
function H2({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <h2 className={cn('pb-1 font-serif text-[clamp(36px,4.4vw,60px)] leading-[1.1] font-normal tracking-[-0.01em] text-balance', className)}>
      {children}
    </h2>
  );
}

const shell = 'mx-auto max-w-[1320px] px-[clamp(16px,4vw,44px)]';
const body = 'text-[15px] leading-relaxed';

// ---- what it draws ----

const DRAWS = ['CSS', 'SVG', 'Canvas 2D', 'WebGL shaders', 'glTF 3D', 'Lottie', 'Web Audio', 'motion blur', 'Google Fonts', 'video'];

export function Ticker() {
  return (
    <section className={cn(shell, 'py-10')}>
      <p className="mx-auto flex max-w-5xl flex-wrap items-baseline justify-center gap-x-5 gap-y-2 text-center">
        <span className="text-sm text-night/60">Drawn natively on the GPU:</span>
        {DRAWS.map((d, i) => (
          <span key={d} className="flex items-baseline gap-5">
            <span className="font-serif text-[clamp(22px,2.2vw,28px)] whitespace-nowrap text-cobalt italic">{d}</span>
            {i < DRAWS.length - 1 && <span className="text-xs text-cobalt/40" aria-hidden>✦</span>}
          </span>
        ))}
      </p>
    </section>
  );
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
            <a className="underline decoration-cobalt/40 underline-offset-2 hover:text-cobalt" href={doc('docs/HANDOFF.md')} target="_blank" rel="noreferrer">HANDOFF.md</a>.
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
    text: 'A recording 2D context: each call becomes a draw command, and Vello paints them. This frame has 2,000 strokes.',
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

// ---- Remotion ----

const REMOTION_CODE = `import { AbsoluteFill, interpolate, spring,
  useCurrentFrame, useVideoConfig } from 'remotion';

export const Title = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame, fps, config: { damping: 12 } });
  return (
    <AbsoluteFill style={{ background: '#2238c4', placeItems: 'center' }}>
      <h1 style={{ color: '#f7f4ec', fontSize: 120,
        transform: \`scale(\${s})\`,
        opacity: interpolate(frame, [0, 15], [0, 1]) }}>
        kinetograph
      </h1>
    </AbsoluteFill>
  );
};`;

const STEPS = [
  ['Bundle', 'esbuild bundles the project and points remotion and @remotion/* at Kinetograph’s implementation.'],
  ['Run the frame', 'Date, Math.random, timers and requestAnimationFrame follow the frame number. A frame is a pure function of (project, frame).'],
  ['Split the tree', 'Native elements become scene layers. Runs of HTML and SVG become DOM islands, sent to Rust as JSON.'],
  ['Style and lay out', 'Stylo applies the CSS, taffy and Parley lay it out, and it is painted in CSS paint order.'],
  ['Composite', 'wgpu draws the layer tree: Vello for vectors and text, WGSL for effects, naga for GLSL, scene3d for meshes.'],
  ['Encode', 'FFmpeg encodes on another thread while the GPU draws the next frame. Web Audio is mixed offline and muxed.'],
] as const;

export function Remotion() {
  return (
    <section id="remotion" className={cn(shell, 'py-[clamp(72px,10vw,140px)]')}>
      <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:gap-16">
        <Reveal className="lg:sticky lg:top-28">
          <H2 className="text-night">
            Your Remotion code, <em className="text-cobalt">unchanged.</em>
          </H2>
          <p className={cn(body, 'mt-5 max-w-[46ch] text-night/75')}>
            Imports from <code className="font-mono text-[13px]">remotion</code> and{' '}
            <code className="font-mono text-[13px]">@remotion/*</code> resolve to Kinetograph's own implementation,
            rebuilt from Remotion's documented behaviour. Sequences, springs, audio, video and Google Fonts work as they
            do there.
          </p>
          <p className={cn(body, 'mt-4 max-w-[46ch] text-night/75')}>
            If a project uses something the engine can't draw yet, <code className="font-mono text-[13px]">kinetograph doctor</code>{' '}
            tells you what and in which frames. With <code className="font-mono text-[13px]">--strict</code> it is an error.
          </p>
          <CommandBar command="npx kinetograph doctor src/index.tsx" className="mt-7 max-w-md border-cobalt/30" />
        </Reveal>
        <Reveal delay={0.1}>
          <CodeBlock title="src/Title.tsx" code={REMOTION_CODE} />
        </Reveal>
      </div>

      <div id="how" className="mt-[clamp(72px,9vw,120px)] border-t border-cobalt/15 pt-[clamp(48px,6vw,80px)]">
        <div className="mb-10 flex flex-wrap items-baseline justify-between gap-4">
          <h3 className="font-serif text-[clamp(28px,3.2vw,42px)] leading-tight font-normal text-night">One frame, start to finish</h3>
          <a className="text-sm text-cobalt underline decoration-cobalt/40 underline-offset-4 hover:decoration-cobalt" href={doc('README.md#architecture')} target="_blank" rel="noreferrer">
            Read the architecture
          </a>
        </div>
        <ol className="grid grid-cols-[minmax(0,1fr)] gap-px overflow-hidden border border-cobalt/20 bg-cobalt/20 sm:grid-cols-2 lg:grid-cols-3">
          {STEPS.map(([title, text], i) => (
            <li key={title} className={cn('p-6 sm:p-7', i === 4 ? 'bg-cobalt text-paper' : 'bg-paper')}>
              <div className="flex items-baseline gap-3">
                <span className={cn('font-serif text-3xl italic', i === 4 ? 'text-paper/70' : 'text-cobalt')}>{['I', 'II', 'III', 'IV', 'V', 'VI'][i]}</span>
                <span className={cn('font-serif text-xl', i === 4 ? 'text-paper' : 'text-night')}>{title}</span>
              </div>
              <p className={cn('mt-3 text-sm leading-relaxed', i === 4 ? 'text-paper/80' : 'text-night/70')}>{text}</p>
            </li>
          ))}
        </ol>
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

// ---- get started ----

export function Start() {
  return (
    <section id="start" className={cn(shell, 'grid grid-cols-[minmax(0,1fr)] gap-10 py-[clamp(72px,10vw,140px)] lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] lg:gap-16')}>
      <Reveal>
        <H2 className="text-night">Three commands to a film</H2>
        <p className={cn(body, 'mt-5 max-w-[42ch] text-night/75')}>
          You need Node 22 or later and a GPU that wgpu supports, such as Metal on a Mac. It needs no display, so it runs
          on a server too. Rendering video needs FFmpeg.
        </p>
      </Reveal>
      <ol className="space-y-6">
        {[
          ['Build it', 'git clone https://github.com/0xS4N4TG/kinetograph && cd kinetograph && npm ci && npm run build'],
          ['Open the studio', 'npx kinetograph studio examples/launch/index.tsx'],
          ['Render', 'npx kinetograph render examples/launch/index.tsx -o out/launch.mp4'],
        ].map(([t, cmd], i) => (
          <li key={t}>
            <Reveal delay={0.08 * i} className="grid grid-cols-[2.5rem_minmax(0,1fr)] items-start gap-3">
              <span className="pt-0.5 font-serif text-3xl text-cobalt italic">{i + 1}</span>
              <div>
                <div className="mb-2 font-serif text-xl text-night">{t}</div>
                <CommandBar command={cmd} className="border-cobalt/30" />
              </div>
            </Reveal>
          </li>
        ))}
      </ol>
    </section>
  );
}

// ---- questions ----

const FAQ: [string, ReactNode][] = [
  ['Is there really no browser?', 'None in the render path, canvas and WebGL included. Node runs your code and a Rust addon draws it. Chrome for Testing appears only in our tests, as the reference we compare frames against.'],
  ['Will my Remotion project render?', 'Most should, without edits: remotion and @remotion/* imports resolve to Kinetograph. The papercut project renders all 988 of its frames natively. What the engine cannot draw yet is reported with a warning, and kinetograph doctor lists it by frame. Known gaps are tracked in docs/OPEN_ISSUES.md.'],
  ['Is a render repeatable?', 'Yes. Date, Math.random, timers and requestAnimationFrame follow the frame number, so the same project and frame give the same pixels. Nothing reads the wall clock.'],
  ['What does it run on?', 'Node 22 or later and a GPU wgpu supports: Metal on macOS, Vulkan or DX12 elsewhere. It needs no window or display. The render command links FFmpeg, using VideoToolbox on macOS.'],
  ['How is it licensed?', 'PolyForm Small Business 1.0.0. It is free for individuals and for companies with fewer than 100 people and under a million dollars of revenue a year. Larger companies need a commercial licence.'],
  ['Can an agent drive it?', 'It was built for that. Every command takes --json and kinetograph mcp serves them as MCP tools. lint and inspect let an agent check a layout without looking at pixels.'],
];

export function Questions() {
  return (
    <section id="faq" className="border-t border-cobalt/15">
      <div className={cn(shell, 'grid grid-cols-[minmax(0,1fr)] gap-10 py-[clamp(72px,10vw,140px)] lg:grid-cols-[minmax(0,0.7fr)_minmax(0,1.3fr)] lg:gap-16')}>
        <Reveal>
          <H2 className="text-night">
            Things people <em className="text-cobalt">ask</em>
          </H2>
        </Reveal>
        <Accordion className="border-t border-cobalt/20">
          {FAQ.map(([q, a]) => (
            <AccordionItem key={q} value={q} className="border-b border-cobalt/20">
              <AccordionTrigger className="py-5 font-serif text-xl font-normal text-night hover:text-cobalt hover:no-underline">{q}</AccordionTrigger>
              <AccordionContent className={cn(body, 'pb-5 text-night/75')}>{a}</AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </div>
    </section>
  );
}
