// Codex round 17 on #6135: a revision's stale raw `engineResult` must never keep a clean revision gated, rechecked or
// booked. ONE helper (estimate-result-container.js storedAreaAddOnRows) answers "the area add-on rows of this stored
// estimate" from the AUTHORITATIVE container, the pick the Bermuda evidence detector uses; every reader below goes
// through it. The replayable INPUTS stay fail-closed at every gate boundary (the Bermuda data detector's choice).

jest.mock('../models/db', () => {
  const mock = jest.fn();
  mock.fn = { now: jest.fn(() => 'NOW') };
  mock.raw = jest.fn((sql) => ({ __raw: sql }));
  mock.transaction = jest.fn(async (fn) => fn(mock));
  return mock;
});
jest.mock('../services/stripe', () => ({}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { storedAreaAddOnRows, storedEstimateContainer } = require('../services/estimate-result-container');
const mapper = require('../services/pricing-engine/v1-legacy-mapper');
const { soldAddOnKeys } = require('../services/area-addon-limits');
const { areaAddOnKnobSignalForReplay } = require('../services/estimate-area-addon-knob-replay');
const { persistedAddOnRefusal, recurringAcceptWouldDropAreaAddOns } = require('../services/estimate-manual-acceptance');
const { normalizeOneTimeBreakdown } = require('../routes/estimate-public');
const { assertEstimateSendable } = require('../routes/admin-estimates')._internals;

const ADD_ON = { service: 'area_addon', addOnKey: 'fire_ant_yard', label: 'Fire Ant Yard Treatment', price: 120, priceAfterDiscount: 120 };
const PEST = { service: 'one_time_pest', name: 'One-Time Pest Control', label: 'One-Time Pest Control', price: 150 };
const withAddOn = () => ({ oneTime: { items: [PEST, ADD_ON] }, lineItems: [ADD_ON] });
const clean = () => ({ oneTime: { items: [PEST] }, lineItems: [PEST] });

let savedGate;
beforeEach(() => { savedGate = process.env.GATE_AREA_ADDONS; delete process.env.GATE_AREA_ADDONS; });
afterEach(() => {
  if (savedGate === undefined) delete process.env.GATE_AREA_ADDONS; else process.env.GATE_AREA_ADDONS = savedGate;
});

// A revision that removed the add-on: the clean authoritative `result`, the previous raw `engineResult` left behind.
const staleRevision = (extra = {}) => ({ result: clean(), engineResult: withAddOn(), ...extra });
const onlyEngineResult = () => ({ engineResult: withAddOn() });

describe('storedAreaAddOnRows: the authoritative container', () => {
  test('a clean priced result wins over a stale engineResult', () => {
    expect(storedAreaAddOnRows(staleRevision())).toEqual([]);
  });

  test('a result that still carries the add-on supplies it', () => {
    expect(storedAreaAddOnRows({ result: withAddOn(), engineResult: clean() }).map((r) => r.addOnKey)).toContain('fire_ant_yard');
  });

  test('an estimate whose only container is engineResult is read from it', () => {
    expect([...new Set(storedAreaAddOnRows(onlyEngineResult()).map((r) => r.addOnKey))]).toEqual(['fire_ant_yard']);
  });

  test('a placeholder result that prices nothing yields to a priced engineResult (a quote-wizard row)', () => {
    expect(storedAreaAddOnRows({ result: {}, engineResult: withAddOn() }).length).toBeGreaterThan(0);
  });

  test('a SERVER reprice makes result the authority even when it prices nothing (row authority or the blob lock stamp)', () => {
    const data = { result: {}, engineResult: withAddOn() };
    expect(storedAreaAddOnRows(data, { pricingAuthority: 'SERVER' })).toEqual([]);
    expect(storedAreaAddOnRows({ ...data, pricingAuthorityAtLock: 'SERVER' })).toEqual([]);
    expect(storedAreaAddOnRows(data, { pricingAuthority: 'CLIENT_FALLBACK' }).length).toBeGreaterThan(0);
  });

  test('a bare mapped shape (neither container) is read as itself; a JSON string and junk are safe', () => {
    expect(storedAreaAddOnRows(withAddOn()).length).toBeGreaterThan(0);
    expect(storedAreaAddOnRows(JSON.stringify(staleRevision()))).toEqual([]);
    expect(storedAreaAddOnRows('{not json')).toEqual([]);
    expect(storedAreaAddOnRows(null)).toEqual([]);
    expect(storedEstimateContainer({ oneTime: {} })).toBeNull();
  });
});

describe('every reader uses it', () => {
  test('the gate detector: a clean revision is not carried, whatever engineResult still holds; the only-engineResult shape is', () => {
    expect(mapper.estimateDataCarriesAreaAddOns(staleRevision())).toBe(false);
    expect(mapper.estimateDataCarriesAreaAddOns(onlyEngineResult())).toBe(true);
    expect(mapper.estimateDataCarriesAreaAddOns({ result: withAddOn(), engineResult: clean() })).toBe(true);
  });

  test('the replayable inputs stay fail-closed even beside a clean result', () => {
    for (const inputs of [
      { engineInputs: { services: { areaAddOns: [{ key: 'fire_ant_yard' }] } } },
      { inputs: { services: { areaAddOns: [{ key: 'fire_ant_yard' }] } } },
      { engineRequest: { options: { areaAddOns: [{ key: 'fire_ant_yard' }] } } },
    ]) {
      expect(mapper.estimateDataCarriesAreaAddOns(staleRevision(inputs))).toBe(true);
    }
  });

  test('sold keys (the limit recheck and the booking): the stale add-on is not rechecked or booked, the real one is', () => {
    expect(soldAddOnKeys(staleRevision())).toEqual([]);
    expect(soldAddOnKeys(onlyEngineResult())).toEqual(['fire_ant_yard']);
    expect(soldAddOnKeys({ result: withAddOn(), engineResult: clean() })).toEqual(['fire_ant_yard']);
    expect(soldAddOnKeys({ result: {}, engineResult: withAddOn() }, { pricingAuthority: 'SERVER' })).toEqual([]);
  });

  test('the knob replay does not take a stamp from the removed add-on', () => {
    const stamped = { ...ADD_ON, pricingKnobs: { targetMargin: 0.5, adminPerJob: 1, laborRate: 1, driveMinutes: 1, items: {} } };
    expect(areaAddOnKnobSignalForReplay({ result: clean(), engineResult: { lineItems: [stamped] } })).toBeNull();
    expect(areaAddOnKnobSignalForReplay({ engineResult: { lineItems: [ADD_ON] } })).not.toBeNull();
  });

  test('the one-time breakdown (slot profile, visit rows, accept) has no add-on row after the revision', () => {
    expect(normalizeOneTimeBreakdown(staleRevision()).items.map((i) => i.service)).toEqual(['one_time_pest']);
    expect(normalizeOneTimeBreakdown({ result: withAddOn(), engineResult: clean() }).items.map((i) => i.service)).toContain('area_addon');
    expect(normalizeOneTimeBreakdown(onlyEngineResult()).items.map((i) => i.service)).toContain('area_addon');
  });
});

describe('each gate boundary asks the inputs-inclusive detector (the Bermuda data detector choice), with the row authority', () => {
  const row = (data, extra = {}) => ({ archived_at: null, estimate_data: JSON.stringify(data), ...extra });
  const addOnInput = { engineRequest: { options: { areaAddOns: [{ key: 'fire_ant_yard' }] } } };

  test('send: a clean revision sends with the gate off; a leftover input or a carried row does not', () => {
    const codeOf = (data) => { try { assertEstimateSendable(row(data)); return null; } catch (err) { return err.code || null; } };
    expect(codeOf(staleRevision())).not.toBe('AREA_ADDONS_GATED');
    expect(codeOf(staleRevision(addOnInput))).toBe('AREA_ADDONS_GATED');
    expect(codeOf(onlyEngineResult())).toBe('AREA_ADDONS_GATED');
  });

  test('accept / reserve / slots / card intents / extend (customer refusal), deposit, prepay suggestion: clean revision passes, leftover input fails closed', () => {
    expect(mapper.gatedAddOnCustomerRefusal(staleRevision())).toBeNull();
    expect(mapper.gatedAddOnCustomerRefusal(staleRevision(addOnInput))).toMatchObject({ code: 'AREA_ADDONS_GATED' });
    expect(mapper.estimateAreaAddOnsGated(staleRevision())).toBe(false);
    expect(mapper.estimateAreaAddOnsGated(onlyEngineResult())).toBe(true);
    expect(mapper.annualPrepayBlockingAddOnReason(staleRevision())).toBeNull();
    expect(mapper.annualPrepayBlockingAddOnReason(onlyEngineResult())).toBe('estimate carries an area add-on');
  });

  test('Mark Won and the schedule booking preflight', () => {
    expect(persistedAddOnRefusal({ estimate_data: staleRevision() }, { action: 'accepting' })).toBeNull();
    expect(persistedAddOnRefusal({ estimate_data: onlyEngineResult() }, { action: 'accepting' })).toMatchObject({ code: 'AREA_ADDONS_GATED' });
    process.env.GATE_AREA_ADDONS = 'true';
    expect(recurringAcceptWouldDropAreaAddOns({ estimate_data: staleRevision(), monthly_total: 40 })).toBe(false);
  });

  test('the row authority rides every call site that holds the estimate row', () => {
    const fs = require('fs');
    const read = (p) => fs.readFileSync(require('path').join(__dirname, '..', p), 'utf8');
    const sites = {
      'routes/admin-estimates.js': /gatedAddOnStaffRefusal\([^)]*pricingAuthority: estimate\.pricing_authority/,
      'routes/estimate-public.js': /estimateDataCarriesAreaAddOns\(estimate\.estimate_data, \{ pricingAuthority: estimate\.pricing_authority/,
      'routes/estimate-slots-public.js': /gatedAddOnCustomerRefusal\(estimate\.estimate_data, \{ pricingAuthority: estimate\.pricing_authority/,
      'services/estimate-manual-acceptance.js': /gatedAddOnStaffRefusal\([^)]*pricingAuthority: estimate\.pricing_authority/,
      'services/estimate-deposits.js': /estimateAreaAddOnsGated\(estimate\.estimate_data, \{ pricingAuthority: estimate\.pricing_authority/,
      'services/annual-prepay-estimate-suggestion.js': /annualPrepayBlockingAddOnReason\(estData, \{ pricingAuthority: estimate\.pricing_authority/,
      'services/area-addon-limits.js': /soldAddOnKeys\([^;]*pricingAuthority/,
    };
    for (const [file, pattern] of Object.entries(sites)) expect([file, pattern.test(read(file))]).toEqual([file, true]);
  });
});

// Codex round 32: an enabled, itemized authored proposal is the customer's quote; retained engine inputs and rows are not.
describe('an authored proposal decides whether the estimate carries an add-on', () => {
  const mapper = require('../services/pricing-engine/v1-legacy-mapper');
  const limits = require('../services/area-addon-limits');
  const retained = {
    engineRequest: { options: { areaAddOns: [{ key: 'web_sweep' }] } },
    result: { oneTime: { items: [{ service: 'area_addon', addOnKey: 'web_sweep', name: 'Web Sweep', price: 89 }] } },
  };
  const proposal = (lineItems, enabled = true) => ({ enabled, buildings: [{ lineItems }] });

  test('a clean authored proposal carries none: not gated, nothing sold to recheck', () => {
    const clean = { ...retained, proposal: proposal([{ description: 'Quarterly pest control', unitPrice: 120, frequency: 'quarterly' }]) };
    expect(mapper.estimateDataCarriesAreaAddOns(clean)).toBe(false);
    expect(limits.soldAddOnKeys(clean)).toEqual([]);
  });

  test('a proposal line that keeps the add-on marker still carries it; a disabled or empty proposal reads the retained estimate', () => {
    for (const line of [{ description: 'Web Sweep', unitPrice: 89, frequency: 'one_time', priceUnit: 'application' }, { description: 'Web Sweep', addOnKey: 'web_sweep' }]) {
      expect(mapper.estimateDataCarriesAreaAddOns({ ...retained, proposal: proposal([line]) })).toBe(true);
    }
    expect(mapper.estimateDataCarriesAreaAddOns({ ...retained, proposal: proposal([{ description: 'x' }], false) })).toBe(true);
    expect(mapper.estimateDataCarriesAreaAddOns({ ...retained, proposal: { enabled: true, buildings: [] } })).toBe(true);
    expect(limits.soldAddOnKeys(retained)).toEqual(['web_sweep']);
  });
});
