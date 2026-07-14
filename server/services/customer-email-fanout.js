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
 *   - automation_enrollments.email — denormalized at enrollment; the
 *     automation runner sends every remaining step to it, so an ACTIVE
 *     enrollment keeps mailing the misspelling after the record is fixed.
 *     Includes customer_id-NULL rows matching the old email: estimate
 *     follow-ups enroll with `customer_id: estimate.customer_id || null`
 *     and nothing backfills the link later.
 *   - email_template_automation_runs.recipient_email — queued/delayed runs
 *     (estimate, appointment, payment follow-ups) send to the stored value
 *     at claim time; a run queued before the correction would deliver to
 *     the misspelling.
 *   - referral_promoters.customer_email — snapshotted at promoter
 *     enrollment; reward emails send directly to it.
 *   - notification_prefs.billing_email — a sendable customer address
 *     (invoice/balance recipients); only rewritten when it still equals the
 *     OLD email, so a deliberately different billing contact is never
 *     touched.
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
const { cleanValidEmailOrNull } = require('../utils/intake-normalize');

// Mirrors customer-address-fanout (which mirrors SENDABLE_ESTIMATE_STATUSES in
// routes/admin-estimates.js and CLOSED_STATUSES in intelligence-bar/leads-tools.js).
// 'sending' is absent from THIS list (no estimate_data touch under an
// in-flight send) but gets its own column-only customer_email sync below —
// this service is diff-gated, so "heal on the next fan-out" never comes.
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
 * @returns counts { leads, estimates, newsletter, automations, templateRuns,
 *   promoters, billingPrefs, contracts, bookingIntents, reviewCards } — all
 *   zero when the email did not actually change or was removed. When a
 *   PENDING (double-opt-in) subscriber row was moved to the corrected
 *   address, the result also carries `pendingConfirmation` ({ id, email,
 *   first_name, confirmation_token }): the DOI confirmation was sent to the
 *   OLD typo, so the CALLER must re-send it to the corrected address AFTER
 *   its transaction commits (never send mail inside a trx) and stamp
 *   confirmation_sent_at on success — otherwise the row sits pending forever
 *   and campaigns (status='active' only) never reach them.
 */
async function propagateCustomerEmailChange({ before, after, source = 'customer edit' }, conn = db) {
  const counts = { leads: 0, estimates: 0, newsletter: 0, automations: 0, templateRuns: 0, promoters: 0, billingPrefs: 0, contracts: 0, bookingIntents: 0, reviewCards: 0 };
  let pendingConfirmation = null;
  const customerId = (after && after.id) || (before && before.id);
  // OLD is a loose match key (the stored copy may itself be malformed — that
  // is exactly what gets corrected); NEW must be a syntactically VALID
  // address before it fans out anywhere or settles a review card — an
  // operator typo like "foo@bar" must not overwrite deliverable copies or
  // resolve an email_invalid card with another invalid value.
  const oldEmail = emailKey(before && before.email);
  const newEmail = cleanValidEmailOrNull(after && after.email) || '';
  if (!customerId || !newEmail || oldEmail === newEmail) return counts;

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
      .update({
        customer_email: newEmail,
        // proposalDelivery claims "the proposal PDF was emailed" — to the OLD
        // address. Stale after the correction, so it drops with the sync
        // (same rule as the address fan-out); the next send re-stamps it.
        // jsonb minus is a no-op when the key is absent and NULL stays NULL.
        estimate_data: conn.raw("estimate_data - 'proposalDelivery'"),
        updated_at: now,
      });

    // 'sending' rows sync too — but COLUMN-ONLY, no estimate_data touch.
    // Unlike the presence-triggered address fan-out (where a skipped
    // 'sending' row heals on the next resave), this service is diff-gated:
    // skip the row now and it can never heal — the old email is gone from
    // the customer row. Verified safe against the send path
    // (routes/admin-estimates.js): the in-flight send reads its recipient
    // into memory BEFORE the 'sending' claim, and the settle write touches
    // status/sent_at and a jsonb merge of its OWN estimate_data keys — never
    // customer_email. Residual: the settle stamps proposalDelivery for the
    // send it just made (to the old spelling) — bounded to that one
    // in-flight send; every future resend/follow-up uses the corrected
    // address.
    counts.estimates += await conn('estimates')
      .where({ customer_id: customerId, status: 'sending' })
      .whereRaw('LOWER(customer_email) = ?', [oldEmail])
      .whereNull('archived_at')
      .update({ customer_email: newEmail, updated_at: now });

    // Active automation enrollments send every remaining step to their
    // denormalized email — terminal enrollments (completed/cancelled/failed)
    // are history and stay untouched. customer_id-NULL rows matching the old
    // email are included: estimate follow-ups enroll with
    // `customer_id: estimate.customer_id || null` and nothing links them
    // later — the old-email guard is what scopes them to this correction.
    counts.automations += await conn('automation_enrollments')
      .where({ status: 'active' })
      .where((q) => q.where({ customer_id: customerId }).orWhereNull('customer_id'))
      .whereRaw('LOWER(email) = ?', [oldEmail])
      .update({ email: newEmail, updated_at: now });

    // Queued/delayed email-template automation runs deliver to the stored
    // recipient_email at claim time (email-template-automation-executor).
    // Only NOT-YET-CLAIMED states sync (queued/scheduled/retry_scheduled).
    // 'running' is deliberately excluded: the claimed attempt sends to its
    // in-memory copy, so rewriting the row mid-flight would make the run
    // record show the corrected address for an email that actually went to
    // the typo — delivery audit beats retry healing here. Residual: a
    // mid-flight failure retries to the old spelling (bounded by
    // max_attempts). Completed/skipped runs are an audit trail and stay
    // untouched.
    counts.templateRuns += await conn('email_template_automation_runs')
      .whereIn('status', ['queued', 'scheduled', 'retry_scheduled'])
      .where((q) => q.where({ recipient_id: String(customerId) }).orWhereNull('recipient_id'))
      .whereRaw('LOWER(recipient_email) = ?', [oldEmail])
      .update({ recipient_email: newEmail, updated_at: now });

    // Referral promoter rows snapshot the email at enrollment; reward
    // notifications send directly to it (referral-engine).
    counts.promoters += await conn('referral_promoters')
      .where({ customer_id: customerId })
      .whereRaw('LOWER(customer_email) = ?', [oldEmail])
      .update({ customer_email: newEmail, updated_at: now });

    // billing_email is a sendable customer address (invoice/balance
    // recipients read it) — the old-email guard means a deliberately
    // different billing contact is never rewritten.
    counts.billingPrefs += await conn('notification_prefs')
      .where({ customer_id: customerId })
      .whereRaw('LOWER(billing_email) = ?', [oldEmail])
      .update({ billing_email: newEmail, updated_at: now });

    // Contract packets snapshot recipient_email at creation and the delivery
    // path PREFERS it over the live customer row — resends and due reminders
    // for draft/sent/viewed rows would keep mailing the misspelling.
    // Terminal contracts (signed/cancelled/voided — mirrors
    // document-contract-delivery TERMINAL_STATUSES) are history.
    counts.contracts += await conn('customer_contracts')
      .where({ customer_id: customerId })
      .whereRaw('LOWER(recipient_email) = ?', [oldEmail])
      .whereNotIn('status', ['signed', 'cancelled', 'voided'])
      .update({ recipient_email: newEmail, updated_at: now });

    // Abandoned-booking recovery sends its ~24h second touch directly to
    // booking_intents.email. Only rows still awaiting that touch matter:
    // unconverted, email touch unsent, not suppressed.
    counts.bookingIntents += await conn('booking_intents')
      .where({ customer_id: customerId, followup_email_sent: false, suppressed: false })
      .whereRaw('LOWER(email) = ?', [oldEmail])
      .whereNull('converted_at')
      .update({ email: newEmail, updated_at: now });

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
        // than colliding with the unique index. But first: a public-signup
        // row commonly has customer_id NULL (the typo on customers.email kept
        // linkToCustomer from matching it) — adopt it onto this customer so
        // deleting the misspelled row doesn't sever their only linked
        // subscription. A row already linked to ANOTHER customer is left
        // alone (never steal a link).
        if (!targetSub.customer_id) {
          await conn('newsletter_subscribers')
            .where({ id: targetSub.id })
            .whereNull('customer_id')
            .update({ customer_id: customerId, updated_at: now });
        }
        counts.newsletter += await conn('newsletter_subscribers').where({ id: oldSub.id }).del();
      } else {
        counts.newsletter += await conn('newsletter_subscribers')
          .where({ id: oldSub.id })
          .update({ email: newEmail, updated_at: now });
        // A PENDING row's DOI confirmation went to the old typo — hand the
        // caller what it needs to re-send post-commit (see @returns).
        if (String(oldSub.status || '') === 'pending' && oldSub.confirmation_token) {
          pendingConfirmation = {
            id: oldSub.id,
            email: newEmail,
            first_name: oldSub.first_name || null,
            confirmation_token: oldSub.confirmation_token,
          };
        }
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

  if (Object.values(counts).some(Boolean)) {
    // Counts only — never the email values (PII stays out of logs).
    logger.info(`[email-fanout] customer ${customerId}: synced ${counts.leads} lead(s), ${counts.estimates} estimate(s), ${counts.newsletter} newsletter, ${counts.automations} enrollment(s), ${counts.templateRuns} template run(s), ${counts.promoters} promoter(s), ${counts.billingPrefs} billing pref(s), ${counts.contracts} contract(s), ${counts.bookingIntents} booking intent(s); resolved ${counts.reviewCards} email review card(s)`);
  }
  return pendingConfirmation ? { ...counts, pendingConfirmation } : counts;
}

/**
 * Post-commit companion to propagateCustomerEmailChange: re-send the DOI
 * confirmation to the corrected address and stamp confirmation_sent_at on
 * success. Fire-and-forget safe — never throws (the customer edit already
 * committed; a failed re-send logs and leaves the pending row for the
 * stale-pending sweep / a fresh signup). Call AFTER the edit transaction
 * commits, never inside it.
 */
async function resendPendingConfirmation(pendingConfirmation, conn = db) {
  if (!pendingConfirmation) return false;
  try {
    await require('./newsletter-confirm').sendConfirmationEmail(pendingConfirmation);
    await conn('newsletter_subscribers')
      .where({ id: pendingConfirmation.id })
      .update({ confirmation_sent_at: new Date(), updated_at: new Date() });
    return true;
  } catch (e) {
    // Provider error bodies can echo the recipient address — log only the
    // subscriber id and a sanitized code (this path exists BECAUSE the email
    // is being corrected; it must not leak into logs).
    logger.warn(`[email-fanout] DOI confirmation re-send failed for subscriber ${pendingConfirmation.id}: ${e.code || e.statusCode || 'send_failed'}`);
    return false;
  }
}

// Operator-facing disclosure of everything this fan-out touches. The IB
// confirmation-card summary AND the update_customer tool description both
// render THIS string, so the disclosure can never silently drift from the
// service's actual side effects — extend it in the same commit that adds a
// new synced surface.
const EMAIL_FANOUT_DISCLOSURE = 'an email change also syncs every open copy of the old address (leads, estimates, newsletter, automations, queued template sends, referral promoter, billing pref, contracts, booking recovery) and resolves open email review cards';

module.exports = { propagateCustomerEmailChange, resendPendingConfirmation, emailKey, EMAIL_FANOUT_DISCLOSURE };
