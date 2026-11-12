import type { Metadata } from 'next';

import { Redirect } from '@/components/redirect';
import { movedTo } from '@/lib/library';

const to = '/catalog/?c=templates';

export const metadata: Metadata = movedTo(to);

/** The old /templates/ address: the catalog filtered to templates. */
export default function Page() {
  return <Redirect to={to} />;
}
