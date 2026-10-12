'use strict';

/* Adds the missing `await` before every `views.adminLayout(` and
   `views.renderLogin(` call, and prints the exact lines it changed.

   The two functions were made async because they resolve branding from the
   database. Both are called as `h.sendHtml(res, code, views.X({...}))`, so
   without the await the response body is the string "[object Promise]".

   Usage: node tools/add-admin-awaits.js <file> [--dry]                   */

const fs = require('node:fs');
const path = require('node:path');

const file = path.resolve(process.argv[2] || 'server/admin.js');
const dry = process.argv.includes('--dry');

/* The call is the third argument of sendHtml, not at the start of the line:
     h.sendHtml(res, 404, views.adminLayout({ ... }));
   so match the call itself and insert `await` immediately before it. */
const CALL = /(?<!await )\bviews\.(adminLayout|renderLogin)\(/;

const lines = fs.readFileSync(file, 'utf8').split('\n');
const changed = [];

for (let i = 0; i < lines.length; i++) {
  const before = lines[i];
  if (!CALL.test(before)) continue;
  const after = before.replace(CALL, 'await views.$1(');
  if (after === before) continue;
  lines[i] = after;
  changed.push(i + 1);
}

if (!dry) fs.writeFileSync(file, lines.join('\n'), 'utf8');

console.log(`  ${path.basename(file)}: ${changed.length} call site(s) ${dry ? 'would be' : ''} changed`);
console.log('  lines: ' + changed.join(', '));
process.exitCode = changed.length ? 0 : 1;
