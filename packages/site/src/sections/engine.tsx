import { CommandBar } from '@/components/code';
import { Pic } from '@/components/pic';
import { Heading } from '@/sections/heading';
import { commandBar } from '@/sections/hero';
import { body, link, section, shell } from '@/sections/shared';

const pad = 'p-[clamp(24px,3.2vw,48px)]';

/** The tastes shown in the catalog, as the reels they come from (full colour: you pick a taste by its look). */
const TASTES = [
  { slug: 'archive', name: 'Archive', pose: 'md:mt-6 md:-rotate-[5deg]' },
  { slug: 'collage', name: 'Collage', pose: 'md:mt-0 md:rotate-[1deg]' },
  { slug: 'print', name: 'Print', pose: 'md:mt-8 md:rotate-[6deg]' },
] as const;

/**
 * The product in an asymmetric grid of four cells: what it runs, a drawing of the mechanism, what an agent can do with
 * it, and the taste skills. 7/5 over 5/7, with the cobalt cells on the diagonal.
 */
export function Engine() {
  return (
    <section id="engine" className={`${shell} ${section} scroll-mt-6`}>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-12">
        <div data-reveal className="kg-tray lg:col-span-7">
          <div className={`kg-core kg-core-card flex h-full flex-col justify-between gap-12 ${pad}`}>
            <Heading size="cell" className="max-w-[14ch]">The code you already write, no browser needed.</Heading>
            <p className={`${body} max-w-[46ch]`}>
              Write in TypeScript with Remotion's API, CSS, SVG, Canvas 2D, WebGL shaders and Web Audio. Or write an HTML page
              with GSAP: HyperFrames projects render as they are. Node runs the code and a Rust compositor draws every
              frame. No browser sits anywhere in the path.
            </p>
          </div>
        </div>
        <div data-reveal style={{ '--i': 1 } as React.CSSProperties} className="kg-tray max-lg:aspect-[956/874] max-lg:md:aspect-[4/3] lg:col-span-5 lg:min-h-[320px]">
          <Pic
            tint="/retro/engine-mark.webp"
            alt="An engraving of a film camera mechanism: two toothed reels, a strip of film and a lens."
            className="size-full lg:min-h-[320px]"
            contain
          />
        </div>
        <div id="agents" data-reveal style={{ '--i': 2 } as React.CSSProperties} className="kg-tray scroll-mt-6 lg:col-span-5">
          <div className={`kg-core kg-core-field flex h-full flex-col gap-10 ${pad}`}>
            <Heading size="cell" className="max-w-[12ch] text-on-field">An agent can check its own work.</Heading>
            {/* Heading on top, text and command pinned to the bottom, as in the other cells; the command bar sits level with the taste cell's. */}
            <div className="mt-auto flex flex-col gap-10">
              <p className="max-w-[44ch] font-dm text-[17px] leading-[1.6] tracking-[-0.005em] text-on-field/90">
                Every command takes <code className="font-jb text-[14px]">--json</code>, and{' '}
                <code className="font-jb text-[14px]">kinetograph mcp</code> serves them as tools. An agent writes the TSX or HTML,
                renders a still, reads the scene graph and fixes what is wrong before you watch.
              </p>
              <div>
                <p className="font-dm text-[17px] text-on-field/90">Teach your agent Kinetograph:</p>
                <CommandBar command="npx kinetograph skills update" tone="ink" className={`${commandBar} mt-4 border-on-field/30 bg-on-field/10 text-on-field`} />
              </div>
            </div>
          </div>
        </div>
        <div id="taste" data-reveal style={{ '--i': 3 } as React.CSSProperties} className="kg-tray scroll-mt-6 lg:col-span-7">
          <div className={`kg-core kg-core-card flex h-full flex-col justify-between gap-12 ${pad}`}>
            <div className="flex flex-col justify-between gap-8 md:flex-row">
              <Heading size="cell" className="min-w-0 flex-1">Point your agent at a reel, keep its taste.</Heading>
              <ul className="flex shrink-0 items-start max-md:gap-3 md:-space-x-6 md:pr-2">
                {TASTES.map((t) => (
                  <li key={t.slug} className={t.pose}>
                    <a href={`/tastes/${t.slug}/`} aria-label={`${t.name} taste`} className="block transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] active:scale-[0.98]">
                      <img
                        src={`/catalog/tastes/${t.slug}/hero.webp`}
                        alt={`A frame from the ${t.name.toLowerCase()} taste.`}
                        loading="lazy"
                        className="aspect-[9/16] w-[clamp(92px,8vw,116px)] rounded-[var(--kg-core)] object-cover shadow-[0_6px_18px_-8px_rgb(0_0_0/0.5)]"
                      />
                    </a>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <p className={`${body} max-w-[52ch]`}>
                Give an agent a reel or any reference video. It downloads the video, reads every frame and writes down the
                timing, layout, colour, type and shadows as numbers. Then it makes your own videos in that style, and checks
                each shot against the reference before you see it.
              </p>
              <p className={`${body} mt-4 max-w-[52ch]`}>
                Works with Kinetograph, Remotion or any frame-based renderer.{' '}
                <a className={link} href="/docs/guides/taste/">How it works</a>.
              </p>
              <CommandBar command="npx kinetograph skills update" className={`${commandBar} mt-6`} />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
