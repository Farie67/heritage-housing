'use strict';

/* ==========================================================================
   Lead input — the pipeline stages and the parser for the Manage form.

   Shared by the staff router (index.js), the admin router (admin.js) and both
   views, so the list of stages exists exactly once. Four copies of a status
   list is how a dropdown silently drifts out of step with a validator.
   ========================================================================== */

/* The pipeline, in order. 'New' is where a lead starts; 'Won' and 'Lost' are
   the two closed states, and nothing else is ever treated as closed. */
const LEAD_STATUSES = ['New', 'Contacted', 'Site Visit', 'Negotiation', 'Won', 'Lost'];

/**
 * Reads the editable fields off a lead-update form.
 *
 * A status outside the list falls back to 'New' rather than rejecting the whole
 * submission, so a stale form still saves its notes and follow-up date instead
 * of losing the edit.
 *
 * `budget` is null when the form does not carry one — and the UPDATE's COALESCE
 * then preserves whatever is already stored, because the Manage form does not
 * edit the budget and a plain assignment would wipe it.
 */
function readLeadUpdate(body) {
  const raw = String(body.status || '').trim();
  const followUpDate = String(body.followUpDate || '').trim().slice(0, 10);
  const notes = String(body.notes || '').trim().slice(0, 2000);
  const budget = body.budget === undefined
    ? null
    : (String(body.budget).trim().slice(0, 60) || null);

  return {
    status: LEAD_STATUSES.includes(raw) ? raw : 'New',
    followUpDate: /^\d{4}-\d{2}-\d{2}$/.test(followUpDate) ? followUpDate : null,
    notes: notes || null,
    budget
  };
}

module.exports = { LEAD_STATUSES, readLeadUpdate, notesByLeadFor };

/**
 * Groups lead-note rows by lead id.
 *
 * Both the staff dashboard and the admin leads page show a conversation under
 * each lead, and both fetch every note in one query rather than one query per
 * row — this turns that flat list into a lookup keyed by lead.
 */
function notesByLeadFor(rows) {
  const out = {};
  for (const n of rows) {
    (out[n.lead_id] = out[n.lead_id] || []).push(n);
  }
  return out;
}
