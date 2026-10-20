import Landscape from '@/art/landscape';
import HalftoneWordmarkFooter from '@/components/halftone-footer';
import { Hero } from '@/sections/hero';
import { GITHUB, doc } from '@/sections/links';
import { Nav } from '@/sections/nav';
import { Agents, Film, Proof, Questions, Remotion, Start, Surfaces, Ticker } from '@/sections/page';

const FOOTER_COLUMNS = [
  { title: 'Site', links: [{ label: 'The film', href: '#film' }, { label: 'The engine', href: '#engine' }, { label: 'Remotion', href: '#remotion' }, { label: 'Agents', href: '#agents' }] },
  { title: 'Docs', links: [{ label: 'README', href: `${GITHUB}#readme` }, { label: 'DOM engine', href: doc('docs/ENGINE.md') }, { label: 'Remotion compat', href: doc('docs/COMPAT.md') }, { label: 'Open issues', href: doc('docs/OPEN_ISSUES.md') }] },
  { title: 'Project', links: [{ label: 'GitHub', href: GITHUB }, { label: 'Licence', href: doc('LICENSE.md') }, { label: 'llms.txt', href: '/llms.txt' }] },
];

export function App() {
  return (
    <div className="min-h-screen bg-paper font-sans text-night selection:bg-cobalt selection:text-paper">
      <Nav />
      <main>
        <Hero />
        <Ticker />
        <Proof />
        <Film />
        <Surfaces />
        <Remotion />
        <Agents />
        <Start />
        <Questions />
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
