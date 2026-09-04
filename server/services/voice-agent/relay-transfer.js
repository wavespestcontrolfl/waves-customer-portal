/**
 * Sandy PR 2A — human handoff (office-hours transfer, after-hours callback).
 *
 * GATE: GATE_VOICE_RELAY_TRANSFER (exact 'true', read at call time — ships
 * dark). The `transfer_to_office` tool is registered for a session ONLY when
 * the gate is on AND the office is open right now (`officeOpenNow() === true`;
 * null = unknown counts as CLOSED, fail closed). Both are re-checked inside
 * the tool body, so a stale registered tool list can never ring staff after
 * hours. After hours the tool is absent and the prompt offers a callback
 * through capture_lead instead.
 *
 * THE PACKET IS SERVER-BUILT, NEVER FROM MODEL CLAIMS. The model supplies
 * intent / summary / caller_name / unresolved_question — the parts only it
 * knows — and every verification and provenance field comes from session
 * state through the tool ctx (a model-supplied `verification_tier` is
 * ignored). Written to call_log.metadata.relay_handoff with
 * call_outcome='ai_transferred' through the same owner-fenced UPDATE shape
 * end() uses; ai_transferred is TERMINAL for the reconcile (relay-protocol
 * RELAY_TERMINAL_OUTCOMES) so a socket close cannot rewrite it as ai_handled.
 *
 * TRANSFER NEVER WAITS ON THE PACKET. The write is bounded; on failure or
 * timeout the transfer still proceeds, `context_available: false` is
 * attempted as a second minimal UPDATE, and the sandy_transfer_no_context
 * bell tells the office the summary was unavailable. The staff leg itself is
 * rendered by /relay-complete from the relay's end-frame handoffData
 * (`reason: 'transfer'`), reusing the /voice staff simul-ring + press-1
 * screen. No summary and no id ever ride a URL: the whisper is read back
 * from the call_log row after press-1 (connectingAnnouncement).
 *
 * Sandbox sessions may run the tool (packet on their OWN row); /relay-complete
 * ?sandbox=1 hangs up instead of dialing staff, and no bell fires.
 */

const logger = require('../logger');

const TRANSFER_TOOL_NAME = 'transfer_to_office';
const WHISPER_MAX_WORDS = 20;
const SUMMARY_MAX_WORDS = 20;
const NAME_MAX_CHARS = 60;
const PACKET_WRITE_TIMEOUT_MS = 8000; // = relay-conversation WRITE_TOOL_TIMEOUT_MS
const NO_CONTEXT_BELL = 'sandy_transfer_no_context';

function isTransferGateOn() {
  // Exact 'true' — the same parser as the feature-gates listing, fail closed.
  return process.env.GATE_VOICE_RELAY_TRANSFER === 'true';
}

/** Tool registration rule: gate on AND the office is open right now (null = closed). */
function isTransferAvailable(officeOpen) {
  return isTransferGateOn() && officeOpen === true;
}

const TRANSFER_TOOLS = [
  {
    name: TRANSFER_TOOL_NAME,
    description:
      'Transfer the caller to a Waves team member RIGHT NOW (the office is open). Use it when the '
      + 'caller asks for a person, after two misunderstandings, for refund / cancellation / '
      + 'medical-exposure / legal / property-damage topics, or when a tool has failed twice. '
      + 'Say one short line first ("Let me get someone for you"), then call this — the call is '
      + 'handed to the office and your part ends. Pass a summary of at most twenty words.',
    input_schema: {
      type: 'object',
      properties: {
        intent: { type: 'string', description: 'Why they called, in a few words (e.g. "cancel service", "billing dispute", "wants a person")' },
        summary: { type: 'string', description: 'At most twenty words: what was discussed and what they need' },
        caller_name: { type: 'string', description: 'The caller\'s name as they gave it, if any' },
        unresolved_question: { type: 'string', description: 'The one thing you could not resolve, if any' },
      },
      required: ['intent', 'summary'],
    },
  },
];

/** Spoken-name sanitizer — same character class as the screen announcement. */
function sanitizeSpokenName(value) {
  return String(value == null ? '' : value)
    .replace(/[^\p{L}\p{N}\s.'’-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NAME_MAX_CHARS);
}

/** One flat line, no control/markup characters, at most `maxWords` words. */
function lineClamp(value, maxWords) {
  const flat = String(value == null ? '' : value)
    .replace(/[\r\n`"<>{}[\]]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!flat) return '';
  const words = flat.split(' ');
  return words.length > maxWords ? words.slice(0, maxWords).join(' ') : flat;
}

/**
 * The handoff packet — server state first, the model's four free-text
 * fields sanitized. `facts` is the session's tool-ctx snapshot
 * (relay-conversation handoffFacts()).
 */
function buildHandoffPacket(input = {}, facts = {}) {
  const tools = Array.isArray(facts.tools) ? facts.tools.map((t) => ({ name: String(t.name || '').slice(0, 40), ok: t.ok === true })) : [];
  const commitments = Array.isArray(facts.commitments) ? facts.commitments : [];
  return {
    verification_tier: facts.verificationTier || 'unverified',
    from: facts.from || null,
    language: facts.language || null,
    intent: lineClamp(input.intent, 12) || null,
    summary: lineClamp(input.summary, SUMMARY_MAX_WORDS) || null,
    caller_name: sanitizeSpokenName(input.caller_name) || null,
    facts_collected: facts.factsCollected && typeof facts.factsCollected === 'object' ? facts.factsCollected : {},
    tools,
    commitments,
    unresolved_question: lineClamp(input.unresolved_question, SUMMARY_MAX_WORDS) || null,
    turn_count: Number.isFinite(facts.turnCount) ? facts.turnCount : 0,
    misunderstanding_count: null, // PR 6
    transferred_at: new Date().toISOString(),
    context_available: true,
  };
}

/**
 * The staff whisper spoken after press-1: ≤20 words, sanitized, from the
 * persisted packet only. Missing packet or context_available false ⇒ the
 * generic line.
 */
function transferWhisper(handoff, fallbackName = '') {
  const generic = 'Sandy transfer. The caller requested assistance; the summary was unavailable.';
  if (!handoff || typeof handoff !== 'object' || handoff.context_available !== true) return generic;
  const name = sanitizeSpokenName(handoff.caller_name) || sanitizeSpokenName(fallbackName) || 'an unknown number';
  const intent = lineClamp(handoff.intent, 6);
  const unresolved = lineClamp(handoff.unresolved_question, 8);
  const body = intent ? `${intent}${unresolved ? `; ${unresolved}` : ''}` : (unresolved || 'requested assistance');
  const line = lineClamp(`Sandy transfer from ${name}: ${body}`, WHISPER_MAX_WORDS);
  return /[.!?]$/.test(line) ? line : `${line}.`;
}

/**
 * The owner-fenced packet write. `fence` is relay-conversation's owner fence
 * (a knex-builder decorator); `terminal` the outcome list a socket close may
 * not overwrite. Returns the row count (0 = the row is already terminal or
 * owned elsewhere).
 */
async function writeHandoffPacket(db, { callSid, packet, fence = (q) => q, terminal = [] }) {
  const q = db('call_log')
    .where('twilio_call_sid', callSid)
    .where((w) => w.whereNull('call_outcome').orWhereNotIn('call_outcome', terminal.filter((o) => o !== 'ai_transferred')));
  return fence(q).update({
    call_outcome: 'ai_transferred',
    metadata: db.raw("COALESCE(metadata, '{}'::jsonb) || ?::jsonb", [JSON.stringify({ relay_handoff: packet })]),
    updated_at: new Date(),
  });
}

function withTimeout(promise, ms, fallback) {
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * The tool body. ctx (relay-conversation _buildToolCtx) supplies:
 *   officeOpenNow(), sandbox, callSid, say(text), endForTransfer(),
 *   handoffFacts(), writeHandoff(packet) (the owner-fenced UPDATE),
 *   transferRequested()/markTransferRequested().
 */
async function transferToOfficeText(input = {}, ctx = {}) {
  const officeOpen = typeof ctx.officeOpenNow === 'function' ? ctx.officeOpenNow() : null;
  if (!isTransferAvailable(officeOpen)) {
    return 'Transfer is not available right now — the office is closed. Do NOT try again. Offer a callback: '
      + 'take their details with capture_lead and say a Waves team member will call them back when the office opens.';
  }
  if (typeof ctx.transferRequested === 'function' && ctx.transferRequested() === true) {
    return 'The transfer is already in progress. Say nothing further.';
  }
  if (typeof ctx.markTransferRequested === 'function') ctx.markTransferRequested();
  const facts = typeof ctx.handoffFacts === 'function' ? (ctx.handoffFacts() || {}) : {};
  const packet = buildHandoffPacket(input, facts);
  const { copy } = require('./relay-language');

  const wrote = await writePacketBounded(ctx, packet);
  if (wrote === 'rejected') {
    // 0 rows = the owner fence or the terminal guard refused: this socket no
    // longer owns the call (a reconnect took the claim) or the call is
    // already over. A stale socket must not end the replacement session or
    // ring staff — abort, and the model is told not to retry.
    logger.warn(`[voice-relay] transfer refused — row not owned or already terminal callSid=${require('../twilio-failure-alerts').maskSid(ctx.callSid)}`);
    return 'The transfer could not be started on this call. Do NOT try again — take their details with capture_lead '
      + 'and say a Waves team member will call them back.';
  }
  if (wrote !== 'written') await recordNoContext(ctx, packet, facts);
  // Speak, then end the relay leg: /relay-complete reads reason 'transfer'
  // from the end frame and rings the office.
  if (typeof ctx.say === 'function') ctx.say(copy('transferring', facts.language));
  if (typeof ctx.endForTransfer === 'function') ctx.endForTransfer();
  return 'Transferring the caller to the office now. Your part of the call is over — do not say anything else and do not call any more tools.';
}

/**
 * The bounded packet write: 'written' (a row took it), 'rejected' (0 rows —
 * the owner fence or the terminal guard refused), or 'failed' (a storage
 * error / timeout — the transfer proceeds without context). Never throws.
 */
async function writePacketBounded(ctx, packet) {
  if (typeof ctx.writeHandoff !== 'function') return 'failed';
  const { maskSid } = require('../twilio-failure-alerts');
  try {
    const rows = await withTimeout(Promise.resolve(ctx.writeHandoff(packet)), PACKET_WRITE_TIMEOUT_MS, 'timeout');
    if (rows === 'timeout') {
      logger.warn(`[voice-relay] transfer packet write timed out callSid=${maskSid(ctx.callSid)} — transferring without context`);
      return 'failed';
    }
    return Number(rows) > 0 ? 'written' : 'rejected';
  } catch (err) {
    logger.error(`[voice-relay] transfer packet write failed callSid=${maskSid(ctx.callSid)}: ${err.message}`);
    return 'failed';
  }
}

/**
 * The packet did not land: a second, minimal UPDATE says so on the row (the
 * office at least learns a summary existed) and the no-context bell rings —
 * never on the sandbox. Bounded, best-effort, never blocks the transfer.
 */
async function recordNoContext(ctx, packet, facts) {
  try {
    await withTimeout(Promise.resolve(ctx.writeHandoff({ ...packet, summary: null, unresolved_question: null, facts_collected: {}, tools: [], commitments: [], context_available: false })), 2000, 'timeout');
  } catch { /* the bell below is the record */ }
  if (ctx.sandbox === true) return;
  try {
    const { triggerNotification } = require('../notification-triggers');
    await triggerNotification(NO_CONTEXT_BELL, { callSid: ctx.callSid || null, from: facts.from || null });
  } catch (err) {
    logger.warn(`[voice-relay] ${NO_CONTEXT_BELL} bell failed: ${err.message}`);
  }
}

/**
 * The AI segment to keep ahead of a transferred call's staff-leg transcript
 * (call-recording-processor). Only a row the relay itself transcribed
 * (transcription_provider 'conversation_relay') with call_outcome
 * 'ai_transferred' qualifies; anything else ⇒ null (today's overwrite).
 */
function composeRelaySegment(call) {
  if (!call || call.call_outcome !== 'ai_transferred') return null;
  const { TRANSCRIPTION_PROVIDER } = require('./relay-transcript');
  if (call.transcription_provider !== TRANSCRIPTION_PROVIDER) return null;
  const text = String(call.transcription || '').trim();
  if (!text) return null;
  let meta = call.transcription_metadata;
  if (typeof meta === 'string') { try { meta = JSON.parse(meta); } catch { meta = null; } }
  return {
    text: `[AI segment]\n${text}`,
    metadata: meta && typeof meta === 'object' ? meta : { provider: TRANSCRIPTION_PROVIDER },
  };
}

module.exports = {
  composeRelaySegment,
  TRANSFER_TOOL_NAME,
  TRANSFER_TOOLS,
  WHISPER_MAX_WORDS,
  NO_CONTEXT_BELL,
  isTransferGateOn,
  isTransferAvailable,
  buildHandoffPacket,
  transferWhisper,
  writeHandoffPacket,
  transferToOfficeText,
  sanitizeSpokenName,
  lineClamp,
};
