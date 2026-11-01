// Recap render pipeline — enqueue / claim / render+store / approve, on the single
// service_recaps table (status doubles as job + asset, mirroring pdf-queue.js).
// Best-effort + fail-closed: a missing table or render failure never throws into
// the completion path; the queue retries with backoff.
const db = require('../../models/db');
const logger = require('../logger');
const { buildRecapPayload } = require('./recap-payload');
const { renderRecapToFile, cleanupRecapFile } = require('./recap-render');
const { putRecapFromFile } = require('./recap-storage');
const gates = require('../../config/feature-gates');

const CLAIM_LIMIT = 3;
const STALE_CLAIM_MS = 20 * 60 * 1000;
const DEFAULT_MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MINUTES = [5, 30, 240];
const RECAP_DURATION_MS = 28000; // composition is fixed at 840f / 30fps

// recap-delivery's in-flight window: a send_attempt_at newer than this is a send in progress.
const RECAP_SEND_STALE_MS = 5 * 60 * 1000;

const isMissingTable = (err) => err?.code === '42P01' || err?.code === '42703';
const glassesClipsOn = () => typeof gates.recapGlassesClipsLive === 'function' && gates.recapGlassesClipsLive();
const nextAttemptAt = (now, attempts) => new Date(now.getTime() + RETRY_DELAYS_MINUTES[Math.min(Math.max(attempts, 0), RETRY_DELAYS_MINUTES.length - 1)] * 60 * 1000);

async function getRecap(scheduledServiceId, knex = db) {
  try {
    return await knex('service_recaps').where({ scheduled_service_id: scheduledServiceId }).first();
  } catch (err) {
    if (isMissingTable(err)) return null;
    throw err;
  }
}

// Callback recaps are retired under the re-service copy gate (codex P1
// #3631, extending the payload-side block): the public report/video paths
// hide and 404 them, so approving or SENDING one would text the customer a
// link to a player that no longer exists. Enforced at enqueue, approval,
// delivery, and the staff card. A LOOKUP ERROR retires (fail closed): the
// only cost is a blocked, retryable staff action — never a dead-link SMS.
// No completed record = nothing deliverable either way → not retired.
async function callbackRecapRetired(scheduledServiceId, knex = db) {
  const { reserviceReportCopyGateOn } = require('./reservice-report');
  if (!reserviceReportCopyGateOn()) return false;
  try {
    const rec = await knex('service_records')
      .where({ scheduled_service_id: scheduledServiceId })
      .orderBy('created_at', 'desc')
      .first('is_callback');
    if (rec) return rec.is_callback === true;
    // Pre-completion (codex P2 r6): no record row yet, but a scheduled
    // callback must not accept an enqueue/clips only to become permanently
    // unapprovable the moment completion stamps the record — fall back to
    // the scheduled row's flag.
    const sched = await knex('scheduled_services')
      .where({ id: scheduledServiceId })
      .first('is_callback');
    return Boolean(sched && sched.is_callback === true);
  } catch { return true; }
}

// The greeting rule recaps render under (stamped on service_recaps.greeting_version).
// 1 = a customer with no first name is greeted "there", never by the surname.
const RECAP_GREETING_VERSION = 1;

// True when this unsent recap's video was rendered before the current greeting rule. Its
// baked-in intro may greet a customer with no first name by their SURNAME, and the name
// the renderer used is the completion-time identity snapshot (not the live customer row),
// so EVERY such recap is re-rendered once rather than guessing who it affects (codex
// #5674 r1 + pre-push audit). A one-time cost for recaps awaiting approval at deploy.
async function recapNeedsGreetingRerender(recap) {
  return !!recap && !recap.sent_at && Number(recap.greeting_version || 0) < RECAP_GREETING_VERSION;
}

// GATE_RECAP_GLASSES_CLIPS: true when an unsent recap has clip changes since its render (clip_revision,
// reset when a render publishes). Only a change during a send in progress leaves an approved recap
// like that; when that send did not go out, the recap renders again instead of sending the old video.
function recapNeedsClipRerender(recap) {
  return glassesClipsOn() && !!recap && !recap.sent_at && Number(recap.clip_revision || 0) > 0;
}

// Queue (or re-queue) a recap render. force=true regenerates a ready/failed one.
async function enqueueRecap(scheduledServiceId, { force = false, knex = db } = {}) {
  if (!scheduledServiceId) throw new Error('scheduledServiceId is required');
  if (await callbackRecapRetired(scheduledServiceId, knex)) {
    return { ok: false, retired: true };
  }
  const now = new Date();
  try {
    const existing = await knex('service_recaps').where({ scheduled_service_id: scheduledServiceId }).first();
    if (existing) {
      if (['pending', 'rendering'].includes(existing.status)) return { ok: true, queued: false, recap: existing };
      // Never regenerate a recap already SENT to the customer — keep the approved
      // asset + link live. force only re-renders ready/failed/approved-but-unsent.
      if (!force || existing.sent_at) return { ok: true, queued: false, recap: existing };
      // Never pull a recap out from under a send in progress (send_attempt_at inside the
      // sender's window): the customer's link would point at a video no longer approved.
      const sendStaleBefore = new Date(now.getTime() - RECAP_SEND_STALE_MS);
      const [updated] = await knex('service_recaps').where({ id: existing.id })
        .whereNull('sent_at')
        .andWhere((b) => b.whereNull('send_attempt_at').orWhere('send_attempt_at', '<', sendStaleBefore))
        .update({
          status: 'pending', attempts: 0, next_attempt_at: now, locked_at: null, last_error: null,
          approved_at: null, approved_by: null, updated_at: now,
        }).returning('*');
      if (!updated) return { ok: true, queued: false, recap: existing };
      return { ok: true, queued: true, recap: updated };
    }
    const [inserted] = await knex('service_recaps').insert({
      scheduled_service_id: scheduledServiceId, status: 'pending', attempts: 0,
      max_attempts: DEFAULT_MAX_ATTEMPTS, next_attempt_at: now, created_at: now, updated_at: now,
    }).returning('*');
    return { ok: true, queued: true, recap: inserted };
  } catch (err) {
    if (err?.code === '23505') return { ok: true, queued: false }; // race: another insert won
    if (isMissingTable(err)) {
      logger.warn(`[recap-pipeline] service_recaps table unavailable; recap not queued for ${scheduledServiceId}`);
      return { ok: false, skipped: true };
    }
    throw err;
  }
}

// GATE_RECAP_GLASSES_CLIPS: a clip confirmed, or removed, before the recap was sent must be in (or out
// of) the video the customer gets. One UPDATE on the recap row, so it orders against a render's finish,
// an approval and a send claim: clip_revision counts the changes since the last published render (the
// finish resets it to 0), and a built recap (not pending or rendering)
// with no send in progress goes back to pending, approval cleared; a pending one renders the new clip set
// anyway, and a rendering one renders again at its finish (processRecap compares clip_revision). A sent
// recap keeps its video; one being sent keeps its approval, and if that send fails, sendRecap sees the
// count and renders again instead of sending the old video. Only a clip the renderer uses (`ready`) counts; a
// `processing` clip counts when it is cut. Never throws: the confirm or removal has already happened.
async function markRecapClipsChanged(scheduledServiceId, media, { knex = db, now = new Date() } = {}) {
  if (!glassesClipsOn()) return { marked: false };
  if (media?.status !== 'ready') return { marked: false };
  try {
    if (await callbackRecapRetired(scheduledServiceId, knex)) return { marked: false };
    const requeue = "(status NOT IN ('pending', 'rendering') AND (send_attempt_at IS NULL OR send_attempt_at < :sendStaleBefore))";
    const result = await knex.raw(`
      UPDATE service_recaps SET
        clip_revision = clip_revision + 1,
        status = CASE WHEN ${requeue} THEN 'pending' ELSE status END,
        attempts = CASE WHEN ${requeue} THEN 0 ELSE attempts END,
        next_attempt_at = CASE WHEN ${requeue} THEN :now ELSE next_attempt_at END,
        locked_at = CASE WHEN ${requeue} THEN NULL ELSE locked_at END,
        last_error = CASE WHEN ${requeue} THEN NULL ELSE last_error END,
        approved_at = CASE WHEN ${requeue} THEN NULL ELSE approved_at END,
        approved_by = CASE WHEN ${requeue} THEN NULL ELSE approved_by END,
        updated_at = :now
      WHERE scheduled_service_id = :id AND sent_at IS NULL
      RETURNING status
    `, { id: scheduledServiceId, now, sendStaleBefore: new Date(now.getTime() - RECAP_SEND_STALE_MS) });
    const row = (result.rows || [])[0];
    return { marked: Boolean(row), status: row ? row.status : null };
  } catch (err) {
    logger.warn(`[recap-pipeline] late-clip rebuild failed for ${scheduledServiceId}: ${err.message}`);
    return { marked: false };
  }
}

async function approveRecap(scheduledServiceId, { approvedBy = null, knex = db } = {}) {
  if (await callbackRecapRetired(scheduledServiceId, knex)) {
    return { ok: false, error: 'callback_recap_retired' };
  }
  const recap = await getRecap(scheduledServiceId, knex);
  if (!recap) return { ok: false, error: 'not_found' };
  // A video rendered before the greeting rule would greet a no-first-name customer by
  // their surname: re-render it; staff approve the fresh one when it is ready.
  if (['ready', 'approved'].includes(recap.status) && !recap.sent_at
    && await recapNeedsGreetingRerender(recap, knex)) {
    await enqueueRecap(scheduledServiceId, { force: true, knex });
    return { ok: false, error: 'rerendering_greeting' };
  }
  // Already approved but the SMS never went out → idempotent OK so the caller can
  // retry sendRecap (which re-claims sent_at).
  if (recap.status === 'approved' && !recap.sent_at) return { ok: true, recap };
  if (recap.status !== 'ready') return { ok: false, error: `not_ready (${recap.status})` };
  // Approve only the render read above: a late clip or Regenerate that re-queued it since
  // (or a newer render that replaced it) must not be approved and sent unseen.
  const [updated] = await knex('service_recaps')
    .where({ id: recap.id, status: 'ready', rendered_at: recap.rendered_at })
    .update({ status: 'approved', approved_at: new Date(), approved_by: approvedBy, updated_at: new Date() })
    .returning('*');
  if (!updated) return { ok: false, error: 'not_ready (re-rendering)' };
  return { ok: true, recap: updated };
}

async function recoverStaleRecaps(now = new Date(), knex = db) {
  try {
    await knex.raw(`
      UPDATE service_recaps
      SET status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'pending' END,
          locked_at = NULL,
          last_error = COALESCE(last_error, 'Recovered stale recap render claim'),
          updated_at = ?
      WHERE status = 'rendering' AND locked_at <= ?
    `, [now, new Date(now.getTime() - STALE_CLAIM_MS)]);
  } catch (err) {
    if (!isMissingTable(err)) throw err;
  }
}

async function claimDueRecaps(now = new Date(), limit = CLAIM_LIMIT, knex = db) {
  try {
    const result = await knex.raw(`
      WITH due AS (
        SELECT id FROM service_recaps
        WHERE status = 'pending' AND next_attempt_at <= ?
        ORDER BY next_attempt_at ASC, created_at ASC
        FOR UPDATE SKIP LOCKED LIMIT ?
      )
      UPDATE service_recaps AS r
      SET status = 'rendering', attempts = attempts + 1, locked_at = ?, updated_at = ?
      FROM due WHERE r.id = due.id
      RETURNING r.*
    `, [now, limit, now, now]);
    return result.rows || [];
  } catch (err) {
    if (isMissingTable(err)) return [];
    throw err;
  }
}

async function processRecap(recap, knex = db) {
  let outFile = null;
  try {
    const payload = await buildRecapPayload(recap.scheduled_service_id, { knex });
    if (!payload) {
      // not eligible (e.g., not pest / no intelligence) — mark failed terminally, no retry
      await knex('service_recaps').where({ id: recap.id }).update({
        status: 'failed', locked_at: null, last_error: 'not eligible for recap', attempts: recap.max_attempts, updated_at: new Date(),
      });
      return { status: 'skipped' };
    }
    outFile = await renderRecapToFile(payload);
    const key = await putRecapFromFile(recap.scheduled_service_id, outFile);
    const finish = {
      // Persist only non-secret media metadata — payload.media carries 2h presigned
      // S3 URLs (src) that must not be retained in the DB.
      status: 'ready', s3_key: key, duration_ms: RECAP_DURATION_MS,
      media: JSON.stringify((payload.media || []).map((m) => ({ role: m.role, caption: m.caption, type: m.type }))),
      rendered_at: new Date(), locked_at: null, last_error: null, updated_at: new Date(),
      greeting_version: RECAP_GREETING_VERSION,
    };
    if (glassesClipsOn() && recap.clip_revision != null) {
      // GATE_RECAP_GLASSES_CLIPS: a clip counted after this claim may be missing from the video, so
      // render again instead of publishing. Decided in the UPDATE that publishes, on the recap row:
      // no clip, approval or send claim can fall between the check and the publish. A publish resets
      // the count: it counts changes since the published video.
      const late = Number(recap.clip_revision);
      finish.status = knex.raw("CASE WHEN clip_revision <> ? THEN 'pending' ELSE 'ready' END", [late]);
      finish.clip_revision = knex.raw('CASE WHEN clip_revision <> ? THEN clip_revision ELSE 0 END', [late]);
      finish.attempts = knex.raw('CASE WHEN clip_revision <> ? THEN 0 ELSE attempts END', [late]);
      finish.next_attempt_at = knex.raw('CASE WHEN clip_revision <> ? THEN ? ELSE next_attempt_at END', [late, new Date()]);
    }
    const [done] = await knex('service_recaps').where({ id: recap.id }).update(finish).returning('status');
    return { status: done?.status || 'ready', key };
  } catch (err) {
    const now = new Date();
    const attempts = Number(recap.attempts || 0);
    const exhausted = attempts >= Number(recap.max_attempts || DEFAULT_MAX_ATTEMPTS);
    await knex('service_recaps').where({ id: recap.id }).update({
      status: exhausted ? 'failed' : 'pending',
      next_attempt_at: exhausted ? recap.next_attempt_at : nextAttemptAt(now, attempts - 1),
      locked_at: null, last_error: String(err.message || err).slice(0, 500), updated_at: now,
    });
    if (exhausted) logger.error(`[recap-pipeline] recap render failed permanently for service ${recap.scheduled_service_id}: ${err.message}`);
    return { status: exhausted ? 'failed' : 'pending', error: err.message };
  } finally {
    if (outFile) cleanupRecapFile(outFile);
  }
}

async function processDueRecaps({ now = new Date(), limit = CLAIM_LIMIT } = {}, knex = db) {
  const summary = { claimed: 0, ready: 0, failed: 0, requeued: 0, skipped: 0 };
  await recoverStaleRecaps(now, knex);
  const jobs = await claimDueRecaps(now, limit, knex);
  summary.claimed = jobs.length;
  for (const job of jobs) {
    const r = await processRecap(job, knex);
    if (r.status === 'ready') summary.ready += 1;
    else if (r.status === 'failed') summary.failed += 1;
    else if (r.status === 'pending') summary.requeued += 1;
    else if (r.status === 'skipped') summary.skipped += 1;
  }
  return summary;
}

module.exports = {
  CLAIM_LIMIT, DEFAULT_MAX_ATTEMPTS, RETRY_DELAYS_MINUTES, RECAP_GREETING_VERSION, RECAP_SEND_STALE_MS,
  getRecap, enqueueRecap, markRecapClipsChanged, approveRecap, callbackRecapRetired, recapNeedsGreetingRerender, recapNeedsClipRerender,
  claimDueRecaps, recoverStaleRecaps, processRecap, processDueRecaps,
};
