import { redirect } from 'next/navigation';

/** The old glitch-effects guide, removed from the docs. A static export has no server redirects, so this page redirects in the browser. It now goes to the Datamosh page. */
export default function Page() {
  redirect('/docs/making-videos/datamosh/');
}
