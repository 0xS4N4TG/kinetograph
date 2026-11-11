import { CommandBar } from '@/components/code';
import { PillLink } from '@/components/pill-link';
import { Heading } from '@/sections/heading';
import { commandBar } from '@/sections/hero';
import { body, section, shell } from '@/sections/shared';
import { StudioLoop } from '@/sections/studio-loop';

const WINDOW_ALT =
  'The whole Studio window with a project open: the agent chat on the left, the preview in the middle with the timeline under it, and the inspector on the right.';

/** Short lines, each from the Studio guide (find-your-way, export). */
const THINGS = [
  ['Markup', 'Pin, box or draw on the preview. Your agent gets each note with its frame and the layers under your mark.'],
  ['Timeline', 'Drag a clip to move it and an edge to trim it. Pick a span and it goes to your agent with your next message.'],
  ['Props', "A form drawn from the composition's schema: a slider for a number, a switch for a boolean, a colour input for a colour."],
  ['Export', 'Renders run on this computer. There is no cloud renderer, so nothing is uploaded.'],
] as const;

/**
 * Studio: the heading, what it is and the command to open it, then the real window screenshot (light or dark with the
 * theme) as the dominant picture, then four short things you can do beside a clip of markup. Screenshots stay in
 * full colour: nothing here is tinted.
 */
export function Studio() {
  return (
    <section id="studio" className={`${shell} ${section} scroll-mt-6`}>
      <div data-reveal>
        <Heading className="max-w-[14ch]">Edit it in Studio.</Heading>
        <p className={`${body} mt-8 max-w-[54ch]`}>
          Studio is the editor that comes with Kinetograph. It shows a live preview of your project with a timeline, a form for
          its settings and a chat with your coding agent, and it runs on your computer with no account.
        </p>
        <div className="mt-8 flex flex-col items-start gap-4 sm:flex-row sm:items-center">
          <CommandBar command="npx kinetograph studio src/index.tsx" className={commandBar} />
          <PillLink href="/docs/studio/">Studio guide</PillLink>
        </div>
      </div>

      <div data-reveal className="kg-tray mt-[clamp(40px,6vw,88px)]">
        <div className="kg-core bg-card">
          <img src="/docs-media/studio/window-light.webp" width={3200} height={2320} alt={WINDOW_ALT} loading="lazy" decoding="async" className="block h-auto w-full dark:hidden" />
          <img src="/docs-media/studio/window-dark.webp" width={3200} height={2320} alt={WINDOW_ALT} loading="lazy" decoding="async" className="hidden h-auto w-full dark:block" />
        </div>
      </div>

      <div className="mt-[clamp(40px,6vw,88px)] grid grid-cols-1 gap-x-[clamp(32px,5vw,72px)] gap-y-10 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:items-start">
        <ul className="grid grid-cols-1 gap-y-8">
          {THINGS.map(([name, text], i) => (
            <li key={name} data-reveal style={{ '--i': i } as React.CSSProperties} className="border-t border-ink/15 pt-5">
              <p className="font-display text-[clamp(30px,2.6vw,38px)] leading-none text-ink">{name}</p>
              <p className={`${body} mt-3 max-w-[46ch] text-[16px]`}>{text}</p>
            </li>
          ))}
        </ul>
        <div data-reveal className="kg-tray">
          <div className="kg-core bg-black">
            <StudioLoop
              src="/docs-media/studio/main-loop-dark.mp4"
              poster="/docs-media/studio/main-loop-dark.jpg"
              label="Marking up the preview in Studio: a box round the title, a note, and the agent's reply."
              width={1280}
              height={764}
            />
          </div>
        </div>
      </div>
    </section>
  );
}
