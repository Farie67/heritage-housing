# Heritage Housing Projects — website & client portal

Corporate website and secure client portal for **Heritage Housing Projects (Pvt) Ltd**, Gweru, Zimbabwe.

Rebuilt from the original front-end prototype. The prototype as received is preserved
untouched in `legacy/`, and the review of it is in [`AUDIT.md`](AUDIT.md).

---

## Quick start

Requires **Node.js 22.5 or newer** (developed on Node 24). There is **nothing to install** —
no npm packages, no build step, no lockfile.

```bash
node scripts/seed.js      # create the database and demonstration data
node server/index.js      # start the server
```

Add `--fresh` to the seed to also clear anything the seed does not own — stray
accounts, enquiries, sessions and audit rows — and get back to a known state:

```bash
node scripts/seed.js --fresh
```

Then open <http://localhost:3000>.

Demonstration sign-in: **`HP-10245`** / **`demo123`**

Verify everything works:

```bash
node scripts/check.js
```

That starts its own throwaway server and database, runs **205 checks**, and cleans up after
itself. It never touches your development data.

---

## What's here

```
public/                  static site — the only directory the server will serve from
  index.html  about.html  services.html  projects.html
  properties.html  news.html  contact.html  portal.html
  assets/css/styles.css
  assets/js/site.js
server/
  index.js               HTTP server, routing, static files, API
  db.js                  schema, migrations and queries (node:sqlite)
  auth.js                scrypt password hashing, sessions, sign-in
  security.js            headers, cookies, CSRF, rate limiting
  multipart.js           hand-written multipart/form-data parser
  pdf.js                 hand-written PDF writer (text, rules, pages)
  invoice.js             builds the client statement of account PDF
  references.js          generates payment references
  format.js              shared money/date formatting
  analytics.js           sales analytics engine — all figures come from here
  views-analytics.js     the analytics, period and ledger pages
  exports.js             the eight reports, in three formats
  xlsx.js                hand-written .xlsx writer (zip + XML)
  passwords.js           generated-password helper, shared by CLI and admin
  content.js             editable content: schema and factory defaults
  branding.js            logo resolution (relative vs absolute)
  public-site.js         assembles context for the public pages
  views-public.js        renders the public pages from the database
  views.js               server-rendered client dashboard
  admin.js               staff area: routing and role enforcement
  views-admin.js         staff area: server-rendered pages
scripts/
  seed.js                demonstration data, incl. real generated PDFs
  create-admin.js        create or reset a staff account
  check.js               205-check end-to-end verification
tools/
  build-pages.js         exports public/*.html from the database
  content-coverage.js    proves no client content was lost in the rebuild
legacy/                  the original prototype, exactly as received
data/                    SQLite database (git-ignored)
private-docs/            client documents — deliberately outside the web root
```

### Pages are rendered from the database

The prototype was a single document that toggled `<section class="page">` panels with
`display:none`. Every page is now its own real URL, and the marketing copy lives in SQLite —
see **Editing the site content** below. Page content, including every property listing, is in
the HTML that the server sends, so the site is crawlable and works with JavaScript disabled;
scripting only *enhances* it. The filter bar is hidden until JavaScript reveals it, because
with scripting off it would do nothing, and all properties are simply listed instead.

Project and stand lists come from the `projects` and `stands` tables. Before the CMS they were
written out twice — once in the page generator and once in the seed — so a price change had to
be made in two places and the website and portal could disagree. There is now one source.

The same renderer also writes a static snapshot, for hosting the site with no Node running:

```bash
node scripts/seed.js        # once, to create the database
node tools/build-pages.js   # export public/*.html from the database
```

The live server does **not** read those exported files — it renders from the database on each
request, so an admin edit shows immediately. Export only when you want plain files to upload.
A check verifies the export and the live page are byte-identical, so the committed snapshot
cannot silently go stale.

---

## The client portal

`/portal.html` → sign in → `/dashboard`.

The dashboard shows the client's stand, payment history, outstanding balance, documents and
project-progress timeline. It is **rendered on the server** and requires a valid session; the
data never exists as a public JSON blob, and every value is HTML-escaped on output.

---

## The staff admin

Create a staff account — the password is generated and shown **once**:

```bash
node scripts/create-admin.js                        # staff id ADMIN-001
node scripts/create-admin.js --id ADMIN-002 --name "Office Manager"
node scripts/create-admin.js --id ADMIN-001 --reset # lost the password
node scripts/create-admin.js --id ADMIN-002 --disable
```

Then sign in at **`/admin/login`**. A reset also destroys that account's existing
sessions, so a password change logs the old one out everywhere.

**Built so far**

| Page | What it does |
|---|---|
| `/admin` | Overview: client, enquiry, stand, document and payment counts, plus total received |
| `/admin/enquiries` | The contact-form inbox — read each enquiry, mark it handled, reopen it |
| `/admin/clients` | Searchable client list — by client number, name or email |
| `/admin/clients/new` | Add a client; a password is generated and shown once |
| `/admin/clients/:id` | One client: edit details, reset password, disable/re-enable, unlock, link or unlink a stand, record, confirm, edit and delete payments, upload and delete documents |
| `/admin/projects` | Every project with its progress-step count |
| `/admin/projects/:id` | Edit the progress timeline the client sees in their portal |
| `/admin/content` | Edit the wording on every public page |
| `/admin/settings` | Site-wide values — phone, email, address, tagline — and the logo |

Editing a client replaces nothing silently — a blank name or a malformed email is refused
on the page rather than saved. Recording a payment validates the amount, the date and the
reference, and refuses a reference already in use. Deleting a payment is refused unless the
payment belongs to the client in the URL.

### Payment status

A payment is either **Confirmed** or **Pending**, and only confirmed money reduces what the
client owes. Anything pending is shown separately on the client page, so the office can see
what has been reported but not yet verified without it distorting the balance.

Each row in the payment table has three actions: **Confirm** (or **Mark pending**, to undo),
**Edit**, and **Delete**. Editing covers the amount, date and reference, so a typo can be
corrected without deleting the record and losing its place in the audit log.

### Properties and developments

The **Properties** tab manages the stands the website offers; the **Projects** tab manages the
developments they belong to.

Both write to the same database the public pages are rendered from, so an edit is live the moment
it is saved. There is no publish step and no cached copy to go stale.

A property carries its development, stand number, size, type, price, status and photograph. Only
**Available** ones are offered on the website, and the price can be left blank — the site already
renders that as "on request".

A development carries its name, location, type, status, description and photograph, alongside the
progress timeline clients see in their portal.

Three rules protect the accounts and the public pages:

- **A property with a sale against it cannot be deleted.** Removing it would orphan the client's
  purchase, their payments and every sales figure that points at them. The page explains this and
  suggests marking it Sold instead, or cancelling the sale first.
- **Stand numbers must be unique within a development**, compared case-insensitively, so
  `hp-0245` cannot be created alongside `HP-0245`.
- **Development names must be unique**, because two developments called "Heritage Park" would make
  every sales report ambiguous.

Renaming a development updates the website, the client portal **and** the sales analytics at once,
because the reports read the project's name rather than keeping their own copy of it.

### One development, many properties

The data model is one-to-many, and was already:

```
projects (development)
   └── stands (individual property)      stands.project_id → projects.id
          └── ownerships (a sale)        ownerships.stand_id → stands.id
                 └── payments            payments.ownership_id / stand_id
```

`stands.project_id` is a plain foreign key with no uniqueness on it, so a
development holds as many properties as you like. A **sale is attached to an
individual stand**, not to the development, and every payment carries the same
`stand_id` — so a payment is traceable to the exact property a client bought.

A development's statistics are **counted from its properties on every read**,
never stored. A stored count would drift the moment a stand changed status
through any other path. Both the admin and the public development page show the
same derived breakdown:

```
Heritage Park — 25 Properties | 18 Available | 5 Sold | 2 Reserved
```

**Terminology.** A *development* is the collection; a *property* or *stand* is
one unit inside it. Nothing in the interface should suggest a development is
itself a property.

### Property and development pages

Each individual property has its own page at `/property/<stand-number>` —
addressed by the stand number rather than an internal id, so the link says what
it is. It shows the stand number, development, location, size, type, price,
availability, description and photograph, with an enquiry button. A property
that is not available says so instead of inviting an enquiry.

Each development has a page at `/development/<name-slug>`. The slug is derived
from the name on demand rather than stored, so renaming a development cannot
leave a stale address behind. It shows the location, description, the four
counts, and a grid of that development's **available** properties.

An unknown number or slug returns a proper 404 that still carries the site
chrome and links back to what is available.

A development page carries four things beyond its header and counts:

- **Short description** — one or two sentences, also used on the card in the
  developments list.
- **Full overview** — the longer write-up. Blank lines separate paragraphs, so
  it can run to as many as the subject needs.
- **Main features** — one per line. A line beginning `Location: …` renders the
  part before the colon as a heading and the rest as the detail.
- **Stand sizes and pricing** — a four-column table: size, cash price, credit
  price, minimum deposit. Rows are added, edited and deleted on the development
  page in the admin.

The price amounts are stored as **text, not integer cents**, and that is
deliberate: a minimum deposit legitimately spans a range — `$2,000 – $4,000` —
which a single integer cannot express. This is a published tariff shown to
buyers; the price of an actual stand is still held on the stand itself, in
cents, and is what the sales analytics work from. The two are independent, so
changing a published price row does not silently alter anyone's balance.

### Sold out

A development can be marked **sold out** either from the checkbox on its edit page, or by the
one-click toggle on the Projects list — that toggle exists because it is the one thing the office
needs to change the moment the last stand goes.

Sold out is a **separate flag from the build status**, not another status value. A development can
be finished being built *and* sold out at the same time; collapsing the two into a single dropdown
would lose one of them.

On the website, a sold-out development:

- carries a **Sorry — sold out** stamp across its photograph, in the brand red
- has its photograph desaturated, so the stamp is what the eye lands on
- stops inviting enquiries about its stands, offering "Ask about other developments" instead
- drops its stands from the **available properties** list entirely, and the properties page names
  the sold-out developments in a notice at the top

Nothing is deleted or altered. Clearing the flag brings the development and its stands straight
back.

### Payment references

References are generated, never typed. The format is the project's initials followed by the
date and time the payment was keyed in:

```
HP-20261002-131005      Heritage Park, 2 October 2026 at 13:10:05
```

Initials come from the project name: `Heritage Park` gives `HP`, `Gorge of Toronto` gives
`GOT`. A single-word project like `Emganini` gives `EM` rather than `E`, because one letter is
too weak to search on. A client with no stand yet falls back to the prefix set in
**Site settings** (`HHP` by default).

The time is **local, not UTC** — the reference is read by the office and quoted by clients, so
it has to match the clock on the wall. Two payments keyed in during the same second get a
numeric suffix (`HP-20261002-131006-2`), which means recording a payment can no longer fail
because someone reused a reference.

The form shows the next reference as a preview, it is fixed once saved, and it is read-only
when editing — it is the receipt number a client may already have been given.

### Statements

The **Statement (PDF)** button on a client page produces a real PDF file, not a browser print
dialog, so the office can save it or email it directly. Clients get the same document for
their own account from **Download statement (PDF)** in the portal.

It contains the company details, the client and property block, the purchase price, total
received, the balance outstanding, the full payment history, a separately labelled block for
anything recorded but not yet confirmed, and a statement number of the form
`STM-HP-10245-20261002` that the office can quote on the phone.

There is no dependency available for PDF generation, so it is written by hand in
`server/pdf.js` — the same approach used for the seeded demonstration documents. Two details
there matter more than they look:

- **Text is measured using the real Helvetica metrics**, which is what allows the amount
  column to be right-aligned. Without widths you can only left-align, and an invoice with a
  ragged amount column looks wrong.
- **Byte offsets in the cross-reference table are accumulated as objects are written.** A
  wrong offset produces a file that still starts with `%PDF-` but will not open — so the
  suite follows every offset to the object it claims to point at instead of trusting the
  header, and checks that each declared stream length matches the bytes actually written.

Long histories paginate, and every page carries a footer and a page number.

**How it is secured.** The admin area is a separate sign-in from the client portal, with its
own rate-limit budget so hammering one cannot lock out the other. Access is enforced
server-side on every request by role; a signed-in client is bounced to their own portal, and
a client's credentials are refused at the staff sign-in *before a session cookie is ever
issued*. Resetting a password or disabling an account destroys that user's sessions, so the
old credential stops working immediately rather than at expiry. Every admin view, sign-in and
mutation is written to the audit log. All 57 admin and CMS behaviours are covered by
`scripts/check.js`.

---

## Editing the site content

Everything the office can change lives in `/admin/content` (the wording) and `/admin/settings`
(site-wide values and the logo). Changes appear on the public site immediately — there is no
publish step and no cache to clear.

**What is editable.** Each page has sections; a section is either a set of one-off fields
(the hero, the mission statement) or a repeating list you can add to and delete from (the
"what we do" cards, the values, the news items). Project and stand listings are edited through
the projects and client areas, since they come from the same tables the portal reads.

**Where the definitions live.** `server/content.js` holds both the schema and the factory
defaults. Adding a field there makes it editable; nothing else needs to change unless the
markup for it does too. Two details worth knowing:

- **Defaults sit beside each field**, so a half-populated database still renders a complete
  site rather than blank headings.
- **Once a page has been seeded the database is trusted completely.** That is what makes
  deleting every item in a repeating section stick — the factory rows do not reappear. An
  unseeded page falls back to the defaults so a fresh install is never empty.

**Saving is scoped per section.** Each section is its own form, so saving the hero cannot
overwrite the cards. The server only accepts fields the schema declares for that page and
section, so a crafted form cannot invent content or write to a field that does not exist.

### Contact details

Phone, email, office address, WhatsApp link and the tagline are all editable in
`/admin/settings`. They appear on the contact page, in the footer of every page, and in the
client portal's support area.

The WhatsApp link points at a `wa.me` URL, which opens the app or the web client. It is
rendered with `target="_blank"` and `rel="noopener"` — without the latter the opened page can
reach back through `window.opener`.

Because these are admin-editable values that end up inside an `href`, the link is checked
before it is rendered: anything that is not `http` or `https` is dropped rather than output.
Escaping alone would stop a value breaking out of the attribute, but it would not stop
`href="javascript:..."` firing when clicked.

### Sales analytics

The **Sales** tab gives the office revenue monitoring. Every figure on every page is computed
from the transaction records at request time — no total is stored, so no number can drift away
from the ledger.

**A sale is not cash.** This is the distinction the whole section rests on. A sale is recorded
once (`ownerships`), and money is recorded separately (`payments`). Selling a US$6,500 stand
shows a US$6,500 contract and US$0 collected until a deposit actually arrives.

| | |
|---|---|
| **NEW SALE** | a signed agreement — new contract value, never cash |
| **DEPOSIT** | the first money received on a sale |
| **INSTALLMENT** | a later payment towards a sale |
| **FINAL PAYMENT** | clears the balance; refused if it exceeds what is owed |
| **REFUND** | money returned; always deducted, never revenue |

The existing `payments` and `ownerships` tables were **extended rather than duplicated**, so the
website, portal, statements and CMS read exactly the columns they always did. Payments that
predate the transaction model were backfilled: the earliest payment on each sale is its deposit
and the rest are instalments, which is what they actually were. Payment methods are left unknown
because they genuinely are not recorded anywhere.

**Two date bases.** A sale is dated by its sale date; a transaction by its payment date. A sale
agreed in September and paid in October is a September sale and October cash. Moving the payment
back to the sale date would make both months wrong, so the two are always queried separately —
and there is a check that proves it.

**Balances are derived, never typed.** `outstanding = sale price − (deposits + instalments +
final payments) + refunds`. Status follows automatically: a sale becomes **Completed** at zero
and reopens to **Active** if a refund puts a balance back. A sale paid above its price is
reported as a credit balance rather than netted off receivables.

**Pages:** Overview (eleven KPI cards, collection analysis, transaction-type breakdown, project
and agent performance), Weekly (Monday–Sunday, this/last/custom, daily chart), Monthly (any
month, with the real percentage change against the previous month), Annual (any year, twelve-month
chart and table), Ledger (search, sort, pagination), and a page per sale showing client, property,
payment summary, full history and the financial audit trail.

**Filters** cover date range, project, agent, transaction type, payment method, sale status,
client, stand and reference search. They apply to every card, chart and table, and there is a
Clear filters button.

**Validation.** A payment cannot exist without a sale; a final payment cannot exceed the balance;
a refund cannot exceed what was paid; a transaction needs a date, a positive amount and a
reference; voided transactions leave every total. Overrides exist but must be ticked explicitly.

**Void, don't delete.** Voiding keeps the row so the change stays auditable, and excludes it from
analytics. The existing Delete button still works but now writes the figures to the audit trail
first. Note that a staff account which has recorded money cannot be hard-deleted — the foreign key
prevents it, which is correct for a financial record; use `create-admin.js --disable` instead.

Charts are CSS bars, not a charting library: there is no dependency available, and bars built from
divs reflow on a phone and print correctly without extra work.

### Exports

Every report downloads as **CSV**, **Excel (.xlsx)** and **PDF**, and each one carries the
filters that were applied — so the file matches the screen it came from, and the filter used is
printed on the report itself.

| Report | What it contains |
|---|---|
| Weekly | one row per day of the week, plus the week's totals |
| Monthly | the month against the previous month, plus every day that had activity |
| Annual | all twelve months, plus the year's totals |
| Ledger | every transaction, with a totals line |
| Project | sales, collections and balances per development |
| Agent | the same, per salesperson |
| Outstanding | every sale still owing money — the list the office works from |
| Payment history | every transaction grouped under the sale it belongs to |

There is no zip or spreadsheet library available, so `server/xlsx.js` writes the `.xlsx`
container by hand: stored ZIP entries with CRC-32, and the XML parts Excel expects. Strings are
written inline rather than through a shared-strings table, which saves a whole part for reports
of this size.

The columns for each report are declared **once** and rendered three ways. That matters more than
it sounds: three separate renderers would drift, and a report where the PDF disagrees with the
spreadsheet is worse than having no export at all.

CSV files carry a BOM, because Excel otherwise mis-reads accented names, and money is written as
a bare number so the spreadsheet treats it as numeric — the currency is named in the column
header instead. PDF tables repeat their header on every page and number the pages, since a
multi-page table without a repeated header is unusable in print.

### Images

Every image is a local file. There are no external image URLs and no Base64
strings anywhere in the site — **including in the database**, which is where the
photographs actually live.

Note that almost all of them are CSS `background-image` on a div, not `<img>`.
The only `<img>` elements on the public site are the two logos in the header and
footer, which were already local. Searching for `<img>` tags alone would find
nothing to change.

| Where | Stored as |
|---|---|
| Development photographs | `projects.image_url` → `/images/<name>.jpg` |
| Property photographs | `stands.image_url` → `/images/stand-<number>.jpg` |
| Home banner, feature block | hard-coded in `assets/css/styles.css` |
| Logos and favicon | `assets/img/` — already local, referenced by the stylesheet |

A photograph path is **derived from the entity's own name** rather than held in
a lookup table, so the migration is idempotent and a re-seed cannot reintroduce
a remote URL. A property with no photograph of its own falls back to its
development's, so a missing stand photo never leaves a blank card.

`public/images/README.txt` lists the exact files to upload to cPanel and what
each one is for. The files currently there are on-brand placeholders labelled
"Photograph to follow" — deliberately not stock photography of foreign houses,
which would be a misleading advert for a Gweru development.

Also: a missing image does not break the layout. Each sits on a coloured
background, so an absent file shows the brand navy rather than a broken icon.

**Replacing a photograph is safe.** Every image address carries the file's
modification time — `/images/hero-home.jpg?v=1791017510848` — so the address
changes whenever the file does and a browser cannot keep showing a stale copy.
Without it, a browser told `max-age=3600` would ignore a replaced file for an
hour and the update would look like it had silently failed. The stylesheet link
is versioned for the same reason. The home banner is set from the rendered page
via a `--hero-image` custom property rather than being fixed in the stylesheet,
so it can be versioned too.

### The logo and colours

The supplied logo is a **wide wordmark**, not a square mark, so three files were produced from
it and they live in `public/assets/img/`:

| File | Used for |
|---|---|
| `logo.png` | The wordmark on light backgrounds — header, portal and admin sign-in |
| `logo-light.png` | The same artwork with the navy repainted white, for the dark footer where navy-on-navy would be invisible |
| `logo-mark.png` | The house mark alone, square, as the browser tab icon |

All three were generated from the supplied JPEG: trimmed of its white margin, with the white
background turned into real transparency and a soft edge so the anti-aliased source does not
produce a jagged outline. `server/branding.js` resolves them, and the header shows the
wordmark alone — the artwork already spells the name, so the adjacent text was removed and the
site name now lives in the image's `alt` text. A check enforces that alt text, because an
empty one would leave the home link with no accessible name.

**Colours were sampled from the logo, not guessed:** brand blue `#283090` and brand red
`#e81820`. The red used for small text on white is darkened to `#c81218` so it passes contrast,
while the true logo red is used for solid fills. Green is kept for meaning only — available,
confirmed, completed — never as a brand colour.

Replace the logo at `/admin/settings`. SVG, PNG, JPEG and WebP are accepted, up to
`MAX_UPLOAD_BYTES`. It replaces the wordmark across the site, the portal and the admin, and
becomes the browser tab icon. **Revert to the default logo** restores the bundled one and
deletes the upload.

As with client documents, the declared content type is only a hint — the bytes have to agree.
An SVG is a document rather than a picture, so one carrying `<script>`, an event handler or
embedded content is refused outright and explained on the page; supply a flattened SVG or a
PNG instead. Only one custom logo ever exists, since uploading replaces the previous file.

### Uploaded documents

Uploads go through a hand-written `multipart/form-data` parser (`server/multipart.js`) — there
is no dependency available for one. Three things about how it is wired:

- **The declared content type is not trusted.** A file must actually begin with `%PDF-`, so an
  HTML file renamed to `.pdf` is refused before it reaches the disk. This check has its own test.
- **The client's filename never reaches the filesystem.** Files are stored under a random
  32-hex-character name, so a crafted filename cannot escape the directory or collide.
- **Bytes are never decoded to a string.** The body is handled as a Buffer end to end; a
  round-trip through UTF-8 would corrupt the file. The suite verifies the downloaded bytes
  match what was uploaded.

Uploads get their own size ceiling (`MAX_UPLOAD_BYTES`) rather than sharing the small limit
that ordinary form posts use, so a JSON endpoint cannot be fed megabytes.

---

## Security model

This is the part worth reading. The prototype compared a password in client-side JavaScript
and shipped the client's account details inside the page source. That is gone.

**Passwords.** Hashed with `scrypt` (N=32768, r=8, p=1) and a per-password 16-byte random
salt, using `node:crypto`. Parameters are stored with each hash so the cost can be raised
later without invalidating existing accounts. Verification is constant-time.

**Sessions.** The cookie holds a 256-bit random token. Only its SHA-256 digest is stored in
the database, so a stolen database file cannot be turned into a live session. Cookies are
`HttpOnly` (unreadable from JavaScript, so an XSS bug cannot exfiltrate them),
`SameSite=Strict`, and `Secure` when `BEHIND_HTTPS=1`. Sessions expire after 8 hours and are
purged on a timer.

**Authorisation.** Every client-data route is scoped by the session's own user id — ownership
is part of the SQL `WHERE` clause, not a check performed afterwards. Requesting another
client's document returns `404`, indistinguishable from a document that does not exist. This
is covered by an explicit two-client test.

**Documents.** Stored in `private-docs/`, which is outside `public/` and therefore has no URL
of its own. They are streamed only through `/api/documents/:id/download` after an ownership
check, with `Content-Disposition: attachment` and `nosniff`.

**CSRF.** Every state-changing request must prove its origin, by either a double-submit token
(`X-CSRF-Token` must equal the `csrf` cookie — an attacker's page can send the cookie but
cannot read it) or a matching `Origin`/`Referer`. The second path exists so a real HTML form
POST still works with JavaScript disabled.

**Brute force.** Two independent controls: a per-IP sliding window (8 attempts / 15 min), and
a per-account lockout (8 failures → 15 minute lock). A successful sign-in clears both. An
unknown client number is compared against a dummy hash so response timing does not reveal
whether an account exists, and every failure returns one identical message.

**Headers.** `Content-Security-Policy` with no `unsafe-inline` in `script-src`,
`X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`,
and HSTS when behind HTTPS.

**Audit log.** Sign-ins, lockouts, rate-limit trips, CSRF rejections, dashboard views,
document downloads (granted *and* denied) and enquiries are recorded in an `audit_log` table.

**Static serving.** Path traversal is checked against the *resolved* path after decoding, so
`%2e%2e%2f` is caught too. Dotfiles are refused. The server will only ever serve files under
`public/` — `server/`, `data/` and `private-docs/` are not reachable by any URL, by
construction rather than by a deny-list.

### A deliberate trade-off

`portal.html` prints the demonstration credentials on the page. That is intentional for a
demo, and it is the one place where a credential is visible to a visitor. **Remove that line
before going live** and change the seeded password.

---

## Configuration

All optional; sensible defaults for local development.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Listen port |
| `HOST` | `127.0.0.1` | Bind address — set `0.0.0.0` in a container |
| `DB_PATH` | `data/heritage.db` | SQLite file location |
| `BEHIND_HTTPS` | `0` | Set `1` behind TLS: adds `Secure` cookies and HSTS |
| `TRUST_PROXY` | `0` | Set `1` **only** behind a proxy you control, to use `X-Forwarded-For` |
| `SESSION_TTL_HOURS` | `8` | Session lifetime |
| `LOGIN_MAX_ATTEMPTS` | `8` | Per-IP attempts per window, and per-account failures before lockout |
| `LOGIN_WINDOW_MINUTES` | `15` | Rate-limit window |
| `ACCOUNT_LOCK_MINUTES` | `15` | Lockout duration |
| `ENQUIRY_MAX_PER_HOUR` | `5` | Enquiry submissions per IP per hour |
| `MAX_BODY_BYTES` | `65536` | Request body cap for ordinary form posts |
| `MAX_UPLOAD_BYTES` | `8388608` | Cap for a multipart upload (8 MB) |
| `PRIVATE_DOCS_DIR` | `private-docs` | Where uploaded client documents are stored |
| `PUBLIC_DIR` | `public` | Served directory; also where an uploaded logo is written |

> `TRUST_PROXY=1` on a directly exposed server lets any client spoof its address and walk
> straight through the rate limiter. Leave it off unless something you control sets the header.

---

## Before you deploy

The application is hardened, but a deployment is more than an application. Still to do:

1. **TLS.** Terminate HTTPS (nginx, Caddy, or a load balancer) and set `BEHIND_HTTPS=1`.
   Without this the session cookie travels in the clear.
2. **Host header through the proxy.** The CSRF origin check compares against the `Host`
   header, so make sure your proxy passes the public hostname through unchanged.
3. **Change the demo password** and delete the credential hint from `portal.html`.
4. **Email delivery.** Enquiries are written to the `enquiries` table only — nothing is
   emailed yet. Add an SMTP integration and a notification to the office.
5. **Payments.** "Make a payment" is deliberately *not* implemented. Wire up a verified
   gateway (EcoCash, PayNow, Stripe) server-side; never trust a client-reported amount.
6. **Backups.** Back up `data/` and `private-docs/` together and test a restore. SQLite in WAL
   mode needs `.backup` or a filesystem snapshot, not a naive file copy.
7. **Rate limiting is per-process.** It is held in memory, which is correct for this
   single-process deployment. If you ever run multiple workers or machines, move the counters
   into the database or Redis, or the effective limit multiplies.
8. **Replace the placeholder photography.** See the note below.

### Placeholder photography — a real content risk

Every property image, and the hero image, is a stock photograph hot-linked from Unsplash.
Several show architecture that is plainly not Zimbabwean. Presenting them as named
developments — including "Heritage Park" and the real Gweru suburb name "Mkoba 21" — is
misleading to a buyer and is a licensing and advertising-standards exposure, not just a
cosmetic issue. Replace them with photographs of the actual sites before this goes public,
and host them locally so the site does not depend on a third party.

The stylesheet keeps a dark gradient underneath every background image, so if Unsplash is
blocked or removed the page still reads as intentional rather than broken.

---

## Accessibility

Skip link on every page; one `<h1>` per page; a visible `:focus-visible` ring on everything
interactive; `aria-current="page"` in the navigation; `aria-expanded` on the menu button;
`aria-invalid` plus a `role="status"` message on failed form fields; `role="img"` and
`aria-label` on the CSS background images that convey meaning; `prefers-reduced-motion`
honoured throughout; and no text below 12px (the prototype shipped 8px and 9px text). The
site is fully navigable and readable with JavaScript disabled.

---

## Notes on the data

The prototype listed stand `HP-0245` at **US$5,500** on the public properties page while the
portal showed the same stand at **US$6,500**. That inconsistency has been resolved in favour
of the public listing — purchase price US$5,500, with US$3,000 paid and US$2,500 outstanding.
Money is stored as integer cents everywhere; floating-point currency is a rounding bug waiting
to happen.
