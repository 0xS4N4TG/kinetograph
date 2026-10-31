import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { CodeBlock } from '@/components/code';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { plugins, type Clip, type Export, type GeneSlot, type Look, type Plugin } from '@/lib/catalog';
import { Adjacent, Badges, Block, CatalogPage, Crumbs, Draws, Figure, oneLine, PageHero, Still } from '@/sections/catalog';
import { Label, body, link } from '@/sections/shared';

type Params = { slug: string };

export const dynamicParams = false;

export function generateStaticParams(): Params[] {
  return plugins.map((p) => ({ slug: p.slug }));
}

export async function generateMetadata(props: { params: Promise<Params> }): Promise<Metadata> {
  const { slug } = await props.params;
  const p = plugins.find((x) => x.slug === slug);
  if (!p) return {};
  return {
    title: `${p.title} plugin | Kinetograph`,
    description: p.description,
  };
}

const mono = 'rounded-sm bg-ink/8 px-1.5 py-0.5 font-jb text-[0.9em] text-ink';

/** Inline code for a sentence that names an identifier. */
function Mono({ children }: { children: string }) {
  return <code className={mono}>{children}</code>;
}

function Props({ rows }: { rows: NonNullable<Export['props']> }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Prop</TableHead>
          <TableHead>What it does</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.name}>
            <TableCell className="align-top font-jb text-[13px]">
              {r.name}
              {r.optional ? '?' : ''}
            </TableCell>
            <TableCell className="align-top leading-[1.5] whitespace-normal">
              {r.doc || <span className="text-mute">{r.type}</span>}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

const GROUPS: { kind: Export['kind']; title: string; note: string }[] = [
  {
    kind: 'component',
    title: 'Components',
    note: 'Drawn as JSX inside a composition.',
  },
  {
    kind: 'effect',
    title: 'Effects',
    note: 'Layer effects: put them in a layer\u2019s effects.',
  },
  { kind: 'function', title: 'Functions', note: '' },
  { kind: 'constant', title: 'Constants', note: '' },
];

function Doc({ e }: { e: Export }) {
  const call = e.kind === 'component' ? `<${e.name} />` : e.kind === 'constant' ? e.name : `${e.name}()`;
  return (
    <div className="space-y-3 border-t border-ink/15 pt-5">
      <h4 className="font-jb text-[15px] font-medium text-ink">{call}</h4>
      {e.summary && <p className={`${body} max-w-[68ch]`}>{e.summary}</p>}
      {e.detail && <p className={`${body} max-w-[68ch]`}>{e.detail}</p>}
      {e.props && e.props.length > 0 && <Props rows={e.props} />}
    </div>
  );
}

/** Components open with their prop tables. Effects, functions and constants each sit in a disclosure, closed until opened. */
function Exports({ items }: { items: Export[] }) {
  return (
    <>
      {GROUPS.map((g) => {
        const rows = items.filter((e) => e.kind === g.kind);
        if (rows.length === 0) return null;
        const plain = g.kind === 'constant' ? rows.filter((e) => !e.summary) : [];
        const described = rows.filter((e) => !plain.includes(e));
        const list = (
          <div className="space-y-4">
            {described.map((e) => (
              <Doc key={e.name} e={e} />
            ))}
            {plain.length > 0 && (
              <p className="pt-2 font-jb text-[13px] leading-[1.8] text-ink/80">{plain.map((e) => e.name).join('  ')}</p>
            )}
          </div>
        );
        if (g.kind === 'component') {
          return (
            <div key={g.kind} className="space-y-4">
              <h3 className="font-dm text-[18px] font-bold tracking-[-0.02em] text-ink">{g.title}</h3>
              {g.note && <p className={`${body} max-w-[68ch]`}>{g.note}</p>}
              {list}
            </div>
          );
        }
        return (
          <details key={g.kind} className="group border-t border-ink/15 pt-4">
            <summary className="cursor-pointer font-dm text-[18px] font-bold tracking-[-0.02em] text-ink marker:text-ink/40 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-cobalt">
              {g.title} ({rows.length})
            </summary>
            <div className="mt-4 space-y-4">
              {g.note && <p className={`${body} max-w-[68ch]`}>{g.note}</p>}
              {list}
            </div>
          </details>
        );
      })}
    </>
  );
}

/** Genes by slot: one group per slot, each gene a chip. The note is the chip's title and, for screen readers, hidden text. */
function Genes({ slots }: { slots: GeneSlot[] }) {
  return (
    <div className="grid gap-x-10 gap-y-8 md:grid-cols-2">
      {slots.map((s) => (
        <div key={s.slot} className="space-y-3">
          <h3 className="font-jb text-[16px] font-medium text-ink">
            {s.slot} <span className="text-mute">({s.genes.length})</span>
          </h3>
          {s.note && <p className={`${body} max-w-[68ch]`}>{s.note}</p>}
          <ul className="flex flex-wrap gap-1.5">
            {s.genes.map((g) => (
              <li key={g.id}>
                <span
                  tabIndex={0}
                  title={g.note}
                  className="inline-block rounded-sm border border-ink/20 px-2 py-1 font-jb text-[12px] text-ink focus-visible:outline-2 focus-visible:outline-cobalt"
                >
                  {g.id}
                  <span className="sr-only">: {g.note}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

/** The look kinds as a two-column list on desktop, one column under md. */
function Looks({ looks }: { looks: Look[] }) {
  return (
    <dl className="grid gap-x-10 gap-y-6 md:grid-cols-2">
      {looks.map((l) => (
        <div key={l.kind} className="space-y-1">
          <dt className="font-jb text-[14px] font-medium text-ink">
            {l.kind}
            {l.uses && <span className="text-mute"> {l.uses}</span>}
          </dt>
          <dd className={body}>{l.summary}</dd>
        </div>
      ))}
    </dl>
  );
}

function Names({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="space-y-2 border-t border-ink/15 pt-5">
      <h3 className="font-dm text-[18px] font-bold tracking-[-0.02em] text-ink">{title}</h3>
      <p className="font-jb text-[13px] leading-[1.8] text-ink/80">{items.join('  ')}</p>
    </div>
  );
}

/** Paper's lists. */
function PaperLists({ p }: { p: Plugin }) {
  return (
    <>
      {p.stocks && <Names title="Paper stocks" items={p.stocks} />}
      {p.edges && <Names title="Edge styles" items={p.edges} />}
      {p.layouts && <Names title="Page layouts" items={p.layouts} />}
      {p.textures && <Names title="Texture scans" items={p.textures} />}
    </>
  );
}

type Feature = Plugin['features'][number];

/** One feature: a heading of a few words, a sentence or two, and its clip with one caption line under it. */
function FeatureBlock({ f }: { f: Feature }) {
  return (
    <div className="space-y-3">
      <h3 className="font-dm text-[20px] font-bold tracking-[-0.02em] text-ink">{f.title}</h3>
      <p className={`${body} max-w-[60ch]`}>{f.text}</p>
      <Figure media={f.clip} alt={`${f.title}, a clip`} caption={f.clip.caption} reveal />
    </div>
  );
}

type Group = { kind: 'full' | 'pair' | 'stack'; at: number[] };
/**
 * How each plugin lays out its features, so no two pages repeat a shape and none is an image-left, image-right zigzag.
 * full: one wide clip. pair: two side by side. stack: a large clip beside two small ones. Every group is one column under md.
 */
const LAYOUTS: Record<string, Group[]> = {
  hexed: [
    { kind: 'full', at: [0] },
    { kind: 'pair', at: [1, 2] },
  ],
  'kinetic-typography': [{ kind: 'pair', at: [0, 1] }],
  paper: [
    { kind: 'pair', at: [0, 1] },
    { kind: 'full', at: [2] },
  ],
  vj: [
    { kind: 'stack', at: [0, 1, 2] },
    { kind: 'pair', at: [3, 4] },
  ],
};

function Features({ slug, items }: { slug: string; items: Feature[] }) {
  const groups = LAYOUTS[slug] ?? [{ kind: 'pair' as const, at: items.map((_, i) => i) }];
  return (
    <div className="mt-8 space-y-14">
      {groups.map((g) => {
        const fs = g.at.map((i) => items[i]).filter((f) => f !== undefined);
        if (g.kind === 'full') return <FeatureBlock key={g.at.join()} f={fs[0]} />;
        if (g.kind === 'stack') {
          const [big, ...rest] = fs;
          return (
            <div key={g.at.join()} className="grid grid-cols-1 gap-10 md:grid-cols-[3fr_2fr]">
              <FeatureBlock f={big} />
              <div className="grid grid-cols-1 content-start gap-10">
                {rest.map((f) => (
                  <FeatureBlock key={f.title} f={f} />
                ))}
              </div>
            </div>
          );
        }
        return (
          <div key={g.at.join()} className="grid grid-cols-1 gap-10 md:grid-cols-2">
            {fs.map((f) => (
              <FeatureBlock key={f.title} f={f} />
            ))}
          </div>
        );
      })}
    </div>
  );
}

/** A demo's clips: two columns from md up, one under. Portrait clips run three across and keep their narrow width. */
function DemoClips({ clips, title }: { clips: Clip[]; title: string }) {
  const portrait = clips.every((c) => c.h > c.w);
  return (
    <div className={portrait ? 'grid grid-cols-1 gap-6 sm:grid-cols-2 md:grid-cols-3' : 'grid grid-cols-1 gap-6 md:grid-cols-2'}>
      {clips.map((c) => (
        <Figure key={c.video} media={c} alt={c.caption ?? title} caption={c.caption} />
      ))}
    </div>
  );
}

export default async function PluginPage(props: { params: Promise<Params> }) {
  const { slug } = await props.params;
  const p = plugins.find((x) => x.slug === slug);
  if (!p) notFound();
  const studio = p.studio;
  const hasStudio = studio !== null && (studio.panel || studio.tools.length > 0 || studio.note);
  const demos = p.demos;

  const i = plugins.findIndex((x) => x.slug === slug);
  const prev = plugins[(i - 1 + plugins.length) % plugins.length];
  const next = plugins[(i + 1) % plugins.length];
  const toItem = (x: Plugin) => ({
    href: `/plugins/${x.slug}/`,
    title: x.title,
    image: x.hero,
  });
  const jump = [
    p.exports.length > 0 && ['exports', 'Exports'],
    p.genes && ['genes', 'Genes'],
    p.looks && ['looks', 'Looks'],
    p.stocks && ['paper-lists', 'Stocks and layouts'],
    p.faces && ['faces', 'Faces'],
    p.presets.length > 0 && ['presets', 'Presets'],
    p.examples.length > 0 && ['examples', 'Examples'],
    hasStudio && ['studio', 'In Studio'],
  ].filter((x): x is [string, string] => Array.isArray(x));

  return (
    <CatalogPage>
      <Crumbs section="plugins" current={p.title} />
      <PageHero title={p.title} tag="PLUGIN  1.00" line={oneLine(p.description)} clip={p.hero} alt={`${p.title}, a clip from its demo`}>
        <div className="mt-4 space-y-2">
          <Draws names={p.components} />
          <p className="text-[14px] text-mute">Coming; not published yet.</p>
          <a href="#reference" className={`${link} kc-press inline-block font-jb text-[12px] tracking-[0.04em]`}>
            Jump to reference
          </a>
        </div>
      </PageHero>

      <Block id="what" title="What it does">
        <p className={`${body} max-w-[68ch]`}>{p.intro}</p>
        <Features slug={p.slug} items={p.features} />
      </Block>

      {demos.length > 0 && (
        <Block id="demos" title="Demos">
          {demos.map((d) => (
            <div key={d.id} className="space-y-3 border-t border-ink/15 pt-5">
              <h3 className="font-dm text-[18px] font-bold tracking-[-0.02em] text-ink">{d.title}</h3>
              {d.text && <p className={`${body} max-w-[68ch]`}>{d.text}</p>}
              {d.compositions.length > 0 && (
                <p className="font-jb text-[13px] leading-[1.8] text-ink/80">
                  <span className="text-mute">Compositions </span>
                  {d.compositions.join('  ')}
                </p>
              )}
              {d.clips.length > 0 && <DemoClips clips={d.clips} title={d.title} />}
            </div>
          ))}
        </Block>
      )}
      <div id="reference" className="mt-24 scroll-mt-8 border-t-2 border-ink pt-6">
        <h2 className="font-dm text-[clamp(30px,3.2vw,44px)] leading-tight font-bold tracking-[-0.04em] text-ink">Reference</h2>
        <p className={`${body} mt-2 max-w-[62ch]`}>Exports, props and examples, for wiring it into a project.</p>
        <div className="mt-4">
          <Label className="mb-2">Ships with</Label>
          <Badges panel={p.hasPanel} tools={p.hasTools} skill={p.hasSkill} />
        </div>
        <nav
          aria-label="Reference sections"
          className="sticky top-0 z-30 -mx-1 mt-6 overflow-x-auto border-b border-ink/15 bg-ground px-1 py-3"
        >
          <ul className="flex gap-5 font-jb text-[12px] tracking-[0.04em] whitespace-nowrap">
            {jump.map(([id, name]) => (
              <li key={id}>
                <a href={`#${id}`} className={`${link} kc-press inline-block`}>
                  {name}
                </a>
              </li>
            ))}
            <li className="ml-auto">
              <a href="#" className={`${link} kc-press inline-block`}>
                Top
              </a>
            </li>
          </ul>
        </nav>
        {p.exports.length > 0 && (
          <Block className="mt-14" id="exports" title="What it exports">
            <Exports items={p.exports} />
          </Block>
        )}

        {p.genes && (
          <Block className="mt-14" id="genes" title="Genes by slot">
            <p className={`${body} max-w-[68ch]`}>Each slot holds one gene. Lock a slot to keep its gene, or leave it to the seed.</p>
            <Genes slots={p.genes} />
          </Block>
        )}

        {p.looks && (
          <Block className="mt-14" id="looks" title="Looks">
            <p className={`${body} max-w-[68ch]`}>The look kinds the Studio panel can switch between, and the export that draws each.</p>
            <Looks looks={p.looks} />
          </Block>
        )}

        {p.stocks && (
          <Block className="mt-14" id="paper-lists" title="Stocks, edges and layouts">
            <PaperLists p={p} />
          </Block>
        )}

        {p.faces && (
          <Block className="mt-14" id="faces" title="Faces">
            <Names title="Handwritten, mixed a letter at a time" items={p.faces.hands} />
            <Names title="Display, for key words" items={p.faces.display} />
          </Block>
        )}

        {p.presets.length > 0 && (
          <Block className="mt-14" id="presets" title="Presets">
            {p.presetNote && <p className={`${body} max-w-[68ch]`}>{p.presetNote}</p>}
            <ul className="grid gap-x-8 gap-y-10 sm:grid-cols-2">
              {p.presets.map((pr) => (
                <li key={pr.name} className="border-t border-ink/15 pt-4">
                  {pr.image && <Still image={pr.image} alt={`${pr.name} preset`} fit />}
                  <h3 className="mt-4 font-jb text-[16px] font-medium text-ink">{pr.name}</h3>
                  {pr.line && <p className={`${body} mt-1`}>{pr.line}</p>}
                </li>
              ))}
            </ul>
          </Block>
        )}

        {p.examples.length > 0 && (
          <Block className="mt-14" id="examples" title="Examples">
            {p.examples.map((e) => (
              <CodeBlock key={e.title} title={e.title} code={e.code} />
            ))}
          </Block>
        )}

        {hasStudio && studio && (
          <Block className="mt-14" id="studio" title="In Studio">
            {studio.panel && (
              <div className="space-y-2">
                <h3 className="font-dm text-[18px] font-bold tracking-[-0.02em] text-ink">Panel</h3>
                <p className={`${body} max-w-[68ch]`}>{studio.panel}</p>
              </div>
            )}
            {studio.tools.length > 0 && (
              <div className="space-y-3">
                <h3 className="font-dm text-[18px] font-bold tracking-[-0.02em] text-ink">Agent tools</h3>
                <ul className="space-y-3">
                  {studio.tools.map((t) => (
                    <li key={t.name} className={`${body} max-w-[68ch]`}>
                      <Mono>{t.name}</Mono> {t.text}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {studio.note && <p className={`${body} max-w-[68ch]`}>{studio.note}</p>}
            <p className={`${body} max-w-[68ch]`}>{studio.installed}</p>
          </Block>
        )}
      </div>

      <Adjacent label="plugin" prev={toItem(prev)} next={toItem(next)} />
    </CatalogPage>
  );
}
