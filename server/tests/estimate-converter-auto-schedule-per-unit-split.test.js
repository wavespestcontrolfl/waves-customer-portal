/**
 * B06 / B17: the plain (no-slot) auto-schedule loop of a multi-program accept
 * left every unit's seeded follow-ups unpriced, so completion fell back to the
 * customer-level fee (an add-on billed the OLD plan's fee) or to nothing (a new
 * customer's schedule completed unbilled). autoScheduleUnitPerVisitAmounts
 * prices each unit from the accept route's per-service amounts — and only when
 * rows and units agree one-to-one; unpricedMultiUnitAlertPayload is the office
 * alert for every shape it declines. DB-level coverage:
 * estimate-accept-multi-unit-per-unit-pricing.postgres.test.js.
 */
const {
  autoScheduleUnitPerVisitAmounts,
  unpricedMultiUnitAlertPayload,
} = require('../services/estimate-converter');
const { composeAdminAlert } = require('../services/admin-alert-compose');

const pest = { service: 'pest_control', name: 'Pest Control' };
const mosquito = { service: 'mosquito', name: 'Mosquito Control' };
const lawn = { service: 'lawn_care', name: 'Lawn Care' };
const rows = [
  { service: 'pest_control', name: 'Pest Control', amount: 45 },
  { service: 'mosquito', name: 'Mosquito Control', amount: 30 },
];

describe('autoScheduleUnitPerVisitAmounts', () => {
  test('each unit gets its OWN quoted per-visit amount', () => {
    const units = [{ svc: pest }, { svc: mosquito }];
    const out = autoScheduleUnitPerVisitAmounts({ units, rowAmounts: rows });
    expect(out.get(units[0])).toBe(45);
    expect(out.get(units[1])).toBe(30);
  });

  test('a combined unit (two lines, one visit) bills the sum of its lines', () => {
    const combo = { combo: { combinedFrom: [pest, { service: 'termite_bait', name: 'Termite Bait' }] }, svc: pest };
    const units = [combo, { svc: mosquito }];
    const out = autoScheduleUnitPerVisitAmounts({
      units, rowAmounts: [...rows, { service: 'termite_bait', name: 'Termite Bait', amount: 25 }],
    });
    expect(out.get(combo)).toBe(70);
    expect(out.get(units[1])).toBe(30);
  });

  test('no rows from the route (tier-monthly accept, fallback total, admin convert) → null, never a reconstruction', () => {
    const units = [{ svc: pest }, { svc: mosquito }];
    expect(autoScheduleUnitPerVisitAmounts({ units, rowAmounts: null })).toBeNull();
    expect(autoScheduleUnitPerVisitAmounts({ units, rowAmounts: [] })).toBeNull();
  });

  test('a unit with no matching row → null for the WHOLE plan (all-or-nothing)', () => {
    const units = [{ svc: pest }, { svc: mosquito }, { svc: lawn }];
    expect(autoScheduleUnitPerVisitAmounts({ units, rowAmounts: rows })).toBeNull();
  });

  test('a route row no unit consumes → null (rows and units must agree one-to-one)', () => {
    const units = [{ svc: pest }, { svc: mosquito }];
    expect(autoScheduleUnitPerVisitAmounts({
      units, rowAmounts: [...rows, { service: 'lawn_care', name: 'Lawn Care', amount: 60 }],
    })).toBeNull();
  });

  test('duplicate or non-positive route rows are unkeyable → null', () => {
    const units = [{ svc: pest }, { svc: mosquito }];
    expect(autoScheduleUnitPerVisitAmounts({ units, rowAmounts: [...rows, rows[0]] })).toBeNull();
    expect(autoScheduleUnitPerVisitAmounts({
      units, rowAmounts: [rows[0], { service: 'mosquito', name: 'Mosquito Control', amount: 0 }],
    })).toBeNull();
  });
});

describe('unpricedMultiUnitAlertPayload', () => {
  const base = { estimateId: 'est-1', customerId: 'cust-1', scheduledServiceIds: ['a', 'b'] };

  test.each([
    ['new customer (no fee)', null],
    ['existing per-application customer', 120],
  ])('%s: composes under the canonical admin-alert rules and dedupes per estimate', (_label, existingFee) => {
    const payload = unpricedMultiUnitAlertPayload({ ...base, existingFee });
    // composeAdminAlert threw nothing: the stamped path was used, not the raw fallback.
    expect(payload.title.startsWith('Billing — ')).toBe(true);
    expect(payload.options.metadata).toMatchObject({
      area: 'Billing', severity: 'needs-you', who: 'person', doneWhen: 'per_application_price_set',
      subject: { type: 'estimate', id: 'est-1' },
    });
    expect(payload.options).toMatchObject({
      bell: true, dedupeKey: 'per-application-fee-unresolved:est-1', link: '/admin/customers?customerId=cust-1',
    });
    expect(payload.finalBody).toBe(true);
    expect(() => composeAdminAlert({
      area: 'Billing', action: payload.title.replace('Billing — ', ''), why: payload.body.split('. ')[0] + '.',
      severity: 'needs-you', who: 'person', subject: { type: 'estimate', id: 'est-1' },
      doneWhen: 'per_application_price_set', link: payload.options.link,
    })).not.toThrow();
  });

  test('the existing-fee wording names the fee that would bill; the no-fee wording says no invoice', () => {
    expect(unpricedMultiUnitAlertPayload({ ...base, existingFee: 120 }).body).toContain('$120.00');
    expect(unpricedMultiUnitAlertPayload({ ...base, existingFee: null }).body).toMatch(/no invoice/);
  });
});
