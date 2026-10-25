import HalftoneWordmarkFooter from '@/components/halftone-footer';
import { SmoothScroll } from '@/components/smooth-scroll';
import { Hero } from '@/sections/hero';
import { GITHUB, doc } from '@/sections/links';
import { Nav } from '@/sections/nav';
import { About, Facts } from '@/sections/page';
import { Start } from '@/sections/static';

const FOOTER_COLUMNS = [
  { title: 'Site', links: [{ label: 'Why', href: '#why' }, { label: 'The engine', href: '#engine' }, { label: 'Agents', href: '#agents' }, { label: 'The film', href: '#film' }, { label: 'Get started', href: '#start' }] },
  { title: 'Docs', links: [{ label: 'README', href: `${GITHUB}#readme` }, { label: 'DOM engine', href: doc('packages/cli/skills/kinetograph/references/ENGINE.md') }, { label: 'Remotion compat', href: '/docs/compat/' }, { label: 'Known issues', href: '/docs/known-issues/' }] },
  { title: 'Project', links: [{ label: 'GitHub', href: GITHUB }, { label: 'Licence', href: doc('LICENSE.md') }, { label: 'Commercial licence', href: doc('COMMERCIAL.md') }, { label: 'llms.txt', href: '/llms.txt' }] },
];

export default function Page() {
  return (
    <div className="min-h-screen overflow-x-clip bg-ground font-dm text-ink selection:bg-flag selection:text-white">
      <SmoothScroll />
      <Nav />
      <main>
        <Hero />
        <Facts />
        <About />
        <Start />
      </main>
      <HalftoneWordmarkFooter
        wordmark="kinetograph"
        label="Kinetograph"
        meta="A programmatic video engine · Rust and TypeScript"
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
