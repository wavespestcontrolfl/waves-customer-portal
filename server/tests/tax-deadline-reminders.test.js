/**
 * Tax deadline bells (GATE_TAX_DEADLINE_BELLS, owner 2026-10-30): which stage a filing row is in,
 * the alert each stage raises, the sweep that closes bells, and the 8:23 ET job's two paths.
 * Injected clocks and fakes only: no database, no real alert, no text.
 */
const mockRows = { value: [] };
const mockUpdates = [];
const mockBuilder = () => {
  const b = {};
  for (const m of ['whereNotIn', 'where', 'orderBy', 'whereIn', 'select']) b[m] = jest.fn(() => b);
  b.update = jest.fn(async (patch) => { mockUpdates.push(patch); return 1; });
  b.then = (resolve, reject) => Promise.resolve(mockRows.value).then(resolve, reject);
  return b;
};
const mockDb = jest.fn(() => mockBuilder());
mockDb.raw = jest.fn((sql, bindings) => ({ sql, bindings }));

jest.mock('../models/db', () => mockDb);
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const {
  currentStage, stageToRing, specFor, dedupeKeyFor, sweepBells, runTaxDeadlineReminders, closeBellsForFiling,
} = require('../services/tax-deadline-reminders');
const { composeAdminAlert } = require('../services/admin-alert-compose');

const deposit = (over = {}) => ({
  id: 'f-dep', source_key: 'payroll:941_deposit:2027-01', filing_type: 'payroll_941_deposit',
  title: 'Federal payroll tax deposit — Jan 2027', due_date: '2027-02-16', status: 'upcoming',
  amount_due: '1234.5', notes: 'Pay on EFTPS.', reminder_stages: {}, reminder_sent: false, reminder_sent_at: null, ...over,
});
const rt6 = (over = {}) => ({
  id: 'f-rt6', source_key: 'payroll:rt6:2026-Q4', filing_type: 'payroll_rt6', title: 'Florida RT-6 — Q4 2026',
  due_date: '2027-02-01', status: 'upcoming', amount_due: null, reminder_stages: {}, ...over,
});
const salesTax = (over = {}) => ({
  id: 'f-dr15', source_key: null, filing_type: 'dr15_sales_tax', title: 'FL Sales Tax Return (DR-15) — Nov 2026',
  due_date: '2026-12-20', status: 'upcoming', amount_due: null, reminder_stages: {}, ...over,
});

describe('currentStage', () => {
  test('payroll deposit due Tue 16 Feb 2027: Washington\'s Birthday (15 Feb) pushes the day before to Fri 12 Feb', () => {
    const row = deposit();
    expect(currentStage(row, '2027-02-01')).toBeNull(); // 15 days out
    expect(currentStage(row, '2027-02-02')).toBe('d14'); // 14 days out
    expect(currentStage(row, '2027-02-10')).toBe('d14'); // Wednesday, 6 days out
    expect(currentStage(row, '2027-02-11')).toBe('d14'); // Thursday, 5 days out
    expect(currentStage(row, '2027-02-12')).toBe('d1'); // Friday, the business day before
    expect(currentStage(row, '2027-02-14')).toBe('d1'); // stays d1 over the weekend and the holiday
    expect(currentStage(row, '2027-02-16')).toBe('d1'); // the due day
    expect(currentStage(row, '2027-02-17')).toBe('overdue');
  });

  test('nothing before the 14-day window', () => {
    expect(currentStage(deposit(), '2027-01-31')).toBeNull();
  });

  test('a Florida RT-6 uses the Florida holidays, an IRS row the IRS set (Friday after Thanksgiving)', () => {
    // Due Mon 30 Nov 2026. The Friday after Thanksgiving (27 Nov) is a Florida holiday only.
    const florida = rt6({ due_date: '2026-11-30' });
    const irs = deposit({ due_date: '2026-11-30' });
    expect(currentStage(florida, '2026-11-25')).toBe('d1'); // Wednesday
    expect(currentStage(florida, '2026-11-24')).toBe('d14');
    expect(currentStage(irs, '2026-11-25')).toBe('d14');
    expect(currentStage(irs, '2026-11-27')).toBe('d1'); // Friday
  });

  test('an RT-6 due Mon 1 Feb 2027 (31 Jan is a Sunday) starts the day before on Fri 29 Jan', () => {
    expect(currentStage(rt6(), '2027-01-28')).toBe('d14');
    expect(currentStage(rt6(), '2027-01-29')).toBe('d1');
  });

  test('a row that is not payroll has only d14, and nothing after its due date', () => {
    const row = salesTax();
    expect(currentStage(row, '2026-12-05')).toBeNull(); // 15 days out
    expect(currentStage(row, '2026-12-06')).toBe('d14');
    expect(currentStage(row, '2026-12-19')).toBe('d14'); // the day before: still d14, no d3 or d1
    expect(currentStage(row, '2026-12-20')).toBe('d14');
    expect(currentStage(row, '2026-12-21')).toBeNull(); // no ring after the due date
  });
});

describe('stageToRing', () => {
  test('a payroll row first seen inside 3 days gets only the latest stage', () => {
    expect(stageToRing(deposit({ due_date: '2027-02-18' }), '2027-02-15')).toBe('d3');
    expect(stageToRing(deposit({ due_date: '2027-02-18' }), '2027-02-17')).toBe('d1');
    // First seen on the Saturday before a holiday Monday: the business day before has passed.
    expect(stageToRing(deposit(), '2027-02-13')).toBe('d1');
  });

  test('d3 is skipped when the business day before falls farther than 3 days out', () => {
    expect(currentStage(deposit(), '2027-02-13')).toBe('d1');
  });

  test('a stage rings once and a later day in the same stage does not ring again', () => {
    const row = deposit({ due_date: '2027-02-18', reminder_stages: { d14: '2027-02-04T13:23:00.000Z' } });
    expect(stageToRing(row, '2027-02-05')).toBeNull();
    expect(stageToRing(row, '2027-02-15')).toBe('d3');
  });

  test('a stage never steps back: d1 sent, a later day in d1 or a d3 reading rings nothing', () => {
    const row = deposit({ reminder_stages: { d14: '2027-02-02T13:23:00.000Z', d3: '2027-02-13T13:23:00.000Z', d1: '2027-02-12T13:23:00.000Z' } });
    expect(stageToRing(row, '2027-02-14')).toBeNull();
    expect(stageToRing(row, '2027-02-16')).toBeNull();
  });

  test('overdue rings each ET morning, once a day', () => {
    const sentYesterday = deposit({ reminder_stages: { d1: '2027-02-12T13:23:00.000Z', overdue: '2027-02-17T13:23:00.000Z' } });
    expect(stageToRing(sentYesterday, '2027-02-17')).toBeNull();
    expect(stageToRing(sentYesterday, '2027-02-18')).toBe('overdue');
    expect(dedupeKeyFor(sentYesterday, 'overdue', '2027-02-18')).not.toBe(dedupeKeyFor(sentYesterday, 'overdue', '2027-02-19'));
    expect(dedupeKeyFor(sentYesterday, 'd3', '2027-02-13')).toBe('tax-deadline:f-dep:d3');
  });

  test('a non-payroll row rings d14 once, then never', () => {
    expect(stageToRing(salesTax(), '2026-12-10')).toBe('d14');
    expect(stageToRing(salesTax({ reminder_stages: { d14: '2026-12-06T13:23:00.000Z' } }), '2026-12-19')).toBeNull();
    expect(stageToRing(salesTax(), '2026-12-21')).toBeNull();
  });

  test('reminder_stages may arrive as JSON text', () => {
    expect(stageToRing(deposit({ reminder_stages: '{"d14":"2027-02-02T13:23:00.000Z"}' }), '2027-02-03')).toBeNull();
  });
});

describe('specFor', () => {
  const cases = [
    ['deposit d14', deposit(), 'd14', '2027-02-02'],
    ['deposit d3', deposit({ due_date: '2027-02-18' }), 'd3', '2027-02-15'],
    ['deposit d1', deposit(), 'd1', '2027-02-12'],
    ['deposit due today', deposit(), 'd1', '2027-02-16'],
    ['deposit overdue', deposit(), 'overdue', '2027-02-19'],
    ['rt6 d1', rt6(), 'd1', '2027-01-29'],
    ['rt6 overdue one day', rt6(), 'overdue', '2027-02-02'],
    ['941 d1 before a weekend gap', { ...deposit({ source_key: 'payroll:941:2026-Q4', filing_type: 'payroll_941', title: 'Form 941 — Q4 2026', due_date: '2027-02-16', amount_due: null }) }, 'd1', '2027-02-12'],
    ['sales tax d14', salesTax(), 'd14', '2026-12-10'],
    ['long title', salesTax({ title: 'Federal Tax Return (Schedule C) — Tax Year 2025 with a very long suffix' }), 'd14', '2026-12-10'],
  ];

  test.each(cases)('%s passes the admin notification rule', (_name, row, stage, today) => {
    const spec = specFor(row, stage, today);
    const composed = composeAdminAlert(spec);
    expect(composed.headline.length).toBeLessThanOrEqual(60);
    expect(composed.link).toBe('/admin/tax?tab=filings');
    expect(composed.metadata).toMatchObject({ severity: 'needs-you', who: 'person', doneWhen: 'filing_marked_done', area: 'Billing' });
  });

  test('d1 wording by row type', () => {
    expect(specFor(rt6(), 'd1', '2027-01-29').why).toBe('Start the Florida payment by 5 PM ET today, due Mon, Feb 1.');
    expect(specFor(deposit(), 'd1', '2027-02-12').why).toBe('Pay today: EFTPS needs the payment started by 8 PM ET today, due Tue, Feb 16 for $1,234.50.');
    const form941 = deposit({ filing_type: 'payroll_941', due_date: '2027-02-02' });
    expect(specFor(form941, 'd1', '2027-02-01').why).toBe('Due tomorrow for $1,234.50.');
    expect(specFor({ ...form941, due_date: '2027-02-16' }, 'd1', '2027-02-12').why).toBe('Due Tue, Feb 16, the next business day for $1,234.50.');
    expect(specFor(deposit(), 'd1', '2027-02-16').why).toBe('Due today for $1,234.50.');
  });

  test('overdue says how late and that it rings daily', () => {
    expect(specFor(deposit(), 'overdue', '2027-02-18').why).toBe('Was due Tue, Feb 16, 2 days ago for $1,234.50; it rings each morning until you mark it.');
  });
});

describe('runTaxDeadlineReminders', () => {
  const now = new Date('2027-02-15T13:23:00.000Z'); // Mon 15 Feb 2027, 8:23 AM ET
  const episodes = () => ({
    openAdminAlertKeys: jest.fn(async () => []),
    closeAdminAlertKeys: jest.fn(async () => 0),
  });

  beforeEach(() => {
    mockUpdates.length = 0;
    mockRows.value = [];
    jest.clearAllMocks();
  });

  test('raises one bell per row in category tax with bellDefault (not bell), and records the stage', async () => {
    mockRows.value = [deposit({ due_date: '2027-02-18' }), salesTax({ due_date: '2027-02-20' })];
    const raise = jest.fn(async () => ({ id: 'n1' }));
    const tally = await runTaxDeadlineReminders({ now, raise, episodes: episodes() });
    expect(tally).toMatchObject({ rung: 2, failed: 0 });
    const [category, spec, opts] = raise.mock.calls[0];
    expect(category).toBe('tax');
    expect(spec.severity).toBe('needs-you');
    expect(opts).toMatchObject({ dedupeKey: 'tax-deadline:f-dep:d3', bellDefault: true, detail: 'Pay on EFTPS.' });
    expect(opts).not.toHaveProperty('bell');
    expect(raise.mock.calls[1][2].dedupeKey).toBe('tax-deadline:f-dr15:d14');
    // The first stage also sets the old columns; the jsonb merge carries the stage and time.
    expect(mockUpdates[0]).toMatchObject({ reminder_sent: true, reminder_sent_at: now });
    expect(mockDb.raw).toHaveBeenCalledWith(expect.stringContaining('reminder_stages'), [JSON.stringify({ d3: now.toISOString() })]);
  });

  test('a row already marked reminded keeps its old columns and only gains the stage', async () => {
    mockRows.value = [deposit({ due_date: '2027-02-18', reminder_sent: true, reminder_sent_at: new Date('2027-02-04T13:23:00Z'), reminder_stages: { d14: '2027-02-04T13:23:00.000Z' } })];
    await runTaxDeadlineReminders({ now, raise: jest.fn(async () => ({ id: 'n1' })), episodes: episodes() });
    expect(mockUpdates[0]).not.toHaveProperty('reminder_sent');
    expect(mockUpdates[0]).toHaveProperty('reminder_stages');
  });

  test('nothing is recorded when nothing was written (suppressed or failed insert), so tomorrow tries again', async () => {
    mockRows.value = [deposit({ due_date: '2027-02-18' })];
    const tally = await runTaxDeadlineReminders({ now, raise: jest.fn(async () => ({ id: null, suppressed: true })), episodes: episodes() });
    expect(mockUpdates).toHaveLength(0);
    expect(tally.rung).toBe(0);
    await runTaxDeadlineReminders({ now, raise: jest.fn(async () => null), episodes: episodes() });
    expect(mockUpdates).toHaveLength(0);
  });

  test('one failing row does not stop the others', async () => {
    mockRows.value = [deposit({ due_date: '2027-02-18' }), rt6({ due_date: '2027-02-16' })];
    const raise = jest.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ id: 'n2' });
    const tally = await runTaxDeadlineReminders({ now, raise, episodes: episodes() });
    expect(tally).toMatchObject({ rung: 1, failed: 1 });
  });

  test('a row with nothing due today is skipped', async () => {
    mockRows.value = [deposit({ due_date: '2027-02-18', reminder_stages: { d3: '2027-02-15T01:00:00.000Z' } })];
    const raise = jest.fn();
    const tally = await runTaxDeadlineReminders({ now, raise, episodes: episodes() });
    expect(raise).not.toHaveBeenCalled();
    expect(tally.skipped).toBe(1);
  });
});

describe('sweepBells', () => {
  const key = (id, tail) => `tax-deadline:${id}:${tail}`;

  async function sweep(openKeys, rows, today = '2027-02-18') {
    mockRows.value = rows;
    const closeKeys = jest.fn(async (_c, list) => list.length);
    const closed = await sweepBells({ today, closeKeys, openKeys: async () => openKeys, conn: mockDb });
    return { closed, calls: closeKeys.mock.calls.map(([, list, reason, opts]) => ({ list, reason, resolution: opts.resolution })) };
  }

  test('a marked, paid or deleted row closes every bell it has', async () => {
    const { calls } = await sweep(
      [key('a', 'd14'), key('b', 'd3'), key('c', 'd1')],
      [{ id: 'a', status: 'paid', due_date: '2027-02-16', source_key: 'payroll:x' }, { id: 'b', status: 'filed', due_date: '2027-02-16', source_key: null }],
    );
    expect(calls).toEqual([{ list: [key('a', 'd14'), key('b', 'd3'), key('c', 'd1')], reason: 'tax_deadline_settled', resolution: 'The filing was marked paid or filed' }]);
  });

  test('a non-payroll bell closes once the due date passes; a payroll bell does not', async () => {
    const { calls } = await sweep(
      [key('s', 'd14'), key('p', 'overdue:2027-02-18')],
      [{ id: 's', status: 'upcoming', due_date: '2027-02-16', source_key: null }, { id: 'p', status: 'upcoming', due_date: '2027-02-16', source_key: 'payroll:y' }],
    );
    expect(calls).toEqual([{ list: [key('s', 'd14')], reason: 'tax_deadline_settled', resolution: 'The due date has passed' }]);
  });

  test('an unmarked payroll row keeps only its newest bell', async () => {
    const { calls } = await sweep(
      [key('p', 'd14'), key('p', 'd3'), key('p', 'd1'), key('p', 'overdue:2027-02-17'), key('p', 'overdue:2027-02-18')],
      [{ id: 'p', status: 'upcoming', due_date: '2027-02-16', source_key: 'payroll:y' }],
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].list.sort()).toEqual([key('p', 'd14'), key('p', 'd3'), key('p', 'd1'), key('p', 'overdue:2027-02-17')].sort());
    expect(calls[0].resolution).toBe('A newer reminder for this filing replaced it');
  });

  test('no open bells: no query for rows and no close', async () => {
    const { closed, calls } = await sweep([], []);
    expect(closed).toBe(0);
    expect(calls).toHaveLength(0);
  });
});

describe('closeBellsForFiling', () => {
  test('closes the row\'s open bells under its key prefix', async () => {
    const episodes = {
      openAdminAlertKeys: jest.fn(async () => ['tax-deadline:f1:d14', 'tax-deadline:f1:d3']),
      closeAdminAlertKeys: jest.fn(async (_c, keys) => keys.length),
    };
    await expect(closeBellsForFiling('f1', { conn: mockDb, episodes })).resolves.toBe(2);
    expect(episodes.openAdminAlertKeys).toHaveBeenCalledWith(mockDb, 'tax-deadline:f1:');
    expect(episodes.closeAdminAlertKeys).toHaveBeenCalledWith(mockDb, ['tax-deadline:f1:d14', 'tax-deadline:f1:d3'], 'tax_filing_marked', expect.objectContaining({ resolution: expect.any(String) }));
  });

  test('never throws', async () => {
    const episodes = { openAdminAlertKeys: jest.fn(async () => { throw new Error('db down'); }), closeAdminAlertKeys: jest.fn() };
    await expect(closeBellsForFiling('f1', { conn: mockDb, episodes })).resolves.toBe(0);
  });
});
