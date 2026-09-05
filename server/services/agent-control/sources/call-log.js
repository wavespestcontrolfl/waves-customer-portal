/**
 * Read adapter: call_log processing (transcription → extraction → validation
 * → enrichment, lane call_extraction) → canonical runs. The processor's
 * own heartbeat column (processing_heartbeat_at) is the run heartbeat, so
 * health.js reads a stuck call the same way it reads a stuck agent run.
 */

const db = require('../../../models/db');
const { canonicalRun, humanize, modelLabel, keyset, notMirrored, isMissingSchema } = require('./shape');

const SOURCE = 'call_log';
const LANE = 'call_extraction';
// Sort / page key = the run's startedAt in fromRow, at ms precision.
const START = db.raw("date_trunc('milliseconds', COALESCE(processing_started_at, created_at))");
const ID = 'id';
const COLUMNS = [
  'id', 'direction', 'status', 'duration_seconds', 'processing_status', 'transcription_status', 'v2_extraction_status',
  'classification', 'disposition', 'call_outcome', 'processing_started_at', 'processing_heartbeat_at',
  db.raw('(ai_extraction_enriched IS NOT NULL) AS enriched'),
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
  // extraction landed but the customer / lead write did not (the processor
  // stamps these instead of processed; the sweep retries them)
  customer_creation_failed: { lifecycle: 'terminal', result: 'errored', failureClass: 'tool' },
  lead_creation_failed: { lifecycle: 'terminal', result: 'errored', failureClass: 'tool' },
});
// A status this map does not know is NOT a success: terminal with no
// result, which the index buckets as failed / attention so it surfaces
// (tests/agent-control-run-index drift-checks the map against the
// processor's vocabulary).
const UNKNOWN_STATUS = Object.freeze({ lifecycle: 'terminal', result: null });

// The processor's own stage vocabularies (call-recording-processor.js,
// drift-tested): transcription_status 'completed' | 'summary_only' carry a
// usable transcript; v2_extraction_status 'valid' is the ONE extraction
// success (parse_failed / schema_failed / normalization_failed /
// api_unavailable are its failures); enrichment has no status column of
// its own — ai_extraction_enriched is the enriched payload.
const TRANSCRIBED = new Set(['completed', 'summary_only']);
const V2_VALID = 'valid';

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
  const map = STATUS_MAP[status] || UNKNOWN_STATUS;
  const live = map.lifecycle === 'running';
  const extracted = status === 'processed' || c.v2_extraction_status === V2_VALID;
  const extractFailed = map.result === 'errored' || /_failed$|^api_unavailable$/.test(c.v2_extraction_status || '');
  const transcribed = extracted || TRANSCRIBED.has(c.transcription_status);
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
      { key: 'extract', label: 'Extract', status: extractFailed ? 'failed' : stepStatus(extracted, live && transcribed), detail: extractFailed && c.v2_extraction_status ? c.v2_extraction_status : modelLabel(c, 'ai_extraction_model', 'ai_extraction_prompt_version'), ms: null, toolName: null },
      { key: 'enrich', label: 'Enrich', status: stepStatus(!!c.enriched, live && extracted), detail: null, ms: null, toolName: null },
    ],
    link: `/admin/communications?tab=calls&call=${c.id}`,
    entity: { type: 'call_log', id: c.id },
  });
}

async function list({ from, cursor = null, limit = 200 } = {}) {
  try {
    const rows = await keyset(notMirrored(db('call_log')
      .select(COLUMNS)
      .whereNotNull('processing_status')
      .where((q) => {
        // queued and in-flight calls stay listed however old (a stuck queue is the point)
        q.whereIn('processing_status', ['pending', 'processing']);
        q.orWhere(START, '>=', from);
      }), { source: SOURCE, idColumn: 'call_log.id' }), { start: START, id: ID, cursor, limit });
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

module.exports = { SOURCE, LANE, STATUS_MAP, TRANSCRIBED, V2_VALID, list, get, fromRow };
