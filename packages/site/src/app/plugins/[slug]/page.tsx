import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { CodeBlock } from '@/components/code';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { plugins, type ComponentDoc } from '@/lib/catalog';
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

function Props({ rows }: { rows: [string, string][] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Prop</TableHead>
          <TableHead>What it does</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map(([name, text]) => (
          <TableRow key={name}>
            <TableCell className="align-top font-jb text-[13px]">{name}</TableCell>
            <TableCell className="align-top leading-[1.5] whitespace-normal">{text}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function Doc({ doc }: { doc: ComponentDoc }) {
  return (
    <div className="space-y-3 border-t border-ink/15 pt-5">
      <h3 className="font-jb text-[16px] font-medium text-ink">{doc.kind === 'component' ? `<${doc.name} />` : doc.name}</h3>
      <p className={`${body} max-w-[68ch]`}>{doc.summary}</p>
      {doc.props.length > 0 && <Props rows={doc.props} />}
      {doc.after && <p className={`${body} max-w-[68ch]`}>{doc.after}</p>}
    </div>
  );
}

export default async function PluginPage(props: { params: Promise<Params> }) {
  const { slug } = await props.params;
  const p = plugins.find((x) => x.slug === slug);
  if (!p) notFound();
  const studio = p.studio;
  const hasStudio = studio !== null && (studio.panel || studio.tools.length > 0 || studio.note);
  const components = p.componentDocs.filter((d) => d.kind === 'component');
  const looks = p.componentDocs.filter((d) => d.kind === 'look');
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
      </Block>

      {(components.length > 0 || looks.length > 0) && (
        <Block id="components" title="Components">
          {components.map((d) => (
            <Doc key={d.name} doc={d} />
          ))}
          {looks.length > 0 && (
            <>
              <p className={`${body} max-w-[68ch]`}>Looks are layer effects: put them in a layer&rsquo;s effects.</p>
              {looks.map((d) => (
                <Doc key={d.name} doc={d} />
              ))}
            </>
          )}
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
