import { Redirect } from '@/components/redirect';
import { movedTo } from '@/lib/library';

const to = '/catalog/plugin-paper/';

export const metadata = movedTo(to);

/** The old plugin guide of paper, removed from the docs: its page is in the catalog. */
export default function Page() {
  return <Redirect to={to} />;
}
