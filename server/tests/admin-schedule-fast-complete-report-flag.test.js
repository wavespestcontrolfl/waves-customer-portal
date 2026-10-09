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

  test('an area add-on (the web sweep is pest control by family) keeps the generic form, never the report flow or the lawn sheet', async () => {
    process.env.GATE_FAST_COMPLETE_REPORT = 'true';
    const { resolveCompletionProfileForScheduledService } = require('../services/service-completion-profiles');
    resolveCompletionProfileForScheduledService.mockImplementation(async (svc) => (svc.id === 'svc-1'
      ? { serviceKey: 'area_addon_web_sweep', category: 'pest_control', findingsType: null, companions: [] }
      : { serviceKey: 'pest_general_quarterly', category: 'pest_control', findingsType: null, companions: [] }));
    const saved = process.env.GATE_LAWN_FAST_COMPLETE;
    process.env.GATE_LAWN_FAST_COMPLETE = 'true';
    try {
      expect(await flags()).toEqual([false, true]);
      resolveCompletionProfileForScheduledService.mockImplementation(async (svc) => (svc.id === 'svc-1'
        ? { serviceKey: 'area_addon_lawn_insect_spot', category: 'lawn_care', companions: [] }
        : { serviceKey: 'lawn_care_recurring', category: 'lawn_care', companions: [] }));
      const map = await loadProjectCompletionContextByServiceId(services);
      expect([map.get('svc-1').lawnFastCompleteEnabled, map.get('svc-2').lawnFastCompleteEnabled]).toEqual([false, true]);
    } finally {
      resolveCompletionProfileForScheduledService.mockImplementation(async () => null);
      if (saved === undefined) delete process.env.GATE_LAWN_FAST_COMPLETE; else process.env.GATE_LAWN_FAST_COMPLETE = saved;
    }
  });

  // A same-trip add-on rides a normal pest or lawn visit as a scheduled_service_addons row
  // (Codex r6 P1): every lightweight flow is off for that visit and the feed lists the keys.
  test('a visit with an attached area add-on row loses every lightweight flow; the other visit keeps them', async () => {
    const UUID_ADDON_VISIT = '7c1b0a5e-2f3d-4a6b-9c8d-0e1f2a3b4c5d';
    const UUID_PLAIN_VISIT = '8d2c1b6f-3a4e-4b7c-8d9e-1f2a3b4c5d6e';
    process.env.GATE_FAST_COMPLETE_REPORT = 'true';
    const saved = { lawn: process.env.GATE_LAWN_FAST_COMPLETE, recap: process.env.GATE_FAST_COMPLETE_RECAP };
    process.env.GATE_LAWN_FAST_COMPLETE = 'true';
    process.env.GATE_FAST_COMPLETE_RECAP = 'true';
    const db = require('../models/db');
    const { resolveCompletionProfileForScheduledService } = require('../services/service-completion-profiles');
    resolveCompletionProfileForScheduledService.mockImplementation(async (svc) => ({ serviceKey: svc.id === UUID_ADDON_VISIT ? 'pest_general_quarterly' : 'lawn_care_recurring', category: svc.id === UUID_ADDON_VISIT ? 'pest_control' : 'lawn_care', findingsType: null, companions: [] }));
    const queried = [];
    db.raw = (sql) => sql;
    db.mockImplementation((table) => {
      if (!String(table).startsWith('scheduled_service_addons')) throw new Error('linked-project lookup is optional');
      const qb = { leftJoin: () => qb, whereRaw: () => qb, orderBy: () => qb, select: () => qb, whereIn: (_col, ids) => { queried.push(ids); return qb; },
        then: (res, rej) => Promise.resolve([{ scheduled_service_id: UUID_ADDON_VISIT, service_key: 'area_addon_fire_ant_yard', service_name: 'Fire Ant Yard Treatment' }]).then(res, rej) };
      return qb;
    });
    try {
      const map = await loadProjectCompletionContextByServiceId([{ id: UUID_ADDON_VISIT }, { id: UUID_PLAIN_VISIT }, { id: 'not-a-uuid' }]);
      expect(queried).toEqual([[UUID_ADDON_VISIT, UUID_PLAIN_VISIT]]);
      expect(map.get(UUID_ADDON_VISIT)).toMatchObject({
        fastCompleteReportEnabled: false, lawnFastCompleteEnabled: false, fastCompleteRecapEnabled: false, typedReportFlowEnabled: false,
        reserviceFastCompleteEnabled: false, lawnReserviceFastCompleteEnabled: false, treeShrubFastCompleteEnabled: false,
        areaAddOnRowsAttached: true, areaAddOnKeys: ['area_addon_fire_ant_yard'],
        // The host keeps its own lane; the list labels the add-on's product fields (name, sold area).
        areaAddOns: [{ key: 'area_addon_fire_ant_yard', name: 'Fire Ant Yard Treatment', areaSqFt: null, tierSqFt: null, areaLabel: 'lawn', grassType: null }],
      });
      expect(map.get(UUID_PLAIN_VISIT)).toMatchObject({ fastCompleteReportEnabled: true, lawnFastCompleteEnabled: true });
      expect(map.get(UUID_PLAIN_VISIT).areaAddOnRowsAttached).toBeUndefined();
    } finally {
      resolveCompletionProfileForScheduledService.mockImplementation(async () => null);
      db.mockImplementation(() => { throw new Error('linked-project lookup is optional'); });
      if (saved.lawn === undefined) delete process.env.GATE_LAWN_FAST_COMPLETE; else process.env.GATE_LAWN_FAST_COMPLETE = saved.lawn;
      if (saved.recap === undefined) delete process.env.GATE_FAST_COMPLETE_RECAP; else process.env.GATE_FAST_COMPLETE_RECAP = saved.recap;
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
    expect(src).toContain('fastCompleteReportEnabled: fastCompleteReportOffered(completionProfile)');
  });
});
