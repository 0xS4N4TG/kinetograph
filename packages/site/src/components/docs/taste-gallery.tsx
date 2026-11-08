import Link from 'next/link';

import { Media } from '@/components/docs/media';
import { tastes } from '@/lib/catalog';

/**
 * A gallery of every taste in the catalog: its demo reel as a short silent loop (public/docs-media/tastes/<id>.mp4, with
 * a .webp poster) and its name linking to its page. Two columns on a phone, four from the `sm` width up.
 *
 * ```mdx
 * <TasteGallery />
 * ```
 */
export function TasteGallery() {
  return (
    <div className="not-prose my-6 grid grid-cols-2 gap-x-3 gap-y-6 sm:grid-cols-4">
      {tastes.map((t) => (
        <div key={t.id} className="min-w-0">
          <div className="[&>figure]:my-0">
            <Media src={`tastes/${t.id}.mp4`} poster={`tastes/${t.id}.webp`} width={360} height={640} alt={`A four second loop of the ${t.title} taste's demo reel: ${t.description}`} />
          </div>
          <Link href={`/tastes/${t.id}/`} className="mt-2 block text-sm font-medium text-fd-foreground hover:underline">
            {t.title}
          </Link>
        </div>
      ))}
    </div>
  );
}
