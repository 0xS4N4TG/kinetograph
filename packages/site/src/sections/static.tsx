import { CommandBar } from '@/components/code';
import { commandBar } from '@/sections/hero';
import { Heading } from '@/sections/heading';
import { body, Label, link, section, shell } from '@/sections/shared';

const STEPS = [
  ['Install', 'npm install kinetograph'],
  ['Open the studio', 'npx kinetograph studio src/index.tsx'],
  ['Render', 'npx kinetograph render src/index.tsx -o out.mp4'],
] as const;

export function Start() {
  return (
    <section id="start" className={`${shell} ${section}`}>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-14 border-t border-cobalt/30 pt-[clamp(56px,8vw,112px)] lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:gap-20">
        <div>
          <Heading lines={['three commands to a film.']} hot="commands" tag="TRK 06  0.95" className="text-[clamp(32px,3.6vw,52px)]" />
          <p className={`${body} mt-10 max-w-[40ch]`}>
            You need Node 22 or later. It uses the GPU when there is one (Metal, Vulkan or D3D12) and draws on the CPU
            otherwise. It needs no display, so it runs on a server too, and the npm package carries FFmpeg.
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
      <p className={`${body} mt-24 max-w-[62ch] text-[15px]`}>
        Free for individuals and small companies under the PolyForm Small Business licence.{' '}
        See the <a className={link} href="/docs/known-issues/">known issues</a>.
      </p>
    </section>
  );
}
