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
