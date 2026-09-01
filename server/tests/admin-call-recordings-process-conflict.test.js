// A blocked processing claim is not a completed run. The route maps the
// processor's { skipped, reason: 'already_processing' } result to HTTP 409 so
// no client can render it as success — on 2026-08-31 the owner's manual
// Process tap during a wedged claim got a 200 and a success toast while the
// call sat unprocessed for 18 minutes. Other skip reasons completed real work
// (e.g. a rejected transcription) and must stay 200.
jest.mock('../models/db', () => jest.fn());
jest.mock('../config', () => ({ twilio: { accountSid: 'AC_test', authToken: 'auth_test' } }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/call-recording-processor', () => ({ processRecording: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => { req.technicianId = 'tech-1'; next(); },
  requireTechOrAdmin: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
}));

const express = require('express');
const CallRecordingProcessor = require('../services/call-recording-processor');
const router = require('../routes/admin-call-recordings');

function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/admin/call-recordings', router);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return fn(baseUrl).finally(() => new Promise((r) => server.close(r)));
}

const SID = 'CA' + '0'.repeat(32);

describe('POST /process/:callSid skip semantics', () => {
  beforeEach(() => jest.clearAllMocks());

  test('a blocked claim returns 409 with the explanation, never a bare 200', async () => {
    CallRecordingProcessor.processRecording.mockResolvedValue({
      success: false, skipped: true, reason: 'already_processing',
    });
    await withServer(async (base) => {
      const res = await fetch(`${base}/admin/call-recordings/process/${SID}`, { method: 'POST' });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.skipped).toBe(true);
      expect(body.reason).toBe('already_processing');
      expect(body.error).toMatch(/already being processed/i);
    });
  });

  test('a skip that completed real work stays 200', async () => {
    CallRecordingProcessor.processRecording.mockResolvedValue({
      success: true, skipped: true, reason: 'transcription_rejected_implausible',
    });
    await withServer(async (base) => {
      const res = await fetch(`${base}/admin/call-recordings/process/${SID}`, { method: 'POST' });
      expect(res.status).toBe(200);
      expect((await res.json()).reason).toBe('transcription_rejected_implausible');
    });
  });

  test('a successful run stays 200 and passes through', async () => {
    CallRecordingProcessor.processRecording.mockResolvedValue({ success: true, extracted: { first_name: 'Test' } });
    await withServer(async (base) => {
      const res = await fetch(`${base}/admin/call-recordings/process/${SID}?force=true`, { method: 'POST' });
      expect(res.status).toBe(200);
      expect(CallRecordingProcessor.processRecording).toHaveBeenCalledWith(SID, { force: true });
    });
  });
});

// A settled skip COMPLETED work — the bulk counters must not report it as
// nothing done, which would prompt a needless reprocess of a call that was
// correctly classified. An ownership loss is the opposite: it finished
// NOTHING and must never land in `processed`.
describe('processAllPending counters', () => {
  const { summarizeBatch } = jest.requireActual('../services/call-recording-processor')._test;

  test('a classified voicemail is processed; a blocked claim and an ownership loss are not', () => {
    const result = summarizeBatch([
      { success: true },
      { success: true, skipped: true, reason: 'voicemail' },
      { success: false, skipped: true, reason: 'already_processing' },
      { success: false, skipped: true, reason: 'terminal_write_ownership_lost' },
      { success: false, error: 'provider timeout' },
    ]);
    expect(result).toEqual({ processed: 2, skipped: 2, failed: 1, attempted: 5 });
  });

  test('an empty batch reports nothing rather than dividing by itself', () => {
    expect(summarizeBatch([])).toEqual({ processed: 0, skipped: 0, failed: 0, attempted: 0 });
  });
});

// The claim ceiling must stay ABOVE what a healthy pass can legitimately
// spend, or it reclaims a slow-but-working run out from under itself. The
// derivation mirrors the processor's own timeout map — pinned here so the two
// cannot drift apart silently.
describe('claim ceiling is derived from the provider budgets', () => {
  const { claimAbsoluteCeilingMinutes, providerBudgetMs, HEADROOM } = require('../utils/claim-ceiling');
  const { PROVIDER_FETCH_TIMEOUTS_MS } = jest.requireActual('../services/call-recording-processor')._test;

  test('the mirrored budget matches the processor timeout map', () => {
    const expected = PROVIDER_FETCH_TIMEOUTS_MS.recording_download
      + (2 * PROVIDER_FETCH_TIMEOUTS_MS.transcription)
      + PROVIDER_FETCH_TIMEOUTS_MS.transcript_label
      + (2 * PROVIDER_FETCH_TIMEOUTS_MS.extraction);
    expect(providerBudgetMs()).toBe(expected);
  });

  test('the ceiling exceeds the worst-case healthy pass', () => {
    expect(claimAbsoluteCeilingMinutes() * 60000).toBeGreaterThan(providerBudgetMs());
    expect(HEADROOM).toBeGreaterThan(1);
  });
});
