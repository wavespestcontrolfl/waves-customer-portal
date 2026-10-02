/**
 * Schedule payload flag `treeShrubFastCompleteEnabled` (T&S Fast Complete):
 * true exactly when GATE_TS_FAST_COMPLETE is 'true', for every technician (owner
 * 2026-10-01: no per-tech flag). Rides beside
 * `reserviceFastCompleteEnabled` on the same per-service completion context.
 */
jest.mock('../models/db', () => jest.fn(() => { throw new Error('linked-project lookup is optional'); }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/service-completion-profiles', () => ({
  ...jest.requireActual('../services/service-completion-profiles'),
  resolveCompletionProfileForScheduledService: jest.fn(async () => null),
}));

const { loadProjectCompletionContextByServiceId } = require('../routes/admin-schedule');

const services = [{ id: 'svc-1' }, { id: 'svc-2' }];
const flags = async () => {
  const map = await loadProjectCompletionContextByServiceId(services);
  return [map.get('svc-1').treeShrubFastCompleteEnabled, map.get('svc-2').treeShrubFastCompleteEnabled];
};

describe('treeShrubFastCompleteEnabled', () => {
  const savedGate = process.env.GATE_TS_FAST_COMPLETE;
  afterEach(() => {
    if (savedGate === undefined) delete process.env.GATE_TS_FAST_COMPLETE; else process.env.GATE_TS_FAST_COMPLETE = savedGate;
  });

  test('gate live: true for every service, no per-user flag involved', async () => {
    process.env.GATE_TS_FAST_COMPLETE = 'true';
    expect(await flags()).toEqual([true, true]);
  });

  test.each([undefined, '', 'false', '1', 'TRUE'])('gate %p: false', async (value) => {
    if (value === undefined) delete process.env.GATE_TS_FAST_COMPLETE; else process.env.GATE_TS_FAST_COMPLETE = value;
    expect(await flags()).toEqual([false, false]);
  });
});
