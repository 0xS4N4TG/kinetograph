import { useState } from 'react';
import {
  ArrowRightIcon,
  BoxIcon,
  CheckIcon,
  ChevronRightIcon,
  CpuIcon,
  FileCodeIcon,
  FilmIcon,
  LayersIcon,
  PlayIcon,
  TerminalIcon,
  ZapIcon
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardDescription, CardPanel } from '@/components/ui/card';
import { Tabs, TabsList, TabsTab, TabsPanel } from '@/components/ui/tabs';
import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from '@/components/ui/accordion';
import { Separator } from '@/components/ui/separator';
import { CodeBlock, CommandBar } from '@/components/code';
import { SiteNav } from '@/components/chrome';
import { KinetographHero, KinetographLandscape } from '@/components/illustrations';
import HalftoneWordmarkFooter from '@/components/halftone-footer';

const DOC_PAGES: Record<string, { title: string; desc: string; content: React.ReactNode }> = {
  intro: {
    title: 'Introduction to Kinetograph',
    desc: 'The headless, programmatic video renderer powered by Rust and modern web standards.',
    content: (
      <div className="space-y-6 text-sm leading-relaxed text-foreground/80">
        <p>
          Kinetograph is a programmatic video engine with <strong>no browser in it</strong>.
          You (or an AI agent) author videos in TypeScript with Remotion's API, CSS, SVG, Canvas 2D,
          WebGL fragment shaders, and Web Audio.
        </p>
        <p>
          Node executes the code while an in-process Rust GPU compositor (via N-API and <code>wgpu</code>)
          renders every frame. Existing Remotion projects render as they are—<code>remotion</code> and{' '}
          <code>@remotion/*</code> imports resolve directly to Kinetograph's drop-in implementation.
        </p>
        <Card className="bg-card/40 border-cobalt/20">
          <CardHeader>
            <CardTitle className="text-cobalt flex items-center gap-2">
              <ZapIcon className="size-4" /> 7.0× Faster Rendering
            </CardTitle>
            <CardDescription>
              On an Apple M4, reference Remotion scenes render in 1.28s compared to 8.96s in Chromium.
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    ),
  },
  quickstart: {
    title: 'Quickstart Guide',
    desc: 'Render your first video in under two minutes.',
    content: (
      <div className="space-y-6 text-sm leading-relaxed text-foreground/80">
        <p>1. Start the live studio on any entry file:</p>
        <CommandBar command="npx kinetograph studio src/index.tsx" tone="paper" />
        <p>2. Render an MP4 directly to disk from the CLI:</p>
        <CommandBar command="npx kinetograph render src/index.tsx out.mp4 --fps 30" tone="paper" />
        <p>3. Use with MCP servers in coding assistants (Hermes, Claude, Cursor):</p>
        <CodeBlock
          title="mcp-config.json"
          code={`{
  "mcpServers": {
    "kinetograph": {
      "command": "npx",
      "args": ["-y", "@kinetograph/mcp"]
    }
  }
}`}
        />
      </div>
    ),
  },
  architecture: {
    title: 'Engine Architecture',
    desc: 'How frames flow from TypeScript down to wgpu and FFmpeg.',
    content: (
      <div className="space-y-6 text-sm leading-relaxed text-foreground/80">
        <ol className="list-decimal pl-5 space-y-3 font-sans">
          <li><strong>Bundle:</strong> esbuild bundles your project and swaps <code>remotion</code> imports for native bindings.</li>
          <li><strong>Clock Shim:</strong> <code>Date</code>, <code>Math.random</code>, timers, and <code>rAF</code> are deterministically pinned to the frame number.</li>
          <li><strong>React Reconciler:</strong> Custom reconciler executes the component tree once per frame.</li>
          <li><strong>Native DOM Engine:</strong> Stylo for CSS, Taffy for flexbox/grid layout, Parley for text shaping, usvg for SVG paths.</li>
          <li><strong>GPU Compositor:</strong> wgpu + Vello vectors + WGSL/GLSL shaders + FFmpeg encoding.</li>
        </ol>
      </div>
    ),
  },
  studio: {
    title: 'Studio & Preview UI',
    desc: 'Realtime interactive timeline, scene inspection, and prop tweak controls.',
    content: (
      <div className="space-y-4 text-sm leading-relaxed text-foreground/80">
        <p>
          The Studio UI is served locally on <code>http://127.0.0.1:3000</code>. It provides:
        </p>
        <ul className="list-disc pl-5 space-y-1.5">
          <li>Interactive timeline ruler with scrubbing and playhead scrubbing</li>
          <li>Hierarchical Scene Graph inspection</li>
          <li>Live props inspector with interactive controls and instant canvas reload</li>
          <li>Background render queue management</li>
        </ul>
      </div>
    ),
  },
};

export function App() {
  const [activeDoc, setActiveDoc] = useState('intro');

  return (
    <div className="min-h-screen bg-paper text-foreground font-sans selection:bg-cobalt/20 selection:text-cobalt">
      <SiteNav />

      {/* Hero Section */}
      <section className="relative px-4 sm:px-6 pt-6 pb-20 overflow-hidden">
        <div className="mx-auto max-w-[1320px]">
          {/* Framed Canvas Illustration Card */}
          <div className="relative rounded-2xl border-2 border-cobalt bg-cobalt overflow-hidden shadow-2xl">
            {/* The animated Kinetograph procedural canvas */}
            <KinetographHero className="w-full h-[520px] sm:h-[620px] block" />

            {/* Overlaid arch content container styled like Cobalt Toile */}
            <div className="absolute inset-0 pointer-events-none flex items-center justify-center p-4">
              <div className="pointer-events-auto bg-paper/95 backdrop-blur-md border border-cobalt/30 rounded-t-full rounded-b-2xl p-8 sm:p-12 max-w-xl text-center shadow-2xl mx-auto flex flex-col items-center">
                <Badge variant="outline" className="text-cobalt border-cobalt/40 bg-cobalt/5 mb-4 text-[11px] font-mono uppercase tracking-widest px-3 py-1">
                  Est. 1891 · Reimagined for Rust & GPU
                </Badge>
                
                <h1 className="font-serif text-3xl sm:text-5xl text-cobalt tracking-tight font-normal leading-[1.1] mb-4 text-balance">
                  Programmatic Video <br /><em className="italic font-serif">Without the Browser</em>
                </h1>
                
                <p className="text-foreground/80 text-sm sm:text-base leading-relaxed mb-6 max-w-md">
                  Write video in TypeScript with Remotion's API, SVG, Canvas 2D, and shaders. 
                  Node executes your code; an in-process Rust GPU compositor draws every frame.
                </p>

                <div className="w-full mb-6">
                  <CommandBar command="npx kinetograph studio src/index.tsx" tone="paper" className="border-cobalt/30 shadow-sm" />
                </div>

                <div className="flex flex-wrap items-center justify-center gap-3">
                  <Button render={<a href="#docs" />} className="bg-cobalt text-paper hover:bg-cobalt/90 shadow-md">
                    Explore Documentation <ArrowRightIcon className="size-4" />
                  </Button>
                  <Button variant="outline" render={<a href="#features" />} className="border-cobalt/30 hover:bg-cobalt/5 text-cobalt">
                    Engine Features
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Marquee Ticker */}
      <section className="border-y border-cobalt/15 bg-cobalt/5 py-3 overflow-hidden">
        <div className="flex shrink-0 animate-marquee gap-8 items-center text-cobalt font-mono text-xs uppercase tracking-widest">
          <span>Rust GPU Compositor</span>
          <span>•</span>
          <span>Zero Headless Chrome</span>
          <span>•</span>
          <span>Remotion API Drop-In</span>
          <span>•</span>
          <span>Stylo CSS + Taffy Layout</span>
          <span>•</span>
          <span>Vello Vector Paths</span>
          <span>•</span>
          <span>WGSL & GLSL Naga Shaders</span>
          <span>•</span>
          <span>Offline Web Audio Context</span>
          <span>•</span>
          <span>Deterministic Frame Clock</span>
          <span>•</span>
          <span>MCP Server Ready</span>
          <span>•</span>
        </div>
      </section>

      {/* Benchmark Section */}
      <section id="benchmark" className="mx-auto max-w-[1320px] px-[clamp(16px,4vw,44px)] py-20">
        <div className="text-center max-w-2xl mx-auto mb-12">
          <Badge variant="outline" className="border-cobalt/30 text-cobalt bg-cobalt/5 uppercase tracking-widest text-[11px] mb-3">
            Benchmark Metrics
          </Badge>
          <h2 className="font-serif text-3xl sm:text-5xl text-foreground font-normal">
            7.0× Faster than Remotion
          </h2>
          <p className="text-muted-foreground mt-3 text-sm sm:text-base">
            Median wall-clock render times on an Apple M4 rendering standard test suites.
          </p>
        </div>

        <div className="grid md:grid-cols-2 gap-6 max-w-4xl mx-auto">
          <Card className="border-cobalt/30 bg-card p-6 rounded-xl shadow-sm border-2">
            <CardHeader className="p-0 mb-4">
              <div className="flex justify-between items-baseline">
                <span className="font-serif text-lg text-cobalt font-medium">Kinetograph (Rust Engine)</span>
                <span className="font-mono text-2xl font-bold text-cobalt">1.28 s</span>
              </div>
              <CardDescription className="text-xs">Native compositor + in-process Vello vectors</CardDescription>
            </CardHeader>
            <div className="w-full bg-cobalt/10 h-3 rounded-full overflow-hidden">
              <div className="bg-cobalt h-full rounded-full transition-all duration-1000" style={{ width: '14.3%' }} />
            </div>
          </Card>

          <Card className="border-border bg-card/50 p-6 rounded-xl shadow-sm">
            <CardHeader className="p-0 mb-4">
              <div className="flex justify-between items-baseline">
                <span className="font-serif text-lg text-foreground font-medium">Remotion (Puppeteer)</span>
                <span className="font-mono text-2xl font-bold text-muted-foreground">8.96 s</span>
              </div>
              <CardDescription className="text-xs">Chromium launch + IPC screenshot buffer transfer</CardDescription>
            </CardHeader>
            <div className="w-full bg-muted h-3 rounded-full overflow-hidden">
              <div className="bg-muted-foreground/40 h-full rounded-full" style={{ width: '100%' }} />
            </div>
          </Card>
        </div>
      </section>

      {/* Engine Features Bento */}
      <section id="features" className="bg-cobalt/[0.03] border-y border-cobalt/15 py-24">
        <div className="mx-auto max-w-[1320px] px-[clamp(16px,4vw,44px)]">
          <div className="text-center max-w-2xl mx-auto mb-16">
            <span className="text-cobalt font-mono text-xs uppercase tracking-widest">Core Innovations</span>
            <h2 className="font-serif text-3xl sm:text-5xl text-foreground font-normal mt-2">
              Engineered from the Silicon Up
            </h2>
          </div>

          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6">
            <Card className="border-cobalt/20 bg-paper hover:border-cobalt/50 transition-all shadow-sm">
              <CardHeader>
                <div className="size-10 rounded-lg bg-cobalt/10 text-cobalt flex items-center justify-center mb-3">
                  <CpuIcon className="size-5" />
                </div>
                <CardTitle className="font-serif text-xl text-cobalt font-medium">No Browser Overhead</CardTitle>
                <CardDescription className="text-foreground/70 text-xs sm:text-sm">
                  Node runs user TSX; Rust handles GPU rasterization. Zero Chrome sandboxes, zero WebSocket screenshot pipes.
                </CardDescription>
              </CardHeader>
            </Card>

            <Card className="border-cobalt/20 bg-paper hover:border-cobalt/50 transition-all shadow-sm">
              <CardHeader>
                <div className="size-10 rounded-lg bg-cobalt/10 text-cobalt flex items-center justify-center mb-3">
                  <FileCodeIcon className="size-5" />
                </div>
                <CardTitle className="font-serif text-xl text-cobalt font-medium">Remotion Drop-in</CardTitle>
                <CardDescription className="text-foreground/70 text-xs sm:text-sm">
                  Existing Remotion projects render unmodified. Hooks, Sequences, Springs, and Interpolation are natively shimmed.
                </CardDescription>
              </CardHeader>
            </Card>

            <Card className="border-cobalt/20 bg-paper hover:border-cobalt/50 transition-all shadow-sm">
              <CardHeader>
                <div className="size-10 rounded-lg bg-cobalt/10 text-cobalt flex items-center justify-center mb-3">
                  <LayersIcon className="size-5" />
                </div>
                <CardTitle className="font-serif text-xl text-cobalt font-medium">Native DOM Rendering</CardTitle>
                <CardDescription className="text-foreground/70 text-xs sm:text-sm">
                  Built on Mozilla's Stylo (CSS), Taffy (Flexbox/Grid), Parley (text shaping), and usvg for sub-pixel vector layout.
                </CardDescription>
              </CardHeader>
            </Card>

            <Card className="border-cobalt/20 bg-paper hover:border-cobalt/50 transition-all shadow-sm">
              <CardHeader>
                <div className="size-10 rounded-lg bg-cobalt/10 text-cobalt flex items-center justify-center mb-3">
                  <BoxIcon className="size-5" />
                </div>
                <CardTitle className="font-serif text-xl text-cobalt font-medium">Native 3D & Shaders</CardTitle>
                <CardDescription className="text-foreground/70 text-xs sm:text-sm">
                  Full glTF and PBR 3D scenes composited with 2.5D cameras in the exact same render pass as HTML elements.
                </CardDescription>
              </CardHeader>
            </Card>

            <Card className="border-cobalt/20 bg-paper hover:border-cobalt/50 transition-all shadow-sm">
              <CardHeader>
                <div className="size-10 rounded-lg bg-cobalt/10 text-cobalt flex items-center justify-center mb-3">
                  <FilmIcon className="size-5" />
                </div>
                <CardTitle className="font-serif text-xl text-cobalt font-medium">Deterministic Time</CardTitle>
                <CardDescription className="text-foreground/70 text-xs sm:text-sm">
                  Date, Math.random, timers, and rAF lock step with frame indices. Rerenders are byte-for-byte identical.
                </CardDescription>
              </CardHeader>
            </Card>

            <Card className="border-cobalt/20 bg-paper hover:border-cobalt/50 transition-all shadow-sm">
              <CardHeader>
                <div className="size-10 rounded-lg bg-cobalt/10 text-cobalt flex items-center justify-center mb-3">
                  <TerminalIcon className="size-5" />
                </div>
                <CardTitle className="font-serif text-xl text-cobalt font-medium">AI Agent Native (MCP)</CardTitle>
                <CardDescription className="text-foreground/70 text-xs sm:text-sm">
                  Built-in MCP server allows Claude, Cursor, and Hermes agents to construct, preview, and export videos autonomously.
                </CardDescription>
              </CardHeader>
            </Card>
          </div>
        </div>
      </section>

      {/* Coss UI Documentation Hub Section */}
      <section id="docs" className="mx-auto max-w-[1320px] px-[clamp(16px,4vw,44px)] py-24">
        <div className="flex flex-col md:flex-row gap-12">
          {/* Docs Sidebar */}
          <div className="w-full md:w-64 shrink-0">
            <div className="sticky top-24 space-y-4">
              <div className="font-serif text-xl text-cobalt font-medium flex items-center gap-2">
                Documentation
              </div>
              <p className="text-xs text-muted-foreground">
                Engine specifications, API contracts, and guides.
              </p>
              <Separator className="my-2" />
              <nav className="flex flex-col space-y-1">
                {[
                  { id: 'intro', label: '1. Introduction' },
                  { id: 'quickstart', label: '2. Quickstart' },
                  { id: 'architecture', label: '3. Architecture' },
                  { id: 'studio', label: '4. Studio UI' },
                ].map((item) => (
                  <button
                    key={item.id}
                    onClick={() => setActiveDoc(item.id)}
                    className={`flex items-center justify-between px-3 py-2 text-sm rounded-lg text-left transition-colors ${
                      activeDoc === item.id
                        ? 'bg-cobalt text-paper font-medium'
                        : 'text-foreground/80 hover:bg-cobalt/10 hover:text-cobalt'
                    }`}
                  >
                    <span>{item.label}</span>
                    <ChevronRightIcon className="size-3.5 opacity-60" />
                  </button>
                ))}
              </nav>

              <div className="pt-6">
                <Card className="bg-cobalt/5 border-cobalt/20 p-4 rounded-lg">
                  <div className="text-xs font-semibold text-cobalt uppercase tracking-wider mb-1">LLMs Context</div>
                  <p className="text-xs text-foreground/70 mb-3">
                    Machine-readable documentation for AI assistants.
                  </p>
                  <Button size="xs" variant="outline" className="w-full border-cobalt/30 text-cobalt" render={<a href="/llms.txt" />}>
                    View llms.txt
                  </Button>
                </Card>
              </div>
            </div>
          </div>

          {/* Docs Content Area */}
          <div className="flex-1 min-w-0">
            <div className="bg-card border border-border rounded-xl p-8 shadow-sm">
              <Badge variant="outline" className="border-cobalt/30 text-cobalt bg-cobalt/5 mb-3 text-[10px] uppercase font-mono">
                Docs / {activeDoc}
              </Badge>
              <h3 className="font-serif text-2xl sm:text-4xl text-foreground font-normal mb-2">
                {DOC_PAGES[activeDoc]?.title}
              </h3>
              <p className="text-sm text-muted-foreground mb-6">
                {DOC_PAGES[activeDoc]?.desc}
              </p>
              <Separator className="mb-6" />

              {DOC_PAGES[activeDoc]?.content}

              {/* Code Example Tabs using Coss UI Tabs */}
              <div className="mt-8">
                <h4 className="font-serif text-lg text-cobalt mb-3">TypeScript Authoring Example</h4>
                <Tabs defaultValue="component">
                  <TabsList className="mb-3">
                    <TabsTab value="component">Component.tsx</TabsTab>
                    <TabsTab value="render">Render.ts</TabsTab>
                  </TabsList>
                  <TabsPanel value="component">
                    <CodeBlock
                      title="src/Composition.tsx"
                      code={`import { AbsoluteFill, interpolate, useCurrentFrame, spring } from 'remotion';

export const MyVideo = () => {
  const frame = useCurrentFrame();
  const scale = spring({ frame, fps: 30, config: { damping: 12 } });
  const opacity = interpolate(frame, [0, 15], [0, 1]);

  return (
    <AbsoluteFill style={{ background: '#2238c4', justifyContent: 'center', alignItems: 'center' }}>
      <h1 style={{ color: '#f7f4ec', fontSize: 96, transform: \`scale(\${scale})\`, opacity }}>
        Kinetograph
      </h1>
    </AbsoluteFill>
  );
};`}
                    />
                  </TabsPanel>
                  <TabsPanel value="render">
                    <CodeBlock
                      title="src/render.ts"
                      code={`import { renderMedia, selectComposition } from '@kinetograph/core';

const composition = await selectComposition({
  entry: './src/index.tsx',
  id: 'MyVideo'
});

await renderMedia({
  composition,
  serveUrl: './dist',
  codec: 'h264',
  outputLocation: 'out/video.mp4',
});`}
                    />
                  </TabsPanel>
                </Tabs>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Decorative Toile Landscape Strip */}
      <section className="w-full overflow-hidden border-t border-cobalt/20 bg-paper">
        <KinetographLandscape className="w-full h-32 sm:h-44 block" />
      </section>

      {/* Halftone Wordmark Interactive Footer */}
      <HalftoneWordmarkFooter
        wordmark="kinetograph"
        label="Kinetograph"
        meta="Programmatic video engine · Rust & TypeScript"
        preset="cobalt"
        palette={{
          background: "#2238c4",
          ink: "#f7f4ec",
          warm: "#ffcd3c"
        }}
        dotGap={5.5}
        radius={85}
        crop={0.15}
        height="500px"
      />
    </div>
  );
}
