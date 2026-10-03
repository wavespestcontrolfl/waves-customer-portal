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

module.exports = { DICTATION_AUDIO_TYPES, DICTATION_MAX_BYTES, DICTATION_TOO_LARGE, dictationBaseType, dictationAudioUpload, dictationClipType };
