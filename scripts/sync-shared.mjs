#!/usr/bin/env node
// Vendors sf-shared/lib into every skill's scripts/lib so each skill folder is self-contained.
// Usage: node scripts/sync-shared.mjs [--check]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(repo, 'sf-shared', 'lib');
const skills = fs.readdirSync(repo).filter((d) => d.startsWith('sf-') && fs.existsSync(path.join(repo, d, 'SKILL.md')));
const check = process.argv.includes('--check');
const files = fs.readdirSync(src).filter((f) => f.endsWith('.mjs'));
const banner = '// GENERATED COPY of sf-shared/lib — edit sf-shared/lib and run `npm run sync`.\n';
let drift = 0;

for (const skill of skills) {
  const dest = path.join(repo, skill, 'scripts', 'lib');
  fs.mkdirSync(dest, { recursive: true });
  for (const f of files) {
    const want = banner + fs.readFileSync(path.join(src, f), 'utf8');
    const target = path.join(dest, f);
    const have = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
    if (have !== want) {
      drift++;
      if (!check) fs.writeFileSync(target, want);
      else console.error(`out of sync: ${path.relative(repo, target)}`);
    }
  }
  for (const f of fs.readdirSync(dest)) {
    if (!files.includes(f)) {
      drift++;
      if (!check) fs.unlinkSync(path.join(dest, f));
      else console.error(`stale file: ${skill}/scripts/lib/${f}`);
    }
  }
}
if (check) process.exit(drift ? 1 : 0);
console.log(`synced sf-shared/lib into ${skills.length} skill(s); ${drift} file(s) updated`);
