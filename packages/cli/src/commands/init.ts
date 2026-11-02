import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { CliError } from '../errors.js';
import type { Command } from './types.js';

const TITLE_SCENE = `import { AbsoluteFill, Rect, Text, interpolate, useCurrentFrame } from '@kinetographdev/core';
import { loadFont } from '@remotion/google-fonts/Inter';

const { fontFamily } = loadFont('normal', { weights: ['400'] });

export const Title = () => {
  const frame = useCurrentFrame();
  const width = interpolate(frame, [0, 30], [0, 640], { extrapolateRight: 'clamp' });
  return (
    <AbsoluteFill style={{ backgroundColor: '#14171f' }}>
      <Text x={320} y={200} font={fontFamily} size={96} color="#ffffff">
        Hello, Kinetograph
      </Text>
      <Rect x={320} y={340} width={width} height={12} radius={6} fill="#f6c177" />
    </AbsoluteFill>
  );
};
`;

const INDEX_TSX = `import { Composition, registerRoot } from '@kinetographdev/core';
import { Title } from './scenes/Title';

registerRoot(() => (
  <Composition id="Main" component={Title} durationInFrames={60} fps={30} width={1280} height={720} />
));
`;

const GOOGLE_FONTS_DTS = `// \`@remotion/google-fonts/<Family>\` is made by the kinetograph CLI when it bundles the project, so the type checker
// finds no file for it. This declares the part the starter uses.
declare module '@remotion/google-fonts/*' {
  export function loadFont(
    style?: string,
    options?: { weights?: string[]; subsets?: string[] },
  ): { fontFamily: string };
  export const fontFamily: string;
}
`;

const INDEX_HTML = `<!doctype html>
<html>
<head>
<style>
  body { margin: 0; background: #14171f; font-family: Inter; }
  #title { position: absolute; left: 320px; top: 200px; color: #fff; font-size: 96px; }
  #bar { position: absolute; left: 320px; top: 340px; height: 12px; width: 0; border-radius: 6px; background: #f6c177; }
</style>
<script src="https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/gsap.min.js"></script>
</head>
<body>
<div id="root" data-composition-id="main" data-width="1280" data-height="720" data-duration="2">
  <div id="title">Hello, Kinetograph</div>
  <div id="bar"></div>
</div>
<script>
  const tl = gsap.timeline({ paused: true });
  tl.to('#bar', { width: 640, duration: 1, ease: 'none' });
  window.__timelines = { main: tl };
</script>
</body>
</html>
`;

const TSCONFIG = {
  compilerOptions: {
    target: 'ES2023',
    lib: ['ES2023', 'DOM'],
    module: 'ESNext',
    moduleResolution: 'Bundler',
    jsx: 'react-jsx',
    strict: true,
    esModuleInterop: true,
    skipLibCheck: true,
    isolatedModules: true,
    verbatimModuleSyntax: true,
    forceConsistentCasingInFileNames: true,
    noEmit: true,
  },
  include: ['src'],
};

const GITIGNORE = 'node_modules/\nout/\n';

const ASSET_FOLDERS = ['images', 'fonts', 'audio', 'video'];

function version(): string {
  return (createRequire(import.meta.url)('../../package.json') as { version: string }).version;
}

/** A valid npm package name from a folder name. */
function packageName(dir: string): string {
  const name = basename(dir).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-._]+|-+$/g, '');
  return name === '' ? 'my-video' : name;
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

export const init: Command = {
  name: 'init',
  summary: 'Create the standard project folders and a starter (src/, public/, out/; html/ with --html) in a directory',
  project: false,
  positionals: [{ name: 'dir', description: 'The project folder, made if it does not exist (default: the current directory)', optional: true }],
  options: [{ name: 'html', type: 'boolean', description: 'Start an HTML page (html/index.html) instead of a TSX project' }],
  async run(args) {
    const html = args.options.html === true;
    const dir = resolve(String(args.positionals.dir ?? '.'));
    if (existsSync(dir) && !statSync(dir).isDirectory()) throw new CliError('INVALID_ARG', `${dir} is a file, not a folder`);

    const entry = html ? 'html/index.html' : 'src/index.tsx';
    const files = new Map<string, string>();
    if (html) files.set('html/index.html', INDEX_HTML);
    else {
      files.set('src/index.tsx', INDEX_TSX);
      files.set('src/scenes/Title.tsx', TITLE_SCENE);
      files.set('src/google-fonts.d.ts', GOOGLE_FONTS_DTS);
      files.set('tsconfig.json', json(TSCONFIG));
    }
    files.set(
      'package.json',
      json({
        name: packageName(dir),
        private: true,
        type: 'module',
        scripts: {
          still: `kinetograph still ${entry} 15`,
          strip: `kinetograph strip ${entry}`,
          render: `kinetograph render ${entry}`,
          [html ? 'lint' : 'check']: `kinetograph ${html ? 'lint' : 'check'} ${entry}`,
        },
        dependencies: { kinetograph: version() },
        ...(html ? {} : { devDependencies: { '@types/react': '19.3.0' } }),
      }),
    );
    files.set('.gitignore', GITIGNORE);
    for (const folder of ASSET_FOLDERS) files.set(`public/${folder}/.gitkeep`, '');

    const folders = [...(html ? [] : ['src/components', 'src/lib']), 'out'];

    // A path that is a file where a folder is needed is refused before anything is written.
    for (const path of [...files.keys(), ...folders]) {
      for (let parent = dirname(join(dir, path)); parent !== dir && parent.startsWith(dir); parent = dirname(parent)) {
        if (existsSync(parent) && !statSync(parent).isDirectory()) throw new CliError('INVALID_ARG', `${parent} is a file, not a folder`);
      }
    }

    try {
      mkdirSync(dir, { recursive: true });
    } catch (error) {
      throw new CliError('INVALID_ARG', `cannot make ${dir}: ${(error as Error).message}`);
    }
    const created: string[] = [];
    const skipped: string[] = [];
    for (const [path, content] of files) {
      const file = join(dir, path);
      if (existsSync(file)) {
        skipped.push(path);
        continue;
      }
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content);
      created.push(path);
    }
    for (const folder of folders) mkdirSync(join(dir, folder), { recursive: true });

    const here = relative(process.cwd(), dir);
    const next = [
      ...(here === '' ? [] : [`cd ${here.startsWith('..') ? dir : here}`]),
      'npm install',
      `npx kinetograph still ${entry} 15     # out/stills/Main-f15.png`,
      `npx kinetograph strip ${entry}        # out/sheets/Main-strip.png`,
      `npx kinetograph render ${entry}       # out/renders/Main.mp4`,
    ];
    const lines = [
      `created ${created.length} file${created.length === 1 ? '' : 's'} in ${dir}`,
      ...(skipped.length > 0 ? [`skipped ${skipped.length} that already exist: ${skipped.join(', ')}`] : []),
      'next:',
      ...next.map((step) => `  ${step}`),
    ];
    return { data: { dir, entry, created, skipped, next }, text: lines.join('\n') };
  },
};
