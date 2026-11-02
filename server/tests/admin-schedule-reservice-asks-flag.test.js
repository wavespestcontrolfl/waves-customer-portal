/**
 * Schedule payload flag `reserviceAsksEnabled` (step S2a, GATE_RESERVICE_ASKS): true exactly when the gate is 'true'
 * AND the visit is a pest or lawn re-service (a callback, or the catalog's re-service key; the completion profile
 * carries the key). The rodent trapping follow-up, an ordinary visit, no profile and a failed profile read are never
 * flagged, gate on or off.
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
const { reserviceAsksLive } = require('../config/feature-gates');
const { loadProjectCompletionContextByServiceId } = require('../routes/admin-schedule');

const VISITS = {
  'pest-callback': { row: { id: 'pest-callback', is_callback: true }, profile: { serviceKey: 'quarterly_pest_control' } },
  'pest-key': { row: { id: 'pest-key', is_callback: false }, profile: { serviceKey: 'pest_re_service' } },
  'lawn-key': { row: { id: 'lawn-key', is_callback: false }, profile: { serviceKey: 'lawn_re_service' } },
  ordinary: { row: { id: 'ordinary', is_callback: false }, profile: { serviceKey: 'quarterly_pest_control' } },
  'rodent-followup': { row: { id: 'rodent-followup', is_callback: true }, profile: { serviceKey: 'rodent_trapping_followup' } },
  'no-profile': { row: { id: 'no-profile', is_callback: false }, profile: null },
  'callback-no-profile': { row: { id: 'callback-no-profile', is_callback: true }, profile: null },
  'profile-error': { row: { id: 'profile-error', is_callback: false }, profile: new Error('profile lookup outage') },
};
const services = Object.values(VISITS).map(({ row }) => row);

const flags = async () => {
  const map = await loadProjectCompletionContextByServiceId(services);
  return Object.fromEntries(services.map(({ id }) => [id, map.get(id).reserviceAsksEnabled]));
};

describe('reserviceAsksEnabled', () => {
  const savedGate = process.env.GATE_RESERVICE_ASKS;
  beforeEach(() => {
    resolveCompletionProfileForScheduledService.mockImplementation(async (service) => {
      const { profile } = VISITS[service.id];
      if (profile instanceof Error) throw profile;
      return profile;
    });
  });
  afterEach(() => {
    if (savedGate === undefined) delete process.env.GATE_RESERVICE_ASKS; else process.env.GATE_RESERVICE_ASKS = savedGate;
  });

  test('gate live: true for a re-service only', async () => {
    process.env.GATE_RESERVICE_ASKS = 'true';
    expect(await flags()).toEqual({
      'pest-callback': true, 'pest-key': true, 'lawn-key': true, ordinary: false,
      'rodent-followup': false, 'no-profile': false, 'callback-no-profile': true, 'profile-error': false,
    });
  });

  test.each([undefined, '', 'false', '1', 'TRUE'])('gate %p: false for every visit, a re-service too', async (value) => {
    if (value === undefined) delete process.env.GATE_RESERVICE_ASKS; else process.env.GATE_RESERVICE_ASKS = value;
    expect(reserviceAsksLive()).toBe(false);
    const result = await flags();
    expect(Object.values(result).every((flag) => flag === false)).toBe(true);
  });
});
