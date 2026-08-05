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
const { reserviceSelfServeEnabled } = require('./reservice-scheduler');

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

module.exports = { buildReserviceLink, reserviceSmsLineFor };
