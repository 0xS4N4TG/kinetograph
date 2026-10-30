import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { CodeBlock } from '@/components/code';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { plugins, type Export, type GeneSlot, type Look, type Plugin } from '@/lib/catalog';
import { Back, Badges, Block, CatalogPage, Draws, Figure, Paragraphs, Still } from '@/sections/catalog';
import { Heading } from '@/sections/heading';
import { body } from '@/sections/shared';

type Params = { slug: string };

export const dynamicParams = false;

export function generateStaticParams(): Params[] {
  return plugins.map((p) => ({ slug: p.slug }));
}

export async function generateMetadata(props: { params: Promise<Params> }): Promise<Metadata> {
  const { slug } = await props.params;
  const p = plugins.find((x) => x.slug === slug);
  if (!p) return {};
  return { title: `${p.title} plugin | Kinetograph`, description: p.description };
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
            <TableCell className="align-top leading-[1.5] whitespace-normal">{r.doc || <span className="text-mute">{r.type}</span>}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

const GROUPS: { kind: Export['kind']; title: string; note: string }[] = [
  { kind: 'component', title: 'Components', note: 'Drawn as JSX inside a composition.' },
  { kind: 'effect', title: 'Effects', note: 'Layer effects: put them in a layer\u2019s effects.' },
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

/** Components, effects, functions and constants, each as the source describes it. Constants without a line are one list. */
function Exports({ items }: { items: Export[] }) {
  return (
    <>
      {GROUPS.map((g) => {
        const rows = items.filter((e) => e.kind === g.kind);
        if (rows.length === 0) return null;
        const plain = g.kind === 'constant' ? rows.filter((e) => !e.summary) : [];
        const described = rows.filter((e) => !plain.includes(e));
        return (
          <div key={g.kind} className="space-y-4">
            <h3 className="font-dm text-[18px] font-bold tracking-[-0.02em] text-ink">{g.title}</h3>
            {g.note && <p className={`${body} max-w-[68ch]`}>{g.note}</p>}
            {described.map((e) => (
              <Doc key={e.name} e={e} />
            ))}
            {plain.length > 0 && (
              <p className="border-t border-ink/15 pt-5 font-jb text-[13px] leading-[1.8] text-ink/80">{plain.map((e) => e.name).join('  ')}</p>
            )}
          </div>
        );
      })}
    </>
  );
}

function Genes({ slots }: { slots: GeneSlot[] }) {
  return (
    <>
      {slots.map((s) => (
        <div key={s.slot} className="space-y-3 border-t border-ink/15 pt-5">
          <h3 className="font-jb text-[16px] font-medium text-ink">
            {s.slot} <span className="text-mute">({s.genes.length})</span>
          </h3>
          {s.note && <p className={`${body} max-w-[68ch]`}>{s.note}</p>}
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Gene</TableHead>
                <TableHead>What it does</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {s.genes.map((g) => (
                <TableRow key={g.id}>
                  <TableCell className="align-top font-jb text-[13px]">{g.id}</TableCell>
                  <TableCell className="align-top leading-[1.5] whitespace-normal">{g.note}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ))}
    </>
  );
}

function Looks({ looks }: { looks: Look[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Look</TableHead>
          <TableHead>Drawn by</TableHead>
          <TableHead>What it does</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {looks.map((l) => (
          <TableRow key={l.kind}>
            <TableCell className="align-top font-jb text-[13px]">{l.kind}</TableCell>
            <TableCell className="align-top font-jb text-[13px]">{l.uses || '-'}</TableCell>
            <TableCell className="align-top leading-[1.5] whitespace-normal">{l.summary}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
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

export default async function PluginPage(props: { params: Promise<Params> }) {
  const { slug } = await props.params;
  const p = plugins.find((x) => x.slug === slug);
  if (!p) notFound();
  const studio = p.studio;
  const hasStudio = studio !== null && (studio.panel || studio.tools.length > 0 || studio.note);
  const demos = p.demos;

  return (
    <CatalogPage>
      <Back href="/plugins/">All plugins</Back>
      <Heading as="h1" lines={[p.title]} hot={p.title.split(' ')[0]} tag="PLUGIN  1.00" className="text-[clamp(36px,4.2vw,56px)]" />
      <p className={`${body} mt-6 max-w-[62ch]`}>{p.description}</p>
      <div className="mt-4 space-y-3">
        <Draws names={p.components} />
        <Badges panel={p.hasPanel} tools={p.hasTools} skill={p.hasSkill} />
        <p className="text-[14px] text-mute">Coming; not published yet.</p>
      </div>
      {p.hero && (
        <div className="mt-10">
          <Figure image={p.hero} alt={`${p.title}, a frame from its demo`} />
        </div>
      )}

      <Block id="what" title="What it does">
        <Paragraphs items={p.about} />
        {p.stills.length > 0 && (
          <div className="mt-8 grid gap-6 sm:grid-cols-2">
            {p.stills.map((s) => (
              <Figure key={s.src} image={s} alt={s.caption ?? p.title} caption={s.caption} />
            ))}
          </div>
        )}
      </Block>

      {p.exports.length > 0 && (
        <Block id="exports" title="What it exports">
          <Exports items={p.exports} />
        </Block>
      )}

      {p.genes && (
        <Block id="genes" title="Genes by slot">
          <p className={`${body} max-w-[68ch]`}>
            Each slot holds one gene. Lock a slot to keep its gene, or leave it to the seed.
          </p>
          <Genes slots={p.genes} />
        </Block>
      )}

      {p.looks && (
        <Block id="looks" title="Looks">
          <p className={`${body} max-w-[68ch]`}>The look kinds the Studio panel can switch between, and the export that draws each.</p>
          <Looks looks={p.looks} />
        </Block>
      )}

      {p.stocks && (
        <Block id="paper-lists" title="Stocks, edges and layouts">
          <PaperLists p={p} />
        </Block>
      )}

      {p.faces && (
        <Block id="faces" title="Faces">
          <Names title="Handwritten, mixed a letter at a time" items={p.faces.hands} />
          <Names title="Display, for key words" items={p.faces.display} />
        </Block>
      )}

      {p.presets.length > 0 && (
        <Block id="presets" title="Presets">
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
        <Block id="examples" title="Examples">
          {p.examples.map((e) => (
            <CodeBlock key={e.title} title={e.title} code={e.code} />
          ))}
        </Block>
      )}

      {hasStudio && studio && (
        <Block id="studio" title="In Studio">
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
              {d.stills.length > 0 && (
                <div className="grid gap-6 sm:grid-cols-2">
                  {d.stills.map((s) => (
                    <Figure key={s.src} image={s} alt={s.caption ?? d.title} caption={s.caption} />
                  ))}
                </div>
              )}
            </div>
          ))}
        </Block>
      )}
    </CatalogPage>
  );
}
