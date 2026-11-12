import type { Metadata } from 'next';

import { Redirect } from '@/components/redirect';
import { movedTo } from '@/lib/library';

const to = '/catalog/?c=tastes';

export const metadata: Metadata = movedTo(to);

/** The old /tastes/ address: the catalog filtered to tastes. */
export default function Page() {
  return <Redirect to={to} />;
}
