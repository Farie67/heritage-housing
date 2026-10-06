# Security & Quality Audit — Heritage Housing Projects (Pvt) Ltd Website Prototype

**Artifact audited:** `heritage-housing-prototype/` — `index.html` (126 lines), `styles.css` (single minified line, 11,843 bytes), `app.js` (31 lines), `README.md` (24 lines)
**Audit type:** static, re-runnable review of a client-supplied front-end prototype (no live deployment, no server-side code in scope)
**Method:** automated checks in `.audit/audit.py` (output: `.audit/findings.json`, 16 findings) plus manual verification of every cited line in the source.
**Findings:** 1 Critical, 5 High, 6 Medium, 4 Low — 16 total.

> **Where these files are now.** The four audited files have since been moved to
> `legacy/` (`legacy/index.html`, `legacy/styles.css`, `legacy/app.js`,
> `legacy/README.md`) so the originals stay verifiable alongside the rebuild.
> Every path and line number below is relative to `legacy/` — read `app.js` L27
> as `legacy/app.js` L27. Nothing in those four files was altered; they are
> byte-for-byte as audited.
>
> **Remediation status.** A rebuilt front-end and a server-side portal now live
> in `public/` and `server/`. Each finding below has been addressed, and
> `scripts/check.js` carries a check per finding (prefixed with its ID, e.g.
> `H-1`, `M-5`) that fails if the defect is reintroduced. Run `npm run check`
> to verify. This report is unchanged apart from this note — it remains the
> record of the prototype as received, not of the rebuild.

---

## 1. Summary

### 1.1 Counts by severity

| Severity | Count | Theme |
|---|---|---|
| Critical | 1 | Portal authentication is a client-side string comparison, with the credentials published in the page and the repository. |
| High | 5 | Stored-XSS sinks, complete dependence on JavaScript, no visible keyboard focus, a modal with no keyboard exit, and five non-focusable links. |
| Medium | 6 | Focus styling gaps, no reduced-motion support, 15 third-party URLs, imagery that is invisible to assistive technology, 8–11px text, and stock photography presented as named developments. |
| Low | 4 | Hard-coded copyright year, a toast timer bug, two unused CSS custom properties, and seven `<h1>` elements in one document. |

### 1.2 Finding index

| ID | Severity | Area | Finding (one line) | Location |
|---|---|---|---|---|
| C-1 | Critical | Security | Portal login accepts a hard-coded client number/password pair, and both are printed on the login screen and in `README.md`. | `app.js` L27; `index.html` L117 |
| H-1 | High | Security | Three `innerHTML` sinks interpolate data objects unescaped — stored XSS the moment they are fed by a CMS or API. | `app.js` L20, L22, L29 |
| H-2 | High | Robustness | Every page except `#home` is `display:none` with no `<noscript>` fallback; without JavaScript the site is a single static hero with dead navigation. | `styles.css` rule `.page`; `index.html` L36 |
| H-3 | High | A11y | No `:focus-visible` rule anywhere, and the only `:focus` rules drop the outline — keyboard users cannot see where they are. | `styles.css` (no such rule; 3 `:focus` rules) |
| H-4 | High | A11y | The portal modal cannot be closed with Escape and traps neither focus nor background interaction. | `index.html` L109–L121; `app.js` L25–L26 |
| H-5 | High | A11y | Five footer `<a>` elements have no `href`, so they are not focusable and not keyboard-operable. | `index.html` L123 |
| M-1 | Medium | A11y | `outline:none` on four form controls; the enquiry `<select>` is covered by the reset but omitted from the focus rule, so it has no focus indicator at all. | `styles.css` rules `.contact-form input,…` and `…:focus` |
| M-2 | Medium | A11y | No `prefers-reduced-motion` support while smooth scrolling and transitions are always on. | `styles.css` `html{scroll-behavior:smooth}`; `app.js` L17 |
| M-3 | Medium | Robustness | 15 external URLs across 3 hosts (Unsplash ×12, Google Fonts ×3) — the page degrades and leaks visitor IPs if they are blocked. | `index.html` L8–L10; `app.js` L2–L13; `styles.css` `.hero`, `.heritage-image` |
| M-4 | Medium | A11y | Four content images are CSS backgrounds; screen readers never learn they exist because there is no `<img>` and no `alt` text. | `styles.css` `.hero`, `.heritage-image`, `.project-thumb`, `.property-img`; `app.js` L20, L22 |
| M-5 | Medium | A11y/UX | Font sizes of 8px, 9px, 10px and 11px are used, including in the payment/statement area. | `styles.css` (11 rules) |
| M-6 | Medium | Content risk | Foreign stock photographs are presented as named Heritage developments, including a real Gweru suburb name. | `index.html` L73–L74; `app.js` L2–L7, L10–L13 |
| L-1 | Low | Maintenance | The copyright year is hard-coded and will silently go stale. | `index.html` L123 |
| L-2 | Low | Correctness | `toast()` never clears its previous timer, so a second message is cut short by the first message's timeout. | `app.js` L19 |
| L-3 | Low | Cleanliness | Two CSS custom properties are defined but never used. | `styles.css` `:root` (`--navy2`, `--white`) |
| L-4 | Low | SEO/A11y | Seven `<h1>` elements coexist in one document. | `index.html` L41, L87, L93, L96, L99, L102, L105 |

### 1.3 How to read the locations

- `index.html` has conventional line numbers; all references are exact.
- `app.js` has 31 lines, but each function occupies exactly one very long line. Line numbers are exact, and function names are given so a reviewer can find the code in any reformatted copy.
- `styles.css` is a single minified line. There is no meaningful line granularity, so CSS findings are cited by selector/rule name instead. Character offsets are available from the audit script if needed.

---

## 2. Critical

### C-1 — Client portal authentication is a hard-coded credential pair, published to the user

**Location:** `app.js` L27 (function `login`), plus `index.html` L117 and `app.js` L15

**Evidence**

```js
// app.js L27 — the entire authentication decision
function login(e){e.preventDefault();const n=document.getElementById('clientNumber').value.trim(),p=document.getElementById('clientPassword').value;if(n==='HP-10245'&&p==='demo123')showDashboard();else toast('Demo login: HP-10245 / demo123')}
```

```html
<!-- index.html L117 — the credentials are also printed on the login form itself -->
<p class="demo-note">Demo access: <b>HP-10245</b> / <b>demo123</b></p>
```

```js
// app.js L15 — the "protected" record lives in the same publicly served file
const client={name:'Demo Client',number:'HP-10245',project:'Heritage Park',stand:'HP-0245',size:'200m²',purchase:6500,paid:3000,type:'Residential',status:'Servicing in progress'};
```

**Impact**

The login screen above the form says "Access your stand, payment and project information" and the submit button says "Sign in securely", but the check that guards that data is a string comparison executing in the visitor's own browser, against a credential pair shipped in the same file as the data it protects. Anyone who opens View Source, or downloads `app.js`, obtains both the client number and the password, and — because `app.js` is served unauthenticated — also obtains the client record itself: stand `HP-0245`, purchase price US$6,500, US$3,000 paid, US$3,500 outstanding, and the three confirmed payment references (`HP001245`, `HP001389`, `HP001502`) with their dates and amounts. For a Zimbabwean property developer, the practical consequences are concrete: a competitor or a journalist can retrieve a client's payment position without any authentication; a buyer who was told the portal is secure can reasonably claim the balance figures were exposed; and the same pattern copied into production would make every client's statement readable by URL-fetching `app.js`, regardless of how strong the "password" is. The mistake is not only the value `demo123` — it is the placement of the trust boundary, because a check that runs on the client can be bypassed or simply read, and the credentials distributed in `README.md` L18–L19 will already be circulating to contractors, hosting providers and anyone the repository has been shared with. A secondary, quieter problem is that the failure branch prints the valid credentials back in a toast, which is the opposite of the generic "invalid credentials" guidance that prevents account enumeration.

**Recommended fix**

Move the authentication decision to a server endpoint and stop shipping any credential or client record in front-end assets.

```js
// app.js — the browser never learns the credential, and never receives another client's record
async function login(e){
  e.preventDefault();
  const clientNumber = document.getElementById('clientNumber').value.trim();
  const password     = document.getElementById('clientPassword').value;

  const res = await fetch('/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',                 // session cookie is HttpOnly + Secure + SameSite=Lax
    body: JSON.stringify({ clientNumber, password })
  });

  if (!res.ok) { toast('Client number or password is incorrect.'); return; }
  showDashboard(await res.json());              // server returns only the authenticated client's data
}
```

Additional required changes:

1. Delete `index.html` L117 and the credential lines in `README.md`; the demo account should be distributed out-of-band, and the in-page hint removed before any client-facing demonstration.
2. Hash passwords server-side (bcrypt/Argon2id) and enforce throttling, lockout and audit logging on `/api/session`.
3. Remove `client` (and the payment-history rows) from `app.js`; serve those values per-request from an authenticated endpoint that authorises the session against the requested client number.
4. Replace the echoed-credentials toast with a generic failure message.
5. Never re-use `HP-10245 / demo123` for a real client record; rotate it even in demo environments that are publicly reachable.

---

## 3. High

### H-1 — Three `innerHTML` sinks interpolate unescaped data (stored XSS waiting to be wired up)

**Location:** `app.js` L20 (`renderProjects`), L22 (`renderProperties`), L29 (`showDashboard`)

**Evidence**

```js
// app.js L20 — every field is interpolated straight into HTML
document.getElementById('projectGrid').innerHTML=projects.map(p=>`<article class="project-card"><div class="project-thumb" style="background-image:url('${p.image}')"></div><div class="project-card-body"><span class="status">● ${p.status.toUpperCase()}</span><h3>${p.name}</h3><p>${p.location}</p><p>${p.desc}</p>…
```

```js
// app.js L22 — the same pattern, and a data value is additionally placed inside an inline event handler
…onclick="enquire('${p.project}','${p.stand}')">Enquire about this stand</button>…
```

```js
// app.js L29 — portal dashboard: client-controlled fields rendered as raw HTML
d.innerHTML=`…<h2>Welcome, ${client.name}</h2><p class="muted">Client ${client.number}</p>…<h3>${client.stand}</h3><p>${client.project}<br>${client.size} • ${client.type}</p>…`
```

**Impact**

`innerHTML` parses its argument as HTML, so any value that arrives from a database, CMS field or support-desk form is executed as markup rather than displayed as text. Today the arrays in `app.js` L1–L14 are literals, so nothing is exploitable yet; the finding is that the rendering layer is already shaped for stored XSS on the day it is connected to the real CMS/API that the prototype's own copy promises ("Project detail page can be connected to the CMS here"). The highest-value target is `showDashboard`: it is the view that renders a client's name, stand and payment position, and it sits directly above a "Make a payment" button (L29, `onclick="toast('Payment gateway would open here in production.')"`) that will become a payment-gateway redirect. An attacker who can influence any single field that reaches that template — a client name captured by an estate agent, a stand description edited by a staff account, a project title exported from a spreadsheet — can run script inside an authenticated client's session, read the balance and statement, and re-point or pre-fill the payment flow so that money owed to Heritage is paid to a third party. Property records also make this unusually damaging: a payload can rewrite the displayed purchase price and instalment amounts in the DOM, then be photographed as "proof" in a dispute. The inline-handler interpolation at L22 is a second, independent defect: a value containing a single quote or a `</script>` sequence breaks out of both the JavaScript string and the HTML attribute, so a project name such as `Heritage' s Park` corrupts the page even without an attacker. The same pattern in `renderProjects` (L20) means a poisoned project name is shown to every visitor, not just one logged-in client, and projects name real developments — so the injected text inherits the site's authority.

**Recommended fix**

Escape on output, and stop generating inline event handlers from data.

```js
// app.js — one escaping helper, applied to every interpolation, and no inline onclick built from data
const esc = s => String(s).replace(/[&<>"']/g,
  c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// in renderProperties / renderProjects: escape every field
`<h3>${esc(p.project)}</h3><p>Stand ${esc(p.stand)}</p>`

// in the property card, replace the inline handler with data attributes…
`<button class="btn primary" data-project="${esc(p.project)}" data-stand="${esc(p.stand)}">Enquire about this stand</button>`

// …and handle it once, with a delegated listener (DOMContentLoaded, app.js L31)
document.getElementById('propertyGrid').addEventListener('click', e => {
  const b = e.target.closest('button[data-project]');
  if (b) enquire(b.dataset.project, b.dataset.stand);   // dataset returns text, not markup
});
```

Also: build the CSS image URL with `style.backgroundImage = \`url("${encodeURI(p.image)}")\`` rather than embedding a data value inside a style attribute in an HTML string, and prefer `textContent` (as `toast()` already does at L19) wherever a value is pure text. A Content-Security-Policy without `unsafe-inline` should be added once the inline `onclick` attributes are gone.

### H-2 — All content pages are hidden without JavaScript, and there is no `<noscript>` fallback

**Location:** `styles.css` (rules `.page` and `.page.active`); `index.html` L36 (the only page marked `active`) and no `<noscript>` element anywhere

**Evidence**

```css
/* styles.css — single minified line, verbatim rules */
.page{display:none}
.page.active{display:block}
```

```html
<!-- index.html L36 — only the home page starts visible -->
<section id="home" class="page active">
```

Verified: `noscript` does not occur in `index.html`; every other page (`#about`, `#services`, `#projects`, `#properties`, `#news`, `#contact`) carries `class="page"` only; and the navigation is driven exclusively by inline `onclick` handlers such as `onclick="showPage('about')"` (`index.html` L23–L29), which `app.js` L17 implements by toggling the `active` class.

**Impact**

If `app.js` fails to load or execute — JavaScript disabled, a corporate/ISP filter, an aggressive mobile "data saver" browser, a CSP rule, or simply a truncated download on a slow Zimbabwean mobile connection — the visitor gets the header, the hero and the footer, and nothing else. Six of the seven content sections stay hidden forever, because the only mechanism that reveals them is JavaScript. The header links still carry `href="#about"` etc., so the URL hash changes on click and the browser appears to respond while the page content never changes; to a visitor this reads as a broken site rather than a disabled feature. On viewports under 900px the situation is worse: the CSS at `@media(max-width:900px)` sets `.site-header nav{display:none}` and relies on `.site-header nav.open` being added by `toggleMenu()` (L18), so without JavaScript there is *no navigation at all* on a phone, not even inert links. The commercially significant loss is the whole purchase funnel: `#properties` (with its filter controls) and `#contact` (with the enquiry form) are unreachable, so a prospective stand buyer cannot see availability and cannot submit an enquiry, and the phone number and email only survive because they sit in the footer. The hero promises "Available Properties" with a button that does nothing, which is a poor first impression for a company whose proposition is "clear communication".

**Recommended fix**

Provide a CSS-only path to each page plus an explicit no-JavaScript notice, then let JavaScript take over.

```html
<!-- index.html — immediately after <body>, before the header -->
<noscript>
  <div class="container" style="padding:20px;background:#f7f4ed;border:1px solid #e5e7eb;border-radius:10px;margin:16px auto">
    <p><strong>JavaScript is disabled in this browser.</strong> The Projects, Properties,
    News and Client Portal sections need JavaScript. Please call <b>+263 542 22697</b> or
    email <b>heritagehousingp@gmail.com</b> for stand availability and enquiries.</p>
  </div>
</noscript>
```

```css
/* styles.css — make every page reachable by URL fragment when JS is absent */
.page{display:none}
.page.active,.page:target{display:block}
html.js .page:target:not(.active){display:none}   /* once JS runs, keep SPA behaviour authoritative */
```

```js
// app.js L31 — flag that JS is available, and open the page named in the URL
document.documentElement.classList.add('js');
```

### H-3 — No `:focus-visible` rule, and the only focus styles suppress the outline

**Location:** `styles.css` — verified absent: the string `:focus-visible` occurs 0 times; there are exactly 3 `:focus` selectors

**Evidence**

```css
/* styles.css — the complete set of focus styling in the stylesheet */
.contact-form input:focus,.contact-form textarea:focus,.login-form input:focus{border-color:var(--navy)}
```

There is no `:focus` or `:focus-visible` rule for the navigation links, the `.portal-btn` / `.btn` buttons, the `.text-btn` buttons, the `.filters select` controls, the modal close button, the footer links or the property-card "Enquire" buttons. Combined with `M-1`, the focus indicator for text inputs is a border colour change only.

**Impact**

Keyboard-only and switch-access users navigate by watching the focus indicator; with none defined, the browser default is the sole remaining cue, and it is suppressed wherever `outline:none` applies. On this site the consequence is domain-specific: the button that opens the client portal, the "Sign in securely" submit button, the three filter dropdowns on the Properties page, and the per-stand "Enquire about this stand" buttons all give no visible confirmation of focus. A keyboard user can therefore press Enter on an unknown target — including on the login form, where they are entering a client number and password for an account that displays payment balances — and a mistyped submission is indistinguishable from a deliberate one. The `.filters select` case is the most concrete: it retains the browser default ring only because it is not covered by the `outline:none` reset, so focus indication on the Properties page is inconsistent between controls by accident rather than design.

**Recommended fix**

Add one global rule that preserves the default ring and one brand-styled override, and remove `outline:none` (see M-1).

```css
:focus-visible{outline:3px solid var(--gold);outline-offset:2px;border-radius:4px}
.site-header nav a:focus-visible,.footer-grid a:focus-visible{outline:3px solid var(--gold);outline-offset:3px}
.modal-panel :focus-visible{outline:3px solid var(--navy);outline-offset:2px}
```

### H-4 — The portal modal cannot be closed with Escape and does not manage focus

**Location:** `index.html` L109–L121; `app.js` L25 (`openPortal`) and L26 (`closePortal`)

**Evidence**

```html
<!-- index.html L109–L121 -->
<div id="portalModal" class="modal hidden" role="dialog" aria-modal="true" aria-labelledby="portalTitle">
  <div class="modal-backdrop" onclick="closePortal()"></div>
  <div class="modal-panel">
    <button class="modal-close" onclick="closePortal()">×</button>
```

```js
// app.js L25–L26 — open and close, with no keyboard handling
function openPortal(){document.getElementById('portalModal').classList.remove('hidden');document.getElementById('loginView').classList.remove('hidden');document.getElementById('dashboardView').classList.add('hidden');setTimeout(()=>document.getElementById('clientNumber').focus(),100)}
function closePortal(){document.getElementById('portalModal').classList.add('hidden')}
```

Verified: `Escape` occurs 0 times in `app.js`, and there are no `keydown`/`keyup`/`keypress` listeners.

**Impact**

The dialog declares `aria-modal="true"`, which tells assistive technology that the rest of the page is inert — but nothing enforces that promise. `Tab` from the sign-in button walks out of the panel and into the page behind the backdrop, where the user is now operating invisible controls with no way back to the form they were filling in. There is no Escape handler, so the keyboard-only exit is missing entirely and the only way out is to find the `×` button by tabbing or to click the backdrop with a pointer. The close button itself has no accessible name beyond the character `×`, which screen readers commonly announce as "multiplication sign" or skip, so a screen-reader user may not identify it as the close control. This matters most in exactly the flow the modal exists for: a client entering a client number and password to view their stand and payment records. If they abandon the login, the modal remains open and they cannot use the site without a pointer; and because `showDashboard()` writes the account balance and payment history into `#dashboardView` inside the same panel, the sensitive view stays on screen after any interaction with content behind the backdrop, which is a shoulder-surfing and screen-sharing exposure on a shared or office machine.

**Recommended fix**

Add Escape handling, an accessible name for the close button, a focus trap while open, and focus restoration on close.

```js
// app.js — replace openPortal/closePortal
let lastFocused = null;
function openPortal(){
  lastFocused = document.activeElement;
  document.getElementById('portalModal').classList.remove('hidden');
  document.getElementById('loginView').classList.remove('hidden');
  document.getElementById('dashboardView').classList.add('hidden');
  setTimeout(() => document.getElementById('clientNumber').focus(), 100);
}
function closePortal(){
  document.getElementById('portalModal').classList.add('hidden');
  document.getElementById('clientPassword').value = '';   // never leave a password in the DOM
  if (lastFocused) lastFocused.focus();
}
document.addEventListener('keydown', e => {
  const modal = document.getElementById('portalModal');
  if (modal.classList.contains('hidden')) return;
  if (e.key === 'Escape') { closePortal(); return; }
  if (e.key !== 'Tab') return;
  const f = modal.querySelectorAll('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])');
  if (!f.length) return;
  const first = f[0], last = f[f.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});
```

Also give the close button `aria-label="Close client portal"` in `index.html` L112. Note that `closePortal` as written also leaves the typed password in the input, which the shown version clears.

### H-5 — Five footer links have no `href` and cannot be reached by keyboard

**Location:** `index.html` L123 (footer "Explore" and "Clients" columns)

**Evidence**

```html
<!-- index.html L123 — the anchors have no href attribute -->
<div><h4>Explore</h4><a onclick="showPage('projects')">Projects</a><a onclick="showPage('properties')">Properties</a><a onclick="showPage('services')">Services</a></div><div><h4>Clients</h4><a onclick="openPortal()">Client Login</a><a onclick="openPortal()">My Heritage</a></div>
```

The audit identifies exactly these five: Projects, Properties, Services, Client Login, My Heritage. Note the contrast with the header navigation (`index.html` L23–L29), where the same destinations *do* carry `href="#home"` etc.

**Impact**

An `<a>` without `href` is not a link: it is not in the tab order, it has no implicit ARIA role, and it cannot be activated with Enter or Space. The five most commercially important destinations in the footer — the properties list, the projects list, and both routes into the client portal — are therefore pointer-only. A keyboard user scrolling to the footer finds nothing focusable, and a screen-reader user hears the surrounding headings ("Explore", "Clients") followed by no navigable items, which makes the footer look empty. This is also the failure point for anyone who reaches the site on a phone with a keyboard case, or on a desktop where the header nav has collapsed under 900px and the mobile menu button is inoperative (see H-2): the footer is the only remaining navigation, and it does not work from the keyboard. Because the footer is the one navigation region that is visible in every state, including the no-JavaScript state, its inaccessibility removes the last reliable route to the Properties page for an assistive-technology user.

**Recommended fix**

Give each anchor a real destination, and keep it a genuine link.

```html
<a href="#projects" onclick="showPage('projects');return false">Projects</a>
<a href="#properties" onclick="showPage('properties');return false">Properties</a>
<a href="#services" onclick="showPage('services');return false">Services</a>
<a href="#portal" onclick="openPortal();return false">Client Login</a>
<a href="#portal" onclick="openPortal();return false">My Heritage</a>
```

`return false` prevents a redundant hash jump once the handler runs; if H-2's `:target` fallback is adopted, the same markup makes these links functional with JavaScript disabled. Repeating the Client Login destination twice also produces two identical accessible names in the same region — consider one link labelled "Client Login / My Heritage", or keep both but distinguish them.

---

## 4. Medium

### M-1 — `outline:none` on form controls; the enquiry `<select>` is left with no focus indicator

**Location:** `styles.css` — rule `.contact-form input,.contact-form textarea,.contact-form select,.login-form input{…}` and rule `.contact-form input:focus,.contact-form textarea:focus,.login-form input:focus{…}`

**Evidence**

```css
/* styles.css — one reset covering four selectors */
.contact-form input,.contact-form textarea,.contact-form select,.login-form input{display:block;width:100%;padding:13px 14px;margin-top:7px;border:1px solid var(--line);border-radius:9px;font:14px 'DM Sans';outline:none}

/* …but only three of them get a focus style back */
.contact-form input:focus,.contact-form textarea:focus,.login-form input:focus{border-color:var(--navy)}
```

`select` appears in the reset and not in the focus rule, so `<select name="interest">` (`index.html` L105) has its outline removed and nothing put back. The standalone `.filters select` rule is unaffected and keeps the browser ring.

**Impact**

The reset deletes the one indicator that keyboard users rely on, and replaces it with a subtle border-colour change from `--line` (`#e5e7eb`, a very light grey) to `--navy` (`#102a43`). On a laptop screen in daylight — the working condition for a site visit or a sales desk — that shift is easy to miss, so a keyboard user filling in the sign-in form cannot reliably tell which of the two credential fields is active while typing a client number and password. The enquiry form's "Interested in" dropdown is worse: it has no focus indication of any kind, which means a user tabbing through the contact form loses the caret entirely for one step, immediately before the free-text message box. Both forms are the entry point to a commercial relationship — the enquiry form is what generates stand leads, and the login form is the gateway to payment records — so a keyboard user who cannot see where they are is a lost enquiry or a failed login, not an abstract compliance point.

**Recommended fix**

Remove `outline:none` from the reset and add the `:focus-visible` rule from H-3, including the missing `select`:

```css
.contact-form input:focus-visible,.contact-form textarea:focus-visible,
.contact-form select:focus-visible,.login-form input:focus-visible{
  outline:3px solid var(--navy);outline-offset:2px;border-color:var(--navy);
}
```

### M-2 — No `prefers-reduced-motion` support

**Location:** `styles.css` — `html{scroll-behavior:smooth}`, `.portal-btn,.btn{…transition:.2s}`, `.toast{…transition:.25s}`; `app.js` L17

**Evidence**

```css
/* styles.css */
html{scroll-behavior:smooth}
.portal-btn,.btn{border:0;border-radius:10px;padding:12px 18px;font:600 14px 'DM Sans';cursor:pointer;transition:.2s}
.toast{…transform:translateY(120px);opacity:0;transition:.25s;box-shadow:var(--shadow)}
```

```js
// app.js L17 — every page change animates the scroll position
…window.scrollTo({top:0,behavior:'smooth'});…
```

Verified: `prefers-reduced-motion` occurs 0 times in `styles.css`; there are 2 `transition:` declarations and 1 `scroll-behavior` declaration.

**Impact**

The site animates on every navigation: `showPage()` smooth-scrolls to the top of the document on each of the seven page transitions, the toast slides in and out, and buttons translate and fade. For users with vestibular disorders or migraine sensitivity, motion that the user cannot disable is the specific problem — the operating-system "reduce motion" preference exists for them, and this prototype ignores it. There is a second, practical cost in this market: smooth scrolling of long documents is janky on low-end Android hardware, and because each page switch triggers a scroll animation, the transition between pages can feel slower than the page load itself. The toast animation and button transitions are individually trivial; the accumulated, unconditional motion across every navigation is not.

**Recommended fix**

```css
@media (prefers-reduced-motion: reduce){
  html{scroll-behavior:auto}
  *,*::before,*::after{animation-duration:.001ms !important;animation-iteration-count:1 !important;transition-duration:.001ms !important}
}
```

In `app.js` L17, respect the same preference rather than always animating:

```js
const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
window.scrollTo({ top: 0, behavior: still ? 'auto' : 'smooth' });
```

### M-3 — 15 third-party URLs across 3 hosts; the page degrades and depends on an ad-hoc photo service

**Location:** `index.html` L8–L10; `app.js` L2–L7 and L10–L13; `styles.css` rules `.hero` and `.heritage-image`

**Evidence**

```html
<!-- index.html L8–L10 -->
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Manrope:wght@600;700;800&display=swap" rel="stylesheet">
```

```js
// app.js L2 — one of twelve Unsplash hotlinks; the same photo ids recur across projects and properties
{name:'Heritage Park',…,image:'https://images.unsplash.com/photo-1600607687920-4e2a09cf159d?auto=format&fit=crop&w=1000&q=80'},
```

```css
/* styles.css */
.hero{min-height:670px;position:relative;background:linear-gradient(100deg,rgba(10,30,48,.92),rgba(10,30,48,.55)),url('https://images.unsplash.com/photo-1600607687920-4e2a09cf159d?auto=format&fit=crop&w=1800&q=85') center/cover;…}
```

Breakdown verified by the audit: `images.unsplash.com` ×12, `fonts.googleapis.com` ×2, `fonts.gstatic.com` ×1. The images are fetched at full requested widths (w=1800 for the hero, w=1200 for the featured development, w=1000 for project cards, w=900 for property cards) with no `srcset`, no explicit dimensions and no lazy loading.

**Impact**

Every visitor must reach two third-party domains before the site looks correct, and each image is a separate request to a photo service that has no relationship with Heritage and no obligation to keep those URLs stable. If the images are slow or blocked, the hero — a 670px-tall banner — and the featured "Heritage Park" panel render as flat blocks, which on a property website is the worst possible failure because imagery is what communicates progress on a development. On Zimbabwean mobile connections, 12 unoptimised photographs of this size are a material cost to the visitor in data and time, and there is no width/height reservation, so the layout shifts as each one arrives. The font links add a further dependency with a visible failure mode: if `fonts.googleapis.com` is slow, text renders first in a fallback face and then reflows. There is also a privacy dimension that a company handling payment records should weigh: each of those requests discloses the visitor's IP address and user agent to Google and to Unsplash, and a self-hosted alternative removes that disclosure entirely. Finally, hotlinking a stock-photo CDN into production is fragile by design — Unsplash rate-limits and photo removals are outside Heritage's control, and a broken hero image cannot be fixed by editing the site, only by changing every URL.

**Recommended fix**

Self-host the assets: download the photographs, convert to WebP/AVIF at the widths actually used, store them under `assets/img/`, and reference them with `srcset`/`sizes` plus `loading="lazy"` (and `fetchpriority="high"` for the hero). Self-host the two font families as WOFF2 with `font-display:swap`, `preload` for the weights used above the fold, and a metric-compatible fallback stack. Keep a local gradient as the CSS fallback background behind the hero so that a failed image still yields a legible, on-brand banner.

### M-4 — Content images are CSS backgrounds with no accessible alternative

**Location:** `styles.css` rules `.hero`, `.heritage-image`, `.project-thumb`, `.property-img`; `app.js` L20 and L22 set the same properties inline

**Evidence**

```css
/* styles.css */
.heritage-image{background-image:linear-gradient(0deg,rgba(16,42,67,.6),transparent),url('https://images.unsplash.com/photo-1600566753086-00f18fb6b3ea?auto=format&fit=crop&w=1200&q=85');position:relative}
.project-thumb{height:210px;background:center/cover}
.property-img{height:185px;background:center/cover}
```

```js
// app.js L20 / L22 — the per-card image is injected as a style attribute
<div class="project-thumb" style="background-image:url('${p.image}')"></div>
```

Verified: `index.html` contains 0 `<img>` elements and 0 `alt` attributes; the audit counts 4 content images delivered as CSS backgrounds (the hero, the featured development panel, and the project/property card thumbnails).

**Impact**

CSS background images are decoration as far as assistive technology is concerned: they carry no text alternative, are not announced, and cannot be described. A screen-reader user evaluating stands at Heritage Park is told the project name, location, size and price, but never that a photograph of the development exists — and on a property site the imagery is often the most persuasive content, because it is what suggests that servicing and construction are real. There is no purely technical way to add `alt` text to a background image, so this cannot be fixed without changing the markup, which is why it is worth correcting before the pattern is copied onto the remaining pages. The `background:center/cover` sizing used for `.project-thumb` and `.property-img` also reserves no intrinsic aspect ratio, so cards reflow as images arrive — the same layout-shift problem noted in M-3, felt most on the Properties grid where several cards load at once. The featured panel adds a third problem: the visible label "HERITAGE PARK" is a positioned `<div>` (`.image-label`) laid over the image rather than text tied to it, so the association between the photo and the development exists visually only.

**Recommended fix**

Render content imagery as real elements and keep CSS backgrounds for decoration:

```html
<img class="heritage-image" src="assets/img/heritage-park.webp" width="1200" height="800"
     alt="Serviced residential stands at Heritage Park, Gweru, with roads and water infrastructure in progress">
```

```css
.project-thumb img,.property-img img{width:100%;height:100%;object-fit:cover;display:block}
```

For images that are genuinely decorative, keep `background-image` but add `role="img"` with an `aria-label`, or leave them unlabelled and ensure the adjacent text carries the meaning.

### M-5 — Text as small as 8px, including inside the payment and statement area

**Location:** `styles.css` — 11 rules at or below 11px

**Evidence**

```css
/* styles.css — the four smallest sizes in use */
.brand small{font-size:8px;letter-spacing:2px;color:var(--gold);margin-top:5px;font-weight:700}
.portal-brand small{font-size:9px;letter-spacing:1.5px;color:var(--gold);font-weight:800}
.property-meta small{font-size:10px;color:var(--muted);text-transform:uppercase}
.portal-stat small{font-size:10px;color:var(--muted);text-transform:uppercase}
.portal-table th{font-size:10px;text-transform:uppercase;color:var(--muted)}
```

Set of sizes found by the audit: 8, 9, 10, 11px. The 11px rules are `.eyebrow`, `.status`, `.mini-grid small`, `.mission-card span` and `.copyright`; the 10px rules are `.property-meta small`, `.news-card span`, `.portal-stat small` and `.portal-table th`.

**Impact**

Two of these rules sit directly on financial information. `.portal-stat small` labels the Project / Stand / Size figures that head the client dashboard, and `.portal-table th` heads the payment-history table — Date, Reference, Amount, Status — that a client reads to check whether a payment was received. At 10px, uppercase and in `--muted` (`#667085`) on white, a reference number such as `HP001389` or a status of "Confirmed" is at the edge of legibility for anyone reading on a phone in daylight, and the audience for a Zimbabwean property developer skews towards older buyers. The 8px and 9px instances are brand furniture (the "HOUSING PROJECTS" tagline and "CLIENT PORTAL" label) rather than data, but they are the smallest text on the site and they render as an illegible smudge on low-DPI displays, which undercuts the professional impression the design is aiming for. The mitigating factor is that the viewport meta tag (`index.html` L5) does not set `maximum-scale`, so pinch-zoom is available to every user — the problem is that relying on zoom to read a payment status is a poor substitute for legible type. WCAG sets no absolute minimum size, but 8–10px is below any reasonable engineering threshold for body or label text.

**Recommended fix**

Set a floor of 12px for labels and 14px for anything conveying data, expressed in `rem` so it scales with the browser's base font size:

```css
.portal-table th,.portal-stat small{font-size:.8125rem}  /* 13px */
.portal-table td{font-size:.875rem;color:var(--ink)}     /* 14px */
.brand small{font-size:.625rem}                          /* 10px floor for decorative brand text only */
```

Where a label must stay visually quiet, reduce weight or contrast rather than size. Never let the payment table drop below 14px.

### M-6 — Foreign stock photography presented as named Heritage developments

**Location:** `index.html` L73–L74; `app.js` L2–L7 (projects) and L10–L13 (properties); `styles.css` rule `.heritage-image`

**Evidence**

```html
<!-- index.html L73–L74 — a stock photograph labelled as the featured development -->
<div class="project-image heritage-image"><div class="image-label">HERITAGE PARK</div></div>
<div class="project-info"><span class="status">● DEVELOPMENT IN PROGRESS</span><h3>200m² Residential Stands</h3><p>…</p><div class="mini-grid"><div><small>Location</small><strong>Gweru, Zimbabwe</strong></div>…
```

```js
// app.js L5 — a real Gweru suburb used as a project name, illustrated with an Unsplash photo
{name:'Mkoba 21',location:'Gweru, Zimbabwe',type:'Residential',status:'Project',desc:'Residential property development opportunity in Gweru.',image:'https://images.unsplash.com/photo-1600047509807-ba8f99d2cdde?auto=format&fit=crop&w=1000&q=80'},
```

**Impact**

Twelve of the fifteen external URLs point at Unsplash, and every project and property card uses one. The featured panel on the home page overlays the label "HERITAGE PARK" on a foreign stock photograph and presents it beside "Location: Gweru, Zimbabwe" and "● DEVELOPMENT IN PROGRESS", with no indication that the image is illustrative. Several of the named developments are real or plausible local references — Mkoba is an established Gweru suburb, and Mutare is named for "Gorge of Toronto" — which makes the mismatch between the photograph and the place harder to defend than if the whole portfolio were obviously fictional. The commercial risk is that a prospective buyer, or a client in a payment dispute, treats the marketing imagery as a representation of what is being sold; with a stand purchased over several years of instalments, "the development was advertised with a photo of something that does not exist in Gweru" is an argument that costs far more to answer than the cost of replacing the images. There is also a governance angle: the prototype is a client-facing artifact and screenshots of it will circulate, so unlabelled stock imagery can outlive the prototype and appear in a tender document or a social post. This finding is about presentation, not deception — the site copy itself is careful ("Residential stands in a developing community") — but the visual layer is not currently held to the same standard.

**Recommended fix**

Replace each stock photograph with real site photography or a clearly attributed illustrator's impression, and label anything that is not a photograph of the actual development. As an interim measure, add a visible caption to the featured panel and an `alt`/caption note to each card, e.g. `Illustrative image — Heritage Park, Gweru`, and record the source and licence of every image used. Confirm the project names and locations against the actual portfolio before publication, since "Gorge of Toronto" in Mutare will read as an error regardless of the photograph.

---

## 5. Low

### L-1 — Copyright year is hard-coded

**Location:** `index.html` L123

**Evidence**

```html
<div class="container copyright">© 2026 Heritage Housing Projects (Pvt) Ltd. All rights reserved.</div>
```

**Impact**

The year is static, so the notice becomes wrong on 1 January and stays wrong until someone remembers to edit the HTML. On a corporate footer this reads as neglect, and for a company whose sales material emphasises transparency and responsible process, an out-of-date notice on the site is a small but avoidable signal. The audit flags it simply because the year is a hard-coded literal next to a `©` symbol, which is the pattern that reliably goes stale.

**Recommended fix**

Populate it at runtime, with the literal retained as the no-JavaScript fallback:

```html
<span class="copyright-year">2026</span> Heritage Housing Projects (Pvt) Ltd. All rights reserved.
```

```js
// app.js L31 (DOMContentLoaded)
document.querySelector('.copyright-year').textContent = new Date().getFullYear();
```

### L-2 — `toast()` does not clear its previous timer

**Location:** `app.js` L19

**Evidence**

```js
function toast(msg){const t=document.getElementById('toast');t.textContent=msg;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),2800)}
```

**Impact**

Each call schedules an independent 2,800ms timeout that removes the `show` class, and no handle is retained. If a second toast appears within that window, the first call's timeout still fires and hides the second message early — the classic symptom is a message that flashes and disappears before it can be read. On this prototype the reachable sequence is a failed login followed by a retry: the "Demo login: HP-10245 / demo123" hint (L27) is exactly the kind of message a user needs time to read and act on, and it is also the message most likely to follow another toast. The bug is worth fixing now because `toast()` is the site's only feedback channel for enquiries, payments and support requests, and after C-1 is corrected it will carry messages such as "Client number or password is incorrect", where a truncated display is actively misleading.

**Recommended fix**

```js
let toastTimer;
function toast(msg){
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);                       // cancel the previous dismissal
  toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
}
```

For messages that convey an error or a required action, consider `role="status"` on the toast container and a longer dwell time than an animation-only message.

### L-3 — Two CSS custom properties are defined but never used

**Location:** `styles.css` — `:root` (single minified line)

**Evidence**

```css
:root{--navy:#102a43;--navy2:#163b5c;--gold:#c79a45;--cream:#f7f4ed;--ink:#17212b;--muted:#667085;--line:#e5e7eb;--white:#fff;--green:#238b5a;--shadow:0 18px 50px rgba(16,42,67,.12);--radius:18px}
```

Verified: `var(--navy2)` occurs 0 times and `var(--white)` occurs 0 times, while `var(--cream)` and the other tokens are used. `--white` is defined as `#fff` although the literal `#fff` is used throughout the stylesheet.

**Impact**

Low maintenance cost, but it is the kind of drift that makes a design system untrustworthy: a developer searching for the secondary navy finds `--navy2` declared and reasonably assumes it is in use, or changes `--white` expecting the cascade to follow and nothing happens. On a prototype that will be handed to a production team, unused tokens tend to be copied forward into the real codebase.

**Recommended fix**

Either delete the two declarations from `:root`, or adopt them — the safe adoption is `var(--white)` in place of the literal `#fff` (which also makes an intentional colour-theme change a one-line edit). `--navy2` (`#163b5c`) does not match any navy currently in the stylesheet, so it should probably be deleted rather than pointed at an existing surface. Add a lint step or a build-time check that fails on an unused custom property.

### L-4 — Seven `<h1>` elements in one document

**Location:** `index.html` L41 (home), L87 (about), L93 (services), L96 (projects), L99 (properties), L102 (news), L105 (contact)

**Evidence**

```html
<!-- index.html L41 -->   <h1>Building Communities.<br><span>Creating Opportunities.</span></h1>
<!-- index.html L87 -->   <h1>Developing places people can call home.</h1>
<!-- index.html L93 -->   <h1>From land to opportunity.</h1>
<!-- index.html L96 -->   <h1>Developments across Zimbabwe.</h1>
<!-- index.html L99 -->   <h1>Find your next property opportunity.</h1>
<!-- index.html L102 -->  <h1>What is happening at Heritage.</h1>
<!-- index.html L105 -->  <h1>Let's discuss your property opportunity.</h1>
```

**Impact**

Each heading is the correct top-level heading *for its own page*, and in an SPA that is a defensible authoring choice — but all seven exist in the same document simultaneously, so any consumer that reads the static HTML (search-engine crawlers on first pass, social/link preview generators, accessibility tools that do not execute the routing) sees seven competing document titles. The practical effects are a diluted page heading for the terms Heritage most wants to rank for — "properties in Gweru", "residential stands Zimbabwe" — and a flat heading outline in which a screen-reader user navigating by heading level gets seven equivalent starting points with no way to tell which page they are on. The non-active sections are hidden with `display:none`, which removes them from the accessibility tree in most browsers, so the live experience is better than the static markup suggests; the risk is concentrated in indexing and in any tool that reads the source.

**Recommended fix**

Keep a single `<h1>` for the document (the home hero) and demote the per-page headings to `<h2>`, adjusting the CSS rules that target `.page-hero h1` accordingly. If each page genuinely needs its own top-level heading, generate it when the route changes — set the heading level dynamically or, more simply, update `document.title` and move focus to the page container in `showPage()` (L17) so that assistive-technology users are told which page loaded. Note that `showPage()` currently neither updates the title nor moves focus, which is worth fixing on its own merits.

---

## 6. What is working well

The following are genuinely good, and should be preserved as the prototype is rebuilt into a production site.

- **The SPA routing is simple and predictable.** `showPage()` (`app.js` L17) removes a single class from all `.page` sections, adds it to the target, scrolls to the top, closes the mobile menu and lazily renders the page that needs it (`if(id==='projects')renderProjects();if(id==='properties')renderProperties()`). One id, one class, no framework, no state to desynchronise — easy to reason about and easy for a production team to keep or replace. The header links carry real `href` fragments so they are focusable and show the destination in the status bar; the only gaps are the footer anchors (H-5) and the absence of hash-change handling for deep links and history, which the `:target` fallback in H-2 would also address.
- **The property filter logic is correct and fails gracefully.** `renderProperties()` (`app.js` L22) reads all three selects and applies the predicates with `String(p.size)===sf` — the explicit `String()` conversion against the option values `"200"`/`"300"` is exactly the right call and avoids the number-versus-string comparison bug this pattern usually ships with. `populateFilters()` (L21) derives the project options from the data via `[...new Set(projects.map(p=>p.name))]` rather than a hand-written list, so the project filter stays aligned with the project records, and the empty result path renders "No properties match your filters." rather than an empty grid — which is also what a user selecting the hand-written "Commercial" option correctly sees today, since no commercial stand exists in the sample data. The controls are native `<select>` elements that keep their default focus ring, so no custom-widget keyboard handling is needed.
- **The responsive breakpoints are deliberate and cover both ends.** Two media queries (900px and 600px) do the real work: at 900px the nav collapses and `.cards.four`, `.values`, `.trust-grid`, `.footer-grid`, `.property-grid` and `.cards.three` drop to two columns while `.project-feature`, `.two-col`, `.contact-layout` and `.client-grid` become single-column; at 600px every grid goes to one column, the filters stack and go full width, `.hero-actions`, `.section-head` and `.portal-callout` switch to column layout, and padding is reduced for the modal and project panel. The `clamp()` typography on `h1`/`h2` (`clamp(42px,6vw,76px)`) means headings scale continuously instead of jumping at breakpoints, and the viewport meta tag does not disable zoom — which is what makes M-5 recoverable for users who need it.
- **The toast is a correct `aria-live` implementation.** `index.html` L14 declares `<div id="toast" class="toast" aria-live="polite"></div>` once, in the initial DOM, which is the pattern assistive technology requires — a live region added at the moment a message appears is frequently not announced. `toast()` (`app.js` L19) then writes with `t.textContent`, not `innerHTML`, so the site's feedback channel is the one place in the codebase that is inherently immune to the injection defect described in H-1. It is the model the rest of the rendering code should follow. The `role="dialog"`, `aria-modal="true"` and `aria-labelledby="portalTitle"` on the modal (`index.html` L109) are also correct, and `openPortal()` moving focus to `#clientNumber` after opening shows the right instinct — H-4 is about completing that work, not about it being absent.
- **Two further details worth keeping:** the contact links use `tel:` and `mailto:` (`index.html` L105), which is the correct mobile behaviour and was clearly a deliberate choice for a market where most enquiries arrive by phone or WhatsApp; and the CSS is organised around a small token set in `:root` with a single `--radius`/`--shadow` pair, so the visual system can be rethemed without touching component rules.

One honest caveat on the filtering, which is otherwise well built: none of the three filter `<select>` elements has an associated `<label>` or `aria-label` (`index.html` L99), so their accessible name is empty and a screen-reader user hears only the currently selected option. This sits outside the 16 automated findings but is worth fixing alongside H-3; a visually hidden `<label for="projectFilter">` per select is a two-line change.

---

## 7. Scope, limitations and acknowledgements

**Acknowledged prototype limitations.** The hard-coded credentials (C-1) and the inline client record in `app.js` L15 are *not* oversights. `README.md` L17–L19 documents the demo login, and L21–L24 states plainly: "The portal in this prototype is intentionally front-end only. A production deployment must replace the demo login and hard-coded client data with a secure backend/database, server-side authentication, role-based access control, encrypted transport/storage, audit logging, secure document access, backups and verified payment integration." The same section names the intended stack and closes with "Do not store passwords or sensitive client records in front-end JavaScript." The author identified the correct control set in advance. C-1 is reported at Critical severity because of what happens to anyone who deploys or shares this artifact before that production work is done — the prototype is a client-facing deliverable, and the login screen currently presents itself as secure — not because the limitation was concealed. Where findings rest on that acknowledged shortcut, they should be read as a pre-production checklist rather than as criticism of the design intent.

**Files added to the folder during the audit window.** While this review was in progress, three directories appeared alongside the audited files: `public/` (a multi-page static build with `assets/css` and `assets/js`), `server/` (`auth.js`, `config.js`, `db.js`, `security.js`, `views.js`) and `tools/` (`build-pages.js`). A directory listing taken at the start of this audit showed only `index.html`, `styles.css`, `app.js` and `README.md`, so none of these were present in — or reviewed as part of — the artifact described by the 16 findings above. They appear to be a separate production-hardening workstream and are explicitly out of scope here; whether they address the findings in this report was not assessed. If that workstream is intended to remediate this audit, it should be reviewed against the findings on its own terms, because the report below describes the original prototype as it stood.

**What this audit did not cover.** No live deployment was tested, so nothing is claimed about HTTP response headers, TLS configuration, cookies, caching, server-side authorisation, database access or the payment integration — none of which exist in this artifact. The audit is a static review of four files; runtime behaviour was reasoned about from the source rather than observed in a browser. Automated accessibility results were not available, so the accessibility findings are source-level (markup, ARIA, CSS) rather than a full conformance assessment.

**Coverage notes on the audit script.** `.audit/audit.py` contains two further checks that did not produce findings. Check K (duplicate element ids) correctly found none — `index.html` declares 20 unique ids. Check P (favicon) did not fire because it tests for the substring `icon` anywhere in the lowercased HTML (`if "icon" not in H.lower()`), which matches `class="icon"` on the feature cards at L62–L65; verified independently, `index.html` has no `<link rel="icon">`, so browsers will request `/favicon.ico` and receive a 404 on every load. That is a cosmetic one-line defect, recorded here for completeness, and it is not one of the 16 findings above. Similarly, check F reports "3 `innerHTML` sinks" by counting assignments (a reliable proxy here) and check M matches the `toast()` timer pattern; both were confirmed by reading the code, including the timer bug that the pattern match predicted.

**Verification statement.** Every line number and code snippet in this report was read from the working copy at `heritage-housing-prototype/` during this audit. CSS citations are by rule name because `styles.css` is a single minified line and has no meaningful line granularity; `app.js` line numbers are exact, and each cited function occupies exactly one line. No source file was modified — this report is the only artifact produced.
