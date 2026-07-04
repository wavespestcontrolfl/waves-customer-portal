/**
 * Customer self-serve reschedule deep link.
 *
 * Long URL: {portal}/reschedule/{scheduled_services.reschedule_token},
 * shortened through the branded short-url service (kind 'reschedule') the
 * same way the en-route tracking link is. Short codes deliberately never
 * expire (expires_at null, same posture as estimate links): the reschedule
 * token is stable across moves, so a customer who used the link to push the
 * visit out must be able to reuse the SAME link from an old text to change
 * it again. Eligibility is owned by the /reschedule/:token target — once the
 * visit is terminal/past, the page shows the friendly not-reschedulable
 * state, so an expiring code buys nothing and breaks that contract.
 *
 * buildRescheduleLink returns { url, line }:
 *   - url:  the short (or long, on shortener failure) URL, or null when the
 *           row has no token (legacy pre-backfill rows).
 *   - line: the ready-to-embed SMS clause for the {reschedule_line} template
 *           variable, '' when there is no URL. Clause-style var (mirroring
 *           tech_en_route's {track_clause}) so a missing link renders clean
 *           copy instead of leaving an unresolved placeholder — which would
 *           suppress the whole SMS in getTemplate's unresolved check.
 *
 * Best-effort: never throws; callers treat { url: null, line: '' } as
 * "send the message without the link".
 */

const db = require('../models/db');
const logger = require('./logger');
const { portalUrl } = require('../utils/portal-url');
const { shortenOrPassthrough } = require('./short-url');

function smsLineFor(url) {
  return url ? `Need a different time? Reschedule online: ${url}\n\n` : '';
}

async function buildRescheduleLink(scheduledServiceId, { customerId = null } = {}) {
  try {
    if (!scheduledServiceId) return { url: null, line: '' };
    const svc = await db('scheduled_services')
      .where({ id: scheduledServiceId })
      .first('id', 'customer_id', 'reschedule_token');
    if (!svc?.reschedule_token) return { url: null, line: '' };

    const longUrl = portalUrl(`/reschedule/${svc.reschedule_token}`);
    const url = await shortenOrPassthrough(longUrl, {
      kind: 'reschedule',
      entityType: 'scheduled_services',
      entityId: svc.id,
      customerId: customerId || svc.customer_id || null,
      // Never expires — see header. The /reschedule/:token page owns
      // eligibility for stale links.
      expiresAt: null,
    });
    return { url, line: smsLineFor(url) };
  } catch (err) {
    logger.warn(`[reschedule-link] build failed for ${scheduledServiceId}: ${err.message}`);
    return { url: null, line: '' };
  }
}

module.exports = { buildRescheduleLink, smsLineFor };
