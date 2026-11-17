import { redirect } from 'next/navigation';

/** The old Components and templates page. A static export has no server redirects, so this page redirects in the browser and shows nothing. */
export default function Page() {
  redirect('/docs/library/use-an-item/');
}
