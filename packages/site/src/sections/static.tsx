import { CommandBar } from '@/components/code';
import { Heading } from '@/sections/heading';
import { commandBar } from '@/sections/hero';
import { doc } from '@/sections/links';
import { body, Label, link, section, shell } from '@/sections/shared';

const STEPS = [
  ['Install', 'npm install kinetograph'],
  ['Open Studio', 'npx kinetograph studio src/index.tsx'],
  ['Render', 'npx kinetograph render src/index.tsx -o out.mp4'],
] as const;

export function Start() {
  return (
    <section id="start" className={`${shell} ${section} scroll-mt-6`}>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-14 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:gap-20">
        <div data-reveal>
          <Heading className="max-w-[14ch]">Three commands to a film.</Heading>
          <p className={`${body} mt-10 max-w-[40ch]`}>
            You need Node 22 or later. It draws on the GPU (Metal, Vulkan or D3D12) and falls back to the CPU when there is
            none. It needs no display, so it runs on a server too. The npm package carries FFmpeg.
          </p>
        </div>
        <ol className="space-y-9 lg:pt-3">
          {STEPS.map(([t, cmd], i) => (
            <li key={t} data-reveal style={{ '--i': i + 1 } as React.CSSProperties}>
              <Label className="mb-3 ml-6">{t}</Label>
              <CommandBar command={cmd} className={`${commandBar} max-w-none`} />
            </li>
          ))}
        </ol>
      </div>
      <div id="licence" data-reveal className="mt-[clamp(64px,8vw,112px)] max-w-[50ch] scroll-mt-6">
        <Label className="mb-3">Licence</Label>
        <p className={body}>
          Kinetograph is open source under the Apache License 2.0, free for any use, including commercial.{' '}
          <a className={link} href={doc('LICENSE.md')}>Read the licence</a>. See{' '}
          <a className={link} href="/docs/compat/">what works</a>.
        </p>
      </div>
    </section>
  );
}
