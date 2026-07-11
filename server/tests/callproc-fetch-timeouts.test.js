// Provider-fetch timeouts (2026-07-11, slim re-cut of closed PR #2256).
// A HUNG provider call never throws, so it never increments the extraction
// retry budget — the 10-min stale reclaim re-runs it forever while zombie
// runs accumulate. Every provider fetch now carries an AbortSignal timeout
// so a hang becomes an ordinary thrown TimeoutError that flows the EXISTING
// failure paths (retry budget, Gemini fallback, fail-open geocode).
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { providerTimeoutSignal, PROVIDER_FETCH_TIMEOUTS_MS, downloadRecording } =
  require('../services/call-recording-processor')._test;

describe('provider timeout configuration', () => {
  test('every provider kind has a generous, positive default', () => {
    expect(PROVIDER_FETCH_TIMEOUTS_MS.recording_download).toBe(120000);
    expect(PROVIDER_FETCH_TIMEOUTS_MS.transcription).toBe(300000);
    expect(PROVIDER_FETCH_TIMEOUTS_MS.transcript_label).toBe(120000);
    expect(PROVIDER_FETCH_TIMEOUTS_MS.extraction).toBe(180000);
  });

  test('providerTimeoutSignal returns a live AbortSignal (unknown kind falls back)', () => {
    for (const kind of ['recording_download', 'transcription', 'transcript_label', 'extraction', 'nope']) {
      const s = providerTimeoutSignal(kind);
      expect(s).toBeInstanceOf(AbortSignal);
      expect(s.aborted).toBe(false);
    }
  });
});

describe('fetches carry the signal', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  test('downloadRecording passes an AbortSignal and a hang-turned-abort throws', async () => {
    let captured = null;
    global.fetch = jest.fn(async (url, opts) => {
      captured = opts;
      return { ok: true, arrayBuffer: async () => new ArrayBuffer(4) };
    });
    process.env.TWILIO_ACCOUNT_SID = 'ACtest';
    process.env.TWILIO_AUTH_TOKEN = 'test';
    await downloadRecording('https://api.twilio.com/rec/RE123');
    expect(captured.signal).toBeInstanceOf(AbortSignal);

    // When the runtime aborts the fetch (timeout), the error propagates as an
    // ordinary throw — the existing catch paths own it from there.
    global.fetch = jest.fn(async () => { const e = new Error('The operation was aborted due to timeout'); e.name = 'TimeoutError'; throw e; });
    await expect(downloadRecording('https://api.twilio.com/rec/RE123')).rejects.toThrow(/timeout/i);
  });
});
