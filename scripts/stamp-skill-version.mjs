// Writes packages/cli/package.json's version into the `metadata.version` of every agent skill in packages/cli/skills, which the CLI's update
// notice compares with the installed copy. Run it with the release bump; packages/cli/test/update-notice.test.ts fails
// when the two differ.
import fs from 'node:fs';

const version = JSON.parse(fs.readFileSync('packages/cli/package.json', 'utf8')).version;
for (const name of fs.readdirSync('packages/cli/skills')) {
  const file = `packages/cli/skills/${name}/SKILL.md`;
  const text = fs.readFileSync(file, 'utf8');
  const next = text.replace(/^(metadata:\n  version: )"[^"]*"$/m, `$1"${version}"`);
  if (next === text && !text.includes(`version: "${version}"`)) throw new Error(`${file} has no metadata.version to update`);
  fs.writeFileSync(file, next);
  console.log(`${file}: ${version}`);
}
