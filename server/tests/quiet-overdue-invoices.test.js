// Quiet overdue invoices (owner 2026-10-24): which reminder states count as
// quiet, the one standing Billing bell it raises (copy passes the admin
// notification rule), when a refresh rings, and the close at zero. The SQL
// runs against PostgreSQL in quiet-overdue-invoices-postgres.test.js.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({
  quietOverdueListLive: jest.fn(() => true),
  alertEpisodesLive: jest.fn(() => true),
}));
jest.mock('../services/admin-alert-episodes', () => ({
  raiseAdminAlertWithReopen: jest.fn(async () => ({ id: 'n1', deduped: false, rang: true })),
  closeAdminAlertKeys: jest.fn(async () => 0),
}));
jest.mock('../services/notification-service', () => ({
  notifyAdmin: jest.fn(async () => ({ id: 'n2', deduped: false })),
}));
jest.mock('../services/workflows/balance-reminder', () => ({ latePaymentCheckRetired: jest.fn(async () => true) }));

const gates = require('../config/feature-gates');
const episodes = require('../services/admin-alert-episodes');
const NotificationService = require('../services/notification-service');
const BalanceReminder = require('../services/workflows/balance-reminder');
const { composeAdminAlert } = require('../services/admin-alert-compose');
const Quiet = require('../services/quiet-overdue-invoices');

const { quietReason, listedReason, listItems, composeList, ringOnNewInvoice, reasonWords } = Quiet._private;
const NOW = new Date('2026-10-26T15:47:00Z'); // Monday 11:47 ET

const row = (over = {}) => ({
  id: over.id || 'inv-1',
  invoice_number: 'WPC-TEST-0001',
  customer_id: 'cust-1',
  total: '100.00',
  credit_applied: '0',
  first_name: 'Pat',
  last_name: 'Synthetic',
  seq_status: 'completed',
  next_touch_at: null,
  paused_until: null,
  stopped_by_admin_id: null,
  stopped_reason: null,
  autopay_failures_observed: 0,
  days_late: 30,
  hold_days: 30,
  ...over,
});

// A knex-like chain that resolves to `rows` whatever is chained on it.
function fakeDatabase(rows) {
  const chain = new Proxy(() => {}, {
    get(_target, prop) {
      if (prop === 'then') return (resolve, reject) => Promise.resolve(typeof rows === 'function' ? rows() : rows).then(resolve, reject);
      return () => chain;
    },
  });
  const database = () => chain;
  database.raw = () => ({});
  return database;
}

beforeEach(() => {
  jest.clearAllMocks();
  gates.quietOverdueListLive.mockReturnValue(true);
  gates.alertEpisodesLive.mockReturnValue(true);
  BalanceReminder.latePaymentCheckRetired.mockResolvedValue(true);
});

describe('which states are quiet', () => {
  test.each([
    [{ seq_status: null }, 'never_set_up'],
    [{ seq_status: 'active', next_touch_at: new Date('2026-10-28T14:00:00Z') }, null],
    [{ seq_status: 'active', next_touch_at: null }, 'unscheduled'],
    [{ seq_status: 'paused' }, 'paused'],
    [{ seq_status: 'paused', paused_until: new Date('2026-11-01T00:00:00Z') }, null],
    [{ seq_status: 'paused', paused_until: new Date('2026-10-20T00:00:00Z') }, 'pause_ended'],
    [{ seq_status: 'stopped' }, 'stopped'],
    [{ seq_status: 'completed' }, 'finished'],
    [{ seq_status: 'autopay_hold' }, 'autopay_hold'],
    [{ seq_status: 'something_new' }, 'unknown'],
  ])('%o -> %s', (over, expected) => {
    expect(quietReason(row(over), NOW)).toBe(expected);
  });

  test('an Auto Pay hold is listed from 7 days on hold; every other quiet state from 14 days late', () => {
    expect(listedReason(row({ seq_status: 'autopay_hold', hold_days: 6, days_late: 20 }), NOW)).toBeNull();
    expect(listedReason(row({ seq_status: 'autopay_hold', hold_days: 7, days_late: 7 }), NOW)).toBe('autopay_hold');
    expect(listedReason(row({ seq_status: 'stopped', days_late: 13 }), NOW)).toBeNull();
    expect(listedReason(row({ seq_status: 'stopped', days_late: 14 }), NOW)).toBe('stopped');
    expect(listedReason(row({ seq_status: null, days_late: 14 }), NOW)).toBe('never_set_up');
  });
});

describe('the list', () => {
  test('oldest first, nothing with no money due, staff stop notes kept and system stop codes left out', () => {
    const items = listItems([
      row({ id: 'a', invoice_number: 'A', days_late: 20, seq_status: 'stopped', stopped_by_admin_id: 'admin-1', stopped_reason: 'Check' }),
      row({ id: 'b', invoice_number: 'B', days_late: 90, seq_status: 'stopped', stopped_reason: 'invoice_terminal_status:void' }),
      row({ id: 'c', invoice_number: 'C', days_late: 50, total: '40.00', credit_applied: '40.00' }),
      row({ id: 'd', invoice_number: 'D', days_late: 10, hold_days: 9, seq_status: 'autopay_hold', autopay_failures_observed: 2 }),
    ], NOW);
    expect(items.map((i) => i.invoiceNumber)).toEqual(['B', 'A', 'D']);
    expect(reasonWords(items[0])).toBe('reminders stopped by the system');
    expect(reasonWords(items[1])).toBe('reminders stopped by staff ("Check")');
    expect(reasonWords(items[2])).toBe('on Auto Pay hold, 2 failed charges');
  });

  test('several invoices: one rule-clean Billing bell that opens the Invoices page, the list in the detail', () => {
    const items = listItems([
      row({ id: 'b', invoice_number: 'WPC-TEST-0002', total: '996.00', days_late: 146 }),
      row({ id: 'a', invoice_number: 'WPC-TEST-0001', total: '75.50', days_late: 30, seq_status: 'paused' }),
    ], NOW);
    const composed = composeList(items);
    const alert = composeAdminAlert(composed.spec);
    expect(alert.headline).toBe('Billing — follow up on 2 quiet overdue invoices');
    expect(alert.why).toBe('$1,072 is owed with no overdue reminder scheduled on any of them; the oldest is 146 days late.');
    expect(alert.link).toBe('/admin/invoices');
    expect(alert.metadata).toMatchObject({ area: 'Billing', severity: 'needs-you', who: 'person', doneWhen: 'count_zero', subject: { type: 'check', id: Quiet.DEDUPE_KEY } });
    expect(composed.itemKeys).toEqual(['a', 'b']);
    expect(composed.total).toBe(1071.5);
    expect(composed.detail.split('\n')).toEqual([
      '2 open invoices, $1,071.50 owed. No overdue reminder is scheduled on any of them, and nothing was sent by this check.',
      'Oldest first:',
      'WPC-TEST-0002 · Pat Synthetic · $996.00 · 146 days late · every reminder sent, nothing next',
      'WPC-TEST-0001 · Pat Synthetic · $75.50 · 30 days late · reminders paused, no end date',
    ]);
  });

  test('one invoice: the why names the customer and the link opens that invoice', () => {
    const composed = composeList(listItems([row({ id: 'inv-9', total: '250.00', days_late: 16, hold_days: 10, seq_status: 'autopay_hold' })], NOW));
    const alert = composeAdminAlert(composed.spec);
    expect(alert.headline).toBe('Billing — follow up on 1 quiet overdue invoice');
    expect(alert.why).toBe('Pat Synthetic owes $250 with no overdue reminder scheduled; it is 16 days late.');
    expect(alert.link).toBe('/admin/invoices?invoice=inv-9');
  });

  test('one invoice whose name the rule cannot carry: the why drops the name', () => {
    for (const over of [{ first_name: 'Mary J.', last_name: 'Synthetic' }, { first_name: 'Bartholomew-Maximilian Alexander', last_name: 'Synthetic-Featherstonehaugh' }]) {
      const composed = composeList(listItems([row({ ...over, total: '250.00', days_late: 16 })], NOW));
      expect(composeAdminAlert(composed.spec).why).toBe('$250 is owed on one invoice with no overdue reminder scheduled; it is 16 days late.');
    }
  });

  test('a long list stays rule-clean and the detail names how many more there are', () => {
    const rows = Array.from({ length: 30 }, (_, i) => row({ id: `id-${String(i).padStart(2, '0')}`, invoice_number: `N${i}`, total: '12345.67', days_late: 400 + i }));
    const composed = composeList(listItems(rows, NOW));
    expect(() => composeAdminAlert(composed.spec)).not.toThrow();
    const lines = composed.detail.split('\n');
    expect(lines).toHaveLength(2 + 25 + 1);
    expect(lines[lines.length - 1]).toBe('…and 5 more.');
    expect(composed.itemKeys).toHaveLength(30);
  });
});

describe('ringing', () => {
  test('a refresh rings only when an invoice joins the list', () => {
    expect(ringOnNewInvoice(['a', 'b'])({}, { itemKeys: ['a', 'b'] })).toBe(false);
    expect(ringOnNewInvoice(['a'])({}, { itemKeys: ['a', 'b'] })).toBe(false);
    expect(ringOnNewInvoice(['a', 'c'])({}, { itemKeys: ['a', 'b'] })).toBe(true);
    expect(ringOnNewInvoice(['a'])({}, {})).toBe(true);
  });
});

describe('runQuietOverdueList', () => {
  test('gate off: no read, no bell', async () => {
    gates.quietOverdueListLive.mockReturnValue(false);
    const database = jest.fn();
    await expect(Quiet.runQuietOverdueList({ now: NOW, database })).resolves.toEqual({ skipped: 'disabled' });
    expect(database).not.toHaveBeenCalled();
    expect(episodes.raiseAdminAlertWithReopen).not.toHaveBeenCalled();
  });

  test('the legacy sender still running: no read, no bell, no close (it may still contact these invoices)', async () => {
    const database = jest.fn();
    BalanceReminder.latePaymentCheckRetired.mockResolvedValue(false);
    await expect(Quiet.runQuietOverdueList({ now: NOW, database })).resolves.toEqual({ skipped: 'legacy_sender_live' });
    // Its own full retirement rule, read without its log lines.
    expect(BalanceReminder.latePaymentCheckRetired).toHaveBeenCalledWith({ log: false });
    expect(database).not.toHaveBeenCalled();
    expect(episodes.raiseAdminAlertWithReopen).not.toHaveBeenCalled();
    expect(episodes.closeAdminAlertKeys).not.toHaveBeenCalled();
  });

  test('a list raises one standing billing row that asks to ring and rings again only for a new invoice', async () => {
    const out = await Quiet.runQuietOverdueList({ now: NOW, database: fakeDatabase([row({ id: 'a' }), row({ id: 'b', seq_status: 'active', next_touch_at: NOW })]) });
    expect(out).toEqual({ count: 1, total: 100, outcome: 'raised' });
    expect(episodes.raiseAdminAlertWithReopen).toHaveBeenCalledTimes(1);
    const [category, headline, why, opts] = episodes.raiseAdminAlertWithReopen.mock.calls[0];
    expect(category).toBe('billing');
    expect(headline).toBe('Billing — follow up on 1 quiet overdue invoice');
    expect(why).toMatch(/^Pat Synthetic owes \$100/);
    expect(opts).toMatchObject({
      dedupeKey: 'quiet-overdue-invoices', bellDefault: true, refreshOnDedupe: true, bumpOnRefresh: true, link: '/admin/invoices?invoice=a',
      metadata: { itemKeys: ['a'], count: 1, totalDue: 100, area: 'Billing', severity: 'needs-you', doneWhen: 'count_zero' },
    });
    expect(opts.detail).toMatch(/^1 open invoice, \$100\.00 owed\./);
    expect(opts.ringOnRefresh({}, { itemKeys: ['a'] })).toBe(false);
    expect(episodes.closeAdminAlertKeys).not.toHaveBeenCalled();
  });

  test('a quiet refresh, an unchanged list and a silenced bell are reported as such', async () => {
    episodes.raiseAdminAlertWithReopen.mockResolvedValueOnce({ id: 'n1', deduped: true, refreshed: true, rung: false });
    await expect(Quiet.runQuietOverdueList({ now: NOW, database: fakeDatabase([row()]) })).resolves.toMatchObject({ outcome: 'refreshed' });
    episodes.raiseAdminAlertWithReopen.mockResolvedValueOnce({ id: 'n1', deduped: true });
    await expect(Quiet.runQuietOverdueList({ now: NOW, database: fakeDatabase([row()]) })).resolves.toMatchObject({ outcome: 'unchanged' });
    // The owner silenced billing bells: the bell policy wrote nothing, and the run says so.
    episodes.raiseAdminAlertWithReopen.mockResolvedValueOnce({ id: null, suppressed: true, deduped: false });
    await expect(Quiet.runQuietOverdueList({ now: NOW, database: fakeDatabase([row()]) })).resolves.toMatchObject({ outcome: 'suppressed' });
  });

  test('an empty list closes the standing row as done', async () => {
    episodes.closeAdminAlertKeys.mockResolvedValueOnce(1);
    const database = fakeDatabase([row({ seq_status: 'active', next_touch_at: NOW })]);
    await expect(Quiet.runQuietOverdueList({ now: NOW, database })).resolves.toEqual({ count: 0, outcome: 'closed' });
    expect(episodes.closeAdminAlertKeys).toHaveBeenCalledWith(database, ['quiet-overdue-invoices'], 'count_zero', {
      resolution: 'Every overdue invoice has reminders going out or is settled',
    });
    expect(episodes.raiseAdminAlertWithReopen).not.toHaveBeenCalled();
  });

  test('a failed read throws and never closes the row', async () => {
    const database = fakeDatabase(() => { throw new Error('connection reset'); });
    await expect(Quiet.runQuietOverdueList({ now: NOW, database })).rejects.toThrow('connection reset');
    expect(episodes.closeAdminAlertKeys).not.toHaveBeenCalled();
  });

  test('a bell that was not written throws so the run reads as failed', async () => {
    episodes.raiseAdminAlertWithReopen.mockResolvedValueOnce(null);
    await expect(Quiet.runQuietOverdueList({ now: NOW, database: fakeDatabase([row()]) })).rejects.toThrow('quiet overdue invoice bell was not written');
  });

  test('with alert episodes killed it raises through the plain rule-checked path and never closes', async () => {
    gates.alertEpisodesLive.mockReturnValue(false);
    await Quiet.runQuietOverdueList({ now: NOW, database: fakeDatabase([row()]) });
    expect(episodes.raiseAdminAlertWithReopen).not.toHaveBeenCalled();
    expect(NotificationService.notifyAdmin).toHaveBeenCalledWith('billing', 'Billing — follow up on 1 quiet overdue invoice', expect.any(String), expect.objectContaining({
      dedupeKey: 'quiet-overdue-invoices', bellDefault: true, refreshOnDedupe: true,
    }));
    await Quiet.runQuietOverdueList({ now: NOW, database: fakeDatabase([]) });
    expect(episodes.closeAdminAlertKeys).not.toHaveBeenCalled();
  });
});
