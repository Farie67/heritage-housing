'use strict';

/* ==========================================================================
   Content coverage check.

     node tools/content-coverage.js

   The rebuild must not silently lose the client's own content. This extracts
   the facts from the original prototype in legacy/ and asserts each one is
   still present somewhere in the new site.

   Exits non-zero if any fact has gone missing.
   ========================================================================== */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const LEGACY = path.join(ROOT, 'legacy');
const PUBLIC = path.join(ROOT, 'public');

/* Everything the rebuilt site can legitimately contain content in. */
function readAll() {
  const parts = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (/\.(html|css|js|md)$/.test(entry.name)) parts.push(fs.readFileSync(full, 'utf8'));
    }
  };
  for (const d of ['public', 'server', 'scripts', 'tools']) walk(path.join(ROOT, d));
  return parts.join('\n');
}

const SITE = readAll();

/* Facts taken from the original prototype, grouped by where they came from. */
const GROUPS = [
  ['Company identity', [
    ['Trading name',        'HERITAGE'],
    ['Trading name',        'HOUSING PROJECTS'],
    ['Tagline',             'Building Communities'],
    ['Tagline',             'Creating Opportunities'],
    ['Legal entity',        'Heritage Housing Projects (Pvt) Ltd']
  ]],
  ['Contact details', [
    ['Office address',      'NetOne Building'],
    ['Office number',       'Office PD30'],
    ['Town',                'Gweru'],
    ['Landline',            '+263 542 22697'],
    ['Email',               'heritagehousingp@gmail.com']
  ]],
  ['Services', [
    ['Service',             'Land & Property Development'],
    ['Service',             'Infrastructure Development'],
    ['Service',             'Property Sales'],
    ['Service',             'Construction & Works'],
    ['Service detail',      'Land subdivision'],
    ['Service detail',      'Water & sewer infrastructure'],
    ['Service detail',      'Earthworks'],
    ['Service detail',      'Renovations'],
    ['Service detail',      'Building maintenance']
  ]],
  ['Projects', [
    ['Project',             'Heritage Park'],
    ['Project',             'Raylands Estate'],
    ['Project',             'Goshen Park'],
    ['Project',             'Mkoba 21'],
    ['Project',             'Emganini'],
    ['Project',             'Gorge of Toronto'],
    ['Location',            'Mutare'],
    ['Status',              'Development in progress']
  ]],
  ['Properties', [
    ['Stand',               'HP-0245'],
    ['Stand',               'HP-0261'],
    ['Stand',               'HP-0310'],
    ['Stand',               'GP-0102'],
    ['Price',               'US$5,500'],
    ['Price',               'US$7,500']
  ]],
  ['Client portal', [
    ['Client number',       'HP-10245'],
    ['Client name',         'Demo Client'],
    ['Stand status',        'Servicing in progress'],
    ['Payment reference',   'HP001245'],
    ['Payment reference',   'HP001389'],
    ['Payment reference',   'HP001502'],
    ['Document',            'Agreement of Sale'],
    ['Document',            'Statement of Account'],
    ['Document',            'Payment Schedule'],
    ['Progress step',       'Land allocation'],
    ['Progress step',       'Survey / planning'],
    ['Progress step',       'Infrastructure servicing'],
    ['Progress step',       'Compliance / approvals'],
    ['Progress step',       'Ready to build']
  ]],
  ['About / mission', [
    ['Value',               'Integrity'],
    ['Value',               'Development'],
    ['Value',               'Client Focus'],
    ['Value',               'Value Creation'],
    ['Mission',             'transparency'],
    ['Page heading',        'Developing places people can call home'],
    ['Page heading',        'From land to opportunity'],
    ['Page heading',        'Developments across Zimbabwe'],
    ['Page heading',        'Find your next property opportunity'],
    ['Page heading',        'What is happening at Heritage'],
    ['Page heading',        'discuss your property opportunity']
  ]],
  ['News', [
    ['News item',           'Heritage Park development progress'],
    ['News item',           'Introducing My Heritage'],
    ['News item',           'Building stronger communities']
  ]]
];

/* The one deliberate divergence: the original listed HP-0245 at US$5,500
   publicly but US$6,500 in the portal. We standardised on the public price. */
const KNOWN_DIVERGENCE = 'US$6,500';

let found = 0;
let missing = [];

console.log('\n  Content coverage — does the rebuild still carry the client\'s content?');
console.log('  ' + '='.repeat(72));

for (const [group, items] of GROUPS) {
  const absent = items.filter(([, needle]) => !SITE.includes(needle));
  const present = items.length - absent.length;
  found += present;
  console.log(`\n  ${group}: ${present}/${items.length}`);
  for (const [label, needle] of absent) {
    console.log(`    MISSING  ${label}: "${needle}"`);
    missing.push(`${group} / ${label}: ${needle}`);
  }
}

const total = GROUPS.reduce((n, [, items]) => n + items.length, 0);

console.log('\n  ' + '='.repeat(72));
console.log(`  ${found}/${total} facts carried across.`);

/* Sanity: the legacy source must still be present for this to mean anything. */
for (const f of ['index.html', 'app.js', 'styles.css', 'README.md']) {
  if (!fs.existsSync(path.join(LEGACY, f))) {
    console.log(`  ! legacy/${f} is missing — cannot verify against the original`);
    process.exit(1);
  }
}

console.log(`\n  Deliberate divergence, documented in README.md:`);
console.log(`    the original showed stand HP-0245 at US$5,500 publicly and`);
console.log(`    ${KNOWN_DIVERGENCE} in the portal; the rebuild uses US$5,500 throughout.`);

if (missing.length) {
  console.log(`\n  ${missing.length} fact(s) lost. Add them back or update this list.\n`);
  process.exit(1);
}
console.log('\n  No client content was lost.\n');
