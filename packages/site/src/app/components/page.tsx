import type { Metadata } from 'next';

import { Redirect } from '@/components/redirect';
import { movedTo } from '@/lib/library';

const to = '/catalog/?c=components';

export const metadata: Metadata = movedTo(to);

/** The old /components/ address: the catalog filtered to components. */
export default function Page() {
  return <Redirect to={to} />;
}
