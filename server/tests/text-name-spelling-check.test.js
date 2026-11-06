/**
 * text-name-spelling-check: the nightly read-only check over the last 24 hours of staff texts. A
 * text that greets its customer by a close spelling of the record's name (the words the mic now
 * re-spells) posts one engineering FIX row listing the texts by sms_log id; a clean night retires
 * the row. Synthetic names only.
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
const { runTextNameSpellingCheck, OPS_KEY, _private: { composeDigest } } = require('../services/text-name-spelling-check');

const NOW = new Date('2026-11-07T04:32:00Z'); // 11:32 PM ET
const text = (id, body, first = 'Dena', last = 'Exampleton', at = '2026-11-06T15:00:00Z') => ({
  id, created_at: at, message_body: body, first_name: first, last_name: last,
});

// A knex that records the read chain and answers select() with `rows` (or throws `error`).
function fakeKnex(rows, { calls = [], error = null } = {}) {
  return (table) => {
    const state = { table, joins: [], where: [], whereNotNull: [] };
    calls.push(state);
    const chain = {
      join(...args) { state.joins.push(args); return chain; },
      where(...args) { state.where.push(args); return chain; },
      whereNotNull(column) { state.whereNotNull.push(column); return chain; },
      orderBy(...args) { state.orderBy = args; return chain; },
      select(...columns) { state.columns = columns; return error ? Promise.reject(error) : Promise.resolve(rows); },
    };
    return chain;
  };
}
const noKeep = async () => new Set();

beforeEach(() => {
  jest.clearAllMocks();
  sendgrid.isConfigured.mockReturnValue(true);
});

describe('runTextNameSpellingCheck', () => {
  test('a clean night retires the standing row and posts nothing', async () => {
    const rows = [text('sms-1', 'Hey Dena, we can come Tuesday.'), text('sms-2', 'Dina called about the lanai.')];

    const result = await runTextNameSpellingCheck({ knex: fakeKnex(rows), now: NOW, readKeepWords: noKeep });

    expect(result).toEqual({ checked: 2, findings: [] });
    expect(retireIfClean).toHaveBeenCalledWith(OPS_KEY);
    expect(deliverOpsDigest).not.toHaveBeenCalled();
  });

  test('reads outbound staff texts of the 24 hours before now, with the name of the customer each went to', async () => {
    const calls = [];
    await runTextNameSpellingCheck({ knex: fakeKnex([], { calls }), now: NOW, readKeepWords: noKeep });

    const [read] = calls;
    expect(read.table).toBe('sms_log as s');
    expect(read.joins).toEqual([['customers as c', 'c.id', 's.customer_id']]);
    expect(read.where).toContainEqual(['s.direction', 'outbound']);
    expect(read.whereNotNull).toEqual(['s.admin_user_id', 's.message_body']);
    expect(read.where).toContainEqual(['s.created_at', '>=', new Date('2026-11-06T04:32:00Z')]);
    expect(read.columns).toEqual(['s.id', 's.created_at', 's.message_body', 'c.first_name', 'c.last_name']);
  });

  test('a text that greets its customer by a close spelling posts one FIX row listing the text by id', async () => {
    const rows = [
      text('sms-1', 'Hey Dina. We can come Tuesday at ten.'),
      text('sms-2', 'Hi Dena, all set.'),
      // a keep word (here a staff first name) is never a finding
      text('sms-3', 'Hi Joe, see you then.', 'Joy', 'Sampleroe'),
    ];

    const result = await runTextNameSpellingCheck({ knex: fakeKnex(rows), now: NOW, readKeepWords: async () => new Set(['joe']) });

    expect(result.checked).toBe(3);
    expect(result.findings).toEqual([{ id: 'sms-1', at: new Date('2026-11-06T15:00:00Z'), fixes: [{ heard: 'Dina', spelled: 'Dena' }] }]);
    expect(retireIfClean).not.toHaveBeenCalled();
    expect(deliverOpsDigest).toHaveBeenCalledTimes(1);
    const sent = deliverOpsDigest.mock.calls[0][0];
    expect(sent).toMatchObject({
      fallOff: true,
      key: OPS_KEY,
      dedupeKey: OPS_KEY,
      refreshOnDedupe: true,
      link: '/admin/communications',
      count: 1,
      itemKeys: ['sms-1'],
    });
    expect(sent.subject).toBe("FIX: 1 staff text spelled the customer's name off the record");
    expect(sent.headline.length).toBeLessThanOrEqual(60);
    expect(sent.summary.length).toBeLessThanOrEqual(110);
    expect(sent.text).toContain('"Dina" for "Dena" (sms_log sms-1)');
    // the row names the words, never the rest of the message
    expect(sent.text).not.toContain('Tuesday');
    expect(result.delivery).toEqual({ ok: true, channel: 'in_app', id: 'n1' });
  });

  test('a read that throws fails the run and never retires the row', async () => {
    const knex = fakeKnex([], { error: new Error('pool exhausted') });

    await expect(runTextNameSpellingCheck({ knex, now: NOW, readKeepWords: noKeep })).rejects.toThrow('pool exhausted');
    expect(retireIfClean).not.toHaveBeenCalled();
    expect(deliverOpsDigest).not.toHaveBeenCalled();
  });

  test('the email fallback goes only to the internal ops inbox, and fails when the mailer is not set up', async () => {
    await runTextNameSpellingCheck({ knex: fakeKnex([text('sms-1', 'Hi Dina!')]), now: NOW, readKeepWords: noKeep });
    const { sendEmail } = deliverOpsDigest.mock.calls[0][0];

    await sendEmail();
    expect(sendgrid.sendOne).toHaveBeenCalledWith(expect.objectContaining({
      to: 'contact@wavespestcontrol.com',
      categories: ['ops', OPS_KEY],
    }));

    sendgrid.sendOne.mockClear();
    sendgrid.isConfigured.mockReturnValue(false);
    await expect(sendEmail()).rejects.toThrow('mailer not configured');
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
  });
});

describe('composeDigest', () => {
  const finding = (i) => ({ id: `sms-${i}`, at: new Date('2026-11-06T15:00:00Z'), fixes: [{ heard: 'Dina', spelled: 'Dena' }] });

  test('lists at most 25 texts and counts the rest; plural wording', () => {
    const composed = composeDigest(Array.from({ length: 27 }, (_, i) => finding(i)));
    expect(composed.subject).toBe("FIX: 27 staff texts spelled the customer's name off the record");
    expect(composed.text.match(/^- /gm)).toHaveLength(25);
    expect(composed.text).toContain('… and 2 more.');
    expect(composed.html).toContain('<li style="margin:0 0 6px 0;">');
    expect(composed.html).toContain('&quot;Dina&quot; for &quot;Dena&quot;');
  });
});

describe('scheduler wiring', () => {
  test('runs nightly at 11:32 PM ET under runExclusive, with a lazy require and a job_health rethrow', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'scheduler.js'), 'utf8');
    const i = src.indexOf("cron.schedule('32 23 * * *'");
    expect(i).toBeGreaterThan(-1);
    const block = src.slice(i, src.indexOf('timezone', i) + 40);
    expect(block).toContain("runExclusive('text-name-spelling-check'");
    expect(block).toContain("require('./text-name-spelling-check')");
    expect(block).toContain('result.delivery.ok === false');
    expect(block).toContain("timezone: 'America/New_York'");
    // #3208 rule. failing-jobs-check.test.js also checks that no fixed or hourly job shares the minute.
    expect(src.match(/cron\.schedule\('32 23 \* \* \*'/g)).toHaveLength(1);
  });
});
