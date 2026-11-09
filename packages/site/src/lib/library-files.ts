import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Where `npx kinetograph add <name>` puts each file of an item, read from the item's registry JSON at build time. */
export function itemFiles(name: string): string[] {
  const file = join(process.cwd(), 'public/r', `${name}.json`);
  return (JSON.parse(readFileSync(file, 'utf8')) as { files: { target: string }[] }).files.map((f) => f.target);
}
