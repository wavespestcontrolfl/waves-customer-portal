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
//   drop  - a NEWER committed, notify-requested staff move exists for the same
//           customer that supersedes this move's anchor (see findNewerSeriesMove).
//           The older move's text quotes a date that is no longer the plan, so it is not sent. The pass concludes it as a
//           definitive non-send and records who superseded it.
//   hold  - the move is younger than the hold. The pass keeps every other
//           effect (reminders, cards, broadcasts), skips the text, leaves
//           notified_at NULL and does not re-arm the reminder windows it
//           covered: the text, or the newer move's text, still owns them.
//           The existing series-move reconcile job (one scheduler, one lock)
//           releases it when the hold ends.
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
// How long a move's text stays in the held-text rule: the release sweep selects
// a move only while it is younger than this, and an inconclusive supersession
// lookup holds the text only until the move reaches this age, then sends.
const SERIES_TEXT_HELD_WINDOW_MS = 30 * 60 * 1000;

function enabled() {
  return require('../config/feature-gates').seriesMoveTextCoalesceLive();
}

// A newer committed move, text requested, same customer, that SUPERSEDES this
// move's anchor: it moved that same anchor visit, or its recorded shifted set
// (result.rescheduledOccurrences, which rescheduleSeries persists) includes
// it. Sharing a recurring parent proves nothing: a series move shifts only
// the visit staff picked and the LATER ones, so moving a later occurrence
// leaves an earlier move's slot valid and its text still owed. A result that
// cannot prove inclusion falls back to the same anchor only (toward sending).
async function findNewerSeriesMove({ seriesMoveId, markers, conn = db }) {
  if (!markers.customer_id || !markers.created_at) return null;
  const query = conn('series_moves')
    .where({ customer_id: markers.customer_id, status: 'committed', notify_requested: true })
    .whereIn('source_surface', COALESCE_SURFACES)
    .where('created_at', '>', markers.created_at)
    .whereNot({ id: seriesMoveId })
    .where((q) => q.where('anchor_service_id', markers.anchor_service_id)
      .orWhereRaw("COALESCE(result->'rescheduledOccurrences', '[]'::jsonb) @> ?::jsonb", [JSON.stringify([{ id: String(markers.anchor_service_id) }])]));
  return (await query.orderBy('created_at', 'desc').first('id', 'created_at', 'new_date')) || null;
}

// What the effects pass does with this move's customer text right now.
// `markers` is the series_moves row the pass read under its lease.
// `holdStartedMs` is when the hold began: the first effects pass AFTER the
// commit (series_moves.created_at is the transaction START, so a move that
// waited on locks would reach its hold already expired). Without one, the
// hold counts from created_at.
//
// An inconclusive supersession lookup (the read threw) is not a "no newer
// move": the text is HELD for the next pass instead of sent with a possibly
// stale date, until the move is older than SERIES_TEXT_HELD_WINDOW_MS, then
// it is sent anyway (the customer should hear something). Every pass, live,
// release sweep or 15-minute reconciler, runs this same rule.
async function decideSeriesTextRelease({ seriesMoveId, markers, holdStartedMs = NaN, now = Date.now(), conn = db }) {
  if (!seriesMoveId || !markers || !enabled()) return { action: 'send' };
  if (!COALESCE_SURFACES.includes(markers.source_surface)) return { action: 'send' };
  const createdMs = new Date(markers.created_at).getTime();
  if (!Number.isFinite(createdMs)) return { action: 'send' };
  let newer = null;
  let lookupFailed = false;
  try {
    newer = await findNewerSeriesMove({ seriesMoveId, markers, conn });
  } catch (err) {
    lookupFailed = true;
    logger.warn(`[series-text-coalesce] newer-move read failed for ${seriesMoveId}: ${err.message}`);
  }
  if (newer) return { action: 'drop', supersededBy: String(newer.id) };
  const releaseAt = (Number.isFinite(holdStartedMs) ? holdStartedMs : createdMs) + SERIES_TEXT_HOLD_MS;
  const held = lookupFailed ? now - createdMs < SERIES_TEXT_HELD_WINDOW_MS : now < releaseAt;
  return held ? { action: 'hold', releaseAt: new Date(releaseAt) } : { action: 'send' };
}

// Records when this move's hold began (its first post-commit effects pass) in
// the row's own result jsonb: no migration, fenced on the pass's lease by
// `ownedRow`, and only when still unset. Answers the start (ms), or NaN when
// the write failed (the hold then counts from created_at).
async function stampHoldStart({ ownedRow, seriesMoveId, atMs }) {
  try {
    await ownedRow(db('series_moves'))
      .whereRaw("result->>'textHoldStartedAt' IS NULL")
      .update({ result: db.raw("jsonb_set(COALESCE(result, '{}'::jsonb), '{textHoldStartedAt}', to_jsonb(?::text))", [new Date(atMs).toISOString()]) });
    return atMs;
  } catch (err) {
    logger.warn(`[series-text-coalesce] could not stamp the hold start on ${seriesMoveId}: ${err.message}`);
    return NaN;
  }
}

// What the effects pass does with the customer text, in the two values its
// existing text branching already consumes: `send` (may this pass text now)
// and `sent` (the pass's starting result). `notify` is the move's recorded
// intent. Held and superseded texts answer send:false with sent:null, not
// false: a staff screen shows a "text failed" notice only for false, and
// neither is a failure. A held text leaves notified_at NULL for the
// reconciler. A superseded text concludes here as a definitive non-send
// (notified_at stamped, customer_notified false, fenced on the pass's lease
// by `stampMarker`) and names the move that replaced it, so it is never
// retried and never silently lost. A move whose text already concluded or
// went out is passed through untouched. Gate off: { send: notify, sent: false }.
async function resolveSeriesTextRelease({ notify, seriesMoveId, markers, stampMarker, ownedRow, now = Date.now(), conn = db }) {
  const passThrough = { send: notify, sent: false };
  if (!notify || !seriesMoveId || !markers || markers.notified_at || markers.customer_notified === true || !enabled()
    || !COALESCE_SURFACES.includes(markers.source_surface)) return passThrough;
  const recorded = Date.parse(markers.result?.textHoldStartedAt || '');
  const holdStartedMs = Number.isFinite(recorded) ? recorded : await stampHoldStart({ ownedRow, seriesMoveId, atMs: now });
  const decision = await decideSeriesTextRelease({ seriesMoveId, markers, holdStartedMs, now, conn });
  if (decision.action === 'send') return passThrough;
  if (decision.action === 'drop') {
    logger.info(`[series-text-coalesce] move ${seriesMoveId}: customer text dropped, superseded by newer move ${decision.supersededBy}`);
    await stampMarker('notified_at', {
      customer_notified: false,
      result: db.raw("jsonb_set(COALESCE(result, '{}'::jsonb), '{textSupersededBy}', to_jsonb(?::text))", [decision.supersededBy]),
    });
  }
  return { send: false, sent: null };
}

module.exports = {
  SERIES_TEXT_HOLD_MS,
  SERIES_TEXT_HELD_WINDOW_MS,
  COALESCE_SURFACES,
  enabled,
  findNewerSeriesMove,
  decideSeriesTextRelease,
  resolveSeriesTextRelease,
};
