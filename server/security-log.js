'use strict';

/* ==========================================================================
   Security event log.

   One JSON line per event on stdout, so a log collector can pick these up
   without parsing prose.

   Deliberately separate from audit() in db.js. audit() writes to the database
   and is part of the application's own record, which is the right place for
   "who changed what". This is the operational trail, and it has to survive the
   database being unavailable — a burst of failed logins during an outage is
   exactly the event worth having.

   Nothing here may throw. A logging call that can break the request it is
   describing turns a security control into a denial-of-service vector.
   ========================================================================== */

const config = require('./config');

/** The client address, honouring the proxy only when we were told to. */
function securityLogIp(req) {
  if (!req) return 'unknown';
  if (config.TRUST_PROXY) {
    const fwd = req.headers && req.headers['x-forwarded-for'];
    if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

/**
 * Writes one security event as a JSON line.
 *
 * @param {string} type   Short, machine-readable name, e.g. 'login_failed'.
 * @param {object} req    The request, for the IP and path. May be null.
 * @param {object} detail Anything else worth recording.
 *
 * Never pass a password, a session token or a password hash in `detail`: this
 * line goes to stdout, which is typically the least protected place in the
 * deployment.
 */
function logSecurityEvent(type, req, detail = {}) {
  try {
    console.log(JSON.stringify({
      at: new Date().toISOString(),
      type: String(type || 'unknown'),
      ip: securityLogIp(req),
      /* The query string is dropped on purpose — a reset link or a token could
         be sitting in it. */
      path: req ? String(req.url || '').split('?')[0].slice(0, 200) : '',
      detail: detail && typeof detail === 'object' ? detail : {}
    }));
  } catch {
    /* Swallow everything. Logging must never be the reason a request fails. */
  }
}

module.exports = { logSecurityEvent, securityLogIp };
