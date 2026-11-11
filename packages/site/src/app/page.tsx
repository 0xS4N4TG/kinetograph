import { RootProvider } from 'fumadocs-ui/provider/next';

import { RevealRoot } from '@/components/reveal-root';
import { SmoothScroll } from '@/components/smooth-scroll';
import { Engine } from '@/sections/engine';
import { Film } from '@/sections/film';
import { Footer } from '@/sections/footer';
import { Hero } from '@/sections/hero';
import { GITHUB, doc } from '@/sections/links';
import { THEME } from '@/lib/theme';
import { Nav } from '@/sections/nav';
import { Origin } from '@/sections/origin';
import { SpeedSection } from '@/sections/speed';
import { Start } from '@/sections/static';

const FOOTER_COLUMNS = [
  { title: 'Site', links: [{ label: 'Why', href: '#why' }, { label: 'The engine', href: '#engine' }, { label: 'Agents', href: '#agents' }, { label: 'Taste', href: '#taste' }, { label: 'The film', href: '#film' }, { label: 'Get started', href: '#start' }] },
  { title: 'Docs', links: [{ label: 'Overview', href: '/docs/' }, { label: 'Check your setup', href: '/docs/check-your-setup/' }, { label: 'First video', href: '/docs/getting-started/first-video/' }, { label: 'How the engine works', href: '/docs/internals/engine/' }, { label: 'What works', href: '/docs/compat/' }, { label: 'Changelog', href: '/docs/changelog/' }] },
  { title: 'Project', links: [{ label: 'GitHub', href: GITHUB }, { label: 'Licence', href: doc('LICENSE.md') }, { label: 'llms.txt', href: '/llms.txt' }] },
];

export default function Page() {
  return (
    <RootProvider theme={THEME} search={{ enabled: false }}>
      <div className="min-h-screen overflow-x-clip bg-ground font-dm text-ink selection:bg-field selection:text-on-field">
        <SmoothScroll />
        <RevealRoot />
        <div aria-hidden className="kg-frame" />
        <Nav />
        <div className="relative z-10 bg-ground">
          <main>
            <Hero />
            <Film />
            <SpeedSection />
            <Engine />
            <Origin />
            <Start />
          </main>
        </div>
        <Footer columns={FOOTER_COLUMNS} />
      </div>
      <div aria-hidden className="kg-grain" />
    </RootProvider>
  );
}
