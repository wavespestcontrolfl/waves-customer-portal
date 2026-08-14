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
    await NotificationService.notifyAdmin(
      'billing',
      `Billing follow-up call: ${flag.replace(/_/g, ' ')}`,
      detail,
      { link: `/admin/customers/${customerId}`, metadata: { customerId, flag, source: 'collections_voice' } },
    );
    return true;
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
      detail: 'An outbound billing follow-up call reached someone who says this number does not belong to the customer. All outreach to this customer is blocked pending a number review.',
    });
  }
  return res;
}

module.exports = {
  writeFlag,
  revokeAutomatedVoiceConsent,
  placeDisputeHold,
  flagWrongNumber,
  fileFlagCard,
};
