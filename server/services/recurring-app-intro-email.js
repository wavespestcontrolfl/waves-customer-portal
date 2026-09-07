/**
 * Fires the one-time "introducing the Waves app" email when a new
 * customer's technician goes EN ROUTE to their first visit — the moment the
 * app's headline feature (watch your tech arrive live) is most relevant.
 *
 * Wired from track-transitions.markEnRoute (best-effort; never blocks the
 * transition or the en-route SMS). All gating lives here so the transition
 * code stays a one-liner:
 *   - GATE_APP_INTRO_EMAIL must be 'true' (off until the apps are live in both
 *     stores; flip the env var to activate).
 *   - First service day only: no earlier reports or completed/on-site visits.
 *     The email itself is
 *     idempotent per customer (idempotencyKey app_intro:<customerId>), but this
 *     check also keeps the existing customer base from receiving it on their
 *     next en-route after launch.
 */

const logger = require('./logger');
const AccountMembershipEmail = require('./account-membership-email');
const { isFirstServiceVisit } = require('./customer-visit-history');

function isEnabled() {
  return String(process.env.GATE_APP_INTRO_EMAIL || '').toLowerCase() === 'true';
}

async function appIntroEligibility(svc) {
  if (!svc?.customer_id) return { eligible: false, reason: 'no_customer' };
  // An auto-derived LABEL-ONLY tier (GATE_AUTO_WAVEGUARD_TIER stamp on a
  // per-visit customer) is not membership for messaging purposes — the tier
  // stamp is contractually comms-silent, and unverifiable provenance
  // ('unknown') suppresses rather than sends (Codex #3011 r9/r10). Lazy
  // require avoids a cycle.
  const { tierLabelStatus } = require('./self-booking-plan-sync');
  if ((await tierLabelStatus(svc.customer_id)) !== 'not_label') {
    return { eligible: false, reason: 'label_only_tier' };
  }
  if (!(await isFirstServiceVisit(svc.customer_id, svc.scheduled_date))) {
    return { eligible: false, reason: 'not_first_visit' };
  }
  return { eligible: true, reason: 'first_visit' };
}

/**
 * @param {object} svc scheduled_services row (customer_id, scheduled_date, track_view_token, id)
 * @returns {Promise<{sent:boolean, skipped?:boolean, reason?:string, error?:string}>}
 */
async function maybeSendOnEnRoute(svc) {
  try {
    if (!isEnabled()) return { sent: false, skipped: true, reason: 'gate_off' };
    const eligibility = await appIntroEligibility(svc);
    if (!eligibility.eligible) return { sent: false, skipped: true, reason: eligibility.reason };
    return await AccountMembershipEmail.sendAppIntro({
      customerId: svc.customer_id,
      sourceId: svc.id,
      trackToken: svc.track_view_token,
      trackTokenExpiresAt: svc.track_token_expires_at,
    });
  } catch (err) {
    logger.error(`[recurring-app-intro] send failed for customer ${svc?.customer_id}: ${err.message}`);
    return { sent: false, error: err.message };
  }
}

module.exports = { maybeSendOnEnRoute, isEnabled, appIntroEligibility };
