'use strict';

/* ==========================================================================
   Create or update a sales agent's staff login.

     node scripts/create-agent.js --list
     node scripts/create-agent.js --name "Tendai Moyo" --email tendai@heritagehousing.co.zw
     node scripts/create-agent.js --name "Tendai Moyo" --reset
     node scripts/create-agent.js --name "Tendai Moyo" --disable

   Agents are the sales team, not administrators: they sign in at /staff/login,
   not /admin/login, and their session lives in its own cookie and table. A row
   in `agents` does not need a password — an agent can exist purely as the
   person credited on a sale, which is what --no-login creates.

   The password is generated here and printed once. It is never written to a
   file, never seeded into the repository, and only its scrypt hash is stored —
   the same hash format the admin and client logins use.

   Options:
     --name <full name>   required, unless --list
     --email <address>
     --reset              replace the password of an existing agent
     --disable            deactivate the agent and end their sessions
     --enable             reactivate a deactivated agent
     --no-login           create the agent without a password (sales credit only)
     --list               show every agent and whether they can sign in
   ========================================================================== */

const { db, ready, agents, staffSessions, audit } = require('../server/db');
const { hashPassword } = require('../server/auth');
const { generatePassword } = require('../server/passwords');

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = process.argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
}

function flag(name) { return process.argv.includes(`--${name}`); }

/** Prints the agent list, flagging who can actually sign in. */
async function list() {
  const rows = await db.prepare(`
    SELECT a.id, a.name, a.email, a.active,
           CASE WHEN a.password_hash IS NULL THEN 0 ELSE 1 END AS has_password,
           (SELECT COUNT(*) FROM leads l WHERE l.assigned_agent_id = a.id) AS leads
      FROM agents a
     ORDER BY a.active DESC, a.name
  `).all();

  if (!rows.length) {
    console.log('\n  No agents yet. Create one with:\n');
    console.log('      node scripts/create-agent.js --name "Tendai Moyo" --email tendai@heritagehousing.co.zw\n');
    return;
  }

  console.log('\n  ' + '='.repeat(72));
  console.log('   Agents');
  console.log('  ' + '='.repeat(72));
  for (const a of rows) {
    const state = !a.active ? 'disabled' : a.has_password ? 'can sign in' : 'no login set';
    console.log(`   ${String(a.id).padStart(3)}  ${a.name.padEnd(26)} ${String(a.email || '—').padEnd(30)} ${state}`);
  }
  console.log('  ' + '='.repeat(72));
  console.log(`   ${rows.length} agent${rows.length === 1 ? '' : 's'}.` +
    ` ${rows.filter((a) => a.active && a.has_password).length} can sign in.\n`);
}

async function main() {
  /* The schema and every ensureColumn migration run behind an async promise
     inside db.js. Without this await the script can query a brand-new database
     before the tables exist and die on "no such table: agents". */
  await ready;

  if (flag('list')) return await list();

  const name = String(arg('name', '') || '').trim();
  const email = arg('email', null);
  const reset = flag('reset');
  const disable = flag('disable');
  const enable = flag('enable');
  const noLogin = flag('no-login');

  if (!name) {
    console.error('\n  --name is required.\n');
    console.error('  Try:\n');
    console.error('      node scripts/create-agent.js --list');
    console.error('      node scripts/create-agent.js --name "Tendai Moyo" --email tendai@heritagehousing.co.zw\n');
    process.exit(1);
  }

  const existing = (await db.prepare('SELECT * FROM agents WHERE lower(name) = lower(?)').get(name)) || null;

  /* Disable / enable are about the account, not the password. */
  if (disable || enable) {
    if (!existing) { console.error(`\n  No agent called "${name}".\n`); process.exit(1); }
    const active = enable ? 1 : 0;
    await db.prepare('UPDATE agents SET active = ? WHERE id = ?').run(active, existing.id);
    if (!enable) await staffSessions.destroyAllForAgent(existing.id);
    await audit(enable ? 'agent_enable' : 'agent_disable', 'success', {
      detail: `agent ${existing.id} (${existing.name}) via create-agent.js`
    });
    console.log(`\n  ${enable ? 'Enabled' : 'Disabled'} ${existing.name}.` +
      (enable ? '\n' : ' Their sessions will be refused.\n'));
    process.exit(0);
  }

  if (existing && existing.password_hash && !reset) {
    console.error(`\n  "${existing.name}" already has a login.`);
    console.error('  Use --reset to issue a new password, or --disable to turn it off.\n');
    process.exit(1);
  }

  /* A sales credit only: the agent can be named on a sale but cannot sign in. */
  if (noLogin) {
    if (existing) { console.error(`\n  "${existing.name}" already exists.\n`); process.exit(1); }
    await db.prepare(
      'INSERT INTO agents (name, email, active, created_at) VALUES (?, ?, 1, ?)'
    ).run(name, email || null, new Date().toISOString());
    await audit('agent_create', 'success', { detail: `${name} (no login) via create-agent.js` });
    console.log(`\n  Created ${name} without a login. They can be credited on a sale`);
    console.log('  but cannot sign in to /staff.\n');
    process.exit(0);
  }

  const password = generatePassword(20);
  const hash = await hashPassword(password);

  if (existing) {
    await db.prepare('UPDATE agents SET password_hash = ?, active = 1 WHERE id = ?')
      .run(hash, existing.id);
    if (email) await db.prepare('UPDATE agents SET email = ? WHERE id = ?').run(String(email), existing.id);

    /* A password change must invalidate every existing session for that agent,
       exactly as it does for a client or an admin. */
    await staffSessions.destroyAllForAgent(existing.id);
    await audit('agent_password_reset', 'success', {
      detail: `agent ${existing.id} (${existing.name}) via create-agent.js`
    });
  } else {
    await db.prepare(
      'INSERT INTO agents (name, email, password_hash, active, created_at) VALUES (?, ?, ?, 1, ?)'
    ).run(name, email || null, hash, new Date().toISOString());
    await audit('agent_create', 'success', { detail: `${name} via create-agent.js` });
  }

  const saved = await db.prepare('SELECT id, name, email FROM agents WHERE lower(name) = lower(?)').get(name);

  console.log('');
  console.log('  ' + '='.repeat(58));
  console.log(`   Agent login ${existing ? 'updated' : 'created'}`);
  console.log('  ' + '='.repeat(58));
  console.log(`   Agent    : ${saved.name}  (#${saved.id})`);
  console.log(`   Email    : ${saved.email || '—'}`);
  console.log(`   Password : ${password}`);
  console.log('  ' + '='.repeat(58));
  console.log('');
  console.log('   This password is shown once and is not stored anywhere.');
  console.log('   Save it in your password manager now.');
  console.log('');
  console.log('   Sign in at /staff/login — by email if one is set, otherwise by name.');
  console.log('   Lost it? Run this script again with --reset.');
  console.log('');
}

main().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});
