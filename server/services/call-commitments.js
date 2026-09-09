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
 * SMS actions share this ledger through sms_log_id and sms_context. The
 * call readers below require a linked call record: SMS work surfaces in its
 * customer profile Comms tab and conversation-linked admin bells.
 */

const crypto = require('crypto');
const logger = require('./logger');
const MODELS = require('../config/models');
const { parseETDateTime, etDateString, addETDays } = require('../utils/datetime-et');

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

// A kind belongs to one party (plus 'other' for both). A caller promise
// must never be recorded as a Waves promise, or the reverse — by a
// malformed request or by model output.
function kindBelongsToParty(party, kind) {
  if (kind === 'other') return party === 'waves' || party === 'customer';
  if (party === 'waves') return WAVES_KINDS.includes(kind);
  if (party === 'customer') return CUSTOMER_KINDS.includes(kind);
  return false;
}
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
  // A repeatable promise is identified by the VERBATIM words that carry it
  // — the first evidence quote, normalized — not by the model's wording of
  // the description, which a reprocess paraphrases ("send the inspection
  // report" → "email the inspection findings") and would mint a second
  // row (Codex #3738 r15 P2). The description slug is the fallback for a
  // row with no quote.
  const anchor = normalizeForMatch(item.evidence?.[0]?.quote);
  const s = anchor
    ? `q${crypto.createHash('sha1').update(anchor).digest('hex').slice(0, 12)}`
    : (slug(item.description) || crypto.createHash('sha1').update(String(item.description || '')).digest('hex').slice(0, 10));
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
// Every timestamp that reaches a commitment — a V2 scheduling field or a
// model-written due_at — goes through the Eastern parser: a naive
// "2026-09-02T09:00:00" is an ET wall clock, never Railway's UTC.
function isoOrNull(value) {
  const d = parseDueAt(value);
  return d instanceof Date ? d.toISOString() : null;
}

// The persisted V2 schema types scheduling.callback_window_start as a TIME
// ("14:00" — the caller said "call me back at two"), not a datetime. A
// bare time is pinned to the ET date of the call, or to the next ET day
// when that instant was already past when the call started ("call me at
// nine" said at three in the afternoon). Without the call's start there is
// no date to pin to, and the promise keeps the implicit deadline. A full
// datetime is taken as is.
const TIME_ONLY_RE = /^(\d{1,2}):(\d{2})(?::\d{2})?$/;
function callbackDueAt(value, callStartedAt) {
  if (value == null || value === '') return null;
  const text = String(value).trim();
  const time = TIME_ONLY_RE.exec(text);
  if (!time) return isoOrNull(text);
  const start = callStartedAt ? new Date(callStartedAt) : null;
  if (!start || Number.isNaN(start.getTime())) return null;
  const hhmm = `${time[1].padStart(2, '0')}:${time[2]}`;
  let due = parseETDateTime(`${etDateString(start)}T${hhmm}`);
  if (Number.isNaN(due.getTime())) return null;
  if (due.getTime() < start.getTime()) due = parseETDateTime(`${etDateString(addETDays(start, 1))}T${hhmm}`);
  return due.toISOString();
}

// A V2 quote is admitted only when the transcript literally carries it in
// the turn of the speaker V2 claims for it (flat match when the transcript
// has no speaker labels); a schema-valid payload can still hallucinate a
// quote or hand a caller line to an agent-owned field, and a seed on such
// evidence would be an obligation nobody can check against the words
// (Codex #3738 r15 P1). `owner` names the speaker whose words must be
// among the grounded ones for the field to mean a promise at all.
function groundSeedEvidence(evidence, transcript, { owner = null } = {}) {
  const turns = speakerTurns(transcript);
  const flat = normalizeForMatch(transcript);
  const grounded = [];
  for (const e of Array.isArray(evidence) ? evidence : []) {
    const q = normalizeForMatch(e?.quote);
    if (q.length < 3) continue;
    const speaker = e.speaker === 'agent' || e.speaker === 'caller' ? e.speaker : null;
    const ok = turns ? Boolean(speaker) && turns[speaker].some((turn) => turn.includes(q)) : flat.includes(q);
    if (ok) grounded.push(e);
  }
  if (owner && !grounded.some((e) => e.speaker === owner)) return [];
  return grounded;
}

// Seeds come from the V2 extraction ONLY, and only where V2 pinned a
// transcript quote for the field that the transcript itself confirms:
// downstream composers never read V1 (AGENTS.md), and a commitment with no
// checkable evidence would be an obligation nobody can hold anyone to. A
// flag without a grounded quote is left to the model pass, which grounds
// every item verbatim the same way.
function deriveCommitmentsFromExtraction({ v2 = null, transcript = '', callStartedAt = null } = {}) {
  const items = [];
  const sr = v2?.service_request || {};
  const sched = v2?.scheduling || {};
  const conf = v2?.confidence || {};
  const withEvidence = (item, owner = null) => {
    const evidence = groundSeedEvidence(item.evidence, transcript, { owner });
    if (evidence.length) items.push({ ...item, evidence });
  };

  // The PROMISE needs its own pinned quote: a price spoken on the call is
  // not a promised quote (the extraction contract says so), so evidence on
  // quoted_price_usd alone cannot seed an obligation Waves owes — that case
  // is left to the grounded model pass (Codex #3738 r7 P1). The price quote
  // rides along as supporting evidence once the promise is pinned.
  if (sr.quote_promised === true && evidenceFor(v2, ['/service_request/quote_promised']).length) {
    withEvidence({
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
    }, 'agent');
  }

  // A confirmed slot is NOT seeded as a "send the confirmation" promise: the
  // status proves the booking, not that anyone promised a later text, and
  // the pipeline sends its own confirmation when it books. An explicit
  // "we will text you the details" is left to the model pass, which needs
  // verbatim evidence to record it.

  // A window the caller named is a callback promise only once the AGENT
  // accepted it: the seed needs a grounded agent quote among its evidence
  // (owner 'agent', like every other Waves seed) — a caller's request
  // alone is not an obligation Waves took on (Codex #3738 r17 P1); an
  // agent line V2 did not pin is left to the model pass, which grounds it
  // the same way. The promise is recorded even when it cannot be pinned
  // to an instant (no call start to date a bare time) — it then carries
  // the implicit deadline instead of a stated one.
  const callbackAsked = sched.callback_window_start != null && String(sched.callback_window_start).trim() !== '';
  const callbackWindow = callbackDueAt(sched.callback_window_start, callStartedAt);
  if (callbackAsked || v2?.recommended_disposition === 'callback_task_created') {
    withEvidence({
      party: 'waves',
      kind: 'callback',
      description: callbackAsked ? `Call the customer back (asked for ${sched.callback_window_start})` : 'Call the customer back',
      channel: 'call',
      due_at: callbackWindow,
      // A bare time was STATED; the date it was pinned to (the call's ET
      // day, or the next) is derived — "tomorrow at nine" said at eight in
      // the morning carries no date in the persisted schema — so the basis
      // is 'suggested', the schema's word for a derived deadline (Codex
      // #3738 r15 P2). A full datetime is a stated deadline.
      due_basis: callbackWindow ? (TIME_ONLY_RE.test(String(sched.callback_window_start).trim()) ? 'suggested' : 'stated') : null,
      confidence: typeof conf.scheduling_window === 'number' ? conf.scheduling_window : null,
      evidence: evidenceFor(v2, ['/scheduling/callback_window_start', '/scheduling/callback_window_end']),
      origin: callbackAsked ? 'v2:scheduling.callback_window_start' : 'v2:recommended_disposition',
    }, 'agent');
  }

  if (sched.follow_up_mentioned === true) {
    const followUpAt = isoOrNull(sched.follow_up_start_at);
    withEvidence({
      party: 'waves',
      kind: 'technician_follow_up',
      description: followUpAt ? `Follow-up visit or contact around ${sched.follow_up_start_at}` : 'Follow-up visit or contact was discussed',
      channel: 'unknown',
      due_at: followUpAt,
      due_basis: followUpAt ? 'stated' : null,
      confidence: typeof conf.scheduling_window === 'number' ? conf.scheduling_window : null,
      evidence: evidenceFor(v2, ['/scheduling/follow_up_start_at', '/scheduling/follow_up_mentioned']),
      origin: 'v2:scheduling.follow_up_mentioned',
    }, 'agent');
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

// The transcript's labelled turns, normalized, by speaker. Null when the
// transcript carries no Agent:/Caller: labels at all (a flat fallback
// transcript), in which case only flat grounding is possible.
const PARTY_SPEAKER = { waves: 'agent', customer: 'caller' };
function speakerTurns(transcript) {
  const turns = { agent: [], caller: [] };
  let labelled = false;
  for (const line of String(transcript || '').split('\n')) {
    const m = line.match(/^\s*(agent|caller|customer)\s*:\s*(.*)$/i);
    if (!m) continue;
    labelled = true;
    turns[m[1].toLowerCase() === 'agent' ? 'agent' : 'caller'].push(normalizeForMatch(m[2]));
  }
  return labelled ? turns : null;
}

// Drop anything the transcript does not literally support. A quote proves
// a PARTY's commitment only when it sits in a turn of that party's speaker
// (waves → Agent, customer → Caller): matched anywhere in the flat text, a
// caller's own promise could be filed as an open Waves obligation on a
// swapped label or a model speaker error. Returns the surviving items plus
// counts for the processing log.
// What a grounded quote must SAY, per kind: a verbatim "yes" from the right
// speaker proves the speaker said yes, not that they promised anything
// (Codex #3738 r11 P1). The quote has to carry the action — one of the
// kind's action words, or a content word of the model's own description —
// and be more than a bare affirmation.
const KIND_ACTION_WORDS = Object.freeze({
  send_estimate: ['estimate', 'quote', 'pricing', 'price', 'proposal'],
  send_appointment_confirmation: ['confirm', 'confirmation', 'text', 'email', 'details'],
  callback: ['call', 'ring', 'phone', 'reach'],
  send_report: ['report', 'summary', 'send'],
  send_paperwork: ['paperwork', 'form', 'agreement', 'contract', 'document', 'send'],
  schedule_visit: ['schedule', 'appointment', 'visit', 'come', 'book', 'out'],
  technician_follow_up: ['follow', 'back', 'recheck', 'return', 'visit'],
  send_photos: ['photo', 'photos', 'picture', 'pictures', 'pic', 'pics', 'send', 'text'],
  confirm_date: ['confirm', 'date', 'day', 'time', 'let'],
  call_back: ['call', 'ring', 'phone', 'reach'],
  provide_info: ['send', 'give', 'get', 'address', 'email', 'number', 'info'],
  make_payment: ['pay', 'payment', 'card', 'invoice', 'check', 'money'],
});
const ACTION_STOPWORDS = new Set(['the', 'and', 'that', 'this', 'with', 'will', 'would', 'have', 'them', 'they', 'your', 'you', 'our', 'for', 'from', 'customer', 'caller', 'waves', 'later', 'today', 'tomorrow']);
function quoteExpressesAction(normalizedQuote, item) {
  const words = normalizedQuote.split(' ').filter(Boolean);
  if (words.length < 3) return false;
  const wanted = new Set([
    ...(KIND_ACTION_WORDS[item.kind] || []),
    ...normalizeForMatch(item.description).split(' ').filter((w) => w.length >= 4 && !ACTION_STOPWORDS.has(w)),
  ]);
  return words.some((w) => wanted.has(w) || [...wanted].some((k) => k.length >= 4 && w.startsWith(k)));
}

function groundModelCommitments(items, transcript) {
  const flat = normalizeForMatch(transcript);
  const turns = speakerTurns(transcript);
  const kept = [];
  let droppedUngrounded = 0;
  let droppedLowConfidence = 0;
  let droppedMismatched = 0;
  let malformedDueAt = 0;
  for (const item of Array.isArray(items) ? items : []) {
    // The schema already restricts party and kind individually; the pairing
    // is a cross-field rule the schema cannot express.
    if (!kindBelongsToParty(item.party, item.kind)) { droppedMismatched += 1; continue; }
    const speaker = PARTY_SPEAKER[item.party] || null;
    const grounded = (item.evidence || []).filter((e) => {
      const q = normalizeForMatch(e?.quote);
      if (q.length < 3) return false;
      if (!quoteExpressesAction(q, item)) return false;
      if (!turns || !speaker) return flat.includes(q);
      return turns[speaker].some((turn) => turn.includes(q));
    });
    if (!grounded.length) { droppedUngrounded += 1; continue; }
    if (typeof item.confidence !== 'number' || item.confidence < MIN_MODEL_CONFIDENCE) { droppedLowConfidence += 1; continue; }
    const malformedDue = Number.isNaN(parseDueAt(item.due_at));
    if (malformedDue) malformedDueAt += 1;
    kept.push({
      party: item.party,
      kind: COMMITMENT_KINDS.includes(item.kind) ? item.kind : 'other',
      description: String(item.description).trim(),
      channel: CHANNELS.includes(item.channel) ? item.channel : 'unknown',
      // The schema cannot type-check due_at as a timestamp: a nonempty
      // value the Eastern parser rejects is NOT a stated deadline. The
      // promise is kept, the deadline is dropped in the open (counted, and
      // the raw wording rides in due_text so the row still says WHEN)
      // rather than persisted as "stated" with no instant (Codex r12 P2).
      due_at: malformedDue ? null : isoOrNull(item.due_at),
      due_basis: !malformedDue && item.due_at ? 'stated' : null,
      due_text: item.due_text || (malformedDue ? String(item.due_at).slice(0, 80) : null),
      confidence: item.confidence,
      // With labelled turns the speaker is the one whose turn carried the
      // words, not the model's claim.
      evidence: grounded.map((e) => ({ quote: String(e.quote).trim(), speaker: turns && speaker ? speaker : e.speaker })),
      origin: 'model',
    });
  }
  return { kept, droppedUngrounded, droppedLowConfidence, droppedMismatched, malformedDueAt };
}

async function extractCommitmentsWithModel(transcript, { callStartedAt = null, client = null } = {}) {
  if (!transcript || String(transcript).length < 40) return { items: [], skipped: 'transcript_too_short' };
  const anthropic = client || ((Anthropic && process.env.ANTHROPIC_API_KEY) ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null);
  if (!anthropic) return { items: [], skipped: 'no_provider' };
  const startedAt = Date.now();
  // No sampling controls on the request (current Anthropic models 400 on
  // them). maxRetries 0 because the pipeline has its own retry lanes — a
  // claim-holding pass must not sit through the SDK's per-attempt timeouts.
  const response = await anthropic.messages.create({
    model: MODELS.FLAGSHIP,
    max_tokens: 2000,
    messages: [{ role: 'user', content: buildCommitmentsPrompt({ transcript, callStartedAt }) }],
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
  return { items: grounded.kept, droppedUngrounded: grounded.droppedUngrounded, droppedLowConfidence: grounded.droppedLowConfidence, droppedMismatched: grounded.droppedMismatched, malformedDueAt: grounded.malformedDueAt, model: MODELS.FLAGSHIP, ms: Date.now() - startedAt };
}

// ── Persistence ────────────────────────────────────────────────────────────
function toRow(callLogId, item, { generation, extractorVersion, recordingSid = null }) {
  return {
    call_log_id: callLogId,
    commitment_key: commitmentKey(item),
    party: item.party === 'customer' ? 'customer' : 'waves',
    kind: COMMITMENT_KINDS.includes(item.kind) ? item.kind : 'other',
    // The model's relative timing ("later today", "after the inspection")
    // has no column and no instant; it rides in the description so the row
    // still says WHEN once persisted (Codex r9 P2). A stated instant makes
    // it redundant.
    description: String(item.due_text && !item.due_at ? `${item.description || ''} (${item.due_text})` : (item.description || '')).slice(0, 2000),
    channel: CHANNELS.includes(item.channel) ? item.channel : 'unknown',
    due_at: item.due_at ? new Date(item.due_at) : null,
    due_basis: item.due_basis || null,
    confidence: typeof item.confidence === 'number' ? Math.max(0, Math.min(1, item.confidence)) : null,
    evidence: JSON.stringify(item.evidence || []),
    source: 'ai',
    processing_generation: generation ?? null,
    last_seen_generation: generation ?? null,
    extractor_version: extractorVersion || EXTRACTOR_VERSION,
    recording_sid: recordingSid || null,
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
async function upsertCommitments(conn, callLogId, items, { generation = null, extractorVersion = EXTRACTOR_VERSION, procToken = null, procGeneration = null, recordingSid = null } = {}) {
  const dedupedByKey = new Map();
  for (const item of items) {
    const key = commitmentKey(item);
    // First detection wins for the same key; the seeds run before the model.
    if (!dedupedByKey.has(key)) dedupedByKey.set(key, item);
  }
  const rows = [...dedupedByKey.values()].map((item) => toRow(callLogId, item, { generation, extractorVersion, recordingSid }));

  return conn.transaction(async (trx) => {
    // The fence also names the AUDIO this pass heard: an adopted or
    // replaced recording swaps recording_sid without moving the generation,
    // and a pass still enriching the superseded audio must not persist its
    // promises against the new one (Codex r16 P2).
    const sameRecording = recordingSid ? { recording_sid: recordingSid } : {};
    if (procToken) {
      const owned = await trx('call_log').where({ id: callLogId, processing_token: procToken, ...sameRecording }).forShare().first('id');
      if (!owned) return { written: 0, ownershipLost: true };
    } else if (procGeneration != null) {
      const current = await trx('call_log')
        .where({ id: callLogId, processing_generation: procGeneration, ...sameRecording })
        .whereNull('processing_token')
        .forShare()
        .first('id');
      if (!current) return { written: 0, ownershipLost: true };
    }
    // A replaced or adopted recording is different audio: the fulfillment
    // an earlier pass proved against the OLD audio's promise is not proof
    // for whatever this audio says under the same key. Untouched AI rows
    // written from another SID go back to open before their keys are
    // reused (Codex r12 P2); the ones this pass no longer detects still
    // read "not seen on the latest pass" via last_seen_generation. Rows
    // with no SID on record (no recording when written) are left alone.
    if (recordingSid) {
      await trx.raw(
        `UPDATE call_commitments
            SET status = 'open', fulfillment = NULL, fulfilled_at = NULL, updated_at = NOW()
          WHERE call_log_id = ? AND source = 'ai' AND human_state IS NULL
            AND recording_sid IS NOT NULL AND recording_sid <> ?`,
        [callLogId, recordingSid],
      );
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
            evidence, source, processing_generation, last_seen_generation, extractor_version, recording_sid, status, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (call_log_id, commitment_key) DO UPDATE SET
           description = CASE WHEN call_commitments.human_state IS NULL AND call_commitments.source = 'ai' THEN EXCLUDED.description ELSE call_commitments.description END,
           channel = CASE WHEN call_commitments.human_state IS NULL AND call_commitments.source = 'ai' THEN EXCLUDED.channel ELSE call_commitments.channel END,
           due_at = CASE WHEN call_commitments.human_state IS NULL AND call_commitments.source = 'ai' THEN EXCLUDED.due_at ELSE call_commitments.due_at END,
           due_basis = CASE WHEN call_commitments.human_state IS NULL AND call_commitments.source = 'ai' THEN EXCLUDED.due_basis ELSE call_commitments.due_basis END,
           confidence = CASE WHEN call_commitments.human_state IS NULL AND call_commitments.source = 'ai' THEN EXCLUDED.confidence ELSE call_commitments.confidence END,
           evidence = CASE WHEN call_commitments.human_state IS NULL AND call_commitments.source = 'ai' THEN EXCLUDED.evidence ELSE call_commitments.evidence END,
           processing_generation = CASE WHEN call_commitments.human_state IS NULL AND call_commitments.source = 'ai' THEN EXCLUDED.processing_generation ELSE call_commitments.processing_generation END,
           extractor_version = CASE WHEN call_commitments.human_state IS NULL AND call_commitments.source = 'ai' THEN EXCLUDED.extractor_version ELSE call_commitments.extractor_version END,
           recording_sid = CASE WHEN call_commitments.human_state IS NULL AND call_commitments.source = 'ai' THEN EXCLUDED.recording_sid ELSE call_commitments.recording_sid END,
           last_seen_generation = EXCLUDED.last_seen_generation,
           updated_at = CASE WHEN call_commitments.human_state IS NULL AND call_commitments.source = 'ai' THEN EXCLUDED.updated_at ELSE call_commitments.updated_at END
         RETURNING id, (xmax = 0) AS inserted`,
        [
          row.call_log_id, row.commitment_key, row.party, row.kind, row.description, row.channel, row.due_at, row.due_basis, row.confidence,
          row.evidence, row.source, row.processing_generation, row.last_seen_generation, row.extractor_version, row.recording_sid, row.status, row.updated_at,
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
  procToken = null,
  procGeneration = null,
  modelClient = null,
  runModel = true,
} = {}) {
  const summary = { seeds: 0, model: 0, written: 0, dropped: 0, ownershipLost: false, skipped: null };
  try {
    const segments = parseSegments(call?.transcript_structured);
    const seeds = deriveCommitmentsFromExtraction({ v2, transcript, callStartedAt: call?.created_at });
    summary.seeds = seeds.length;
    let modelItems = [];
    if (runModel) {
      // The model leg is OPTIONAL enrichment: a provider rejection or
      // timeout must not discard the evidence-backed seeds derived above
      // (Codex r8 P1) — they need no model output. Reported, not thrown.
      let model;
      try {
        model = await extractCommitmentsWithModel(transcript, { callStartedAt: call?.created_at, client: modelClient });
      } catch (modelErr) {
        logger.warn(`[call-commitments] model pass failed for call ${call?.id}; keeping ${seeds.length} deterministic seed(s): ${modelErr.message}`);
        model = { items: [], skipped: 'model_failed', error: modelErr.message };
      }
      summary.skipped = model.skipped || null;
      if (model.error) summary.modelError = model.error;
      summary.dropped = (model.droppedUngrounded || 0) + (model.droppedLowConfidence || 0) + (model.droppedMismatched || 0);
      summary.modelMs = model.ms || null;
      if (model.malformedDueAt) summary.malformedDueAt = model.malformedDueAt;
      modelItems = model.items || [];
      summary.model = modelItems.length;
    }
    const items = [...seeds, ...modelItems].map((item) => ({
      ...item,
      evidence: anchorEvidence(item.evidence, { segments, transcript }),
    }));
    const result = await upsertCommitments(conn, call.id, items, { generation: procGeneration, procToken, procGeneration, recordingSid: call?.recording_sid || null });
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

// The lead this call minted (metadata.lead_id) or, for a relay call that
// REUSED an existing prospect, the lead it was stamped with (relay_lead_id
// — the lead keeps its original twilio_call_sid, so the SID hop would find
// the earlier call instead).
function leadIdsOf(call) {
  try {
    const meta = typeof call?.metadata === "string" ? JSON.parse(call.metadata) : (call?.metadata || {});
    return [...new Set([meta?.lead_id, meta?.relay_lead_id].filter(Boolean).map(String))];
  } catch { return []; }
}

// The END of the call — the boundary the promised-estimate watcher already
// uses (its `sent_at > CASE …` clause): a record stamped while the caller
// was still on the line (an estimate sent mid-call) cannot have kept a
// promise made later in the same call. Normal inbound rows are inserted at
// ring time, so their end is created_at + duration; bridged rows end at
// bridge + duration; other rows (recovered outbound, inserted near the end
// by status callbacks) end at created_at.
function callEndedAt(call) {
  const created = call?.created_at ? new Date(call.created_at) : null;
  if (!created || Number.isNaN(created.getTime())) return null;
  const durationMs = Math.max(0, Number(call?.duration_seconds) || 0) * 1000;
  if (call?.bridged_at) {
    const bridged = new Date(call.bridged_at);
    if (!Number.isNaN(bridged.getTime())) return new Date(bridged.getTime() + durationMs);
  }
  if (String(call?.direction || "") === "inbound") return new Date(created.getTime() + durationMs);
  return created;
}

// Where each kind looks for its proof. Every match happened AFTER THE CALL
// ENDED (`after`); the strength says whether the record is linked to this
// call or merely to the same customer/phone inside the window. An
// estimate's creation time is deliberately NOT a condition (r14): "I'll
// resend that estimate" to an existing customer is kept by a send of an
// estimate created long before the call — the promised-estimate watcher
// this lane stands in for accepts exactly that send.

// The ONE handoff witness every send_estimate proof applies — the single-
// call path, the batch path, direct and association alike. sent_at alone
// is not delivery (#3725 r13 P1 class): sendEstimateNow advances it on a
// suppression-only attempt (SMS gate or template off — sent:true,
// real:false) and report/plan-restart mints stamp it at publish, so the
// witness is deliveryState.lastDeliveredAt — advanced only on a real
// handoff — after the boundary, OR acceptance after the boundary (a
// manual accept stamps sent_at with no delivery record, and an accepted
// estimate was certainly handed off). A group-send sibling never carries
// its own deliveryState (only the anchor does) — and a sibling that was
// sent on its own BEFORE joining the group keeps its stale stamp — so BOTH
// the sibling's own handoff and its anchor's are witnesses, each tested
// against the window on its own (the later one may fall past `until`
// while the earlier one qualifies).
// A handoff stamp is JSON text the one writer (admin-estimates' delivery
// state) sets to an ISO instant. Only text Postgres itself accepts as a
// timestamptz is cast (pg_input_is_valid — a non-throwing check, PG16+;
// prod is 18): a hand-edited or legacy value — free text OR an ISO-shaped
// impossible date — reads NULL instead of aborting the whole witness query
// and hiding every other estimate's proof in the batch (pre-push hook P1
// on bafc4c4ae, codex r20 P2).
const isoInstantSql = (text) => `(CASE WHEN pg_input_is_valid(${text}, 'timestamptz') THEN (${text})::timestamptz END)`;
const OWN_HANDOFF_SQL = isoInstantSql("estimates.estimate_data #>> '{deliveryState,lastDeliveredAt}'");
// The FIRST real handoff is retained across resends (admin-estimates
// carries deliveryState.firstDeliveredAt forward while lastDeliveredAt
// advances): a delivery inside the window followed by a resend after it
// must keep counting as the kept promise, or refreshFulfillment would
// clear an association hint the facts still support (codex r29 P2).
const FIRST_HANDOFF_SQL = isoInstantSql("estimates.estimate_data #>> '{deliveryState,firstDeliveredAt}'");
// The durable send history (deliveryState.deliveredAt, every real handoff
// oldest first — admin-estimates) carries the INTERMEDIATE handoffs first
// and last cannot: delivered before the call, resent inside the window,
// resent again after it (codex r30 P2). Read as a set of instants; a
// malformed element is skipped, never fatal (same rule as isoInstantSql).
const DELIVERIES_SQL = "(CASE WHEN jsonb_typeof(estimates.estimate_data #> '{deliveryState,deliveredAt}') = 'array' THEN estimates.estimate_data #> '{deliveryState,deliveredAt}' ELSE '[]'::jsonb END)";
// Each element is cast ONLY under its own validity CASE (the scalar
// witnesses' rule): a WHERE-term guard does not order evaluation in
// PostgreSQL, so a bare cast beside it could still abort the batch on one
// corrupt element (codex r31 P2).
const historyInstants = (where) => `(SELECT MIN(h.t) FROM (SELECT ${isoInstantSql('d')} AS t FROM jsonb_array_elements_text(${DELIVERIES_SQL}) AS d) AS h WHERE h.t IS NOT NULL${where})`;
// Acceptance is a witness only when the CUSTOMER accepted: a manual accept
// (mark-accepted — an admin recording a verbal yes) stamps accepted_at and
// locks the price as 'manual_accept' with no document delivered, so it
// proves nothing about the promised estimate going out (codex r18 P1).
const ACCEPT_WITNESS_SQL = `CASE WHEN estimates.price_locked_by IS DISTINCT FROM 'manual_accept' THEN estimates.accepted_at END`;
// A sibling inherits its anchor's handoff only while it is one the anchor's
// send carries: admin-estimates' live-sibling group reconciliation re-stamps
// groupPublishedByEstimateId and extends expiry for the siblings that are
// sent / viewed, unarchived and unlocked — an archived, expired, declined or
// price-locked sibling keeps its old pointer but was not in the public group
// the resend delivered, so the anchor's new lastDeliveredAt is no witness
// for it (codex r24 P1). Its own handoff and accept witnesses still stand.
// Read at sweep time: a sibling retired since the resend loses the
// inheritance — fail closed.
const ANCHOR_HANDOFF_SQL = `(SELECT ${isoInstantSql("a.estimate_data #>> '{deliveryState,lastDeliveredAt}'")} FROM estimates a
     WHERE a.id::text = estimates.estimate_data ->> 'groupPublishedByEstimateId'
       AND estimates.archived_at IS NULL AND estimates.status IN ('sent', 'viewed') AND estimates.price_locked_at IS NULL)`;

// Rows with a witness in (after, until]: the SQL form for a single query,
// the row form for a batch fetched with the witness columns below. The
// witness time — not sent_at — is when the promise was kept: an estimate
// sent BEFORE the call and accepted after it kept the promise at
// acceptance (pre-push hook P1 on 3b5b2cb27).
const handedOffWithin = (qb, after, until = null) => qb.where(function handoffWitness() {
  const within = (expr) => `(${expr} > ?${until ? ` AND ${expr} <= ?` : ''})`;
  const bind = until ? [after, until] : [after];
  this.whereRaw(within(OWN_HANDOFF_SQL), bind)
    .orWhereRaw(within(FIRST_HANDOFF_SQL), bind)
    .orWhereRaw(`${historyInstants(` AND h.t > ?${until ? ' AND h.t <= ?' : ''}`)} IS NOT NULL`, bind)
    .orWhereRaw(within(ANCHOR_HANDOFF_SQL), bind)
    .orWhereRaw(within(ACCEPT_WITNESS_SQL), bind);
});
// Ordering by the QUALIFYING witness, not the earliest one on the row: a
// row admitted for a post-call handoff may also carry a pre-call handoff
// or acceptance, and sorting by that stale stamp would put it ahead of an
// estimate actually handed off earlier after the call (codex r15 P2).
// LEAST ignores NULLs, and every row here passed handedOffWithin on the
// same window, so at least one CASE is non-null.
const handoffOrder = (conn, after, until = null) => {
  const inWindow = (expr) => `CASE WHEN ${expr} > ?${until ? ` AND ${expr} <= ?` : ''} THEN ${expr} END`;
  const bind = until ? [after, until] : [after];
  const history = historyInstants(` AND h.t > ?${until ? ' AND h.t <= ?' : ''}`);
  return conn.raw(`LEAST(${inWindow(OWN_HANDOFF_SQL)}, ${inWindow(FIRST_HANDOFF_SQL)}, ${history}, ${inWindow(ANCHOR_HANDOFF_SQL)}, ${inWindow(ACCEPT_WITNESS_SQL)}) asc`, [...bind, ...bind, ...bind, ...bind, ...bind]);
};
const HANDOFF_COLS = (conn) => ["id", "sent_at", "status", "accepted_at", conn.raw(`${OWN_HANDOFF_SQL} as handed_off_at`), conn.raw(`${FIRST_HANDOFF_SQL} as first_handed_off_at`), conn.raw(`${DELIVERIES_SQL} as delivered_at_history`), conn.raw(`${ANCHOR_HANDOFF_SQL} as anchor_handed_off_at`), conn.raw(`${ACCEPT_WITNESS_SQL} as accept_witness_at`)];
// The EARLIEST post-boundary witness time on a fetched row, or null.
const witnessAt = (row, after) => {
  const history = Array.isArray(row.delivered_at_history) ? row.delivered_at_history : [];
  const times = [row.handed_off_at, row.first_handed_off_at, ...history, row.anchor_handed_off_at, row.accept_witness_at]
    .map((t) => (t ? new Date(t) : null))
    .filter((d) => d && !Number.isNaN(d.getTime()) && d > after);
  return times.length ? new Date(Math.min(...times.map((d) => d.getTime()))) : null;
};

// The send_estimate DIRECT routes — the estimator's own callLogId stamp,
// and an estimate on a lead THIS call minted (carrying its SID) by the
// lead FK or the estimate_data.lead_id mirror — for MANY calls in three
// queries. resolveFulfillment's direct branch and the triage evidence
// sweep both consume this; there is no second implementation. Never
// association-strength matches.
//
// A lead "minted by this call" is one carrying the call's SID AND created
// at or after the call started: lead-attribution re-stamps a REUSED lead's
// twilio_call_sid with each newer call, so the SID alone is not filing-
// time provenance — a lead older than the call is a reused one, and its
// estimate is association-strength at most. A probe without callStartedAt
// mints nothing (fails closed).
const mintedByCall = (lead, probe) => {
  const started = probe.callStartedAt ? new Date(probe.callStartedAt) : null;
  const created = lead.created_at ? new Date(lead.created_at) : null;
  return Boolean(started && created && !Number.isNaN(started.getTime()) && !Number.isNaN(created.getTime()) && created >= started);
};

// An estimate's owner must agree with the call it is proof for: a relink
// (admin-call-recordings) moves the call and its call-created lead to the
// new customer but leaves the estimates behind, so a stamp alone would let
// customer A's estimate keep a promise made to customer B. An owned
// estimate must be owned by the call's customer; an unowned one (commercial
// proposals carry only customer_phone) must carry the caller's number when
// the call is linked, and contradicts nothing when the call is unlinked too.
const ownerAgrees = (row, probe) => {
  if (row.customer_id) return Boolean(probe.customerId) && String(row.customer_id) === String(probe.customerId);
  if (!probe.customerId) return true;
  const caller = phoneDigits(probe.phone);
  return Boolean(caller) && phoneDigits(row.customer_phone) === caller;
};

// probes: [{ key, callId, twilioCallSid, callStartedAt, customerId, phone,
// after, covers? }] — one per card, with its own boundary and the call's
// CURRENT customer / caller number. covers(row, siblings) — optional — is
// the probe's own scope test (the triage sweep binds a delivered estimate
// to the card's quote_scope); siblings are the other rows of the
// estimate's group, so a multi-property proposal is judged as a whole.
// Returns Map key → the EARLIEST qualifying direct proof.
async function directEstimatesSentAfter(conn, probes) {
  const out = new Map();
  if (!probes.length) return out;
  const probesByCall = new Map();
  for (const p of probes) {
    const list = probesByCall.get(String(p.callId)) || [];
    list.push(p);
    probesByCall.set(String(p.callId), list);
  }
  const minAfter = new Date(Math.min(...probes.map((p) => new Date(p.after).getTime())));
  // The columns a scope test reads: what the estimate prices (service
  // words + recurring / one-time totals) and where (address column or the
  // property row) — on the candidate AND on every group sibling.
  const SCOPE_COLS = ["service_interest", "estimate_data", "estimate_group_id", "monthly_total", "annual_total", "onetime_total", "address", "created_at"];
  const PROPERTY_COLS = [
    conn.raw("(SELECT cp.address_line1 FROM customer_properties cp WHERE cp.id = estimates.property_id) as property_address_line1"),
    conn.raw("(SELECT cp.address_line2 FROM customer_properties cp WHERE cp.id = estimates.property_id) as property_address_line2"),
    conn.raw("(SELECT cp.city FROM customer_properties cp WHERE cp.id = estimates.property_id) as property_city"),
    conn.raw("(SELECT cp.zip FROM customer_properties cp WHERE cp.id = estimates.property_id) as property_zip"),
  ];
  const cols = [
    ...HANDOFF_COLS(conn), "source", "customer_id", "customer_phone", ...SCOPE_COLS, ...PROPERTY_COLS,
    conn.raw("estimate_data #>> '{estimatorEngine,callLogId}' as stamped_call_id"),
    conn.raw("estimate_data ->> 'lead_id' as mirror_lead_id"),
  ];
  // Candidates are judged after BOTH routes ran: a scope test needs the
  // group siblings, fetched once for every candidate that has any.
  const candidates = [];
  const scoped = probes.some((p) => typeof p.covers === "function");
  const consider = (callId, row, basis) => candidates.push({ callId, row, basis });
  const judge = async () => {
    const groupIds = scoped ? [...new Set(candidates.map((c) => c.row.estimate_group_id).filter(Boolean))] : [];
    const siblingsByGroup = new Map();
    if (groupIds.length) {
      const rows = await conn("estimates").whereIn("estimate_group_id", groupIds).select(...HANDOFF_COLS(conn), ...SCOPE_COLS, ...PROPERTY_COLS);
      for (const r of rows) siblingsByGroup.set(String(r.estimate_group_id), [...(siblingsByGroup.get(String(r.estimate_group_id)) || []), r]);
    }
    for (const { callId, row, basis } of candidates) {
      const siblings = row.estimate_group_id ? (siblingsByGroup.get(String(row.estimate_group_id)) || []).filter((s) => String(s.id) !== String(row.id)) : [];
      for (const p of probesByCall.get(String(callId)) || []) {
        if (!ownerAgrees(row, p)) continue;
        if (typeof p.covers === "function") {
          // Only siblings that were IN a qualifying handoff count toward the
          // scope: one with no post-boundary witness of its own, or created
          // after the handoff it would inherit (a service added to the group
          // after the anchor went out), was never delivered (codex r18 P1).
          const after = new Date(p.after);
          const delivered = siblings.filter((s) => {
            const w = witnessAt(s, after);
            return Boolean(w) && Boolean(s.created_at) && new Date(s.created_at) <= w;
          });
          if (!p.covers(row, delivered)) continue;
        }
        const at = witnessAt(row, new Date(p.after));
        if (!at) continue;
        const cur = out.get(p.key);
        if (!cur || at < new Date(cur.matched_at)) {
          out.set(p.key, { kind: "estimate_sent", record_type: "estimate", record_id: row.id, matched_at: at, strength: "direct", basis });
        }
      }
    }
    return out;
  };
  const callIds = [...probesByCall.keys()];
  // No sent_at prefilter anywhere below: the handoff witness is the whole
  // contract, and an estimate accepted during its first send keeps
  // accepted_at + lastDeliveredAt with sent_at still null (admin-estimates
  // finalization) — it is delivered proof all the same.
  const stamped = await handedOffWithin(conn("estimates")
    .whereRaw(`estimate_data #>> '{estimatorEngine,callLogId}' IN (${callIds.map(() => "?").join(", ")})`, callIds), minAfter)
    .select(cols);
  for (const r of stamped) consider(r.stamped_call_id, r, "estimate_stamped_with_this_call");

  const probeBySid = new Map(probes.filter((p) => p.twilioCallSid).map((p) => [p.twilioCallSid, p]));
  if (!probeBySid.size) return judge();
  const leads = (await conn("leads")
    .whereIn("twilio_call_sid", [...probeBySid.keys()])
    .select("id", "estimate_id", "twilio_call_sid", "created_at"))
    .filter((l) => mintedByCall(l, probeBySid.get(l.twilio_call_sid)));
  if (!leads.length) return judge();
  const callBySid = new Map([...probeBySid].map(([sid, p]) => [sid, String(p.callId)]));
  const estimateIds = leads.map((l) => l.estimate_id).filter(Boolean);
  const leadIds = leads.map((l) => String(l.id));
  const linked = await handedOffWithin(conn("estimates")
    .where(function linkedToLeads() {
      if (estimateIds.length) this.orWhereIn("id", estimateIds);
      this.orWhereRaw(`estimate_data ->> 'lead_id' IN (${leadIds.map(() => "?").join(", ")})`, leadIds);
    }), minAfter)
    .select(cols);
  // Several leads can share one estimate_id — every call behind them is a
  // match, not an arbitrary one of them.
  const leadsByEstimateId = new Map();
  for (const l of leads) {
    if (!l.estimate_id) continue;
    const k = String(l.estimate_id);
    leadsByEstimateId.set(k, [...(leadsByEstimateId.get(k) || []), l]);
  }
  const leadById = new Map(leads.map((l) => [String(l.id), l]));
  for (const r of linked) {
    const matched = [...(leadsByEstimateId.get(String(r.id)) || [])];
    const mirror = leadById.get(String(r.mirror_lead_id || ""));
    if (mirror) matched.push(mirror);
    const callIds = new Set(matched.map((l) => callBySid.get(l.twilio_call_sid)).filter(Boolean));
    for (const callId of callIds) consider(callId, r, "estimate_linked_to_this_call_sent");
  }
  return judge();
}

// Shared ownership fence for delivered estimates, including commercial
// proposals whose estimate is unowned but whose live lead has a customer.
function whereEstimateCustomerOwnership(query, customerId) {
  return query.whereRaw(`(estimates.customer_id = ? OR (
          estimates.customer_id IS NULL
          AND (estimates.id IN (
            SELECT l.estimate_id FROM leads l
            WHERE l.deleted_at IS NULL AND l.customer_id = ? AND l.estimate_id IS NOT NULL
          ) OR estimates.estimate_data ->> 'lead_id' IN (
            SELECT l.id::text FROM leads l
            WHERE l.deleted_at IS NULL AND l.customer_id = ?
          ))
          AND estimates.id NOT IN (
            SELECT l.estimate_id FROM leads l
            WHERE l.deleted_at IS NULL AND l.customer_id IS DISTINCT FROM ? AND l.estimate_id IS NOT NULL
          )
          AND COALESCE(estimates.estimate_data ->> 'lead_id', '') NOT IN (
            SELECT l.id::text FROM leads l
            WHERE l.deleted_at IS NULL AND l.customer_id IS DISTINCT FROM ?
          )
        ))`, [customerId, customerId, customerId, customerId, customerId]);
}

async function resolveFulfillment(conn, commitment, call) {
  const started = call?.created_at ? new Date(call.created_at) : null;
  const after = callEndedAt(call);
  if (!started || Number.isNaN(started.getTime()) || !after) return null;
  const until = windowEnd(after);
  const phone = contactPhoneOf(call);
  const customerId = call?.customer_id || null;
  const leadIds = leadIdsOf(call);

  switch (commitment.kind) {
    case "send_estimate": {
      // Direct: the shared primitive above (estimator stamp; lead FK or
      // public-quote mirror on a lead this call minted).
      const probe = { key: "call", callId: call.id, twilioCallSid: call.twilio_call_sid, callStartedAt: call.created_at, customerId, phone, after };
      const direct = (await directEstimatesSentAfter(conn, [probe])).get("call");
      if (direct) return direct;
      // A REUSED earlier call's lead — reached through the lead_id /
      // relay_lead_id stamp, or carrying this call's SID only because
      // attribution re-stamped a lead older than the call — is a hint,
      // never direct proof (Codex #3738 r13 P1): an estimate later sent on
      // it is not necessarily this call's. Same guard as buildCallOutcomes:
      // no lead key, no lead lookup. No local catch: a failed lead lookup
      // reaches refreshFulfillment's failed accounting (r13 P2) instead of
      // reading as "no leads".
      const stampedLeads = (leadIds.length || call.twilio_call_sid) ? await conn("leads")
        .where(function scope() {
          if (leadIds.length) this.orWhereIn("id", leadIds);
          if (call.twilio_call_sid) this.orWhere("twilio_call_sid", call.twilio_call_sid);
        })
        .select("id", "estimate_id", "twilio_call_sid", "created_at") : [];
      const mintedHere = (lead) => Boolean(lead.twilio_call_sid) && lead.twilio_call_sid === call.twilio_call_sid && mintedByCall(lead, probe);
      const mintedIds = new Set(stampedLeads.filter(mintedHere).map((l) => String(l.id)));
      const reused = stampedLeads.filter((l) => !mintedHere(l));
      const reusedLeadIds = [...new Set([...leadIds.filter((id) => !mintedIds.has(id)), ...reused.map((l) => String(l.id))])];
      const reusedEstimateIds = reused.map((l) => l.estimate_id).filter(Boolean);
      if (reusedEstimateIds.length || reusedLeadIds.length) {
        const onReused = await handedOffWithin(conn("estimates")
          .where(function linkedToLeads() {
            if (reusedEstimateIds.length) this.orWhereIn("id", reusedEstimateIds);
            if (reusedLeadIds.length) this.orWhereRaw(`estimate_data ->> 'lead_id' IN (${reusedLeadIds.map(() => "?").join(", ")})`, reusedLeadIds);
          }), after)
          .orderByRaw(handoffOrder(conn, after))
          .first(...HANDOFF_COLS(conn));
        if (onReused) return { kind: "estimate_sent", record_type: "estimate", record_id: onReused.id, matched_at: witnessAt(onReused, after), strength: "association", basis: "estimate_sent_on_a_lead_reused_from_an_earlier_call" };
      }
      // An estimate linked only through estimates.customer_phone still keeps
      // the promise (commercial proposals store the phone with a NULL
      // customer_id, so a same-customer lookup misses them). Mirror the
      // promised-estimate-watcher phone predicate (Codex #3738 P1): a LINKED
      // call is cleared by its own customer's estimate; an UNLINKED call only
      // by an UNLINKED estimate whose phone matches the caller — a shared
      // household number never lets one customer's estimate clear another's
      // promise.
      const estQ = handedOffWithin(conn("estimates"), after, until);
      if (customerId) {
        // A lead can acquire its customer before its estimate does. Reuse the
        // precise FK / lead-id mirror, never contact matching. This remains
        // an association; conflicting or unknown live-lead ownership blocks
        // the unowned-estimate fallback in either linkage direction.
        // Uncorrelated membership sets avoid rescanning leads per estimate.
        // Exclude NULL FK values so NOT IN does not reject unrelated rows.
        whereEstimateCustomerOwnership(estQ, customerId);
      } else if (phone) {
        estQ.whereNull("customer_id").modify((b) => phoneWhere(b, "customer_phone", phone));
      } else {
        return null;
      }
      const est = await estQ.orderByRaw(handoffOrder(conn, after, until)).first(...HANDOFF_COLS(conn));
      return est ? { kind: "estimate_sent", record_type: "estimate", record_id: est.id, matched_at: witnessAt(est, after), strength: "association", basis: customerId ? `estimate_sent_to_same_customer_within_${ASSOCIATION_WINDOW_DAYS}_days` : `estimate_sent_to_caller_phone_within_${ASSOCIATION_WINDOW_DAYS}_days` } : null;
    }
    case "send_appointment_confirmation": {
      if (!phone) return null;
      // A confirmation that failed or was never delivered is not a kept
      // promise; the earliest surviving row is the hint so a later delivery
      // is not hidden behind an earlier failure (Codex r16 P2).
      const sms = await conn("sms_log")
        .where({ direction: "outbound", message_type: "confirmation" })
        .whereNotIn("status", ["failed", "undelivered", "canceled", "error"])
        .where("created_at", ">", after)
        .where("created_at", "<=", until)
        .modify((b) => phoneWhere(b, "to_phone", phone))
        .orderBy("created_at", "asc")
        .first("id", "created_at", "status");
      return sms ? { kind: "sms_sent", record_type: "sms_log", record_id: sms.id, matched_at: sms.created_at, strength: "association", basis: `confirmation_text_to_caller_within_${ASSOCIATION_WINDOW_DAYS}_days` } : null;
    }
    case "callback": {
      // A returned callback IS the fulfilment — the phone is the linkage.
      // Same completion predicate as the callbacks digest
      // (unworked-comms-watcher, "Already returned"): a CONNECTED outbound
      // call to the caller's number after this call (>= 60 s — the stored
      // duration is the parent leg, so a pickup-and-abandon is short), or
      // a HUMAN-authored text to it (manual / ai_approved / ai_revised —
      // never the assistant's automatic reply, and not a proactive draft
      // with no inbound anchor). A LINKED call is returned only by a
      // record linked to the same customer (shared household numbers);
      // an unlinked call keeps the phone-level match. No outer window: a
      // callback returned late was still returned.
      if (!phone) return null;
      const sameCustomer = (b, column) => { if (customerId) b.where(column, customerId); };
      const outbound = await conn("call_log")
        .modify((b) => require('./voice-agent/relay-protocol').whereNotSandboxCall(b))
        .where("direction", "outbound")
        .where("created_at", ">", after)
        .whereRaw("COALESCE(duration_seconds, 0) >= 60")
        .modify((b) => { phoneWhere(b, "to_phone", phone); sameCustomer(b, "customer_id"); })
        .orderBy("created_at", "asc")
        .first("id", "created_at");
      if (outbound) return { kind: "outbound_call", record_type: "call_log", record_id: outbound.id, matched_at: outbound.created_at, strength: "direct", basis: "callback_returned_connected_outbound_call" };
      const text = await conn("sms_log as os")
        .where("os.direction", "outbound")
        .whereIn("os.message_type", ["manual", "ai_approved", "ai_revised"])
        .whereIn("os.status", ["queued", "sent", "delivered"])
        .where("os.created_at", ">", after)
        .whereNotExists(function proactiveDraft() {
          this.select(1).from("message_drafts as mdx")
            .whereNull("mdx.sms_log_id")
            .whereRaw("(mdx.customer_id = os.customer_id OR (mdx.customer_id IS NULL AND os.customer_id IS NULL AND RIGHT(regexp_replace(COALESCE(mdx.flags->>'phone', mdx.flags->>'toPhone', ''), '[^0-9]', '', 'g'), 10) = RIGHT(regexp_replace(COALESCE(os.to_phone, ''), '[^0-9]', '', 'g'), 10)))")
            .whereRaw("mdx.sent_at BETWEEN os.created_at - interval '2 minutes' AND os.created_at + interval '2 minutes'");
        })
        .modify((b) => { phoneWhere(b, "os.to_phone", phone); sameCustomer(b, "os.customer_id"); })
        .orderBy("os.created_at", "asc")
        .first("os.id", "os.created_at");
      // No local catch: a failed lookup must reach refreshFulfillment's
      // `failed` accounting so the watchdog leaves this call out of the bell.
      return text ? { kind: "sms_sent", record_type: "sms_log", record_id: text.id, matched_at: text.created_at, strength: "direct", basis: "callback_returned_by_human_text" } : null;
    }
    case "call_back": {
      // The CUSTOMER's promise to call us back: the inbound counterpart of
      // the outbound lookup above — a later completed inbound call from the
      // caller's number (Codex r8 P2). Same association strength: the call
      // proves contact, not what was said.
      if (!phone) return null;
      const inbound = await conn("call_log")
        .whereNot("id", call.id)
        .where("direction", "like", "inbound%")
        .where("created_at", ">", after)
        .where("created_at", "<=", until)
        .where("status", "completed")
        .where("duration_seconds", ">=", 20)
        // A bake-off call from a customer's phone is not the customer calling back.
        .modify((b) => require('./voice-agent/relay-protocol').whereNotSandboxCall(b))
        .modify((b) => phoneWhere(b, "from_phone", phone))
        .orderBy("created_at", "asc")
        .first("id", "created_at");
      return inbound ? { kind: "inbound_call", record_type: "call_log", record_id: inbound.id, matched_at: inbound.created_at, strength: "association", basis: `completed_inbound_call_from_caller_within_${ASSOCIATION_WINDOW_DAYS}_days` } : null;
    }
    case "schedule_visit":
    case "technician_follow_up": {
      // Booked AFTER the call, like every other match: a reprocess can link
      // an existing visit to this call.
      const direct = await conn("scheduled_services")
        .where("source_call_log_id", call.id)
        .where("created_at", ">", after)
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
      // Paid AFTER the call, like every other match: a visit re-linked to
      // this call during a reprocess can carry an invoice paid before it.
      // And PAID means a payment: an invoice closed with pre-existing credit
      // (apply-credit stamps paid_at and creates no payment row) or a
      // goodwill adjustment is not the customer keeping a promise to pay —
      // the witness is a paid payments row (Codex #3738 r11 P2) — and it
      // must be THAT invoice's payment, recorded after the call. payments
      // has no invoice_id column: a row is linked to its invoice through
      // metadata.invoice_id / waves_invoice_id or a shared Stripe
      // PaymentIntent (the completion + refund paths key on the same). A
      // same-day payment on some other invoice cannot vouch for one closed
      // with account credit after the call (Codex #3738 r12 P2). payment_date
      // is a DATE (business day, Eastern), so the post-call instant is the
      // row's created_at, with the business day as the floor.
      if (!customerId) return null;
      const paidByItsOwnPayment = (qb) => qb.whereExists(function paymentForThisInvoice() {
        this.select(conn.raw("1")).from("payments as p")
          .where("p.status", "paid")
          .where("p.created_at", ">", after)
          .whereRaw("p.payment_date >= (?::timestamptz AT TIME ZONE 'America/New_York')::date", [after])
          .whereRaw("(p.metadata::jsonb ->> 'invoice_id' = i.id::text OR p.metadata::jsonb ->> 'waves_invoice_id' = i.id::text"
            + " OR (p.stripe_payment_intent_id IS NOT NULL AND p.stripe_payment_intent_id = i.stripe_payment_intent_id))");
      });
      const direct = await conn("invoices as i")
        .join("scheduled_services as ss", "ss.id", "i.scheduled_service_id")
        .where("ss.source_call_log_id", call.id)
        .whereNotNull("i.paid_at")
        .where("i.paid_at", ">", after)
        .modify(paidByItsOwnPayment)
        .orderBy("i.paid_at", "asc")
        .first("i.id", "i.paid_at")
        .catch(() => null);
      if (direct) return { kind: "invoice_paid", record_type: "invoice", record_id: direct.id, matched_at: direct.paid_at, strength: "direct", basis: "invoice_for_the_visit_booked_from_this_call_paid" };
      const inv = await conn("invoices as i")
        .where("i.customer_id", customerId)
        .whereNotNull("i.paid_at")
        .where("i.paid_at", ">", after)
        .where("i.paid_at", "<=", until)
        .modify(paidByItsOwnPayment)
        .orderBy("i.paid_at", "asc")
        .first("i.id", "i.paid_at")
        .catch(() => null);
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
  const row = call || await conn("call_log").where({ id: callLogId }).first("id", "twilio_call_sid", "customer_id", "from_phone", "to_phone", "direction", "created_at", "bridged_at", "duration_seconds", "metadata");
  if (!row) return { checked: 0, fulfilled: 0, hinted: 0 };
  const open = await conn("call_commitments").where({ call_log_id: callLogId, status: "open" }).whereNull("human_state");
  let fulfilled = 0;
  let hinted = 0;
  let cleared = 0;
  // A lookup that threw proves nothing either way: the row is left as is
  // and the failure is COUNTED, so the watchdog can keep that call out of
  // the bell instead of paging on a row it could not verify.
  let failed = 0;
  const LOOKUP_FAILED = Symbol("lookup_failed");
  for (const c of open) {
    const proof = await resolveFulfillment(conn, c, row).catch((err) => {
      logger.warn(`[call-commitments] fulfillment lookup failed for ${c.id}: ${err.message}`);
      return LOOKUP_FAILED;
    });
    if (proof === LOOKUP_FAILED) { failed += 1; continue; }
    if (!proof) {
      // A hint the current facts no longer support — the call was relinked
      // to another customer, or the record it pointed at is gone — must not
      // keep saying "possibly kept": the panel would steer a manual
      // completion off a record that is not this customer's. Only a
      // completed lookup clears it; an error above leaves it alone.
      cleared += await conn("call_commitments")
        .where({ id: c.id, status: "open" })
        .whereNull("human_state")
        .whereRaw("fulfillment ->> 'strength' = 'association'")
        .update({ fulfillment: null, updated_at: new Date() });
      continue;
    }
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
  return { checked: open.length, fulfilled, hinted, cleared, failed };
}


// ── Queue reads (the Owed tab, Customer 360, the lead card, the bell) ─────
// A Waves promise with no stated due time is still owed promptly. The
// implicit deadline per kind preserves what the lanes this queue takes
// over from already enforced, so handing a promise to the pager never
// loosens it: an estimate is owed within 24 hours (the promised-estimate
// watcher's grace), a callback by the end of the call's ET day (the
// end-of-day unworked digest), the other prompt kinds (confirmation,
// report, paperwork) within OVERDUE_IMPLICIT_DAYS. Follow-up visits and
// scheduling without a date are not judged this way — they wait for the
// office to set a time. The clock starts at the call for an AI row and at
// the moment it was recorded for a human one (a promise the office adds to
// a weeks-old call is not overdue the instant it is typed).
// `effectiveDueSql` is the same rule for the queue's SQL ordering.
const OVERDUE_IMPLICIT_DAYS = 3;
const OVERDUE_IMPLICIT_ESTIMATE_HOURS = 24;
const PROMPT_KINDS = new Set(['send_estimate', 'send_appointment_confirmation', 'callback', 'send_report', 'send_paperwork']);

// The first ET midnight after `date`.
function endOfETDay(date) {
  return parseETDateTime(`${etDateString(addETDays(date, 1))}T00:00`);
}

function implicitDueAt(row) {
  if (row.party !== 'waves' || !PROMPT_KINDS.has(row.kind)) return null;
  const basis = row.source === 'human' ? row.created_at : (row.call_started_at || row.created_at);
  const from = basis ? new Date(basis) : null;
  if (!from || Number.isNaN(from.getTime())) return null;
  if (row.kind === 'send_estimate') return new Date(from.getTime() + OVERDUE_IMPLICIT_ESTIMATE_HOURS * 60 * 60 * 1000);
  if (row.kind === 'callback') return endOfETDay(from);
  return new Date(from.getTime() + OVERDUE_IMPLICIT_DAYS * 24 * 60 * 60 * 1000);
}

function isOverdue(row, now = new Date()) {
  if (!row || row.status !== 'open' || row.human_state === 'dismissed') return false;
  if (row.due_at) return new Date(row.due_at).getTime() < now.getTime();
  const implicit = implicitDueAt(row);
  return !!implicit && implicit.getTime() < now.getTime();
}

// isOverdue's deadline as SQL over a call_commitments alias and its
// call_log alias: the stated due time, else the implicit one, else NULL.
// Static SQL — every value is a constant from this module.
function effectiveDueSql(cc = 'cc', cl = 'cl') {
  const basis = `CASE WHEN ${cc}.source = 'human' THEN ${cc}.created_at ELSE ${cl}.created_at END`;
  const promptKinds = [...PROMPT_KINDS].map((k) => `'${k}'`).join(', ');
  return `CASE WHEN ${cc}.due_at IS NOT NULL THEN ${cc}.due_at`
    + ` WHEN ${cc}.party <> 'waves' THEN NULL`
    + ` WHEN ${cc}.kind = 'send_estimate' THEN (${basis}) + interval '${OVERDUE_IMPLICIT_ESTIMATE_HOURS} hours'`
    + ` WHEN ${cc}.kind = 'callback' THEN (((${basis}) AT TIME ZONE 'America/New_York')::date + 1)::timestamp AT TIME ZONE 'America/New_York'`
    + ` WHEN ${cc}.kind IN (${promptKinds}) THEN (${basis}) + interval '${OVERDUE_IMPLICIT_DAYS} days'`
    + ' ELSE NULL END';
}

// An untouched AI row a LATER commitments pass no longer detected: kept for
// the audit trail, labelled stale by the panel, never live work — not in
// the queue, not a bell, and not a reason for the legacy watcher to stand
// down. "Later pass" means a pass that demonstrably COMPLETED its
// commitments step on this call — some row of the call carries a higher
// last_seen_generation — never the call's processing_generation, which
// advances the moment a reprocess claims the row (r15): a reprocess that
// times out or fails before recording commitments must not hide the
// promises the last good pass found. (A later pass that detected nothing
// at all leaves the earlier rows live — the safe direction.) A
// human-confirmed or edited row is the office's call and never stale.
// Static SQL; `cc` is the call_commitments alias of the enclosing query.
function staleAiRowSql(cc = 'cc') {
  return `(${cc}.human_state IS NULL AND ${cc}.source = 'ai' AND ${cc}.last_seen_generation IS NOT NULL AND ${cc}.last_seen_generation < (SELECT MAX(later.last_seen_generation) FROM call_commitments later WHERE later.call_log_id = ${cc}.call_log_id))`;
}

// Pure, exported for the watchdog tests.
function selectOverdue(rows, { now = new Date() } = {}) {
  return (rows || []).filter((r) => isOverdue(r, now));
}

async function listOpenCommitments(conn, { party = null, customerId = null, leadId = null, limit = 100, offset = 0, includeHints = true, now = new Date() } = {}) {
  let leadSid = null;
  if (leadId) {
    // No local catch: a failed lookup must reach the route's error handler
    // (a SID-only linked call would otherwise read as nothing owed — Codex
    // #3725 r18 P2).
    const lead = await conn('leads').where({ id: leadId }).first('twilio_call_sid');
    leadSid = lead?.twilio_call_sid || null;
  }
  const rows = await conn('call_commitments as cc')
    .join('call_log as cl', 'cl.id', 'cc.call_log_id')
    .leftJoin('customers as cu', 'cu.id', 'cl.customer_id')
    .where('cc.status', 'open')
    .whereRaw(`NOT ${staleAiRowSql('cc')}`)
    .modify((b) => {
      if (party === 'waves' || party === 'customer') b.where('cc.party', party);
      if (customerId) b.where('cl.customer_id', customerId);
      if (leadId) {
        b.where(function leadScope() {
          this.whereRaw("cl.metadata ->> 'lead_id' = ?", [String(leadId)]);
          // A relay call that REUSED an existing lead leaves leads.twilio_call_sid
          // on the original call and stamps itself relay_lead_id (capture_lead).
          this.orWhereRaw("cl.metadata ->> 'relay_lead_id' = ?", [String(leadId)]);
          if (leadSid) this.orWhere('cl.twilio_call_sid', leadSid);
        });
      }
      if (!includeHints) b.whereNull('cc.fulfillment');
    })
    // Overdue first — by the SAME rule isOverdue applies (the stated due
    // time, else the per-kind implicit deadline, in the past) — then
    // soonest EFFECTIVE due (a callback owed by tonight ahead of an
    // estimate owed tomorrow morning; undated scheduling rows last), then
    // oldest call.
    // cc.id last: a page boundary between rows tied on deadline and call
    // (several undated promises from one call) must fall the same way on
    // every offset query, or Load more / the watchdog scan would duplicate
    // one row and skip another (Codex #3725 r19 P2).
    .orderByRaw(`CASE WHEN (${effectiveDueSql('cc', 'cl')}) < NOW() THEN 0 ELSE 1 END, (${effectiveDueSql('cc', 'cl')}) ASC NULLS LAST, cl.created_at ASC, cc.id ASC`)
    // 200 rows per page + one probe row the route uses to say has_more.
    .limit(Math.max(1, Math.min(201, Number(limit) || 100)))
    .offset(Math.max(0, Number(offset) || 0))
    .select(
      'cc.*',
      'cl.twilio_call_sid', 'cl.created_at as call_started_at', 'cl.direction', 'cl.from_phone', 'cl.to_phone',
      'cl.customer_id', 'cu.first_name as customer_first_name', 'cu.last_name as customer_last_name',
    );
  return rows.map((r) => ({ ...normalizeRow(r), overdue: isOverdue(r, now) }));
}

// Which of these commitment ids are still LIVE work right now — open, not
// dismissed, and not gone stale (a reprocess that finished after the
// snapshot and no longer detects the row: the same predicate that keeps it
// out of the queue). The watchdog re-checks its snapshot immediately
// before paging, so a promise the office settled — or a pass withdrew —
// while the scan was refreshing never rings.
async function stillOpenIds(conn, ids) {
  if (!ids?.length) return new Set();
  const rows = await conn('call_commitments as cc')
    .join('call_log as cl', 'cl.id', 'cc.call_log_id')
    .whereIn('cc.id', ids)
    .where('cc.status', 'open')
    .whereRaw("cc.human_state IS DISTINCT FROM 'dismissed'")
    .whereRaw(`NOT ${staleAiRowSql('cc')}`)
    .select('cc.id');
  return new Set(rows.map((r) => r.id));
}

// ── The AI phone assistant's own promises ────────────────────────────────
// Relay calls never go through processRecording, so Sandy's "someone will
// call you back" existed only in the transcript. The session's close writes
// the scrubbed transcript; this reads the AGENT lines of that text (never
// the raw turns) and records a commitment for each promise it finds. The
// capture_lead tool's own verdict on the estimate (queued or refused) is
// the stronger signal and outranks the wording.
// English AND Spanish: a caller who chose Spanish on the keypad hears the
// model and the deterministic closes (relay-language COPY.es — "le
// devolverá la llamada", "se comunicará con usted", "le dé seguimiento")
// in Spanish, and those promises are owed just the same. Accented letters
// are not \\w, so the Spanish alternatives end without a trailing \\b.
const RELAY_PROMISE_PATTERNS = Object.freeze([
  { kind: 'callback', re: /\b(call(?:ing)? you back|give you a call( back)?|get back to you|reach out to you|follow(?:s|ing)? up with you|team member will follow up|someone will follow up|(?:a )?note for the team to follow up|team to follow up|will follow up (?:with you )?(?:shortly|as soon as possible|first thing|when the office opens))\b/i },
  { kind: 'callback', re: /\b(le devolver(?:á|a|emos) la llamada|devolverle la llamada|se comunicar(?:á|a|án) con usted|nos comunicar(?:emos|íamos) con usted|le llamar(?:á|a|emos|án)(?: de vuelta)?|le regresar(?:á|a|emos) la llamada|nos pondremos en contacto|se pondr(?:á|a|án) en contacto con usted|le d(?:é|e|ar(?:á|a|án|emos)) seguimiento|dar(?:á|a|án|emos)? seguimiento a (?:esto|su))/i },
  { kind: 'send_estimate', re: /\b(written estimate|send (?:you )?(?:an?|the|your) (?:written )?(?:estimate|quote)|(?:estimate|quote) (?:usually )?(?:goes|will go|will be sent|is sent) out|email (?:you )?(?:an?|the|your) (?:estimate|quote))\b/i },
  { kind: 'send_estimate', re: /\b((?:le )?(?:enviar|mandar)(?:é|emos|á|án|le|emos)?(?: a usted)? (?:un|una|el|la|su) (?:presupuesto|cotizaci(?:ó|o)n)(?: por escrito)?|(?:presupuesto|cotizaci(?:ó|o)n)(?: por escrito)? (?:se (?:le )?(?:enviar(?:á|a)|env(?:í|i)a)|(?:le )?llegar(?:á|a)|(?:normalmente )?sale)|(?:presupuesto|cotizaci(?:ó|o)n) por escrito)/i },
]);
const RELAY_EXTRACTOR_VERSION = 'relay-v1';

// The phrase has to be an AFFIRMATIVE promise. "Would you like me to call
// you back?" is an offer and "I can't send you an estimate yet" a refusal;
// both contain the pattern and neither is work the office owes (Codex
// #3725 r16 P2). The check runs on the CLAUSE that carries the match —
// sentences, and ", but" / "pero" splits — so "I can't send the estimate
// yet, but someone will call you back" still records the callback.
const RELAY_NON_PROMISE_RE = /\b(can(?:'|’)?t|cannot|can not|won(?:'|’)?t|will not|not able|unable|not be able|not going to|no puedo|no podemos|no podr(?:é|e|á|a|emos|án|an)|no (?:le |se )?(?:va|vamos|voy) a|would you like|do you want|want me to|shall i|should i|quiere que|quisiera que|le gustar(?:í|i)a|desea que)\b/i;
function relayClauses(line) {
  return String(line).split(/(?<=[.!?])\s+|,?\s+(?:but|pero)\s+/i).map((c) => c.trim()).filter(Boolean);
}
function isAffirmativePromise(clause) {
  return !/\?\s*$/.test(clause) && !clause.startsWith('¿') && !RELAY_NON_PROMISE_RE.test(clause);
}
function affirmativeRelayHit(line, re) {
  // The first clause that matches AND is affirmative: "Would you like me to
  // call you back? Someone will follow up tomorrow." rejects the offer and
  // still records the promise that follows it (Codex #3725 r17 P2).
  const clause = relayClauses(line).find((c) => re.test(c) && isAffirmativePromise(c));
  return clause ? line : null;
}

// capture_lead's spoken expectation for the estimate ('about_15_minutes'
// when the office is open; 'when_office_opens' / 'as_soon_as_possible'
// otherwise). Only the 15-minute wording names a time the caller can hold
// Waves to; the other two carry no timestamp and keep the implicit window.
const RELAY_ESTIMATE_DUE_MS = { about_15_minutes: 15 * 60 * 1000 };

// `estimatePromisedAt` is when capture_lead spoke the expectation ("about
// 15 minutes"): the deadline runs from that instant, not from the close of
// a conversation that may have gone on for minutes afterwards.
function deriveRelayCommitments({ transcript = '', estimateQueued = null, estimateExpectation = null, estimatePromisedAt = null, now = new Date() } = {}) {
  const promisedAt = estimatePromisedAt && !Number.isNaN(new Date(estimatePromisedAt).getTime()) ? new Date(estimatePromisedAt) : now;
  const agentLines = String(transcript || '')
    .split('\n')
    .filter((l) => l.startsWith('Agent: '))
    .map((l) => l.slice('Agent: '.length).trim())
    .filter(Boolean);
  const items = [];
  for (const { kind, re } of RELAY_PROMISE_PATTERNS) {
    let hit = null;
    for (const line of agentLines) { hit = affirmativeRelayHit(line, re); if (hit) break; }
    if (!hit) continue;
    // The tool refused the estimate (missing fields / could not queue): the
    // prompt tells Sandy not to promise one, and a stray phrase is not an
    // obligation the office can act on.
    if (kind === 'send_estimate' && estimateQueued === false) continue;
    const dueMs = kind === 'send_estimate' ? RELAY_ESTIMATE_DUE_MS[estimateExpectation] : null;
    items.push({
      party: 'waves',
      kind,
      description: kind === 'callback'
        ? 'Call the caller back (promised by the AI phone assistant)'
        : 'Send the caller a written estimate (promised by the AI phone assistant)',
      channel: kind === 'callback' ? 'call' : 'unknown',
      due_at: dueMs ? new Date(promisedAt.getTime() + dueMs).toISOString() : null,
      due_basis: dueMs ? 'stated' : null,
      confidence: kind === 'send_estimate' && estimateQueued === true ? 0.95 : 0.75,
      evidence: [{ quote: hit.slice(0, 300), speaker: 'agent' }],
      origin: 'relay',
    });
  }
  if (estimateQueued === true && !items.some((i) => i.kind === 'send_estimate')) {
    const dueMs = RELAY_ESTIMATE_DUE_MS[estimateExpectation];
    items.push({
      party: 'waves',
      kind: 'send_estimate',
      description: 'Send the caller a written estimate (queued by the AI phone assistant)',
      channel: 'unknown',
      due_at: dueMs ? new Date(promisedAt.getTime() + dueMs).toISOString() : null,
      due_basis: dueMs ? 'stated' : null,
      confidence: 0.9,
      evidence: [],
      origin: 'relay_tool',
    });
  }
  return items;
}

// Called from the relay session's end() after its reconcile UPDATE landed.
// Relay rows have no processing_token; the session-owner fence below
// protects their commitment transaction. Never throws.
function relayClaimOwner(metadata) {
  try {
    const meta = typeof metadata === 'string' ? JSON.parse(metadata) : (metadata || {});
    const owner = meta?.relay_session_claim_owner;
    return owner == null ? null : String(owner);
  } catch {
    return null;
  }
}

// `sessionKey` is the closing session's claim nonce. The reconcile UPDATE
// that precedes this call is owner-fenced, but a replacement socket can take
// the claim between that UPDATE and this write; the row is therefore locked
// and its owner re-checked in the SAME transaction as the upsert, so a
// superseded conversation's promises never reach the Owed queue. A NULL
// owner is an unclaimed row (an unverified session still records its own
// honest promises); only a FOREIGN owner refuses.
async function recordRelayCommitments(conn, { callSid, transcript, estimateQueued = null, estimateExpectation = null, estimatePromisedAt = null, sessionKey = null } = {}) {
  const summary = { found: 0, written: 0 };
  try {
    if (!callSid) return summary;
    return await conn.transaction(async (trx) => {
      const call = await trx('call_log').where({ twilio_call_sid: callSid }).forUpdate().first('id', 'metadata', 'source', 'call_outcome');
      if (!call) return summary;
      // A voice-agent sandbox call is a test: a promise Sandy makes on it
      // must never become office work in the Owed queue.
      if (call.source === require('./voice-agent/relay-protocol').VOICE_RELAY_SANDBOX_SOURCE) return { ...summary, sandbox: true };
      if (sessionKey) {
        const owner = relayClaimOwner(call.metadata);
        if (owner && owner !== String(sessionKey)) return { ...summary, superseded: true };
      }
      // Segment-backed calls must derive evidence from this locked snapshot.
      // A late socket may have read an earlier expectation under the SAME
      // owner; ownership alone does not make that pre-read current.
      const metadata = typeof call.metadata === 'string' ? JSON.parse(call.metadata) : (call.metadata || {});
      if (Array.isArray(metadata.relay_segments) && metadata.relay_segments.length) {
        // A late append must have the same durable eligibility as normal
        // finalization: handled calls, or a real transfer/reconnect salvage.
        const eligible = ['ai_handled', 'ai_transferred'].includes(call.call_outcome)
          || (call.call_outcome === 'voicemail' && (metadata.relay_handoff || Number(metadata.relay_reconnects) > 0));
        if (!eligible) return summary;
        const { segmentsText, latestPromises } = require('./voice-agent/relay-segments');
        transcript = segmentsText(metadata.relay_segments);
        const estimate = latestPromises(metadata.relay_segments).find((p) => p.kind === 'send_estimate');
        estimateQueued = estimate ? estimate.verdict : null;
        estimateExpectation = estimate?.expectation || null;
        estimatePromisedAt = estimate?.at || null;
      }
      const items = deriveRelayCommitments({ transcript, estimateQueued, estimateExpectation, estimatePromisedAt })
        .map((item) => ({ ...item, evidence: anchorEvidence(item.evidence, { transcript }) }));
      summary.found = items.length;
      if (!items.length) return summary;
      const result = await upsertCommitments(trx, call.id, items, { generation: null, extractorVersion: RELAY_EXTRACTOR_VERSION });
      summary.written = result.written;
      return summary;
    });
  } catch (err) {
    logger.warn(`[call-commitments] relay commitments not recorded for ${callSid ? String(callSid).slice(0, 2) + '…' + String(callSid).slice(-6) : 'n/a'}: ${err.message}`);
    return { ...summary, error: err.message };
  }
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
      // An edited obligation is a NEW obligation: the proof that kept the
      // old wording ("send estimate") is not proof for the new one ("send
      // revised estimate"). A fulfilled row goes back to open with its
      // fulfillment cleared; open and dismissed rows are left as they are
      // (Codex #3738 r13 P2). SQL-side so no pre-read races the update.
      if (description !== undefined || due_at !== undefined) {
        patch.status = conn.raw("CASE WHEN status = 'fulfilled' THEN 'open' ELSE status END");
        patch.fulfillment = conn.raw("CASE WHEN status = 'fulfilled' THEN NULL ELSE fulfillment END");
        patch.fulfilled_at = conn.raw("CASE WHEN status = 'fulfilled' THEN NULL ELSE fulfilled_at END");
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
  // Strict: an unknown party or a kind that does not belong to that party
  // is a bad request, never a silently different obligation.
  if (party !== 'waves' && party !== 'customer') throw Object.assign(new Error('party must be waves or customer'), { status: 400 });
  if (!COMMITMENT_KINDS.includes(kind)) throw Object.assign(new Error(`kind must be one of: ${COMMITMENT_KINDS.join(', ')}`), { status: 400 });
  if (!kindBelongsToParty(party, kind)) throw Object.assign(new Error(`kind "${kind}" is not a ${party} commitment`), { status: 400 });
  const p = party;
  const k = kind;
  const text = String(description || '').trim();
  if (!text) throw Object.assign(new Error('description is required'), { status: 400 });
  const due = parseDueAt(due_at);
  if (Number.isNaN(due)) throw Object.assign(new Error('due_at is not a valid date'), { status: 400 });
  // The :h<hash> suffix is what keeps a human row from colliding with the
  // AI row of the same kind, so the base is trimmed to leave room for it —
  // never the suffix.
  const suffix = `:h${crypto.createHash('sha1').update(text).digest('hex').slice(0, 6)}`;
  const key = `${commitmentKey({ party: p, kind: k, description: text }).slice(0, 160 - suffix.length)}${suffix}`;
  // Idempotent: the key is deterministic on (party, kind, wording), so a
  // retried or double-submitted request returns the row it already created
  // instead of tripping the unique constraint.
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
  }).onConflict(['call_log_id', 'commitment_key']).ignore().returning('*');
  if (row) return normalizeRow(row);
  const existing = await conn('call_commitments').where({ call_log_id: callLogId, commitment_key: key }).first();
  return normalizeRow(existing);
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
  // No lead key at all (an imported call: no stamped lead_id, no SID) means
  // no lead — an empty scope would read the first lead in the table and
  // hang its estimates and revenue on this call.
  const lead = (leadId || call.twilio_call_sid) ? await conn('leads')
    .where(function scope() {
      if (leadId) this.orWhere('id', leadId);
      if (call.twilio_call_sid) this.orWhere('twilio_call_sid', call.twilio_call_sid);
    })
    .whereNull('deleted_at')
    .orderBy('created_at', 'asc')
    .first('id', 'status', 'lost_reason', 'customer_id', 'estimate_id', 'converted_at', 'created_at')
    .catch(() => null) : null;
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
  // A pre-existing booking the processor ATTACHED to this call (a
  // confirmation call stamps the old row with source_call_log_id) predates
  // the call and is labelled as such, not as booked from it (Codex r16 P2).
  out.appointments = appointments.map((a) => ({
    id: a.id, status: a.status, scheduled_date: a.scheduled_date, completed_at: a.completed_at, service_type: a.service_type,
    basis: a.source_call_log_id === call.id
      ? (a.created_at && new Date(a.created_at) > after ? 'booked_from_this_call' : 'existing_booking_attached_to_this_call')
      : 'customer_visit_after_call',
  }));
  if (customerId) {
    const invoices = await conn('invoices')
      .where('customer_id', customerId)
      .where('created_at', '>', after)
      .orderBy('created_at', 'asc')
      .limit(5)
      .select('id', 'status', 'total', 'paid_at', 'created_at')
      .catch(() => []);
    out.invoices = invoices.map((i) => ({ id: i.id, status: i.status, total: i.total == null ? null : Number(i.total), paid_at: i.paid_at, basis: 'customer_invoice_after_call' }));
    // The list above is a capped display; the paid total is a separate
    // aggregate over EVERY later paid invoice, in integer cents.
    const paid = await conn('invoices')
      .where('customer_id', customerId)
      .where('created_at', '>', after)
      .whereNotNull('paid_at')
      .first(conn.raw('COALESCE(ROUND(SUM(total) * 100), 0)::bigint AS cents'))
      .catch(() => null);
    out.revenue_cents = Number(paid?.cents || 0);
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
  kindBelongsToParty,
  parseDueAt,
  anchorEvidence,
  deriveCommitmentsFromExtraction,
  callbackDueAt,
  callEndedAt,
  whereEstimateCustomerOwnership,
  handedOffWithin,
  handoffOrder,
  HANDOFF_COLS,
  witnessAt,
  directEstimatesSentAfter,
  implicitDueAt,
  staleAiRowSql,
  stillOpenIds,
  OVERDUE_IMPLICIT_ESTIMATE_HOURS,
  buildCommitmentsPrompt,
  groundModelCommitments,
  toRow,
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
  OVERDUE_IMPLICIT_DAYS,
  PROMPT_KINDS,
  RELAY_EXTRACTOR_VERSION,
  isOverdue,
  selectOverdue,
  listOpenCommitments,
  deriveRelayCommitments,
  recordRelayCommitments,
};
