'use strict';

/* ==========================================================================
   Instalment reminders.

     node scripts/send-reminders.js --dry-run    # show who would be emailed
     node scripts/send-reminders.js              # send for real

   Also exported as runReminderCheck(), which /admin/reminders/run calls.

   ---------------------------------------------------------------------------
   WHY resend IS LOADED LAZILY
   ---------------------------------------------------------------------------
   admin.js requires this module so the dashboard button can call it. If
   `require('resend')` sat at the top level, a missing package would throw while
   the server was still starting — taking the whole site down over a reminder
   feature. The require is therefore inside a function: the server boots
   regardless, and the button reports that email is not configured.
   ========================================================================== */

const { getOverdueClients } = require('../server/db');
const { money } = require('../server/format');

const FROM = 'Heritage Housing <reminders@heritagehousingprojects.co.zw>';

/* Anything at the company's own domain is a placeholder the lead-conversion
   wrote (client-0771234567@heritagehousing.co.zw) because no real address was
   ever captured. Sending to it would bounce, so those clients are skipped and
   reported rather than silently counted as "sent". */
const PLACEHOLDER_DOMAIN = '@heritagehousing.co.zw';

const log = (msg) => console.log(`  ${msg}`);

/** A usable address, or null. */
function deliverableEmail(email) {
  const value = String(email || '').trim();
  if (!value || !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(value)) return null;
  if (value.toLowerCase().endsWith(PLACEHOLDER_DOMAIN)) return null;
  return value;
}

/** The HTML body, with the name and stand escaped. */
function buildHtml(client) {
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const balance = (client.balance_cents / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2, maximumFractionDigits: 2
  });

  return `<p>Dear ${esc(client.name)},</p>`
    + `<p>This is a reminder that your payment for Stand <strong>${esc(client.stand_number)}</strong> `
    + `is due. Your outstanding balance is <strong>US$${balance}</strong>.</p>`
    + '<p>Please make a payment to avoid penalties.</p>';
}

/**
 * Loads the Resend client, or throws a message a human can act on.
 *
 * The package is required here rather than at the top of the file so a missing
 * dependency cannot stop the server from starting.
 */
function loadResend() {
  let Resend;
  try {
    ({ Resend } = require('resend'));
  } catch {
    throw new Error(
      'The "resend" package is not installed. Run `npm install` in the project root.');
  }

  const key = process.env.RESEND_API_KEY;
  if (!key) {
    throw new Error('RESEND_API_KEY is not set in the environment.');
  }
  return new Resend(key);
}

/**
 * Emails every overdue client.
 *
 * Returns { sent, skipped, failed, total, clients }. Never throws on a single
 * bad address — one failure should not stop the run — but a missing package or
 * API key does throw, because then nothing can be sent at all.
 *
 * `dryRun` reports what would happen without calling Resend.
 */
async function runReminderCheck({ dryRun = false, days = 30 } = {}) {
  const clients = await getOverdueClients(days);

  const result = { sent: 0, skipped: 0, failed: 0, total: clients.length, clients };

  if (dryRun) {
    return { ...result, sent: 0 };
  }

  const resend = loadResend();

  for (const client of clients) {
    const to = deliverableEmail(client.email);
    if (!to) {
      result.skipped += 1;
      continue;
    }

    try {
      const { error } = await resend.emails.send({
        from: FROM,
        to,
        subject: `Payment Reminder for Stand ${client.stand_number}`,
        html: buildHtml(client)
      });

      if (error) {
        result.failed += 1;
        log(`! ${client.name} (${client.client_number}): ${error.message || error}`);
      } else {
        result.sent += 1;
        log(`sent -> ${client.name} <${to}> (stand ${client.stand_number}, ${money(client.balance_cents)})`);
      }
    } catch (err) {
      result.failed += 1;
      log(`! ${client.name} (${client.client_number}): ${err.message}`);
    }
  }

  return result;
}

module.exports = { runReminderCheck, getOverdueClients, deliverableEmail, buildHtml, FROM };

/* Run as a script, not when required by admin.js. */
if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');

  console.log('');
  console.log('  ' + '='.repeat(62));
  console.log(`   Instalment reminders${dryRun ? '  (DRY RUN — nothing will be sent)' : ''}`);
  console.log('  ' + '='.repeat(62));

  (async () => {
    const result = await runReminderCheck({ dryRun });

    if (dryRun) {
      for (const c of result.clients) {
        const to = deliverableEmail(c.email);
        log(`${to ? 'would email' : 'SKIP (no real address)'}  ${c.name.padEnd(20)} `
          + `stand ${String(c.stand_number).padEnd(10)} ${money(c.balance_cents).padEnd(12)} `
          + `last ${c.last_payment_date || 'never'}`);
        if (to) log(`    subject: Payment Reminder for Stand ${c.stand_number}`);
      }
      console.log('');
      log(`${result.total} overdue · ${result.clients.filter((c) => deliverableEmail(c.email)).length} `
        + `would receive an email`);
      console.log('');
      process.exit(0);
    }

    console.log('');
    log(`Overdue: ${result.total} · sent: ${result.sent} · `
      + `skipped (no real address): ${result.skipped} · failed: ${result.failed}`);
    console.log('');
    process.exit(result.failed > 0 ? 1 : 0);
  })().catch((err) => {
    console.error('');
    console.error(`  ${err.message}`);
    console.error('');
    process.exit(1);
  });
}
