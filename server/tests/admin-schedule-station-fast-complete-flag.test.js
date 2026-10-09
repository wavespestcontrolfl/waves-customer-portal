/**
 * Schedule payload flag `stationFastCompleteEnabled` (GATE_STATION_FAST_COMPLETE,
 * owner 2026-10-08): true only while the station gate, GATE_FAST_COMPLETE_REPORT
 * and GATE_TYPED_VOICE_FILL are all exactly 'true' (read at call time), and only
 * for a termite or rodent bait station form with no companion form. A trap check
 * keeps the full form (its setup and serviced rules differ), and so does every
 * other typed form. The day and the week projections both carry it.
 */
jest.mock('../models/db', () => jest.fn(() => { throw new Error('linked-project lookup is optional'); }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));
const PROFILES = {
  termite_bait: { serviceKey: 'termite_bait_monitoring', findingsType: 'termite_bait_station' },
  rodent_bait: { serviceKey: 'rodent_bait_quarterly', findingsType: 'rodent_bait_station' },
  rodent_trapping: { serviceKey: 'rodent_trapping', findingsType: 'rodent_trapping' },
  combined: { serviceKey: 'termite_bait_monitoring', findingsType: 'termite_bait_station', companions: [{ type: 'rodent_bait_station' }] },
  roach: { serviceKey: 'cockroach_control', findingsType: 'cockroach' },
  termite_inspection: { serviceKey: 'termite_inspection', findingsType: 'termite_inspection' },
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

const services = Object.keys(PROFILES).map((id) => ({ id, service_type: id }));
const flags = async () => {
  const map = await loadProjectCompletionContextByServiceId(services);
  return Object.fromEntries(services.map((s) => [s.id, map.get(s.id).stationFastCompleteEnabled]));
};
const GATES = ['GATE_STATION_FAST_COMPLETE', 'GATE_FAST_COMPLETE_REPORT', 'GATE_TYPED_VOICE_FILL'];

describe('stationFastCompleteEnabled', () => {
  const saved = Object.fromEntries(GATES.map((name) => [name, process.env[name]]));
  afterEach(() => {
    for (const name of GATES) {
      if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name];
    }
  });
  const setGates = (env) => {
    for (const name of GATES) {
      if (env[name] === undefined) delete process.env[name]; else process.env[name] = env[name];
    }
  };

  test('all three gates exactly "true": on for the two bait station forms only, never a trap check or a combined visit', async () => {
    setGates({ GATE_STATION_FAST_COMPLETE: 'true', GATE_FAST_COMPLETE_REPORT: 'true', GATE_TYPED_VOICE_FILL: 'true' });
    expect(await flags()).toEqual({
      termite_bait: true,
      rodent_bait: true,
      rodent_trapping: false,
      combined: false,
      roach: false,
      termite_inspection: false,
      pest: false,
      no_profile: false,
    });
  });

  test.each([
    ['the station gate unset', { GATE_FAST_COMPLETE_REPORT: 'true', GATE_TYPED_VOICE_FILL: 'true' }],
    ['the station gate not exactly "true"', { GATE_STATION_FAST_COMPLETE: 'TRUE', GATE_FAST_COMPLETE_REPORT: 'true', GATE_TYPED_VOICE_FILL: 'true' }],
    ['the report flow off', { GATE_STATION_FAST_COMPLETE: 'true', GATE_FAST_COMPLETE_REPORT: 'false', GATE_TYPED_VOICE_FILL: 'true' }],
    ['typed voice fill off', { GATE_STATION_FAST_COMPLETE: 'true', GATE_FAST_COMPLETE_REPORT: 'true' }],
  ])('%s: off everywhere', async (_label, env) => {
    setGates(env);
    expect(Object.values(await flags()).every((on) => on === false)).toBe(true);
  });

  test('both schedule projections (the day and the week) carry it', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin-schedule.js'), 'utf8');
    const count = (re) => (src.match(re) || []).length;
    expect(count(/stationFastCompleteEnabled: projectCompletionContext\.stationFastCompleteEnabled === true/g)).toBe(2);
    expect(count(/stationFastCompleteEnabled: projectCompletionContext\.stationFastCompleteEnabled === true/g))
      .toBe(count(/typedReportFlowEnabled: projectCompletionContext\.typedReportFlowEnabled === true/g));
  });
});
