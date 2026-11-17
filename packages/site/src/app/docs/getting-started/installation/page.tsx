import { redirect } from 'next/navigation';

/** The old Install page. A static export has no server redirects, so this page redirects in the browser and shows nothing. */
export default function Page() {
  redirect('/docs/getting-started/first-video/');
}
