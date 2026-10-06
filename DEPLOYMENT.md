# Deployment to cPanel

Heritage Housing Projects — Node.js application.

---

## Before you start: Node version

The application uses **`node:sqlite`**, which is built into Node but only exists from
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

This application has **no dependencies** — `package.json` lists none, and there is no
lockfile. `npm install` is therefore harmless but does very little. It is listed here
because cPanel's Node.js App manager often runs it automatically on deployment.

## Step 2: Set file permissions for the database to 755

The database file is **`data/heritage.db`**, not `database.sqlite`.

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

Optional. Set these in the **Environment Variables** section of cPanel's Node.js App
manager.

| Variable | Default | Set it when |
|---|---|---|
| `DB_PATH` | `data/heritage.db` | You want the database somewhere else, e.g. outside the web root |
| `HOST` | `127.0.0.1` | The app must be reachable from another interface — try `0.0.0.0` |
| `BEHIND_HTTPS` | off | **Set to `1` on a live HTTPS site.** It adds the `Secure` flag to session cookies and enables HSTS |
| `TRUST_PROXY` | off | Only when a reverse proxy you control sets `X-Forwarded-For` |
| `SITE_URL` | — | Not an environment variable; set **Site address** under Admin → Settings |

`PORT` is set by cPanel. Leave it alone.

---

## Moving your existing data

`data/heritage.db` is the live database — developments, properties, sales, payments and
staff accounts all live in it.

**Back it up before any change to the deployment:**

```bash
cp data/heritage.db data/heritage.backup.db
```

Do **not** rename it to `database.sqlite`. The application looks for `data/heritage.db`;
if that file is missing it silently creates a new, empty database, and the site will
appear to have lost every development, payment and login.

---

## After deploying

1. Open the site and confirm the home page loads with styling.
2. Sign in at `/admin` and open **Projects** and **Properties**.
3. Check **Site address** under Admin → Settings is the real domain — it drives the
   canonical links search engines see.
4. If uploads fail, permissions on `public/images` are the first thing to check.

## Notes

- The application must sit at the **top level of the domain**, not in a subfolder.
  Image and stylesheet paths begin with `/`, so a subdirectory install will not find them.
- `data/` and `private-docs/` should **not** be reachable over the web. Keep them
  outside `public/`, as they are now.
- There is no build step. `node server/index.js` is the whole story.
