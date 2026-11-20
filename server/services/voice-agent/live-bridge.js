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
 * The server records reply delay and transcript for each call on
 * call_log.metadata.gpt_live. GPT-Live sends no speech-started event, so
 * barge-in is this bridge's job: a caller transcript delta while model audio
 * is still queued in Twilio flushes Twilio's buffer.
 *
 * Tools are a READ-ONLY allowlist (open appointment times, services list).
 * Nothing here books, captures a lead, texts or transfers.
 *
 * Logging: callSid, codes and counts only. Never transcript text or numbers.
 */

const logger = require('../logger');

const OPENAI_LIVE_URL = 'wss://api.openai.com/v1/live/sessions';
const LIVE_VOICES = Object.freeze(['marin', 'delta']);
const DEFAULT_VOICE = 'marin';
// The trial's one lookup is the services list: a local database read. Open
// appointment times are left out on purpose: the shared booking engine behind
// get_availability / find_slots can buy Google geocodes and road times, and
// find_slots sends date words to a paid model, all outside the owner's
// OpenAI-only spend yes (2026-11-19).
const BACKEND_TOOL_NAMES = Object.freeze(['get_services_catalog']);
const TOOL_REFUSAL = 'That is not available on this test line.';

const WS_OPEN = 1;
const TOOL_TIMEOUT_MS = 8000;
const SESSION_CAP_MS = 10 * 60 * 1000;
const CLOSE_WAIT_MS = 5000;
const START_DEADLINE_MS = 10000; // session.started must arrive within this, or the call ends
const BARGE_IN_MARGIN_MS = 200;
const NEW_REPLY_GAP_MS = 250; // model silence before a delta that marks the start of a new reply
const MULAW_BYTES_PER_MS = 8; // 8000 samples a second, one byte each
const TRANSCRIPT_MAX_CHARS = 20000;
const INSTRUCTIONS_MAX_CHARS = 60000; // about 16k tokens; OpenAI's limit is 16,384

// ── Spend accounting for the owner's $5 cap (OpenAI pricing page and GPT-Live
// reference, read 2026-11-19/20) ──
// GPT-Live-1.1 bills $0.05 an active minute, counted per second; the final
// seconds are confirmed only by session.closed. The delegated backend bills on
// top. Its model is the CODE default of OPENAI_FAST_INTERACTIVE (gpt-5.6-luna
// on that date: $0.20 per 1M input tokens, $1.20 per 1M output); the env
// override is ignored here because these prices are for that model. The docs
// give no backend input cap and no documented token-usage event, so a backend
// unit is charged at its worst case: a full 128,000-token GPT-Live context in
// ($0.0256) plus max_output_tokens 1,024 out ($0.0012), rounded up to $0.03.
// One unit = one delegation OpenAI starts, or one response.create this bridge
// sends. The tool run itself is a local database read and costs nothing.
const LIVE_USD_PER_MINUTE = 0.05;
const BACKEND_USD_PER_UNIT = 0.03;
const BACKEND_USD_PER_INPUT_TOKEN = 0.20 / 1e6;
const BACKEND_USD_PER_OUTPUT_TOKEN = 1.20 / 1e6;
const BACKEND_MAX_OUTPUT_TOKENS = 1024;
const MAX_BACKEND_UNITS = 15;
// Past this much reported backend token cost the call ends too.
const BACKEND_RESERVE_USD = (MAX_BACKEND_UNITS + 1) * BACKEND_USD_PER_UNIT;
const round4 = (n) => Math.round(n * 10000) / 10000;
// The most one call can cost: the session cap plus 30 s of close wait and
// clock skew, and the backend cap plus the one unit that can cross it. The cell
// route reserves this much of the cap before it issues a stream token, and a
// call keeps it unless session.closed confirms the final usage.
const PER_CALL_RESERVE_USD = round4(((SESSION_CAP_MS + 30000) / 60000) * LIVE_USD_PER_MINUTE + BACKEND_RESERVE_USD);

function backendTokenUsd(inputTokens, outputTokens) {
  return inputTokens * BACKEND_USD_PER_INPUT_TOKEN + outputTokens * BACKEND_USD_PER_OUTPUT_TOKEN;
}

// Voice seconds, plus the larger of the worst-case unit charge and any token
// usage OpenAI reported.
function callCostUsd(usageSeconds, backendUnits, tokenUsd = 0) {
  return round4((usageSeconds / 60) * LIVE_USD_PER_MINUTE + Math.max(backendUnits * BACKEND_USD_PER_UNIT, tokenUsd));
}

const TRIAL_LIMITS = [
  'TRIAL LIMITS (this overrides everything above):',
  'You are on a test line. You can look up the list of services Waves offers, and nothing else.',
  'You cannot look up open appointment times, book, take a lead, send a text, transfer the call, or look up',
  'prices or accounts, and nobody will call back from this line. If the caller wants any of those,',
  'say this test line cannot do that, and they can call or text the Waves office.',
].join('\n');

const BACKEND_INSTRUCTIONS = 'Use the tool to answer questions about the services Waves offers. '
  + 'Reply in one or two plain sentences, ready to be spoken aloud. Nothing can be booked, saved or sent on this line, '
  + 'and nobody will call back, so ignore any tool text that says to capture a lead, place a booking or promise a call; '
  + 'say the caller can call or text the Waves office.';

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

// Anthropic tool shape {name, description, input_schema} -> OpenAI function
// shape. The three allowlisted tools live in TOOLS (the availability pair) and
// CONTEXT_TOOLS (the services list).
function buildBackendTools() {
  const { CONTEXT_TOOLS } = require('./relay-tools');
  return BACKEND_TOOL_NAMES.map((name) => {
    const tool = (CONTEXT_TOOLS || []).find((t) => t && t.name === name);
    if (!tool) throw new Error(`relay tool ${name} not found`);
    return { type: 'function', name: tool.name, description: tool.description, parameters: tool.input_schema };
  });
}

function buildSessionStart({ instructions, tools, voice }) {
  const { OPENAI_VOICE_LIVE, DEFAULTS } = require('../../config/models');
  return {
    type: 'session.start',
    session: {
      model: OPENAI_VOICE_LIVE,
      instructions,
      audio: {
        format: { type: 'audio/pcmu', rate: 8000 },
        output: { voice: LIVE_VOICES.includes(voice) ? voice : DEFAULT_VOICE },
      },
      delegation: {
        type: 'responses',
        responses: {
          // The priced code default, never the env override (see the spend notes).
          model: DEFAULTS.OPENAI_FAST_INTERACTIVE,
          instructions: BACKEND_INSTRUCTIONS,
          tools,
          tool_choice: 'auto',
          parallel_tool_calls: false,
          max_output_tokens: BACKEND_MAX_OUTPUT_TOKENS,
        },
      },
      store: false,
    },
  };
}

// The context a sandbox relay session passes read tools (relay-conversation
// _buildToolCtx), minus everything a caller identity or a write would use: no
// customer, no verification, no slot refs (nothing here can book one).
function buildToolCtx(callSid) {
  return {
    from: null,
    to: null,
    callSid,
    sandbox: true,
    language: null,
    sessionKey: null,
    customerId: null,
    customerTier: 'redacted',
    callerVerified: false,
    callerAttested: false,
    consumeLookup: () => false,
    resolveLookupRef: () => null,
    resolveSlotRef: () => null,
    revokeAccountSlots: () => {},
    toolFailed: false,
  };
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('tool_timeout')), ms);
    if (timer && timer.unref) timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// A bounded error code for logs: a database error message can echo the
// statement's bindings (the transcript), so err.message is never logged here.
function errCode(err) {
  return String((err && (err.code || err.name)) || 'error').replace(/[^\w.-]/g, '').slice(0, 32);
}

function median(sorted) {
  return sorted.length ? sorted[Math.ceil(sorted.length * 0.5) - 1] : null;
}

function defaultDeps() {
  const WebSocket = require('ws');
  return {
    openaiFactory: ({ url, headers }) => new WebSocket(url, { headers }),
    now: () => Date.now(),
    executeTool: (name, input, ctx) => require('./relay-tools').executeTool(name, input, ctx),
    buildInstructions: buildLiveInstructions,
    buildTools: buildBackendTools,
    greeting: () => require('./relay-protocol').defaultWelcomeGreeting(),
    scrubTurns: (turns) => require('./relay-transcript').scrubTurnsForStorage(turns),
    db: () => require('../../models/db'),
    apiKey: () => process.env.OPENAI_API_KEY,
    toolTimeoutMs: TOOL_TIMEOUT_MS,
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
    this.startSeen = false; // the Twilio start frame is handled once, whatever it holds

    this.startedAt = this.deps.now();
    this.sessionStartWall = null; // when session.started arrived: transcript ms count from here
    this.speechEndWall = null;
    this.awaitingReply = false;
    this.playbackEndsAt = 0;
    this.replyStartWall = null; // wall time the model's current reply began

    this.latencies = [];
    this.interruptions = 0;
    this.toolCalls = [];
    this.errors = [];
    this.transcript = [];
    this.transcriptChars = 0;
    this.handledCalls = new Set();
    this.delegations = new Set();
    this.backendUnits = 0;
    this.backendInputTokens = 0;
    this.backendOutputTokens = 0;
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
    this.openOpenAi();
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
      startMsg = buildSessionStart({ instructions: this.deps.buildInstructions(), tools: this.deps.buildTools(), voice: this.voice });
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
    this.openai.on('open', () => this.toOpenAi(startMsg));
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
      'session.output_transcript.delta': () => this.addTranscript('sandy', msg.delta),
      'response.event': () => this.onResponseEvent(msg),
      'session.delegation.created': () => this.countDelegation(msg.delegation && msg.delegation.id),
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
    // A reply delay counts only where a reply starts (model audio after a
    // silence). A caller transcript that lands while the model is already
    // talking (transcription lag) must not log a false near-zero delay.
    const replyStart = t >= this.playbackEndsAt + NEW_REPLY_GAP_MS;
    if (replyStart) this.replyStartWall = t;
    if (replyStart && this.awaitingReply && this.speechEndWall !== null) {
      this.latencies.push(Math.max(0, Math.round(t - this.speechEndWall)));
    }
    this.awaitingReply = false;
    const decodedBytes = Buffer.from(msg.delta, 'base64').length;
    this.playbackEndsAt = Math.max(t, this.playbackEndsAt) + decodedBytes / MULAW_BYTES_PER_MS;
    this.toTwilio({ event: 'media', streamSid: this.streamSid, media: { payload: msg.delta } });
  }

  onInputTranscript(msg) {
    const text = typeof msg.delta === 'string' ? msg.delta : '';
    const t = this.deps.now();
    // start_ms / end_ms count from the start of the Live session, so they map
    // to wall time from session.started, not from the first caller packet.
    const speechEnd = Number.isFinite(msg.end_ms) && this.sessionStartWall !== null ? this.sessionStartWall + msg.end_ms : null;
    // Arm a delay measure only for speech that ended after the latest reply
    // began. A late transcript of words that reply already answered must not
    // time the NEXT reply from them.
    if (speechEnd !== null && (this.replyStartWall === null || speechEnd > this.replyStartWall)) {
      this.speechEndWall = speechEnd;
      this.awaitingReply = true;
    }
    if (text.trim() && this.isBargeIn(t, speechEnd)) {
      this.toTwilio({ event: 'clear', streamSid: this.streamSid });
      this.playbackEndsAt = t;
      this.interruptions += 1;
    }
    this.addTranscript('caller', text);
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

  addTranscript(role, text) {
    if (typeof text !== 'string' || !text || this.transcriptChars >= TRANSCRIPT_MAX_CHARS) return;
    const piece = text.slice(0, TRANSCRIPT_MAX_CHARS - this.transcriptChars);
    this.transcriptChars += piece.length;
    const last = this.transcript[this.transcript.length - 1];
    if (last && last.role === role) last.text += piece;
    else this.transcript.push({ role, text: piece });
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
    // responses_validation_failed comes after it (OpenAI validates delegation
    // settings asynchronously and keeps the bad ones), so the lookups can never
    // work: end that call too rather than bill a broken comparison. Other
    // errors after the start (a rejected command) are nonfatal.
    if (!this.ready) void this.finalize('setup_rejected');
    else if (e.code === 'responses_validation_failed') void this.finalize('backend_rejected');
  }

  // ── tools ────────────────────────────────────────────────────────────────
  onResponseEvent(msg) {
    this.countDelegation(msg.delegation_id);
    const ev = msg.event;
    if (ev && ev.type === 'response.completed') this.noteBackendTokens(ev.response && ev.response.usage);
    if (!ev || ev.type !== 'response.output_item.done') return;
    const item = ev.item;
    if (!item || item.type !== 'function_call' || item.status !== 'completed') return;
    if (!item.call_id || this.handledCalls.has(item.call_id)) return; // one answer per call_id
    this.handledCalls.add(item.call_id);
    void this.runTool(item);
  }

  async runTool(item) {
    const output = await this.callTool(item.name, item.arguments);
    if (this._finalizing) return;
    this.toOpenAi({ type: 'response.item.create', item: { type: 'function_call_output', call_id: item.call_id, output } });
    if (this.addBackendUnit()) this.toOpenAi({ type: 'response.create' });
  }

  // Never throws: a refused name, bad JSON, a timeout or a thrown error all
  // answer with the same short refusal.
  async callTool(name, rawArgs) {
    if (!BACKEND_TOOL_NAMES.includes(name)) {
      this.noteError('tool_refused');
      return TOOL_REFUSAL;
    }
    let input;
    try {
      input = JSON.parse(rawArgs || '{}');
    } catch {
      this.noteError('tool_bad_json');
      return TOOL_REFUSAL;
    }
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      this.noteError('tool_bad_json');
      return TOOL_REFUSAL;
    }
    this.toolCalls.push(name);
    const ctx = buildToolCtx(this.callSid);
    try {
      // The services list takes no input: nothing the model sent is passed on.
      const out = await withTimeout(Promise.resolve().then(() => this.deps.executeTool(name, {}, ctx)), this.deps.toolTimeoutMs);
      if (ctx.toolFailed) this.noteError('tool_failed');
      return typeof out === 'string' && out ? out : TOOL_REFUSAL;
    } catch (err) {
      this.noteError(err && err.message === 'tool_timeout' ? 'tool_timeout' : 'tool_error');
      return TOOL_REFUSAL;
    }
  }

  // Each delegation OpenAI starts is a paid backend call: count it once, from
  // session.delegation.created or the first response.event that names it.
  // It is counted even while the call is closing: OpenAI may still bill work
  // it started before session.close, so the settled cost must include it.
  countDelegation(id) {
    if (typeof id !== 'string' || !id || this.delegations.has(id)) return;
    this.delegations.add(id);
    this.backendUnits += 1;
    this.checkBackendCap();
  }

  // Past MAX_BACKEND_UNITS the call ends: GPT-Live starts delegations on its
  // own, so ending the session is the only stop.
  checkBackendCap() {
    if (this.backendUnits <= MAX_BACKEND_UNITS || this._finalizing) return;
    this.noteError('backend_cap');
    void this.finalize('backend_cap');
  }

  // Token usage, if a forwarded response.completed carries it (the reference
  // does not document the shape). It can only raise the settled cost, and past
  // the backend reserve it ends the call.
  noteBackendTokens(usage) {
    if (!usage || typeof usage !== 'object') return;
    const inTok = Number(usage.input_tokens);
    const outTok = Number(usage.output_tokens);
    if (Number.isFinite(inTok) && inTok > 0) this.backendInputTokens += inTok;
    if (Number.isFinite(outTok) && outTok > 0) this.backendOutputTokens += outTok;
    if (backendTokenUsd(this.backendInputTokens, this.backendOutputTokens) > BACKEND_RESERVE_USD) {
      this.noteError('backend_cap');
      void this.finalize('backend_cap');
    }
  }

  // One more paid backend unit. Past MAX_BACKEND_UNITS the call ends: GPT-Live
  // starts delegations on its own, so ending the session is the only stop.
  // Returns false when the unit would cross the cap (the caller then skips it).
  addBackendUnit() {
    if (this._finalizing || this.backendUnits >= MAX_BACKEND_UNITS) {
      if (!this._finalizing) {
        this.noteError('backend_cap');
        void this.finalize('backend_cap');
      }
      return false;
    }
    this.backendUnits += 1;
    return true;
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
    try {
      await this.writeSummary(reason);
    } catch (err) {
      // The UPDATE binds the transcript, and a database error message can echo
      // its bindings: log a bounded code only, never err.message.
      logger.warn(`[voice-live] summary write failed callSid=${this.callSid} code=${errCode(err)}`);
    }
  }

  // session.close, then up to closeWaitMs for session.closed (it carries the
  // final usage). A socket that is not open is just dropped.
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
      if (sock.readyState === WS_OPEN) sock.close();
      else if (typeof sock.terminate === 'function') sock.terminate();
      else sock.close();
    } catch { /* already closed */ }
  }

  // The seconds to record and whether the cost can be settled. A call that
  // never reached OpenAI (no key, a local setup failure, a bad start frame)
  // provably used nothing: it settles at zero and frees its reservation.
  // Otherwise only session.closed confirms the final usage (OpenAI: a close
  // without it "does not confirm successful finalization"); unconfirmed, no
  // cost is settled and the call keeps its full reservation.
  settledUsage(errors) {
    if (this.openai === null) return { usage: 0, settled: true };
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
    const tokenUsd = backendTokenUsd(this.backendInputTokens, this.backendOutputTokens);
    // Card numbers and access codes are scrubbed before storage, across turns
    // (a number read in pieces), with the relay transcript's own scrubber.
    // It returns null when it cannot run: then no text is stored at all.
    let transcript = null;
    try { transcript = this.deps.scrubTurns(this.transcript); } catch { transcript = null; }
    if (!Array.isArray(transcript)) {
      transcript = [];
      errors.push('transcript_scrub_unavailable');
    }
    return {
      usage_seconds: usage,
      openai_contacted: this.openai !== null,
      usage_confirmed: this.usageConfirmed,
      backend_units: this.backendUnits,
      backend_input_tokens: this.backendInputTokens,
      backend_output_tokens: this.backendOutputTokens,
      ...(settled ? { cost_usd: callCostUsd(usage, this.backendUnits, tokenUsd) } : {}),
      // Why the bridge ended the call (cap, caller hangup, ...), and OpenAI's
      // own close reason separately: an acknowledged close must not hide a cap.
      close_reason: reason,
      provider_close_reason: this.closeReason,
      turns: this.latencies,
      latency_p50_ms: median(sorted),
      latency_max_ms: sorted.length ? sorted[sorted.length - 1] : null,
      interruptions: this.interruptions,
      tool_calls: this.toolCalls,
      errors,
      transcript: transcript.filter((turn) => turn && turn.text),
    };
  }

  async writeSummary(reason) {
    const db = this.deps.db();
    const summary = this.summary(reason);
    // The ledger first: it is the budget. A settled cost frees the rest of the
    // reservation; an unsettled call leaves its row alone (it keeps it all).
    if (summary.cost_usd !== undefined) {
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
  buildBackendTools,
  buildSessionStart,
  buildToolCtx,
  BACKEND_TOOL_NAMES,
  TOOL_REFUSAL,
  TRIAL_LIMITS,
  OPENAI_LIVE_URL,
  INSTRUCTIONS_MAX_CHARS,
  PER_CALL_RESERVE_USD,
  MAX_BACKEND_UNITS,
  BACKEND_USD_PER_UNIT,
  callCostUsd,
};
