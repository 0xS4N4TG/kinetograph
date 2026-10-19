import {
  ArrowRightIcon,
  AudioLinesIcon,
  BoxIcon,
  CpuIcon,
  FilmIcon,
  GaugeIcon,
  GlobeOffIcon,
  LayersIcon,
  PlayIcon,
  PuzzleIcon,
  SparklesIcon,
  TerminalIcon,
  type LucideIcon,
} from 'lucide-react';

import { Button } from '@/components/button';
import { GridBackground, Marquee, ShimmerText, SpotlightCard } from '@/components/effects';

const GITHUB = 'https://github.com/';

const features: { icon: LucideIcon; title: string; body: string; span?: string }[] = [
  {
    icon: GlobeOffIcon,
    title: 'No browser in the loop',
    body: 'Node runs your code; a Rust compositor draws every frame. No headless Chrome to launch, screenshot or babysit.',
    span: 'md:col-span-2',
  },
  {
    icon: PuzzleIcon,
    title: 'Remotion compatible',
    body: 'remotion and @remotion/* imports resolve to Kinetograph’s own implementation. Existing projects render as they are.',
  },
  {
    icon: CpuIcon,
    title: 'GPU compositor',
    body: 'wgpu and Vello for vectors, text and Canvas 2D. WGSL effects, GLSL via naga, Lottie, motion blur and a layer cache.',
  },
  {
    icon: BoxIcon,
    title: 'Real 3D layer',
    body: 'glTF and PBR scenes with a 2.5D camera, composited in the same pass as your 2D layers.',
  },
  {
    icon: LayersIcon,
    title: 'A DOM engine, natively',
    body: 'CSS through Stylo, layout through taffy, text through Parley, SVG through usvg. HTML and SVG, painted without a browser.',
    span: 'md:col-span-2',
  },
  {
    icon: AudioLinesIcon,
    title: 'Web Audio, offline',
    body: 'Sound is mixed with an OfflineAudioContext and encoded alongside the frames.',
  },
  {
    icon: FilmIcon,
    title: 'Deterministic frames',
    body: 'Date, Math.random, timers and rAF follow the frame number. A frame is a pure function of project and frame.',
  },
  {
    icon: TerminalIcon,
    title: 'Studio, CLI and MCP',
    body: 'A live browser studio, a command line, and an MCP server so agents can write and render video.',
  },
];

const steps = [
  { n: '01', title: 'Bundle', body: 'esbuild bundles your TSX and rewrites remotion imports to @kinetograph/core.' },
  { n: '02', title: 'Run the frame', body: 'A determinism shim pins the clock; a React reconciler renders the tree for that frame.' },
  { n: '03', title: 'Emit a scene', body: 'Native elements become scene layers; runs of HTML and SVG become DOM islands.' },
  { n: '04', title: 'Composite', body: 'The Rust addon draws on the GPU and hands frames to FFmpeg for MP4, MOV or PNG.' },
];

const code = `import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion';

export function Title() {
  const frame = useCurrentFrame();
  const y = interpolate(frame, [0, 30], [40, 0], { extrapolateRight: 'clamp' });
  const opacity = interpolate(frame, [0, 20], [0, 1]);

  return (
    <AbsoluteFill style={{ background: '#0a0a0a', justifyContent: 'center', alignItems: 'center' }}>
      <h1 style={{ color: 'white', fontSize: 120, opacity, transform: \`translateY(\${y}px)\` }}>
        Hello, Kinetograph
      </h1>
    </AbsoluteFill>
  );
}`;

const tech = [
  'Rust', 'wgpu', 'Vello', 'Stylo', 'taffy', 'Parley', 'usvg', 'naga', 'ThorVG', 'FFmpeg',
  'napi-rs', 'React 19', 'esbuild', 'WebGL', 'Canvas 2D', 'Web Audio', 'glTF', 'WGSL',
];

export function App() {
  return (
    <div className="relative min-h-screen overflow-x-hidden">
      <Nav />
      <Hero />
      <section className="border-y bg-card/20 py-6">
        <Marquee items={tech} />
      </section>
      <Benchmark />
      <Features />
      <HowItWorks />
      <CodeSection />
      <Cta />
      <Footer />
    </div>
  );
}

function Nav() {
  return (
    <header className="bg-background/70 sticky top-0 z-50 border-b backdrop-blur-xl">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-6">
        <a href="#" className="flex items-center gap-2 font-semibold tracking-tight">
          <span className="grid size-6 place-items-center rounded-md bg-white text-black">
            <PlayIcon className="size-3 fill-current" />
          </span>
          Kinetograph
        </a>
        <nav className="text-muted-foreground ml-6 hidden items-center gap-6 text-sm md:flex">
          <a className="hover:text-foreground transition-colors" href="#features">Features</a>
          <a className="hover:text-foreground transition-colors" href="#how">How it works</a>
          <a className="hover:text-foreground transition-colors" href="#code">Code</a>
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="ghost" size="sm" href={GITHUB}>GitHub</Button>
          <Button size="sm" href="#start">Get started</Button>
        </div>
      </div>
    </header>
  );
}

function Hero() {
  return (
    <section className="relative px-6 pt-24 pb-28 text-center">
      <GridBackground />
      <div aria-hidden className="pointer-events-none absolute top-0 left-1/2 h-[420px] w-[720px] -translate-x-1/2 rounded-full bg-white/[0.07] blur-[120px]" />
      <div className="relative mx-auto max-w-4xl">
        <a href="#benchmark" className="bg-card/60 text-muted-foreground hover:text-foreground mx-auto mb-8 inline-flex items-center gap-2 rounded-full border px-4 py-1.5 text-xs transition-colors">
          <SparklesIcon className="size-3.5" />
          7× faster than Remotion on our reference scene
          <ArrowRightIcon className="size-3.5" />
        </a>
        <h1 className="text-5xl leading-[1.05] font-semibold tracking-tight text-balance md:text-7xl">
          Programmatic video,
          <br />
          <ShimmerText>without the browser.</ShimmerText>
        </h1>
        <p className="text-muted-foreground mx-auto mt-6 max-w-2xl text-lg text-balance">
          Write video in TypeScript with Remotion’s API, CSS, SVG, Canvas and shaders. Node runs the code and a Rust GPU
          compositor draws every frame.
        </p>
        <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
          <Button size="lg" href="#start">
            Get started <ArrowRightIcon />
          </Button>
          <Button size="lg" variant="outline" href="#code">
            See the code
          </Button>
        </div>
        <Terminal />
      </div>
    </section>
  );
}

function Terminal() {
  return (
    <div className="bg-card/70 mx-auto mt-16 max-w-2xl overflow-hidden rounded-xl border text-left shadow-2xl shadow-black/60">
      <div className="flex items-center gap-1.5 border-b px-4 py-3">
        <span className="size-2.5 rounded-full bg-white/15" />
        <span className="size-2.5 rounded-full bg-white/15" />
        <span className="size-2.5 rounded-full bg-white/15" />
        <span className="text-muted-foreground ml-3 font-mono text-xs">~/my-video</span>
      </div>
      <div className="space-y-1.5 p-5 font-mono text-sm">
        <p><span className="text-muted-foreground">$</span> npx kinetograph studio src/index.tsx</p>
        <p className="text-muted-foreground">build 1 ready</p>
        <p>
          kinetograph studio: <span className="underline underline-offset-4">http://127.0.0.1:3000/</span>
          <span className="animate-blink ml-1 inline-block h-4 w-2 translate-y-0.5 bg-white" />
        </p>
      </div>
    </div>
  );
}

function Benchmark() {
  return (
    <section id="benchmark" className="mx-auto max-w-6xl px-6 py-24">
      <div className="mx-auto max-w-2xl text-center">
        <SectionTag>Benchmark</SectionTag>
        <h2 className="mt-4 text-3xl font-semibold tracking-tight md:text-5xl">7.0× faster, same scene.</h2>
        <p className="text-muted-foreground mt-4 text-balance">
          A reference scene rendered by both engines, median of runs, on an Apple M4.
        </p>
      </div>
      <SpotlightCard className="mx-auto mt-12 max-w-3xl p-8">
        <Bar label="Kinetograph" value="1.28 s" width="14.3%" strong />
        <div className="h-5" />
        <Bar label="Remotion" value="8.96 s" width="100%" />
      </SpotlightCard>
      <div className="mx-auto mt-6 grid max-w-3xl grid-cols-3 gap-4 text-center">
        {[
          ['988', 'frames of the papercut project rendered natively'],
          ['0', 'browsers launched'],
          ['4', 'output paths: MP4, MOV, PNG, live preview'],
        ].map(([big, small]) => (
          <div key={small} className="bg-card/40 rounded-2xl border p-5">
            <div className="text-3xl font-semibold tabular-nums">{big}</div>
            <div className="text-muted-foreground mt-1 text-xs">{small}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

function Bar({ label, value, width, strong }: { label: string; value: string; width: string; strong?: boolean }) {
  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between text-sm">
        <span className={strong ? 'font-medium' : 'text-muted-foreground'}>{label}</span>
        <span className="font-mono tabular-nums">{value}</span>
      </div>
      <div className="bg-secondary h-3 overflow-hidden rounded-full">
        <div
          className={strong ? 'h-full rounded-full bg-gradient-to-r from-white/70 to-white' : 'h-full rounded-full bg-white/20'}
          style={{ width }}
        />
      </div>
    </div>
  );
}

function SectionTag({ children }: { children: string }) {
  return (
    <span className="text-muted-foreground bg-card/60 inline-block rounded-full border px-3 py-1 text-[11px] font-medium tracking-widest uppercase">
      {children}
    </span>
  );
}

function Features() {
  return (
    <section id="features" className="mx-auto max-w-6xl px-6 py-24">
      <div className="mx-auto max-w-2xl text-center">
        <SectionTag>Features</SectionTag>
        <h2 className="mt-4 text-3xl font-semibold tracking-tight md:text-5xl">Everything a video engine needs.</h2>
        <p className="text-muted-foreground mt-4 text-balance">
          Authoring in the tools you already know, rendering in a stack built for speed.
        </p>
      </div>
      <div className="mt-14 grid gap-4 md:grid-cols-3">
        {features.map(({ icon: Icon, title, body, span }) => (
          <SpotlightCard key={title} className={span}>
            <div className="bg-secondary mb-4 grid size-10 place-items-center rounded-lg border">
              <Icon className="size-5" />
            </div>
            <h3 className="font-semibold tracking-tight">{title}</h3>
            <p className="text-muted-foreground mt-2 text-sm leading-relaxed">{body}</p>
          </SpotlightCard>
        ))}
      </div>
    </section>
  );
}

function HowItWorks() {
  return (
    <section id="how" className="border-y bg-card/20 py-24">
      <div className="mx-auto max-w-6xl px-6">
        <div className="mx-auto max-w-2xl text-center">
          <SectionTag>How it works</SectionTag>
          <h2 className="mt-4 text-3xl font-semibold tracking-tight md:text-5xl">One frame, start to finish.</h2>
        </div>
        <div className="relative mt-14 grid gap-4 md:grid-cols-4">
          <div aria-hidden className="absolute top-8 right-[12%] left-[12%] hidden h-px bg-gradient-to-r from-transparent via-white/20 to-transparent md:block" />
          {steps.map((s) => (
            <div key={s.n} className="relative text-center">
              <div className="bg-background relative mx-auto grid size-16 place-items-center rounded-full border font-mono text-sm">
                {s.n}
              </div>
              <h3 className="mt-5 font-semibold tracking-tight">{s.title}</h3>
              <p className="text-muted-foreground mx-auto mt-2 max-w-[16rem] text-sm leading-relaxed">{s.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function CodeSection() {
  return (
    <section id="code" className="mx-auto grid max-w-6xl items-center gap-12 px-6 py-24 md:grid-cols-2">
      <div>
        <SectionTag>Authoring</SectionTag>
        <h2 className="mt-4 text-3xl font-semibold tracking-tight md:text-5xl">Write the video you already know.</h2>
        <p className="text-muted-foreground mt-4 leading-relaxed">
          It’s the Remotion API: hooks, interpolation, sequences. Bring a project as it is, or start fresh and reach for
          native elements, shaders and 3D when you want them.
        </p>
        <ul className="mt-6 space-y-3 text-sm">
          {['Remotion imports resolve automatically', 'Google Fonts fetched once and cached', 'Hot rebuilds in the studio'].map((t) => (
            <li key={t} className="flex items-center gap-3">
              <GaugeIcon className="text-muted-foreground size-4" />
              {t}
            </li>
          ))}
        </ul>
      </div>
      <div className="bg-card/70 overflow-hidden rounded-xl border shadow-2xl shadow-black/60">
        <div className="flex items-center gap-1.5 border-b px-4 py-3">
          <span className="size-2.5 rounded-full bg-white/15" />
          <span className="size-2.5 rounded-full bg-white/15" />
          <span className="size-2.5 rounded-full bg-white/15" />
          <span className="text-muted-foreground ml-3 font-mono text-xs">Title.tsx</span>
        </div>
        <pre className="overflow-x-auto p-5 font-mono text-[13px] leading-relaxed">
          <code>{code}</code>
        </pre>
      </div>
    </section>
  );
}

function Cta() {
  return (
    <section id="start" className="px-6 py-24">
      <div className="bg-card/60 relative mx-auto max-w-4xl overflow-hidden rounded-3xl border px-8 py-16 text-center">
        <GridBackground />
        <div className="relative">
          <h2 className="text-3xl font-semibold tracking-tight md:text-5xl">Render your first frame.</h2>
          <p className="text-muted-foreground mx-auto mt-4 max-w-xl text-balance">
            Point the studio at any entry file and watch it render live.
          </p>
          <div className="bg-background mx-auto mt-8 flex max-w-md items-center justify-center rounded-full border px-5 py-3 font-mono text-sm">
            npx kinetograph studio src/index.tsx
          </div>
          <div className="mt-8 flex justify-center gap-3">
            <Button size="lg" href={GITHUB}>
              View on GitHub <ArrowRightIcon />
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="border-t">
      <div className="text-muted-foreground mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-6 py-8 text-sm">
        <span className="text-foreground font-semibold tracking-tight">Kinetograph</span>
        <span>A programmatic video engine with no browser in it.</span>
        <span>PolyForm Small Business 1.0.0</span>
      </div>
    </footer>
  );
}
