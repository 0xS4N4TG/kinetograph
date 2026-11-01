import { plugins } from '@/lib/catalog';
import { catalogFeed } from '@/lib/catalog-feed';

export const dynamic = 'force-static';

/** Static export: the plugin feed Studio reads is written to out/api/catalog at build time. */
export function GET() {
  return Response.json(catalogFeed(plugins));
}
