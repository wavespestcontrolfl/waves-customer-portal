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
const { HOLD_FLAG, DISPUTE_REASON_PREFIX } = require('../collection-hold');

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

async function fileFlagCard({ customerId, flag, detail, manualAction = false }) {
  try {
    const NotificationService = require('../../notification-service');
    const card = await NotificationService.notifyAdmin(
      'billing',
      `Billing follow-up call: ${flag.replace(/_/g, ' ')}`,
      detail,
      {
        link: `/admin/customers?customerId=${customerId}`,
        metadata: { customerId, flag, source: 'collections_voice' },
        // A manual-action card is the only staff signal for a problem no row
        // records; it rings past the bell policy's category defaults.
        ...(manualAction ? { bell: true } : {}),
      },
    );
    // notifyAdmin resolves null on a failed insert (gh prb-r4) — a card
    // that never persisted is not filed. A manual-action card counts only
    // when a row actually exists (a suppressed sentinel is not a card).
    if (manualAction) return Boolean(card && card.id);
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

/**
 * Dispute raised on-call: collection_hold blocks EVERY dunning channel AND
 * (collection-hold.js) every off-session charge. The reason text is the
 * discriminator that makes it a money hold — it must start with
 * DISPUTE_REASON_PREFIX. collection_hold is also a wrong-number / wrong-party
 * fallback artifact, and the one-active-row-per-flag index means a dispute
 * raised while such a fallback row is active would otherwise be swallowed as
 * "already active": the existing row is upgraded to carry the dispute reason
 * (its earlier reason kept after it).
 */
const DISPUTE_HOLD_ATTEMPTS = 3;

async function placeDisputeHold(customerId, { summary, createdBy } = {}) {
  const disputeReason = summary ? `${DISPUTE_REASON_PREFIX} on call: ${summary}` : `${DISPUTE_REASON_PREFIX} raised on call`;
  // Atomic, bounded: insert; if a hold is already active, ONE conditional
  // UPDATE on the ACTIVE row (released_at IS NULL, reason not already a
  // dispute) sets the dispute reason. 0 rows updated means the row was
  // released (retry the insert) or is already a dispute row (verified). ok is
  // reported only when an active dispute-prefixed row verifiably exists.
  let res = { ok: false, reason: 'write_failed' };
  try {
    for (let attempt = 0; attempt < DISPUTE_HOLD_ATTEMPTS && !res.ok; attempt += 1) {
      const inserted = await writeFlag({ customerId, flag: HOLD_FLAG, reason: disputeReason, createdBy });
      if (!inserted.ok) { res = inserted; break; }
      if (inserted.created !== false) { res = inserted; break; }
      const upgraded = await db('collections_flags')
        .where({ customer_id: customerId, flag: HOLD_FLAG })
        .whereNull('released_at')
        .whereRaw('(reason IS NULL OR reason NOT ILIKE ?)', [`${DISPUTE_REASON_PREFIX}%`]) // parenthesized: knex does not wrap raw fragments
        .update({
          reason: db.raw("left(? || '; earlier hold: ' || coalesce(reason, 'no reason recorded'), 500)", [disputeReason]),
        });
      if (Number(upgraded) > 0) { res = { ok: true, created: false, upgraded: true }; break; }
      const activeDispute = await db('collections_flags')
        .where({ customer_id: customerId, flag: HOLD_FLAG })
        .whereNull('released_at')
        .whereRaw('reason ILIKE ?', [`${DISPUTE_REASON_PREFIX}%`])
        .first('id');
      if (activeDispute) res = { ok: true, created: false };
      // else: released between the insert and the update - loop and insert again
    }
  } catch (err) {
    logger.error(`[collections-flags] dispute hold FAILED customer=${customerId}: ${err.message}`);
    res = { ok: false, reason: 'write_failed' };
  }
  if (!res.ok && !res.reason) res = { ok: false, reason: 'write_failed' };
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
    if (!res || res.ok === false) return { ok: false, reason: 'suppression_write_failed', phone: canonical };
    // recordSuppression keeps a standing manual_dnc and still resolves ok:
    // read the effective reason so the card describes what is really there.
    let effectiveReason = null;
    try {
      const row = await db('messaging_suppression').where({ phone: canonical, active: true }).first('reason');
      effectiveReason = row?.reason || null;
    } catch (readErr) {
      logger.warn(`[collections-flags] wrong-number suppression re-read failed: ${readErr.message}`);
    }
    return { ok: true, phone: canonical, effectiveReason };
  } catch (err) {
    logger.error(`[collections-flags] wrong-number suppression threw: ${err.message}`);
    return { ok: false, reason: 'suppression_write_failed', phone: canonical };
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
  // A card is filed for every outcome and its copy states only what landed.
  // Whichever half failed, this is the only staff signal: the caller's
  // collection_hold fallback files a card of its own only when the hold
  // ALSO fails.
  {
    const last4 = suppression.phone ? suppression.phone.slice(-4) : null;
    const collectionsBlocked = res.ok
      ? 'Collections calls and texts to this customer are blocked'
      : 'The collections wrong-number flag could not be saved either (a billing hold may have been placed instead)';
    const numberLabel = `The number${last4 ? ` ending ${last4}` : ''}`;
    let detailText;
    if (!suppression.ok) {
      detailText = `An outbound billing follow-up call reached someone who says this number does not belong to the customer. ${collectionsBlocked}, BUT the do-not-text record for ${last4 ? `the number ending ${last4}` : 'this number'} could NOT be written: appointment reminders, review requests and other texts may still go to it. Add that number to the do-not-contact list or correct the customer's phone by hand now.`;
    } else if (!res.ok) {
      detailText = `An outbound billing follow-up call reached someone who says this number does not belong to the customer. ${numberLabel} is on the do-not-text list for every text and App notice${suppression.effectiveReason === 'manual_dnc' ? ' (the staff do-not-contact entry, which also blocks payment emails, stays in place)' : ''}, BUT the collections wrong-number flag could not be saved (a billing hold may have been placed instead). Review and correct the customer's phone, then release any hold.`;
    } else if (suppression.effectiveReason === 'manual_dnc') {
      detailText = `An outbound billing follow-up call reached someone who says this number does not belong to the customer. ${numberLabel} was already on the staff do-not-contact list, which stays in place and blocks every text, App notice and payment email to it; collections calls and texts to this customer are blocked pending a number review.`;
    } else {
      detailText = `An outbound billing follow-up call reached someone who says this number does not belong to the customer. ${numberLabel} is now on the do-not-text list for every text and App notice, and collections calls and texts to this customer are blocked pending a number review; payment emails still go to the email on file. The old number stays suppressed after you correct the customer's phone.`;
    }
    const filed = await fileFlagCard({
      customerId,
      flag: 'wrong_number',
      detail: detailText,
      manualAction: !suppression.ok || !res.ok,
    });
    if (!filed && (!suppression.ok || !res.ok)) {
      logger.error(`[collections-flags] wrong-number card ALSO failed customer=${customerId} (suppression ${suppression.ok ? 'ok' : 'MISSING'}, flag ${res.ok ? 'ok' : 'MISSING'}) — no admin card`);
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
    .select('id', 'flag', 'reason', 'created_by', 'created_at');
}

/**
 * Release an active flag — stamp released_at, never delete (the row is the
 * paper trail). Idempotent: nothing active ⇒ { ok:true, released:0 }.
 * `id` (optional) narrows the release to exactly that row — still only while
 * it is active and belongs to this customer + flag — so a staff release of the
 * hold they were looking at can never lift a newer hold placed since.
 */
async function releaseFlag({ customerId, flag, id = null, trx = null }) {
  if (!customerId || !flag) return { ok: false, reason: 'missing_args' };
  try {
    const where = { customer_id: customerId, flag };
    if (id) where.id = id;
    const released = await (trx || db)('collections_flags')
      .where(where)
      .whereNull('released_at')
      .update({ released_at: (trx || db).fn.now() });
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
