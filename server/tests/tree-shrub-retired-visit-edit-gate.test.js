// Codex r17/r18 on #4786: the visit-edit retired-for-sale gate must see every
// line the save ADDS — catalog ids, a changed primary label, and the name of
// an ID-less add-on line (normalizeUpdateDetailsAddons keeps an unresolved
// serviceName and persists it by name alone) — and nothing the visit already
// carries, so a grandfathered visit is never re-checked.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../middleware/admin-auth', () => {
  const actual = jest.requireActual('../middleware/admin-auth');
  return { ...actual, adminAuthenticate: (_req, _res, next) => next() };
});
jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.transaction = jest.fn();
  return fn;
});
jest.mock('../sockets', () => ({ getIo: jest.fn(() => ({ to: jest.fn(() => ({ emit: jest.fn() })) })) }));

const { retiredGateInputsForVisitEdit, retiredSaleKeysVouchedByAcceptedEstimate } = require('../routes/admin-schedule')._test;

const RETIRED_ID = '11111111-2222-4333-8444-555555555555';
const LIVE_ID = '66666666-7777-4888-8999-aaaaaaaaaaaa';
const current = { customer_id: 'cust-1', service_id: LIVE_ID, service_type: 'Quarterly Pest Control' };

describe('retiredGateInputsForVisitEdit', () => {
  test('an ID-less add-on name new to the visit goes through the gate by name', () => {
    expect(retiredGateInputsForVisitEdit({
      current, currentAddons: [], postedCatalogIds: [LIVE_ID],
      postedAddonNames: ['Quarterly Tree & Shrub'], serviceType: 'Quarterly Pest Control',
    })).toEqual({ serviceIds: [], serviceTypes: ['Quarterly Tree & Shrub'] });
  });

  test('a grandfathered visit that keeps its own lines is never re-checked', () => {
    expect(retiredGateInputsForVisitEdit({
      current,
      currentAddons: [{ service_id: null, service_name: 'Quarterly Tree & Shrub' }, { service_id: RETIRED_ID, service_name: 'Quarterly T&S' }],
      postedCatalogIds: [LIVE_ID, RETIRED_ID],
      postedAddonNames: ['quarterly tree & shrub '],
      serviceType: ' quarterly pest control',
    })).toEqual({ serviceIds: [], serviceTypes: [] });
  });

  test('added catalog ids and a changed primary label are gated too', () => {
    expect(retiredGateInputsForVisitEdit({
      current, currentAddons: [], postedCatalogIds: [RETIRED_ID], postedAddonNames: [], serviceType: 'Quarterly Tree & Shrub Care',
    })).toEqual({ serviceIds: [RETIRED_ID], serviceTypes: ['Quarterly Tree & Shrub Care'] });
  });

  // codex r18 P1: turning a one-off visit into a recurring one sells its
  // retained lines as a plan, so they go through the gate as if added.
  test('activating recurrence gates the retained primary line and add-ons', () => {
    const oneOff = { ...current, service_id: RETIRED_ID, service_type: 'Quarterly Tree & Shrub Care' };
    expect(retiredGateInputsForVisitEdit({
      current: oneOff, currentAddons: [{ service_id: LIVE_ID, service_name: 'Quarterly Pest Control' }, { service_id: null, service_name: 'Mosquito add-on' }],
      postedCatalogIds: [RETIRED_ID], postedAddonNames: [], serviceType: 'Quarterly Tree & Shrub Care', becomesRecurring: true,
    })).toEqual({
      serviceIds: [RETIRED_ID, LIVE_ID],
      serviceTypes: ['Quarterly Tree & Shrub Care', 'Mosquito add-on'],
    });
    // Already recurring, or a save that does not post recurrence: nothing retained is re-checked.
    expect(retiredGateInputsForVisitEdit({
      current: oneOff, currentAddons: [], postedCatalogIds: [RETIRED_ID], postedAddonNames: [], serviceType: 'Quarterly Tree & Shrub Care', becomesRecurring: false,
    })).toEqual({ serviceIds: [], serviceTypes: [] });
  });

  test('the route hands ID-less add-on names and the visit\'s current add-on names to the helper', () => {
    const source = require('fs').readFileSync(require.resolve('../routes/admin-schedule'), 'utf8');
    expect(source).toMatch(/\.filter\(\(l\) => l && !l\.serviceId && typeof l\.serviceName === 'string' && l\.serviceName\.trim\(\)\)/);
    expect(source).toMatch(/where\(\{ scheduled_service_id: req\.params\.id \}\)\.select\('service_id', 'service_name'\)/);
    expect(source).toMatch(/retiredGateInputsForVisitEdit\(\{ current, currentAddons, postedCatalogIds, postedAddonNames, serviceType, becomesRecurring \}\)/);
    // Activation is confirmed against the row's own flag, never the posted one alone.
    expect(source).toMatch(/first\('customer_id', 'service_id', 'service_type', 'is_recurring'\)/);
    expect(source).toMatch(/const becomesRecurring = recurrencePosted && !current\.is_recurring;/);
  });
});

// codex r18 P1: "Mark Won, then book" — an ACCEPTED linked quote that carries
// the retired plan is grandfathering evidence on POST / (every acceptance
// path refuses that plan for a new sale, so an accepted one predates the
// retirement or belongs to the customer already on it); an open quote is not.
describe('retiredSaleKeysVouchedByAcceptedEstimate', () => {
  const quarterly = { recurring: { services: [{ name: 'Quarterly Tree & Shrub Care Service', serviceKey: 'tree_shrub_quarterly', visitsPerYear: 4 }] } };
  const bimonthly = { recurring: { services: [{ name: 'Bi-Monthly Tree & Shrub Care Service', serviceKey: 'tree_shrub_program', visitsPerYear: 6 }] } };

  test('an accepted quote on the retired cadence vouches for the retired row (object or JSON estimate_data)', () => {
    expect([...retiredSaleKeysVouchedByAcceptedEstimate({ status: 'accepted', estimate_data: quarterly })]).toEqual(['tree_shrub_quarterly']);
    expect([...retiredSaleKeysVouchedByAcceptedEstimate({ status: 'accepted', estimate_data: JSON.stringify(quarterly) })]).toEqual(['tree_shrub_quarterly']);
  });

  test('an open quote, a current-cadence quote, or no quote vouches for nothing', () => {
    expect(retiredSaleKeysVouchedByAcceptedEstimate({ status: 'sent', estimate_data: quarterly }).size).toBe(0);
    expect(retiredSaleKeysVouchedByAcceptedEstimate({ status: 'viewed', estimate_data: quarterly }).size).toBe(0);
    expect(retiredSaleKeysVouchedByAcceptedEstimate({ status: 'accepted', estimate_data: bimonthly }).size).toBe(0);
    expect(retiredSaleKeysVouchedByAcceptedEstimate({ status: 'accepted', estimate_data: '{not json' }).size).toBe(0);
    expect(retiredSaleKeysVouchedByAcceptedEstimate(null).size).toBe(0);
  });

  test('POST / runs the gate after the linked estimate is loaded and filters the vouched rows', () => {
    const source = require('fs').readFileSync(require.resolve('../routes/admin-schedule'), 'utf8');
    const load = source.indexOf("linkedEstimate = await db('estimates')");
    const gate = source.indexOf('const vouchedByQuote = retiredSaleKeysVouchedByAcceptedEstimate(linkedEstimate);');
    expect(load).toBeGreaterThan(0);
    expect(gate).toBeGreaterThan(load);
    expect(source).toMatch(/\}\)\)\.filter\(\(r\) => !vouchedByQuote\.has\(r\.service_key\)\);/);
    // Still before the first write: the booking transaction opens later.
    expect(gate).toBeLessThan(source.indexOf('db.transaction', gate));
  });
});
