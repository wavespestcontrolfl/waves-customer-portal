// Emailed invoices not linked to Spark (owner 2026-11-05): the vendor list, the one
// standing bell built from it (copy passes the admin notification rule), when a
// refresh rings, and the close at zero. The DB read is a thin query; the list logic
// is pure and tested on rows in the shape that query returns.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({
  invoiceNotOnSparkLive: jest.fn(() => true),
  alertEpisodesLive: jest.fn(() => true),
}));
jest.mock('../services/admin-alert-episodes', () => ({
  raiseAdminAlertWithReopen: jest.fn(async () => ({ id: 'n1', deduped: false, rang: true })),
  closeAdminAlertKeys: jest.fn(async () => 0),
}));
jest.mock('../services/notification-service', () => ({
  notifyAdmin: jest.fn(async () => ({ id: 'n2', deduped: false })),
}));

const gates = require('../config/feature-gates');
const logger = require('../services/logger');
const episodes = require('../services/admin-alert-episodes');
const NotificationService = require('../services/notification-service');
const { composeAdminAlert } = require('../services/admin-alert-compose');
const Spark = require('../services/invoice-not-on-spark');

const { parseOkLabels, windowFor, buildVendorList, composeList, whyFor, ringOnNewVendor, accountWords } = Spark._private;

const OK = new Set(['capital-one-card-6646', 'capital-one-checking-3965']);
const WIN = { from: '2026-10-22', to: '2026-11-02' };
let n = 0;
const row = (over = {}) => {
  n += 1;
  return { expense_id: `e${n}`, vendor_name: 'Acme Supply', amount: '42.10', expense_date: '2026-10-30', account_label: null, ...over };
};
const list = (rows, win = WIN) => buildVendorList(rows, { okLabels: OK, ...win });

beforeEach(() => {
  jest.clearAllMocks();
  gates.invoiceNotOnSparkLive.mockReturnValue(true);
  gates.alertEpisodesLive.mockReturnValue(true);
});

describe('settings', () => {
  test('the account list is the env list, trimmed; unset or empty is empty', () => {
    expect([...parseOkLabels(' a-1 , b-2,,')]).toEqual(['a-1', 'b-2']);
    expect(parseOkLabels('').size).toBe(0);
    expect(parseOkLabels(undefined).size).toBe(0);
  });

  test('the last four digits of the account label', () => {
    expect(accountWords('capital-one-card-8804')).toBe('••8804');
    expect(accountWords('amex')).toBe('another account');
  });
});

describe('the window (ET calendar days)', () => {
  test('3 days of grace, 14 days back', () => {
    expect(windowFor(new Date('2026-11-05T15:00:00Z'))).toEqual({ from: '2026-10-22', to: '2026-11-02' });
  });

  test('just after ET midnight and just before it, the ET day decides, not the UTC day', () => {
    // 00:30 EDT on Nov 1, before the 2:00 AM fall-back
    expect(windowFor(new Date('2026-11-01T04:30:00Z'))).toEqual({ from: '2026-10-18', to: '2026-10-29' });
    // 23:30 EST on Nov 1 is already Nov 2 in UTC
    expect(windowFor(new Date('2026-11-02T04:30:00Z'))).toEqual({ from: '2026-10-18', to: '2026-10-29' });
    // 00:30 EST on Nov 2, the next ET day
    expect(windowFor(new Date('2026-11-02T05:30:00Z'))).toEqual({ from: '2026-10-19', to: '2026-10-30' });
  });

  test('the first and last day are in, the day outside each edge is out', () => {
    const out = list([
      row({ expense_date: '2026-10-21' }), row({ expense_date: '2026-10-22' }),
      row({ expense_date: '2026-11-02' }), row({ expense_date: '2026-11-03' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].count).toBe(2);
  });
});

describe('the vendor list', () => {
  test('no linked line is no_charge, a line on another account is other_account, an OK account drops out', () => {
    const out = list([
      row({ vendor_name: 'No Charge Co' }),
      row({ vendor_name: 'Old Card Co', account_label: 'capital-one-card-8804' }),
      row({ vendor_name: 'Spark Co', account_label: 'capital-one-card-6646' }),
      row({ vendor_name: 'Debit Co', account_label: 'capital-one-checking-3965' }),
    ]);
    expect(out.map((v) => [v.name, v.kinds])).toEqual([
      ['No Charge Co', ['no_charge']], ['Old Card Co', ['other_account']],
    ].sort((a, b) => a[0].localeCompare(b[0])));
  });

  test('no link but an unmatched same-amount charge on Spark or the debit stays listed, worded as waiting for review', () => {
    const out = list([
      row({ vendor_name: 'Parked Co', ok_candidate: true }),
      row({ vendor_name: 'Missing Co', ok_candidate: false }),
      // a linked line on another account is still other_account, whatever the candidate flag says
      row({ vendor_name: 'Old Card Co', account_label: 'capital-one-card-8804', ok_candidate: true }),
    ]);
    expect(out.map((v) => [v.name, v.kinds])).toEqual([
      ['Missing Co', ['no_charge']], ['Old Card Co', ['other_account']], ['Parked Co', ['awaiting_review']],
    ]);
    expect(whyFor(out.filter((v) => v.name === 'Parked Co'))).toBe(
      'Parked Co: 1 invoice ($42.10) a same-amount Spark or debit charge waits for review',
    );
  });

  test('one unmatched charge never hides invoices: two same-amount invoices from different vendors both stay listed', () => {
    const out = list([
      row({ vendor_name: 'Vendor One', amount: '100.00', ok_candidate: true }),
      row({ vendor_name: 'Vendor Two', amount: '100.00', ok_candidate: true }),
    ]);
    expect(out.map((v) => [v.name, v.count, v.kinds])).toEqual([
      ['Vendor One', 1, ['awaiting_review']], ['Vendor Two', 1, ['awaiting_review']],
    ]);
  });

  test('amount zero or less and missing ids are left out', () => {
    expect(list([row({ amount: '0' }), row({ amount: '-5.00' }), row({ amount: null }), row({ expense_id: null })])).toEqual([]);
  });

  test('one vendor in different spellings is one entry; counts, total, accounts and newest date add up', () => {
    const [v] = list([
      row({ vendor_name: 'Acme Supply', amount: '10.10', expense_date: '2026-10-25', account_label: 'capital-one-checking-3098' }),
      row({ vendor_name: '  ACME   supply ', amount: '20.20', expense_date: '2026-10-28', account_label: 'capital-one-checking-3098' }),
      row({ vendor_name: 'acme supply', amount: '5.05', expense_date: '2026-10-26' }),
    ]);
    expect(v).toMatchObject({ key: 'acme supply', name: 'ACME supply', count: 3, noCharge: 1, accounts: ['••3098'], newest: '2026-10-28' });
    expect(v.total).toBeCloseTo(35.35, 2);
    expect(v.kinds).toEqual(['no_charge', 'other_account']);
  });

  test('a missing vendor name becomes Unknown vendor', () => {
    expect(list([row({ vendor_name: null }), row({ vendor_name: '  ' })])).toMatchObject([{ name: 'Unknown vendor', count: 2 }]);
  });

  test('the same expense twice (two emails for one expense) counts once', () => {
    const dup = row();
    expect(list([dup, { ...dup }])[0].count).toBe(1);
  });

  test('biggest total first', () => {
    const out = list([row({ vendor_name: 'Small Co', amount: '5' }), row({ vendor_name: 'Big Co', amount: '500' })]);
    expect(out.map((v) => v.name)).toEqual(['Big Co', 'Small Co']);
  });
});

describe('the bell', () => {
  const three = () => list([
    ...Array.from({ length: 22 }, () => row({ vendor_name: 'Anthropic', amount: '10', account_label: 'capital-one-checking-3098' })),
    row({ vendor_name: 'OpenMeteo', amount: '313' }),
    row({ vendor_name: 'Acme Supply', amount: '42.10', account_label: 'capital-one-card-8804' }),
  ]);

  test('three vendors: a rule-clean Tax-page bell with plain words', () => {
    const composed = composeList(three());
    const alert = composeAdminAlert(composed.spec);
    expect(alert.headline).toBe("Billing — check 3 vendors' invoices not linked to Spark");
    expect(alert.why).toBe('OpenMeteo: 1 invoice ($313) no card charge found; Anthropic: 22 invoices ($220) paid from ••3098; and 1 more');
    expect(alert.link).toBe('/admin/tax?tab=expenses');
    expect(alert.metadata).toMatchObject({ area: 'Billing', severity: 'needs-you', who: 'person', doneWhen: 'count_zero', subject: { type: 'check', id: Spark.DEDUPE_KEY } });
    expect(composed.itemKeys).toEqual(['acme supply', 'anthropic', 'openmeteo']);
    expect(composed.invoices).toBe(24);
    expect(composed.total).toBe(575.1);
    const lines = composed.detail.split('\n');
    expect(lines[0]).toMatch(/^24 emailed vendor invoices, \$575\.10 in all, dated 3 to 14 days ago were not paid/);
    expect(lines).toContain('Anthropic · 22 invoices · $220 · paid from ••3098 · newest Oct 30');
  });

  test('one vendor reads in the singular', () => {
    const alert = composeAdminAlert(composeList(list([row()])).spec);
    expect(alert.headline).toBe("Billing — check one vendor's invoices not linked to Spark");
    expect(alert.why).toBe('Acme Supply: 1 invoice ($42.10) no card charge found');
  });

  test('a vendor name the rule cannot carry falls back to counts', () => {
    const vendors = list([row({ vendor_name: 'Acme [Legacy] Co', amount: '12' }), row({ vendor_name: 'Acme [Legacy] Co', amount: '8' })]);
    expect(whyFor(vendors)).toBe('2 invoices worth $20 from 1 vendor were not linked to Spark');
    expect(() => composeAdminAlert(composeList(vendors).spec)).not.toThrow();
    const long = list([row({ vendor_name: `${'Very Long Vendor Name '.repeat(6)}`, amount: '12' })]);
    expect(whyFor(long)).toBe('1 invoice worth $12 from 1 vendor were not linked to Spark');
  });

  test('a long list stays rule-clean and the detail names how many more there are', () => {
    const vendors = list(Array.from({ length: 30 }, (_, i) => row({ vendor_name: `Vendor ${String(i).padStart(2, '0')}`, amount: '9.99' })));
    const composed = composeList(vendors);
    expect(() => composeAdminAlert(composed.spec)).not.toThrow();
    const lines = composed.detail.split('\n');
    expect(lines).toHaveLength(2 + 25 + 1 + 1);
    expect(lines[lines.length - 2]).toBe('…and 5 more.');
    expect(composed.itemKeys).toHaveLength(30);
  });

  test('a refresh rings only when a vendor joins the list', () => {
    expect(ringOnNewVendor(['a', 'b'])({}, { itemKeys: ['a', 'b'] })).toBe(false);
    expect(ringOnNewVendor(['a'])({}, { itemKeys: ['a', 'b'] })).toBe(false);
    expect(ringOnNewVendor(['a', 'c'])({}, { itemKeys: ['a', 'b'] })).toBe(true);
    expect(ringOnNewVendor(['a'])({}, {})).toBe(true);
  });
});

describe('runInvoiceNotOnSpark', () => {
  const database = jest.fn();
  const now = new Date('2026-11-05T15:00:00Z');
  const base = { database, now, okLabels: OK };

  test('gate off: no read, no bell', async () => {
    gates.invoiceNotOnSparkLive.mockReturnValue(false);
    await expect(Spark.runInvoiceNotOnSpark({ ...base })).resolves.toEqual({ skipped: 'disabled' });
    expect(database).not.toHaveBeenCalled();
    expect(episodes.raiseAdminAlertWithReopen).not.toHaveBeenCalled();
    expect(episodes.closeAdminAlertKeys).not.toHaveBeenCalled();
  });

  test('no account list: one log line, no read, no bell, no close', async () => {
    await expect(Spark.runInvoiceNotOnSpark({ ...base, okLabels: new Set() })).resolves.toEqual({ skipped: 'no_ok_accounts' });
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(database).not.toHaveBeenCalled();
    expect(episodes.raiseAdminAlertWithReopen).not.toHaveBeenCalled();
    expect(episodes.closeAdminAlertKeys).not.toHaveBeenCalled();
  });

  test('a list raises one standing tax row that asks to ring and rings again only for a new vendor', async () => {
    const rows = [row({ expense_date: '2026-10-30' })];
    const out = await Spark.runInvoiceNotOnSpark({ ...base, rows });
    expect(out).toEqual({ count: 1, invoices: 1, total: 42.1, outcome: 'raised' });
    expect(episodes.raiseAdminAlertWithReopen).toHaveBeenCalledTimes(1);
    const [category, headline, why, opts] = episodes.raiseAdminAlertWithReopen.mock.calls[0];
    expect(category).toBe('tax');
    expect(headline).toBe("Billing — check one vendor's invoices not linked to Spark");
    expect(why).toMatch(/^Acme Supply: 1 invoice/);
    expect(opts).toMatchObject({
      dedupeKey: 'invoice-not-on-spark', bellDefault: true, refreshOnDedupe: true, bumpOnRefresh: true, link: '/admin/tax?tab=expenses',
      metadata: { itemKeys: ['acme supply'], count: 1, invoiceCount: 1, totalNotOnSpark: 42.1, area: 'Billing', severity: 'needs-you', doneWhen: 'count_zero' },
    });
    expect(opts.ringOnRefresh({}, { itemKeys: ['acme supply'] })).toBe(false);
    expect(opts.ringOnRefresh({}, { itemKeys: ['other co'] })).toBe(true);
    expect(episodes.closeAdminAlertKeys).not.toHaveBeenCalled();
  });

  test('rows outside the window or on an OK account never raise a bell', async () => {
    episodes.closeAdminAlertKeys.mockResolvedValueOnce(1);
    const rows = [row({ expense_date: '2026-11-04' }), row({ account_label: 'capital-one-card-6646' })];
    await expect(Spark.runInvoiceNotOnSpark({ ...base, rows })).resolves.toEqual({ count: 0, outcome: 'closed' });
    expect(episodes.raiseAdminAlertWithReopen).not.toHaveBeenCalled();
  });

  test('a quiet refresh, an unchanged list and a silenced bell are reported as such', async () => {
    const rows = [row()];
    episodes.raiseAdminAlertWithReopen.mockResolvedValueOnce({ id: 'n1', deduped: true, refreshed: true, rung: false });
    await expect(Spark.runInvoiceNotOnSpark({ ...base, rows })).resolves.toMatchObject({ outcome: 'refreshed' });
    episodes.raiseAdminAlertWithReopen.mockResolvedValueOnce({ id: 'n1', deduped: true });
    await expect(Spark.runInvoiceNotOnSpark({ ...base, rows })).resolves.toMatchObject({ outcome: 'unchanged' });
    episodes.raiseAdminAlertWithReopen.mockResolvedValueOnce({ id: null, suppressed: true, deduped: false });
    await expect(Spark.runInvoiceNotOnSpark({ ...base, rows })).resolves.toMatchObject({ outcome: 'suppressed' });
  });

  test('an empty list closes the standing row as done', async () => {
    episodes.closeAdminAlertKeys.mockResolvedValueOnce(1);
    await expect(Spark.runInvoiceNotOnSpark({ ...base, rows: [] })).resolves.toEqual({ count: 0, outcome: 'closed' });
    expect(episodes.closeAdminAlertKeys).toHaveBeenCalledWith(database, ['invoice-not-on-spark'], 'count_zero', {
      resolution: 'Every emailed invoice from the last 14 days is linked to a Spark or business debit charge',
    });
    await expect(Spark.runInvoiceNotOnSpark({ ...base, rows: [] })).resolves.toEqual({ count: 0, outcome: 'clear' });
  });

  test('a failed read throws and never closes the row', async () => {
    const failing = jest.fn(() => { throw new Error('connection reset'); });
    await expect(Spark.runInvoiceNotOnSpark({ ...base, database: failing })).rejects.toThrow('connection reset');
    expect(episodes.closeAdminAlertKeys).not.toHaveBeenCalled();
  });

  test('a bell that was not written throws so the run reads as failed', async () => {
    episodes.raiseAdminAlertWithReopen.mockResolvedValueOnce(null);
    await expect(Spark.runInvoiceNotOnSpark({ ...base, rows: [row()] })).rejects.toThrow('invoice not on Spark bell was not written');
  });

  test('with alert episodes killed it raises through the plain rule-checked path and never closes', async () => {
    gates.alertEpisodesLive.mockReturnValue(false);
    await Spark.runInvoiceNotOnSpark({ ...base, rows: [row()] });
    expect(episodes.raiseAdminAlertWithReopen).not.toHaveBeenCalled();
    expect(NotificationService.notifyAdmin).toHaveBeenCalledWith('tax', "Billing — check one vendor's invoices not linked to Spark", expect.any(String), expect.objectContaining({
      dedupeKey: 'invoice-not-on-spark', bellDefault: true, refreshOnDedupe: true,
    }));
    await Spark.runInvoiceNotOnSpark({ ...base, rows: [] });
    expect(episodes.closeAdminAlertKeys).not.toHaveBeenCalled();
  });
});
