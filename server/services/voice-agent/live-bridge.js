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
 * The session uses CLIENT delegation: when GPT-Live asks for help, it asks
 * this bridge. OpenAI's paid Responses backend is never used. Two modes, picked
 * once per call:
 *   - Default (GATE_VOICE_GPT_LIVE_TOOLS off): no tools and no lookups. Every
 *     delegation gets one fixed sentence. Nothing here books, captures a lead,
 *     texts or transfers.
 *   - Tools (GATE_VOICE_GPT_LIVE_TOOLS on, owner 2026-11-24): the delegation is
 *     answered by one Sandy conversation per call (live-brain.js, a
 *     RelayConversation as a sandbox PRACTICE LINE: public information only,
 *     prices, services and a dry-run new-customer request; no open times, no
 *     account tools and no caller recognition; writes are dry runs).
 *     GPT-Live's delegation names no task, so the bridge keeps the
 *     caller's transcript fragments IN MEMORY, hands the words since the last
 *     delegation to the brain (with what GPT-Live said just before, labelled),
 *     one ask at a time, and speaks its reply as a session.commentary.append
 *     (1,800 characters and 450 UTF-8 bytes at most, which bounds the tokens). An ask still running after 6 s gets
 *     one holding line on the same delegation id and the real answer follows as
 *     a second append; after 20 s the brain gives up with a fixed "call or text
 *     the office" line. At most BRAIN_ASK_CAP asks a call, then the fixed
 *     sentence. Still nothing texts or transfers, and nothing books or files
 *     for real.
 *
 * Logging and storage: callSid, codes, counts and timings only. The caller's
 * words are never stored or logged (the brain's reply is never stored or
 * logged either): the owner hears the trial calls himself, and a transcript
 * could hold card numbers or access codes. In tools mode the summary adds
 * brain_asks, brain_soft_timeouts, brain_hard_timeouts, and per ask in ms
 * brain_wait_ms (delegation to the brain's start), brain_ms (the brain's own
 * time) and brain_total_ms (delegation to the answer). Counts and times only.
 */

const logger = require('../logger');

const OPENAI_LIVE_URL = 'wss://api.openai.com/v1/live/sessions';
const LIVE_VOICES = Object.freeze(['marin', 'delta']);
const DEFAULT_VOICE = 'marin';
// The one answer to every delegation, spoken to the caller: the trial has no lookups.
const DELEGATION_REPLY = "I can't look that up on this test line. You can call or text the Waves office for that.";

// Tools mode (GATE_VOICE_GPT_LIVE_TOOLS): one brain ask per delegation.
const BRAIN_ASK_CAP = 15; // asks a call; after that the fixed sentence (each ask is a paid model call)
const BRAIN_REPLY_MAX_CHARS = 1800;
const BRAIN_REPLY_MAX_TOKENS = 450; // one commentary append holds 500 tokens at most; bounded by UTF-8 bytes (tokens <= bytes)
const BRAIN_NO_WORDS_REPLY = "Sorry, I didn't catch that. Could you say it again?";
const BRAIN_OPEN_MAX_MS = 4000; // the brain must be open within this of a delegation reaching its turn, or the fixed sentence
const BRAIN_STILL_REPLY = 'Still pulling that up.'; // spoken when an ask runs past the brain's soft deadline
const AGENT_TEXT_MAX_CHARS = 300; // what GPT-Live said, kept for the brain's context (the latest part)
const AGENT_UTTERANCES_KEPT = 4;
const BRAIN_EMPTY_REPLY = "I wasn't able to get that just now. You can call or text the Waves office.";
const CALLER_TEXT_MAX_CHARS = 1000; // caller words kept since the last delegation (the latest part)
const UTTERANCE_GAP_MS = 1200; // transcript fragments this far apart start a new caller utterance
const TRANSCRIPT_QUIET_MS = 350; // a delegation waits for the caller's transcript to be quiet this long
const TRANSCRIPT_MAX_WAIT_MS = 1500; // ...and at most this long (transcripts run behind the audio)

const WS_OPEN = 1;
const SESSION_CAP_MS = 10 * 60 * 1000;
const CLOSE_WAIT_MS = 5000;
const START_DEADLINE_MS = 10000; // session.started must arrive within this, or the call ends
const BARGE_IN_MARGIN_MS = 200;
const NEW_REPLY_GAP_MS = 250; // a model audio chunk this long after the one before starts a new reply
const REPLY_SILENCE_MIN_MS = 600; // model audio silent this long before voice begins starts a new reply
const VOICED_SAMPLE_MIN = 300; // a decoded sample at or above this magnitude (16-bit scale) is voice
const CALLER_VOICED_RMS_MIN = 300; // a caller frame at or above this RMS (16-bit scale) holds voice
const CALLER_SPEECH_MIN_MS = 100; // caller frames that hold voice this long in a row are speech; a shorter sound (a click, a knock) is not
const CALLER_GAP_MIN_MS = 20; // caller audio missing this long before a frame, by Twilio's media timestamps (one 20 ms frame of its), ends a run of voice
const TAIL_DROP_MAX_MS = 1500; // after a barge-in, drop the cut-off reply's tail at most this long
// Caller audio that arrives before session.started (admission and the OpenAI
// start) is held in memory, never stored: the latest 3 s at most (Twilio sends
// 20 ms frames). It is forwarded in order once the session is up when it
// holds sound (onSessionStarted).
const OPENING_AUDIO_MAX_FRAMES = 150;
const OPENING_SOUND_RMS_MIN = 100; // a held frame at or above this RMS (16-bit scale) may hold speech, quiet speech too; the noise of a quiet line is under it
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
const REPLY_SILENCE_MIN_SAMPLES = REPLY_SILENCE_MIN_MS * MULAW_BYTES_PER_MS;
// The squared linear value of each mu-law byte, for a frame's RMS.
const MULAW_SQUARE = Float64Array.from({ length: 256 }, (_, b) => mulawToLinear(b) ** 2);

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

// Tools mode replaces TRIAL_LIMITS (which says nothing can be looked up).
const TOOLS_LIMITS = [
  'TRIAL LIMITS (this overrides everything above):',
  'This is a practice line. Delegate only these: prices, services offered, and a new-customer request. For',
  'those, say only what the delegation result says; never guess or invent a price or service. A request is',
  'practice and changes nothing, and the result says so. You cannot check open appointment times, accounts,',
  'visits, invoices, estimates, messages or call history: if asked, say this practice line cannot check that,',
  'and they can call or text the Waves office. You cannot send a text or transfer the call, and nobody will',
  'call back from this line.',
].join('\n');

// ── Session setup pieces (pure, exported for tests) ────────────────────────

// Sandy's production system prompt (the same pure builders RelayConversation
// calls), then the trial limits last so they govern.
function buildLiveInstructions({ tools = false } = {}) {
  const { buildBasePrompt, composeSystemPrompt, getVoiceProfileTextNonBlocking } = require('./relay-conversation');
  const { isContextEnabled } = require('./relay-context');
  const base = buildBasePrompt(isContextEnabled(), null, { officeOpen: null });
  const text = `${composeSystemPrompt(base, getVoiceProfileTextNonBlocking())}\n\n${tools ? TOOLS_LIMITS : TRIAL_LIMITS}`;
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

const sleep = (ms) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  if (timer.unref) timer.unref();
});

// An upper bound on a reply's tokens that holds for any tokenizer: a token is at
// least one UTF-8 byte (byte-level and byte-fallback vocabularies never make a
// token of zero bytes), so tokens <= bytes. Averages (4 characters a token) fail
// on digits, punctuation-heavy identifiers and other languages; this cannot.
function estimateTokens(text) {
  return Buffer.byteLength(String(text), 'utf8');
}

// A reply cut so it fits BOTH maxChars and maxTokens (an append holds 500
// tokens), by that byte bound, at a sentence end when one lies in the second
// half of what fits, else at a word. 450 bytes is about 75 spoken words: short
// is fine on a phone.
function capReply(text, maxChars = BRAIN_REPLY_MAX_CHARS, maxTokens = BRAIN_REPLY_MAX_TOKENS) {
  const t = String(text || '').trim();
  if (t.length <= maxChars && estimateTokens(t) <= maxTokens) return t;
  let fit = 0;
  let bytes = 0;
  for (const ch of t) {
    bytes += Buffer.byteLength(ch, 'utf8');
    if (fit + ch.length > maxChars || bytes > maxTokens) break;
    fit += ch.length;
  }
  const head = t.slice(0, fit);
  const sentenceEnd = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '));
  if (sentenceEnd >= fit / 2) return head.slice(0, sentenceEnd + 1).trim();
  const wordEnd = head.lastIndexOf(' ');
  return (wordEnd > 0 ? head.slice(0, wordEnd) : head).trim();
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
    toolsOn: () => require('../../config/feature-gates').voiceGptLiveToolsLive(),
    brainFactory: (args) => require('./live-brain').LiveBrain.open(args),
    brainOpenMs: BRAIN_OPEN_MAX_MS,
    transcriptQuietMs: TRANSCRIPT_QUIET_MS,
    transcriptMaxWaitMs: TRANSCRIPT_MAX_WAIT_MS,
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
    this.sessionStartWall = null; // when session.started arrived: transcript ms count from here
    this.callerRunMs = 0; // length of the caller's current run of voiced frames
    this.callerRunSince = null; // ...and when the audio of that run began
    this.callerStampEnd = null; // Twilio's media timestamp at the end of the caller's last frame (ms from the stream start)
    this.callerSpokeAt = null; // arrival of the caller's latest frame of speech (noteCallerFrame)
    this.callerSpokeSinceReply = false; // ...and whether one came since the current reply began to arrive, in the order the bridge handled them
    this.callerMs = 0; // caller audio received, and the part of it in voiced frames (caller_voiced_pct)
    this.callerVoicedMs = 0;
    this.playbackEndsAt = 0;
    this.voiceEndsAt = 0; // wall time Twilio finishes the last voiced sample forwarded (silence queued after it is nothing to cut)
    this.replyStartWall = null; // wall time the model's current reply began (its audio arrived)
    this.replyVoiceWall = null; // ...and when its first voiced sample reached the bridge (delays run to it)
    this.replyDelayIn = null; // where the current reply's delay is kept: the list it is the last item of, or 'first' (firstReplyAmbiguousMs)
    this.lastAudioAt = null; // arrival time of the last model audio chunk
    this.voiceSeen = false; // a voiced sample has arrived
    this.silentSamples = 0; // silent model audio samples since the last voiced sample
    this.gapSinceVoice = false; // an arrival gap happened since the last voiced sample
    this.tailDropSince = null; // a barge-in cleared Twilio at this time: drop the old reply's tail

    this.latencies = [];
    this.interruptions = 0;
    this.errors = [];
    this.delegations = new Set();
    // Tools mode is read once per call, so its instructions and its delegation
    // answers agree whatever happens to the gate mid-call. A read that throws is off.
    this.tools = false;
    try { this.tools = this.deps.toolsOn() === true; } catch { /* off */ }
    this.brain = null;
    this.brainPromise = null; // the brain being opened, or open
    this.brainChain = Promise.resolve(); // delegations are answered one at a time
    this.brainAsks = 0;
    // Per ask (counts and ms only): the wait before the brain started (queue and
    // transcript settle), the brain's own time, and delegation to the answer.
    this.brainMs = [];
    this.brainWaitMs = [];
    this.brainTotalMs = [];
    this.brainRounds = []; // per ask: model rounds the relay conversation ran (counts only)
    // The caller's words, in memory only and never logged or stored: fragments
    // since the last delegation, and the latest two utterances for a delegation
    // that finds none. fragments counts them for the transcript settle.
    // Words not yet bound to a delegation, and the newest delegation's range, which
    // takes late fragments of its question until its transcript settles.
    this.callerPending = { text: '', startMs: null };
    this.callerLate = null;
    this.callerRecent = []; // { text, startMs }
    this.agentRecent = []; // what GPT-Live said, { text, startMs }, so "yes, the second one" has a referent
    this.agentFragmentEndMs = null;
    this.callerFragments = 0;
    this.callerFragmentEndMs = null;
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
    const sound = this.noteCallerFrame(media.payload, media.timestamp);
    if (!this.ready) {
      this.openingAudio.push({ payload: media.payload, sound });
      if (this.openingAudio.length > OPENING_AUDIO_MAX_FRAMES) this.openingAudio.shift();
      return;
    }
    this.toOpenAi({ type: 'session.input_audio.append', audio: media.payload });
  }

  // Reads one caller frame's level: its RMS, so one stray sample at speech
  // level does not count. Only levels and times are kept, never audio.
  // At CALLER_VOICED_RMS_MIN or more the frame holds voice. Caller SPEECH is
  // voice for CALLER_SPEECH_MIN_MS in a row, and nothing else: a shorter sound
  // (a click, a knock) times nothing. Frames are in a row by Twilio's media
  // timestamp, the frame's place in the stream: when CALLER_GAP_MIN_MS of
  // audio or more is missing before this frame, whatever this frame's own
  // length, that ends the run as a silent frame does. The
  // arrival of the latest frame of speech is kept (callerSpokeAt); reply
  // delays start there (onReplyStart). Speech from before session.started
  // starts no delay: the model hears it only once the session is up, and the
  // oldest of it may be gone from the held opening audio by then.
  // A frame holds the audio from just before it arrived, so a run of voice
  // began one frame length before its first frame arrived (callerRunSince).
  // Returns whether the frame holds any sound (OPENING_SOUND_RMS_MIN or more),
  // for the held opening audio. That level is lower on purpose: speech for
  // timing must be sure, and the opening audio must not lose quiet speech.
  noteCallerFrame(payload, timestamp) {
    const audio = Buffer.from(payload, 'base64');
    let sum = 0;
    for (let i = 0; i < audio.length; i++) sum += MULAW_SQUARE[audio[i]];
    const atLevel = (rms) => audio.length > 0 && sum >= audio.length * rms ** 2;
    const ms = audio.length / MULAW_BYTES_PER_MS;
    this.callerMs += ms;
    const stamp = Number.parseInt(timestamp, 10);
    if (Number.isFinite(stamp)) {
      if (this.callerStampEnd !== null && stamp - this.callerStampEnd >= CALLER_GAP_MIN_MS) this.callerRunMs = 0;
      this.callerStampEnd = stamp + ms;
    }
    if (atLevel(CALLER_VOICED_RMS_MIN)) {
      const now = this.deps.now();
      if (this.callerRunMs === 0) this.callerRunSince = now - ms;
      this.callerVoicedMs += ms;
      this.callerRunMs += ms;
      if (this.ready && this.callerRunMs >= CALLER_SPEECH_MIN_MS) {
        this.callerSpokeAt = now;
        this.callerSpokeSinceReply = true;
        // This speech began before the current reply's first voiced sample and
        // goes on now that the reply's chunk has arrived: that reply did not
        // wait for the caller. The run's begin decides, not this frame's
        // arrival: a run is known as speech only CALLER_SPEECH_MIN_MS after it
        // began, and that can be after the reply's first voice.
        if (this.replyVoiceWall !== null && this.callerRunSince < this.replyVoiceWall) this.dropReplyDelay();
      }
    } else {
      this.callerRunMs = 0;
    }
    return atLevel(OPENING_SOUND_RMS_MIN);
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
      startMsg = buildSessionStart({ instructions: this.deps.buildInstructions({ tools: this.tools }), voice: this.voice, greeting: this.deps.greeting() });
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
      'session.output_transcript.delta': () => { if (this.tools) this.noteAgentText(msg); },
      'session.delegation.created': () => this.onDelegation(msg.delegation, msg.offset_ms),
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
    // The brain opens now, not at the first delegation: the caller check it makes
    // allows a call only so long after it began.
    if (this.tools) void this.ensureBrain();
    // The held opening audio goes to OpenAI only when it holds sound (the
    // caller spoke, quietly too), and then from just before the first sound.
    // Held silence, the noise of a quiet line included, is dropped: it holds
    // nothing to answer. The one live session that got 1.6 s of it in a burst
    // (2026-11-20) was the one where the greeting was never spoken; the
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
  // REPLY_SILENCE_MIN_MS of silent audio, or follows an arrival gap. Returns
  // the index of the first such sample (-1: none) and of the last voiced
  // sample (-1: none). A chunk is one arrival: it marks one reply start at
  // the most.
  scanModelAudio(audio) {
    let start = -1;
    let last = -1;
    for (let i = 0; i < audio.length; i++) {
      if (!VOICED_BYTE[audio[i]]) {
        this.silentSamples += 1;
        continue;
      }
      if (start < 0 && (!this.voiceSeen || this.gapSinceVoice || this.silentSamples >= REPLY_SILENCE_MIN_SAMPLES)) start = i;
      this.voiceSeen = true;
      this.gapSinceVoice = false;
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
    // on) with digital silence (every mu-law byte 0xFF) between utterances, so
    // an arrival gap alone does not mark a reply. A reply starts at the first
    // voiced sample after at least REPLY_SILENCE_MIN_MS of silent audio (pauses
    // inside one utterance are under about 500 ms), or after an arrival gap
    // (OpenAI pausing the stream). A reply start marks its chunk whatever is
    // still queued at Twilio, so a fast reply and a reply right after a
    // barge-in are both timed.
    const audio = Buffer.from(msg.delta, 'base64');
    if (this.lastAudioAt !== null && t - this.lastAudioAt >= NEW_REPLY_GAP_MS) this.gapSinceVoice = true;
    this.lastAudioAt = t;
    const { start, last } = this.scanModelAudio(audio);
    // After a barge-in, audio that starts no reply is the cut-off reply's
    // tail: it is dropped, so the caller never hears it restart mid-sentence
    // (for TAIL_DROP_MAX_MS at the most). A reply start ends that: its chunk
    // is forwarded from the reply's first voiced sample on.
    let from = 0;
    if (this.tailDropSince !== null) {
      const dropping = t - this.tailDropSince < TAIL_DROP_MAX_MS;
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

  // A reply's delay runs from the caller's last speech to the reply's first
  // voiced sample. Both are taken at the bridge: when the caller's frame
  // arrived (the bridge forwards a frame as it arrives, so the model has heard
  // nothing later) and when the model's chunk arrived. No transcript is used:
  // OpenAI's start_ms and end_ms are not a usable clock. Measured on the live
  // API (two sessions, 2026-11-20 and 11-21, four caller utterances): end_ms,
  // counted from session.started, ran 1.3 to 2.5 s after the caller's true
  // last sound (in three of the four, after the reply had begun), and its
  // offset moved by more than a second inside one session (OpenAI:
  // "approximate fragment timing rather than exact word boundaries"). With it
  // every delay read 0.
  // A reply answers the caller's last speech when that speech came after the
  // reply before it began to arrive. "After" is the order in which the bridge
  // handled the frame and the chunk, not their clock times: the two can share
  // a millisecond. With no such speech (the model goes on by itself) the reply
  // has no delay. The first reply is normally the greeting.
  // When the caller spoke first (after session.started) it may instead be the
  // answer: that delay is kept apart, never in turns. A reply inside the 1.5 s
  // after a barge-in is kept apart as well (onOutputAudio).
  onReplyStart(t, ambiguous, voiceAt) {
    const first = this.replyStartWall === null;
    const spoke = this.callerSpokeSinceReply;
    this.replyStartWall = t;
    this.replyVoiceWall = voiceAt;
    this.replyDelayIn = null;
    this.callerSpokeSinceReply = false;
    if (!spoke) return; // no caller speech since the reply before this one began
    // Both times are the bridge's wall clock (deps.now), as every time in this
    // file. Never negative when that clock steps back, as before this change.
    const delay = Math.max(0, Math.round(voiceAt - this.callerSpokeAt));
    if (ambiguous) this.replyDelayIn = this.ambiguousReplies;
    else this.replyDelayIn = first ? 'first' : this.latencies;
    if (this.replyDelayIn === 'first') this.firstReplyAmbiguousMs = delay;
    else this.replyDelayIn.push(delay);
  }

  // Takes back the current reply's delay. Caller speech that began before the
  // reply's first voiced sample goes on after the reply's chunk arrived
  // (noteCallerFrame): the model spoke over the caller, or the line is noisy
  // and the bridge cannot hear the caller stop. Either way the number would
  // not be a reply delay. The caller's audio after the reply began decides,
  // not how short the delay is: a fast reply after the caller truly stopped
  // is followed by silence and keeps its delay.
  dropReplyDelay() {
    if (this.replyDelayIn === 'first') this.firstReplyAmbiguousMs = null;
    else if (this.replyDelayIn) this.replyDelayIn.pop();
    this.replyDelayIn = null;
  }

  onInputTranscript(msg) {
    const text = typeof msg.delta === 'string' ? msg.delta : '';
    const t = this.deps.now();
    // start_ms / end_ms count from the start of the Live session, so they map
    // to wall time from session.started, not from the first caller packet.
    // The reply delay does not read them (onReplyStart). The barge-in flush
    // here still does, unchanged.
    if (this.tools) this.noteCallerText(msg);
    const speechEnd = Number.isFinite(msg.end_ms) && this.sessionStartWall !== null ? this.sessionStartWall + msg.end_ms : null;
    if (text.trim() && this.isBargeIn(t, speechEnd)) {
      this.toTwilio({ event: 'clear', streamSid: this.streamSid });
      this.playbackEndsAt = t;
      this.voiceEndsAt = t;
      this.tailDropSince = t;
      this.ambiguousUntil = t + TAIL_DROP_MAX_MS;
      this.interruptions += 1;
    }
  }

  // A barge-in is caller speech that runs past the start of the reply still
  // playing. A late transcript of words the caller finished BEFORE the reply
  // began is not one: flushing then would cut the answer to their question.
  // No timing, no flush. Silence queued at Twilio is nothing to cut: the check
  // runs to the last voiced sample queued. A pause inside a reply still to
  // play counts, because that reply is not over.
  isBargeIn(t, speechEnd) {
    if (t >= this.voiceEndsAt - BARGE_IN_MARGIN_MS) return false; // no voice (much) left to cut
    if (speechEnd === null || this.replyStartWall === null) return false;
    return speechEnd > this.replyStartWall + BARGE_IN_MARGIN_MS;
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
  // GPT-Live asks THIS bridge for help (client delegation). Without tools mode
  // each ask gets the same fixed answer, once, as commentary: the caller hears
  // it (thinking would be silent and leave the caller waiting). With tools mode
  // the brain's reply is that one commentary append, in the order asked.
  // A delegation to any other target would be paid backend work this session
  // never set up: end the call.
  onDelegation(delegation, offsetMs = null) {
    const id = delegation && typeof delegation.id === 'string' ? delegation.id : '';
    if (!id || this.delegations.has(id) || this._finalizing) return;
    this.delegations.add(id);
    if (delegation.target !== 'client') {
      this.noteError('unexpected_delegation');
      void this.finalize('unexpected_delegation');
      return;
    }
    if (this.tools) {
      const receivedAt = this.deps.now();
      const range = this.openRange(offsetMs); // this delegation's words, bound now, not when it reaches the front of the queue
      this.brainChain = this.brainChain.then(() => this.answerWithBrain(id, receivedAt, range)).catch(() => {});
      return;
    }
    this.toOpenAi({ type: 'session.commentary.append', delegation_id: id, content: DELEGATION_REPLY });
  }

  // ── tools mode: the brain answers ────────────────────────────────────────
  // Transcript fragments, caller's and GPT-Live's, kept in memory (never logged
  // or stored). A gap between fragments starts a new utterance.
  static addFragment(list, endMs, msg, keep) {
    const text = typeof msg.delta === 'string' ? msg.delta : '';
    if (!text.trim()) return endMs;
    const start = Number.isFinite(msg.start_ms) ? msg.start_ms : null;
    const fresh = !list.length || (start !== null && endMs !== null && start - endMs >= UTTERANCE_GAP_MS);
    if (fresh) list.push({ text: text.slice(-CALLER_TEXT_MAX_CHARS), startMs: start });
    else list[list.length - 1].text = (list[list.length - 1].text + text).slice(-CALLER_TEXT_MAX_CHARS);
    if (list.length > keep) list.shift();
    return Number.isFinite(msg.end_ms) ? msg.end_ms : endMs;
  }

  // A fragment that arrives while a delegation's transcript is settling is the late tail of ITS question only
  // when its audio time (start_ms) runs on from that question: before the delegation, or within one utterance gap
  // of the question's last word. One that starts later is the caller's next question, and waits for the next
  // delegation. A fragment with no usable time keeps the old rule (it joins the delegation that is settling).
  static belongsToLate(range, msg) {
    if (!Number.isFinite(msg.start_ms)) return true;
    const anchors = [range.endMs, range.offsetMs].filter(Number.isFinite);
    if (!anchors.length) return true;
    return msg.start_ms - Math.max(...anchors) < UTTERANCE_GAP_MS;
  }

  noteCallerText(msg) {
    const text = typeof msg.delta === 'string' ? msg.delta : '';
    if (!text.trim()) return;
    this.callerFragments += 1;
    const range = this.callerLate && this.callerLate.open && LiveBridge.belongsToLate(this.callerLate, msg) ? this.callerLate : this.callerPending;
    if (range === this.callerLate && Number.isFinite(msg.end_ms)) range.endMs = Math.max(range.endMs ?? msg.end_ms, msg.end_ms);
    if (!range.text && Number.isFinite(msg.start_ms)) range.startMs = msg.start_ms;
    range.text = (range.text + text).slice(-CALLER_TEXT_MAX_CHARS);
    this.callerFragmentEndMs = LiveBridge.addFragment(this.callerRecent, this.callerFragmentEndMs, msg, 2);
  }

  noteAgentText(msg) {
    this.agentFragmentEndMs = LiveBridge.addFragment(this.agentRecent, this.agentFragmentEndMs, msg, AGENT_UTTERANCES_KEPT);
  }

  // A delegation's own words, bound when it ARRIVES: everything not yet bound to
  // an earlier delegation. Late fragments of its question join it until its
  // transcript settles (noteCallerText) or the next delegation arrives. Queued
  // delegations each keep their own range, however long they wait.
  openRange(offsetMs = null) {
    // The delegation before this one closes now, with its context frozen as of now: it never
    // reads the shared fragments again, whatever is said after this delegation arrives.
    if (this.callerLate) this.freezeRange(this.callerLate);
    // offsetMs: where GPT-Live's session clock stood when it delegated; endMs: where this range's own words ended.
    // Together they tell a late continuation of this question from the caller's NEXT one (belongsToLate).
    const range = {
      text: this.callerPending.text, startMs: this.callerPending.startMs, open: this.deps.transcriptQuietMs > 0, // no settle wait: closed at once
      offsetMs: Number.isFinite(offsetMs) ? offsetMs : null, endMs: this.callerFragmentEndMs,
      // The fallback for a delegation with no words of its own, fixed HERE: what the caller said before it arrived.
      // A later question (it goes to the next delegation) never becomes this one's fallback.
      fallback: this.callerRecent.map((u) => ({ text: u.text, startMs: u.startMs })),
    };
    this.callerPending = { text: '', startMs: null };
    this.callerLate = range;
    // The context is FROZEN as the range closes (its words, the fallback utterances and the
    // agent line before them): later speech never changes what this delegation asks.
    if (!range.open) {
      this.freezeRange(range);
      range.settled = Promise.resolve();
    } else {
      range.settled = this.settleTranscript().then(() => this.freezeRange(range));
    }
    return range;
  }

  // The first close wins: later calls (the settle timer after the next delegation arrived) change nothing.
  freezeRange(range) {
    if (range.frozen) return;
    range.frozen = true;
    range.open = false;
    range.prompt = this.takeCallerText(range);
  }

  // The words for one ask: its range, else the latest two utterances; with what
  // GPT-Live said just before them, labelled, so the brain can tell what "yes,
  // the second one" answers. GPT-Live's own "let me check" lines, spoken after
  // the caller, are left out by time.
  takeCallerText(range) {
    const clean = (t) => t.replace(/\s+/g, ' ').trim();
    let words = clean(range.text);
    let startMs = range.startMs;
    if (!words) {
      words = clean(range.fallback.map((u) => u.text).join(' ')).slice(-CALLER_TEXT_MAX_CHARS);
      startMs = range.fallback.length ? range.fallback[0].startMs : null;
    }
    if (!words) return '';
    const before = this.agentRecent.filter((u) => startMs === null || u.startMs === null || u.startMs < startMs);
    const agent = before.length ? clean(before[before.length - 1].text).slice(-AGENT_TEXT_MAX_CHARS) : '';
    return agent ? `Agent just said: ${agent}\nCaller said: ${words}` : words;
  }

  // GPT-Live's delegation arrives before the caller's transcript is complete
  // (fragments run behind the audio): wait until no fragment has come for a
  // quiet spell, within a bound.
  async settleTranscript() {
    const { transcriptQuietMs: quiet, transcriptMaxWaitMs: max } = this.deps;
    if (!(quiet > 0)) return;
    const end = Date.now() + max;
    for (;;) {
      const seen = this.callerFragments;
      await sleep(quiet);
      if (this.callerFragments === seen || Date.now() >= end || this._finalizing) return;
    }
  }

  ensureBrain() {
    if (!this.brainPromise) {
      this.brainPromise = Promise.resolve()
        .then(() => this.deps.brainFactory({ callSid: this.callSid, db: this.deps.db() }))
        .then((brain) => {
          this.brain = brain;
          if (this._finalizing) void brain.end('bridge_closed');
          return brain;
        })
        .catch((err) => {
          this.noteError('brain_open_failed');
          logger.warn(`[voice-live] brain open failed callSid=${this.callSid} code=${errCode(err)}`);
          return null;
        });
    }
    return this.brainPromise;
  }

  // What to say for one delegation, and whether the brain was asked (so its
  // times are kept). Never throws. A delegation past the soft deadline gets a
  // holding line through say(), then this returns the real answer.
  async brainReply(say, range) {
    if (this.brainAsks >= BRAIN_ASK_CAP) return { reply: DELEGATION_REPLY };
    await range.settled;
    if (this._finalizing) return { reply: DELEGATION_REPLY };
    const words = range.prompt;
    if (!words) return { reply: BRAIN_NO_WORDS_REPLY };
    // A brain that is slow to open (a stalled database read) must not hold every queued
    // delegation without a word: past the bound the fixed sentence is the answer, and a
    // brain that opens later still serves the asks after it.
    const brain = await waitAtMost(this.ensureBrain(), this.deps.brainOpenMs);
    if (brain === undefined) this.noteError('brain_open_timeout');
    if (!brain || this._finalizing) return { reply: DELEGATION_REPLY };
    this.brainAsks += 1;
    const startedAt = this.deps.now();
    let reply;
    try {
      reply = await brain.ask(words, { onSoft: () => say(BRAIN_STILL_REPLY) });
      if (brain.lastRan === false) {
        // A retired or closed brain answered without running anything: no paid call, so not counted or timed.
        this.brainAsks -= 1;
        return { reply: capReply(reply) || DELEGATION_REPLY };
      }
    } catch (err) {
      this.noteError('brain_error');
      logger.warn(`[voice-live] brain ask failed callSid=${this.callSid} code=${errCode(err)}`);
      return { reply: DELEGATION_REPLY, startedAt, endedAt: this.deps.now() };
    }
    const endedAt = this.deps.now();
    const spoken = capReply(reply);
    if (spoken) return { reply: spoken, startedAt, endedAt };
    this.noteError('brain_empty');
    return { reply: BRAIN_EMPTY_REPLY, startedAt, endedAt };
  }

  speak(id, content) {
    if (!this._finalizing) this.toOpenAi({ type: 'session.commentary.append', delegation_id: id, content });
  }

  async answerWithBrain(id, receivedAt, range) {
    if (this._finalizing) return;
    const { reply, startedAt, endedAt } = await this.brainReply((line) => this.speak(id, line), range);
    this.speak(id, reply); // nothing is sent if the call ended while the brain worked
    if (startedAt === undefined) return;
    const ms = (from, to) => Math.max(0, to - from);
    this.brainWaitMs.push(ms(receivedAt, startedAt));
    this.brainMs.push(ms(startedAt, endedAt));
    this.brainTotalMs.push(ms(receivedAt, this.deps.now()));
    const usage = (this.brain && this.brain.lastUsage) || {};
    this.brainRounds.push(Number(usage.rounds) || 0);
  }

  async endBrain() {
    if (!this.brainPromise) return;
    const brain = await this.brainPromise;
    if (brain) await brain.end('bridge_closed');
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
    // Stops the brain first: any model round it has running spends until it ends.
    const brainEnded = this.endBrain().catch(() => {});
    await this.closeOpenAi();
    await waitAtMost(brainEnded, this.deps.closeWaitMs);
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
      // The share of the caller's audio in frames that hold voice. Near 100 (a
      // noisy line) or 0 (speech under the voice level) the bridge cannot hear
      // the caller stop, and turns holds few delays or none.
      caller_voiced_pct: this.callerMs ? Math.round((100 * this.callerVoicedMs) / this.callerMs) : null,
      delegations: this.delegations.size,
      // Tools mode only, counts and times: how many asks the brain served (each
      // a paid model call); how many ran past its soft deadline (a holding line
      // was spoken and the answer still came) and how many hit the hard one (given
      // up); and for each ask in ms, the wait before the brain started (queue and
      // transcript settle), the brain's time, and delegation to the answer; and for
      // each ask the model rounds and paid tool calls it ran (what the spend estimate rests on).
      ...(this.tools ? {
        brain_asks: this.brainAsks,
        brain_soft_timeouts: this.brain ? this.brain.softTimeouts : 0,
        brain_hard_timeouts: this.brain ? this.brain.hardTimeouts : 0,
        brain_wait_ms: this.brainWaitMs,
        brain_ms: this.brainMs,
        brain_total_ms: this.brainTotalMs,
        brain_rounds: this.brainRounds,
      } : {}),
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
  TOOLS_LIMITS,
  BRAIN_ASK_CAP,
  BRAIN_REPLY_MAX_CHARS,
  capReply,
  estimateTokens,
  BRAIN_REPLY_MAX_TOKENS,
  OPENAI_LIVE_URL,
  INSTRUCTIONS_MAX_CHARS,
  PER_CALL_RESERVE_USD,
  callCostUsd,
};
