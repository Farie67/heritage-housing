'use strict';

/* Static check: is every `views.adminLayout(` / `views.renderLogin(` call site
   inside an async function? Needed before adding `await`, because `await` in a
   non-async function is a syntax error.

   This parses nothing and runs no server or test — it walks the file text. */

const fs = require('node:fs');
const path = require('node:path');

const file = path.resolve(process.argv[2]);
const lines = fs.readFileSync(file, 'utf8').split('\n');

const CALL = /views\.(adminLayout|renderLogin)\(/;
const NOT_A_FUNCTION = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'do', 'else', 'return',
  'typeof', 'delete', 'void', 'new', 'in', 'of', 'case', 'default',
  'try', 'finally', 'with', 'yield', 'await', 'throw'
]);

let checked = 0;
let bad = 0;

for (let i = 0; i < lines.length; i++) {
  const m = CALL.exec(lines[i]);
  if (!m) continue;
  checked++;

  /* Walk back to the nearest function declaration and report its async-ness. */
  let found = null;
  for (let j = i; j >= 0; j--) {
    const l = lines[j];
    const named = /^\s*(async\s+)?function\s+([A-Za-z_$][\w$]*)/.exec(l);
    if (named) { found = { line: j + 1, name: named[2], async: Boolean(named[1]) }; break; }
    const method = /^\s{2,}(async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/.exec(l);
    if (method && !NOT_A_FUNCTION.has(method[2])) {
      found = { line: j + 1, name: method[2], async: Boolean(method[1]) };
      break;
    }
  }

  if (!found) {
    console.log(`  line ${i + 1}: NO ENCLOSING FUNCTION FOUND`);
    bad++;
  } else if (!found.async) {
    console.log(`  line ${i + 1}: enclosing ${found.name}() at line ${found.line} is NOT async`);
    bad++;
  }
}

console.log(`  ${m_name(file)}: ${checked} call site(s), ${bad} not inside an async function`);
function m_name(p) { return path.basename(p); }
process.exitCode = bad ? 1 : 0;
