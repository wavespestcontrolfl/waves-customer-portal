/**
 * GATE_LAWN_FAST_COMPLETE: strict `=== 'true'`, read at call time, dark in every
 * environment, mirrored per service onto the schedule payload as
 * `lawnFastCompleteEnabled`; and the /complete wiring of the `lawnFast`
 * preflight.
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

const { lawnFastCompleteLive, isEnabled, gates } = require('../config/feature-gates');
const { loadProjectCompletionContextByServiceId } = require('../routes/admin-schedule');

describe('GATE_LAWN_FAST_COMPLETE', () => {
  const saved = process.env.GATE_LAWN_FAST_COMPLETE;
  afterEach(() => {
    if (saved === undefined) delete process.env.GATE_LAWN_FAST_COMPLETE; else process.env.GATE_LAWN_FAST_COMPLETE = saved;
  });

  test('ships dark: unset is off', () => {
    delete process.env.GATE_LAWN_FAST_COMPLETE;
    expect(lawnFastCompleteLive()).toBe(false);
  });

  test('only an exact "true" turns it on, read at call time', () => {
    process.env.GATE_LAWN_FAST_COMPLETE = 'true';
    expect(lawnFastCompleteLive()).toBe(true);
    for (const value of ['1', 'on', 'TRUE', 'yes', 'false', '']) {
      process.env.GATE_LAWN_FAST_COMPLETE = value;
      expect(lawnFastCompleteLive()).toBe(false);
    }
  });

  test('is its own switch, separate from the lawn re-service, pest and T&S gates', () => {
    expect(Object.keys(gates)).toEqual(expect.arrayContaining(['lawnFastComplete', 'lawnReserviceFastComplete', 'reserviceFastComplete', 'tsFastComplete']));
    expect(isEnabled('lawnFastComplete')).toBe(false);
  });

  describe('schedule payload', () => {
    const services = [{ id: 'svc-1' }, { id: 'svc-2' }];
    const flags = async () => {
      const map = await loadProjectCompletionContextByServiceId(services, { userId: 'tech-1' });
      return [map.get('svc-1').lawnFastCompleteEnabled, map.get('svc-2').lawnFastCompleteEnabled];
    };

    test('gate on: true for every service', async () => {
      process.env.GATE_LAWN_FAST_COMPLETE = 'true';
      expect(await flags()).toEqual([true, true]);
    });

    test.each([undefined, '', 'false', '1', 'TRUE'])('gate %p: false', async (value) => {
      if (value === undefined) delete process.env.GATE_LAWN_FAST_COMPLETE; else process.env.GATE_LAWN_FAST_COMPLETE = value;
      expect(await flags()).toEqual([false, false]);
    });
  });

  test('every schedule payload that carries the lawn re-service flag carries the lawn flag too', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin-schedule.js'), 'utf8');
    const count = (re) => (src.match(re) || []).length;
    expect(count(/lawnFastCompleteEnabled:/g)).toBe(count(/lawnReserviceFastCompleteEnabled:/g));
    expect(count(/lawnFastCompleteEnabled: projectCompletionContext\.lawnFastCompleteEnabled === true/g)).toBe(2);
  });
});

describe('/complete wiring', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'complete-scheduled-service.js'), 'utf8');

  test('a lawnFast block runs the lawn-fast preflight before the lawn assessment preflight, and a block ends the attempt', () => {
    const fast = src.indexOf("require('./lawn-fast-complete').preflightLawnFastCompletion");
    const assessment = src.indexOf('await preflightLawnAssessmentCompletion({');
    expect(fast).toBeGreaterThan(-1);
    expect(assessment).toBeGreaterThan(fast);
    const block = src.slice(fast, assessment);
    expect(block).toMatch(/markCompletionAttemptFailed/);
    expect(block).toMatch(/return \(\{ status: lawnFastBlock\.status, body: lawnFastBlock\.payload \}\)/);
  });

  test('only a body that carries the block is judged', () => {
    expect(src).toMatch(/^\s+lawnFast = null,$/m);
    expect(src).toMatch(/if \(lawnFast !== null && lawnFast !== undefined\)/);
  });
});
