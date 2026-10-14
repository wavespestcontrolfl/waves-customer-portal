/**
 * Schedule payload flag `assessmentFastCompleteEnabled` (Waves Assessment Fast
 * Complete): true exactly when GATE_ASSESSMENT_FAST_COMPLETE is 'true' AND the
 * visit's completion profile is the assessment service key. A pest profile, no
 * profile and a failed profile read are never flagged, gate on or off.
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
  resolveCompletionProfileForScheduledService: jest.fn(),
}));

const { resolveCompletionProfileForScheduledService } = require('../services/service-completion-profiles');
const { ASSESSMENT_SERVICE_KEY } = require('../services/assessment-booking');
const { assessmentFastCompleteLive } = require('../config/feature-gates');
const { loadProjectCompletionContextByServiceId } = require('../routes/admin-schedule');

const PROFILES = {
  'svc-assessment': { serviceKey: ASSESSMENT_SERVICE_KEY, category: 'inspection' },
  'svc-pest': { serviceKey: 'pest_control_quarterly', category: 'pest_control' },
  'svc-none': null,
  'svc-error': new Error('profile lookup outage'),
};
const services = Object.keys(PROFILES).map((id) => ({ id }));

const flags = async () => {
  const map = await loadProjectCompletionContextByServiceId(services);
  return Object.fromEntries(services.map(({ id }) => [id, map.get(id).assessmentFastCompleteEnabled]));
};

describe('assessmentFastCompleteEnabled', () => {
  const savedGate = process.env.GATE_ASSESSMENT_FAST_COMPLETE;
  beforeEach(() => {
    resolveCompletionProfileForScheduledService.mockImplementation(async (service) => {
      const profile = PROFILES[service.id];
      if (profile instanceof Error) throw profile;
      return profile;
    });
  });
  afterEach(() => {
    if (savedGate === undefined) delete process.env.GATE_ASSESSMENT_FAST_COMPLETE; else process.env.GATE_ASSESSMENT_FAST_COMPLETE = savedGate;
  });

  test('gate live: true for the assessment only', async () => {
    process.env.GATE_ASSESSMENT_FAST_COMPLETE = 'true';
    expect(await flags()).toEqual({
      'svc-assessment': true, 'svc-pest': false, 'svc-none': false, 'svc-error': false,
    });
  });

  test.each([undefined, '', 'false', '1', 'TRUE'])('gate %p: false for every service, the assessment too', async (value) => {
    if (value === undefined) delete process.env.GATE_ASSESSMENT_FAST_COMPLETE; else process.env.GATE_ASSESSMENT_FAST_COMPLETE = value;
    expect(assessmentFastCompleteLive()).toBe(false);
    expect(await flags()).toEqual({
      'svc-assessment': false, 'svc-pest': false, 'svc-none': false, 'svc-error': false,
    });
  });

  test('the reader is strict and read at call time', () => {
    process.env.GATE_ASSESSMENT_FAST_COMPLETE = 'true';
    expect(assessmentFastCompleteLive()).toBe(true);
    delete process.env.GATE_ASSESSMENT_FAST_COMPLETE;
    expect(assessmentFastCompleteLive()).toBe(false);
  });
});
