'use strict';

/* ==========================================================================
   Create or update a staff (admin) account.

     node scripts/create-admin.js
     node scripts/create-admin.js --id ADMIN-002 --name "Office Manager"
     node scripts/create-admin.js --id ADMIN-001 --reset

   The password is generated here and printed once. It is never written to a
   file, never seeded into the repository, and only its scrypt hash is stored —
   so if you lose it, use --reset rather than hunting for it.

   Options:
     --id <staffId>     default ADMIN-001
     --name <full name> default "Heritage Administrator"
     --email <address>
     --reset            replace the password of an existing staff account
     --disable          disable the account instead of creating it
   ========================================================================== */

const { db, users, sessions, audit } = require('../server/db');
const { hashPassword } = require('../server/auth');
const { generatePassword } = require('../server/passwords');

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = process.argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
}

function flag(name) { return process.argv.includes(`--${name}`); }

async function main() {
  const clientNumber = String(arg('id', 'ADMIN-001')).trim().toUpperCase();
  const fullName = String(arg('name', 'Heritage Administrator')).trim();
  const email = arg('email', 'admin@heritagehousing.co.zw');
  const reset = flag('reset');
  const disable = flag('disable');

  if (!/^[A-Z0-9][A-Z0-9-]{2,31}$/.test(clientNumber)) {
    console.error(`\n  Invalid staff id "${clientNumber}".`);
    console.error('  Use 3-32 characters: letters, digits and hyphens.\n');
    process.exit(1);
  }

  const existing = users.byClientNumber(clientNumber);

  if (disable) {
    if (!existing) { console.error(`\n  No account ${clientNumber}.\n`); process.exit(1); }
    db.prepare('UPDATE users SET disabled = 1 WHERE id = ?').run(existing.id);
    sessions.destroyAllForUser(existing.id);
    audit('admin_disable', 'success', { userId: existing.id, clientNumber, detail: 'via create-admin.js' });
    console.log(`\n  Disabled ${clientNumber}. Their sessions will be refused.\n`);
    process.exit(0);
  }

  if (existing && !reset) {
    console.error(`\n  ${clientNumber} already exists.`);
    console.error('  Use --reset to issue a new password, or --disable to turn it off.\n');
    process.exit(1);
  }

  const password = generatePassword(20);
  const hash = await hashPassword(password);

  if (existing) {
    db.prepare(`
      UPDATE users
         SET full_name = ?, email = ?, password_hash = ?, role = 'admin',
             disabled = 0, failed_attempts = 0, locked_until = NULL
       WHERE id = ?
    `).run(fullName, email, hash, existing.id);

    // Any session issued under the old password must not survive a reset.
    sessions.destroyAllForUser(existing.id);
    audit('admin_password_reset', 'success', { userId: existing.id, clientNumber, detail: 'via create-admin.js' });
  } else {
    users.insert({ clientNumber, fullName, email, role: 'admin', passwordHash: hash });
    audit('admin_create', 'success', { clientNumber, detail: 'via create-admin.js' });
  }

  console.log('');
  console.log('  ' + '='.repeat(58));
  console.log(`   Staff account ${existing ? 'updated' : 'created'}`);
  console.log('  ' + '='.repeat(58));
  console.log(`   Staff ID : ${clientNumber}`);
  console.log(`   Name     : ${fullName}`);
  console.log(`   Password : ${password}`);
  console.log('  ' + '='.repeat(58));
  console.log('');
  console.log('   This password is shown once and is not stored anywhere.');
  console.log('   Save it in your password manager now.');
  console.log('');
  console.log('   Sign in at /admin/login');
  console.log('   Lost it? Run this script again with --reset.');
  console.log('');
}

main().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});
