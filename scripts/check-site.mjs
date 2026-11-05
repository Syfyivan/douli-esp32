import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const site = resolve(root, 'site');
const html = readFileSync(resolve(site, 'index.html'), 'utf8');
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
assert.equal(new Set(ids).size, ids.length, 'HTML IDs must be unique');
assert.equal((html.match(/<h1\b/g) || []).length, 1, 'Use one primary heading');
assert.match(html, /<html lang="zh-CN">/);
const references = [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map(m => m[1]);
for (const ref of references) {
  if (ref.startsWith('#')) assert.ok(ids.includes(ref.slice(1)), `Missing section: ${ref}`);
  else if (ref.startsWith('./')) {
    const file = resolve(site, ref);
    assert.ok(file.startsWith(site + sep) && existsSync(file), `Missing asset: ${ref}`);
  } else assert.ok(ref.startsWith('https://github.com/Syfyivan/douli-esp32'), `Unexpected external reference: ${ref}`);
}
for (const doc of ['README.md', 'docs/AI_GUIDE.md', 'docs/WEBSITE.md']) {
  const file = resolve(root, doc), text = readFileSync(file, 'utf8');
  for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
    const target = match[1].split('#')[0];
    if (!target || /^https?:/.test(target)) continue;
    assert.ok(existsSync(resolve(dirname(file), target)), `Broken ${doc} link: ${target}`);
  }
}
function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(resolve(directory, entry.name)) : [resolve(directory, entry.name)]);
}
const assets = files(site);
for (const file of assets) assert.ok(/\.(html|css|js|svg)$/.test(file), `Unapproved public file: ${file}`);
const bytes = assets.reduce((total, file) => total + statSync(file).size, 0);
assert.ok(bytes < 150000, `Static site exceeds the 150 KB source budget: ${bytes}`);
console.log(`Website check passed: ${assets.length} files, ${bytes} bytes; assets, anchors and documentation links valid.`);
