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
