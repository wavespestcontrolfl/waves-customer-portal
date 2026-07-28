const CallRecordingProcessor = require('../services/call-recording-processor');

describe('recording download verification', () => {
  const { verifyRecordingBuffer } = CallRecordingProcessor._test;

  // Prod Twilio recordings run ~7.8KB/s (64kbps mp3); the floor is 3000 B/s.
  const bufferOf = (bytes) => Buffer.alloc(bytes);

  test('accepts a full-size buffer for the known duration', () => {
    expect(verifyRecordingBuffer(bufferOf(254 * 7800), 254, String(254 * 7800)).ok).toBe(true);
  });

  test('rejects a buffer far below the duration floor as a partial read', () => {
    const verdict = verifyRecordingBuffer(bufferOf(20 * 1024), 254, null);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('below_duration_floor');
  });

  test('rejects a body shorter than the declared Content-Length', () => {
    const verdict = verifyRecordingBuffer(bufferOf(100_000), 10, '150000');
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('short_read');
  });

  test('sub-3s recordings skip the duration floor (legitimately tiny)', () => {
    expect(verifyRecordingBuffer(bufferOf(4_000), 2, null).ok).toBe(true);
  });

  test('unknown duration passes through (no false rejects on missing metadata)', () => {
    expect(verifyRecordingBuffer(bufferOf(1_000), null, null).ok).toBe(true);
    expect(verifyRecordingBuffer(bufferOf(1_000), 0, null).ok).toBe(true);
    expect(verifyRecordingBuffer(bufferOf(1_000), undefined, undefined).ok).toBe(true);
  });

  test('missing or bogus Content-Length does not trip the short-read check', () => {
    expect(verifyRecordingBuffer(bufferOf(60 * 7800), 60, null).ok).toBe(true);
    expect(verifyRecordingBuffer(bufferOf(60 * 7800), 60, 'not-a-number').ok).toBe(true);
  });
});

describe('transcription keyword hints', () => {
  const { modelSupportsKeywordHints, transcriptionKeywords } = CallRecordingProcessor._test;

  test('gpt-transcribe family supports keyword hints', () => {
    expect(modelSupportsKeywordHints('gpt-transcribe')).toBe(true);
    expect(modelSupportsKeywordHints('gpt-transcribe-2026-06')).toBe(true);
    expect(modelSupportsKeywordHints('gpt-live-transcribe')).toBe(true);
  });

  test('gpt-4o generation and whisper do NOT get the keywords parameter', () => {
    expect(modelSupportsKeywordHints('gpt-4o-transcribe')).toBe(false);
    expect(modelSupportsKeywordHints('gpt-4o-transcribe-diarize')).toBe(false);
    expect(modelSupportsKeywordHints('gpt-4o-mini-transcribe')).toBe(false);
    expect(modelSupportsKeywordHints('whisper-1')).toBe(false);
    expect(modelSupportsKeywordHints(null)).toBe(false);
  });

  test('default keyword list carries the misheard service-area proper nouns', () => {
    const keywords = transcriptionKeywords();
    expect(keywords).toContain('Englewood');
    expect(keywords).toContain('Waves Pest Control');
    expect(keywords.every((k) => typeof k === 'string' && k.length > 0)).toBe(true);
  });
});
