// Codex r17/r18/r19 on #4786: the visit-edit retired-for-sale gate must see every
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
      current, currentAddons: [], postedServiceId: LIVE_ID,
      postedAddons: [{ serviceId: null, serviceName: 'Quarterly Tree & Shrub', recurringPattern: null }], serviceType: 'Quarterly Pest Control',
    })).toEqual({ serviceIds: [], serviceTypes: ['Quarterly Tree & Shrub'] });
  });

  test('a grandfathered visit that keeps its own lines is never re-checked', () => {
    expect(retiredGateInputsForVisitEdit({
      current: { ...current, is_recurring: true },
      currentAddons: [{ service_id: null, service_name: 'Quarterly Tree & Shrub', recurring_pattern: null }, { service_id: RETIRED_ID, service_name: 'Quarterly T&S', recurring_pattern: 'quarterly' }],
      postedServiceId: LIVE_ID,
      postedAddons: [{ serviceId: null, serviceName: 'quarterly tree & shrub ', recurringPattern: null }, { serviceId: RETIRED_ID, serviceName: 'Quarterly T&S', recurringPattern: 'quarterly' }],
      serviceType: ' quarterly pest control',
    })).toEqual({ serviceIds: [], serviceTypes: [] });
  });

  test('added catalog ids and a changed primary label are gated too', () => {
    expect(retiredGateInputsForVisitEdit({
      current, currentAddons: [], postedServiceId: RETIRED_ID, postedAddons: [], serviceType: 'Quarterly Tree & Shrub Care',
    })).toEqual({ serviceIds: [RETIRED_ID], serviceTypes: ['Quarterly Tree & Shrub Care'] });
  });

  // codex r18 P1: turning a one-off visit into a recurring one sells its
  // retained lines as a plan, so they go through the gate as if added.
  test('activating recurrence gates the retained primary line and add-ons', () => {
    const oneOff = { ...current, service_id: RETIRED_ID, service_type: 'Quarterly Tree & Shrub Care' };
    expect(retiredGateInputsForVisitEdit({
      current: oneOff, currentAddons: [{ service_id: LIVE_ID, service_name: 'Quarterly Pest Control' }, { service_id: null, service_name: 'Mosquito add-on' }],
      postedServiceId: RETIRED_ID, postedAddons: [], serviceType: 'Quarterly Tree & Shrub Care', becomesRecurring: true,
    })).toEqual({
      serviceIds: [RETIRED_ID, LIVE_ID],
      serviceTypes: ['Quarterly Tree & Shrub Care', 'Mosquito add-on'],
    });
    // Already recurring, or a save that does not post recurrence: nothing retained is re-checked.
    expect(retiredGateInputsForVisitEdit({
      current: oneOff, currentAddons: [], postedServiceId: RETIRED_ID, postedAddons: [], serviceType: 'Quarterly Tree & Shrub Care', becomesRecurring: false,
    })).toEqual({ serviceIds: [], serviceTypes: [] });
  });

  // codex r19 P1: on a visit that already recurs, a retained add-on stored
  // as its own one_time line and reposted with a plan pattern (null rides
  // the recurring parent) joins the plan — gated as if added.
  test('promoting a one_time add-on to a plan pattern gates it, by id or by name', () => {
    const recurring = { ...current, is_recurring: true };
    const stored = [
      { service_id: RETIRED_ID, service_name: 'Quarterly T&S', recurring_pattern: 'one_time' },
      { service_id: null, service_name: 'Quarterly Tree & Shrub', recurring_pattern: 'one_time' },
    ];
    expect(retiredGateInputsForVisitEdit({
      current: recurring, currentAddons: stored, postedServiceId: LIVE_ID, serviceType: 'Quarterly Pest Control',
      postedAddons: [
        { serviceId: RETIRED_ID, serviceName: 'Quarterly T&S', recurringPattern: null },
        { serviceId: null, serviceName: 'Quarterly Tree & Shrub', recurringPattern: 'quarterly' },
      ],
    })).toEqual({ serviceIds: [RETIRED_ID], serviceTypes: ['Quarterly Tree & Shrub'] });
    // Reposted still as one_time: unchanged, not gated.
    expect(retiredGateInputsForVisitEdit({
      current: recurring, currentAddons: stored, postedServiceId: LIVE_ID, serviceType: 'Quarterly Pest Control',
      postedAddons: [{ serviceId: RETIRED_ID, serviceName: 'Quarterly T&S', recurringPattern: 'one_time' }],
    })).toEqual({ serviceIds: [], serviceTypes: [] });
    // On a one-off parent the add-on's own pattern makes no plan; a stored
    // plan line reposted as-is is not a promotion either.
    expect(retiredGateInputsForVisitEdit({
      current: { ...current, is_recurring: false }, currentAddons: stored, postedServiceId: LIVE_ID, serviceType: 'Quarterly Pest Control',
      postedAddons: [{ serviceId: RETIRED_ID, serviceName: 'Quarterly T&S', recurringPattern: null }],
    })).toEqual({ serviceIds: [], serviceTypes: [] });
    expect(retiredGateInputsForVisitEdit({
      current: recurring, currentAddons: [{ service_id: RETIRED_ID, service_name: 'Quarterly T&S', recurring_pattern: null }], postedServiceId: LIVE_ID, serviceType: 'Quarterly Pest Control',
      postedAddons: [{ serviceId: RETIRED_ID, serviceName: 'Quarterly T&S', recurringPattern: 'quarterly' }],
    })).toEqual({ serviceIds: [], serviceTypes: [] });
  });

  test('the route hands every posted add-on line, with the stored pattern, to the helper', () => {
    const source = require('fs').readFileSync(require.resolve('../routes/admin-schedule'), 'utf8');
    expect(source).toMatch(/const postedAddons = Array\.isArray\(replaceAddons\) \? replaceAddons\.filter\(Boolean\) : \[\];/);
    expect(source).toMatch(/where\(\{ scheduled_service_id: req\.params\.id \}\)\.select\('service_id', 'service_name', 'recurring_pattern'\)/);
    expect(source).toMatch(/current, currentAddons, postedServiceId: updates\.service_id, postedAddons, serviceType, becomesRecurring,/);
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
