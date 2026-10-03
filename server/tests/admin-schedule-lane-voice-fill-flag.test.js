/**
 * Schedule payload flag `laneVoiceFillEnabled` (lane voice fill, Fast Complete
 * step 2): true only while GATE_LANE_VOICE_FILL is exactly 'true', read at
 * call time, and only for a visit whose lane the reader reads, resolved from
 * its completion profile as the completion resolves it (a typed form has no
 * lane). Every schedule projection that carries the completion flags carries
 * this one.
 */
jest.mock('../models/db', () => jest.fn(() => { throw new Error('linked-project lookup is optional'); }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));
const PROFILES = {
  bed_bug: { serviceKey: 'bed_bug_treatment' },
  fire_ant: { serviceKey: 'fire_ant' },
  pest: { serviceKey: 'pest_general_quarterly' },
  mosquito_event: { serviceKey: 'mosquito_one_time', findingsType: 'mosquito_event' },
  dethatching: { serviceKey: 'dethatching' },
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
  { id: 'bed_bug', service_type: 'Bed Bug Treatment' },
  { id: 'fire_ant', service_type: 'Fire Ant Treatment' },
  { id: 'pest', service_type: 'Quarterly Pest Control' },
  { id: 'mosquito_event', service_type: 'One-Time Mosquito Treatment' },
  { id: 'dethatching', service_type: 'Dethatching' },
  { id: 'no_profile', service_type: 'Quarterly Pest Control' },
];
const flags = async () => {
  const map = await loadProjectCompletionContextByServiceId(services);
  return Object.fromEntries(services.map((s) => [s.id, map.get(s.id).laneVoiceFillEnabled]));
};

describe('laneVoiceFillEnabled', () => {
  const saved = process.env.GATE_LANE_VOICE_FILL;
  afterEach(() => {
    if (saved === undefined) delete process.env.GATE_LANE_VOICE_FILL; else process.env.GATE_LANE_VOICE_FILL = saved;
  });

  test('gate exactly "true": on only for a lane the reader reads', async () => {
    process.env.GATE_LANE_VOICE_FILL = 'true';
    expect(await flags()).toEqual({
      bed_bug: true, fire_ant: true, pest: false, mosquito_event: false, dethatching: false, no_profile: false,
    });
  });

  test.each([undefined, '', 'false', '1', 'TRUE'])('gate %p: off everywhere', async (value) => {
    if (value === undefined) delete process.env.GATE_LANE_VOICE_FILL; else process.env.GATE_LANE_VOICE_FILL = value;
    expect(Object.values(await flags()).every((on) => on === false)).toBe(true);
  });

  test('every schedule projection that carries the completion flags carries this one', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin-schedule.js'), 'utf8');
    const count = (re) => (src.match(re) || []).length;
    expect(count(/laneVoiceFillEnabled: projectCompletionContext\.laneVoiceFillEnabled === true/g))
      .toBe(count(/fastCompleteRecapEnabled: projectCompletionContext\.fastCompleteRecapEnabled === true/g));
  });
});
