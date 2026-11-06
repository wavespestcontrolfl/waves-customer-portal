/**
 * late-sent-bill-check: the nightly read-only check over the open self-pay bills first delivered in
 * the last 7 days (owner 2026-11-06, "fix"). A bill whose due date is before the Eastern day of its
 * first delivery stamp went out on a path that skipped the first-delivery due-date move; it posts
 * one engineering FIX row listing those bills, and a clean night retires the row. The SQL runs on
 * real Postgres in late-sent-bill-postgres.test.js. Synthetic invoice numbers only.
 */
const fs = require('fs');
const path = require('path');

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/sendgrid-mail', () => ({
  isConfigured: jest.fn(() => true),
  sendOne: jest.fn(async () => ({ ok: true })),
}));
jest.mock('../services/ops-digest', () => ({ deliverOpsDigest: jest.fn(async () => ({ ok: true, channel: 'in_app', id: 'n1' })) }));
jest.mock('../services/ops-digest-fall-off', () => ({ retireIfClean: jest.fn(async () => 0) }));

const sendgrid = require('../services/sendgrid-mail');
const { deliverOpsDigest } = require('../services/ops-digest');
const { retireIfClean } = require('../services/ops-digest-fall-off');
const { runLateSentBillCheck, OPS_KEY, _private: { composeDigest } } = require('../services/late-sent-bill-check');

const NOW = new Date('2026-11-07T04:30:00Z'); // 11:30 PM ET, Nov 6
const bill = (id, over = {}) => ({
  id, invoice_number: `WPC-TEST-${id.slice(-4)}`, due_date: '2026-11-03', annual_prepay_term_id: null,
  first_delivered_at: '2026-11-04T15:00:00Z', ...over,
});

// A knex that records the read chain and answers select() with `rows` (or throws `error`).
function fakeKnex(rows, { calls = [], error = null } = {}) {
  const knex = (table) => {
    const state = { table, whereIn: [], whereNull: [], whereNotNull: [], whereRaw: [] };
    calls.push(state);
    const chain = {
      whereIn(...args) { state.whereIn.push(args); return chain; },
      whereNull(column) { state.whereNull.push(column); return chain; },
      whereNotNull(column) { state.whereNotNull.push(column); return chain; },
      whereRaw(sql, bindings) { state.whereRaw.push([sql, bindings]); return chain; },
      orderByRaw(sql) { state.orderByRaw = sql; return chain; },
      select(...columns) { state.columns = columns; return error ? Promise.reject(error) : Promise.resolve(rows); },
    };
    return chain;
  };
  knex.raw = (sql) => ({ raw: sql });
  return knex;
}

beforeEach(() => {
  jest.clearAllMocks();
  sendgrid.isConfigured.mockReturnValue(true);
});

describe('runLateSentBillCheck', () => {
  test('a clean night retires the standing row and posts nothing', async () => {
    const result = await runLateSentBillCheck({ knex: fakeKnex([]), now: NOW });

    expect(result).toEqual({ found: 0 });
    expect(retireIfClean).toHaveBeenCalledWith(OPS_KEY);
    expect(deliverOpsDigest).not.toHaveBeenCalled();
  });

  test('reads the open self-pay bills first delivered in the 7 days before now, due before the Eastern day of that delivery', async () => {
    const calls = [];
    await runLateSentBillCheck({ knex: fakeKnex([], { calls }), now: NOW });

    const [read] = calls;
    expect(read.table).toBe('invoices');
    // the shared open self-pay rule (open-balance.js applyOpenSelfPayPredicates)
    expect(read.whereIn).toContainEqual(['invoices.status', ['sent', 'viewed', 'overdue']]);
    expect(read.whereNull).toEqual(['invoices.payer_id', 'invoices.payer_statement_id']);
    expect(read.whereNotNull).toEqual(['invoices.due_date']);
    const first = 'LEAST(invoices.sent_at, invoices.sms_sent_at, invoices.email_sent_at)';
    expect(read.whereRaw).toContainEqual([`${first} >= ?`, [new Date('2026-10-31T04:30:00Z')]]);
    expect(read.whereRaw).toContainEqual([`invoices.due_date < (${first} AT TIME ZONE 'America/New_York')::date`, undefined]);
    expect(read.orderByRaw).toBe(`${first} ASC`);
    expect(read.columns).toEqual([
      'invoices.id', 'invoices.invoice_number', 'invoices.due_date', 'invoices.annual_prepay_term_id',
      { raw: `${first} AS first_delivered_at` },
    ]);
  });

  test('a bill that reached its customer already past due posts one FIX row listing it by number and id', async () => {
    const rows = [bill('inv-0001', { annual_prepay_term_id: 'term-1' })];

    const result = await runLateSentBillCheck({ knex: fakeKnex(rows), now: NOW });

    expect(result).toEqual({ found: 1, delivery: { ok: true, channel: 'in_app', id: 'n1' } });
    expect(retireIfClean).not.toHaveBeenCalled();
    expect(deliverOpsDigest).toHaveBeenCalledTimes(1);
    const sent = deliverOpsDigest.mock.calls[0][0];
    expect(sent).toMatchObject({
      fallOff: true,
      key: OPS_KEY,
      dedupeKey: OPS_KEY,
      refreshOnDedupe: true,
      link: '/admin/invoices',
      count: 1,
      itemKeys: ['inv-0001'],
      subject: 'FIX: 1 bill reached the customer already past due',
      headline: 'Billing — fix 1 bill sent already past due',
    });
    expect(sent.headline.length).toBeLessThanOrEqual(60);
    expect(sent.summary.length).toBeLessThanOrEqual(110);
    expect(sent.text).toContain('- WPC-TEST-0001, an annual prepay bill: due Nov 3, first sent Wed, Nov 4 10:00 AM ET (invoice inv-0001)');
    expect(sent.text).toContain('firstDeliveryDueDate');
  });

  test('a read that throws fails the run and never retires the row', async () => {
    const knex = fakeKnex([], { error: new Error('pool exhausted') });

    await expect(runLateSentBillCheck({ knex, now: NOW })).rejects.toThrow('pool exhausted');
    expect(retireIfClean).not.toHaveBeenCalled();
    expect(deliverOpsDigest).not.toHaveBeenCalled();
  });

  test('the email fallback goes only to the internal ops inbox, and fails when the mailer is not set up', async () => {
    await runLateSentBillCheck({ knex: fakeKnex([bill('inv-0001')]), now: NOW });
    const { sendEmail } = deliverOpsDigest.mock.calls[0][0];

    await sendEmail();
    expect(sendgrid.sendOne).toHaveBeenCalledWith(expect.objectContaining({
      to: 'contact@wavespestcontrol.com',
      subject: 'FIX: 1 bill reached the customer already past due',
      categories: ['ops', OPS_KEY],
    }));

    sendgrid.sendOne.mockClear();
    sendgrid.isConfigured.mockReturnValue(false);
    await expect(sendEmail()).rejects.toThrow('mailer not configured');
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
  });
});

describe('composeDigest', () => {
  test('lists at most 25 bills and counts the rest; plural wording; a pg DATE keeps its own day', () => {
    const rows = Array.from({ length: 27 }, (_, i) => bill(`inv-${String(i).padStart(4, '0')}`));
    // node-pg reads a DATE as local midnight; the line keeps the calendar day.
    rows[0] = bill('inv-0000', { due_date: new Date(2026, 10, 3) });
    const composed = composeDigest(rows);
    expect(composed.subject).toBe('FIX: 27 bills reached the customer already past due');
    expect(composed.headline).toBe('Billing — fix 27 bills sent already past due');
    expect(composed.text.match(/^- /gm)).toHaveLength(25);
    expect(composed.text).toContain('- WPC-TEST-0000: due Nov 3,');
    expect(composed.text).toContain('… and 2 more.');
    expect(composed.html).toContain('<li style="margin:0 0 6px 0;">WPC-TEST-0000: due Nov 3,');
  });
});

describe('scheduler wiring', () => {
  test('runs nightly at 11:30 PM ET under runExclusive, with a lazy require and a job_health rethrow', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'scheduler.js'), 'utf8');
    const i = src.indexOf("cron.schedule('30 23 * * *'");
    expect(i).toBeGreaterThan(-1);
    const block = src.slice(i, src.indexOf('timezone', i) + 40);
    expect(block).toContain("runExclusive('late-sent-bill-check'");
    expect(block).toContain("require('./late-sent-bill-check')");
    expect(block).toContain('result.delivery.ok === false');
    expect(block).toContain("timezone: 'America/New_York'");
    // #3208 rule. failing-jobs-check.test.js also checks that no fixed or hourly job shares the minute.
    expect(src.match(/cron\.schedule\('30 23 \* \* \*'/g)).toHaveLength(1);
  });
});
