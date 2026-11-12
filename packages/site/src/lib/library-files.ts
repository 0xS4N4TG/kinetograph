import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { plugins } from './catalog';
import { pluginSlug, type Item } from './library-core';

export interface Step {
  text: string;
  code?: string;
}

type Registry = { files: { path: string; target: string; content?: string }[] };
const registry = (name: string) => JSON.parse(readFileSync(join(process.cwd(), 'public/r', `${name}.json`), 'utf8')) as Registry;

const RENDER = 'npx kinetograph render src/index.tsx -o out/video.mp4';

/**
 * The by-hand steps of an item, as the installer sets them up (packages/cli/src/registry/install.ts): where it lands, how
 * to use it and how to render. The component's tag is the first export that reads as a component, from its registry file.
 */
export function manualSteps(item: Item): Step[] {
  if (item.type === 'plugin') {
    const plugin = plugins.find((p) => p.slug === pluginSlug(item))!;
    return [
      { text: 'Run this in your project folder.', code: `npm install ${plugin.name}` },
      { text: 'The package goes in `node_modules/` and is listed in your `package.json` dependencies. `npx kinetograph plugins` lists it with its skill.' },
      { text: 'Import it in a scene and use it.', code: plugin.examples[0]?.code },
      { text: 'Render the video.', code: RENDER },
    ];
  }
  const add = { text: 'Run this in your project folder.', code: `npx kinetograph add ${item.name}` };
  const files = registry(item.name).files;
  if (item.type === 'template') {
    const entry = `src/templates/${item.name}/index.tsx`;
    return [
      add,
      { text: `It lands in \`src/templates/${item.name}/\`, with any media in \`public/\`.` },
      { text: 'It registers its own composition, so you can look at a frame as it is.', code: `npx kinetograph still ${entry} 0` },
      { text: 'Render it.', code: `npx kinetograph render ${entry} -o out/${item.name}.mp4` },
    ];
  }
  if (item.type === 'taste') {
    const note = files.find((f) => /(^|\/)TASTE\.md$/.test(f.path))?.target ?? `src/tastes/${item.name}/`;
    return [
      add,
      { text: `It lands in \`src/tastes/${item.name}/\`.` },
      { text: `Tell your agent to read \`${note}\` before it makes a video in this taste.` },
      { text: 'Render the video it makes.', code: RENDER },
    ];
  }
  const source = files.find((f) => f.path === 'index.tsx')?.content ?? '';
  const tag = [...source.matchAll(/^export\s+(?:declare\s+)?(?:const|function|class)\s+([A-Z][a-z]\w*)/gm)][0]?.[1] ?? 'Component';
  return [
    add,
    { text: `It lands in \`src/components/${item.name}/\`.` },
    { text: 'Import it in a file under `src/scenes/` and draw it. Every prop has a default.', code: `import { ${tag} } from '../components/${item.name}';\n\n<${tag} />` },
    { text: 'Render the video.', code: RENDER },
  ];
}
