/**
 * Read adapter: call_log processing (transcription → extraction → validation
 * → enrichment, lane call_extraction) → canonical runs. The processor's
 * own heartbeat column (processing_heartbeat_at) is the run heartbeat, so
 * health.js reads a stuck call the same way it reads a stuck agent run.
 */

const db = require('../../../models/db');
const { pagedAtColumn, canonicalRun, humanize, modelLabel, keyset, notMirrored, isMissingSchema } = require('./shape');
const { whereNotSandboxCall } = require('../../voice-agent/relay-protocol');
// the processor's retry limits (one config): an extraction_failed call still
// inside them is queued work its sweep will claim again, not a failure (Codex r9)
const { CALL_EXTRACTION_MAX_ATTEMPTS, EXTRACTION_RETRY_WINDOW_DAYS } = require('../../../config/call-extraction-retry');

const SOURCE = 'call_log';
const LANE = 'call_extraction';
// Sort / page key = the run's startedAt in fromRow, at ms precision.
const START = () => db.raw("date_trunc('milliseconds', COALESCE(processing_started_at, created_at))");
// the page key: the call's raw creation, immutable (processing_started_at
// moves on every retry; Codex r14) — call_log_created_at_index serves the
// scan; the stamp beside it (pagedAtColumn) is what the cursor carries
const PAGED = 'created_at';
const ID = 'id';
const PAN_DETECTED = "(transcription_metadata::jsonb ->> 'pan_detected') = 'true'";
const COLUMNS = () => [
  pagedAtColumn(db, 'created_at'), // the page stamp (see PAGED)
  'id', 'direction', 'status', 'duration_seconds', 'processing_status', 'transcription_status', 'v2_extraction_status',
  'classification', 'disposition', 'call_outcome', 'processing_started_at', 'processing_heartbeat_at',
  db.raw('(ai_extraction_enriched IS NOT NULL) AS enriched'),
  'extraction_attempts', 'ai_extraction_model', 'ai_extraction_prompt_version', 'created_at', 'updated_at', 'caller_city', 'recording_url',
  // the sweep's media gates (claimable / retryEligible)
  'recording_duration_seconds',
  db.raw(`(${PAN_DETECTED}) AS pan_detected`),
  db.raw('(transcription IS NOT NULL) AS has_transcript'),
];

const STATUS_MAP = Object.freeze({
  pending: { lifecycle: 'queued' },
  processing: { lifecycle: 'running' },
  processed: { lifecycle: 'terminal', result: 'succeeded', disposition: 'applied' },
  // the class comes from the v2 extraction status when one was recorded
  // (extractFailureClass); a bare extraction_failed is any exception the
  // extractor threw — key, network, provider — so infrastructure, not a
  // model-quality failure (Codex r7)
  extraction_failed: { lifecycle: 'terminal', result: 'errored', failureClass: 'infrastructure' },
  voicemail: { lifecycle: 'terminal', result: 'succeeded', disposition: 'no_action' },
  spam: { lifecycle: 'terminal', result: 'succeeded', disposition: 'no_action' },
  // transcription never landed: the processor's sweep reclaims this state on
  // EVERY tick with no age gate or cap (processAllPending), so it is queued
  // work — never a finished no-op (Codex r2), never terminal either (r10) —
  // WHILE the row carries media the sweep will claim (retryEligible, r11);
  // without a claimable recording nothing will ever retry it: an errored
  // transcription. The last failure stays as the run's code (fromRow).
  no_transcription: { lifecycle: 'terminal', result: 'errored', failureClass: 'infrastructure' },
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
// a failure the sweep will retry: queued, its last failure kept as the code
const QUEUED_RETRY = Object.freeze({ lifecycle: 'queued' });
const RETRY_WINDOW_MS = Number(EXTRACTION_RETRY_WINDOW_DAYS) * 864e5;

// processAllPending's media gates, as the sweep applies them (Codex r11):
// a row is claimable only with a non-empty recording — or, for every state
// but no_transcription, a PAN-quarantined MASKED transcript (its transcript-
// only branch) — AND real content: over 10 s, or PAN-quarantined (a card
// readback was heard). A retry state without them is never reclaimed.
function claimable(c, status) {
  const recording = !!(c.recording_url && c.recording_url !== '');
  const pan = c.pan_detected === true;
  const media = recording || (status !== TRANSCRIBE_FAILED && pan && !!c.has_transcript);
  return media && (Number(c.recording_duration_seconds ?? c.duration_seconds ?? 0) > 10 || pan);
}

// What the sweep will claim again: no_transcription unconditionally (no
// cap, no age gate); extraction_failed inside the processor's retry limits.
function retryEligible(c, status, now = Date.now()) {
  if (status === TRANSCRIBE_FAILED) return claimable(c, status);
  return status === 'extraction_failed'
    && Number(c.extraction_attempts || 0) < Number(CALL_EXTRACTION_MAX_ATTEMPTS)
    && new Date(c.created_at).getTime() > now - RETRY_WINDOW_MS
    && claimable(c, status);
}

// The processor's own stage vocabularies (call-recording-processor.js,
// drift-tested): transcription_status 'completed' | 'summary_only' carry a
// usable transcript; v2_extraction_status 'valid' is the ONE extraction
// success (parse_failed / schema_failed / normalization_failed /
// api_unavailable are its failures); enrichment has no status column of
// its own — ai_extraction_enriched is the enriched payload.
const TRANSCRIBED = new Set(['completed', 'summary_only']);
const V2_VALID = 'valid';
const TRANSCRIBE_FAILED = 'no_transcription';
const EXTRACT_FAILED = /_failed$|^api_unavailable$/;
// extraction landed; the customer / lead write after it did not (its own step)
const LINK_FAILED = new Set(['customer_creation_failed', 'lead_creation_failed']);
// v2 extraction failure status → failure class: the model's output was the
// problem (incomplete) vs the provider was (provider)
const EXTRACT_FAILURE_CLASS = Object.freeze({ parse_failed: 'incomplete', schema_failed: 'incomplete', normalization_failed: 'incomplete', api_unavailable: 'provider' });

function failureClassFor(c, status, map) {
  if (status !== 'extraction_failed') return map.failureClass;
  return EXTRACT_FAILURE_CLASS[c.v2_extraction_status] || map.failureClass;
}

// extraction_attempts counts FAILED extractions (the processor increments it
// on failure only): the attempts that ran = failures + the current pass
// unless the current pass is itself the recorded failure (Codex r7). A
// transcription retry (no_transcription) is a different policy — reclaimed
// without a cap and never counted — so its attempts and limit are unknown,
// not the extraction limit (r11).
function attemptsFor(c, status) {
  if (status === TRANSCRIBE_FAILED) return null;
  return Math.max(1, Number(c.extraction_attempts || 0) + (status === 'extraction_failed' ? 0 : 1));
}
function maxAttemptsFor(status) {
  return status === TRANSCRIBE_FAILED ? null : Number(CALL_EXTRACTION_MAX_ATTEMPTS);
}
// The sweep's media gates in SQL (claimable() above, one to one). A never-
// claimed row (processing_status NULL / pending) is queued work only when
// the restart-safe sweep would claim it: a non-empty recording, or a PAN-
// quarantined row whose recording_url is cleared by design but whose MASKED
// transcript still needs processing (its transcript-only branch), with real
// content — over 10 s, or PAN-quarantined. Anything else with those
// statuses is a recording the sweep never picks up — not a run (Codex r6);
// the same gates decide whether a retry state is queued (r11).
const HAS_RECORDING = "(recording_url IS NOT NULL AND recording_url <> '')";
const HAS_CONTENT = `(COALESCE(recording_duration_seconds, duration_seconds, 0) > 10 OR ${PAN_DETECTED})`;
const SWEEP_CLAIMABLE = `((${HAS_RECORDING} OR (${PAN_DETECTED} AND transcription IS NOT NULL)) AND ${HAS_CONTENT})`;
const TRANSCRIBE_RETRY_CLAIMABLE = `(${HAS_RECORDING} AND ${HAS_CONTENT})`;

function stepStatus(done, running) {
  return done ? 'done' : running ? 'running' : 'skipped';
}

function title(c) {
  const parts = [humanize(c.direction) || 'Call'];
  if (c.caller_city) parts.push(`from ${c.caller_city}`);
  if (c.duration_seconds) parts.push(`· ${Math.round(c.duration_seconds / 60)} min`);
  return parts.join(' ');
}

// The stages as steps: transcribe → extract → enrich → link (the customer /
// lead write). Each failure fails ITS step only — a failed transcription
// attempts nothing after it; an extraction failure is the extractor's
// (`extraction_failed` or a v2 failure status), never a later write's
// (Codex r5); a linkage failure fails the link step with extraction done.
function stepsFor(c, status, map) {
  const live = map.lifecycle === 'running';
  const extracted = status === 'processed' || c.v2_extraction_status === V2_VALID;
  const transcribeFailed = status === TRANSCRIBE_FAILED;
  const extractFailed = status === 'extraction_failed' || EXTRACT_FAILED.test(c.v2_extraction_status || '');
  const transcribed = extracted || TRANSCRIBED.has(c.transcription_status);
  return [
    { key: 'transcribe', label: 'Transcribe', status: transcribeFailed ? 'failed' : stepStatus(transcribed, live), detail: null, ms: null, toolName: null },
    { key: 'extract', label: 'Extract', status: extractFailed ? 'failed' : stepStatus(extracted, live && transcribed), detail: extractFailed && c.v2_extraction_status ? c.v2_extraction_status : modelLabel(c, 'ai_extraction_model', 'ai_extraction_prompt_version'), ms: null, toolName: null },
    { key: 'enrich', label: 'Enrich', status: stepStatus(!!c.enriched, live && extracted), detail: null, ms: null, toolName: null },
    { key: 'link', label: 'Link customer / lead', status: LINK_FAILED.has(status) ? 'failed' : stepStatus(status === 'processed', live && extracted), detail: LINK_FAILED.has(status) ? humanize(status) : null, ms: null, toolName: null },
  ];
}

function fromRow(c) {
  const status = c.processing_status || 'pending';
  const retry = retryEligible(c, status);
  const map = retry ? QUEUED_RETRY : STATUS_MAP[status] || UNKNOWN_STATUS;
  const beat = c.processing_heartbeat_at || c.processing_started_at;
  return canonicalRun({
    source: SOURCE,
    id: c.id,
    laneId: LANE,
    title: title(c),
    subtitle: [humanize(c.classification), humanize(c.call_outcome || c.disposition)].filter(Boolean).join(' · ') || humanize(status),
    ...map,
    failureClass: failureClassFor(c, status, map),
    errorCode: map.result === 'errored' || retry ? status : null,
    createdAt: c.created_at,
    pagedAt: c.paged_at,
    startedAt: c.processing_started_at || c.created_at,
    finishedAt: map.lifecycle === 'terminal' ? c.updated_at : null,
    lastHeartbeatAt: beat,
    lastProgressAt: beat,
    attempts: attemptsFor(c, status),
    maxAttempts: maxAttemptsFor(status),
    steps: stepsFor(c, status, map),
    // CommunicationsPageV2 selects the tab and CallLogTabV2 the focused call from the HASH (Codex r14)
    link: `/admin/communications#tab=calls&call=${c.id}`,
    entity: { type: 'call_log', id: c.id },
  });
}

async function list({ from, cursor = null, limit = 200 } = {}) {
  try {
    const rows = await keyset(notMirrored(db('call_log')
      .select(COLUMNS())
      // a fresh, never-claimed row is processing_status NULL (the processor
      // treats NULL as queued): listed only when the sweep would claim it
      .where((q) => {
        q.whereNotNull('processing_status').whereNot('processing_status', 'pending');
        q.orWhereRaw(SWEEP_CLAIMABLE);
      })
      // a voice-agent sandbox call is not a run anyone supervises
      .modify((qb) => whereNotSandboxCall(qb))
      .where((q) => {
        // queued (NULL / pending) and in-flight calls stay listed however old (a stuck queue is the point)
        q.whereNull('processing_status').orWhereIn('processing_status', ['pending', 'processing']);
        // … and so does a failure the sweep will retry (retryEligible): a
        // transcription failure with claimable media, an extraction failure
        // inside the processor's limits with claimable media
        q.orWhere((r) => r.where('processing_status', TRANSCRIBE_FAILED).whereRaw(TRANSCRIBE_RETRY_CLAIMABLE));
        q.orWhere((r) => r.where('processing_status', 'extraction_failed')
          .whereRaw('COALESCE(extraction_attempts, 0) < ?', [Number(CALL_EXTRACTION_MAX_ATTEMPTS)])
          .where('created_at', '>', db.raw(`NOW() - INTERVAL '${Number(EXTRACTION_RETRY_WINDOW_DAYS)} days'`))
          .whereRaw(SWEEP_CLAIMABLE));
        q.orWhere(START(), '>=', from);
      }), { source: SOURCE, idColumn: 'call_log.id' }), { start: PAGED, id: ID, cursor, limit });
    return { runs: rows.map(fromRow), unavailable: false };
  } catch (err) {
    if (isMissingSchema(err)) return { runs: [], unavailable: true };
    throw err;
  }
}

async function get(id) {
  try {
    const row = await db('call_log').select(COLUMNS()).where({ id }).modify((qb) => whereNotSandboxCall(qb)).first();
    return row ? { run: fromRow(row) } : null;
  } catch (err) {
    if (isMissingSchema(err)) return null;
    throw err;
  }
}

module.exports = { SOURCE, LANE, STATUS_MAP, TRANSCRIBED, V2_VALID, retryEligible, list, get, fromRow };
