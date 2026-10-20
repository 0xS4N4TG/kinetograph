import { useEffect, useRef, useState, type ReactNode } from 'react';
import { PlayIcon } from 'lucide-react';

import { CodeBlock, CommandBar } from '@/components/code';
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

function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('font-mono text-[11px] tracking-[0.3em] text-cobalt uppercase', className)}>{children}</div>;
}

function Rule({ className }: { className?: string }) {
  return (
    <div className={cn('flex items-center gap-3 text-cobalt', className)} aria-hidden>
      <span className="h-px flex-1 bg-current opacity-30" />
      <svg width="14" height="14" viewBox="-7 -7 14 14"><path d="M0 -7Q1 -1 7 0Q1 1 0 7Q-1 1 -7 0Q-1 -1 0 -7Z" fill="currentColor" /></svg>
      <span className="h-px flex-1 bg-current opacity-30" />
    </div>
  );
}

const shell = 'mx-auto max-w-[1320px] px-[clamp(16px,4vw,44px)]';

// ---- what it draws ----

const DRAWS = ['CSS', 'SVG', 'Canvas 2D', 'WebGL shaders', 'glTF and PBR 3D', 'Lottie', 'Web Audio', 'motion blur', 'Google Fonts', 'video layers'];

export function Ticker() {
  const row = DRAWS.flatMap((d, i) => [
    <span key={d} className="font-serif text-[clamp(22px,2.4vw,30px)] whitespace-nowrap text-cobalt italic">{d}</span>,
    <span key={`s${i}`} className="text-cobalt/50" aria-hidden>✦</span>,
  ]);
  return (
    <section className={cn(shell, 'flex items-center gap-8 py-6')}>
      <div className="shrink-0 font-mono text-[10px] leading-[1.6] tracking-[0.3em] text-night/70 uppercase">
        Drawn
        <br />
        natively,
        <br />
        on the GPU
      </div>
      <div className="relative min-w-0 flex-1 overflow-hidden [mask-image:linear-gradient(90deg,transparent,#000_8%,#000_92%,transparent)]">
        <div className="flex w-max animate-marquee items-center gap-8">
          {row}
          {row.map((n, i) => <span key={`b${i}`} aria-hidden>{n}</span>)}
        </div>
      </div>
    </section>
  );
}

// ---- measured ----

export function Proof() {
  const [ref, seen] = useSeen<HTMLDivElement>();
  const bars = [
    { name: 'Kinetograph', s: 1.28, note: 'Node + the Rust compositor', main: true },
    { name: 'Remotion', s: 8.96, note: 'headless Chrome, a screenshot per frame', main: false },
  ];
  return (
    <section id="proof" className={cn(shell, 'py-[clamp(64px,9vw,120px)]')}>
      <Rule className="mb-14" />
      <div className="grid gap-12 md:grid-cols-3 md:gap-8">
        {[
          ['7.0×', 'faster than Remotion on the same scene. 1.28 s against 8.96 s, the median on an Apple M4.'],
          ['988 / 988', 'frames of papercut, the first real Remotion project we tried, render natively. None are skipped.'],
          ['0', 'browsers. Chrome only runs in the test suite, where we compare our frames against it.'],
        ].map(([n, t]) => (
          <div key={n} className="text-center md:px-6">
            <div className="font-serif text-[clamp(52px,6vw,84px)] leading-none font-light whitespace-nowrap text-cobalt tabular-nums">{n}</div>
            <p className="mx-auto mt-4 max-w-[30ch] text-[15px] leading-relaxed text-night/75">{t}</p>
          </div>
        ))}
      </div>

      <div ref={ref} className="mx-auto mt-16 max-w-3xl border border-cobalt/25 bg-card p-6 sm:p-8">
        <div className="mb-5 flex flex-wrap items-baseline justify-between gap-2">
          <Eyebrow>Same project, same frames</Eyebrow>
          <span className="font-mono text-[11px] text-night/60">S04 · 89 frames · 1080p</span>
        </div>
        <div className="space-y-5">
          {bars.map((b) => (
            <div key={b.name}>
              <div className="mb-2 flex items-baseline justify-between gap-4">
                <span className={cn('font-serif text-lg', b.main ? 'text-cobalt' : 'text-night/70')}>
                  {b.name} <span className="hidden font-sans text-xs text-night/50 sm:inline">{b.note}</span>
                </span>
                <span className={cn('font-mono text-lg whitespace-nowrap tabular-nums', b.main ? 'text-cobalt' : 'text-night/60')}>{b.s.toFixed(2)} s</span>
              </div>
              <div className="h-3 overflow-hidden bg-cobalt/8">
                <div
                  className={cn('h-full origin-left', b.main ? 'bg-cobalt' : 'bg-night/25')}
                  style={{
                    width: `${(b.s / 8.96) * 100}%`,
                    transform: `scaleX(${seen ? 1 : 0})`,
                    transition: `transform ${b.s * 0.25}s linear`,
                  }}
                />
              </div>
            </div>
          ))}
        </div>
        <p className="mt-5 text-xs text-night/55">
          Bars fill at a quarter of real time. Measured with <code className="font-mono">kinetograph bench</code>; method in{' '}
          <a className="underline decoration-cobalt/40 underline-offset-2 hover:text-cobalt" href={doc('docs/HANDOFF.md')} target="_blank" rel="noreferrer">HANDOFF.md</a>.
        </p>
      </div>
    </section>
  );
}

// ---- the film ----

const STILLS = [
  ['s02-66', 'the question'],
  ['s05-30', 'the camera, in 3D'],
  ['m1-85', '<Scene3D>'],
  ['m2-40', 'orthographic camera'],
  ['m3-40', '<GlslShader>'],
  ['m4-40', '<Canvas>'],
  ['m5-60', 'glass, ray-traced'],
  ['s08-200', 'Remotion code'],
  ['s09-150', 'the benchmark'],
  ['s10-70', 'just pixels'],
] as const;

export function Film() {
  const video = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  return (
    <section id="film" className="bg-cobalt py-[clamp(64px,9vw,120px)] text-paper">
      <div className={shell}>
        <div className="grid grid-cols-[minmax(0,1fr)] items-end gap-6 md:grid-cols-[1.1fr_1fr]">
          <div>
            <Eyebrow className="text-paper/70">The launch film · 50 s</Eyebrow>
            <h2 className="mt-4 font-serif text-[clamp(38px,5vw,68px)] leading-[1.02] font-normal text-balance">
              This film was rendered by <em>Kinetograph.</em>
            </h2>
          </div>
          <p className="max-w-[46ch] text-[15px] leading-relaxed text-paper/80 md:justify-self-end">
            1,521 frames, rendered in 297 seconds on a laptop. Everything in it, sound effects included, comes from one
            TypeScript project in the repo: <code className="font-mono text-[13px]">examples/launch</code>.
          </p>
        </div>

        <div className="relative mt-12 border border-paper/40 p-2 sm:p-3">
          <span className="pointer-events-none absolute -top-px -left-px size-5 border-t-2 border-l-2 border-paper" />
          <span className="pointer-events-none absolute -top-px -right-px size-5 border-t-2 border-r-2 border-paper" />
          <span className="pointer-events-none absolute -bottom-px -left-px size-5 border-b-2 border-l-2 border-paper" />
          <span className="pointer-events-none absolute -right-px -bottom-px size-5 border-r-2 border-b-2 border-paper" />
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
                className="group absolute inset-0 flex items-center justify-center bg-night/10"
                aria-label="Play the launch film"
              >
                <span className="flex size-20 items-center justify-center rounded-full border border-paper/70 bg-cobalt/90 text-paper shadow-2xl transition-transform group-hover:scale-105">
                  <PlayIcon className="ml-1 size-7 fill-current" />
                </span>
              </button>
            )}
          </div>
        </div>
      </div>

      {/* a contact sheet of stills from the film, on a strip of film */}
      <div className="relative mt-14 overflow-hidden border-y border-paper/30 bg-night py-5">
        <div className="absolute inset-x-0 top-1.5 h-2 bg-[repeating-linear-gradient(90deg,transparent_0_10px,rgb(247_244_236/0.55)_10px_22px)]" />
        <div className="absolute inset-x-0 bottom-1.5 h-2 bg-[repeating-linear-gradient(90deg,transparent_0_10px,rgb(247_244_236/0.55)_10px_22px)]" />
        <div className="flex w-max animate-marquee gap-3 [animation-duration:70s] hover:[animation-play-state:paused]">
          {[...STILLS, ...STILLS].map(([n, label], i) => (
            <figure key={i} className="w-[min(300px,62vw)] shrink-0" aria-hidden={i >= STILLS.length}>
              <img src={`/film/${n}.jpg`} alt={i < STILLS.length ? `Launch film still: ${label}` : ''} loading="lazy" className="aspect-video w-full object-cover" />
              <figcaption className="mt-2 font-mono text-[10px] tracking-[0.2em] text-paper/60 uppercase">{label}</figcaption>
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
    n: 'I', api: '<Scene3D>', title: '3D, in the same pass', still: 'm1-85',
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
    n: 'II', api: '<Camera3D type="orthographic">', title: 'Isometric scenes', still: 'm2-40',
    text: 'An orthographic camera turns the same 3D layer into an isometric diorama. The film dives into one of 81 blocks.',
    code: `<Camera3D
  type="orthographic"
  height={10.5 * (1 - dive) + 0.25 * dive}
  position={eye}
  target={look}
/>`,
  },
  {
    n: 'III', api: '<GlslShader>', title: 'WebGL shaders', still: 'm3-40',
    text: 'GLSL ES fragment shaders, translated to the GPU by naga. Uniforms and textures come from props, so they animate like anything else.',
    code: `<GlslShader
  width={W} height={H}
  fragment={MARBLE}
  uniforms={{ u_t: frame / 30, u_red: red }}
/>`,
  },
  {
    n: 'IV', api: '<Canvas>', title: 'Canvas 2D', still: 'm4-40',
    text: 'A recording 2D context: each call becomes a draw command and Vello paints them. 2,000 strokes a frame here.',
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
    n: 'V', api: '<GlslShader textures>', title: 'Glass that bends light', still: 'm5-60',
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
    <section id="engine" className="bg-night py-[clamp(72px,10vw,140px)] text-paper">
      <div className={cn(shell, 'grid grid-cols-[minmax(0,1fr)] gap-12 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.4fr)] lg:gap-16')}>
        <div>
          <Eyebrow className="text-[#8fa0ff]">The engine</Eyebrow>
          <h2 className="mt-4 font-serif text-[clamp(38px,4.6vw,62px)] leading-[1.02] font-normal">
            It all draws on <em className="text-[#aab6ff]">one GPU.</em>
          </h2>
          <p className="mt-5 max-w-[44ch] text-[15px] leading-relaxed text-paper/70">
            HTML and CSS go through Stylo, Firefox's style engine, and taffy and Parley lay them out. SVG goes through
            usvg. It all ends up in one layer tree, and wgpu composites that together with the native elements below.
          </p>
          <ul className="mt-8 divide-y divide-paper/12 border-y border-paper/12">
            {SURFACES.map((x, i) => (
              <li key={x.n}>
                <button
                  type="button"
                  onClick={() => setActive(i)}
                  className={cn('flex w-full items-baseline gap-4 py-3.5 text-left transition-colors', i === active ? 'text-paper' : 'text-paper/55 hover:text-paper/85')}
                >
                  <span className="w-8 font-serif text-sm italic text-[#8fa0ff]">{x.n}.</span>
                  <span className="font-serif text-xl">{x.title}</span>
                  <span className="ml-auto hidden font-mono text-[11px] text-paper/45 sm:inline">{x.api}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div className="grid gap-5">
          <figure>
            <div className="relative overflow-hidden border border-paper/15">
              <img key={s.still} src={`/film/${s.still}.jpg`} alt={`${s.title}, a frame from the launch film`} className="aspect-video w-full object-cover animate-in fade-in duration-500" />
              <span className="absolute top-3 left-3 bg-night/80 px-2 py-1 font-mono text-[10px] tracking-[0.2em] text-paper/80 uppercase">
                {s.n} · frame from the film
              </span>
            </div>
          </figure>
          <p className="max-w-[60ch] text-[15px] leading-relaxed text-paper/75">{s.text}</p>
          <CodeBlock key={s.api} title={s.api} code={s.code} className="border-paper/15 text-[12px]" />
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
        <div className="lg:sticky lg:top-28">
          <Eyebrow>Remotion compatible</Eyebrow>
          <h2 className="mt-4 font-serif text-[clamp(38px,4.6vw,62px)] leading-[1.02] font-normal text-night">
            Your Remotion code. <em className="text-cobalt">Unchanged.</em>
          </h2>
          <p className="mt-5 max-w-[46ch] text-[15px] leading-relaxed text-night/75">
            Imports from <code className="font-mono text-[13px]">remotion</code> and{' '}
            <code className="font-mono text-[13px]">@remotion/*</code> resolve to Kinetograph's own implementation,
            rebuilt from Remotion's documented behaviour. Sequences, springs, interpolation, audio, video and Google
            Fonts work as they do there.
          </p>
          <p className="mt-4 max-w-[46ch] text-[15px] leading-relaxed text-night/75">
            When a project uses something the engine can't draw yet, you hear about it.{' '}
            <code className="font-mono text-[13px]">kinetograph doctor</code> lists what and in which frames, and{' '}
            <code className="font-mono text-[13px]">--strict</code> turns it into an error.
          </p>
          <CommandBar command="npx kinetograph doctor src/index.tsx" className="mt-7 max-w-md border-cobalt/30" />
        </div>
        <CodeBlock title="src/Title.tsx · unchanged" code={REMOTION_CODE} />
      </div>

      <div id="how" className="mt-[clamp(72px,9vw,120px)]">
        <Rule className="mb-10" />
        <div className="mb-10 flex flex-wrap items-end justify-between gap-4">
          <h3 className="font-serif text-[clamp(30px,3.4vw,44px)] leading-tight font-normal text-night">One frame, start to finish</h3>
          <a className="font-mono text-xs tracking-[0.15em] text-cobalt uppercase hover:underline" href={doc('README.md#architecture')} target="_blank" rel="noreferrer">
            Architecture →
          </a>
        </div>
        <ol className="grid gap-px overflow-hidden border border-cobalt/20 bg-cobalt/20 sm:grid-cols-2 lg:grid-cols-3">
          {STEPS.map(([title, text], i) => (
            <li key={title} className="bg-paper p-6 sm:p-7">
              <div className="flex items-baseline gap-3">
                <span className="font-serif text-3xl text-cobalt italic">{['I', 'II', 'III', 'IV', 'V', 'VI'][i]}</span>
                <span className="font-serif text-xl text-night">{title}</span>
              </div>
              <p className="mt-3 text-sm leading-relaxed text-night/70">{text}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

// ---- agents ----

const COMMANDS = [
  ['still', 'One frame to a PNG, to look at what you made.', 'npx kinetograph still index.tsx 120 -o frame.png --json'],
  ['strip', 'A contact sheet of evenly spaced frames, labelled with frame and time.', 'npx kinetograph strip index.tsx -n 12 -o strip.png'],
  ['inspect', 'The scene graph at a frame: layers, bounds and resolved styles.', 'npx kinetograph inspect index.tsx --frame 60 --json'],
  ['lint', 'Text overflowing its box, layers off the canvas, missing fonts and assets.', 'npx kinetograph lint index.tsx --json'],
  ['render', 'Frames to a video with audio.', 'npx kinetograph render index.tsx -o out.mp4'],
  ['mcp', 'The same commands as an MCP server on stdio, one tool each.', 'npx kinetograph mcp'],
] as const;

export function Agents() {
  const [i, setI] = useState(0);
  const c = COMMANDS[i]!;
  return (
    <section id="agents" className="border-y border-cobalt/15 bg-[color-mix(in_oklab,var(--cobalt)_5%,var(--paper))] py-[clamp(72px,10vw,140px)]">
      <div className={cn(shell, 'grid grid-cols-[minmax(0,1fr)] gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] lg:gap-16')}>
        <div>
          <Eyebrow>Built for agents</Eyebrow>
          <h2 className="mt-4 font-serif text-[clamp(38px,4.6vw,62px)] leading-[1.02] font-normal text-night">
            An agent can <em className="text-cobalt">see its own work.</em>
          </h2>
          <p className="mt-5 max-w-[46ch] text-[15px] leading-relaxed text-night/75">
            Every command takes <code className="font-mono text-[13px]">--json</code>, and{' '}
            <code className="font-mono text-[13px]">kinetograph mcp</code> serves them as tools. An agent writes the
            TSX, renders a still, reads the scene graph, lints the layout and fixes what it finds, without opening a
            browser. This film was made that way.
          </p>
        </div>
        <div className="border border-cobalt/25 bg-paper">
          <div className="flex flex-wrap border-b border-cobalt/20">
            {COMMANDS.map(([name], k) => (
              <button
                key={name}
                type="button"
                onClick={() => setI(k)}
                className={cn(
                  'px-4 py-3 font-mono text-xs transition-colors',
                  k === i ? 'bg-cobalt text-paper' : 'text-night/70 hover:bg-cobalt/8 hover:text-cobalt',
                )}
              >
                {name}
              </button>
            ))}
          </div>
          <div className="p-6 sm:p-8">
            <p className="font-serif text-2xl leading-snug text-night">{c[1]}</p>
            <CommandBar command={c[2]} className="mt-6 border-cobalt/30" />
            <p className="mt-6 font-mono text-[11px] leading-relaxed text-night/55">
              Also: compositions · onion · check · bench · audio analyze · snapshot · effects · studio
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

// ---- get started ----

export function Start() {
  return (
    <section id="start" className="bg-cobalt py-[clamp(72px,10vw,120px)] text-paper">
      <div className={cn(shell, 'grid grid-cols-[minmax(0,1fr)] gap-10 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] lg:gap-16')}>
        <div>
          <Eyebrow className="text-paper/70">Get started</Eyebrow>
          <h2 className="mt-4 font-serif text-[clamp(38px,4.6vw,62px)] leading-[1.02] font-normal">
            Three commands to a film.
          </h2>
          <p className="mt-5 max-w-[40ch] text-[15px] leading-relaxed text-paper/75">
            Node 22 or later and a GPU that wgpu supports (Metal on macOS). No display needed, so it runs on a server
            as well. Rendering video needs FFmpeg.
          </p>
        </div>
        <ol className="space-y-5">
          {[
            ['Build it', 'git clone https://github.com/0xS4N4TG/kinetograph && cd kinetograph && npm ci && npm run build'],
            ['Open the studio', 'npx kinetograph studio examples/launch/index.tsx'],
            ['Render', 'npx kinetograph render examples/launch/index.tsx -o out/launch.mp4'],
          ].map(([t, cmd], i) => (
            <li key={t} className="grid grid-cols-[2.5rem_minmax(0,1fr)] items-start gap-3">
              <span className="pt-1 font-serif text-3xl text-paper/60 italic">{i + 1}</span>
              <div>
                <div className="mb-2 font-serif text-xl">{t}</div>
                <CommandBar command={cmd} tone="ink" />
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

// ---- questions ----

const FAQ: [string, ReactNode][] = [
  ['Is there really no browser?', 'None in the render path, canvas and WebGL included. Node runs your code and a Rust addon draws it. Chrome for Testing appears only in our tests, as the reference we compare frames against.'],
  ['Will my Remotion project render?', 'Most should, without edits: remotion and @remotion/* imports resolve to Kinetograph. The papercut project renders all 988 of its frames natively. What the engine cannot draw yet is reported with a warning, and kinetograph doctor lists it by frame. Known gaps are tracked in docs/OPEN_ISSUES.md.'],
  ['Is a render repeatable?', 'Yes. Date, Math.random, timers and requestAnimationFrame follow the frame number, so the same project and frame give the same pixels. Nothing reads the wall clock.'],
  ['What does it run on?', 'Node 22 or later and a GPU wgpu supports: Metal on macOS, Vulkan or DX12 elsewhere. It needs no window or display. The render command links FFmpeg, using VideoToolbox on macOS.'],
  ['How is it licensed?', 'PolyForm Small Business 1.0.0: free for individuals and for companies with fewer than 100 people and under a million dollars of revenue a year. Larger companies need a commercial licence.'],
  ['Can an agent drive it?', 'It was built for that. Every command takes --json and kinetograph mcp serves them as MCP tools. lint and inspect let an agent check a layout without looking at pixels.'],
];

export function Questions() {
  return (
    <section id="faq" className={cn(shell, 'grid grid-cols-[minmax(0,1fr)] gap-10 py-[clamp(72px,10vw,140px)] lg:grid-cols-[minmax(0,0.7fr)_minmax(0,1.3fr)] lg:gap-16')}>
      <div>
        <Eyebrow>Questions</Eyebrow>
        <h2 className="mt-4 font-serif text-[clamp(38px,4.6vw,62px)] leading-[1.02] font-normal text-night">
          Things people <em className="text-cobalt">ask.</em>
        </h2>
      </div>
      <Accordion className="border-t border-cobalt/20">
        {FAQ.map(([q, a]) => (
          <AccordionItem key={q} value={q} className="border-b border-cobalt/20">
            <AccordionTrigger className="py-5 font-serif text-xl font-normal text-night hover:text-cobalt hover:no-underline">{q}</AccordionTrigger>
            <AccordionContent className="pb-5 text-[15px] leading-relaxed text-night/75">{a}</AccordionContent>
          </AccordionItem>
        ))}
      </Accordion>
    </section>
  );
}
