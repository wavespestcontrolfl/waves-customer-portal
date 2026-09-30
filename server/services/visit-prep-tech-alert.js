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
 * Ordering: the push is delivered under the SAME per-visit advisory lock as
 * a visit notice's push (utils/tech-visit-push-lock.js, keyed on the
 * scheduled_services id both use), so a photo alert and a move/cancel notice
 * for one stop can never interleave across app instances; the in-process
 * chain (enqueueForVisit) only orders within one instance. The staleness
 * rules (still that tech's stop, still on the route, still assignable) run
 * under the lock as the sender's beforeDispatch, immediately before the
 * provider handoff.
 *
 * Never throws; every failure is caught and logged so a card or push
 * problem can never surface to (or block) the customer's request.
 */
const db = require('../models/db');
const logger = require('./logger');
const { visitPrepPhotosLive, visitPrepTechAlertsLive } = require('../config/feature-gates');
const { isAssignable, applyAssignable } = require('./technician-eligibility');
const { JOIN_INELIGIBLE_STATUSES } = require('./visit-context/statuses');
const { dateOnlyString } = require('../utils/datetime-et');
const { techAccessCutoff } = require('./technician-visit-scope');
const { sendUnderVisitPushLock } = require('../utils/tech-visit-push-lock');

const TYPE = 'customer_visit_photos';

// Statuses that take a visit off the route while it keeps technician_id:
// the canonical join-ineligible set (terminal + rescheduled).
const OFF_ROUTE_STATUSES = JOIN_INELIGIBLE_STATUSES;

// Exact copy (owner-approved, scope doc §5.4 item 4): one line, no
// customer name/address/note — the same lock-screen discipline as every
// PUSH_TITLE_BY_KIND line in tech-visit-notifications.js.
const PUSH_TITLE = 'A customer sent photos for a visit on your route';

function enabled() {
  return visitPrepTechAlertsLive() && visitPrepPhotosLive();
}

// The visit row, read under FOR SHARE inside the card's own transaction
// (the same pattern tech-visit-notifications.js writeCard uses): a
// reassignment or regroup either commits before this read — and the card
// follows it — or waits for the card to land. Recipient, visit key and
// date all come from this ONE read (Codex #5303 r1 P2 x2).
async function loadVisitLocked(scheduledServiceId, trx) {
  return trx('scheduled_services')
    .where({ id: scheduledServiceId })
    .forShare()
    .first('id', 'technician_id', 'visit_id', 'scheduled_date', 'status');
}


// Writes the card and returns the recipient, or null when there is no one
// to tell. Throws only on a database error (the caller logs it).
async function writeCard(scheduledServiceId) {
  return db.transaction(async (trx) => {
    const row = await loadVisitLocked(scheduledServiceId, trx);
    if (!row?.technician_id) return null;
    // Cancelled or completed since the photos landed (a transition keeps
    // technician_id): no longer a visit on anyone's route (Codex #5303 r2).
    // 'rescheduled' also leaves the route (awaiting a new date) while
    // keeping technician_id (Codex #5303 r3 P1).
    if (OFF_ROUTE_STATUSES.includes(row.status)) return null;
    const technicianId = String(row.technician_id);
    // FOR SHARE: a Team edit that makes this tech office-only either lands
    // before this read or waits for the card (Codex #5303 r3 P2).
    const tech = await trx('technicians').where({ id: technicianId }).forShare()
      .first('id', 'employment_status', 'field_dispatchable');
    if (!isAssignable(tech)) return null;
    await trx('tech_notifications').insert({
      technician_id: technicianId,
      type: TYPE,
      message: PUSH_TITLE,
      payload: JSON.stringify({
        scheduled_service_id: row.id,
        visit_id: row.visit_id || null,
        scheduled_date: dateOnlyString(row.scheduled_date),
      }),
    });
    return technicianId;
  });
}

async function stillAlertable(scheduledServiceId, technicianId, conn = db) {
  const q = conn('scheduled_services as s')
    .join('technicians as t', 't.id', 's.technician_id')
    .where('s.id', scheduledServiceId)
    .where('s.technician_id', technicianId)
    .whereNotIn('s.status', OFF_ROUTE_STATUSES);
  applyAssignable(q, 't');
  return !!(await q.first('s.id'));
}

/**
 * @param {object} args
 * @param {string} args.scheduledServiceId  the row the photos were stored
 *   against (persistLocked's `current.id`). The recipient, visit key and
 *   date are all re-read from this id under lock — never passed in.
 */
async function notifyTechVisitPrepPhotos({ scheduledServiceId } = {}) {
  if (!scheduledServiceId) return;
  try {
    if (!enabled()) return;
  } catch (err) {
    logger.error(`[visit-prep-tech-alert] gate read failed for visit ${scheduledServiceId}: ${err.message}`);
    return;
  }
  // Through tech-visit-notifications.js's per-visit queue (Codex #5303 r4
  // P1): a reassignment or cancellation right after the photos lands its
  // card AND push strictly after this one, never overtaken by a slow push.
  const { enqueueForVisit } = require('./tech-visit-notifications');
  await enqueueForVisit(scheduledServiceId, () => sendPhotoAlert(scheduledServiceId));
}

async function sendPhotoAlert(scheduledServiceId) {
  try {
    const technicianId = await writeCard(scheduledServiceId);
    if (!technicianId) return;
    try {
      const PushService = require('./push-notifications');
      // The last liveness check runs INSIDE the sender, after its
      // subscription lookup and immediately before the provider handoff
      // (push-notifications.js beforeDispatch; Codex #5303 r10): a
      // reassignment, cancellation or office-only edit committed up to
      // that point sends nothing. The card itself is re-scoped on every
      // feed read.
      // Under the visit's cross-instance push lock (see the header). The
      // liveness check stays in beforeDispatch, so it runs under the lock.
      await sendUnderVisitPushLock(scheduledServiceId, {
        // The liveness read is the lock's recheck, run as the sender's
        // beforeDispatch (after the lookup, right before the handoff). One
        // connection per holder: lookup and recheck run on the lock's own.
        isCurrent: (conn) => stillAlertable(scheduledServiceId, technicianId, conn),
        send: (conn, { deadlineAt, beforeDispatch }) => PushService.sendToAdminUsers([technicianId], {
          title: PUSH_TITLE,
          body: '',
          url: '/tech',
          tag: `visit-prep-${scheduledServiceId}`,
          priority: 'high',
        }, { beforeDispatch, connection: conn, deadlineAt }),
      });
    } catch (pushErr) {
      // The card is already durable — a push failure never loses it.
      logger.warn(`[visit-prep-tech-alert] push failed for tech ${technicianId} (card already written): ${pushErr.message}`);
    }
  } catch (err) {
    logger.error(`[visit-prep-tech-alert] failed for visit ${scheduledServiceId}: ${err.message}`);
  }
}

// Read-time reconcile for the tech feed (Codex #5303 r5 P1). A photo card
// is a pointer at a live visit, not a snapshot: it is served only while its
// scheduled_services row is still assigned to the card's technician and
// still on the route. A reassignment, reschedule-out or cancellation after
// the card was written hides it at once, with no per-transition hook to
// keep in step. Applied inside the feed query, before its row limit.
function scopePhotoCardsToLiveVisits(q, conn) {
  return q.where(function livePhotoCards() {
    this.whereNot({ type: TYPE }).orWhereExists(function liveVisit() {
      // …and the technician is still a field tech (an office-only edit
      // keeps future visits assigned; Codex #5303 r7 P2), via the shared
      // technician-eligibility predicate.
      const liveVisit = this.select(conn.raw('1')).from('scheduled_services as s')
        .join('technicians as t', 't.id', 's.technician_id')
        .whereRaw("s.id = (tech_notifications.payload->>'scheduled_service_id')::uuid")
        .whereRaw('s.technician_id = tech_notifications.technician_id')
        .whereNotIn('s.status', OFF_ROUTE_STATUSES)
        // The canonical technician access window (technician-visit-scope.js):
        // past it the Visit Brief and its photos refuse the tech, so the card
        // goes too (Codex #5303 r12 P1).
        .where('s.scheduled_date', '>=', techAccessCutoff());
      applyAssignable(liveVisit, 't');
    });
  });
}

// The card's date comes from the visit as it is now (a same-tech move
// keeps the card, with the new date), read with the SAME live-visit rules
// as the feed scope: a card whose visit stopped qualifying between the feed
// query and this read is dropped, not returned (Codex #5303 r14). Returns
// the rows to serve.
async function refreshPhotoCardDates(rows, conn) {
  const cards = rows.filter((r) => r.type === TYPE && r.payload?.scheduled_service_id);
  if (!cards.length) return rows;
  const q = conn('scheduled_services as s')
    .join('technicians as t', 't.id', 's.technician_id')
    .whereIn('s.id', [...new Set(cards.map((r) => r.payload.scheduled_service_id))])
    .whereNotIn('s.status', OFF_ROUTE_STATUSES)
    .where('s.scheduled_date', '>=', techAccessCutoff());
  applyAssignable(q, 't');
  const live = await q.select('s.id', 's.scheduled_date', 's.visit_id', 's.technician_id');
  const byId = new Map(live.map((v) => [String(v.id), v]));
  return rows.filter((r) => {
    if (r.type !== TYPE || !r.payload?.scheduled_service_id) return true;
    const v = byId.get(String(r.payload.scheduled_service_id));
    if (!v || String(v.technician_id) !== String(r.technician_id)) return false;
    r.payload = { ...r.payload, scheduled_date: dateOnlyString(v.scheduled_date), visit_id: v.visit_id || null };
    return true;
  });
}

module.exports = {
  TYPE,
  PUSH_TITLE,
  notifyTechVisitPrepPhotos,
  scopePhotoCardsToLiveVisits,
  refreshPhotoCardDates,
  isEnabled: enabled,
  _internal: { loadVisitLocked, writeCard, stillAlertable },
};
