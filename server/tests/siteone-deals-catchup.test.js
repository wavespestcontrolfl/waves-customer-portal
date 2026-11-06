/**
 * siteone-deals-digest missed-tick catch-up. The Monday 8:00 ET tick can be lost; the
 * Monday/Tuesday catch-up reads job_health.last_success_at to learn whether this ET week's
 * run finished, and when it did not it reads the SAME 7-day window the Monday tick would
 * have read. Fakes only: no network, no database. All names and addresses are synthetic.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { weekIsMissing, runSiteOneDealsCatchUp, scheduledTickFor } = require('../services/procurement/siteone-deals-digest');

const MONDAY_TICK = new Date('2026-11-02T13:00:00Z'); // Monday 8:00 AM EST (DST ended Sunday Nov 1)
const TUESDAY_CATCH_UP = new Date('2026-11-03T15:52:00Z'); // Tuesday 10:52 AM EST
const MONDAY_CATCH_UP = new Date('2026-11-02T15:52:00Z');

const authFor = (domain) => `mx.google.com; dkim=pass header.i=@${domain} header.s=s1 header.b=abc; spf=pass (google.com: domain of bounce@${domain} designates 192.0.2.1 as permitted sender) smtp.mailfrom=bounce@${domain}; dmarc=pass (p=NONE sp=NONE dis=NONE) header.from=${domain}`;
const deal = (over = {}) => ({
  id: 1,
  from_address: 'srep@siteone.com',
  from_name: 'Sam Rep',
  subject: 'Pest Specials',
  body_text: '',
  body_html: null,
  has_attachments: false,
  received_at: new Date('2026-10-30T15:00:00Z'),
  classification: null,
  authentication_results: authFor('siteone.com'),
  label_ids: ['INBOX'],
  quarantined_at: null,
  ...over,
});

// job_health answers .where({ job_name }).first('last_success_at'); emails keeps its date window.
function fakeDb({ lastSuccessAt = null, healthError = null, emails = [] }) {
  const calls = { tables: [], wheres: [] };
  const db = (table) => {
    calls.tables.push(table);
    const preds = [];
    const chain = {
      select() { return chain; },
      whereNull() { return chain; },
      whereRaw() { return chain; },
      limit() { return chain; },
      orderBy() { return chain; },
      first() {
        if (healthError) return Promise.reject(new Error(healthError));
        return Promise.resolve(lastSuccessAt ? { last_success_at: lastSuccessAt } : undefined);
      },
      where(a, b, c) {
        if (typeof a === 'function') return chain;
        calls.wheres.push([table, a, b, c]);
        if (c !== undefined) preds.push((row) => (b === '>=' ? row[a] >= c : row[a] < c));
        return chain;
      },
      then(resolve, reject) {
        return Promise.resolve(table === 'products_catalog' ? [] : emails.filter((row) => preds.every((p) => p(row)))).then(resolve, reject);
      },
    };
    return chain;
  };
  db.raw = (sql, bindings) => ({ sql, bindings });
  return { db, calls };
}

describe('scheduledTickFor', () => {
  test('is Monday 8:00 ET of the week the moment falls in, from any day of that week', () => {
    expect(scheduledTickFor(TUESDAY_CATCH_UP)).toEqual(MONDAY_TICK);
    expect(scheduledTickFor(MONDAY_CATCH_UP)).toEqual(MONDAY_TICK);
    expect(scheduledTickFor(new Date('2026-11-08T20:00:00Z'))).toEqual(MONDAY_TICK); // Sunday evening, still that ET week
  });
});

describe('weekIsMissing', () => {
  test('no job_health row: this week is missing', async () => {
    const { db } = fakeDb({});
    await expect(weekIsMissing({ now: TUESDAY_CATCH_UP, db })).resolves.toBe(true);
  });

  test("last success was an earlier week's catch-up: missing", async () => {
    const { db } = fakeDb({ lastSuccessAt: new Date('2026-10-27T14:00:00Z') });
    await expect(weekIsMissing({ now: TUESDAY_CATCH_UP, db })).resolves.toBe(true);
  });

  test('last success was Sunday night before the week began: still missing', async () => {
    const { db } = fakeDb({ lastSuccessAt: new Date('2026-11-02T04:30:00Z') }); // Sunday 11:30 PM EST
    await expect(weekIsMissing({ now: TUESDAY_CATCH_UP, db })).resolves.toBe(true);
  });

  test('the Monday tick finished: not missing', async () => {
    const { db } = fakeDb({ lastSuccessAt: new Date('2026-11-02T13:00:04Z') });
    await expect(weekIsMissing({ now: TUESDAY_CATCH_UP, db })).resolves.toBe(false);
    await expect(weekIsMissing({ now: MONDAY_CATCH_UP, db })).resolves.toBe(false);
  });

  test('an unreadable job_health row answers "not missing": skip, never a blind second run', async () => {
    const { db } = fakeDb({ healthError: 'connection reset' });
    await expect(weekIsMissing({ now: TUESDAY_CATCH_UP, db })).resolves.toBe(false);
  });
});

describe('runSiteOneDealsCatchUp', () => {
  const emails = () => [
    deal({ id: 10, subject: 'Pest Specials', received_at: new Date('2026-10-29T15:00:00Z') }),
    deal({ id: 11, subject: 'Fall rebate promo', received_at: new Date('2026-11-02T14:00:00Z') }), // after Monday 8:00: next week's mail
  ];

  test('the week was missed: reads the window the Monday tick would have, on the same weekly dedupeKey', async () => {
    const { db, calls } = fakeDb({ emails: emails() });
    const notify = jest.fn().mockResolvedValue({ id: 5 });
    const result = await runSiteOneDealsCatchUp({ now: TUESDAY_CATCH_UP, db, notify });

    expect(result).toEqual({ scanned: 1, deals: 1, notified: true });
    expect(calls.wheres).toContainEqual(['emails', 'received_at', '>=', new Date('2026-10-26T13:00:00Z')]);
    expect(calls.wheres).toContainEqual(['emails', 'received_at', '<', MONDAY_TICK]);
    const [, , opts] = notify.mock.calls[0];
    expect(opts.dedupeKey).toBe('siteone-deals:2026-11-02');
    expect(opts.metadata.emailIds).toEqual([10]);
  });

  test('a Monday catch-up and a Tuesday catch-up read the identical window', async () => {
    const reads = [];
    for (const at of [MONDAY_CATCH_UP, TUESDAY_CATCH_UP]) {
      const { db, calls } = fakeDb({ emails: emails() });
      await runSiteOneDealsCatchUp({ now: at, db, notify: jest.fn().mockResolvedValue({ id: 1 }) });
      reads.push(calls.wheres.filter(([table]) => table === 'emails'));
    }
    expect(reads[0]).toEqual(reads[1]);
  });

  test('the week already ran: reads no mail and rings no bell', async () => {
    const { db, calls } = fakeDb({ lastSuccessAt: new Date('2026-11-02T13:00:04Z'), emails: emails() });
    const notify = jest.fn();
    const result = await runSiteOneDealsCatchUp({ now: MONDAY_CATCH_UP, db, notify });
    expect(result).toEqual({ skipped: 'already_ran' });
    expect(notify).not.toHaveBeenCalled();
    expect(calls.tables).not.toContain('emails');
  });

  test('an unreadable job_health row under the lock REJECTS: never resolved as "already ran", so job health records a failure', async () => {
    const { db, calls } = fakeDb({ healthError: 'connection reset', emails: emails() });
    const notify = jest.fn();
    await expect(runSiteOneDealsCatchUp({ now: TUESDAY_CATCH_UP, db, notify })).rejects.toThrow('connection reset');
    expect(notify).not.toHaveBeenCalled();
    expect(calls.tables).not.toContain('emails');
  });
});
