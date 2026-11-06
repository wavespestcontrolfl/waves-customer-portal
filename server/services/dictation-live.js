/**
 * Live words while a staff member talks (GATE_DICTATION_LIVE_WORDS).
 *
 * A PREVIEW only. The browser records the clip as before and POSTs it to /api/tech/dictation when the
 * mic stops; those are the final words. In the same moments the browser also streams its audio here
 * over the staff socket, and this module relays it to OpenAI's live transcription so the words can show
 * while the person is still talking. The browser drops the preview when the final words land.
 *
 * Socket events (staff sockets only; registerDictationLive is called from sockets/index.js):
 *   dictation:live:start  ({ customerId?, serviceId? }, ack)  -> ack({ ok } | { ok: false, reason })
 *   dictation:live:audio  (binary PCM16, 24 kHz, mono; at most MAX_FRAME_BYTES a frame)
 *   dictation:live:stop   (ack)  commits the audio, waits up to STOP_WAIT_MS for the last words, closes
 *   server -> client:  dictation:live:text { text }   the finished segments in order, then the live one
 *                      dictation:live:ended { reason } the session is over (a cap, an error, a stop)
 *
 * A second audio path leaves our server here (to api.openai.com), so it is kept narrow:
 *   - one session per socket; a disconnect closes it;
 *   - hard caps: MAX_SESSION_MS, MAX_SESSION_BYTES, MAX_FRAME_BYTES, and IDLE_MS with no audio;
 *   - each session spends one unit of the shared dictation budget (dictation-upload.js), and only while
 *     at most half of it is used, so previews never use up the clips that make the final words;
 *   - the context ids go through the same fence as the clip route (dictation-context.js) and the word
 *     list is built by the same server code (dictation-word-list.js); the client never sends words;
 *   - nothing is stored. The log carries counts and sizes only, never the words (and never an OpenAI
 *     error message, which may quote a keyword).
 * The text sent to the browser passes the same card-number mask as every other transcript.
 *
 * OpenAI events used (https://developers.openai.com/api/docs/guides/realtime-transcription):
 * conversation.item.input_audio_transcription.delta { item_id, delta } and .completed { item_id,
 * transcript } (matched by item_id: completions can arrive out of order), .failed, and error.
 */
const logger = require('./logger');
const featureGates = require('../config/feature-gates');
const { fenceDictationContext } = require('./dictation-context');
const { buildDictationHints } = require('./dictation-word-list');
const { takeLiveSessionBudget } = require('./dictation-upload');
const { transcriptionKeywords, mergeTranscriptionKeywords } = require('./call-recording-processor');
const { scrubPansDetailed } = require('../utils/pan-scrub');

const OPENAI_LIVE_URL = 'wss://api.openai.com/v1/realtime?intent=transcription';
const DEFAULT_LIVE_MODEL = 'gpt-live-transcribe';
const SAMPLE_RATE = 24000;
const BYTES_PER_SECOND = SAMPLE_RATE * 2;

const MAX_SESSION_MS = 3 * 60 * 1000;
// Three minutes of PCM16 plus a little slack for the last frame.
const MAX_SESSION_BYTES = BYTES_PER_SECOND * 185;
// One second of audio; the browser sends 100 to 200 ms frames.
const MAX_FRAME_BYTES = BYTES_PER_SECOND;
const IDLE_MS = 15 * 1000;
const OPEN_TIMEOUT_MS = 8 * 1000;
const STOP_WAIT_MS = 4 * 1000;
// A stalled upstream link must not queue audio without bound.
const MAX_BUFFERED_BYTES = 2 * 1024 * 1024;
// The bubble shows two lines; a long dictation keeps its newest words.
const MAX_TEXT_CHARS = 400;
// Under 100 ms of audio is not worth a commit.
const MIN_COMMIT_BYTES = BYTES_PER_SECOND / 10;
const WS_OPEN = 1;

const sessions = new Map();

const liveModel = () => process.env.OPENAI_LIVE_TRANSCRIBE_MODEL || DEFAULT_LIVE_MODEL;

// OpenAI rejects a keyword with <, >, CR or LF.
const cleanKeyword = (word) => String(word ?? '').replace(/[<>\r\n]/g, ' ').replace(/\s+/g, ' ').trim();

function liveKeywords(extra) {
  return mergeTranscriptionKeywords(transcriptionKeywords(), extra).map(cleanKeyword).filter(Boolean);
}

function sessionUpdate(prompt, keywords) {
  return {
    type: 'session.update',
    session: {
      type: 'transcription',
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: SAMPLE_RATE },
          transcription: { model: liveModel(), prompt, keywords: liveKeywords(keywords), languages: ['en'] },
          // gpt-live-transcribe has no server-side turn detection; the whole recording is one turn.
          turn_detection: null,
        },
      },
    },
  };
}

// The segments heard so far, in the order OpenAI first named them.
function joinedText(session) {
  const joined = session.order
    .map((id) => session.segments.get(id).text)
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  const text = scrubPansDetailed(joined).text;
  return text.length > MAX_TEXT_CHARS ? text.slice(text.length - MAX_TEXT_CHARS).replace(/^\S*\s/, '') : text;
}

function segmentFor(session, itemId) {
  const id = String(itemId || '');
  if (!session.segments.has(id)) {
    session.segments.set(id, { text: '', done: false });
    session.order.push(id);
  }
  return session.segments.get(id);
}

function emitText(session) {
  const text = joinedText(session);
  if (text === session.lastEmitted) return;
  session.lastEmitted = text;
  session.socket.emit('dictation:live:text', { text });
}

function handleUpstream(session, event) {
  session.events += 1;
  const type = event?.type;
  if (type === 'conversation.item.input_audio_transcription.delta') {
    const seg = segmentFor(session, event.item_id);
    if (!seg.done) seg.text += String(event.delta || '');
    emitText(session);
  } else if (type === 'conversation.item.input_audio_transcription.completed') {
    const seg = segmentFor(session, event.item_id);
    seg.text = String(event.transcript || '');
    seg.done = true;
    emitText(session);
    maybeFinishStop(session);
  } else if (type === 'input_audio_buffer.committed') {
    // The turn our commit closed; the stop waits for its words.
    segmentFor(session, event.item_id);
    session.committedItem = String(event.item_id || '');
    maybeFinishStop(session);
  } else if (type === 'conversation.item.input_audio_transcription.failed') {
    segmentFor(session, event.item_id).done = true;
    maybeFinishStop(session);
  } else if (type === 'error') {
    // The code only: the message may quote a keyword or part of the word list.
    logger.warn(`[dictation-live] upstream error code=${String(event?.error?.code || event?.error?.type || 'unknown').slice(0, 60)}`);
    endSession(session, 'upstream_error');
  }
}

function maybeFinishStop(session) {
  if (!session.stopping) return;
  const pending = [...session.segments.values()].some((seg) => !seg.done);
  if (!pending && session.committedItem && session.segments.get(session.committedItem)?.done) endSession(session, 'stopped');
}

function sendUpstream(session, message) {
  if (session.ws.readyState !== WS_OPEN) return false;
  session.ws.send(JSON.stringify(message));
  return true;
}

function endSession(session, reason) {
  if (session.ended) return;
  session.ended = true;
  clearTimeout(session.idleTimer);
  clearTimeout(session.maxTimer);
  clearTimeout(session.stopTimer);
  clearTimeout(session.openTimer);
  if (sessions.get(session.socket) === session) sessions.delete(session.socket);
  try {
    session.ws.close();
  } catch { /* already closed */ }
  logger.info(`[dictation-live] end reason=${reason} role=${session.role} user=${session.userId} frames=${session.frames} bytes=${session.bytes} events=${session.events} ms=${Date.now() - session.startedAt}`);
  if (reason !== 'disconnect') {
    try {
      session.socket.emit('dictation:live:ended', { reason });
    } catch { /* socket gone */ }
  }
  session.resolveStop?.();
}

function armIdleTimer(session) {
  clearTimeout(session.idleTimer);
  session.idleTimer = setTimeout(() => endSession(session, 'idle'), IDLE_MS);
  session.idleTimer.unref?.();
}

function onAudio(socket, data) {
  const session = sessions.get(socket);
  if (!session || session.ended || session.stopping || !session.ready) return;
  const frame = Buffer.isBuffer(data) ? data : (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) ? Buffer.from(data.buffer || data, data.byteOffset || 0, data.byteLength) : null;
  if (!frame || !frame.length || frame.length > MAX_FRAME_BYTES || frame.length % 2 !== 0) {
    endSession(session, 'bad_frame');
    return;
  }
  if (session.bytes + frame.length > MAX_SESSION_BYTES) {
    endSession(session, 'max_bytes');
    return;
  }
  if (session.ws.bufferedAmount > MAX_BUFFERED_BYTES) {
    endSession(session, 'slow_link');
    return;
  }
  session.frames += 1;
  session.bytes += frame.length;
  armIdleTimer(session);
  sendUpstream(session, { type: 'input_audio_buffer.append', audio: frame.toString('base64') });
}

function onStop(socket, ack) {
  const reply = typeof ack === 'function' ? ack : () => {};
  const session = sessions.get(socket);
  if (!session || session.ended) {
    reply({ ok: true });
    return;
  }
  session.stopping = true;
  clearTimeout(session.idleTimer);
  if (session.bytes < MIN_COMMIT_BYTES) {
    endSession(session, 'stopped');
    reply({ ok: true });
    return;
  }
  session.committed = sendUpstream(session, { type: 'input_audio_buffer.commit' });
  new Promise((resolve) => {
    session.resolveStop = resolve;
    session.stopTimer = setTimeout(() => endSession(session, 'stop_timeout'), STOP_WAIT_MS);
    session.stopTimer.unref?.();
    if (!session.committed) endSession(session, 'stopped');
  }).then(() => reply({ ok: true }));
}

// Everything that can refuse a session before any audio is accepted. Returns a reason string, or null.
async function refusal(socket) {
  if (!featureGates.dictationLiveWordsLive() || !featureGates.serverDictationLive()) return 'unavailable';
  if (!process.env.OPENAI_API_KEY) return 'unavailable';
  if (sessions.has(socket)) return 'busy';
  const key = `tech:${socket.userId}:v${socket.staffTokenVersion}`;
  if (!(await takeLiveSessionBudget(key))) return 'budget';
  return null;
}

function openSession(WebSocketImpl, socket, ids) {
  const ws = new WebSocketImpl(OPENAI_LIVE_URL, {
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    handshakeTimeout: OPEN_TIMEOUT_MS,
    perMessageDeflate: false,
  });
  const session = {
    socket,
    ws,
    role: socket.userType,
    userId: socket.userId,
    startedAt: Date.now(),
    segments: new Map(),
    order: [],
    lastEmitted: '',
    frames: 0,
    bytes: 0,
    events: 0,
    ready: false,
    stopping: false,
    committed: false,
    committedItem: '',
    ended: false,
    context: ids.serviceId ? 'service' : ids.customerId ? 'customer' : 'none',
  };
  sessions.set(socket, session);
  return session;
}

async function onStart(socket, payload, ack, WebSocketImpl) {
  const reply = typeof ack === 'function' ? ack : () => {};
  try {
    const refused = await refusal(socket);
    if (refused) return reply({ ok: false, reason: refused });
    const actor = { techRole: socket.userType, technicianId: socket.userId };
    const ids = await fenceDictationContext(actor, { customerId: payload?.customerId, serviceId: payload?.serviceId });
    const hints = await buildDictationHints({
      ...ids,
      scope: socket.userType === 'technician' ? { technicianId: socket.userId } : {},
    });
    // A refusal, a second start, or a disconnect may have landed while the word list was building.
    if (socket.disconnected) return reply({ ok: false, reason: 'disconnected' });
    if (sessions.has(socket)) return reply({ ok: false, reason: 'busy' });
    const session = openSession(WebSocketImpl, socket, ids);
    const { ws } = session;
    session.openTimer = setTimeout(() => {
      if (!session.ready) {
        reply({ ok: false, reason: 'open_timeout' });
        endSession(session, 'open_timeout');
      }
    }, OPEN_TIMEOUT_MS);
    session.openTimer.unref?.();
    ws.on('open', () => {
      if (session.ended) return;
      sendUpstream(session, sessionUpdate(hints.prompt, hints.keywords));
      session.ready = true;
      clearTimeout(session.openTimer);
      armIdleTimer(session);
      session.maxTimer = setTimeout(() => endSession(session, 'max_time'), MAX_SESSION_MS);
      session.maxTimer.unref?.();
      logger.info(`[dictation-live] start role=${session.role} user=${session.userId} context=${session.context} promptChars=${String(hints.prompt || '').length} keywords=${liveKeywords(hints.keywords).length}`);
      reply({ ok: true });
    });
    ws.on('message', (raw) => {
      let event;
      try {
        event = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!session.ended) handleUpstream(session, event);
    });
    ws.on('error', (err) => {
      // The error text is not logged: a handshake failure can echo request details.
      logger.warn(`[dictation-live] upstream socket error name=${String(err?.name || 'Error').slice(0, 40)}`);
      if (!session.ready) reply({ ok: false, reason: 'open_failed' });
      endSession(session, 'upstream_error');
    });
    ws.on('close', () => {
      if (!session.ready) reply({ ok: false, reason: 'open_failed' });
      endSession(session, session.stopping ? 'stopped' : 'upstream_closed');
    });
    return undefined;
  } catch (err) {
    logger.warn(`[dictation-live] start failed name=${String(err?.name || 'Error').slice(0, 40)}`);
    return reply({ ok: false, reason: 'error' });
  }
}

/** Wires the three events onto one STAFF socket. Called from sockets/index.js on connection. */
function registerDictationLive(socket, deps = {}) {
  const WebSocketImpl = deps.WebSocket || require('ws');
  socket.on('dictation:live:start', (payload, ack) => { void onStart(socket, payload, ack, WebSocketImpl); });
  socket.on('dictation:live:audio', (data) => onAudio(socket, data));
  socket.on('dictation:live:stop', (ack) => onStop(socket, ack));
  socket.on('disconnect', () => {
    const session = sessions.get(socket);
    if (session) endSession(session, 'disconnect');
  });
}

module.exports = {
  registerDictationLive,
  MAX_SESSION_MS,
  MAX_SESSION_BYTES,
  MAX_FRAME_BYTES,
  IDLE_MS,
  STOP_WAIT_MS,
  _sessions: sessions,
};
