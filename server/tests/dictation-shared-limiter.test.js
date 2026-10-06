// Paid transcription has ONE clip budget per staff bucket. Two dictation routes
// each with its own express-rate-limit would let the same token spend the budget
// once per route (Codex #6049 r6), so both must use the shared limiter.
const fs = require('fs');
const path = require('path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

describe('dictation routes share one paid-transcription limiter', () => {
  test('the shared module exports the limiter', () => {
    expect(typeof require('../services/dictation-upload').dictationLimiter).toBe('function');
  });

  test.each(['routes/tech-track.js', 'routes/tech-dictation.js'])('%s takes dictationLimiter from dictation-upload and builds no limiter of its own for it', (rel) => {
    const src = read(rel);
    expect(src).toMatch(/\{[^}]*\bdictationLimiter\b[^}]*\}\s*=\s*require\('\.\.\/services\/dictation-upload'\)/);
    expect(src).not.toMatch(/const\s+dictationLimiter\s*=/);
  });
});
