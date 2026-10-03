/**
 * Schedule payload flag `fastCompleteVoiceFillEnabled` (Fast Complete voice
 * fill): it rides every per-service completion context exactly like
 * `reserviceFastCompleteEnabled`, from GATE_FAST_COMPLETE_VOICE_FILL read at
 * call time (no per-tech flag), so the pest re-service sheet learns from the
 * payload whether to show its mic, Check chips and office note.
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

const { loadProjectCompletionContextByServiceId } = require('../routes/admin-schedule');

describe('fastCompleteVoiceFillEnabled on the schedule payload', () => {
  const saved = process.env.GATE_FAST_COMPLETE_VOICE_FILL;
  afterEach(() => {
    if (saved === undefined) delete process.env.GATE_FAST_COMPLETE_VOICE_FILL; else process.env.GATE_FAST_COMPLETE_VOICE_FILL = saved;
  });

  const services = [{ id: 'svc-1' }, { id: 'svc-2' }];
  const flags = async () => {
    const map = await loadProjectCompletionContextByServiceId(services, { userId: 'tech-1' });
    return [map.get('svc-1').fastCompleteVoiceFillEnabled, map.get('svc-2').fastCompleteVoiceFillEnabled];
  };

  test('gate on: true for every service, with no per-tech flag read', async () => {
    process.env.GATE_FAST_COMPLETE_VOICE_FILL = 'true';
    expect(await flags()).toEqual([true, true]);
  });

  test.each([undefined, '', 'false', '1', 'TRUE'])('gate %p: false', async (value) => {
    if (value === undefined) delete process.env.GATE_FAST_COMPLETE_VOICE_FILL; else process.env.GATE_FAST_COMPLETE_VOICE_FILL = value;
    expect(await flags()).toEqual([false, false]);
  });

  test('is read at call time: a flip needs no restart', async () => {
    delete process.env.GATE_FAST_COMPLETE_VOICE_FILL;
    expect(await flags()).toEqual([false, false]);
    process.env.GATE_FAST_COMPLETE_VOICE_FILL = 'true';
    expect(await flags()).toEqual([true, true]);
  });

  // The completion-context projections are written out per route; pin that every
  // one that carries the pest routing flag carries this one too, read from the
  // gate registry's reader and never a literal.
  test('every schedule payload that carries the pest routing gate carries the voice-fill flag', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin-schedule.js'), 'utf8');
    const count = (re) => (src.match(re) || []).length;
    expect(count(/[^A-Za-z]fastCompleteVoiceFillEnabled:/g)).toBe(count(/[^A-Za-z]reserviceFastCompleteEnabled:/g));
    expect(src).toContain('fastCompleteVoiceFillEnabled: fastCompleteVoiceFillLive()');
    expect(count(/fastCompleteVoiceFillEnabled: projectCompletionContext\.fastCompleteVoiceFillEnabled === true/g)).toBe(2);
  });
});
