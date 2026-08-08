/**
 * Customer self-serve re-service deep link.
 *
 * Long URL: {portal}/reservice/{customers.reservice_token}, shortened through
 * the branded short-url service (kind 'reservice') the same way the
 * reschedule link is. Short codes deliberately never expire (expires_at
 * null): the token is standing for the life of the customer, and eligibility
 * is owned by the /reservice/:token target — a lapsed plan renders the
 * friendly not-eligible state there, so an expiring code buys nothing.
 *
 * Gate-aware: while GATE_RESERVICE_SELF_SERVE is off this returns
 * { url: null, line: '' } so no dark-launch link ever rides an SMS.
 *
 * buildReserviceLink returns { url, line }:
 *   - url:  the short (or long, on shortener failure) URL, or null when the
 *           customer has no token (pre-backfill row) or the gate is off.
 *   - line: the ready-to-embed SMS clause, '' when there is no URL —
 *           clause-style like reschedule-link's {reschedule_line} so a
 *           missing link renders clean copy instead of an unresolved
 *           placeholder.
 *
 * Best-effort: never throws; callers treat { url: null, line: '' } as
 * "send the message without the link".
 */

const db = require('../models/db');
const logger = require('./logger');
const { portalUrl } = require('../utils/portal-url');
const { shortenOrPassthrough } = require('./short-url');
const { reserviceSelfServeEnabled, reserviceLanesForCustomer } = require('./reservice-scheduler');

function reserviceSmsLineFor(url) {
  return url ? `Book your free re-service here: ${url}\n\n` : '';
}

async function buildReserviceLink(customerId) {
  try {
    if (!customerId || !reserviceSelfServeEnabled()) return { url: null, line: '' };
    const customer = await db('customers')
      .where({ id: customerId })
      .whereNull('deleted_at')
      .first('id', 'reservice_token');
    if (!customer?.reservice_token) return { url: null, line: '' };

    const longUrl = portalUrl(`/reservice/${customer.reservice_token}`);
    const url = await shortenOrPassthrough(longUrl, {
      kind: 'reservice',
      entityType: 'customers',
      entityId: customer.id,
      customerId: customer.id,
      // Never expires — see header. The /reservice/:token page owns
      // eligibility for stale links.
      expiresAt: null,
    });
    return { url, line: reserviceSmsLineFor(url) };
  } catch (err) {
    logger.warn(`[reservice-link] build failed for ${customerId}: ${err.message}`);
    return { url: null, line: '' };
  }
}

/**
 * The {reservice_line} value for the automatic post-service texts
 * (service_complete* / service_report_v1* / review_request).
 *
 * RETIRED — owner directive 2026-08-08: the automatic texts no longer carry a
 * re-service booking link. Always ''. The contract half (migration
 * 20260808060000) strips the {reservice_line} token from those template
 * bodies; this helper stays wired into every render site because an
 * UNSUPPLIED key suppresses the whole message (getTemplate's
 * unresolved-placeholder check), so any body still carrying the token — an
 * owner-customized variant, a row restored from backup, a database the
 * migration has not reached yet — must resolve to empty rather than silence a
 * completion text.
 *
 * The re-service scheduler itself is untouched: the portal card, the report
 * footer link, and the admin composer's insert-link button all still run off
 * buildReserviceLink / reserviceStreamlineAccess below.
 */
async function reserviceLineForCustomer() {
  return '';
}

/**
 * Shared streamline eligibility check — one implementation for the SMS clause
 * above and the report-page link, so the two delivery surfaces can't drift.
 * null (the safe render) unless both gates are lit, the customer row is live
 * with a reservice_token, and the plan grants at least one lane. Never throws.
 */
async function reserviceStreamlineAccess(customerId) {
  try {
    if (!customerId) return null;
    const { isEnabled } = require('../config/feature-gates');
    if (!isEnabled('reserviceStreamline') || !reserviceSelfServeEnabled()) return null;
    const customer = await db('customers')
      .where({ id: customerId })
      .whereNull('deleted_at')
      .first('id', 'active', 'waveguard_tier', 'monthly_rate', 'reservice_token');
    if (!customer || customer.active === false || !customer.reservice_token) return null;
    const lanes = await reserviceLanesForCustomer(customer);
    if (!lanes.length) return null;
    return { token: customer.reservice_token, lanes };
  } catch (err) {
    logger.warn(`[reservice-link] access lookup failed for ${customerId}: ${err.message}`);
    return null;
  }
}

module.exports = {
  buildReserviceLink,
  reserviceSmsLineFor,
  reserviceLineForCustomer,
  reserviceStreamlineAccess,
};
