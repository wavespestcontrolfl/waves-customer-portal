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
async function resolveOpenEmailReviewCards({ customerId, email, source = 'customer edit', reasonCodes = EMAIL_REVIEW_REASON_CODES, restrictToCallLogIds = null }, conn = db) {
  if (!customerId || !cleanValidEmailOrNull(email)) return 0;
  const codes = reasonCodes.filter((c) => EMAIL_REVIEW_REASON_CODES.includes(c));
  if (!codes.length) return 0;
  const now = new Date();
  // restrictToCallLogIds (Codex #3084 r49): a transactional caller that
  // already holds row locks (the fanout's hold FOR UPDATE) passes the call
  // set whose advisory locks it pre-acquired — settling a card on a call
  // OUTSIDE that set would acquire its advisory lock AFTER those row locks,
  // the inversion the global order forbids. Standalone callers (own
  // transaction, advisory-first inside resolveCards) pass nothing.
  const openItemsQuery = conn('triage_items')
    .whereIn('reason_code', codes)
    .whereIn('status', OPEN_REVIEW_STATES)
    .whereIn('call_log_id', conn('call_log').select('id').where({ customer_id: customerId }))
    .select('id', 'call_log_id');
  if (restrictToCallLogIds) openItemsQuery.whereIn('call_log_id', restrictToCallLogIds);
  const openItems = await openItemsQuery;
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
  const counts = { leads: 0, estimates: 0, newsletter: 0, newsletterDeliveries: 0, automations: 0, templateRuns: 0, promoters: 0, billingPrefs: 0, contracts: 0, bookingIntents: 0, reviewCards: 0, heldDripResumed: 0 };
  let pendingConfirmation = null;
  let heldNewsletterResume = null;
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

  // The review scope IS the authority signal (Codex #3084 r49): the default
  // scope (all of EMAIL_REVIEW_REASON_CODES) means an OPERATOR asserted this
  // address — it settles the read-back cards. The call path narrows to
  // ['customer_email_missing'] precisely because a call-captured address is
  // unverified BY DESIGN: it may retarget the plain snapshot copies (an old
  // address really is out there, possibly hard-bouncing), but it must NEVER
  // touch the hold ledger or release a held first-touch send — the holds
  // exist to park sends until a human confirms the address, and the capture's
  // own read-back card is still open. Everything below that treats newEmail
  // as approved (hold retargets, deny-stamp lifts, zero-work markers, the
  // r34 evidence writes, and the resume) is gated on this.
  const operatorAssertedEmail = ['email_unverified', 'email_invalid']
    .every((code) => reviewReasonCodes.includes(code));

  const now = new Date();

  // Lock-order discipline (Codex #3084 r30): the release engine's enroll
  // transaction locks first_touch_holds FOR UPDATE and then writes
  // automation_enrollments; this fan-out previously locked enrollment rows
  // (the sync below) and THEN waited on the hold retargets — a classic
  // cycle Postgres resolves by aborting one side (a 500 on the customer
  // edit, or a delayed release). Take the customer's hold-row locks FIRST,
  // so both paths acquire first_touch_holds → automation_enrollments in
  // the same order. Later hold updates re-lock rows this transaction
  // already owns. ALL of the customer's hold rows (any status): the lock
  // wait itself is the serialization point, and a release that just
  // settled its row mid-wait must still surface its target below.
  // The locked rows also yield the holds' PRIOR TARGETS (Codex #3084
  // r31): the held extraction can deliberately differ from the customer's
  // stored old email, so an enrollment created by a release at extracted
  // address X would be invisible to an oldEmail-only sweep — and its
  // immediately-due steps would keep mailing the address the operator
  // just rejected. Every distinct prior hold target joins the enrollment
  // sweeps' match set.
  let priorHoldTargets = [];
  let heldCallIds = [];
  // GLOBAL LOCK ORDER (owner ruling 2026-08-02): advisory call lock →
  // first_touch_holds rows → triage_items. This fan-out settles review
  // cards (resolveOpenEmailReviewCards below) and writes review evidence
  // for the held calls AFTER taking hold-row locks — acquiring advisory
  // locks at those later points would be the exact AB-BA inversion against
  // admin-triage (which holds advisory and then waits on hold rows).
  // Pre-lock every call of the customer, sorted: per-call advisory locks
  // are cheap, contention is per-customer, and re-acquiring one later is a
  // no-op. The snapshot is ALSO the fence for every later lock in this
  // transaction (Codex #3084 r49): the hold-row FOR UPDATE below and the
  // card settle in resolveOpenEmailReviewCards are both restricted to these
  // call ids, so this transaction never locks a row belonging to a call
  // whose advisory lock it does not hold — a call committed after this
  // snapshot is simply outside this correction's scope (its own release
  // lane owns it; fail-toward-hold). Outside a transaction the
  // pg_advisory_xact_lock releases immediately (same non-guarantee as the
  // FOR UPDATE for non-transactional callers — unchanged behavior), so no
  // snapshot fence applies there either.
  let snapshotCallIds = null;
  if (conn.isTransaction) {
    const callRows = await conn('call_log').where({ customer_id: customerId }).select('id');
    snapshotCallIds = [...new Set(callRows.map((r) => r.id).filter(Boolean))].sort();
    for (const callId of snapshotCallIds) await lockTriageCall(conn, callId);
  }
  const holdsTableExists = await conn.schema.hasTable('first_touch_holds');
  if (operatorAssertedEmail && holdsTableExists) {
    let holdsLockQuery = conn('first_touch_holds')
      .where({ customer_id: customerId });
    if (snapshotCallIds) holdsLockQuery = holdsLockQuery.whereIn('call_log_id', snapshotCallIds);
    const lockedHolds = await holdsLockQuery
      .forUpdate()
      .select('id', 'held_email', 'call_log_id');
    const newEmailLc = newEmail.toLowerCase();
    priorHoldTargets = [...new Set(
      lockedHolds
        .map((r) => String(r.held_email || '').trim().toLowerCase())
        .filter((e) => e && e !== newEmailLc && e !== oldEmail),
    )];
    // The held calls also drive the r34 review-evidence writes below.
    heldCallIds = [...new Set(lockedHolds.map((r) => r.call_log_id).filter(Boolean))];
  }

  // Set when the oldEmail newsletter pass below leaves a subscriber row at
  // the corrected address (retarget or merge) — the r40 prior-target pass
  // reads it to avoid a redundant existence check.
  let subscriberAtCorrectedAddress = false;

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
    // Snapshot read WITHOUT a lock, then deliveries, THEN the FOR UPDATE
    // re-read (Codex #3084 r46): the SendGrid webhook writes a delivery
    // row and then its subscriber (webhooks-sendgrid handleNewsletterEvent)
    // — locking the subscriber before touching its deliveries here was the
    // reverse acquisition order, a deadlock Postgres breaks by aborting
    // the customer edit or the webhook. The locked re-read (not the
    // snapshot) drives every status decision below, so the r43/r44 opt-out
    // safety is unchanged: an unsubscribe committing before our lock is
    // seen; one committing after it waits on the row lock.
    const oldSubSnapshot = await conn('newsletter_subscribers')
      .where({ customer_id: customerId })
      .whereRaw('LOWER(email) = ?', [oldEmail])
      .first('id');
    let oldSub = null;
    if (oldSubSnapshot) {
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
        .where({ subscriber_id: oldSubSnapshot.id })
        .update({ engagement_token: conn.raw('gen_random_uuid()'), updated_at: now });
      oldSub = await conn('newsletter_subscribers')
        .where({ id: oldSubSnapshot.id })
        .forUpdate()
        .first();
    }
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
        // Status CAS (r44): an unsubscribe committing after the snapshot
        // wins — the opt-out record is never deleted.
        counts.newsletter += await conn('newsletter_subscribers')
          .where({ id: oldSub.id })
          .whereIn('status', ['pending', 'active'])
          .del();
      } else {
        // ROTATE both bearer tokens with the move: the old confirmation and
        // unsubscribe links were DELIVERED to the old mailbox (DOI email,
        // newsletter footers), and a typo address can be a real third
        // party's inbox — the stale tokens would let that mailbox confirm
        // or unsubscribe the corrected address.
        const freshConfirmationToken = randomUUID();
        // Status CAS (r44): a concurrent unsubscribe wins — its record
        // stays at the old address, unmoved, and no confirmation is
        // re-sent for it.
        const moved = await conn('newsletter_subscribers')
          .where({ id: oldSub.id })
          .whereIn('status', ['pending', 'active'])
          .update({
            email: newEmail,
            confirmation_token: freshConfirmationToken,
            unsubscribe_token: randomUUID(),
            // A pending row's delivered-stamp attests a DOI sent to the OLD
            // address — carried onto the corrected row it would make the
            // resume path's dedupe guard treat this subscriber as recently
            // delivered and settle holds without ever sending a usable link
            // (Codex #3084 r18). Confirmed rows keep theirs (audit only —
            // the guard reads pending rows exclusively).
            confirmation_sent_at: conn.raw("CASE WHEN status = 'pending' THEN NULL ELSE confirmation_sent_at END"),
            updated_at: now,
          });
        counts.newsletter += moved;
        // A PENDING row's DOI confirmation went to the old typo — hand the
        // caller what it needs to re-send post-commit (see @returns), keyed
        // to the FRESH token (the old one is dead by design). Only when the
        // move actually landed (r44).
        if (moved && String(oldSub.status || '') === 'pending') {
          pendingConfirmation = {
            id: oldSub.id,
            email: newEmail,
            first_name: oldSub.first_name || null,
            confirmation_token: freshConfirmationToken,
          };
        }
        // The retarget branch leaves a subscriber at the corrected address
        // only when the move landed (r44); the merge branch always does
        // (targetSub exists there).
        subscriberAtCorrectedAddress = subscriberAtCorrectedAddress || moved > 0;
      }
      if (targetSub) subscriberAtCorrectedAddress = true;
    }
  }

  // The hold lane can ADOPT-LINK a subscriber at a held extraction address
  // the stored email never matched (Codex #3084 r40): a resumed DOI creates
  // subscriber X and links it to this customer while customers.email still
  // says A. The oldEmail-keyed pass above never selects X, so a later
  // correction A→B would strand X's confirmation/unsubscribe tokens on the
  // operator-rejected mailbox and let the next resume mint a SECOND
  // subscriber at B. Ownership-safe by construction: customer_id-bound
  // selection only — an unlinked or foreign-owned row at a prior target is
  // never touched (the extraction can be a stranger's real address).
  // Shared by the pre-pass (priorHoldTargets) AND the post-merge late pass
  // (r56): a raced release can create/adopt-link a subscriber at a hold
  // target the pre-lock snapshot never saw — when the marker merge later
  // recovers that target, the SAME subscriber/token fanout must run for it,
  // or the DOI/unsubscribe bearer links delivered to the rejected mailbox
  // stay valid after the record moves to the corrected address.
  const retargetSubscribersAtRejectedTargets = async (targets) => {
    // Unlocked snapshot → deliveries → FOR UPDATE re-read (Codex #3084
    // r43/r46): the retarget and delete act on the LOCKED read's status,
    // so an unsubscribe committing after our lock waits and one before it
    // is seen — while the delivery rotation happens BEFORE the subscriber
    // locks, matching the SendGrid webhook's delivery-then-subscriber
    // write order (no deadlock cycle). The status predicates on the
    // writes below are the belt for callers outside a transaction.
    const priorTargetSnapshot = await conn('newsletter_subscribers')
      .where({ customer_id: customerId })
      .where(function atPriorTargets() {
        for (const target of targets) this.orWhereRaw('LOWER(email) = ?', [target]);
      })
      .select('id');
    let priorTargetSubs = [];
    if (priorTargetSnapshot.length) {
      // Bearer links already DELIVERED to the prior targets die regardless
      // of what happens to each row (the r18 rule — a rejected extraction
      // can be a real third party's inbox).
      for (const sub of priorTargetSnapshot) {
        counts.newsletterDeliveries += await conn('newsletter_send_deliveries')
          .where({ subscriber_id: sub.id })
          .update({ engagement_token: conn.raw('gen_random_uuid()'), updated_at: now });
      }
      priorTargetSubs = await conn('newsletter_subscribers')
        .whereIn('id', priorTargetSnapshot.map((s) => s.id))
        .forUpdate()
        .select('*');
    }
    if (priorTargetSubs.length) {
      // 'unsubscribed' (or any other status) is an opt-out record — never
      // retargeted, never deleted; only its delivered links rotate above.
      const eligible = priorTargetSubs.filter((s) => ['pending', 'active'].includes(String(s.status || '')));
      let hasRowAtNewEmail = subscriberAtCorrectedAddress;
      if (!hasRowAtNewEmail && eligible.length) {
        hasRowAtNewEmail = Boolean(await conn('newsletter_subscribers')
          .whereRaw('LOWER(email) = ?', [newEmail])
          .first());
      }
      let retargetSub = null;
      if (!hasRowAtNewEmail && eligible.length) {
        retargetSub = eligible.find((s) => String(s.status || '') === 'pending') || eligible[0];
      }
      // Redundant rows (same person, rejected addresses) go away rather
      // than colliding with the unique index on a later correction. The
      // status CAS (r43) refuses when an unsubscribe committed after the
      // snapshot — an opt-out record is never deleted.
      for (const sub of eligible) {
        if (retargetSub && sub.id === retargetSub.id) continue;
        counts.newsletter += await conn('newsletter_subscribers')
          .where({ id: sub.id })
          .whereIn('status', ['pending', 'active'])
          .del();
      }
      if (retargetSub) {
        const freshConfirmationToken = randomUUID();
        // Status CAS (r43): a concurrent unsubscribe wins — the retarget
        // must never overwrite an opt-out with 'pending' and queue a
        // fresh confirmation.
        const retargeted = await conn('newsletter_subscribers')
          .where({ id: retargetSub.id })
          .whereIn('status', ['pending', 'active'])
          .update({
            email: newEmail,
            confirmation_token: freshConfirmationToken,
            unsubscribe_token: randomUUID(),
            // Unlike the stored-address move above, a prior-target row's
            // DOI state belongs to the REJECTED mailbox: an 'active' row
            // here was confirmed by whoever reads X, not by the corrected
            // address — demote to pending and let the corrected inbox
            // confirm for itself.
            status: 'pending',
            confirmed_at: null,
            confirmation_sent_at: null,
            updated_at: now,
          });
        counts.newsletter += retargeted;
        if (retargeted && !pendingConfirmation) {
          pendingConfirmation = {
            id: retargetSub.id,
            email: newEmail,
            first_name: retargetSub.first_name || null,
            confirmation_token: freshConfirmationToken,
          };
        }
        if (retargeted) subscriberAtCorrectedAddress = true;
      }
    }
  };
  if (priorHoldTargets.length) await retargetSubscribersAtRejectedTargets(priorHoldTargets);

  // The operator asserting a NEW email on the record answers any open
  // read-back question for this customer's calls — resolve those cards and
  // keep call_log.review_status in sync (mirrors transitionCore in
  // routes/admin-triage.js). Scoped to email reason codes only: address or
  // booking reviews on the same call are untouched.
  counts.reviewCards += await resolveOpenEmailReviewCards({
    customerId, email: newEmail, source, reasonCodes: reviewReasonCodes,
    restrictToCallLogIds: snapshotCallIds,
  }, conn);


  // A correction that answers a call's read-back BEFORE the processor's
  // Step-6 hold write must still leave its answer in the ledger (Codex
  // #3084 r9): in that window the card exists but no first_touch_holds
  // row does, so the resume above had nothing to release — and the
  // processor would later record (and end-of-run release) the stale
  // pre-correction address. A SETTLED marker row keyed to the call makes
  // recordFirstTouchHold's released-during-run guard adopt the corrected
  // address instead. Covers cards in ANY state, not just open ones (Codex
  // #3084 r11): a non-releasing deny can resolve the card before the
  // correction arrives, and the end-of-run reconciliation would read that
  // resolved-during-run card as confirmation of the stale address.
  // onConflict-ignore: real hold rows are never clobbered; errors propagate
  // with the rest of the edit transaction.
  // Gated on operatorAssertedEmail (Codex #3084 r49): every write in this
  // block treats newEmail as an approved address — retargets, deny-stamp
  // lifts, zero-work markers, the r34 evidence flips. A narrowed
  // (call-capture) scope must leave the ledger exactly as the open
  // read-back card demands: held.
  if (operatorAssertedEmail && holdsTableExists) {
    // A claim already in flight ('releasing') can't be re-claimed by this
    // correction — supersede its TARGET so any retry of that claim (every
    // failure path re-pends, and the ledger sweep re-triggers) resumes to
    // the NEWEST corrected address, not the value captured at claim time
    // (Codex #3084 r12). updated_at is deliberately untouched: bumping it
    // would extend a possibly-dead claimant's stale-claim window.
    // The deny stamp lifts here too (Codex #3084 r22): the correction's own
    // resume cannot claim a releasing row, and the in-flight worker's
    // deny-safe settle would re-pend it with the stamp preserved — leaving
    // the sweep to exclude the corrected hold forever. The correction is an
    // explicit operator approval of the new address, on active claims
    // exactly as on pending rows. A deny-stamped releasing row is also
    // OWNERLESS by construction (Codex #3084 r29): the deny's updated_at
    // bump invalidated every outstanding lease, so no worker can settle or
    // re-pend it, and leaving it 'releasing' would park the corrected
    // release behind the full stale-claim timeout. Flip exactly those rows
    // back to 'pending' with the retarget, so this correction's own resume
    // (below) claims and releases them immediately.
    // Snapshot-fenced like every other hold lock in this transaction
    // (Codex #3084 r50): a hold committed after the advisory snapshot must
    // not be retargeted, claimed, or released here — its call's advisory
    // lock was never acquired and its cards were outside the restricted
    // resolve. Non-transactional callers carry no snapshot (no locks
    // persist there anyway).
    let releasingRetarget = conn('first_touch_holds')
      .where({ customer_id: customerId, status: 'releasing' });
    if (snapshotCallIds) releasingRetarget = releasingRetarget.whereIn('call_log_id', snapshotCallIds);
    await releasingRetarget
      .update({
        held_email: newEmail,
        // The EXPLICIT correction marker (Codex #3084 r39): only these
        // fanout retargets write it, so recordFirstTouchHold's merge can
        // distinguish an operator-asserted target from a claim/re-pend
        // bump when deciding what a reprocess may overwrite.
        corrected_at: now,
        status: conn.raw("CASE WHEN last_error = 'email_denied_await_correction' THEN 'pending' ELSE status END"),
        last_error: conn.raw("CASE WHEN last_error = 'email_denied_await_correction' THEN NULL ELSE last_error END"),
      });
    // PENDING rows durably adopt the corrected address too, BEFORE the
    // release attempt below (Codex #3084 r18): resumeHeldFirstTouch never
    // throws — a transient failure re-pends the row and returns — and this
    // edit transaction still commits, so without the retarget the sweep
    // would later release the ledger's OLD (rejected) address with no email
    // override in sight. The correction is an explicit operator approval of
    // the new address, so it also lifts a deny stamp: a sweep release of
    // the retargeted row sends exactly what this fanout release would have.
    let pendingRetarget = conn('first_touch_holds')
      .where({ customer_id: customerId, status: 'pending' });
    if (snapshotCallIds) pendingRetarget = pendingRetarget.whereIn('call_log_id', snapshotCallIds);
    await pendingRetarget
      .update({
        held_email: newEmail,
        corrected_at: now,
        last_error: conn.raw("CASE WHEN last_error = 'email_denied_await_correction' THEN NULL ELSE last_error END"),
        updated_at: now,
      });
    // Second enrollment sweep, AFTER the hold retargets (Codex #3084 r26):
    // the first sync above ran before these statements waited out an
    // in-flight claimant's row lock (a transactional release claims the
    // hold, then enrolls) — an enrollment INSERTED inside that open claim
    // was invisible to it, and the releasing-row retarget alone leaves the
    // fresh enrollment mailing the superseded address. This re-sweep
    // executes after the lock wait, sees the claimant's committed insert,
    // and retargets it. Idempotent with the first sweep; same ownership
    // guard (customer-linked, active). Matches the holds' PRIOR TARGETS
    // too (Codex #3084 r31): a release enrolls at the HELD extraction,
    // which can differ from the customer's stored old email — an
    // oldEmail-only match would leave that enrollment mailing the
    // rejected (possibly hard-bounced) address forever.
    // Scoped to the new_lead template (Codex #3084 r39): the hold lane
    // only ever creates new_lead enrollments, and a billing-recipient
    // automation's deliberately separate address (notification_prefs)
    // must not be rewritten even when it happens to match a hold target.
    counts.automations += await conn('automation_enrollments')
      .where({ customer_id: customerId, status: 'active', template_key: 'new_lead' })
      .where(function priorTargets() {
        this.whereRaw('LOWER(email) = ?', [oldEmail]);
        for (const target of priorHoldTargets) {
          this.orWhereRaw('LOWER(email) = ?', [target]);
        }
      })
      .update({ email: newEmail, updated_at: now });
    let reviewedCallsQuery = conn('triage_items')
      .whereIn('reason_code', EMAIL_REVIEW_REASON_CODES)
      .whereIn('call_log_id', conn('call_log').select('id').where({ customer_id: customerId }));
    // Same snapshot fence (r50): the zero-work markers this set drives are
    // hold-row upserts, and the r34 evidence writes are card writes.
    if (snapshotCallIds) reviewedCallsQuery = reviewedCallsQuery.whereIn('call_log_id', snapshotCallIds);
    const reviewedCalls = await reviewedCallsQuery.distinct('call_log_id');
    // Zero-work released markers RETARGET on conflict (Codex #3084 r17):
    // two corrections before the processor's Step-6 write means marker A
    // already exists when correction B arrives — B's address must win, or
    // the processor's released-during-run guard adopts A's superseded
    // value. Real rows (any held flag, or pending/releasing/blocked) are
    // never touched by the CASE.
    const zeroWorkMarker = "first_touch_holds.status = 'released' AND NOT first_touch_holds.held_drip AND NOT first_touch_holds.held_newsletter";
    const reviewedCallIds = [...new Set(reviewedCalls.map((r) => r.call_log_id).filter(Boolean))];
    // Pre-merge target capture (Codex #3084 r55): when the pre-lock hold
    // snapshot predates a raced release's insert, the pending row that
    // release leaves behind (claimed → enrolled → DOI failed → re-pended)
    // carries the ONLY record of the address its new_lead enrollment was
    // created at. The retarget below rewrites pending/releasing rows to
    // the corrected address, so the post-merge re-read can never recover
    // that target and the final sweep leaves the enrollment mailing the
    // rejected address. The ON CONFLICT DO NOTHING insert is what waits
    // out the racing transaction's row lock (a plain FOR UPDATE cannot
    // see an uncommitted insert); once it returns, the pre-merge state is
    // lockable and readable, and only THEN is the retarget applied.
    const racedMergeTargets = [];
    for (const callId of reviewedCallIds) {
      await conn('first_touch_holds')
        .insert({
          call_log_id: callId,
          customer_id: customerId,
          held_email: newEmail,
          held_drip: false,
          held_newsletter: false,
          status: 'released',
          released_at: now,
          corrected_at: now,
          created_at: now,
          updated_at: now,
        })
        .onConflict('call_log_id')
        .ignore();
      const [preMerge] = await conn('first_touch_holds')
        .where({ call_log_id: callId })
        .forUpdate()
        .select('held_email', 'status');
      if (preMerge && ['pending', 'releasing'].includes(preMerge.status)) {
        const target = String(preMerge.held_email || '').trim().toLowerCase();
        if (target && target !== newEmail.toLowerCase()) racedMergeTargets.push(target);
      }
      // Real pending/releasing rows RETARGET here too (Codex #3084
      // r36): recordFirstTouchHold can insert the first real row
      // after this transaction's retarget updates already found
      // nothing — this is the last correction write that can still
      // see it, and preserving its extracted target would let a
      // claimant (or the resolved-card sweep) send to the address the
      // operator just rejected. Deny-lift and the ownerless
      // releasing→pending flip mirror the retarget updates;
      // updated_at stays untouched (never extend a possibly-dead
      // claimant's stale window).
      await conn('first_touch_holds')
        .where({ call_log_id: callId })
        .update({
          held_email: conn.raw(`CASE WHEN ${zeroWorkMarker} OR first_touch_holds.status IN ('pending', 'releasing') THEN ? ELSE first_touch_holds.held_email END`, [newEmail]),
          released_at: conn.raw(`CASE WHEN ${zeroWorkMarker} THEN ? ELSE first_touch_holds.released_at END`, [now]),
          corrected_at: conn.raw(`CASE WHEN ${zeroWorkMarker} OR first_touch_holds.status IN ('pending', 'releasing') THEN ? ELSE first_touch_holds.corrected_at END`, [now]),
          status: conn.raw("CASE WHEN first_touch_holds.status = 'releasing' AND first_touch_holds.last_error = 'email_denied_await_correction' THEN 'pending' ELSE first_touch_holds.status END"),
          last_error: conn.raw("CASE WHEN first_touch_holds.status IN ('pending', 'releasing') AND first_touch_holds.last_error = 'email_denied_await_correction' THEN NULL ELSE first_touch_holds.last_error END"),
        });
    }

    // FINAL enrollment retarget, after the marker merges (Codex #3084
    // r37): a release can insert its hold row AND commit an active
    // new_lead enrollment after the sweep above ran — the marker merge is
    // the correction's first write that waits out that release's row
    // lock, and its retarget fixes only the HOLD. The freshly committed,
    // immediately-due enrollment still carries the rejected address.
    // SCOPED to the new_lead template (Codex #3084 r38): only a hold
    // release creates the late enrollment this race-repair exists for. A
    // billing-recipient automation deliberately carries a SEPARATE
    // address resolved from notification_prefs. Unlinked rows stay
    // untouched (the r26 ownership rule).
    // Ownership alone is NOT evidence (Codex #3084 r54): a public-quote
    // requester's deliberately DIFFERENT address (public-quote.js enrolls
    // new_lead at the requester's email while the customer record keeps
    // its own) must not be redirected by a later edit to the stored
    // address. The raced release's target IS knowable now: it enrolls at
    // its hold row's held target, and the marker merge above was this
    // correction's first write to wait out that release's row lock — so a
    // POST-MERGE re-read of the snapshot's hold rows sees it (the merge's
    // CASE preserves a real released row's held_email). Match set = old
    // email ∪ pre-lock prior targets ∪ post-merge held targets; anything
    // else linked to the customer is presumed intentional and stays.
    const lateReleaseTargets = [];
    {
      let heldNowQuery = conn('first_touch_holds').where({ customer_id: customerId });
      if (snapshotCallIds) heldNowQuery = heldNowQuery.whereIn('call_log_id', snapshotCallIds);
      const heldNowRows = await heldNowQuery.select('held_email');
      const newEmailLcFinal = newEmail.toLowerCase();
      for (const row of heldNowRows) {
        const target = String(row.held_email || '').trim().toLowerCase();
        if (target && target !== newEmailLcFinal) lateReleaseTargets.push(target);
      }
    }
    // racedMergeTargets (r55): pre-merge pending/releasing targets the
    // retarget above overwrote — same hold-lane evidence tier as the
    // held targets read back here, recoverable ONLY before the merge.
    //
    // Late-discovered targets get the SAME subscriber/token fanout the
    // pre-pass gave priorHoldTargets (r56): a raced release can
    // create/adopt-link a subscriber at X before this correction's
    // snapshot ever saw a hold row — without this pass, X's DOI
    // confirmation and unsubscribe bearer links stay valid in the
    // rejected mailbox after the record moves to the corrected address.
    const newEmailLcLate = newEmail.toLowerCase();
    const lateSubscriberTargets = [...new Set([...lateReleaseTargets, ...racedMergeTargets])]
      .filter((t) => t && t !== newEmailLcLate && t !== oldEmail && !priorHoldTargets.includes(t));
    if (lateSubscriberTargets.length) await retargetSubscribersAtRejectedTargets(lateSubscriberTargets);
    const finalSweepTargets = [...new Set([oldEmail, ...priorHoldTargets, ...lateReleaseTargets, ...racedMergeTargets].filter(Boolean))];
    if (finalSweepTargets.length) {
      counts.automations += await conn('automation_enrollments')
        .where({ customer_id: customerId, status: 'active', template_key: 'new_lead' })
        .whereRaw('LOWER(email) != ?', [newEmail.toLowerCase()])
        .where(function knownTargets() {
          for (const target of finalSweepTargets) {
            this.orWhereRaw('LOWER(email) = ?', [target]);
          }
        })
        .update({ email: newEmail, updated_at: now });
    }

    // A correction is itself the ANSWER to a dismissed read-back card
    // (Codex #3084 r34): dismissal is "not actionable", so the ledger
    // sweep's latest-card-resolved rule deliberately excludes those
    // calls — but once the operator asserts the address, a transient
    // release failure (the resume below re-pending, or its deferred DOI
    // callback failing) would strand the retargeted hold forever: this
    // correction is already consumed, no open card is left to resolve,
    // and the sweep never admits the call. Flip the dismissed email cards
    // to resolved — documenting the supersession — so the sweep owns the
    // retry. The evidence covers the calls holding rows AND the reviewed
    // calls that only got a zero-work marker above (Codex #3084 r35): in
    // the pre-Step-6 window the correction lands before the processor's
    // hold write, so heldCallIds alone misses the call whose merged-in
    // work will later re-pend against a latest-dismissed card. A covered
    // call with NO email card at all (the processor's card insert failed)
    // gets a synthetic RESOLVED card for the same reason: the operator's
    // correction IS the review. Both writes ride the correction
    // transaction.
    const evidenceCallIds = [...new Set([...heldCallIds, ...reviewedCallIds])];
    if (evidenceCallIds.length) {
      // Deliberately NOT added to counts.reviewCards — that count reports
      // OPEN cards this correction answered; the flip re-labels an
      // already-terminal card.
      await conn('triage_items')
        .whereIn('call_log_id', evidenceCallIds)
        .whereIn('reason_code', EMAIL_REVIEW_REASON_CODES)
        .where({ status: 'dismissed' })
        .update({
          status: 'resolved',
          resolution_note: `Email corrected on the customer record after dismissal (${String(source).slice(0, 100)})`,
          resolved_at: now,
          updated_at: now,
        });
      const carded = new Set((await conn('triage_items')
        .whereIn('call_log_id', evidenceCallIds)
        .whereIn('reason_code', EMAIL_REVIEW_REASON_CODES)
        .select('call_log_id')).map((r) => r.call_log_id));
      const cardless = evidenceCallIds.filter((id) => !carded.has(id));
      if (cardless.length) {
        const { buildTriageItem } = require('./call-routing-gates');
        await conn('triage_items').insert(cardless.map((callId) => ({
          ...buildTriageItem({
            callLogId: callId,
            flag: 'email_unverified',
            extraction: null,
            severity: 'advisory',
            extraPayload: { hold_reason: 'email_corrected_no_card' },
          }),
          status: 'resolved',
          resolution_note: `Email corrected on the customer record; no read-back card existed (${String(source).slice(0, 100)})`,
          resolved_at: now,
          updated_at: now,
        })));
      }
    }
  }

  // Resume the HELD first-touch sends (2026-07-30): the call pipeline holds
  // the new_lead drip AND the newsletter DOI while an email read-back card
  // is live; the operator's correction is a release point. NOT gated on a
  // card still being open — a deny verdict (wrong name) resolves the email
  // card before the correction happens, and the ledger row, not the card,
  // carries the pending state (Codex #3084 r8). The shared helper re-checks
  // consent (do-not-contact, suppressions), dedupes via enrollCustomer, and
  // no-ops for customers with no pending hold.
  // Operator-asserted scopes ONLY (Codex #3084 r49): a narrowed
  // (call-capture) scope is not a release point — the captured address is
  // exactly what the still-open read-back card asks a human to confirm, so
  // releasing the held drip/DOI to it would send an unapproved address.
  if (operatorAssertedEmail) {
    try {
      const { resumeHeldFirstTouch } = require('./lead-first-touch-resume');
      // deferNewsletter: this runs inside the caller's edit transaction — the
      // DOI (an unrollbackable send) executes post-commit via
      // resumeHeldNewsletterPostCommit, same contract as pendingConfirmation.
      // restrictToCallLogIds (r50): the resume claims and releases hold
      // rows — inside this transaction it must stay within the
      // advisory-locked snapshot like every other hold operation.
      const resume = await resumeHeldFirstTouch({ customerId, email: newEmail, dbh: conn, source: 'email_corrected', deferNewsletter: true, restrictToCallLogIds: snapshotCallIds });
      if (resume?.enrolled) counts.heldDripResumed = 1;
      if (resume?.newsletterResume) heldNewsletterResume = resume.newsletterResume;
    } catch (resumeErr) {
      logger.warn(`[email-fanout] held-drip resume failed for customer ${customerId}: ${resumeErr.message}`);
    }
  }

  if (Object.values(counts).some(Boolean)) {
    // Counts only — never the email values (PII stays out of logs).
    logger.info(`[email-fanout] customer ${customerId}: synced ${counts.leads} lead(s), ${counts.estimates} estimate(s), ${counts.newsletter} newsletter (${counts.newsletterDeliveries} delivery token(s) rotated), ${counts.automations} enrollment(s), ${counts.templateRuns} template run(s), ${counts.promoters} promoter(s), ${counts.billingPrefs} billing pref(s), ${counts.contracts} contract(s), ${counts.bookingIntents} booking intent(s); resolved ${counts.reviewCards} email review card(s)`);
  }
  // One DOI, never two (Codex #3084 r5): if the customer publicly
  // subscribed while the call's newsletter was held, the moved pending row's
  // re-sent confirmation IS the resume — drop the held payloads so only
  // resendPendingConfirmation sends. The holds themselves are NOT consumed
  // here (Codex #3084 r9): the re-send runs post-commit and can fail, and a
  // hold consumed in-transaction would leave the subscriber pending with
  // nothing left to retry. The ids ride along on pendingConfirmation;
  // resendPendingConfirmation settles every one only after the confirmation
  // actually sends, and re-pends them all on failure. Until then the rows
  // stay 'releasing' (the deferred-resume claim), reclaimable via the
  // stale-claim window if the process dies before the post-commit call.
  if (pendingConfirmation && heldNewsletterResume) {
    pendingConfirmation.heldNewsletterHoldIds = heldNewsletterResume
      .map((p) => p?.holdId)
      .filter(Boolean);
    // Per-hold claim fence stamps ride along too (Codex #3084 r27): the
    // post-commit resend must prove it still owns each claimed row before
    // sending or settling — a callback delayed past the stale-claim window
    // lost its rows to the sweep's reclaim.
    pendingConfirmation.heldNewsletterHoldClaims = Object.fromEntries(
      heldNewsletterResume
        .filter((p) => p?.holdId && p?.claimStamp)
        .map((p) => [p.holdId, p.claimStamp]),
    );
    heldNewsletterResume = null;
  }
  const extras = {};
  if (pendingConfirmation) extras.pendingConfirmation = pendingConfirmation;
  if (heldNewsletterResume) extras.heldNewsletterResume = heldNewsletterResume;
  return Object.keys(extras).length ? { ...counts, ...extras } : counts;
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
  const holdIds = Array.isArray(pendingConfirmation.heldNewsletterHoldIds)
    ? pendingConfirmation.heldNewsletterHoldIds
    : [];
  // Claim fence (Codex #3084 r27): every hold write below lands only while
  // this callback still owns the row's claim — a delay past the stale-claim
  // window hands reclaimed rows (sends AND settles) to the sweep.
  const holdClaims = { ...(pendingConfirmation.heldNewsletterHoldClaims || {}) };
  const { renewClaim, fencedHoldWrite, gateHoldForSend, repenAmbiguousDelivery } = require('./lead-first-touch-resume');
  const fenceOf = (holdId) => holdClaims[holdId] || null;
  // The captured payload can be SUPERSEDED before this callback runs
  // (Codex #3084 r18): a second correction committed in the gap rotates the
  // subscriber's email and confirmation token in its own transaction, and
  // sending the captured link would mail a dead token to the outdated
  // mailbox — then settle holds whose DOI never usably delivered. Verify
  // the row still matches; a mismatch hands the work to the newer
  // correction's own callback, with the holds re-pended so the sweep
  // covers a lost callback. 'target_verify_failed', NOT the send-failed
  // marker: nothing was sent, so the retry must keep its dedupe guard.
  // Deny-preserving two-step (Codex #3084 r22): the fallback marker only
  // lands on un-stamped rows; a deny that stamped mid-callback re-pends
  // with its stamp intact.
  const repenHolds = async (marker) => {
    for (const holdId of holdIds) {
      try {
        const repenned = await fencedHoldWrite(
          conn('first_touch_holds').where({ id: holdId })
            .where(function notDenied() {
              this.whereNull('last_error').orWhereNot('last_error', 'email_denied_await_correction');
            }),
          fenceOf(holdId),
        )
          .update({ status: 'pending', last_error: marker, updated_at: new Date() });
        if (!repenned) {
          await fencedHoldWrite(conn('first_touch_holds').where({ id: holdId }), fenceOf(holdId))
            .update({ status: 'pending', updated_at: new Date() });
        }
      } catch (repenErr) {
        logger.warn(`[email-fanout] hold ${holdId} re-pend failed: ${repenErr.code || repenErr.name || 'db_error'} (stale-claim window will reclaim)`);
      }
    }
  };
  let subscriberCustomerId = null;
  try {
    const current = await conn('newsletter_subscribers')
      .where({ id: pendingConfirmation.id })
      .first('email', 'confirmation_token', 'customer_id', 'status');
    subscriberCustomerId = current?.customer_id || null;
    const emailMatches = String(current?.email || '').trim().toLowerCase()
      === String(pendingConfirmation.email || '').trim().toLowerCase();
    const tokenMatches = String(current?.confirmation_token || '')
      === String(pendingConfirmation.confirmation_token || '');
    // Only a still-PENDING subscriber gets a re-sent confirmation (Codex
    // #3084 r24): an admin unsubscribe landing after the edit committed is
    // an explicit opt-out, and this send deliberately bypasses SendGrid
    // suppressions. The re-pended holds retry through runNewsletterResume,
    // whose subscribe helper honors the unsubscribed state and settles
    // without sending.
    const stillPending = String(current?.status || '') === 'pending';
    if (!current || !emailMatches || !tokenMatches || !stillPending) {
      logger.info(`[email-fanout] DOI re-send superseded for subscriber ${pendingConfirmation.id} — stale payload skipped`);
      await repenHolds('target_verify_failed');
      return false;
    }
  } catch (verifyErr) {
    // Can't verify the authoritative target — never send on a stale guess.
    logger.warn(`[email-fanout] DOI re-send target verify failed for subscriber ${pendingConfirmation.id}: ${verifyErr.code || verifyErr.name || 'db_error'}`);
    await repenHolds('target_verify_failed');
    return false;
  }
  // BOTH outbound vetoes run here too (Codex #3084 r19): when the coalesced
  // pending-subscriber path carries the held DOI, this callback — not
  // runOnePostCommitResume — is the send site, and a do-not-contact request
  // or bounce suppression landing after the correction committed would
  // otherwise bypass every check. Fail-closed: an unverifiable veto never
  // defaults to sending.
  try {
    const { customerCallDoNotContact, emailSuppressedForNewLead } = require('./lead-first-touch-resume');
    if (subscriberCustomerId && await customerCallDoNotContact(subscriberCustomerId, conn)) {
      logger.info(`[email-fanout] DOI re-send vetoed for subscriber ${pendingConfirmation.id}: do-not-contact — hold(s) blocked`);
      for (const holdId of holdIds) {
        try {
          await fencedHoldWrite(conn('first_touch_holds').where({ id: holdId }), fenceOf(holdId))
            .update({ status: 'blocked', last_error: 'do_not_contact', updated_at: new Date() });
        } catch (blockErr) {
          logger.warn(`[email-fanout] hold ${holdId} block failed: ${blockErr.code || blockErr.name || 'db_error'} (stale-claim window will reclaim)`);
        }
      }
      return false;
    }
    if (await emailSuppressedForNewLead(pendingConfirmation.email, conn)) {
      logger.info(`[email-fanout] DOI re-send vetoed for subscriber ${pendingConfirmation.id}: address suppressed — hold(s) stay pending`);
      await repenHolds('email_suppressed');
      return false;
    }
  } catch (vetoErr) {
    logger.warn(`[email-fanout] DOI re-send veto check failed for subscriber ${pendingConfirmation.id}: ${vetoErr.code || vetoErr.name || 'db_error'} — not sending`);
    await repenHolds('target_verify_failed');
    return false;
  }
  // Deny veto BEFORE the send (Codex #3084 r25): a force-reprocess verdict
  // can stamp a deduped hold between the correction's commit and this
  // callback — the deny-preserving settles would only keep the stamp AFTER
  // the prohibited DOI went out. A deny on ANY deduped hold vetoes the
  // send; the plain re-pend touches no last_error. Fail-closed.
  if (holdIds.length) {
    try {
      const denyRow = await conn('first_touch_holds')
        .whereIn('id', holdIds)
        .where({ last_error: 'email_denied_await_correction' })
        .first('id');
      if (denyRow) {
        logger.info(`[email-fanout] DOI re-send vetoed for subscriber ${pendingConfirmation.id}: hold denied — awaiting correction`);
        for (const holdId of holdIds) {
          try {
            await fencedHoldWrite(conn('first_touch_holds').where({ id: holdId }), fenceOf(holdId))
              .update({ status: 'pending', updated_at: new Date() });
          } catch (repenErr) {
            logger.warn(`[email-fanout] hold ${holdId} re-pend failed: ${repenErr.code || repenErr.name || 'db_error'} (stale-claim window will reclaim)`);
          }
        }
        return false;
      }
    } catch (denyErr) {
      logger.warn(`[email-fanout] DOI re-send deny check failed for subscriber ${pendingConfirmation.id}: ${denyErr.code || denyErr.name || 'db_error'} — not sending`);
      await repenHolds('target_verify_failed');
      return false;
    }
  }
  // Lease renewal before anything irreversible (Codex #3084 r27, CAS since
  // r28 — a read-only check races the sweep's reclaim). The re-sent DOI is
  // shared across the WHOLE deduped group, so ONE reclaimed sibling
  // abandons the send (r28): its reclaimer may already have re-sent this
  // exact pending confirmation, and this path sends directly — no dedupe
  // guard would catch the duplicate. Holds still owned re-pend (fenced,
  // deny-preserving) so the sweep retries promptly under the resume path's
  // dedupe guard.
  if (holdIds.length && Object.keys(holdClaims).length) {
    let anyLost = false;
    for (const holdId of holdIds) {
      const stamp = fenceOf(holdId);
      if (!stamp) continue; // legacy stamp-less payload — unfenced
      const renewed = await renewClaim(holdId, stamp, conn);
      if (renewed) holdClaims[holdId] = renewed;
      else anyLost = true;
    }
    if (anyLost) {
      logger.info(`[email-fanout] DOI re-send claim(s) lost to a reclaim for subscriber ${pendingConfirmation.id} — abandoning the group send`);
      await repenHolds('claim_lost');
      return false;
    }
  }
  // The DOI expiry stamp lands BEFORE the send (Codex #3084 r26), mirroring
  // subscribeOrResubscribe's pre-stamp: token rotation cleared the pending
  // row's confirmation_sent_at, and a post-send stamp that THREW would
  // leave it NULL with the holds already settled — lookupByToken applies
  // the seven-day expiry and the stale-pending purge runs only on non-null
  // timestamps, so the freshly mailed token would never expire.
  // Pre-stamping is durable across every post-send failure; the SEND
  // failure branch below clears it again (and the r25 force-resend marker
  // carries the retry past a stamp that survived a failed cleanup — the
  // r14 skipDedupe contract). Conditional on the row still matching the
  // verified payload (Codex #3084 r19/r24, unsubscribe included): zero
  // rows = rotated or opted out since the verify read → nothing usable to
  // mail, and B's own callback owns delivery.
  const sentEmailLc = String(pendingConfirmation.email || '').trim().toLowerCase();
  const verifiedRowQuery = () => conn('newsletter_subscribers')
    .where({
      id: pendingConfirmation.id,
      confirmation_token: pendingConfirmation.confirmation_token,
      status: 'pending',
    })
    .whereRaw('LOWER(email) = ?', [sentEmailLc]);
  try {
    const stamped = await verifiedRowQuery()
      .update({ confirmation_sent_at: new Date(), updated_at: new Date() });
    if (!stamped) {
      logger.info(`[email-fanout] DOI re-send superseded before send for subscriber ${pendingConfirmation.id} — holds stay retryable`);
      await repenHolds('target_verify_failed');
      return false;
    }
  } catch (stampErr) {
    // Nothing sent yet — fail closed and retryable. The non-force marker
    // keeps skipDedupe false on retry, and the stamp never landed, so the
    // dedupe guard permits the fresh send.
    logger.warn(`[email-fanout] confirmation_sent_at pre-stamp failed for subscriber ${pendingConfirmation.id}: ${stampErr.code || stampErr.name || 'db_error'} — not sending`);
    await repenHolds('doi_state_unverified');
    return false;
  }
  // The 'newsletter_doi_not_confirmed' re-pend is scoped to SEND failures
  // only (Codex #3084 r16): retries treat that marker as "must actually
  // re-send" (skipDedupe), so a post-send bookkeeping failure marked the
  // same way would double-mail a delivered confirmation.
  // Pre-send GATE (Codex #3084 r34, superseding the r31–r33 marker
  // consume): one fenced CAS per deduped hold — validate the fence, refuse
  // a denial, consume any force-resend marker, extend the lease — for
  // EVERY hold, marked or not, run ALL-OR-NOTHING in one transaction as
  // the last hold write before the send. The r33 layout gated only marked
  // holds, so a denial landing between the renewal above and the send on
  // an ordinary hold still mailed the operator-rejected address. Placed
  // AFTER the pre-stamp so the abort path (which never sent) lifts it
  // (r33); a send failure below re-arms the marker via sendFailedMarkerFor.
  // The rollback restores every marker already consumed, and the plain
  // fenced re-pends keep last_error untouched — markers and deny stamps
  // survive for the retry.
  // The gates and the SEND share the transaction (Codex #3084 r37): the
  // gate CASes take the deduped holds' row locks, and the correction
  // fanout's FIRST statement locks these same rows FOR UPDATE — holding
  // the transaction open across the provider call excludes a correction
  // from retargeting any grouped row (its fence deliberately unchanged)
  // between the gates and the actual send. A send failure is CAUGHT
  // inside — a rollback after the send would restore consumed markers for
  // a DOI that already went out.
  let gateFailed = false;
  let sentOk = false;
  let sendErr = null;
  // Pre-gate fence snapshot (Codex #3084 r38): if the COMMIT fails after
  // the provider already accepted the message, the rollback reinstates
  // these stamps in the DB — the post-send settles must fence on them,
  // not on the rolled-back gate stamps.
  const preGateClaims = { ...holdClaims };
  const gatedStamps = {};
  // Holds parked by the r40 unreadable-reconcile path — the post-send
  // settle loop below must not touch them (their claims are gone, and a
  // null fence would write UNFENCED over the parked state).
  const fenceUnresolved = new Set();
  if (holdIds.length) {
    try {
      await conn.transaction(async (trx) => {
        for (const holdId of holdIds) {
          // Target-bound (r35): a correction retargeting a releasing row
          // preserves its fence, so only the held_email CAS can refuse
          // the superseded send.
          const gated = await gateHoldForSend(holdId, fenceOf(holdId), trx, sentEmailLc);
          if (!gated) {
            const lost = new Error(`pre-send gate refused for hold ${holdId}`);
            lost.code = 'send_gate_lost';
            throw lost;
          }
          gatedStamps[holdId] = gated;
        }
        // The SUBSCRIBER row rides the same transaction as the send
        // (Codex #3084 r50): the pre-stamp above was a separate committed
        // statement, so a one-click/admin unsubscribe committing between
        // it and the provider call would deliver a confirmation AFTER the
        // opt-out — and this path deliberately bypasses SendGrid
        // suppressions, so nothing downstream catches it. Re-verify
        // pending+token UNDER a row lock held through the send: an
        // unsubscribe queues behind it and lands strictly after, which is
        // a legitimate ordering. Lock order: holds (gates above) →
        // newsletter_subscribers — same relative order as the retarget
        // passes earlier in this file.
        const liveSubscriber = await trx('newsletter_subscribers')
          .where({
            id: pendingConfirmation.id,
            confirmation_token: pendingConfirmation.confirmation_token,
            status: 'pending',
          })
          .whereRaw('LOWER(email) = ?', [sentEmailLc])
          .forUpdate()
          .first('id');
        if (!liveSubscriber) {
          const lost = new Error(`subscriber ${pendingConfirmation.id} no longer pending — not sending`);
          lost.code = 'send_gate_lost';
          throw lost;
        }
        // All gates landed — the transaction always commits from here
        // (the send below never rethrows), so the fresh stamps are safe
        // to adopt; a gate abort above leaves holdClaims on the OLD
        // stamps the rollback restored.
        Object.assign(holdClaims, gatedStamps);
        try {
          await require('./newsletter-confirm').sendConfirmationEmail(pendingConfirmation);
          sentOk = true;
        } catch (e) {
          sendErr = e;
        }
      });
    } catch (gateErr) {
      if (sentOk) {
        // The COMMIT errored after the provider accepted the message
        // (Codex #3084 r38) — the DOI is out. A commit error is
        // AMBIGUOUS (r39): the rows may durably carry either the
        // pre-gate stamps (rolled back, markers restored) or the gate
        // stamps (committed, acknowledgment lost) — settling on the
        // wrong set makes every settle miss and the stale reclaimer
        // force-resend a DOI the provider already accepted. Reread which
        // fence each row durably carries and fall through to the NORMAL
        // post-send path on those: the released settles clear any
        // restored markers, and the kept pre-stamp is the delivery
        // evidence the dedupe guard honors.
        logger.warn(`[email-fanout] gate commit errored AFTER the send for subscriber ${pendingConfirmation.id}: ${gateErr.code || gateErr.name || 'db_error'} — reconciling the durable fences`);
        for (const holdId of holdIds) {
          let durable = preGateClaims[holdId];
          const gated = gatedStamps[holdId];
          if (gated) {
            try {
              const row = await conn('first_touch_holds').where({ id: holdId }).first('updated_at');
              if (row && +new Date(row.updated_at) === +gated) durable = gated;
            } catch (rereadErr) {
              // An UNREADABLE reconcile must not assume rollback (Codex
              // #3084 r40): if the commit actually landed, pre-gate fenced
              // settles all miss and the stale reclaimer forces a
              // duplicate DOI. Park the hold on whichever fence it durably
              // carries — pending, neutral marker — and keep it out of the
              // settle loop below; the retry's dedupe guard resolves
              // delivery from the durable pre-stamp evidence.
              logger.warn(`[email-fanout] fence reconcile read failed for hold ${holdId}: ${rereadErr.code || rereadErr.name || 'db_error'} — parking the hold unresolved`);
              try {
                await repenAmbiguousDelivery(holdId, [durable, gated], conn);
              } catch (parkErr) {
                logger.warn(`[email-fanout] hold ${holdId} ambiguous-delivery park failed: ${parkErr.code || parkErr.name || 'db_error'} (stale-claim window will reclaim)`);
              }
              fenceUnresolved.add(holdId);
              delete holdClaims[holdId];
              continue;
            }
          }
          if (durable === undefined) delete holdClaims[holdId];
          else holdClaims[holdId] = durable;
        }
      } else {
        gateFailed = true;
        logger.warn(`[email-fanout] pre-send gate ${gateErr.code === 'send_gate_lost' ? 'refused' : 'failed'} for subscriber ${pendingConfirmation.id}: ${gateErr.code || gateErr.name || 'db_error'}`);
      }
    }
  } else {
    // No deduped holds — but the subscriber row still needs the r50
    // serialization: lock it, re-verify pending+token, and hold the lock
    // through the provider call so an unsubscribe cannot slip between the
    // pre-stamp and the send. A refused re-verify aborts without sending
    // (the gateFailed path lifts the pre-stamp). A commit failure after a
    // successful send is harmless here — the transaction held only a
    // read lock, and the pre-stamp is already durable.
    try {
      await conn.transaction(async (trx) => {
        const liveSubscriber = await trx('newsletter_subscribers')
          .where({
            id: pendingConfirmation.id,
            confirmation_token: pendingConfirmation.confirmation_token,
            status: 'pending',
          })
          .whereRaw('LOWER(email) = ?', [sentEmailLc])
          .forUpdate()
          .first('id');
        if (!liveSubscriber) {
          const lost = new Error(`subscriber ${pendingConfirmation.id} no longer pending — not sending`);
          lost.code = 'send_gate_lost';
          throw lost;
        }
        try {
          await require('./newsletter-confirm').sendConfirmationEmail(pendingConfirmation);
          sentOk = true;
        } catch (e) {
          sendErr = e;
        }
      });
    } catch (gateErr) {
      if (!sentOk) {
        gateFailed = true;
        logger.warn(`[email-fanout] subscriber gate ${gateErr.code === 'send_gate_lost' ? 'refused' : 'failed'} for ${pendingConfirmation.id}: ${gateErr.code || gateErr.name || 'db_error'}`);
      } else {
        logger.warn(`[email-fanout] no-holds send transaction commit errored after the send for subscriber ${pendingConfirmation.id}: ${gateErr.code || gateErr.name || 'db_error'} — pre-stamp already durable, continuing`);
      }
    }
  }
  if (gateFailed) {
    logger.warn(`[email-fanout] aborting the re-send for subscriber ${pendingConfirmation.id} — markers and deny stamps intact`);
    // Nothing was sent, so lift our own pre-stamp (conditional on the row
    // still being the verified payload — a rotation owns its delivery):
    // a marker-less retry path must not trust a stamp for a DOI that
    // never went out.
    let stampLifted = false;
    try {
      await verifiedRowQuery().update({ confirmation_sent_at: null, updated_at: new Date() });
      stampLifted = true;
    } catch (clearErr) {
      logger.warn(`[email-fanout] pre-stamp clear failed for subscriber ${pendingConfirmation.id}: ${clearErr.code || clearErr.name || 'db_error'}`);
    }
    if (stampLifted) {
      // Plain fenced re-pends: markers and deny stamps stay untouched.
      for (const holdId of holdIds) {
        try {
          await fencedHoldWrite(conn('first_touch_holds').where({ id: holdId }), fenceOf(holdId))
            .update({ status: 'pending', updated_at: new Date() });
        } catch (repenErr) {
          logger.warn(`[email-fanout] hold ${holdId} re-pend failed: ${repenErr.code || repenErr.name || 'db_error'} (stale-claim window will reclaim)`);
        }
      }
    } else {
      // The UNSENT pre-stamp survived the failed lift (Codex #3084 r35):
      // an ordinary unmarked hold re-pended plainly would meet the
      // retry's dedupe guard trusting that stamp — settling the hold
      // without the DOI ever going out. Arm the force-resend ticket
      // instead (verified against the attempted subscriber id + token,
      // r31/r32; deny-preserving, r23) so the retry actually sends.
      const { sendFailedMarkerFor } = require('./lead-first-touch-resume');
      await repenHolds(await sendFailedMarkerFor(
        pendingConfirmation.email,
        conn,
        pendingConfirmation.id,
        pendingConfirmation.confirmation_token || null,
      ));
    }
    return false;
  }
  if (!sentOk) {
    const e = sendErr || new Error('send_failed');
    // Provider error bodies can echo the recipient address — log only the
    // subscriber id and a sanitized code (this path exists BECAUSE the email
    // is being corrected; it must not leak into logs).
    logger.warn(`[email-fanout] DOI confirmation re-send failed for subscriber ${pendingConfirmation.id}: ${e.code || e.statusCode || 'send_failed'}`);
    // The pre-stamp must not bury an undelivered DOI: clear it, conditional
    // on the row still being OUR verified payload (a rotation landing
    // mid-send already replaced or cleared it, and B's callback owns
    // delivery). A failed clear is covered by the r25 marker below.
    try {
      await verifiedRowQuery().update({ confirmation_sent_at: null, updated_at: new Date() });
    } catch (clearErr) {
      logger.warn(`[email-fanout] pre-stamp clear failed for subscriber ${pendingConfirmation.id}: ${clearErr.code || clearErr.name || 'db_error'}`);
    }
    // The deduped holds' DOI never went out — restore a retryable state so
    // the next release trigger re-sends instead of stranding the pending
    // subscriber (Codex #3084 r9). Via the deny-preserving helper (r23): a
    // denial stamping after the veto checks must not be replaced by the
    // send-failed marker. The force-resend marker only when the subscriber
    // still carries the attempted address (r25) — a rotation mid-send makes
    // this failure obsolete, and the rotated target's own callback owns
    // delivery.
    const { sendFailedMarkerFor } = require('./lead-first-touch-resume');
    // Bound to the ATTEMPTED subscriber id (r31): an unrelated signup
    // claiming the freed address must not satisfy the verify and arm a
    // force-resend for a hold that meanwhile targets the rotation.
    await repenHolds(await sendFailedMarkerFor(pendingConfirmation.email, conn, pendingConfirmation.id, pendingConfirmation.confirmation_token || null));
    return false;
  }
  // Post-send rotation check, now read-only (the stamp already landed):
  // correction B can rotate email + token between the pre-stamp and the
  // send, meaning the link just mailed is dead and B's own callback owns
  // delivery — re-pend the holds and settle nothing (Codex #3084 r19).
  // A THROWN read keeps the r16 behavior: the verified send did go out,
  // the expiry stamp is durable, and every hold settle below is
  // target-CAS'd on its own.
  try {
    const live = await verifiedRowQuery().first('id');
    if (!live) {
      logger.info(`[email-fanout] DOI re-send superseded mid-send for subscriber ${pendingConfirmation.id} — holds stay retryable`);
      await repenHolds('target_verify_failed');
      return false;
    }
  } catch (postVerifyErr) {
    logger.warn(`[email-fanout] post-send verify failed for subscriber ${pendingConfirmation.id}: ${postVerifyErr.code || postVerifyErr.name || 'db_error'} — proceeding on target-CAS settles`);
  }
  // This re-sent DOI IS the resume for any newsletter hold deduped against
  // it (one DOI, never two) — settle those holds only now that delivery
  // succeeded (Codex #3084 r9). Each settle is conditional on the hold
  // still targeting the address this DOI went to, and a released settle
  // re-checks for work merged during the claim (Step 8 adding held_drip
  // mid-callback) exactly like the resume paths (Codex #3084 r19).
  const { repenIfWorkMergedDuringClaim } = require('./lead-first-touch-resume');
  for (const holdId of holdIds) {
    if (fenceUnresolved.has(holdId)) continue;
    try {
      const hold = await conn('first_touch_holds').where({ id: holdId }).first('held_drip', 'released_drip');
      const dripSettled = !hold || !hold.held_drip || hold.released_drip;
      const settled = await fencedHoldWrite(
        conn('first_touch_holds')
          .where({ id: holdId })
          .whereRaw("LOWER(COALESCE(held_email, '')) = ?", [sentEmailLc]),
        fenceOf(holdId),
      )
        // A deny stamping mid-callback must survive the settle — same
        // guard as the resume module's settleIfTargetUnchanged (Codex
        // #3084 r21).
        .where(function notDenied() {
          this.whereNull('last_error').orWhereNot('last_error', 'email_denied_await_correction');
        })
        .update({
          released_newsletter: true,
          status: dripSettled ? 'released' : 'pending',
          ...(dripSettled ? { released_at: new Date(), last_error: null } : {}),
          updated_at: new Date(),
        });
      if (!settled) {
        // Two-step deny-preserving re-pend (mirrors repenHoldPreservingDeny):
        // the fallback marker only lands on un-stamped rows. Fenced (r27).
        const repenned = await fencedHoldWrite(
          conn('first_touch_holds')
            .where({ id: holdId })
            .where(function notDenied() {
              this.whereNull('last_error').orWhereNot('last_error', 'email_denied_await_correction');
            }),
          fenceOf(holdId),
        )
          .update({ status: 'pending', last_error: 'superseded_during_send', updated_at: new Date() });
        if (!repenned) {
          await fencedHoldWrite(conn('first_touch_holds').where({ id: holdId }), fenceOf(holdId))
            .update({ status: 'pending', updated_at: new Date() });
        }
        continue;
      }
      if (dripSettled) await repenIfWorkMergedDuringClaim(holdId, conn);
    } catch (settleErr) {
      logger.warn(`[email-fanout] hold ${holdId} settle failed after DOI re-send: ${settleErr.code || settleErr.name || 'db_error'}`);
    }
  }
  return true;
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
      // MERGE-SPECIFIC evidence, not global uniqueness (r38 — the same
      // ruling every other claimant site adopted): customers.email is
      // deliberately non-unique, so a spouse/tenant/shared-household
      // holder must not leave the matched customer email-less. Only a
      // live holder who is the restored LOSER of an UNDONE merge whose
      // winner is THIS customer proves the address is a stale pre-undo
      // capture. One joined existence query; if the joined read fails,
      // fall back to the conservative bare-holder block.
      let undoneHolder = null;
      try {
        undoneHolder = await trx('customers as c')
          .join('customer_merge_journal as j', function joinUndone() {
            this.on('j.loser_customer_id', 'c.id');
          })
          .where('j.winner_customer_id', customerId)
          .whereNotNull('j.undone_at')
          .whereRaw('lower(c.email) = ?', [emailKeyNorm])
          .whereNot('c.id', customerId)
          .where('c.active', true)
          .whereNull('c.deleted_at')
          .first('c.id');
      } catch {
        undoneHolder = await trx('customers')
          .whereRaw('lower(email) = ?', [emailKeyNorm])
          .whereNot({ id: customerId })
          .where('active', true)
          .whereNull('deleted_at')
          .first('id');
      }
      if (undoneHolder) {
        const { email: _dropped, ...rest } = updates;
        if (Object.keys(rest).length) await trx('customers').where({ id: customerId }).update(rest);
        return { emailApplied: false, emailDroppedReason: 'address was restored to a merged-away customer by an undo' };
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
