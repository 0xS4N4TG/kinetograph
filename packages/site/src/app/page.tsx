import Landscape from '@/art/landscape';
import HalftoneWordmarkFooter from '@/components/halftone-footer';
import { SmoothScroll } from '@/components/smooth-scroll';
import { Hero } from '@/sections/hero';
import { GITHUB, doc } from '@/sections/links';
import { Nav } from '@/sections/nav';
import { Agents, Film, Proof, Surfaces } from '@/sections/page';
import { Questions, Remotion, Start, Ticker } from '@/sections/static';
import { FinalCta, Problem, Solution } from '@/sections/story';

const FOOTER_COLUMNS = [
  { title: 'Site', links: [{ label: 'Why', href: '#why' }, { label: 'The engine', href: '#engine' }, { label: 'Agents', href: '#agents' }, { label: 'The film', href: '#film' }, { label: 'Get started', href: '#start' }] },
  { title: 'Docs', links: [{ label: 'README', href: `${GITHUB}#readme` }, { label: 'DOM engine', href: doc('packages/cli/skills/kinetograph/references/ENGINE.md') }, { label: 'Remotion compat', href: '/docs/compat/' }, { label: 'Known issues', href: '/docs/known-issues/' }] },
  { title: 'Project', links: [{ label: 'GitHub', href: GITHUB }, { label: 'Licence', href: doc('LICENSE.md') }, { label: 'Commercial licence', href: doc('COMMERCIAL.md') }, { label: 'llms.txt', href: '/llms.txt' }] },
];

export default function Page() {
  return (
    <div className="min-h-screen bg-paper font-sans text-night selection:bg-cobalt selection:text-paper">
      <SmoothScroll />
      <Nav />
      <main>
        <Hero />
        <Problem />
        <Solution />
        <Remotion />
        <Ticker />
        <Surfaces />
        <Agents />
        <Proof />
        <Film />
        <Start />
        <Questions />
        <FinalCta />
      </main>
      <Landscape className="block h-[clamp(180px,24vw,360px)] w-full" />
      <HalftoneWordmarkFooter
        wordmark="kinetograph"
        label="Kinetograph"
        meta="A video engine with no browser in it · Rust and TypeScript"
        columns={FOOTER_COLUMNS}
        preset="cobalt"
        palette={{ background: '#2238c4', ink: '#f7f4ec', warm: '#ffcd3c' }}
        dotGap={5.5}
        radius={85}
        crop={0.15}
        height="520px"
        fontFamily="'Geist Variable', system-ui, sans-serif"
        monoFamily="'Geist Mono Variable', ui-monospace, monospace"
      />
    </div>
  );
}
