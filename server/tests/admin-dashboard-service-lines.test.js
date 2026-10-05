/**
 * "By service line" dashboard card (services/dashboard-service-lines.js).
 *
 * Pins:
 *  (a) close-rate math: 3 accepted + 1 declined + 1 expired + 2 open -> 60%, open = 2
 *  (b) an estimate with several service lines counts once in EACH line
 *  (c) a failing query yields that field as null + a caveat, never a throw (a 500)
 */

jest.mock('../models/db', () => {
  const mockResults = {};
  function makeChain(table) {
    const state = { table };
    const chain = new Proxy({}, {
      get(_t, prop) {
        if (prop === 'then') {
          return (resolve, reject) => {
            const key = state.byCustomer ? 'estimatesByCustomer' : state.table;
            const value = mockResults[key];
            if (value instanceof Error) return Promise.reject(value).then(resolve, reject);
            return Promise.resolve(value || []).then(resolve, reject);
          };
        }
        if (prop === 'whereIn') {
          return (col) => { if (col === 'customer_id') state.byCustomer = true; return chain; };
        }
        // modify() must not run scopeToProspects against the fake.
        return () => chain;
      },
    });
    return chain;
  }
  const db = (arg) => makeChain(typeof arg === 'string' ? arg : Object.values(arg)[0]);
  db.raw = (sql) => sql;
  db.__results = mockResults;
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const db = require('../models/db');
const { computeServiceLines } = require('../services/dashboard-service-lines');

const NOW = new Date('2026-10-05T16:00:00Z');
const WIN = { from: '2026-10-01', to: '2026-10-05', label: 'Month to Date' };
const sentAt = '2026-10-01T15:00:00Z';

const est = (over) => ({
  id: Math.random().toString(36).slice(2),
  status: 'sent',
  sent_at: sentAt,
  created_at: '2026-09-30T15:00:00Z',
  updated_at: sentAt,
  archived_at: null,
  disposition: null,
  estimate_data: {},
  service_interest: 'Pest Control',
  ...over,
});

function resetResults() {
  for (const k of Object.keys(db.__results)) delete db.__results[k];
  db.__results.customers = [];
  db.__results.estimatesByCustomer = [];
  db.__results.leads = [];
}

const pestRow = (lines) => lines.find((l) => l.key === 'pest');
const lawnRow = (lines) => lines.find((l) => l.key === 'lawn');

beforeEach(resetResults);

describe('computeServiceLines', () => {
  it('(a) close rate is accepted / resolved: 3 won + 1 declined + 1 expired + 2 open = 60%, open = 2', async () => {
    db.__results.estimates = [
      est({ status: 'accepted', accepted_at: '2026-10-02T15:00:00Z' }),
      est({ status: 'accepted', accepted_at: '2026-10-02T16:00:00Z' }),
      est({ status: 'accepted', accepted_at: '2026-10-03T16:00:00Z' }),
      est({ status: 'declined', declined_at: '2026-10-03T15:00:00Z', decline_reason: 'Too expensive' }),
      est({ status: 'expired', expires_at: '2026-10-04T15:00:00Z', viewed_at: '2026-10-02T10:00:00Z' }),
      est({ status: 'sent' }),
      est({ status: 'viewed' }),
    ];
    const out = await computeServiceLines(WIN, { now: NOW });
    const pest = pestRow(out.lines);
    expect(pest.accepted).toBe(3);
    expect(pest.lost).toBe(2);
    expect(pest.resolved).toBe(5);
    expect(pest.close_rate).toBe(60);
    expect(pest.open).toBe(2);
    expect(pest.sent).toBe(7);
    // Open offers sent a few days ago are not yet "over 7 days".
    expect(pest.aging7).toBe(0);
    expect(out.period).toEqual(WIN);
    expect(out.caveats.length).toBeGreaterThan(0);
  });

  it('(a2) archived, dead and converted-elsewhere rows leave the math; null close rate with no resolved rows', async () => {
    db.__results.estimates = [
      est({ status: 'accepted', accepted_at: '2026-10-02T15:00:00Z', archived_at: '2026-10-03T00:00:00Z' }),
      est({ status: 'declined', declined_at: '2026-10-03T15:00:00Z', disposition: 'converted_other_path' }),
      est({ status: 'declined', declined_at: '2026-10-03T15:00:00Z', disposition: 'invalid_lead' }),
    ];
    const out = await computeServiceLines(WIN, { now: NOW });
    expect(pestRow(out.lines).resolved).toBe(0);
    expect(pestRow(out.lines).close_rate).toBeNull();
  });

  it('(a3) open estimates sent over 7 days ago count as aging whatever the period', async () => {
    db.__results.estimates = [
      est({ status: 'sent', sent_at: '2026-09-10T15:00:00Z' }),
      est({ status: 'viewed', sent_at: '2026-09-20T15:00:00Z' }),
      est({ status: 'sent', sent_at: '2026-10-04T15:00:00Z' }),
    ];
    const out = await computeServiceLines(WIN, { now: NOW });
    const pest = pestRow(out.lines);
    expect(pest.aging7).toBe(2);
    expect(pest.sent).toBe(1);
    expect(pest.open).toBe(1);
  });

  it('(b) a multi-line estimate counts once in EACH of its lines', async () => {
    db.__results.estimates = [
      est({ status: 'accepted', accepted_at: '2026-10-02T15:00:00Z', service_interest: 'Pest control and lawn care' }),
    ];
    const out = await computeServiceLines(WIN, { now: NOW });
    for (const row of [pestRow(out.lines), lawnRow(out.lines)]) {
      expect(row.sent).toBe(1);
      expect(row.accepted).toBe(1);
      expect(row.close_rate).toBe(100);
    }
    expect(out.caveats.join(' ')).toMatch(/several service lines counts once in EACH/);
  });

  it('(c) a failing query returns that field as null plus a caveat, never a throw', async () => {
    db.__results.estimates = [est({ status: 'accepted', accepted_at: '2026-10-02T15:00:00Z' })];
    db.__results.leads = new Error('relation "ad_service_attribution" does not exist');
    const out = await computeServiceLines(WIN, { now: NOW });
    const pest = pestRow(out.lines);
    expect(pest.cac).toBeNull();
    expect(pest.accepted).toBe(1);
    expect(pest.ret90).toEqual({ cohort: 0, retained: 0, rate: null });
    expect(out.caveats.some((c) => /Cost per new customer could not be loaded/.test(c))).toBe(true);
  });

  it('computes 90-day retention and cost per new customer from their own queries', async () => {
    db.__results.estimates = [];
    const live = { active: true, deleted_at: null, stage_changed_at: null };
    db.__results.customers = [
      { id: 'c1', pipeline_stage: 'active_customer', churned_at: null, conv: '2026-05-01', ...live },
      { id: 'c2', pipeline_stage: 'churned', churned_at: '2026-06-01', conv: '2026-05-01', ...live }, // left inside 90d
      { id: 'c3', pipeline_stage: 'churned', churned_at: '2026-09-01', conv: '2026-05-01', ...live }, // left after 90d
      // dormant with no churned_at: exit = stage-change date (after day 90 → retained)
      { id: 'c4', pipeline_stage: 'dormant', churned_at: null, conv: '2026-05-01', ...live, stage_changed_at: '2026-09-15' },
      // still "active_customer" by stage but soft-deleted inside 90d → NOT retained
      { id: 'c5', pipeline_stage: 'active_customer', churned_at: null, conv: '2026-05-01', ...live, deleted_at: '2026-06-10' },
      // active=false, no churn, no delete: undatable → dropped from the cohort
      { id: 'c6', pipeline_stage: 'active_customer', churned_at: null, conv: '2026-05-01', ...live, active: false },
    ];
    db.__results.estimatesByCustomer = [
      ...[1, 2, 3, 4, 5, 6].map((n) => ({ customer_id: `c${n}`, estimate_data: {}, service_interest: 'Lawn care', accepted_on: '2026-05-02' })),
      // a pest upsell accepted a year after conversion must NOT put c1 in the pest cohort
      { customer_id: 'c1', estimate_data: {}, service_interest: 'Pest control', accepted_on: '2027-04-01' },
    ];
    db.__results.leads = [
      { id: 'l1', service_interest: 'Lawn care', status: 'won', converted_at: null, customer_id: 'cx1', ad_cost: '30.00' },
      { id: 'l2', service_interest: 'Lawn care', status: 'new', converted_at: null, customer_id: null, ad_cost: '10.00' },
      { id: 'l3', service_interest: 'Lawn care', status: 'new', converted_at: '2026-10-03T00:00:00Z', customer_id: 'cx2', ad_cost: null },
      // second won lead for an existing customer: not a new acquisition
      { id: 'l4', service_interest: 'Lawn care', status: 'won', converted_at: null, customer_id: 'cx1', ad_cost: '5.00' },
      // marked won by hand with no customer: not a new customer
      { id: 'l5', service_interest: 'Lawn care', status: 'won', converted_at: null, customer_id: null, ad_cost: '0' },
      // spam lead that still carried allocated spend: spend stays, lead does not count
      { id: 'l6', service_interest: 'Lawn care', status: 'spam', converted_at: null, customer_id: null, ad_cost: '15.00', is_prospect: false },
      // multi-line interest: lands in BOTH the lawn and pest CAC rows
      { id: 'l7', service_interest: 'Pest control and lawn care', status: 'won', converted_at: null, customer_id: 'cx3', ad_cost: '20.00', is_prospect: true },
    ];
    const out = await computeServiceLines(WIN, { now: NOW });
    const lawn = lawnRow(out.lines);
    expect(lawn.ret90).toEqual({ cohort: 5, retained: 3, rate: 60 });
    const pest = out.lines.find((l) => l.key === 'pest');
    expect(pest.ret90).toEqual({ cohort: 0, retained: 0, rate: null });
    // leads: l1 l2 l3 l4 l5 l7 (l6 is not a prospect); converted: cx1, cx2, cx3;
    // spend: 30+10+0+5+0+15+20 = 80
    expect(lawn.cac).toEqual({ leads: 6, converted: 3, spend: 80, value: 26.67 });
    expect(pest.cac).toEqual({ leads: 1, converted: 1, spend: 20, value: 20 });
  });

  it('anchors sent and aging on the first delivery evidence, not sent_at alone', async () => {
    db.__results.estimates = [
      // accepted while the send claim was in flight: no sent_at, firstDeliveredAt in window
      { id: 'e1', status: 'accepted', sent_at: null, accepted_at: '2026-10-03T15:00:00Z', created_at: '2026-10-03T14:00:00Z',
        estimate_data: { deliveryState: { firstDeliveredAt: '2026-10-03T14:30:00Z' } }, service_interest: 'Lawn care' },
      // open row resent yesterday but first delivered 20 days ago: still aging
      { id: 'e2', status: 'sent', sent_at: '2026-10-04T15:00:00Z', created_at: '2026-09-10T14:00:00Z',
        estimate_data: { deliveryState: { firstDeliveredAt: '2026-09-15T14:00:00Z' } }, service_interest: 'Lawn care' },
    ];
    const out = await computeServiceLines(WIN, { now: NOW });
    const lawn = lawnRow(out.lines);
    expect(lawn.sent).toBe(1);
    expect(lawn.accepted).toBe(1);
    expect(lawn.aging7).toBe(1);
  });

  it('uses the plain period for close rate and the floored window only for cost per customer', async () => {
    db.__results.estimates = [];
    const adWin = { from: '2026-09-15', to: WIN.to, label: 'floored' };
    const out = await computeServiceLines(WIN, { now: NOW, adWin });
    expect(out.period).toEqual(WIN);
    expect(out.adPeriod).toEqual(adWin);
    expect(out.caveats.some((c) => c.includes('2026-09-15') && /attribution baseline/.test(c))).toBe(true);
  });
});
