/**
 * GPT-Live trial bridge (GATE_VOICE_GPT_LIVE_TEST, owner 2026-11-19, spend cap $5).
 *
 * One Twilio Media Streams socket on one side, one OpenAI GPT-Live session
 * (wss://api.openai.com/v1/live/sessions) on the other. The caller's mu-law
 * 8 kHz audio passes through unchanged in both directions, so the owner can
 * compare this one speech-to-speech model with Sandy's STT -> Claude -> TTS
 * chain by ear. relay-server.js hands the socket here only after the same
 * door as /ws/voice-agent: per-call token, sandbox-sourced call_log row with
 * the gpt_live stamp the cell route wrote, gate on, token burned.
 *
 * The server records reply delay (no call words) for each call on
 * call_log.metadata.gpt_live. GPT-Live sends no speech-started event, so
 * barge-in is this bridge's job: a caller transcript delta while model audio
 * is still queued in Twilio flushes Twilio's buffer.
 *
 * No tools and no lookups. The session uses CLIENT delegation: when GPT-Live
 * asks for help, it asks this bridge, which answers with one fixed sentence.
 * OpenAI's paid Responses backend is never used. Nothing here books, captures
 * a lead, texts or transfers.
 *
 * Logging and storage: callSid, codes, counts and timings only. The caller's
 * words are never stored or logged: the owner hears the trial calls himself,
 * and a transcript could hold card numbers or access codes.
 */

const logger = require('../logger');

const OPENAI_LIVE_URL = 'wss://api.openai.com/v1/live/sessions';
const LIVE_VOICES = Object.freeze(['marin', 'delta']);
const DEFAULT_VOICE = 'marin';
// The one answer to every delegation, spoken to the caller: the trial has no lookups.
const DELEGATION_REPLY = "I can't look that up on this test line. You can call or text the Waves office for that.";

const WS_OPEN = 1;
const SESSION_CAP_MS = 10 * 60 * 1000;
const CLOSE_WAIT_MS = 5000;
const START_DEADLINE_MS = 10000; // session.started must arrive within this, or the call ends
const BARGE_IN_MARGIN_MS = 200;
const NEW_REPLY_GAP_MS = 250; // a model audio chunk this long after the one before starts a new reply
const TAIL_DROP_MAX_MS = 1500; // after a barge-in, drop the cut-off reply's tail at most this long
const MULAW_BYTES_PER_MS = 8; // 8000 samples a second, one byte each
const INSTRUCTIONS_MAX_CHARS = 60000; // about 16k tokens; OpenAI's limit is 16,384

// ── Spend accounting for the owner's $5 cap (OpenAI pricing page and GPT-Live
// reference, read 2026-11-19/20) ──
// GPT-Live-1.1 bills $0.05 an active minute, counted per second; the final
// seconds are confirmed only by session.closed. Backend model and tool usage
// bill separately, and this session has none: client delegation runs no
// OpenAI backend model (the bridge answers), so voice time is the whole cost.
const LIVE_USD_PER_MINUTE = 0.05;
// The most one call can cost: the session cap plus 30 s of close wait and
// clock skew. The cell route reserves this much of the cap before it issues a
// stream token, and a call keeps it unless session.closed confirms the usage.
// Rounded UP to the ledger's $0.0001 (decimal(10,4)): a settled row never
// understates spend, however many short calls add up under the cap.
function callCostUsd(usageSeconds) {
  const tenThousandths = (usageSeconds * LIVE_USD_PER_MINUTE * 10000) / 60;
  return Math.max(0, Math.ceil(tenThousandths - 1e-9)) / 10000; // max(): never -0
}

const PER_CALL_RESERVE_USD = callCostUsd((SESSION_CAP_MS + 30000) / 1000);

const TRIAL_LIMITS = [
  'TRIAL LIMITS (this overrides everything above):',
  'You are on a test line and cannot look anything up: no open appointment times, prices, accounts or',
  'records. You cannot book, take a lead, send a text or transfer the call, and nobody will call back',
  'from this line. If the caller wants any of those, say this test line cannot do that, and they can',
  'call or text the Waves office.',
].join('\n');

// ── Session setup pieces (pure, exported for tests) ────────────────────────

// Sandy's production system prompt (the same pure builders RelayConversation
// calls), then the trial limits last so they govern.
function buildLiveInstructions() {
  const { buildBasePrompt, composeSystemPrompt, getVoiceProfileTextNonBlocking } = require('./relay-conversation');
  const { isContextEnabled } = require('./relay-context');
  const base = buildBasePrompt(isContextEnabled(), null, { officeOpen: null });
  const text = `${composeSystemPrompt(base, getVoiceProfileTextNonBlocking())}\n\n${TRIAL_LIMITS}`;
  if (text.length >= INSTRUCTIONS_MAX_CHARS) {
    throw new Error(`live instructions are ${text.length} chars (limit ${INSTRUCTIONS_MAX_CHARS})`);
  }
  return text;
}

function buildSessionStart({ instructions, voice }) {
  const { OPENAI_VOICE_LIVE } = require('../../config/models');
  return {
    type: 'session.start',
    session: {
      model: OPENAI_VOICE_LIVE,
      instructions,
      audio: {
        format: { type: 'audio/pcmu', rate: 8000 },
        output: { voice: LIVE_VOICES.includes(voice) ? voice : DEFAULT_VOICE },
      },
      // Client: delegations come to this bridge, never to OpenAI's paid
      // Responses backend (omitted or null would also select client).
      delegation: { type: 'client' },
      store: false,
    },
  };
}

// A bounded error code for logs: a database error message can echo the
// statement's bindings, so err.message is never logged here.
function errCode(err) {
  return String((err && (err.code || err.name)) || 'error').replace(/[^\w.-]/g, '').slice(0, 32);
}

// The call's ledger row (voice_gpt_live_spend) turns admitted once, after the
// WebSocket handshake and before OpenAI opens. A row the cell route released
// (never admitted within the token's life) or already settled cannot be, so a
// stream never opens a paid session on a freed reservation.
async function admitReservation(callSid) {
  const db = require('../../models/db');
  const n = await db('voice_gpt_live_spend')
    .where({ call_sid: callSid })
    .whereNull('admitted_at')
    .whereNull('cost_usd')
    .update({ admitted_at: db.fn.now() });
  return n === 1;
}

function median(sorted) {
  return sorted.length ? sorted[Math.ceil(sorted.length * 0.5) - 1] : null;
}

function defaultDeps() {
  const WebSocket = require('ws');
  return {
    openaiFactory: ({ url, headers }) => new WebSocket(url, { headers }),
    now: () => Date.now(),
    admit: admitReservation,
    buildInstructions: buildLiveInstructions,
    greeting: () => require('./relay-protocol').defaultWelcomeGreeting(),
    db: () => require('../../models/db'),
    apiKey: () => process.env.OPENAI_API_KEY,
    sessionCapMs: SESSION_CAP_MS,
    closeWaitMs: CLOSE_WAIT_MS,
    startDeadlineMs: START_DEADLINE_MS,
  };
}

class LiveBridge {
  constructor(twilioWs, { callSid, voice, cell }, deps = {}) {
    this.deps = { ...defaultDeps(), ...deps };
    this.twilio = twilioWs;
    this.callSid = callSid;
    this.voice = voice;
    this.cell = cell;
    this.openai = null;
    this.streamSid = null;
    this.ready = false; // session.started seen: caller audio may flow
    this.admitted = false; // this bridge claimed the call's ledger row
    this.admission = null;
    this.startSent = false; // session.start left the bridge: OpenAI may bill from here
    this.startSeen = false; // the Twilio start frame is handled once, whatever it holds

    this.startedAt = this.deps.now();
    this.sessionStartWall = null; // when session.started arrived: transcript ms count from here
    this.speechEndWall = null;
    this.awaitingReply = false;
    this.playbackEndsAt = 0;
    this.replyStartWall = null; // wall time the model's current reply began
    this.prevReplyStartWall = null; // ...and the reply before it
    this.replySample = null; // { index, speechEnd } of the delay sample the current reply has
    this.lastAudioAt = null; // arrival time of the last model audio chunk
    this.tailDropSince = null; // a barge-in cleared Twilio at this time: drop the old reply's tail

    this.latencies = [];
    this.interruptions = 0;
    this.errors = [];
    this.delegations = new Set();
    this.usageConfirmed = false; // session.closed carried the final usage

    this.usageSeconds = null;
    this.closeReason = null;
    this.openaiGone = false;
    this.wakeClose = null;
    this._finalizing = null;
    this.capTimer = null;
    this.startTimer = null;
  }

  // ── plumbing ─────────────────────────────────────────────────────────────
  static sendJson(ws, obj) {
    if (!ws || ws.readyState !== WS_OPEN) return false;
    try {
      ws.send(JSON.stringify(obj));
      return true;
    } catch {
      return false;
    }
  }

  toOpenAi(obj) { return LiveBridge.sendJson(this.openai, obj); }

  toTwilio(obj) { return LiveBridge.sendJson(this.twilio, obj); }

  noteError(code) {
    if (!this._finalizing && this.errors.length < 50) this.errors.push(String(code || 'error').slice(0, 64));
  }

  start() {
    this.admission = Promise.resolve()
      .then(() => this.deps.admit(this.callSid))
      .then((ok) => { this.admitted = ok === true; return this.admitted; })
      .catch(() => { this.noteError('admit_failed'); return false; });
    this.capTimer = setTimeout(() => { void this.finalize('cap'); }, this.deps.sessionCapMs);
    if (this.capTimer.unref) this.capTimer.unref();
    this.twilio.on('message', (raw) => this.onTwilioMessage(raw));
    this.twilio.on('close', () => { void this.finalize('twilio_closed'); });
    this.twilio.on('error', () => { this.noteError('twilio_socket'); void this.finalize('twilio_error'); });
    return this;
  }

  // ── Twilio side ──────────────────────────────────────────────────────────
  onTwilioMessage(raw) {
    let msg;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    if (msg.event === 'start') this.onTwilioStart(msg.start || {});
    else if (msg.event === 'media') this.onTwilioMedia(msg.media || {});
    else if (msg.event === 'stop') void this.finalize('twilio_stop');
  }

  // Startup runs once: a later start frame never opens a second paid session.
  // The paid socket opens only for this call's CallSid with a stream to answer on.
  onTwilioStart(start) {
    if (this.startSeen || this._finalizing) return;
    this.startSeen = true;
    const streamSid = typeof start.streamSid === 'string' ? start.streamSid.trim() : '';
    const bad = start.callSid !== this.callSid ? 'callsid_mismatch' : (!streamSid ? 'no_stream_sid' : null);
    if (bad) {
      logger.warn(`[voice-live] bad start frame (${bad}) — closing callSid=${this.callSid}`);
      this.noteError(bad);
      void this.finalize(bad);
      return;
    }
    this.streamSid = streamSid;
    // OpenAI opens only on an admitted reservation.
    void this.admission.then((ok) => {
      if (this._finalizing) return;
      if (ok) {
        this.openOpenAi();
        return;
      }
      this.noteError('not_admitted');
      void this.finalize('not_admitted');
    });
  }

  onTwilioMedia(media) {
    // Caller audio is dropped until the model session is confirmed.
    if (!this.ready || typeof media.payload !== 'string' || (media.track && media.track !== 'inbound')) return;
    this.toOpenAi({ type: 'session.input_audio.append', audio: media.payload });
  }

  // ── OpenAI side ──────────────────────────────────────────────────────────
  openOpenAi() {
    const apiKey = this.deps.apiKey();
    if (!apiKey) {
      this.noteError('no_api_key');
      void this.finalize('no_api_key');
      return;
    }
    let startMsg;
    try {
      startMsg = buildSessionStart({ instructions: this.deps.buildInstructions(), voice: this.voice });
    } catch (err) {
      logger.error(`[voice-live] session setup failed callSid=${this.callSid}: ${err.message}`);
      this.noteError('setup_failed');
      void this.finalize('setup_failed');
      return;
    }
    try {
      this.openai = this.deps.openaiFactory({ url: OPENAI_LIVE_URL, headers: { Authorization: `Bearer ${apiKey}` } });
    } catch {
      // A socket that throws at construction never reached OpenAI.
      this.openai = null;
      this.noteError('socket_open_failed');
      void this.finalize('socket_open_failed');
      return;
    }
    // No session.started in time = a refused or stuck start: end the call
    // rather than leave the caller on a silent line.
    this.startTimer = setTimeout(() => {
      if (this.ready) return;
      this.noteError('start_timeout');
      void this.finalize('start_timeout');
    }, this.deps.startDeadlineMs);
    if (this.startTimer.unref) this.startTimer.unref();
    this.openai.on('open', () => { if (this.toOpenAi(startMsg)) this.startSent = true; });
    this.openai.on('message', (raw) => this.onOpenAiMessage(raw));
    this.openai.on('close', () => this.onOpenAiGone());
    this.openai.on('error', (err) => {
      this.noteError(err && err.code ? `socket_${err.code}` : 'socket_error');
      this.onOpenAiGone();
    });
  }

  onOpenAiGone() {
    this.openaiGone = true;
    if (this.wakeClose) this.wakeClose();
    void this.finalize('openai_closed');
  }

  onOpenAiMessage(raw) {
    let msg;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    if (!msg || typeof msg.type !== 'string') return;
    const handlers = {
      'session.started': () => this.onSessionStarted(),
      'session.output_audio.delta': () => this.onOutputAudio(msg),
      'session.input_transcript.delta': () => this.onInputTranscript(msg),
      'session.delegation.created': () => this.onDelegation(msg.delegation),
      'session.usage.updated': () => this.noteUsage(msg.usage),
      'session.closed': () => this.onSessionClosed(msg),
      error: () => this.onOpenAiError(msg),
    };
    const handler = handlers[msg.type];
    if (handler) handler();
  }

  onSessionStarted() {
    this.ready = true;
    this.sessionStartWall = this.deps.now();
    clearTimeout(this.startTimer);
    this.toOpenAi({ type: 'session.commentary.append', delegation_id: null, content: this.deps.greeting() });
  }

  onOutputAudio(msg) {
    if (typeof msg.delta !== 'string' || !msg.delta || !this.streamSid) return;
    const t = this.deps.now();
    // OpenAI streams a reply faster than it plays, so its chunks arrive close
    // together, and a new reply arrives after a gap in the stream. A gap marks
    // a reply start whatever is still queued at Twilio, so a fast reply and a
    // reply right after a barge-in are both timed. A chunk with no gap after a
    // barge-in is the cut-off reply's tail: it is dropped, so the caller never
    // hears it restart mid-sentence (for TAIL_DROP_MAX_MS at the most).
    const newReply = this.lastAudioAt === null || t - this.lastAudioAt >= NEW_REPLY_GAP_MS;
    this.lastAudioAt = t;
    if (newReply) {
      this.tailDropSince = null;
      this.onReplyStart(t);
    } else if (this.tailDropSince !== null) {
      if (t - this.tailDropSince < TAIL_DROP_MAX_MS) return;
      this.tailDropSince = null;
    }
    const decodedBytes = Buffer.from(msg.delta, 'base64').length;
    this.playbackEndsAt = Math.max(t, this.playbackEndsAt) + decodedBytes / MULAW_BYTES_PER_MS;
    this.toTwilio({ event: 'media', streamSid: this.streamSid, media: { payload: msg.delta } });
  }

  // The pending measure is consumed only here, by a reply start. The first
  // reply start is the greeting (sent at session.started): it is never timed,
  // even when the caller spoke before it.
  onReplyStart(t) {
    const greeting = this.replyStartWall === null;
    this.prevReplyStartWall = this.replyStartWall;
    this.replyStartWall = t;
    this.replySample = null;
    if (!greeting && this.awaitingReply && this.speechEndWall !== null) {
      this.latencies.push(Math.max(0, Math.round(t - this.speechEndWall)));
      this.replySample = { index: this.latencies.length - 1, speechEnd: this.speechEndWall };
    }
    this.awaitingReply = false;
  }

  onInputTranscript(msg) {
    const text = typeof msg.delta === 'string' ? msg.delta : '';
    const t = this.deps.now();
    // start_ms / end_ms count from the start of the Live session, so they map
    // to wall time from session.started, not from the first caller packet.
    const speechEnd = Number.isFinite(msg.end_ms) && this.sessionStartWall !== null ? this.sessionStartWall + msg.end_ms : null;
    if (speechEnd !== null) this.noteSpeechEnd(speechEnd);
    if (text.trim() && this.isBargeIn(t, speechEnd)) {
      this.toTwilio({ event: 'clear', streamSid: this.streamSid });
      this.playbackEndsAt = t;
      this.tailDropSince = t;
      this.interruptions += 1;
    }
  }

  // Speech that ended after the current reply began arms the measure for the
  // next reply. Speech that ended before it, whose transcript came late, timed
  // the CURRENT reply, when it ended after the reply before that one began:
  // it adds that reply's sample, or moves it to a later fragment's end. The
  // greeting (no reply before it) is never timed.
  noteSpeechEnd(speechEnd) {
    if (this.replyStartWall === null || speechEnd > this.replyStartWall) {
      this.speechEndWall = speechEnd;
      this.awaitingReply = true;
      return;
    }
    if (this.prevReplyStartWall === null || speechEnd <= this.prevReplyStartWall) return;
    const delay = Math.max(0, Math.round(this.replyStartWall - speechEnd));
    if (!this.replySample) {
      this.latencies.push(delay);
      this.replySample = { index: this.latencies.length - 1, speechEnd };
    } else if (speechEnd > this.replySample.speechEnd) {
      this.latencies[this.replySample.index] = delay;
      this.replySample.speechEnd = speechEnd;
    }
  }

  // A barge-in is caller speech that runs past the start of the reply still
  // playing. A late transcript of words the caller finished BEFORE the reply
  // began is not one: flushing then would cut the answer to their question.
  // No timing, no flush.
  isBargeIn(t, speechEnd) {
    if (t >= this.playbackEndsAt - BARGE_IN_MARGIN_MS) return false; // nothing (much) left to cut
    if (speechEnd === null || this.replyStartWall === null) return false;
    return speechEnd > this.replyStartWall + BARGE_IN_MARGIN_MS;
  }

  noteUsage(usage) {
    if (usage && Number.isFinite(usage.seconds)) this.usageSeconds = usage.seconds;
  }

  onSessionClosed(msg) {
    this.noteUsage(msg.usage);
    if (msg.usage && Number.isFinite(msg.usage.seconds)) this.usageConfirmed = true;
    this.closeReason = typeof msg.reason === 'string' ? msg.reason : this.closeReason;
    this.openaiGone = true;
    if (this.wakeClose) this.wakeClose();
    // A session OpenAI ended itself (expired, content, connection_lost) is
    // over even if its socket stays open: end the call and write the record.
    // During our own close this is the awaited reply and changes nothing.
    void this.finalize('provider_closed');
  }

  onOpenAiError(msg) {
    const e = msg.error || {};
    // Code and type only: the message can echo input.
    this.noteError(`${e.code || 'error'}${e.type ? `:${e.type}` : ''}`);
    logger.warn(`[voice-live] openai error code=${String(e.code || '')} type=${String(e.type || '')} callSid=${this.callSid}`);
    // Before session.started, an error is a refused start: end the call.
    // Errors after the start (a rejected command) are nonfatal.
    if (!this.ready) void this.finalize('setup_rejected');
  }

  // ── delegation ───────────────────────────────────────────────────────────
  // GPT-Live asks THIS bridge for help (client delegation). The trial has no
  // lookups, so each ask gets the same fixed answer, once, as commentary: the
  // caller hears it (thinking would be silent and leave the caller waiting).
  // A delegation to any other target would be paid backend work this session
  // never set up: end the call.
  onDelegation(delegation) {
    const id = delegation && typeof delegation.id === 'string' ? delegation.id : '';
    if (!id || this.delegations.has(id) || this._finalizing) return;
    this.delegations.add(id);
    if (delegation.target !== 'client') {
      this.noteError('unexpected_delegation');
      void this.finalize('unexpected_delegation');
      return;
    }
    this.toOpenAi({ type: 'session.commentary.append', delegation_id: id, content: DELEGATION_REPLY });
  }

  // ── finish ───────────────────────────────────────────────────────────────
  // Exactly once, whichever of Twilio stop, either socket close or the cap
  // gets here first. Later callers get the same promise.
  finalize(reason) {
    if (!this._finalizing) this._finalizing = this.runFinalize(reason);
    return this._finalizing;
  }

  async runFinalize(reason) {
    clearTimeout(this.capTimer);
    clearTimeout(this.startTimer);
    await this.closeOpenAi();
    try { this.twilio.close(); } catch { /* already closed */ }
    await this.admission; // settled, never thrown: whether this bridge owns the ledger row
    try {
      await this.writeSummary(reason);
    } catch (err) {
      // A database error message can echo its bindings: log a bounded code
      // only, never err.message.
      logger.warn(`[voice-live] summary write failed callSid=${this.callSid} code=${errCode(err)}`);
    }
  }

  // session.close, then up to closeWaitMs for session.closed (it carries the
  // final usage). With no session.closed by then, the socket is terminated at
  // once: a graceful close could hold it open 30 s more, past the reservation.
  async closeOpenAi() {
    const sock = this.openai;
    if (!sock) return;
    if (sock.readyState === WS_OPEN && !this.openaiGone) {
      this.toOpenAi({ type: 'session.close' });
      let timer;
      await new Promise((resolve) => {
        this.wakeClose = resolve;
        timer = setTimeout(resolve, this.deps.closeWaitMs);
        if (timer.unref) timer.unref();
      });
      clearTimeout(timer);
      this.wakeClose = null;
    }
    try {
      if (this.openaiGone && sock.readyState === WS_OPEN) sock.close();
      else if (typeof sock.terminate === 'function') sock.terminate();
      else sock.close();
    } catch { /* already closed */ }
  }

  // The seconds to record and whether the cost can be settled. A call whose
  // session.start never left the bridge (no key, a local setup failure, a bad
  // start frame, a DNS/TLS/HTTP handshake failure) started no session and
  // provably used nothing: it settles at zero and frees its reservation.
  // Otherwise only session.closed confirms the final usage (OpenAI: a close
  // without it "does not confirm successful finalization"); unconfirmed, no
  // cost is settled and the call keeps its full reservation.
  settledUsage(errors) {
    if (!this.startSent) return { usage: 0, settled: true };
    let usage = this.usageSeconds;
    if (usage === null) {
      usage = Math.max(0, Math.round((this.deps.now() - this.startedAt) / 1000));
      errors.push('usage_missing');
    }
    if (!this.usageConfirmed) errors.push('usage_unconfirmed');
    return { usage, settled: this.usageConfirmed };
  }

  summary(reason) {
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const errors = [...this.errors];
    const { usage, settled } = this.settledUsage(errors);
    return {
      usage_seconds: usage,
      openai_contacted: this.startSent,
      usage_confirmed: this.usageConfirmed,
      ...(settled ? { cost_usd: callCostUsd(usage) } : {}),
      // Why the bridge ended the call (cap, caller hangup, ...), and OpenAI's
      // own close reason separately: an acknowledged close must not hide a cap.
      close_reason: reason,
      provider_close_reason: this.closeReason,
      turns: this.latencies,
      latency_p50_ms: median(sorted),
      latency_max_ms: sorted.length ? sorted[sorted.length - 1] : null,
      interruptions: this.interruptions,
      delegations: this.delegations.size,
      errors,
    };
  }

  async writeSummary(reason) {
    const db = this.deps.db();
    const summary = this.summary(reason);
    // The ledger first: it is the budget. A settled cost frees the rest of the
    // reservation; an unsettled call leaves its row alone (it keeps it all). A
    // bridge that never claimed the row leaves it to the cell route's release.
    if (summary.cost_usd !== undefined && this.admitted) {
      try {
        await db('voice_gpt_live_spend').where({ call_sid: this.callSid }).update({ cost_usd: summary.cost_usd, settled_at: new Date() });
      } catch (err) {
        logger.warn(`[voice-live] ledger settle failed callSid=${this.callSid} code=${errCode(err)}`);
      }
    }
    const merged = JSON.stringify(summary);
    await db('call_log').where({ twilio_call_sid: this.callSid }).update({
      metadata: db.raw(
        "jsonb_set(COALESCE(metadata, '{}'::jsonb), '{gpt_live}', COALESCE(metadata->'gpt_live', '{}'::jsonb) || ?::jsonb, true)",
        [merged],
      ),
      updated_at: new Date(),
    });
    logger.info(`[voice-live] done callSid=${this.callSid} reason=${reason} turns=${this.latencies.length} usage_s=${this.usageSeconds}`);
  }
}

function runLiveBridge(twilioWs, params, deps) {
  return new LiveBridge(twilioWs, params, deps).start();
}

module.exports = {
  runLiveBridge,
  LiveBridge,
  buildLiveInstructions,
  buildSessionStart,
  admitReservation,
  DELEGATION_REPLY,
  TRIAL_LIMITS,
  OPENAI_LIVE_URL,
  INSTRUCTIONS_MAX_CHARS,
  PER_CALL_RESERVE_USD,
  callCostUsd,
};
