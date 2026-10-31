/**
 * The invoice / pay page / PDF schedule of a lawn_rounds_9 term lists the dates
 * the payment-time seeder will write: when the covered series' parent stores a
 * recurring_round_anchor_date, the dates are placed from it (the same shared
 * resolver, seriesRoundAnchorForTerm). Display only: a failed read keeps the
 * plain round walk and never breaks the invoice load. Other cadences make no
 * extra read.
 */
jest.mock('../models/db', () => {
  const dbFn = jest.fn(() => {
    const q = { columnInfo: async () => ({ recurring_round_anchor_date: {}, scheduled_date: {} }) };
    return q;
  });
  return dbFn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/sms-template-renderer', () => ({ renderSmsTemplate: jest.fn() }));
jest.mock('../services/account-membership-email', () => ({ sendMembershipRenewalReminder: jest.fn() }));

const { loadInvoiceAnnualPrepay } = require('../services/invoice-prepay');
const renewals = require('../services/annual-prepay-renewals');
const { lawnRoundDate, lawnRoundDateFrom } = require('../services/lawn-rounds');

const STORED_ANCHOR = '2026-01-13'; // the series' round anchor (a Tuesday)
const TERM_START = '2026-08-11'; // Codex's example: the term starts after the anchor
const NINE = (fn) => Array.from({ length: 9 }, (_, i) => fn(i));

function setup({ cadence = 'lawn_rounds_9', parent = { id: 'svc-old', recurring_round_anchor_date: STORED_ANCHOR } } = {}) {
  const reads = [];
  const child = (table) => {
    reads.push(table);
    const query = {
      where: () => query,
      columnInfo: async () => ({ coverage_service_type: {}, coverage_visit_count: {}, coverage_cadence: {} }),
      first: async () => {
        if (table === 'scheduled_services') {
          if (parent instanceof Error) throw parent;
          return parent;
        }
        return {
          id: 'term-1', customer_id: 'customer-r', status: 'payment_pending', plan_label: 'Lawn Annual',
          monthly_rate: 75, prepay_amount: 855, term_start: TERM_START, term_end: '2027-08-10',
          coverage_service_type: 'Lawn Care', coverage_visit_count: 9, coverage_cadence: cadence,
        };
      },
    };
    return query;
  };
  child.schema = { hasTable: jest.fn(async () => true) };
  const rowsSpy = jest.spyOn(renewals, 'coverageRowsForTerm')
    .mockResolvedValue([{ id: 'svc-child', recurring_parent_id: 'svc-old', scheduled_date: TERM_START }]);
  return { child, reads, rowsSpy };
}

const load = (child) => loadInvoiceAnnualPrepay({ id: 'inv-1', customer_id: 'customer-r', annual_prepay_term_id: 'term-1', line_items: [] }, child);

beforeEach(() => {
  jest.useFakeTimers({ now: new Date('2026-08-01T16:00:00Z') });
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('invoice-prepay — lawn_rounds_9 schedule', () => {
  test('a stored series anchor places the listed dates exactly as the seeder does (Sep 8, not Sep 22)', async () => {
    const { child, rowsSpy } = setup();
    const result = await load(child);
    const seeded = NINE((i) => lawnRoundDateFrom(STORED_ANCHOR, TERM_START, i));
    expect(result.coverageVisits.map((v) => v.date)).toEqual(seeded);
    expect(seeded[1]).toBe('2026-09-08');
    expect(lawnRoundDate(TERM_START, 1)).toBe('2026-09-22');
    expect(rowsSpy).toHaveBeenCalledWith(expect.objectContaining({ customer_id: 'customer-r', term_start: TERM_START, term_end: '2027-08-10' }), expect.anything());
  });

  test('no explicit anchor: the series parent cadence position places the dates (Sep 8), as the series extends', async () => {
    const { child } = setup({ parent: { id: 'svc-old', scheduled_date: STORED_ANCHOR, recurring_round_anchor_date: null } });
    const result = await load(child);
    expect(result.coverageVisits.map((v) => v.date)).toEqual(NINE((i) => lawnRoundDateFrom(STORED_ANCHOR, TERM_START, i)));
    expect(result.coverageVisits[1].date).toBe('2026-09-08');
  });

  test('no parent found: the plain round walk from the term anchor, as before', async () => {
    const { child } = setup({ parent: null });
    const result = await load(child);
    expect(result.coverageVisits.map((v) => v.date)).toEqual(NINE((i) => lawnRoundDate(TERM_START, i)));
  });

  test('a failed read keeps the plain dates and the invoice still loads', async () => {
    const { child } = setup({ parent: new Error('db down') });
    const result = await load(child);
    expect(result.coverageVisits.map((v) => v.date)).toEqual(NINE((i) => lawnRoundDate(TERM_START, i)));
    expect(result.coverageVisitCount).toBe(9);
  });

  test('a failed coverage-rows read keeps the plain dates', async () => {
    const { child, rowsSpy } = setup();
    rowsSpy.mockRejectedValue(new Error('rows down'));
    const result = await load(child);
    expect(result.coverageVisits.map((v) => v.date)).toEqual(NINE((i) => lawnRoundDate(TERM_START, i)));
  });

  test('a non-rounds term makes no extra read', async () => {
    const { child, reads, rowsSpy } = setup({ cadence: 'every_6_weeks' });
    const result = await load(child);
    expect(rowsSpy).not.toHaveBeenCalled();
    expect(reads).not.toContain('scheduled_services');
    expect(result.coverageVisits[1].date).toBe('2026-09-22');
  });
});
