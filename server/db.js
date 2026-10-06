'use strict';

/* ==========================================================================
   Database — SQLite via Node's built-in `node:sqlite`.
   No external driver, so there is nothing to install and no native build step.

   Conventions:
     - Money is stored as an integer number of cents (price_cents, amount_cents).
       Floating-point currency is a rounding-error bug waiting to happen.
     - Timestamps are ISO-8601 UTC strings.
   ========================================================================== */

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');
/* format.js has no dependencies of its own, so this cannot create a cycle. */
const { slugify } = require('./format');

fs.mkdirSync(path.dirname(config.DB_PATH), { recursive: true });
fs.mkdirSync(config.PRIVATE_DOCS_DIR, { recursive: true });

const db = new DatabaseSync(config.DB_PATH);

/* Referential integrity and a sane default journal mode. WAL lets the
   dashboard read while an enquiry write is in flight. */
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA busy_timeout = 5000');

db.exec(`
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
db.exec(`
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

function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

/* Enquiries gain a handled flag so the office can work through them. */
ensureColumn('enquiries', 'handled_at', 'TEXT');
ensureColumn('enquiries', 'handled_by', 'INTEGER REFERENCES users(id)');

/* Whether a development has nothing left to sell.
   Kept separate from `status` rather than added as another status value: a
   development can be finished being built (Completed) and sold out at the same
   time, and collapsing the two would lose one of them. */
ensureColumn('projects', 'sold_out', 'INTEGER NOT NULL DEFAULT 0');

/* The individual property gains the fields the business actually describes it
   by. `project_id` was already the link to its development, so nothing about
   the one-to-many relationship changes here — this only adds detail to the
   child, which is the side that was thin. */
ensureColumn('stands', 'currency', "TEXT NOT NULL DEFAULT 'US$'");
ensureColumn('stands', 'description', 'TEXT');
ensureColumn('stands', 'location', 'TEXT');
ensureColumn('stands', 'created_at', 'TEXT');
ensureColumn('stands', 'updated_at', 'TEXT');

/* Existing rows predate these fields. Stamped once, then left alone. */
{
  const stamped = new Date().toISOString();
  db.exec(`
    UPDATE stands SET currency = 'US$' WHERE currency IS NULL OR currency = '';
    UPDATE stands SET created_at = '${stamped}' WHERE created_at IS NULL;
    UPDATE stands SET updated_at = COALESCE(created_at, '${stamped}') WHERE updated_at IS NULL;
  `);
}

/* ── Development overview, features and the published price list ─────────
   These describe the development itself, so they hang off the parent record
   rather than being repeated on every property inside it. */
ensureColumn('projects', 'long_description', 'TEXT');
ensureColumn('projects', 'features', 'TEXT');

/* Prices are text rather than integer cents: the published list includes
   ranges such as "$2,000 – $4,000", which one integer cannot express. This is
   a tariff shown to buyers, not a figure the accounts add up — the sale price
   of an actual stand lives on the stand itself, in cents. */
db.exec(`
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
    const row = db.prepare('SELECT value FROM site_settings WHERE key = ?').get(key);
    if (row && row.value && !/^(\/|https?:|data:)/i.test(row.value)) {
      db.prepare('UPDATE site_settings SET value = ? WHERE key = ?').run(`/${row.value}`, key);
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

  for (const p of db.prepare('SELECT id, name, image_url FROM projects').all()) {
    if (external.test(p.image_url || '')) {
      db.prepare('UPDATE projects SET image_url = ? WHERE id = ?')
        .run(`/images/${slugify(p.name)}.jpg`, p.id);
    }
  }

  for (const s of db.prepare('SELECT id, stand_number, image_url FROM stands').all()) {
    if (external.test(s.image_url || '')) {
      db.prepare('UPDATE stands SET image_url = ? WHERE id = ?')
        .run(`/images/stand-${slugify(s.stand_number)}.jpg`, s.id);
    }
  }
}

/* A sale is an `ownerships` row; a payment is a `payments` row. That
   distinction is deliberate and load-bearing:
     NEW SALE is recorded once, when the stand is sold, and is NOT cash.
     Everything else below is money actually moving, and lives in payments. */
const TRANSACTION_TYPES = ['DEPOSIT', 'INSTALLMENT', 'FINAL_PAYMENT', 'REFUND'];

/* The four types that count towards collections. NEW SALE is excluded by
   definition — a signed contract is not money in the bank. */
const COLLECTION_TYPES = ['DEPOSIT', 'INSTALLMENT', 'FINAL_PAYMENT'];

const PAYMENT_METHODS = [
  'Cash', 'Bank transfer', 'EcoCash', 'InnBucks', 'Cheque', 'Card', 'Other'
];

const SALE_STATUSES = ['Active', 'Completed', 'Cancelled'];

/* Property vocabulary, offered as dropdowns so the office cannot introduce a
   fourth spelling of "Residential" that then breaks the website's filters. */
const PROPERTY_TYPES = ['Residential', 'Commercial', 'Industrial', 'Mixed use', 'Agricultural'];
const STAND_STATUSES = ['Available', 'Reserved', 'On Hold', 'Sold'];
const PROJECT_STATUSES = ['Planning', 'Development', 'Development in progress', 'Completed'];

/* ── Sales analytics: schema ─────────────────────────────────────────────
   Adds the columns the analytics need to the existing tables. Nothing here
   changes what already worked; the website, portal, statements and CMS read
   the same columns they always did. */

db.exec(`
CREATE TABLE IF NOT EXISTS agents (
  id         INTEGER PRIMARY KEY,
  name       TEXT    NOT NULL UNIQUE,
  email      TEXT,
  phone      TEXT,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT    NOT NULL
);

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
ensureColumn('ownerships', 'sale_price_cents', 'INTEGER');
ensureColumn('ownerships', 'deposit_required_cents', 'INTEGER');
ensureColumn('ownerships', 'payment_plan', 'TEXT');
ensureColumn('ownerships', 'agent_id', 'INTEGER REFERENCES agents(id)');
ensureColumn('ownerships', 'sale_status', "TEXT DEFAULT 'Active'");
ensureColumn('ownerships', 'sale_date', 'TEXT');
ensureColumn('ownerships', 'closed_at', 'TEXT');
ensureColumn('ownerships', 'sale_notes', 'TEXT');

/* The transaction side. `status` (Confirmed/Pending) already existed and keeps
   its meaning — whether the money has been verified. `voided_at` is a separate
   concept: a transaction that should no longer count at all. */
ensureColumn('payments', 'ownership_id', 'INTEGER REFERENCES ownerships(id)');
ensureColumn('payments', 'type', 'TEXT');
ensureColumn('payments', 'method', 'TEXT');
ensureColumn('payments', 'recorded_by', 'INTEGER REFERENCES users(id)');
ensureColumn('payments', 'notes', 'TEXT');
ensureColumn('payments', 'voided_at', 'TEXT');
ensureColumn('payments', 'voided_by', 'INTEGER REFERENCES users(id)');
ensureColumn('payments', 'void_reason', 'TEXT');
ensureColumn('payments', 'original_transaction_id', 'INTEGER REFERENCES payments(id)');
ensureColumn('payments', 'approved_by', 'INTEGER REFERENCES users(id)');

db.exec(`
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
function backfillTransactionModel() {
  const now = nowIso();

  db.exec(`
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
  db.exec(`
    UPDATE payments
       SET voided_at = COALESCE(voided_at, '${now}'),
           void_reason = COALESCE(void_reason, 'Incomplete record: missing date or amount')
     WHERE paid_on IS NULL OR paid_on = '' OR amount_cents IS NULL OR amount_cents <= 0;
  `);

  return db.prepare(
    "SELECT COUNT(*) AS c FROM payments WHERE ownership_id IS NOT NULL AND type IS NOT NULL"
  ).get().c;
}


const nowIso = () => new Date().toISOString();

/* ── Audit log ──────────────────────────────────────────────────────────── */

const insertAudit = db.prepare(`
  INSERT INTO audit_log (at, action, outcome, actor_user_id, client_number, detail, ip)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

function audit(action, outcome, { userId = null, clientNumber = null, detail = null, ip = null } = {}) {
  insertAudit.run(nowIso(), action, outcome, userId, clientNumber, detail, ip);
}

/* ── Users ──────────────────────────────────────────────────────────────── */

const qUserByNumber = db.prepare('SELECT * FROM users WHERE client_number = ?');
const qUserById     = db.prepare('SELECT * FROM users WHERE id = ?');
const qBumpFailed   = db.prepare('UPDATE users SET failed_attempts = failed_attempts + 1 WHERE id = ?');
const qLockUser     = db.prepare('UPDATE users SET locked_until = ?, failed_attempts = 0 WHERE id = ?');
const qResetFailed  = db.prepare('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?');

const users = {
  byClientNumber: (n) => qUserByNumber.get(n),
  byId: (id) => qUserById.get(id),
  bumpFailed: (id) => qBumpFailed.run(id),
  lock: (id, untilIso) => qLockUser.run(untilIso, id),
  resetFailed: (id) => qResetFailed.run(id),

  insert({ clientNumber, fullName, email, role = 'client', passwordHash }) {
    const stmt = db.prepare(`
      INSERT INTO users (client_number, full_name, email, role, password_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    return stmt.run(clientNumber, fullName, email, role, passwordHash, nowIso());
  }
};

/* ── Sessions ───────────────────────────────────────────────────────────── */

const qInsertSession = db.prepare(`
  INSERT INTO sessions (token_hash, user_id, created_at, expires_at, ip, user_agent)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const qFindSession = db.prepare(`
  SELECT s.token_hash, s.user_id, s.expires_at,
         u.client_number, u.full_name, u.role, u.disabled
  FROM sessions s
  JOIN users u ON u.id = s.user_id
  WHERE s.token_hash = ?
`);
const qDeleteSession = db.prepare('DELETE FROM sessions WHERE token_hash = ?');
const qDeleteExpired = db.prepare('DELETE FROM sessions WHERE expires_at < ?');
const qDeleteUserSessions = db.prepare('DELETE FROM sessions WHERE user_id = ?');

const sessions = {
  create({ tokenHash, userId, expiresAt, ip, userAgent }) {
    qInsertSession.run(tokenHash, userId, nowIso(), expiresAt, ip, userAgent);
  },
  find: (tokenHash) => qFindSession.get(tokenHash),
  destroy: (tokenHash) => qDeleteSession.run(tokenHash),
  destroyAllForUser: (userId) => qDeleteUserSessions.run(userId),
  purgeExpired: () => qDeleteExpired.run(nowIso())
};

/* ── Client portal reads ────────────────────────────────────────────────── */

const qOwnership = db.prepare(`
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
const qPayments = db.prepare(`
  SELECT id, stand_id, paid_on, reference, amount_cents, status
  FROM payments
  WHERE user_id = ?
  ORDER BY paid_on DESC, id DESC
`);

const qPaymentTotal = db.prepare(`
  SELECT COALESCE(SUM(amount_cents), 0) AS total
  FROM payments
  WHERE user_id = ? AND status = 'Confirmed'
`);

const qDocuments = db.prepare(`
  SELECT id, title, mime, size_bytes, uploaded_at
  FROM documents
  WHERE user_id = ?
  ORDER BY uploaded_at DESC
`);

const qDocumentForUser = db.prepare(`
  SELECT id, title, stored_name, mime
  FROM documents
  WHERE id = ? AND user_id = ?
`);

const qProgress = db.prepare(`
  SELECT label, state FROM progress WHERE project_id = ? ORDER BY position
`);

const qProjects = db.prepare('SELECT * FROM projects ORDER BY id');
/* `project_sold_out` travels with each stand so the website can leave a sold-out
   development out of the available-properties list without a second query. */
const qStands = db.prepare(`
  SELECT st.*, p.name AS project_name, p.sold_out AS project_sold_out,
         p.image_url AS project_image_url
  FROM stands st JOIN projects p ON p.id = st.project_id
  ORDER BY st.stand_number
`);

const portal = {
  ownershipFor: (userId) => qOwnership.get(userId),
  paymentsFor: (userId) => qPayments.all(userId),
  paidTotalFor: (userId) => qPaymentTotal.get(userId).total,
  documentsFor: (userId) => qDocuments.all(userId),
  documentForUser: (id, userId) => qDocumentForUser.get(id, userId),
  progressFor: (projectId) => qProgress.all(projectId),
  projects: () => qProjects.all(),
  stands: () => qStands.all()
};

const contentSchema = require('./content');
const { defaultSettings, defaultBlocks, defaultValue, defaultItemCount } = contentSchema;

/* ── New fields on already-seeded pages ──────────────────────────────────
   seedDefaults only runs from the seed script, so a field added to the schema
   after a site is live would never reach its database and would render blank.

   This fills in missing FIELDS, but only for items that already have a row. It
   deliberately never creates items: deleting a service card is a decision the
   office made, and re-adding it on the next restart would undo that. */
{
  const existing = new Set(
    db.prepare('SELECT page, section, item, field FROM content_blocks').all()
      .map((r) => `${r.page}\u0000${r.section}\u0000${r.item}\u0000${r.field}`));
  const liveItems = new Set(
    db.prepare('SELECT DISTINCT page, section, item FROM content_blocks').all()
      .map((r) => `${r.page}\u0000${r.section}\u0000${r.item}`));
  const liveSections = new Set(
    db.prepare('SELECT DISTINCT page, section FROM content_blocks').all()
      .map((r) => `${r.page}\u0000${r.section}`));
  const seededPages = new Set(
    db.prepare('SELECT DISTINCT page FROM content_blocks').all().map((r) => r.page));

  /* Only repeatable sections can have their items deleted in the admin, so a
     non-repeating section that is entirely absent was never created rather
     than removed. That is what makes seeding a brand-new section safe. */
  const repeatable = new Set();
  for (const p of contentSchema.PAGES) {
    for (const s of p.sections) {
      if (s.repeat) repeatable.add(`${p.key}\u0000${s.key}`);
    }
  }

  const insert = db.prepare(
    'INSERT INTO content_blocks (page, section, item, field, value) VALUES (?, ?, ?, ?, ?)');

  for (const b of defaultBlocks()) {
    const fieldKey = `${b.page}\u0000${b.section}\u0000${b.item}\u0000${b.field}`;
    if (existing.has(fieldKey)) continue;

    const itemKey = `${b.page}\u0000${b.section}\u0000${b.item}`;
    const sectionKey = `${b.page}\u0000${b.section}`;

    if (liveItems.has(itemKey)) {
      // A new field on an item that already exists.
      insert.run(b.page, b.section, b.item, b.field, b.value);
      continue;
    }

    /* A non-repeating section, on a page that is already live, with no rows at
       all: a section added to the schema after the site went live. */
    if (!repeatable.has(sectionKey) && seededPages.has(b.page) && !liveSections.has(sectionKey)) {
      insert.run(b.page, b.section, b.item, b.field, b.value);
    }
  }
}

/* ── Site settings and content blocks ───────────────────────────────────── */

const qAllSettings = db.prepare('SELECT key, value FROM site_settings');
const qUpsertSetting = db.prepare(`
  INSERT INTO site_settings (key, value, updated_at) VALUES (?, ?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
`);

const qBlocksForPage = db.prepare(
  'SELECT section, item, field, value FROM content_blocks WHERE page = ?');
const qUpsertBlock = db.prepare(`
  INSERT INTO content_blocks (page, section, item, field, value) VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(page, section, item, field) DO UPDATE SET value = excluded.value
`);
const qDeleteBlockItem = db.prepare(
  'DELETE FROM content_blocks WHERE page = ? AND section = ? AND item = ?');
const qDeletePageBlocks = db.prepare('DELETE FROM content_blocks WHERE page = ?');
const qCountBlocks = db.prepare('SELECT COUNT(*) AS c FROM content_blocks');

const range = (from, to) => {
  const out = [];
  for (let i = from; i <= to; i++) out.push(i);
  return out;
};

const content = {
  /** All settings, with factory defaults filling any gap. */
  settings() {
    const out = { ...defaultSettings() };
    for (const row of qAllSettings.all()) out[row.key] = row.value;
    return out;
  },

  setSetting(key, value) { qUpsertSetting.run(key, String(value ?? ''), nowIso()); },

  settingsList() {
    const stored = Object.create(null);
    for (const row of qAllSettings.all()) stored[row.key] = row.value;
    return stored;
  },

  setIsEmpty: () => qCountBlocks.get().c === 0,

  /**
   * Resolves one page's content for rendering.
   *
   * If the page has no rows at all it has never been seeded, so the factory
   * defaults are used. Once seeded, the database is trusted completely — which
   * is what makes deleting every item in a repeating section stick, rather
   * than the defaults silently reappearing.
   */
  resolve(pageKey) {
    const rows = qBlocksForPage.all(pageKey);
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
      get(section, field, item = 0) {
        const key = `${section}\u0000${item}\u0000${field}`;
        return map.has(key) ? map.get(key) : defaultValue(pageKey, section, field, item);
      },
      items(sectionKey) { return range(1, countFor(sectionKey)); },
      count: countFor
    };
  },

  setBlock(pageKey, sectionKey, item, fieldKey, value) {
    qUpsertBlock.run(pageKey, sectionKey, Number(item) || 0, fieldKey, String(value ?? ''));
  },

  /** Appends an item to a repeating section and returns its number. */
  addItem(pageKey, sectionKey) {
    const rows = qBlocksForPage.all(pageKey);
    let max = 0;
    for (const r of rows) if (r.section === sectionKey && r.item > max) max = r.item;
    const next = Math.max(max, defaultItemCount(pageKey, sectionKey)) + 1;
    for (const field of (contentSchema.sectionSchema(pageKey, sectionKey) || { fields: [] }).fields) {
      qUpsertBlock.run(pageKey, sectionKey, next, field.key, '');
    }
    return next;
  },

  deleteItem(pageKey, sectionKey, item) { qDeleteBlockItem.run(pageKey, sectionKey, Number(item)); },

  /**
   * Writes the factory content. Without `overwrite` only missing keys are
   * filled, so re-running the seed never destroys what the office has edited.
   */
  seedDefaults({ overwrite = false } = {}) {
    let settings = 0;
    let blocks = 0;

    const existingSettings = new Set(qAllSettings.all().map((r) => r.key));
    for (const s of contentSchema.SETTINGS) {
      if (overwrite || !existingSettings.has(s.key)) { qUpsertSetting.run(s.key, s.value, nowIso()); settings++; }
    }

    const existingBlocks = new Set(
      db.prepare('SELECT page, section, item, field FROM content_blocks').all()
        .map((r) => `${r.page}\u0000${r.section}\u0000${r.item}\u0000${r.field}`));

    for (const b of defaultBlocks()) {
      const key = `${b.page}\u0000${b.section}\u0000${b.item}\u0000${b.field}`;
      if (overwrite || !existingBlocks.has(key)) {
        qUpsertBlock.run(b.page, b.section, b.item, b.field, b.value);
        blocks++;
      }
    }

    return { settings, blocks };
  },

  /** Wipes a page's content so it can be re-seeded from scratch. */
  resetPage(pageKey) { qDeletePageBlocks.run(pageKey); }
};

/* ── Enquiries ──────────────────────────────────────────────────────────── */

const qInsertEnquiry = db.prepare(`
  INSERT INTO enquiries (name, phone, interest, message, created_at, ip)
  VALUES (?, ?, ?, ?, ?, ?)
`);

/* Unhandled first, then newest first within each group. */
const qEnquiriesAll = db.prepare(`
  SELECT id, name, phone, interest, message, created_at, handled_at
  FROM enquiries
  ORDER BY (handled_at IS NOT NULL), created_at DESC
`);

const qEnquiryCounts = db.prepare(`
  SELECT COUNT(*) AS total,
         COALESCE(SUM(CASE WHEN handled_at IS NULL THEN 1 ELSE 0 END), 0) AS open
  FROM enquiries
`);

const qEnquiryById = db.prepare('SELECT * FROM enquiries WHERE id = ?');
const qMarkHandled = db.prepare('UPDATE enquiries SET handled_at = ?, handled_by = ? WHERE id = ?');
const qReopen = db.prepare('UPDATE enquiries SET handled_at = NULL, handled_by = NULL WHERE id = ?');

const enquiries = {
  insert({ name, phone, interest, message, ip }) {
    return qInsertEnquiry.run(name, phone, interest, message, nowIso(), ip);
  },
  all: () => qEnquiriesAll.all(),
  byId: (id) => qEnquiryById.get(id),
  counts: () => qEnquiryCounts.get(),
  markHandled: (id, userId) => qMarkHandled.run(nowIso(), userId, id),
  reopen: (id) => qReopen.run(id)
};

/* ── Admin ──────────────────────────────────────────────────────────────── */

const qAdminCounts = db.prepare(`
  SELECT
    (SELECT COUNT(*) FROM users WHERE role = 'client')                            AS clients,
    (SELECT COUNT(*) FROM documents)                                              AS documents,
    (SELECT COUNT(*) FROM stands)                                                 AS stands,
    (SELECT COUNT(*) FROM payments)                                               AS payments,
    (SELECT COALESCE(SUM(amount_cents), 0) FROM payments WHERE status='Confirmed') AS paid_cents,
    (SELECT COUNT(*) FROM enquiries WHERE handled_at IS NULL)                      AS open_enquiries
`);

/* One row per client, with their stand and how much they have paid. */
const qClientsList = db.prepare(`
  SELECT u.id, u.client_number, u.full_name, u.email, u.disabled, u.created_at,
         st.stand_number, p.name AS project_name,
         o.purchase_price_cents, o.status AS ownership_status,
         (SELECT COALESCE(SUM(amount_cents), 0)
            FROM payments WHERE user_id = u.id AND status = 'Confirmed') AS paid_cents
  FROM users u
  LEFT JOIN ownerships o ON o.user_id = u.id
  LEFT JOIN stands     st ON st.id = o.stand_id
  LEFT JOIN projects   p  ON p.id = st.project_id
  WHERE u.role = 'client'
  ORDER BY u.client_number
`);

/* ── Clients grouped by the development they bought into ────────────────────
   There is no development column on users. The link is three hops:
   users -> ownerships -> stands -> projects. Grouped with GROUP BY so a client
   holding two stands in the same development is listed once, while a client
   holding stands in two different developments appears under each — which is
   correct, not a duplicate. */
const qClientsByDevelopment = db.prepare(`
  SELECT p.name AS development, p.id AS project_id,
         u.id, u.client_number, u.full_name, u.email, u.disabled
  FROM users u
  JOIN ownerships o ON o.user_id = u.id
  JOIN stands     st ON st.id = o.stand_id
  JOIN projects   p  ON p.id = st.project_id
  WHERE u.role = 'client'
  GROUP BY p.id, u.id
  ORDER BY p.name, u.full_name
`);

/* A client with no sale at all belongs to no development. */
const qClientsUnassigned = db.prepare(`
  SELECT u.id, u.client_number, u.full_name, u.email, u.disabled
  FROM users u
  WHERE u.role = 'client'
    AND NOT EXISTS (SELECT 1 FROM ownerships o WHERE o.user_id = u.id)
  ORDER BY u.full_name
`);

/* ── Admin: single client ───────────────────────────────────────────────── */

const qClientById = db.prepare(`
  SELECT u.id, u.client_number, u.full_name, u.email, u.role, u.disabled,
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

const qUpdateClient = db.prepare('UPDATE users SET full_name = ?, email = ? WHERE id = ?');
const qSetDisabled  = db.prepare('UPDATE users SET disabled = ? WHERE id = ?');
const qSetPassword  = db.prepare(
  'UPDATE users SET password_hash = ?, failed_attempts = 0, locked_until = NULL WHERE id = ?');
const qUnlockClient = db.prepare(
  'UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?');

/* ── Admin: stands and ownership ────────────────────────────────────────── */

const qStandsAll = db.prepare(`
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
         (SELECT COUNT(*) FROM ownerships o WHERE o.stand_id = st.id) AS sale_count
    FROM stands st
    JOIN projects p ON p.id = st.project_id`;

const qStandsForAdmin = db.prepare(`${STAND_SELECT} ORDER BY p.name, st.stand_number`);
const qStandById = db.prepare(`${STAND_SELECT} WHERE st.id = ?`);
/* For the client-facing property page, addressed by stand number rather than
   an internal id. */
const qStandByNumber = db.prepare(`${STAND_SELECT} WHERE lower(st.stand_number) = lower(?)`);

/* Stand numbers are globally unique in the schema, so the check has to be
   global too. Checking only within the development let a duplicate through to
   the INSERT, which then failed with a raw constraint error. Returns the
   clashing row so the message can name the development it belongs to. */
const qStandNumberTaken = db.prepare(`
  SELECT s.id, s.stand_number, p.name AS project_name
    FROM stands s JOIN projects p ON p.id = s.project_id
   WHERE lower(s.stand_number) = lower(?) AND s.id <> ?`);

const qInsertStand = db.prepare(`
  INSERT INTO stands (project_id, stand_number, size_sqm, type, price_cents, status, image_url,
                      currency, description, location, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

const qUpdateStand = db.prepare(`
  UPDATE stands
     SET project_id = ?, stand_number = ?, size_sqm = ?, type = ?,
         price_cents = ?, status = ?, image_url = ?,
         currency = ?, description = ?, location = ?, updated_at = ?
   WHERE id = ?`);

const qDeleteStand = db.prepare('DELETE FROM stands WHERE id = ?');

const qUpdateProject = db.prepare(`
  UPDATE projects
     SET name = ?, location = ?, type = ?, status = ?, description = ?, image_url = ?,
         sold_out = ?, long_description = ?, features = ?
   WHERE id = ?`);

const qInsertProject = db.prepare(`
  INSERT INTO projects (name, location, type, status, description, image_url, sold_out,
                        long_description, features)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);

const qSetProjectSoldOut = db.prepare('UPDATE projects SET sold_out = ? WHERE id = ?');

/* ── Published price list ── */
const qPricingFor = db.prepare(
  'SELECT * FROM development_pricing WHERE project_id = ? ORDER BY position, id');
const qInsertPricing = db.prepare(`
  INSERT INTO development_pricing (project_id, size_label, cash, credit, deposit, position)
  VALUES (?, ?, ?, ?, ?, ?)`);
const qUpdatePricing = db.prepare(`
  UPDATE development_pricing SET size_label = ?, cash = ?, credit = ?, deposit = ? WHERE id = ?`);
const qDeletePricing = db.prepare('DELETE FROM development_pricing WHERE id = ?');
const qPricingById = db.prepare('SELECT * FROM development_pricing WHERE id = ?');
const qNextPricingPosition = db.prepare(
  'SELECT COALESCE(MAX(position), 0) + 1 AS p FROM development_pricing WHERE project_id = ?');

const qProjectNameTaken = db.prepare(
  'SELECT id FROM projects WHERE lower(name) = lower(?) AND id <> ?');

const qInsertOwnership = db.prepare(`
  INSERT INTO ownerships (user_id, stand_id, purchase_price_cents, purchase_date, status)
  VALUES (?, ?, ?, ?, ?)
`);
const qOwnershipById = db.prepare('SELECT * FROM ownerships WHERE id = ?');
const qDeleteOwnership = db.prepare('DELETE FROM ownerships WHERE id = ?');
const qSetStandStatus = db.prepare('UPDATE stands SET status = ? WHERE id = ?');
const qCountOwnershipsForUser = db.prepare('SELECT COUNT(*) AS c FROM ownerships WHERE user_id = ?');

/* ── Admin: payments ────────────────────────────────────────────────────── */

/* The transaction columns are part of the insert so a payment recorded through
   the ordinary client form is typed and linked to its sale immediately —
   an untyped payment would be invisible to the analytics. */
const qInsertPayment = db.prepare(`
  INSERT INTO payments
    (user_id, stand_id, ownership_id, type, paid_on, reference, amount_cents, status,
     method, recorded_by, notes)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const qPaymentById = db.prepare('SELECT * FROM payments WHERE id = ?');
const qDeletePayment = db.prepare('DELETE FROM payments WHERE id = ?');
const qReferenceTaken = db.prepare('SELECT 1 AS x FROM payments WHERE reference = ?');
const qReferenceTakenByOther = db.prepare(
  'SELECT 1 AS x FROM payments WHERE reference = ? AND id <> ?');
const qSetPaymentStatus = db.prepare('UPDATE payments SET status = ? WHERE id = ?');
const qUpdatePayment = db.prepare(`
  UPDATE payments SET paid_on = ?, reference = ?, amount_cents = ?, status = ?
  WHERE id = ?
`);

/* The only two states a payment may hold. Anything else is refused rather than
   written, so the balance query cannot be fooled by an unexpected string. */
const PAYMENT_STATUSES = ['Confirmed', 'Pending'];

/* ── Admin: documents ───────────────────────────────────────────────────── */

const qDocumentsForUser = db.prepare(`
  SELECT id, title, stored_name, mime, size_bytes, uploaded_at
  FROM documents
  WHERE user_id = ?
  ORDER BY uploaded_at DESC, id DESC
`);
const qDocumentById = db.prepare('SELECT * FROM documents WHERE id = ?');
const qInsertDocument = db.prepare(`
  INSERT INTO documents (user_id, title, stored_name, mime, size_bytes, uploaded_at)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const qDeleteDocument = db.prepare('DELETE FROM documents WHERE id = ?');
const qCountDocumentsForUser = db.prepare('SELECT COUNT(*) AS c FROM documents WHERE user_id = ?');

/* ── Admin: project progress ────────────────────────────────────────────── */

/* Development statistics are counted from the properties themselves on every
   read, never stored. A stored count would drift the moment a stand changed
   status through any other path. */
const qProjectsWithCounts = db.prepare(`
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

const qProgressWithIds = db.prepare(
  'SELECT id, label, state, position FROM progress WHERE project_id = ? ORDER BY position, id');
const qUpdateProgressStep = db.prepare('UPDATE progress SET label = ?, state = ? WHERE id = ?');
const qDeleteProgressStep = db.prepare('DELETE FROM progress WHERE id = ?');
const qInsertProgressStep = db.prepare(
  'INSERT INTO progress (project_id, label, state, position) VALUES (?, ?, ?, ?)');
const qMaxProgressPosition = db.prepare(
  'SELECT COALESCE(MAX(position), 0) AS m FROM progress WHERE project_id = ?');

const VALID_STATES = new Set(['done', 'current', 'pending']);

/** Escapes LIKE wildcards so a search for "50%" is a literal, not a pattern. */
function likePattern(q) {
  return '%' + String(q).replace(/[\\%_]/g, (ch) => '\\' + ch) + '%';
}

const admin = {
  counts: () => qAdminCounts.get(),
  clients: () => qClientsList.all(),

  /**
   * Clients grouped under the development they are associated with, via their
   * sale. Any client without a sale is returned last, under "Unassigned".
   *
   * Returns [{ development, clients: [{ id, client_number, full_name, ... }] }]
   */
  clientsByDevelopment() {
    const groups = [];
    const byName = new Map();

    for (const row of qClientsByDevelopment.all()) {
      let group = byName.get(row.development);
      if (!group) {
        group = { development: row.development, clients: [] };
        byName.set(row.development, group);
        groups.push(group);
      }
      group.clients.push(row);
    }

    const unassigned = qClientsUnassigned.all();
    if (unassigned.length) groups.push({ development: 'Unassigned', clients: unassigned });

    return groups;
  },

  /** Clients filtered by number, name or email. An empty query lists all. */
  searchClients(q) {
    const term = String(q || '').trim();
    if (!term) return qClientsList.all();

    const pattern = likePattern(term);
    return db.prepare(`
      SELECT u.id, u.client_number, u.full_name, u.email, u.disabled, u.created_at,
             st.stand_number, p.name AS project_name,
             o.purchase_price_cents, o.status AS ownership_status,
             (SELECT COALESCE(SUM(amount_cents), 0)
                FROM payments WHERE user_id = u.id AND status = 'Confirmed') AS paid_cents
      FROM users u
      LEFT JOIN ownerships o ON o.user_id = u.id
      LEFT JOIN stands     st ON st.id = o.stand_id
      LEFT JOIN projects   p  ON p.id = st.project_id
      WHERE u.role = 'client'
        AND (u.client_number LIKE ? ESCAPE '\\'
          OR u.full_name     LIKE ? ESCAPE '\\'
          OR COALESCE(u.email, '') LIKE ? ESCAPE '\\')
      ORDER BY u.client_number
    `).all(pattern, pattern, pattern);
  },

  clientById: (id) => qClientById.get(id),

  updateClient(id, { fullName, email }) {
    qUpdateClient.run(fullName, email || null, id);
    return qClientById.get(id);
  },

  setDisabled(id, disabled) {
    qSetDisabled.run(disabled ? 1 : 0, id);
    if (disabled) sessions.destroyAllForUser(id);
  },

  setPassword(id, hash) {
    qSetPassword.run(hash, id);
    // A password change must invalidate every existing session for that user.
    sessions.destroyAllForUser(id);
  },

  unlock(id) { qUnlockClient.run(id); },

  stands: () => qStandsAll.all(),
  ownershipById: (id) => qOwnershipById.get(id),
  ownershipCountFor: (userId) => qCountOwnershipsForUser.get(userId).c,

  /** Links a stand to a client and marks the stand sold. */
  linkStand({ userId, standId, priceCents, purchaseDate, status }) {
    qInsertOwnership.run(userId, standId, priceCents, purchaseDate, status);
    qSetStandStatus.run('Sold', standId);
  },

  /** Removes an ownership and frees the stand again. */
  unlinkOwnership(ownershipId) {
    const o = qOwnershipById.get(ownershipId);
    if (!o) return false;
    qDeleteOwnership.run(ownershipId);
    qSetStandStatus.run('Available', o.stand_id);
    return true;
  },

  paymentsFor: (userId) => qPayments.all(userId),
  paymentById: (id) => qPaymentById.get(id),
  referenceTaken: (ref) => Boolean(qReferenceTaken.get(ref)),

  addPayment({ userId, standId, ownershipId = null, type = null, paidOn, reference,
    amountCents, status, method = null, recordedBy = null, notes = null }) {
    qInsertPayment.run(userId, standId || null, ownershipId, type, paidOn, reference,
      amountCents, status, method, recordedBy, notes);
    return Number(db.prepare('SELECT last_insert_rowid() AS id').get().id);
  },

  deletePayment(id) { qDeletePayment.run(id); },

  /** Confirms a pending payment, or puts a confirmed one back to pending. */
  setPaymentStatus(id, status) {
    if (!PAYMENT_STATUSES.includes(status)) return false;
    qSetPaymentStatus.run(status, id);
    return true;
  },

  updatePayment(id, { paidOn, reference, amountCents, status }) {
    if (!PAYMENT_STATUSES.includes(status)) return false;
    qUpdatePayment.run(paidOn, reference, amountCents, status, id);
    return true;
  },

  /** True when another payment already uses this reference. */
  referenceTakenBy: (ref, id) => Boolean(qReferenceTakenByOther.get(ref, id)),

  /* ── Documents ── */
  documentsFor: (userId) => qDocumentsForUser.all(userId),
  documentById: (id) => qDocumentById.get(id),
  documentCountFor: (userId) => qCountDocumentsForUser.get(userId).c,

  addDocument({ userId, title, storedName, mime, sizeBytes }) {
    qInsertDocument.run(userId, title, storedName, mime, sizeBytes, nowIso());
  },

  deleteDocument(id) { qDeleteDocument.run(id); },

  projects: () => qProjects.all(),
  projectsWithCounts: () => qProjectsWithCounts.all(),

  /**
   * Suggests the next free client number, e.g. HP-10246.
   * Derived from the highest existing HP- number rather than a counter table,
   * so it stays correct even if rows are deleted by hand.
   */
  suggestClientNumber() {
    const rows = db.prepare("SELECT client_number FROM users WHERE client_number LIKE 'HP-%'").all();
    let highest = 10000;
    for (const row of rows) {
      const n = Number.parseInt(String(row.client_number).slice(3), 10);
      if (Number.isInteger(n) && n > highest) highest = n;
    }
    return 'HP-' + String(highest + 1).padStart(5, '0');
  },

  createClient({ clientNumber, fullName, email, passwordHash }) {
    return users.insert({ clientNumber, fullName, email, role: 'client', passwordHash });
  },

  projectById: (id) => db.prepare('SELECT * FROM projects WHERE id = ?').get(id),

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
  deleteProject(id) {
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
    if (!project) return { ok: false, reason: 'notFound', stands: [] };

    const stands = db.prepare(
      'SELECT id, stand_number FROM stands WHERE project_id = ? ORDER BY stand_number').all(id);

    const countFor = (table) =>
      db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE stand_id = ?`);

    const blocked = [];
    for (const s of stands) {
      const sales = countFor('ownerships').get(s.id).c;
      const payments = countFor('payments').get(s.id).c;
      if (sales || payments) blocked.push(s.stand_number);
    }
    if (blocked.length) return { ok: false, reason: 'hasRecords', stands: blocked };

    /* One transaction: either the development and all of its properties go, or
       nothing does. */
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('DELETE FROM stands WHERE project_id = ?').run(id);
      db.prepare('DELETE FROM progress WHERE project_id = ?').run(id);
      db.prepare('DELETE FROM development_pricing WHERE project_id = ?').run(id);
      db.prepare('DELETE FROM projects WHERE id = ?').run(id);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }

    return { ok: true, stands: stands.map((s) => s.stand_number) };
  },

  /* ── Developments ── */
  /** True when another project already uses this name, case-insensitively. */
  projectNameTaken: (name, exceptId = 0) => Boolean(qProjectNameTaken.get(name, exceptId)),

  updateProject(id, { name, location, type, status, description, imageUrl, soldOut,
    longDescription = null, features = null }) {
    qUpdateProject.run(name, location, type, status, description, imageUrl, soldOut ? 1 : 0,
      longDescription, features, id);
    return true;
  },

  createProject({ name, location, type, status, description, imageUrl, soldOut,
    longDescription = null, features = null }) {
    const info = qInsertProject.run(name, location, type, status, description, imageUrl,
      soldOut ? 1 : 0, longDescription, features);
    return Number(info.lastInsertRowid);
  },

  /* ── The published price list for a development ── */
  pricingFor: (projectId) => qPricingFor.all(projectId),
  pricingById: (id) => qPricingById.get(id) || null,

  addPricing(projectId, { sizeLabel, cash, credit, deposit }) {
    const position = qNextPricingPosition.get(projectId).p;
    const info = qInsertPricing.run(projectId, sizeLabel, cash, credit, deposit, position);
    return Number(info.lastInsertRowid);
  },

  updatePricing(id, { sizeLabel, cash, credit, deposit }) {
    qUpdatePricing.run(sizeLabel, cash, credit, deposit, id);
    return true;
  },

  deletePricing: (id) => qDeletePricing.run(id),

  /** The quick toggle on the projects list, without opening the full form. */
  setProjectSoldOut(id, soldOut) {
    qSetProjectSoldOut.run(soldOut ? 1 : 0, id);
    return true;
  },

  /* ── Stands, which the website shows as available properties ── */
  standsForAdmin: () => qStandsForAdmin.all(),
  /** Every property belonging to one development. */
  standsForProject: (projectId) => db.prepare(`${STAND_SELECT} WHERE st.project_id = ? ORDER BY st.stand_number`).all(projectId),
  standById: (id) => qStandById.get(id),
  standByNumber: (number) => qStandByNumber.get(number) || null,
  /** Returns the clashing row, or null. Stand numbers are unique globally. */
  standNumberTaken: (standNumber, exceptId = 0) =>
    qStandNumberTaken.get(standNumber, exceptId) || null,

  createStand({ projectId, standNumber, sizeSqm, type, priceCents, status, imageUrl,
    currency = 'US$', description = null, location = null }) {
    const at = new Date().toISOString();
    const info = qInsertStand.run(projectId, standNumber, sizeSqm, type, priceCents, status,
      imageUrl, currency, description, location, at, at);
    return Number(info.lastInsertRowid);
  },

  updateStand(id, { projectId, standNumber, sizeSqm, type, priceCents, status, imageUrl,
    currency = 'US$', description = null, location = null }) {
    qUpdateStand.run(projectId, standNumber, sizeSqm, type, priceCents, status, imageUrl,
      currency, description, location, new Date().toISOString(), id);
    return true;
  },

  deleteStand: (id) => qDeleteStand.run(id),
  progressSteps: (projectId) => qProgressWithIds.all(projectId),

  setProgressStep(id, label, state) {
    if (!VALID_STATES.has(state)) return false;
    qUpdateProgressStep.run(label, state, id);
    return true;
  },

  deleteProgressStep(id) { qDeleteProgressStep.run(id); },

  addProgressStep(projectId, label, state) {
    const safeState = VALID_STATES.has(state) ? state : 'pending';
    const next = qMaxProgressPosition.get(projectId).m + 1;
    qInsertProgressStep.run(projectId, label, safeState, next);
  }
};

/* Runs once per start; the statements are written to be idempotent. */
const backfilledPayments = backfillTransactionModel();

module.exports = {
  db, audit, users, sessions, portal, enquiries, admin, content, nowIso,
  PAYMENT_STATUSES, TRANSACTION_TYPES, COLLECTION_TYPES, PAYMENT_METHODS,
  SALE_STATUSES, PROPERTY_TYPES, STAND_STATUSES, PROJECT_STATUSES
};
