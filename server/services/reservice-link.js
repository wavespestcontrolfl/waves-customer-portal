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

// Clause for the automatic post-service texts ({reservice_line} in the
// completion/report/review templates) — context-framed so it reads as "if
// something comes back" rather than the composer line's bare imperative.
function reserviceFollowupLineFor(url) {
  return url ? `If a covered issue comes back, book a free re-service: ${url}\n\n` : '';
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
 * '' — the safe, byte-identical-to-today render — unless ALL of:
 *   - GATE_RESERVICE_STREAMLINE on (the delivery streamline is Adam's flip;
 *     buildReserviceLink's own GATE_RESERVICE_SELF_SERVE check still applies
 *     underneath, so both gates must be lit),
 *   - the customer's LIVE plan state grants a pest or lawn lane
 *     (reserviceLanesForCustomer — a mosquito-only or lapsed plan never gets
 *     the line; the office-call families stay office calls),
 *   - the customer row is active with a reservice_token.
 *
 * Never throws: every render site passes this value into a template that
 * carries the {reservice_line} token, and an UNSUPPLIED key suppresses the
 * whole message (getTemplate's unresolved-placeholder check) — so this
 * helper must always resolve to a string.
 */
async function reserviceLineForCustomer(customerId) {
  try {
    const access = await reserviceStreamlineAccess(customerId);
    if (!access) return '';
    const { url } = await buildReserviceLink(customerId);
    return reserviceFollowupLineFor(url);
  } catch (err) {
    logger.warn(`[reservice-link] line lookup failed for ${customerId}: ${err.message}`);
    return '';
  }
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
  reserviceFollowupLineFor,
  reserviceLineForCustomer,
  reserviceStreamlineAccess,
};
