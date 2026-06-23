// Recap render pipeline — enqueue / claim / render+store / approve, on the single
// service_recaps table (status doubles as job + asset, mirroring pdf-queue.js).
// Best-effort + fail-closed: a missing table or render failure never throws into
// the completion path; the queue retries with backoff.
const db = require('../../models/db');
const logger = require('../logger');
const { buildRecapPayload } = require('./recap-payload');
const { renderRecapToFile, cleanupRecapFile } = require('./recap-render');
const { putRecapFromFile } = require('./recap-storage');

const CLAIM_LIMIT = 3;
const STALE_CLAIM_MS = 20 * 60 * 1000;
const DEFAULT_MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MINUTES = [5, 30, 240];
const RECAP_DURATION_MS = 28000; // composition is fixed at 840f / 30fps

const isMissingTable = (err) => err?.code === '42P01' || err?.code === '42703';
const nextAttemptAt = (now, attempts) => new Date(now.getTime() + RETRY_DELAYS_MINUTES[Math.min(Math.max(attempts, 0), RETRY_DELAYS_MINUTES.length - 1)] * 60 * 1000);

async function getRecap(serviceRecordId, knex = db) {
  try {
    return await knex('service_recaps').where({ service_record_id: serviceRecordId }).first();
  } catch (err) {
    if (isMissingTable(err)) return null;
    throw err;
  }
}

// Queue (or re-queue) a recap render. force=true regenerates a ready/failed one.
async function enqueueRecap(serviceRecordId, { force = false, knex = db } = {}) {
  if (!serviceRecordId) throw new Error('serviceRecordId is required');
  const now = new Date();
  try {
    const existing = await knex('service_recaps').where({ service_record_id: serviceRecordId }).first();
    if (existing) {
      if (['pending', 'rendering'].includes(existing.status)) return { ok: true, queued: false, recap: existing };
      if (!force) return { ok: true, queued: false, recap: existing };
      const [updated] = await knex('service_recaps').where({ id: existing.id }).update({
        status: 'pending', attempts: 0, next_attempt_at: now, locked_at: null, last_error: null,
        approved_at: null, approved_by: null, updated_at: now,
      }).returning('*');
      return { ok: true, queued: true, recap: updated };
    }
    const [inserted] = await knex('service_recaps').insert({
      service_record_id: serviceRecordId, status: 'pending', attempts: 0,
      max_attempts: DEFAULT_MAX_ATTEMPTS, next_attempt_at: now, created_at: now, updated_at: now,
    }).returning('*');
    return { ok: true, queued: true, recap: inserted };
  } catch (err) {
    if (err?.code === '23505') return { ok: true, queued: false }; // race: another insert won
    if (isMissingTable(err)) {
      logger.warn(`[recap-pipeline] service_recaps table unavailable; recap not queued for ${serviceRecordId}`);
      return { ok: false, skipped: true };
    }
    throw err;
  }
}

async function approveRecap(serviceRecordId, { approvedBy = null, knex = db } = {}) {
  const recap = await getRecap(serviceRecordId, knex);
  if (!recap) return { ok: false, error: 'not_found' };
  if (recap.status !== 'ready') return { ok: false, error: `not_ready (${recap.status})` };
  const [updated] = await knex('service_recaps').where({ id: recap.id }).update({
    status: 'approved', approved_at: new Date(), approved_by: approvedBy, updated_at: new Date(),
  }).returning('*');
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
    const payload = await buildRecapPayload(recap.service_record_id, { knex });
    if (!payload) {
      // not eligible (e.g., not pest / no intelligence) — mark failed terminally, no retry
      await knex('service_recaps').where({ id: recap.id }).update({
        status: 'failed', locked_at: null, last_error: 'not eligible for recap', attempts: recap.max_attempts, updated_at: new Date(),
      });
      return { status: 'skipped' };
    }
    outFile = await renderRecapToFile(payload);
    const key = await putRecapFromFile(recap.service_record_id, outFile);
    await knex('service_recaps').where({ id: recap.id }).update({
      status: 'ready', s3_key: key, duration_ms: RECAP_DURATION_MS, media: JSON.stringify(payload.media || []),
      rendered_at: new Date(), locked_at: null, last_error: null, updated_at: new Date(),
    });
    return { status: 'ready', key };
  } catch (err) {
    const now = new Date();
    const attempts = Number(recap.attempts || 0);
    const exhausted = attempts >= Number(recap.max_attempts || DEFAULT_MAX_ATTEMPTS);
    await knex('service_recaps').where({ id: recap.id }).update({
      status: exhausted ? 'failed' : 'pending',
      next_attempt_at: exhausted ? recap.next_attempt_at : nextAttemptAt(now, attempts - 1),
      locked_at: null, last_error: String(err.message || err).slice(0, 500), updated_at: now,
    });
    if (exhausted) logger.error(`[recap-pipeline] recap render failed permanently for service ${recap.service_record_id}: ${err.message}`);
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
  CLAIM_LIMIT, DEFAULT_MAX_ATTEMPTS, RETRY_DELAYS_MINUTES,
  getRecap, enqueueRecap, approveRecap,
  claimDueRecaps, recoverStaleRecaps, processRecap, processDueRecaps,
};
