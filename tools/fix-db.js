'use strict';

/* Targeted repairs to server/db.js.

   db.js is hand-maintained (its .bak is the pre-migration file), so a few spots
   the codemod cannot safely reach are fixed here instead. Each replacement is
   exact and asserted, so a silent miss is impossible. */

const fs = require('node:fs');
const path = require('node:path');

const file = path.resolve(process.argv[2] || 'server/db.js');
let src = fs.readFileSync(file, 'utf8');
let applied = 0;
const missed = [];

function replace(label, from, to, expect = 1) {
  const count = src.split(from).length - 1;
  if (count !== expect) { missed.push(`${label} (found ${count}, expected ${expect})`); return; }
  src = src.split(from).join(to);
  applied++;
}

/* 1. Site-settings URL rewrite — a bare prepare(...).run(...) with no await. */
replace('settings rewrite',
  "prepare('UPDATE site_settings SET value = ? WHERE key = ?').run(`/${row.value}`, key);",
  "await prepare('UPDATE site_settings SET value = ? WHERE key = ?').run(`/${row.value}`, key);");

/* 2. Multi-line `return prepare(...)` whose .all()/.get() sits on a later line. */
replace('return prepare multi-line',
  'return prepare(`',
  'return await prepare(`');

/* 3. Stands lookup inside deleteProject. */
replace('deleteProject stands',
  'const stands = prepare(`',
  'const stands = await prepare(`');

/* 4. updateStand — my early precedence regex grabbed `.toISOString` from inside
      the argument list and destroyed the call. */
replace('updateStand call',
  '    (await qUpdateStand.run(projectId, standNumber, sizeSqm, type, priceCents, status, imageUrl,\n'
  + '      currency, description, location, new Date()).toISOString(), id);',
  '    await qUpdateStand.run(projectId, standNumber, sizeSqm, type, priceCents, status, imageUrl,\n'
  + '      currency, description, location, new Date().toISOString(), id);');

/* 5. A stray `async` that an early fixer injected into a SQL string. */
replace('searchClients SQL',
  "        async AND (u.client_number LIKE ? ESCAPE '\\\\'",
  "        AND (u.client_number LIKE ? ESCAPE '\\\\'");

fs.writeFileSync(file, src, 'utf8');

console.log(`  ${path.basename(file)}: ${applied} repairs applied`);
if (missed.length) {
  console.log('  NOT MATCHED:');
  for (const m of missed) console.log('    - ' + m);
  process.exit(1);
}
