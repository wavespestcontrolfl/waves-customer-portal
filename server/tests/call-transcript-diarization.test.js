const CallRecordingProcessor = require('../services/call-recording-processor');

describe('normalizeOpenAISegments (diarized_json → stored shape)', () => {
  const { normalizeOpenAISegments } = CallRecordingProcessor._test;

  test('maps diarized_json segments to { id, speaker, start_ms, end_ms, text }', () => {
    const data = {
      segments: [
        { id: 0, speaker: 'A', start: 0, end: 3.2, text: 'Waves Pest Control.' },
        { id: 1, speaker: 'B', start: 3.5, end: 7.0, text: 'Hi, I have roaches.' },
      ],
    };
    expect(normalizeOpenAISegments(data)).toEqual([
      { id: 0, speaker: 'A', start_ms: 0, end_ms: 3200, text: 'Waves Pest Control.' },
      { id: 1, speaker: 'B', start_ms: 3500, end_ms: 7000, text: 'Hi, I have roaches.' },
    ]);
  });

  test('converts seconds to integer milliseconds (rounds)', () => {
    const data = { segments: [{ speaker: 'A', start: 1.2345, end: 2.6789, text: 'hi' }] };
    const [seg] = normalizeOpenAISegments(data);
    expect(seg.start_ms).toBe(1235);
    expect(seg.end_ms).toBe(2679);
  });

  test('falls back to array index when id missing', () => {
    const data = { segments: [{ speaker: 'A', start: 0, end: 1, text: 'a' }, { speaker: 'B', start: 1, end: 2, text: 'b' }] };
    const out = normalizeOpenAISegments(data);
    expect(out[0].id).toBe(0);
    expect(out[1].id).toBe(1);
  });

  test('accepts alternate speaker key names', () => {
    expect(normalizeOpenAISegments({ segments: [{ speaker_id: 'spk_0', start: 0, end: 1, text: 'x' }] })[0].speaker).toBe('spk_0');
    expect(normalizeOpenAISegments({ segments: [{ speaker_label: 'S1', start: 0, end: 1, text: 'x' }] })[0].speaker).toBe('S1');
  });

  test('drops empty-text segments', () => {
    const data = { segments: [{ speaker: 'A', start: 0, end: 1, text: '  ' }, { speaker: 'B', start: 1, end: 2, text: 'real' }] };
    const out = normalizeOpenAISegments(data);
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe('real');
  });

  test('null start/end when not numeric', () => {
    const [seg] = normalizeOpenAISegments({ segments: [{ speaker: 'A', text: 'no times' }] });
    expect(seg.start_ms).toBeNull();
    expect(seg.end_ms).toBeNull();
  });

  test('null speaker when none provided', () => {
    const [seg] = normalizeOpenAISegments({ segments: [{ start: 0, end: 1, text: 'unlabeled' }] });
    expect(seg.speaker).toBeNull();
  });

  test('returns null for non-diarized / empty payloads', () => {
    expect(normalizeOpenAISegments(null)).toBeNull();
    expect(normalizeOpenAISegments({ text: 'plain json, no segments' })).toBeNull();
    expect(normalizeOpenAISegments({ segments: [] })).toBeNull();
    expect(normalizeOpenAISegments({ segments: [{ text: '' }] })).toBeNull();
  });
});
