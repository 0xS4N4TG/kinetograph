import { createFromSource } from 'fumadocs-core/search/server';

import { source } from '@/lib/source';

export const revalidate = false;

/** Static export: the search index is written to out/api/search at build time and queried in the browser. */
export const GET = createFromSource(source).staticGET;
