'use strict';

/* ==========================================================================
   Database — SQLite via Node's built-in `node:sqlite`.
   No external driver, so there is nothing to install and no native build step.

   Conventions:
     - Money is stored as an integer number of cents (price_cents, amount_cents).
       Floating-point currency is a rounding-error bug waiting to happen.
     - Timestamps are ISO-8601 UTC strings.
   ========================================================================== */

const config = require('./config');
const driver = require('./driver');
/* format.js has no dependencies of its own, so this cannot create a cycle. */
const { slugify } = require('./format');

/* Every statement returns a Promise, whichever engine is underneath. */
const db = { exec: driver.exec, prepare: driver.prepare };
const prepare = driver.prepare;
const exec = driver.exec;

/* The schema and the migrations below are asynchronous, so they run once here
   and every exported method awaits `ready` before its first query. Callers
   never have to know whether the database has finished opening. */
const TRANSACTION_TYPES = ['DEPOSIT', 'INSTALLMENT', 'FINAL_PAYMENT', 'REFUND'];
const COLLECTION_TYPES = ['DEPOSIT', 'INSTALLMENT', 'FINAL_PAYMENT'];
const PAYMENT_METHODS = [
  'Cash', 'Bank transfer', 'EcoCash', 'InnBucks', 'Cheque', 'Card', 'Other'
];
const SALE_STATUSES = ['Active', 'Completed', 'Cancelled'];
const PROPERTY_TYPES = ['Residential', 'Commercial', 'Industrial', 'Mixed use', 'Agricultural'];
const STAND_STATUSES = ['Available', 'Reserved', 'On Hold', 'Sold'];
const PROJECT_STATUSES = ['Planning', 'Development', 'Development in progress', 'Completed'];
const ready = (async () => {

await driver.exec(`
CREATE TABLE IF NOT EXISTS users (
  id              INTEGER PRIMARY KEY,
  client_number   TEXT    NOT NULL UNIQUE,
  full_name       TEXT    NOT NULL,
  email           TEXT,
  role            TEXT    NOT NULL DEFAULT 'client' CHECK (role IN ('client','admin')),
  password_hash   TEXT    NOT NULL,
  created_at      TEXT    NOT NULL,
  disabled        INTEGER NOT NULL DEFAULT 0,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until    TEXT
);

/* Only a SHA-256 digest of the session token is stored. If the database file
   leaks, the attacker still cannot mint a valid session cookie from it. */
CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT    PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT    NOT NULL,
  expires_at  TEXT    NOT NULL,
  ip          TEXT,
  user_agent  TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_exp  ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS projects (
  id          INTEGER PRIMARY KEY,
  name        TEXT    NOT NULL UNIQUE,
  location    TEXT    NOT NULL,
  type        TEXT    NOT NULL,
  status      TEXT    NOT NULL,
  description TEXT    NOT NULL,
  image_url   TEXT
);

CREATE TABLE IF NOT EXISTS stands (
  id            INTEGER PRIMARY KEY,
  project_id    INTEGER NOT NULL REFERENCES projects(id),
  stand_number  TEXT    NOT NULL UNIQUE,
  size_sqm      INTEGER NOT NULL,
  type          TEXT    NOT NULL,
  price_cents   INTEGER,
  status        TEXT    NOT NULL DEFAULT 'Available',
  image_url     TEXT
);

-- Which client owns which stand. Kept separate from the stands table so a
-- stand can be listed publicly before it is sold, and so ownership carries
-- its own purchase price (which may differ from the current list price).
CREATE TABLE IF NOT EXISTS ownerships (
  id                   INTEGER PRIMARY KEY,
  user_id              INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stand_id             INTEGER NOT NULL REFERENCES stands(id),
  purchase_price_cents INTEGER NOT NULL,
  purchase_date        TEXT    NOT NULL,
  status               TEXT    NOT NULL DEFAULT 'Servicing in progress',
  UNIQUE (user_id, stand_id)
);

CREATE TABLE IF NOT EXISTS payments (
  id           INTEGER PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stand_id     INTEGER REFERENCES stands(id),
  paid_on      TEXT    NOT NULL,
  reference    TEXT    NOT NULL UNIQUE,
  amount_cents INTEGER NOT NULL,
  status       TEXT    NOT NULL DEFAULT 'Confirmed'
);
CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id);

-- stored_name is a filename inside private-docs/, never a client-supplied
-- path. Documents are only ever streamed through an ownership-checked route.
CREATE TABLE IF NOT EXISTS documents (
  id           INTEGER PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title        TEXT    NOT NULL,
  stored_name  TEXT    NOT NULL,
  mime         TEXT    NOT NULL DEFAULT 'application/pdf',
  size_bytes   INTEGER NOT NULL DEFAULT 0,
  uploaded_at  TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_documents_user ON documents(user_id);

CREATE TABLE IF NOT EXISTS progress (
  id         INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  label      TEXT    NOT NULL,
  state      TEXT    NOT NULL CHECK (state IN ('done','current','pending')),
  position   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_progress_project ON progress(project_id, position);

CREATE TABLE IF NOT EXISTS enquiries (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  phone      TEXT NOT NULL,
  interest   TEXT NOT NULL,
  message    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  ip         TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id            INTEGER PRIMARY KEY,
  at            TEXT NOT NULL,
  action        TEXT NOT NULL,
  outcome       TEXT NOT NULL,
  actor_user_id INTEGER,
  client_number TEXT,
  detail        TEXT,
  ip            TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at);
`);

/* Editable site content. `item` is 0 for a one-off field and 1..n for a row
   inside a repeating section such as the "what we do" cards. */
await driver.exec(`
CREATE TABLE IF NOT EXISTS site_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS content_blocks (
  id      INTEGER PRIMARY KEY,
  page    TEXT NOT NULL,
  section TEXT NOT NULL,
  item    INTEGER NOT NULL DEFAULT 0,
  field   TEXT NOT NULL,
  value   TEXT NOT NULL DEFAULT '',
  UNIQUE (page, section, item, field)
);
CREATE INDEX IF NOT EXISTS idx_blocks_page ON content_blocks(page, section, item);
`);

/* ── Lightweight migrations ───────────────────────────────────────────────
   `CREATE TABLE IF NOT EXISTS` cannot add a column to a table that already
   exists, so new columns are applied here. Each runs only when the column is
   genuinely absent, which makes startup idempotent.
   ------------------------------------------------------------------------ */

async function ensureColumn(table, column, definition) {
  const cols = await prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    await driver.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

/* Enquiries gain a handled flag so the office can work through them. */
await ensureColumn('enquiries', 'handled_at', 'TEXT');
await ensureColumn('enquiries', 'handled_by', 'INTEGER REFERENCES users(id)');

/* Whether a client account has been filed away.
   The cleanup path for test accounts and for clients who have been refunded: it
   hides the account and stops it signing in, while leaving the ownership, the
   payments and the audit trail exactly where they are. There is deliberately no
   delete for a client, because every financial row points at this one.
   Distinct from `disabled`, which is a temporary suspension that the office
   expects to lift. */
await ensureColumn('users', 'archived', 'INTEGER NOT NULL DEFAULT 0');

/* Whether a development has nothing left to sell.
   Kept separate from `status` rather than added as another status value: a
   development can be finished being built (Completed) and sold out at the same
   time, and collapsing the two would lose one of them. */
await ensureColumn('projects', 'sold_out', 'INTEGER NOT NULL DEFAULT 0');

/* Whether a development has been announced but not released yet.
   A third independent fact, for the same reason the second one is: a
   development can be coming soon, on sale, or sold out, and it can pass through
   those in order. Where it is set at the same time as `sold_out`, coming soon
   wins — something not yet released cannot also be sold out. */
await ensureColumn('projects', 'coming_soon', 'INTEGER NOT NULL DEFAULT 0');

/* The individual property gains the fields the business actually describes it
   by. `project_id` was already the link to its development, so nothing about
   the one-to-many relationship changes here — this only adds detail to the
   child, which is the side that was thin. */
await ensureColumn('stands', 'currency', "TEXT NOT NULL DEFAULT 'US$'");
await ensureColumn('stands', 'description', 'TEXT');
await ensureColumn('stands', 'location', 'TEXT');
await ensureColumn('stands', 'created_at', 'TEXT');
await ensureColumn('stands', 'updated_at', 'TEXT');

/* The same announcement flag, one level down: a single stand can be advertised
   before it is released even when the rest of its development is on sale. */
await ensureColumn('stands', 'coming_soon', 'INTEGER NOT NULL DEFAULT 0');

/* Existing rows predate these fields. Stamped once, then left alone. */
{
  const stamped = new Date().toISOString();
  await driver.exec(`
    UPDATE stands SET currency = 'US$' WHERE currency IS NULL OR currency = '';
    UPDATE stands SET created_at = '${stamped}' WHERE created_at IS NULL;
    UPDATE stands SET updated_at = COALESCE(created_at, '${stamped}') WHERE updated_at IS NULL;
  `);
}

/* ── Development overview, features and the published price list ─────────
   These describe the development itself, so they hang off the parent record
   rather than being repeated on every property inside it. */
await ensureColumn('projects', 'long_description', 'TEXT');
await ensureColumn('projects', 'features', 'TEXT');

/* Prices are text rather than integer cents: the published list includes
   ranges such as "$2,000 – $4,000", which one integer cannot express. This is
   a tariff shown to buyers, not a figure the accounts add up — the sale price
   of an actual stand lives on the stand itself, in cents. */
await driver.exec(`
CREATE TABLE IF NOT EXISTS development_pricing (
  id         INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  size_label TEXT    NOT NULL,
  cash       TEXT,
  credit     TEXT,
  deposit    TEXT,
  position   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_dev_pricing_project ON development_pricing(project_id, position);
`);

/* ── Internal asset paths must start at the root ─────────────────────────
   The development and property pages live one level deep
   (/development/heritage-park), so a stored "assets/img/logo.png" resolves to
   /development/assets/img/logo.png and 404s. Existing values are corrected
   once; anything already absolute or hosted elsewhere is left alone. */
{
  for (const key of ['logo_url', 'logo_light_url', 'favicon_url']) {
    const row = await prepare('SELECT value FROM site_settings WHERE key = ?').get(key);
    if (row && row.value && !/^(\/|https?:|data:)/i.test(row.value)) {
      await prepare('UPDATE site_settings SET value = ? WHERE key = ?').run(`/${row.value}`, key);
    }
  }
}

/* ── Local images ────────────────────────────────────────────────────────
   The site shipped with remote stock photography. For deployment every image
   has to be a local file, so any remaining absolute URL is rewritten to the
   matching file in public/images/.

   Derived from the entity's own name rather than a hard-coded table, and
   idempotent: once a value is a local path it no longer matches, and an admin
   who has set their own path is never overridden. */
{
  const external = /^(https?:)?\/\//i;

  for (const p of await prepare('SELECT id, name, image_url FROM projects').all()) {
    if (external.test(p.image_url || '')) {
      await prepare('UPDATE projects SET image_url = ? WHERE id = ?')
        .run(`/images/${slugify(p.name)}.jpg`, p.id);
    }
  }

  for (const s of await prepare('SELECT id, stand_number, image_url FROM stands').all()) {
    if (external.test(s.image_url || '')) {
      await prepare('UPDATE stands SET image_url = ? WHERE id = ?')
        .run(`/images/stand-${slugify(s.stand_number)}.jpg`, s.id);
    }
  }
}

/* A sale is an `ownerships` row; a payment is a `payments` row. That
   distinction is deliberate and load-bearing:
     NEW SALE is recorded once, when the stand is sold, and is NOT cash.
     Everything else below is money actually moving, and lives in payments. */

/* The four types that count towards collections. NEW SALE is excluded by
   definition — a signed contract is not money in the bank. */


/* Property vocabulary, offered as dropdowns so the office cannot introduce a
   fourth spelling of "Residential" that then breaks the website's filters. */

/* ── Sales analytics: schema ─────────────────────────────────────────────
   Adds the columns the analytics need to the existing tables. Nothing here
   changes what already worked; the website, portal, statements and CMS read
   the same columns they always did. */

await driver.exec(`
CREATE TABLE IF NOT EXISTS agents (
  id         INTEGER PRIMARY KEY,
  name       TEXT    NOT NULL UNIQUE,
  email      TEXT,
  phone      TEXT,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT    NOT NULL
);

/* CRM, phase 1. An enquiry that has not yet become a client.

   assigned_agent_id is nullable on purpose: a lead can sit unowned until
   someone claims it, and nothing in phase 1 assigns one automatically. Status
   is free text with a default so phase 2 can add stages without a migration;
   the values are not constrained yet. */
CREATE TABLE IF NOT EXISTS leads (
  id                INTEGER PRIMARY KEY,
  full_name         TEXT    NOT NULL,
  phone             TEXT,
  email             TEXT,
  source            TEXT,
  status            TEXT    NOT NULL DEFAULT 'New',
  assigned_agent_id INTEGER REFERENCES agents(id),
  created_at        TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_leads_agent ON leads(assigned_agent_id);

/* Staff sessions live apart from the sessions table for a hard reason: that
   table's user_id is a foreign key to users(id), and an agent is an agents row.
   With foreign keys enforced an agent id could never be stored there. Keeping
   the two apart also means a client session can never be mistaken for a staff
   one, which matters once both portals exist. Same shape as sessions
   otherwise: only the SHA-256 digest of the token is stored. */
CREATE TABLE IF NOT EXISTS staff_sessions (
  token_hash  TEXT    PRIMARY KEY,
  agent_id    INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  created_at  TEXT    NOT NULL,
  expires_at  TEXT    NOT NULL,
  ip          TEXT,
  user_agent  TEXT
);
CREATE INDEX IF NOT EXISTS idx_staff_sessions_agent ON staff_sessions(agent_id);

/* A financial audit trail, separate from the general audit_log: this one
   records what a value changed FROM and TO, which is what an accountant
   needs and what audit_log's free-text detail cannot express. */
CREATE TABLE IF NOT EXISTS finance_audit (
  id            INTEGER PRIMARY KEY,
  at            TEXT NOT NULL,
  actor_user_id INTEGER,
  action        TEXT NOT NULL,
  entity        TEXT NOT NULL,
  entity_id     INTEGER,
  reference     TEXT,
  old_value     TEXT,
  new_value     TEXT,
  reason        TEXT
);
CREATE INDEX IF NOT EXISTS idx_finance_audit_entity ON finance_audit(entity, entity_id);
CREATE INDEX IF NOT EXISTS idx_finance_audit_at     ON finance_audit(at);
`);

/* The sale side of the model. `purchase_price_cents` already existed and stays
   authoritative for the website and portal; `sale_price_cents` mirrors it for
   the analytics and may differ after an agreed discount. */
await ensureColumn('ownerships', 'sale_price_cents', 'INTEGER');
await ensureColumn('ownerships', 'deposit_required_cents', 'INTEGER');
await ensureColumn('ownerships', 'payment_plan', 'TEXT');
await ensureColumn('ownerships', 'agent_id', 'INTEGER REFERENCES agents(id)');
await ensureColumn('ownerships', 'sale_status', "TEXT DEFAULT 'Active'");
await ensureColumn('ownerships', 'sale_date', 'TEXT');
await ensureColumn('ownerships', 'closed_at', 'TEXT');
await ensureColumn('ownerships', 'sale_notes', 'TEXT');

/* Staff sign-in. Nullable: an agent can exist as a sales credit on a sale
   without ever being given a login. An agent with no hash simply cannot sign
   in, which is a safer default than creating one with a guessable password. */
await ensureColumn('agents', 'password_hash', 'TEXT');

/* The transaction side. `status` (Confirmed/Pending) already existed and keeps
   its meaning — whether the money has been verified. `voided_at` is a separate
   concept: a transaction that should no longer count at all. */
await ensureColumn('payments', 'ownership_id', 'INTEGER REFERENCES ownerships(id)');
await ensureColumn('payments', 'type', 'TEXT');
await ensureColumn('payments', 'method', 'TEXT');
await ensureColumn('payments', 'recorded_by', 'INTEGER REFERENCES users(id)');
await ensureColumn('payments', 'notes', 'TEXT');
await ensureColumn('payments', 'voided_at', 'TEXT');
await ensureColumn('payments', 'voided_by', 'INTEGER REFERENCES users(id)');
await ensureColumn('payments', 'void_reason', 'TEXT');
await ensureColumn('payments', 'original_transaction_id', 'INTEGER REFERENCES payments(id)');
await ensureColumn('payments', 'approved_by', 'INTEGER REFERENCES users(id)');

await driver.exec(`
CREATE INDEX IF NOT EXISTS idx_payments_ownership ON payments(ownership_id);
CREATE INDEX IF NOT EXISTS idx_payments_type      ON payments(type);
CREATE INDEX IF NOT EXISTS idx_payments_paid_on   ON payments(paid_on);
`);

/* ── One-time backfill ───────────────────────────────────────────────────
   Existing rows predate the transaction model. Each statement below only
   touches rows where the new column is still NULL, so it is safe to run on
   every start and will not overwrite anything set since.

   The type of a historical payment is inferred rather than invented: on each
   sale, the earliest payment is the deposit and the rest are instalments.
   That is what those payments actually were; the payment method is left
   unknown because it genuinely is not recorded anywhere. */
async function backfillTransactionModel() {
  const now = nowIso();

  await driver.exec(`
    UPDATE ownerships
       SET sale_price_cents = purchase_price_cents
     WHERE sale_price_cents IS NULL;

    UPDATE ownerships
       SET sale_date = purchase_date
     WHERE sale_date IS NULL;

    UPDATE ownerships
       SET sale_status = 'Active'
     WHERE sale_status IS NULL;

    /* Link each payment to its sale. Matched on client + stand, which is how
       the two were related before sales had an id of their own. */
    UPDATE payments
       SET ownership_id = (
             SELECT o.id FROM ownerships o
              WHERE o.user_id = payments.user_id
                AND o.stand_id = payments.stand_id
              LIMIT 1)
     WHERE ownership_id IS NULL;

    /* The first payment on each sale is its deposit. */
    UPDATE payments
       SET type = 'INSTALLMENT'
     WHERE type IS NULL;

    UPDATE payments
       SET type = 'DEPOSIT'
     WHERE type = 'INSTALLMENT'
       AND id IN (
         SELECT MIN(p.id) FROM payments p
          WHERE p.ownership_id IS NOT NULL
          GROUP BY p.ownership_id);
  `);

  /* Anything with no date or amount would corrupt every total, so those are
     never treated as financial records. */
  await driver.exec(`
    UPDATE payments
       SET voided_at = COALESCE(voided_at, '${now}'),
           void_reason = COALESCE(void_reason, 'Incomplete record: missing date or amount')
     WHERE paid_on IS NULL OR paid_on = '' OR amount_cents IS NULL OR amount_cents <= 0;
  `);

  return (await prepare(
    "SELECT COUNT(*) AS c FROM payments WHERE ownership_id IS NOT NULL AND type IS NOT NULL"
  ).get()).c;
}



  /* Runs once per start; the statements are written to be idempotent. */
  await backfillTransactionModel();
{
  const existing = new Set(
    (await prepare('SELECT page, section, item, field FROM content_blocks').all())
      .map((r) => `${r.page}\u0000${r.section}\u0000${r.item}\u0000${r.field}`));
  const liveItems = new Set(
    (await prepare('SELECT DISTINCT page, section, item FROM content_blocks').all())
      .map((r) => `${r.page}\u0000${r.section}\u0000${r.item}`));
  const liveSections = new Set(
    (await prepare('SELECT DISTINCT page, section FROM content_blocks').all())
      .map((r) => `${r.page}\u0000${r.section}`));
  const seededPages = new Set(
    (await prepare('SELECT DISTINCT page FROM content_blocks').all()).map((r) => r.page));

  /* Only repeatable sections can have their items deleted in the admin, so a
     non-repeating section that is entirely absent was never created rather
     than removed. That is what makes seeding a brand-new section safe. */
  const repeatable = new Set();
  for (const p of contentSchema.PAGES) {
    for (const s of p.sections) {
      if (s.repeat) repeatable.add(`${p.key}\u0000${s.key}`);
    }
  }

  const insert = prepare(
    'INSERT INTO content_blocks (page, section, item, field, value) VALUES (?, ?, ?, ?, ?)');

  for (const b of defaultBlocks()) {
    const fieldKey = `${b.page}\u0000${b.section}\u0000${b.item}\u0000${b.field}`;
    if (existing.has(fieldKey)) continue;

    const itemKey = `${b.page}\u0000${b.section}\u0000${b.item}`;
    const sectionKey = `${b.page}\u0000${b.section}`;

    if (liveItems.has(itemKey)) {
      // A new field on an item that already exists.
      await insert.run(b.page, b.section, b.item, b.field, b.value);
      continue;
    }

    /* A non-repeating section, on a page that is already live, with no rows at
       all: a section added to the schema after the site went live. */
    if (!repeatable.has(sectionKey) && seededPages.has(b.page) && !liveSections.has(sectionKey)) {
      await insert.run(b.page, b.section, b.item, b.field, b.value);
    }
  }
}
})();

const nowIso = () => new Date().toISOString();

/* ── Audit log ──────────────────────────────────────────────────────────── */

const insertAudit = prepare(`
  INSERT INTO audit_log (at, action, outcome, actor_user_id, client_number, detail, ip)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

async function audit(action, outcome, { userId = null, clientNumber = null, detail = null, ip = null } = {}) {
  await insertAudit.run(nowIso(), action, outcome, userId, clientNumber, detail, ip);
}

/* ── Users ──────────────────────────────────────────────────────────────── */

const qUserByNumber = prepare('SELECT * FROM users WHERE client_number = ?');
const qUserById     = prepare('SELECT * FROM users WHERE id = ?');
const qBumpFailed   = prepare('UPDATE users SET failed_attempts = failed_attempts + 1 WHERE id = ?');
const qLockUser     = prepare('UPDATE users SET locked_until = ?, failed_attempts = 0 WHERE id = ?');
const qResetFailed  = prepare('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?');

const users = {
  byClientNumber: async (n) => await qUserByNumber.get(n),
  byId: async (id) => await qUserById.get(id),
  bumpFailed: async (id) => await qBumpFailed.run(id),
  lock: async (id, untilIso) => await qLockUser.run(untilIso, id),
  resetFailed: async (id) => await qResetFailed.run(id),

  async insert({ clientNumber, fullName, email, role = 'client', passwordHash }) {
    const stmt = prepare(`
      INSERT INTO users (client_number, full_name, email, role, password_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    return await stmt.run(clientNumber, fullName, email, role, passwordHash, nowIso());
  }
};

/* ── Sessions ───────────────────────────────────────────────────────────── */

const qInsertSession = prepare(`
  INSERT INTO sessions (token_hash, user_id, created_at, expires_at, ip, user_agent)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const qFindSession = prepare(`
  SELECT s.token_hash, s.user_id, s.expires_at,
         u.client_number, u.full_name, u.role, u.disabled, u.archived
  FROM sessions s
  JOIN users u ON u.id = s.user_id
  WHERE s.token_hash = ?
`);
const qDeleteSession = prepare('DELETE FROM sessions WHERE token_hash = ?');
const qDeleteExpired = prepare('DELETE FROM sessions WHERE expires_at < ?');
const qDeleteUserSessions = prepare('DELETE FROM sessions WHERE user_id = ?');

const sessions = {
  async create({ tokenHash, userId, expiresAt, ip, userAgent }) {
    await qInsertSession.run(tokenHash, userId, nowIso(), expiresAt, ip, userAgent);
  },
  find: async (tokenHash) => await qFindSession.get(tokenHash),
  destroy: async (tokenHash) => await qDeleteSession.run(tokenHash),
  destroyAllForUser: async (userId) => await qDeleteUserSessions.run(userId),
  purgeExpired: async () => await qDeleteExpired.run(nowIso())
};

/* ── Staff (agents) ─────────────────────────────────────────────────────── */

const qAgentById = prepare('SELECT * FROM agents WHERE id = ?');
const qSetAgentPassword = prepare('UPDATE agents SET password_hash = ? WHERE id = ?');

/* The staff table on /admin/staff. `has_password` is returned rather than the
   hash itself: the page only needs to know whether a login exists, and sending
   a hash to a template invites it into the HTML one day. */
const qAgentsForAdmin = prepare(`
  SELECT a.id, a.name, a.email, a.phone, a.active, a.created_at,
         CASE WHEN a.password_hash IS NULL THEN 0 ELSE 1 END AS has_password,
         (SELECT COUNT(*) FROM leads l WHERE l.assigned_agent_id = a.id) AS lead_count
    FROM agents a
   ORDER BY a.active DESC, a.name
`);
const qAgentNameTaken = prepare('SELECT id FROM agents WHERE lower(name) = lower(?)');
const qInsertAgent = prepare(`
  INSERT INTO agents (name, email, phone, password_hash, active, created_at)
  VALUES (?, ?, ?, ?, 1, ?)
`);

/* Staff sign in with their email or, when no email is on file, their name.
   Neither is a secret — both are already shown on the website and in analytics
   — so accepting either leaks nothing.

   Deliberately does NOT filter on `active`. A deactivated agent has to be
   distinguishable from one that does not exist, because otherwise the audit
   log says "unknown agent" for both and there is no way to tell an operator
   why a real person cannot get in. The active check happens in staffSignIn,
   the same way the client sign-in checks `disabled` after the lookup. */
const qAgentByLogin = prepare(`
  SELECT * FROM agents
   WHERE lower(email) = lower(?) OR lower(name) = lower(?)
   LIMIT 1
`);

/* Staff sessions. Same discipline as client sessions: only the digest of the
   token is ever stored. */
const qInsertStaffSession = prepare(`
  INSERT INTO staff_sessions (token_hash, agent_id, created_at, expires_at, ip, user_agent)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const qFindStaffSession = prepare(`
  SELECT s.token_hash, s.agent_id, s.expires_at,
         a.name, a.email, a.active
  FROM staff_sessions s
  JOIN agents a ON a.id = s.agent_id
  WHERE s.token_hash = ?
`);
const qDeleteStaffSession = prepare('DELETE FROM staff_sessions WHERE token_hash = ?');
const qDeleteAgentStaffSessions = prepare('DELETE FROM staff_sessions WHERE agent_id = ?');
const qDeleteExpiredStaffSessions = prepare('DELETE FROM staff_sessions WHERE expires_at < ?');

const agents = {
  byId: async (id) => await qAgentById.get(id),
  byLogin: async (identifier) => await qAgentByLogin.get(identifier, identifier),
  /** Hashes are produced by auth.hashPassword, the same as every other login. */
  setPassword: async (id, hash) => await qSetAgentPassword.run(hash, id),

  /** Every agent, for the staff table on /admin/staff. */
  list: async () => await qAgentsForAdmin.all(),

  /** `agents.name` is UNIQUE; checked before the insert so the office gets a
      readable message instead of a raw constraint error. */
  nameTaken: async (name) => Boolean(await qAgentNameTaken.get(name)),

  /** Creates an agent with a login and returns the new id. */
  async create({ name, email, phone, passwordHash }) {
    const info = await qInsertAgent.run(
      name, email || null, phone || null, passwordHash || null, nowIso());
    return Number(info.lastInsertRowid);
  }
};

const staffSessions = {
  async create({ tokenHash, agentId, expiresAt, ip, userAgent }) {
    await qInsertStaffSession.run(tokenHash, agentId, nowIso(), expiresAt, ip, userAgent);
  },
  find: async (tokenHash) => await qFindStaffSession.get(tokenHash),
  destroy: async (tokenHash) => await qDeleteStaffSession.run(tokenHash),
  destroyAllForAgent: async (agentId) => await qDeleteAgentStaffSessions.run(agentId),
  purgeExpired: async () => await qDeleteExpiredStaffSessions.run(nowIso())
};

/* ── Client portal reads ────────────────────────────────────────────────── */

const qOwnership = prepare(`
  SELECT o.id, o.purchase_price_cents, o.purchase_date, o.status,
         st.stand_number, st.size_sqm, st.type,
         p.name AS project_name, p.location AS project_location, p.id AS project_id
  FROM ownerships o
  JOIN stands   st ON st.id = o.stand_id
  JOIN projects p  ON p.id  = st.project_id
  WHERE o.user_id = ?
  ORDER BY o.id
  LIMIT 1
`);

/* `id` and `stand_id` are selected because the admin renders a per-row action
   for each payment. Without the id the action URL lost its identifier and the
   delete button led to a 404. */
const qPayments = prepare(`
  SELECT id, stand_id, paid_on, reference, amount_cents, status
  FROM payments
  WHERE user_id = ?
  ORDER BY paid_on DESC, id DESC
`);

const qPaymentTotal = prepare(`
  SELECT COALESCE(SUM(amount_cents), 0) AS total
  FROM payments
  WHERE user_id = ? AND status = 'Confirmed'
`);

const qDocuments = prepare(`
  SELECT id, title, mime, size_bytes, uploaded_at
  FROM documents
  WHERE user_id = ?
  ORDER BY uploaded_at DESC
`);

const qDocumentForUser = prepare(`
  SELECT id, title, stored_name, mime
  FROM documents
  WHERE id = ? AND user_id = ?
`);

const qProgress = prepare(`
  SELECT label, state FROM progress WHERE project_id = ? ORDER BY position
`);

const qProjects = prepare('SELECT * FROM projects ORDER BY id');
/* `project_sold_out` travels with each stand so the website can leave a sold-out
   development out of the available-properties list without a second query.

   `has_ownership` answers "is this stand already sold?" from the ownerships
   table, which is the authority. It is NOT taken from stands.status: real data
   has stands marked Available that carry an active sale, and stands.status is
   the one the office edits by hand. */
const qStands = prepare(`
  SELECT st.*, p.name AS project_name, p.sold_out AS project_sold_out,
         p.coming_soon AS project_coming_soon,
         p.image_url AS project_image_url,
         EXISTS (SELECT 1 FROM ownerships o
                  WHERE o.stand_id = st.id
                    AND COALESCE(o.sale_status, 'Active') <> 'Cancelled') AS has_ownership
  FROM stands st JOIN projects p ON p.id = st.project_id
  ORDER BY st.stand_number
`);

const portal = {
  ownershipFor: async (userId) => await qOwnership.get(userId),
  paymentsFor: async (userId) => await qPayments.all(userId),
  paidTotalFor: async (userId) => (await qPaymentTotal.get(userId)).total,
  documentsFor: async (userId) => await qDocuments.all(userId),
  documentForUser: async (id, userId) => await qDocumentForUser.get(id, userId),
  progressFor: async (projectId) => await qProgress.all(projectId),
  projects: async () => await qProjects.all(),
  stands: async () => await qStands.all()
};

const contentSchema = require('./content');
const { defaultSettings, defaultBlocks, defaultValue, defaultItemCount } = contentSchema;

/* ── New fields on already-seeded pages ──────────────────────────────────

/* ── Site settings and content blocks ───────────────────────────────────── */

const qAllSettings = prepare('SELECT key, value FROM site_settings');
const qUpsertSetting = prepare(`
  INSERT INTO site_settings (key, value, updated_at) VALUES (?, ?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
`);

const qBlocksForPage = prepare(
  'SELECT section, item, field, value FROM content_blocks WHERE page = ?');
const qUpsertBlock = prepare(`
  INSERT INTO content_blocks (page, section, item, field, value) VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(page, section, item, field) DO UPDATE SET value = excluded.value
`);
const qDeleteBlockItem = prepare(
  'DELETE FROM content_blocks WHERE page = ? AND section = ? AND item = ?');
const qDeletePageBlocks = prepare('DELETE FROM content_blocks WHERE page = ?');
const qCountBlocks = prepare('SELECT COUNT(*) AS c FROM content_blocks');

const range = (from, to) => {
  const out = [];
  for (let i = from; i <= to; i++) out.push(i);
  return out;
};

const content = {
  /** All settings, with factory defaults filling any gap. */
  async settings() {
    const out = { ...defaultSettings() };
    for (const row of await qAllSettings.all()) out[row.key] = row.value;
    return out;
  },

  async setSetting(key, value) { await qUpsertSetting.run(key, String(value ?? ''), nowIso()); },

  async settingsList() {
    const stored = Object.create(null);
    for (const row of await qAllSettings.all()) stored[row.key] = row.value;
    return stored;
  },

  setIsEmpty: async () => (await qCountBlocks.get()).c === 0,

  /**
   * Resolves one page's content for rendering.
   *
   * If the page has no rows at all it has never been seeded, so the factory
   * defaults are used. Once seeded, the database is trusted completely — which
   * is what makes deleting every item in a repeating section stick, rather
   * than the defaults silently reappearing.
   */
  async resolve(pageKey) {
    const rows = await qBlocksForPage.all(pageKey);
    const seeded = rows.length > 0;
    const map = new Map();
    for (const r of rows) map.set(`${r.section}\u0000${r.item}\u0000${r.field}`, r.value);

const countFor = (sectionKey) => {
      if (!seeded) return defaultItemCount(pageKey, sectionKey);
      let max = 0;
      for (const r of rows) if (r.section === sectionKey && r.item > max) max = r.item;
      return max;
    };

    return {
      seeded,
      /* get/items/count read from the `map` built above. They touch no
         database, so they stay synchronous — callers do
         `c.items('value').map(...)` and must not receive a Promise. */
      get(section, field, item = 0) {
        const key = `${section}\u0000${item}\u0000${field}`;
        return map.has(key) ? map.get(key) : defaultValue(pageKey, section, field, item);
      },
      items(sectionKey) { return range(1, countFor(sectionKey)); },
      count: countFor
    };
  },

  async setBlock(pageKey, sectionKey, item, fieldKey, value) {
    await qUpsertBlock.run(pageKey, sectionKey, Number(item) || 0, fieldKey, String(value ?? ''));
  },

  /** Appends an item to a repeating section and returns its number. */
  async addItem(pageKey, sectionKey) {
    const rows = await qBlocksForPage.all(pageKey);
    let max = 0;
    for (const r of rows) if (r.section === sectionKey && r.item > max) max = r.item;
    const next = Math.max(max, defaultItemCount(pageKey, sectionKey)) + 1;
    for (const field of (contentSchema.sectionSchema(pageKey, sectionKey) || { fields: [] }).fields) {
      await qUpsertBlock.run(pageKey, sectionKey, next, field.key, '');
    }
    return next;
  },

  async deleteItem(pageKey, sectionKey, item) { await qDeleteBlockItem.run(pageKey, sectionKey, Number(item)); },

  /**
   * Writes the factory content. Without `overwrite` only missing keys are
   * filled, so re-running the seed never destroys what the office has edited.
   */
  async seedDefaults({ overwrite = false } = {}) {
    let settings = 0;
    let blocks = 0;

    const existingSettings = new Set((await qAllSettings.all()).map((r) => r.key));
    for (const s of contentSchema.SETTINGS) {
      if (overwrite || !existingSettings.has(s.key)) { await qUpsertSetting.run(s.key, s.value, nowIso()); settings++; }
    }

    const existingBlocks = new Set(
      (await prepare('SELECT page, section, item, field FROM content_blocks').all())
        .map((r) => `${r.page}\u0000${r.section}\u0000${r.item}\u0000${r.field}`));

    for (const b of defaultBlocks()) {
      const key = `${b.page}\u0000${b.section}\u0000${b.item}\u0000${b.field}`;
      if (overwrite || !existingBlocks.has(key)) {
        await qUpsertBlock.run(b.page, b.section, b.item, b.field, b.value);
        blocks++;
      }
    }

    return { settings, blocks };
  },

  /** Wipes a page's content so it can be re-seeded from scratch. */
  async resetPage(pageKey) { await qDeletePageBlocks.run(pageKey); }
};

/* ── Enquiries ──────────────────────────────────────────────────────────── */

const qInsertEnquiry = prepare(`
  INSERT INTO enquiries (name, phone, interest, message, created_at, ip)
  VALUES (?, ?, ?, ?, ?, ?)
`);

/* Unhandled first, then newest first within each group. */
const qEnquiriesAll = prepare(`
  SELECT id, name, phone, interest, message, created_at, handled_at
  FROM enquiries
  ORDER BY (handled_at IS NOT NULL), created_at DESC
`);

const qEnquiryCounts = prepare(`
  SELECT COUNT(*) AS total,
         COALESCE(SUM(CASE WHEN handled_at IS NULL THEN 1 ELSE 0 END), 0) AS open
  FROM enquiries
`);

const qEnquiryById = prepare('SELECT * FROM enquiries WHERE id = ?');
const qMarkHandled = prepare('UPDATE enquiries SET handled_at = ?, handled_by = ? WHERE id = ?');
const qReopen = prepare('UPDATE enquiries SET handled_at = NULL, handled_by = NULL WHERE id = ?');

const enquiries = {
  async insert({ name, phone, interest, message, ip }) {
    return await qInsertEnquiry.run(name, phone, interest, message, nowIso(), ip);
  },
  all: async () => await qEnquiriesAll.all(),
  byId: async (id) => await qEnquiryById.get(id),
  counts: async () => await qEnquiryCounts.get(),
  markHandled: async (id, userId) => await qMarkHandled.run(nowIso(), userId, id),
  reopen: async (id) => await qReopen.run(id)
};

/* ── Admin ──────────────────────────────────────────────────────────────── */

const qAdminCounts = prepare(`
  SELECT
    (SELECT COUNT(*) FROM users WHERE role = 'client')                            AS clients,
    (SELECT COUNT(*) FROM documents)                                              AS documents,
    (SELECT COUNT(*) FROM stands)                                                 AS stands,
    (SELECT COUNT(*) FROM payments)                                               AS payments,
    (SELECT COALESCE(SUM(amount_cents), 0) FROM payments WHERE status='Confirmed') AS paid_cents,
    (SELECT COUNT(*) FROM enquiries WHERE handled_at IS NULL)                      AS open_enquiries
`);

/* One row per client, with their stand and how much they have paid.
   Archived accounts are left out unless the office asks for them, so the list
   stays the list of live accounts.

   agent_name is the sales agent credited with the sale. It is joined through
   the ownership rather than the user, and LEFT joined because agent_id is
   nullable — every sale recorded before the column was used has no agent, and
   those rows must still list. */
const CLIENTS_SELECT = `
  SELECT u.id, u.client_number, u.full_name, u.email, u.disabled, u.archived, u.created_at,
         st.stand_number, p.name AS project_name,
         o.purchase_price_cents, o.status AS ownership_status,
         ag.name AS agent_name,
         (SELECT COALESCE(SUM(amount_cents), 0)
            FROM payments WHERE user_id = u.id AND status = 'Confirmed') AS paid_cents
  FROM users u
  LEFT JOIN ownerships o ON o.user_id = u.id
  LEFT JOIN stands     st ON st.id = o.stand_id
  LEFT JOIN projects   p  ON p.id = st.project_id
  LEFT JOIN agents     ag ON ag.id = o.agent_id
  WHERE u.role = 'client'`;

/* Grouped by development, so the order is development name first and then the
   client's own name. `p.name IS NULL` sorts ahead of everything in SQLite, so
   it is folded in first to push the clients with no stand to the bottom rather
   than the top — which is where "Unassigned" belongs. */
const qClientsList = prepare(
  `${CLIENTS_SELECT} AND u.archived = 0
   ORDER BY p.name IS NULL, p.name, u.full_name`);
const qClientsListAll = prepare(
  `${CLIENTS_SELECT}
   ORDER BY p.name IS NULL, p.name, u.full_name`);

/* ── Clients grouped by the development they bought into ────────────────────
   There is no development column on users. The link is three hops:
   users -> ownerships -> stands -> projects. Grouped with GROUP BY so a client
   holding two stands in the same development is listed once, while a client
   holding stands in two different developments appears under each — which is
   correct, not a duplicate. */
const qClientsByDevelopment = prepare(`
  SELECT p.name AS development, p.id AS project_id,
         u.id, u.client_number, u.full_name, u.email, u.disabled, u.archived
  FROM users u
  JOIN ownerships o ON o.user_id = u.id
  JOIN stands     st ON st.id = o.stand_id
  JOIN projects   p  ON p.id = st.project_id
  WHERE u.role = 'client'
  GROUP BY p.id, u.id
  ORDER BY p.name, u.full_name
`);

/* A client with no sale at all belongs to no development. */
const qClientsUnassigned = prepare(`
  SELECT u.id, u.client_number, u.full_name, u.email, u.disabled, u.archived
  FROM users u
  WHERE u.role = 'client'
    AND NOT EXISTS (SELECT 1 FROM ownerships o WHERE o.user_id = u.id)
  ORDER BY u.full_name
`);

/* ── Admin: single client ───────────────────────────────────────────────── */

const qClientById = prepare(`
  SELECT u.id, u.client_number, u.full_name, u.email, u.role, u.disabled, u.archived,
         u.created_at, u.locked_until, u.failed_attempts,
         o.id AS ownership_id, o.purchase_price_cents, o.purchase_date,
         o.status AS ownership_status,
         st.id AS stand_id, st.stand_number, st.size_sqm, st.type AS stand_type,
         p.name AS project_name, p.id AS project_id
  FROM users u
  LEFT JOIN ownerships o ON o.user_id = u.id
  LEFT JOIN stands     st ON st.id = o.stand_id
  LEFT JOIN projects   p  ON p.id = st.project_id
  WHERE u.id = ?
  ORDER BY o.id
  LIMIT 1
`);

const qUpdateClient = prepare('UPDATE users SET full_name = ?, email = ? WHERE id = ?');
const qSetDisabled  = prepare('UPDATE users SET disabled = ? WHERE id = ?');
const qSetArchived  = prepare('UPDATE users SET archived = ? WHERE id = ?');
const qSetPassword  = prepare(
  'UPDATE users SET password_hash = ?, failed_attempts = 0, locked_until = NULL WHERE id = ?');
const qUnlockClient = prepare(
  'UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?');

/* ── Admin: stands and ownership ────────────────────────────────────────── */

const qStandsAll = prepare(`
  SELECT st.id, st.stand_number, st.size_sqm, st.type, st.price_cents, st.status,
         p.name AS project_name,
         (SELECT u.client_number
            FROM ownerships o JOIN users u ON u.id = o.user_id
           WHERE o.stand_id = st.id
           LIMIT 1) AS held_by
  FROM stands st
  JOIN projects p ON p.id = st.project_id
  ORDER BY p.name, st.stand_number
`);

/* ── Admin: editing developments and the stands they contain ──────────────
   `sale_count` is what stops a stand being deleted out from under a sale the
   analytics and the client portal both read. */

const STAND_SELECT = `
  SELECT st.*, p.name AS project_name, p.location AS project_location,
         p.description AS project_description, p.image_url AS project_image_url,
         p.sold_out AS project_sold_out,
         p.coming_soon AS project_coming_soon,
         (SELECT COUNT(*) FROM ownerships o WHERE o.stand_id = st.id) AS sale_count
    FROM stands st
    JOIN projects p ON p.id = st.project_id`;

const qStandsForAdmin = prepare(`${STAND_SELECT} ORDER BY p.name, st.stand_number`);
const qStandById = prepare(`${STAND_SELECT} WHERE st.id = ?`);
/* For the client-facing property page, addressed by stand number rather than
   an internal id. */
const qStandByNumber = prepare(`${STAND_SELECT} WHERE lower(st.stand_number) = lower(?)`);

/* Stand numbers are globally unique in the schema, so the check has to be
   global too. Checking only within the development let a duplicate through to
   the INSERT, which then failed with a raw constraint error. Returns the
   clashing row so the message can name the development it belongs to. */
const qStandNumberTaken = prepare(`
  SELECT s.id, s.stand_number, p.name AS project_name
    FROM stands s JOIN projects p ON p.id = s.project_id
   WHERE lower(s.stand_number) = lower(?) AND s.id <> ?`);

const qInsertStand = prepare(`
  INSERT INTO stands (project_id, stand_number, size_sqm, type, price_cents, status, image_url,
                      currency, description, location, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

const qUpdateStand = prepare(`
  UPDATE stands
     SET project_id = ?, stand_number = ?, size_sqm = ?, type = ?,
         price_cents = ?, status = ?, image_url = ?,
         currency = ?, description = ?, location = ?, updated_at = ?
   WHERE id = ?`);

const qDeleteStand = prepare('DELETE FROM stands WHERE id = ?');
const qSetStandComingSoon = prepare('UPDATE stands SET coming_soon = ? WHERE id = ?');

const qUpdateProject = prepare(`
  UPDATE projects
     SET name = ?, location = ?, type = ?, status = ?, description = ?, image_url = ?,
         sold_out = ?, long_description = ?, features = ?
   WHERE id = ?`);

const qInsertProject = prepare(`
  INSERT INTO projects (name, location, type, status, description, image_url, sold_out,
                        long_description, features)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);

const qSetProjectSoldOut = prepare('UPDATE projects SET sold_out = ? WHERE id = ?');
const qSetProjectComingSoon = prepare('UPDATE projects SET coming_soon = ? WHERE id = ?');

/* ── Published price list ── */
const qPricingFor = prepare(
  'SELECT * FROM development_pricing WHERE project_id = ? ORDER BY position, id');
const qInsertPricing = prepare(`
  INSERT INTO development_pricing (project_id, size_label, cash, credit, deposit, position)
  VALUES (?, ?, ?, ?, ?, ?)`);
const qUpdatePricing = prepare(`
  UPDATE development_pricing SET size_label = ?, cash = ?, credit = ?, deposit = ? WHERE id = ?`);
const qDeletePricing = prepare('DELETE FROM development_pricing WHERE id = ?');
const qPricingById = prepare('SELECT * FROM development_pricing WHERE id = ?');
const qNextPricingPosition = prepare(
  'SELECT COALESCE(MAX(position), 0) + 1 AS p FROM development_pricing WHERE project_id = ?');

const qProjectNameTaken = prepare(
  'SELECT id FROM projects WHERE lower(name) = lower(?) AND id <> ?');

const qInsertOwnership = prepare(`
  INSERT INTO ownerships
    (user_id, stand_id, purchase_price_cents, purchase_date, status, agent_id)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const qOwnershipById = prepare('SELECT * FROM ownerships WHERE id = ?');
const qDeleteOwnership = prepare('DELETE FROM ownerships WHERE id = ?');

/* Is this stand already spoken for?

   `sale_status` is the lifecycle column — Active / Completed / Cancelled. Only
   'Cancelled' frees the stand again, and unlinkOwnership() deletes the row
   outright; both mean "no longer allocated". COALESCE guards rows written
   before the sale_status column existed.

   Note it is NOT `status`, which despite the name holds the service progress
   label the office sets by hand ("Servicing in progress", "Awaiting transfer",
   "Transferred", "Paid up") and never holds Active or Cancelled. */
const qStandAllocated = prepare(`
  SELECT 1 FROM ownerships
   WHERE stand_id = ? AND COALESCE(sale_status, 'Active') <> 'Cancelled'
   LIMIT 1
`);

const qSetStandStatus = prepare('UPDATE stands SET status = ? WHERE id = ?');
const qCountOwnershipsForUser = prepare('SELECT COUNT(*) AS c FROM ownerships WHERE user_id = ?');

/* The sales agents a sale can be credited to. Inactive agents are left out of
   the picker, but a sale they already closed still shows its agent name —
   that name is joined in CLIENTS_SELECT, not read from this list. Same query
   the analytics filters use. */
const qAgents = prepare('SELECT id, name FROM agents WHERE active = 1 ORDER BY name');

/* ── Admin: payments ────────────────────────────────────────────────────── */

/* The transaction columns are part of the insert so a payment recorded through
   the ordinary client form is typed and linked to its sale immediately —
   an untyped payment would be invisible to the analytics. */
const qInsertPayment = prepare(`
  INSERT INTO payments
    (user_id, stand_id, ownership_id, type, paid_on, reference, amount_cents, status,
     method, recorded_by, notes)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const qPaymentById = prepare('SELECT * FROM payments WHERE id = ?');
const qDeletePayment = prepare('DELETE FROM payments WHERE id = ?');
const qReferenceTaken = prepare('SELECT 1 AS x FROM payments WHERE reference = ?');
const qReferenceTakenByOther = prepare(
  'SELECT 1 AS x FROM payments WHERE reference = ? AND id <> ?');
const qSetPaymentStatus = prepare('UPDATE payments SET status = ? WHERE id = ?');
const qUpdatePayment = prepare(`
  UPDATE payments SET paid_on = ?, reference = ?, amount_cents = ?, status = ?
  WHERE id = ?
`);

/* The only two states a payment may hold. Anything else is refused rather than
   written, so the balance query cannot be fooled by an unexpected string. */
const PAYMENT_STATUSES = ['Confirmed', 'Pending'];

/* ── Admin: documents ───────────────────────────────────────────────────── */

const qDocumentsForUser = prepare(`
  SELECT id, title, stored_name, mime, size_bytes, uploaded_at
  FROM documents
  WHERE user_id = ?
  ORDER BY uploaded_at DESC, id DESC
`);
const qDocumentById = prepare('SELECT * FROM documents WHERE id = ?');
const qInsertDocument = prepare(`
  INSERT INTO documents (user_id, title, stored_name, mime, size_bytes, uploaded_at)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const qDeleteDocument = prepare('DELETE FROM documents WHERE id = ?');
const qCountDocumentsForUser = prepare('SELECT COUNT(*) AS c FROM documents WHERE user_id = ?');

/* ── Admin: project progress ────────────────────────────────────────────── */

/* Development statistics are counted from the properties themselves on every
   read, never stored. A stored count would drift the moment a stand changed
   status through any other path. */
const qProjectsWithCounts = prepare(`
  SELECT p.*,
         (SELECT COUNT(*) FROM progress WHERE project_id = p.id) AS step_count,
         (SELECT COUNT(*) FROM stands s WHERE s.project_id = p.id) AS property_count,
         (SELECT COUNT(*) FROM stands s WHERE s.project_id = p.id AND s.status = 'Available') AS available_count,
         (SELECT COUNT(*) FROM stands s WHERE s.project_id = p.id AND s.status = 'Reserved')  AS reserved_count,
         (SELECT COUNT(*) FROM stands s WHERE s.project_id = p.id AND s.status = 'On Hold')   AS on_hold_count,
         (SELECT COUNT(*) FROM stands s WHERE s.project_id = p.id AND s.status = 'Sold')      AS sold_count
  FROM projects p
  ORDER BY p.name
`);

const qProgressWithIds = prepare(
  'SELECT id, label, state, position FROM progress WHERE project_id = ? ORDER BY position, id');
const qUpdateProgressStep = prepare('UPDATE progress SET label = ?, state = ? WHERE id = ?');
const qDeleteProgressStep = prepare('DELETE FROM progress WHERE id = ?');
const qInsertProgressStep = prepare(
  'INSERT INTO progress (project_id, label, state, position) VALUES (?, ?, ?, ?)');
const qMaxProgressPosition = prepare(
  'SELECT COALESCE(MAX(position), 0) AS m FROM progress WHERE project_id = ?');

const VALID_STATES = new Set(['done', 'current', 'pending']);

/** Escapes LIKE wildcards so a search for "50%" is a literal, not a pattern.
    Synchronous on purpose: it is pure string work, and an async version returns
    a Promise that cannot be bound to a SQLite parameter. */
function likePattern(q) {
  return '%' + String(q).replace(/[\\%_]/g, (ch) => '\\' + ch) + '%';
}

const admin = {
  counts: async () => await qAdminCounts.get(),
  clients: async () => await qClientsList.all(),

  /**
   * Clients grouped under the development they are associated with, via their
   * sale. Any client without a sale is returned last, under "Unassigned".
   *
   * Returns [{ development, clients: [{ id, client_number, full_name, ... }] }]
   */
  async clientsByDevelopment() {
    const groups = [];
    const byName = new Map();

    for (const row of await qClientsByDevelopment.all()) {
      let group = byName.get(row.development);
      if (!group) {
        /* projectId travels with the group so the overview can link straight to
           the filtered client list. Without it the view has no id to build a
           URL from and the folders cannot be clickable. */
        group = { development: row.development, projectId: row.project_id, clients: [] };
        byName.set(row.development, group);
        groups.push(group);
      }
      group.clients.push(row);
    }

    const unassigned = await qClientsUnassigned.all();
    if (unassigned.length) {
      groups.push({ development: 'Unassigned', projectId: 'unassigned', clients: unassigned });
    }

    return groups;
  },

  /** Clients filtered by number, name or email. An empty query lists all.
      Archived accounts are excluded unless `includeArchived` is set.

      `developmentId` narrows the list to one development — a project id, or
      the string 'unassigned' for clients with no sale at all. Both are needed
      by the overview's folder tiles. */
  async searchClients(q, { includeArchived = false, developmentId = null } = {}) {
    const term = String(q || '').trim();

    /* The two simplest shapes are precompiled. A development filter changes the
       clause rather than just the bindings, so that case is built here. */
    if (!developmentId && !term) {
      return await (includeArchived ? qClientsListAll : qClientsList).all();
    }

    const clauses = [];
    const args = [];

    if (!includeArchived) clauses.push('u.archived = 0');

    if (developmentId === 'unassigned') {
      /* The same test qClientsUnassigned uses: no ownership row at all. */
      clauses.push('NOT EXISTS (SELECT 1 FROM ownerships ow WHERE ow.user_id = u.id)');
    } else if (Number.isInteger(developmentId) && developmentId > 0) {
      /* EXISTS rather than a join on the outer query, so a client holding two
         stands in the same development still appears once. */
      clauses.push(`EXISTS (SELECT 1 FROM ownerships ow
                              JOIN stands sw ON sw.id = ow.stand_id
                             WHERE ow.user_id = u.id AND sw.project_id = ?)`);
      args.push(developmentId);
    }

    if (term) {
      const pattern = likePattern(term);
      clauses.push(`(u.client_number LIKE ? ESCAPE '\\'
                  OR u.full_name     LIKE ? ESCAPE '\\'
                  OR COALESCE(u.email, '') LIKE ? ESCAPE '\\')`);
      args.push(pattern, pattern, pattern);
    }

    const where = clauses.length ? ` AND ${clauses.join(' AND ')}` : '';
    return await prepare(
      `${CLIENTS_SELECT}${where} ORDER BY p.name IS NULL, p.name, u.full_name`
    ).all(...args);
  },

  clientById: async (id) => await qClientById.get(id),

  async updateClient(id, { fullName, email }) {
    await qUpdateClient.run(fullName, email || null, id);
    return await qClientById.get(id);
  },

  async setDisabled(id, disabled) {
    await qSetDisabled.run(disabled ? 1 : 0, id);
    if (disabled) await sessions.destroyAllForUser(id);
  },

  /** Files a client account away, or brings it back.
      Archiving hides the account from the clients list and stops it signing in,
      but changes nothing else — the ownership, the payments and the audit trail
      all stay, which is the whole point of preferring it to a delete. Signing
      out on archive mirrors setDisabled, so a session opened a moment ago stops
      working rather than lingering until it expires. */
  async setClientArchived(id, archived) {
    await qSetArchived.run(archived ? 1 : 0, id);
    if (archived) await sessions.destroyAllForUser(id);
  },

  async setPassword(id, hash) {
    await qSetPassword.run(hash, id);
    // A password change must invalidate every existing session for that user.
    await sessions.destroyAllForUser(id);
  },

  async unlock(id) { await qUnlockClient.run(id); },

  stands: async () => await qStandsAll.all(),
  /* Sales agents, for the "who closed this sale?" picker. */
  agents: async () => await qAgents.all(),
  ownershipById: async (id) => await qOwnershipById.get(id),
  ownershipCountFor: async (userId) => (await qCountOwnershipsForUser.get(userId)).c,

  /** Links a stand to a client and marks the stand sold.
      `agentId` is the sales agent credited with the deal, or null when the
      office has not recorded one. */
  async linkStand({ userId, standId, priceCents, purchaseDate, status, agentId = null }) {
    /* Belt and braces. The admin form already offers only free stands and
       admin.js refuses one that is held by another client, but neither survives
       a double-click, a stale page left open, or two staff working at once.
       Checked here, next to the write, so it cannot be bypassed by a caller
       that forgets. */
    if (await qStandAllocated.get(standId)) {
      throw new Error('This stand is already allocated to another client.');
    }

    await qInsertOwnership.run(userId, standId, priceCents, purchaseDate, status,
      agentId === undefined ? null : agentId);
    await qSetStandStatus.run('Sold', standId);
  },

  /** Removes an ownership and frees the stand again. */
  async unlinkOwnership(ownershipId) {
    const o = await qOwnershipById.get(ownershipId);
    if (!o) return false;
    await qDeleteOwnership.run(ownershipId);
    await qSetStandStatus.run('Available', o.stand_id);
    return true;
  },

  paymentsFor: async (userId) => await qPayments.all(userId),
  paymentById: async (id) => await qPaymentById.get(id),
  referenceTaken: async (ref) => Boolean(await qReferenceTaken.get(ref)),

  async addPayment({ userId, standId, ownershipId = null, type = null, paidOn, reference,
    amountCents, status, method = null, recordedBy = null, notes = null }) {
    const info = await qInsertPayment.run(userId, standId || null, ownershipId, type, paidOn,
      reference, amountCents, status, method, recordedBy, notes);
    return Number(info.lastInsertRowid);
  },

  async deletePayment(id) { await qDeletePayment.run(id); },

  /** Confirms a pending payment, or puts a confirmed one back to pending. */
  async setPaymentStatus(id, status) {
    if (!PAYMENT_STATUSES.includes(status)) return false;
    await qSetPaymentStatus.run(status, id);
    return true;
  },

  async updatePayment(id, { paidOn, reference, amountCents, status }) {
    if (!PAYMENT_STATUSES.includes(status)) return false;
    await qUpdatePayment.run(paidOn, reference, amountCents, status, id);
    return true;
  },

  /** True when another payment already uses this reference. */
  referenceTakenBy: async (ref, id) => Boolean(await qReferenceTakenByOther.get(ref, id)),

  /* ── Documents ── */
  documentsFor: async (userId) => await qDocumentsForUser.all(userId),
  documentById: async (id) => await qDocumentById.get(id),
  documentCountFor: async (userId) => (await qCountDocumentsForUser.get(userId)).c,

  async addDocument({ userId, title, storedName, mime, sizeBytes }) {
    await qInsertDocument.run(userId, title, storedName, mime, sizeBytes, nowIso());
  },

  async deleteDocument(id) { await qDeleteDocument.run(id); },

  projects: async () => await qProjects.all(),
  projectsWithCounts: async () => await qProjectsWithCounts.all(),

  /**
   * Suggests the next free client number, e.g. HP-10246.
   * Derived from the highest existing HP- number rather than a counter table,
   * so it stays correct even if rows are deleted by hand.
   */
  async suggestClientNumber() {
    const rows = await prepare("SELECT client_number FROM users WHERE client_number LIKE 'HP-%'").all();
    let highest = 10000;
    for (const row of rows) {
      const n = Number.parseInt(String(row.client_number).slice(3), 10);
      if (Number.isInteger(n) && n > highest) highest = n;
    }
    return 'HP-' + String(highest + 1).padStart(5, '0');
  },

  async createClient({ clientNumber, fullName, email, passwordHash }) {
    return await users.insert({ clientNumber, fullName, email, role: 'client', passwordHash });
  },

  projectById: async (id) => await prepare('SELECT * FROM projects WHERE id = ?').get(id),

  /**
   * Removes a development along with everything that exists only because of it.
   *
   * `stands.project_id` has no ON DELETE clause, so deleting a development that
   * still owns properties raises a foreign key error. The properties are
   * therefore removed first, in the same transaction.
   *
   * The one thing this refuses to do is cascade over a financial record. If any
   * of the development's stands carries a sale or a payment, the delete is
   * abandoned and the blocking stands are named. Cascading those away would
   * erase a client's payment history, and that is the one thing on this system
   * that must never disappear without someone deciding it should.
   *
   * Returns { ok: true, stands } or { ok: false, reason, stands }.
   */
  async deleteProject(id) {
    const project = await prepare('SELECT * FROM projects WHERE id = ?').get(id);
    if (!project) return { ok: false, reason: 'notFound', stands: [] };

    const stands = await prepare(
      'SELECT id, stand_number FROM stands WHERE project_id = ? ORDER BY stand_number').all(id);

    const countFor = (table) =>
      prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE stand_id = ?`);

    const blocked = [];
    for (const s of stands) {
      const sales = await countFor('ownerships').get(s.id);
      const payments = await countFor('payments').get(s.id);
      if (sales.c || payments.c) blocked.push(s.stand_number);
    }
    if (blocked.length) return { ok: false, reason: 'hasRecords', stands: blocked };

    /* One transaction: either the development and all of its properties go, or
       nothing does. driver.transaction uses a real Turso transaction, which
       separate HTTP statements could not hold open. */
    await driver.transaction(async (tx) => {
      await tx.prepare('DELETE FROM stands WHERE project_id = ?').run(id);
      await tx.prepare('DELETE FROM progress WHERE project_id = ?').run(id);
      await tx.prepare('DELETE FROM development_pricing WHERE project_id = ?').run(id);
      await tx.prepare('DELETE FROM projects WHERE id = ?').run(id);
    });

    return { ok: true, stands: stands.map((s) => s.stand_number) };
  },

  /* ── Developments ── */
  /** True when another project already uses this name, case-insensitively. */
  projectNameTaken: async (name, exceptId = 0) => Boolean(await qProjectNameTaken.get(name, exceptId)),

  async updateProject(id, { name, location, type, status, description, imageUrl, soldOut,
    longDescription = null, features = null }) {
    await qUpdateProject.run(name, location, type, status, description, imageUrl, soldOut ? 1 : 0,
      longDescription, features, id);
    return true;
  },

  async createProject({ name, location, type, status, description, imageUrl, soldOut,
    longDescription = null, features = null }) {
    const info = await qInsertProject.run(name, location, type, status, description, imageUrl,
      soldOut ? 1 : 0, longDescription, features);
    return Number(info.lastInsertRowid);
  },

  /* ── The published price list for a development ── */
  pricingFor: async (projectId) => await qPricingFor.all(projectId),
  pricingById: async (id) => await qPricingById.get(id) || null,

  async addPricing(projectId, { sizeLabel, cash, credit, deposit }) {
    const position = (await qNextPricingPosition.get(projectId)).p;
    const info = await qInsertPricing.run(projectId, sizeLabel, cash, credit, deposit, position);
    return Number(info.lastInsertRowid);
  },

  async updatePricing(id, { sizeLabel, cash, credit, deposit }) {
    await qUpdatePricing.run(sizeLabel, cash, credit, deposit, id);
    return true;
  },

  deletePricing: async (id) => await qDeletePricing.run(id),

  /** The quick toggle on the projects list, without opening the full form. */
  async setProjectSoldOut(id, soldOut) {
    await qSetProjectSoldOut.run(soldOut ? 1 : 0, id);
    return true;
  },

  /** The same, for a development that has not been released yet. */
  async setProjectComingSoon(id, comingSoon) {
    await qSetProjectComingSoon.run(comingSoon ? 1 : 0, id);
    return true;
  },

  /* ── Stands, which the website shows as available properties ── */
  standsForAdmin: async () => await qStandsForAdmin.all(),
  /** Every property belonging to one development. */
  standsForProject: async (projectId) => await prepare(`${STAND_SELECT} WHERE st.project_id = ? ORDER BY st.stand_number`).all(projectId),
  standById: async (id) => await qStandById.get(id),
  standByNumber: async (number) => await qStandByNumber.get(number) || null,
  /** Returns the clashing row, or null. Stand numbers are unique globally. */
  standNumberTaken: async (standNumber, exceptId = 0) => await qStandNumberTaken.get(standNumber, exceptId) || null,

  async createStand({ projectId, standNumber, sizeSqm, type, priceCents, status, imageUrl,
    currency = 'US$', description = null, location = null }) {
    const at = new Date().toISOString();
    const info = await qInsertStand.run(projectId, standNumber, sizeSqm, type, priceCents, status,
      imageUrl, currency, description, location, at, at);
    return Number(info.lastInsertRowid);
  },

  async updateStand(id, { projectId, standNumber, sizeSqm, type, priceCents, status, imageUrl,
    currency = 'US$', description = null, location = null }) {
    await qUpdateStand.run(projectId, standNumber, sizeSqm, type, priceCents, status, imageUrl,
      currency, description, location, new Date().toISOString(), id);
    return true;
  },

  deleteStand: async (id) => await qDeleteStand.run(id),

  /** The quick toggle on the properties list, without opening the full form. */
  async setPropertyComingSoon(id, comingSoon) {
    await qSetStandComingSoon.run(comingSoon ? 1 : 0, id);
    return true;
  },

  progressSteps: async (projectId) => await qProgressWithIds.all(projectId),

  async setProgressStep(id, label, state) {
    if (!VALID_STATES.has(state)) return false;
    await qUpdateProgressStep.run(label, state, id);
    return true;
  },

  async deleteProgressStep(id) { await qDeleteProgressStep.run(id); },

  async addProgressStep(projectId, label, state) {
    const safeState = VALID_STATES.has(state) ? state : 'pending';
    const next = (await qMaxProgressPosition.get(projectId)).m + 1;
    await qInsertProgressStep.run(projectId, label, safeState, next);
  }
};


module.exports = {
  db, ready, driver, audit, users, sessions, agents, staffSessions,
  portal, enquiries, admin, content, nowIso,
  PAYMENT_STATUSES, TRANSACTION_TYPES, COLLECTION_TYPES, PAYMENT_METHODS,
  SALE_STATUSES, PROPERTY_TYPES, STAND_STATUSES, PROJECT_STATUSES
};
