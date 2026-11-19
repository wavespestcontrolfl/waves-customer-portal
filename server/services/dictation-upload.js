/**
 * The one audio-upload policy for clips a staff mic records in the browser:
 * field dictation (routes/tech-track.js) and Fast Complete voice fill
 * (routes/admin-dispatch.js). Both use the same recorder and the same
 * transcriber, so the accepted containers, the size cap and the multer error
 * handling live here once.
 */
const multer = require('multer');

// Container → the filename the transcriber sniffs the format from.
const DICTATION_AUDIO_TYPES = new Map([
  ['audio/webm', 'clip.webm'],
  ['audio/mp4', 'clip.mp4'],
  ['audio/x-m4a', 'clip.m4a'],
  ['audio/m4a', 'clip.m4a'],
  ['audio/mpeg', 'clip.mp3'],
  ['audio/ogg', 'clip.ogg'],
  ['audio/wav', 'clip.wav'],
]);
const DICTATION_MAX_BYTES = 15 * 1024 * 1024;
const DICTATION_TOO_LARGE = 'Recording too large (15 MB max)';

// Mime type as the browser reports it, stripped of codec parameters
// ("audio/webm;codecs=opus" → "audio/webm").
function dictationBaseType(mimetype) {
  return String(mimetype || '').split(';')[0].trim().toLowerCase();
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: DICTATION_MAX_BYTES } });

/**
 * Express middleware: buffers the `audio` part in memory under the cap. An
 * over-size clip is a 413 with `tooLargeBody` (each route keeps its own shape);
 * any other multer error goes to next().
 */
function dictationAudioUpload(tooLargeBody = { error: DICTATION_TOO_LARGE }) {
  return (req, res, next) => {
    upload.single('audio')(req, res, (err) => {
      if (!err) return next();
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json(tooLargeBody);
      return next(err);
    });
  };
}

/** The uploaded clip's base type and transcriber filename; filename is undefined for an unsupported type. */
function dictationClipType(file) {
  const baseType = dictationBaseType(file?.mimetype);
  return { baseType, filename: DICTATION_AUDIO_TYPES.get(baseType) };
}

// Paid transcription: ONE clip budget per staff bucket (the same key as every
// other paid-LLM limiter — rate-limit-key.js) shared by every dictation route
// (the visit upload in tech-track.js and server dictation in tech-dictation.js),
// so a stuck retry loop cannot bill unbounded by spreading clips across routes.
// 40 clips in 15 minutes is far above one person's honest cadence.
const { MemoryStore } = require('express-rate-limit');
const DICTATION_WINDOW_MS = 15 * 60 * 1000;
const DICTATION_MAX_CLIPS = 40;
const dictationStore = new MemoryStore();
const dictationLimiter = require('express-rate-limit')({
  windowMs: DICTATION_WINDOW_MS,
  max: DICTATION_MAX_CLIPS,
  store: dictationStore,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: require('../middleware/rate-limit-key').rateLimitKey,
  message: { error: 'Too many dictation clips. Type for now.' },
});

// Live words (services/dictation-live.js) spend from the SAME bucket: one live session counts as one clip. A
// session may start only while at most half the budget is used, so previews can never use up the clips that
// make the final words. Returns false (no session) when the bucket is too full.
const LIVE_SESSION_SHARE = DICTATION_MAX_CLIPS / 2;
// Admissions run one at a time: a read followed by a write would let concurrent starts all see an empty bucket.
let liveAdmissions = Promise.resolve();
async function admitLiveSession(key) {
  const used = await dictationStore.get(key);
  // The store drops an expired window only on its sweep, so a count past its reset time is not a count.
  const live = used && (!used.resetTime || used.resetTime.getTime() > Date.now()) ? used.totalHits : 0;
  if (live >= LIVE_SESSION_SHARE) return false;
  await dictationStore.increment(key);
  return true;
}
function takeLiveSessionBudget(key) {
  const admitted = liveAdmissions.then(() => admitLiveSession(key));
  liveAdmissions = admitted.catch(() => {});
  return admitted;
}

// The browser sends a clip again when no answer reached it (fetchWithNetworkRetry on iOS "Load failed", client
// hooks/serverDictation.js). When the first answer was lost on the way back, the transcriber already ran: the same
// login, route context and audio bytes within RECENT_CLIP_MS share that first call (or the call still running)
// instead of paying for it twice. A miss (null) or a throw is not kept, so a later send tries again. A call still
// running is never dropped: RECENT_CLIP_MS counts from when it settles, and the size cap drops settled entries only
// (running calls are bounded by dictationLimiter's 40 clips per 15 minutes per login).
const crypto = require('crypto');
const RECENT_CLIP_MS = 2 * 60 * 1000;
const RECENT_CLIP_MAX = 100;
const recentClips = new Map();

function forgetClip(key, entry) {
  if (recentClips.get(key) === entry) recentClips.delete(key);
}

function pruneRecentClips(now) {
  for (const [key, entry] of recentClips) {
    if (entry.settledAt !== null && now - entry.settledAt >= RECENT_CLIP_MS) recentClips.delete(key);
  }
  // Oldest settled first (Map keeps insertion order), leaving room for one more.
  for (const [key, entry] of recentClips) {
    if (recentClips.size < RECENT_CLIP_MAX) break;
    if (entry.settledAt !== null) recentClips.delete(key);
  }
}

/** `transcribe()` once per (scope, audio bytes) while it runs and RECENT_CLIP_MS after; returns its promise. */
function transcribeClipOnce(scope, buffer, transcribe) {
  pruneRecentClips(Date.now());
  const key = `${scope}|${crypto.createHash('sha256').update(buffer).digest('hex')}`;
  const hit = recentClips.get(key);
  if (hit) return hit.result;
  const entry = { result: Promise.resolve().then(transcribe), settledAt: null };
  recentClips.set(key, entry);
  entry.result.then(
    (value) => { if (value) entry.settledAt = Date.now(); else forgetClip(key, entry); },
    () => forgetClip(key, entry),
  );
  return entry.result;
}

module.exports = {
  transcribeClipOnce, __resetRecentClips: () => recentClips.clear(),
  takeLiveSessionBudget, DICTATION_AUDIO_TYPES, DICTATION_MAX_BYTES, DICTATION_TOO_LARGE, dictationBaseType, dictationAudioUpload, dictationClipType, dictationLimiter };
