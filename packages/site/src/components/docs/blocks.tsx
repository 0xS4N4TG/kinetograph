import { Callout } from 'fumadocs-ui/components/callout';
import { Step as BaseStep } from 'fumadocs-ui/components/steps';
import type { ReactNode } from 'react';

import { LinkCard } from '@/components/docs/link-card';

/** A numbered step with a bold title, as `<Steps><Step title="Install">...</Step></Steps>`. */
export function Step({ title, children }: { title?: string; children?: ReactNode }) {
  return (
    <BaseStep>
      {title ? <p className="font-semibold">{title}</p> : null}
      {children}
    </BaseStep>
  );
}

/** A card that links to a page. `<Card title icon href>text</Card>`; see `LinkCard`. */
export function Card({ title, href, icon, children }: { title: string; href?: string; icon?: string; children?: ReactNode }) {
  return (
    <LinkCard title={title} href={href ?? '#'} icon={icon}>
      {children}
    </LinkCard>
  );
}

/** Cards side by side: `<CardGroup cols={2}>` with a `Card` for each. */
export function CardGroup({ cols = 2, children }: { cols?: 1 | 2 | 3; children?: ReactNode }) {
  const grid = cols === 3 ? 'sm:grid-cols-3' : cols === 2 ? 'sm:grid-cols-2' : '';
  return <div className={`grid grid-cols-1 gap-x-4 ${grid} [&>a]:my-2`}>{children}</div>;
}

/** A callout: `<Tip>` for advice, `<Note>` for something to know. */
export function Tip({ children }: { children?: ReactNode }) {
  return <Callout type="info" title="Tip">{children}</Callout>;
}
export function Note({ children }: { children?: ReactNode }) {
  return <Callout type="info" title="Note">{children}</Callout>;
}
export function Warning({ children }: { children?: ReactNode }) {
  return <Callout type="warn" title="Warning">{children}</Callout>;
}
