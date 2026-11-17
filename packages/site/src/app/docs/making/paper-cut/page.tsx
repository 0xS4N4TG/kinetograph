import { redirect } from 'next/navigation';

/** The old paper-cut guide, removed from the docs. A static export has no server redirects, so this page redirects in the browser. It now goes to the Paper plugin's catalog page. */
export default function Page() {
  redirect('/catalog/plugin-paper/');
}
