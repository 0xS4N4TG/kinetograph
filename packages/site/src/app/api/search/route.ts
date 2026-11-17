import { findPath } from 'fumadocs-core/page-tree';
import { createSearchAPI } from 'fumadocs-core/search/server';

import { pluginPages, source } from '@/lib/source';

export const revalidate = false;

/** The folders a docs page sits in, as the search result's breadcrumb (the same as `createFromSource` makes). */
function docsBreadcrumbs(url: string) {
  const tree = source.getPageTree();
  const path = findPath(tree.children, (node) => node.type === 'page' && node.url === url);
  if (!path) return undefined;
  path.pop();
  return [tree.name, ...path.map((n) => n.name)].filter((n): n is string => typeof n === 'string' && n.length > 0);
}

/**
 * Static export: the search index is written to out/api/search at build time and queried in the browser. It holds the docs
 * pages and the plugins' catalog pages, which is where each plugin's features are now.
 */
export const GET = createSearchAPI('advanced', {
  indexes: [
    ...source.getPages().map((page) => ({ page, breadcrumbs: docsBreadcrumbs(page.url) })),
    ...pluginPages.getPages().map((page) => ({ page, breadcrumbs: ['Catalog', 'Plugins'] })),
  ].map(({ page, breadcrumbs }) => ({
    id: page.url,
    title: page.data.title,
    description: page.data.description,
    url: page.url,
    breadcrumbs,
    structuredData: page.data.structuredData,
  })),
}).staticGET;
