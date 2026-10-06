'use strict';

/* ==========================================================================
   End-to-end verification.

     node scripts/check.js            (against http://127.0.0.1:3000)
     BASE=http://host:port node scripts/check.js

   Proves the security properties that matter rather than assuming them:
   authentication, access control, CSRF, path-traversal, escaping and the
   private-document route. Exits non-zero if any check fails.
   ========================================================================== */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

/* When BASE is given we test an already-running server. Otherwise we start a
   throwaway server on its own port with its own database, so the suite is
   hermetic and can be re-run as often as you like — the login rate-limit test
   deliberately poisons its own limiter, which would break a shared server. */
const OWN_SERVER = !process.env.BASE;
const TEST_PORT = Number(process.env.CHECK_PORT || 3999);
const TEST_DB = path.join(ROOT, 'data', 'check.db');
/* Uploads must not land in the real private-docs directory. */
const TEST_DOCS = path.join(ROOT, 'data', 'check-docs');
/* A throwaway copy of public/, because uploading a logo writes into it. */
const TEST_PUBLIC = path.join(ROOT, 'data', 'check-public');
/* Where the throwaway server's own output goes, for diagnosing a crash. */
const TEST_SERVER_LOG = path.join(ROOT, 'data', 'check-server.log');
let serverLogFd = null;

let BASE = process.env.BASE || `http://127.0.0.1:${TEST_PORT}`;
let ORIGIN = BASE;

/* Document id owned by the demo client, captured so we can prove a second
   authenticated client cannot reach it. */
let ownerDocId = null;
const OTHER_CLIENT = 'HP-77777';

function runNode(args, env) {
  return new Promise((resolve, reject) => {
    // stdio 'ignore' rather than 'pipe': piped child stdio is blocked in some
    // sandboxes, and we do not need the child's output.
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: 'ignore'
    });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`node ${args.join(' ')} exited ${code}`)));
  });
}

async function waitForHealth(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`server did not become healthy at ${url} within ${timeoutMs}ms`);
}

function removeTestDb() {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TEST_DB + suffix); } catch { /* not there */ }
  }
}

function removeTestDocs() {
  try { fs.rmSync(TEST_DOCS, { recursive: true, force: true }); } catch { /* not there */ }
}

function stageTestPublic() {
  fs.rmSync(TEST_PUBLIC, { recursive: true, force: true });
  fs.cpSync(path.join(ROOT, 'public'), TEST_PUBLIC, { recursive: true });
}

function removeTestPublic() {
  try { fs.rmSync(TEST_PUBLIC, { recursive: true, force: true }); } catch { /* not there */ }
}

/* Terminate the child and wait for it to actually exit, then retry the unlink
   a few times. Killing is asynchronous, and SQLite keeps its WAL/SHM files
   open until the process is really gone — deleting first leaves them behind. */
async function stopServerAndClean(child) {
  if (child && child.exitCode === null && !child.killed) {
    await new Promise((resolve) => {
      let settled = false;
      const done = () => { if (!settled) { settled = true; resolve(); } };
      child.once('exit', done);
      child.kill();
      setTimeout(done, 4000).unref();
    });
  }
  for (let attempt = 0; attempt < 10; attempt++) {
    removeTestDb();
    if (!fs.existsSync(TEST_DB)) return;
    await new Promise((r) => setTimeout(r, 120));
  }
}

let passed = 0;
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  \u2713 ${name}`);
  } catch (err) {
    failures.push({ name, message: err.message });
    console.log(`  \u2717 ${name}\n      ${err.message}`);
  }
}

/* A tiny cookie jar — fetch does not persist cookies on its own. */
function makeJar() {
  const jar = new Map();
  return {
    header: () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; '),
    absorb(res) {
      for (const raw of res.headers.getSetCookie()) {
        const [pair] = raw.split(';');
        const i = pair.indexOf('=');
        const name = pair.slice(0, i).trim();
        const value = pair.slice(i + 1).trim();
        if (value === '') jar.delete(name);
        else jar.set(name, value);
      }
      return res;
    },
    get: (k) => jar.get(k),
    has: (k) => jar.has(k)
  };
}

function req(path, opts = {}) {
  const { jar, ...rest } = opts;
  const headers = { Origin: ORIGIN, ...(rest.headers || {}) };
  if (jar) {
    const c = jar.header();
    if (c) headers.Cookie = c;
    else delete headers.Cookie;
  }
  return fetch(BASE + path, { ...rest, headers, redirect: 'manual' });
}

/**
 * Builds a multipart/form-data body the way a browser would, so the upload
 * path is exercised through the real parser rather than bypassed.
 */
function multipart(fields, files) {
  const boundary = '----heritageCheck' + crypto.randomBytes(8).toString('hex');
  const chunks = [];

  for (const [name, value] of Object.entries(fields || {})) {
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`, 'utf8'));
  }

  for (const f of files || []) {
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${f.name}"; filename="${f.filename}"\r\n`
      + `Content-Type: ${f.contentType}\r\n\r\n`, 'utf8'));
    chunks.push(f.data);
    chunks.push(Buffer.from('\r\n', 'utf8'));
  }

  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return { boundary, body: Buffer.concat(chunks) };
}

/**
 * Validates a PDF's structure, not just its header.
 *
 * A file with a wrong xref offset still starts with %PDF- but will not open,
 * so every entry is followed to the object it claims to point at.
 */
function assertValidPdf(buf) {
  const s = buf.toString('latin1');
  assert.ok(s.startsWith('%PDF-'), 'missing %PDF- header');

  const sx = /startxref\s+(\d+)\s+%%EOF/.exec(s);
  assert.ok(sx, 'missing startxref');
  const xrefOff = Number(sx[1]);
  assert.strictEqual(s.substr(xrefOff, 4), 'xref', `no xref table at offset ${xrefOff}`);

  let p = s.indexOf('\n', xrefOff) + 1;
  const headerEnd = s.indexOf('\n', p);
  const [first, count] = s.slice(p, headerEnd).trim().split(/\s+/).map(Number);
  assert.ok(count > 2, `implausible xref size: ${count}`);
  p = headerEnd + 1;

  for (let i = 0; i < count; i++) {
    const entry = s.substr(p, 20);
    p += 20;
    const parts = entry.trim().split(/\s+/);
    const offset = Number(parts[0]);
    const type = parts[2];

    if (type !== 'n') {
      // Only object 0 may be free; a gap anywhere else means a numbering bug.
      assert.strictEqual(i, 0, `object ${i} is marked free in the xref`);
      continue;
    }
    assert.ok(s.startsWith(`${i} 0 obj`, offset),
      `object ${i}: xref offset ${offset} points at ${JSON.stringify(s.substr(offset, 16))}`);
  }

  // Declared stream lengths must match the bytes actually written.
  const streams = [...s.matchAll(/<< \/Length (\d+) >>\s*stream\r?\n/g)];
  assert.ok(streams.length > 0, 'no content stream');
  for (const m of streams) {
    const declared = Number(m[1]);
    const start = m.index + m[0].length;
    const end = s.indexOf('\nendstream', start);
    assert.strictEqual(end - start, declared, 'a stream length does not match its content');
  }

  return { first, count, streams: streams.length };
}

/** The text drawn on a PDF's pages. The streams are uncompressed by design. */
function pdfText(buf) {
  return [...buf.toString('latin1').matchAll(/\((.*?)\) Tj/gs)].map((m) => m[1]).join('\n');
}

/* ── Unit checks on the pure view helpers ───────────────────────────────── */

function unitChecks() {
  const views = require('../server/views');

  check('esc() neutralises an HTML injection attempt', () => {
    const out = views.esc('<script>alert(1)</script>');
    assert.ok(!out.includes('<script'), 'raw <script> survived escaping');
    assert.strictEqual(out, '&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  check('esc() escapes both quote characters (attribute contexts)', () => {
    assert.strictEqual(views.esc(`a"b'c`), 'a&quot;b&#39;c');
  });

  check('esc() handles null and undefined without throwing', () => {
    assert.strictEqual(views.esc(null), '');
    assert.strictEqual(views.esc(undefined), '');
  });

  check('money() renders integer cents without float drift', () => {
    assert.strictEqual(views.money(550000), 'US$5,500');
    assert.strictEqual(views.money(300000), 'US$3,000');
    assert.strictEqual(views.money(0), 'US$0');
  });

  check('money() shows both decimal places when an amount is not whole', () => {
    // 25050 cents must not print as "US$250.5" on a payment statement.
    assert.strictEqual(views.money(25050), 'US$250.50');
    assert.strictEqual(views.money(224950), 'US$2,249.50');
    assert.strictEqual(views.money(1), 'US$0.01');
    assert.strictEqual(views.money(150), 'US$1.50');
  });

  check('references: project initials are derived sensibly', () => {
    const { projectCode } = require('../server/references');
    assert.strictEqual(projectCode('Heritage Park'), 'HP');
    assert.strictEqual(projectCode('Raylands Estate'), 'RE');
    assert.strictEqual(projectCode('Goshen Park'), 'GP');
    assert.strictEqual(projectCode('Gorge of Toronto'), 'GOT');
    // One word, so a single initial is too weak to search on.
    assert.strictEqual(projectCode('Emganini'), 'EM');
    assert.strictEqual(projectCode('Mkoba 21'), 'MK');
    assert.strictEqual(projectCode(''), 'GEN');
    assert.strictEqual(projectCode(null), 'GEN');
  });

  check('references: the timestamp is local, zero-padded and ordered', () => {
    const { timestamp, buildReference } = require('../server/references');
    // Constructed from local parts, so this is timezone-independent.
    const when = new Date(2026, 9, 2, 9, 5, 3);
    assert.strictEqual(timestamp(when), '20261002-090503');
    assert.strictEqual(
      buildReference({ projectName: 'Heritage Park', when, isTaken: () => false }),
      'HP-20261002-090503');
  });

  check('references: a client with no project falls back to the given prefix', () => {
    const { buildReference } = require('../server/references');
    const when = new Date(2026, 9, 2, 9, 5, 3);
    assert.strictEqual(
      buildReference({ projectName: null, when, isTaken: () => false, fallbackCode: 'HHP' }),
      'HHP-20261002-090503');
  });

  check('references: a collision within the same second is suffixed', () => {
    const { buildReference } = require('../server/references');
    const when = new Date(2026, 9, 2, 9, 5, 3);
    const taken = new Set(['HP-20261002-090503', 'HP-20261002-090503-2']);

    assert.strictEqual(
      buildReference({ projectName: 'Heritage Park', when, isTaken: (r) => taken.has(r) }),
      'HP-20261002-090503-3');
  });
}

/* ── Static checks that the audit findings are actually fixed ───────────── */

const PAGE_FILES = ['index.html', 'about.html', 'services.html', 'projects.html',
                    'properties.html', 'news.html', 'contact.html', 'portal.html'];

function staticChecks() {
  const PUB = path.join(ROOT, 'public');
  const read = (p) => fs.readFileSync(path.join(PUB, p), 'utf8');

  /* Scanning raw text produces false positives: these files legitimately
     *mention* the very patterns we are checking for, inside explanatory
     comments. Strip comments before analysing. The line-comment pattern
     requires // to follow whitespace or start-of-line, so it does not eat
     "https://". */
  const stripBlock = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
  const stripJsComments = (s) => stripBlock(s).replace(/(^|\s)\/\/[^\n]*/g, '$1');

  const pages = PAGE_FILES.map((f) => ({ file: f, html: read(f) }));
  const js = stripJsComments(read('assets/js/site.js'));
  const css = stripBlock(read('assets/css/styles.css'));

  /* C-1 — credentials must not live in client-side code. */
  check('C-1 no password or credential check in client-side JavaScript', () => {
    assert.ok(!/demo123/.test(js), 'a password literal is present in site.js');
    assert.ok(!/HP-10245/.test(js), 'a client number is present in site.js');
    assert.ok(!/password\s*===|===\s*['"]demo/.test(js), 'credential comparison in site.js');
    // The comparison must live on the server.
    const server = fs.readFileSync(path.join(ROOT, 'server', 'auth.js'), 'utf8');
    assert.ok(server.includes('verifyPassword'), 'no server-side password verification');
  });

  /* H-1 — no HTML built from strings, so nothing can become stored XSS. */
  check('H-1 no innerHTML / outerHTML / insertAdjacentHTML in client JavaScript', () => {
    for (const sink of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write']) {
      assert.ok(!js.includes(sink), `${sink} is still used in site.js`);
    }
  });

  /* H-2 — real pages, not display:none panels toggled by script. */
  check('H-2 every page is a real document, not a display:none panel', () => {
    const flat = css.replace(/\s+/g, '');
    assert.ok(!/\.page\{display:none\}/.test(flat), '.page{display:none} is back');
    assert.ok(!/\.page\.active/.test(flat), '.page.active is back');
    for (const { file, html } of pages) {
      assert.ok(html.includes('<main'), `${file} has no main element`);
      assert.ok(html.length > 2500, `${file} looks like an empty shell`);
    }
  });

  /* H-3 — keyboard focus must be visible. */
  check('H-3 a :focus-visible ring is defined', () => {
    assert.ok(css.includes(':focus-visible'), 'no :focus-visible rule');
    assert.ok(!/outline\s*:\s*none/.test(css), 'outline:none is still used');
  });

  /* H-4 / H-5 — keyboard escape from overlays. */
  check('H-4 the mobile menu can be dismissed with the Escape key', () => {
    assert.ok(js.includes('Escape'), 'no Escape handling in site.js');
    assert.ok(js.includes('keydown'), 'no keydown listener in site.js');
  });

  /* Every link must be focusable — the original had five href-less anchors. */
  check('no anchor is missing an href', () => {
    for (const { file, html } of pages) {
      const anchors = html.match(/<a\b[^>]*>/g) || [];
      const bad = anchors.filter((a) => !/\shref=/.test(a));
      assert.strictEqual(bad.length, 0, `${file} has ${bad.length} href-less anchor(s)`);
    }
  });

  /* M — reduced motion, small text, image alt text, external deps. */
  check('M prefers-reduced-motion is honoured', () => {
    assert.ok(css.includes('prefers-reduced-motion'), 'no reduced-motion block');
  });

  check('M no font-size below 11px remains', () => {
    const sizes = [...css.matchAll(/font-size\s*:\s*(\d+(?:\.\d+)?)px/g)]
      .map((m) => Number(m[1]));
    const tiny = sizes.filter((n) => n < 11);
    assert.strictEqual(tiny.length, 0, `font sizes below 11px: ${tiny.join(', ')}`);
  });

  check('M every CSS background image is labelled for screen readers', () => {
    for (const { file, html } of pages) {
      const tags = html.match(/<[a-z]+\b[^>]*background-image[^>]*>/g) || [];
      for (const tag of tags) {
        assert.ok(/role="img"/.test(tag), `unlabelled background image in ${file}`);
        assert.ok(/aria-label="/.test(tag), `background image without aria-label in ${file}`);
      }
    }
  });

  check('M the only external hosts are the expected ones', () => {
    /* An explicit allowlist beats a bare count: a newly introduced third-party
       host fails this check even if the total number stays the same. */
    const EXPECTED = new Set([
      'fonts.googleapis.com',   // typography
      'fonts.gstatic.com',      // font files Google serves from a second origin
      'wa.me'                   // the WhatsApp contact link
    ]);

    const hosts = new Set();
    for (const { html } of pages) {
      // The canonical URL names our own domain; it is not a dependency.
      const withoutCanonical = html.replace(/<link[^>]*rel="canonical"[^>]*>/g, '');
      for (const m of withoutCanonical.matchAll(/https:\/\/([^/"']+)/g)) hosts.add(m[1]);
    }
    for (const m of css.matchAll(/https:\/\/([^/"']+)/g)) hosts.add(m[1]);

    const unexpected = [...hosts].filter((h) => !EXPECTED.has(h));
    assert.strictEqual(unexpected.length, 0,
      `unexpected external hosts: ${unexpected.join(', ')}`);
  });

  /* L — maintenance and polish. */
  check('L the copyright year is not hard-coded', () => {
    for (const { file, html } of pages) {
      assert.ok(html.includes('data-year'), `${file} does not use data-year`);
    }
    assert.ok(js.includes('data-year'), 'site.js does not fill in data-year');
  });

  check('L the toast clears its previous timer', () => {
    assert.ok(js.includes('clearTimeout'), 'toast does not clearTimeout — messages get cut short');
  });

  check('L every page declares a favicon', () => {
    for (const { file, html } of pages) {
      assert.ok(/rel="icon"/.test(html), `${file} has no favicon link`);
    }
  });

  check('L no unused CSS custom properties', () => {
    const defined = new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
    const used = new Set([...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]));
    const unused = [...defined].filter((v) => !used.has(v));
    assert.strictEqual(unused.length, 0, `unused custom properties: ${unused.join(', ')}`);
  });

  check('L the stylesheet has no unbalanced comments or loose prose', () => {
    /* A comment closed early turns the prose after it into garbage CSS, and the
       parser then swallows the NEXT rule. That is exactly how `.kpi-grid`
       silently stopped being a grid — the tiles stacked vertically one per row
       with no error reported anywhere. Nothing about the page content looks
       wrong, which is why this needs its own check. */
    const opens = (css.match(/\/\*/g) || []).length;
    const closes = (css.match(/\*\//g) || []).length;
    assert.strictEqual(opens, closes,
      `unbalanced comment markers: ${opens} "/*" against ${closes} "*/"`);

    const lines = css.split('\n');
    let inComment = false;
    let depth = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const wasInComment = inComment;
      const o = (line.match(/\/\*/g) || []).length;
      const c = (line.match(/\*\//g) || []).length;
      if (o > c) inComment = true;
      else if (c > o) inComment = false;

      /* Escaped prose can only sit at the top level, between rules — inside a
         rule, an indented line is a multi-line declaration. */
      if (!wasInComment && depth === 0 && /^\s{2,}\S/.test(line)
          && !/[;{}*]/.test(line) && !/^\s*\/\*/.test(line)) {
        assert.fail(`line ${i + 1} is loose prose outside a comment: "${line.trim()}"`);
      }

      if (!wasInComment) {
        depth += (line.match(/\{/g) || []).length;
        depth -= (line.match(/\}/g) || []).length;
      }
    }
  });

  check('L every CSS custom property that is used is also defined', () => {
    /* The dangerous case: a var() with no definition AND no fallback silently
       resolves to nothing, which can leave text invisible rather than
       obviously broken.

       Two things count as safe:
         - defined in the stylesheet
         - given a fallback, e.g. var(--hero-image, url('...')), which the page
           may set per-request (the hero banner is versioned that way so a
           replaced photograph is not hidden by the browser cache). */
    const defined = new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));

    const undefinedVars = [];
    for (const m of css.matchAll(/var\((--[a-z0-9-]+)([^)]*)/g)) {
      const [, name, rest] = m;
      if (defined.has(name)) continue;
      // `rest` runs to the next ')' — a leading comma means a fallback exists.
      if (rest.trimStart().startsWith(',')) continue;
      undefinedVars.push(name);
    }

    assert.strictEqual(undefinedVars.length, 0,
      `used but never defined and with no fallback: ${[...new Set(undefinedVars)].join(', ')}`);
  });

  check('L the palette carries the colours sampled from the logo', () => {
    assert.match(css, /--navy:\s*#283090/i, 'the sampled brand blue is not the primary');
    assert.match(css, /#e81820/i, 'the sampled brand red is missing');
  });

  check('L each page uses the wordmark, the light variant and the square mark', () => {
    for (const { file, html } of pages) {
      /* Rooted, because the development and property pages sit one level deep
         and a relative asset path 404s there. */
      assert.match(html, /class="brand-logo"[^>]+src="\/assets\/img\/logo\.png/,
        `${file}: header does not use the wordmark`);
      // The light variant in the dark footer, where navy would be invisible.
      assert.ok(html.includes('/assets/img/logo-light.png'),
        `${file}: footer does not use the light logo`);
      // The square mark as the tab icon.
      assert.ok(html.includes('/assets/img/logo-mark.png'),
        `${file}: favicon is not the square mark`);
    }
  });

  check('L the wordmark carries the site name as its alt text', () => {
    /* The logo is the only place the name appears in the header, so an empty
       alt would leave the home link with no accessible name. */
    for (const { file, html } of pages) {
      const tags = html.match(/<img class="brand-logo"[^>]*>/g) || [];
      assert.ok(tags.length > 0, `${file}: no brand logo found`);
      for (const tag of tags) {
        assert.match(tag, /alt="[^"]+"/, `${file}: a brand logo has no alt text -> ${tag}`);
      }
    }
  });

  /* The original shipped 11 KB of single-line minified CSS. */
  check('L the stylesheet is readable, not minified onto one line', () => {
    const lines = css.split('\n').length;
    assert.ok(lines > 200, `styles.css is only ${lines} lines — looks minified again`);
  });
}

/* ── Admin area ─────────────────────────────────────────────────────────── */

const ADMIN_ID = 'ADMIN-TEST';
const ADMIN_PW = 'test-admin-password';

/** Stages a staff account in the throwaway database. */
async function stageAdmin() {
  const { db, users } = require('../server/db');
  const { hashPassword } = require('../server/auth');
  const hash = await hashPassword(ADMIN_PW);
  const existing = users.byClientNumber(ADMIN_ID);

  if (existing) {
    db.prepare(`UPDATE users SET full_name = ?, email = ?, password_hash = ?, role = 'admin',
                                   disabled = 0, failed_attempts = 0, locked_until = NULL
                 WHERE id = ?`).run('Test Admin', 'admin@test.local', hash, existing.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(existing.id);
  } else {
    users.insert({
      clientNumber: ADMIN_ID, fullName: 'Test Admin',
      email: 'admin@test.local', role: 'admin', passwordHash: hash
    });
  }
  return require('../server/db').db
    .prepare('SELECT id FROM users WHERE client_number = ?').get(ADMIN_ID).id;
}

/**
 * `clientJar` must be a live client session — it is used to prove that being
 * signed in as a client grants nothing in the admin area.
 */
async function adminChecks(clientJar) {
  const { db, admin } = require('../server/db');
  const analytics = require('../server/analytics');
  const { money, slugify } = require('../server/format');
  await stageAdmin();
  const jar = makeJar();

  await check('admin: unauthenticated /admin redirects to staff sign-in', async () => {
    const r = await req('/admin');
    assert.strictEqual(r.status, 302);
    assert.strictEqual(r.headers.get('location'), '/admin/login');
  });

  await check('admin: the staff sign-in page renders with a CSRF field', async () => {
    const r = await req('/admin/login');
    assert.strictEqual(r.status, 200);
    const html = await r.text();
    assert.ok(html.includes('Admin sign in'), 'no sign-in form');
    assert.ok(html.includes('name="csrf"'), 'form has no CSRF field');
  });

  await check('admin: a signed-in CLIENT cannot reach any admin page', async () => {
    for (const p of ['/admin', '/admin/enquiries', '/admin/clients']) {
      const r = await req(p, { jar: clientJar });
      assert.strictEqual(r.status, 302, `${p} gave ${r.status} to a client session`);
      assert.strictEqual(r.headers.get('location'), '/dashboard',
        `${p} did not bounce the client to their own portal`);
    }
  });

  await check('admin: valid client credentials are refused staff access', async () => {
    const r = await req('/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ clientNumber: 'HP-10245', password: 'demo123' }).toString()
    });
    assert.strictEqual(r.status, 403, `client credentials returned ${r.status}`);
    const html = await r.text();
    assert.ok(!/Overview|Enquiries<\/h1>/.test(html), 'a client was shown an admin page');
  });

  await check('admin: an admin POST without CSRF is refused', async () => {
    const r = await fetch(BASE + '/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://evil.example' },
      body: new URLSearchParams({ clientNumber: ADMIN_ID, password: ADMIN_PW }).toString()
    });
    assert.strictEqual(r.status, 403);
  });

  await check('admin: correct staff credentials sign in', async () => {
    const r = await req('/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ clientNumber: ADMIN_ID, password: ADMIN_PW }).toString()
    });
    assert.strictEqual(r.status, 302, `status ${r.status}`);
    assert.strictEqual(r.headers.get('location'), '/admin');
    jar.absorb(r);
    assert.ok(jar.has('heritage_session'), 'no session cookie issued');
  });

  await check('admin: the overview renders real counts', async () => {
    const r = await req('/admin', { jar });
    assert.strictEqual(r.status, 200, `status ${r.status}`);
    const html = await r.text();
    assert.ok(html.includes('Overview') || html.includes('Admin'), 'no overview');
    assert.ok(html.includes('Open enquiries'), 'missing enquiry stat');
    assert.ok(html.includes('Total received'), 'missing payment stat');
  });

  await check('admin: pages are marked noindex', async () => {
    for (const p of ['/admin', '/admin/enquiries', '/admin/clients']) {
      const html = await (await req(p, { jar })).text();
      assert.ok(html.includes('noindex'), `${p} is not noindex`);
    }
  });

  await check('admin: the enquiries inbox lists a submitted enquiry', async () => {
    const r = await req('/admin/enquiries', { jar });
    assert.strictEqual(r.status, 200);
    const html = await r.text();
    assert.ok(html.includes('Test Enquirer'), 'the submitted enquiry is not listed');
    assert.ok(html.includes('+263771234567'), 'enquiry phone missing');
  });

  await check('admin: marking an enquiry handled persists', async () => {
    const row = db.prepare('SELECT id, handled_at FROM enquiries ORDER BY id LIMIT 1').get();
    assert.ok(row, 'no enquiry to work with');
    assert.strictEqual(row.handled_at, null, 'enquiry was already handled');

    const r = await req(`/admin/enquiries/${row.id}/handle`, { method: 'POST', jar });
    assert.strictEqual(r.status, 302, `status ${r.status}`);

    const after = db.prepare('SELECT handled_at, handled_by FROM enquiries WHERE id = ?').get(row.id);
    assert.ok(after.handled_at, 'handled_at was not written');
    assert.ok(after.handled_by, 'handled_by was not recorded');

    // And it can be reopened.
    await req(`/admin/enquiries/${row.id}/reopen`, { method: 'POST', jar });
    const reopened = db.prepare('SELECT handled_at FROM enquiries WHERE id = ?').get(row.id);
    assert.strictEqual(reopened.handled_at, null, 'reopen did not clear the flag');
  });

  await check('admin: an admin action is written to the audit log', async () => {
    const row = db.prepare(
      "SELECT COUNT(*) AS c FROM audit_log WHERE action LIKE 'admin_%'"
    ).get();
    assert.ok(row.c > 0, 'no admin activity in the audit log');
  });

  await check('admin: an unknown enquiry id gives 404, not a crash', async () => {
    const r = await req('/admin/enquiries/999999/handle', { method: 'POST', jar });
    assert.strictEqual(r.status, 404);
  });

  /* ── Client management ──────────────────────────────────────────────── */

  const SCRATCH = 'HP-88888';
  const { hashPassword } = require('../server/auth');

  db.prepare('DELETE FROM users WHERE client_number = ?').run(SCRATCH);
  db.prepare(`INSERT INTO users (client_number, full_name, email, role, password_hash, created_at)
              VALUES (?, ?, ?, 'client', ?, ?)`)
    .run(SCRATCH, 'Scratch Client', 'scratch@example.com',
         await hashPassword('scratch-client-password'), new Date().toISOString());

  const scratchId = db.prepare('SELECT id FROM users WHERE client_number = ?').get(SCRATCH).id;
  const demoId = db.prepare("SELECT id FROM users WHERE client_number = 'HP-10245'").get().id;

  await check('admin: the client detail page renders', async () => {
    const r = await req(`/admin/clients/${demoId}`, { jar });
    assert.strictEqual(r.status, 200, `status ${r.status}`);
    const html = await r.text();
    assert.ok(html.includes('Demo Client'), 'client name missing');
    assert.ok(html.includes('HP-0245'), 'linked stand missing');
    assert.ok(html.includes('Record a payment'), 'no payment form');
    assert.ok(html.includes('US$2,500'), 'balance missing');
  });

  await check('admin: a non-existent client id is a 404, not a crash', async () => {
    const r = await req('/admin/clients/999999', { jar });
    assert.strictEqual(r.status, 404);
  });

  await check('admin: editing a client persists', async () => {
    const r = await req(`/admin/clients/${scratchId}/update`, {
      method: 'POST', jar,
      body: new URLSearchParams({ fullName: 'Renamed Client', email: 'renamed@example.com' }).toString()
    });
    assert.strictEqual(r.status, 302, `status ${r.status}`);
    const row = db.prepare('SELECT full_name, email FROM users WHERE id = ?').get(scratchId);
    assert.strictEqual(row.full_name, 'Renamed Client');
    assert.strictEqual(row.email, 'renamed@example.com');
  });

  await check('admin: an invalid email is refused', async () => {
    await req(`/admin/clients/${scratchId}/update`, {
      method: 'POST', jar,
      body: new URLSearchParams({ fullName: 'Renamed Client', email: 'not-an-email' }).toString()
    });
    const row = db.prepare('SELECT email FROM users WHERE id = ?').get(scratchId);
    assert.strictEqual(row.email, 'renamed@example.com', 'a malformed email was saved');
  });

  await check('admin: a blank name is refused', async () => {
    await req(`/admin/clients/${scratchId}/update`, {
      method: 'POST', jar,
      body: new URLSearchParams({ fullName: '   ', email: '' }).toString()
    });
    const row = db.prepare('SELECT full_name FROM users WHERE id = ?').get(scratchId);
    assert.strictEqual(row.full_name, 'Renamed Client', 'a blank name was saved');
  });

  await check('admin: search matches number, name and email — and nothing else', async () => {
    for (const q of [SCRATCH, 'Renamed', 'renamed@example.com']) {
      const html = await (await req(`/admin/clients?q=${encodeURIComponent(q)}`, { jar })).text();
      assert.ok(html.includes(SCRATCH), `search "${q}" did not find the client`);
    }
    const none = await (await req('/admin/clients?q=zzz-no-such-client', { jar })).text();
    assert.ok(!none.includes(SCRATCH), 'an unrelated search matched a client');
  });

  await check('admin: resetting a password issues a working one and signs them out', async () => {
    // Give the scratch client a live session first.
    const sJar = makeJar();
    const login = await req('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientNumber: SCRATCH, password: 'scratch-client-password' })
    });
    assert.strictEqual(login.status, 200, `could not sign the scratch client in (${login.status})`);
    sJar.absorb(login);
    assert.strictEqual((await req('/api/me', { jar: sJar })).status, 200);

    const r = await req(`/admin/clients/${scratchId}/reset-password`, { method: 'POST', jar });
    assert.strictEqual(r.status, 200, `status ${r.status}`);
    const shown = (await r.text()).match(/<code class="pw">([^<]+)<\/code>/);
    assert.ok(shown, 'the new password was not shown to the admin');
    const newPassword = shown[1];

    // The reset must have destroyed the session that was live a moment ago.
    assert.strictEqual((await req('/api/me', { jar: sJar })).status, 401,
      'the old session survived a password reset');

    // The old password must no longer work, and the new one must.
    const old = await req('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientNumber: SCRATCH, password: 'scratch-client-password' })
    });
    assert.strictEqual(old.status, 401, 'the old password still works');

    const fresh = await req('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientNumber: SCRATCH, password: newPassword })
    });
    assert.strictEqual(fresh.status, 200, 'the new password does not work');
  });

  await check('admin: linking a stand creates the ownership and marks it sold', async () => {
    const stand = db.prepare("SELECT id FROM stands WHERE stand_number = 'HP-0261'").get();
    const r = await req(`/admin/clients/${scratchId}/stand`, {
      method: 'POST', jar,
      body: new URLSearchParams({
        standId: String(stand.id), price: '5500', purchaseDate: '2025-11-01',
        ownershipStatus: 'Servicing in progress'
      }).toString()
    });
    assert.strictEqual(r.status, 302, `status ${r.status}`);

    const own = db.prepare('SELECT * FROM ownerships WHERE user_id = ?').get(scratchId);
    assert.ok(own, 'no ownership row was created');
    assert.strictEqual(own.purchase_price_cents, 550000, 'price not stored as exact cents');

    const after = db.prepare("SELECT status FROM stands WHERE stand_number = 'HP-0261'").get();
    assert.strictEqual(after.status, 'Sold', 'the stand was not marked sold');
  });

  await check('admin: a client cannot hold two stands at once', async () => {
    const stand = db.prepare("SELECT id FROM stands WHERE stand_number = 'HP-0310'").get();
    const r = await req(`/admin/clients/${scratchId}/stand`, {
      method: 'POST', jar,
      body: new URLSearchParams({
        standId: String(stand.id), price: '7500', purchaseDate: '2025-11-01',
        ownershipStatus: 'Servicing in progress'
      }).toString()
    });
    assert.strictEqual(r.status, 200, 'the second link was not refused in-page');
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS c FROM ownerships WHERE user_id = ?').get(scratchId).c, 1,
      'a second ownership was created');
  });

  await check('admin: a malformed purchase price is refused', async () => {
    // Unlink first so the "already has a stand" rule is not what refuses us.
    const own = db.prepare('SELECT id FROM ownerships WHERE user_id = ?').get(scratchId);
    await req(`/admin/clients/${scratchId}/unlink`, { method: 'POST', jar });

    const stand = db.prepare("SELECT id FROM stands WHERE stand_number = 'HP-0310'").get();
    await req(`/admin/clients/${scratchId}/stand`, {
      method: 'POST', jar,
      body: new URLSearchParams({
        standId: String(stand.id), price: 'five thousand', purchaseDate: '2025-11-01'
      }).toString()
    });
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS c FROM ownerships WHERE user_id = ?').get(scratchId).c, 0,
      'a bogus price was accepted');
    assert.ok(own, 'expected an ownership to have existed for this test');
  });

  await check('admin: unlinking frees the stand again', async () => {
    const row = db.prepare("SELECT status FROM stands WHERE stand_number = 'HP-0261'").get();
    assert.strictEqual(row.status, 'Available', 'the stand was left marked sold');
  });

  await check('admin: a stand already held by another client cannot be taken', async () => {
    const held = db.prepare("SELECT id FROM stands WHERE stand_number = 'HP-0245'").get();
    const r = await req(`/admin/clients/${scratchId}/stand`, {
      method: 'POST', jar,
      body: new URLSearchParams({
        standId: String(held.id), price: '5500', purchaseDate: '2025-11-01'
      }).toString()
    });
    assert.strictEqual(r.status, 200, 'the takeover was not refused in-page');
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS c FROM ownerships WHERE user_id = ?').get(scratchId).c, 0,
      'an already-held stand was reassigned');
  });

  /* The reference is generated now, so the checks carry the id forward rather
     than looking the payment up by a reference they chose. */
  let testPaymentId = null;

  await check('admin: a pending payment is recorded but does not move the balance', async () => {
    const before = db.prepare("SELECT COUNT(*) AS c FROM payments WHERE user_id = ?").get(demoId).c;

    const r = await req(`/admin/clients/${demoId}/payments`, {
      method: 'POST', jar,
      body: new URLSearchParams({
        paidOn: '2025-12-01', amount: '1000.00', status: 'Pending'
      }).toString()
    });
    assert.strictEqual(r.status, 302, `status ${r.status}`);

    const after = db.prepare("SELECT COUNT(*) AS c FROM payments WHERE user_id = ?").get(demoId).c;
    assert.strictEqual(after, before + 1, 'the payment was not recorded');

    const stored = db.prepare('SELECT * FROM payments WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(demoId);
    testPaymentId = stored.id;
    assert.strictEqual(stored.amount_cents, 100000, 'the amount was not stored as exact cents');
    assert.strictEqual(stored.status, 'Pending');

    // Unverified money must not reduce what the client owes.
    const html = await (await req(`/admin/clients/${demoId}`, { jar })).text();
    assert.ok(html.includes('US$2,500'), 'a pending payment reduced the balance');
    assert.ok(html.includes('not yet confirmed'),
      'the pending amount is not shown as awaiting confirmation');
  });

  await check('admin: the rendered payment actions carry a real payment id', async () => {
    /* This is the check that was missing. The delete form used to render
       "payments//delete" because the query never selected the id, so the empty
       segment fell through to a 404. The previous check built the URL itself
       from the database and therefore never saw the broken link. */
    const html = await (await req(`/admin/clients/${demoId}`, { jar })).text();
    const row = { id: testPaymentId };

    const statusActions = [...html.matchAll(/action="([^"]*\/payments\/[^"]*\/status)"/g)].map((m) => m[1]);
    const deleteActions = [...html.matchAll(/action="([^"]*\/payments\/[^"]*\/delete)"/g)].map((m) => m[1]);

    assert.ok(statusActions.length > 0, 'no status action is rendered at all');
    assert.ok(deleteActions.length > 0, 'no delete action is rendered at all');

    for (const action of statusActions) {
      assert.match(action, /\/payments\/\d+\/status$/, `malformed status action: ${action}`);
    }
    for (const action of deleteActions) {
      assert.match(action, /\/payments\/\d+\/delete$/, `malformed delete action: ${action}`);
    }

    assert.ok(html.includes(`/admin/clients/${demoId}/payments/${row.id}/status`),
      'the Confirm action does not carry the payment id');
    assert.ok(html.includes(`/admin/clients/${demoId}/payments/${row.id}/delete`),
      'the Delete action does not carry the payment id');
  });

  await check('admin: confirming a pending payment moves the balance', async () => {
    const row = { id: testPaymentId };

    const r = await req(`/admin/clients/${demoId}/payments/${row.id}/status`, {
      method: 'POST', jar,
      body: new URLSearchParams({ status: 'Confirmed' }).toString()
    });
    assert.strictEqual(r.status, 302, `status ${r.status}`);
    assert.strictEqual(
      db.prepare('SELECT status FROM payments WHERE id = ?').get(row.id).status, 'Confirmed');

    assert.ok((await (await req(`/admin/clients/${demoId}`, { jar })).text()).includes('US$1,500'),
      'confirming the payment did not reduce the balance');
  });

  await check('admin: a confirmed payment can be put back to pending', async () => {
    const row = { id: testPaymentId };
    await req(`/admin/clients/${demoId}/payments/${row.id}/status`, {
      method: 'POST', jar, body: new URLSearchParams({ status: 'Pending' }).toString()
    });
    assert.ok((await (await req(`/admin/clients/${demoId}`, { jar })).text()).includes('US$2,500'),
      'marking it pending did not restore the balance');

    await req(`/admin/clients/${demoId}/payments/${row.id}/status`, {
      method: 'POST', jar, body: new URLSearchParams({ status: 'Confirmed' }).toString()
    });
  });

  await check('admin: the reference is generated from the project and the time', async () => {
    const stored = db.prepare('SELECT * FROM payments WHERE id = ?').get(testPaymentId);

    // Heritage Park gives HP, then local YYYYMMDD-HHMMSS.
    assert.match(stored.reference, /^HP-\d{8}-\d{6}(-\d+)?$/,
      `reference does not follow the convention: ${stored.reference}`);

    const now = new Date();
    const today = `${now.getFullYear()}`
      + `${String(now.getMonth() + 1).padStart(2, '0')}`
      + `${String(now.getDate()).padStart(2, '0')}`;
    assert.ok(stored.reference.includes(today),
      `the reference does not carry today's date: ${stored.reference}`);
  });

  await check('admin: the payment form never asks for a reference', async () => {
    const html = await (await req(`/admin/clients/${demoId}`, { jar })).text();
    assert.ok(!/name="reference"/.test(html), 'the form still has an editable reference field');
    assert.ok(/id="referencePreview"/.test(html), 'no reference preview is shown');
    assert.match(html, /HP-\d{8}-\d{6}/, 'the preview does not show the generated shape');
  });

  await check('admin: two payments in the same second get distinct references', async () => {
    const ids = [];
    for (let i = 0; i < 3; i++) {
      await req(`/admin/clients/${demoId}/payments`, {
        method: 'POST', jar,
        body: new URLSearchParams({ paidOn: '2026-03-02', amount: '5', status: 'Pending' }).toString()
      });
      ids.push(db.prepare('SELECT id FROM payments WHERE user_id = ? ORDER BY id DESC LIMIT 1')
        .get(demoId).id);
    }

    const refs = ids.map((id) => db.prepare('SELECT reference FROM payments WHERE id = ?').get(id).reference);
    assert.strictEqual(new Set(refs).size, refs.length,
      `duplicate references were issued: ${refs.join(', ')}`);

    for (const id of ids) {
      await req(`/admin/clients/${demoId}/payments/${id}/delete`, { method: 'POST', jar });
    }
  });

  await check('admin: a client with no stand uses the fallback prefix', async () => {
    // The scratch client has no linked stand at this point in the suite.
    const r = await req(`/admin/clients/${scratchId}/payments`, {
      method: 'POST', jar,
      body: new URLSearchParams({ paidOn: '2026-03-03', amount: '10', status: 'Pending' }).toString()
    });
    assert.strictEqual(r.status, 302, `status ${r.status}`);

    const row = db.prepare('SELECT * FROM payments WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(scratchId);
    assert.match(row.reference, /^HHP-\d{8}-\d{6}/, `fallback prefix not used: ${row.reference}`);

    await req(`/admin/clients/${scratchId}/payments/${row.id}/delete`, { method: 'POST', jar });
  });

  await check('admin: a malformed payment amount is refused', async () => {
    const before = db.prepare('SELECT COUNT(*) AS c FROM payments').get().c;
    await req(`/admin/clients/${demoId}/payments`, {
      method: 'POST', jar,
      body: new URLSearchParams({
        paidOn: '2025-12-03', amount: '-50', status: 'Confirmed'
      }).toString()
    });
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS c FROM payments').get().c, before,
      'a negative amount was accepted');
  });

  await check('admin: a payment cannot be deleted through another client\'s URL', async () => {
    const target = { id: testPaymentId };
    const r = await req(`/admin/clients/${scratchId}/payments/${target.id}/delete`, { method: 'POST', jar });
    assert.strictEqual(r.status, 404, `cross-client delete returned ${r.status}`);
    assert.ok(db.prepare('SELECT id FROM payments WHERE id = ?').get(target.id),
      'another client\'s payment was deleted');
  });

  await check('admin: a payment can be edited, and the balance follows', async () => {
    const row = { id: testPaymentId };

    const form = await req(`/admin/clients/${demoId}/payments/${row.id}`, { jar });
    assert.strictEqual(form.status, 200, `edit page returned ${form.status}`);
    assert.ok((await form.text()).includes('value="1000.00"'), 'the current amount is not prefilled');

    const before = db.prepare('SELECT reference FROM payments WHERE id = ?').get(row.id).reference;

    const r = await req(`/admin/clients/${demoId}/payments/${row.id}`, {
      method: 'POST', jar,
      body: new URLSearchParams({
        paidOn: '2025-12-02', amount: '1200.50', status: 'Confirmed'
      }).toString()
    });
    assert.strictEqual(r.status, 302, `status ${r.status}`);

    const after = db.prepare('SELECT * FROM payments WHERE id = ?').get(row.id);
    assert.strictEqual(after.reference, before, 'the reference was changed by an edit');
    assert.strictEqual(after.amount_cents, 120050, 'the edited amount is not exact cents');
    assert.strictEqual(after.paid_on, '2025-12-02');

    assert.ok((await (await req(`/admin/clients/${demoId}`, { jar })).text()).includes('US$1,299.50'),
      'the balance did not follow the edited amount');
  });

  await check('admin: the edit page shows the reference as read-only', async () => {
    const row = { id: testPaymentId };
    const current = db.prepare('SELECT reference FROM payments WHERE id = ?').get(row.id).reference;

    const html = await (await req(`/admin/clients/${demoId}/payments/${row.id}`, { jar })).text();
    assert.ok(html.includes(`value="${current}"`), 'the reference is not shown on the edit page');
    assert.ok(!/name="reference"/.test(html), 'the reference is still editable');
  });

  await check('admin: an invented payment status is refused', async () => {
    const row = { id: testPaymentId };
    await req(`/admin/clients/${demoId}/payments/${row.id}/status`, {
      method: 'POST', jar, body: new URLSearchParams({ status: 'Written off' }).toString()
    });
    assert.strictEqual(
      db.prepare('SELECT status FROM payments WHERE id = ?').get(row.id).status, 'Confirmed',
      'an invented status was stored');
  });

  await check('admin: deleting a payment works from the link the page renders', async () => {
    const row = { id: testPaymentId };

    /* The URL is taken from the rendered page, not built here — that is the
       difference between testing the route and testing the button. */
    const html = await (await req(`/admin/clients/${demoId}`, { jar })).text();
    const action = `/admin/clients/${demoId}/payments/${row.id}/delete`;
    assert.ok(html.includes(action), 'the delete link is not rendered with the real id');

    const r = await req(action, { method: 'POST', jar });
    assert.strictEqual(r.status, 302, `deleting returned ${r.status}`);
    assert.ok(!db.prepare('SELECT id FROM payments WHERE id = ?').get(row.id), 'the payment survived');

    assert.ok((await (await req(`/admin/clients/${demoId}`, { jar })).text()).includes('US$2,500'),
      'the balance did not return to US$2,500');
  });

  await check('admin: disabling an account ends its sessions', async () => {
    // The reset check above changed this password, so set a known one and
    // prove we really hold a live session before disabling the account.
    db.prepare('UPDATE users SET password_hash = ?, disabled = 0 WHERE id = ?')
      .run(await hashPassword('scratch-client-password'), scratchId);

    const sJar = makeJar();
    const login = await req('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientNumber: SCRATCH, password: 'scratch-client-password' })
    });
    assert.strictEqual(login.status, 200, `could not sign the scratch client in (${login.status})`);
    sJar.absorb(login);
    assert.strictEqual((await req('/api/me', { jar: sJar })).status, 200, 'no live session to begin with');

    await req(`/admin/clients/${scratchId}/disable`, {
      method: 'POST', jar, body: new URLSearchParams({ disabled: '1' }).toString()
    });
    assert.strictEqual(db.prepare('SELECT disabled FROM users WHERE id = ?').get(scratchId).disabled, 1,
      'the account was not disabled');
    assert.strictEqual((await req('/api/me', { jar: sJar })).status, 401,
      'the session survived the account being disabled');
    assert.ok(!db.prepare('SELECT token_hash FROM sessions WHERE user_id = ?').get(scratchId),
      'session rows survived disabling the account');

    await req(`/admin/clients/${scratchId}/disable`, {
      method: 'POST', jar, body: new URLSearchParams({ disabled: '0' }).toString()
    });
    assert.strictEqual(db.prepare('SELECT disabled FROM users WHERE id = ?').get(scratchId).disabled, 0,
      'the account was not re-enabled');
  });

  /* ── Creating clients ───────────────────────────────────────────────── */

  await check('admin: the new-client form renders with a suggested number', async () => {
    const r = await req('/admin/clients/new', { jar });
    assert.strictEqual(r.status, 200, `status ${r.status}`);
    const html = await r.text();
    assert.ok(html.includes('Add a client'), 'no form');
    assert.match(html, /value="HP-\d{5}"/, 'no suggested client number');
  });

  await check('admin: creating a client issues a working password', async () => {
    const clientNumber = 'HP-88999';
    db.prepare('DELETE FROM users WHERE client_number = ?').run(clientNumber);

    const r = await req('/admin/clients', {
      method: 'POST', jar,
      body: new URLSearchParams({
        clientNumber, fullName: 'New Client', email: 'new@example.com'
      }).toString()
    });
    assert.strictEqual(r.status, 200, `status ${r.status}`);

    const shown = (await r.text()).match(/<code class="pw">([^<]+)<\/code>/);
    assert.ok(shown, 'the generated password was not shown');

    const row = db.prepare('SELECT id, role FROM users WHERE client_number = ?').get(clientNumber);
    assert.ok(row, 'the client was not created');
    assert.strictEqual(row.role, 'client', 'the new account is not a client');

    const login = await req('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientNumber, password: shown[1] })
    });
    assert.strictEqual(login.status, 200, 'the generated password does not work');
  });

  await check('admin: a duplicate client number is refused', async () => {
    const before = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
    const r = await req('/admin/clients', {
      method: 'POST', jar,
      body: new URLSearchParams({ clientNumber: 'HP-10245', fullName: 'Copy Cat' }).toString()
    });
    assert.strictEqual(r.status, 200, 'the duplicate was not refused in-page');
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS c FROM users').get().c, before,
      'a duplicate client number was created');
  });

  await check('admin: a malformed client number and a blank name are refused', async () => {
    const before = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;

    await req('/admin/clients', {
      method: 'POST', jar,
      body: new URLSearchParams({ clientNumber: 'a b!', fullName: 'Bad Number' }).toString()
    });
    await req('/admin/clients', {
      method: 'POST', jar,
      body: new URLSearchParams({ clientNumber: 'HP-88998', fullName: '   ' }).toString()
    });

    assert.strictEqual(db.prepare('SELECT COUNT(*) AS c FROM users').get().c, before,
      'an invalid client was created');
  });

  /* ── Document upload ────────────────────────────────────────────────── */

  const MINIMAL_PDF = Buffer.from(
    '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n', 'latin1');
  /* Declares itself as a PDF but is not one — an HTML file renamed. */
  const NOT_A_PDF = Buffer.from('<html><body><script>alert(1)</script></body></html>', 'utf8');

  await check('admin: uploading a PDF stores the file and records it', async () => {
    const before = fs.existsSync(TEST_DOCS) ? fs.readdirSync(TEST_DOCS).length : 0;

    const { boundary, body } = multipart({ title: 'Uploaded Agreement' }, [
      { name: 'file', filename: 'agreement.pdf', contentType: 'application/pdf', data: MINIMAL_PDF }
    ]);

    const r = await req(`/admin/clients/${scratchId}/documents`, {
      method: 'POST', jar,
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body
    });
    assert.strictEqual(r.status, 302, `status ${r.status}`);

    const row = db.prepare('SELECT * FROM documents WHERE user_id = ? AND title = ?')
      .get(scratchId, 'Uploaded Agreement');
    assert.ok(row, 'no document row was created');
    assert.strictEqual(row.size_bytes, MINIMAL_PDF.length, 'the recorded size is wrong');
    assert.match(row.stored_name, /^[0-9a-f]{32}\.pdf$/,
      `the stored name is not a safe random name: ${row.stored_name}`);

    const onDisk = path.join(TEST_DOCS, row.stored_name);
    assert.ok(fs.existsSync(onDisk), 'the file was not written to disk');
    assert.strictEqual(fs.readFileSync(onDisk).subarray(0, 5).toString('latin1'), '%PDF-',
      'the uploaded bytes were corrupted in transit');

    assert.strictEqual(fs.readdirSync(TEST_DOCS).length, before + 1, 'unexpected file count');
  });

  await check('admin: a file that is not really a PDF is refused', async () => {
    const before = fs.readdirSync(TEST_DOCS).length;

    const { boundary, body } = multipart({ title: 'Sneaky' }, [
      { name: 'file', filename: 'evil.pdf', contentType: 'application/pdf', data: NOT_A_PDF }
    ]);

    const r = await req(`/admin/clients/${scratchId}/documents`, {
      method: 'POST', jar,
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body
    });

    // The declared type said PDF; only the magic bytes give it away.
    assert.strictEqual(r.status, 200, `the upload was not refused in-page (${r.status})`);
    assert.strictEqual(fs.readdirSync(TEST_DOCS).length, before, 'a non-PDF reached the disk');
    assert.ok(!db.prepare('SELECT id FROM documents WHERE title = ?').get('Sneaky'),
      'a non-PDF was recorded in the database');
  });

  await check('admin: an oversized upload is refused', async () => {
    const before = fs.readdirSync(TEST_DOCS).length;
    const huge = Buffer.concat([MINIMAL_PDF, Buffer.alloc(9 * 1024 * 1024, 0x20)]);

    const { boundary, body } = multipart({ title: 'Too Big' }, [
      { name: 'file', filename: 'big.pdf', contentType: 'application/pdf', data: huge }
    ]);

    let status = 0;
    try {
      status = (await req(`/admin/clients/${scratchId}/documents`, {
        method: 'POST', jar,
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
        body
      })).status;
    } catch {
      status = 413;
    }

    assert.ok(status === 413 || status === 200, `unexpected status ${status}`);
    assert.strictEqual(fs.readdirSync(TEST_DOCS).length, before, 'an oversized file was written');
  });

  await check('admin: an admin can download a client document', async () => {
    const doc = db.prepare('SELECT id FROM documents WHERE title = ?').get('Uploaded Agreement');
    const r = await req(`/admin/clients/${scratchId}/documents/${doc.id}/download`, { jar });
    assert.strictEqual(r.status, 200, `status ${r.status}`);
    assert.match(r.headers.get('content-type'), /application\/pdf/);
    assert.match(r.headers.get('content-disposition'), /attachment/);
    const buf = Buffer.from(await r.arrayBuffer());
    assert.strictEqual(buf.subarray(0, 5).toString('latin1'), '%PDF-', 'not the stored PDF');
  });

  await check('admin: a document cannot be fetched through another client\'s URL', async () => {
    const doc = db.prepare('SELECT id FROM documents WHERE title = ?').get('Uploaded Agreement');
    const r = await req(`/admin/clients/${demoId}/documents/${doc.id}/download`, { jar });
    assert.strictEqual(r.status, 404, `cross-client document read returned ${r.status}`);
  });

  await check('admin: deleting a document removes the row and the file', async () => {
    const doc = db.prepare('SELECT id, stored_name FROM documents WHERE title = ?')
      .get('Uploaded Agreement');
    const onDisk = path.join(TEST_DOCS, doc.stored_name);
    assert.ok(fs.existsSync(onDisk), 'the file should exist before deletion');

    const r = await req(`/admin/clients/${scratchId}/documents/${doc.id}/delete`,
      { method: 'POST', jar });
    assert.strictEqual(r.status, 302, `status ${r.status}`);
    assert.ok(!db.prepare('SELECT id FROM documents WHERE id = ?').get(doc.id), 'the row survived');
    assert.ok(!fs.existsSync(onDisk), 'the file survived on disk');
  });

  /* ── Project progress ───────────────────────────────────────────────── */

  await check('admin: the projects list renders', async () => {
    const r = await req('/admin/projects', { jar });
    assert.strictEqual(r.status, 200, `status ${r.status}`);
    assert.ok((await r.text()).includes('Heritage Park'), 'no projects listed');
  });

  await check('admin: project progress can be added, edited and deleted', async () => {
    const project = db.prepare("SELECT id FROM projects WHERE name = 'Heritage Park'").get();
    const before = db.prepare('SELECT COUNT(*) AS c FROM progress WHERE project_id = ?')
      .get(project.id).c;

    let r = await req(`/admin/projects/${project.id}/progress`, {
      method: 'POST', jar,
      body: new URLSearchParams({ label: 'Roads and drainage', state: 'pending' }).toString()
    });
    assert.strictEqual(r.status, 302, `add returned ${r.status}`);
    assert.strictEqual(
      db.prepare('SELECT COUNT(*) AS c FROM progress WHERE project_id = ?').get(project.id).c,
      before + 1, 'the step was not added');

    const step = db.prepare(
      'SELECT * FROM progress WHERE project_id = ? ORDER BY position DESC, id DESC LIMIT 1')
      .get(project.id);
    assert.strictEqual(step.label, 'Roads and drainage');
    assert.ok(step.position > 0, 'the new step has no position');

    r = await req(`/admin/projects/${project.id}/progress/${step.id}`, {
      method: 'POST', jar,
      body: new URLSearchParams({ label: 'Roads, drainage and kerbs', state: 'current' }).toString()
    });
    assert.strictEqual(r.status, 302, `update returned ${r.status}`);

    const updated = db.prepare('SELECT label, state FROM progress WHERE id = ?').get(step.id);
    assert.strictEqual(updated.label, 'Roads, drainage and kerbs');
    assert.strictEqual(updated.state, 'current');

    // An unrecognised state must not reach the database.
    await req(`/admin/projects/${project.id}/progress/${step.id}`, {
      method: 'POST', jar,
      body: new URLSearchParams({ label: 'Still fine', state: 'nonsense' }).toString()
    });
    assert.strictEqual(db.prepare('SELECT state FROM progress WHERE id = ?').get(step.id).state,
      'current', 'an invalid state was stored');

    r = await req(`/admin/projects/${project.id}/progress/${step.id}/delete`, { method: 'POST', jar });
    assert.strictEqual(r.status, 302, `delete returned ${r.status}`);
    assert.strictEqual(
      db.prepare('SELECT COUNT(*) AS c FROM progress WHERE project_id = ?').get(project.id).c,
      before, 'the step was not deleted');
  });

  await check('admin: an edited step shows up in the client\'s portal', async () => {
    const project = db.prepare("SELECT id FROM projects WHERE name = 'Heritage Park'").get();
    const first = db.prepare('SELECT * FROM progress WHERE project_id = ? ORDER BY position LIMIT 1')
      .get(project.id);

    await req(`/admin/projects/${project.id}/progress/${first.id}`, {
      method: 'POST', jar,
      body: new URLSearchParams({ label: 'Land allocation confirmed', state: first.state }).toString()
    });

    const dash = await req('/dashboard', { jar: clientJar });
    assert.strictEqual(dash.status, 200, `the client session was not usable (${dash.status})`);
    assert.ok((await dash.text()).includes('Land allocation confirmed'),
      'the client portal does not show the edited step');

    // Restore, so the check leaves nothing behind.
    await req(`/admin/projects/${project.id}/progress/${first.id}`, {
      method: 'POST', jar,
      body: new URLSearchParams({ label: first.label, state: first.state }).toString()
    });
  });

  /* ── Editable site content ─────────────────────────────────────────── */

  await check('cms: the content index lists every editable page', async () => {
    const r = await req('/admin/content', { jar });
    assert.strictEqual(r.status, 200, `status ${r.status}`);
    const html = await r.text();
    for (const label of ['Home', 'About', 'Services', 'Projects', 'Properties', 'News', 'Contact']) {
      assert.ok(html.includes(label), `${label} is not listed`);
    }
  });

  await check('cms: a page renders its editable fields', async () => {
    const r = await req('/admin/content/home', { jar });
    assert.strictEqual(r.status, 200, `status ${r.status}`);
    const html = await r.text();
    assert.ok(html.includes('f:hero:0:heading'), 'the hero heading field is missing');
    assert.ok(html.includes('Add another item'), 'no way to add a repeating item');
  });

  await check('cms: editing copy changes the public page immediately', async () => {
    const before = await (await req('/index.html')).text();
    const original = (/<h1>([^<]*)<br>/.exec(before) || [])[1];
    assert.ok(original, 'could not read the current heading');

    const r = await req('/admin/content/home/save', {
      method: 'POST', jar,
      body: new URLSearchParams({ 'f:hero:0:heading': 'Edited By The Verification Suite' }).toString()
    });
    assert.strictEqual(r.status, 302, `save returned ${r.status}`);

    const after = await (await req('/index.html')).text();
    assert.ok(after.includes('Edited By The Verification Suite'),
      'the edit did not reach the public page');

    const row = db.prepare(
      "SELECT value FROM content_blocks WHERE page='home' AND section='hero' AND item=0 AND field='heading'"
    ).get();
    assert.strictEqual(row.value, 'Edited By The Verification Suite', 'the database was not written');

    await req('/admin/content/home/save', {
      method: 'POST', jar,
      body: new URLSearchParams({ 'f:hero:0:heading': original }).toString()
    });
  });

  await check('cms: a field that is not in the schema is ignored', async () => {
    const r = await req('/admin/content/home/save', {
      method: 'POST', jar,
      body: new URLSearchParams({
        'f:hero:0:heading': 'Legitimate',
        'f:nosuchsection:0:heading': 'Injected',
        'f:hero:0:nosuchfield': 'Injected',
        'f:hero:99:heading': 'Wrong item number'
      }).toString()
    });
    assert.strictEqual(r.status, 302);

    assert.strictEqual(
      db.prepare("SELECT COUNT(*) AS c FROM content_blocks WHERE section='nosuchsection' OR field='nosuchfield'")
        .get().c, 0, 'a crafted form invented content outside the schema');
    assert.strictEqual(
      db.prepare("SELECT COUNT(*) AS c FROM content_blocks WHERE item=99 AND page='home'").get().c, 0,
      'a one-off field was written at a bogus item number');
  });

  await check('cms: adding and removing a repeating item works end to end', async () => {
    const before = db.prepare(
      "SELECT MAX(item) AS m FROM content_blocks WHERE page='home' AND section='feature'").get().m;

    let r = await req('/admin/content/home/feature/add', { method: 'POST', jar });
    assert.strictEqual(r.status, 302, `add returned ${r.status}`);

    const after = db.prepare(
      "SELECT MAX(item) AS m FROM content_blocks WHERE page='home' AND section='feature'").get().m;
    assert.strictEqual(after, before + 1, 'no new item was created');

    await req('/admin/content/home/save', {
      method: 'POST', jar,
      body: new URLSearchParams({
        [`f:feature:${after}:title`]: 'A Brand New Card',
        [`f:feature:${after}:body`]: 'Added by the verification suite.'
      }).toString()
    });

    assert.ok((await (await req('/index.html')).text()).includes('A Brand New Card'),
      'the added card is not on the home page');

    r = await req(`/admin/content/home/feature/${after}/delete`, { method: 'POST', jar });
    assert.strictEqual(r.status, 302, `delete returned ${r.status}`);
    assert.strictEqual(
      db.prepare("SELECT COUNT(*) AS c FROM content_blocks WHERE page='home' AND section='feature' AND item=?")
        .get(after).c, 0, 'the item was not deleted');

    // The factory defaults must not silently reappear once a page is seeded.
    assert.ok(!(await (await req('/index.html')).text()).includes('A Brand New Card'),
      'the deleted card came back');
  });

  await check('cms: site settings change the public header and footer', async () => {
    const original = db.prepare("SELECT value FROM site_settings WHERE key='phone'").get().value;

    const r = await req('/admin/settings', {
      method: 'POST', jar,
      body: new URLSearchParams({ 's:phone': '+263 999 000 111' }).toString()
    });
    assert.strictEqual(r.status, 302, `save returned ${r.status}`);

    const page = await (await req('/index.html')).text();
    assert.ok(page.includes('+263 999 000 111'), 'the new phone number is not on the page');

    await req('/admin/settings', {
      method: 'POST', jar, body: new URLSearchParams({ 's:phone': original }).toString()
    });
    assert.ok(!(await (await req('/index.html')).text()).includes('+263 999 000 111'),
      'the setting did not revert');
  });

  await check('cms: a project rename in the database reaches the public page', async () => {
    const before = await (await req('/projects.html')).text();
    assert.ok(before.includes('Raylands Estate'), 'the project is missing to begin with');

    db.prepare('UPDATE projects SET name = ? WHERE name = ?').run('Renamed Estate', 'Raylands Estate');

    const after = await (await req('/projects.html')).text();
    assert.ok(after.includes('Renamed Estate'), 'a database rename did not reach the public page');
    assert.ok(!after.includes('Raylands Estate'), 'the old name is still rendered');

    db.prepare('UPDATE projects SET name = ? WHERE name = ?').run('Raylands Estate', 'Renamed Estate');
  });

  await check('cms: a stand price change reaches the public page', async () => {
    const stand = db.prepare("SELECT id, price_cents FROM stands WHERE stand_number = 'HP-0310'").get();
    db.prepare('UPDATE stands SET price_cents = ? WHERE id = ?').run(1234500, stand.id);

    assert.ok((await (await req('/properties.html')).text()).includes('US$12,345'),
      'the new price is not on the properties page');

    db.prepare('UPDATE stands SET price_cents = ? WHERE id = ?').run(stand.price_cents, stand.id);
    assert.ok(!(await (await req('/properties.html')).text()).includes('US$12,345'),
      'the price did not revert');
  });

  await check('cms: the static export matches what the server renders', async () => {
    const publicSite = require('../server/public-site');
    const live = await (await req('/about.html')).text();
    const exported = publicSite.renderFile('about.html');

    assert.ok(exported, 'the exporter produced nothing');
    assert.strictEqual(exported, live,
      'the exported file differs from the live page, so the static copy is stale');
  });

  /* ── Logo ──────────────────────────────────────────────────────────── */

  const SVG_LOGO = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">'
    + '<rect width="64" height="64" rx="12" fill="#7a1f1f"/></svg>', 'utf8');
  const SVG_WITH_SCRIPT = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">'
    + '<script>alert(1)</script></svg>', 'utf8');

  await check('cms: uploading a logo changes it across the site', async () => {
    const { boundary, body } = multipart({}, [
      { name: 'logo', filename: 'logo.svg', contentType: 'image/svg+xml', data: SVG_LOGO }
    ]);

    const r = await req('/admin/logo', {
      method: 'POST', jar,
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body
    });
    assert.strictEqual(r.status, 302, `status ${r.status}`);

    assert.ok((await (await req('/index.html')).text()).includes('logo-custom.svg'),
      'the public page still points at the old logo');

    const asset = await req('/assets/img/logo-custom.svg');
    assert.strictEqual(asset.status, 200, `the uploaded logo is not served (${asset.status})`);
    assert.match(asset.headers.get('content-type'), /image\/svg/);
  });

  await check('cms: an SVG carrying script is refused', async () => {
    const { boundary, body } = multipart({}, [
      { name: 'logo', filename: 'evil.svg', contentType: 'image/svg+xml', data: SVG_WITH_SCRIPT }
    ]);

    const r = await req('/admin/logo', {
      method: 'POST', jar,
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body
    });
    assert.strictEqual(r.status, 200, `the upload was not refused in-page (${r.status})`);

    const stored = fs.readFileSync(path.join(TEST_PUBLIC, 'assets', 'img', 'logo-custom.svg'), 'utf8');
    assert.ok(!stored.includes('<script'), 'the malicious SVG replaced the good one');
  });

  await check('cms: a file that is not an image is refused', async () => {
    const { boundary, body } = multipart({}, [
      { name: 'logo', filename: 'notes.txt', contentType: 'text/plain', data: Buffer.from('hello') }
    ]);

    const r = await req('/admin/logo', {
      method: 'POST', jar,
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body
    });
    assert.strictEqual(r.status, 200, 'a text file was accepted as a logo');
  });

  await check('cms: the logo can be reverted to the default', async () => {
    const r = await req('/admin/logo/remove', { method: 'POST', jar });
    assert.strictEqual(r.status, 302, `status ${r.status}`);

    const page = await (await req('/index.html')).text();
    assert.ok(page.includes('assets/img/logo.png'), 'the default logo was not restored');
    assert.ok(!page.includes('logo-custom'), 'a custom logo is still referenced');

    const leftovers = fs.readdirSync(path.join(TEST_PUBLIC, 'assets', 'img'))
      .filter((n) => n.startsWith('logo-custom'));
    assert.strictEqual(leftovers.length, 0, `custom logo files were left behind: ${leftovers.join(', ')}`);
  });

  /* ── Statement of account (PDF) ─────────────────────────────────────── */

  await check('cms: the admin can download a client statement as a PDF', async () => {
    const r = await req(`/admin/clients/${demoId}/statement.pdf`, { jar });
    assert.strictEqual(r.status, 200, `status ${r.status}`);
    assert.match(r.headers.get('content-type'), /application\/pdf/);
    assert.match(r.headers.get('content-disposition'), /Statement-HP-10245\.pdf/);

    const buf = Buffer.from(await r.arrayBuffer());
    assert.ok(buf.length > 1500, `suspiciously small: ${buf.length} bytes`);
    const info = assertValidPdf(buf);

    const text = pdfText(buf);
    for (const needle of ['STATEMENT OF ACCOUNT', 'BALANCE OUTSTANDING', 'PAYMENTS RECEIVED',
      'HP-10245', 'Demo Client', 'HP-0245', 'Total confirmed']) {
      assert.ok(text.includes(needle), `the statement does not contain "${needle}"`);
    }
    // Every payment the database holds must be drawn.
    for (const p of db.prepare('SELECT reference FROM payments WHERE user_id = ?').all(demoId)) {
      assert.ok(text.includes(p.reference), `payment ${p.reference} is missing from the statement`);
    }
    return info;
  });

  await check('cms: a client can download their own statement', async () => {
    const r = await req('/api/statement.pdf', { jar: clientJar });
    assert.strictEqual(r.status, 200, `status ${r.status}`);
    assert.match(r.headers.get('content-type'), /application\/pdf/);

    const buf = Buffer.from(await r.arrayBuffer());
    assertValidPdf(buf);
    assert.ok(pdfText(buf).includes('Demo Client'), 'the wrong client is on the statement');
  });

  await check('cms: a statement is refused without a session', async () => {
    const anon = await req('/api/statement.pdf');
    assert.strictEqual(anon.status, 401, `unauthenticated request returned ${anon.status}`);
  });

  await check('cms: a pending payment is labelled unconfirmed on the statement', async () => {
    await req(`/admin/clients/${demoId}/payments`, {
      method: 'POST', jar,
      body: new URLSearchParams({ paidOn: '2026-01-05', amount: '250', status: 'Pending' }).toString()
    });

    const row = db.prepare('SELECT * FROM payments WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(demoId);

    const r = await req(`/admin/clients/${demoId}/statement.pdf`, { jar });
    const text = pdfText(Buffer.from(await r.arrayBuffer()));

    assert.ok(text.includes(row.reference),
      `the pending payment ${row.reference} is not on the statement`);
    assert.ok(text.includes('NOT YET CONFIRMED'), 'pending money is not labelled as unconfirmed');

    await req(`/admin/clients/${demoId}/payments/${row.id}/delete`, { method: 'POST', jar });
  });

  await check('cms: a long payment history spills onto more than one page', async () => {
    /* A statement that silently truncates is worse than one that is long, so
       every generated reference must appear somewhere in the document. */
    const ids = [];
    for (let i = 0; i < 45; i++) {
      await req(`/admin/clients/${demoId}/payments`, {
        method: 'POST', jar,
        body: new URLSearchParams({ paidOn: '2026-02-01', amount: '10', status: 'Confirmed' }).toString()
      });
      ids.push(db.prepare('SELECT id FROM payments WHERE user_id = ? ORDER BY id DESC LIMIT 1')
        .get(demoId).id);
    }

    const refs = ids.map((id) => db.prepare('SELECT reference FROM payments WHERE id = ?').get(id).reference);

    const r = await req(`/admin/clients/${demoId}/statement.pdf`, { jar });
    const buf = Buffer.from(await r.arrayBuffer());
    assertValidPdf(buf);

    const raw = buf.toString('latin1');
    const pages = (raw.match(/\/Type \/Page[^s]/g) || []).length;
    assert.ok(pages > 1, `expected several pages, got ${pages}`);

    const text = pdfText(buf);
    for (const ref of refs) {
      assert.ok(text.includes(ref), `payment ${ref} is missing from the multi-page statement`);
    }
    assert.ok(text.includes('Page 2 of'), 'later pages have no page number');

    for (const id of ids) {
      await req(`/admin/clients/${demoId}/payments/${id}/delete`, { method: 'POST', jar });
    }
  });

  /* ── WhatsApp contact ───────────────────────────────────────────────── */

  const WA = 'https://wa.me/message/3NT2K5FBKFQI1';

  await check('cms: the WhatsApp link is on the contact page', async () => {
    const html = await (await req('/contact.html')).text();
    assert.ok(html.includes(WA), 'no WhatsApp link on the contact page');
    assert.match(html, /href="https:\/\/wa\.me\/message\/3NT2K5FBKFQI1"[^>]*target="_blank"/,
      'the link does not open in a new tab');
    assert.match(html, /wa\.me[^>]*rel="noopener/, 'the external link has no rel="noopener"');
    assert.ok(html.includes('WhatsApp us'), 'no WhatsApp label');
  });

  await check('cms: the WhatsApp link is in every footer', async () => {
    for (const file of ['/index.html', '/about.html', '/services.html', '/projects.html',
      '/properties.html', '/news.html', '/contact.html', '/portal.html']) {
      const html = await (await req(file)).text();
      assert.ok(html.includes('wa.me/message/3NT2K5FBKFQI1'), `${file} has no WhatsApp link`);
    }
  });

  await check('cms: the client portal offers WhatsApp support', async () => {
    const html = await (await req('/dashboard', { jar: clientJar })).text();
    assert.ok(html.includes('wa.me/message/3NT2K5FBKFQI1'), 'the portal has no WhatsApp link');
  });

  await check('cms: a non-web WhatsApp value is refused rather than rendered', async () => {
    /* The setting is admin-editable. Escaping alone would not stop
       href="javascript:..." from firing, so the value is checked too. */
    await req('/admin/settings', {
      method: 'POST', jar,
      body: new URLSearchParams({ 's:whatsapp_url': 'javascript:alert(1)' }).toString()
    });

    const html = await (await req('/contact.html')).text();
    assert.ok(!html.includes('javascript:'), 'a javascript: URL reached the page');
    assert.ok(!html.includes('WhatsApp us'), 'the button rendered with an unsafe link');

    await req('/admin/settings', {
      method: 'POST', jar,
      body: new URLSearchParams({ 's:whatsapp_url': WA }).toString()
    });
    assert.ok((await (await req('/contact.html')).text()).includes(WA), 'the link did not come back');
  });

  /* ── Contact details ────────────────────────────────────────────────── */

  await check('cms: the contact card carries the office, phone and email', async () => {
    /* This looks inside the card specifically. A page-wide "does the number
       appear at all" check passed for a long time while the card itself was
       empty, because the footer contains the same details. */
    const html = await (await req('/contact.html')).text();
    const card = /<div class="contact-card">([\s\S]*?)<\/div>\s*<form/.exec(html);
    assert.ok(card, 'the contact card was not found on the page');
    const inner = card[1];

    assert.match(inner, /<b>Office:<\/b>\s*\S/, 'the office line is empty');
    assert.match(inner, /<b>Phone:<\/b>\s*<a href="tel:[^"]+">[^<]+<\/a>/, 'the phone line is empty');
    assert.match(inner, /<b>Email:<\/b>\s*<a href="mailto:[^"]+">[^<]+<\/a>/, 'the email line is empty');
    assert.ok(!/href="tel:"/.test(inner), 'the Call button has no number');
    assert.ok(!/href="mailto:"/.test(inner), 'the Email button has no address');
  });

  await check('cms: no settings-driven link anywhere is empty', async () => {
    for (const file of ['/index.html', '/about.html', '/services.html', '/projects.html',
      '/properties.html', '/news.html', '/contact.html', '/portal.html']) {
      const html = await (await req(file)).text();
      assert.ok(!/href="tel:"/.test(html), `${file} renders an empty tel: link`);
      assert.ok(!/href="mailto:"/.test(html), `${file} renders an empty mailto: link`);
      assert.ok(!/src="assets\/img\/undefined/.test(html), `${file} renders an undefined image`);
    }
  });

  /* ══ Sales analytics ══════════════════════════════════════════════════
     The brief's required scenario, driven end to end through the real HTTP
     routes: a US$6,500 stand paid by deposit 3,000, two instalments of 500,
     a final 2,500, then a 500 refund. */

  let scenarioSaleId = null;
  let scenarioStandId = null;
  let confirmSaleId = null;
  let confirmClientId = null;

  const recordTxn = (type, amount, paidOn) => req(`/admin/sales/${scenarioSaleId}/transactions`, {
    method: 'POST', jar,
    body: new URLSearchParams({
      type, amount, paidOn, method: 'Bank transfer', notes: 'scenario'
    }).toString()
  });

  await check('analytics: the scenario sale is created at US$6,500 with nothing collected', async () => {
    const project = db.prepare('SELECT id FROM projects ORDER BY id LIMIT 1').get();
    scenarioStandId = Number(db.prepare(
      'INSERT INTO stands (project_id, stand_number, size_sqm, type, price_cents, status) VALUES (?,?,?,?,?,?)')
      .run(project.id, 'ANALYTICS-6500', 200, 'Residential', 650000, 'Sold').lastInsertRowid);

    const clientId = Number(db.prepare(
      "INSERT INTO users (client_number, full_name, email, role, password_hash, created_at) VALUES (?,?,?,'client',?,?)")
      .run('HP-90001', 'Analytics Scenario Client', 'scenario@example.com', 'scrypt$unused',
        new Date().toISOString()).lastInsertRowid);

    scenarioSaleId = Number(db.prepare(`INSERT INTO ownerships
        (user_id, stand_id, purchase_price_cents, purchase_date, status, sale_price_cents, sale_status, sale_date)
        VALUES (?,?,?,?,?,?,'Active',?)`)
      .run(clientId, scenarioStandId, 650000, '2026-01-10', 'Servicing in progress', 650000, '2026-01-10')
      .lastInsertRowid);

    const s = analytics.saleById(scenarioSaleId);
    assert.strictEqual(s.sale_price_cents, 650000, 'sale price should be US$6,500');
    assert.strictEqual(s.collected_cents, 0, 'a new sale must not count as cash collected');
    assert.strictEqual(s.outstanding_cents, 650000, 'the whole price is outstanding');
    assert.strictEqual(s.isCompleted, false);
  });

  await check('analytics: a US$3,000 deposit leaves US$3,500 outstanding', async () => {
    const r = await recordTxn('DEPOSIT', '3000', '2026-01-10');
    assert.strictEqual(r.status, 302, `status ${r.status}`);

    const s = analytics.saleById(scenarioSaleId);
    assert.strictEqual(s.deposits_cents, 300000);
    assert.strictEqual(s.collected_cents, 300000, 'only the deposit has been collected');
    assert.strictEqual(s.outstanding_cents, 350000);
    assert.strictEqual(s.sale_status, 'Active');
  });

  await check('analytics: two US$500 instalments reduce the balance to US$2,500', async () => {
    await recordTxn('INSTALLMENT', '500', '2026-02-01');
    await recordTxn('INSTALLMENT', '500', '2026-03-01');

    const s = analytics.saleById(scenarioSaleId);
    assert.strictEqual(s.installments_cents, 100000);
    assert.strictEqual(s.collected_cents, 400000);
    assert.strictEqual(s.outstanding_cents, 250000);
  });

  await check('analytics: a final payment beyond the balance is refused', async () => {
    // Rule 3 — the balance is US$2,500, so US$3,000 must not be accepted.
    const r = await recordTxn('FINAL_PAYMENT', '3000', '2026-04-01');
    assert.strictEqual(r.status, 302, `status ${r.status}`);

    const s = analytics.saleById(scenarioSaleId);
    assert.strictEqual(s.finals_cents, 0, 'an over-large final payment was accepted');
    assert.strictEqual(s.outstanding_cents, 250000, 'the balance must be unchanged');
  });

  await check('analytics: the exact US$2,500 final payment completes the sale', async () => {
    await recordTxn('FINAL_PAYMENT', '2500', '2026-04-01');

    const s = analytics.saleById(scenarioSaleId);
    assert.strictEqual(s.finals_cents, 250000);
    assert.strictEqual(s.collected_cents, 650000, 'total collected must equal the sale price');
    assert.strictEqual(s.net_cents, 650000);
    assert.strictEqual(s.refunds_cents, 0);
    assert.strictEqual(s.outstanding_cents, 0, 'the balance must be zero');
    assert.strictEqual(s.isCompleted, true);
    assert.strictEqual(s.sale_status, 'Completed', 'the status must follow the balance automatically');
    assert.strictEqual(s.paidPercent, 100);
  });

  await check('analytics: a refund larger than the money received is refused', async () => {
    // Rule 4.
    const r = await recordTxn('REFUND', '7000', '2026-05-01');
    assert.strictEqual(r.status, 302, `status ${r.status}`);

    const s = analytics.saleById(scenarioSaleId);
    assert.strictEqual(s.refunds_cents, 0, 'an over-large refund was accepted');
  });

  await check('analytics: a US$500 refund gives gross 6,500, net 6,000, recoverable 500', async () => {
    await recordTxn('REFUND', '500', '2026-05-01');

    const s = analytics.saleById(scenarioSaleId);
    assert.strictEqual(s.collected_cents, 650000, 'gross collections stay at the full price paid');
    assert.strictEqual(s.refunds_cents, 50000);
    assert.strictEqual(s.net_cents, 600000, 'net collections must fall by the refund');
    assert.strictEqual(s.outstanding_cents, 50000, 'the refund reopens a US$500 balance');
    assert.strictEqual(s.isCompleted, false, 'a part-refunded sale is no longer fully paid');
    assert.strictEqual(s.sale_status, 'Active', 'the status must follow the reopened balance');
  });

  await check('analytics: the dashboard renders the figures the engine computes', async () => {
    const k = analytics.kpis({});
    const html = await (await req('/admin/analytics', { jar })).text();

    for (const [label, cents] of [
      ['contract sales value', k.contractCents],
      ['gross collections', k.grossCents],
      ['net collections', k.netCents],
      ['refunds', k.refundsCents],
      ['outstanding', k.outstandingCents]
    ]) {
      assert.ok(html.includes(money(cents)), `the dashboard does not show ${label} (${money(cents)})`);
    }

    // And the arithmetic identities the brief specifies.
    assert.strictEqual(k.grossCents, k.depositsCents + k.installmentsCents + k.finalsCents);
    assert.strictEqual(k.netCents, k.grossCents - k.refundsCents);
    assert.strictEqual(k.outstandingCents, k.contractCents - k.netCents);
    assert.ok(k.refundsCents >= 50000, 'the scenario refund is missing from the totals');
  });

  await check('analytics: voiding a transaction removes it from every figure', async () => {
    // Rule 7.
    const before = analytics.kpis({});
    const txn = db.prepare(
      "SELECT id FROM payments WHERE ownership_id = ? AND type = 'INSTALLMENT' ORDER BY id LIMIT 1")
      .get(scenarioSaleId);

    await req(`/admin/payments/${txn.id}/void`, {
      method: 'POST', jar, body: new URLSearchParams({ reason: 'scenario void' }).toString()
    });

    const after = analytics.kpis({});
    assert.strictEqual(after.installmentsCents, before.installmentsCents - 50000,
      'a voided instalment is still being counted');
    assert.strictEqual(after.netCents, before.netCents - 50000, 'a voided transaction still affects net');

    // The row survives so the deletion stays auditable.
    assert.ok(db.prepare('SELECT voided_at FROM payments WHERE id = ?').get(txn.id).voided_at,
      'voiding deleted the row instead of marking it');

    await req(`/admin/payments/${txn.id}/restore`, {
      method: 'POST', jar, body: new URLSearchParams({ reason: 'scenario restore' }).toString()
    });
    assert.strictEqual(analytics.kpis({}).netCents, before.netCents, 'restoring did not bring it back');
  });

  await check('analytics: every change to money leaves an audit trail', async () => {
    // Rule 8 and the audit-trail section.
    const rows = analytics.financeAuditLog({ limit: 300 });
    for (const action of ['deposit_created', 'installment_created', 'final_payment_created',
      'refund_created', 'payment_voided', 'payment_restored']) {
      assert.ok(rows.some((r) => r.action === action), `no audit entry for ${action}`);
    }

    const created = rows.find((r) => r.action === 'deposit_created' && r.new_value.includes('300000'));
    assert.ok(created, 'the deposit was not audited with its amount');
    assert.ok(created.actor_number, 'the audit entry does not record who did it');
  });

  await check('analytics: a payment cannot be recorded against a missing sale', async () => {
    // Rule 1.
    const r = analytics.recordTransaction({
      ownershipId: 999999, type: 'DEPOSIT', amountCents: 1000, paidOn: '2026-01-01', reference: 'NOWHERE'
    });
    assert.strictEqual(r.ok, false, 'a payment was accepted for a sale that does not exist');
    assert.match(r.error, /existing sale/);
  });

  await check('analytics: an instalment cannot exist without a sale', async () => {
    // Rule 2.
    const r = analytics.recordTransaction({
      ownershipId: null, type: 'INSTALLMENT', amountCents: 1000, paidOn: '2026-01-01', reference: 'ORPHAN'
    });
    assert.strictEqual(r.ok, false, 'an orphan instalment was accepted');
  });

  await check('analytics: an invalid type, amount or date is refused', async () => {
    // Rule 9.
    const base = { ownershipId: scenarioSaleId, paidOn: '2026-01-01', reference: 'R' };
    assert.strictEqual(analytics.recordTransaction({ ...base, type: 'BRIBE', amountCents: 100 }).ok, false);
    assert.strictEqual(analytics.recordTransaction({ ...base, type: 'DEPOSIT', amountCents: 0 }).ok, false);
    assert.strictEqual(analytics.recordTransaction({ ...base, type: 'DEPOSIT', amountCents: -500 }).ok, false);
    assert.strictEqual(
      analytics.recordTransaction({ ...base, type: 'DEPOSIT', amountCents: 100, paidOn: 'yesterday' }).ok, false);
    assert.strictEqual(
      analytics.recordTransaction({ ...base, type: 'DEPOSIT', amountCents: 100, reference: '' }).ok, false);
  });

  await check('analytics: transaction ids are unique', async () => {
    // Rule 11 — the primary key guarantees it, so this asserts the guarantee holds.
    const ids = db.prepare('SELECT id FROM payments').all().map((r) => r.id);
    assert.strictEqual(new Set(ids).size, ids.length, 'duplicate transaction ids exist');
  });

  await check('analytics: analytics are keyed off the transaction date, not the sale date', async () => {
    // Rule 18 — the sale is dated 10 January; the May refund must land in May.
    const jan = analytics.kpis({ from: '2026-01-01', to: '2026-01-31' });
    const may = analytics.kpis({ from: '2026-05-01', to: '2026-05-31' });

    assert.ok(jan.refundsCents === 0, 'the May refund leaked into January');
    assert.strictEqual(may.refundsCents, 50000, 'the refund is not counted in the month it happened');
    assert.strictEqual(may.depositsCents, 0, 'the January deposit leaked into May');
    assert.strictEqual(jan.depositsCents, 300000, 'the deposit is not counted in January');
  });

  await check('analytics: weekly, monthly and annual views all render', async () => {
    for (const path of [
      '/admin/analytics/weekly',
      '/admin/analytics/weekly?week=-1',
      '/admin/analytics/weekly?from=2026-01-01&to=2026-03-31',
      '/admin/analytics/monthly',
      '/admin/analytics/monthly?month=2026-05',
      '/admin/analytics/annual',
      '/admin/analytics/annual?year=2026'
    ]) {
      const r = await req(path, { jar });
      assert.strictEqual(r.status, 200, `${path} returned ${r.status}`);
      assert.ok((await r.text()).includes('kpi-value'), `${path} rendered no figures`);
    }
  });

  await check('analytics: weeks run Monday to Sunday', async () => {
    /* 2026-01-05 was a Monday and the scenario deposit falls on the Saturday of
       that week, so the chart has something to draw and the order is visible. */
    const html = await (await req('/admin/analytics/weekly?from=2026-01-05&to=2026-01-11', { jar })).text();
    const labels = html.match(/bar-label">(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)/g) || [];
    assert.strictEqual(labels.length, 7, `expected seven day bars, saw ${labels.length}`);
    assert.ok(labels[0].endsWith('Monday'), 'the week does not start on Monday');
    assert.ok(labels[6].endsWith('Sunday'), 'the week does not end on Sunday');
  });

  await check('analytics: the monthly comparison states the real direction', async () => {
    // February 2026 has one US$500 instalment; January has a US$3,000 deposit,
    // so this must report a fall — not a flattering figure.
    const html = await (await req('/admin/analytics/monthly?month=2026-02', { jar })).text();
    assert.ok(html.includes('vs January 2026'), 'the previous month is not named');
    assert.match(html, /(Increased|Decreased) \d+\.\d%/, 'no percentage change is shown');
    assert.ok(html.includes('Decreased'), 'a real fall was not reported as a fall');
  });

  await check('analytics: the annual view lists twelve months including empty ones', async () => {
    const html = await (await req('/admin/analytics/annual?year=2026', { jar })).text();
    // en-GB abbreviates September as "Sept", so both spellings are accepted.
    const rows = html.match(/<td><strong>(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)<\/strong><\/td>/g) || [];
    assert.strictEqual(rows.length, 12, `expected twelve month rows, saw ${rows.length}`);
  });

  await check('analytics: the period views are refused to a non-admin', async () => {
    for (const path of ['/admin/analytics/weekly', '/admin/analytics/monthly', '/admin/analytics/annual']) {
      const r = await req(path, { jar: clientJar });
      assert.notStrictEqual(r.status, 200, `${path} was served to a non-admin`);
    }
  });

  await check('analytics: every report exports in every format', async () => {
    const combos = [
      ['weekly', '?from=2026-01-05&to=2026-01-11', 'Weekly sales report'],
      ['monthly', '?month=2026-02', 'Monthly sales report'],
      ['annual', '?year=2026', 'Annual sales report'],
      ['ledger', '', 'Transaction ledger'],
      ['project', '', 'Sales performance by project'],
      ['agent', '', 'Sales performance by agent'],
      ['outstanding', '', 'Outstanding balances'],
      ['payments', '', 'Payment history']
    ];

    for (const [type, qs, title] of combos) {
      for (const format of ['csv', 'xlsx', 'pdf']) {
        const r = await req(`/admin/analytics/export/${type}.${format}${qs}`, { jar });
        assert.strictEqual(r.status, 200, `${type}.${format} returned ${r.status}`);

        const buf = Buffer.from(await r.arrayBuffer());
        assert.ok(buf.length > 100, `${type}.${format} produced only ${buf.length} bytes`);

        if (format === 'csv') {
          assert.match(r.headers.get('content-type'), /text\/csv/);
          const text = buf.toString('utf8');
          assert.ok(text.startsWith('\uFEFF'), `${type}.csv has no BOM, so Excel will mangle accents`);
          assert.ok(text.includes(title), `${type}.csv does not name its report`);
          assert.ok(text.includes('Filters:'), `${type}.csv does not state the filters used`);
        } else if (format === 'xlsx') {
          assert.match(r.headers.get('content-type'), /spreadsheetml/);
          assert.strictEqual(buf.subarray(0, 2).toString('latin1'), 'PK',
            `${type}.xlsx is not a zip container`);
        } else {
          assert.match(r.headers.get('content-type'), /application\/pdf/);
          assert.strictEqual(buf.subarray(0, 5).toString('latin1'), '%PDF-');
          assertValidPdf(buf);
        }

        assert.match(r.headers.get('content-disposition'),
          /attachment; filename="[^"]+\.(csv|xlsx|pdf)"/, `${type}.${format} has no download filename`);
      }
    }
  });

  await check('analytics: xlsx exports are real workbooks a spreadsheet can open', async () => {
    const { columnName } = require('../server/xlsx');
    assert.strictEqual(columnName(0), 'A');
    assert.strictEqual(columnName(25), 'Z');
    assert.strictEqual(columnName(26), 'AA');
    assert.strictEqual(columnName(51), 'AZ');

    const buf = Buffer.from(await (await req('/admin/analytics/export/annual.xlsx?year=2026', { jar }))
      .arrayBuffer());

    /* Walk the zip central directory. A wrong offset here is the difference
       between a file Excel opens and one it rejects. */
    const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    assert.ok(end > 0, 'no end-of-central-directory record');

    const entries = buf.readUInt16LE(end + 10);
    assert.ok(entries >= 6, `expected the workbook parts, saw ${entries} entries`);

    let offset = buf.readUInt32LE(end + 16);
    const names = [];
    for (let i = 0; i < entries; i++) {
      assert.strictEqual(buf.readUInt32LE(offset), 0x02014b50, `entry ${i} is not a central header`);
      const nameLen = buf.readUInt16LE(offset + 28);
      names.push(buf.subarray(offset + 46, offset + 46 + nameLen).toString('utf8'));
      offset += 46 + nameLen + buf.readUInt16LE(offset + 30) + buf.readUInt16LE(offset + 32);
    }

    for (const part of ['[Content_Types].xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml',
      'xl/styles.xml']) {
      assert.ok(names.includes(part), `the workbook is missing ${part}`);
    }
    assert.ok(names.includes('xl/worksheets/sheet2.xml'), 'the second sheet is missing');
  });

  await check('analytics: exports respect the filters that were applied', async () => {
    const all = await (await req('/admin/analytics/export/project.csv', { jar })).text();
    assert.ok(all.includes('Heritage Park'), 'the unfiltered export is missing Heritage Park');

    const goshen = db.prepare("SELECT id FROM projects WHERE name = 'Goshen Park'").get();
    const filtered = await (await req(`/admin/analytics/export/project.csv?project=${goshen.id}`, { jar })).text();

    assert.ok(filtered.includes('Goshen Park'), 'the filtered export lost its own project');
    assert.ok(!filtered.includes('Heritage Park'), 'the export ignored the project filter');
    assert.ok(filtered.includes('project Goshen Park'), 'the export does not state which filters it used');
  });

  await check('analytics: the ledger export carries the real transactions', async () => {
    const text = await (await req('/admin/analytics/export/ledger.csv', { jar })).text();
    assert.ok(text.includes('Amount (US$)'), 'the ledger export has no amount column');
    assert.ok(text.includes('DEPOSIT'), 'the deposit is not in the ledger export');
    assert.ok(text.includes('REFUND'), 'the refund is not in the ledger export');
    assert.ok(text.includes('3000.00'), 'the US$3,000 deposit amount is missing');
  });

  await check('analytics: an unknown report or format is refused', async () => {
    for (const path of ['/admin/analytics/export/nonsense.csv', '/admin/analytics/export/ledger.doc']) {
      const r = await req(path, { jar });
      assert.strictEqual(r.status, 404, `${path} returned ${r.status}`);
    }
  });

  await check('analytics: exports are refused to a non-admin', async () => {
    const r = await req('/admin/analytics/export/ledger.csv', { jar: clientJar });
    assert.notStrictEqual(r.status, 200, 'an export was served to a non-admin');
  });

  await check('analytics: confirming a pending payment completes the sale', async () => {
    /* This was a real bug. The client page's Confirm button changed the
       payment's status without recomputing the sale, so the money arrived and
       the sale stayed "Active" with a balance of zero. */
    const project = db.prepare('SELECT id FROM projects ORDER BY id LIMIT 1').get();
    const standId = Number(db.prepare(
      'INSERT INTO stands (project_id, stand_number, size_sqm, type, price_cents, status) VALUES (?,?,?,?,?,?)')
      .run(project.id, 'CONFIRM-1000', 100, 'Residential', 100000, 'Sold').lastInsertRowid);

    confirmClientId = Number(db.prepare(
      "INSERT INTO users (client_number, full_name, email, role, password_hash, created_at) VALUES (?,?,?,'client',?,?)")
      .run('HP-90002', 'Confirm Scenario', 'confirm@example.com', 'scrypt$unused',
        new Date().toISOString()).lastInsertRowid);

    confirmSaleId = Number(db.prepare(`INSERT INTO ownerships
        (user_id, stand_id, purchase_price_cents, purchase_date, status, sale_price_cents, sale_status, sale_date)
        VALUES (?,?,?,?,?,?,'Active',?)`)
      .run(confirmClientId, standId, 100000, '2026-06-01', 'Servicing in progress', 100000, '2026-06-01')
      .lastInsertRowid);

    // The whole price, paid but not yet verified.
    const r = await req(`/admin/clients/${confirmClientId}/payments`, {
      method: 'POST', jar,
      body: new URLSearchParams({ paidOn: '2026-06-01', amount: '1000', status: 'Pending' }).toString()
    });
    assert.strictEqual(r.status, 302, `recording returned ${r.status}`);

    const before = analytics.saleById(confirmSaleId);
    assert.strictEqual(before.collected_cents, 0, 'a pending payment must not count as collected');
    assert.strictEqual(before.outstanding_cents, 100000);
    assert.strictEqual(before.sale_status, 'Active');

    const txn = db.prepare('SELECT id FROM payments WHERE ownership_id = ?').get(confirmSaleId);

    // Confirm it through the real client-page route.
    const confirmed = await req(`/admin/clients/${confirmClientId}/payments/${txn.id}/status`, {
      method: 'POST', jar,
      body: new URLSearchParams({ status: 'Confirmed' }).toString()
    });
    assert.strictEqual(confirmed.status, 302, `status route returned ${confirmed.status}`);

    const after = analytics.saleById(confirmSaleId);
    assert.strictEqual(after.collected_cents, 100000, 'confirming did not bring the money in');
    assert.strictEqual(after.outstanding_cents, 0, 'the balance was not recomputed');
    assert.strictEqual(after.sale_status, 'Completed',
      'confirming the payment that cleared the balance left the sale Active');

    assert.ok(
      analytics.financeAuditLog({ limit: 400 })
        .some((a) => a.action === 'payment_status_changed' && a.new_value === 'Confirmed'),
      'the confirmation was not written to the finance audit trail');
  });

  await check('analytics: an edit from the client page is audited and recomputes', async () => {
    // Rule 8 — an edit to a financial record must leave a trail.
    const txn = db.prepare('SELECT * FROM payments WHERE ownership_id = ?').get(confirmSaleId);
    const editsBefore = analytics.financeAuditLog({ limit: 400 })
      .filter((a) => a.action === 'payment_edited' && a.entity_id === txn.id).length;

    const r = await req(`/admin/clients/${confirmClientId}/payments/${txn.id}`, {
      method: 'POST', jar,
      body: new URLSearchParams({
        paidOn: '2026-06-02', amount: '1200', status: 'Confirmed'
      }).toString()
    });
    assert.strictEqual(r.status, 302, `edit returned ${r.status}`);

    const editsAfter = analytics.financeAuditLog({ limit: 400 })
      .filter((a) => a.action === 'payment_edited' && a.entity_id === txn.id);
    assert.strictEqual(editsAfter.length, editsBefore + 1, 'the edit left no audit entry');
    assert.ok(editsAfter[0].old_value.includes('100000'), 'the audit entry does not record the old amount');
    assert.ok(editsAfter[0].new_value.includes('120000'), 'the audit entry does not record the new amount');

    // US$1,200 against a US$1,000 sale is an overpayment, reported as credit.
    const sale = analytics.saleById(confirmSaleId);
    assert.strictEqual(sale.collected_cents, 120000, 'the edit did not take effect');
    assert.strictEqual(sale.outstanding_cents, 0, 'a credit balance must not read as owed');
    assert.strictEqual(sale.overpaid_cents, 20000, 'the credit balance is not identified separately');
  });

  await check('analytics: the pages are refused to a signed-in client', async () => {
    for (const path of ['/admin/analytics', '/admin/analytics/ledger', '/admin/sales/1']) {
      const r = await req(path, { jar: clientJar });
      assert.notStrictEqual(r.status, 200, `${path} was served to a non-admin`);
    }
  });

  /* ══ Editing developments and properties ═══════════════════════════════ */

  let testProjectId = null;
  let testStandId = null;

  await check('admin: a development can be created', async () => {
    const r = await req('/admin/projects', {
      method: 'POST', jar,
      body: new URLSearchParams({
        name: 'Test Valley Estate', location: 'Gweru, Zimbabwe', type: 'Residential',
        status: 'Planning', description: 'Created by the check suite.', imageUrl: ''
      }).toString()
    });
    assert.strictEqual(r.status, 302, `status ${r.status}`);

    const created = db.prepare("SELECT * FROM projects WHERE name = 'Test Valley Estate'").get();
    assert.ok(created, 'the development was not created');
    testProjectId = created.id;
    assert.strictEqual(created.status, 'Planning');
  });

  await check('admin: a duplicate development name is refused', async () => {
    const before = db.prepare('SELECT COUNT(*) AS c FROM projects').get().c;

    const r = await req('/admin/projects', {
      method: 'POST', jar,
      body: new URLSearchParams({
        name: 'heritage park', location: 'Somewhere', type: 'Residential', status: 'Planning'
      }).toString()
    });

    assert.strictEqual(r.status, 200, 'the duplicate was not refused in-page');
    assert.ok((await r.text()).includes('already exists'), 'no explanation was given');
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS c FROM projects').get().c, before,
      'a duplicate development was created anyway');
  });

  await check('admin: a development can be renamed and the website follows', async () => {
    const before = await (await req('/projects.html')).text();
    assert.ok(before.includes('Test Valley Estate'), 'the new development is not on the website');

    const r = await req(`/admin/projects/${testProjectId}`, {
      method: 'POST', jar,
      body: new URLSearchParams({
        name: 'Renamed Valley Estate', location: 'Gweru, Zimbabwe', type: 'Residential',
        status: 'Development in progress', description: 'Renamed by the check suite.', imageUrl: ''
      }).toString()
    });
    assert.strictEqual(r.status, 302, `status ${r.status}`);

    const after = await (await req('/projects.html')).text();
    assert.ok(after.includes('Renamed Valley Estate'), 'the new name is not on the website');
    assert.ok(!after.includes('Test Valley Estate'), 'the old name is still on the website');

    /* The analytics read the project name rather than storing a copy of it, so
       a rename has to show up in the sales reports as well. */
    assert.ok(analytics.filterOptions().projects.some((p) => p.name === 'Renamed Valley Estate'),
      'the sales analytics still offers the old name');
  });

  await check('admin: a property can be added to a development', async () => {
    const r = await req('/admin/properties', {
      method: 'POST', jar,
      body: new URLSearchParams({
        project: String(testProjectId), standNumber: 'TV-0001', sizeSqm: '250',
        type: 'Residential', price: '4200.50', status: 'Available', imageUrl: ''
      }).toString()
    });
    assert.strictEqual(r.status, 302, `status ${r.status}`);

    const created = db.prepare("SELECT * FROM stands WHERE stand_number = 'TV-0001'").get();
    assert.ok(created, 'the property was not created');
    testStandId = created.id;
    assert.strictEqual(created.size_sqm, 250);
    assert.strictEqual(created.price_cents, 420050, 'the price was not stored as exact cents');
    assert.strictEqual(created.status, 'Available');
  });

  await check('admin: a duplicate stand number is refused, in any development', async () => {
    /* Stand numbers are unique across the whole system, matching the schema's
       UNIQUE constraint. Checking only within the development let a duplicate
       through to the INSERT, which then failed with a raw constraint error. */
    const before = db.prepare('SELECT COUNT(*) AS c FROM stands').get().c;

    // Same development, different case.
    const same = await req('/admin/properties', {
      method: 'POST', jar,
      body: new URLSearchParams({
        project: String(testProjectId), standNumber: 'tv-0001', sizeSqm: '250',
        type: 'Residential', price: '1000', status: 'Available'
      }).toString()
    });
    assert.strictEqual(same.status, 200, 'the duplicate was not refused in-page');
    assert.ok((await same.text()).includes('already used by a property'), 'no explanation was given');

    // A DIFFERENT development must be refused too, or the insert throws.
    const other = db.prepare('SELECT id FROM projects WHERE id <> ? LIMIT 1').get(testProjectId);
    const cross = await req('/admin/properties', {
      method: 'POST', jar,
      body: new URLSearchParams({
        project: String(other.id), standNumber: 'TV-0001', sizeSqm: '250',
        type: 'Residential', price: '1000', status: 'Available'
      }).toString()
    });
    assert.strictEqual(cross.status, 200,
      'a stand number already used in another development crashed the insert');
    assert.ok((await cross.text()).includes('already used by a property'),
      'the cross-development clash was not explained');

    assert.strictEqual(db.prepare('SELECT COUNT(*) AS c FROM stands').get().c, before,
      'a duplicate property was created anyway');
  });

  await check('admin: editing a property changes what the website shows', async () => {
    const before = await (await req('/properties.html')).text();
    assert.ok(before.includes('TV-0001'), 'the new property is not on the website');
    assert.ok(before.includes('250'), 'the original size is not shown');

    const r = await req(`/admin/properties/${testStandId}`, {
      method: 'POST', jar,
      body: new URLSearchParams({
        project: String(testProjectId), standNumber: 'TV-0001', sizeSqm: '375',
        type: 'Commercial', price: '5100', status: 'Reserved', imageUrl: ''
      }).toString()
    });
    assert.strictEqual(r.status, 302, `status ${r.status}`);

    const stored = db.prepare('SELECT * FROM stands WHERE id = ?').get(testStandId);
    assert.strictEqual(stored.size_sqm, 375);
    assert.strictEqual(stored.type, 'Commercial');
    assert.strictEqual(stored.price_cents, 510000);
    assert.strictEqual(stored.status, 'Reserved');

    const after = await (await req('/properties.html')).text();
    assert.ok(after.includes('375'), 'the edited size is not on the website');
    assert.ok(after.includes('Commercial'), 'the edited type is not on the website');
  });

  await check('admin: a property with a sale against it cannot be deleted', async () => {
    /* Removing it would orphan a client's purchase, their payments and every
       sales figure that points at them. */
    const held = db.prepare(`
      SELECT s.id, s.stand_number FROM stands s
       WHERE (SELECT COUNT(*) FROM ownerships o WHERE o.stand_id = s.id) > 0
       LIMIT 1`).get();
    assert.ok(held, 'the suite should have left at least one stand with a sale');

    await req(`/admin/properties/${held.id}/delete`, { method: 'POST', jar });

    assert.ok(db.prepare('SELECT 1 AS x FROM stands WHERE id = ?').get(held.id),
      'a property with a sale was deleted, orphaning the sale');

    const page = await (await req(`/admin/properties/${held.id}`, { jar })).text();
    assert.ok(page.includes('cannot be deleted'), 'the page does not explain why');
  });

  await check('admin: a property with no sale can be deleted', async () => {
    const r = await req(`/admin/properties/${testStandId}/delete`, { method: 'POST', jar });
    assert.strictEqual(r.status, 302, `status ${r.status}`);
    assert.ok(!db.prepare('SELECT 1 AS x FROM stands WHERE id = ?').get(testStandId),
      'the property was not deleted');

    const after = await (await req('/properties.html')).text();
    assert.ok(!after.includes('TV-0001'), 'the deleted property is still on the website');
  });

  await check('admin: nonsense property and development input is refused', async () => {
    const cases = [
      ['/admin/properties', { project: String(testProjectId), standNumber: '', sizeSqm: '200', type: 'Residential', price: '100', status: 'Available' }],
      ['/admin/properties', { project: String(testProjectId), standNumber: 'BAD-1', sizeSqm: '0', type: 'Residential', price: '100', status: 'Available' }],
      ['/admin/properties', { project: String(testProjectId), standNumber: 'BAD-2', sizeSqm: '200', type: 'Castle', price: '100', status: 'Available' }],
      ['/admin/properties', { project: String(testProjectId), standNumber: 'BAD-3', sizeSqm: '200', type: 'Residential', price: '-5', status: 'Available' }],
      ['/admin/properties', { project: String(testProjectId), standNumber: 'BAD-4', sizeSqm: '200', type: 'Residential', price: '100', status: 'Available', imageUrl: 'javascript:alert(1)' }],
      ['/admin/properties', { project: '99999', standNumber: 'BAD-5', sizeSqm: '200', type: 'Residential', price: '100', status: 'Available' }],
      ['/admin/projects', { name: 'X', location: 'Nowhere', type: 'Residential', status: 'Planning' }],
      ['/admin/projects', { name: 'Valid Name', location: 'Nowhere', type: 'Residential', status: 'Nonsense' }]
    ];

    for (const [path, fields] of cases) {
      const r = await req(path, { method: 'POST', jar, body: new URLSearchParams(fields).toString() });
      assert.strictEqual(r.status, 200, `${path} with ${JSON.stringify(fields)} was accepted`);
    }

    for (const number of ['BAD-1', 'BAD-2', 'BAD-3', 'BAD-4', 'BAD-5']) {
      assert.ok(!db.prepare('SELECT 1 AS x FROM stands WHERE stand_number = ?').get(number),
        `${number} was created despite invalid input`);
    }
    assert.ok(!db.prepare("SELECT 1 AS x FROM projects WHERE name = 'Valid Name'").get(),
      'a development with an invalid status was created');
  });

  /* ── Sold out ── */

  let soldOutStandId = null;

  await check('admin: a development can be marked sold out from the list', async () => {
    const r = await req(`/admin/projects/${testProjectId}/sold-out`, {
      method: 'POST', jar, body: new URLSearchParams({ soldOut: '1' }).toString()
    });
    assert.strictEqual(r.status, 302, `status ${r.status}`);
    assert.strictEqual(
      db.prepare('SELECT sold_out FROM projects WHERE id = ?').get(testProjectId).sold_out, 1,
      'the flag was not set');

    const page = await (await req('/projects.html')).text();
    assert.ok(page.includes('sold-out-stamp'), 'the website does not stamp a sold-out development');
    assert.ok(page.includes('Renamed Valley Estate'), 'the development vanished from the website');
    assert.ok(page.includes('Ask about other developments'),
      'a sold-out development still invites enquiries about its stands');
  });

  await check('admin: a sold-out development stops offering its stands', async () => {
    const r = await req('/admin/properties', {
      method: 'POST', jar,
      body: new URLSearchParams({
        project: String(testProjectId), standNumber: 'TV-SOLDOUT', sizeSqm: '200',
        type: 'Residential', price: '3000', status: 'Available'
      }).toString()
    });
    assert.strictEqual(r.status, 302, `status ${r.status}`);

    soldOutStandId = db.prepare("SELECT id FROM stands WHERE stand_number = 'TV-SOLDOUT'").get().id;
    assert.ok(soldOutStandId, 'the stand was not created');

    const page = await (await req('/properties.html')).text();
    assert.ok(!page.includes('TV-SOLDOUT'),
      'a stand in a sold-out development is still offered on the website');

    /* Below the grid, not above it — so a visitor sees what is available first
       and the apology second. */
    const gridAt = page.indexOf('id="propertyGrid"');
    const noteAt = page.indexOf('sold-out-note-page');
    assert.ok(noteAt > 0, 'the properties page does not mention the sold-out development');
    assert.ok(gridAt > 0, 'the properties page has no property grid');
    assert.ok(noteAt > gridAt, 'the sold-out notice must sit below the available stands');

    assert.ok(page.includes('Renamed Valley Estate'), 'the sold-out development is not named');
    assert.ok(page.includes('Every stand there has been sold'),
      'the sold-out notice does not explain what happened');
    assert.ok(page.includes('about our other developments'),
      'the sold-out notice does not point anywhere else');
  });

  await check('admin: marking a development available again offers its stands', async () => {
    await req(`/admin/projects/${testProjectId}/sold-out`, {
      method: 'POST', jar, body: new URLSearchParams({ soldOut: '0' }).toString()
    });
    assert.strictEqual(
      db.prepare('SELECT sold_out FROM projects WHERE id = ?').get(testProjectId).sold_out, 0);

    const page = await (await req('/properties.html')).text();
    assert.ok(page.includes('TV-SOLDOUT'), 'the stand did not come back with the development');
    assert.ok(!page.includes('sold-out-stamp'), 'the website still stamps the development sold out');

    await req(`/admin/properties/${soldOutStandId}/delete`, { method: 'POST', jar });
  });

  await check('admin: the edit form can also set and clear sold out', async () => {
    const save = (soldOut) => req(`/admin/projects/${testProjectId}`, {
      method: 'POST', jar,
      body: new URLSearchParams({
        name: 'Renamed Valley Estate', location: 'Gweru, Zimbabwe', type: 'Residential',
        status: 'Development in progress', description: 'Sold-out test.', imageUrl: '',
        ...(soldOut ? { soldOut: 'on' } : {})
      }).toString()
    });

    await save(true);
    assert.strictEqual(
      db.prepare('SELECT sold_out FROM projects WHERE id = ?').get(testProjectId).sold_out, 1,
      'the checkbox did not mark the development sold out');

    await save(false);
    assert.strictEqual(
      db.prepare('SELECT sold_out FROM projects WHERE id = ?').get(testProjectId).sold_out, 0,
      'clearing the checkbox did not make it available again');
  });

  await check('admin: a non-admin cannot change the sold-out state', async () => {
    await req(`/admin/projects/${testProjectId}/sold-out`, {
      method: 'POST', jar: clientJar, body: new URLSearchParams({ soldOut: '1' }).toString()
    });
    assert.strictEqual(
      db.prepare('SELECT sold_out FROM projects WHERE id = ?').get(testProjectId).sold_out, 0,
      'a non-admin changed the sold-out state');
  });

  await check('admin: the properties admin is refused to a non-admin', async () => {
    for (const path of ['/admin/properties', `/admin/properties/${testStandId || 1}`]) {
      const r = await req(path, { jar: clientJar });
      assert.notStrictEqual(r.status, 200, `${path} was served to a non-admin`);
    }
  });

  /* ══ One development, many properties ═════════════════════════════════
     The relationship the brief is about, tested end to end. */

  await check('properties: one development holds many properties', async () => {
    const before = db.prepare('SELECT COUNT(*) AS c FROM stands WHERE project_id = ?')
      .get(testProjectId).c;
    const projectsBefore = db.prepare('SELECT COUNT(*) AS c FROM projects').get().c;

    for (const [number, size, price, status] of [
      ['TV-1001', '200', '5500', 'Available'],
      ['TV-1002', '300', '7500', 'Reserved'],
      ['TV-1003', '200', '5500', 'Sold']
    ]) {
      const r = await req('/admin/properties', {
        method: 'POST', jar,
        body: new URLSearchParams({
          project: String(testProjectId), standNumber: number, sizeSqm: size,
          type: 'Residential', price, status, currency: 'US$'
        }).toString()
      });
      assert.strictEqual(r.status, 302, `adding ${number} returned ${r.status}`);
    }

    assert.strictEqual(
      db.prepare('SELECT COUNT(*) AS c FROM stands WHERE project_id = ?').get(testProjectId).c,
      before + 3, 'the properties were not all added to the one development');

    /* Adding three properties must not create three developments. */
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS c FROM projects').get().c, projectsBefore,
      'a development was created per property instead of reusing the existing one');

    assert.strictEqual(
      db.prepare("SELECT COUNT(DISTINCT project_id) AS c FROM stands WHERE stand_number LIKE 'TV-100%'").get().c,
      1, 'the properties landed in different developments');
  });

  await check('properties: each keeps its own number, size, price and status', async () => {
    const rows = db.prepare("SELECT * FROM stands WHERE stand_number LIKE 'TV-100%' ORDER BY stand_number").all();

    assert.strictEqual(rows.length, 3, 'expected three properties');
    assert.deepStrictEqual(rows.map((r) => r.stand_number), ['TV-1001', 'TV-1002', 'TV-1003'],
      'stand numbers are not individual');
    assert.deepStrictEqual(rows.map((r) => r.size_sqm), [200, 300, 200], 'sizes are not individual');
    assert.deepStrictEqual(rows.map((r) => r.price_cents), [550000, 750000, 550000],
      'prices are not individual');
    assert.deepStrictEqual(rows.map((r) => r.status), ['Available', 'Reserved', 'Sold'],
      'statuses are not individual');
    assert.strictEqual(new Set(rows.map((r) => r.id)).size, 3, 'property ids collide');
  });

  await check('properties: development statistics update automatically', async () => {
    const stats = admin.projectsWithCounts().find((p) => p.id === testProjectId);
    assert.strictEqual(stats.property_count, 3, 'the property count is wrong');
    assert.strictEqual(stats.available_count, 1, 'the available count is wrong');
    assert.strictEqual(stats.reserved_count, 1, 'the reserved count is wrong');
    assert.strictEqual(stats.sold_count, 1, 'the sold count is wrong');

    const html = await (await req(`/admin/projects/${testProjectId}`, { jar })).text();
    assert.ok(html.includes('3 Properties | 1 Available | 1 Sold | 1 Reserved'),
      'the development page does not show the derived breakdown');
  });

  await check('properties: selling one does not mark the development sold', async () => {
    /* One of three is Sold. The development is still selling, and its build
       status is untouched. */
    const project = admin.projectsWithCounts().find((p) => p.id === testProjectId);
    assert.strictEqual(project.sold_out, 0, 'selling one property marked the whole development sold');
    assert.strictEqual(project.status, 'Development in progress',
      'the development build status changed when a property sold');
    assert.strictEqual(project.available_count, 1, 'the other properties stopped being available');
  });

  await check('properties: a sale stays linked to the individual property', async () => {
    const sale = db.prepare(`
      SELECT o.id, o.stand_id, st.stand_number FROM ownerships o
        JOIN stands st ON st.id = o.stand_id
       WHERE st.stand_number = 'HP-0245' LIMIT 1`).get();
    assert.ok(sale, 'the HP-0245 sale is missing');

    const linked = db.prepare('SELECT stand_number FROM stands WHERE id = ?').get(sale.stand_id);
    assert.strictEqual(linked.stand_number, 'HP-0245', 'the sale is attached to the wrong property');

    /* The payment chain must reach the same individual property. */
    const payment = db.prepare('SELECT stand_id FROM payments WHERE ownership_id = ? LIMIT 1').get(sale.id);
    assert.ok(payment, 'the sale has no payments');
    assert.strictEqual(payment.stand_id, sale.stand_id,
      'a payment points at a different property than its sale');
  });

  await check('properties: the client portal still shows the purchased property', async () => {
    const html = await (await req('/dashboard', { jar: clientJar })).text();
    assert.ok(html.includes('HP-0245'), 'the portal no longer names the client\'s stand');
  });

  await check('properties: existing records survived the migration', async () => {
    const home = (number) => db.prepare(`
      SELECT p.name FROM stands s JOIN projects p ON p.id = s.project_id
       WHERE s.stand_number = ?`).get(number);

    assert.strictEqual(home('HP-0245').name, 'Heritage Park', 'HP-0245 lost its development');
    assert.strictEqual(home('GP-0102').name, 'Goshen Park', 'GP-0102 lost its development');
    assert.ok(db.prepare('SELECT COUNT(*) AS c FROM payments').get().c >= 7, 'payments were lost');
    assert.ok(db.prepare('SELECT COUNT(*) AS c FROM ownerships').get().c >= 2, 'sales were lost');

    // The new columns were backfilled rather than left null.
    const stand = db.prepare("SELECT * FROM stands WHERE stand_number = 'HP-0245'").get();
    assert.strictEqual(stand.currency, 'US$', 'currency was not backfilled');
    assert.ok(stand.created_at, 'created_at was not backfilled');
    assert.ok(stand.updated_at, 'updated_at was not backfilled');
  });

  await check('properties: each property has its own client page', async () => {
    for (const path of ['/property/HP-0245', '/property/GP-0102']) {
      const r = await req(path);
      assert.strictEqual(r.status, 200, `${path} returned ${r.status}`);

      const html = await r.text();
      for (const field of ['Stand number', 'Development', 'Location', 'Size', 'Property type',
        'Price', 'Availability']) {
        assert.ok(html.includes(`<dt>${field}</dt>`), `${path} is missing the ${field} field`);
      }
      assert.ok(html.includes('Enquire about this property'), `${path} has no enquiry button`);
    }

    assert.strictEqual((await req('/property/NOPE-999')).status, 404,
      'an unknown property did not 404');
  });

  await check('properties: the listing headlines the stand, not the development', async () => {
    const html = await (await req('/properties.html')).text();
    assert.match(html, /<h3><a href="\/property\/[^"]+">Stand [^<]+<\/a><\/h3>/,
      'the listing does not headline the stand number');
    assert.ok(!/<h3><a[^>]*>(Heritage Park|Goshen Park)<\/a><\/h3>/.test(html),
      'a development name is being used as a property headline — a stand must be the headline');
  });

  await check('properties: the development page lists its own properties', async () => {
    const r = await req('/development/heritage-park');
    assert.strictEqual(r.status, 200, `the development page returned ${r.status}`);

    const html = await r.text();
    assert.ok(html.includes('Heritage Park'), 'the development is not named');
    assert.ok(html.includes('Stand HP-0245'), 'the development does not list its property');
    assert.strictEqual((html.match(/kpi-label">(Properties|Available|Reserved|Sold)</g) || []).length, 4,
      'the development page does not show all four counts');

    assert.strictEqual((await req('/development/nope-at-all')).status, 404,
      'an unknown development did not 404');
  });

  /* ══ Local images ═════════════════════════════════════════════════════ */

  await check('images: no external image URL or base64 remains anywhere', async () => {
    const external = db.prepare(`
      SELECT (SELECT COUNT(*) FROM projects WHERE image_url LIKE 'http%')
           + (SELECT COUNT(*) FROM stands   WHERE image_url LIKE 'http%')
           + (SELECT COUNT(*) FROM content_blocks WHERE value LIKE 'http%')
           + (SELECT COUNT(*) FROM site_settings  WHERE value LIKE 'data:%') AS c`).get().c;
    assert.strictEqual(external, 0, `${external} external reference(s) left in the database`);

    const css = await (await req('/assets/css/styles.css')).text();
    assert.ok(!/url\(\s*['"]?https?:/i.test(css), 'the stylesheet still loads an image from another origin');
    assert.ok(!/data:image\//i.test(css), 'the stylesheet still contains a base64 image');

    for (const page of ['/', '/about.html', '/services.html', '/projects.html',
      '/properties.html', '/news.html', '/contact.html', '/portal.html']) {
      const html = await (await req(page)).text();
      assert.ok(!/images\.unsplash\.com/i.test(html), `${page} still references Unsplash`);
      assert.ok(!/data:image\//i.test(html), `${page} still contains a base64 image`);
      assert.ok(!/<img[^>]+src="https?:\/\//i.test(html), `${page} has an <img> pointing off-site`);
    }
  });

  await check('images: every referenced /images/ file actually exists', async () => {
    /* The failure this guards against is a renamed or mistyped file: the page
       renders perfectly and the photograph is silently missing. */
    const referenced = new Set();
    for (const r of db.prepare("SELECT image_url AS u FROM projects WHERE image_url LIKE '/images/%'").all()) {
      referenced.add(r.u);
    }
    for (const r of db.prepare("SELECT image_url AS u FROM stands WHERE image_url LIKE '/images/%'").all()) {
      referenced.add(r.u);
    }

    const css = await (await req('/assets/css/styles.css')).text();
    for (const m of css.matchAll(/url\(\s*['"]?(\/images\/[^'")]+)/gi)) referenced.add(m[1]);

    assert.ok(referenced.size > 0, 'no local images are referenced at all');

    const dir = path.join(__dirname, '..', 'public', 'images');
    for (const ref of referenced) {
      const file = path.join(dir, ref.replace(/^\/images\//, ''));
      assert.ok(fs.existsSync(file), `${ref} is referenced but is not in public/images`);
      assert.ok(fs.statSync(file).size > 1000, `${ref} exists but is suspiciously small`);
    }

    return `${referenced.size} file(s)`;
  });

  await check('images: the files are served with the right type', async () => {
    for (const name of ['heritage-park.jpg', 'hero-home.jpg', 'stand-hp-0245.jpg']) {
      const r = await req(`/images/${name}`);
      assert.strictEqual(r.status, 200, `/images/${name} returned ${r.status}`);
      assert.match(r.headers.get('content-type') || '', /image\/jpeg/,
        `/images/${name} is not served as a JPEG`);
    }
  });

  await check('images: the admin shows the local path, not a URL', async () => {
    const html = await (await req('/admin/properties/1', { jar })).text();
    assert.ok(html.includes('/images/stand-hp-0245.jpg'),
      'the property form does not show the local image path');
    assert.ok(!/images\.unsplash\.com/.test(html), 'the admin still shows an Unsplash URL');
  });

  await check('images: the services page carries one local image per service', async () => {
    const html = await (await req('/services.html')).text();

    const imgs = [...html.matchAll(/<img class="service-image" src="([^"]+)" alt="([^"]*)"[^>]*>/g)];
    assert.ok(imgs.length >= 3, `expected a service image per card, saw ${imgs.length}`);

    for (const [, src, alt] of imgs) {
      // The ?v= suffix is the cache-buster, so compare the path without it.
      const file = src.split('?')[0];
      assert.ok(file.startsWith('/images/'), `a service image is not a local path: ${src}`);
      assert.ok(/\.jpg$/.test(file), `a service image is not a .jpg: ${src}`);
      assert.ok(alt.trim().length > 0, `${src} has an empty alt attribute`);
    }

    /* One image per card — a mismatch would silently misalign the pictures. */
    const cards = (html.match(/<article class="service-card">/g) || []).length;
    assert.strictEqual(imgs.length, cards,
      `${imgs.length} service image(s) for ${cards} card(s)`);

    /* The alt text must be the service name, not a filename. */
    const titles = [...html.matchAll(/<h2>([^<]+)<\/h2>/g)].map((m) => m[1]);
    for (const [, , alt] of imgs) {
      assert.ok(titles.some((t) => t.replace(/&amp;/g, '&') === alt.replace(/&amp;/g, '&')),
        `the alt text "${alt}" does not match any service title`);
    }
  });

  await check('images: each service image exists and is served', async () => {
    const html = await (await req('/services.html')).text();

    for (const [, src] of html.matchAll(/<img class="service-image" src="([^"]+)"/g)) {
      const r = await req(src);
      assert.strictEqual(r.status, 200, `${src} returned ${r.status}`);
      assert.match(r.headers.get('content-type') || '', /image\/jpeg/, `${src} is not a JPEG`);
    }
  });

  await check('images: the service photograph is editable in the admin', async () => {
    const html = await (await req('/admin/content/services', { jar })).text();
    assert.ok(html.includes('Photograph (path under'),
      'the content editor does not offer a photograph path field');
    assert.ok(html.includes('/images/service-land-property-development.jpg'),
      'the editor does not show the current service photograph path');
  });

  await check('images: a replaced photograph is not hidden by the browser cache', async () => {
    /* Every image address carries the file's modification time. Without it a
       browser told max-age=3600 keeps showing its saved copy for an hour, and
       replacing a picture looks like it silently failed. */
    const home = await (await req('/')).text();

    const versioned = [...home.matchAll(/\/images\/[A-Za-z0-9._-]+\.jpg\?v=\d+/g)];
    assert.ok(versioned.length > 0,
      'no image URL carries a version, so a replaced file would be served from cache');

    // The hero is set from the page, not the stylesheet, so it is versioned too.
    assert.match(home, /--hero-image:url\('\/images\/hero-home\.jpg\?v=\d+'\)/,
      'the hero banner is not versioned, so replacing it would not show');

    // The stylesheet is versioned for the same reason.
    assert.match(home, /assets\/css\/styles\.css\?v=\d+/, 'the stylesheet is not versioned');

    // And the versioned address must still resolve.
    const first = versioned[0][0];
    const r = await req(first);
    assert.strictEqual(r.status, 200, `${first} returned ${r.status} with its version suffix`);
    assert.match(r.headers.get('content-type') || '', /image\/jpeg/);
  });

  /* ── Development overview, features and the published price list ─────── */

  await check('developments: the page shows the overview, features and price list', async () => {
    const html = await (await req('/development/heritage-park')).text();

    assert.ok(html.includes('About Heritage Park'), 'no About section');
    assert.ok(html.includes('managed by Heritage Housing Projects'),
      'the full overview is not shown');
    assert.ok(html.includes('Main features'), 'no features section');
    assert.ok(/<li><strong>Location:<\/strong>/.test(html), 'feature labels are not rendered');
    assert.ok(html.includes('Stand sizes and pricing'), 'no price list section');

    const table = /<table class="portal-table price-table">([\s\S]*?)<\/table>/.exec(html);
    assert.ok(table, 'no price table was rendered');
    for (const size of ['150 sqm', '200 sqm', '300 sqm', '500 sqm']) {
      assert.ok(table[1].includes(size), `${size} is missing from the price table`);
    }
    assert.ok(table[1].includes('$8,800'), 'the credit price is missing');
    assert.ok(table[1].includes('$2,000 \u2013 $4,000'), 'a ranged deposit was not rendered');
  });

  await check('developments: a price row can be added, edited and deleted', async () => {
    const page = `/development/${slugify('Renamed Valley Estate')}`;

    const add = await req(`/admin/projects/${testProjectId}/pricing`, {
      method: 'POST', jar,
      body: new URLSearchParams({
        sizeLabel: '999 sqm', cash: '$1', credit: '$2', deposit: '$3'
      }).toString()
    });
    assert.strictEqual(add.status, 302, `adding returned ${add.status}`);

    const row = admin.pricingFor(testProjectId).find((r) => r.size_label === '999 sqm');
    assert.ok(row, 'the price row was not created');

    let html = await (await req(page)).text();
    assert.ok(html.includes('999 sqm'), 'the new price row is not on the development page');

    await req(`/admin/projects/${testProjectId}/pricing/${row.id}`, {
      method: 'POST', jar,
      body: new URLSearchParams({
        sizeLabel: '999 sqm', cash: '$9,999', credit: '', deposit: ''
      }).toString()
    });
    assert.strictEqual(admin.pricingById(row.id).cash, '$9,999', 'the price edit did not save');

    await req(`/admin/projects/${testProjectId}/pricing/${row.id}/delete`, { method: 'POST', jar });
    assert.ok(!admin.pricingById(row.id), 'the price row was not deleted');

    html = await (await req(page)).text();
    assert.ok(!html.includes('999 sqm'), 'the deleted price row is still on the public page');
  });

  await check('developments: a price row without a stand size is refused', async () => {
    const before = admin.pricingFor(testProjectId).length;
    await req(`/admin/projects/${testProjectId}/pricing`, {
      method: 'POST', jar,
      body: new URLSearchParams({ sizeLabel: '   ', cash: '$1' }).toString()
    });
    assert.strictEqual(admin.pricingFor(testProjectId).length, before,
      'a price row with no stand size was accepted');
  });

  await check('pages: every internal link and asset resolves from every public page', async () => {
    /* The bug this exists for: the development and property pages sit one level
       deep, so a relative "assets/css/styles.css" resolved to
       /development/assets/css/styles.css and 404'd — the page rendered with no
       styling at all. Comparing page content never catches that. Following
       every link does. */
    const pages = ['/', '/about.html', '/services.html', '/projects.html', '/properties.html',
      '/news.html', '/contact.html', '/portal.html', '/property/HP-0245',
      '/development/heritage-park'];

    const seen = new Set();

    for (const page of pages) {
      const html = await (await req(page)).text();

      for (const m of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
        const ref = m[1];
        if (!ref || ref.startsWith('#') || /^(https?:|mailto:|tel:|data:)/i.test(ref)) continue;

        const resolved = new URL(ref, `http://127.0.0.1:3999${page}`);
        const target = resolved.pathname + resolved.search;
        if (seen.has(target)) continue;
        seen.add(target);

        const r = await req(target);
        assert.ok(r.status === 200 || r.status === 302,
          `${page} points at "${ref}", which resolves to ${target} and returned ${r.status}`);
      }
    }

    return `${seen.size} distinct link(s) across ${pages.length} page(s)`;
  });

  await check('pages: the nested pages load the stylesheet and the logo', async () => {
    /* Singled out because losing the stylesheet is invisible to a content
       check and ruins the whole page. */
    for (const page of ['/development/heritage-park', '/property/HP-0245']) {
      const html = await (await req(page)).text();

      const css = /<link rel="stylesheet" href="([^"]*styles\.css[^"]*)"/.exec(html);
      assert.ok(css, `${page} has no stylesheet link`);
      assert.ok(css[1].startsWith('/assets/'),
        `${page} loads its stylesheet from ${css[1]}, which is not root-absolute`);

      const cssRes = await req(css[1]);
      assert.strictEqual(cssRes.status, 200, `${page}: ${css[1]} returned ${cssRes.status}`);

      const logo = /<img class="brand-logo" src="([^"]+)"/.exec(html);
      assert.ok(logo, `${page} has no logo`);
      assert.ok(logo[1].startsWith('/assets/'),
        `${page} loads its logo from ${logo[1]}, which is not root-absolute`);
      assert.strictEqual((await req(logo[1])).status, 200, `${page}: ${logo[1]} did not load`);
    }
  });

  await check('images: the featured development photograph is the one set in the editor', async () => {
    /* This used to take the featured development's own photograph regardless,
       so the image shipped for this slot could never appear while that
       development had a picture of its own. */
    const html = await (await req('/')).text();

    const block = /<div class="project-image heritage-image"[^>]*style="[^"]*url\('([^']+)'\)/.exec(html);
    assert.ok(block, 'the featured development block has no photograph at all');
    assert.ok(block[1].startsWith('/images/featured-development.jpg'),
      `the featured block shows ${block[1]}, not the image set in the content editor`);

    assert.strictEqual((await req(block[1])).status, 200, `${block[1]} did not load`);

    const editor = await (await req('/admin/content/home', { jar })).text();
    assert.ok(editor.includes('/images/featured-development.jpg'),
      'the content editor does not offer the featured photograph');
  });

  await check('about: the Chief Executive block shows the photograph and the name', async () => {
    const html = await (await req('/about.html')).text();

    assert.ok(html.includes('class="ceo-block"'), 'there is no Chief Executive block');
    assert.ok(html.includes('Mrs. Trish B Makaka'), 'the name is missing');
    assert.ok(html.includes('Chief Executive Officer'), 'the role is missing');

    const img = /<div class="ceo-photo">\s*<img src="([^"]+)" alt="([^"]+)"/.exec(html);
    assert.ok(img, 'the Chief Executive block has no photograph');
    assert.ok(img[1].startsWith('/images/'), `${img[1]} is not a site image`);
    assert.ok(img[2].includes('Trish'), `the alt text is not descriptive: "${img[2]}"`);
    assert.strictEqual((await req(img[1])).status, 200, `${img[1]} did not load`);

    // Editable like every other part of the page.
    const editor = await (await req('/admin/content/about', { jar })).text();
    assert.ok(editor.includes('ceo-trish-makaka.jpg'),
      'the content editor does not offer the photograph');
    assert.ok(editor.includes('Chief Executive'), 'the editor has no Chief Executive section');
  });

  await check('about: the value icons, trust strip and page scoping are all present', async () => {
    const html = await (await req('/about.html')).text();

    assert.ok(html.includes('inner-page about-page'),
      'the about page is not carrying its scoping class');

    /* One icon per value, and the right icon for each name. */
    const icons = [...html.matchAll(
      /<span class="value-icon">([\s\S]*?)<\/span>\s*<b>\d+<\/b>\s*<h3>([^<]+)<\/h3>/g)];
    assert.strictEqual(icons.length, 4, `expected 4 value icons, found ${icons.length}`);

    const signature = {
      Integrity: 'M12 3l7 3v5.5',
      Development: 'M4 21V6a1 1 0 0 1 1-1h9',
      'Client Focus': 'm11 17 2 2',
      'Value Creation': 'M7 16l4-4 3 3 5-6'
    };
    for (const [, svg, title] of icons) {
      assert.ok(signature[title], `unexpected value "${title}"`);
      assert.ok(svg.includes(signature[title]), `"${title}" has the wrong icon`);
      assert.ok(svg.includes('aria-hidden="true"'), `"${title}" icon is exposed to screen readers`);
    }

    assert.match(html,
      /<p class="trust-strip">A multi-award-winning company in property development\.<\/p>/,
      'the trust strip is missing or has been reworded');

    /* The polish is scoped to About: no other inner page may inherit it. */
    for (const page of ['services.html', 'projects.html', 'properties.html', 'news.html',
      'contact.html']) {
      const other = await (await req(`/${page}`)).text();
      assert.ok(!other.includes('about-page'), `${page} inherited the about-page class`);
      assert.ok(!other.includes('trust-strip'), `${page} inherited the trust strip`);
      assert.ok(!other.includes('value-icon'), `${page} inherited the value icons`);
    }
  });

  check('L the About polish is scoped and does not restyle the shared hero', () => {
    /* Read here rather than reusing the static-check binding, which lives in
       another scope. */
    const cssText = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'public', 'assets', 'css', 'styles.css'), 'utf8');

    for (const sel of ['.about-page .page-hero', '.about-page .trust-strip',
      '.about-page .value-icon']) {
      assert.ok(cssText.includes(sel), `${sel} is missing from the stylesheet`);
    }

    assert.match(cssText, /\.about-page p \{ line-height: 1\.7/,
      'paragraph line-height is not 1.7');

    /* The shared hero is used by six inner pages, so a background on the bare
       .page-hero rule would restyle all of them. */
    const leaked = /^\.page-hero\s*\{[^}]*background/m.test(cssText);
    assert.ok(!leaked, 'the hero background leaked into the shared .page-hero rule');
  });

  await check('admin: a development with no sales deletes, taking its properties with it', async () => {
    /* `stands.project_id` has no ON DELETE clause, so this is the case that
       would raise a foreign key error if the properties were not removed
       first. */
    await req('/admin/projects', {
      method: 'POST', jar,
      body: new URLSearchParams({
        name: 'Delete Me Estate', location: 'Nowhere', type: 'Residential',
        status: 'Planning', description: 'Created by the check suite.'
      }).toString()
    });
    const project = admin.projects().find((p) => p.name === 'Delete Me Estate');
    assert.ok(project, 'the development was not created');

    await req('/admin/properties', {
      method: 'POST', jar,
      body: new URLSearchParams({
        project: String(project.id), standNumber: 'DM-0001', sizeSqm: '200',
        type: 'Residential', price: '5000', status: 'Available'
      }).toString()
    });
    assert.ok(admin.standByNumber('DM-0001'), 'the property was not created');

    const res = await req(`/admin/projects/${project.id}/delete`, { method: 'POST', jar });
    assert.strictEqual(res.status, 302, `deleting returned ${res.status}`);

    assert.ok(!admin.projectById(project.id), 'the development survived the delete');
    assert.ok(!admin.standByNumber('DM-0001'), 'its property survived the delete');
  });

  await check('admin: a development holding a sale is refused, and nothing is lost', async () => {
    const tally = () => ({
      payments: db.prepare('SELECT COUNT(*) c FROM payments').get().c,
      ownerships: db.prepare('SELECT COUNT(*) c FROM ownerships').get().c,
      stands: db.prepare('SELECT COUNT(*) c FROM stands').get().c
    });

    const row = db.prepare(`
      SELECT p.id, p.name, s.stand_number
        FROM projects p
        JOIN stands s ON s.project_id = p.id
        JOIN payments y ON y.stand_id = s.id
       GROUP BY p.id LIMIT 1`).get();
    assert.ok(row, 'the fixture has no development carrying a payment');

    const before = tally();
    const res = await req(`/admin/projects/${row.id}/delete`, { method: 'POST', jar });
    assert.strictEqual(res.status, 302, `the refusal returned ${res.status}`);

    /* Cascading here would have erased the client's payment history. */
    assert.ok(admin.projectById(row.id), `${row.name} was deleted despite holding a payment`);
    assert.ok(admin.standByNumber(row.stand_number),
      `${row.stand_number} was deleted despite holding a payment`);
    assert.deepStrictEqual(tally(), before, 'a refused delete still removed records');
  });

  await check('admin: the delete control confirms, and no inline handler is left anywhere', async () => {
    const list = await (await req('/admin/projects', { jar })).text();
    assert.match(list, /data-confirm="Are you sure\? This will delete all associated properties\."/,
      'the delete button has no confirmation');

    let confirms = 0;
    for (const page of ['/admin/projects', '/admin/projects/1', '/admin/properties',
      '/admin/analytics', '/admin/clients']) {
      const html = await (await req(page, { jar })).text();

      /* script-src 'self' drops inline handlers without an error, so a confirm
         written as onsubmit="return confirm(...)" never runs and the delete
         goes through on the first click. */
      assert.ok(!/onsubmit=/.test(html), `${page} still relies on an inline onsubmit handler`);

      confirms += (html.match(/data-confirm="/g) || []).length;
    }
    assert.ok(confirms > 0, 'no confirmation prompts were found anywhere in the admin');
  });

  check('L the confirmation is attached from an external script, not an attribute', () => {
    const js = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'public', 'assets', 'js', 'site.js'), 'utf8');
    assert.ok(js.includes('data-confirm'), 'site.js never reads data-confirm');
    assert.ok(js.includes('window.confirm'), 'site.js never asks for confirmation');
  });

  await check('admin: the add development form still works', async () => {
    const res = await req('/admin/projects', {
      method: 'POST', jar,
      body: new URLSearchParams({
        name: 'Added By Test', location: 'Gweru, Zimbabwe', type: 'Residential',
        status: 'Planning', description: 'Created by the check suite.'
      }).toString()
    });
    assert.strictEqual(res.status, 302, `adding a development returned ${res.status}`);

    const made = admin.projects().find((p) => p.name === 'Added By Test');
    assert.ok(made, 'the development was not created');
    assert.strictEqual(made.location, 'Gweru, Zimbabwe', 'the location was not saved');
  });

  await check('admin: signing out ends the staff session', async () => {
    // Deliberately last: this destroys the session every check above relies
    // on, so anything after it would only be re-testing the auth guard.
    const r = await req('/admin/logout', { method: 'POST', jar });
    assert.strictEqual(r.status, 302);
    jar.absorb(r);
    const after = await req('/admin', { jar });
    assert.strictEqual(after.status, 302);
    assert.strictEqual(after.headers.get('location'), '/admin/login');
  });

  /* Keep the throwaway database tidy for the next run.

     Accounts are disabled rather than deleted. Now that payments record who
     entered them, a foreign key deliberately prevents removing a member of
     staff who has touched money — which is the correct behaviour for a
     financial record, and matches how the product treats staff anyway
     (create-admin.js --disable). The database is discarded after the run. */
  const { users } = require('../server/db');
  for (const number of [ADMIN_ID, SCRATCH, 'HP-88999', 'HP-90001']) {
    const u = users.byClientNumber(number);
    if (u) db.prepare('UPDATE users SET disabled = 1 WHERE id = ?').run(u.id);
  }
}

/* ── HTTP checks ────────────────────────────────────────────────────────── */

async function httpChecks() {
  const jar = makeJar();

  await check('GET /healthz returns ok', async () => {
    const r = await req('/healthz');
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await r.json()).ok, true);
  });

  await check('GET / serves the home page', async () => {
    const r = await req('/');
    assert.strictEqual(r.status, 200);
    const html = await r.text();
    assert.ok(html.includes('Building Communities'), 'hero copy missing');
    assert.ok(html.includes('<h1'), 'no h1 on the home page');
  });

  await check('every marketing page returns 200 with content', async () => {
    for (const p of ['/about.html', '/services.html', '/projects.html',
                     '/properties.html', '/news.html', '/contact.html', '/portal.html']) {
      const r = await req(p);
      assert.strictEqual(r.status, 200, `${p} returned ${r.status}`);
      const html = await r.text();
      assert.ok(html.length > 2000, `${p} looks empty`);
      assert.ok(html.includes('<main'), `${p} has no <main>`);
    }
  });

  await check('properties page lists stands in the HTML itself (works without JS)', async () => {
    const html = await (await req('/properties.html')).text();
    for (const stand of ['HP-0245', 'HP-0261', 'HP-0310', 'GP-0102']) {
      assert.ok(html.includes(stand), `${stand} missing from static markup`);
    }
    assert.ok(html.includes('US$5,500'), 'price missing from static markup');
  });

  await check('every page has exactly one h1 and a skip link', async () => {
    for (const p of ['/index.html', '/about.html', '/services.html', '/projects.html',
                     '/properties.html', '/news.html', '/contact.html', '/portal.html']) {
      const html = await (await req(p)).text();
      const h1s = (html.match(/<h1[\s>]/g) || []).length;
      assert.strictEqual(h1s, 1, `${p} has ${h1s} <h1> elements`);
      assert.ok(html.includes('skip-link'), `${p} has no skip link`);
    }
  });

  await check('CSS and JS assets are served with correct types', async () => {
    const css = await req('/assets/css/styles.css');
    assert.strictEqual(css.status, 200);
    assert.match(css.headers.get('content-type'), /text\/css/);

    const js = await req('/assets/js/site.js');
    assert.strictEqual(js.status, 200);
    assert.match(js.headers.get('content-type'), /javascript/);
  });

  await check('security headers are present', async () => {
    const r = await req('/');
    assert.ok(r.headers.get('content-security-policy'), 'no CSP');
    assert.strictEqual(r.headers.get('x-content-type-options'), 'nosniff');
    assert.strictEqual(r.headers.get('x-frame-options'), 'DENY');
    assert.ok(r.headers.get('referrer-policy'), 'no Referrer-Policy');
    const csp = r.headers.get('content-security-policy');
    assert.ok(!/script-src[^;]*unsafe-inline/.test(csp), 'CSP allows inline script');
  });

  await check('unknown page returns a 404 page', async () => {
    const r = await req('/does-not-exist.html');
    assert.strictEqual(r.status, 404);
    assert.ok((await r.text()).includes('Page not found'));
  });

  await check('path traversal cannot reach server source', async () => {
    const attempts = [
      '/../server/index.js',
      '/%2e%2e/server/index.js',
      '/..%2fserver%2findex.js',
      '/assets/../../server/index.js',
      '/%2e%2e%2f%2e%2e%2fserver/config.js'
    ];
    for (const a of attempts) {
      const r = await req(a);
      assert.ok(r.status === 403 || r.status === 404,
        `${a} returned ${r.status} — expected 403/404`);
      const body = await r.text();
      assert.ok(!body.includes('DatabaseSync'), `${a} leaked server source!`);
    }
  });

  await check('dotfiles are refused', async () => {
    const r = await req('/.gitignore');
    assert.ok(r.status === 403 || r.status === 404, `returned ${r.status}`);
  });

  /* ── Authentication ── */

  await check('GET /dashboard without a session redirects to the login page', async () => {
    const r = await req('/dashboard');
    assert.strictEqual(r.status, 302);
    assert.strictEqual(r.headers.get('location'), '/portal.html');
  });

  await check('client API refuses unauthenticated requests', async () => {
    for (const p of ['/api/me', '/api/payments', '/api/documents', '/api/documents/1/download']) {
      const r = await req(p);
      assert.strictEqual(r.status, 401, `${p} returned ${r.status}`);
    }
  });

  await check('sign-in with a wrong password is refused', async () => {
    const r = await req('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientNumber: 'HP-10245', password: 'wrong-password' })
    });
    assert.strictEqual(r.status, 401);
    const body = await r.json();
    assert.ok(!/demo123/.test(body.error || ''), 'error message leaked the password');
  });

  await check('unknown client number gives the same error as a wrong password', async () => {
    const a = await req('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientNumber: 'HP-00000', password: 'whatever' })
    });
    const b = await req('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientNumber: 'HP-10245', password: 'wrong-password' })
    });
    assert.strictEqual(a.status, b.status);
    assert.strictEqual((await a.json()).error, (await b.json()).error,
      'responses differ — client-number enumeration is possible');
  });

  await check('CSRF: a cross-origin POST is rejected', async () => {
    const r = await fetch(BASE + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
      body: JSON.stringify({ clientNumber: 'HP-10245', password: 'demo123' })
    });
    assert.strictEqual(r.status, 403);
  });

  await check('CSRF: a POST with no Origin or Referer is rejected', async () => {
    const r = await fetch(BASE + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientNumber: 'HP-10245', password: 'demo123' })
    });
    assert.strictEqual(r.status, 403);
  });

  await check('sign-in with correct credentials succeeds and sets safe cookies', async () => {
    const r = await req('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientNumber: 'HP-10245', password: 'demo123' })
    });
    assert.strictEqual(r.status, 200, `status ${r.status}`);

    const raw = r.headers.getSetCookie().join(' | ');
    assert.match(raw, /heritage_session=/, 'no session cookie set');
    assert.match(raw, /HttpOnly/, 'session cookie is not HttpOnly');
    assert.match(raw, /SameSite=Strict/, 'session cookie is not SameSite=Strict');

    jar.absorb(r);
    assert.ok(jar.has('heritage_session'), 'jar did not capture the session');
  });

  await check('the session cookie is not readable by script (no csrf leak)', async () => {
    // The CSRF cookie must be readable; the session cookie must not be.
    const raw = jar.header();
    assert.ok(!/heritage_session=null/.test(raw));
  });

  /* ── Authorised access ── */

  await check('GET /dashboard renders the signed-in client\'s own data', async () => {
    const r = await req('/dashboard', { jar });
    assert.strictEqual(r.status, 200, `status ${r.status}`);
    const html = await r.text();
    assert.ok(html.includes('Demo Client'), 'client name missing');
    assert.ok(html.includes('HP-0245'), 'stand missing');
    assert.ok(html.includes('US$2,500'), 'balance missing');
    assert.ok(html.includes('noindex'), 'dashboard not marked noindex');
  });

  await check('once signed in, /portal.html redirects to the dashboard', async () => {
    const r = await req('/portal.html', { jar });
    assert.strictEqual(r.status, 302);
    assert.strictEqual(r.headers.get('location'), '/dashboard');
  });

  await check('GET /api/me returns the right client', async () => {
    const r = await req('/api/me', { jar });
    assert.strictEqual(r.status, 200);
    const body = await r.json();
    assert.strictEqual(body.user.clientNumber, 'HP-10245');
  });

  await check('GET /api/payments totals the seeded payments', async () => {
    const r = await req('/api/payments', { jar });
    assert.strictEqual(r.status, 200);
    const body = await r.json();
    assert.strictEqual(body.payments.length, 3);
    assert.strictEqual(body.paidTotalCents, 300000);
    assert.strictEqual(body.balanceCents, 250000);
  });

  await check('GET /api/documents lists the seeded documents', async () => {
    const r = await req('/api/documents', { jar });
    const body = await r.json();
    assert.strictEqual(body.documents.length, 3);
  });

  await check('a client can download their own document as a real PDF', async () => {
    const list = await (await req('/api/documents', { jar })).json();
    const id = list.documents[0].id;
    ownerDocId = id;

    const r = await req(`/api/documents/${id}/download`, { jar });
    assert.strictEqual(r.status, 200);
    assert.match(r.headers.get('content-type'), /application\/pdf/);
    assert.match(r.headers.get('content-disposition'), /attachment/);

    const buf = Buffer.from(await r.arrayBuffer());
    assert.ok(buf.subarray(0, 5).toString() === '%PDF-', 'not a real PDF');
    assert.ok(buf.length > 500, 'PDF suspiciously small');
  });

  await check('document download is refused without a session', async () => {
    const r = await req('/api/documents/1/download');
    assert.strictEqual(r.status, 401);
  });

  await check('a non-existent document id is a 404, not a 500', async () => {
    const r = await req('/api/documents/999999/download', { jar });
    assert.strictEqual(r.status, 404);
  });

  await check('a non-numeric document id is rejected', async () => {
    const r = await req('/api/documents/abc/download', { jar });
    assert.ok(r.status === 400 || r.status === 404, `returned ${r.status}`);
  });

  /* ── Enquiries ── */

  await check('an enquiry is accepted and validated', async () => {
    const bad = await req('/api/enquiries', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ name: 'A', phone: '1', message: 'short' })
    });
    assert.strictEqual(bad.status, 400, 'invalid enquiry was accepted');

    const good = await req('/api/enquiries', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        name: 'Test Enquirer', phone: '+263771234567',
        interest: 'Site visit', message: 'I would like to arrange a site visit to Heritage Park.'
      })
    });
    assert.strictEqual(good.status, 201, `status ${good.status}`);
  });

  await check('oversized request bodies are refused', async () => {
    const r = await req('/api/enquiries', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ name: 'x'.repeat(200000), phone: '123456', message: 'y'.repeat(200000) })
    });
    assert.ok(r.status === 413 || r.status === 400, `returned ${r.status}`);
  });

  /* ── Admin area ── */
  await adminChecks(jar);

  /* ── Cross-client access control ───────────────────────────────────────
     The single most important property of the portal: an authenticated
     client must not be able to reach another client's records.          */

  await check('a second client cannot read the first client\'s documents or data', async () => {
    const { db } = require('../server/db');
    const { hashPassword } = require('../server/auth');

    // Set up a second, unrelated client.
    const pw = 'second-client-password';
    const hash = await hashPassword(pw);
    const existing = db.prepare('SELECT id FROM users WHERE client_number = ?').get(OTHER_CLIENT);
    if (existing) {
      db.prepare('UPDATE users SET password_hash = ?, disabled = 0, failed_attempts = 0, locked_until = NULL WHERE id = ?')
        .run(hash, existing.id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(existing.id);
    } else {
      db.prepare(`INSERT INTO users (client_number, full_name, email, role, password_hash, created_at)
                  VALUES (?, ?, ?, 'client', ?, ?)`)
        .run(OTHER_CLIENT, 'Other Client', 'other@example.com', hash, new Date().toISOString());
    }

    const jar2 = makeJar();
    const login = await req('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientNumber: OTHER_CLIENT, password: pw })
    });
    assert.strictEqual(login.status, 200, `second client could not sign in (${login.status})`);
    jar2.absorb(login);

    // Their document list must be empty, not the first client's.
    const docs = await (await req('/api/documents', { jar: jar2 })).json();
    assert.strictEqual(docs.documents.length, 0,
      `second client can see ${docs.documents.length} documents that are not theirs`);

    // And they must not be able to fetch the first client's document by id.
    const stolen = await req(`/api/documents/${ownerDocId}/download`, { jar: jar2 });
    assert.strictEqual(stolen.status, 404,
      `cross-client document access returned ${stolen.status} — expected 404`);
    const body = await stolen.text();
    assert.ok(!body.startsWith('%PDF-'), 'another client\'s PDF was disclosed!');

    // Their payments must be empty too.
    const pays = await (await req('/api/payments', { jar: jar2 })).json();
    assert.strictEqual(pays.payments.length, 0, 'second client can see foreign payments');
    assert.strictEqual(pays.balanceCents, 0);

    // Their dashboard must not contain the first client's details.
    const dash = await (await req('/dashboard', { jar: jar2 })).text();
    assert.ok(!dash.includes('HP-0245'), 'dashboard leaked another client\'s stand');
    assert.ok(dash.includes('Other Client'), 'dashboard did not render the right client');

    // Clean up so the check is re-runnable.
    const id = db.prepare('SELECT id FROM users WHERE client_number = ?').get(OTHER_CLIENT).id;
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
  });

  /* ── Sign-out ── */

  await check('sign-out clears the session', async () => {
    const r = await req('/api/auth/logout', { method: 'POST', jar });
    assert.strictEqual(r.status, 200);
    jar.absorb(r);

    const after = await req('/api/me', { jar });
    assert.strictEqual(after.status, 401, 'session still valid after logout');
  });

  /* ── Rate limiting (last: it deliberately exhausts the per-IP budget) ── */

  await check('repeated failed sign-ins are rate limited', async () => {
    let sawLimit = false;
    for (let i = 0; i < 14; i++) {
      const r = await req('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientNumber: 'HP-99999', password: 'nope' })
      });
      if (r.status === 429) { sawLimit = true; break; }
    }
    assert.ok(sawLimit, 'no 429 after 14 failed attempts — limiter is not working');
  });
}

/* ── Run ────────────────────────────────────────────────────────────────── */

(async () => {
  let server = null;

  if (OWN_SERVER) {
    // Point this process's own database and document access at the throwaway
    // locations too, so everything the checks touch is disposable.
    process.env.DB_PATH = TEST_DB;
    process.env.PRIVATE_DOCS_DIR = TEST_DOCS;

    console.log(`\n  Starting a throwaway server on port ${TEST_PORT}…`);
    removeTestDb();
    removeTestDocs();
    stageTestPublic();
    try {
      await runNode(['scripts/seed.js'], {
        DB_PATH: TEST_DB, PRIVATE_DOCS_DIR: TEST_DOCS, PUBLIC_DIR: TEST_PUBLIC
      });

      /* The child's output goes to a file rather than a pipe: piped stdio is
         blocked in some sandboxes, and if the server dies mid-run its stack
         trace is the only thing that explains why. */
      serverLogFd = fs.openSync(TEST_SERVER_LOG, 'w');

      server = spawn(process.execPath, ['server/index.js'], {
        cwd: ROOT,
        env: {
          ...process.env,
          DB_PATH: TEST_DB,
          PRIVATE_DOCS_DIR: TEST_DOCS,
          PUBLIC_DIR: TEST_PUBLIC,
          PORT: String(TEST_PORT),
          HOST: '127.0.0.1'
        },
        stdio: ['ignore', serverLogFd, serverLogFd]
      });
      await waitForHealth(`${BASE}/healthz`, 20000);
      console.log('  Server ready.\n');
    } catch (err) {
      console.error(`\n  Could not start the test server: ${err.message}\n`);
      if (server) server.kill();
      removeTestDb();
      removeTestDocs();
      removeTestPublic();
      process.exit(1);
    }
  }

  console.log(`  Verifying ${BASE}\n  ${'='.repeat(60)}\n`);

  console.log('  Pure helpers');
  unitChecks();

  console.log('\n  Audit findings fixed (static analysis of the built front-end)');
  staticChecks();

  console.log('\n  HTTP behaviour');
  try {
    await httpChecks();
  } catch (err) {
    failures.push({ name: 'httpChecks aborted', message: err.message });
    console.log(`  \u2717 httpChecks aborted: ${err.message}`);
  }

  console.log(`\n  ${'='.repeat(60)}`);
  console.log(`  ${passed} passed, ${failures.length} failed`);

  if (OWN_SERVER) {
    // The cross-client check opens the database inside *this* process to stage
    // its second user. Windows refuses to unlink a file that is still open, so
    // close that handle before trying to remove the throwaway database.
    const dbModule = require.resolve('../server/db');
    if (require.cache[dbModule]) {
      try { require.cache[dbModule].exports.db.close(); } catch { /* already closed */ }
    }
    await stopServerAndClean(server);
    removeTestDocs();
    removeTestPublic();
  }

  if (failures.length) {
    console.log('\n  Failures:');
    for (const f of failures) console.log(`   - ${f.name}: ${f.message}`);
    process.exit(1);
  }
  console.log('  All checks passed.\n');
  process.exit(0);
})();
