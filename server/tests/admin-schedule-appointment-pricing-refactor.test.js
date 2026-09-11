/**
 * buildAppointmentPricing — Codex round-1 P2 on PR #4405 ("reduce the
 * rewritten pricing function's decision count"). The primary line and every
 * add-on line used to run the SAME three steps (resolve the line's discount
 * against its gross, compute the net the stacking pass restates, shape the
 * appointmentServiceLines entry) as two separately-written blocks — one
 * outside the add-on loop, one inside it. That duplicated decision path
 * (not just duplicated code — the null-check ternary and the `|| null`
 * service-identity fallbacks were each written twice) is now one function,
 * `resolveServiceLine`, called once per line (the primary, then each
 * add-on) — real reuse, not a one-use wrapper that just relocates branches.
 *
 * This does not change any computed amount: resolveServiceLine is exactly
 * the code that used to sit inline at each call site, unchanged in logic,
 * just no longer duplicated. The existing buildAppointmentPricing suites
 * (admin-schedule-discount-eligibility, discount-stacking-gate,
 * admin-schedule-mosquito-ladder-default, …) already cover the worked
 * amounts end to end and are unchanged by this refactor; these tests pin
 * the extracted helper directly and guard the wiring.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/discount-engine', () => ({
  manualEligibilityFailures: jest.fn(),
  clearCache: jest.fn(),
}));

const fs = require('fs');
const path = require('path');
const db = require('../models/db');
const DiscountEngine = require('../services/discount-engine');
const { resolveServiceLine } = require('../routes/admin-schedule')._test;

const src = fs.readFileSync(path.join(__dirname, '../routes/admin-schedule.js'), 'utf8');

function discountQuery(discount) {
  return { where: jest.fn().mockReturnThis(), first: jest.fn().mockResolvedValue(discount) };
}

beforeEach(() => jest.clearAllMocks());

describe('resolveServiceLine', () => {
  test('no discount: net equals gross, the line carries the gross/service identity', async () => {
    const { discount, net, line } = await resolveServiceLine({
      gross: 100, discountInput: null, serviceKey: 'general_pest', serviceCategory: 'pest_control',
      customer: { id: 'c1' }, recurringMembershipBooking: false,
    });
    expect(discount).toBeNull();
    expect(net).toBe(100);
    expect(line).toEqual({ amount: 100, gross: 100, lineDiscount: null, serviceKey: 'general_pest', serviceCategory: 'pest_control' });
  });

  test('a resolved catalog discount reduces the net by its dollars', async () => {
    const row = { id: 'd1', name: 'Spring 10%', discount_type: 'percentage', amount: 10 };
    db.mockReturnValueOnce(discountQuery(row));
    DiscountEngine.manualEligibilityFailures.mockResolvedValue([]);

    const { discount, net, line } = await resolveServiceLine({
      gross: 100, discountInput: { discountId: 'd1' }, serviceKey: 'general_pest', serviceCategory: 'pest_control',
      customer: { id: 'c1' }, recurringMembershipBooking: false,
    });
    expect(discount.discountDollars).toBe(10);
    expect(net).toBe(90);
    expect(line).toMatchObject({ amount: 90, gross: 100, serviceKey: 'general_pest', serviceCategory: 'pest_control' });
    expect(line.lineDiscount).toBe(discount);
  });

  test('a null gross (no price at all) resolves a null net, not zero — same contract every call site relied on', async () => {
    const { net, line } = await resolveServiceLine({
      gross: null, discountInput: null, serviceKey: null, serviceCategory: null,
      customer: { id: 'c1' }, recurringMembershipBooking: false,
    });
    expect(net).toBeNull();
    // The line entry still floors amount/gross at 0 for the stacking pass,
    // exactly as the old primary/addon literals did (`amount: net || 0`).
    expect(line).toEqual({ amount: 0, gross: 0, lineDiscount: null, serviceKey: null, serviceCategory: null });
  });

  test('a falsy (undefined) serviceKey/serviceCategory is normalized to null, as both call sites required', async () => {
    const { line } = await resolveServiceLine({
      gross: 50, discountInput: null, serviceKey: undefined, serviceCategory: '',
      customer: { id: 'c1' }, recurringMembershipBooking: false,
    });
    expect(line.serviceKey).toBeNull();
    expect(line.serviceCategory).toBeNull();
  });
});

describe('wiring (source-pattern guards — structural, not literal, per the #4372 exact-string-pin trap)', () => {
  test('the primary line resolves through resolveServiceLine, not an inline duplicate', () => {
    const block = src.slice(
      src.indexOf('async function buildAppointmentPricing('),
      src.indexOf('const addonLines = [];')
    );
    expect(block).toMatch(/primaryResolved\s*=\s*await\s+resolveServiceLine\(/);
    expect(block).not.toMatch(/const primaryDiscount\s*=\s*await\s+resolveLineDiscount\(/);
  });

  test('the add-on loop resolves through the SAME helper, so it is genuine reuse rather than a one-use wrapper', () => {
    const block = src.slice(
      src.indexOf('const addonLines = [];'),
      src.indexOf('const hasAnyPrice =')
    );
    expect(block).toMatch(/addonResolved\s*=\s*await\s+resolveServiceLine\(/);
    expect(block).not.toMatch(/const lineDiscount\s*=\s*await\s+resolveLineDiscount\(/);
  });

  test('buildAppointmentPricing returns a single result shape (no duplicated return object)', () => {
    const fnSrc = src.slice(
      src.indexOf('async function buildAppointmentPricing('),
      src.indexOf('async function insertScheduledServiceAddons(')
    );
    const returns = fnSrc.match(/\breturn\s*\{/g) || [];
    expect(returns.length).toBe(1);
  });
});
