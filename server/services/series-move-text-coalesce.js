// Series-move customer text, held so only the newest move's date goes out
// (GATE_SERIES_MOVE_TEXT_COALESCE, owner ruling 2026-10-06).
//
// Evidence: staff moved one recurring series twice in a minute and the
// customer got two confirmations ("Thursday, Oct 15" at 4:41 PM, "Wednesday,
// Oct 14" at 4:42 PM). Each move texts from applySeriesMoveEffects
// (routes/admin-dispatch.js), which sent the moment the move committed.
//
// Mechanism: the EXISTING series_moves deferral. A text the sender cannot
// finish leaves notified_at NULL, and the effects reconciler
// (reconcileSeriesMoveEffects) re-runs the pass later; the markers and the
// lease make that idempotent. This module only adds the decision the pass
// asks right before it sends:
//
//   drop  - a NEWER committed, notify-requested staff move exists on the same
//           series (same anchor, or same recurring parent) for the same
//           customer. The older move's text quotes a date that is no longer
//           the plan, so it is not sent. The pass concludes it as a
//           definitive non-send and records who superseded it.
//   hold  - the move is younger than the hold. The pass keeps every other
//           effect (reminders, cards, broadcasts), skips the text, leaves
//           notified_at NULL and does not re-arm the reminder windows it
//           covered: the text, or the newer move's text, still owns them.
//   send  - the hold has run out and nothing newer exists: send as before.
//
// Each move holds from ITS OWN commit time, so a chain of moves less than
// the hold apart still ends in exactly one text, for the last move, sent one
// hold after it.
//
// Only staff board and Edit appointment moves are held. Quick Move sends its
// own moved text; customer-driven moves (web page, SMS reply, call) are not
// staff corrections. Reminder rows and every other move effect stay
// immediate: only the customer text waits.
const db = require('../models/db');
const logger = require('./logger');

// How long a move's text waits for a newer move on the same series.
const SERIES_TEXT_HOLD_MS = 3 * 60 * 1000;
// The surfaces whose text is held (all are authenticated staff actions and
// all are in the reconciler's surface list, so a held row is always retried).
const COALESCE_SURFACES = ['dispatch_board', 'edit_modal'];

function enabled() {
  return require('../config/feature-gates').seriesMoveTextCoalesceLive();
}

// A newer committed move, text requested, same customer, on the same series.
// "Same series" = the same anchor visit, or the same recurring parent when
// the move records one (a different service line has its own parent).
async function findNewerSeriesMove({ seriesMoveId, markers, conn = db }) {
  if (!markers.customer_id || !markers.created_at) return null;
  const query = conn('series_moves')
    .where({ customer_id: markers.customer_id, status: 'committed', notify_requested: true })
    .whereIn('source_surface', COALESCE_SURFACES)
    .where('created_at', '>', markers.created_at)
    .whereNot({ id: seriesMoveId })
    .where((q) => {
      q.where('anchor_service_id', markers.anchor_service_id);
      if (markers.parent_service_id) q.orWhere('parent_service_id', markers.parent_service_id);
    });
  return (await query.orderBy('created_at', 'desc').first('id', 'created_at', 'new_date')) || null;
}

// What the effects pass does with this move's customer text right now.
// `markers` is the series_moves row the pass read under its lease.
async function decideSeriesTextRelease({ seriesMoveId, markers, now = Date.now(), conn = db }) {
  if (!seriesMoveId || !markers || !enabled()) return { action: 'send' };
  if (!COALESCE_SURFACES.includes(markers.source_surface)) return { action: 'send' };
  const createdMs = new Date(markers.created_at).getTime();
  if (!Number.isFinite(createdMs)) return { action: 'send' };
  try {
    const newer = await findNewerSeriesMove({ seriesMoveId, markers, conn });
    if (newer) return { action: 'drop', supersededBy: String(newer.id) };
  } catch (err) {
    // A failed read must not strand the text: fall through to the time rule.
    logger.warn(`[series-text-coalesce] newer-move read failed for ${seriesMoveId}: ${err.message}`);
  }
  const releaseAt = createdMs + SERIES_TEXT_HOLD_MS;
  if (now < releaseAt) return { action: 'hold', releaseAt: new Date(releaseAt) };
  return { action: 'send' };
}

// Records, on the move's own row, which move replaced its text. `ownedQuery`
// returns the caller's lease-fenced query on the row; never throws.
async function recordSupersededText(ownedQuery, supersededBy, seriesMoveId) {
  logger.info(`[series-text-coalesce] move ${seriesMoveId}: customer text dropped, superseded by newer move ${supersededBy}`);
  try {
    await ownedQuery().update({
      result: db.raw("jsonb_set(COALESCE(result, '{}'::jsonb), '{textSupersededBy}', to_jsonb(?::text))", [supersededBy]),
    });
  } catch (err) {
    logger.warn(`[series-text-coalesce] could not record supersession on ${seriesMoveId}: ${err.message}`);
  }
}

module.exports = {
  SERIES_TEXT_HOLD_MS,
  COALESCE_SURFACES,
  enabled,
  findNewerSeriesMove,
  decideSeriesTextRelease,
  recordSupersededText,
};
