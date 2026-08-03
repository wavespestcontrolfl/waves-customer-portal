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
 *     Customer-linked rows only — email equality alone never proves an
 *     unlinked row is this customer's (retargeting a stranger's sends is a
 *     P0), so the known unlinked-enrollment gap awaits an
 *     ownership-verified backfill instead.
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

const { randomUUID } = require('crypto');
const db = require('../models/db');
const logger = require('./logger');
const { cleanValidEmailOrNull } = require('../utils/intake-normalize');
const { lockTriageCall } = require('../utils/triage-locks');

// Mirrors customer-address-fanout (which mirrors SENDABLE_ESTIMATE_STATUSES in
// routes/admin-estimates.js and CLOSED_STATUSES in intelligence-bar/leads-tools.js).
// 'sending' is absent from THIS list (no estimate_data touch under an
// in-flight send) but gets its own column-only customer_email sync below —
// this service is diff-gated, so "heal on the next fan-out" never comes.
const OPEN_ESTIMATE_STATUSES = ['draft', 'scheduled', 'sent', 'viewed', 'send_failed'];
const TERMINAL_LEAD_STATUSES = ['won', 'lost', 'disqualified', 'duplicate', 'unresponsive'];

// Mirrors OPEN_STATES in routes/admin-triage.js.
const OPEN_REVIEW_STATES = ['open', 'in_progress'];
// customer_email_missing (codex round-7 P2): a call that booked WITHOUT an
// email files this card; once a valid email lands on the profile the card's
// job is done — same lifecycle as the read-back cards, same resolution
// safety (only a syntactically valid NEW address settles any of these).
const EMAIL_REVIEW_REASON_CODES = ['email_unverified', 'email_invalid', 'customer_email_missing'];

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
/**
 * Resolve every open email review card (EMAIL_REVIEW_REASON_CODES) for the
 * customer's calls and keep call_log.review_status in sync. Standalone so the
 * CALL-path email writes can settle cards too (codex round-9 P2, PR #3119):
 * backfillCustomerFromAppointmentContact and the phone-match upsert write
 * customers.email directly, bypassing propagateCustomerEmailChange — without
 * this, a caller who booked email-less and supplied the email on a LATER
 * call kept an open customer_email_missing card forever.
 *
 * Same validity gate as the fanout: an invalid `email` resolves nothing.
 * `reasonCodes` narrows WHICH cards settle (always intersected with
 * EMAIL_REVIEW_REASON_CODES): the call path passes ['customer_email_missing']
 * only — a call-captured email is unverified BY DESIGN, so it must never
 * settle the email_unverified / email_invalid read-back cards the bridge
 * files for that very capture (codex round-10 P2). An OPERATOR-asserted
 * email (the fanout) settles all three.
 * Returns the number of cards resolved; never throws on a no-op.
 */
async function resolveOpenEmailReviewCards({ customerId, email, source = 'customer edit', reasonCodes = EMAIL_REVIEW_REASON_CODES }, conn = db) {
  if (!customerId || !cleanValidEmailOrNull(email)) return 0;
  const codes = reasonCodes.filter((c) => EMAIL_REVIEW_REASON_CODES.includes(c));
  if (!codes.length) return 0;
  const now = new Date();
  const openItems = await conn('triage_items')
    .whereIn('reason_code', codes)
    .whereIn('status', OPEN_REVIEW_STATES)
    .whereIn('call_log_id', conn('call_log').select('id').where({ customer_id: customerId }))
    .select('id', 'call_log_id');
  if (!openItems.length) return 0;
  // Shared per-call lock contract (utils/triage-locks.js) with the nightly
  // auto-resolve sweep and admin-triage: sorted acquisition BEFORE any card
  // write, inside a transaction, so overlapping writers on the same call
  // serialize instead of deadlocking (an aborted deadlock here would roll
  // back the caller's email edit).
  const resolveCards = async (trx) => {
    const callIds = [...new Set(openItems.map((i) => i.call_log_id).filter(Boolean))].sort();
    for (const callId of callIds) await lockTriageCall(trx, callId);
    const updated = await trx('triage_items')
      .whereIn('id', openItems.map((i) => i.id))
      .whereIn('status', OPEN_REVIEW_STATES)
      .update({
        status: 'resolved',
        resolution_note: `Email corrected on the customer record (${String(source).slice(0, 100)})`,
        resolved_at: now,
        updated_at: now,
      });
    for (const callId of callIds) {
      const stillOpen = await trx('triage_items')
        .where({ call_log_id: callId })
        .whereIn('status', OPEN_REVIEW_STATES)
        .count('* as n')
        .first();
      await trx('call_log')
        .where({ id: callId })
        .update({ review_status: parseInt(stillOpen?.n || 0, 10) > 0 ? 'open' : 'resolved', updated_at: now });
    }
    return updated;
  };
  return conn.isTransaction ? resolveCards(conn) : conn.transaction(resolveCards);
}

/**
 * `reviewReasonCodes` narrows which review cards the fanout settles, exactly
 * as in resolveOpenEmailReviewCards. The CALL path passes
 * ['customer_email_missing'] when it REPLACES a garbled stored email with a
 * call capture: the retargeting (leads, estimates, newsletter tokens, open
 * sends) must run because an old address really is out there, but the capture
 * is still unverified BY DESIGN, so it must not settle the email_unverified /
 * email_invalid read-back cards filed for that very capture (round-10 P2).
 * An OPERATOR-asserted edit keeps the default and settles all three.
 */
async function propagateCustomerEmailChange({
  before, after, source = 'customer edit', reviewReasonCodes = EMAIL_REVIEW_REASON_CODES,
}, conn = db) {
  const counts = { leads: 0, estimates: 0, newsletter: 0, newsletterDeliveries: 0, automations: 0, templateRuns: 0, promoters: 0, billingPrefs: 0, contracts: 0, bookingIntents: 0, reviewCards: 0 };
  let pendingConfirmation = null;
  const customerId = (after && after.id) || (before && before.id);
  // OLD is a loose match key (the stored copy may itself be malformed — that
  // is exactly what gets corrected); NEW must be a syntactically VALID
  // address before it fans out anywhere or settles a review card — an
  // operator typo like "foo@bar" must not overwrite deliverable copies or
  // resolve an email_invalid card with another invalid value.
  // A stored value with no at-sign ("not-an-email", a garbled call capture)
  // is still a REAL string sitting in the snapshot columns — emailKey drops
  // it to '', which skipped every retarget below and left leads, estimates,
  // automations and queued sends permanently bound to it (codex round-24 P2).
  // Fall back to the normalized raw value: it can only ADD matches that
  // previously matched nothing, and an empty/absent old value still yields ''
  // (nothing to retarget), which is the pre-existing behavior.
  const oldEmail = emailKey(before && before.email)
    || String((before && before.email) ?? '').trim().toLowerCase();
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
    // are history and stay untouched. CUSTOMER-LINKED rows only: email
    // equality alone does not prove an unlinked row belongs to this customer
    // (the typo can be someone ELSE'S real address), and retargeting a
    // stranger's enrollment would redirect their messages and PII to our
    // customer. The unlinked-enrollment gap (estimate follow-ups enroll with
    // customer_id null) is real but needs an ownership-verified backfill,
    // never an email-only match.
    counts.automations += await conn('automation_enrollments')
      .where({ customer_id: customerId, status: 'active' })
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
    // Same ownership rule as enrollments: recipient-linked rows only —
    // email-only matching could retarget another person's queued sends.
    // Per-row instead of set-based: the stored payload can carry the email
    // as a TEMPLATE VARIABLE ({{customer_email}} in portal.invite et al.),
    // and the executor renders from that payload — syncing the recipient
    // while the body still displays the typo would be half a fix. Only
    // payload keys whose value equals the OLD email are rewritten; each
    // update re-asserts status/recipient so a concurrent claim wins.
    const runRows = await conn('email_template_automation_runs')
      .whereIn('status', ['queued', 'scheduled', 'retry_scheduled'])
      .where({ recipient_id: String(customerId) })
      .whereRaw('LOWER(recipient_email) = ?', [oldEmail])
      .select('id', 'payload');
    for (const row of runRows) {
      const payload = row.payload && typeof row.payload === 'object' ? { ...row.payload } : null;
      let payloadPatched = false;
      if (payload) {
        for (const key of ['customer_email', 'recipient_email', 'email']) {
          if (emailKey(payload[key]) === oldEmail) {
            payload[key] = newEmail;
            payloadPatched = true;
          }
        }
      }
      counts.templateRuns += await conn('email_template_automation_runs')
        .where({ id: row.id, recipient_id: String(customerId) })
        .whereIn('status', ['queued', 'scheduled', 'retry_scheduled'])
        .whereRaw('LOWER(recipient_email) = ?', [oldEmail])
        .update({
          recipient_email: newEmail,
          ...(payloadPatched ? { payload: JSON.stringify(payload) } : {}),
          updated_at: now,
        });
    }

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
    // IS NOT TRUE mirrors the recovery sender's own pending predicate —
    // the flags are nullable and NULL counts as unsent there.
    counts.bookingIntents += await conn('booking_intents')
      .where({ customer_id: customerId })
      .whereRaw('followup_email_sent IS NOT TRUE')
      .whereRaw('suppressed IS NOT TRUE')
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
      // The old inbox's already-DELIVERED quiz/feedback/event links must stop
      // resolving once the address moves — each delivery row's engagement_token
      // is a bearer credential mailed to the OLD mailbox (which, on a typo fix,
      // can be a real third party's inbox). Rotate them per-row BEFORE the
      // merge branch's del() below sets subscriber_id NULL and strands them.
      // gen_random_uuid() is volatile (fresh value per row), so the unique
      // index on engagement_token holds. Answered quizzes/feedback are keyed
      // by delivery id, not token — nothing recorded is lost — and future
      // sends read the token at send time, so they pick up the new values.
      counts.newsletterDeliveries += await conn('newsletter_send_deliveries')
        .where({ subscriber_id: oldSub.id })
        .update({ engagement_token: conn.raw('gen_random_uuid()'), updated_at: now });
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
        // ROTATE both bearer tokens with the move: the old confirmation and
        // unsubscribe links were DELIVERED to the old mailbox (DOI email,
        // newsletter footers), and a typo address can be a real third
        // party's inbox — the stale tokens would let that mailbox confirm
        // or unsubscribe the corrected address.
        const freshConfirmationToken = randomUUID();
        counts.newsletter += await conn('newsletter_subscribers')
          .where({ id: oldSub.id })
          .update({
            email: newEmail,
            confirmation_token: freshConfirmationToken,
            unsubscribe_token: randomUUID(),
            updated_at: now,
          });
        // A PENDING row's DOI confirmation went to the old typo — hand the
        // caller what it needs to re-send post-commit (see @returns), keyed
        // to the FRESH token (the old one is dead by design).
        if (String(oldSub.status || '') === 'pending') {
          pendingConfirmation = {
            id: oldSub.id,
            email: newEmail,
            first_name: oldSub.first_name || null,
            confirmation_token: freshConfirmationToken,
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
  counts.reviewCards += await resolveOpenEmailReviewCards({
    customerId, email: newEmail, source, reasonCodes: reviewReasonCodes,
  }, conn);

  if (Object.values(counts).some(Boolean)) {
    // Counts only — never the email values (PII stays out of logs).
    logger.info(`[email-fanout] customer ${customerId}: synced ${counts.leads} lead(s), ${counts.estimates} estimate(s), ${counts.newsletter} newsletter (${counts.newsletterDeliveries} delivery token(s) rotated), ${counts.automations} enrollment(s), ${counts.templateRuns} template run(s), ${counts.promoters} promoter(s), ${counts.billingPrefs} billing pref(s), ${counts.contracts} contract(s), ${counts.bookingIntents} booking intent(s); resolved ${counts.reviewCards} email review card(s)`);
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
const EMAIL_FANOUT_DISCLOSURE = 'an email change also updates every open send still targeting the old email address (leads, estimates, newsletter, automations, queued template sends, referral promoter, billing pref, contracts, booking recovery) and resolves open email review cards';

/**
 * Apply an AUTOMATED intake writer's updates to an existing customer row,
 * serializing an email backfill against a concurrent customer-merge UNDO.
 *
 * customers.email has NO unique constraint, and revertMerge (customer-
 * dedupe.js) restores a merged-away customer's email only after an explicit
 * "is this address claimed by another live customer?" check — a check that
 * is only honest if everything that ASSIGNS an email onto a customer row
 * serializes with it. The operator-driven writers (Customer 360 edit, IB
 * update_customer) already take the shared advisory lock; this helper
 * extends it to the automated backfill writers (lead webhook, public quote,
 * call pipeline), which fill an EXISTING customer's empty email from
 * unauthenticated intake data.
 *
 * KEY DERIVATION (must stay byte-identical to customer-dedupe.js,
 * routes/admin-customers.js and intelligence-bar/tools.js — extend ALL in
 * the same commit): pg_advisory_xact_lock(hashtextextended(
 *   'customer-email:' || lower(trim(<email>)), 0)) — transaction-scoped,
 * released on commit/rollback, so the hold is only ever as long as this
 * one small write.
 *
 * LOCK ORDER matches revertMerge (customer row locks BEFORE the advisory
 * email lock): the customer row is locked FOR UPDATE first, then the
 * advisory lock is taken — so an undo holding the row lock never waits on
 * a writer that holds the advisory lock (no cycle, no deadlock abort).
 *
 * PROCEED-WITH-FRESH-READ semantics — this guard must NEVER turn an intake
 * write into a failure:
 *   - the row and the claim state are re-read UNDER the locks, and only
 *     the email COLUMN is dropped when the fresh state disqualifies it
 *     (someone filled the email while we waited, or another live customer —
 *     e.g. a just-restored merge loser — now owns the address); every other
 *     update still lands;
 *   - if the guarded transaction itself fails for any reason, the updates
 *     are re-applied WITHOUT the email exactly as the caller would have
 *     written them before this guard existed.
 * Returns { emailApplied, emailDroppedReason } for the caller's logging.
 */
async function applyCustomerUpdatesWithEmailClaimGuard({
  customerId, updates, source = 'intake',
  // REPLACEMENT mode (the garbled-stored-email rule, call-recording-
  // processor round-12/round-24): the caller read an EMAIL_RE-failing
  // stored value and intends to replace it. `replaceExpectedEmail` is that
  // pre-read value — under the row lock the write proceeds only if the
  // stored email is STILL that exact value (anything else means someone
  // fixed it while we waited, and the standing value wins). Because a
  // replacement has an old address with live copies out there,
  // `applyWithEmailInTrx(trx)` lets the caller run the customer write and
  // the required fan-out in THIS guarded transaction, so the claim
  // serialization, the write, and the fan-out commit or roll back as one.
  replaceExpectedEmail = null,
  applyWithEmailInTrx = null,
}) {
  const emailKeyNorm = emailKey(updates.email);
  if (!updates.email || !emailKeyNorm) {
    // No email being assigned (or not an address at all) — nothing to
    // serialize; write exactly as before.
    await db('customers').where({ id: customerId }).update(updates);
    return { emailApplied: false, emailDroppedReason: null };
  }
  try {
    return await db.transaction(async (trx) => {
      const fresh = await trx('customers').where({ id: customerId }).forUpdate().first('id', 'email');
      if (!fresh) return { emailApplied: false, emailDroppedReason: 'customer row gone' };
      const standingValueBlocks = replaceExpectedEmail == null
        ? !!fresh.email
        : String(fresh.email || '') !== String(replaceExpectedEmail);
      if (standingValueBlocks) {
        // Filled (or fixed) while we waited — operator edit, merge
        // backfill, a racing intake. The standing value wins; automated
        // intake never overwrites an email it did not read pre-lock, only
        // backfills an empty one or replaces the exact garbled value it
        // saw.
        const { email: _dropped, ...rest } = updates;
        if (Object.keys(rest).length) await trx('customers').where({ id: customerId }).update(rest);
        return { emailApplied: false, emailDroppedReason: 'email filled concurrently' };
      }
      await trx.raw('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [`customer-email:${emailKeyNorm}`]);
      // Same claim probe revertMerge runs: an address owned by ANOTHER live
      // customer (typically the just-restored loser of an undone merge) is
      // someone else's registered mailbox — never backfill it here.
      const claimant = await trx('customers')
        .whereRaw('lower(email) = ?', [emailKeyNorm])
        .whereNot({ id: customerId })
        .where('active', true)
        .whereNull('deleted_at')
        .first('id');
      if (claimant) {
        const { email: _dropped, ...rest } = updates;
        if (Object.keys(rest).length) await trx('customers').where({ id: customerId }).update(rest);
        return { emailApplied: false, emailDroppedReason: 'address now belongs to another live customer' };
      }
      if (applyWithEmailInTrx) {
        await applyWithEmailInTrx(trx);
      } else {
        await trx('customers').where({ id: customerId }).update(updates);
      }
      return { emailApplied: true, emailDroppedReason: null };
    });
  } catch (e) {
    // The guard must never block the intake write into failure: drop the
    // email fill (the lead/quote/call record still carries the address for
    // staff) and apply the rest exactly as the pre-guard code did. For a
    // REPLACEMENT this also rolls the fan-out and the email write back
    // together — the malformed stored value stays, which is the state a
    // later call can retry from (round-24 semantics).
    logger.warn(`[email-fanout] email-claim guard failed for ${source} (customer ${customerId}) — applying updates without the email backfill: ${e.message}`);
    const { email: _dropped, ...rest } = updates;
    if (Object.keys(rest).length) await db('customers').where({ id: customerId }).update(rest);
    return { emailApplied: false, emailDroppedReason: `guard failed: ${e.message}` };
  }
}

module.exports = {
  propagateCustomerEmailChange,
  resolveOpenEmailReviewCards,
  resendPendingConfirmation,
  emailKey,
  EMAIL_FANOUT_DISCLOSURE,
  applyCustomerUpdatesWithEmailClaimGuard,
};
