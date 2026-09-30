/**
 * collections_flags writers for the outbound-voice lane (PR B).
 *
 * Idempotent inserts against the partial unique index (one ACTIVE row per
 * customer+flag): ON CONFLICT DO NOTHING on the active predicate is not
 * expressible through knex's onConflict for a partial index across versions,
 * so we insert and treat the 23505 duplicate as success — the flag is
 * already active, which is the state we wanted.
 *
 * Every flag write also files an admin card ('billing' category — the bell
 * allowlist lesson: novel categories are silently suppressed under
 * GATE_ADMIN_BELL_POLICY) so a spoken opt-out / dispute is never a silent
 * database row. Card filing is best-effort AFTER the durable flag write; the
 * flag row itself is the artifact that halts contact.
 */

const db = require('../../../models/db');
const logger = require('../../logger');

async function writeFlag({ customerId, flag, reason, createdBy = 'system:collections_voice' }) {
  if (!customerId || !flag) return { ok: false, reason: 'missing_args' };
  try {
    await db('collections_flags').insert({
      customer_id: customerId,
      flag,
      reason: reason ? String(reason).slice(0, 500) : null,
      created_by: createdBy,
    });
    return { ok: true, created: true };
  } catch (err) {
    // Unique-violation = the flag is already active — success by intent.
    if (String(err.code) === '23505' || /collections_flags_active_uniq/.test(err.message || '')) {
      return { ok: true, created: false };
    }
    logger.error(`[collections-flags] flag write FAILED customer=${customerId} flag=${flag}: ${err.message}`);
    return { ok: false, reason: 'write_failed' };
  }
}

async function fileFlagCard({ customerId, flag, detail }) {
  try {
    const NotificationService = require('../../notification-service');
    const card = await NotificationService.notifyAdmin(
      'billing',
      `Billing follow-up call: ${flag.replace(/_/g, ' ')}`,
      detail,
      { link: `/admin/customers?customerId=${customerId}`, metadata: { customerId, flag, source: 'collections_voice' } },
    );
    // notifyAdmin resolves null on a failed insert (gh prb-r4) — a card
    // that never persisted is not filed.
    return Boolean(card && (card.id || card.suppressed));
  } catch (err) {
    logger.warn(`[collections-flags] admin card failed for customer ${customerId} (${flag}): ${err.message}`);
    return false;
  }
}

/**
 * Press-9 / spoken revocation: stop automated voice calls. Durable flag
 * first, card second. Returns ok only when the FLAG write is durable.
 */
async function revokeAutomatedVoiceConsent(customerId, { reason, createdBy } = {}) {
  const res = await writeFlag({
    customerId,
    flag: 'automated_voice_consent_revoked',
    reason: reason || 'customer opted out of automated calls',
    createdBy,
  });
  if (res.ok) {
    await fileFlagCard({
      customerId,
      flag: 'automated_voice_consent_revoked',
      detail: 'Customer opted out of automated calls on a billing follow-up call. Automated voice contact is now blocked; other channels unchanged.',
    });
  }
  return res;
}

/** Dispute raised on-call: collection_hold blocks EVERY dunning channel. */
async function placeDisputeHold(customerId, { summary, createdBy } = {}) {
  const res = await writeFlag({
    customerId,
    flag: 'collection_hold',
    reason: summary ? `dispute on call: ${summary}` : 'dispute raised on call',
    createdBy,
  });
  if (res.ok) {
    await fileFlagCard({
      customerId,
      flag: 'collection_hold',
      detail: `Customer raised a billing dispute on a follow-up call — all balance outreach is now on hold pending review.${summary ? ` Summary: ${summary}` : ''}`,
    });
  }
  return res;
}

/**
 * Canonical do-not-text record for a wrong number reported on a call.
 *
 * collections_flags.wrong_number is read only by the collections
 * ContactPolicy; every other customer-comms rail (reminders, review asks,
 * tech-arrived, invoice sends...) gates on messaging_suppression, the
 * application-wide store the SMS wrong-number path writes through
 * recordSuppression (reason 'wrong_number'). The voice lane writes the same
 * row through the same helper, keyed on the number the call was DIALED to
 * (recordSuppression normalizes to E.164, exactly as the SMS path does) —
 * that number reached the stranger, whatever customers.phone says now.
 *
 * Never throws; resolves { ok, reason? } so the caller can tell the admin
 * the truth when the canonical write did not land.
 */
async function recordWrongNumberSuppression({ phone, callLogId, capturedBody } = {}) {
  const { toE164 } = require('../../../utils/phone');
  const canonical = toE164(phone);
  if (!canonical || !/^\+\d{8,15}$/.test(canonical)) return { ok: false, reason: 'no_valid_phone' };
  try {
    const { recordSuppression } = require('../../messaging/validators/suppression');
    const res = await recordSuppression({
      phone: canonical,
      reason: 'wrong_number',
      source: callLogId ? `collections_voice_call:${callLogId}` : 'collections_voice_call',
      capturedBody,
    });
    if (!res || res.ok === false) return { ok: false, reason: 'suppression_write_failed' };
    return { ok: true, phone: canonical };
  } catch (err) {
    logger.error(`[collections-flags] wrong-number suppression threw: ${err.message}`);
    return { ok: false, reason: 'suppression_write_failed' };
  }
}

/**
 * Wrong-party answer where the answerer says the customer is unknown here.
 *
 * Two durable writes: the collections_flags row (collections lane) AND the
 * canonical messaging_suppression row for the dialed phone (every other
 * rail). Both are attempted independently; the returned `suppression`
 * carries the canonical write's outcome. The admin card states only what
 * actually landed.
 */
async function flagWrongNumber(customerId, { detail, createdBy, phone, callLogId, capturedBody } = {}) {
  const res = await writeFlag({
    customerId,
    flag: 'wrong_number',
    reason: detail || 'answerer reported wrong number on outbound call',
    createdBy,
  });
  const suppression = await recordWrongNumberSuppression({ phone, callLogId, capturedBody });
  if (!suppression.ok) {
    logger.error(`[collections-flags] WRONG-NUMBER SUPPRESSION NOT WRITTEN customer=${customerId} callLog=${callLogId || 'n/a'}: ${suppression.reason} — other SMS rails may still text this number`);
  }
  // The suppression-failure card is filed whatever happened to the flag
  // row: it is the only staff signal that other rails can still text this
  // number (the caller's collection_hold fallback files a card only when the
  // hold ALSO fails). Its copy states only what landed.
  if (res.ok || !suppression.ok) {
    const last4 = suppression.phone ? suppression.phone.slice(-4) : null;
    const collectionsBlocked = res.ok
      ? 'Collections calls and texts to this customer are blocked'
      : 'The collections wrong-number flag could not be saved either (a billing hold may have been placed instead)';
    const filed = await fileFlagCard({
      customerId,
      flag: 'wrong_number',
      detail: suppression.ok
        ? `An outbound billing follow-up call reached someone who says this number does not belong to the customer. The number${last4 ? ` ending ${last4}` : ''} is now on the do-not-text list for every text and App notice, and collections calls and texts to this customer are blocked pending a number review; payment emails still go to the email on file. The old number stays suppressed after you correct the customer's phone.`
        : `An outbound billing follow-up call reached someone who says this number does not belong to the customer. ${collectionsBlocked}, BUT the do-not-text record for this number could NOT be written: appointment reminders, review requests and other texts may still go to it. Add the number to the do-not-contact list or correct the customer's phone by hand now.`,
    });
    if (!filed && !suppression.ok) {
      logger.error(`[collections-flags] wrong-number card ALSO failed customer=${customerId} — canonical suppression missing and no admin card`);
    }
  }
  return { ...res, suppression };
}

/** Active (unreleased) flags on a customer, oldest first. */
async function activeFlags(customerId) {
  if (!customerId) return [];
  return db('collections_flags')
    .where({ customer_id: customerId })
    .whereNull('released_at')
    .orderBy('created_at', 'asc')
    .select('flag', 'reason', 'created_by', 'created_at');
}

/**
 * Release an active flag — stamp released_at, never delete (the row is the
 * paper trail). Idempotent: nothing active ⇒ { ok:true, released:0 }.
 */
async function releaseFlag({ customerId, flag }) {
  if (!customerId || !flag) return { ok: false, reason: 'missing_args' };
  try {
    const released = await db('collections_flags')
      .where({ customer_id: customerId, flag })
      .whereNull('released_at')
      .update({ released_at: db.fn.now() });
    return { ok: true, released: Number(released) || 0 };
  } catch (err) {
    logger.error(`[collections-flags] flag release FAILED customer=${customerId} flag=${flag}: ${err.message}`);
    return { ok: false, reason: 'release_failed' };
  }
}

module.exports = {
  writeFlag,
  releaseFlag,
  activeFlags,
  revokeAutomatedVoiceConsent,
  placeDisputeHold,
  flagWrongNumber,
  recordWrongNumberSuppression,
  fileFlagCard,
};
