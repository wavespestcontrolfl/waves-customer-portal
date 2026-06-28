/**
 * RelayConversation — the Claude tool-use loop behind one ConversationRelay call.
 *
 * One instance per phone call. Twilio sends transcribed caller turns as `prompt`
 * frames; we run a streaming Claude tool-use loop and hand the reply text back
 * for Twilio to speak. Phase 0 scope: capture-only (see relay-tools.js) — no
 * quoting, no booking, no schedule mutation.
 *
 * Model: MODELS.VOICE (claude-sonnet-4-6) — the repo's warm customer-facing
 * tier (CLAUDE.md: never hardcode model IDs). Overridable via VOICE_RELAY_MODEL.
 * Thinking is DISABLED: this is a live phone call where a "thinking" pause reads
 * as dead air; tool-use + a tight system prompt carry the structure instead.
 * Streaming (.stream + .finalMessage) per the claude-api skill — avoids HTTP
 * timeouts and lets us abort cleanly on barge-in.
 */

const Anthropic = require('@anthropic-ai/sdk');
const MODELS = require('../../config/models');
const logger = require('../logger');
const { isLikelyE164 } = require('../../utils/phone');
const { createLeadFromExtraction } = require('../lead-from-extraction');
const { TOOLS, executeTool } = require('./relay-tools');

const MODEL = process.env.VOICE_RELAY_MODEL || MODELS.VOICE;
const MAX_TOOL_ROUNDS = 6; // safety cap on tool_use loops per caller turn
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
  constructor({ callSid, from, to, language, send }) {
    this.callSid = callSid || null;
    this.from = from || null;
    this.to = to || null;
    this.language = language || null;
    this._send = typeof send === 'function' ? send : () => {};
    this.messages = [];
    this.ended = false;
    this.leadCaptured = false;
    this._controller = null;
    this._chain = Promise.resolve(); // serializes overlapping prompts
    this._userTurns = [];
  }

  /** Speak a line to the caller (no-op on empty). */
  say(text) {
    const t = String(text || '').trim();
    if (t) this._send(t);
  }

  /** Handle one transcribed caller turn. Serialized so turns never interleave. */
  handlePrompt(text) {
    const t = String(text || '').trim();
    if (!t || this.ended) return this._chain;
    this._userTurns.push(t);
    this.messages.push({ role: 'user', content: t });
    this._chain = this._chain.then(() => this._runLoop()).catch((e) => {
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
        if (this._controller.signal.aborted) return; // barge-in; caller is talking
        logger.error(`[voice-relay] anthropic error callSid=${this.callSid}: ${err.message}`);
        this.say('Sorry, I had trouble there. Could you say that again?');
        return;
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
    if (this.leadCaptured || !isLikelyE164(this.from || '')) return;
    try {
      await createLeadFromExtraction(
        {
          call_summary:
            'Inbound voice call (auto-captured on hangup). ' +
            (this._userTurns.length ? `Caller said: ${this._userTurns.join(' | ').slice(0, 600)}` : 'No transcript captured.'),
          requested_service: null,
        },
        { phone: this.from, toPhone: this.to, callSid: this.callSid, language: this.language }
      );
      logger.info(`[voice-relay] capture-floor lead written callSid=${this.callSid} reason=${reason || 'end'}`);
    } catch (err) {
      logger.error(`[voice-relay] capture-floor failed callSid=${this.callSid}: ${err.message}`);
    }
  }
}

module.exports = { RelayConversation, SYSTEM_PROMPT, MODEL };
