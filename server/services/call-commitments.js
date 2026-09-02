/**
 * Call commitments — what Waves promised the caller and what the caller
 * agreed to do, each as its own reviewable row with transcript evidence.
 *
 * Sources, in order:
 *   1. Deterministic seeds from the V2 extraction the pipeline already
 *      produced (quote_promised → send_estimate, a confirmed slot →
 *      send_appointment_confirmation, a callback disposition/window →
 *      callback, follow_up_mentioned → technician_follow_up). No model call,
 *      no new prompt hash, and the evidence the V2 prompt already pins.
 *   2. One bounded model pass over the labeled transcript for the promises
 *      V2 has no field for (send the report, send the WDO paperwork, the
 *      caller will text photos / confirm a date / call back). Every quote
 *      the model returns is re-grounded against the transcript text; a
 *      commitment with no verbatim evidence is DROPPED, never stored.
 *
 * Identity: `commitment_key` is party:kind for the singular kinds and
 * party:kind:<description slug> for the kinds a call can carry more than
 * once (send_report, send_paperwork, provide_info, other), so a reprocess
 * upserts instead of duplicating and two distinct promises of a repeatable
 * kind keep their own rows. Human-touched rows (human_state set, or source='human') are
 * never rewritten by the AI upsert; they are re-marked as still detected.
 *
 * Fulfillment: a promise is not fulfilled because the summary says so. Only
 * a later record LINKED to this call (a visit booked from it, the estimate
 * on the lead it minted, the invoice for that visit) marks it kept. A record
 * that merely belongs to the same customer or phone inside a bounded window
 * is stored as a hint with the status left open — the office confirms it —
 * so nobody mistakes an association for proof.
 *
 * Dark behind GATE_CALL_COMMITMENTS (checked by the processor). Reads
 * happen regardless of the gate so already-recorded rows stay visible.
 */

const crypto = require('crypto');
const logger = require('./logger');
const MODELS = require('../config/models');
const { parseETDateTime } = require('../utils/datetime-et');

// A due time typed by the office arrives either as an ISO instant (the
// panel converts its datetime-local value with the ET helper) or, from any
// other client, as a naive 'YYYY-MM-DDTHH:mm'. Railway runs in UTC, so a
// naive string handed to new Date() lands 4–5 hours off the Eastern
// deadline that was meant — parseETDateTime pins naive strings to ET.
function parseDueAt(value) {
  if (value == null || value === '') return null;
  const d = parseETDateTime(value);
  return d instanceof Date && !Number.isNaN(d.getTime()) ? d : NaN;
}

let Anthropic = null;
try { Anthropic = require('@anthropic-ai/sdk'); } catch { Anthropic = null; }

const WAVES_KINDS = Object.freeze([
  'send_estimate', 'send_appointment_confirmation', 'callback', 'send_report',
  'send_paperwork', 'technician_follow_up', 'schedule_visit',
]);
const CUSTOMER_KINDS = Object.freeze([
  'send_photos', 'confirm_date', 'call_back', 'provide_info', 'make_payment',
]);
const COMMITMENT_KINDS = Object.freeze([...WAVES_KINDS, ...CUSTOMER_KINDS, 'other']);
const CHANNELS = Object.freeze(['sms', 'email', 'call', 'in_person', 'unknown']);

// Bumped when the derivation rules or the model prompt change, so a row can
// say which extractor produced it.
const EXTRACTOR_VERSION = 'commitments-v1';

// Mirrors CALL_PROC_EXTRACT_TIMEOUT_MS in call-recording-processor.js; the
// claim ceiling counts this leg at the same budget.
const MODEL_TIMEOUT_MS = Number(process.env.CALL_PROC_EXTRACT_TIMEOUT_MS) || 180000;

// Ungrounded output is dropped; grounded-but-hedged output is stored with
// its confidence so the office can weigh it. Below this the model is
// guessing and the row would be noise.
const MIN_MODEL_CONFIDENCE = 0.5;

// ── Identity ───────────────────────────────────────────────────────────────
function slug(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !['the', 'a', 'an', 'to', 'will', 'we', 'i', 'you', 'and', 'of', 'for', 'our', 'your', 'them', 'it'].includes(w))
    .slice(0, 6)
    .join('-');
}

// Kinds a single call can legitimately carry MORE THAN ONCE (send the WDO
// report AND the treatment paperwork; provide the gate code AND the HOA
// contact). These key on a description slug as well, like `other`; the
// singular kinds (one estimate, one confirmation, one callback…) key on
// party:kind alone so a reworded description on reprocess upserts the same
// row instead of duplicating it.
const REPEATABLE_KINDS = new Set(['send_report', 'send_paperwork', 'provide_info', 'other']);

function commitmentKey(item) {
  const party = item.party === 'customer' ? 'customer' : 'waves';
  const kind = COMMITMENT_KINDS.includes(item.kind) ? item.kind : 'other';
  if (!REPEATABLE_KINDS.has(kind)) return `${party}:${kind}`;
  const s = slug(item.description) || crypto.createHash('sha1').update(String(item.description || '')).digest('hex').slice(0, 10);
  return `${party}:${kind}:${s}`.slice(0, 160);
}

// ── Evidence ───────────────────────────────────────────────────────────────
function normalizeForMatch(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Pin a quote to the diarized segment it came from (segment index +
// timestamps, for the "jump to this moment" affordance), or to a character
// offset in the flat transcript when there are no segments (Gemini
// fallback), or mark it unmatched. Never invents a location.
function anchorEvidence(evidence, { segments = null, transcript = '' } = {}) {
  const out = [];
  const flatNorm = normalizeForMatch(transcript);
  for (const item of Array.isArray(evidence) ? evidence : []) {
    const quote = String(item?.quote || '').trim();
    if (!quote) continue;
    const anchored = {
      quote,
      speaker: item.speaker === 'agent' || item.speaker === 'caller' ? item.speaker : null,
      matched: false,
    };
    if (item.field_path) anchored.field_path = item.field_path;
    const q = normalizeForMatch(quote);
    if (q && Array.isArray(segments) && segments.length) {
      const hit = segments.find((s) => normalizeForMatch(s?.text).includes(q));
      if (hit) {
        anchored.matched = true;
        anchored.segment_index = Number.isFinite(Number(hit.index)) ? Number(hit.index) : segments.indexOf(hit);
        if (hit.start_ms != null) anchored.start_ms = Number(hit.start_ms);
        if (hit.end_ms != null) anchored.end_ms = Number(hit.end_ms);
      }
    }
    if (!anchored.matched && q && flatNorm.includes(q)) {
      anchored.matched = true;
      // Approximate character offset in the ORIGINAL text via a case- and
      // punctuation-insensitive search on the raw string.
      const idx = String(transcript || '').toLowerCase().indexOf(quote.toLowerCase());
      if (idx >= 0) anchored.char_offset = idx;
    }
    out.push(anchored);
  }
  return out;
}

function evidenceFor(v2, paths) {
  const list = Array.isArray(v2?.evidence) ? v2.evidence : [];
  return list.filter((e) => e?.quote && paths.some((p) => String(e.field_path || '').startsWith(p)));
}

// ── Deterministic seeds from the V2 extraction ─────────────────────────────
function isoOrNull(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function deriveCommitmentsFromExtraction({ v2 = null, v1 = null, disposition = null } = {}) {
  const items = [];
  const sr = v2?.service_request || {};
  const sched = v2?.scheduling || {};
  const conf = v2?.confidence || {};

  if (sr.quote_promised === true || v1?.quote_promised === true) {
    items.push({
      party: 'waves',
      kind: 'send_estimate',
      description: 'Send the caller an estimate',
      channel: v2?.caller?.preferred_contact_method === 'sms' ? 'sms'
        : v2?.caller?.preferred_contact_method === 'email' ? 'email' : 'unknown',
      due_at: null,
      due_basis: null,
      confidence: typeof conf.overall === 'number' ? conf.overall : null,
      evidence: evidenceFor(v2, ['/service_request/quote_promised', '/service_request/quoted_price_usd']),
      origin: 'v2:service_request.quote_promised',
    });
  }

  if (sched.status === 'confirmed' && sched.confirmed_start_at) {
    items.push({
      party: 'waves',
      kind: 'send_appointment_confirmation',
      description: `Send the appointment confirmation for ${sched.confirmed_start_at}`,
      channel: 'sms',
      due_at: null,
      due_basis: null,
      confidence: typeof conf.scheduling_window === 'number' ? conf.scheduling_window : null,
      evidence: evidenceFor(v2, ['/scheduling/confirmed_start_at', '/scheduling/status', '/scheduling/agent_committed_booking']),
      origin: 'v2:scheduling.confirmed',
    });
  }

  const callbackWindow = isoOrNull(sched.callback_window_start);
  if (disposition === 'callback_task_created' || v2?.recommended_disposition === 'callback_task_created' || callbackWindow) {
    items.push({
      party: 'waves',
      kind: 'callback',
      description: callbackWindow ? `Call the customer back (asked for ${sched.callback_window_start})` : 'Call the customer back',
      channel: 'call',
      due_at: callbackWindow,
      due_basis: callbackWindow ? 'stated' : null,
      confidence: typeof conf.scheduling_window === 'number' ? conf.scheduling_window : null,
      evidence: evidenceFor(v2, ['/scheduling/callback_window_start', '/scheduling/callback_window_end']),
      origin: callbackWindow ? 'v2:scheduling.callback_window_start' : 'disposition:callback_task_created',
    });
  }

  if (sched.follow_up_mentioned === true) {
    const followUpAt = isoOrNull(sched.follow_up_start_at);
    items.push({
      party: 'waves',
      kind: 'technician_follow_up',
      description: followUpAt ? `Follow-up visit or contact around ${sched.follow_up_start_at}` : 'Follow-up visit or contact was discussed',
      channel: 'unknown',
      due_at: followUpAt,
      due_basis: followUpAt ? 'stated' : null,
      confidence: typeof conf.scheduling_window === 'number' ? conf.scheduling_window : null,
      evidence: evidenceFor(v2, ['/scheduling/follow_up_start_at', '/scheduling/follow_up_mentioned']),
      origin: 'v2:scheduling.follow_up_mentioned',
    });
  }

  return items;
}

// ── Model pass ─────────────────────────────────────────────────────────────
const MODEL_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['commitments'],
  properties: {
    commitments: {
      type: 'array',
      maxItems: 12,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['party', 'kind', 'description', 'evidence', 'confidence'],
        properties: {
          party: { type: 'string', enum: ['waves', 'customer'] },
          kind: { type: 'string', enum: COMMITMENT_KINDS },
          description: { type: 'string', minLength: 3, maxLength: 240 },
          channel: { type: ['string', 'null'], enum: [...CHANNELS, null] },
          due_text: { type: ['string', 'null'], maxLength: 80 },
          due_at: { type: ['string', 'null'] },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          evidence: {
            type: 'array',
            minItems: 1,
            maxItems: 3,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['quote', 'speaker'],
              properties: {
                quote: { type: 'string', minLength: 3, maxLength: 300 },
                speaker: { type: 'string', enum: ['agent', 'caller'] },
              },
            },
          },
        },
      },
    },
  },
};

let validateModelOutput = null;
function getValidator() {
  if (validateModelOutput) return validateModelOutput;
  const Ajv = require('ajv/dist/2020');
  const ajv = new Ajv({ allErrors: true, strict: false });
  validateModelOutput = ajv.compile(MODEL_OUTPUT_SCHEMA);
  return validateModelOutput;
}

function buildCommitmentsPrompt({ transcript, callStartedAt }) {
  const when = callStartedAt ? new Date(callStartedAt).toLocaleString('en-US', { timeZone: 'America/New_York' }) : 'unknown';
  return `You read a phone call transcript between a Waves Pest Control agent ("Agent:") and a caller ("Caller:") and list the COMMITMENTS made on the call.

A commitment is something one party explicitly said they would do after the call. Two parties:
- "waves": the agent promised to do something (send an estimate, send an appointment confirmation text, call back, email a report, send WDO/termite paperwork, have the technician follow up, schedule a visit).
- "customer": the caller agreed to do something (send photos, confirm a date, call back, provide information such as an address or gate code, make a payment).

Rules — these are strict:
1. Only list what was actually SAID. Do not infer a promise from context, tone, or what a good agent would normally do. If nobody committed to anything, return {"commitments": []}.
2. Every commitment needs at least one VERBATIM quote copied exactly from the transcript (same words, same spelling), with the speaker who said it. Do not paraphrase the quote.
3. "due_text" is the timing as spoken ("by tomorrow morning", "later today", "after the inspection") or null. "due_at" is an ISO 8601 timestamp with the -04:00/-05:00 Eastern offset ONLY when the spoken timing names a specific day/time relative to the call date (${when} Eastern); otherwise null. Never invent a time.
4. "confidence" is how sure you are that the quoted words constitute a real commitment (0 to 1).
5. Use kind "other" only when none of the listed kinds fits.
6. Output ONLY a JSON object, no prose:
{"commitments":[{"party":"waves","kind":"send_estimate","description":"...","channel":"email","due_text":"...","due_at":null,"confidence":0.9,"evidence":[{"quote":"...","speaker":"agent"}]}]}

Transcript:
${transcript}`;
}

function parseLooseJsonObject(text) {
  const raw = String(text || '').trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('no JSON object in model output');
  return JSON.parse(raw.slice(start, end + 1));
}

// Drop anything the transcript does not literally support. Returns the
// surviving items plus counts for the processing log.
function groundModelCommitments(items, transcript) {
  const flat = normalizeForMatch(transcript);
  const kept = [];
  let droppedUngrounded = 0;
  let droppedLowConfidence = 0;
  for (const item of Array.isArray(items) ? items : []) {
    const grounded = (item.evidence || []).filter((e) => {
      const q = normalizeForMatch(e?.quote);
      return q.length >= 3 && flat.includes(q);
    });
    if (!grounded.length) { droppedUngrounded += 1; continue; }
    if (typeof item.confidence !== 'number' || item.confidence < MIN_MODEL_CONFIDENCE) { droppedLowConfidence += 1; continue; }
    kept.push({
      party: item.party,
      kind: COMMITMENT_KINDS.includes(item.kind) ? item.kind : 'other',
      description: String(item.description).trim(),
      channel: CHANNELS.includes(item.channel) ? item.channel : 'unknown',
      due_at: isoOrNull(item.due_at),
      due_basis: item.due_at ? 'stated' : null,
      due_text: item.due_text || null,
      confidence: item.confidence,
      evidence: grounded.map((e) => ({ quote: String(e.quote).trim(), speaker: e.speaker })),
      origin: 'model',
    });
  }
  return { kept, droppedUngrounded, droppedLowConfidence };
}

async function extractCommitmentsWithModel(transcript, { callStartedAt = null, client = null } = {}) {
  if (!transcript || String(transcript).length < 40) return { items: [], skipped: 'transcript_too_short' };
  const anthropic = client || ((Anthropic && process.env.ANTHROPIC_API_KEY) ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null);
  if (!anthropic) return { items: [], skipped: 'no_provider' };
  const startedAt = Date.now();
  const response = await anthropic.messages.create({
    model: MODELS.FLAGSHIP,
    max_tokens: 2000,
    temperature: 0,
    messages: [{ role: 'user', content: buildCommitmentsPrompt({ transcript, callStartedAt }) }],
    // maxRetries: 0 — the pipeline has its own retry lanes; a claim-holding
    // pass must not hold the claim through the SDK's per-attempt timeouts.
  }, { timeout: MODEL_TIMEOUT_MS, maxRetries: 0 });
  const text = (response?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  let parsed;
  try {
    parsed = parseLooseJsonObject(text);
  } catch (err) {
    return { items: [], skipped: 'parse_failed', error: err.message, model: MODELS.FLAGSHIP, ms: Date.now() - startedAt };
  }
  const validate = getValidator();
  if (!validate(parsed)) {
    return { items: [], skipped: 'schema_failed', errors: validate.errors, model: MODELS.FLAGSHIP, ms: Date.now() - startedAt };
  }
  const grounded = groundModelCommitments(parsed.commitments, transcript);
  return { items: grounded.kept, droppedUngrounded: grounded.droppedUngrounded, droppedLowConfidence: grounded.droppedLowConfidence, model: MODELS.FLAGSHIP, ms: Date.now() - startedAt };
}

// ── Persistence ────────────────────────────────────────────────────────────
function toRow(callLogId, item, { generation, extractorVersion }) {
  return {
    call_log_id: callLogId,
    commitment_key: commitmentKey(item),
    party: item.party === 'customer' ? 'customer' : 'waves',
    kind: COMMITMENT_KINDS.includes(item.kind) ? item.kind : 'other',
    description: String(item.description || '').slice(0, 2000),
    channel: CHANNELS.includes(item.channel) ? item.channel : 'unknown',
    due_at: item.due_at ? new Date(item.due_at) : null,
    due_basis: item.due_basis || null,
    confidence: typeof item.confidence === 'number' ? Math.max(0, Math.min(1, item.confidence)) : null,
    evidence: JSON.stringify(item.evidence || []),
    source: 'ai',
    processing_generation: generation ?? null,
    last_seen_generation: generation ?? null,
    extractor_version: extractorVersion || EXTRACTOR_VERSION,
    status: 'open',
    updated_at: new Date(),
  };
}

// Upsert the AI's view of this pass. The whole write runs in one
// transaction that first takes a SHARE lock on the call_log row WITH the
// pass's fence: while the pass holds its claim that is the
// processing_token; after finalization (token cleared) it is the pass's
// processing_generation with no live token — the same post-finalization
// identity the detached estimator lanes use. A peer's claim UPDATE has to
// wait for this commit, so a superseded pass cannot write and a claim
// cannot move between the check and the write.
async function upsertCommitments(conn, callLogId, items, { generation = null, extractorVersion = EXTRACTOR_VERSION, procToken = null, procGeneration = null } = {}) {
  const dedupedByKey = new Map();
  for (const item of items) {
    const key = commitmentKey(item);
    // First detection wins for the same key; the seeds run before the model.
    if (!dedupedByKey.has(key)) dedupedByKey.set(key, item);
  }
  const rows = [...dedupedByKey.values()].map((item) => toRow(callLogId, item, { generation, extractorVersion }));

  return conn.transaction(async (trx) => {
    if (procToken) {
      const owned = await trx('call_log').where({ id: callLogId, processing_token: procToken }).forShare().first('id');
      if (!owned) return { written: 0, ownershipLost: true };
    } else if (procGeneration != null) {
      const current = await trx('call_log')
        .where({ id: callLogId, processing_generation: procGeneration })
        .whereNull('processing_token')
        .forShare()
        .first('id');
      if (!current) return { written: 0, ownershipLost: true };
    }
    let written = 0;
    for (const row of rows) {
      // ON CONFLICT … DO UPDATE only when the row is still the AI's to
      // change: a human confirmation/edit/dismissal or a human-created row
      // is never rewritten. Every seen row is re-marked as detected on this
      // generation so the UI can say "still detected" vs "not seen lately".
      const result = await trx.raw(
        `INSERT INTO call_commitments
           (call_log_id, commitment_key, party, kind, description, channel, due_at, due_basis, confidence,
            evidence, source, processing_generation, last_seen_generation, extractor_version, status, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (call_log_id, commitment_key) DO UPDATE SET
           description = CASE WHEN call_commitments.human_state IS NULL AND call_commitments.source = 'ai' THEN EXCLUDED.description ELSE call_commitments.description END,
           channel = CASE WHEN call_commitments.human_state IS NULL AND call_commitments.source = 'ai' THEN EXCLUDED.channel ELSE call_commitments.channel END,
           due_at = CASE WHEN call_commitments.human_state IS NULL AND call_commitments.source = 'ai' THEN EXCLUDED.due_at ELSE call_commitments.due_at END,
           due_basis = CASE WHEN call_commitments.human_state IS NULL AND call_commitments.source = 'ai' THEN EXCLUDED.due_basis ELSE call_commitments.due_basis END,
           confidence = CASE WHEN call_commitments.human_state IS NULL AND call_commitments.source = 'ai' THEN EXCLUDED.confidence ELSE call_commitments.confidence END,
           evidence = CASE WHEN call_commitments.human_state IS NULL AND call_commitments.source = 'ai' THEN EXCLUDED.evidence ELSE call_commitments.evidence END,
           processing_generation = CASE WHEN call_commitments.human_state IS NULL AND call_commitments.source = 'ai' THEN EXCLUDED.processing_generation ELSE call_commitments.processing_generation END,
           extractor_version = CASE WHEN call_commitments.human_state IS NULL AND call_commitments.source = 'ai' THEN EXCLUDED.extractor_version ELSE call_commitments.extractor_version END,
           last_seen_generation = EXCLUDED.last_seen_generation,
           updated_at = CASE WHEN call_commitments.human_state IS NULL AND call_commitments.source = 'ai' THEN EXCLUDED.updated_at ELSE call_commitments.updated_at END
         RETURNING id, (xmax = 0) AS inserted`,
        [
          row.call_log_id, row.commitment_key, row.party, row.kind, row.description, row.channel, row.due_at, row.due_basis, row.confidence,
          row.evidence, row.source, row.processing_generation, row.last_seen_generation, row.extractor_version, row.status, row.updated_at,
        ],
      );
      written += (result?.rows || []).length;
    }
    return { written, ownershipLost: false, keys: rows.map((r) => r.commitment_key) };
  });
}

function parseSegments(transcriptStructured) {
  try {
    const parsed = typeof transcriptStructured === 'string' ? JSON.parse(transcriptStructured) : transcriptStructured;
    return Array.isArray(parsed?.segments) ? parsed.segments : null;
  } catch { return null; }
}

/**
 * The processor's one entry point: derive seeds, run the model pass, anchor
 * evidence, upsert under the claim fence. Never throws — a failure here
 * must not fail the call; it is logged and reported in the return value.
 */
async function recordCallCommitments({
  conn,
  call,
  transcript,
  v2 = null,
  v1 = null,
  disposition = null,
  procToken = null,
  procGeneration = null,
  modelClient = null,
  runModel = true,
} = {}) {
  const summary = { seeds: 0, model: 0, written: 0, dropped: 0, ownershipLost: false, skipped: null };
  try {
    const segments = parseSegments(call?.transcript_structured);
    const seeds = deriveCommitmentsFromExtraction({ v2, v1, disposition });
    summary.seeds = seeds.length;
    let modelItems = [];
    if (runModel) {
      const model = await extractCommitmentsWithModel(transcript, { callStartedAt: call?.created_at, client: modelClient });
      summary.skipped = model.skipped || null;
      summary.dropped = (model.droppedUngrounded || 0) + (model.droppedLowConfidence || 0);
      summary.modelMs = model.ms || null;
      modelItems = model.items || [];
      summary.model = modelItems.length;
    }
    const items = [...seeds, ...modelItems].map((item) => ({
      ...item,
      evidence: anchorEvidence(item.evidence, { segments, transcript }),
    }));
    const result = await upsertCommitments(conn, call.id, items, { generation: procGeneration, procToken, procGeneration });
    summary.written = result.written;
    summary.ownershipLost = result.ownershipLost;
    return summary;
  } catch (err) {
    logger.warn(`[call-commitments] recording failed for call ${call?.id}: ${err.message}`);
    return { ...summary, error: err.message };
  }
}

// ── Reads ──────────────────────────────────────────────────────────────────
async function listForCall(conn, callLogId) {
  const rows = await conn('call_commitments').where({ call_log_id: callLogId }).orderBy([{ column: 'party' }, { column: 'created_at' }]);
  return rows.map(normalizeRow);
}

function normalizeRow(row) {
  const parse = (v) => {
    if (v == null) return null;
    if (typeof v === 'string') { try { return JSON.parse(v); } catch { return null; } }
    return v;
  };
  return {
    ...row,
    evidence: parse(row.evidence) || [],
    fulfillment: parse(row.fulfillment),
    confidence: row.confidence == null ? null : Number(row.confidence),
  };
}

// ── Fulfillment ────────────────────────────────────────────────────────────
// Two strengths of proof, and only one of them changes status:
//   direct      — the later record is LINKED to this call (a visit whose
//                 source_call_log_id is this call, an estimate on the lead
//                 this call minted, an invoice for that visit). Marks the
//                 commitment fulfilled.
//   association — the later record merely belongs to the same customer or
//                 phone, inside ASSOCIATION_WINDOW_DAYS of the call. Stored
//                 as a HINT on the row (fulfillment.strength = "association")
//                 with the status left open, so the office confirms it with
//                 "Mark done" instead of the system inventing history.
const ASSOCIATION_WINDOW_DAYS = 14;

function contactPhoneOf(call) {
  return String(call?.direction || "").startsWith("outbound") ? call?.to_phone : call?.from_phone;
}

function phoneDigits(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
}

function phoneWhere(builder, column, phone) {
  const key = phoneDigits(phone);
  if (!key) { builder.whereRaw("false"); return; }
  builder.whereRaw(`regexp_replace(COALESCE(${column}, ''), '[^0-9]', '', 'g') IN (?, ?)`, [key, `1${key}`]);
}

function windowEnd(after) {
  return new Date(after.getTime() + ASSOCIATION_WINDOW_DAYS * 24 * 60 * 60 * 1000);
}

function leadIdOf(call) {
  try {
    const meta = typeof call?.metadata === "string" ? JSON.parse(call.metadata) : (call?.metadata || {});
    return meta?.lead_id || null;
  } catch { return null; }
}

// Where each kind looks for its proof. Every match is AFTER the call; the
// strength says whether the record is linked to this call or merely to the
// same customer/phone inside the window.
async function resolveFulfillment(conn, commitment, call) {
  const after = call?.created_at ? new Date(call.created_at) : null;
  if (!after || Number.isNaN(after.getTime())) return null;
  const until = windowEnd(after);
  const phone = contactPhoneOf(call);
  const customerId = call?.customer_id || null;
  const leadId = leadIdOf(call);

  switch (commitment.kind) {
    case "send_estimate": {
      // Direct: the estimate on the lead this call minted (or that carries
      // this call's SID). Association: any later estimate sent to the
      // call's customer inside the window.
      const leadEstimate = await conn("leads")
        .where(function scope() {
          if (leadId) this.orWhere("id", leadId);
          if (call.twilio_call_sid) this.orWhere("twilio_call_sid", call.twilio_call_sid);
        })
        .whereNotNull("estimate_id")
        .first("estimate_id")
        .catch(() => null);
      if (leadEstimate?.estimate_id) {
        // The lead can be a REUSED one (an earlier call's), so its estimate
        // must have been sent after THIS call to count as this call's proof.
        const est = await conn("estimates").where({ id: leadEstimate.estimate_id }).whereNotNull("sent_at").where("sent_at", ">", after).first("id", "sent_at", "status");
        if (est) return { kind: "estimate_sent", record_type: "estimate", record_id: est.id, matched_at: est.sent_at, strength: "direct", basis: "estimate_sent_on_the_lead_this_call_created" };
      }
      if (!customerId) return null;
      const est = await conn("estimates")
        .where("customer_id", customerId)
        .whereNotNull("sent_at")
        .where("sent_at", ">", after)
        .where("sent_at", "<=", until)
        .orderBy("sent_at", "asc")
        .first("id", "sent_at", "status");
      return est ? { kind: "estimate_sent", record_type: "estimate", record_id: est.id, matched_at: est.sent_at, strength: "association", basis: `estimate_sent_to_same_customer_within_${ASSOCIATION_WINDOW_DAYS}_days` } : null;
    }
    case "send_appointment_confirmation": {
      if (!phone) return null;
      const sms = await conn("sms_log")
        .where({ direction: "outbound", message_type: "confirmation" })
        .where("created_at", ">", after)
        .where("created_at", "<=", until)
        .modify((b) => phoneWhere(b, "to_phone", phone))
        .orderBy("created_at", "asc")
        .first("id", "created_at", "status");
      return sms ? { kind: "sms_sent", record_type: "sms_log", record_id: sms.id, matched_at: sms.created_at, strength: "association", basis: `confirmation_text_to_caller_within_${ASSOCIATION_WINDOW_DAYS}_days` } : null;
    }
    case "callback": {
      if (!phone) return null;
      const outbound = await conn("call_log")
        .where("direction", "like", "outbound%")
        .where("created_at", ">", after)
        .where("created_at", "<=", until)
        .where("status", "completed")
        .where("duration_seconds", ">=", 20)
        .modify((b) => phoneWhere(b, "to_phone", phone))
        .orderBy("created_at", "asc")
        .first("id", "created_at");
      return outbound ? { kind: "outbound_call", record_type: "call_log", record_id: outbound.id, matched_at: outbound.created_at, strength: "association", basis: `completed_outbound_call_to_caller_within_${ASSOCIATION_WINDOW_DAYS}_days` } : null;
    }
    case "schedule_visit":
    case "technician_follow_up": {
      const direct = await conn("scheduled_services")
        .where("source_call_log_id", call.id)
        .whereNotIn("status", ["cancelled", "canceled"])
        .orderBy("created_at", "asc")
        .first("id", "created_at", "scheduled_date", "status");
      if (direct) return { kind: "appointment_booked", record_type: "scheduled_service", record_id: direct.id, matched_at: direct.created_at, strength: "direct", basis: "visit_booked_from_this_call" };
      if (!customerId) return null;
      const visit = await conn("scheduled_services")
        .where("customer_id", customerId)
        .where("created_at", ">", after)
        .where("created_at", "<=", until)
        .whereNotIn("status", ["cancelled", "canceled"])
        .orderBy("created_at", "asc")
        .first("id", "created_at", "scheduled_date", "status");
      return visit ? { kind: "appointment_booked", record_type: "scheduled_service", record_id: visit.id, matched_at: visit.created_at, strength: "association", basis: `visit_booked_for_same_customer_within_${ASSOCIATION_WINDOW_DAYS}_days` } : null;
    }
    case "send_photos": {
      if (!phone) return null;
      const msg = await conn("messages as m")
        .join("conversations as c", "c.id", "m.conversation_id")
        .where("m.direction", "inbound")
        .where("m.created_at", ">", after)
        .where("m.created_at", "<=", until)
        .whereRaw("m.media IS NOT NULL AND jsonb_typeof(m.media) = 'array' AND jsonb_array_length(m.media) > 0")
        .modify((b) => phoneWhere(b, "c.contact_phone", phone))
        .orderBy("m.created_at", "asc")
        .first("m.id", "m.created_at")
        .catch(() => null);
      return msg ? { kind: "inbound_media", record_type: "message", record_id: msg.id, matched_at: msg.created_at, strength: "association", basis: `inbound_message_with_media_from_caller_within_${ASSOCIATION_WINDOW_DAYS}_days` } : null;
    }
    case "make_payment": {
      const direct = await conn("invoices as i")
        .join("scheduled_services as ss", "ss.id", "i.scheduled_service_id")
        .where("ss.source_call_log_id", call.id)
        .whereNotNull("i.paid_at")
        .orderBy("i.paid_at", "asc")
        .first("i.id", "i.paid_at")
        .catch(() => null);
      if (direct) return { kind: "invoice_paid", record_type: "invoice", record_id: direct.id, matched_at: direct.paid_at, strength: "direct", basis: "invoice_for_the_visit_booked_from_this_call_paid" };
      if (!customerId) return null;
      const inv = await conn("invoices").where({ customer_id: customerId }).whereNotNull("paid_at").where("paid_at", ">", after).where("paid_at", "<=", until).orderBy("paid_at", "asc").first("id", "paid_at");
      return inv ? { kind: "invoice_paid", record_type: "invoice", record_id: inv.id, matched_at: inv.paid_at, strength: "association", basis: `customer_invoice_paid_within_${ASSOCIATION_WINDOW_DAYS}_days` } : null;
    }
    default:
      return null;
  }
}

// Direct proof marks an open AI row fulfilled. Association proof is stored
// as a hint (status stays open, nothing is invented). Human-touched rows are
// left to the human either way.
async function refreshFulfillment(conn, callLogId, call = null) {
  const row = call || await conn("call_log").where({ id: callLogId }).first("id", "twilio_call_sid", "customer_id", "from_phone", "to_phone", "direction", "created_at", "metadata");
  if (!row) return { checked: 0, fulfilled: 0, hinted: 0 };
  const open = await conn("call_commitments").where({ call_log_id: callLogId, status: "open" }).whereNull("human_state");
  let fulfilled = 0;
  let hinted = 0;
  for (const c of open) {
    const proof = await resolveFulfillment(conn, c, row).catch((err) => {
      logger.warn(`[call-commitments] fulfillment lookup failed for ${c.id}: ${err.message}`);
      return null;
    });
    if (!proof) continue;
    if (proof.strength === "direct") {
      fulfilled += await conn("call_commitments")
        .where({ id: c.id, status: "open" })
        .whereNull("human_state")
        .update({ status: "fulfilled", fulfillment: JSON.stringify(proof), fulfilled_at: proof.matched_at || new Date(), updated_at: new Date() });
    } else {
      // A hint is written once and refreshed only while it is still a hint.
      hinted += await conn("call_commitments")
        .where({ id: c.id, status: "open" })
        .whereNull("human_state")
        .whereRaw("(fulfillment IS NULL OR fulfillment ->> 'strength' = 'association')")
        .update({ fulfillment: JSON.stringify(proof), updated_at: new Date() });
    }
  }
  return { checked: open.length, fulfilled, hinted };
}

// ── Human corrections ──────────────────────────────────────────────────────
const HUMAN_ACTIONS = new Set(['confirm', 'dismiss', 'fulfill', 'reopen', 'edit']);

async function applyHumanUpdate(conn, id, { action, description, due_at, note, reviewedBy } = {}) {
  if (!HUMAN_ACTIONS.has(action)) throw Object.assign(new Error(`Unknown commitment action: ${action}`), { status: 400 });
  const patch = { reviewed_by: reviewedBy || null, reviewed_at: new Date(), updated_at: new Date() };
  if (note !== undefined) patch.human_note = note ? String(note).slice(0, 2000) : null;
  switch (action) {
    case 'confirm':
      patch.human_state = 'confirmed';
      break;
    case 'dismiss':
      patch.human_state = 'dismissed';
      patch.status = 'dismissed';
      break;
    case 'fulfill':
      patch.human_state = 'confirmed';
      patch.status = 'fulfilled';
      patch.fulfilled_at = new Date();
      patch.fulfillment = JSON.stringify({ kind: 'manual', basis: 'marked_done_by_office', matched_at: new Date().toISOString(), note: note || null });
      break;
    case 'reopen':
      patch.human_state = 'confirmed';
      patch.status = 'open';
      patch.fulfilled_at = null;
      patch.fulfillment = null;
      break;
    case 'edit':
      patch.human_state = 'edited';
      if (description !== undefined) {
        const text = String(description || '').trim();
        if (!text) throw Object.assign(new Error('description is required'), { status: 400 });
        patch.description = text.slice(0, 2000);
      }
      if (due_at !== undefined) {
        const parsed = parseDueAt(due_at);
        if (Number.isNaN(parsed)) throw Object.assign(new Error('due_at is not a valid date'), { status: 400 });
        patch.due_at = parsed;
        patch.due_basis = parsed ? 'stated' : null;
      }
      break;
    default:
      break;
  }
  const updated = await conn('call_commitments').where({ id }).update(patch);
  if (!updated) throw Object.assign(new Error('Commitment not found'), { status: 404 });
  return normalizeRow(await conn('call_commitments').where({ id }).first());
}

async function addHumanCommitment(conn, callLogId, { party, kind, description, due_at = null, channel = null, reviewedBy = null } = {}) {
  const p = party === 'customer' ? 'customer' : 'waves';
  const k = COMMITMENT_KINDS.includes(kind) ? kind : 'other';
  const text = String(description || '').trim();
  if (!text) throw Object.assign(new Error('description is required'), { status: 400 });
  const due = parseDueAt(due_at);
  if (Number.isNaN(due)) throw Object.assign(new Error('due_at is not a valid date'), { status: 400 });
  const key = `${commitmentKey({ party: p, kind: k, description: text })}:h${crypto.createHash('sha1').update(text).digest('hex').slice(0, 6)}`.slice(0, 160);
  const [row] = await conn('call_commitments').insert({
    call_log_id: callLogId,
    commitment_key: key,
    party: p,
    kind: k,
    description: text.slice(0, 2000),
    channel: CHANNELS.includes(channel) ? channel : 'unknown',
    due_at: due,
    due_basis: due ? 'stated' : null,
    confidence: null,
    evidence: JSON.stringify([]),
    source: 'human',
    human_state: 'confirmed',
    reviewed_by: reviewedBy,
    reviewed_at: new Date(),
    status: 'open',
  }).returning('*');
  return normalizeRow(row);
}

// ── Later outcomes (revenue / operational linkage) ────────────────────────
// Association, not causation: every entry says how it was matched.
async function buildCallOutcomes(conn, call) {
  const after = call?.created_at ? new Date(call.created_at) : null;
  const out = { lead: null, estimates: [], appointments: [], invoices: [], revenue_cents: 0, basis_note: 'Records linked by this call\'s SID/id are direct; records matched by customer after the call are associations.' };
  if (!after) return out;
  let leadId = null;
  try {
    const meta = typeof call.metadata === 'string' ? JSON.parse(call.metadata) : (call.metadata || {});
    leadId = meta?.lead_id || null;
  } catch { leadId = null; }
  const lead = await conn('leads')
    .where(function scope() {
      if (leadId) this.orWhere('id', leadId);
      if (call.twilio_call_sid) this.orWhere('twilio_call_sid', call.twilio_call_sid);
    })
    .whereNull('deleted_at')
    .orderBy('created_at', 'asc')
    .first('id', 'status', 'lost_reason', 'customer_id', 'estimate_id', 'converted_at', 'created_at')
    .catch(() => null);
  if (lead) {
    out.lead = { id: lead.id, status: lead.status, lost_reason: lead.lost_reason, converted_at: lead.converted_at, basis: leadId && lead.id === leadId ? 'stamped_on_call' : 'lead_carries_call_sid' };
  }
  const customerId = call.customer_id || lead?.customer_id || null;
  if (customerId || lead?.estimate_id) {
    const estimates = await conn('estimates')
      // After the call only — a reused lead can carry an estimate from an
      // earlier call, which is not this call's outcome.
      .where('created_at', '>', after)
      .where(function scope() {
        if (customerId) this.orWhere('customer_id', customerId);
        if (lead?.estimate_id) this.orWhere('id', lead.estimate_id);
      })
      .orderBy('created_at', 'asc')
      .limit(5)
      .select('id', 'status', 'sent_at', 'accepted_at', 'created_at', 'customer_id')
      .catch(() => []);
    out.estimates = estimates.map((e) => ({ id: e.id, status: e.status, sent_at: e.sent_at, accepted_at: e.accepted_at, created_at: e.created_at, basis: lead?.estimate_id === e.id ? 'lead_estimate' : 'customer_estimate_after_call' }));
  }
  const appointments = await conn('scheduled_services')
    .where(function scope() {
      this.where('source_call_log_id', call.id);
      if (customerId) this.orWhere(function c() { this.where('customer_id', customerId).where('created_at', '>', after); });
    })
    .orderBy('created_at', 'asc')
    .limit(5)
    .select('id', 'status', 'scheduled_date', 'completed_at', 'created_at', 'source_call_log_id', 'service_type')
    .catch(() => []);
  out.appointments = appointments.map((a) => ({ id: a.id, status: a.status, scheduled_date: a.scheduled_date, completed_at: a.completed_at, service_type: a.service_type, basis: a.source_call_log_id === call.id ? 'booked_from_this_call' : 'customer_visit_after_call' }));
  if (customerId) {
    const invoices = await conn('invoices')
      .where('customer_id', customerId)
      .where('created_at', '>', after)
      .orderBy('created_at', 'asc')
      .limit(5)
      .select('id', 'status', 'total', 'paid_at', 'created_at')
      .catch(() => []);
    out.invoices = invoices.map((i) => ({ id: i.id, status: i.status, total: i.total == null ? null : Number(i.total), paid_at: i.paid_at, basis: 'customer_invoice_after_call' }));
    out.revenue_cents = Math.round(invoices.filter((i) => i.paid_at).reduce((sum, i) => sum + Number(i.total || 0), 0) * 100);
  }
  return out;
}

module.exports = {
  COMMITMENT_KINDS,
  REPEATABLE_KINDS,
  WAVES_KINDS,
  CUSTOMER_KINDS,
  CHANNELS,
  EXTRACTOR_VERSION,
  ASSOCIATION_WINDOW_DAYS,
  MODEL_TIMEOUT_MS,
  MIN_MODEL_CONFIDENCE,
  MODEL_OUTPUT_SCHEMA,
  commitmentKey,
  parseDueAt,
  anchorEvidence,
  deriveCommitmentsFromExtraction,
  buildCommitmentsPrompt,
  groundModelCommitments,
  extractCommitmentsWithModel,
  upsertCommitments,
  recordCallCommitments,
  listForCall,
  normalizeRow,
  resolveFulfillment,
  refreshFulfillment,
  applyHumanUpdate,
  addHumanCommitment,
  buildCallOutcomes,
};
