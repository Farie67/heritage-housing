'use strict';

/* ==========================================================================
   Static export.

     node tools/build-pages.js

   Writes every editable page out of the database into public/, so the site can
   also be hosted as plain files with nothing running.

   The live server does not read these files: it renders the same pages from the
   database per request, so an admin edit shows up immediately. Export only when
   you want a static snapshot to upload somewhere.

   This file used to hold its own copies of the project and stand lists, which
   meant a price change had to be made here *and* in the seed. It now reads
   everything from the database, so there is one place to change.
   ========================================================================== */

const fs = require('node:fs');
const path = require('node:path');

const config = require('../server/config');
const publicSite = require('../server/public-site');

const OUT = path.join(__dirname, '..', 'public');

if (!fs.existsSync(config.DB_PATH)) {
  console.error(`\n  No database found at ${config.DB_PATH}`);
  console.error('  Run "node scripts/seed.js" first, then export.\n');
  process.exit(1);
}

let written = 0;
let totalBytes = 0;

for (const file of publicSite.allFiles()) {
  const html = publicSite.renderFile(file);

  if (html === null) {
    console.error(`  ! no renderer for ${file}`);
    continue;
  }

  fs.writeFileSync(path.join(OUT, file), html, 'utf8');
  console.log(`  wrote public/${file}  (${html.length.toLocaleString()} bytes)`);
  written++;
  totalBytes += html.length;
}

const portal = publicSite.renderPortalPage();
fs.writeFileSync(path.join(OUT, 'portal.html'), portal, 'utf8');
console.log(`  wrote public/portal.html  (${portal.length.toLocaleString()} bytes)`);
written++;
totalBytes += portal.length;

console.log(`\n  ${written} pages exported from the database`);
console.log(`  ${(totalBytes / 1024).toFixed(1)} KB total\n`);
