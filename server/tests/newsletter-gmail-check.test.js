/**
 * The newsletter Gmail check (services/newsletter-gmail-check.js): Gmail sends no spam reports, so
 * the one sign that Gmail filed an issue as spam is that Gmail readers opened far fewer copies
 * than all other readers. These cases pin the verdict rule (under half the other readers' rate,
 * and beyond chance), the window a run asks for, and the one alert it raises. The alert goes
 * through the real composeAdminAlert, which throws under NODE_ENV=test on any break of
 * docs/admin-notifications.md. The counts query and the issue query are proven on PostgreSQL in
 * newsletter-gmail-check-postgres.test.js.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

jest.mock('../models/db', () => {
  const state = { sends: [], wheres: [] };
  const fn = jest.fn(() => {
    const q = {
      whereIn: jest.fn((...args) => { state.wheres.push(args); return q; }),
      whereRaw: jest.fn((...args) => { state.wheres.push(args); return q; }),
      orderByRaw: jest.fn(() => q),
      select: jest.fn(async () => state.sends),
    };
    return q;
  });
  fn.raw = jest.fn((sql) => sql);
  fn.state = state;
  return fn;
});

jest.mock('../services/newsletter-sender', () => ({ gmailOpenCounts: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({ id: 'notif-1', deduped: false })) }));

const db = require('../models/db');
const logger = require('../services/logger');
const { gmailOpenCounts } = require('../services/newsletter-sender');
const { notifyAdmin } = require('../services/notification-service');
const {
  runNewsletterGmailCheck, gmailGapVerdict, chanceOfSoFewGmailOpens, MIN_COPIES,
} = require('../services/newsletter-gmail-check');

const counts = (gmailOpened, gmailDelivered, otherOpened, otherDelivered) => ({
  gmail: { delivered: gmailDelivered, opened: gmailOpened },
  other: { delivered: otherDelivered, opened: otherOpened },
});
const NOW = new Date('2026-12-05T12:00:00Z');
const HOUR_MS = 60 * 60 * 1000;
const issue = (over = {}) => ({
  id: 'send-1', subject: 'Native termites can swarm in winter', newsletter_type: 'pest-insider-monthly',
  went_out_at: new Date('2026-12-03T12:00:00Z'), ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  db.state.sends = [];
  db.state.wheres = [];
});

describe('gmailGapVerdict', () => {
  test('Gmail under half the other readers\' rate, beyond chance, is a gap', () => {
    expect(gmailGapVerdict(counts(2, 50, 20, 40))).toBe('gap');
    // A full list: 1% against 44%.
    expect(gmailGapVerdict(counts(4, 352, 120, 270))).toBe('gap');
  });

  test('a Gmail rate that keeps pace, or is behind by less than half, is ok', () => {
    expect(gmailGapVerdict(counts(25, 50, 20, 40))).toBe('ok');
    expect(gmailGapVerdict(counts(13, 50, 20, 40))).toBe('ok');
  });

  test('a gap that chance explains is ok: 1 of 20 against 4 of 20 happens about 17 times in 100', () => {
    expect(chanceOfSoFewGmailOpens(counts(1, 20, 4, 20))).toBeCloseTo(0.1708, 4);
    expect(gmailGapVerdict(counts(1, 20, 4, 20))).toBe('ok');
  });

  test('neither rate is taken as exact: 0 of 20 against 5 of 20 is ok, 0 of 20 against 8 of 20 is a gap', () => {
    // A binomial tail against an exact 25% reads the first as 3 in 1,000 and would ring.
    expect(chanceOfSoFewGmailOpens(counts(0, 20, 5, 20))).toBeCloseTo(0.02356, 5);
    expect(gmailGapVerdict(counts(0, 20, 5, 20))).toBe('ok');
    expect(chanceOfSoFewGmailOpens(counts(0, 20, 8, 20))).toBeCloseTo(0.001638, 6);
    expect(gmailGapVerdict(counts(0, 20, 8, 20))).toBe('gap');
  });

  test('either group under the minimum gives no verdict, whatever the rates', () => {
    expect(gmailGapVerdict(counts(0, MIN_COPIES - 1, 30, 40))).toBe('too_few');
    expect(gmailGapVerdict(counts(0, 50, MIN_COPIES - 1, MIN_COPIES - 1))).toBe('too_few');
  });

  test('an issue nobody opened is ok: that is not a Gmail fault', () => {
    expect(gmailGapVerdict(counts(0, 50, 0, 40))).toBe('ok');
  });

  test('an issue every other reader opened does not divide by zero', () => {
    expect(gmailGapVerdict(counts(0, 30, 30, 30))).toBe('gap');
    expect(gmailGapVerdict(counts(30, 30, 30, 30))).toBe('ok');
  });
});

describe('chanceOfSoFewGmailOpens', () => {
  test('is 1 when Gmail holds every open it can, and when nobody opened', () => {
    expect(chanceOfSoFewGmailOpens(counts(30, 30, 30, 30))).toBe(1);
    expect(chanceOfSoFewGmailOpens(counts(0, 50, 0, 40))).toBe(1);
  });

  test('a large issue does not overflow: 1,000 of 2,000 in each group is about one half', () => {
    expect(chanceOfSoFewGmailOpens(counts(1000, 2000, 1000, 2000))).toBeCloseTo(0.5126, 4);
  });
});

describe('runNewsletterGmailCheck', () => {
  test('asks for the issues that went out 48 to 72 hours before now, a send that stopped part way included', async () => {
    await runNewsletterGmailCheck({ now: NOW });

    expect(db).toHaveBeenCalledWith('newsletter_sends');
    expect(db.state.wheres).toEqual([
      ['status', ['sent', 'failed']],
      [expect.stringMatching(/^greatest\(newsletter_sends\.sent_at, .+\) <= \?$/), [new Date(NOW.getTime() - 48 * HOUR_MS)]],
      [expect.stringMatching(/^greatest\(newsletter_sends\.sent_at, .+\) > \?$/), [new Date(NOW.getTime() - 72 * HOUR_MS)]],
    ]);
    expect(gmailOpenCounts).not.toHaveBeenCalled();
    expect(notifyAdmin).not.toHaveBeenCalled();
  });

  test('a gap raises one alert that names the newsletter and both counts, and always rings', async () => {
    db.state.sends = [issue()];
    gmailOpenCounts.mockResolvedValue(counts(2, 50, 20, 40));

    const result = await runNewsletterGmailCheck({ now: NOW });

    // Opens count up to 48 hours after the issue went out, whichever hourly run reads them.
    expect(gmailOpenCounts).toHaveBeenCalledWith(db, 'send-1', new Date('2026-12-05T12:00:00Z'));
    expect(notifyAdmin).toHaveBeenCalledTimes(1);
    const [category, headline, why, opts] = notifyAdmin.mock.calls[0];
    expect(category).toBe('newsletter');
    expect(headline).toBe('Content — check Gmail delivery of the Waves Pest Insider');
    expect(why).toBe('Gmail readers opened 2 of 50 copies (4%); all other readers opened 20 of 40 (50%).');
    expect(opts).toMatchObject({
      dedupeKey: 'newsletter-gmail-check:send-1',
      bell: true,
      link: '/admin/newsletter?tab=history',
      metadata: {
        area: 'Content', severity: 'needs-you', who: 'person', doneWhen: 'report_read',
        subject: { type: 'check', id: 'newsletter-gmail-check:send-1' },
        source: 'newsletter-gmail-check', sendId: 'send-1',
      },
    });
    // One alert per issue, ever: a later run and a row marked done both stay silent.
    expect(opts).not.toHaveProperty('dedupeOpenOnly');
    expect(opts).not.toHaveProperty('refreshOnDedupe');
    expect(opts.detail).toContain('"Native termites can swarm in winter" went out Thu, Dec 3.');
    expect(opts.detail).toContain('Gmail readers opened 2 of 50 delivered copies (4%).');
    expect(result.judged).toEqual([{ sendId: 'send-1', verdict: 'gap', ...counts(2, 50, 20, 40) }]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  test('a weekly issue is named the Waves Newsletter', async () => {
    db.state.sends = [issue({ newsletter_type: 'local-weekly-fresh-events' })];
    gmailOpenCounts.mockResolvedValue(counts(4, 352, 120, 270));

    await runNewsletterGmailCheck({ now: NOW });

    expect(notifyAdmin.mock.calls[0][1]).toBe('Content — check Gmail delivery of the Waves Newsletter');
  });

  test('an issue that is ok or too small raises nothing, and each issue gets its own verdict', async () => {
    db.state.sends = [issue({ id: 'send-ok' }), issue({ id: 'send-small' }), issue({ id: 'send-gap' })];
    gmailOpenCounts
      .mockResolvedValueOnce(counts(25, 50, 20, 40))
      .mockResolvedValueOnce(counts(0, 1, 0, 0))
      .mockResolvedValueOnce(counts(2, 50, 20, 40));

    const result = await runNewsletterGmailCheck({ now: NOW });

    expect(result.judged.map((row) => [row.sendId, row.verdict])).toEqual([
      ['send-ok', 'ok'], ['send-small', 'too_few'], ['send-gap', 'gap'],
    ]);
    expect(notifyAdmin).toHaveBeenCalledTimes(1);
    expect(notifyAdmin.mock.calls[0][3].dedupeKey).toBe('newsletter-gmail-check:send-gap');
  });

  test('the next hour reads the same 48 hours of opens, finds the alert already written and logs nothing', async () => {
    db.state.sends = [issue()];
    gmailOpenCounts.mockResolvedValue(counts(2, 50, 20, 40));
    notifyAdmin.mockResolvedValueOnce({ id: 'notif-1', deduped: true });

    await runNewsletterGmailCheck({ now: new Date(NOW.getTime() + HOUR_MS) });

    expect(gmailOpenCounts).toHaveBeenCalledWith(db, 'send-1', new Date('2026-12-05T12:00:00Z'));
    expect(notifyAdmin).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test('an alert that could not be written fails the run: it is not logged as raised', async () => {
    db.state.sends = [issue()];
    gmailOpenCounts.mockResolvedValue(counts(2, 50, 20, 40));
    notifyAdmin.mockResolvedValueOnce(null);

    await expect(runNewsletterGmailCheck({ now: NOW })).rejects.toThrow('the Gmail alert for send send-1 was not written');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test('a failed read is thrown, so the job run is recorded as failed', async () => {
    db.state.sends = [issue()];
    gmailOpenCounts.mockRejectedValue(new Error('connection lost'));

    await expect(runNewsletterGmailCheck({ now: NOW })).rejects.toThrow('connection lost');
    expect(notifyAdmin).not.toHaveBeenCalled();
  });
});
