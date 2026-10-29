'use strict';

/* ==========================================================================
   Create the three executive accounts.

     node scripts/add-executives.js --dry-run    # show what would happen
     node scripts/add-executives.js              # create them
     node scripts/add-executives.js --reset      # re-issue passwords

   Requires TURSO_DATABASE_URL and TURSO_AUTH_TOKEN in the environment.

   ---------------------------------------------------------------------------
   WHY THE ROLE COLUMN SAYS 'admin'
   ---------------------------------------------------------------------------
   The users table carries CHECK (role IN ('client','admin','manager')). Turso
   will not accept 'ceo', 'finance' or 'hr', and the rebuild that would widen it
   fails on foreign keys. So these three are written as 'admin' and given their
   real role by server/permissions.js, which maps:

     ceo@heritagehousing.co.zw      -> ceo
     finance@heritagehousing.co.zw  -> finance
     hr@heritagehousing.co.zw       -> hr

   The email address is therefore load-bearing: change it and the account loses
   its role. The script checks the mapping took effect and says so per account.
   ========================================================================== */

const crypto = require('node:crypto');
const { promisify } = require('node:util');

let createClient;
try {
  ({ createClient } = require('@libsql/client'));
} catch {
  console.error('\n  @libsql/client is not installed.');
  console.error('  Run `npm install` in the project root, then try again.\n');
  process.exit(1);
}

const scrypt = promisify(crypto.scrypt);

/* Mirrors server/config.js. Duplicated so this script never requires
   server/db — which would open the LOCAL database just by being loaded. */
const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 64, maxmem: 96 * 1024 * 1024 };

const DEFAULT_PASSWORD = 'Heritage2026!';
const DRY_RUN = process.argv.includes('--dry-run');
const RESET = process.argv.includes('--reset');

/* role is what the office means; the column gets 'admin'. */
const EXECUTIVES = [
  {
    clientNumber: 'MD-001', fullName: 'Ms Mufunda',
    email: 'ceo@heritagehousing.co.zw', role: 'ceo'
  },
  {
    clientNumber: 'FIN-001', fullName: 'Mr Tagarira',
    email: 'finance@heritagehousing.co.zw', role: 'finance'
  },
  {
    clientNumber: 'HR-001', fullName: 'Mrs Mutengwa',
    email: 'hr@heritagehousing.co.zw', role: 'hr'
  }
];

const log = (msg) => console.log(`  ${msg}`);
const step = (msg) => console.log(`\n  ${msg}`);

async function hashPassword(password) {
  const { N, r, p, keylen, maxmem } = SCRYPT;
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(password, salt, keylen, { N, r, p, maxmem });
  return ['scrypt', N, r, p, salt.toString('base64'), derived.toString('base64')].join('$');
}

async function main() {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;

  if (!url) {
    console.error('\n  TURSO_DATABASE_URL is not set. Nothing was changed.\n');
    process.exit(1);
  }

  console.log('');
  console.log('  ' + '='.repeat(62));
  console.log(`   Executive accounts${DRY_RUN ? '  (DRY RUN — nothing will be written)' : ''}`);
  console.log('  ' + '='.repeat(62));
  log(`Database : ${url.replace(/\/\/[^@]*@/, '//***@')}`);
  log(`Password : ${RESET ? 're-issued' : DEFAULT_PASSWORD}`);

  const db = createClient({ url, authToken });

  try {
    /* Confirm the table is the shape we expect before writing to it. */
    step('Checking the users table...');
    const table = await db.execute(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'");
    if (!table.rows.length) {
      throw new Error('No users table found. Is this the right database?');
    }
    log(`Current CHECK: ${(/CHECK\s*\(role[^)]*\)/i.exec(String(table.rows[0].sql)) || ['(none)'])[0]}`);
    log('Writing role = \'admin\'; getEffectiveRole supplies the executive role.');

    step('Hashing the password once...');
    const passwordHash = await hashPassword(DEFAULT_PASSWORD);
    log('scrypt hash ready.');

    const created = [];
    const skipped = [];
    const updated = [];

    for (const person of EXECUTIVES) {
      step(`${person.fullName} (${person.clientNumber})`);

      const existing = await db.execute({
        sql: 'SELECT id, client_number, full_name, email, role FROM users WHERE client_number = ?',
        args: [person.clientNumber]
      });

      if (existing.rows.length && !RESET) {
        log('already exists — left alone.');
        skipped.push(person);
        continue;
      }

      if (DRY_RUN) {
        log(existing.rows.length
          ? 'would re-issue the password.'
          : `would insert: ${person.email} as admin (${person.role}).`);
        continue;
      }

      if (existing.rows.length) {
        await db.execute({
          sql: `UPDATE users
                   SET full_name = ?, email = ?, role = 'admin', password_hash = ?,
                       disabled = 0, failed_attempts = 0, locked_until = NULL,
                       archived = 0
                 WHERE client_number = ?`,
          args: [person.fullName, person.email, passwordHash, person.clientNumber]
        });
        updated.push(person);
        log('password re-issued, re-enabled.');
      } else {
        await db.execute({
          sql: `INSERT INTO users
                  (client_number, full_name, email, role, password_hash, created_at)
                VALUES (?, ?, ?, 'admin', ?, ?)`,
          args: [person.clientNumber, person.fullName, person.email, passwordHash,
            new Date().toISOString()]
        });
        created.push(person);
        log('inserted.');
      }
    }

    if (DRY_RUN) {
      console.log('');
      log('Dry run finished. Re-run without --dry-run to apply.');
      console.log('');
      await db.close();
      process.exit(0);
    }

    /* ── Verify the role mapping actually took effect ───────────────────── */
    step('Verifying what each account will sign in as...');
    const { getEffectiveRole } = require('../server/permissions');
    const problems = [];

    for (const person of EXECUTIVES) {
      const row = await db.execute({
        sql: 'SELECT id, client_number, full_name, email, role FROM users WHERE client_number = ?',
        args: [person.clientNumber]
      });
      if (!row.rows.length) continue;

      const stored = row.rows[0];
      const effective = getEffectiveRole(stored);
      const ok = effective === person.role;
      if (!ok) problems.push(person);
      log(`${person.clientNumber.padEnd(8)} stored=${String(stored.role).padEnd(7)} `
        + `effective=${String(effective).padEnd(8)} ${ok ? 'ok' : 'MISMATCH'}`);
    }

    console.log('');
    console.log('  ' + '='.repeat(62));
    console.log(`   Created ${created.length} · password re-issued ${updated.length} · `
      + `skipped ${skipped.length}`);
    console.log('  ' + '='.repeat(62));
    if (created.length || updated.length) {
      console.log(`   Password for every account above: ${DEFAULT_PASSWORD}`);
      console.log('   Change it after the first sign-in.');
    }
    for (const p of [...created, ...updated, ...skipped]) {
      console.log(`   ${p.role.toUpperCase().padEnd(8)} ${p.clientNumber.padEnd(9)} ${p.email}`);
    }
    console.log('  ' + '='.repeat(62));
    console.log('   Sign in at /admin/login with the client number as the ID.');

    if (problems.length) {
      console.log('');
      log('! These accounts will NOT get their intended role:');
      for (const p of problems) log(`  ${p.clientNumber} — expected ${p.role}`);
      log('! The email must match server/permissions.js exactly.');
      await db.close();
      process.exit(1);
    }

    console.log('');
    await db.close();
    process.exit(0);
  } catch (err) {
    console.error('');
    console.error(`  Failed: ${err.message}`);
    console.error('');
    try { await db.close(); } catch { /* already closed */ }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('\n  Failed:', err.message, '\n');
  process.exit(1);
});
