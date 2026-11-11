import { BENCH, SCENES, type Scene } from '@/data/speed';
import { Heading } from '@/sections/heading';
import { body, link, section, shell } from '@/sections/shared';

const scene = (id: string): Scene => {
  const s = SCENES.find((x) => x.id === id);
  if (!s) throw new Error(`speed.ts has no scene "${id}"`);
  return s;
};
/** The page prints times to the data's own precision, as the Speed page does. */
const secs = (n: number) => `${n.toFixed(2)} s`;
const times = (n: number) => `${n.toFixed(1)}×`;

/** Dot screens for the bars, from the same ordered dither as the pictures (a 50% and a 25% tile), screened over the field. */
const screen = (tile: string): React.CSSProperties => ({
  backgroundColor: 'var(--field)',
  backgroundImage: `url(/retro/dither-${tile}.png)`,
  backgroundBlendMode: 'screen',
  backgroundSize: '28px 28px',
});
const sprockets: React.CSSProperties = {
  backgroundColor: 'var(--field)',
  backgroundImage: 'url(/retro/sprocket.png)',
  backgroundBlendMode: 'screen',
  backgroundSize: '31.5px 45.5px',
  backgroundRepeat: 'repeat-y',
};

/**
 * The 60-second film's three render times (data/speed.ts) as bars drawn to scale: ours solid, the others in lighter dot
 * screens, between two columns of film sprocket holes. Labels and values are live text, so the list is its own text alternative.
 */
function RenderChart() {
  const film = scene('film');
  const rows = [
    { name: 'Kinetograph', s: film.kinetograph.s, style: { backgroundColor: '#fff' } as React.CSSProperties },
    { name: 'HyperFrames', s: film.hyperframes!.s, style: screen('half') },
    { name: 'Remotion', s: film.remotion!.s, style: screen('quarter') },
  ];
  const max = Math.max(...rows.map((r) => r.s));
  return (
    <div className="kg-core kg-core-field flex h-full min-h-[340px] flex-col justify-between gap-10 px-[68px] py-[clamp(24px,3vw,40px)]">
      <i aria-hidden className="absolute inset-y-0 left-3 w-[31.5px]" style={sprockets} />
      <i aria-hidden className="absolute inset-y-0 right-3 w-[31.5px]" style={sprockets} />
      <p className="font-display text-[clamp(30px,2.6vw,38px)] leading-none">Render time of the {film.seconds}-second film</p>
      <ul className="flex flex-col gap-[clamp(28px,4vw,56px)]">
        {rows.map((r) => (
          <li key={r.name}>
            <p className="flex items-baseline justify-between gap-4">
              <span className="font-display text-[20px] leading-none tracking-[0.04em] uppercase">{r.name}</span>
              <span className="font-jb text-[14px]">{secs(r.s)}</span>
            </p>
            <div aria-hidden className="mt-3 h-[clamp(52px,6vw,88px)]" style={{ width: `${(r.s / max) * 100}%`, ...r.style }} />
          </li>
        ))}
      </ul>
    </div>
  );
}

const numeral = 'font-display font-normal leading-[0.8]';

/**
 * Render speed from the measured scenes in data/speed.ts, one scene per number: the film, the paper cut-out video, the
 * shattering terminal. An asymmetric grid, four cells: the film's time on the cobalt field, a chart of the three engines'
 * times on that film, two ratios. Each sentence names its video; the run count is in the note under the grid.
 */
export function Speed() {
  const film = scene('film');
  const paper = scene('papercut');
  const term = scene('mg1');
  return (
    <div id="benchmark" className="mt-[clamp(40px,6vw,88px)] scroll-mt-8">
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-12">
        <div data-reveal className="kg-tray lg:col-span-7">
          <div className="kg-core kg-core-field flex h-full min-h-[340px] flex-col justify-between gap-12 p-[clamp(24px,3vw,44px)]">
            <p className={`${numeral} text-[clamp(120px,15vw,230px)]`}>
              {film.kinetograph.s.toFixed(2)}
              <span className="ml-[0.1em] text-[0.3em]">s</span>
            </p>
            <div>
              <p className="max-w-[30ch] font-dm text-[clamp(20px,2vw,26px)] leading-snug font-medium tracking-[-0.01em]">
                to render the {film.seconds}-second film: {film.frames.toLocaleString('en-US')} frames of 1080p.
              </p>
            </div>
          </div>
        </div>
        <div data-reveal style={{ '--i': 1 } as React.CSSProperties} className="kg-tray min-h-[300px] lg:col-span-5 lg:row-span-2">
          <RenderChart />
        </div>
        <div data-reveal style={{ '--i': 2 } as React.CSSProperties} className="kg-tray lg:col-span-4">
          <div className="kg-core kg-core-card flex h-full flex-col justify-between gap-10 p-[clamp(24px,2.6vw,36px)]">
            <p className={`${numeral} text-[clamp(80px,8vw,124px)] text-cobalt`}>{times(paper.vsRemotion!.x)}</p>
            <p className={`${body} max-w-[32ch] text-[16px]`}>
              faster than Remotion on the {paper.title.toLowerCase()}: {secs(paper.kinetograph.s)} against {secs(paper.remotion!.s)}.
            </p>
          </div>
        </div>
        <div data-reveal style={{ '--i': 3 } as React.CSSProperties} className="kg-tray lg:col-span-3">
          <div className="kg-core kg-core-card flex h-full flex-col justify-between gap-10 p-[clamp(24px,2.6vw,36px)]">
            <p className={`${numeral} text-[clamp(80px,8vw,124px)] text-cobalt`}>{times(term.vsHyperframes!.x)}</p>
            <p className={`${body} text-[16px]`}>
              faster than HyperFrames on the {term.title.toLowerCase()}. Against Remotion the gap is {times(term.vsRemotion!.x)}.
            </p>
          </div>
        </div>
      </div>
      <p data-reveal className="mt-6 max-w-[70ch] font-jb text-[12px] leading-relaxed text-ink/70">
        Each number is one video, not a general claim. {BENCH.machine}, median of {BENCH.n} timed runs after {BENCH.warmups} warm-up, measured {BENCH.date}.{' '}
        <a className={link} href="/docs/speed/">All {SCENES.length} videos</a>.
      </p>
    </div>
  );
}

/** The speed section: its heading, then the numbers. */
export function SpeedSection() {
  return (
    <section id="why" className={`${shell} ${section} scroll-mt-6`}>
      <div data-reveal>
        <Heading className="max-w-[16ch]">The renders, and how long they took.</Heading>
      </div>
      <Speed />
    </section>
  );
}
