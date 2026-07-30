const CallRecordingProcessor = require('../services/call-recording-processor');

// Buffer with a valid MPEG1 Layer III frame header at the given bitrate.
// 0xFF 0xFB = sync + MPEG1 + Layer III + no CRC; upper nibble of byte 2 is
// the bitrate index.
const MPEG1_L3_KBPS = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
function mp3BufferOf(bytes, kbps = 64) {
  const buf = Buffer.alloc(bytes);
  const idx = MPEG1_L3_KBPS.indexOf(kbps);
  if (idx <= 0) throw new Error(`not a valid MPEG1 L3 bitrate: ${kbps}`);
  buf[0] = 0xff;
  buf[1] = 0xfb;
  buf[2] = (idx << 4) | 0x04;
  return buf;
}

describe('mp3 duration estimation', () => {
  const { estimateMp3DurationSeconds } = CallRecordingProcessor._test;

  test('estimates duration from bitrate for a CBR buffer', () => {
    // 64kbps → 8000 B/s → 254s needs 2,032,000 bytes
    const est = estimateMp3DurationSeconds(mp3BufferOf(254 * 8000, 64));
    expect(est).toBeCloseTo(254, 0);
  });

  test('returns null when no parseable frame header exists', () => {
    expect(estimateMp3DurationSeconds(Buffer.alloc(50_000))).toBeNull();
    expect(estimateMp3DurationSeconds(null)).toBeNull();
  });
});

describe('recording download verification', () => {
  const { verifyRecordingBuffer } = CallRecordingProcessor._test;

  // Prod Twilio recordings run ~7.8KB/s (64kbps mp3); the floor is 3000 B/s.
  const bufferOf = (bytes) => Buffer.alloc(bytes);

  test('accepts a full-size mp3 for the known duration', () => {
    expect(verifyRecordingBuffer(mp3BufferOf(254 * 8000, 64), 254, String(254 * 8000)).ok).toBe(true);
  });

  test('rejects a half-length mp3 even though it clears the byte floor (Codex P1)', () => {
    // 5 min of a 10-min call at 64kbps = 2.4MB — well above 3000 B/s × 600s
    // (1.8MB), so the old floor passed it; duration estimation catches it.
    const verdict = verifyRecordingBuffer(mp3BufferOf(300 * 8000, 64), 600, null);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('duration_shortfall');
  });

  test('headerless buffer falls back to the byte floor: rejects far-short reads', () => {
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
