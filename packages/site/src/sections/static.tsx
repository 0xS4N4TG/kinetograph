import { CommandBar } from '@/components/code';
import { commandBar } from '@/sections/hero';
import { Heading } from '@/sections/heading';
import { doc } from '@/sections/links';
import { body, Label, link, section, shell } from '@/sections/shared';

const STEPS = [
  ['Install', 'npm install kinetograph'],
  ['Open Studio', 'npx kinetograph studio src/index.tsx'],
  ['Render', 'npx kinetograph render src/index.tsx -o out.mp4'],
] as const;

export function Start() {
  return (
    <section id="start" className={`${shell} ${section}`}>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-14 border-t border-cobalt/30 pt-[clamp(56px,8vw,112px)] lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:gap-20">
        <div>
          <Heading lines={['three commands to a film.']} hot="commands" tag="TRK 06  0.95" className="text-[clamp(32px,3.6vw,52px)]" />
          <p className={`${body} mt-10 max-w-[40ch]`}>
            You need Node 22 or later. It draws on the GPU (Metal, Vulkan or D3D12) and falls back to the CPU when there is
            none. It needs no display, so it runs on a server too. The npm package carries FFmpeg.
          </p>
        </div>
        <ol className="space-y-9">
          {STEPS.map(([t, cmd], i) => (
            <li key={t}>
              <Label className="mb-3">{t}</Label>
              <CommandBar command={cmd} className={`${commandBar} max-w-none`} />
            </li>
          ))}
        </ol>
      </div>
      <div id="licence" className="mt-24 grid grid-cols-[minmax(0,1fr)] gap-6 border-t border-cobalt/30 pt-10 md:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] md:gap-20">
        <div>
          <Label className="mb-3">Licence</Label>
          <p className={`${body} max-w-[40ch]`}>
            Free for individuals, non-profits and companies under 100 people and 1,000,000 USD revenue. Source-available
            under the PolyForm Small Business licence.
          </p>
        </div>
        <div>
          <Label className="mb-3">Commercial licence</Label>
          <p className={`${body} max-w-[46ch]`}>
            Larger companies need a commercial licence. Email{' '}
            <a className={link} href="mailto:sanatasgsih@gmail.com">sanatasgsih@gmail.com</a>, or read{' '}
            <a className={link} href={doc('COMMERCIAL.md')}>the terms</a>. See <a className={link} href="/docs/compat/">what works</a>{' '}
            before you buy.
          </p>
        </div>
      </div>
    </section>
  );
}
