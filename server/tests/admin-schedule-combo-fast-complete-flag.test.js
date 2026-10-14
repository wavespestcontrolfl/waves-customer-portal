/**
 * Schedule payload flag `comboFastCompleteEnabled` (GATE_COMBO_FAST_COMPLETE, owner 2026-10-09,
 * PR 1 of 2): true only while the gate is exactly 'true' (read at call time) AND the row is a member
 * of a grouped stop (it carries a visit_id). The day and the week projections both carry it. Off,
 * the flag is false on every row.
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
  resolveCompletionProfileForScheduledService: jest.fn(async () => ({ serviceKey: 'pest_general_quarterly' })),
}));

const fs = require('fs');
const path = require('path');
const { loadProjectCompletionContextByServiceId } = require('../routes/admin-schedule');

const services = [
  { id: 'grouped', service_type: 'Pest Control', visit_id: '00000000-0000-4000-8000-000000000001' },
  { id: 'alone', service_type: 'Pest Control', visit_id: null },
  { id: 'no_field', service_type: 'Pest Control' },
];
const flags = async () => {
  const map = await loadProjectCompletionContextByServiceId(services);
  return Object.fromEntries(services.map((s) => [s.id, map.get(s.id).comboFastCompleteEnabled]));
};

describe('comboFastCompleteEnabled', () => {
  const saved = process.env.GATE_COMBO_FAST_COMPLETE;
  afterEach(() => { if (saved === undefined) delete process.env.GATE_COMBO_FAST_COMPLETE; else process.env.GATE_COMBO_FAST_COMPLETE = saved; });

  test('gate exactly "true": on for a member of a grouped stop only', async () => {
    process.env.GATE_COMBO_FAST_COMPLETE = 'true';
    expect(await flags()).toEqual({ grouped: true, alone: false, no_field: false });
  });

  test.each([undefined, 'false', 'TRUE', '1', ''])('gate %j: off on every row', async (value) => {
    if (value === undefined) delete process.env.GATE_COMBO_FAST_COMPLETE; else process.env.GATE_COMBO_FAST_COMPLETE = value;
    expect(await flags()).toEqual({ grouped: false, alone: false, no_field: false });
  });

  test('both schedule projections (the day and the week) carry it', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin-schedule.js'), 'utf8');
    const count = (re) => (src.match(re) || []).length;
    expect(count(/comboFastCompleteEnabled: projectCompletionContext\.comboFastCompleteEnabled === true/g)).toBe(2);
    expect(count(/comboFastCompleteEnabled: projectCompletionContext\.comboFastCompleteEnabled === true/g))
      .toBe(count(/typedReportFlowEnabled: projectCompletionContext\.typedReportFlowEnabled === true/g));
  });
});
