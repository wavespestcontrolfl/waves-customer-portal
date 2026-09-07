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
// STRICTLY inside relay-conversation's WRITE_TOOL_TIMEOUT_MS (8000): the packet
// write, the no-context fallback write, and the say/end must all complete
// before the outer tool deadline, or the model hears "outcome unknown" and
// keeps talking while this function ends the call underneath it.
const PACKET_WRITE_TIMEOUT_MS = 4000;
const NO_CONTEXT_WRITE_TIMEOUT_MS = 1500;
const ABANDON_REVERT_TIMEOUT_MS = 1500;
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
  // PAN-scrubbed first (hook P0): the model can put anything in this field,
  // and it is persisted and spoken like the summary.
  const { scrubForStorage } = require('./relay-transcript');
  return String(scrubForStorage(String(value == null ? '' : value)) || '')
    .replace(/[^\p{L}\p{N}\s.'’-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NAME_MAX_CHARS);
}

/**
 * One flat line, no control/markup characters, at most `maxWords` words —
 * PAN-SCRUBBED FIRST (hook P0): the model's summary can echo a card number
 * the caller read out, and the packet is persisted (call_log.metadata) and
 * spoken (the staff whisper). Same scrubber the transcript takes.
 */
function lineClamp(value, maxWords) {
  const { scrubForStorage } = require('./relay-transcript');
  const flat = String(scrubForStorage(String(value == null ? '' : value)) || '')
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
    // This attempt's nonce: a write that times out but lands later is
    // recognized by the fallback as OUR packet (see writeHandoffPacket).
    attempt: require('crypto').randomUUID(),
    verification_tier: facts.verificationTier || 'unverified',
    caller_attested: facts.callerAttested === true,
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
 * not overwrite — ai_transferred INCLUDED, so one transfer per CallSid is
 * enforced by the row itself: a reconnected socket's second attempt matches
 * 0 rows and aborts (the session latch is only process-local). Returns the
 * row count (0 = already terminal / transferred, or owned elsewhere).
 */
async function writeHandoffPacket(db, { callSid, packet, fence = (q) => q, terminal = [] }) {
  // Attempt-fenced (codex r2 P1): Promise.race cannot cancel a queued
  // UPDATE, so a write classified as timed out may still land. The row is
  // matched when it is not yet terminal OR when it is ai_transferred and
  // already carries THIS attempt's packet — and in that second case the statement leaves the
  // packet as it is (the fallback then confirms the earlier write instead
  // of refusing it). The returned context_available says which landed.
  const attempt = String(packet && packet.attempt ? packet.attempt : '');
  // A CLOSED call is never a transfer target either (hook P1): ai_handled is
  // what the close reconcile / /call-complete backstop write, so a queued
  // UPDATE that executes after the caller hung up matches 0 rows.
  const notTransferable = [...new Set([...terminal, 'ai_handled'])];
  const q = db('call_log')
    .where('twilio_call_sid', callSid)
    // …nor a call /call-status already closed (status terminal, outcome
    // still NULL — the caller hung up while this UPDATE was queued): the
    // compensating revert is best-effort, this fence is not (codex r5 P1).
    .whereRaw("(status IS NULL OR status NOT IN ('completed', 'failed', 'busy', 'no-answer', 'canceled'))")
    .where((w) => w
      .where((n) => n.whereNull('call_outcome').orWhereNotIn('call_outcome', notTransferable))
      // …restricted to a row still in the transfer's own state: a later
      // terminal outcome (voicemail after an unconfirmed ring) is preserved
      // even when the timed-out full write executes after it (hook P1).
      .orWhere((a) => a.where('call_outcome', 'ai_transferred').whereRaw("(metadata->'relay_handoff'->>'attempt') = ?", [attempt])));
  const rows = await fence(q).update({
    call_outcome: 'ai_transferred',
    metadata: db.raw(
      "CASE WHEN (metadata->'relay_handoff'->>'attempt') = ? THEN metadata ELSE COALESCE(metadata, '{}'::jsonb) || ?::jsonb END",
      [attempt, JSON.stringify({ relay_handoff: packet })],
    ),
    updated_at: new Date(),
  }, [db.raw("(metadata->'relay_handoff'->>'context_available') AS context_available")]);
  const list = Array.isArray(rows) ? rows : [];
  return { rows: Array.isArray(rows) ? rows.length : Number(rows) || 0, contextAvailable: list.length > 0 && String(list[0] && list[0].context_available) === 'true' };
}

/** Row count from a writeHandoff result (a count, or { rows, contextAvailable }). */
function writeRows(res) {
  if (res && typeof res === 'object') return Number(res.rows) || 0;
  return Number(res) || 0;
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
  if (!isTransferGateOn()) {
    // The live kill switch flipped mid-call (the frozen tool list still
    // carries the tool): refuse without a word about the office's hours
    // (codex r6 P2).
    return 'Transfer is not available on this call. Do NOT try again and do not say the office is open or closed. '
      + 'Offer a callback: take their details with capture_lead and say a Waves team member will call them back.';
  }
  if (officeOpen !== true) {
    return officeOpen === false
      ? 'Transfer is not available right now — the office is closed. Do NOT try again. Offer a callback: '
        + 'take their details with capture_lead and say a Waves team member will call them back when the office opens.'
      : 'Transfer is not available right now. Do NOT try again and do not say the office is open or closed. '
        + 'Offer a callback: take their details with capture_lead and say a Waves team member will call them back.';
  }
  if (typeof ctx.transferRequested === 'function' && ctx.transferRequested() === true) {
    return 'The transfer is already in progress. Say nothing further.';
  }
  if (typeof ctx.markTransferRequested === 'function') ctx.markTransferRequested();
  const facts = typeof ctx.handoffFacts === 'function' ? (ctx.handoffFacts() || {}) : {};
  const packet = buildHandoffPacket(input, facts);
  const { copy } = require('./relay-language');

  // A CONFIRMED durable write — the full packet, or the minimal no-context
  // stamp — is what authorizes the transfer: it proves this socket still
  // owns the row (the owner fence) and that /relay-complete's own
  // owner-bound ring claim will find it. 0 rows on either write = the
  // fence or the terminal guard refused (a reconnect took the call, or the
  // call is over); neither confirming = storage down. Both abort: a stale
  // socket must not end the replacement session, and an unconfirmed
  // transfer would only end in /relay-complete's voicemail fallback — the
  // callback offer below is the better outcome (hook P1s).
  const late = []; // UPDATEs that timed out but are still queued (Promise.race cannot cancel them)
  let wrote = await writePacketBounded(ctx, packet, late);
  let noContext = false;
  if (wrote === 'failed') {
    wrote = await recordNoContext(ctx, packet, facts, late);
    noContext = wrote === 'written'; // the minimal stamp is what landed
  }
  if (wrote !== 'written' && wrote !== 'reconciled') {
    ctx.toolFailed = true;
    logger.warn(`[voice-relay] transfer refused (${wrote}) — row not owned, already terminal, or storage unconfirmed callSid=${require('../twilio-failure-alerts').maskSid(ctx.callSid)}`);
    revertLateWrites(ctx, packet.attempt, late);
    return 'The transfer could not be started on this call. Do NOT try again — take their details with capture_lead '
      + 'and say a Waves team member will call them back.';
  }
  // The caller hung up while the write was in flight (codex r3 P1): the
  // socket is closed, no end frame can ring staff, and end() is waiting on
  // this very tool chain before it can stamp the close — so the row would
  // stay a transfer nobody rang. Undo the stamp (detached) and abort.
  if (typeof ctx.sessionEnded === 'function' && ctx.sessionEnded() === true) {
    ctx.toolFailed = true;
    logger.warn(`[voice-relay] transfer abandoned — session ended during the packet write callSid=${require('../twilio-failure-alerts').maskSid(ctx.callSid)}`);
    // AWAITED (bounded): end() resumes when this tool returns and reconciles
    // the row at once — a detached revert would race it (an ai_transferred
    // row skips the reconcile, a NULL one reached after the salvage loses the
    // transcript). 4s + 1.5s + 1.5s stays inside the 8s write-tool budget.
    if (typeof ctx.revertHandoff === 'function') {
      try {
        const res = await withTimeout(Promise.resolve(ctx.revertHandoff(packet.attempt)), ABANDON_REVERT_TIMEOUT_MS, 'timeout');
        if (res === 'timeout') logger.warn(`[voice-relay] abandoned-transfer revert unconfirmed (timeout) callSid=${require('../twilio-failure-alerts').maskSid(ctx.callSid)}`);
      } catch (err) {
        logger.warn(`[voice-relay] abandoned-transfer revert failed callSid=${require('../twilio-failure-alerts').maskSid(ctx.callSid)}: ${err.message}`);
      }
    }
    revertLateWrites(ctx, packet.attempt, late); // a timed-out full write landing after this revert is undone too
    return 'The call has ended. Do not say anything else and do not call any more tools.';
  }
  // Speak, then end the relay leg: /relay-complete reads reason 'transfer'
  // from the end frame and rings the office.
  if (typeof ctx.say === 'function') ctx.say(copy('transferring', facts.language));
  const sent = typeof ctx.endForTransfer === 'function' ? ctx.endForTransfer() : false;
  if (sent === false) {
    ctx.toolFailed = true;
    // The socket closed (or the send threw) between the ended check and
    // the end frame: no /relay-complete transfer callback will come, so the
    // stamp is undone the same way (codex r5 P1). Nothing rings.
    logger.warn(`[voice-relay] transfer end frame NOT sent — reverting the stamp callSid=${require('../twilio-failure-alerts').maskSid(ctx.callSid)}`);
    if (typeof ctx.revertHandoff === 'function') {
      try {
        await withTimeout(Promise.resolve(ctx.revertHandoff(packet.attempt)), ABANDON_REVERT_TIMEOUT_MS, 'timeout');
      } catch (err) {
        logger.warn(`[voice-relay] unsent-frame revert failed callSid=${require('../twilio-failure-alerts').maskSid(ctx.callSid)}: ${err.message}`);
      }
    }
    revertLateWrites(ctx, packet.attempt, late);
    return 'The transfer could not be started on this call. Do NOT try again — take their details with capture_lead '
      + 'and say a Waves team member will call them back.';
  }
  if (noContext) ringNoContextBell(ctx, facts);
  return 'Transferring the caller to the office now. Your part of the call is over — do not say anything else and do not call any more tools.';
}

/**
 * An ABORTED transfer whose timed-out UPDATE lands later (hook P1): the tool
 * still holds the promise, so when it resolves with a row the stamp is
 * reverted — the call never rang staff and must not report as transferred.
 * Detached (the caller's turn is already answered), fenced by the attempt
 * nonce and the empty ring claim, never throws.
 */
function revertLateWrites(ctx, attempt, late) {
  if (!late.length || typeof ctx.revertHandoff !== 'function') return;
  const { maskSid } = require('../twilio-failure-alerts');
  for (const pending of late) {
    void pending
      .then((res) => (writeRows(res) > 0 ? ctx.revertHandoff(attempt) : 0))
      .then((rows) => { if (rows > 0) logger.warn(`[voice-relay] late packet write reverted after an aborted transfer callSid=${maskSid(ctx.callSid)}`); })
      .catch((err) => logger.warn(`[voice-relay] late packet write revert failed callSid=${maskSid(ctx.callSid)}: ${err.message}`));
  }
}

/**
 * Undo THIS attempt's stamp on a row nobody rang: the outcome returns to
 * NULL (the live-call state the close reconcile / /call-complete backstop
 * settle) and the packet is dropped. A rung transfer is never touched.
 */
async function revertHandoffPacket(db, { callSid, attempt, fence = (q) => q }) {
  const rows = await fence(db('call_log')
    .where('twilio_call_sid', callSid)
    .where('call_outcome', 'ai_transferred')
    .whereRaw("(metadata->'relay_handoff'->>'attempt') = ?", [String(attempt || '')])
    .whereRaw("COALESCE(metadata->>'relay_transfer_ring_at', '') = ''"))
    .update({
      // A call that closed in the meantime (status completed by /call-status)
      // gets the AI-handled outcome the close would have written; a live
      // call returns to NULL for the close reconcile to settle.
      call_outcome: db.raw("CASE WHEN status = 'completed' THEN 'ai_handled' ELSE NULL END"),
      metadata: db.raw("metadata - 'relay_handoff'"),
      updated_at: new Date(),
    });
  return Number(rows) || 0;
}

/**
 * The bounded packet write: 'written' (a row took it), 'rejected' (0 rows —
 * the owner fence or the terminal guard refused), or 'failed' (a storage
 * error / timeout — the transfer proceeds without context). Never throws.
 */
async function writePacketBounded(ctx, packet, late = []) {
  if (typeof ctx.writeHandoff !== 'function') return 'failed';
  const { maskSid } = require('../twilio-failure-alerts');
  try {
    const pending = Promise.resolve(ctx.writeHandoff(packet));
    const res = await withTimeout(pending, PACKET_WRITE_TIMEOUT_MS, 'timeout');
    if (res === 'timeout') {
      late.push(pending);
      logger.warn(`[voice-relay] transfer packet write timed out callSid=${maskSid(ctx.callSid)} — confirming through the fallback`);
      return 'failed';
    }
    return writeRows(res) > 0 ? 'written' : 'rejected';
  } catch (err) {
    logger.error(`[voice-relay] transfer packet write failed callSid=${maskSid(ctx.callSid)}: ${err.message}`);
    return 'failed';
  }
}

/**
 * The packet did not land (storage failure / timeout): a second, minimal
 * UPDATE says so on the row (the office at least learns a summary existed)
 * — the transfer proceeds ONLY when that write confirms; the caller rings
 * the no-context bell once the transfer is committed. Returns the same
 * status vocabulary as writePacketBounded.
 */
async function recordNoContext(ctx, packet, facts, late = []) {
  let status = 'failed';
  try {
    const pending = Promise.resolve(ctx.writeHandoff({ ...packet, summary: null, unresolved_question: null, facts_collected: {}, tools: [], commitments: [], context_available: false }));
    const res = await withTimeout(pending, NO_CONTEXT_WRITE_TIMEOUT_MS, 'timeout');
    if (res === 'timeout') late.push(pending);
    else {
      // 'reconciled' = the earlier (timed-out) full write had landed: the
      // row carries THIS attempt's packet with context — no bell.
      if (writeRows(res) > 0) status = res && typeof res === 'object' && res.contextAvailable === true ? 'reconciled' : 'written';
      else status = 'rejected';
    }
  } catch { /* storage down: unconfirmed */ }
  return status;
}

/**
 * The no-context bell — rung by transferToOfficeText ONLY once the transfer
 * is committed (after the session-ended check and the end frame, codex r4
 * P2): a bell for a transfer that was then abandoned would tell staff a
 * caller was transferred who never was. Detached (never on the caller's
 * path or the tool budget) and DEDUPED per CallSid: a reconnect or a
 * repeated attempt on the same call re-uses the one bell (the
 * call-commitments watchdog pattern — notifyAdmin with a dedupeKey and
 * bell: true; the registry entry keeps the row tech-visible). Never on the
 * sandbox.
 */
function ringNoContextBell(ctx, facts) {
  if (ctx.sandbox === true) return;
  void Promise.resolve()
    .then(() => require('../notification-service').notifyAdmin(
      'alert',
      'Sandy transfer without context',
      `A caller${facts.from ? ` from ${require('./relay-protocol').maskPhone(facts.from)}` : ''} was transferred to the office but the call summary could not be saved — ask the caller to recap.`,
      {
        link: '/admin/communications#tab=calls',
        dedupeKey: `${NO_CONTEXT_BELL}:${ctx.callSid || 'unknown'}`,
        bell: true,
        metadata: { triggerKey: NO_CONTEXT_BELL, callSid: ctx.callSid || null },
      },
    ))
    .catch((err) => logger.warn(`[voice-relay] ${NO_CONTEXT_BELL} bell failed: ${err.message}`));
}

/**
 * The AI segment to keep ahead of a transferred call's recording transcript
 * (call-recording-processor). Qualified on the PERSISTED handoff packet
 * (metadata.relay_handoff) plus the relay transcript (metadata.relay_transcript,
 * else the relay-stamped columns) — never on the final outcome: a transfer nobody accepted ends as 'voicemail' through
 * /call-complete, and that voicemail's transcript must not erase the AI
 * conversation either. Anything else ⇒ null (today's overwrite).
 */
function composeRelaySegment(call) {
  if (!call) return null;
  let meta = call.metadata;
  if (typeof meta === 'string') { try { meta = JSON.parse(meta); } catch { meta = null; } }
  // Either durable transfer marker qualifies: the packet, or the ring claim
  // /relay-complete stamps even when both packet writes failed (hook P1).
  const transferred = meta && typeof meta === 'object'
    && ((meta.relay_handoff && typeof meta.relay_handoff === 'object') || Boolean(meta.relay_transfer_ring_at));
  // PR 2B: a RECONNECTED call that fell to voicemail (second failure,
  // transfer unavailable) carries no transfer marker but the same evidence
  // problem — its recording must not erase the composed relay transcript.
  const reconnected = meta && typeof meta === 'object' && (Number(meta.relay_reconnects) || 0) > 0;
  const registered = Array.isArray(meta?.relay_segment_owners) && meta.relay_segment_owners.length > 0;
  if (!transferred && !reconnected && !registered) return null;
  const { TRANSCRIPTION_PROVIDER } = require('./relay-transcript');
  // The durable copy first: end() stashes the relay transcript under
  // metadata.relay_transcript because the recording-status swap CLEARS the
  // transcript columns before the recording is transcribed (codex r1 P1).
  const stash = meta.relay_transcript && typeof meta.relay_transcript === 'object' ? meta.relay_transcript : null;
  let text = String((stash && stash.text) || '').trim();
  let tmeta = stash && stash.metadata && typeof stash.metadata === 'object' ? stash.metadata : null;
  if (!text) {
    if (call.transcription_provider === TRANSCRIPTION_PROVIDER) {
      text = String(call.transcription || '').trim();
      tmeta = call.transcription_metadata;
      if (typeof tmeta === 'string') { try { tmeta = JSON.parse(tmeta); } catch { tmeta = null; } }
    }
  }
  // PR 2B: the segments themselves are the third source — a resumed leg that
  // failed before any turn wrote no stash and the recording swap cleared the
  // columns, but every earlier socket appended its segment.
  if (!text && Array.isArray(meta.relay_segments)) {
    text = String(require('./relay-segments').segmentsText(meta.relay_segments) || '').trim();
    tmeta = null;
  }
  if (!text) return null;
  return {
    text: `[AI segment]\n${text}`,
    metadata: { ...(tmeta && typeof tmeta === 'object' ? tmeta : { provider: TRANSCRIPTION_PROVIDER }),
      ...require('./relay-segments').summarizeSegments(meta) },
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
  revertHandoffPacket,
  transferToOfficeText,
  sanitizeSpokenName,
  lineClamp,
};
