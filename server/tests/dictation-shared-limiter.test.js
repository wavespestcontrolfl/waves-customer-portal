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

describe('live words spend from the same bucket', () => {
  test('a session counts as one clip, and only while half the budget is free', async () => {
    const { takeLiveSessionBudget, dictationLimiter } = require('../services/dictation-upload');
    expect(typeof dictationLimiter).toBe('function');
    const key = 'tech:budget-test:v1';
    for (let i = 0; i < 20; i += 1) expect(await takeLiveSessionBudget(key)).toBe(true);
    expect(await takeLiveSessionBudget(key)).toBe(false);
    // concurrent starts cannot all pass against an empty bucket
    const burst = await Promise.all(Array.from({ length: 100 }, () => takeLiveSessionBudget('tech:burst-test:v1')));
    expect(burst.filter(Boolean)).toHaveLength(20);
    // a full bucket whose window has passed admits again, before the store's own sweep
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    jest.setSystemTime(Date.now() + 16 * 60 * 1000);
    expect(await takeLiveSessionBudget(key)).toBe(true);
    jest.useRealTimers();
    // the clip route still has its other half: the limiter's own store holds the same count
    expect(await takeLiveSessionBudget('tech:other:v1')).toBe(true);
  });
});
