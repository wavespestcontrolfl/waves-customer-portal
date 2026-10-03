/**
 * Schedule payload flag `typedReportFlowEnabled` (typed voice fill, Fast
 * Complete step 3, the tech sheet): true only while GATE_FAST_COMPLETE_REPORT
 * and GATE_TYPED_VOICE_FILL are both exactly 'true', read at call time, and
 * only for a visit whose typed form the sheet reads (its completion profile's
 * own findingsType; step 5's termite forms are read on the office form only,
 * so `typedVoiceFillEnabled` alone is on for them), never a combined visit
 * (its companion sections are required at completion and the sheet has
 * none), never new-construction pre-treat. Every schedule projection that
 * carries the completion flags carries this one.
 */
jest.mock('../models/db', () => jest.fn(() => { throw new Error('linked-project lookup is optional'); }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));
const PROFILES = {
  roach: { serviceKey: 'cockroach_control', findingsType: 'cockroach' },
  rodent_inspection: { serviceKey: 'rodent_inspection', findingsType: 'rodent_inspection' },
  rodent_trapping: { serviceKey: 'rodent_trapping', findingsType: 'rodent_trapping' },
  termite_trenching: { serviceKey: 'termite_trenching', findingsType: 'termite_treatment' },
  termite_inspection: { serviceKey: 'termite_inspection', findingsType: 'termite_inspection' },
  termite_pretreatment: { serviceKey: 'termite_pretreatment', findingsType: 'termite_treatment' },
  combined: { serviceKey: 'cockroach_control', findingsType: 'cockroach', companions: [{ type: 'rodent_bait_station' }] },
  tree_shrub: { serviceKey: 'tree_shrub_program', findingsType: 'tree_shrub' },
  pest: { serviceKey: 'pest_general_quarterly' },
  no_profile: null,
};
jest.mock('../services/service-completion-profiles', () => ({
  ...jest.requireActual('../services/service-completion-profiles'),
  resolveCompletionProfileForScheduledService: jest.fn(async (service) => PROFILES[service.id]),
}));

const fs = require('fs');
const path = require('path');
const { loadProjectCompletionContextByServiceId } = require('../routes/admin-schedule');

const services = [
  { id: 'roach', service_type: 'Cockroach Control' },
  { id: 'rodent_inspection', service_type: 'Rodent Inspection' },
  { id: 'rodent_trapping', service_type: 'Rodent Trapping Follow-up' },
  { id: 'termite_trenching', service_type: 'Termite Trenching' },
  { id: 'termite_inspection', service_type: 'Termite Inspection' },
  { id: 'termite_pretreatment', service_type: 'Termite Pre-Treatment' },
  { id: 'combined', service_type: 'Cockroach Control' },
  { id: 'tree_shrub', service_type: 'Tree & Shrub Care' },
  { id: 'pest', service_type: 'Quarterly Pest Control' },
  { id: 'no_profile', service_type: 'Quarterly Pest Control' },
];
const flags = async (flag = 'typedReportFlowEnabled') => {
  const map = await loadProjectCompletionContextByServiceId(services);
  return Object.fromEntries(services.map((s) => [s.id, map.get(s.id)[flag]]));
};

describe('typedReportFlowEnabled', () => {
  const saved = { report: process.env.GATE_FAST_COMPLETE_REPORT, typed: process.env.GATE_TYPED_VOICE_FILL };
  afterEach(() => {
    if (saved.report === undefined) delete process.env.GATE_FAST_COMPLETE_REPORT; else process.env.GATE_FAST_COMPLETE_REPORT = saved.report;
    if (saved.typed === undefined) delete process.env.GATE_TYPED_VOICE_FILL; else process.env.GATE_TYPED_VOICE_FILL = saved.typed;
  });

  test('both gates exactly "true": on only for a typed form the reader reads, never a combined visit', async () => {
    process.env.GATE_FAST_COMPLETE_REPORT = 'true';
    process.env.GATE_TYPED_VOICE_FILL = 'true';
    expect(await flags()).toEqual({
      roach: true,
      rodent_inspection: true,
      rodent_trapping: true,
      termite_trenching: false,
      termite_inspection: false,
      termite_pretreatment: false,
      combined: false,
      tree_shrub: false,
      pest: false,
      no_profile: false,
    });
  });

  test('step 5: termite treatment and inspection are read on the office form only; new-construction pre-treat never', async () => {
    process.env.GATE_FAST_COMPLETE_REPORT = 'true';
    process.env.GATE_TYPED_VOICE_FILL = 'true';
    expect(await flags('typedVoiceFillEnabled')).toMatchObject({
      termite_trenching: true, termite_inspection: true, termite_pretreatment: false, roach: true, tree_shrub: false,
    });
  });

  test.each([
    ['the report flow off', { GATE_FAST_COMPLETE_REPORT: 'false', GATE_TYPED_VOICE_FILL: 'true' }],
    ['typed voice fill off', { GATE_FAST_COMPLETE_REPORT: 'true', GATE_TYPED_VOICE_FILL: undefined }],
    ['typed voice fill not exactly "true"', { GATE_FAST_COMPLETE_REPORT: 'true', GATE_TYPED_VOICE_FILL: 'TRUE' }],
  ])('%s: off everywhere', async (_label, env) => {
    for (const [name, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    expect(Object.values(await flags()).every((on) => on === false)).toBe(true);
  });

  test('every schedule projection that carries the completion flags carries this one', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin-schedule.js'), 'utf8');
    const count = (re) => (src.match(re) || []).length;
    expect(count(/typedReportFlowEnabled: projectCompletionContext\.typedReportFlowEnabled === true/g))
      .toBe(count(/fastCompleteRecapEnabled: projectCompletionContext\.fastCompleteRecapEnabled === true/g));
  });
});
