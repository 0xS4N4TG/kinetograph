import { loader } from 'fumadocs-core/source';
import { docs } from 'collections/server';
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
