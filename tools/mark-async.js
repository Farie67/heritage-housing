'use strict';

/* Safety net for the async migration.

   The codemod's brace matcher cannot follow every template literal, so a
   function that awaits can occasionally be missed. This runs `node --check`,
   reads the exact line Node objects to, walks back to the enclosing function
   and marks it async — repeating until the file parses.

   Usage: node tools/mark-async.js <file> [<file> ...]                    */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

/* Lines that look like a declaration but are control flow. */
const NOT_A_FUNCTION = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'do', 'else', 'return',
  'typeof', 'delete', 'void', 'new', 'in', 'of', 'case', 'default',
  'try', 'finally', 'with', 'yield', 'await', 'throw', 'import', 'export'
]);

function syntaxErrorLine(file) {
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (r.status === 0) return null;
  const out = (r.stderr || '') + (r.stdout || '');
  const m = new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':(\\d+)').exec(out);
  if (!m) return null;
  if (!/await is only valid in async/.test(out)) return { line: Number(m[1]), fatal: true, out };
  return { line: Number(m[1]) };
}

function markAsync(file) {
  let applied = 0;

  for (let pass = 0; pass < 300; pass++) {
    const err = syntaxErrorLine(file);
    if (!err || err.fatal) return { applied, error: err };

    const lines = fs.readFileSync(file, 'utf8').split('\n');
    const target = err.line - 1;
    let hit = -1;
    let kind = '';

    for (let i = target; i >= 0; i--) {
      const l = lines[i];
      if (/\basync\b/.test(l)) continue;
      const t = l.trim();
      if (t === '' || t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue;

      /* A named function or method: `function f(`  /  `name(args) {` */
      const named = /^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/.exec(l);
      const method = /^\s{2,}([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{?\s*$/.exec(l);
      const methodOpen = /^\s{2,}([A-Za-z_$][\w$]*)\s*\(/.exec(l);
      const arrowEq = /^\s*(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*(?:async\s*)?\(/.exec(l);
      const propArrow = /^\s{2,}[A-Za-z_$][\w$]*\s*:\s*\(/.exec(l);

      if (named && !NOT_A_FUNCTION.has(named[1])) { hit = i; kind = 'function'; break; }
      if (method && !NOT_A_FUNCTION.has(method[1])) { hit = i; kind = 'method'; break; }
      if (methodOpen && !NOT_A_FUNCTION.has(methodOpen[1]) && !/\)/.test(l)) { hit = i; kind = 'method'; break; }
      if (arrowEq) { hit = i; kind = 'arrow'; break; }
      if (propArrow) { hit = i; kind = 'arrow'; break; }
    }

    if (hit < 0) return { applied, error: { line: err.line, stuck: true } };

    const l = lines[hit];
    if (kind === 'function') lines[hit] = l.replace(/^(\s*)function\s/, '$1async function ');
    else if (kind === 'arrow') lines[hit] = l.replace(/=\s*\(/, '= async (').replace(/:\s*\(/, ': async (');
    else lines[hit] = l.replace(/^(\s{2,})/, '$1async ');

    fs.writeFileSync(file, lines.join('\n'), 'utf8');
    applied++;
  }
  return { applied, error: { stuck: true } };
}

let total = 0;
for (const arg of process.argv.slice(2)) {
  const file = path.resolve(arg);
  const before = fs.readFileSync(file, 'utf8');
  if (syntaxErrorLine(file) === null) { console.log(`  ${path.basename(file)}: already parses`); continue; }
  const r = markAsync(file);
  total += r.applied;
  const ok = syntaxErrorLine(file) === null;
  console.log(`  ${path.basename(file)}: +${r.applied} async  ${ok ? 'parses' : 'STILL FAILING'}`);
  if (!ok) {
    const err = syntaxErrorLine(file);
    console.log(`    line ${err.line}${err.fatal ? ' (fatal)' : ''}`);
  }
}
console.log(`  total marked async: ${total}`);
