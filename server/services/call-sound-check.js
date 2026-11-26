'use strict';

/**
 * Call sound check (GATE_CALL_SOUND_CHECK, dark; owner 2026-11-25 "both").
 *
 * A model LISTENS to the recording of each newly processed call and notes what a transcript cannot show: the
 * customer's mood at the start and at the end, whether the customer was upset, how often staff talked over the
 * customer, whether staff sounded rushed, and any risky claim staff made. Notes only: the answer is saved on the call
 * (call_log.metadata.sound_check). No bell, no text, nothing a customer sees.
 *
 * Every listen is a paid Gemini call (MODELS.ROUTES.callSoundCheck, `hear` below), so the job is built around its
 * spend:
 *   - a recording gets ONE record, written while it has none, and so one attempt: a failed listen is not tried
 *     again (the one exception sent nothing: with no Gemini key the claim is taken back and the tick stops). A
 *     recording swapped onto the call later is a new recording and gets its own record;
 *   - the call is CLAIMED before the model is asked, and the claim reserves the attempt's worst cost in
 *     call_sound_check_spend, so a process that dies mid-call can neither ask again nor drop spend from the day;
 *   - the ET day stops at DAILY_CAP_USD: a call is claimed only while the day's total in call_sound_check_spend plus
 *     its own worst cost fits. That table outlives the call row (a call marked spam is deleted);
 *   - a model with no usable llm_model_prices row, or no audio input rate, makes no call: the cap could not be kept.
 * Every dollar figure here is an ESTIMATE from the portal's price table (services/llm-cost.js), not Google's bill.
 *
 * Never sent: an internal call (voice-agent sandbox, tech voice line), a call flagged for card data, a call still in
 * the pipeline, audio longer than MAX_SECONDS, and a recording that is not the pipeline's own MP3.
 */

const db = require('../models/db');
const logger = require('./logger');
const MODELS = require('../config/models');
const llmCost = require('./llm-cost');
const { canonicalTwilioRecordingUrl } = require('../utils/twilio-recording-url');
const { callSoundCheckLive } = require('../config/feature-gates');
const { dispatch, rejectCall } = require('./llm/call');
const { whereNotSandboxCall } = require('./voice-agent/relay-protocol');
const { scrubPansDetailed } = require('../utils/pan-scrub');
const { etDateString } = require('../utils/datetime-et');

const METADATA_KEY = 'sound_check';
// One row per claim: what it reserved and what it cost. The cap sums this table, which outlives a deleted call row.
const SPEND = 'call_sound_check_spend';
const PROMPT_VERSION = 'sound-check-v1';
// The top of the range the owner approved (2026-11-25: $0.33 to $0.83 a day). A constant on purpose: raising the
// spend is a code change with the owner's yes, never a variable.
const DAILY_CAP_USD = 0.83;
const BATCH = 3;
const LOOKBACK_HOURS = 48;
const MIN_SECONDS = 20;
const MAX_SECONDS = 30 * 60;
// Base64 adds a third, and Gemini takes at most 20 MB in one inline request.
const MAX_AUDIO_BYTES = 12 * 1024 * 1024;
const MAX_TOKENS = 4096;
const TIMEOUT_MS = 120_000;
// The reserve's input side: Google documents 32 tokens for a second of audio; the prompt and its schema sit well
// inside the allowance.
const AUDIO_TOKENS_PER_SECOND = 32;
const PROMPT_TOKENS_ALLOWANCE = 1500;
const TONE_MAX = 40;
const CLAIM_MAX = 240;

// No card number was heard on the call: not by the recording's own scrub, not by live transcription (a masked card
// number, a quarantine, or a card pause, which means a card was read out).
const NOT_CARD_FLAGGED_SQL = "COALESCE(transcription_metadata::jsonb ->> 'pan_detected', '') <> 'true'"
  + " AND COALESCE(metadata #>> '{live_transcription,pan_detected}', '') <> 'true'"
  + " AND (metadata #> '{live_transcription,quarantined_at}') IS NULL"
  + " AND (metadata #> '{live_transcription,card_pause}') IS NULL";

const PROMPT = [
  'You will hear one recorded phone call to or from a pest control and lawn care company in Florida.',
  'One side is the customer: a customer of the company, or someone who asks about its service. The other side is a company employee.',
  'Judge only what you hear. Do not transcribe the call. Never write a number that anyone says (a card, phone, account or street number).',
  '',
  'Answer with JSON:',
  '- no_conversation: true when the recording holds no talk between a customer and an employee (a voicemail, a phone menu, hold music, silence). Then use null, false and 0 for the other keys.',
  "- caller_tone_start: one or two words for the customer's mood early in the call (for example calm, friendly, worried, annoyed, angry).",
  "- caller_tone_end: one or two words for the customer's mood at the end of the call.",
  '- caller_upset: true only when the customer sounds angry, distressed or clearly frustrated at some point.',
  '- talk_over_count: how many times the employee started to talk while the customer was still talking, and kept going. Do not count short sounds of agreement.',
  '- agent_sounded_rushed: true when the employee hurried the customer: clipped answers, talk too fast to follow, or a push to end the call.',
  '- risky_claim: flag is true only when the employee made a claim that may be false, unproven or not allowed for a pest control company. That is a claim about safety (safe for pets or children), organic or natural products, a guarantee, a promised result, a price, what a service includes, or licensing. A promise to call back is not a risky claim. When flag is true, what is one sentence that names the claim in your own words. When flag is false, what is null.',
].join('\n');

const NOTE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['no_conversation', 'caller_tone_start', 'caller_tone_end', 'caller_upset', 'talk_over_count', 'agent_sounded_rushed', 'risky_claim'],
  properties: {
    no_conversation: { type: 'boolean' },
    caller_tone_start: { type: ['string', 'null'] },
    caller_tone_end: { type: ['string', 'null'] },
    caller_upset: { type: 'boolean' },
    talk_over_count: { type: 'integer', minimum: 0 },
    agent_sounded_rushed: { type: 'boolean' },
    risky_claim: {
      type: 'object',
      additionalProperties: false,
      required: ['flag', 'what'],
      properties: { flag: { type: 'boolean' }, what: { type: ['string', 'null'] } },
    },
  },
};

const isBoolean = (value) => typeof value === 'boolean';
const isTextOrNull = (value) => value === null || typeof value === 'string';

// Every key of NOTE_SCHEMA is there with its type. The schema asks the model for the same; this is the check that
// does not trust it to comply.
function hasNoteShape(json) {
  const claim = json?.risky_claim;
  return !!claim && typeof claim === 'object'
    && [json.no_conversation, json.caller_upset, json.agent_sounded_rushed, claim.flag].every(isBoolean)
    && [json.caller_tone_start, json.caller_tone_end, claim.what].every(isTextOrNull)
    && Number.isInteger(json.talk_over_count) && json.talk_over_count >= 0;
}

// The note to store, or null when the answer is not the shape asked for. The model's free text passes the card-number
// scrub and is cut to length; `pan_scrubbed` marks a note the scrub changed.
function normalizeNote(json) {
  if (!hasNoteShape(json)) return null;
  if (json.no_conversation) return { no_conversation: true };
  let scrubbed = 0;
  const cleanText = (value, max) => {
    const out = scrubPansDetailed(String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 2000));
    scrubbed += out.count;
    return out.text.slice(0, max) || null;
  };
  const claim = json.risky_claim;
  const what = claim.flag ? cleanText(claim.what, CLAIM_MAX) : null;
  // A flagged claim has to say what the claim was: a bare flag gives staff nothing to check.
  if (claim.flag && !what) return null;
  const note = {
    no_conversation: false,
    caller_tone_start: cleanText(json.caller_tone_start, TONE_MAX),
    caller_tone_end: cleanText(json.caller_tone_end, TONE_MAX),
    caller_upset: json.caller_upset,
    talk_over_count: Math.min(json.talk_over_count, 99),
    agent_sounded_rushed: json.agent_sounded_rushed,
    risky_claim: { flag: claim.flag, what },
  };
  return scrubbed ? { ...note, pan_scrubbed: true } : note;
}

// One model call for one recording: what is sent, and what comes back. `note` is null when the call failed or the
// answer is not the shape asked for (that answer's ledger row is then marked rejected), and `reason` says which.
// The model's raw reply is not returned: it can repeat what was said on the call, and only the checked note is fit
// to store. `usage` holds token counts only, for the caller's cost record.
async function hear(audio) {
  const result = await dispatch(MODELS.ROUTES.callSoundCheck, {
    text: PROMPT,
    audio: [{ mimeType: 'audio/mpeg', data: audio.toString('base64') }],
    jsonMode: true,
    jsonSchema: NOTE_SCHEMA,
    maxTokens: MAX_TOKENS,
    thinkingLevel: 'LOW',
    timeoutMs: TIMEOUT_MS,
    laneId: 'call_sound_check',
    promptVersion: PROMPT_VERSION,
  });
  const note = result.ok ? normalizeNote(result.json) : null;
  if (result.ok && !note) rejectCall(result, 'invalid_note');
  const failure = result.ok ? 'invalid_note' : String(result.reason || 'error').slice(0, 60);
  return {
    note,
    reason: note ? null : failure,
    model: result.ok ? result.servedModel || result.model : null,
    usage: result.usage || null,
  };
}

const round6 = (n) => Math.round(n * 1e6) / 1e6;

// Estimated USD of one call's token usage at the model's price, or null when it cannot be priced.
function costOf(price, usage) {
  return llmCost.costUsd('gemini', usage, llmCost.audioInputRates(llmCost.ratesForCall(price, usage.input_tokens)));
}

// The most one attempt can cost: every second of audio at the documented token rate, the prompt allowance, and the
// whole output limit (Gemini counts thinking and the answer against it) at the dearer of the two rates. Infinity when
// it cannot be priced: such a call never fits the cap.
function worstCaseUsd(price, seconds) {
  const input = Math.ceil(seconds) * AUDIO_TOKENS_PER_SECOND + PROMPT_TOKENS_ALLOWANCE;
  const asAnswer = costOf(price, { input_tokens: input, output_tokens: MAX_TOKENS });
  const asThinking = costOf(price, { input_tokens: input, reasoning_tokens: MAX_TOKENS });
  return asAnswer == null || asThinking == null ? Infinity : Math.max(asAnswer, asThinking);
}

// Usage with real counts. The Gemini adapter returns an object of nulls when the reply has no usageMetadata.
const hasCounts = (usage) => Boolean(usage) && usage.input_tokens != null && usage.output_tokens != null;

// What an attempt cost. Usage the provider reported is priced. Anything else (a timeout, a refused or failed
// request, an answer with no usage counts) counts as the whole reserve: the figure may read high, never low.
function attemptCostUsd(price, usage, reserved) {
  return (hasCounts(usage) ? costOf(price, usage) : null) ?? reserved;
}

// The model's price, only when the table lists its audio input rate: a row with no audio rate was pulled before
// that rate was stored, or the feed does not say what audio costs, and either way the cap could read low.
async function priceOfModel(conn, model) {
  const price = llmCost.priceFor((await llmCost.loadPrices(conn)).map, model);
  // A long-prompt tier with no audio rate would bill its audio at its text rate, which may read low.
  if (!price || price.audioInput == null || (price.tiers || []).some((t) => t.audioInput == null)) return null;
  return Number.isFinite(worstCaseUsd(price, MAX_SECONDS)) ? price : null;
}

// The ET day's spend so far: what settled attempts cost plus what unsettled claims reserved.
async function daySpendUsd(conn, day) {
  const row = await conn(SPEND).where({ day }).select(conn.raw('COALESCE(SUM(COALESCE(spent_usd, reserved_usd)), 0) AS total')).first();
  return Number(row?.total) || 0;
}

// No record yet, or only a record of a recording the call no longer has (an adopted or replaced recording keeps the
// call's metadata, and the old audio's note does not describe the new audio). Only an object can take a record: the
// merge in recordPatch would turn any other jsonb value into an array, and a call whose record cannot be read back
// would be claimed, and paid for, on every tick.
const whereNoRecord = (qb) => qb.whereRaw(
  "jsonb_typeof(COALESCE(metadata, '{}'::jsonb)) = 'object'"
  + " AND (metadata->:key IS NULL OR (metadata->:key->>'recording_url') <> recording_url)",
  { key: METADATA_KEY },
);
const recordPatch = (conn, record) => conn.raw("COALESCE(metadata, '{}'::jsonb) || ?::jsonb", [JSON.stringify({ [METADATA_KEY]: record })]);

// A processed, recorded, ordinary call from the last two days with no record, oldest first.
function candidates(conn, now) {
  const since = new Date(now.getTime() - LOOKBACK_HOURS * 60 * 60 * 1000);
  return whereNoRecord(whereNotSandboxCall(conn('call_log')))
    .where('processing_status', 'processed')
    .where('created_at', '>=', since)
    .whereNull('processing_token')
    .whereRaw("NULLIF(btrim(recording_url), '') IS NOT NULL")
    .whereRaw('COALESCE(recording_duration_seconds, duration_seconds, 0) >= ?', [MIN_SECONDS])
    .whereRaw(NOT_CARD_FLAGGED_SQL)
    .orderBy('created_at', 'asc')
    .limit(BATCH)
    .select('id', 'recording_url', 'recording_duration_seconds', 'duration_seconds');
}

// A call's first and only record for its recording, written while it has none: two writers cannot both record, or
// both claim, a call. Every record names the recording it is about.
// A claim (`status: 'started'`) also repeats what must still be true of the call before its audio is sent.
async function writeFirstRecord(conn, call, record) {
  const query = whereNoRecord(conn('call_log').where({ id: call.id }));
  if (record.status === 'started') {
    whereNotSandboxCall(query)
      .where({ processing_status: 'processed', recording_url: call.recording_url })
      .whereNull('processing_token')
      .whereRaw(NOT_CARD_FLAGGED_SQL);
  }
  return (await query.update({ metadata: recordPatch(conn, { ...record, recording_url: call.recording_url }) })) > 0;
}

// Claim the call and reserve its worst cost in one transaction. Returns the spend row's id, or null when the claim
// was lost (another writer, or the call changed).
async function claimCall(conn, call, claim) {
  return conn.transaction(async (trx) => {
    if (!(await writeFirstRecord(trx, call, claim))) return null;
    const [row] = await trx(SPEND).insert({ call_id: call.id, day: claim.day, reserved_usd: claim.reserved_usd }).returning('id');
    return row?.id ?? row;
  });
}

// Ask the model about a claimed call and put the outcome in place of the claim.
async function listen(conn, call, audio, claim, price) {
  const heard = await hear(audio);
  // The claim on this recording: a recording swapped in during the model call is not the audio that was heard.
  const claimed = () => conn('call_log').where({ id: call.id, recording_url: call.recording_url })
    .whereRaw("metadata->:key->>'status' = 'started'", { key: METADATA_KEY });
  if (heard.reason === 'no_key') {
    // Nothing was sent, so nothing is owed and the call keeps its turn. No call after it could be sent either.
    await claimed().update({ metadata: conn.raw('metadata - ?::text', [METADATA_KEY]) });
    await conn(SPEND).where({ id: claim.spendId }).del();
    throw new Error('no Gemini API key: no recording was sent');
  }
  const outcome = heard.note
    ? { status: 'done', note: heard.note, model: heard.model, prompt_version: PROMPT_VERSION, usage: heard.usage }
    : { status: 'failed', reason: heard.reason };
  const spent = round6(attemptCostUsd(price, heard.usage, claim.reserved_usd));
  // The spend is settled whatever happens to the call row: Google billed the attempt either way.
  await conn(SPEND).where({ id: claim.spendId }).update({ spent_usd: spent, settled_at: conn.fn.now() });
  const record = { ...outcome, spent_usd: spent, day: claim.day, at: claim.at, recording_url: call.recording_url };
  const saved = await claimed().update({ metadata: recordPatch(conn, record) });
  if (!saved) logger.warn(`[call-sound-check] outcome not saved for call ${call.id}: its claim was gone after the model call`);
  return outcome.status;
}

/**
 * Check one candidate. Returns what happened: 'done', 'failed', 'skipped' (a record that ends the call's turn with no
 * model call, or a claim another writer won) or 'capped' (no room left in the day; nothing written).
 */
// The ET day an attempt is charged to, read from the clock at that moment, and what that day has spent so far.
async function dayNow(conn, clock) {
  const at = clock();
  const day = etDateString(at);
  return { day, at: at.toISOString(), room: DAILY_CAP_USD - (await daySpendUsd(conn, day)) };
}

async function checkOne(conn, call, ctx) {
  const first = await dayNow(conn, ctx.clock);
  const end = async (status, reason) => {
    await writeFirstRecord(conn, call, { status, reason, day: first.day, at: first.at });
    return status;
  };
  const rowSeconds = Number(call.recording_duration_seconds) || Number(call.duration_seconds) || 0;
  if (!/\.mp3$/i.test(String(call.recording_url))) return end('skipped', 'not_mp3');
  // The download sends the Twilio account's credentials, so only the one exact Twilio URL is fetched, over https.
  const url = canonicalTwilioRecordingUrl(call.recording_url);
  if (!url) return end('skipped', 'not_twilio_url');
  if (rowSeconds > MAX_SECONDS) return end('skipped', 'too_long');
  // Nothing is downloaded for a call the day has no room for.
  if (worstCaseUsd(ctx.price, rowSeconds) > first.room) return 'capped';

  let audio;
  try {
    audio = await ctx.download(url, rowSeconds);
  } catch (err) {
    logger.warn(`[call-sound-check] download failed for call ${call.id}: ${String(err.message).slice(0, 120)}`);
    return end('failed', 'download_failed');
  }
  // The audio itself says how long it is; with no readable frame header, the lowest MP3 bitrate (8 kbps) bounds it.
  const seconds = Math.max(rowSeconds, ctx.audioSeconds(audio) ?? audio.length / 1000);
  if (audio.length > MAX_AUDIO_BYTES || seconds > MAX_SECONDS) return end('skipped', 'too_long');
  const reserved = worstCaseUsd(ctx.price, seconds);
  // The claim is charged to the day it is written in: a tick or a download can run past midnight ET.
  const now = await dayNow(conn, ctx.clock);
  if (reserved > now.room) return 'capped';

  const claim = { status: 'started', reserved_usd: round6(reserved), day: now.day, at: now.at };
  const spendId = await claimCall(conn, call, claim);
  if (spendId == null) return 'skipped';
  return listen(conn, call, audio, { ...claim, spendId }, ctx.price);
}

/**
 * One pass (scheduler: every 5 minutes, inside runExclusive). `download` and `audioSeconds` are the pipeline's
 * recording download and its MP3 length estimate; tests pass their own.
 */
async function runCallSoundCheck({ conn = db, now, clock, download, audioSeconds } = {}) {
  if (!callSoundCheckLive()) return { skipped: true, reason: 'gated_off' };
  const model = MODELS.ROUTES.callSoundCheck.model;
  const price = await priceOfModel(conn, model);
  if (!price) throw new Error(`no usable price for ${model}: the daily cap cannot be kept, so no call is made`);
  const pipeline = () => require('./call-recording-processor');
  // `clock` is read before each claim; a fixed `now` (tests) stands for every read.
  const readClock = clock || (now ? () => now : () => new Date());
  const ctx = {
    price,
    clock: readClock,
    // With the call's length the pipeline's download refuses a cut-off file, so the model never judges half a call.
    download: download || ((url, expectedSeconds) => pipeline().downloadRecording(url, { expectedSeconds })),
    audioSeconds: audioSeconds || ((buffer) => pipeline().estimateMp3DurationSeconds(buffer)),
  };
  const tally = { done: 0, failed: 0, skipped: 0, capped: 0 };
  for (const call of await candidates(conn, readClock())) {
    const kind = await checkOne(conn, call, ctx);
    tally[kind] += 1;
    // No room for this call today: it and the calls after it wait for the next ET day, oldest first, or age out.
    if (kind === 'capped') break;
  }
  if (tally.done || tally.failed || tally.skipped || tally.capped) logger.info(`[call-sound-check] tick: ${JSON.stringify(tally)}`);
  return tally;
}

module.exports = {
  runCallSoundCheck,
  hear,
  METADATA_KEY,
  DAILY_CAP_USD,
  // exported for tests
  normalizeNote,
  worstCaseUsd,
};
