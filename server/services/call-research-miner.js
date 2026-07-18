/**
 * Call-research miner — the voice-of-customer corpus (nightly sweep).
 *
 * Mines verbatim quote chunks out of call transcripts into
 * call_research_chunks, tagged with the fixed research taxonomy. Runs as a
 * nightly sweep (NOT a hook in the call pipeline) so the LLM call and
 * insert fan-out stay off the operational hot path — overnight freshness
 * is ample for research.
 *
 * Extraction routes cross-provider through llm/call.js dispatchWithFallback
 * (bake-off-locked primary + automatic Claude fallback; env-overridable per
 * the extraction-exception pattern). Output is ajv-validated, every quote
 * is mechanically verified verbatim against the transcript, and quote +
 * context are DOUBLE-REDACTED (redactText per name-context, then redactPii)
 * before any row is written — the same non-negotiable as
 * voice_corpus_examples and resolution_artifacts.
 *
 * Idempotency: call_log.research_mined_at + research_prompt_version stamp
 * each call; a prompt-hash bump (or a re-transcription after mining)
 * re-selects the call, and each re-mine is a delete + reinsert inside one
 * transaction. Zero-chunk calls (robocalls, wrong numbers, unlabeled
 * transcripts) still get stamped so they aren't re-mined forever. Failed
 * extractions are NOT stamped — they retry on the next nightly run, and a
 * run aborts early after consecutive request failures so a provider outage
 * can't burn quota across the whole backlog.
 */

const db = require('../models/db');
const logger = require('./logger');
const { redactText } = require('./agent-decision-training');
const { redact: redactPii } = require('./content/pii-redactor');
const { dispatchWithFallback } = require('./llm/call');
const MODELS = require('../config/models');
const { hasAgentCallerLabels } = require('./sms-voice-corpus-miner');
const { RESEARCH_SCHEMA_VERSION } = require('./call-research-taxonomy');
const { buildCallResearchPrompt, validateResearchOutput, PROMPT_HASH } = require('./prompts/call-research-v1');

// Route locked by the 7-arm bake-off (2026-07-18, 20 fixed prod calls, all
// arms through the identical validate → verbatim-guard → redact pipeline):
// gpt-5.6-sol won on trustworthy-chunk volume (73 kept at 97% verbatim);
// Claude Opus 4.8 is the cross-provider fallback (98% verbatim, runner-up
// on precision) per the house automatic-fallback-to-Claude rule. Both legs
// env-overridable per the extraction-exception pattern; if the primary is
// pointed at Anthropic the fallback flips to OpenAI so the dispatcher's
// same-provider rejection can't brick the nightly. Swapping models
// mid-corpus mixes extraction provenance — pair a deliberate swap with a
// PROMPT_VERSION bump when a uniform re-mine is wanted. Re-run the bake-off
// (scripts/bakeoff-call-research.js) at major model GAs; bump only on a win.
const PRIMARY_PROVIDER = process.env.CALL_RESEARCH_PROVIDER || MODELS.PROVIDER.OPENAI;
// A provider-only override must never inherit another provider's model id —
// each provider gets its own bake-off-informed default.
const DEFAULT_MODEL_FOR = {
  [MODELS.PROVIDER.OPENAI]: MODELS.OPENAI_REPORT_WRITER,
  [MODELS.PROVIDER.ANTHROPIC]: MODELS.FLAGSHIP,
  [MODELS.PROVIDER.GEMINI]: 'gemini-2.5-pro',
};
const CALL_RESEARCH_PRIMARY = Object.freeze({
  provider: PRIMARY_PROVIDER,
  model: process.env.CALL_RESEARCH_MODEL || DEFAULT_MODEL_FOR[PRIMARY_PROVIDER] || MODELS.OPENAI_REPORT_WRITER,
});
const CALL_RESEARCH_ROUTE = Object.freeze({
  primary: CALL_RESEARCH_PRIMARY,
  fallback: CALL_RESEARCH_PRIMARY.provider === MODELS.PROVIDER.ANTHROPIC
    ? Object.freeze({ provider: MODELS.PROVIDER.OPENAI, model: MODELS.OPENAI_REPORT_WRITER })
    : Object.freeze({ provider: MODELS.PROVIDER.ANTHROPIC, model: MODELS.FLAGSHIP }),
});

const MAX_TRANSCRIPT_CHARS = 24000;
const MAX_CONSECUTIVE_FAILURES = 3;
const EXTRACTION_TIMEOUT_MS = 120000;
const MAX_SEGMENT_REFS = 5;

function normalizeForMatch(text) {
  return String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// The verbatim guard: a quote must appear in the transcript once whitespace
// and case are normalized. Paraphrases and hallucinations get dropped.
function isVerbatim(quote, normalizedTranscript) {
  const q = normalizeForMatch(quote);
  return q.length >= 3 && normalizedTranscript.includes(q);
}

// Multi-context double redaction (resolution-mapper precedent): run the
// exact-name pass once per known name context, then the heuristic PII pass.
function redactChunkText(text, contexts = []) {
  let out = String(text || '');
  if (!out) return out;
  for (const c of contexts) out = redactText(out, { customer: c });
  return redactPii(out).text;
}

function nameContext(source) {
  if (!source || typeof source !== 'object') return null;
  let first = typeof source.first_name === 'string' ? source.first_name : null;
  let last = typeof source.last_name === 'string' ? source.last_name : null;
  // Persisted call-extraction schema stores unsplit names as name_full.
  const full = typeof source.name === 'string' ? source.name
    : typeof source.name_full === 'string' ? source.name_full : null;
  if (full && !first && !last) {
    // redactText matches each context name as a whole string, so split an
    // unsplit full name too — a quote often carries just the first name.
    const parts = full.trim().split(/\s+/);
    if (parts.length >= 2) {
      first = parts[0];
      last = parts[parts.length - 1];
    }
  }
  if (!first && !last && !full) return null;
  return { first_name: first, last_name: last, customer_name: full };
}

// Linked customer row + whatever names the extraction pipeline already
// pulled out of the call (caller + secondary contacts) — all defensive:
// enriched payloads vary by schema version and may be strings.
function buildRedactionContexts(call, customer) {
  const contexts = [];
  if (customer) contexts.push(customer);
  let enriched = call && call.ai_extraction_enriched;
  if (typeof enriched === 'string') {
    try { enriched = JSON.parse(enriched); } catch { enriched = null; }
  }
  if (enriched && typeof enriched === 'object') {
    const candidates = [enriched.caller, enriched.secondary_contact]
      .concat(Array.isArray(enriched.secondary_contacts) ? enriched.secondary_contacts : []);
    for (const candidate of candidates) {
      const ctx = nameContext(candidate);
      if (ctx) contexts.push(ctx);
    }
  }
  return contexts;
}

// Post-schema normalization: dedupe, verify verbatim, and clamp the
// free-text fields. Returns clean chunks + drop counters for the summary.
function normalizeChunks(rawChunks, transcript) {
  const normalizedTranscript = normalizeForMatch(transcript);
  const seen = new Set();
  const dropped = {};
  const bump = (key) => { dropped[key] = (dropped[key] || 0) + 1; };
  const chunks = [];

  for (const raw of Array.isArray(rawChunks) ? rawChunks : []) {
    const quote = String(raw.quote || '').trim();
    if (!quote) { bump('empty_quote'); continue; }
    if (!isVerbatim(quote, normalizedTranscript)) { bump('quote_not_verbatim'); continue; }
    const dedupeKey = `${raw.tag}|${normalizeForMatch(quote)}`;
    if (seen.has(dedupeKey)) { bump('duplicate_quote'); continue; }
    seen.add(dedupeKey);

    const topics = (Array.isArray(raw.topics) ? raw.topics : [])
      .filter((t) => typeof t === 'string' && t.trim())
      .map((t) => t.trim().toLowerCase().slice(0, 60))
      .slice(0, 8);

    chunks.push({
      speaker: raw.speaker,
      quote,
      context: typeof raw.context === 'string' && raw.context.trim() ? raw.context.trim() : null,
      tag: raw.tag,
      topics,
      service_mentioned:
        typeof raw.service_mentioned === 'string' && raw.service_mentioned.trim()
          ? raw.service_mentioned.trim().slice(0, 50)
          : null,
    });
  }

  return { chunks, dropped };
}

// Mechanical jump-to-audio mapping — never model-produced. Matches diarized
// segments whose text overlaps the quote (either containment direction).
function mapSegmentRefs(quote, transcriptStructured) {
  let structured = transcriptStructured;
  if (typeof structured === 'string') {
    try { structured = JSON.parse(structured); } catch { return null; }
  }
  const segments = structured && Array.isArray(structured.segments) ? structured.segments : null;
  if (!segments) return null;

  const q = normalizeForMatch(quote);
  if (q.length < 3) return null;
  const refs = [];
  for (const seg of segments) {
    const segText = normalizeForMatch(seg && seg.text);
    if (segText.length < 3) continue;
    if (q.includes(segText) || segText.includes(q)) {
      refs.push({ id: seg.id != null ? seg.id : null, index: seg.index, start_ms: seg.start_ms, end_ms: seg.end_ms });
      if (refs.length >= MAX_SEGMENT_REFS) break;
    }
  }
  return refs.length ? refs : null;
}

// Base eligibility: inbound, transcribed, consent played, not spam/robocall,
// NULL-safe on pipeline columns (mirrors the voice-corpus filters).
function eligibleCallsQuery({ onlyUnmined = true } = {}) {
  let q = db('call_log')
    .where('direction', 'inbound')
    .whereNotNull('transcription')
    .where('call_recording_consent_disclaimer_played', true)
    .where(function () {
      this.whereNull('processing_status').orWhereNotIn('processing_status', ['spam', 'voicemail']);
    })
    .where(function () {
      this.whereNull('call_outcome').orWhereNotIn('call_outcome', ['wrong_number', 'spam']);
    });
  if (onlyUnmined) {
    q = q.where(function () {
      this.whereNull('research_mined_at')
        .orWhere('research_prompt_version', '<>', PROMPT_HASH)
        .orWhereRaw('retranscribed_at > research_mined_at');
    });
  }
  return q;
}

// One call → validated, normalized, REDACTED chunks. Shared by the nightly
// run and the pre-backfill bake-off (which passes a model override).
async function extractResearchChunks(call, customer, { route = CALL_RESEARCH_ROUTE } = {}) {
  const transcript = String(call.transcription || '').slice(0, MAX_TRANSCRIPT_CHARS);
  if (!hasAgentCallerLabels(transcript)) {
    return { status: 'unlabeled', chunks: [], dropped: {} };
  }

  // Schema validation runs INSIDE the dispatcher so contract-invalid primary
  // output (valid JSON, wrong shape) triggers the fallback leg instead of
  // failing the call outright.
  const res = await dispatchWithFallback(route, {
    text: buildCallResearchPrompt(transcript),
    jsonMode: true,
    maxTokens: 8192,
    temperature: 0, // closed-enum structured extraction — greedy decode
    timeoutMs: EXTRACTION_TIMEOUT_MS,
  }, {
    validate: (result) => (result.json && validateResearchOutput(result.json).valid ? null : 'research_schema_invalid'),
  });
  if (!res.ok || !res.json) {
    const schemaReject = (res.failures || []).some((f) => f.reason === 'research_schema_invalid');
    return schemaReject
      ? { status: 'schema_failed', errors: res.failures, chunks: [], dropped: {} }
      : { status: 'request_failed', reason: res.reason || 'empty_json', chunks: [], dropped: {} };
  }

  const { chunks, dropped } = normalizeChunks(res.json.chunks, transcript);
  const contexts = buildRedactionContexts(call, customer);
  // topics / service_mentioned are model-produced strings too — anything
  // redaction would alter carries PII and is useless as a facet, so it is
  // DROPPED rather than stored with markers (quote/context keep markers:
  // the surrounding words still carry research value there).
  const dropIfPii = (value) => {
    if (!value) return null;
    if (redactChunkText(value, contexts) !== value) {
      dropped.pii_facet_dropped = (dropped.pii_facet_dropped || 0) + 1;
      return null;
    }
    return value;
  };
  const redacted = chunks.map((c) => ({
    ...c,
    quote: redactChunkText(c.quote, contexts),
    context: c.context ? redactChunkText(c.context, contexts) : null,
    topics: c.topics.map(dropIfPii).filter(Boolean),
    service_mentioned: dropIfPii(c.service_mentioned),
    segment_refs: mapSegmentRefs(c.quote, call.transcript_structured),
  }));

  return { status: 'ok', chunks: redacted, dropped, model: res.model || route.primary.model, fallbackUsed: !!res.fallbackUsed };
}

// Delete + reinsert + stamp, one transaction per call. The stamp is a
// GUARDED claim on the retranscribed_at we extracted from: if the hourly
// re-transcription backfill replaced the transcript mid-extraction, an
// unconditional stamp would bury the new transcript forever (its
// retranscribed_at would no longer exceed research_mined_at). Zero rows
// claimed → our chunks are stale → write nothing; the next run re-mines.
// date_trunc to ms because node Dates drop Postgres microseconds.
async function persistCallChunks(call, chunks, extractionModel) {
  return db.transaction(async (trx) => {
    const claimed = await trx('call_log')
      .where({ id: call.id })
      .modify((q) => {
        if (call.retranscribed_at) {
          q.whereRaw("date_trunc('milliseconds', retranscribed_at) = ?", [new Date(call.retranscribed_at)]);
        } else {
          q.whereNull('retranscribed_at');
        }
      })
      .update({
        research_mined_at: new Date(),
        research_prompt_version: PROMPT_HASH,
        updated_at: new Date(),
      });
    if (!claimed) return false;
    await trx('call_research_chunks').where({ call_log_id: call.id }).del();
    if (chunks.length) {
      await trx('call_research_chunks').insert(chunks.map((c, i) => ({
        call_log_id: call.id,
        customer_id: call.customer_id || null,
        chunk_index: i,
        speaker: c.speaker,
        quote: c.quote,
        context: c.context,
        tag: c.tag,
        topics: JSON.stringify(c.topics),
        service_mentioned: c.service_mentioned,
        segment_refs: c.segment_refs ? JSON.stringify(c.segment_refs) : null,
        occurred_at: call.created_at,
        extraction_model: extractionModel,
        prompt_version: PROMPT_HASH,
        schema_version: RESEARCH_SCHEMA_VERSION,
      })));
    }
    return true;
  });
}

async function mineCallResearch({ limit = 150 } = {}) {
  const startedAt = Date.now();
  const skipped = {};
  const bump = (key, by = 1) => { skipped[key] = (skipped[key] || 0) + by; };

  const keyFor = (provider) => {
    if (provider === MODELS.PROVIDER.OPENAI) return !!process.env.OPENAI_API_KEY;
    if (provider === MODELS.PROVIDER.ANTHROPIC) return !!process.env.ANTHROPIC_API_KEY;
    return !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
  };
  if (![CALL_RESEARCH_ROUTE.primary, CALL_RESEARCH_ROUTE.fallback].some((r) => keyFor(r.provider))) {
    logger.warn('[call-research] no API key for either route leg — skipping run');
    return { examined: 0, mined: 0, chunksInserted: 0, skipped: { no_llm_key: 1 }, exhausted: true, ms: 0 };
  }

  // Degrade CLOSED if the consent column is missing (voice-corpus precedent).
  if (!(await db.schema.hasColumn('call_log', 'call_recording_consent_disclaimer_played'))) {
    logger.warn('[call-research] consent column missing — skipping run');
    return { examined: 0, mined: 0, chunksInserted: 0, skipped: { consent_column_missing: 1 }, exhausted: true, ms: 0 };
  }

  const calls = await eligibleCallsQuery()
    .orderBy('created_at', 'asc')
    .limit(limit)
    .select('id', 'customer_id', 'transcription', 'transcript_structured', 'ai_extraction_enriched', 'created_at', 'retranscribed_at');

  const customerIds = [...new Set(calls.map((c) => c.customer_id).filter(Boolean))];
  const customerById = new Map();
  if (customerIds.length) {
    const customers = await db('customers').whereIn('id', customerIds).select('id', 'first_name', 'last_name', 'phone');
    customers.forEach((c) => customerById.set(c.id, c));
  }

  let mined = 0;
  let chunksInserted = 0;
  let consecutiveFailures = 0;

  for (const call of calls) {
    const result = await extractResearchChunks(call, customerById.get(call.customer_id) || null);

    if (result.status === 'request_failed') {
      bump('extraction_failed');
      consecutiveFailures += 1;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        logger.error(`[call-research] aborting run after ${consecutiveFailures} consecutive extraction failures (last: ${result.reason})`);
        break;
      }
      continue; // not stamped — retries next run
    }
    consecutiveFailures = 0;

    if (result.status === 'schema_failed') {
      bump('schema_failed');
      logger.warn(`[call-research] schema validation failed for call ${call.id}: ${JSON.stringify((result.errors || []).slice(0, 3))}`);
      continue; // not stamped — retries next run
    }

    if (result.status === 'unlabeled') bump('transcript_unlabeled');
    Object.entries(result.dropped || {}).forEach(([key, count]) => bump(key, count));

    const persisted = await persistCallChunks(call, result.chunks, result.model || CALL_RESEARCH_ROUTE.primary.model);
    if (!persisted) {
      bump('retranscribed_mid_mine'); // fresh transcript re-selects next run
      continue;
    }
    mined += 1;
    chunksInserted += result.chunks.length;
    if (result.status === 'ok' && !result.chunks.length) bump('zero_chunks');
  }

  const summary = {
    examined: calls.length,
    mined,
    chunksInserted,
    skipped,
    exhausted: calls.length < limit,
    ms: Date.now() - startedAt,
  };
  logger.info(`[call-research] run complete: ${JSON.stringify(summary)}`);
  return summary;
}

module.exports = {
  mineCallResearch,
  extractResearchChunks,
  eligibleCallsQuery,
  CALL_RESEARCH_ROUTE,
  _test: {
    normalizeForMatch,
    isVerbatim,
    normalizeChunks,
    redactChunkText,
    buildRedactionContexts,
    mapSegmentRefs,
    persistCallChunks,
    MAX_TRANSCRIPT_CHARS,
  },
};
