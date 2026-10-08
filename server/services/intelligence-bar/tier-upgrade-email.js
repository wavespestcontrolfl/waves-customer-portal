/**
 * The tier-upgrade email of an Intelligence Bar update_customer card
 * (owner 2026-10-08, GATE_IB_TIER_UPGRADE_EMAIL, dark).
 *
 * When ONE confirmed update_customer card raises a customer's WaveGuard tier
 * and changes the monthly rate that customer is billed, the customer gets the
 * membership.tier_upgraded email after the update is saved.
 *
 * Decided once, at proposal time (`proposal`): the route pins the result on
 * the stored card params (`_tier_upgrade_email`) and the card names the email
 * before Confirm. At commit (`afterCommit`, called by the executor once its
 * transaction has committed) the email goes only when the pin is there, the
 * gate is still on, and the rows the write actually committed still pass the
 * same rules. The send is fire-and-forget: it can never fail or undo the
 * customer update. Suppression (no email on file, the customer's email
 * switch) stays with account-membership-email.js sendTemplate.
 *
 * Bulk cards never reach this module: only update_customer calls it.
 */
const db = require('../../models/db');
const logger = require('../logger');

const PIN_PARAM = '_tier_upgrade_email';

function live() {
  return require('../../config/feature-gates').ibTierUpgradeEmailLive();
}

function cents(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

// A real WaveGuard member, by the customer page's own test for its
// membership emails (routes/admin-customers.js): a membership on the row that
// is not an auto-derived tier label.
function isRealMember(row) {
  const { hasMembership } = require('../membership-state');
  const { isAutoDerivedTierLabelRow } = require('../self-booking-plan-sync');
  return hasMembership(row) && !isAutoDerivedTierLabelRow(row);
}

/**
 * The send rules on a before/after pair of customer rows:
 *   - the tier moved to a HIGHER WaveGuard tier (a first tier from none is a
 *     membership start, not an upgrade; a downgrade or the same tier is not
 *     one either);
 *   - the price the customer is charged changed: the monthly rate moved AND
 *     the customer is billed monthly after the change. A stored rate on a
 *     per-application, prepaid or per-visit customer is never charged, so a
 *     change to it is not a price change (the email's "% off" line would be
 *     untrue);
 *   - the customer was a real member before and is one after, and is active.
 * Returns { eligible: true, from, to } (tier keys) or { eligible: false, reason }.
 */
function eligibility(before = {}, after = {}) {
  const { waveguardTierRank } = require('../account-membership-email')._private;
  const { membershipTierKey } = require('../membership-state');
  const fromRank = waveguardTierRank(before.waveguard_tier);
  const toRank = waveguardTierRank(after.waveguard_tier);
  if (toRank < 0) return { eligible: false, reason: 'not_a_waveguard_tier' };
  if (fromRank < 0) return { eligible: false, reason: 'first_tier' };
  if (toRank <= fromRank) return { eligible: false, reason: 'not_an_upgrade' };
  if (cents(before.monthly_rate) === cents(after.monthly_rate)) return { eligible: false, reason: 'price_unchanged' };
  if (require('../billing-lane').resolveBillingLane(after).mode !== 'monthly_membership') {
    return { eligible: false, reason: 'rate_not_billed' };
  }
  if (!isRealMember(before)) return { eligible: false, reason: 'not_a_member_before' };
  if (!isRealMember(after)) return { eligible: false, reason: 'not_a_member' };
  if (after.deleted_at || after.active === false || after.pipeline_stage === 'churned') {
    return { eligible: false, reason: 'inactive' };
  }
  return { eligible: true, from: membershipTierKey(before.waveguard_tier), to: membershipTierKey(after.waveguard_tier) };
}

/**
 * Proposal-time decision for an update_customer card. Returns null (no pin,
 * no card line) or { pin, display }. Reads only; a thrown read is the
 * caller's to turn into "no pin".
 */
async function proposal(customerId, updates) {
  if (!live()) return null;
  if (!customerId || !updates || typeof updates !== 'object') return null;
  if (updates.waveguard_tier === undefined || updates.monthly_rate === undefined) return null;
  // A card that also moves the stage or the active flag decides at commit
  // who is still an active customer (lifecycle stamps, the churn guard). The
  // card cannot promise an email on top of that, so it does not.
  if (updates.pipeline_stage !== undefined || updates.active !== undefined) return null;

  const before = await db('customers').where('id', customerId).first(
    'id', 'first_name', 'company_name', 'email', 'waveguard_tier', 'waveguard_tier_source',
    'monthly_rate', 'billing_mode', 'pipeline_stage', 'active', 'deleted_at',
  );
  if (!before) return null;
  const after = {
    ...before,
    waveguard_tier: updates.waveguard_tier,
    // The executor stamps a tier written here as 'manual' (tools.js sanitizeUpdates).
    waveguard_tier_source: updates.waveguard_tier ? 'manual' : null,
    monthly_rate: updates.monthly_rate,
    ...(updates.first_name !== undefined ? { first_name: updates.first_name } : {}),
    ...(updates.email !== undefined ? { email: updates.email } : {}),
  };
  const verdict = eligibility(before, after);
  if (!verdict.eligible) return null;

  // The card promises an email only to a customer who can get one: an
  // address on file after this edit, and the customer's email switch not off.
  const contact = require('../customer-contact').getPrimaryContact(after);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(contact.email || '').trim())) return null;
  const prefs = await db('notification_prefs').where({ customer_id: customerId }).first('email_enabled');
  if (prefs && prefs.email_enabled === false) return null;

  const { tierDisplayName } = require('../account-membership-email')._private;
  return {
    pin: { from: verdict.from, to: verdict.to },
    display: {
      first_name: String(contact.name || '').trim().split(/\s+/)[0] || 'the customer',
      from_tier: tierDisplayName(before.waveguard_tier),
      to_tier: tierDisplayName(after.waveguard_tier),
      note: 'After Confirm, the customer is emailed the tier upgrade notice with the new monthly rate. Tell the operator.',
    },
  };
}

// The card's one line for the email (authorization-contract.js). The send is
// started after commit and not waited for, so the line says "attempted" and
// what can stop it, the same way the card words the double-opt-in re-send.
function cardLine(display) {
  return `Emails ${display.first_name} the ${display.to_tier} upgrade notice after the update is saved (plan moved up from ${display.from_tier}, with the new monthly rate). Attempted, not guaranteed: it does not go if their email is turned off or the send fails, and the customer's interaction history records the result`;
}

const NOT_SENT_TEXT = {
  gate_off: 'the tier upgrade email was switched off after the card was shown',
};

/**
 * Commit side. `before` / `after` are the rows the executor committed (the
 * locked row, and that row with the written fields). Returns the fields to
 * add to the executor's result: null when the card carried no pin;
 * tier_upgrade_email 'sending' with a `message` when the send was started
 * (it is not waited for: sendTemplate records the outcome on the customer's
 * interaction history, and a failure is logged here); or 'not_sent' with the
 * reason and a `warning` when the card promised an email that is not going.
 * The finished card shows the message or the warning. Never throws.
 */
function afterCommit({ pin, customerId, before, after, operationId }) {
  if (!pin || typeof pin !== 'object') return null;
  const notSent = (reason) => ({
    tier_upgrade_email: 'not_sent',
    tier_upgrade_email_reason: reason,
    warning: `The customer record was updated. The upgrade email was NOT sent: ${NOT_SENT_TEXT[reason] || 'the plan, price or account status was not what the card showed'}.`,
  });
  try {
    if (!live()) return notSent('gate_off');
    // The idempotency key is built on the pending action id; without one a
    // repeated commit could send twice, so nothing goes.
    if (!operationId) return notSent('no_operation_id');
    const verdict = eligibility(before, after);
    if (!verdict.eligible) return notSent(verdict.reason);
    if (verdict.from !== pin.from || verdict.to !== pin.to) return notSent('tier_differs_from_card');
    const pick = (row) => ({
      waveguard_tier: row.waveguard_tier, monthly_rate: row.monthly_rate, billing_mode: row.billing_mode || null,
    });
    void require('../account-membership-email').sendMembershipTierUpgraded({
      customerId,
      before: pick(before),
      after: pick(after),
      sourceId: `ib_pending_action:${operationId}`,
      idempotencyKey: `membership.tier_upgraded:${customerId}:ib:${operationId}`,
    }).then((result) => {
      if (!result?.ok && !result?.deduped) {
        logger.warn(`[intelligence-bar] tier upgrade email not sent for ${customerId}: ${result?.reason || result?.error || 'email_not_sent'}`);
      }
    }).catch((err) => logger.warn(`[intelligence-bar] tier upgrade email failed for ${customerId}: ${err.message}`));
    return {
      tier_upgrade_email: 'sending',
      message: "The customer record was updated and the upgrade email was started. The customer's interaction history shows whether it was sent.",
    };
  } catch (err) {
    logger.warn(`[intelligence-bar] tier upgrade email setup failed for ${customerId}: ${err.message}`);
    return notSent('send_setup_failed');
  }
}

module.exports = { PIN_PARAM, proposal, cardLine, eligibility, afterCommit };
