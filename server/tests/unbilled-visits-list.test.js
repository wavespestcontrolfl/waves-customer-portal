// Unbilled visits (owner 2026-10-25, Air Jobs Plan step 3): the one standing
// Billing bell built from the Billing recovery page's own list (copy passes the
// admin notification rule), when a refresh rings, and the close at zero. The
// list itself is the page's: routes/admin-billing-recovery.js listUninvoicedLeaks.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({
  unbilledVisitsListLive: jest.fn(() => true),
  alertEpisodesLive: jest.fn(() => true),
}));
jest.mock('../services/admin-alert-episodes', () => ({
  raiseAdminAlertWithReopen: jest.fn(async () => ({ id: 'n1', deduped: false, rang: true })),
  closeAdminAlertKeys: jest.fn(async () => 0),
}));
jest.mock('../services/notification-service', () => ({
  notifyAdmin: jest.fn(async () => ({ id: 'n2', deduped: false })),
}));
jest.mock('../routes/admin-billing-recovery', () => ({ listUninvoicedLeaks: jest.fn() }));

const gates = require('../config/feature-gates');
const episodes = require('../services/admin-alert-episodes');
const NotificationService = require('../services/notification-service');
const BillingRecovery = require('../routes/admin-billing-recovery');
const { composeAdminAlert } = require('../services/admin-alert-compose');
const Unbilled = require('../services/unbilled-visits-list');

const { listItems, composeList, ringOnNewVisit, nextStepWords, WINDOW_DAYS } = Unbilled._private;

// One row of the page's list, in the shape GET /api/admin/billing-recovery/leaks returns.
const visit = (over = {}) => ({
  scheduled_service_id: over.scheduled_service_id || 'ss-1',
  service_record_id: 'sr-1',
  customer_id: 'cust-1',
  customer: 'Pat Synthetic',
  service_type: 'Quarterly Pest Control Service',
  price: 97,
  prepaid: 0,
  completed_at: '2026-10-20T15:00:00.000Z',
  monthly_rate: 0,
  billing_mode: null,
  billable: true,
  leak_kind: 'uninvoiced',
  voided_invoice_number: null,
  billed_elsewhere_invoice_number: null,
  billed_elsewhere_invoice_status: null,
  ...over,
});
const pageList = ({ leaks = [], needsReview = [] } = {}) => ({ window_days: WINDOW_DAYS, summary: {}, leaks, needs_review: needsReview });

beforeEach(() => {
  jest.clearAllMocks();
  gates.unbilledVisitsListLive.mockReturnValue(true);
  gates.alertEpisodesLive.mockReturnValue(true);
});

describe('the list', () => {
  test('both page lists, oldest first; a row with no visit id or no completion time is left out', () => {
    const items = listItems(pageList({
      leaks: [
        visit({ scheduled_service_id: 'b', completed_at: '2026-10-22T15:00:00Z' }),
        visit({ scheduled_service_id: null }),
        visit({ scheduled_service_id: 'x', completed_at: 'not a date' }),
      ],
      needsReview: [visit({ scheduled_service_id: 'a', completed_at: '2026-10-02T15:00:00Z', monthly_rate: 45 })],
    }));
    expect(items.map((i) => [i.visitId, i.review])).toEqual([['a', true], ['b', false]]);
    expect(listItems(null)).toEqual([]);
  });

  test('the next step says what the office does with each visit', () => {
    const [plain, review, noRecord, voided, elsewhere] = listItems(pageList({
      leaks: [
        visit({ scheduled_service_id: 'a', completed_at: '2026-10-01T15:00:00Z' }),
        visit({ scheduled_service_id: 'c', completed_at: '2026-10-03T15:00:00Z', billable: false }),
        visit({ scheduled_service_id: 'd', completed_at: '2026-10-04T15:00:00Z', voided_invoice_number: 'WPC-TEST-0001' }),
        visit({ scheduled_service_id: 'e', completed_at: '2026-10-05T15:00:00Z', billed_elsewhere_invoice_number: 'WPC-TEST-0002' }),
      ],
      needsReview: [visit({ scheduled_service_id: 'b', completed_at: '2026-10-02T15:00:00Z' })],
    }));
    expect(nextStepWords(plain)).toBe('bill or mark free');
    expect(nextStepWords(review)).toBe('check, then bill or mark free');
    expect(nextStepWords(noRecord)).toBe('finish its completion first');
    expect(nextStepWords(voided)).toBe('bill or mark free; invoice WPC-TEST-0001 was voided');
    expect(nextStepWords(elsewhere)).toBe('bill or mark free; it was marked billed on WPC-TEST-0002, which is no longer live');
  });

  test('several visits: one rule-clean Billing bell that opens Billing recovery, the list in the detail', () => {
    const composed = composeList(listItems(pageList({
      leaks: [visit({ scheduled_service_id: 'b', price: 196, completed_at: '2026-10-21T15:00:00Z', customer: 'Lee Example', service_type: 'Lawn Care Service' })],
      needsReview: [visit({ scheduled_service_id: 'a', price: 97, completed_at: '2026-10-02T15:00:00Z', monthly_rate: 45 })],
    })));
    const alert = composeAdminAlert(composed.spec);
    expect(alert.headline).toBe('Billing — bill or mark free 2 unbilled visits');
    expect(alert.why).toBe('2 visits have no invoice, $293 in all; the oldest was done Oct 2.');
    expect(alert.link).toBe('/admin/billing-recovery');
    expect(alert.metadata).toMatchObject({ area: 'Billing', severity: 'needs-you', who: 'person', doneWhen: 'count_zero', subject: { type: 'check', id: Unbilled.DEDUPE_KEY } });
    expect(composed.itemKeys).toEqual(['a', 'b']);
    expect(composed.total).toBe(293);
    expect(composed.detail.split('\n')).toEqual([
      '2 visits done in the last 30 days have no invoice, $293.00 in all. 1 needs a check first (a monthly plan, a prepay, a per-application customer or an inspection or rodent visit). This check billed nothing and sent nothing.',
      'Oldest first:',
      'Pat Synthetic · Quarterly Pest Control Service · done Oct 2 · $97.00 · check, then bill or mark free',
      'Lee Example · Lawn Care Service · done Oct 21 · $196.00 · bill or mark free',
      'Open Billing recovery to bill each visit or mark it free.',
    ]);
  });

  test('one visit: the headline and the why name the customer', () => {
    const alert = composeAdminAlert(composeList(listItems(pageList({ leaks: [visit({ completed_at: '2026-10-23T15:00:00Z' })] }))).spec);
    expect(alert.headline).toBe("Billing — bill or mark free Pat Synthetic's visit");
    expect(alert.why).toBe("Pat Synthetic's Quarterly Pest Control Service on Oct 23 has no invoice; $97.00 is not billed.");
  });

  test('one visit whose name or service the rule cannot carry: the why drops them, the headline shortens the name', () => {
    for (const over of [
      { customer: 'Bartholomew-Maximilian Alexander Synthetic-Featherstonehaugh', service_type: 'Quarterly Pest Control Service With Interior' },
      { service_type: '[Legacy] Pest Control' },
    ]) {
      const composed = composeList(listItems(pageList({ leaks: [visit({ ...over, completed_at: '2026-10-23T15:00:00Z' })] })));
      const alert = composeAdminAlert(composed.spec);
      expect(alert.why).toBe('One visit done Oct 23 has no invoice; $97.00 is not billed.');
      expect(alert.headline.length).toBeLessThanOrEqual(60);
    }
  });

  test('one visit whose name the headline rule refuses: the headline counts instead, and the bell is still written', () => {
    for (const customer of ['Pat Synthetic [VIP]', 'Pat Synthetic!', 'Pat Synthetic \u{1F41C}']) {
      const composed = composeList(listItems(pageList({ leaks: [visit({ customer, completed_at: '2026-10-23T15:00:00Z' })] })));
      const alert = composeAdminAlert(composed.spec);
      expect(alert.headline).toBe('Billing — bill or mark free 1 unbilled visit');
      expect(alert.why).toBe('One visit done Oct 23 has no invoice; $97.00 is not billed.');
    }
  });

  test('a long list stays rule-clean and the detail names how many more there are', () => {
    const leaks = Array.from({ length: 30 }, (_, i) => visit({ scheduled_service_id: `id-${String(i).padStart(2, '0')}`, price: 12345.67, completed_at: new Date(Date.UTC(2026, 9, 1, 15) + i * 3600 * 1000).toISOString() }));
    const composed = composeList(listItems(pageList({ leaks })));
    expect(() => composeAdminAlert(composed.spec)).not.toThrow();
    const lines = composed.detail.split('\n');
    expect(lines).toHaveLength(2 + 25 + 1 + 1);
    expect(lines[lines.length - 2]).toBe('…and 5 more.');
    expect(composed.itemKeys).toHaveLength(30);
  });
});

describe('ringing', () => {
  test('a refresh rings only when a visit joins the list', () => {
    expect(ringOnNewVisit(['a', 'b'])({}, { itemKeys: ['a', 'b'] })).toBe(false);
    expect(ringOnNewVisit(['a'])({}, { itemKeys: ['a', 'b'] })).toBe(false);
    expect(ringOnNewVisit(['a', 'c'])({}, { itemKeys: ['a', 'b'] })).toBe(true);
    expect(ringOnNewVisit(['a'])({}, {})).toBe(true);
  });
});

describe('runUnbilledVisitsList', () => {
  const database = jest.fn();

  test('gate off: no read, no bell', async () => {
    gates.unbilledVisitsListLive.mockReturnValue(false);
    const loadList = jest.fn();
    await expect(Unbilled.runUnbilledVisitsList({ database, loadList })).resolves.toEqual({ skipped: 'disabled' });
    expect(loadList).not.toHaveBeenCalled();
    expect(episodes.raiseAdminAlertWithReopen).not.toHaveBeenCalled();
    expect(episodes.closeAdminAlertKeys).not.toHaveBeenCalled();
  });

  test('the default list is the Billing recovery page\'s own, over the last 30 days', async () => {
    BillingRecovery.listUninvoicedLeaks.mockResolvedValueOnce(pageList());
    await Unbilled.runUnbilledVisitsList({ database });
    expect(BillingRecovery.listUninvoicedLeaks).toHaveBeenCalledWith(30);
  });

  test('a list raises one standing billing row that asks to ring and rings again only for a new visit', async () => {
    const loadList = jest.fn(async () => pageList({ leaks: [visit({ scheduled_service_id: 'a' })] }));
    const out = await Unbilled.runUnbilledVisitsList({ database, loadList });
    expect(out).toEqual({ count: 1, total: 97, outcome: 'raised' });
    expect(loadList).toHaveBeenCalledWith(30);
    expect(episodes.raiseAdminAlertWithReopen).toHaveBeenCalledTimes(1);
    const [category, headline, why, opts] = episodes.raiseAdminAlertWithReopen.mock.calls[0];
    expect(category).toBe('billing');
    expect(headline).toBe("Billing — bill or mark free Pat Synthetic's visit");
    expect(why).toMatch(/^Pat Synthetic's Quarterly Pest Control Service on Oct 20 has no invoice/);
    expect(opts).toMatchObject({
      dedupeKey: 'unbilled-visits', bellDefault: true, refreshOnDedupe: true, bumpOnRefresh: true, link: '/admin/billing-recovery',
      metadata: { itemKeys: ['a'], count: 1, totalUnbilled: 97, area: 'Billing', severity: 'needs-you', doneWhen: 'count_zero' },
    });
    expect(opts.detail).toMatch(/^1 visit done in the last 30 days has no invoice, \$97\.00 in all\. This check billed nothing and sent nothing\./);
    expect(opts.ringOnRefresh({}, { itemKeys: ['a'] })).toBe(false);
    expect(episodes.closeAdminAlertKeys).not.toHaveBeenCalled();
  });

  test('a quiet refresh, an unchanged list and a silenced bell are reported as such', async () => {
    const loadList = async () => pageList({ leaks: [visit()] });
    episodes.raiseAdminAlertWithReopen.mockResolvedValueOnce({ id: 'n1', deduped: true, refreshed: true, rung: false });
    await expect(Unbilled.runUnbilledVisitsList({ database, loadList })).resolves.toMatchObject({ outcome: 'refreshed' });
    episodes.raiseAdminAlertWithReopen.mockResolvedValueOnce({ id: 'n1', deduped: true });
    await expect(Unbilled.runUnbilledVisitsList({ database, loadList })).resolves.toMatchObject({ outcome: 'unchanged' });
    // The owner silenced billing bells: the bell policy wrote nothing, and the run says so.
    episodes.raiseAdminAlertWithReopen.mockResolvedValueOnce({ id: null, suppressed: true, deduped: false });
    await expect(Unbilled.runUnbilledVisitsList({ database, loadList })).resolves.toMatchObject({ outcome: 'suppressed' });
  });

  test('an empty list closes the standing row as done', async () => {
    episodes.closeAdminAlertKeys.mockResolvedValueOnce(1);
    await expect(Unbilled.runUnbilledVisitsList({ database, loadList: async () => pageList() })).resolves.toEqual({ count: 0, outcome: 'closed' });
    expect(episodes.closeAdminAlertKeys).toHaveBeenCalledWith(database, ['unbilled-visits'], 'count_zero', {
      resolution: 'No visit from the last 30 days is waiting to be billed',
    });
    expect(episodes.raiseAdminAlertWithReopen).not.toHaveBeenCalled();
    await expect(Unbilled.runUnbilledVisitsList({ database, loadList: async () => pageList() })).resolves.toEqual({ count: 0, outcome: 'clear' });
  });

  test('a failed read throws and never closes the row', async () => {
    const loadList = async () => { throw new Error('connection reset'); };
    await expect(Unbilled.runUnbilledVisitsList({ database, loadList })).rejects.toThrow('connection reset');
    expect(episodes.closeAdminAlertKeys).not.toHaveBeenCalled();
  });

  test('a bell that was not written throws so the run reads as failed', async () => {
    episodes.raiseAdminAlertWithReopen.mockResolvedValueOnce(null);
    await expect(Unbilled.runUnbilledVisitsList({ database, loadList: async () => pageList({ leaks: [visit()] }) })).rejects.toThrow('unbilled visits bell was not written');
  });

  test('with alert episodes killed it raises through the plain rule-checked path and never closes', async () => {
    gates.alertEpisodesLive.mockReturnValue(false);
    await Unbilled.runUnbilledVisitsList({ database, loadList: async () => pageList({ leaks: [visit()] }) });
    expect(episodes.raiseAdminAlertWithReopen).not.toHaveBeenCalled();
    expect(NotificationService.notifyAdmin).toHaveBeenCalledWith('billing', "Billing — bill or mark free Pat Synthetic's visit", expect.any(String), expect.objectContaining({
      dedupeKey: 'unbilled-visits', bellDefault: true, refreshOnDedupe: true,
    }));
    await Unbilled.runUnbilledVisitsList({ database, loadList: async () => pageList() });
    expect(episodes.closeAdminAlertKeys).not.toHaveBeenCalled();
  });
});
