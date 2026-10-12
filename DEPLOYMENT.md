# Deployment to cPanel

Heritage Housing Projects — Node.js application.

---

## Where the data lives: Turso or a local file

`server/driver.js` chooses the database engine at start-up:

| `TURSO_DATABASE_URL` | Engine | Notes |
|---|---|---|
| **set** | Turso, via `@libsql/client` | The production choice — no database file on the server to lose or to back up by hand |
| **unset** | local `node:sqlite` file at `DB_PATH` | Development and the test suite; needs no network and no install |

Both engines expose exactly the same asynchronous methods, so nothing else in the
codebase changes between them.

To use Turso, set both variables in cPanel's **Environment Variables** section:

```
TURSO_DATABASE_URL = libsql://<your-database>.turso.io
TURSO_AUTH_TOKEN   = <token>
```

and run `npm install` so `@libsql/client` is present. If Turso is configured but the
package is missing, the driver **refuses to start** rather than quietly writing to a
local file — a silent fallback would mean payments landing somewhere nobody looks.

> **`data/` is no longer needed when Turso is in use.** The migration to Turso also
> copies the existing rows across; do that once, from a machine that can reach both,
> before switching the live site over. Keep the old `data/heritage.db` until the Turso
> data has been checked.

---

## Before you start: Node version

The local fallback uses **`node:sqlite`**, which is built into Node but only exists from
**Node 22.5.0 onwards**. It was developed and tested on Node 24.

In cPanel, open **Setup Node.js App** and check the selected Node version. If it is
below 22.5.0, change it to the newest version cPanel offers before doing anything else.
An older runtime will fail on startup with `Cannot find module 'node:sqlite'`.

You can confirm the version on the server with:

```bash
node --version
```

---

## Step 1: Run npm install

```bash
npm install
```

Required **only** for the Turso path, to fetch `@libsql/client`. On the local-file
fallback the application uses nothing but Node's standard library and runs with no
install step at all. cPanel's Node.js App manager often runs this automatically.

## Step 2: Set file permissions for the database to 755

Skip this step entirely if you are using Turso — there is no database file.

The local database is **`data/heritage.db`**, not `database.sqlite`.

```bash
chmod 755 data/heritage.db
```

> **The directory matters more than the file.** SQLite writes a `-wal` and a `-shm`
> file next to the database while the app is running, so the **`data/` directory**
> must be writable by the application user. If `data/` is not writable, the site will
> start but every page that reads the database will fail.
>
> ```bash
> chmod 755 data
> ```

If `data/heritage.db` does not exist yet, the application creates it on first start —
but that new file will be **empty**. See *Moving your existing data* below.

## Step 3: Set file permissions for the public/images/ folder to 755

```bash
chmod -R 755 public/images
```

This must be writable, because the admin uploads photographs here.

## Step 4: Restart the Node.js app in cPanel

In **Setup Node.js App**, click **Restart** for this application.

The port is assigned automatically by cPanel through the `PORT` environment variable,
and the application already reads it. **Do not set `PORT` yourself** — cPanel passes it
in, and overriding it will break the site.

---

## Environment variables

Set these in the **Environment Variables** section of cPanel's Node.js App manager.

| Variable | Default | Set it when |
|---|---|---|
| `TURSO_DATABASE_URL` | — | You are using the remote Turso database. Unset means the local file |
| `TURSO_AUTH_TOKEN` | — | Alongside `TURSO_DATABASE_URL`; without it Turso refuses the connection |
| `DB_PATH` | `data/heritage.db` | Local-file mode only: you want the database somewhere else |
| `HOST` | `127.0.0.1` | The app must be reachable from another interface — try `0.0.0.0` |
| `BEHIND_HTTPS` | off | **Set to `1` on a live HTTPS site.** It adds the `Secure` flag to session cookies and enables HSTS |
| `TRUST_PROXY` | off | Only when a reverse proxy you control sets `X-Forwarded-For` |
| `SITE_URL` | — | Not an environment variable; set **Site address** under Admin → Settings |

`PORT` is set by cPanel. Leave it alone.

---

## Moving your existing data

Under the local-file fallback, `data/heritage.db` is the live database — developments,
properties, sales, payments and staff accounts all live in it.

**Back it up before any change to the deployment:**

```bash
cp data/heritage.db data/heritage.backup.db
```

Do **not** rename it to `database.sqlite`. The application looks for `data/heritage.db`;
if that file is missing it silently creates a new, empty database, and the site will
appear to have lost every development, payment and login.

If you are moving to Turso, copy the rows across **before** switching
`TURSO_DATABASE_URL` on, and verify the totals in Admin → Analytics against the old
site. Once Turso is live the local file is ignored, so a mistake there is invisible
from the website until someone notices a missing payment.

---

## After deploying

1. Open the site and confirm the home page loads with styling.
2. Sign in at `/admin` and open **Projects** and **Properties**.
3. Check **Site address** under Admin → Settings is the real domain — it drives the
   canonical links search engines see.
4. If uploads fail, permissions on `public/images` are the first thing to check.
5. If the app will not start, check the log: a configured-but-missing
   `@libsql/client`, or a bad `TURSO_AUTH_TOKEN`, is reported there by name.

## Notes

- The application must sit at the **top level of the domain**, not in a subfolder.
  Image and stylesheet paths begin with `/`, so a subdirectory install will not find them.
- `data/` and `private-docs/` should **not** be reachable over the web. Keep them
  outside `public/`, as they are now.
- There is no build step. `node server/index.js` is the whole story.
- Two development-only tools were added by the migration and are not needed in
  production: `tools/asyncify.js`, `tools/mark-async.js` and `tools/fix-db.js`.
