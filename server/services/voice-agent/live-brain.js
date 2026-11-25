/**
 * The brain behind the GPT-Live trial line's client delegations
 * (GATE_VOICE_GPT_LIVE_TOOLS, owner 2026-11-24 "ok lets give it read and write").
 *
 * One RelayConversation (Sandy's own Claude/OpenAI agent and its 16 tools) per
 * call, always built with sandbox: true. The conversation runs as it does on
 * the ConversationRelay sandbox line: reads (account, visits, open times,
 * prices, invoices, estimates) run for real, and writes (capture_lead,
 * request_booking, request_reservice) are answered without running. The
 * bridge (live-bridge.js) feeds it the caller's words and speaks its reply
 * through GPT-Live.
 *
 * What RelayConversation hands its `send` is not a JSON frame: relay-server
 * wraps it. `send(token, last)` gets a string of speech and whether it ends
 * the utterance (relay-server builds {type:'text', token, last} from it), and
 * `endSession(handoffData)` gets an object (relay-server builds the {type:'end'}
 * frame). A turn is over when handlePrompt()'s promise settles; every token
 * sent before then is the turn's reply.
 *
 * Nothing here transfers the call: the end/handoff callback answers false
 * ("not sent"), so no tool claims a transfer or a hangup it did not do.
 *
 * The close does not run RelayConversation.end(). end() writes the call's
 * transcript (the caller's words) into call_log, stamps the row ai_handled and
 * completed, syncs a message row and records commitments: the bridge's own
 * promise is that the trial line stores no words, and the bridge owns the
 * row's close. end() here stops the conversation and writes nothing.
 *
 * Logging: callSid, codes and timings only, never the caller's words or the
 * reply.
 */

const logger = require('../logger');

// An ask that is not done at SOFT_DEADLINE_MS tells its caller (onSoft) and keeps
// waiting: the real answer still goes out when it lands. At ASK_DEADLINE_MS it
// is given up and TIMEOUT_REPLY is the answer.
const SOFT_DEADLINE_MS = 6000;
const ASK_DEADLINE_MS = 20000;
// Spoken at the hard deadline: GPT-Live paraphrases it and the call goes on.
const TIMEOUT_REPLY = "I'll have the office confirm that for you.";
const CLOSED_REPLY = "I can't check that right now.";

function errCode(err) {
  return String((err && (err.code || err.name)) || 'error').replace(/[^\w.-]/g, '').slice(0, 32);
}

class LiveBrain {
  // `convo` is the one conversation. Build it with LiveBrain.open(): the
  // constructor is public for tests only and takes the conversation built.
  constructor({ callSid, convo, deadlineMs = ASK_DEADLINE_MS, softMs = SOFT_DEADLINE_MS }) {
    this.callSid = callSid;
    this.convo = convo;
    this.deadlineMs = deadlineMs;
    this.softMs = softMs;
    this.ended = false;
    this.softTimeouts = 0; // asks still running at the soft deadline (they may still answer)
    this.hardTimeouts = 0; // asks given up at the hard deadline
    this.turn = null; // the turn collecting tokens: { tokens: [], closed: false }
    this.wakeEnded = null;
    this.endedPromise = new Promise((resolve) => { this.wakeEnded = resolve; });
  }

  // The collector the conversation's `send` writes to. Tokens of a turn that
  // already closed (deadline, end) are dropped.
  collect(token) {
    if (this.turn && !this.turn.closed && typeof token === 'string') this.turn.tokens.push(token);
    return true;
  }

  // Builds the call's one conversation. The sandbox proof is read again here
  // from the call's own row: the bridge proved it at the door, and this refuses
  // anything but a sandbox-sourced inbound row, whatever the caller asks.
  // `make` is injected by tests (and builds a RelayConversation by default).
  static async open({ callSid, db, make, deadlineMs, softMs }) {
    const { VOICE_RELAY_SANDBOX_SOURCE } = require('./relay-protocol');
    const sid = String(callSid || '').trim();
    if (!sid) throw new Error('live_brain_no_callsid');
    const row = await db('call_log').where({ twilio_call_sid: sid }).first('source', 'from_phone', 'to_phone');
    if (!row || row.source !== VOICE_RELAY_SANDBOX_SOURCE) throw new Error('live_brain_not_sandbox');
    let brain = null;
    const build = make || ((args) => {
      const { RelayConversation } = require('./relay-conversation');
      return new RelayConversation(args);
    });
    const convo = build({
      callSid: sid,
      // The live door verified the signed per-call token for this CallSid and
      // burned it; the row is the proof ANI checks read.
      callTokenVerified: true,
      from: row.from_phone || null,
      to: row.to_phone || null,
      language: null,
      sandbox: true, // always: a write tool never runs on this line
      send: (token) => brain.collect(token),
      endSession: () => {
        logger.info(`[voice-live-brain] end/handoff frame ignored callSid=${sid}`);
        return false;
      },
    });
    brain = new LiveBrain({ callSid: sid, convo, deadlineMs, softMs });
    if (convo && convo.sandbox !== true) {
      // Belt and braces: a conversation that is not in dry-run mode never serves a call.
      throw new Error('live_brain_not_sandbox');
    }
    return brain;
  }

  // One caller turn in, the conversation's whole reply out (its tokens joined).
  // At the soft deadline it counts that and calls onSoft() once (the bridge says
  // a holding line), then keeps waiting: tokens still collect, and a late answer
  // is the answer. At the hard deadline it resolves TIMEOUT_REPLY, counts the
  // timeout and aborts the conversation's round so the next ask starts clean.
  // Rejects only when the conversation's turn fails.
  async ask(text, { onSoft } = {}) {
    const prompt = String(text || '').trim();
    if (this.ended || !prompt) return CLOSED_REPLY;
    const turn = { tokens: [], closed: false };
    this.turn = turn;
    let timer;
    const deadline = new Promise((resolve) => {
      timer = setTimeout(() => resolve('deadline'), this.deadlineMs);
      if (timer.unref) timer.unref();
    });
    const softTimer = setTimeout(() => {
      if (turn.closed) return;
      this.softTimeouts += 1;
      try { if (typeof onSoft === 'function') onSoft(); } catch { /* a failed holding line never fails the ask */ }
    }, this.softMs);
    if (softTimer.unref) softTimer.unref();
    try {
      const done = Promise.resolve(this.convo.handlePrompt(prompt)).then(() => 'done', () => 'failed');
      const outcome = await Promise.race([done, deadline, this.endedPromise.then(() => 'ended')]);
      turn.closed = true;
      if (outcome === 'ended') return CLOSED_REPLY;
      if (outcome === 'failed') throw new Error('live_brain_turn_failed');
      if (outcome === 'deadline') {
        this.hardTimeouts += 1;
        logger.warn(`[voice-live-brain] ask hit the ${this.deadlineMs} ms deadline callSid=${this.callSid}`);
        try { this.convo.interrupt(); } catch { /* nothing to abort */ }
        return TIMEOUT_REPLY;
      }
      return turn.tokens.join('').replace(/\s+/g, ' ').trim();
    } catch (err) {
      turn.closed = true;
      logger.warn(`[voice-live-brain] ask failed callSid=${this.callSid} code=${errCode(err)}`);
      throw err;
    } finally {
      clearTimeout(timer);
      clearTimeout(softTimer);
      if (this.turn === turn) this.turn = null;
    }
  }

  // Stops the conversation and writes nothing (see the header: RelayConversation.end()
  // would store the transcript on the call's row). `ended` stops queued turns, and
  // interrupt() aborts a round in flight. Never throws.
  async end(reason) {
    if (this.ended) return;
    this.ended = true;
    if (this.turn) this.turn.closed = true;
    this.wakeEnded();
    try {
      if (this.convo) {
        this.convo.ended = true;
        this.convo.interrupt();
      }
    } catch (err) {
      logger.warn(`[voice-live-brain] close failed callSid=${this.callSid} code=${errCode(err)}`);
    }
    logger.info(`[voice-live-brain] closed callSid=${this.callSid} reason=${String(reason || '').slice(0, 32)}`);
  }
}

module.exports = { LiveBrain, SOFT_DEADLINE_MS, ASK_DEADLINE_MS, TIMEOUT_REPLY, CLOSED_REPLY };
