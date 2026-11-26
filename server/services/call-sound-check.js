'use strict';

/**
 * Call sound check: the model call (owner 2026-11-25 "both").
 *
 * A model LISTENS to one call recording and notes what a transcript cannot show: the customer's mood at the start
 * and at the end, whether the customer was upset, how often staff talked over the customer, whether staff sounded
 * rushed, and any risky claim staff made. `hear` makes that one call, checks the answer and returns the checked note.
 * The model's raw reply stays inside `hear`.
 *
 * Nothing calls `hear` yet. Every listen is a paid Gemini call (MODELS.ROUTES.callSoundCheck), so the job that picks
 * the calls comes as its own change, with a gate and a daily spend cap.
 */

const MODELS = require('../config/models');
const { dispatch, rejectCall } = require('./llm/call');
const { scrubPansDetailed } = require('../utils/pan-scrub');

const PROMPT_VERSION = 'sound-check-v1';
const MAX_TOKENS = 4096;
const TIMEOUT_MS = 120_000;
const TONE_MAX = 40;
const CLAIM_MAX = 240;

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

module.exports = {
  hear,
  // exported for tests
  normalizeNote,
};
