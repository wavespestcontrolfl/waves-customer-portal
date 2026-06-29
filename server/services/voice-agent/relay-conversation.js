/**
 * RelayConversation — the Claude tool-use loop behind one ConversationRelay call.
 *
 * One instance per phone call. Twilio sends transcribed caller turns as `prompt`
 * frames; we run a streaming Claude tool-use loop and hand the reply text back
 * for Twilio to speak. Phase 0 scope: capture-only (see relay-tools.js) — no
 * quoting, no booking, no schedule mutation.
 *
 * Model: MODELS.VOICE — the repo's warm customer-facing tier (CLAUDE.md: never
 * hardcode model IDs; concrete IDs live only in server/config/models.js).
 * Overridable via VOICE_RELAY_MODEL.
 * Thinking is DISABLED: this is a live phone call where a "thinking" pause reads
 * as dead air; tool-use + a tight system prompt carry the structure instead.
 * Streaming (.stream + .finalMessage) per the claude-api skill — avoids HTTP
 * timeouts and lets us abort cleanly on barge-in.
 */

const Anthropic = require('@anthropic-ai/sdk');
const MODELS = require('../../config/models');
const db = require('../../models/db');
const logger = require('../logger');
const { toE164, isLikelyE164 } = require('../../utils/phone');
const { createLeadFromExtraction } = require('../lead-from-extraction');
const { syncVoiceMessageForCall } = require('../conversations');
const { TOOLS, executeTool } = require('./relay-tools');

const MODEL = process.env.VOICE_RELAY_MODEL || MODELS.VOICE;
const MAX_TOOL_ROUNDS = 6; // safety cap on tool_use loops per caller turn
const MAX_CALL_TURNS = 40; // safety cap on total caller turns for one call
const STREAM_TIMEOUT_MS = 20000; // bound a single model stream so it can't hang
const MAX_TOKENS = 1024; // voice replies are short

let anthropic = null;
try {
  anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
} catch {
  anthropic = null;
}

const SYSTEM_PROMPT = [
  'You are the phone assistant for Waves Pest Control & Lawn Care, a family-owned',
  'company in southwest Florida (Manatee, Sarasota, and Charlotte counties).',
  'You are answering a real, live phone call. The caller hears your words spoken aloud.',
  '',
  'YOUR JOB on this call is to understand why they are calling, offer real open',
  'appointment windows when they want to know your availability, and capture their',
  'information so a Waves team member can confirm. What you CAN and CANNOT do:',
  '- You CAN look up genuine open times with the get_availability and find_slots tools',
  '  once you have the service address or at least the city/ZIP.',
  '- You CANNOT confirm or reserve an appointment, and you cannot take payment. Offering a',
  '  time is not booking it — a Waves team member calls back to lock it in. Say so.',
  '- You CANNOT quote prices. If asked, say a team member will go over pricing on the callback.',
  '',
  'How to talk:',
  '- Keep every reply to one or two short sentences. This is a phone call, not an essay.',
  '- Be warm, plain-spoken, and efficient. No corporate filler.',
  '- Gather, conversationally: their name, the service address or ZIP, and what is going on',
  '  (the pest or lawn problem). The address/ZIP is also what lets you look up open times.',
  '- ONLY state appointment times that a tool actually returned. Never invent or guess a',
  '  time, date, or that a slot is held. If a tool returns no times, say a team member will',
  '  call to find one.',
  '',
  'Before you end the call, you MUST call the capture_lead tool with everything you gathered',
  '(a brief call_summary is required; include any time they picked in preferred_date_time).',
  'After it succeeds, tell the caller a Waves team member will follow up shortly to confirm,',
  'then say goodbye.',
].join('\n');

class RelayConversation {
  constructor({ callSid, from, to, language, send, endSession }) {
    this.callSid = callSid || null;
    this.from = from || null;
    this.to = to || null;
    this.language = language || null;
    this._send = typeof send === 'function' ? send : () => {};
    this._endSession = typeof endSession === 'function' ? endSession : null;
    this.messages = [];
    this.ended = false;
    this.leadCaptured = false;
    this._ending = false; // set once we've decided to end the relay session
    this._controller = null;
    this._chain = Promise.resolve(); // serializes overlapping prompts
    this._userTurns = [];
    this._startedAt = Date.now(); // for the AI-handled leg duration on reconcile
  }

  /**
   * After the model finishes a turn: if the lead is already captured, the agent
   * has delivered its closing line, so proactively end the ConversationRelay
   * session (send the end frame) instead of leaving the caller in silence until
   * they hang up. Idempotent. NOTE: whether the end frame lets the final goodbye
   * TTS finish first is version-dependent — verify on the first live call (same
   * caveat as relay-protocol.parsePrompt).
   */
  _maybeEndAfterTurn() {
    if (!this.leadCaptured || !this._endSession || this._ending) return;
    this._ending = true;
    try {
      this._endSession({ reason: 'agent_complete', captured: true });
    } catch (e) {
      logger.error(`[voice-relay] endSession failed callSid=${this.callSid}: ${e.message}`);
    }
  }

  /** Speak a line to the caller (no-op on empty). */
  say(text) {
    const t = String(text || '').trim();
    if (t) this._send(t);
  }

  /** Handle one transcribed caller turn. Serialized so turns never interleave. */
  handlePrompt(text) {
    const t = String(text || '').trim();
    if (!t || this.ended || this._ending) return this._chain;
    // Per-call cap on total caller turns. MAX_TOOL_ROUNDS bounds the tool loop
    // WITHIN a turn; this bounds the NUMBER of turns so a never-ending or abusive
    // call (or a leaked ws key) can't drive the model — and spend Anthropic
    // tokens — without limit. End gracefully rather than going silent.
    if (this._userTurns.length >= MAX_CALL_TURNS) {
      if (!this._ending) {
        logger.warn(`[voice-relay] call turn cap (${MAX_CALL_TURNS}) reached callSid=${this.callSid} — ending`);
        this.say('A Waves team member will follow up with you shortly to take care of this. Thanks for calling!');
        this._ending = true;
        try {
          if (this._endSession) this._endSession({ reason: 'turn_cap', captured: this.leadCaptured });
        } catch (e) {
          logger.error(`[voice-relay] endSession (turn cap) failed callSid=${this.callSid}: ${e.message}`);
        }
      }
      return this._chain;
    }
    this._userTurns.push(t);
    // Append the turn to the shared transcript INSIDE the serialized chain —
    // right before the loop that handles it — so a turn that arrives while a
    // prior _runLoop is still in flight can't be inserted ahead of that loop's
    // assistant/tool_result messages and corrupt the conversation order.
    this._chain = this._chain.then(() => {
      if (this.ended) return undefined;
      this.messages.push({ role: 'user', content: t });
      return this._runLoop();
    }).catch((e) => {
      logger.error(`[voice-relay] loop error callSid=${this.callSid}: ${e.message}`);
    });
    return this._chain;
  }

  /** Caller barged in over the agent's speech — abort the in-flight generation. */
  interrupt() {
    try {
      if (this._controller) this._controller.abort();
    } catch {
      /* no-op */
    }
  }

  async _runLoop() {
    if (this.ended || !anthropic) {
      if (!anthropic) this.say('Sorry, I am unable to help right now. A team member will call you back.');
      return;
    }
    const toolCtx = {
      from: this.from,
      to: this.to,
      callSid: this.callSid,
      language: this.language,
      markCaptured: () => {
        this.leadCaptured = true;
      },
    };

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      if (this.ended) return;
      this._controller = new AbortController();
      let msg;
      // Bound the model stream: without this a hung upstream call would pin the
      // serialized turn chain open with no recovery. On timeout we abort the
      // same controller barge-in uses, then surface a graceful reprompt.
      let streamTimedOut = false;
      const streamTimer = setTimeout(() => {
        streamTimedOut = true;
        try { this._controller.abort(); } catch { /* no-op */ }
      }, STREAM_TIMEOUT_MS);
      try {
        const stream = anthropic.messages.stream(
          {
            model: MODEL,
            max_tokens: MAX_TOKENS,
            system: SYSTEM_PROMPT,
            thinking: { type: 'disabled' },
            tools: TOOLS,
            messages: this.messages,
          },
          { signal: this._controller.signal }
        );
        msg = await stream.finalMessage();
      } catch (err) {
        if (streamTimedOut) {
          logger.warn(`[voice-relay] model stream timeout (${STREAM_TIMEOUT_MS}ms) callSid=${this.callSid}`);
          this.say('Sorry, that took a moment — could you say that again?');
          return;
        }
        if (this._controller.signal.aborted) return; // barge-in; caller is talking
        logger.error(`[voice-relay] anthropic error callSid=${this.callSid}: ${err.message}`);
        this.say('Sorry, I had trouble there. Could you say that again?');
        return;
      } finally {
        clearTimeout(streamTimer);
      }

      this.messages.push({ role: 'assistant', content: msg.content });

      const text = msg.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join(' ')
        .trim();
      if (text) this.say(text);

      if (msg.stop_reason === 'tool_use') {
        const results = [];
        for (const block of msg.content) {
          if (block.type !== 'tool_use') continue;
          const out = await executeTool(block.name, block.input, toolCtx);
          results.push({ type: 'tool_result', tool_use_id: block.id, content: out });
        }
        this.messages.push({ role: 'user', content: results });
        continue; // let the model respond to the tool result
      }
      this._maybeEndAfterTurn(); // lead captured + agent done → end the call
      return; // end_turn
    }
    logger.warn(`[voice-relay] hit MAX_TOOL_ROUNDS callSid=${this.callSid}`);
  }

  /**
   * Call ended (caller hung up or session closed). Capture floor: if the model
   * never managed to call capture_lead but we have a real caller number, write a
   * minimal lead so this call still produces a follow-up — preserving exactly
   * the value the current capture-only agent guarantees.
   */
  async end(reason) {
    if (this.ended) return;
    this.ended = true;
    this.interrupt();

    // Drain the serialized prompt/tool chain BEFORE the capture floor runs. If
    // the caller hung up while executeTool('capture_lead') was mid-write, this
    // lets it finish and set leadCaptured first — otherwise the floor below
    // could start a second createLeadFromExtraction (not idempotent on callSid)
    // and duplicate the lead. interrupt() already aborted any in-flight Claude
    // stream, and queued turns early-return once `ended` is set, so this settles
    // promptly.
    try { await this._chain; } catch { /* per-turn loop errors are already logged */ }

    // Reconcile call reporting: this call was handled by the AI agent, not
    // voicemail. The /voice answers-first and /call-complete backstop paths
    // leave the row at a non-final status ('ringing' / 'no-answer') with a
    // stale duration; stamp the FINAL completed status + the AI-handled leg
    // duration + outcome here (mirroring the /agent-fallback path) so these
    // calls don't linger as ringing/no-answer/null, then resync the unified
    // message row. Keyed by CallSid — a no-op (0 rows) for the TwiML-Bin
    // sandbox path, which has no call_log row.
    if (this.callSid) {
      try {
        // RACE: end() runs on EVERY WebSocket close, including a relay failure
        // (rejected upgrade / WS error / transient disconnect). On failure Twilio
        // also hits /relay-complete, which stamps call_outcome='voicemail' as the
        // terminal fallback. Those two writes race, and end() can land last —
        // overwriting the voicemail fallback with an optimistic 'ai_handled'.
        // Guard so the failure path always wins: skip the row only when
        // /relay-complete already wrote call_outcome='voicemail'. The handoff
        // clears call_outcome to NULL before the relay leg, and a bare
        // `whereNot('call_outcome','voicemail')` does NOT match NULL in SQL
        // (NULL <> 'voicemail' is NULL, not true) — which would strand every
        // SUCCESSFUL call at ringing/null. So match NULL OR not-voicemail. In the
        // reverse ordering, /relay-complete's unconditional failure write still
        // overwrites this ai_handled. ('voicemail' here can only mean a real
        // failure, since the leg started at NULL.)
        await db('call_log')
          .where('twilio_call_sid', this.callSid)
          .where((q) => q.whereNull('call_outcome').orWhereNot('call_outcome', 'voicemail'))
          .update({
            status: 'completed',
            answered_by: 'ai_agent',
            call_outcome: 'ai_handled',
            duration_seconds: Math.max(0, Math.round((Date.now() - this._startedAt) / 1000)),
            updated_at: new Date(),
          });
        await syncVoiceMessageForCall(this.callSid); // awaited so a rejection is caught here, not floated
      } catch (err) {
        logger.warn(`[voice-relay] outcome reconcile failed callSid=${this.callSid}: ${err.message}`);
      }
    }

    // Normalize to E.164 and persist the normalized value (the voice-agent lead
    // contract requires a valid E.164 — isLikelyE164 alone accepts bare digits),
    // matching capture_lead in relay-tools.
    const callerPhone = toE164(this.from || '');
    if (this.leadCaptured || !isLikelyE164(callerPhone)) return;
    try {
      await createLeadFromExtraction(
        {
          call_summary:
            'Inbound voice call (auto-captured on hangup). ' +
            (this._userTurns.length ? `Caller said: ${this._userTurns.join(' | ').slice(0, 600)}` : 'No transcript captured.'),
          requested_service: null,
        },
        { phone: callerPhone, toPhone: this.to, callSid: this.callSid, language: this.language }
      );
      logger.info(`[voice-relay] capture-floor lead written callSid=${this.callSid} reason=${reason || 'end'}`);
    } catch (err) {
      logger.error(`[voice-relay] capture-floor failed callSid=${this.callSid}: ${err.message}`);
    }
  }
}

module.exports = { RelayConversation, SYSTEM_PROMPT, MODEL };
