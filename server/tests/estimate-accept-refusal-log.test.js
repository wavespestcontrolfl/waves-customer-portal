/**
 * Every refused accept leaves one log line (estimate page audit 2026-11-05).
 * The server kept no record of a refusal, so a customer stuck at Approve left
 * no trace. The hook wraps res.json, the one exit every refusal shares: sent
 * by the handler, thrown and answered by its catch, or sent by the limiter.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/estimate-stuck-alert', () => ({ noteAcceptRefused: jest.fn(async () => null) }));

const logger = require('../services/logger');
const { noteAcceptRefused } = require('../services/estimate-stuck-alert');
const { logAcceptRefusals } = require('../routes/estimate-public');

function fakeRes() {
  const res = { statusCode: 200, locals: {}, sent: [] };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.sent.push(payload); return res; };
  return res;
}

function hooked() {
  const res = fakeRes();
  const next = jest.fn();
  logAcceptRefusals({}, res, next);
  expect(next).toHaveBeenCalledTimes(1);
  return res;
}

beforeEach(() => { logger.info.mockClear(); noteAcceptRefused.mockClear(); });

describe('logAcceptRefusals', () => {
  it('logs a refusal with its status, code, estimate id and reason, and still sends it', () => {
    const res = hooked();
    res.locals.acceptEstimateId = 'est-1';
    const body = { error: 'One of this estimate’s plan options is no longer offered.', code: 'service_cadence_tier_unavailable' };
    res.status(409).json(body);
    expect(res.sent).toEqual([body]);
    expect(logger.info).toHaveBeenCalledWith(
      '[estimate-accept] refused 409 service_cadence_tier_unavailable for estimate est-1: One of this estimate’s plan options is no longer offered.',
    );
  });

  it('logs a refusal with no code, and the limiter refusal sent before the row is read', () => {
    const res = hooked();
    res.status(409).json({ error: 'This estimate is being re-priced — please try again in a few minutes' });
    expect(logger.info).toHaveBeenLastCalledWith(
      '[estimate-accept] refused 409 no-code for estimate unknown: This estimate is being re-priced — please try again in a few minutes',
    );
    const limited = hooked();
    limited.status(429).json({ error: 'Too many attempts. Please wait a moment and try again, or call our office.' });
    expect(logger.info).toHaveBeenLastCalledWith(
      '[estimate-accept] refused 429 no-code for estimate unknown: Too many attempts. Please wait a moment and try again, or call our office.',
    );
  });

  it('logs nothing for a success or a server error', () => {
    const res = hooked();
    res.json({ success: true });
    const failed = hooked();
    failed.status(500).json({ error: 'Internal server error' });
    expect(logger.info).not.toHaveBeenCalled();
    expect(noteAcceptRefused).not.toHaveBeenCalled();
  });

  it('hands every refusal to the office stuck alert, which decides whether it is one the page recovers from', () => {
    const req = { headers: { 'user-agent': 'Mozilla/5.0 (iPhone)' } };
    const res = fakeRes();
    logAcceptRefusals(req, res, jest.fn());
    res.locals.acceptEstimateId = 'est-1';
    const body = { error: 'We could not confirm this plan’s pricing online.', code: 'PER_APPLICATION_ADD_ON_UNPRICED' };
    res.status(409).json(body);
    expect(noteAcceptRefused).toHaveBeenCalledWith(req, 'est-1', 409, body);
    expect(res.sent).toEqual([body]);
  });

  it('caps a long reason at 160 characters', () => {
    const res = hooked();
    res.status(422).json({ error: 'x'.repeat(400) });
    const line = logger.info.mock.calls[0][0];
    expect(line.endsWith(`: ${'x'.repeat(160)}`)).toBe(true);
  });
});
