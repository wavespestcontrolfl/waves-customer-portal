/**
 * Staff voice-to-text through our own transcriber (GATE_SERVER_DICTATION).
 *
 *   GET  /api/tech/dictation/availability  -> { available }
 *   POST /api/tech/dictation                -> { text }
 *        multipart: audio (the clip), duration_seconds, customer_id?, service_id?
 *
 * Every staff mic (client/src/hooks/useSpeechDictation.js) records a clip and
 * posts it here instead of using the browser's speech recognition, which on an
 * iPhone is Apple dictation and mishears customer, product and pest names. The
 * clip is heard by the same transcriber Fast Complete voice fill uses
 * (OPENAI_VOICE_FILL_TRANSCRIBE_MODEL, default `gpt-transcribe`; lane
 * voice_fill_transcription), primed with a word list the SERVER builds from its
 * own records (services/dictation-word-list.js). The client sends ids only,
 * never prompt text. Admin and technician logins both reach it; it answers only
 * with the words the caller spoke, so a context id never returns record data.
 *
 * Nothing is stored: no row, no S3 object. The audit line carries sizes and
 * counts only, never the audio or the words (audio has no ledger: lane-policies
 * marks the transcription lane `unrecordable`).
 * Gate off: availability says { available: false } and POST answers 404, before
 * any audio is buffered, and every mic keeps the browser's behavior.
 */
const express = require('express');
const rateLimit = require('express-rate-limit');

const router = express.Router();
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const { rateLimitKey } = require('../middleware/rate-limit-key');
const { dictationAudioUpload, dictationClipType } = require('../services/dictation-upload');
const featureGates = require('../config/feature-gates');
const logger = require('../services/logger');

router.use(adminAuthenticate, requireTechOrAdmin);

// Paid transcription: cap clips per staff bucket (the same key as every other
// paid-LLM limiter) so a stuck retry loop cannot bill unbounded. 40 clips in
// 15 minutes is far above one person's honest cadence.
const dictationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: rateLimitKey,
  message: { error: 'Too many dictation clips. Type for now.' },
});

const { UUID_RE } = require('../services/dictation-word-list');
const uuidOrNull = (value) => (UUID_RE.test(String(value || '')) ? String(value) : null);

const gateOn = () => featureGates.serverDictationLive() === true;
const NOT_AVAILABLE = { error: 'Server dictation is not available' };

router.get('/availability', (req, res) => {
  res.json({ available: gateOn() && Boolean(process.env.OPENAI_API_KEY) });
});

// Gate first, so a gate-off request never costs 15 MB of memory in multer.
router.post('/', (req, res, next) => (gateOn() ? next() : res.status(404).json(NOT_AVAILABLE)),
  dictationLimiter, dictationAudioUpload(), async (req, res, next) => {
    try {
      if (!req.file || !req.file.buffer?.length) return res.status(400).json({ error: 'No audio provided' });
      const { baseType, filename } = dictationClipType(req.file);
      if (!filename) return res.status(415).json({ error: `Unsupported audio type: ${baseType || 'unknown'}` });

      // Ids only. The prompt is built here from our own records; nothing the
      // client sends other than an id ever reaches the transcriber.
      const { buildDictationPrompt } = require('../services/dictation-word-list');
      const customerId = uuidOrNull(req.body?.customer_id);
      const serviceId = uuidOrNull(req.body?.service_id);
      const prompt = await buildDictationPrompt({ customerId, serviceId });

      const { transcribeWithOpenAI, isImplausibleTranscript } = require('../services/call-recording-processor');
      const voiceFill = require('../services/fast-complete-voice-fill');
      const result = await transcribeWithOpenAI(req.file.buffer, {
        model: process.env.OPENAI_VOICE_FILL_TRANSCRIBE_MODEL || voiceFill.VOICE_FILL_TRANSCRIBE_MODEL,
        prompt,
        mimeType: baseType,
        filename,
        // silence is an answer ({ text: '' }), not a provider failure
        emptyOk: true,
      });
      const text = String(result?.text || '').trim();
      const context = serviceId ? 'service' : customerId ? 'customer' : 'none';
      logger.info(`[server-dictation] tech=${req.technicianId} bytes=${req.file.buffer.length} type=${baseType} context=${context} promptChars=${prompt.length} ok=${Boolean(result)} chars=${text.length}`);
      if (!result) return res.status(502).json({ error: 'Transcription unavailable. Type instead.' });
      // Same hallucination guard as call recordings and field dictation: far
      // more characters than the clip's seconds can hold is a fabricated
      // transcript. The client reports the recorded seconds; unknown fails open.
      const durationSeconds = Number(req.body?.duration_seconds) || 0;
      if (isImplausibleTranscript(text, durationSeconds)) {
        logger.warn(`[server-dictation] implausible transcript rejected chars=${text.length} seconds=${durationSeconds}`);
        return res.status(502).json({ error: 'Transcription looked unreliable. Try again or type.' });
      }
      return res.json({ text });
    } catch (err) { return next(err); }
  });

module.exports = router;
