/**
 * Customer appointment deep link — the one link the 24h reminder and the
 * booking confirmation text send.
 *
 * Long URL: {portal}/appointment/{scheduled_services.reschedule_token},
 * shortened through the same branded short-url service the reschedule and
 * en-route links use. Deliberately REUSES reschedule_token rather than
 * minting a second secret: it already exists on every visit, is stable
 * across moves (so an old text keeps working after a reschedule), and the
 * /appointment/:token target owns eligibility exactly like /reschedule
 * does. One token per visit is also one thing to reason about when
 * auditing what a texted link can reach.
 *
 * Short codes never expire (same posture as the reschedule link) — the
 * page shows a friendly "this visit is done / cancelled" state instead.
 *
 * buildAppointmentLink returns { url, line }:
 *   - url:  short (or long, on shortener failure) URL, null when the row
 *           has no token (legacy pre-backfill rows).
 *   - line: ready-to-embed SMS clause for the {appointment_line} template
 *           variable, '' when there is no URL — clause-style so a missing
 *           link renders clean copy instead of leaving an unresolved
 *           placeholder (which would suppress the whole SMS).
 *
 * Best-effort: never throws; callers treat { url: null, line: '' } as
 * "send the message without the link".
 */

const db = require('../models/db');
const logger = require('./logger');
const { portalUrl } = require('../utils/portal-url');
const { shortenOrPassthrough } = require('./short-url');

// Clause-style (trailing blank line included) so an absent link collapses
// cleanly instead of leaving a gap or an unresolved placeholder. `label`
// lets each caller frame the same page for its moment — a reminder points
// at the details, a fresh booking points at the Confirm button.
function smsLineFor(url, label = 'Everything about your visit') {
  return url ? `${label}: ${url}\n\n` : '';
}

async function buildAppointmentLink(scheduledServiceId, { customerId = null, label } = {}) {
  try {
    // Mint nothing while the gate is off: the page this URL points at 404s,
    // the v2 template that would embed it never renders, and every legacy
    // confirmation/reminder would otherwise insert a never-expiring
    // short_codes row for an unreachable destination — permanent table
    // growth for nothing. Gate here (the single choke point) rather than at
    // each caller.
    if (process.env.GATE_APPOINTMENT_PAGE !== 'true') return { url: null, line: '' };
    if (!scheduledServiceId) return { url: null, line: '' };
    const svc = await db('scheduled_services')
      .where({ id: scheduledServiceId })
      .first('id', 'customer_id', 'reschedule_token');
    if (!svc?.reschedule_token) return { url: null, line: '' };

    const longUrl = portalUrl(`/appointment/${svc.reschedule_token}`);
    // Idempotent per visit: the page URL is deterministic (one token, one
    // page), so the FIRST minted code serves every message about this
    // visit — confirmation now, the 24h reminder later. This also caps an
    // eagerly rendered body whose SMS leg never runs (email-preference
    // paths) at one reused row per visit rather than an orphan per render.
    const { existingShortUrlFor } = require('./short-url');
    const reused = await existingShortUrlFor({
      kind: 'appointment', entityType: 'scheduled_services', entityId: svc.id,
    });
    if (reused) return { url: reused, line: smsLineFor(reused, label) };
    const url = await shortenOrPassthrough(longUrl, {
      kind: 'appointment',
      entityType: 'scheduled_services',
      entityId: svc.id,
      customerId: customerId || svc.customer_id || null,
      expiresAt: null,
    });
    return { url, line: smsLineFor(url, label) };
  } catch (err) {
    logger.warn(`[appointment-link] build failed for ${scheduledServiceId}: ${err.message}`);
    return { url: null, line: '' };
  }
}

module.exports = { buildAppointmentLink, smsLineFor };
