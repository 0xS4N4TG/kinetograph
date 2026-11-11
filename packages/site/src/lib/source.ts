import { loader } from 'fumadocs-core/source';
import { catalog, docs } from 'collections/server';
import { Clapperboard, MonitorPlay, ScrollText, Terminal } from 'lucide-react';
import { createElement } from 'react';

const icons = { Clapperboard, MonitorPlay, ScrollText, Terminal };

export const source = loader({
  baseUrl: '/docs',
  source: docs.toFumadocsSource(),
  icon(name) {
    if (name && name in icons) return createElement(icons[name as keyof typeof icons]);
  },
});

/** The plugins' catalog pages: one MDX file each, `plugin-<slug>` under /catalog. */
export const pluginPages = loader({
  baseUrl: '/catalog',
  source: catalog.toFumadocsSource(),
});
