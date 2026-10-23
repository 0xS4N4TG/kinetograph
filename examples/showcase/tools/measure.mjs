// Measures the strings that widths.ts lists, with the addon's own text engine
// (the one that draws them):
//   node examples/showcase/tools/measure.mjs
// Run a `still` first so the fonts are in ~/.cache/kinetograph/fonts.
import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { layoutText } = require('@kinetographdev/native');
const dir = join(homedir(), '.cache', 'kinetograph', 'fonts');
const files = readdirSync(dir).filter((f) => f.endsWith('.ttf'));
const find = (suffix) => join(dir, files.find((f) => f.endsWith(suffix)));
const FONTS = {
  'Inter:400': find('UcCO3FwrK3iLTeHuS_nVMrMxCp50SjIw2boKoduKmMEVuLyfMZg.ttf'),
  'Inter:500': find('UcCO3FwrK3iLTeHuS_nVMrMxCp50SjIw2boKoduKmMEVuI6fMZg.ttf'),
  'Inter:600': find('UcCO3FwrK3iLTeHuS_nVMrMxCp50SjIw2boKoduKmMEVuGKYMZg.ttf'),
  'Instrument Serif': find('jizBRFtNs2ka5fXjeivQ4LroWlx-2zI.ttf'),
};
const measure = (font, size, text) => Math.round(layoutText({ text, font, size, fonts: FONTS }).width * 10) / 10;

const jobs = JSON.parse(process.argv[2] ?? '[]');
const out = {};
for (const [name, font, size, text] of jobs) out[name] = measure(font, size, text);
console.log(JSON.stringify(out, null, 1));
