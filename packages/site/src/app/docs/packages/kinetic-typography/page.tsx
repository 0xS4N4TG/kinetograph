import { Redirect } from '@/components/redirect';
import { movedTo } from '@/lib/library';

const to = '/catalog/plugin-kinetic-typography/';

export const metadata = movedTo(to);

/** The old package page of kinetic-typography, removed from the docs: its page is in the catalog. */
export default function Page() {
  return <Redirect to={to} />;
}
