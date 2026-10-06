'use strict';

/* ==========================================================================
   Seed the database with demonstration data.

     node scripts/seed.js

   Idempotent: re-running replaces the demo client's records rather than
   duplicating them, so it is safe to run repeatedly during development.

   !! The demo password below is published in this repository and printed on
      the login page. Change it before any real deployment, and never create a
      real client account with a shared password.
   ========================================================================== */

const fs = require('node:fs');
const path = require('node:path');

const config = require('../server/config');
const { db, content } = require('../server/db');
const { hashPassword } = require('../server/auth');

const DEMO_CLIENT_NUMBER = 'HP-10245';
const DEMO_PASSWORD = 'demo123';

/* `--fresh` also clears anything the seed does not own: stray accounts (such as
   the second client some checks create), enquiries, sessions and audit rows.
   Without it, re-seeding updates the demonstration data and leaves the rest. */
const FRESH = process.argv.includes('--fresh');

/* ── A very small PDF writer ─────────────────────────────────────────────
   Enough to produce a genuine, openable one-page PDF so the private-document
   download route serves a real file rather than a stub. Byte offsets in the
   xref table are accumulated as objects are emitted, because a wrong offset
   makes the file unopenable.
   ------------------------------------------------------------------------ */

function buildPdf(title, lines) {
  const esc = (s) => String(s).replace(/([\\()])/g, '\\$1');

  let content = 'BT\n/F1 20 Tf\n60 780 Td\n(' + esc(title) + ') Tj\nET\n';
  content += 'BT\n/F1 11 Tf\n';
  let y = 745;
  for (const line of lines) {
    content += `60 ${y} Td\n(${esc(line)}) Tj\n0 -18 Td\n`;
    y -= 18;
  }
  content += 'ET\n';

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] ' +
      '/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}endstream`
  ];

  let pdf = '%PDF-1.4\n';
  const offsets = [];

  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefStart = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (const off of offsets) {
    pdf += String(off).padStart(10, '0') + ' 00000 n \n';
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  pdf += `startxref\n${xrefStart}\n%%EOF\n`;

  return Buffer.from(pdf, 'latin1');
}

/* ── Seed ───────────────────────────────────────────────────────────────── */

async function main() {
  fs.mkdirSync(config.PRIVATE_DOCS_DIR, { recursive: true });

  const passwordHash = await hashPassword(DEMO_PASSWORD);

  /* Photographs are local files under /images/. Photograph URLs follow the
     development's own name, which is also the rule the live-site migration
     uses, so a re-seed cannot reintroduce a remote URL. */
  const projects = [
    ['Heritage Park', 'Gweru, Zimbabwe', 'Residential', 'Development in progress',
      'Residential stands with servicing and infrastructure progressing toward build readiness.',
      '/images/heritage-park.jpg'],
    ['Raylands Estate', 'Zimbabwe', 'Residential', 'Development',
      'A residential development opportunity focused on planned community growth.',
      '/images/raylands-estate.jpg'],
    ['Goshen Park', 'Zimbabwe', 'Residential', 'Development',
      'A planned property development forming part of the Heritage portfolio.',
      '/images/goshen-park.jpg'],
    ['Mkoba 21', 'Gweru, Zimbabwe', 'Residential', 'Development',
      'Residential property development opportunity in Gweru.',
      '/images/mkoba-21.jpg'],
    ['Emganini', 'Zimbabwe', 'Residential', 'Development',
      'A Heritage development opportunity.',
      '/images/emganini.jpg'],
    ['Gorge of Toronto', 'Mutare, Zimbabwe', 'Residential', 'Development',
      'A development opportunity in Mutare.',
      '/images/gorge-of-toronto.jpg']
  ];

  /* US$5,500 for HP-0245, matching the public listing on properties.html.
     The original prototype showed the same stand at US$5,500 publicly and
     US$6,500 in the portal account — a genuine data inconsistency.

     A stand with no photograph of its own falls back to its development's, so
     the demonstration stands below deliberately have none. */
  const stands = [
    ['Heritage Park', 'HP-0245', 200, 'Residential', 550000, '/images/stand-hp-0245.jpg'],
    ['Heritage Park', 'HP-0261', 200, 'Residential', 550000, null],
    ['Heritage Park', 'HP-0310', 300, 'Residential', 750000, null],
    ['Goshen Park', 'GP-0102', 300, 'Residential', null, '/images/stand-gp-0102.jpg']
  ];

  /* The longer write-up and the published price list, for developments that
     have one. Prose is in British/Zimbabwean English to match the rest of the
     site, and the citation markers and search links of the source material are
     not carried across. */
  const developmentDetail = {
    'Heritage Park': {
      overview: [
        'Heritage Park is a residential property development in Gweru, Zimbabwe, managed by '
        + 'Heritage Housing Projects. Located along Lower Gweru Road just 7.5km from the Gweru '
        + 'Central Business District (CBD), the project offers affordable, ready-for-development '
        + 'land aimed at home builders and property investors.',

        'Stands are fully accessible, with roads established for the community. Prices vary with '
        + 'the size of the plot and the payment method chosen.',

        'Instalment terms are flexible, with monthly options starting as low as $100 per month '
        + 'after the initial deposit. Special consideration programmes, such as free house plans '
        + 'for widows, are offered from time to time.'
      ].join('\n\n'),

      features: [
        'Location: Positioned next to Rosemont Park, roughly 7.5km from the Gweru CBD via Lower Gweru Road.',
        'Accessibility: Accessible roads let buyers move materials in and begin building straight away.',
        'Investment profile: Sits within a high-growth suburban corridor, suited to single-family '
        + 'homes or long-term land investment.'
      ].join('\n'),

      /* Amounts are text: a deposit legitimately spans a range. */
      pricing: [
        ['150 sqm', '$4,000', '$5,000', '$2,000'],
        ['200 sqm', '$5,500', '$6,500', '$3,000'],
        ['300 sqm', '$7,500', '$8,800', '$2,000 \u2013 $4,000'],
        ['500 sqm', '$9,000', '$10,000', '$2,000 \u2013 $4,000']
      ]
    }
  };

  const progress = [
    ['Land allocation', 'done', 1],
    ['Survey / planning', 'done', 2],
    ['Infrastructure servicing', 'current', 3],
    ['Compliance / approvals', 'pending', 4],
    ['Ready to build', 'pending', 5]
  ];

  /* Payments totalling US$3,000, dated in the past. */
  const payments = [
    ['2025-08-05', 'HP001245', 150000, 'Confirmed'],
    ['2025-09-05', 'HP001389',  50000, 'Confirmed'],
    ['2025-10-05', 'HP001502', 100000, 'Confirmed']
  ];

  const documents = [
    ['Agreement of Sale', 'agreement-of-sale.pdf', [
      'This document is part of a demonstration dataset.',
      '',
      'Property  : Heritage Park, Gweru, Zimbabwe',
      'Stand     : HP-0245 (200 square metres)',
      'Purchaser : Demo Client',
      'Purchase price: US$5,500.00',
      '',
      'In a production deployment this file would be a real signed',
      'agreement, served only to the client it belongs to.'
    ]],
    ['Statement of Account', 'statement-of-account.pdf', [
      'Account statement as at the date of issue.',
      '',
      'Purchase price : US$5,500.00',
      'Total received : US$3,000.00',
      'Balance due    : US$2,500.00',
      '',
      'Payments received:',
      '  05 Aug 2025  HP001245  US$1,500.00  Confirmed',
      '  05 Sep 2025  HP001389  US$  500.00  Confirmed',
      '  05 Oct 2025  HP001502  US$1,000.00  Confirmed'
    ]],
    ['Payment Schedule', 'payment-schedule.pdf', [
      'Agreed instalment plan for stand HP-0245.',
      '',
      'Instalments are due on the 5th of each month.',
      'Please quote your client number and stand number with',
      'every payment so it can be allocated correctly.',
      '',
      'Contact the office on +263 542 22697 with any query.'
    ]]
  ];

  const run = db.prepare.bind(db);

  db.exec('BEGIN');
  try {
    if (FRESH) {
      /* Children before parents — these tables reference users(id). */
      db.exec(`
        DELETE FROM sessions;
        DELETE FROM audit_log;
        DELETE FROM enquiries;
        DELETE FROM finance_audit;
        DELETE FROM ownerships;
        DELETE FROM payments;
        DELETE FROM documents;
        DELETE FROM agents;
        DELETE FROM users WHERE client_number <> '${DEMO_CLIENT_NUMBER}';
      `);
    }

    /* Projects — upsert by name. */
    const upProject = db.prepare(`
      INSERT INTO projects (name, location, type, status, description, image_url,
                            long_description, features)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        location = excluded.location, type = excluded.type,
        status = excluded.status, description = excluded.description,
        image_url = excluded.image_url,
        long_description = excluded.long_description, features = excluded.features
    `);
    for (const p of projects) {
      const detail = developmentDetail[p[0]] || {};
      upProject.run(...p, detail.overview || null, detail.features || null);
    }

    const projectId = (name) =>
      db.prepare('SELECT id FROM projects WHERE name = ?').get(name).id;

    /* Stands — upsert by stand number, resolving the project by name. */
    const upStand = db.prepare(`
      INSERT INTO stands (project_id, stand_number, size_sqm, type, price_cents, status, image_url)
      VALUES (?, ?, ?, ?, ?, 'Available', ?)
      ON CONFLICT(stand_number) DO UPDATE SET
        project_id = excluded.project_id, size_sqm = excluded.size_sqm,
        type = excluded.type, price_cents = excluded.price_cents,
        image_url = excluded.image_url
    `);
    for (const [proj, num, size, type, cents, img] of stands) {
      upStand.run(projectId(proj), num, size, type, cents, img);
    }

    /* Published price lists — replaced wholesale, so ordering stays correct
       and a row removed from the seed does not linger. */
    const clearPricing = db.prepare('DELETE FROM development_pricing WHERE project_id = ?');
    const addPricing = db.prepare(`
      INSERT INTO development_pricing (project_id, size_label, cash, credit, deposit, position)
      VALUES (?, ?, ?, ?, ?, ?)`);

    for (const p of projects) {
      const pid = projectId(p[0]);
      clearPricing.run(pid);
      let position = 0;
      for (const [sizeLabel, cash, credit, deposit] of (developmentDetail[p[0]] || {}).pricing || []) {
        addPricing.run(pid, sizeLabel, cash, credit, deposit, position++);
      }
    }

    /* Progress — replace wholesale so ordering stays correct. */
    for (const p of projects) {
      const pid = projectId(p[0]);
      db.prepare('DELETE FROM progress WHERE project_id = ?').run(pid);
      const ins = db.prepare('INSERT INTO progress (project_id, label, state, position) VALUES (?, ?, ?, ?)');
      if (p[0] === 'Heritage Park') for (const [label, state, pos] of progress) ins.run(pid, label, state, pos);
    }

    /* Demo client — upsert by client number. */
    const existing = db.prepare('SELECT id FROM users WHERE client_number = ?').get(DEMO_CLIENT_NUMBER);
    let userId;
    if (existing) {
      userId = existing.id;
      db.prepare(`
        UPDATE users SET full_name = ?, email = ?, password_hash = ?,
                         disabled = 0, failed_attempts = 0, locked_until = NULL
        WHERE id = ?
      `).run('Demo Client', 'demo@heritagehousing.co.zw', passwordHash, userId);
      // Force a fresh sign-in with the new password.
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    } else {
      const r = db.prepare(`
        INSERT INTO users (client_number, full_name, email, role, password_hash, created_at)
        VALUES (?, ?, ?, 'client', ?, ?)
      `).run(DEMO_CLIENT_NUMBER, 'Demo Client', 'demo@heritagehousing.co.zw',
             passwordHash, new Date().toISOString());
      userId = Number(r.lastInsertRowid);
    }

    /* Ownership + payments — cleared and re-inserted so totals stay exact. */
    db.prepare('DELETE FROM ownerships WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM payments   WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM documents  WHERE user_id = ?').run(userId);

    const standId = db.prepare('SELECT id FROM stands WHERE stand_number = ?').get('HP-0245').id;
    db.prepare(`
      INSERT INTO ownerships (user_id, stand_id, purchase_price_cents, purchase_date, status)
      VALUES (?, ?, ?, ?, ?)
    `).run(userId, standId, 550000, '2025-08-05', 'Servicing in progress');

    const insPay = db.prepare(`
      INSERT INTO payments (user_id, stand_id, paid_on, reference, amount_cents, status)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const [paidOn, ref, cents, status] of payments) {
      insPay.run(userId, standId, paidOn, ref, cents, status);
    }

    /* Real PDF files on disk, outside the web root. */
    const insDoc = db.prepare(`
      INSERT INTO documents (user_id, title, stored_name, mime, size_bytes, uploaded_at)
      VALUES (?, ?, ?, 'application/pdf', ?, ?)
    `);
    for (const [title, filename, lines] of documents) {
      const buf = buildPdf(title + ' — Heritage Housing Projects', lines);
      fs.writeFileSync(path.join(config.PRIVATE_DOCS_DIR, filename), buf);
      insDoc.run(userId, title, filename, buf.length, new Date().toISOString());
    }

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  /* Editable site content. Outside the transaction above because it is
     additive: without --fresh it only fills in keys that are missing, so
     re-seeding never overwrites what the office has edited. */
  const contentCounts = content.seedDefaults({ overwrite: FRESH });

  const owned = db.prepare(`
    SELECT u.client_number, u.full_name, st.stand_number, o.purchase_price_cents
    FROM users u
    JOIN ownerships o ON o.user_id = u.id
    JOIN stands st ON st.id = o.stand_id
    WHERE u.client_number = ?
  `).get(DEMO_CLIENT_NUMBER);

  const paid = db.prepare('SELECT COALESCE(SUM(amount_cents),0) AS t FROM payments WHERE user_id = ?')
    .get(db.prepare('SELECT id FROM users WHERE client_number = ?').get(DEMO_CLIENT_NUMBER).id).t;

  console.log('\n  Seeded demonstration data');
  console.log('  ' + '-'.repeat(52));
  if (FRESH) console.log('  Mode            : --fresh (stray accounts, enquiries, sessions and logs cleared)');
  console.log(`  Projects        : ${projects.length}`);
  console.log(`  Stands          : ${stands.length}`);
  console.log(`  Documents       : ${documents.length} PDFs written to private-docs/`);
  console.log(`  Content blocks  : ${contentCounts.blocks}`);
  console.log(`  Settings        : ${contentCounts.settings}`);
  console.log(`  Client          : ${owned.client_number} (${owned.full_name})`);
  console.log(`  Stand           : ${owned.stand_number}`);
  console.log(`  Purchase price  : US$${(owned.purchase_price_cents / 100).toLocaleString('en-US')}`);
  console.log(`  Paid to date    : US$${(paid / 100).toLocaleString('en-US')}`);
  console.log(`  Balance         : US$${((owned.purchase_price_cents - paid) / 100).toLocaleString('en-US')}`);
  console.log(`\n  Sign in at http://localhost:${config.PORT}/portal.html`);
  console.log(`  ${DEMO_CLIENT_NUMBER} / ${DEMO_PASSWORD}`);
  console.log('\n  ! Change this password before any real deployment.\n');
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
