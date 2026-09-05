/**
 * Read adapter: call_log processing (transcription → extraction → validation
 * → enrichment, lane call_extraction) → canonical runs. The processor's
 * own heartbeat column (processing_heartbeat_at) is the run heartbeat, so
 * health.js reads a stuck call the same way it reads a stuck agent run.
 */

const db = require('../../../models/db');
const { canonicalRun, humanize, modelLabel, isMissingSchema } = require('./shape');

const SOURCE = 'call_log';
const LANE = 'call_extraction';
const COLUMNS = [
  'id', 'direction', 'status', 'duration_seconds', 'processing_status', 'transcription_status', 'v2_extraction_status',
  'enrichment_status', 'classification', 'disposition', 'call_outcome', 'processing_started_at', 'processing_heartbeat_at',
  'extraction_attempts', 'ai_extraction_model', 'ai_extraction_prompt_version', 'created_at', 'updated_at', 'caller_city',
];

const STATUS_MAP = Object.freeze({
  pending: { lifecycle: 'queued' },
  processing: { lifecycle: 'running' },
  processed: { lifecycle: 'terminal', result: 'succeeded', disposition: 'applied' },
  extraction_failed: { lifecycle: 'terminal', result: 'errored', failureClass: 'incomplete' },
  voicemail: { lifecycle: 'terminal', result: 'succeeded', disposition: 'no_action' },
  spam: { lifecycle: 'terminal', result: 'succeeded', disposition: 'no_action' },
  no_transcription: { lifecycle: 'terminal', result: 'succeeded', disposition: 'no_action' },
});

const DONE = new Set(['completed', 'complete']);

function stepStatus(done, running) {
  return done ? 'done' : running ? 'running' : 'skipped';
}

function title(c) {
  const parts = [humanize(c.direction) || 'Call'];
  if (c.caller_city) parts.push(`from ${c.caller_city}`);
  if (c.duration_seconds) parts.push(`· ${Math.round(c.duration_seconds / 60)} min`);
  return parts.join(' ');
}

function fromRow(c) {
  const status = c.processing_status || 'pending';
  const map = STATUS_MAP[status] || { lifecycle: 'terminal', result: 'succeeded' };
  const live = map.lifecycle === 'running';
  const extracted = status === 'processed' || c.v2_extraction_status === 'completed';
  const transcribed = extracted || DONE.has(c.transcription_status);
  const beat = c.processing_heartbeat_at || c.processing_started_at;
  return canonicalRun({
    source: SOURCE,
    id: c.id,
    laneId: LANE,
    title: title(c),
    subtitle: [humanize(c.classification), humanize(c.call_outcome || c.disposition)].filter(Boolean).join(' · ') || humanize(status),
    ...map,
    errorCode: map.result === 'errored' ? status : null,
    createdAt: c.created_at,
    startedAt: c.processing_started_at || c.created_at,
    finishedAt: map.lifecycle === 'terminal' ? c.updated_at : null,
    lastHeartbeatAt: beat,
    lastProgressAt: beat,
    attempts: Math.max(1, Number(c.extraction_attempts || 0)),
    steps: [
      { key: 'transcribe', label: 'Transcribe', status: stepStatus(transcribed, live), detail: null, ms: null, toolName: null },
      { key: 'extract', label: 'Extract', status: map.result === 'errored' ? 'failed' : stepStatus(extracted, live && transcribed), detail: modelLabel(c, 'ai_extraction_model', 'ai_extraction_prompt_version'), ms: null, toolName: null },
      { key: 'enrich', label: 'Enrich', status: stepStatus(DONE.has(c.enrichment_status), live && extracted), detail: null, ms: null, toolName: null },
    ],
    link: `/admin/communications?tab=calls&call=${c.id}`,
    entity: { type: 'call_log', id: c.id },
  });
}

async function list({ from, to, limit = 200 } = {}) {
  try {
    const rows = await db('call_log')
      .select(COLUMNS)
      .whereNotNull('processing_status')
      .where((q) => {
        q.whereIn('processing_status', ['processing']);
        q.orWhere((w) => { w.where('created_at', '>=', from); if (to) w.andWhere('created_at', '<=', to); });
      })
      .orderBy('created_at', 'desc')
      .limit(limit);
    return { runs: rows.map(fromRow), unavailable: false };
  } catch (err) {
    if (isMissingSchema(err)) return { runs: [], unavailable: true };
    throw err;
  }
}

async function get(id) {
  try {
    const row = await db('call_log').select(COLUMNS).where({ id }).first();
    return row ? { run: fromRow(row) } : null;
  } catch (err) {
    if (isMissingSchema(err)) return null;
    throw err;
  }
}

module.exports = { SOURCE, LANE, list, get, fromRow };
