// A draft saved before the barrel hold existed carries no quote-required flag on its rows. The send guard reads its
// stored roof pick: never issued + barrel tile + no eave footage = held; footage entered, or already sent = sends.
jest.mock('../models/db', () => jest.fn());
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => next(),
  requireTechOrAdmin: (req, res, next) => next(),
  requireAdmin: (req, res, next) => next(),
}));
jest.mock('../services/short-url', () => ({ shortenOrPassthrough: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));

const router = require('../routes/admin-estimates');
const { estimateHasUnmeasuredBarrelExclusion } = require('../services/estimate-roof-style-replay');

const NEVER = { status: 'draft', sent_at: null, viewed_at: null };
const SENT = { status: 'sent', sent_at: new Date('2026-11-01T12:00:00Z'), viewed_at: null };
const exclusion = (extra) => ({ pricingVersion: 'v2', standardWireMeshPoints: 4, roofStyle: 'barrel_tile', ...extra });
const SHAPES = {
  engineInputs: (extra) => ({ engineInputs: { services: { exclusion: exclusion(extra) } } }),
  inputs: (extra) => ({ inputs: { services: { exclusion: exclusion(extra) } } }),
  'wizard engineInput': (extra) => ({ engineInput: { services: { exclusion: exclusion(extra) } } }),
  'result.inputs': (extra) => ({ result: { inputs: { services: { exclusion: exclusion(extra) } } } }),
};

describe.each(Object.entries(SHAPES))('stored shape: %s', (_name, make) => {
  const send = (row, extra) => router._internals.assertEstimateSendable({
    id: 'e1', token: 'tok', monthly_total: 0, onetime_total: 900, ...row, estimate_data: make(extra),
  });

  test('a never-issued draft with no eave footage is held', () => {
    expect(estimateHasUnmeasuredBarrelExclusion(make({}))).toBe(true);
    expect(() => send(NEVER, {})).toThrow(/eave footage/);
    expect(() => send(NEVER, { barrelEaveFt: 0 })).toThrow(/eave footage/);
  });

  test('footage entered, or an estimate already sent, goes through', () => {
    expect(() => send(NEVER, { barrelEaveFt: 80 })).not.toThrow();
    expect(() => send(SENT, {})).not.toThrow();
    expect(() => send(NEVER, { roofStyle: 'flat_tile' })).not.toThrow();
  });
});

test('a stored row marker holds a never-issued draft too', () => {
  expect(estimateHasUnmeasuredBarrelExclusion({ result: { lineItems: [{ service: 'rodent_exclusion', barrelClosureNeedsMeasurement: true }] } })).toBe(true);
  expect(estimateHasUnmeasuredBarrelExclusion({ result: { lineItems: [{ service: 'rodent_exclusion' }] } })).toBe(false);
  expect(estimateHasUnmeasuredBarrelExclusion(null)).toBe(false);
});

// The admin editor (Estimate Tool V2) saves the roof pick in its request, not in the engine inputs, and its rows priced
// before the hold carry the barrel roof style but no marker. Both hold a never-issued draft.
test('the admin editor\'s saved request holds a never-issued draft with no eave footage', () => {
  const request = (options, services = ['EXCLUSION']) => ({ engineRequest: { profile: {}, selectedServices: services, options } });
  expect(estimateHasUnmeasuredBarrelExclusion(request({ exclRoofStyle: 'barrel_tile' }))).toBe(true);
  expect(estimateHasUnmeasuredBarrelExclusion(request({ exclRoofStyle: 'barrel_tile', exclBarrelEaveFt: 0 }))).toBe(true);
  expect(estimateHasUnmeasuredBarrelExclusion(request({ exclRoofStyle: 'barrel_tile', exclBarrelEaveFt: 60 }))).toBe(false);
  expect(estimateHasUnmeasuredBarrelExclusion(request({ exclRoofStyle: 'barrel_tile' }, ['PEST']))).toBe(false);
  expect(() => router._internals.assertEstimateSendable({
    id: 'e1', token: 'tok', monthly_total: 0, onetime_total: 900, ...NEVER, estimate_data: request({ exclRoofStyle: 'barrel_tile' }),
  })).toThrow(/eave footage/);
});

test('a pre-hold V2 row with the barrel pick and no closure row is held; a priced closure row sends', () => {
  const main = { service: 'rodent_exclusion', name: 'Rodent Exclusion', price: 900, roofStyle: 'barrel_tile' };
  const closure = { service: 'rodent_exclusion', component: 'barrel_eave_closure', price: 480 };
  expect(estimateHasUnmeasuredBarrelExclusion({ result: { lineItems: [main] } })).toBe(true);
  expect(estimateHasUnmeasuredBarrelExclusion({ result: { lineItems: [main, closure] } })).toBe(false);
});

test('a measured revision is not held by a stale unmeasured engineResult', () => {
  const current = { lineItems: [
    { service: 'rodent_exclusion', name: 'Rodent Exclusion', price: 900, roofStyle: 'barrel_tile' },
    { service: 'rodent_exclusion', component: 'barrel_eave_closure', price: 480 },
  ] };
  const stale = { lineItems: [{ service: 'rodent_exclusion', name: 'Rodent Exclusion', price: 900, roofStyle: 'barrel_tile', barrelClosureNeedsMeasurement: true }] };
  expect(estimateHasUnmeasuredBarrelExclusion({ result: current, engineResult: stale, pricingAuthorityAtLock: 'SERVER' })).toBe(false);
});
