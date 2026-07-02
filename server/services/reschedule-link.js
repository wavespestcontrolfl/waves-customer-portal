/**
 * Customer self-serve reschedule deep link.
 *
 * Long URL: {portal}/reschedule/{scheduled_services.reschedule_token},
 * shortened through the branded short-url service (kind 'reschedule') the
 * same way the en-route tracking link is. The short code expires 24h after
 * the appointment's window start — past that, the target page's own
 * eligibility check would show "no longer reschedulable" anyway, so a
 * longer-lived code buys nothing.
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
const { parseETDateTime } = require('../utils/datetime-et');

function smsLineFor(url) {
  return url ? `Need a different time? Reschedule online: ${url}\n\n` : '';
}

// Compose the appointment's ET start instant from scheduled_date (DATE) +
// window_start (TIME). Null when the row can't produce one.
function apptStartInstant(scheduledDate, windowStart) {
  const datePart = scheduledDate instanceof Date
    ? scheduledDate.toISOString().slice(0, 10)
    : String(scheduledDate || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datePart)) return null;
  const timePart = windowStart ? String(windowStart).slice(0, 5) : '23:59';
  const instant = parseETDateTime(`${datePart}T${timePart}`);
  return Number.isNaN(instant?.getTime?.()) ? null : instant;
}

async function buildRescheduleLink(scheduledServiceId, { customerId = null } = {}) {
  try {
    if (!scheduledServiceId) return { url: null, line: '' };
    const svc = await db('scheduled_services')
      .where({ id: scheduledServiceId })
      .first('id', 'customer_id', 'reschedule_token', 'scheduled_date', 'window_start');
    if (!svc?.reschedule_token) return { url: null, line: '' };

    const longUrl = portalUrl(`/reschedule/${svc.reschedule_token}`);
    const start = apptStartInstant(svc.scheduled_date, svc.window_start);
    const expiresAt = start
      ? new Date(start.getTime() + 24 * 60 * 60 * 1000)
      : null;

    const url = await shortenOrPassthrough(longUrl, {
      kind: 'reschedule',
      entityType: 'scheduled_services',
      entityId: svc.id,
      customerId: customerId || svc.customer_id || null,
      expiresAt,
    });
    return { url, line: smsLineFor(url) };
  } catch (err) {
    logger.warn(`[reschedule-link] build failed for ${scheduledServiceId}: ${err.message}`);
    return { url: null, line: '' };
  }
}

module.exports = { buildRescheduleLink, smsLineFor };
