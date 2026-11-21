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
const REPLY_SILENCE_MIN_MS = 800; // model audio silent this long before voice begins starts a new reply
const TAIL_SILENCE_MIN_MS = 600; // ...and this long inside the tail drop after a barge-in (main's boundary): there a muted answer is worse than a tail that plays on
const VOICED_SAMPLE_MIN = 300; // a decoded sample at or above this magnitude (16-bit scale) is voice
const CALLER_VOICED_RMS_MIN = 300; // a caller frame at or above this RMS (16-bit scale) holds voice: the timing rule
const OPENING_SOUND_RMS_MIN = 100; // a held opening frame at or above this RMS may hold speech, quiet speech too; the noise of a quiet line is under it
const CALLER_END_LOOKBACK_MS = 2000; // a transcript fragment's speech ended at the caller's last voiced frame, at most this long before it arrived
const BARGE_IN_VOICE_MIN_MS = 100; // caller frames voiced this long in a row are a caller who speaks; a shorter sound (a click, a knock) never flushes a reply
const CALLER_STOPPED_MIN_MS = 200; // a reply whose first voice comes sooner than this after the caller's last sound did not wait for the caller to stop
const TAIL_DROP_MAX_MS = 1500; // after a barge-in, drop the cut-off reply's tail at most this long
// Caller audio that arrives before session.started (admission and the OpenAI
// start) is held in memory, never stored: the latest 3 s at most (Twilio sends
// 20 ms frames). It is forwarded in order once the session is up when it
// holds sound (onSessionStarted).
const OPENING_AUDIO_MAX_FRAMES = 150;
const OPENING_LEAD_FRAMES = 5; // held frames sent ahead of the first one that holds sound (100 ms)
const MULAW_BYTES_PER_MS = 8; // 8000 samples a second, one byte each
// G.711 mu-law to a 16-bit linear sample.
function mulawToLinear(byte) {
  const u = ~byte & 0xff;
  const exp = (u >> 4) & 7;
  const x = (((u & 0x0f) << 3) + 0x84) << exp;
  return u & 0x80 ? 0x84 - x : x - 0x84;
}

// Whether each mu-law byte is voice (digital silence is 0xFF and 0x7F).
const VOICED_BYTE = Uint8Array.from({ length: 256 }, (_, b) => (Math.abs(mulawToLinear(b)) >= VOICED_SAMPLE_MIN ? 1 : 0));
// The squared linear value of each mu-law byte, for a frame's RMS.
const MULAW_SQUARE = Float64Array.from({ length: 256 }, (_, b) => mulawToLinear(b) ** 2);
const REPLY_SILENCE_MIN_SAMPLES = REPLY_SILENCE_MIN_MS * MULAW_BYTES_PER_MS;
const TAIL_SILENCE_MIN_SAMPLES = TAIL_SILENCE_MIN_MS * MULAW_BYTES_PER_MS;

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

// The greeting is a developer message in session.start, as OpenAI's Live guide
// says ("include greeting instructions in a developer message in
// session.input"). The bridge used to send it as session.commentary.append
// after session.started: on the live API 2026-11-20 that was acknowledged and
// never spoken (9 s of silence, until the caller spoke). With this message the
// model greeted 2.0 s after session.started (2026-11-21, Sandy's full prompt).
// OpenAI does not promise the model speaks first.
function buildSessionStart({ instructions, voice, greeting }) {
  const { OPENAI_VOICE_LIVE } = require('../../config/models');
  const say = String(greeting || '').replace(/"/g, "'").trim();
  return {
    type: 'session.start',
    session: {
      model: OPENAI_VOICE_LIVE,
      instructions,
      ...(say ? {
        input: [{
          type: 'message',
          role: 'developer',
          content: [{ type: 'input_text', text: `Greet the caller now in English. Say exactly: "${say}" Then pause and listen.` }],
        }],
      } : {}),
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

// The call's ledger row (voice_gpt_live_ledger) turns admitted once, after the
// WebSocket handshake and before OpenAI opens. A row the cell route released
// (never admitted within the token's life) or already settled cannot be, so a
// stream never opens a paid session on a freed reservation.
async function admitReservation(callSid) {
  const db = require('../../models/db');
  const n = await db('voice_gpt_live_ledger')
    .where({ call_sid: callSid })
    .whereNull('admitted_at')
    .whereNull('cost_usd')
    .update({ admitted_at: db.fn.now() });
  return n === 1;
}

function waitAtMost(promise, ms) {
  let timer;
  const bound = new Promise((resolve) => {
    timer = setTimeout(resolve, ms);
    if (timer.unref) timer.unref();
  });
  return Promise.race([promise, bound]).finally(() => clearTimeout(timer));
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
    this.admissionDone = false;
    this.startSent = false; // session.start left the bridge: OpenAI may bill from here
    this.startSeen = false; // the Twilio start frame is handled once, whatever it holds

    this.startedAt = this.deps.now();
    this.sessionStartWall = null; // when session.started arrived
    this.callerVoiceAt = null; // arrival of the caller's latest frame that holds voice
    this.callerRunMs = 0; // how long the caller's frames have held voice in a row
    this.callerSpokeAt = null; // arrival of the caller's latest frame in a run of BARGE_IN_VOICE_MIN_MS or more
    this.callerMs = 0; // caller audio received, and the part of it in frames that hold voice
    this.callerVoicedMs = 0;
    this.speechEndWall = null;
    this.awaitingReply = false;
    this.playbackEndsAt = 0;
    this.voiceEndsAt = 0; // wall time Twilio finishes the last voiced sample forwarded (silence queued after it is nothing to cut)
    this.replyStartWall = null; // wall time the model's current reply began (its audio arrived)
    this.replyVoiceWall = null; // ...and when its first voiced sample reached the bridge (delays run to it)
    this.prevReplyStartWall = null; // ...and the reply before it
    this.replySample = null; // { index, speechEnd } of the delay sample the current reply has
    this.replyOverCaller = false; // the current reply began before the caller had stopped (counted once)
    this.repliesOverCaller = 0;
    this.voiceSeen = false; // a voiced sample has arrived
    this.silentSamples = 0; // silent model audio samples since the last voiced sample
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
    this.firstReplyAmbiguousMs = null; // caller spoke before the first reply
    this.ambiguousReplies = []; // reply starts inside a barge-in's tail-drop window
    this.openingAudio = []; // caller frames before session.started (memory only)
    this.replyAmbiguous = false;
    this.ambiguousUntil = null; // reply starts before this follow a barge-in too closely to time
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
      .finally(() => { this.admissionDone = true; })
      .catch(() => { this.noteError('admit_failed'); return false; });
    this.capTimer = setTimeout(() => { void this.finalize('cap'); }, this.deps.sessionCapMs);
    if (this.capTimer.unref) this.capTimer.unref();
    // No session.started in time = no Twilio start frame, a stalled admission,
    // or a refused or stuck OpenAI start: end the call rather than leave the
    // caller on a silent line. A late admission then finds the call finalizing.
    this.startTimer = setTimeout(() => {
      if (this.ready) return;
      this.noteError('start_timeout');
      void this.finalize('start_timeout');
    }, this.deps.startDeadlineMs);
    if (this.startTimer.unref) this.startTimer.unref();
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
    // Nothing is sent from the moment shutdown begins (session.close sent;
    // only the final usage is still awaited). Before the session is confirmed,
    // the caller's opening audio is held (OPENING_AUDIO_MAX_FRAMES).
    if (this._finalizing || typeof media.payload !== 'string' || (media.track && media.track !== 'inbound')) return;
    const sound = this.noteCallerFrame(media.payload);
    if (!this.ready) {
      this.openingAudio.push({ payload: media.payload, sound });
      if (this.openingAudio.length > OPENING_AUDIO_MAX_FRAMES) this.openingAudio.shift();
      return;
    }
    this.toOpenAi({ type: 'session.input_audio.append', audio: media.payload });
  }

  // Reads one caller frame's level: its RMS, so a stray sample at speech level
  // does not count. At CALLER_VOICED_RMS_MIN or more the frame holds voice, and
  // its arrival time is kept: a time, never audio. Frames that hold voice for
  // BARGE_IN_VOICE_MIN_MS in a row are a caller who speaks (callerSpokeAt):
  // only that can flush a reply. Returns whether the frame holds any sound
  // (OPENING_SOUND_RMS_MIN or more). That level is lower on purpose: timing
  // must be sure of voice, and the opening audio must not lose quiet speech.
  noteCallerFrame(payload) {
    const audio = Buffer.from(payload, 'base64');
    let sum = 0;
    for (let i = 0; i < audio.length; i++) sum += MULAW_SQUARE[audio[i]];
    const atLevel = (rms) => audio.length > 0 && sum >= audio.length * rms ** 2;
    const ms = audio.length / MULAW_BYTES_PER_MS;
    this.callerMs += ms;
    if (atLevel(CALLER_VOICED_RMS_MIN)) {
      this.callerVoicedMs += ms;
      this.callerVoiceAt = this.deps.now();
      this.callerRunMs += ms;
      if (this.callerRunMs >= BARGE_IN_VOICE_MIN_MS) this.callerSpokeAt = this.callerVoiceAt;
    } else {
      this.callerRunMs = 0;
    }
    return atLevel(OPENING_SOUND_RMS_MIN);
  }

  // When the caller stopped speaking, for a transcript fragment that arrives
  // at t: the arrival of the caller's last voiced frame. OpenAI's start_ms and
  // end_ms are not used. Measured on the live API (two sessions, 2026-11-20
  // and 11-21, four caller utterances): end_ms, counted from session.started,
  // ran 1.3 to 2.5 s after the caller's true last sound (in three of the four,
  // after the reply had begun), and its offset moved by more than a second
  // inside one session (OpenAI: "approximate fragment timing rather than exact
  // word boundaries").
  // The caller's own audio is exact, and the last fragment of an utterance
  // arrived 0.75 to 1.2 s after its last sound. With no voiced frame in the
  // last CALLER_END_LOOKBACK_MS (speech under the voice level) the bridge did
  // not hear the caller: null. That fragment times nothing and flushes
  // nothing. Its arrival says only that the caller spoke some time before it,
  // and a late fragment of a finished question must never cut the answer.
  // On a noisy line every frame is voiced, so the end reads as t: no reply
  // then waits CALLER_STOPPED_MIN_MS after it, and no delay is recorded
  // (replyDelay). caller_voiced_pct marks both kinds of call.
  callerSpeechEnd(t) {
    const voice = this.callerVoiceAt;
    return voice !== null && voice >= t - CALLER_END_LOOKBACK_MS ? voice : null;
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
      startMsg = buildSessionStart({ instructions: this.deps.buildInstructions(), voice: this.voice, greeting: this.deps.greeting() });
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
    if (this._finalizing) return; // shutting down: nothing more is sent
    // The held opening audio goes to OpenAI only when it holds sound (the
    // caller spoke, quietly too), and then from just before the first sound.
    // Held silence, the noise of a quiet line included, is dropped: it holds
    // nothing to answer. The one live session that got 1.6 s of it in a
    // burst (2026-11-20) was the one where the greeting was never spoken; the
    // session without it (11-21) greeted. From here on the caller's audio runs
    // in real time, silence included, as OpenAI's guide asks ("Wait for
    // session.started before sending audio", "keep input audio running").
    const opening = this.openingAudio;
    this.openingAudio = [];
    const first = opening.findIndex((frame) => frame.sound);
    if (first < 0) return;
    for (const frame of opening.slice(Math.max(0, first - OPENING_LEAD_FRAMES))) this.toOpenAi({ type: 'session.input_audio.append', audio: frame.payload });
  }

  // One pass over a model audio chunk, sample by sample, so the result does
  // not depend on how OpenAI cuts the stream into chunks. A voiced sample
  // starts a reply when it is the first voice of the call, or follows at least
  // silenceMinSamples of silent audio. Returns
  // the index of the first such sample (-1: none) and of the last voiced
  // sample (-1: none). A chunk is one arrival: it marks one reply start at
  // the most.
  scanModelAudio(audio, silenceMinSamples) {
    let start = -1;
    let last = -1;
    for (let i = 0; i < audio.length; i++) {
      if (!VOICED_BYTE[audio[i]]) {
        this.silentSamples += 1;
        continue;
      }
      if (start < 0 && (!this.voiceSeen || this.silentSamples >= silenceMinSamples)) start = i;
      this.voiceSeen = true;
      this.silentSamples = 0;
      last = i;
    }
    return { start, last };
  }

  onOutputAudio(msg) {
    if (typeof msg.delta !== 'string' || !msg.delta || !this.streamSid) return;
    const t = this.deps.now();
    // Measured on the live API 2026-11-20: GPT-Live's audio is a continuous
    // real-time stream (about 100 ms chunks every 100 ms from session.started
    // on) with digital silence (every mu-law byte 0xFF) between utterances. A
    // reply starts at the first voiced sample after at least
    // REPLY_SILENCE_MIN_MS of silent audio: a pause between two sentences of
    // one reply ran to 593 ms on the live API, and the model answers about 1 s
    // after the caller stops. A gap in arrival is delay on the way (the
    // network, or a busy process), not a reply boundary: one of 358 ms came in
    // a 24 s session, and the audio it held back arrived right after it. A
    // reply start marks its chunk whatever is still queued at Twilio, so a fast
    // reply and a reply right after a barge-in are both timed.
    const audio = Buffer.from(msg.delta, 'base64');
    // Inside the tail drop after a barge-in the boundary is main's 600 ms: a
    // new answer that follows a shorter silence than REPLY_SILENCE_MIN_MS must
    // play, and its delay is kept apart from turns there in any case.
    const dropping = this.tailDropSince !== null && t - this.tailDropSince < TAIL_DROP_MAX_MS;
    const { start, last } = this.scanModelAudio(audio, dropping ? TAIL_SILENCE_MIN_SAMPLES : REPLY_SILENCE_MIN_SAMPLES);
    // After a barge-in, audio that starts no reply is the cut-off reply's
    // tail: it is dropped, so the caller never hears it restart mid-sentence
    // (for TAIL_DROP_MAX_MS at the most). A reply start ends that: its chunk
    // is forwarded from the reply's first voiced sample on.
    let from = 0;
    if (this.tailDropSince !== null) {
      if (dropping && start < 0) return;
      if (dropping) from = start;
      this.tailDropSince = null;
    }
    if (start >= 0) {
      // GPT-Live audio carries no reply id or timing (OpenAI's guide), so a
      // reply start inside the 1.5 s after a barge-in is ambiguous: a fast
      // reply to the barge-in, or the cut-off reply's tail after a network
      // stall. It plays (cutting a real answer is worse) and its delay is kept
      // apart from turns.
      const ambiguous = this.ambiguousUntil !== null && t < this.ambiguousUntil;
      // Which reply answers which speech is decided on the chunk's arrival
      // (t): the model had sent all of it by then. The delay runs to the
      // reply's first voiced sample: the chunk's arrival plus the sample's
      // offset in the audio forwarded. Audio still queued at Twilio ahead of
      // it is not added (as before): the delay measures the model, and a
      // sample must not depend on a later flush.
      this.onReplyStart(t, ambiguous, t + (start - from) / MULAW_BYTES_PER_MS);
    }
    // Twilio plays this chunk after whatever is still queued.
    const playsAt = Math.max(t, this.playbackEndsAt);
    if (last >= 0) this.voiceEndsAt = playsAt + (last + 1 - from) / MULAW_BYTES_PER_MS;
    this.playbackEndsAt = playsAt + (audio.length - from) / MULAW_BYTES_PER_MS;
    const payload = from ? audio.subarray(from).toString('base64') : msg.delta;
    this.toTwilio({ event: 'media', streamSid: this.streamSid, media: { payload } });
  }

  // The pending measure is consumed only here, by a reply start. The first
  // reply start is the greeting (asked for in session.start): it is never timed,
  // even when the caller spoke before it.
  onReplyStart(t, ambiguous, voiceAt) {
    const greeting = this.replyStartWall === null;
    this.prevReplyStartWall = this.replyStartWall;
    this.replyStartWall = t;
    this.replyVoiceWall = voiceAt;
    this.replySample = null;
    this.replyAmbiguous = ambiguous;
    this.replyOverCaller = false;
    // A transcript fragment armed the measure. The reply answers the caller's
    // speech up to their last sound before it, and they may have said more
    // since that fragment: the speech end is their latest voiced frame.
    const speechEnd = this.awaitingReply && this.speechEndWall !== null ? Math.max(this.speechEndWall, this.callerVoiceAt) : null;
    this.awaitingReply = false;
    const delay = speechEnd === null ? null : this.replyDelay(speechEnd);
    if (delay === null) return;
    // The first reply is normally the greeting. When the caller spoke first,
    // it may instead be the answer: that delay is kept apart, never mixed into
    // the per-turn delays and never lost. A reply inside the 1.5 s after a
    // barge-in is kept apart as well (onOutputAudio).
    if (greeting && !ambiguous) {
      this.firstReplyAmbiguousMs = delay;
      return;
    }
    const samples = ambiguous ? this.ambiguousReplies : this.latencies;
    samples.push(delay);
    this.replySample = { index: samples.length - 1, speechEnd };
  }

  // The current reply's delay from a caller speech end: to the reply's first
  // voiced sample. null when that came under CALLER_STOPPED_MIN_MS after the
  // caller's last sound: the model spoke over the caller, or the line is noisy
  // and the bridge cannot hear the caller stop. That is no reply delay, so
  // none is recorded; the reply is counted in replies_over_caller, once.
  replyDelay(speechEnd) {
    const delay = Math.round(this.replyVoiceWall - speechEnd);
    if (delay >= CALLER_STOPPED_MIN_MS) return delay;
    if (!this.replyOverCaller) this.repliesOverCaller += 1;
    this.replyOverCaller = true;
    return null;
  }

  onInputTranscript(msg) {
    const text = typeof msg.delta === 'string' ? msg.delta : '';
    const t = this.deps.now();
    // A fragment with timing fields is caller speech. Its end_ms is not a
    // usable clock: callerSpeechEnd reads the caller's audio instead, and gives
    // null when the bridge did not hear the caller (no timing, no flush).
    const speechEnd = Number.isFinite(msg.end_ms) && this.sessionStartWall !== null ? this.callerSpeechEnd(t) : null;
    if (speechEnd !== null) this.noteSpeechEnd(speechEnd);
    if (text.trim() && this.isBargeIn(t, speechEnd)) {
      this.toTwilio({ event: 'clear', streamSid: this.streamSid });
      this.playbackEndsAt = t;
      this.voiceEndsAt = t;
      this.tailDropSince = t;
      this.ambiguousUntil = t + TAIL_DROP_MAX_MS;
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
    if (this.prevReplyStartWall !== null && speechEnd <= this.prevReplyStartWall) return;
    const delay = this.replyDelay(speechEnd);
    if (delay === null) return;
    if (this.prevReplyStartWall === null) {
      // A late transcript of speech that ended before the FIRST reply: that
      // reply may be the greeting or an answer, so the delay refines the
      // separate first_reply_ambiguous_ms (the latest speech end wins) and
      // never enters turns.
      this.firstReplyAmbiguousMs = this.firstReplyAmbiguousMs === null ? delay : Math.min(this.firstReplyAmbiguousMs, delay);
      return;
    }
    // The latest speech end before the reply wins. An ambiguous reply's sample
    // is refined the same way, in its own list: never in turns.
    const samples = this.replyAmbiguous ? this.ambiguousReplies : this.latencies;
    if (!this.replySample) {
      samples.push(delay);
      this.replySample = { index: samples.length - 1, speechEnd };
    } else if (speechEnd > this.replySample.speechEnd) {
      samples[this.replySample.index] = delay;
      this.replySample.speechEnd = speechEnd;
    }
  }

  // A barge-in is caller speech that runs past the start of the reply still
  // playing. A late transcript of words the caller finished BEFORE the reply
  // began is not one: flushing then would cut the answer to their question.
  // No timing, no flush. Silence queued at Twilio is nothing to cut: the check
  // runs to the last voiced sample queued. A pause inside a reply still to
  // play counts, because that reply is not over.
  // The proof is the caller's own audio: voice for BARGE_IN_VOICE_MIN_MS in a
  // row, past the reply's start, in the CALLER_END_LOOKBACK_MS this fragment
  // can be about. One noise frame after the reply began is not that: with it,
  // a late fragment of the finished question would cut its answer.
  isBargeIn(t, speechEnd) {
    if (t >= this.voiceEndsAt - BARGE_IN_MARGIN_MS) return false; // no voice (much) left to cut
    if (speechEnd === null || this.replyStartWall === null) return false;
    const spoke = this.callerSpokeAt;
    if (spoke === null || spoke < t - CALLER_END_LOOKBACK_MS) return false;
    return spoke > this.replyStartWall + BARGE_IN_MARGIN_MS;
  }

  // usage.seconds is a running total ("use the latest usage.seconds"): keep
  // the highest valid value; a negative or non-finite one is ignored.
  noteUsage(usage) {
    const seconds = usage && usage.seconds;
    if (!Number.isFinite(seconds) || seconds < 0) return;
    this.usageSeconds = this.usageSeconds === null ? seconds : Math.max(this.usageSeconds, seconds);
  }

  onSessionClosed(msg) {
    // The final usage settles the call only if it is a valid total no lower
    // than a running total OpenAI already reported. A contradiction keeps the
    // whole reservation (unsettled).
    const final = msg.usage && msg.usage.seconds;
    const valid = Number.isFinite(final) && final >= 0 && (this.usageSeconds === null || final >= this.usageSeconds);
    if (msg.usage && !valid) this.noteError('usage_contradicts');
    this.noteUsage(msg.usage);
    if (valid) this.usageConfirmed = true;
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
    // Whether this bridge owns the ledger row. A database still stalled after
    // closeWaitMs counts as not admitted: no ledger write now. If the claim
    // lands later, OpenAI was never opened (it opens only after admission), so
    // that row is settled at $0 then and frees its reservation.
    await waitAtMost(this.admission, this.deps.closeWaitMs);
    if (!this.admissionDone) {
      void this.admission.then((ok) => (ok ? this.settleLedger(0) : null));
    }
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
      first_reply_ambiguous_ms: this.firstReplyAmbiguousMs,
      after_barge_in_ambiguous_ms: this.ambiguousReplies,
      interruptions: this.interruptions,
      // Replies whose first voice came under CALLER_STOPPED_MIN_MS after the
      // caller's last sound: no delay is recorded for them.
      replies_over_caller: this.repliesOverCaller,
      // The share of the caller's audio in frames that hold voice. Near 0: the
      // bridge could not hear the caller. Near 100 (a noisy line): it could
      // not hear the caller stop. Either way no delay is recorded.
      caller_voiced_pct: this.callerMs ? Math.round((100 * this.callerVoicedMs) / this.callerMs) : null,
      delegations: this.delegations.size,
      errors,
    };
  }

  // Never throws: a failed write leaves the reservation standing (fail closed).
  async settleLedger(costUsd) {
    try {
      await this.deps.db()('voice_gpt_live_ledger').where({ call_sid: this.callSid }).update({ cost_usd: costUsd, settled_at: new Date() });
    } catch (err) {
      logger.warn(`[voice-live] ledger settle failed callSid=${this.callSid} code=${errCode(err)}`);
    }
  }

  async writeSummary(reason) {
    const db = this.deps.db();
    const summary = this.summary(reason);
    // The ledger first: it is the budget. A settled cost frees the rest of the
    // reservation; an unsettled call leaves its row alone (it keeps it all). A
    // bridge that never claimed the row leaves it to the cell route's release.
    if (summary.cost_usd !== undefined && this.admitted) await this.settleLedger(summary.cost_usd);
    // Only the bridge that holds the reservation writes the call's summary: a
    // refused or never-admitted socket must not overwrite the real session's.
    if (!this.admitted) {
      logger.warn(`[voice-live] not admitted, no summary callSid=${this.callSid} reason=${reason}`);
      return;
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
