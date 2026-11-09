import type { Metadata } from 'next';

import { Browser } from '@/components/library/browser';
import { Frame } from '@/components/library/frame';
import { items } from '@/lib/library';

export const metadata: Metadata = {
  title: 'Catalog | Kinetograph',
  description: `${items.length} templates, components and tastes for Kinetograph videos. Watch each one play, then add it with one command.`,
};

export default function CatalogIndex() {
  return (
    <Frame>
      <Browser />
    </Frame>
  );
}
