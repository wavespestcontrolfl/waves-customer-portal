'use strict';

/**
 * buildCancellationImpact — the "visits pulled" facts must count exactly what
 * the processor's sweep will cancel (C3 dialog renders them as "what pressing
 * the button will do"):
 *   - keep-through boundary (end-of-coverage): dated visits on or before it
 *     are KEPT, not pulled
 *   - live/done track rows (en_route / on_property / complete) are excluded
 *     by the processor's null-safe sweep predicate, so they are never
 *     counted as pulled either (codex C3 r2 P2)
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/cancellation-eligibility', () => ({
  CANCELLABLE_STATUSES: ['pending', 'confirmed', 'rescheduled'],
  LIVE_TRACK_STATES: ['en_route', 'on_property'],
}));
jest.mock('../services/cancellation-processor', () => ({
  planScopedWindDown: jest.fn(),
  familyOfServiceRow: (r) => r.family || null,
}));
jest.mock('../services/self-booking-plan-sync', () => ({ inferTierFromServiceCount: () => null }));
jest.mock('../services/plan-rate-ledger', () => ({ loadComponents: jest.fn(async () => []) }));
jest.mock('../services/open-balance', () => ({ openBalanceSummary: jest.fn(async () => ({ total: 0 })) }));
jest.mock('../services/annual-prepay-renewals', () => ({
  ANNUAL_PREPAY_PREPAID_METHOD: 'annual_prepay_invoice',
  coveredTermsAsOf: jest.fn(() => ({
    where: jest.fn(function where() { return this; }),
    first: jest.fn(async () => null),
  })),
}));
jest.mock('../services/cancellation-resolution/templates', () => ({ familyLabel: (k) => k }));

let mockRows = [];
jest.mock('../models/db', () => jest.fn((table) => {
  const b = {};
  b.where = jest.fn(() => b);
  b.leftJoin = jest.fn(() => b);
  b.first = jest.fn(async () => (String(table).startsWith('customers')
    ? {
      waveguard_tier: 'Silver', monthly_rate: '100.00', billing_mode: 'monthly_membership',
      per_application_fee: null, autopay_enabled: false, next_charge_date: null, termite_stations_rented: false,
    }
    : null));
  b.select = jest.fn(async () => mockRows);
  return b;
}));

const { buildCancellationImpact } = require('../services/cancellation-resolution/impact');

beforeEach(() => { mockRows = []; });

test('live and complete track rows count as upcoming but are never "pulled"', async () => {
  mockRows = [
    { family: 'pest_control', status: 'confirmed', scheduled_date: '2099-01-05', track_state: 'en_route' },
    { family: 'pest_control', status: 'confirmed', scheduled_date: '2099-01-08', track_state: 'on_property' },
    { family: 'pest_control', status: 'confirmed', scheduled_date: '2099-01-20', track_state: 'complete' },
    { family: 'pest_control', status: 'pending', scheduled_date: '2099-02-01', track_state: 'scheduled' },
    { family: 'pest_control', status: 'pending', scheduled_date: '2099-03-01', track_state: null },
  ];
  const impact = await buildCancellationImpact('cust-1', []);
  expect(impact.families[0].upcomingVisits).toBe(5);
  // Only the sweep-cancellable rows: the processor excludes live/done track
  // states and parks them for manual review.
  expect(impact.visitsCancelled).toBe(2);
  expect(impact.nextVisitCancelled).toBe('2099-02-01');
});

test('keep-through boundary keeps COVERED dated visits on or before it out of the pulled count; uncovered rows pull now', async () => {
  mockRows = [
    // Covered, inside the boundary — KEPT.
    { id: 'v1', family: 'pest_control', status: 'confirmed', scheduled_date: '2099-01-05', track_state: 'scheduled', prepaid_method: 'annual_prepay_invoice' },
    { id: 'v2', family: 'pest_control', status: 'pending', scheduled_date: '2099-02-15', track_state: null, annual_prepay_term_id: 'term-1' },
    // Covered but past the boundary — pulled.
    { id: 'v3', family: 'pest_control', status: 'pending', scheduled_date: '2099-03-01', track_state: null, prepaid_method: 'annual_prepay_invoice' },
    // Mixed account: an UNCOVERED row inside the boundary is pulled now
    // (billing stops immediately; no free work).
    { id: 'v4', family: 'lawn_care', status: 'confirmed', scheduled_date: '2099-01-20', track_state: null },
    // Undated/rescheduled rows have no date to keep them — always pulled.
    { id: 'v5', family: 'pest_control', status: 'rescheduled', scheduled_date: '2001-01-01', track_state: null },
  ];
  // Coverage = the LIVE term's canonical covered-row set (keepVisitIds),
  // not the row's stamp/term-id — a dead refunded term keeps its audit link.
  const impact = await buildCancellationImpact('cust-1', [], { after: '2099-02-15', keepVisitIds: ['v1', 'v2', 'v3'] });
  expect(impact.visitsCancelled).toBe(3);
  expect(impact.nextVisitCancelled).toBe('2001-01-01');
  // Stable identities for the approved-facts fingerprint, sorted.
  expect(impact.pulledVisitKeys).toEqual(['v3:2099-03-01', 'v4:2099-01-20', 'v5:2001-01-01'].sort());
});
