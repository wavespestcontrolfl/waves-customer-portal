/**
 * Fires the one-time "introducing the Waves app" email when a new recurring
 * customer's technician goes EN ROUTE to their first visit — the moment the
 * app's headline feature (watch your tech arrive live) is most relevant.
 *
 * Wired from track-transitions.markEnRoute (best-effort; never blocks the
 * transition or the en-route SMS). All gating lives here so the transition
 * code stays a one-liner:
 *   - GATE_APP_INTRO_EMAIL must be 'true' (off until the apps are live in both
 *     stores; flip the env var to activate).
 *   - Recurring members only: is_recurring (a scheduled_services column on svc)
 *     plus a waveguard_tier read from the customers table — loadService() does
 *     NOT join customers, so svc.waveguard_tier is always undefined and must not
 *     be trusted here. Mirrors the welcome-SMS guard in appointment-tagger.
 *   - First visit only: no completed service_records yet. The email itself is
 *     idempotent per customer (idempotencyKey app_intro:<customerId>), but this
 *     check also keeps the existing customer base from receiving it on their
 *     next en-route after launch.
 */

const db = require('../models/db');
const logger = require('./logger');
const AccountMembershipEmail = require('./account-membership-email');

function isEnabled() {
  return String(process.env.GATE_APP_INTRO_EMAIL || '').toLowerCase() === 'true';
}

async function isFirstVisit(customerId) {
  const row = await db('service_records')
    .where({ customer_id: customerId })
    .count('* as count')
    .first();
  return parseInt(row?.count || 0, 10) === 0;
}

/**
 * @param {object} svc scheduled_services row (customer_id, is_recurring, waveguard_tier, id)
 * @returns {Promise<{sent:boolean, skipped?:boolean, reason?:string, error?:string}>}
 */
async function maybeSendOnEnRoute(svc) {
  try {
    if (!isEnabled()) return { sent: false, skipped: true, reason: 'gate_off' };
    if (!svc?.customer_id) return { sent: false, skipped: true, reason: 'no_customer' };
    // is_recurring lives on scheduled_services (present on svc); waveguard_tier
    // is a customers column that loadService() doesn't join, so read it from the
    // customer row — relying on svc.waveguard_tier would skip every send.
    if (!svc.is_recurring) {
      return { sent: false, skipped: true, reason: 'not_recurring' };
    }
    const customer = await db('customers').where({ id: svc.customer_id }).first('waveguard_tier');
    if (!customer?.waveguard_tier) {
      return { sent: false, skipped: true, reason: 'not_member' };
    }
    if (!(await isFirstVisit(svc.customer_id))) {
      return { sent: false, skipped: true, reason: 'not_first_visit' };
    }
    return await AccountMembershipEmail.sendAppIntro({ customerId: svc.customer_id, sourceId: svc.id });
  } catch (err) {
    logger.error(`[recurring-app-intro] send failed for customer ${svc?.customer_id}: ${err.message}`);
    return { sent: false, error: err.message };
  }
}

module.exports = { maybeSendOnEnRoute, isEnabled, isFirstVisit };
