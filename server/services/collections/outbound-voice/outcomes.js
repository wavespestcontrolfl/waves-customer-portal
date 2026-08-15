/**
 * Call outcome → contact ledger + collection_case, atomically (PR B).
 *
 * Every terminal path of a collections call (relay session end, vestibule
 * press-9/press-0, voicemail, no-answer, failure) funnels through
 * writeCallOutcome so the ledger row and the case row can never disagree:
 * both updates ride ONE transaction, and the case update is version-guarded
 * on the case_version the call was dialed for.
 *
 * POST-CONVERSATION SUPPRESSION (ruled): after a LIVE conversation the case
 * goes back to the review queue (state 'proposed', approval cleared) with
 * next_eligible_at = now + 7 days — or the customer's stated payment date
 * plus 1 business day, whichever is LATER. Never auto-redial: a fresh dial
 * always needs a fresh approval + full revalidation. Non-conversation
 * outcomes also return to the review queue (the dial's ledger row already
 * makes the policy deny voice for 7 days, so spacing is enforced twice).
 *
 * Terminology (ruled): the structured capture is
 * `customer_intended_payment_date` — NEVER the phrase "promise to pay".
 *
 * The ledger update here is a direct UPDATE on the dial's existing row
 * (recorded before the dial) — recordContact is never called inside this
 * transaction (the ledger module's SAVEPOINT warning).
 */

const db = require('../../../models/db');
const logger = require('../../logger');
const { etCalendarDayOf } = require('../../../utils/datetime-et');

const DAY_MS = 24 * 60 * 60 * 1000;

// Outcomes that mean a live right-party (or wrong-party) HUMAN conversation
// happened on the relay leg — these trigger the 7-day post-conversation
// suppression window.
const LIVE_CONVERSATION_OUTCOMES = new Set([
  'conversation_completed',
  'conversation_dispute',
  'conversation_consent_revoked',
  'conversation_transferred',
  'conversation_verification_failed',
  'conversation_abandoned',
  'wrong_party',
]);

// `date` (Date) + n business days (Mon–Fri), as a Date at the same UTC time.
function addBusinessDays(date, n) {
  const d = new Date(date.getTime());
  let remaining = n;
  while (remaining > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) remaining--;
  }
  return d;
}

// ISO YYYY-MM-DD sanity for the model-supplied intended payment date: a real
// calendar date, today..+90d. Anything else is DROPPED (recorded only in the
// verbatim summary), never persisted as a structured date.
function normalizeIntendedPaymentDate(value, now) {
  const str = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) return null;
  const d = new Date(`${str}T12:00:00Z`);
  if (Number.isNaN(d.getTime()) || etCalendarDayOf(d) !== str) return null;
  const today = new Date(`${etCalendarDayOf(now)}T12:00:00Z`);
  const diff = d.getTime() - today.getTime();
  if (diff < 0 || diff > 90 * DAY_MS) return null;
  return str;
}

/**
 * Atomically finalize a collections call.
 *
 * @param callLogId  the dial's call_log row (carries case/ledger linkage)
 * @param outcome    stable outcome identifier (see LIVE_CONVERSATION_OUTCOMES
 *                   + 'voicemail_left' | 'no_answer' | 'machine_no_voicemail'
 *                   | 'vestibule_declined' | 'vestibule_office'
 *                   | 'vestibule_no_input' | 'relay_failed' | 'dial_failed')
 * @param captures   { customerIntendedPaymentDate, disputeSummary,
 *                     consentRevoked, wrongParty, payLinkSent, summary }
 */
async function writeCallOutcome(callLogId, { outcome, captures = {}, now = new Date(), onlyIfNoOutcome = false } = {}) {
  if (!callLogId || !outcome) return { ok: false, reason: 'missing_args' };
  const callRow = await db('call_log').where({ id: callLogId }).first();
  if (!callRow) return { ok: false, reason: 'call_log_not_found' };
  const meta = typeof callRow.metadata === 'string'
    ? (() => { try { return JSON.parse(callRow.metadata); } catch { return {}; } })()
    : (callRow.metadata || {});
  const caseId = meta.collectionCaseId;
  const caseVersion = Number(meta.caseVersion);
  const ledgerId = meta.ledgerId;

  const intendedDate = normalizeIntendedPaymentDate(captures.customerIntendedPaymentDate, now);
  const live = LIVE_CONVERSATION_OUTCOMES.has(outcome);

  // Suppression horizon: 7d after a live conversation; stated date + 1
  // business day when that lands LATER.
  let nextEligibleAt = null;
  if (live) {
    nextEligibleAt = new Date(now.getTime() + 7 * DAY_MS);
    if (intendedDate) {
      const statedPlus = addBusinessDays(new Date(`${intendedDate}T12:00:00Z`), 1);
      if (statedPlus.getTime() > nextEligibleAt.getTime()) nextEligibleAt = statedPlus;
    }
  }

  const dispute = Boolean(captures.disputeSummary);
  const casePatch = dispute
    ? {
      current_state: 'held',
      hold_reason: 'dispute_raised_on_call',
      approved_by: null,
      approved_at: null,
      approval_expires_at: null,
      next_eligible_at: nextEligibleAt,
    }
    : {
      // Back to the review queue — never auto-redial.
      current_state: 'proposed',
      hold_reason: null,
      approved_by: null,
      approved_at: null,
      approval_expires_at: null,
      next_eligible_at: nextEligibleAt,
    };

  const ledgerMetaPatch = {
    outcome,
    live_conversation: live,
    ...(intendedDate ? { customer_intended_payment_date: intendedDate } : {}),
    ...(dispute ? { dispute: true } : {}),
    ...(captures.consentRevoked ? { consent_revoked: true } : {}),
    ...(captures.wrongParty ? { wrong_party: true } : {}),
    ...(captures.payLinkSent ? { pay_link_sent: true } : {}),
    outcome_at: now.toISOString(),
  };

  try {
    let skipped = false;
    await db.transaction(async (trx) => {
      if (ledgerId) {
        let q = trx('collections_contact_ledger').where({ id: ledgerId });
        // onlyIfNoOutcome (gh prb-r6): a failure-path writer (relay_failed)
        // must never clobber a meaningful outcome the conversation writer
        // already landed — the fence lives IN the UPDATE's WHERE (atomic,
        // the #3373 voicemail-guard pattern).
        if (onlyIfNoOutcome) q = q.whereRaw("COALESCE(metadata->>'outcome', '') = ''");
        const updated = await q.update({
          metadata: trx.raw(
            "COALESCE(metadata, '{}'::jsonb) || ?::jsonb",
            [JSON.stringify(ledgerMetaPatch)],
          ),
        });
        if (onlyIfNoOutcome && !updated) { skipped = true; return; }
      }
      if (caseId && Number.isFinite(caseVersion)) {
        await trx('collection_cases')
          .where({ id: caseId, case_version: caseVersion })
          .update({ ...casePatch, updated_at: trx.fn.now() });
      }
    });
    return skipped ? { ok: true, skipped: true } : { ok: true, nextEligibleAt, live };
  } catch (err) {
    logger.error(`[collections-outcomes] outcome write failed for call_log ${callLogId}: ${err.message}`);
    return { ok: false, reason: 'write_failed' };
  }
}

module.exports = {
  writeCallOutcome,
  addBusinessDays,
  normalizeIntendedPaymentDate,
  LIVE_CONVERSATION_OUTCOMES,
};
