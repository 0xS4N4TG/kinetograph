import { CodeBlock, CommandBar } from '@/components/code';
import { Reveal } from '@/components/reveal';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { cn } from '@/lib/utils';
import { doc } from '@/sections/links';
import { body, H2, shell } from '@/sections/shared';
import type { ReactNode } from 'react';

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
  ['Composite', 'wgpu draws the layer tree: Skia for vectors and text, WGSL for effects, naga for GLSL, scene3d for meshes.'],
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


// ---- get started ----

export function Start() {
  return (
    <section id="start" className={cn(shell, 'grid grid-cols-[minmax(0,1fr)] gap-10 py-[clamp(72px,10vw,140px)] lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] lg:gap-16')}>
      <Reveal>
        <H2 className="text-night">Three commands to a film</H2>
        <p className={cn(body, 'mt-5 max-w-[42ch] text-night/75')}>
          Point it at the entry file of any Remotion project, or start one from scratch. You need Node 22 or later and a
          GPU that wgpu supports, such as Metal on a Mac. It needs no display, so it runs on a server too. Rendering video
          needs FFmpeg.
        </p>
      </Reveal>
      <ol className="space-y-6">
        {[
          ['Install it', 'npm install kinetograph'],
          ['Open the studio', 'npx kinetograph studio src/index.tsx'],
          ['Render', 'npx kinetograph render src/index.tsx -o out.mp4'],
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
  ['Will my Remotion project render?', <>Most should, without edits: remotion and @remotion/* imports resolve to Kinetograph. The papercut project renders all 988 of its frames natively. What the engine cannot draw yet is reported with a warning, and kinetograph doctor lists it by frame. Known gaps are in the <a className="underline decoration-cobalt/40 underline-offset-2 hover:text-cobalt" href="/docs/known-issues/">known issues</a>.</>],
  ['Is a render repeatable?', 'Yes. Date, Math.random, timers and requestAnimationFrame follow the frame number, so the same project and frame give the same pixels. Nothing reads the wall clock.'],
  ['What does it run on?', 'Node 22 or later and a GPU wgpu supports: Metal on macOS, Vulkan or DX12 elsewhere. It needs no window or display. The render command links FFmpeg, using VideoToolbox on macOS.'],
  ['How is it licensed?', 'PolyForm Small Business 1.0.0. It is free for individuals and for companies with fewer than 100 people and under a million dollars of revenue a year. Larger companies need a commercial licence.'],
  ['What if it can’t draw something I use?', 'Run kinetograph doctor first: it lists what the engine cannot draw and in which frames, before you spend a render on it. Unsupported content warns, and --strict turns the warning into an error, so nothing is silently dropped.'],
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

