// The registry item format (docs/registry.md): one JSON file per component, template or taste, served at
// `<registry>/<name>.json`, plus `<registry>/index.json`. The zod schemas here are the single source of the TypeScript
// types and of docs/registry-item.schema.json (a test keeps the two equal).

import { z } from 'zod';

export const ITEM_TYPES = ['component', 'template', 'taste'] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

/** The folder under `src/` each type installs into. */
export const TYPE_FOLDERS: Record<ItemType, string> = { component: 'components', template: 'templates', taste: 'tastes' };

/** The `public/` folders `kinetograph init` makes; an item's assets go in these, namespaced by item name. */
export const ASSET_KINDS = ['images', 'fonts', 'audio', 'video'] as const;

/** Where a registry item may write: nothing outside these top-level folders of the project. */
export const TARGET_ROOTS = ['src', 'public'] as const;

export const MAX_FILES = 200;

const NAME_PATTERN = '^[a-z][a-z0-9]*(-[a-z0-9]+)*$';
const PACKAGE_PATTERN = '^(@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*$';
// A version or range (`4.6.7`, `^1.2.0`, `>=1 <2`), never a URL, a git spec, a `file:` path or an alias.
const VERSION_PATTERN = '^[0-9A-Za-z^~<>=.*|+ -]{1,64}$';

export const isItemName = (name: string): boolean => name.length <= 64 && new RegExp(NAME_PATTERN).test(name);

/**
 * Why `path` is not a safe relative path, or undefined when it is: absolute paths, `..` and `.` segments, empty
 * segments, backslashes and control characters are all refused, so a path cannot name anything outside its folder.
 */
export function pathProblem(path: string): string | undefined {
  if (path === '') return 'is empty';
  if (path.length > 240) return 'is too long';
  if (/[\x00-\x1f\x7f\\]/.test(path)) return 'has a backslash or a control character';
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) return 'is an absolute path';
  for (const segment of path.split('/')) {
    if (segment === '..') return 'leaves the folder it is in ("..")';
    if (segment === '' || segment === '.') return 'has an empty or "." segment';
  }
  return undefined;
}

/** Why a file `target` is refused, or undefined: a safe relative path under `src/` or `public/`, not those folders themselves. */
export function targetProblem(target: string): string | undefined {
  const problem = pathProblem(target);
  if (problem !== undefined) return problem;
  const [root, ...rest] = target.split('/');
  if (!(TARGET_ROOTS as readonly string[]).includes(root!)) return `is outside ${TARGET_ROOTS.map((r) => `${r}/`).join(' and ')}`;
  if (rest.length === 0) return 'is a folder, not a file';
  return undefined;
}

const path = z.string().max(240).describe('Where the file sits inside the item, a relative path with no ".." or leading "/".');
const target = z
  .string()
  .max(240)
  .describe('Where it installs in the project: a relative path under src/ or public/ (src/components/<name>/index.tsx, public/images/<name>/logo.png).');

const itemFile = z.union([
  z.object({
    path,
    target,
    content: z.string().describe('The file text (UTF-8).'),
  }),
  z.object({
    path,
    target,
    url: z.string().max(2048).describe('Where a binary file (image, font, audio) is fetched from: https, or relative to this JSON file.'),
    sha256: z.string().regex(/^[0-9a-f]{64}$/).optional().describe('Hex SHA-256 of the file; when present the download is checked against it.'),
  }),
]);

const prop = z.object({
  name: z.string(),
  type: z.string().describe('The prop type as written in TypeScript.'),
  optional: z.boolean().optional(),
  doc: z.string().optional().describe('The description from `.describe()`.'),
});

export const registryItemSchema = z.object({
  $schema: z.string().optional(),
  name: z.string().max(64).regex(new RegExp(NAME_PATTERN)).describe('The id used in `kinetograph add <name>`: lowercase words joined by hyphens.'),
  type: z.enum(ITEM_TYPES),
  title: z.string().min(1).max(120),
  description: z.string().max(2000),
  kinetograph: z.string().regex(/^\d+\.\d+\.\d+$/).describe('The oldest kinetograph CLI that can use this item.'),
  dependencies: z
    .record(z.string().max(214).regex(new RegExp(PACKAGE_PATTERN)), z.string().regex(new RegExp(VERSION_PATTERN)))
    .optional()
    .describe('npm packages the item imports, with versions. Missing ones are installed after the person agrees.'),
  registryDependencies: z.array(z.string().max(64).regex(new RegExp(NAME_PATTERN))).max(20).optional().describe('Other registry items, installed first.'),
  files: z.array(itemFile).max(MAX_FILES),
  props: z.array(prop).optional().describe('The props summary shown in the catalog.'),
  access: z.enum(['free', 'paid']).optional().describe('Default "free". A "paid" item cannot be installed yet.'),
});

export type RegistryItem = z.infer<typeof registryItemSchema>;
export type RegistryFile = RegistryItem['files'][number];

export const registryIndexSchema = z.object({
  $schema: z.string().optional(),
  items: z.array(
    z.object({
      name: z.string().max(64).regex(new RegExp(NAME_PATTERN)),
      type: z.enum(ITEM_TYPES),
      title: z.string(),
      description: z.string(),
      access: z.enum(['free', 'paid']).optional(),
    }),
  ),
});

export type RegistryIndex = z.infer<typeof registryIndexSchema>;

/** The JSON Schema file for items (docs/registry-item.schema.json, served at `<registry>/schema.json`). */
export function itemJsonSchema(): object {
  return {
    ...z.toJSONSchema(registryItemSchema, { io: 'input' }),
    title: 'Kinetograph registry item',
    $id: 'https://kinetograph.dev/r/schema.json',
  };
}

/** The first problem with an item that the schema cannot say: unsafe paths, repeated targets. Undefined when it is fine. */
export function itemProblem(item: RegistryItem): string | undefined {
  const seen = new Set<string>();
  for (const file of item.files) {
    const where = `${item.name}: file "${file.path}"`;
    const inside = pathProblem(file.path);
    if (inside !== undefined) return `${where} has a path that ${inside}`;
    const out = targetProblem(file.target);
    if (out !== undefined) return `${item.name}: target "${file.target}" ${out}`;
    if (seen.has(file.target)) return `${item.name}: two files install to "${file.target}"`;
    seen.add(file.target);
  }
  return undefined;
}
