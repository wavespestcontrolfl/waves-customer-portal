// Codex r17/r18/r19/r20/r22/r23/r24/r25 on #4786: the visit-edit retired-for-sale gate must see every
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

const { retiredGateInputsForVisitEdit, retiredSaleKeysVouchedByAcceptedEstimate, addonLineRecurrence } = require('../routes/admin-schedule')._test;

const RETIRED_ID = '11111111-2222-4333-8444-555555555555';
const LIVE_ID = '66666666-7777-4888-8999-aaaaaaaaaaaa';
const current = { customer_id: 'cust-1', service_id: LIVE_ID, service_type: 'Quarterly Pest Control' };

describe('retiredGateInputsForVisitEdit', () => {
  test('an ID-less add-on name new to the visit goes through the gate by name', () => {
    expect(retiredGateInputsForVisitEdit({
      current, currentAddons: [], postedServiceId: LIVE_ID,
      postedAddons: [{ serviceId: null, serviceName: 'Quarterly Tree & Shrub', recurringPattern: null }], serviceType: 'Quarterly Pest Control',
    })).toEqual({ serviceIds: [], serviceTypes: [{ label: 'Quarterly Tree & Shrub', recurrence: null }] });
    // An add-on line's own cadence rides with its name (codex r22).
    expect(retiredGateInputsForVisitEdit({
      current, currentAddons: [], postedServiceId: LIVE_ID,
      postedAddons: [{ serviceId: null, serviceName: 'Tree & Shrub Care', recurringPattern: 'quarterly', recurringIntervalDays: null }], serviceType: 'Quarterly Pest Control',
    })).toEqual({ serviceIds: [], serviceTypes: [{ label: 'Tree & Shrub Care', recurrence: { pattern: 'quarterly', intervalDays: null } }] });
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

  test('a second copy of an add-on already on the visit is an added line (codex r26)', () => {
    // One stored quarterly T&S add-on (id-backed) and one id-less name; the
    // save reposts each twice. The first copies are the visit's own lines,
    // the second copies are new sales — by id and by name.
    expect(retiredGateInputsForVisitEdit({
      current,
      currentAddons: [{ service_id: RETIRED_ID, service_name: 'Quarterly T&S', recurring_pattern: null }, { service_id: null, service_name: 'Quarterly Tree & Shrub', recurring_pattern: null }],
      postedServiceId: LIVE_ID,
      postedAddons: [
        { serviceId: RETIRED_ID, serviceName: 'Quarterly T&S', recurringPattern: null },
        { serviceId: RETIRED_ID, serviceName: 'Quarterly T&S', recurringPattern: null },
        { serviceId: null, serviceName: 'Quarterly Tree & Shrub', recurringPattern: null },
        { serviceId: null, serviceName: 'Quarterly Tree & Shrub', recurringPattern: 'quarterly', recurringIntervalDays: null },
      ],
      serviceType: 'Quarterly Pest Control',
    })).toEqual({
      serviceIds: [RETIRED_ID],
      serviceTypes: [{ label: 'Quarterly Tree & Shrub', recurrence: { pattern: 'quarterly', intervalDays: null } }],
    });
    // The primary line's own id is one occurrence: a posted add-on carrying
    // it is a move, a second one is added.
    expect(retiredGateInputsForVisitEdit({
      current: { ...current, service_id: RETIRED_ID }, currentAddons: [], postedServiceId: LIVE_ID,
      postedAddons: [{ serviceId: RETIRED_ID, serviceName: 'Quarterly T&S' }, { serviceId: RETIRED_ID, serviceName: 'Quarterly T&S' }],
      serviceType: 'Quarterly Pest Control',
    })).toEqual({ serviceIds: [LIVE_ID, RETIRED_ID], serviceTypes: [] });
    // A same-id posted primary takes the primary occurrence first, so the
    // stored add-on occurrence still covers the reposted add-on.
    expect(retiredGateInputsForVisitEdit({
      current: { ...current, service_id: RETIRED_ID }, currentAddons: [{ service_id: RETIRED_ID, service_name: 'Quarterly T&S' }], postedServiceId: RETIRED_ID,
      postedAddons: [{ serviceId: RETIRED_ID, serviceName: 'Quarterly T&S' }],
      serviceType: 'Quarterly Pest Control',
    })).toEqual({ serviceIds: [], serviceTypes: [] });
  });

  test('two stored copies of one add-on each pair with their own posted line for the cadence checks (codex r27)', () => {
    // A recurring every-60-days visit carries two Standard T&S add-ons on the
    // same catalog id: one one_time (listed first), one riding the parent.
    // The save keeps both and turns the parent quarterly: the riding copy is
    // the retained plan line and must reach the gate; the one_time copy must
    // not swallow it.
    const recurring = { ...current, is_recurring: true, service_type: 'Lawn Care', recurring_pattern: 'custom', recurring_interval_days: 60 };
    const stored = [
      { id: 'a1', service_id: LIVE_ID, service_name: 'Bi-Monthly Tree & Shrub Care', recurring_pattern: 'one_time', recurring_interval_days: null },
      { id: 'a2', service_id: LIVE_ID, service_name: 'Bi-Monthly Tree & Shrub Care', recurring_pattern: null, recurring_interval_days: null },
    ];
    const expected = { serviceIds: [LIVE_ID], serviceTypes: ['Lawn Care', { label: 'Bi-Monthly Tree & Shrub Care', recurrence: null }] };
    // Posted in stored order, no row ids: identity pairing in order.
    expect(retiredGateInputsForVisitEdit({
      current: recurring, currentAddons: stored, postedServiceId: null, serviceType: 'Lawn Care', plansRetainedLines: true,
      postedAddons: [
        { serviceId: LIVE_ID, serviceName: 'Bi-Monthly Tree & Shrub Care', recurringPattern: 'one_time' },
        { serviceId: LIVE_ID, serviceName: 'Bi-Monthly Tree & Shrub Care', recurringPattern: null },
      ],
    })).toEqual(expected);
    // Posted in the opposite order WITH row ids: each line pairs with its own row.
    expect(retiredGateInputsForVisitEdit({
      current: recurring, currentAddons: stored, postedServiceId: null, serviceType: 'Lawn Care', plansRetainedLines: true,
      postedAddons: [
        { id: 'a2', serviceId: LIVE_ID, serviceName: 'Bi-Monthly Tree & Shrub Care', recurringPattern: null },
        { id: 'a1', serviceId: LIVE_ID, serviceName: 'Bi-Monthly Tree & Shrub Care', recurringPattern: 'one_time' },
      ],
    })).toEqual(expected);
    // Without a parent cadence change, repatterning only the riding copy to
    // quarterly is read against ITS stored row (null → quarterly), not the
    // one_time copy's.
    expect(retiredGateInputsForVisitEdit({
      current: recurring, currentAddons: stored, postedServiceId: LIVE_ID, serviceType: 'Lawn Care',
      postedAddons: [
        { id: 'a1', serviceId: LIVE_ID, serviceName: 'Bi-Monthly Tree & Shrub Care', recurringPattern: 'one_time' },
        { id: 'a2', serviceId: LIVE_ID, serviceName: 'Bi-Monthly Tree & Shrub Care', recurringPattern: 'quarterly' },
      ],
    })).toEqual({ serviceIds: [LIVE_ID], serviceTypes: [{ label: 'Bi-Monthly Tree & Shrub Care', recurrence: { pattern: 'quarterly', intervalDays: null } }] });
    // A posted line whose row id names a stored row of a DIFFERENT service is
    // a changed line: the new service is gated as added, never paired by id.
    expect(retiredGateInputsForVisitEdit({
      current, currentAddons: [{ id: 'a1', service_id: LIVE_ID, service_name: 'Bi-Monthly Tree & Shrub Care', recurring_pattern: null }],
      postedServiceId: LIVE_ID, serviceType: 'Quarterly Pest Control',
      postedAddons: [{ id: 'a1', serviceId: RETIRED_ID, serviceName: 'Quarterly T&S', recurringPattern: null }],
    })).toEqual({ serviceIds: [RETIRED_ID], serviceTypes: [] });
  });

  test('added catalog ids and a changed primary label are gated too', () => {
    expect(retiredGateInputsForVisitEdit({
      current, currentAddons: [], postedServiceId: RETIRED_ID, postedAddons: [], serviceType: 'Quarterly Tree & Shrub Care',
    })).toEqual({ serviceIds: [RETIRED_ID], serviceTypes: ['Quarterly Tree & Shrub Care'] });
  });

  // codex r18/r20 P1: turning a one-off visit into a recurring one (or
  // changing the cadence of one that already recurs) sells its retained
  // lines as a plan, so they go through the gate as if added.
  test('activating recurrence gates the retained primary line and add-ons', () => {
    const oneOff = { ...current, service_id: RETIRED_ID, service_type: 'Quarterly Tree & Shrub Care' };
    expect(retiredGateInputsForVisitEdit({
      current: oneOff, currentAddons: [{ service_id: LIVE_ID, service_name: 'Quarterly Pest Control' }, { service_id: null, service_name: 'Mosquito add-on' }],
      postedServiceId: RETIRED_ID, postedAddons: null, serviceType: 'Quarterly Tree & Shrub Care', plansRetainedLines: true,
    })).toEqual({
      serviceIds: [RETIRED_ID, LIVE_ID],
      serviceTypes: ['Quarterly Tree & Shrub Care', { label: 'Quarterly Pest Control', recurrence: null }, { label: 'Mosquito add-on', recurrence: null }],
    });
    // Already recurring, or a save that does not post recurrence: nothing retained is re-checked.
    expect(retiredGateInputsForVisitEdit({
      current: oneOff, currentAddons: [], postedServiceId: RETIRED_ID, postedAddons: [], serviceType: 'Quarterly Tree & Shrub Care', plansRetainedLines: false,
    })).toEqual({ serviceIds: [], serviceTypes: [] });
  });

  // codex r19/r22 P1: on a visit that already recurs, a retained add-on
  // reposted with a different pattern than its stored one (one_time promoted
  // to the plan, or a plan pattern changed) is gated as if added — by id and
  // by name, carrying the NEW cadence.
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
    })).toEqual({
      serviceIds: [RETIRED_ID],
      serviceTypes: [{ label: 'Quarterly T&S', recurrence: null }, { label: 'Quarterly Tree & Shrub', recurrence: { pattern: 'quarterly', intervalDays: null } }],
    });
    // A live 6x add-on reposted with a quarterly pattern: the id stays live,
    // but the name now carries the retired cadence (codex r22).
    expect(retiredGateInputsForVisitEdit({
      current: recurring, currentAddons: [{ service_id: LIVE_ID, service_name: 'Bi-Monthly Tree & Shrub Care', recurring_pattern: 'bimonthly' }], postedServiceId: LIVE_ID, serviceType: 'Quarterly Pest Control',
      postedAddons: [{ serviceId: LIVE_ID, serviceName: 'Bi-Monthly Tree & Shrub Care', recurringPattern: 'quarterly' }],
    })).toEqual({ serviceIds: [LIVE_ID], serviceTypes: [{ label: 'Bi-Monthly Tree & Shrub Care', recurrence: { pattern: 'quarterly', intervalDays: null } }] });
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
      postedAddons: [{ serviceId: RETIRED_ID, serviceName: 'Quarterly T&S', recurringPattern: null }],
    })).toEqual({ serviceIds: [], serviceTypes: [] });
  });

  // codex r23 P1: a live catalog-backed T&S add-on riding a parent whose
  // cadence just changed is the retired plan by name + cadence even though
  // its id stays live — its name reaches the gate with the cadence it will
  // run at (the reposted line's own, else the stored one; null rides the
  // parent, so the route's booking cadence applies).
  test('a cadence change on the parent gates every retained add-on name, catalog-backed or not', () => {
    const recurring = { ...current, is_recurring: true, service_type: 'Monthly Lawn Care', recurring_pattern: 'monthly' };
    const stored = [
      { service_id: LIVE_ID, service_name: 'Bi-Monthly Tree & Shrub Care', recurring_pattern: null, recurring_interval_days: null },
      { service_id: RETIRED_ID, service_name: 'Quarterly T&S', recurring_pattern: 'custom', recurring_interval_days: 90 },
    ];
    expect(retiredGateInputsForVisitEdit({
      current: recurring, currentAddons: stored, postedServiceId: null, postedAddons: null, serviceType: 'Monthly Lawn Care', plansRetainedLines: true,
    })).toEqual({
      serviceIds: [LIVE_ID, RETIRED_ID],
      serviceTypes: [
        'Monthly Lawn Care',
        { label: 'Bi-Monthly Tree & Shrub Care', recurrence: null },
        { label: 'Quarterly T&S', recurrence: { pattern: 'custom', intervalDays: 90 } },
      ],
    });
    // A reposted line's own cadence wins over the stored one.
    expect(retiredGateInputsForVisitEdit({
      current: recurring, currentAddons: stored, postedServiceId: null, serviceType: 'Monthly Lawn Care', plansRetainedLines: true,
      postedAddons: [{ serviceId: LIVE_ID, serviceName: 'Bi-Monthly Tree & Shrub Care', recurringPattern: 'bimonthly' }],
    }).serviceTypes).toContainEqual({ label: 'Bi-Monthly Tree & Shrub Care', recurrence: { pattern: 'bimonthly', intervalDays: null } });
  });

  // codex r24: a retained add-on's interval change is a cadence change too,
  // and a one_time add-on never rides the parent's cadence.
  test('an add-on interval change is re-gated; a one_time add-on is skipped on a parent cadence change', () => {
    const recurring = { ...current, is_recurring: true, service_type: 'Monthly Lawn Care', recurring_pattern: 'monthly' };
    expect(retiredGateInputsForVisitEdit({
      current: recurring, currentAddons: [{ service_id: LIVE_ID, service_name: 'Bi-Monthly Tree & Shrub Care', recurring_pattern: 'custom', recurring_interval_days: 60 }],
      postedServiceId: null, serviceType: 'Monthly Lawn Care',
      postedAddons: [{ serviceId: LIVE_ID, serviceName: 'Bi-Monthly Tree & Shrub Care', recurringPattern: 'custom', recurringIntervalDays: 90 }],
    })).toEqual({ serviceIds: [LIVE_ID], serviceTypes: [{ label: 'Bi-Monthly Tree & Shrub Care', recurrence: { pattern: 'custom', intervalDays: 90 } }] });
    // Same interval reposted: nothing to gate.
    expect(retiredGateInputsForVisitEdit({
      current: recurring, currentAddons: [{ service_id: LIVE_ID, service_name: 'Bi-Monthly Tree & Shrub Care', recurring_pattern: 'custom', recurring_interval_days: 60 }],
      postedServiceId: null, serviceType: 'Monthly Lawn Care',
      postedAddons: [{ serviceId: LIVE_ID, serviceName: 'Bi-Monthly Tree & Shrub Care', recurringPattern: 'custom', recurringIntervalDays: '60' }],
    })).toEqual({ serviceIds: [], serviceTypes: [] });
    // Parent cadence change: the one_time retired add-on stays out of the gate.
    expect(retiredGateInputsForVisitEdit({
      current: recurring, postedServiceId: null, serviceType: 'Monthly Lawn Care', plansRetainedLines: true,
      currentAddons: [
        { service_id: RETIRED_ID, service_name: 'Quarterly T&S', recurring_pattern: 'one_time', recurring_interval_days: null },
        { service_id: LIVE_ID, service_name: 'Bi-Monthly Tree & Shrub Care', recurring_pattern: null, recurring_interval_days: null },
      ],
      postedAddons: null,
    })).toEqual({ serviceIds: [LIVE_ID], serviceTypes: ['Monthly Lawn Care', { label: 'Bi-Monthly Tree & Shrub Care', recurrence: null }] });
  });

  // codex r25 P2: only lines that remain after the save are retained — an
  // explicit add-on replacement drops the stored lines it omits, and a
  // replaced primary service is not retained (the new id is gated as added).
  test('a parent cadence change gates only the lines that remain in the posted state', () => {
    const recurring = { ...current, is_recurring: true, service_type: 'Monthly Lawn Care', recurring_pattern: 'monthly' };
    const stored = [
      { service_id: LIVE_ID, service_name: 'Bi-Monthly Tree & Shrub Care', recurring_pattern: null, recurring_interval_days: null },
      { service_id: null, service_name: 'Mosquito add-on', recurring_pattern: null, recurring_interval_days: null },
    ];
    // Explicit replacement that removes the T&S add-on: it is not gated.
    expect(retiredGateInputsForVisitEdit({
      current: recurring, currentAddons: stored, postedServiceId: null, serviceType: 'Monthly Lawn Care', plansRetainedLines: true,
      postedAddons: [{ serviceId: null, serviceName: 'Mosquito add-on', recurringPattern: null }],
    })).toEqual({ serviceIds: [LIVE_ID], serviceTypes: ['Monthly Lawn Care', { label: 'Mosquito add-on', recurrence: null }] });
    // Explicit empty replacement: no add-on survives.
    expect(retiredGateInputsForVisitEdit({
      current: recurring, currentAddons: stored, postedServiceId: null, postedAddons: [], serviceType: 'Monthly Lawn Care', plansRetainedLines: true,
    })).toEqual({ serviceIds: [LIVE_ID], serviceTypes: ['Monthly Lawn Care'] });
    // Replaced primary: the old id and label are not retained; the new id is gated as added.
    expect(retiredGateInputsForVisitEdit({
      current: { ...recurring, service_id: LIVE_ID }, currentAddons: [], postedServiceId: RETIRED_ID, postedAddons: null,
      serviceType: 'Quarterly Tree & Shrub Care', plansRetainedLines: true,
    })).toEqual({ serviceIds: [RETIRED_ID], serviceTypes: ['Quarterly Tree & Shrub Care'] });
  });

  test('addonLineRecurrence reads a line\'s own pattern or interval, else null', () => {
    expect(addonLineRecurrence({ recurringPattern: 'quarterly' })).toEqual({ pattern: 'quarterly', intervalDays: null });
    expect(addonLineRecurrence({ recurringPattern: 'custom', recurringIntervalDays: '90' })).toEqual({ pattern: 'custom', intervalDays: 90 });
    expect(addonLineRecurrence({ recurringIntervalDays: 90 })).toEqual({ pattern: null, intervalDays: 90 });
    expect(addonLineRecurrence({ recurringPattern: null, recurringIntervalDays: null })).toBeNull();
    expect(addonLineRecurrence({ recurringPattern: ' ' })).toBeNull();
    expect(addonLineRecurrence(undefined)).toBeNull();
  });

  test('the route hands every posted add-on line, with the stored pattern, to the helper', () => {
    const source = require('fs').readFileSync(require.resolve('../routes/admin-schedule'), 'utf8');
    // null when the save posted no add-ons (every stored line stays); an array is an explicit replacement (codex r25).
    expect(source).toMatch(/const postedAddons = Array\.isArray\(replaceAddons\) \? replaceAddons\.filter\(Boolean\) : null;/);
    expect(source).toMatch(/current, currentAddons, postedServiceId: updates\.service_id, postedAddons, serviceType, plansRetainedLines,/);
    // Activation / cadence change is confirmed against the row's own flag and
    // stored pattern, never the posted values alone (codex r18/r20).
    expect(source).toMatch(/\.first\('customer_id', 'service_id', 'service_type', 'is_recurring', 'recurring_pattern', 'recurring_interval_days'\)/);
    // Stored row ids ride along so a posted line pairs with its own stored row (codex r27).
    expect(source).toMatch(/\.select\('id', 'service_id', 'service_name', 'recurring_pattern', 'recurring_interval_days'\)/);
    // A changed interval is a cadence change too (codex r23).
    expect(source).toMatch(/const plansRetainedLines = recurrencePosted\s*&& \(!current\.is_recurring \|\| \(!!recurringPattern && recurringPattern !== current\.recurring_pattern\) \|\| intervalChanged\);/);
    expect(source).toMatch(/&& postedInterval !== Number\.parseInt\(current\.recurring_interval_days, 10\);/);
    // The posted cadence reaches the gate on both write paths (codex r20).
    const recurrenceArg = /recurrence: (?:recurrencePosted|isRecurring) \? \{ pattern: recurringPattern, intervalDays: recurringIntervalDays \} : null,/g;
    expect((source.match(recurrenceArg) || []).length).toBe(2);
    // POST / hands each add-on name its own cadence (codex r22).
    expect(source).toMatch(/recurrence: addonLineRecurrence\(\{ recurringPattern: a\?\.recurringPattern \|\| a\?\.cadence, recurringIntervalDays: a\?\.recurringIntervalDays \?\? a\?\.intervalDays \}\),/);
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

  test('only the retired row the quote actually carries is vouched for (codex r22)', () => {
    // A legacy 12x Premium quote is retired too, but was never sold as tree_shrub_quarterly.
    const premium = { recurring: { services: [{ name: 'Tree & Shrub Premium', visitsPerYear: 12 }] } };
    expect(retiredSaleKeysVouchedByAcceptedEstimate({ status: 'accepted', estimate_data: premium }).size).toBe(0);
    // Light / 4x evidence in any of the row's identity fields vouches.
    for (const svc of [
      { name: 'Tree & Shrub Care', serviceKey: 'tree_shrub_quarterly' },
      { name: 'Tree & Shrub Care', visitsPerYear: 4 },
      { name: 'Tree & Shrub Care', frequency: 'quarterly' },
      { name: 'Tree & Shrub Care', tier: 'light' },
      { name: 'Ornamental Care (Light)' },
    ]) {
      expect([...retiredSaleKeysVouchedByAcceptedEstimate({ status: 'accepted', estimate_data: { recurring: { services: [svc] } } })]).toEqual(['tree_shrub_quarterly']);
    }
    // A quarterly row of another family never vouches for the T&S plan.
    expect(retiredSaleKeysVouchedByAcceptedEstimate({ status: 'accepted', estimate_data: { recurring: { services: [{ name: 'Quarterly Pest Control', visitsPerYear: 4 }] } } }).size).toBe(0);
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
