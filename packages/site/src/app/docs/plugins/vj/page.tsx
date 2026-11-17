import { Redirect } from '@/components/redirect';
import { movedTo } from '@/lib/library';

const to = '/catalog/plugin-vj/';

export const metadata = movedTo(to);

/** The old plugin guide of vj, removed from the docs: its page is in the catalog. */
export default function Page() {
  return <Redirect to={to} />;
}
