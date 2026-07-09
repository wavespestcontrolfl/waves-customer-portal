jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
const mockNotifyAdmin = jest.fn(async () => ({ id: 'notif-1' }));
jest.mock('../services/notification-service', () => ({
  notifyAdmin: (...args) => mockNotifyAdmin(...args),
}));

const db = require('../models/db');
const { runSunbizAnnualReportReminder } = require('../services/sunbiz-annual-report-reminder');

function chain({ first } = {}) {
  const q = {};
  q.where = jest.fn(() => q);
  q.whereIn = jest.fn(() => q);
  q.whereNotIn = jest.fn(() => q);
  q.whereRaw = jest.fn(() => q);
  q.first = jest.fn(async () => first);
  q.insert = jest.fn(async () => undefined);
  q.update = jest.fn(async () => 1);
  return q;
}

// Noon UTC on Jan 1 = 7am ET Jan 1 — squarely inside the filing window.
const JAN_1 = new Date('2027-01-01T12:00:00Z');

describe('runSunbizAnnualReportReminder', () => {
  beforeEach(() => jest.clearAllMocks());

  test('january: creates the filing-calendar row and rings the admin bell with dedupe metadata', async () => {
    const filingQ = chain({ first: undefined }); // no row for the year yet
    const insertQ = chain();
    const dedupeQ = chain({ first: undefined }); // not yet notified
    db.mockReturnValueOnce(filingQ).mockReturnValueOnce(insertQ).mockReturnValueOnce(dedupeQ);

    const result = await runSunbizAnnualReportReminder(JAN_1);

    expect(result).toEqual({ fired: true, filingRowCreated: true });
    expect(insertQ.insert).toHaveBeenCalledWith(expect.objectContaining({
      filing_type: 'sunbiz_annual_report',
      period_label: '2027',
      due_date: '2027-05-01',
      status: 'upcoming',
      amount_due: 138.75,
    }));
    expect(mockNotifyAdmin).toHaveBeenCalledTimes(1);
    const [category, title, , opts] = mockNotifyAdmin.mock.calls[0];
    expect(category).toBe('tax');
    expect(title).toContain('2027 Florida LLC annual report');
    expect(opts.link).toBe('/admin/tax');
    expect(opts.metadata).toEqual({ reminder: 'sunbiz_annual_report', year: '2027' });
  });

  test('january, already notified this year: keeps the filing row but does not ring twice', async () => {
    const filingQ = chain({ first: { id: 'row-1' } }); // year row exists
    const dedupeQ = chain({ first: { id: 'notif-existing' } });
    db.mockReturnValueOnce(filingQ).mockReturnValueOnce(dedupeQ);

    const result = await runSunbizAnnualReportReminder(JAN_1);

    expect(result).toEqual({ fired: false, filingRowCreated: false, reason: 'already_notified' });
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
  });

  test('between the window and the deadline (Feb–May 1): no bell, but still self-heals the row', async () => {
    const ensureQ = chain({ first: undefined }); // no row for the year
    const insertQ = chain();
    db.mockReturnValueOnce(ensureQ).mockReturnValueOnce(insertQ);

    const result = await runSunbizAnnualReportReminder(new Date('2027-03-15T12:00:00Z'));

    expect(result).toEqual({ fired: false, filingRowCreated: true, reason: 'outside_window' });
    expect(insertQ.insert).toHaveBeenCalledWith(expect.objectContaining({ period_label: '2027', due_date: '2027-05-01' }));
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
  });

  test('past May 1 with the report still unfiled: bumps amount_due by the $400 late fee', async () => {
    const ensureQ = chain({ first: { id: 'row-1' } }); // year row already exists
    const sweepQ = chain({ first: { id: 'row-1', amount_due: '138.75', notes: 'File at sunbiz.org.' } });
    const updateQ = chain();
    db.mockReturnValueOnce(ensureQ).mockReturnValueOnce(sweepQ).mockReturnValueOnce(updateQ);

    const result = await runSunbizAnnualReportReminder(new Date('2027-07-09T12:00:00Z'));

    expect(result).toEqual({ fired: false, filingRowCreated: false, lateFeeApplied: true, reason: 'past_due_sweep' });
    expect(sweepQ.whereNotIn).toHaveBeenCalledWith('status', ['filed', 'paid']);
    expect(updateQ.update).toHaveBeenCalledWith(expect.objectContaining({ amount_due: 538.75 }));
    expect(updateQ.update.mock.calls[0][0].notes).toContain('$400 statutory late fee');
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
  });

  test('past May 1 but already filed (or fee already applied): leaves the row alone', async () => {
    const ensureQ = chain({ first: { id: 'row-1' } });
    const sweepQ = chain({ first: undefined }); // filed/paid rows fall out of the whereNotIn
    db.mockReturnValueOnce(ensureQ).mockReturnValueOnce(sweepQ);

    const result = await runSunbizAnnualReportReminder(new Date('2027-07-09T12:00:00Z'));

    expect(result).toEqual({ fired: false, filingRowCreated: false, lateFeeApplied: false, reason: 'past_due_sweep' });
    expect(db).toHaveBeenCalledTimes(2);
  });

  test('past May 1 in an environment where January never ran: creates the row, then applies the fee', async () => {
    const ensureQ = chain({ first: undefined }); // no row for the year
    const insertQ = chain();
    const sweepQ = chain({ first: { id: 'row-new', amount_due: '138.75', notes: 'File at sunbiz.org.' } });
    const updateQ = chain();
    db.mockReturnValueOnce(ensureQ).mockReturnValueOnce(insertQ)
      .mockReturnValueOnce(sweepQ).mockReturnValueOnce(updateQ);

    const result = await runSunbizAnnualReportReminder(new Date('2027-07-09T12:00:00Z'));

    expect(result).toEqual({ fired: false, filingRowCreated: true, lateFeeApplied: true, reason: 'past_due_sweep' });
    expect(insertQ.insert).toHaveBeenCalledWith(expect.objectContaining({ period_label: '2027', status: 'upcoming' }));
    expect(updateQ.update).toHaveBeenCalledWith(expect.objectContaining({ amount_due: 538.75 }));
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
  });

  test('notification insert failure leaves the dedupe unset so the next tick retries', async () => {
    mockNotifyAdmin.mockResolvedValueOnce(null); // notifyAdmin swallows insert errors → null
    const filingQ = chain({ first: { id: 'row-1' } });
    const dedupeQ = chain({ first: undefined });
    db.mockReturnValueOnce(filingQ).mockReturnValueOnce(dedupeQ);

    const result = await runSunbizAnnualReportReminder(JAN_1);

    expect(result).toEqual({ fired: false, filingRowCreated: false });
  });
});
