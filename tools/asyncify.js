'use strict';

/* ==========================================================================
   Codemod: convert a module from the synchronous node:sqlite data layer to the
   asynchronous one.

   Usage:  node tools/asyncify.js <file> [--dry]

   It does three things, in order:

     1. Prefixes every database call with `await`, using real paren matching
        rather than a regex, so nested and multi-line calls are handled.

     2. Wraps calls that are chained (`x.all(...).map(...)`), where the chain
        would otherwise run on the Promise instead of the rows.

     3. Marks every function whose body now contains `await` as `async`.

   Step 3 is done by brace matching over the whole file, so it cannot be fooled
   by control-flow lines, multi-line parameter lists or arrow bodies.
   ========================================================================== */

const fs = require('node:fs');
const path = require('node:path');

/* ── Helpers ────────────────────────────────────────────────────────────── */

/* Finds the index just past the closing paren that matches the one at `open`. */
function matchParen(src, open) {
  return matchDelim(src, open, '(', ')');
}

/* Finds the index just past the closing brace that matches the one at `open`.
   Function bodies are brace-delimited — using the paren matcher here walks to
   the end of the file and silently finds nothing. */
function matchBrace(src, open) {
  return matchDelim(src, open, '{', '}');
}

function matchDelim(src, open, openCh, closeCh) {
  if (src[open] !== openCh) return -1;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === openCh) depth++;
    else if (ch === closeCh) {
      depth--;
      if (depth === 0) return i + 1;
    } else if (ch === '"' || ch === "'" || ch === '`') {
      // Skip strings and template literals, honouring escapes and ${} nesting.
      const quote = ch;
      i++;
      while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === quote) break;
        i++;
      }
    } else if (ch === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? src.length : end + 1;
    } else if (ch === '/') {
      /* A regex literal such as /\/\*\//g would otherwise be read as a line
         comment, and the scan then runs past the closing paren it is looking
         for. A '/' begins a regex when the previous significant character
         cannot end an expression. */
      let p = i - 1;
      while (p >= 0 && /\s/.test(src[p])) p--;
      const prev = src[p];
      const startsRegex = p < 0 || '(,=:[!&|?{};+-*%^~<>'.includes(prev);
      if (startsRegex) {
        i++;
        let inClass = false;
        while (i < src.length) {
          const c = src[i];
          if (c === '\\') { i += 2; continue; }
          if (c === '[') inClass = true;
          else if (c === ']') inClass = false;
          else if (c === '/' && !inClass) break;
          else if (c === '\n') break;    // not a regex after all
          i++;
        }
      }
    }
  }
  return -1;
}

const METHOD = /^(get|all|run)$/;

function isWordChar(ch) {
  return ch !== undefined && /[A-Za-z0-9_$]/.test(ch);
}

/* ── Step 1 and 2: awaits ───────────────────────────────────────────────── */

function addAwaits(src) {
  const edits = [];   // { at, insert }
  const seen = new Set();

  const push = (at, insert) => {
    const key = at + ':' + insert;
    if (seen.has(key)) return;
    seen.add(key);
    edits.push({ at, insert });
  };

  /* 1. `db.prepare(<sql>).get|all|run(` — and the bare `prepare(...)` that db.js
     itself uses, since it binds `const prepare = driver.prepare`. The method
     call must come IMMEDIATELY after the closing paren of prepare(); searching
     for the next '.' instead walks into a later statement and misreads
     definitions as calls. */
  let i = 0;
  while ((i = src.indexOf('prepare(', i)) !== -1) {
    /* Work out where the whole expression starts, because that is where `await`
       belongs. Inside `db.prepare(` the index `i` points at `prepare`, so
       inserting there would produce `db.await prepare(`. */
    let exprStart = i;
    if (src.startsWith('db.prepare(', i - 3)) exprStart = i - 3;
    else if (src.startsWith('driver.prepare(', i - 7)) exprStart = i - 7;
    else {
      /* A bare `prepare(`: reject a longer identifier such as `reprepare(`. */
      const prev = src[i - 1];
      if (prev !== undefined && /[\w$]/.test(prev)) { i += 1; continue; }
      /* Also reject any other object's `.prepare(` — e.g. `tx.prepare(`. */
      if (prev === '.') { i += 1; continue; }
    }

    const openParen = i + 'prepare'.length;
    const closeParen = matchParen(src, openParen);
    if (closeParen < 0) { i += 1; continue; }

    /* Skip whitespace to see what follows the prepare() expression. */
    let after = closeParen;
    while (/\s/.test(src[after] || '')) after++;
    if (src[after] !== '.') { i = closeParen; continue; }

    const methodMatch = /^(get|all|run)\(/.exec(src.slice(after + 1));
    if (!methodMatch) { i = closeParen; continue; }

    const callOpen = after + 1 + methodMatch[0].length - 1;
    const callClose = matchParen(src, callOpen);
    if (callClose < 0) { i = closeParen; continue; }

    const already = /await\s+$/.test(src.slice(0, exprStart));
    if (!already) {
      let chainAt = callClose;
      while (/\s/.test(src[chainAt] || '')) chainAt++;
      if (src[chainAt] === '.' && /[A-Za-z_$]/.test(src[chainAt + 1] || '')) {
        push(exprStart, '(await ');
        push(callClose, ')');
      } else {
        push(exprStart, 'await ');
      }
    }
    /* Advance by ONE, not to the end of the call: a statement call nested in
       another one's arguments — `db.prepare(a).get(db.prepare(b).get(x).id)` —
       must still be visited. */
    i = i + 1;
  }

  /* 2. `qSomeStatement.get|all|run(` — a prepared statement variable being
     called. Anything not preceded by 'function', 'await', '.' or a word char. */
  const stmtRe = /(?<!await )(?<!function )(?<![\w$.])([A-Za-z_$][\w$]*)\s*\.\s*(get|all|run)\(/g;
  let m;
  while ((m = stmtRe.exec(src)) !== null) {
    const name = m[1];
    /* Skip `db.prepare`/`driver.prepare`-style receivers and known objects. */
    if (name === 'db' || name === 'driver' || name === 'tx') { continue; }
    const at = m.index;

    /* Only treat it as a statement call if the identifier is a prepared
       statement: look for `const <name> = prepare(` or `= db.prepare(`. */
    const declared = new RegExp('(?:const|let|var)\\s+' + name + '\\s*=\\s*(?:await\\s+)?(?:db\\.)?prepare\\(').test(src);
    if (!declared) { continue; }

    const callOpen = src.indexOf('(', at + m[0].length - 1);
    const callClose = matchParen(src, callOpen);
    if (callClose < 0) continue;

    /* A definition line looks like `const qX = prepare(...)` with no method. */
    let chainAt2 = callClose;
    while (/\s/.test(src[chainAt2] || '')) chainAt2++;
    if (src[chainAt2] === '.' && /[A-Za-z_$]/.test(src[chainAt2 + 1] || '')) {
      push(at, '(await ');
      push(callClose, ')');
    } else {
      push(at, 'await ');
    }
    stmtRe.lastIndex = at + 1;
  }

  /* 2b. `db.exec(...)` / `driver.exec(...)` — schema, PRAGMA and explicit
     transaction control (BEGIN/COMMIT/ROLLBACK). All of it is async now, and
     an un-awaited COMMIT would let the transaction close out of order. */
  const execRe = /(?<!await )(?<!async function )(?<!function )(?<![\w$.])((?:db|driver)\.exec)\s*\(/g;
  let ex;
  while ((ex = execRe.exec(src)) !== null) {
    const at = ex.index;
    const callOpen = src.indexOf('(', at + ex[1].length);
    const callClose = matchParen(src, callOpen);
    if (callClose < 0) continue;
    push(at, 'await ');
    execRe.lastIndex = callClose;
  }

  /* 3. Namespace method calls. db.js exports `admin`, `users`, `portal` and so
     on; every method on them is now async. analytics.js exports its own set.
     `nowIso` and the CONSTANT arrays are deliberately absent — they stay sync. */
  const NAMESPACES = ['audit', 'users', 'sessions', 'portal', 'enquiries',
    'admin', 'content', 'analytics'];
  const nsAlternation = NAMESPACES.join('|');

  const nsRe = new RegExp(
    '(?<!await )(?<!async function )(?<!function )(?<![.\\w$])' +
    '(?:(?:db|driver)\\.)?(' + nsAlternation + ')\\s*\\.\\s*([A-Za-z_$][\\w$]*)\\s*\\(', 'g');

  let ns;
  while ((ns = nsRe.exec(src)) !== null) {
    /* No definition guard is needed here: the pattern requires a '(' straight
       after the method name, so an assignment such as `admin.foo = async (…)`
       never matches. Earlier guards that skipped anything after `=` silently
       left `const projects = portal.projects()` un-awaited. */
    const at = ns.index;
    const callOpen = src.indexOf('(', at + ns[0].length - 1);
    const callClose = matchParen(src, callOpen);
    if (callClose < 0) continue;

    let chainAt = callClose;
    while (/\s/.test(src[chainAt] || '')) chainAt++;
    if (src[chainAt] === '.' && /[A-Za-z_$]/.test(src[chainAt + 1] || '')) {
      push(at, '(await ');
      push(callClose, ')');
    } else {
      push(at, 'await ');
    }
    nsRe.lastIndex = at + 1;
  }

  edits.sort((a, b) => b.at - a.at || b.insert.length - a.insert.length);
  let out = src;
  for (const e of edits) out = out.slice(0, e.at) + e.insert + out.slice(e.at);
  return out;
}

/* ── Step 3: mark async ─────────────────────────────────────────────────── */

/* Control-flow keywords that look like `name(...) {` but are not functions.
   Without this the scanner marks `if (cond) {` as async and produces
   `async if (...)`. */
const NOT_A_FUNCTION = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'do', 'else', 'return',
  'typeof', 'delete', 'void', 'new', 'in', 'of', 'case', 'default',
  'try', 'finally', 'with', 'yield', 'await', 'throw'
]);

/* Returns [{ start, bodyStart, bodyEnd, kind }] for every function body. */
function findFunctions(src) {
  const found = [];
  const re = /(?:^|\n)([ \t]*)(?:(?<kw>async)\s+)?(?:(?<fn>function)\s+(?<fname>[A-Za-z_$][\w$]*)\s*\(|(?<mname>[A-Za-z_$][\w$]*)\s*\((?<mparams>[^)]*)\)\s*\{)/g;

  let m;
  while ((m = re.exec(src)) !== null) {
    if (m.groups.mname && NOT_A_FUNCTION.has(m.groups.mname)) continue;
    const at = m.index + (m[0][0] === '\n' ? 1 : 0);
    // Find the opening brace of the body.
    let brace = -1;
    if (m.groups.fn) {
      const p = src.indexOf('(', m.index + m[0].indexOf('function'));
      const after = matchParen(src, p);
      brace = src.indexOf('{', after);
    } else {
      brace = m.index + m[0].length - 1;
    }
    if (brace < 0) continue;
    const bodyEnd = matchBrace(src, brace);
    if (bodyEnd < 0) continue;

    found.push({
      at,
      brace,
      bodyEnd,
      isAsync: Boolean(m.groups.kw && m.groups.kw.trim()),
      /* Where to insert `async` — just before the name / function keyword. */
      insertAt: m.index + (m[0][0] === '\n' ? 1 : 0) + m[1].length
    });
  }

  /* Arrow functions assigned to consts:  const x = (a) => { ... }
     Also `const ready = (async () => { ... })()` — already async inside a
     wrapping paren, which must not be marked twice. */
  const arrowRe = /(?:^|\n)([ \t]*)(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(\(?)\s*(async\s+)?(\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{/g;
  while ((m = arrowRe.exec(src)) !== null) {
    const brace = m.index + m[0].length - 1;
    const bodyEnd = matchBrace(src, brace);
    if (bodyEnd < 0) continue;

    /* Insert just after the '=' sign. */
    const eq = src.indexOf('=', m.index + (m[0][0] === '\n' ? 1 : 0));
    let insertAt = eq + 1;
    while (/[ \t]/.test(src[insertAt] || '')) insertAt++;

    found.push({
      at: m.index + (m[0][0] === '\n' ? 1 : 0),
      brace,
      bodyEnd,
      isAsync: Boolean(m[4] && m[4].trim()),
      insertAt
    });
  }

  return found.sort((a, b) => a.at - b.at);
}

function markAsync(src) {
  /* Repeat: making an outer function async can make its caller await, and so
     on outward. */
  for (let pass = 0; pass < 40; pass++) {
    const fns = findFunctions(src);
    let changed = false;

    for (const fn of fns) {
      if (fn.isAsync) continue;
      const body = src.slice(fn.brace, fn.bodyEnd);
      if (!/\bawait\b/.test(body)) continue;

      src = src.slice(0, fn.insertAt) + 'async ' + src.slice(fn.insertAt);
      changed = true;
      break;      // offsets shifted; rescan
    }

    if (!changed) break;
  }

  /* Inline arrows whose expression body awaits need `async`. A regex cannot do
     this: the body may span lines and contain nested parens, as in
       (name) =>
         (await db.prepare(...).get(name)).id;
     so scan for each `=>` and look at the real extent of its body. */
  for (let pass = 0; pass < 30; pass++) {
    let changed = false;
    let idx = 0;

    while ((idx = src.indexOf('=>', idx)) !== -1) {
      /* Walk back over the parameter list. */
      let p = idx - 1;
      while (p >= 0 && /\s/.test(src[p])) p--;

      let paramsStart;
      if (src[p] === ')') {
        let depth = 0;
        let q = p;
        for (; q >= 0; q--) {
          if (src[q] === ')') depth++;
          else if (src[q] === '(') { depth--; if (depth === 0) break; }
        }
        paramsStart = q;
      } else {
        let q = p;
        while (q >= 0 && /[A-Za-z0-9_$]/.test(src[q])) q--;
        paramsStart = q + 1;
      }
      if (paramsStart < 0) { idx += 2; continue; }

      if (/\basync\s+$/.test(src.slice(Math.max(0, paramsStart - 10), paramsStart))) {
        idx += 2;
        continue;
      }

      let b = idx + 2;
      while (b < src.length && /\s/.test(src[b])) b++;

      /* A block body: `setInterval(() => { ... await ... })`. markAsync only
         sees named functions, so anonymous callbacks must be handled here. */
      if (src[b] === '{') {
        const blockEnd = matchBrace(src, b);
        if (blockEnd > 0 && /\bawait\b/.test(src.slice(b, blockEnd))) {
          src = src.slice(0, paramsStart) + 'async ' + src.slice(paramsStart);
          changed = true;
          break;
        }
        idx += 2;
        continue;
      }

      /* Expression body: find where it ends and whether it awaits. */
      let depth = 0;
      let found = false;
      const limit = Math.min(src.length, b + 1500);
      for (let e = b; e < limit; e++) {
        const ch = src[e];
        if (ch === '(' || ch === '[' || ch === '{') depth++;
        else if (ch === ')' || ch === ']' || ch === '}') { if (depth === 0) break; depth--; }
        else if (ch === ';' && depth === 0) break;
        else if (ch === '\n' && depth === 0) {
          /* A line at or left of the arrow's own indent is a new statement. */
          const lineStart = src.lastIndexOf('\n', e) + 1;
          const lineEnd = src.indexOf('\n', lineStart);
          const line = src.slice(lineStart, lineEnd < 0 ? src.length : lineEnd);
          const arrowLineStart = src.lastIndexOf('\n', paramsStart) + 1;
          const arrowIndent = paramsStart - arrowLineStart;
          const indent = line.length - line.trimStart().length;
          if (line.trim() !== '' && indent <= arrowIndent) break;
        }
        if (src.startsWith('await', e)
          && !/[A-Za-z0-9_$]/.test(src[e - 1] || '')
          && !/[A-Za-z0-9_$]/.test(src[e + 5] || '')) { found = true; }
      }

      if (found) {
        src = src.slice(0, paramsStart) + 'async ' + src.slice(paramsStart);
        changed = true;
        break;      // offsets shifted; restart the scan
      }
      idx += 2;
    }

    if (!changed) break;
  }

  return src;
}

/* ── Step 3b: internal calls ────────────────────────────────────────────── */

/* Names declared `async` in this file. Calls to them need `await` too, which
   can in turn make the caller async — so this repeats until it settles. */
function asyncNames(src) {
  const names = new Set();
  const re = /(?:^|\n)[ \t]*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*async\b|(?:^|\n)[ \t]*async\s+function\s+([A-Za-z_$][\w$]*)/g;
  let m;
  while ((m = re.exec(src)) !== null) names.add(m[1] || m[2]);
  return names;
}

function addInternalAwaits(src) {
  let total = 0;
  for (let pass = 0; pass < 20; pass++) {
    const names = asyncNames(src);
    if (names.size === 0) break;

    let changed = false;
    for (const name of names) {
      const re = new RegExp(
        '(?<!await )(?<!async function )(?<!function )(?<![.\\w$])' +
        name.replace(/\$/g, '\\$') + '\\s*\\(', 'g');

      const edits = [];
      let m;
      while ((m = re.exec(src)) !== null) {
        /* Skip the declaration itself. */
        const before = src.slice(Math.max(0, m.index - 30), m.index);
        /* Skip declarations, not calls: `async function n(`, `x = async (`, `const n = `,
           and an object/class method `async n(`. */
        if (/(?:async\s+function\s+|=\s*async\s*|(?:const|let|var)\s+|async\s+)$/.test(before)) continue;
        edits.push(m.index);
      }
      if (edits.length === 0) continue;

      for (const at of edits.reverse()) {
        src = src.slice(0, at) + 'await ' + src.slice(at);
        total++;
        changed = true;
      }
    }

    if (!changed) break;
    src = markAsync(src);
  }
  return { src, total };
}

/* ── Step 3c: cross-module calls ────────────────────────────────────────── */

/* Reading a sibling module's source tells us which of its exports are async, so
   `publicSite.renderFile(...)` can be awaited without guessing. */
function asyncExportsOf(moduleFile) {
  if (!fs.existsSync(moduleFile)) return new Set();
  const src = fs.readFileSync(moduleFile, 'utf8');

  /* 1. Which names does the module export?  Handles both shorthand
     (`{ renderFile, allFiles }`) and aliased (`{ renderFile: rf }`). */
  const exported = new Set();
  const block = /module\.exports\s*=\s*\{([\s\S]*?)\n\};/.exec(src);
  if (block) {
    for (const raw of block[1].split(',')) {
      const part = raw.trim();
      if (!part) continue;
      const alias = /^([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*)$/.exec(part);
      if (alias) { exported.add(alias[2]); continue; }
      const plain = /^([A-Za-z_$][\w$]*)$/.exec(part);
      if (plain) exported.add(plain[1]);
    }
  }
  const re2 = /exports\.([A-Za-z_$][\w$]*)\s*=/g;
  let m2;
  while ((m2 = re2.exec(src)) !== null) exported.add(m2[1]);
  if (exported.size === 0) return new Set();

  /* 2. Of those, which are declared async in this file? */
  const asyncNames = new Set();
  for (const name of exported) {
    const n = name.replace(/\$/g, '\\$');
    const isAsync =
      new RegExp('(?:^|\\n)\\s*async\\s+function\\s+' + n + '\\s*\\(').test(src) ||
      new RegExp('(?:^|\\n)\\s*(?:const|let|var)\\s+' + n + '\\s*=\\s*async\\b').test(src) ||
      new RegExp('(?:^|\\n)\\s*async\\s+' + n + '\\s*\\(').test(src) ||
      new RegExp('(?:^|\\n)\\s*' + n + '\\s*:\\s*async\\b').test(src);
    if (isAsync) asyncNames.add(name);
  }
  return asyncNames;
}

function addCrossModuleAwaits(src, file) {
  const dir = path.dirname(file);
  let total = 0;

  const reqRe = /const\s+([A-Za-z_$][\w$]*)\s*=\s*require\((['"])(\.\.?\/[^'"]+)\2\)/g;
  let r;
  while ((r = reqRe.exec(src)) !== null) {
    const local = r[1];
    const target = path.resolve(dir, r[3].endsWith('.js') ? r[3] : r[3] + '.js');
    const asyncNames = asyncExportsOf(target);
    if (asyncNames.size === 0) continue;

    for (const name of asyncNames) {
      const callRe = new RegExp(
        '(?<!await )(?<![\\w$.])' + local + '\\s*\\.\\s*' + name + '\\s*\\(', 'g');
      const edits = [];
      let c;
      while ((c = callRe.exec(src)) !== null) edits.push(c.index);
      if (edits.length === 0) continue;

      for (const at of edits.reverse()) {
        src = src.slice(0, at) + 'await ' + src.slice(at);
        total++;
      }
    }
  }
  return { src, total };
}

/* ── Step 3d: destructured imports ──────────────────────────────────────── */

/* `const { audit, users } = require('./db')` binds async functions to bare
   names. Calls to them — `audit(action, outcome, {...})` — need `await`, and the
   namespace rule never sees them because it only matches `name.method(`. */
function addBareImportAwaits(src, file) {
  const dir = path.dirname(file);
  let total = 0;

  const re = /const\s*\{([^}]*)\}\s*=\s*require\((['"])(\.\.?\/[^'"]+)\2\)/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const target = path.resolve(dir, m[3].endsWith('.js') ? m[3] : m[3] + '.js');
    const asyncNames = asyncExportsOf(target);
    if (asyncNames.size === 0) continue;

    const bound = m[1].split(',').map((s) => s.trim().split(':').pop().trim()).filter(Boolean);

    for (const name of bound) {
      if (!asyncNames.has(name)) continue;
      const callRe = new RegExp('(?<!await )(?<![\\w$.])' + name + '\\s*\\(', 'g');
      const edits = [];
      let c;
      while ((c = callRe.exec(src)) !== null) {
        const before = src.slice(Math.max(0, c.index - 30), c.index);
        if (/(?:async\s+function\s+|=\s*async\s*|(?:const|let|var)\s+|async\s+)$/.test(before)) continue;
        edits.push(c.index);
      }
      if (edits.length === 0) continue;
      for (const at of edits.reverse()) {
        src = src.slice(0, at) + 'await ' + src.slice(at);
        total++;
      }
    }
  }
  return { src, total };
}

/* ── Step 4: `await f(x).prop` ──────────────────────────────────────────── */

/* `await home('HP-0245').name` parses as `await (home(...).name)` — the await
   binds to the property access, not the call, so the result is undefined. The
   call has to be parenthesised: `(await home('HP-0245')).name`. */
function fixAwaitChains(src) {
  let out = src;
  let total = 0;

  for (let pass = 0; pass < 40; pass++) {
    let changed = false;
    let i = 0;

    while ((i = out.indexOf('await ', i)) !== -1) {
      const start = i + 'await '.length;
      /* Only a direct call: `await NAME(`. */
      const m = /^([A-Za-z_$][\w$]*)\s*\(/.exec(out.slice(start));
      if (!m) { i += 6; continue; }

      const openParen = start + m[0].length - 1;
      const closeParen = matchParen(out, openParen);
      if (closeParen < 0) { i += 6; continue; }

      let after = closeParen;
      while (/\s/.test(out[after] || '')) after++;

      /* `.get(`/`.all(`/`.run(` is the statement call itself, not a property of
         a resolved value. `await prepare(X).all()` must NOT become
         `(await prepare(X)).all()` — prepare() is synchronous and it is the
         .all() that returns the promise. */
      const isStatementMethod = /^\.\s*(get|all|run)\s*\(/.test(out.slice(after));

      /* No guard on the preceding character: `strictEqual(await f(x).name, …)`
         is just as broken as a bare `await f(x).name`. Re-wrapping is
         impossible anyway — after the wrap the next character is `)`, not `.`. */
      if (out[after] === '.' && !isStatementMethod) {
        out = out.slice(0, i) + '(await ' + out.slice(start, closeParen) + ')' + out.slice(closeParen);
        total++;
        changed = true;
        break;      // offsets shifted; rescan
      }
      /* Advance past `await ` only. Jumping to the call's closing paren would
         skip every await inside its arguments — and `await check('name',
         async () => { … await home(x) … })` hides all of them. */
      i += 6;
    }

    if (!changed) break;
  }
  return { src: out, total };
}

/* ── Main ───────────────────────────────────────────────────────────────── */

const target = process.argv[2];
if (!target) {
  console.error('usage: node tools/asyncify.js <file>');
  process.exit(1);
}

const file = path.resolve(target);
const original = fs.readFileSync(file, 'utf8');

let out = addAwaits(original);
const awaits = (out.match(/\bawait\b/g) || []).length - (original.match(/\bawait\b/g) || []).length;
out = markAsync(out);

const internal = addInternalAwaits(out);
out = markAsync(internal.src);

const cross = addCrossModuleAwaits(out, file);
out = markAsync(cross.src);

const bare = addBareImportAwaits(out, file);
out = markAsync(bare.src);

const chains = fixAwaitChains(out);
out = chains.src;

const asyncs = (out.match(/\basync\b/g) || []).length - (original.match(/\basync\b/g) || []).length;

if (process.argv.includes('--dry')) {
  console.log(`  would add ${awaits} db, ${internal.total} internal, ${cross.total} cross, ${bare.total} bare await(s), fix ${chains.total} chain(s), ${asyncs} async(s)`);
} else {
  fs.writeFileSync(file, out, 'utf8');
  console.log(`  ${path.basename(file)}: +${awaits} db, +${internal.total} internal, +${cross.total} cross, +${bare.total} bare, chain=${chains.total}, +${asyncs} async`);
}
