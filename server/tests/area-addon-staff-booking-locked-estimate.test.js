/**
 * Codex round 14 P1 on #6135: the staff booking's transaction read the linked estimate FOR SHARE with identity columns only and
 * ran the yearly-limit recheck (and later the scope writer) on the PREFLIGHT copy of the estimate, so an estimator save that
 * landed between the preflight and the lock was booked unchecked. Every add-on decision in the transaction now reads the row the
 * transaction locked: the gated and recurring-plan refusals, the limits, and the sold scope the visit rows are written from.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const fs = require('fs');
const path = require('path');
const router = require('../routes/admin-schedule');
const limits = require('../services/area-addon-limits');

const { assertLockedEstimateAddOns, LINKED_ESTIMATE_COLUMNS } = router._test;
const ADD_ON = { service: 'area_addon', addOnKey: 'web_sweep', name: 'Web Sweep', price: 59 };
const row = (extra = {}) => ({
  id: 'est-1', status: 'sent', customer_id: null, monthly_total: 0, annual_total: 0, onetime_total: 59,
  estimate_data: JSON.stringify({ engineInputs: { services: { areaAddOns: [{ key: 'web_sweep' }] } }, result: { recurring: { services: [] }, oneTime: { items: [ADD_ON] } } }),
  ...extra,
});
const subject = { billingTerm: 'standard', customerId: 'cust-1', property: { property_id: 'prop-1' }, appliedOn: '2026-11-02' };
const withGate = async (value, fn) => {
  const prev = process.env.GATE_AREA_ADDONS;
  if (value === undefined) delete process.env.GATE_AREA_ADDONS; else process.env.GATE_AREA_ADDONS = value;
  try { return await fn(); } finally { if (prev === undefined) delete process.env.GATE_AREA_ADDONS; else process.env.GATE_AREA_ADDONS = prev; }
};

describe('the staff booking judges the add-ons on the estimate row its transaction locked', () => {
  let recheck;
  beforeEach(() => { recheck = jest.spyOn(limits, 'assertAreaAddOnLimitsOpen').mockResolvedValue(undefined); });
  afterEach(() => recheck.mockRestore());

  test('a sold add-on whose gate is off is refused with the staff 409 and the gate code, before any limit read', async () => {
    await withGate(undefined, async () => {
      await expect(assertLockedEstimateAddOns({}, row(), subject)).rejects.toMatchObject({ status: 409, statusCode: 409, isOperational: true, message: expect.stringMatching(/GATE_AREA_ADDONS/) });
    });
    expect(recheck).not.toHaveBeenCalled();
  });

  test('a not-yet-accepted recurring estimate that carries an add-on is refused (the plan would convert and drop it); an accepted one books', async () => {
    await withGate('true', async () => {
      const recurring = row({ monthly_total: 65, annual_total: 780, estimate_data: JSON.stringify({ result: { recurring: { services: [{ service: 'pest_control', mo: 65 }] }, oneTime: { items: [ADD_ON] } } }) });
      await expect(assertLockedEstimateAddOns({}, recurring, subject)).rejects.toMatchObject({ status: 409, code: 'AREA_ADDONS_ONE_TIME_ACCEPT_ONLY' });
      await expect(assertLockedEstimateAddOns({}, { ...recurring, status: 'accepted' }, subject)).resolves.toBeUndefined();
    });
  });

  test('the yearly-limit recheck gets the LOCKED row with the booking customer, property and day, as a staff request', async () => {
    const trx = { tag: 'trx' };
    const locked = row({ estimate_data: JSON.stringify({ result: { oneTime: { items: [{ service: 'area_addon', addOnKey: 'lawn_insect_preventive', price: 120 }] } } }) });
    await withGate('true', async () => {
      await assertLockedEstimateAddOns(trx, locked, subject);
    });
    expect(recheck).toHaveBeenCalledTimes(1);
    expect(recheck).toHaveBeenCalledWith(trx, { estimate: locked, customerId: 'cust-1', property: { property_id: 'prop-1' }, appliedOn: '2026-11-02', staff: true, onlyServiceKeys: null });
  });

  // Codex round 24: the office may leave a sold add-on off the booking; only the posted add-ons are limit-checked.
  test('the posted add-on keys ride to the recheck', async () => {
    const trx = { tag: 'trx' };
    const locked = row();
    await withGate('true', async () => {
      await assertLockedEstimateAddOns(trx, locked, { ...subject, postedServiceKeys: ['one_time_pest'] });
    });
    expect(recheck).toHaveBeenLastCalledWith(trx, expect.objectContaining({ onlyServiceKeys: ['one_time_pest'] }));
  });

  test('a refusal of the recheck stops the booking with its own 409', async () => {
    recheck.mockRejectedValue(Object.assign(new Error('limit reached'), { status: 409, code: 'AREA_ADDON_YEARLY_LIMIT_REACHED', isOperational: true }));
    await withGate('true', async () => {
      await expect(assertLockedEstimateAddOns({}, row(), subject)).rejects.toMatchObject({ status: 409, code: 'AREA_ADDON_YEARLY_LIMIT_REACHED' });
    });
  });

  test('the transaction reads the whole linked estimate FOR SHARE, judges that row, and writes the sold scope from it', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin-schedule.js'), 'utf8');
    expect(LINKED_ESTIMATE_COLUMNS).toEqual(expect.arrayContaining(['estimate_data', 'status', 'monthly_total', 'annual_total', 'onetime_total', 'customer_id', 'property_id', 'address']));
    // The preflight and the locked read are the same column list.
    expect(src).toContain(".where({ id: linkedEstimateId }).forShare().first(...LINKED_ESTIMATE_COLUMNS);");
    expect(src).toContain('.first(...LINKED_ESTIMATE_COLUMNS);');
    // The decisions made after the lock read the locked copy; the stale copy no longer reaches the recheck or the writer.
    expect(src).toContain('lockedLinkedEstimate = freshLinkedEstimate;');
    expect(src).toContain('estimate: lockedLinkedEstimate, ownServiceKey: svc.service_key_snapshot');
    expect(src).not.toMatch(/assertAreaAddOnLimitsOpen\(trx, \{\s+estimate: linkedEstimate/);
    expect(src).not.toMatch(/writeStaffBookedAreaAddOnScopes\(trx, \{[^}]*estimate: linkedEstimate\b/);
    // The scope writer runs after the lock read, inside the same transaction.
    expect(src.indexOf('lockedLinkedEstimate = freshLinkedEstimate;')).toBeLessThan(src.indexOf('estimate: lockedLinkedEstimate, ownServiceKey'));
  });
});
