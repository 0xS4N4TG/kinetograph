import { CommandBar } from '@/components/code';
import { commandBar } from '@/sections/hero';
import { DOCS, GITHUB } from '@/sections/links';
import { Hand } from '@/sections/hand';
import { body, Label, link, section, shell } from '@/sections/shared';

const STEPS = [
  ['Install it', 'npm install kinetograph'],
  ['Open the studio', 'npx kinetograph studio src/index.tsx'],
  ['Render', 'npx kinetograph render src/index.tsx -o out.mp4'],
] as const;

export function Start() {
  return (
    <section id="start" className={`${shell} ${section}`}>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-14 border-t border-cobalt/30 pt-[clamp(56px,8vw,112px)] lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:gap-20">
        <div>
          <Label>Get started</Label>
          <Hand text="three commands to a film." hot="commands" tag="TRK 06  0.95" className="mt-8 text-[clamp(32px,3.6vw,52px)]" />
          <p className={`${body} mt-10 max-w-[40ch]`}>
            You need Node 22 or later and a GPU that wgpu supports, such as Metal on a Mac. It needs no display, so it runs
            on a server too. Rendering video needs FFmpeg.
          </p>
        </div>
        <ol className="space-y-9">
          {STEPS.map(([t, cmd], i) => (
            <li key={t}>
              <Label className="mb-3">{i + 1} · {t}</Label>
              <CommandBar command={cmd} className={`${commandBar} max-w-none`} />
            </li>
          ))}
        </ol>
      </div>
      <p className={`${body} mt-24 max-w-[62ch] text-[15px]`}>
        Free for individuals and small companies under the PolyForm Small Business licence.{' '}
        <a className={link} href={DOCS} target="_blank" rel="noreferrer">Read the docs</a>,{' '}
        <a className={link} href="/docs/known-issues/">see the known issues</a>, or{' '}
        <a className={link} href={GITHUB} target="_blank" rel="noreferrer">star it on GitHub</a>.
      </p>
    </section>
  );
}
