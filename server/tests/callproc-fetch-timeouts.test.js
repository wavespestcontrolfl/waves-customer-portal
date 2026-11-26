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

describe('downloadRecording with maxBytes', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });
  const bodyOf = (chunks) => {
    const cancel = jest.fn(async () => {});
    let i = 0;
    return { cancel, getReader: () => ({ read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true }), cancel }) };
  };
  const respond = (body, length) => ({ ok: true, headers: { get: (h) => (h === 'content-length' ? length : null) }, body, arrayBuffer: jest.fn() });

  beforeEach(() => {
    process.env.TWILIO_ACCOUNT_SID = 'ACtest';
    process.env.TWILIO_AUTH_TOKEN = 'test';
  });

  test('a file within the limit is read whole', async () => {
    global.fetch = jest.fn(async () => respond(bodyOf([new Uint8Array(3), new Uint8Array(2)]), '5'));
    const buf = await downloadRecording('https://api.twilio.com/rec/RE123', { maxBytes: 5 });
    expect(buf.length).toBe(5);
  });

  test('a declared length over the limit is refused before any read', async () => {
    const body = bodyOf([new Uint8Array(6)]);
    global.fetch = jest.fn(async () => respond(body, '6'));
    await expect(downloadRecording('https://api.twilio.com/rec/RE123', { maxBytes: 5 })).rejects.toMatchObject({ code: 'RECORDING_TOO_LARGE' });
    expect(body.cancel).toHaveBeenCalled();
  });

  test('a body that grows past the limit stops reading at once', async () => {
    const body = bodyOf([new Uint8Array(4), new Uint8Array(4), new Uint8Array(4)]);
    global.fetch = jest.fn(async () => respond(body, null));
    await expect(downloadRecording('https://api.twilio.com/rec/RE123', { maxBytes: 5 })).rejects.toMatchObject({ code: 'RECORDING_TOO_LARGE' });
    expect(body.cancel).toHaveBeenCalled();
  });
});
