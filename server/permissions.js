'use strict';

/* ==========================================================================
   Admin panel permissions.

   One table, consulted by the router (which enforces) and by the navigation
   (which merely displays). Keeping them together is the point: a nav link the
   router refuses is a dead end, and a router hole behind a hidden link is how
   privilege leaks.

   Paths match by exact equality or by prefix + '/'. The overview '/admin' is
   therefore handled by exact equality — treating it as a prefix would open every
   page under /admin to every role.
   ========================================================================== */

/* The Sales page lives at /admin/analytics; /admin/sales is its per-sale detail
   page, which is where payments are recorded. Both count as "sales". */
const SALES = ['/admin/analytics', '/admin/sales'];
const LEADS = ['/admin/leads'];
const ACTIVITY = ['/admin/activity-logs'];
const STAFF = ['/admin/staff'];
const CLIENTS = ['/admin/clients'];
const PROPERTIES = ['/admin/properties'];

const OVERVIEW = '/admin';

/**
 * Every role that may hold an admin session, and what it may do.
 *
 *   paths         the page prefixes it can reach at all. null means everything.
 *   readOnly      true: every non-GET is refused, everywhere.
 *   readOnlyPaths narrower: non-GET refused only under these prefixes.
 */
const ROLES = {
  admin: { paths: null, readOnly: false, readOnlyPaths: [] },

  /* Read-only, as specified. Note this also stops them commenting on activity
     logs, which they could do before — "read-only" taken literally. */
  manager: {
    paths: [OVERVIEW, ...SALES, ...LEADS, ...ACTIVITY, ...STAFF],
    readOnly: true,
    readOnlyPaths: []
  },

  ceo: {
    paths: [OVERVIEW, ...SALES, ...LEADS, ...ACTIVITY, ...STAFF],
    readOnly: true,
    readOnlyPaths: []
  },

  /* Finance is NOT read-only. Recording and correcting payments is the whole
     job, and that happens under /admin/sales/:id. Its route list also includes
     clients and properties, so it can edit those too — that is what granting
     those prefixes means. */
  finance: {
    paths: [OVERVIEW, ...SALES, ...CLIENTS, ...PROPERTIES],
    readOnly: false,
    readOnlyPaths: []
  },

  /* HR runs the staff list, so it may add agents and reset passwords. It reads
     activity logs and leads, but is view-only on leads per the brief. */
  hr: {
    paths: [OVERVIEW, ...STAFF, ...ACTIVITY, ...LEADS],
    readOnly: false,
    readOnlyPaths: [...LEADS]
  }
};

const STAFF_ROLES = new Set(Object.keys(ROLES));

const isStaffRole = (role) => STAFF_ROLES.has(role);

/* ── Email-mapped roles ───────────────────────────────────────────────────
   Turso will not accept the new role values, so the CEO's account still says
   'admin' in the database and is narrowed here instead.

   IMPORTANT: this can only ever REDUCE privilege, never grant it.

   The tempting one-liner — "if the email matches, return 'ceo'" — reads as a
   restriction but is actually an override: a *client* whose email happened to
   be set to this address would be handed a staff role and let into /admin. The
   guard below returns the stored role untouched for anyone who is not already
   staff, so the mapping can demote an admin but cannot promote a client.

   Two further caveats worth knowing:
     - The address is compared case-insensitively and trimmed, because an email
       typed into a database console rarely arrives clean.
     - Whoever can edit users.email can therefore change what this account may
       do. That is a weaker guarantee than a role column, which is why the real
       fix remains widening the CHECK. This keeps the office working meanwhile.
   ────────────────────────────────────────────────────────────────────────── */
const CEO_EMAIL = 'ceo@heritagehousing.co.zw';

/**
 * Addresses that stand for an executive role.
 *
 * The database cannot store these roles, so an account carrying one is saved as
 * 'admin' and narrowed here instead. Add an address to this map to give that
 * person the role without touching the schema.
 */
const ROLE_BY_EMAIL = new Map([
  [CEO_EMAIL, 'ceo'],
  ['finance@heritagehousing.co.zw', 'finance'],
  ['hr@heritagehousing.co.zw', 'hr']
]);

/**
 * Staff-ID prefixes that stand for an executive role.
 *
 * The second way to record an intended role without a role column: the "Add a
 * team member" form already numbers accounts CEO-001, FIN-001 and HR-001, so the
 * prefix identifies the role for every account created through it.
 */
const ROLE_BY_PREFIX = [
  ['CEO-', 'ceo'],
  ['FIN-', 'finance'],
  ['HR-', 'hr']
];

/**
 * The role the app should treat this user as.
 *
 * Accepts a user object and returns a role string. Given a plain string it
 * returns it unchanged, so the primitives below can be called with either.
 *
 * Resolution order — email first, then staff-ID prefix, then the stored role.
 * The guard at the top means none of this can ever promote a non-staff account:
 * a client whose email or ID happened to match is still a client.
 */
function getEffectiveRole(user) {
  if (!user) return null;
  if (typeof user === 'string') return user;

  const stored = user.role;
  if (!isStaffRole(stored)) return stored;      // never promote a non-staff account

  const email = String(user.email || '').trim().toLowerCase();
  if (ROLE_BY_EMAIL.has(email)) return ROLE_BY_EMAIL.get(email);

  const id = String(user.client_number || user.clientNumber || '').trim().toUpperCase();
  for (const [prefix, role] of ROLE_BY_PREFIX) {
    if (id.startsWith(prefix)) return role;
  }

  return stored;
}

/** Resolves a user object or a role string down to a role string. */
const resolveRole = (userOrRole) => getEffectiveRole(userOrRole);

function matches(pathname, prefix) {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/**
 * True when this role may open this path at all.
 *
 * Takes a user object or a role string; an object is resolved through
 * getEffectiveRole first, so no caller has to remember to do it.
 */
function mayReach(userOrRole, pathname) {
  const rule = ROLES[resolveRole(userOrRole)];
  if (!rule) return false;
  if (rule.paths === null) return true;
  if (pathname === OVERVIEW) return rule.paths.includes(OVERVIEW);
  return rule.paths.some((p) => p !== OVERVIEW && matches(pathname, p));
}

/**
 * True when this role may perform this method at this path.
 *
 * Reach and act are separate questions: HR may open a lead but not change it,
 * and a role with no reach is refused whatever the method.
 */
function mayPerform(userOrRole, method, pathname) {
  const role = resolveRole(userOrRole);
  if (!mayReach(role, pathname)) return false;

  const rule = ROLES[role];
  if (!rule) return false;
  if (method === 'GET' || method === 'HEAD') return true;
  if (rule.readOnly) return false;
  if (rule.readOnlyPaths.some((p) => matches(pathname, p))) return false;
  return true;
}

/**
 * The prefixes a role may see, or null meaning "everything".
 *
 * Takes a user object or a role string, the same as mayReach.
 * The view uses this only to decide what to draw. It is not a control.
 */
function visiblePrefixes(userOrRole) {
  const rule = ROLES[resolveRole(userOrRole)];
  if (!rule) return [];
  return rule.paths;
}

module.exports = {
  ROLES, STAFF_ROLES, isStaffRole, getEffectiveRole, mayReach, mayPerform, visiblePrefixes,
  OVERVIEW, SALES, LEADS, ACTIVITY, STAFF, CLIENTS, PROPERTIES
};
