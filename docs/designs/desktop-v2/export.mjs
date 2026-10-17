// Run with: node docs/designs/desktop-v2/export.mjs
import { spawn } from 'node:child_process';
import { openSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
const require = createRequire(import.meta.url);
const directory = path.dirname(fileURLToPath(import.meta.url));
const preview = readFileSync(path.join(directory, 'index.html'), 'utf8')
  .replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
  .replace('<link rel="stylesheet" href="design.css">', () => '<style>' + readFileSync(path.join(directory, 'design.css'), 'utf8') + '</style>')
  .replace('<script src="design.js"></script>', () => '<script>' + readFileSync(path.join(directory, 'design.js'), 'utf8') + '</script>');
writeFileSync(path.join(directory, 'preview.html'), preview);
const logPath = path.join(os.tmpdir(), 'douli-design-export.log');
const log = openSync(logPath, 'w');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require('electron'), [path.join(directory, 'render.cjs')], {
  detached: true, windowsHide: true, stdio: ['ignore', log, log], env,
});
child.unref();
console.log(JSON.stringify({ pid: child.pid, logPath, output: directory }));
