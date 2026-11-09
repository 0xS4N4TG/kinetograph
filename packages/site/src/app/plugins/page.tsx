import type { Metadata } from 'next';

import { Redirect } from '@/components/redirect';
import { CATEGORIES, movedTo } from '@/lib/library';

const to = '/catalog/?c=plugins';

export const metadata: Metadata = movedTo(to);

/** The old anchors of the library page: #templates, #components, #kind-tastes, #kind-<kind> and #plugins. */
const hashes: Record<string, string> = {
  templates: '/catalog/?c=templates',
  components: '/catalog/?c=components',
  'kind-tastes': '/catalog/?c=tastes',
  ...Object.fromEntries(CATEGORIES.filter((c) => c.parent).map((c) => [`kind-${c.id}`, `/catalog/?c=${c.id}`])),
};

/** The old /plugins/ address: the catalog filtered to plugins. */
export default function Page() {
  return <Redirect to={to} hashes={hashes} />;
}
