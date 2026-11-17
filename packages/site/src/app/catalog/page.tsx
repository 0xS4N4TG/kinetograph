import { DocsPage } from 'fumadocs-ui/layouts/docs/page';
import type { Metadata } from 'next';
import { Suspense } from 'react';

import { Browser } from '@/components/library/browser';
import { groups, items } from '@/lib/library';

export const metadata: Metadata = {
  title: 'Catalog | Kinetograph',
  description: `${items.length} templates, components, plugins and tastes for Kinetograph videos. Watch each one play, then add it with one command.`,
};

export default function CatalogIndex() {
  return (
    <DocsPage toc={[]} footer={{ enabled: false }} className="max-w-[1480px]">
      <Suspense fallback={null}>
        <Browser items={items} groups={groups} />
      </Suspense>
    </DocsPage>
  );
}
