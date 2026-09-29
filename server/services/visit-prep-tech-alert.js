/**
 * Tech card + push for a customer's visit-prep photo submission
 * (PR 6, customer-visit-photos scope doc §5.4 item 4; owner is hiring
 * technicians — design for a multi-tech team, not just Adam).
 *
 * Extends the EXISTING tech-visit-notifications.js mechanism — the same
 * `tech_notifications` row + best-effort push through
 * PushService.sendToAdminUser(technicianId) — with one new type,
 * `customer_visit_photos`, rather than building a parallel delivery path.
 *
 * Its own gate, GATE_VISIT_PREP_TECH_ALERTS (visitPrepTechAlertsLive()),
 * is strict opt-in and DELIBERATELY INDEPENDENT of
 * GATE_TECH_VISIT_NOTIFICATIONS (off in production): this can be the
 * first tech visit card to go live, reusing that mechanism's plumbing
 * without depending on its own kill switch. It ALSO requires
 * visitPrepPhotosLive() — the photos feature itself must be on, or there
 * is nothing to alert about.
 *
 * Called post-commit, fire-and-forget, from visit-prep.js's
 * createVisitPrepSubmission — the ONE place a submission is created, so
 * both the public appointment page and the customer-auth app route
 * inherit this with no per-route wiring. The caller only invokes this for
 * a submission that actually stored something new (never a
 * duplicate-only resubmit).
 *
 * Recipient: the visit's CURRENT assigned technician, re-read fresh from
 * scheduled_services at SEND time — never the pre-lock row a caller might
 * still be holding, and not even the write's own recheck()'d row: a beat
 * can pass between that commit and this fire-and-forget call, and a
 * reassignment in that window must reach the tech who actually holds the
 * stop, not the one who held it when the photos landed. No technician on
 * the row, or a non-assignable one (technician-eligibility.js), → no
 * card. A grouped stop's live members share one technician by
 * construction (visit-groups.js), so resolving the triggering row's own
 * technician resolves the stop's — one card per submission, never one per
 * member.
 *
 * Never throws; every failure is caught and logged so a card or push
 * problem can never surface to (or block) the customer's request.
 */
const db = require('../models/db');
const logger = require('./logger');
const { visitPrepPhotosLive, visitPrepTechAlertsLive } = require('../config/feature-gates');
const { isAssignable } = require('./technician-eligibility');

const TYPE = 'customer_visit_photos';

// Exact copy (owner-approved, scope doc §5.4 item 4): one line, no
// customer name/address/note — the same lock-screen discipline as every
// PUSH_TITLE_BY_KIND line in tech-visit-notifications.js.
const PUSH_TITLE = 'A customer sent photos for a visit on your route';

function enabled() {
  return visitPrepTechAlertsLive() && visitPrepPhotosLive();
}

// Fresh read, never the caller's row (see file header).
async function currentTechnicianId(scheduledServiceId, conn) {
  const row = await conn('scheduled_services').where({ id: scheduledServiceId }).first('technician_id');
  return row?.technician_id ? String(row.technician_id) : null;
}

/**
 * @param {object} args
 * @param {string} args.scheduledServiceId  the row the photos were stored
 *   against (persistLocked's `current.id`) — the recipient is resolved
 *   fresh from this id, not passed in.
 * @param {string|null} [args.visitId]  scheduled_services.visit_id at
 *   submission time, carried on the card payload for a future deep link
 *   only — never used to pick the recipient.
 */
async function notifyTechVisitPrepPhotos({ scheduledServiceId, visitId = null } = {}) {
  if (!scheduledServiceId) return;
  try {
    if (!enabled()) return;

    const technicianId = await currentTechnicianId(scheduledServiceId, db);
    if (!technicianId) return;

    const tech = await db('technicians').where({ id: technicianId })
      .first('id', 'employment_status', 'field_dispatchable');
    if (!isAssignable(tech)) return;

    await db('tech_notifications').insert({
      technician_id: technicianId,
      type: TYPE,
      message: PUSH_TITLE,
      payload: JSON.stringify({ scheduled_service_id: scheduledServiceId, visit_id: visitId || null }),
    });

    try {
      const PushService = require('./push-notifications');
      await PushService.sendToAdminUser(technicianId, {
        title: PUSH_TITLE,
        body: '',
        url: '/tech',
        tag: `visit-prep-${scheduledServiceId}`,
        priority: 'high',
      });
    } catch (pushErr) {
      // The card is already durable — a push failure never loses it.
      logger.warn(`[visit-prep-tech-alert] push failed for tech ${technicianId} (card already written): ${pushErr.message}`);
    }
  } catch (err) {
    logger.error(`[visit-prep-tech-alert] failed for visit ${scheduledServiceId}: ${err.message}`);
  }
}

module.exports = {
  TYPE,
  PUSH_TITLE,
  notifyTechVisitPrepPhotos,
  isEnabled: enabled,
  _internal: { currentTechnicianId },
};
