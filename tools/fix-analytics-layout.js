'use strict';

/* Completes the branding-await fix.

   `views-analytics.js` renders through `adminLayout`, imported under the alias
   `layout`. It was asynchronous for the same reason as the admin pages, so:

     1. the six renderers that call `layout(...)` must be async (five are not),
     2. each `return layout({...})` needs `await`,
     3. their callers in admin.js need `await` too.

   Usage: node tools/fix-analytics-layout.js [--dry]                     */

const fs = require('node:fs');
const path = require('node:path');

const dry = process.argv.includes('--dry');
const root = path.resolve(__dirname, '..');
const VA = path.join(root, 'server', 'views-analytics.js');
const AD = path.join(root, 'server', 'admin.js');

const report = [];

/* ── views-analytics.js ─────────────────────────────────────────────────── */

let va = fs.readFileSync(VA, 'utf8').split('\n');

/* 1. Make the layout-calling renderers async. */
const RENDERERS = ['renderAnalytics', 'renderLedger', 'renderWeekly', 'renderMonthly', 'renderAnnual'];
const rendererLines = [];
for (let i = 0; i < va.length; i++) {
  const m = /^function (renderAnalytics|renderLedger|renderWeekly|renderMonthly|renderAnnual)\(/.exec(va[i]);
  if (!m) continue;
  va[i] = va[i].replace(/^function /, 'async function ');
  rendererLines.push(i + 1);
}

/* 2. Await the layout calls. */
const layoutLines = [];
for (let i = 0; i < va.length; i++) {
  if (/(?<!await )\breturn layout\(/.test(va[i])) {
    va[i] = va[i].replace(/(?<!await )\breturn layout\(/, 'return await layout(');
    layoutLines.push(i + 1);
  }
}

/* ── admin.js ───────────────────────────────────────────────────────────── */

let ad = fs.readFileSync(AD, 'utf8').split('\n');
const callerLines = [];
for (let i = 0; i < ad.length; i++) {
  if (/(?<!await )\bviewsAnalytics\.(renderAnalytics|renderLedger|renderWeekly|renderMonthly|renderAnnual)\(/.test(ad[i])) {
    ad[i] = ad[i].replace(
      /(?<!await )\bviewsAnalytics\.(renderAnalytics|renderLedger|renderWeekly|renderMonthly|renderAnnual)\(/,
      'await viewsAnalytics.$1(');
    callerLines.push(i + 1);
  }
}

if (!dry) {
  fs.writeFileSync(VA, va.join('\n'), 'utf8');
  fs.writeFileSync(AD, ad.join('\n'), 'utf8');
}

const tag = dry ? 'would change' : 'changed';
console.log(`  views-analytics.js: ${rendererLines.length} renderer(s) made async ${tag} -> lines ${rendererLines.join(', ')}`);
console.log(`  views-analytics.js: ${layoutLines.length} layout call(s) awaited   ${tag} -> lines ${layoutLines.join(', ')}`);
console.log(`  admin.js         : ${callerLines.length} caller(s) awaited          ${tag} -> lines ${callerLines.join(', ')}`);
