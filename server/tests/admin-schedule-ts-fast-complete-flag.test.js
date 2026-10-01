/**
 * Schedule payload flag `treeShrubFastCompleteEnabled` (T&S Fast Complete):
 * true only when GATE_TS_FAST_COMPLETE is exactly 'true' AND the requesting
 * user has the per-user `ts_fast_complete` flag. Rides beside
 * `reserviceFastCompleteEnabled` on the same per-service completion context.
 */
jest.mock('../models/db', () => jest.fn(() => { throw new Error('linked-project lookup is optional'); }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/feature-flags', () => ({
  ...jest.requireActual('../services/feature-flags'),
  isUserFeatureEnabled: jest.fn(),
}));
jest.mock('../services/service-completion-profiles', () => ({
  ...jest.requireActual('../services/service-completion-profiles'),
  resolveCompletionProfileForScheduledService: jest.fn(async () => null),
}));

const { isUserFeatureEnabled } = require('../services/feature-flags');
const { loadProjectCompletionContextByServiceId } = require('../routes/admin-schedule');

const services = [{ id: 'svc-1' }, { id: 'svc-2' }];
const flags = async (options) => {
  const map = await loadProjectCompletionContextByServiceId(services, options);
  return [map.get('svc-1').treeShrubFastCompleteEnabled, map.get('svc-2').treeShrubFastCompleteEnabled];
};

describe('treeShrubFastCompleteEnabled', () => {
  const savedGate = process.env.GATE_TS_FAST_COMPLETE;
  afterEach(() => {
    if (savedGate === undefined) delete process.env.GATE_TS_FAST_COMPLETE; else process.env.GATE_TS_FAST_COMPLETE = savedGate;
    isUserFeatureEnabled.mockReset();
  });

  test('gate live + user flag on: true for every service, flag read once for the requesting user', async () => {
    process.env.GATE_TS_FAST_COMPLETE = 'true';
    isUserFeatureEnabled.mockResolvedValue(true);
    expect(await flags({ userId: 'tech-1' })).toEqual([true, true]);
    expect(isUserFeatureEnabled).toHaveBeenCalledTimes(1);
    expect(isUserFeatureEnabled).toHaveBeenCalledWith('tech-1', 'ts_fast_complete');
  });

  test('gate live + user flag off: false', async () => {
    process.env.GATE_TS_FAST_COMPLETE = 'true';
    isUserFeatureEnabled.mockResolvedValue(false);
    expect(await flags({ userId: 'tech-1' })).toEqual([false, false]);
  });

  test.each([undefined, '', 'false', '1', 'TRUE'])('gate %p: false without reading the user flag', async (value) => {
    if (value === undefined) delete process.env.GATE_TS_FAST_COMPLETE; else process.env.GATE_TS_FAST_COMPLETE = value;
    isUserFeatureEnabled.mockResolvedValue(true);
    expect(await flags({ userId: 'tech-1' })).toEqual([false, false]);
    expect(isUserFeatureEnabled).not.toHaveBeenCalled();
  });

  test('a flag-read failure is off, not an error', async () => {
    process.env.GATE_TS_FAST_COMPLETE = 'true';
    isUserFeatureEnabled.mockRejectedValue(new Error('db down'));
    expect(await flags({ userId: 'tech-1' })).toEqual([false, false]);
  });

  test('no requesting user: off', async () => {
    process.env.GATE_TS_FAST_COMPLETE = 'true';
    isUserFeatureEnabled.mockResolvedValue(false);
    expect(await flags()).toEqual([false, false]);
  });
});
