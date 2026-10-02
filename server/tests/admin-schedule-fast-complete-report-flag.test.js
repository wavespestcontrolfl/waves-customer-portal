/**
 * Schedule payload flag `fastCompleteReportEnabled` (Fast Complete report
 * flow, owner "ok go" 2026-10-01): true only while GATE_FAST_COMPLETE_REPORT
 * is exactly 'true', read at call time. Rides beside the other Fast Complete
 * flags on the same per-service completion context, and every schedule
 * projection that carries those carries this one.
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

const fs = require('fs');
const path = require('path');
const { loadProjectCompletionContextByServiceId } = require('../routes/admin-schedule');

const services = [{ id: 'svc-1' }, { id: 'svc-2' }];
const flags = async () => {
  const map = await loadProjectCompletionContextByServiceId(services);
  return [map.get('svc-1').fastCompleteReportEnabled, map.get('svc-2').fastCompleteReportEnabled];
};

describe('fastCompleteReportEnabled', () => {
  const savedGate = process.env.GATE_FAST_COMPLETE_REPORT;
  afterEach(() => {
    if (savedGate === undefined) delete process.env.GATE_FAST_COMPLETE_REPORT; else process.env.GATE_FAST_COMPLETE_REPORT = savedGate;
  });

  test('gate exactly "true": on for every service', async () => {
    process.env.GATE_FAST_COMPLETE_REPORT = 'true';
    expect(await flags()).toEqual([true, true]);
  });

  test.each([undefined, '', 'false', '1', 'on', 'TRUE'])('gate %p: off', async (value) => {
    if (value === undefined) delete process.env.GATE_FAST_COMPLETE_REPORT; else process.env.GATE_FAST_COMPLETE_REPORT = value;
    expect(await flags()).toEqual([false, false]);
  });

  test('a combined service with required companion sections keeps the full form (Codex #5538)', async () => {
    process.env.GATE_FAST_COMPLETE_REPORT = 'true';
    const { resolveCompletionProfileForScheduledService } = require('../services/service-completion-profiles');
    resolveCompletionProfileForScheduledService.mockImplementation(async (svc) => (svc.id === 'svc-1'
      ? { serviceKey: 'pest_rodent_quarterly', companions: [{ type: 'rodent_bait', delivery: 'auto_send' }] }
      : { serviceKey: 'pest_general_quarterly', companions: [] }));
    try {
      expect(await flags()).toEqual([false, true]);
    } finally {
      resolveCompletionProfileForScheduledService.mockImplementation(async () => null);
    }
  });

  test('a service with its own typed findings (cockroach) keeps the full form (Codex #5538)', async () => {
    process.env.GATE_FAST_COMPLETE_REPORT = 'true';
    const { resolveCompletionProfileForScheduledService } = require('../services/service-completion-profiles');
    resolveCompletionProfileForScheduledService.mockImplementation(async (svc) => (svc.id === 'svc-1'
      ? { serviceKey: 'cockroach_control', findingsType: 'cockroach', companions: [] }
      : { serviceKey: 'pest_general_quarterly', findingsType: null, companions: [] }));
    try {
      expect(await flags()).toEqual([false, true]);
    } finally {
      resolveCompletionProfileForScheduledService.mockImplementation(async () => null);
    }
  });

  test('read at call time: a flip needs no reload', async () => {
    delete process.env.GATE_FAST_COMPLETE_REPORT;
    expect(await flags()).toEqual([false, false]);
    process.env.GATE_FAST_COMPLETE_REPORT = 'true';
    expect(await flags()).toEqual([true, true]);
  });

  // The day and week projections are pinned by source: each one that copies
  // the other Fast Complete flags off the completion context copies this one.
  test('every schedule projection that carries the routing flags carries this one', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin-schedule.js'), 'utf8');
    const count = (re) => (src.match(re) || []).length;
    expect(count(/fastCompleteReportEnabled: projectCompletionContext\.fastCompleteReportEnabled === true/g))
      .toBe(count(/fastCompleteRecapEnabled: projectCompletionContext\.fastCompleteRecapEnabled === true/g));
    expect(src).toContain("fastCompleteReportEnabled: require('../config/feature-gates').fastCompleteReportLive()");
  });
});
