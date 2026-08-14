/**
 * Retention for collections call artifacts (PR B) — its OWN policy module,
 * deliberately NOT inherited from the inbound relay/call pipeline (ruled):
 * collections calls discuss a customer's balance, so their transcripts and
 * any recordings get a SHORTER horizon than ordinary call history.
 *
 * Horizon: COLLECTIONS_RETENTION_DAYS (env), default 90 — a conservative
 * default documented for Adam to set (shorter is stricter; the sweep never
 * touches anything younger). Only rows this lane created are ever touched
 * (call_log.source = 'collections_voice'); the inbound pipeline's rows are
 * structurally out of reach.
 *
 * What expiry does, per aged row:
 *   - Twilio recording deleted via the API when a recording_sid exists
 *     (best-effort; a failed delete leaves the row un-purged so the next
 *     sweep retries — fail toward retrying the purge, never toward
 *     forgetting it);
 *   - transcription / transcription_metadata / call_summary / recording
 *     columns cleared, transcription_status stamped 'purged';
 *   - the call_log row itself, the collections ledger row, and the case
 *     history REMAIN (who was contacted when is compliance data — only the
 *     conversational CONTENT expires).
 *
 * The sweep runs UNGATED by design: deletion is the conservative direction,
 * and while the lane is dark there are zero collections_voice rows, so the
 * sweep is a provable no-op (pinned) — gate-off behavior is byte-identical.
 */

const db = require('../../../models/db');
const logger = require('../../logger');

const DEFAULT_RETENTION_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

function retentionDays() {
  const raw = Number(process.env.COLLECTIONS_RETENTION_DAYS);
  // Guard rails: a bad env value falls to the default; a sub-1-day value
  // would purge live calls mid-review, so 1 day is the floor.
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_RETENTION_DAYS;
  return Math.floor(raw);
}

async function deleteTwilioRecording(recordingSid) {
  const config = require('../../../config');
  if (!config.twilio.accountSid || !config.twilio.authToken) {
    throw new Error('Twilio not configured');
  }
  const twilio = require('twilio');
  const client = twilio(config.twilio.accountSid, config.twilio.authToken);
  await client.recordings(recordingSid).remove();
}

async function runCollectionsRetentionSweep({ now = new Date() } = {}) {
  const horizon = new Date(now.getTime() - retentionDays() * DAY_MS);
  const rows = await db('call_log')
    .where({ source: 'collections_voice' })
    .where('created_at', '<', horizon)
    .whereNot('transcription_status', 'purged')
    .select('id', 'recording_sid')
    .limit(200);

  let purged = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      if (row.recording_sid) {
        try {
          await deleteTwilioRecording(row.recording_sid);
        } catch (err) {
          // 404 = already gone (fine); anything else leaves the row for the
          // next sweep so a transient API failure never strands a recording.
          const gone = err && (err.status === 404 || err.code === 20404);
          if (!gone) throw err;
        }
      }
      await db('call_log').where({ id: row.id }).update({
        transcription: null,
        transcription_metadata: null,
        call_summary: null,
        recording_url: null,
        recording_sid: null,
        transcription_status: 'purged',
        updated_at: new Date(),
      });
      purged++;
    } catch (err) {
      failed++;
      logger.warn(`[collections-retention] purge failed for call_log ${row.id}: ${err.message} — will retry next sweep`);
    }
  }
  if (rows.length) {
    logger.info(`[collections-retention] sweep: ${purged} purged, ${failed} deferred (horizon ${retentionDays()}d)`);
  }
  return { considered: rows.length, purged, failed, retentionDays: retentionDays() };
}

module.exports = { runCollectionsRetentionSweep, retentionDays, DEFAULT_RETENTION_DAYS };
