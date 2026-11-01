// The public plugin feed at /api/catalog: what Kinetograph Studio reads to list plugins a project does not have yet.
// One function builds it, from the same catalog the plugin pages are drawn from. The route emits it at build time, and
// packages/studio/scripts/sync-catalog.mjs runs it to write the copy bundled into Studio, so there is one source of
// truth. This file imports nothing from the app (the script loads it with Node's type stripping) and uses no syntax
// that stripping cannot erase.

/** The site's address: a plugin's page is `${SITE_URL}/plugins/<slug>/`. */
export const SITE_URL = 'https://kinetograph.dev';

/** What the feed reads from a catalog plugin. The catalog may add `icon`, `version` and `published` later. */
export interface CatalogSource {
  slug: string;
  name: string;
  title: string;
  description: string;
  /** An absolute URL of the plugin's icon. */
  icon?: string;
  version?: string;
  /** True once the package is on npm. Absent means not published. */
  published?: boolean;
}

export interface CatalogFeedPlugin {
  /** The npm package name. */
  name: string;
  slug: string;
  title: string;
  description: string;
  icon?: string;
  version?: string;
  /** Whether the package is on npm. Studio offers to add a plugin only when this is true. */
  published: boolean;
  /** The plugin's page on the site. */
  url: string;
}

export interface CatalogFeed {
  version: 1;
  plugins: CatalogFeedPlugin[];
}

/** The feed for a list of catalog plugins: only the fields above, in the catalog's order, with nothing time-dependent in it. */
export function catalogFeed(plugins: readonly CatalogSource[], siteUrl: string = SITE_URL): CatalogFeed {
  const base = siteUrl.replace(/\/+$/, '');
  return {
    version: 1,
    plugins: plugins.map((p) => ({
      name: p.name,
      slug: p.slug,
      title: p.title,
      description: p.description,
      ...(p.icon ? { icon: p.icon } : {}),
      ...(p.version ? { version: p.version } : {}),
      published: p.published === true,
      url: `${base}/plugins/${p.slug}/`,
    })),
  };
}
