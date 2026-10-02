/**
 * GATE_LAWN_RESERVICE_FAST_COMPLETE: strict `=== 'true'`, read at call time,
 * dark in every environment, and mirrored per service onto the schedule payload
 * as `lawnReserviceFastCompleteEnabled` (no per-tech user flag).
 */
const fs = require('fs');
const path = require('path');

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

const { lawnReserviceFastCompleteLive, isEnabled, gates } = require('../config/feature-gates');
const { loadProjectCompletionContextByServiceId } = require('../routes/admin-schedule');

describe('GATE_LAWN_RESERVICE_FAST_COMPLETE', () => {
  const saved = process.env.GATE_LAWN_RESERVICE_FAST_COMPLETE;
  afterEach(() => {
    if (saved === undefined) delete process.env.GATE_LAWN_RESERVICE_FAST_COMPLETE; else process.env.GATE_LAWN_RESERVICE_FAST_COMPLETE = saved;
  });

  test('ships dark: unset is off', () => {
    delete process.env.GATE_LAWN_RESERVICE_FAST_COMPLETE;
    expect(lawnReserviceFastCompleteLive()).toBe(false);
  });

  test('only an exact "true" turns it on, read at call time', () => {
    process.env.GATE_LAWN_RESERVICE_FAST_COMPLETE = 'true';
    expect(lawnReserviceFastCompleteLive()).toBe(true);
    for (const value of ['1', 'on', 'TRUE', 'yes', 'false', '']) {
      process.env.GATE_LAWN_RESERVICE_FAST_COMPLETE = value;
      expect(lawnReserviceFastCompleteLive()).toBe(false);
    }
  });

  test('is its own switch, separate from the pest and T&S gates', () => {
    expect(Object.keys(gates)).toEqual(expect.arrayContaining(['lawnReserviceFastComplete', 'reserviceFastComplete', 'tsFastComplete']));
    expect(isEnabled('lawnReserviceFastComplete')).toBe(false);
  });

  describe('schedule payload', () => {
    const services = [{ id: 'svc-1' }, { id: 'svc-2' }];
    const flags = async () => {
      const map = await loadProjectCompletionContextByServiceId(services, { userId: 'tech-1' });
      return [map.get('svc-1').lawnReserviceFastCompleteEnabled, map.get('svc-2').lawnReserviceFastCompleteEnabled];
    };

    test('gate on: true for every service, with no per-tech flag read', async () => {
      process.env.GATE_LAWN_RESERVICE_FAST_COMPLETE = 'true';
      expect(await flags()).toEqual([true, true]);
    });

    test.each([undefined, '', 'false', '1', 'TRUE'])('gate %p: false', async (value) => {
      if (value === undefined) delete process.env.GATE_LAWN_RESERVICE_FAST_COMPLETE; else process.env.GATE_LAWN_RESERVICE_FAST_COMPLETE = value;
      expect(await flags()).toEqual([false, false]);
    });
  });

  // The completion-context projections are written out per route; pin that
  // every one that carries the pest routing flag carries this one too.
  test('every schedule payload that carries the pest routing gate carries the lawn re-service flag', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin-schedule.js'), 'utf8');
    const count = (re) => (src.match(re) || []).length;
    expect(count(/lawnReserviceFastCompleteEnabled:/g)).toBe(count(/[^A-Za-z]reserviceFastCompleteEnabled:/g));
    expect(count(/lawnReserviceFastCompleteEnabled: projectCompletionContext\.lawnReserviceFastCompleteEnabled === true/g)).toBe(2);
  });
});
