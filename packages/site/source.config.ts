import { defineDocs } from 'fumadocs-mdx/config';

export const docs = defineDocs({
  dir: 'content/docs',
  // VIDEOS.md is the clip list for whoever records the videos; it is not a docs page.
  docs: { files: ['**/*.mdx'], postprocess: { includeProcessedMarkdown: true } },
});

// The long-form text of each plugin's catalog page (content/catalog/plugin-<slug>.mdx), served at /catalog/plugin-<slug>/.
export const catalog = defineDocs({
  dir: 'content/catalog',
  docs: { files: ['**/*.mdx'], postprocess: { includeProcessedMarkdown: true } },
});
