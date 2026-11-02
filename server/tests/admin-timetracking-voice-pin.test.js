// Team tab API — the tech voice line PIN (hands-free field voice PR 3b): PUT /technicians/:id/voice-pin sets or
// resets a technician's PIN through services/tech-voice-pin.js. The PIN never comes back, never reaches a log line
// and never reaches the audit row. Mirrors the mock style of admin-timetracking-tech-line.test.js.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/time-tracking', () => ({}));
jest.mock('../services/push-notifications', () => ({ deactivateStaffUser: jest.fn(async () => 1) }));
jest.mock('../sockets', () => ({ disconnectStaffSockets: jest.fn() }));
jest.mock('../services/tech-photo', () => ({ resolveTechPhotoUrl: jest.fn(async (_k, fallback) => fallback) }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
}));
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  PutObjectCommand: jest.fn(), GetObjectCommand: jest.fn(), DeleteObjectCommand: jest.fn(),
}));
jest.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: jest.fn() }));
jest.mock('../services/tech-voice-pin', () => ({ setTechVoicePin: jest.fn() }));
jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn(async () => {}) }));

const db = require('../models/db');
const logger = require('../services/logger');
const { setTechVoicePin } = require('../services/tech-voice-pin');
const { recordAuditEvent } = require('../services/audit-log');
const { putTechnicianVoicePin } = require('../routes/admin-timetracking')._handlers;

const TECH_ID = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';

function technicianLookup(found) {
  const chain = { where: jest.fn(() => chain), first: jest.fn(async () => found) };
  db.mockImplementation(() => chain);
  return chain;
}
async function invoke(req) {
  const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  const next = jest.fn();
  await putTechnicianVoicePin({ technicianId: 'admin-1', params: { id: TECH_ID }, body: {}, ...req }, res, next);
  if (next.mock.calls[0]?.[0]) throw next.mock.calls[0][0];
  return res;
}

beforeEach(() => jest.clearAllMocks());

test('sets the PIN for an existing technician; the PIN is in no response, log line or audit row', async () => {
  technicianLookup({ id: TECH_ID });
  setTechVoicePin.mockResolvedValueOnce({ ok: true });
  const res = await invoke({ body: { pin: '4512' } });
  expect(res.statusCode).toBe(200);
  expect(res.body).toEqual({ success: true, technicianId: TECH_ID });
  expect(setTechVoicePin).toHaveBeenCalledWith(db, { technicianId: TECH_ID, pin: '4512' });
  expect(recordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
    actor_type: 'admin', actor_id: 'admin-1', action: 'tech_voice.pin_set', resource_type: 'technician', resource_id: TECH_ID,
  }));
  const said = JSON.stringify([res.body, recordAuditEvent.mock.calls, logger.info.mock.calls, logger.warn.mock.calls]);
  expect(said).not.toContain('4512');
});

test('a PIN that is not 4 to 6 digits is refused with nothing written', async () => {
  technicianLookup({ id: TECH_ID });
  setTechVoicePin.mockResolvedValueOnce({ ok: false, reason: 'pin_format' });
  const res = await invoke({ body: { pin: '12' } });
  expect(res.statusCode).toBe(400);
  expect(res.body).toMatchObject({ code: 'PIN_FORMAT' });
  expect(recordAuditEvent).not.toHaveBeenCalled();
});

test('an unknown or malformed technician id is a 404 before any PIN write', async () => {
  technicianLookup(undefined);
  expect((await invoke({ body: { pin: '4512' } })).statusCode).toBe(404);
  expect((await invoke({ params: { id: 'not-a-uuid' }, body: { pin: '4512' } })).statusCode).toBe(404);
  expect(setTechVoicePin).not.toHaveBeenCalled();
});
