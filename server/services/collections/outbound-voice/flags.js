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
async function placeDisputeHold(customerId, { summary, createdBy } = {}) {
  const disputeReason = summary ? `${DISPUTE_REASON_PREFIX} on call: ${summary}` : `${DISPUTE_REASON_PREFIX} raised on call`;
  let res = await writeFlag({
    customerId,
    flag: HOLD_FLAG,
    reason: disputeReason,
    createdBy,
  });
  if (res.ok && res.created === false) {
    try {
      const active = await db('collections_flags')
        .where({ customer_id: customerId, flag: HOLD_FLAG })
        .whereNull('released_at')
        .first('id', 'reason');
      if (active && !String(active.reason || '').toLowerCase().startsWith(DISPUTE_REASON_PREFIX)) {
        await db('collections_flags').where({ id: active.id }).update({
          reason: `${disputeReason}; earlier hold: ${active.reason || 'no reason recorded'}`.slice(0, 500),
        });
      }
    } catch (err) {
      logger.error(`[collections-flags] dispute upgrade of the active collection_hold FAILED customer=${customerId}: ${err.message}`);
      res = { ok: false, reason: 'write_failed' };
    }
  }
  if (res.ok) {
    await fileFlagCard({
      customerId,
      flag: 'collection_hold',
      detail: `Customer raised a billing dispute on a follow-up call — all balance outreach is now on hold pending review.${summary ? ` Summary: ${summary}` : ''}`,
    });
  }
  return res;
}

/** Wrong-party answer where the answerer says the customer is unknown here. */
async function flagWrongNumber(customerId, { detail, createdBy } = {}) {
  const res = await writeFlag({
    customerId,
    flag: 'wrong_number',
    reason: detail || 'answerer reported wrong number on outbound call',
    createdBy,
  });
  if (res.ok) {
    await fileFlagCard({
      customerId,
      flag: 'wrong_number',
      detail: 'An outbound billing follow-up call reached someone who says this number does not belong to the customer. Calls, texts and App notices to this customer are blocked pending a number review; payment emails still go to the email on file.',
    });
  }
  return res;
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
  fileFlagCard,
};
