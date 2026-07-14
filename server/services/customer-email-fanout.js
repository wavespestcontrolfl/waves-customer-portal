/**
 * Fan a customer EMAIL edit out to the rows that snapshot the email at
 * creation time instead of reading customers.* live, and settle the open
 * email-review question the edit answers:
 *
 *   - leads.email — captured at lead intake; the Leads UI and follow-up
 *     sends read this column directly.
 *   - estimates.customer_email — captured when the estimate is created; the
 *     send/resend path delivers to it, so a stale copy mails the misspelling
 *     even after the customer record is corrected.
 *   - newsletter_subscribers.email — the call pipeline auto-subscribes
 *     callers, so a misheard address becomes a subscriber row of its own.
 *   - triage_items (email_unverified / email_invalid) — the read-back card
 *     asks "which spelling is right?"; an operator saving a DIFFERENT email
 *     on the customer record is the authoritative answer, so the card
 *     resolves instead of waiting for someone to also click it.
 *
 * A snapshot is only rewritten when it still equals the customer's OLD email
 * (case-insensitive) — an intentionally different address on a lead or
 * estimate (a tenant's estimate under a landlord's record) is never
 * clobbered. Removing the email is not propagated: blanking copies would
 * destroy the only remaining record of where contact was promised. Terminal
 * rows are historical documents and stay untouched (mirrors
 * customer-address-fanout). Errors PROPAGATE so a transactional caller rolls
 * the whole edit back rather than leaving the record and its copies
 * half-synced.
 *
 * Origin: 2026-07-13, a transcription dot ("Charles W. Robb" → charlesw.robb@)
 * was stored across customer + lead + newsletter while the review card sat
 * open; correcting it took four hand-written UPDATEs. This service makes the
 * customer-record edit do all of that.
 */

const db = require('../models/db');
const logger = require('./logger');

// Mirrors customer-address-fanout (which mirrors SENDABLE_ESTIMATE_STATUSES in
// routes/admin-estimates.js and CLOSED_STATUSES in intelligence-bar/leads-tools.js).
// 'sending' is deliberately absent: an in-flight send already rendered its
// content; the row still matches the old email once it settles, so the next
// fan-out heals it.
const OPEN_ESTIMATE_STATUSES = ['draft', 'scheduled', 'sent', 'viewed', 'send_failed'];
const TERMINAL_LEAD_STATUSES = ['won', 'lost', 'disqualified', 'duplicate', 'unresponsive'];

// Mirrors OPEN_STATES in routes/admin-triage.js.
const OPEN_REVIEW_STATES = ['open', 'in_progress'];
const EMAIL_REVIEW_REASON_CODES = ['email_unverified', 'email_invalid'];

function emailKey(value) {
  const s = String(value ?? '').trim().toLowerCase();
  return s.includes('@') ? s : '';
}

/**
 * @param {object} opts
 *   before — customer row before the edit (id, email)
 *   after  — customer row after the edit (id, email)
 *   source — short human label for resolution notes/logs (e.g. "Customer 360
 *            edit", "Intelligence Bar update_customer")
 * @param {object} conn — knex connection or transaction
 * @returns counts { leads, estimates, newsletter, reviewCards } — all zero
 *   when the email did not actually change or was removed.
 */
async function propagateCustomerEmailChange({ before, after, source = 'customer edit' }, conn = db) {
  const counts = { leads: 0, estimates: 0, newsletter: 0, reviewCards: 0 };
  const customerId = (after && after.id) || (before && before.id);
  const oldEmail = emailKey(before && before.email);
  const newEmail = emailKey(after && after.email);
  if (!customerId || !newEmail || oldEmail === newEmail) return counts;
  // The stored value keeps the caller's normalization (cleanEmail already
  // lowercases); newEmail is the comparison key AND the written value.

  const now = new Date();

  // Snapshot copies exist only when there was an old value to copy.
  if (oldEmail) {
    counts.leads += await conn('leads')
      .where({ customer_id: customerId })
      .whereRaw('LOWER(email) = ?', [oldEmail])
      .whereNull('deleted_at')
      .where((q) => q.whereNull('status').orWhereNotIn('status', TERMINAL_LEAD_STATUSES))
      .update({ email: newEmail, updated_at: now });

    counts.estimates += await conn('estimates')
      .where({ customer_id: customerId })
      .whereRaw('LOWER(customer_email) = ?', [oldEmail])
      .whereIn('status', OPEN_ESTIMATE_STATUSES)
      .whereNull('archived_at')
      .update({ customer_email: newEmail, updated_at: now });

    // newsletter_subscribers.email is UNIQUE. Check-first instead of
    // update-and-catch: a caught unique violation would poison the caller's
    // transaction (Postgres aborts it), so the rare true race is left to
    // bubble up and roll the whole edit back — half-synced is worse.
    const oldSub = await conn('newsletter_subscribers')
      .where({ customer_id: customerId })
      .whereRaw('LOWER(email) = ?', [oldEmail])
      .first();
    if (oldSub) {
      const targetSub = await conn('newsletter_subscribers')
        .whereRaw('LOWER(email) = ?', [newEmail])
        .first();
      if (targetSub) {
        // The corrected spelling already has a subscriber row — the
        // misspelled row is redundant (same person), so it goes away rather
        // than colliding with the unique index.
        counts.newsletter += await conn('newsletter_subscribers').where({ id: oldSub.id }).del();
      } else {
        counts.newsletter += await conn('newsletter_subscribers')
          .where({ id: oldSub.id })
          .update({ email: newEmail, updated_at: now });
      }
    }
  }

  // The operator asserting a NEW email on the record answers any open
  // read-back question for this customer's calls — resolve those cards and
  // keep call_log.review_status in sync (mirrors transitionCore in
  // routes/admin-triage.js). Scoped to email reason codes only: address or
  // booking reviews on the same call are untouched.
  const openItems = await conn('triage_items')
    .whereIn('reason_code', EMAIL_REVIEW_REASON_CODES)
    .whereIn('status', OPEN_REVIEW_STATES)
    .whereIn('call_log_id', conn('call_log').select('id').where({ customer_id: customerId }))
    .select('id', 'call_log_id');
  if (openItems.length) {
    counts.reviewCards += await conn('triage_items')
      .whereIn('id', openItems.map((i) => i.id))
      .whereIn('status', OPEN_REVIEW_STATES)
      .update({
        status: 'resolved',
        resolution_note: `Email corrected on the customer record (${String(source).slice(0, 100)})`,
        resolved_at: now,
        updated_at: now,
      });
    for (const callId of [...new Set(openItems.map((i) => i.call_log_id).filter(Boolean))]) {
      const stillOpen = await conn('triage_items')
        .where({ call_log_id: callId })
        .whereIn('status', OPEN_REVIEW_STATES)
        .count('* as n')
        .first();
      await conn('call_log')
        .where({ id: callId })
        .update({ review_status: parseInt(stillOpen?.n || 0, 10) > 0 ? 'open' : 'resolved', updated_at: now });
    }
  }

  if (counts.leads || counts.estimates || counts.newsletter || counts.reviewCards) {
    // Counts only — never the email values (PII stays out of logs).
    logger.info(`[email-fanout] customer ${customerId}: synced ${counts.leads} lead(s), ${counts.estimates} estimate(s), ${counts.newsletter} newsletter row(s); resolved ${counts.reviewCards} email review card(s)`);
  }
  return counts;
}

module.exports = { propagateCustomerEmailChange, emailKey };
