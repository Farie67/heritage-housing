'use strict';

/* ==========================================================================
   Database driver.

   One async interface over two possible engines:

     - Turso (@libsql/client)      when TURSO_DATABASE_URL is set
     - node:sqlite (a local file)  otherwise

   The rest of the application talks only to the shim below, so which engine is
   in use stays a deployment detail. Both paths expose the same three statement
   methods — get, all, run — and all three return Promises.

   node:sqlite is synchronous. Its methods are wrapped so they resolve on the
   next tick, which gives callers one consistent promise-based contract whether
   the database is a file on this machine or a server somewhere else.
   ========================================================================== */

const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');

/* ── Engine selection ───────────────────────────────────────────────────── */

let libsql = null;

if (process.env.TURSO_DATABASE_URL) {
  try {
    libsql = require('@libsql/client');
  } catch {
    /* Fail loudly. Someone who has configured a remote database must never
       have their writes silently land in a file on the web server instead. */
    throw new Error(
      'TURSO_DATABASE_URL is set but @libsql/client is not installed. '
      + "Run 'npm install' before starting the server."
    );
  }
}

const usingTurso = Boolean(libsql);
const engine = usingTurso ? 'turso' : 'sqlite';

let client = null;
if (usingTurso) {
  client = libsql.createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN
  });
}

let sqlite = null;
if (!usingTurso) {
  const { DatabaseSync } = require('node:sqlite');
  fs.mkdirSync(path.dirname(config.DB_PATH), { recursive: true });
  sqlite = new DatabaseSync(config.DB_PATH);
  /* WAL lets the dashboard read while a write is in flight. */
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.exec('PRAGMA journal_mode = WAL');
  sqlite.exec('PRAGMA busy_timeout = 5000');
}

fs.mkdirSync(config.PRIVATE_DOCS_DIR, { recursive: true });

/* ── Arg coercion ───────────────────────────────────────────────────────── */

/* libsql rejects undefined and booleans outright; node:sqlite tolerates
   neither well either. Normalising here keeps every call site unchanged. */
function normalise(args) {
  return args.map((v) => {
    if (v === undefined) return null;
    if (typeof v === 'boolean') return v ? 1 : 0;
    return v;
  });
}

/* ── The shim ───────────────────────────────────────────────────────────── */

function prepare(sql) {
  if (usingTurso) {
    return {
      async get(...args) {
        const r = await client.execute({ sql, args: normalise(args) });
        return r.rows[0];
      },
      async all(...args) {
        const r = await client.execute({ sql, args: normalise(args) });
        return r.rows;
      },
      async run(...args) {
        const r = await client.execute({ sql, args: normalise(args) });
        /* rowsAffected and lastInsertRowid both come back as BigInt, which
           throws the moment it reaches JSON.stringify — hence Number(). */
        return {
          changes: Number(r.rowsAffected || 0),
          lastInsertRowid: r.lastInsertRowid === undefined
            ? undefined : Number(r.lastInsertRowid)
        };
      }
    };
  }

  /* Compiled on first use, not at module load. The schema is created
     asynchronously now, so a statement prepared at require time would be
     compiled against tables that do not exist yet. */
  let stmt = null;
  const compiled = () => {
    if (!stmt) stmt = sqlite.prepare(sql);
    return stmt;
  };

  return {
    async get(...args) { return compiled().get(...normalise(args)); },
    async all(...args) { return compiled().all(...normalise(args)); },
    async run(...args) { return compiled().run(...normalise(args)); }
  };
}

async function exec(sql) {
  if (!usingTurso) return sqlite.exec(sql);

  const text = String(sql).trim();
  if (!text) return undefined;

  /* Turso always enforces foreign keys and manages its own journalling, so the
     local-file PRAGMAs are meaningless there. */
  if (/^PRAGMA\b/i.test(text)) return undefined;

  /* libsql will not accept several statements in one execute() call. */
  if (client.executeMultiple) return client.executeMultiple(text);

  const parts = text.split(/;\s*(?=(?:[^'"]*['"][^'"]*['"])*[^'"]*$)/).filter((s) => s.trim());
  for (const part of parts) await client.execute(part);
  return undefined;
}

/**
 * Runs `fn` inside a transaction and returns its result.
 *
 * `fn` receives an object with the same prepare/exec shape, so the body of a
 * transactional operation reads the same on both engines.
 */
async function transaction(fn) {
  if (!usingTurso) {
    await exec('BEGIN IMMEDIATE');
    try {
      const result = await fn({ prepare, exec });
      await exec('COMMIT');
      return result;
    } catch (err) {
      await exec('ROLLBACK');
      throw err;
    }
  }

  /* libsql wants a real transaction object; separate HTTP calls cannot hold
     one open, so the statements have to be routed through it. */
  const tx = await client.transaction('write');
  try {
    const result = await fn({
      prepare: (sql) => ({
        async get(...args) {
          const r = await tx.execute({ sql, args: normalise(args) });
          return r.rows[0];
        },
        async all(...args) {
          const r = await tx.execute({ sql, args: normalise(args) });
          return r.rows;
        },
        async run(...args) {
          const r = await tx.execute({ sql, args: normalise(args) });
          return {
            changes: Number(r.rowsAffected || 0),
            lastInsertRowid: r.lastInsertRowid === undefined
              ? undefined : Number(r.lastInsertRowid)
          };
        }
      }),
      exec: async (sql) => {
        const text = String(sql).trim();
        if (!text || /^PRAGMA\b/i.test(text)) return undefined;
        return tx.executeMultiple ? tx.executeMultiple(text) : tx.execute(text);
      }
    });
    await tx.commit();
    return result;
  } catch (err) {
    try { await tx.rollback(); } catch { /* already rolled back */ }
    throw err;
  }
}

module.exports = { prepare, exec, transaction, engine, usingTurso };
