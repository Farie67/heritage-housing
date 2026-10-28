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

function matches(pathname, prefix) {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/** True when this role may open this path at all. */
function mayReach(role, pathname) {
  const rule = ROLES[role];
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
function mayPerform(role, method, pathname) {
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
 * The view uses this only to decide what to draw. It is not a control.
 */
function visiblePrefixes(role) {
  const rule = ROLES[role];
  if (!rule) return [];
  return rule.paths;
}

module.exports = {
  ROLES, STAFF_ROLES, isStaffRole, mayReach, mayPerform, visiblePrefixes,
  OVERVIEW, SALES, LEADS, ACTIVITY, STAFF, CLIENTS, PROPERTIES
};
