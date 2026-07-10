// Transcription-hallucination guard: a transcript whose length is physically
// impossible for the recording duration is a fabrication (the Gemini fallback
// transcriber inventing dialogue over near-silence). Observed live 2026-07-10:
// a 5s recording produced 4,777 chars of an invented "Amanda" call that minted
// a phantom estimate_send lead. Human speech tops out ~15 chars/sec.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { _test } = require('../services/call-recording-processor');
const { isImplausibleTranscript } = _test;

describe('isImplausibleTranscript', () => {
  test('rejects the observed live hallucination (5s recording, 4777 chars ~955 c/s)', () => {
    expect(isImplausibleTranscript('x'.repeat(4777), 5)).toBe(true);
  });

  test('keeps a real 8-minute rat-emergency transcript (471s, 6324 chars ~13 c/s)', () => {
    expect(isImplausibleTranscript('x'.repeat(6324), 471)).toBe(false);
  });

  test('keeps a normal call at the human speech ceiling (60s, 900 chars = 15 c/s)', () => {
    expect(isImplausibleTranscript('x'.repeat(900), 60)).toBe(false);
  });

  test('rejects an empty voicemail that hallucinated a page of text (5s, 1500 chars)', () => {
    expect(isImplausibleTranscript('x'.repeat(1500), 5)).toBe(true);
  });

  test('does NOT fire on short transcripts (below the min-chars floor)', () => {
    // A 2s recording with a brief "hi, call me back" is plausible, not fabricated.
    expect(isImplausibleTranscript('hi call me back please', 2)).toBe(false);
  });

  test('fails OPEN when recording duration is unknown (never drops a real transcript)', () => {
    expect(isImplausibleTranscript('x'.repeat(4777), null)).toBe(false);
    expect(isImplausibleTranscript('x'.repeat(4777), 0)).toBe(false);
  });

  test('exactly at the ceiling is allowed; just past it is rejected', () => {
    expect(isImplausibleTranscript('x'.repeat(250), 10)).toBe(false); // 25 c/s
    expect(isImplausibleTranscript('x'.repeat(260), 10)).toBe(true);  // 26 c/s
  });

  test('diarization labels are stripped before the ratio (a real short diarized call is kept)', () => {
    // ~20s call, dense but human. Speaker labels + newlines add overhead that
    // must NOT count toward the ratio.
    const turns = Array.from({ length: 10 }, (_, i) =>
      `Agent: ${'word '.repeat(4)}\nCaller: ${'reply '.repeat(4)}`).join('\n');
    // raw length is inflated by labels/newlines; spoken content is ~human rate over 20s
    expect(isImplausibleTranscript(turns, 20)).toBe(false);
  });

  test('a labeled hallucination is still rejected (labels do not rescue it)', () => {
    const hallucination = Array.from({ length: 40 }, () =>
      'Agent: Thank you for calling Waves Pest Control. This is Amanda.\nCaller: Hi Amanda, my name is...').join('\n');
    expect(isImplausibleTranscript(hallucination, 5)).toBe(true);
  });
});
