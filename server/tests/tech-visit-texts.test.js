/**
 * Technician Visit Brief texts (GATE_TECH_VISIT_TEXTS, owner 2026-11-26): services/tech-visit-texts.js, the pure
 * verdict + window rules and the sms_log read. Synthetic data only. The route's gate, ownership and payload are in
 * tech-visit-texts-route.test.js.
 */
const { isPaymentScopedText } = require('../services/payment-status-contract');
const { textVerdict, hasMoneyWords, hasCardCredentials, hasLink, hasNumberRun, windowStart, textWindowStart, visitTexts, MAX_TEXTS, MAX_PAGES, PAGE_SIZE } = require('../services/tech-visit-texts');

const inbound = (over = {}) => ({ direction: 'inbound', message_type: 'inbound', status: 'received', message_body: 'The gate code changed', metadata: null, ...over });
const outbound = (over = {}) => ({ direction: 'outbound', message_type: 'manual', admin_user_id: 'staff-1', status: 'sent', message_body: 'We will be there Tuesday', metadata: { human_authored: true }, ...over });

describe('textVerdict', () => {
  test('a plain customer reply and a plain office text show', () => {
    expect(textVerdict(inbound())).toBe('show');
    expect(textVerdict(outbound())).toBe('show');
  });

  test.each([
    'Please send the bill', 'my invoice is wrong', 'you charged me twice', 'is the card on file ok', 'payment sent', 'can I pay Friday',
    'already paid', 'I want a refund', 'what is the price', 'how much does it cost', 'what is my balance', 'I owe you', 'it was $45', 'about 45 dollars',
    'autopay failed', 'Venmo ok?',
  ])('money words hide the text either way: %s', (body) => {
    expect(hasMoneyWords(body)).toBe(true);
    expect(textVerdict(inbound({ message_body: body }))).toBe('hidden');
    expect(textVerdict(outbound({ message_body: body }))).toBe('hidden');
  });

  test('visit words are not money words', () => {
    for (const body of ['please skip the back yard', 'the gate code is 4521', 'dog is out until noon', 'Thursday works']) {
      expect(hasMoneyWords(body)).toBe(false);
    }
  });

  test.each(['receipt', 'invoice', 'invoice_followup', 'payment_failed', 'ach_retry_notice', 'service_complete_paid_receipt', 'card_request', 'estimate_sent', 'internal_alert'])(
    'an outbound %s text is hidden even with a harmless body', (type) => {
      expect(textVerdict(outbound({ message_type: type, message_body: 'Thanks, see you soon' }))).toBe('hidden');
    });

  test('an unknown outbound type, or one with no type, is hidden by default', () => {
    expect(textVerdict(outbound({ message_type: 'brand_new_type_2027' }))).toBe('hidden');
    expect(textVerdict(outbound({ message_type: null }))).toBe('hidden');
    expect(textVerdict(inbound({ message_type: 'brand_new_type_2027' }))).toBe('hidden');
  });

  test('quiet types, unsent texts and empty texts are dropped without a count', () => {
    expect(textVerdict(inbound({ message_type: 'sms_reaction' }))).toBe('skip');
    expect(textVerdict(inbound({ message_type: 'opt_out', message_body: 'STOP' }))).toBe('skip');
    expect(textVerdict(outbound({ message_type: 'appointment_reminder' }))).toBe('skip');
    expect(textVerdict(outbound({ status: 'failed' }))).toBe('skip');
    expect(textVerdict(outbound({ message_body: '  ' }))).toBe('skip');
    expect(textVerdict(inbound({ message_body: '' }))).toBe('skip');
  });

  test('a photo with no words shows only with the photo switch on, and only as an allowed image type', () => {
    const media = (contentType) => JSON.stringify({ media: [{ key: 'sms-media/inbound/a', contentType }] });
    const on = { withPhotos: true };
    expect(textVerdict(inbound({ message_body: '', metadata: media('image/jpeg') }))).toBe('skip');
    expect(textVerdict(inbound({ message_body: '', metadata: media('image/jpeg') }), on)).toBe('show');
    expect(textVerdict(inbound({ message_body: '', metadata: media('image/heic') }), on)).toBe('show');
    expect(textVerdict(inbound({ message_body: '', metadata: media('application/pdf') }), on)).toBe('skip');
    expect(textVerdict(inbound({ message_body: '', metadata: media(null) }), on)).toBe('skip');
    expect(textVerdict(inbound({ message_body: 'Brown patch by the gate', metadata: media('image/jpeg') }))).toBe('show');
  });

  test('a photo whose caption a screen hides stays hidden with its row, switch on or off', () => {
    const metadata = JSON.stringify({ media: [{ key: 'sms-media/inbound/a', contentType: 'image/jpeg' }] });
    for (const body of ['here is my card 4111 1111 1111 1111', 'pay with this', 'see https://example.com/x', 'cvv 123']) {
      expect(textVerdict(inbound({ message_body: body, metadata }), { withPhotos: true })).toBe('hidden');
      expect(textVerdict(inbound({ message_body: body, metadata }))).toBe('hidden');
    }
  });

  test('an outbound text shows only in a state that reached the customer (allow-list, normalized)', () => {
    for (const status of ['sent', 'SENT', 'delivered', 'queued', 'accepted', 'read']) expect(textVerdict(outbound({ status }))).toBe('show');
    for (const status of ['', null, undefined, '  ', 'failed', 'undelivered', 'held', 'draft', 'skipped', 'suppressed', 'new_status_2027']) expect(textVerdict(outbound({ status }))).toBe('skip');
  });

  test('an inbound text a spam screen enforced is neither shown nor counted', () => {
    expect(textVerdict(inbound({ metadata: { spam_verdict: { enforced: true } } }))).toBe('skip');
    expect(textVerdict(inbound({ metadata: JSON.stringify({ spam_verdict: { enforced: true } }) }))).toBe('skip');
    expect(textVerdict(inbound({ metadata: { spam_verdict: { enforced: false } } }))).toBe('show');
  });

  test('a payment-scoped text is hidden even with none of the plain money words', () => {
    expect(isPaymentScopedText('did my autopay go through')).toBe(true);
    expect(textVerdict(inbound({ message_body: 'did my autopay go through' }))).toBe('hidden');
    expect(textVerdict(outbound({ message_body: 'Your statement is ready' }))).toBe(isPaymentScopedText('Your statement is ready') ? 'hidden' : 'show');
  });

  test.each([
    '4111 1111 1111 1111', '4111111111111111', 'the number is 5555-5555-5555-4444', 'cvv 123', 'security code is 456', 'expires 08/27',
    'my routing is 021000021', 'account number 123456789', 'acct # 99887766', 'checking acct 12345678', 'account 12345678', 'acct: 998877', 'savings 123456789', '021000021', 'checking account 1234 5678', 'bank acct 1234-5678-90', 'account 123 456 789',
    'Exp: 08/27', 'exp 8/2027', 'valid thru 08/27', '4111\u20131111\u20131111\u20131111', '4111\u20111111\u20111111\u20111111', '123-45-6789', '123\u201345\u20136789',
  ])('a card or bank detail hides the whole text even with no money word: %s', (body) => {
    expect(hasCardCredentials(body)).toBe(true);
    expect(textVerdict(inbound({ message_body: body }))).toBe('hidden');
    expect(textVerdict(outbound({ message_body: body }))).toBe('hidden');
  });

  test.each([
    'https://example.com/r/abc123', 'http://x.test/pick', 'www.example.com/pick', 'wavespestcontrol.com/reschedule/abc', 'tap bit.ly/3xyz to move your visit', 'go to example.co/r/1', 'is.gd/abc', 'rb.gy/x1', 'tiny.cc/z9', 'tap v.gd/abc', 'cutt.ly/q', 'Pick a time: s.id/abc', 'photos.example.dev/yard', 'see photos.example.dev', 'upload to cloud.example.photography/x', 'foo.co.uk/pick',
  ])('a text with a link is hidden, so no customer-action link reaches a technician: %s', (body) => {
    expect(hasLink(body)).toBe(true);
    expect(textVerdict(outbound({ message_type: 'appointment_rescheduled', message_body: body }))).toBe('hidden');
    expect(textVerdict(outbound({ message_type: 'rain_out_customer_pick_v1', message_body: body }))).toBe('hidden');
  });

  test('an app push record in sms_log is neither shown nor counted', () => {
    expect(textVerdict(outbound({ message_type: 'appointment_cancelled', from_phone: 'push', message_body: 'Your visit moved to Thursday' }))).toBe('skip');
    expect(textVerdict(outbound({ message_type: 'manual', metadata: { channel: 'push' } }))).toBe('skip');
    expect(textVerdict(outbound({ message_type: 'appointment_cancelled', from_phone: '+19415550100', message_body: 'Your visit moved to Thursday' }))).toBe('show');
  });

  test.each([
    'My verification code is 123456', 'your Google code is 482913', 'bank code 553311', 'login code: 884422', 'sign-in code 112233', 'use passcode 9988',
    'the code to log in is 4455', 'My OTP is 123456', 'otp: 889900', 'my password is hunter2', 'PIN is 4821',
  ])('a sign-in or verification code hides the whole row, photos with it: %s', (body) => {
    const metadata = { media: [{ key: 'sms-media/inbound/a', contentType: 'image/jpeg' }] };
    expect(hasCardCredentials(body)).toBe(true);
    expect(textVerdict(inbound({ message_body: body, metadata }), { withPhotos: true })).toBe('hidden');
    expect(textVerdict(outbound({ message_body: body }))).toBe('hidden');
  });

  test.each([
    'the gate code is 1234', 'gate code is 1234, side door 5566', 'garage code 7788 please', 'use the keypad at the gate, code 2468', 'code 12 34', 'code 1-2-3',
    'code 1.2.3.4', '\uff11\uff12\uff13\uff14', 'we are at 123 Palm Ave', 'call 941 555 0100', 'ZIP 34205', 'arrive 1030am',
  ])('a text with a number of 3 or more digits is hidden, either direction: %s', (body) => {
    expect(hasNumberRun(body)).toBe(true);
    expect(textVerdict(inbound({ message_body: body }))).toBe('hidden');
    expect(textVerdict(outbound({ message_body: body }))).toBe('hidden');
  });

  test.each([
    'see you at 10:30 on 11/26', 'see you 9:15 am', 'Tuesday 11/26/2026 works', 'Nov 26 works for us', 'December 3rd is fine', '2 dogs in the yard', 'only 12 minutes',
    'the 2nd gate', 'we have 3 cats and 2 dogs',
  ])('a time, a date or a small count is not a credential and shows: %s', (body) => {
    expect(hasNumberRun(body)).toBe(false);
    expect(textVerdict(inbound({ message_body: body }))).toBe('show');
  });

  test.each(['All done.Thanks', 'Finished the front.Please call', 'Tuesday works.See you then', 'dogs are out.Ok'])(
    'prose with a dot and no space is not a link: %s', (body) => {
      expect(hasLink(body)).toBe(false);
    });

  test('a manual text shows with the composer stamp or as a technician\'s own text from his line; a staff id alone is skipped', () => {
    const TECH_LINE = require('../config/twilio-numbers').fieldTech[0].number;
    expect(textVerdict(outbound({ message_body: 'We will be there Tuesday' }))).toBe('show'); // human_authored
    // what the tech-line composer leaves on the row today: manual, his id, his line, no metadata mark
    expect(textVerdict(outbound({ admin_user_id: 'tech-1', from_phone: TECH_LINE, metadata: { scheduled_service_id: 'svc-1' } }))).toBe('show');
    expect(textVerdict(outbound({ admin_user_id: 'tech-1', from_phone: TECH_LINE, metadata: null }))).toBe('show');
    // an automated manual send from that line has no sender id; a sender id from an ordinary number is not enough
    expect(textVerdict(outbound({ admin_user_id: null, from_phone: TECH_LINE, metadata: null }))).toBe('skip');
    expect(textVerdict(outbound({ admin_user_id: 'staff-1', from_phone: '+19415550100', metadata: null }))).toBe('skip');
    expect(textVerdict(outbound({ admin_user_id: 'staff-1', metadata: { human_authored: 'true' } }))).toBe('skip');
    expect(textVerdict(outbound({ admin_user_id: null, metadata: JSON.stringify({ human_authored: false }), message_body: 'Spring special for you' }))).toBe('skip');
    expect(textVerdict(outbound({ message_type: 'ai_approved', admin_user_id: null, metadata: null }))).toBe('show');
    // a tech-line text still goes through every other screen
    expect(textVerdict(outbound({ admin_user_id: 'tech-1', from_phone: TECH_LINE, metadata: null, message_body: 'Your balance is due' }))).toBe('hidden');
  });

  test("a customer's handled reschedule reply (retyped by the webhook) shows", () => {
    expect(textVerdict(inbound({ message_type: 'reschedule_reply', message_body: 'Thursday morning works' }))).toBe('show');
  });

  test('an ordinary number is not a card number, but the number rule still hides it', () => {
    expect(hasCardCredentials('gate code 4521, call 941 555 0100')).toBe(false);
    expect(textVerdict(inbound({ message_body: 'gate code is 4521' }))).toBe('hidden');
  });

  test('a tapback stored as an ordinary inbound is dropped, never shown or counted', () => {
    expect(textVerdict(inbound({ message_body: 'Liked \u201cWe will be there Tuesday\u201d' }))).toBe('skip');
    expect(textVerdict(inbound({ message_body: 'Loved \u201cYour balance is due\u201d' }))).toBe('skip');
  });
});

describe('windowStart', () => {
  test('is ET midnight 7 calendar days before the visit date, DST aware', () => {
    expect(windowStart('2026-11-26').toISOString()).toBe('2026-11-19T05:00:00.000Z'); // EST
    expect(windowStart('2026-11-03').toISOString()).toBe('2026-10-27T04:00:00.000Z'); // EDT, date crosses the Nov 1 change
    expect(windowStart('2026-03-12').toISOString()).toBe('2026-03-05T05:00:00.000Z'); // EST start, EDT visit
    expect(windowStart(new Date('2026-11-26T00:00:00Z')).toISOString()).toBe('2026-11-19T05:00:00.000Z');
  });
  test('no date, no window', () => {
    expect(windowStart(null)).toBeNull();
  });
});

// service_records stub for the last-visit read: records the predicates and returns { last } (or throws).
function lastVisitDb(last, { fail = false, visitLast = null, failVisits = false } = {}) {
  const seen = { where: [], raw: [], tables: [], visitWhere: [] };
  const db = (table) => {
    seen.tables.push(table);
    if (table === 'service_records') seen.table = table;
    const isVisits = table === 'scheduled_services';
    const q = {
      where: (...a) => { (isVisits ? seen.visitWhere : seen.where).push(a); return q; },
      whereRaw: (sql) => { seen.raw.push(sql); return q; },
      max: () => q,
      first: async () => {
        if (isVisits) { if (failVisits) throw new Error('read failed'); return { last: visitLast }; }
        if (fail) throw new Error('read failed');
        return { last };
      },
    };
    return q;
  };
  db.seen = seen;
  return db;
}

describe('textWindowStart (owner 2026-11-27: since the last visit, or 7 days back)', () => {
  const svc = { customer_id: 'cust-1', scheduled_date: '2026-11-26' };
  test('starts at ET midnight of the last completed visit when that is more than 7 days back', async () => {
    const db = lastVisitDb('2026-10-20');
    expect((await textWindowStart(db, svc)).toISOString()).toBe('2026-10-20T04:00:00.000Z'); // EDT midnight
    expect(db.seen.table).toBe('service_records');
    expect(db.seen.where).toEqual(expect.arrayContaining([['customer_id', 'cust-1'], ['service_date', '<', '2026-11-26']]));
    expect(db.seen.raw.join(' ')).toMatch(/COALESCE\(status, 'completed'\) = 'completed'/);
  });
  test('a last visit inside the 7 days keeps the 7-day start', async () => {
    expect((await textWindowStart(lastVisitDb('2026-11-24'), svc)).toISOString()).toBe('2026-11-19T05:00:00.000Z');
  });
  test('no earlier visit, or a failed read, keeps the 7-day start', async () => {
    expect((await textWindowStart(lastVisitDb(null), svc)).toISOString()).toBe('2026-11-19T05:00:00.000Z');
    expect((await textWindowStart(lastVisitDb('2026-10-01', { fail: true }), svc)).toISOString()).toBe('2026-11-19T05:00:00.000Z');
  });
  test('a completed appointment with no record counts; the later of the two days wins', async () => {
    const db = lastVisitDb(null, { visitLast: '2026-10-25' });
    expect((await textWindowStart(db, svc)).toISOString()).toBe('2026-10-25T04:00:00.000Z');
    expect(db.seen.visitWhere).toEqual(expect.arrayContaining([['customer_id', 'cust-1'], ['status', 'completed'], ['scheduled_date', '<', '2026-11-26']]));
    expect((await textWindowStart(lastVisitDb('2026-10-10', { visitLast: '2026-10-25' }), svc)).toISOString()).toBe('2026-10-25T04:00:00.000Z');
    expect((await textWindowStart(lastVisitDb('2026-10-25', { visitLast: '2026-10-10' }), svc)).toISOString()).toBe('2026-10-25T04:00:00.000Z');
  });
  test('either read failing keeps the 7-day start', async () => {
    expect((await textWindowStart(lastVisitDb('2026-10-20', { failVisits: true }), svc)).toISOString()).toBe('2026-11-19T05:00:00.000Z');
    expect((await textWindowStart(lastVisitDb(null, { fail: true, visitLast: '2026-10-20' }), svc)).toISOString()).toBe('2026-11-19T05:00:00.000Z');
    expect((await textWindowStart(lastVisitDb(null, { fail: true, failVisits: true }), svc)).toISOString()).toBe('2026-11-19T05:00:00.000Z');
  });
  test('never reaches more than 120 days back', async () => {
    expect((await textWindowStart(lastVisitDb('2025-06-01'), svc)).toISOString()).toBe('2026-07-29T04:00:00.000Z');
  });
  test('a pg DATE object as the last visit reads as its calendar day', async () => {
    expect((await textWindowStart(lastVisitDb(new Date('2026-10-20T00:00:00Z')), svc)).toISOString()).toBe('2026-10-20T04:00:00.000Z');
  });
});

// A tiny sms_log: applies the customer, the created_at bounds, the order, the limit and the offset the service asks for.
// The raw-SQL pieces (provider twin, recruiting and reservation filters) are only recorded; withoutQueueParents covers the twin in JS.
const col = (name) => String(name).replace(/^sl\./, '');
function fakeDb(rows, { tables = {}, failTable = null } = {}) {
  const calls = { selects: 0, tables: [], raw: 0 };
  const sub = () => {
    const b = {};
    for (const m of ['select', 'from', 'where', 'whereRaw', 'whereNull', 'orWhere', 'whereNotExists']) b[m] = (...args) => { if (m === 'whereRaw') calls.raw += 1; if (typeof args[0] === 'function') args[0].call(b, b); return b; };
    b.modify = (cb) => { cb(b); return b; };
    return b;
  };
  // property_preferences / customer_access_codes: the stored codes the reader matches against
  const other = (table) => {
    const q = { where: () => q, whereNotNull: () => q, whereRaw: () => q, max: () => q,
      first: async () => ({ last: tables.service_records_last || null }),
      select: async () => { if (failTable === table) throw new Error('read failed'); return tables[table] || []; } };
    return q;
  };
  const db = (table) => {
    calls.tables.push(table);
    if (!String(table).startsWith('sms_log')) return other(table);
    let list = rows.slice();
    let skip = 0;
    let max = Infinity;
    const orders = [];
    const q = {
      where(a, op, val) {
        if (typeof a === 'function') { a.call(sub(), sub()); return q; }
        if (typeof a === 'object') list = list.filter((r) => Object.entries(a).every(([k, v]) => r[col(k)] === v));
        else if (op === '>=') list = list.filter((r) => r[col(a)] >= val);
        else if (op === '<=') list = list.filter((r) => r[col(a)] <= val);
        else list = list.filter((r) => r[col(a)] === op);
        return q;
      },
      whereNotExists(cb) { cb.call(sub(), sub()); return q; },
      whereRaw() { calls.raw += 1; return q; },
      orderBy(c, dir) { orders.push([col(c), dir === 'desc' ? -1 : 1]); return q; },
      limit(n) { max = n; return q; },
      offset(n) { skip = n; return q; },
      select() {
        calls.selects += 1;
        // every orderBy clause as one comparator, in the order given (created_at first, id as the tie-break)
        const sorted = list.slice().sort((x, y) => {
          for (const [k, dir] of orders) {
            if (x[k] < y[k]) return -dir;
            if (x[k] > y[k]) return dir;
          }
          return 0;
        });
        return Promise.resolve(sorted.slice(skip, skip + max));
      },
    };
    return q;
  };
  db.calls = calls;
  return db;
}

const row = (id, at, over = {}) => ({ id, customer_id: 'cust-1', direction: 'inbound', message_type: 'inbound', status: 'received', message_body: `text ${id}`, metadata: null, created_at: new Date(at), ...over });
const SVC = { id: 'svc-1', customer_id: 'cust-1', scheduled_date: '2026-11-26' };
const NOW = new Date('2026-11-27T12:00:00Z');

describe('visitTexts', () => {
  test('window bounds, oldest first, one customer only, hidden counted', async () => {
    const db = fakeDb([
      row('before', '2026-11-19T04:59:59Z'),
      row('edge', '2026-11-19T05:00:00Z'),
      row('mid', '2026-11-22T15:00:00Z', { direction: 'outbound', message_type: 'manual', admin_user_id: 'staff-1', status: 'sent', metadata: { human_authored: true } }),
      row('money', '2026-11-23T15:00:00Z', { message_body: 'what is my balance' }),
      row('invoice', '2026-11-24T15:00:00Z', { direction: 'outbound', message_type: 'invoice', status: 'sent' }),
      row('late', '2026-11-27T12:00:01Z'),
      row('other', '2026-11-22T16:00:00Z', { customer_id: 'cust-2' }),
    ]);
    const out = await visitTexts(db, SVC, { now: NOW, sign: async () => [] });
    expect(out.texts.map((t) => t.id)).toEqual(['edge', 'mid']);
    expect(out.hidden).toBe(2);
    expect(JSON.stringify(out)).not.toMatch(/balance/);
    expect(Object.keys(out.texts[0]).sort()).toEqual(['at', 'body', 'direction', 'id', 'photoCount', 'photos']);
    expect(db.calls.tables).toContain('sms_log as sl');
    expect(db.calls.raw).toBeGreaterThan(0); // the provider-twin, recruiting and reservation filters were applied
  });

  test('caps at 40, keeping the newest, oldest first', async () => {
    const rows = Array.from({ length: 55 }, (_, i) => row(`r${String(i).padStart(2, '0')}`, `2026-11-2${i % 2}T${String(i % 24).padStart(2, '0')}:00:00Z`, { created_at: new Date(Date.UTC(2026, 10, 20, 0, i)) }));
    const out = await visitTexts(fakeDb(rows), SVC, { now: NOW, sign: async () => [] });
    expect(out.texts).toHaveLength(MAX_TEXTS);
    expect(out.texts[0].id).toBe('r15');
    expect(out.texts[MAX_TEXTS - 1].id).toBe('r54');
  });

  test('a run of reminders newer than a customer instruction does not push it out of view', async () => {
    const reminders = Array.from({ length: 250 }, (_, i) => row(`rem${String(i).padStart(3, '0')}`, '2026-11-22T00:00:00Z', { direction: 'outbound', message_type: 'appointment_reminder', status: 'sent', created_at: new Date(Date.UTC(2026, 10, 22, 12, 0, 250 - i)) }));
    const instruction = row('ask', '2026-11-21T12:00:00Z', { message_body: 'please skip the back yard' });
    const db = fakeDb([...reminders, instruction]);
    const out = await visitTexts(db, SVC, { now: NOW, sign: async () => [] });
    expect(out.texts.map((t) => t.id)).toEqual(['ask']);
    expect(out.hidden).toBe(0);
    expect(db.calls.selects).toBe(2);
  });

  test('paging is bounded, and hidden is counted across every page read', async () => {
    const many = Array.from({ length: PAGE_SIZE * MAX_PAGES + 50 }, (_, i) => row(`m${i}`, '2026-11-22T00:00:00Z', { message_body: 'what is my balance', created_at: new Date(Date.UTC(2026, 10, 22, 0, 0, 0) + i * 1000) }));
    const db = fakeDb(many);
    const out = await visitTexts(db, SVC, { now: NOW, sign: async () => [] });
    expect(db.calls.selects).toBe(MAX_PAGES);
    expect(out.hidden).toBe(PAGE_SIZE * MAX_PAGES);
    expect(out.texts).toEqual([]);
  });

  test('a scheduled send left as a queue parent and a provider row shows once', async () => {
    const parent = row('parent', '2026-11-22T15:00:00Z', { direction: 'outbound', message_type: 'manual', admin_user_id: 'staff-1', status: 'sent', message_body: 'We will be there Tuesday', metadata: { human_authored: true } });
    const twin = row('twin', '2026-11-22T15:00:05Z', { direction: 'outbound', message_type: 'manual', admin_user_id: 'staff-1', status: 'sent', message_body: 'We will be there Tuesday', metadata: JSON.stringify({ human_authored: true, scheduled_sms_log_id: 'parent' }) });
    const out = await visitTexts(fakeDb([parent, twin]), SVC, { now: NOW });
    expect(out.texts.map((t) => t.id)).toEqual(['twin']);
  });

  test('a photo with no words shows as an image only when photos are on; hidden caption rows never sign', async () => {
    const sign = jest.fn(async (items) => items.map((m) => ({ ...m, url: `https://signed.example/${m.key}` })));
    const img = (k) => ({ media: [{ key: `sms-media/inbound/${k}`, contentType: 'image/jpeg' }] });
    const rows = [
      row('bare', '2026-11-22T15:00:00Z', { message_body: '', metadata: img('bare') }),
      row('card', '2026-11-22T16:00:00Z', { message_body: 'my card 4111 1111 1111 1111', metadata: img('card') }),
    ];
    const on = await visitTexts(fakeDb(rows), SVC, { now: NOW, sign, withPhotos: true });
    expect(on.texts.map((t) => t.id)).toEqual(['bare']);
    expect(on.texts[0]).toMatchObject({ body: '', photoCount: 1, photos: [{ url: 'https://signed.example/sms-media/inbound/bare', contentType: 'image/jpeg' }] });
    expect(on.hidden).toBe(1);
    expect(sign).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(on)).not.toMatch(/card|4111/);
    const off = await visitTexts(fakeDb(rows), SVC, { now: NOW, sign });
    expect(off.texts).toEqual([]);
    expect(off.hidden).toBe(1);
  });

  test('photos: off by default, so no photo is ever signed and the count says so', async () => {
    const sign = jest.fn();
    const r = row('p0', '2026-11-22T15:00:00Z', { message_body: 'Brown patch', metadata: { media: [{ key: 'sms-media/inbound/a', contentType: 'image/jpeg' }] } });
    const out = await visitTexts(fakeDb([r]), SVC, { now: NOW, sign });
    expect(sign).not.toHaveBeenCalled();
    expect(out.texts[0]).toMatchObject({ photos: [], photoCount: 1 });
  });

  test('a document is never signed, and only an image is', async () => {
    const media = [
      { key: 'sms-media/inbound/pic', contentType: 'image/png' },
      { key: 'sms-media/inbound/doc', contentType: 'application/pdf' },
    ];
    const sign = jest.fn(async (items) => items.map((m) => ({ ...m, url: `https://signed.example/${m.key}` })));
    const out = await visitTexts(fakeDb([row('both', '2026-11-22T16:00:00Z', { message_body: 'Brown patch', metadata: { media } })]), SVC, { now: NOW, sign, withPhotos: true });
    expect(out.texts[0].photos).toEqual([{ url: 'https://signed.example/sms-media/inbound/pic', contentType: 'image/png' }]);
    expect(out.texts[0].photoCount).toBe(1);
    expect(sign).toHaveBeenCalledTimes(1);
    expect(sign).toHaveBeenCalledWith([media[0]]);
  });

  test('owner 2026-11-27: a last visit more than 7 days back starts the texts there; older texts stay out', async () => {
    const rows = [
      row('before', '2026-10-19T15:00:00Z', { message_body: 'before the last visit' }),
      row('after', '2026-10-21T15:00:00Z', { message_body: 'ants came back in the kitchen' }),
      row('recent', '2026-11-24T15:00:00Z', { message_body: 'see you thursday' }),
    ];
    const out = await visitTexts(fakeDb(rows, { tables: { service_records_last: '2026-10-20' } }), SVC, { now: NOW, sign: async () => [] });
    expect(out.since).toBe('2026-10-20');
    expect(out.texts.map((t) => t.id)).toEqual(['after', 'recent']);
  });

  test('a tapback in the window is neither shown nor counted', async () => {
    const out = await visitTexts(fakeDb([row('tap', '2026-11-22T15:00:00Z', { message_body: 'Liked \u201cWe will be there Tuesday\u201d' })]), SVC, { now: NOW, sign: async () => [] });
    expect(out).toEqual({ texts: [], hidden: 0, since: '2026-11-19' });
  });

  test('photos: only a stored key is linked; a failed signature never falls back to a stored url or a provider url', async () => {
    const media = [
      { key: 'sms-media/inbound/a', url: 'https://old.example/a', providerUrl: 'https://api.twilio.com/x/Media/1', contentType: 'image/jpeg' },
      { providerUrl: 'https://api.twilio.com/x/Media/2', contentType: 'image/jpeg' },
    ];
    const ok = jest.fn(async (items) => items.map((m) => ({ ...m, url: 'https://signed.example/a?sig=1' })));
    // the real signer's failure path: url || providerUrl || null
    const failed = jest.fn(async (items) => items.map((m) => ({ ...m, url: m.url || m.providerUrl || null })));
    const db = (table) => fakeDb([row('p1', '2026-11-22T15:00:00Z', { message_body: 'Brown patch', metadata: { media } })])(table);
    const good = await visitTexts(db, SVC, { now: NOW, sign: ok, withPhotos: true });
    expect(ok).toHaveBeenCalledWith([{ key: 'sms-media/inbound/a', contentType: 'image/jpeg' }]);
    expect(good.texts[0].photos).toEqual([{ url: 'https://signed.example/a?sig=1', contentType: 'image/jpeg' }]);
    const bad = await visitTexts(db, SVC, { now: NOW, sign: failed, withPhotos: true });
    expect(bad.texts[0].photos).toEqual([]);
    expect(JSON.stringify(bad)).not.toMatch(/twilio|old\.example/);
  });

  test('an OTP or password row never has its photo signed, even with photos on', async () => {
    const sign = jest.fn(async (items) => items.map((m) => ({ ...m, url: `https://signed.example/${m.key}` })));
    const img = { media: [{ key: 'sms-media/inbound/otp', contentType: 'image/jpeg' }] };
    const rows = [
      row('otp', '2026-11-22T15:00:00Z', { message_body: 'My OTP is 123456', metadata: img }),
      row('patch', '2026-11-22T16:00:00Z', { message_body: 'Brown patch by the gate', metadata: { media: [{ key: 'sms-media/inbound/patch', contentType: 'image/jpeg' }] } }),
    ];
    const out = await visitTexts(fakeDb(rows), SVC, { now: NOW, sign, withPhotos: true });
    expect(out.texts.map((t) => t.id)).toEqual(['patch']);
    expect(out.hidden).toBe(1);
    expect(sign).toHaveBeenCalledTimes(1);
    expect(sign).toHaveBeenCalledWith([{ key: 'sms-media/inbound/patch', contentType: 'image/jpeg' }]);
    expect(JSON.stringify(out)).not.toMatch(/123456|otp/i);
  });

  test('an image whose upload left no stored key is counted, never signed; a photo-only row still reports it', async () => {
    const sign = jest.fn();
    const noKey = { media: [{ providerUrl: 'https://api.twilio.com/x/Media/1', contentType: 'image/jpeg' }] };
    const rows = [
      row('z-cap', '2026-11-22T15:00:00Z', { message_body: 'Brown patch by the gate', metadata: noKey }),
      row('y-bare', '2026-11-22T16:00:00Z', { message_body: '', metadata: noKey }),
    ];
    const out = await visitTexts(fakeDb(rows), SVC, { now: NOW, sign, withPhotos: true });
    expect(out.texts.map((t) => ({ id: t.id, photos: t.photos, photoCount: t.photoCount }))).toEqual([
      { id: 'z-cap', photos: [], photoCount: 1 },
      { id: 'y-bare', photos: [], photoCount: 1 },
    ]);
    expect(sign).not.toHaveBeenCalled();
    expect(JSON.stringify(out)).not.toMatch(/twilio/);
  });

  test('a card number sent four digits at a time: every contributing text is hidden with its photo; a gate code is hidden too', async () => {
    const sign = jest.fn(async (items) => items.map((m) => ({ ...m, url: `https://signed.example/${m.key}` })));
    const img = (k) => ({ media: [{ key: `sms-media/inbound/${k}`, contentType: 'image/jpeg' }] });
    const parts = ['4111', '1111', '1111', '1111'];
    const rows = [
      ...parts.map((digits, i) => row(`c${i}`, `2026-11-22T1${i}:00:00Z`, { message_body: digits, metadata: img(`c${i}`) })),
      row('after', '2026-11-23T10:00:00Z', { message_body: 'see you Tuesday' }),
      row('gate', '2026-11-23T11:00:00Z', { message_body: 'the gate code is 1234' }),
    ];
    const out = await visitTexts(fakeDb(rows), SVC, { now: NOW, sign, withPhotos: true });
    expect(out.texts.map((t) => t.id)).toEqual(['after']);
    expect(out.hidden).toBe(5);
    expect(sign).not.toHaveBeenCalled();
    expect(JSON.stringify(out)).not.toMatch(/4111|1111|1234/);
  });

  test('a card number split across four texts in full-width digits is hidden, photos never signed', async () => {
    const sign = jest.fn();
    const img = (k) => ({ media: [{ key: `sms-media/inbound/${k}`, contentType: 'image/jpeg' }] });
    const parts = ['\uff14\uff11\uff11\uff11', '\uff11\uff11\uff11\uff11', '\uff11\uff11\uff11\uff11', '\uff11\uff11\uff11\uff11'];
    const rows = parts.map((digits, i) => row(`f${i}`, `2026-11-22T1${i}:00:00Z`, { message_body: digits, metadata: img(`f${i}`) }));
    const out = await visitTexts(fakeDb(rows), SVC, { now: NOW, sign, withPhotos: true });
    expect(out).toEqual({ texts: [], hidden: 4, since: '2026-11-19' });
    expect(sign).not.toHaveBeenCalled();
  });

  test('a one or two digit reply right after a text a credential screen held back is hidden; a plain count is not', async () => {
    const rows = [
      row('a1', '2026-11-22T10:00:00Z', { message_body: 'my verification code is' }),
      row('a2', '2026-11-22T10:01:00Z', { message_body: '48' }),
      row('a3', '2026-11-22T10:02:00Z', { message_body: '1' }),
      row('b1', '2026-11-22T11:00:00Z', { message_body: 'how many dogs do you need to know about' }),
      row('b2', '2026-11-22T11:01:00Z', { message_body: '2' }),
      row('c1', '2026-11-22T12:00:00Z', { message_body: 'my code is' }),
      row('c2', '2026-11-22T12:01:00Z', { message_body: '481' }),
    ];
    const out = await visitTexts(fakeDb(rows), SVC, { now: NOW, sign: async () => [] });
    expect(out.texts.map((t) => t.id)).toEqual(['b1', 'b2', 'c1']);
    expect(out.hidden).toBe(4); // a1 (verification code), a2 + a3 (short replies after it), c2 (3 digits)
    expect(JSON.stringify(out)).not.toMatch(/481|"48"/);
  });

  test('a text with one of the customer\'s stored codes, for any property, is hidden with its photo, whatever the case', async () => {
    const sign = jest.fn();
    const stored = { property_preferences: [{ lockbox_code: 'ABCD' }, { neighborhood_gate_code: 'Blue' }], customer_access_codes: [{ code: 'Pelican' }] };
    const img = { media: [{ key: 'sms-media/inbound/x', contentType: 'image/jpeg' }] };
    const rows = [
      row('s1', '2026-11-22T10:00:00Z', { message_body: 'the lockbox is abcd' }),
      row('s2', '2026-11-22T11:00:00Z', { message_body: 'gate is BLUE', metadata: img }),
      row('s3', '2026-11-22T12:00:00Z', { message_body: 'try pelican' }),
      row('s4', '2026-11-22T13:00:00Z', { message_body: 'the dogs are friendly' }),
    ];
    const out = await visitTexts(fakeDb(rows, { tables: stored }), SVC, { now: NOW, sign, withPhotos: true });
    expect(out.texts.map((t) => t.id)).toEqual(['s4']);
    expect(out.hidden).toBe(3);
    expect(sign).not.toHaveBeenCalled();
    expect(JSON.stringify(out)).not.toMatch(/abcd|blue|pelican/i);
  });

  test.each(['customer_access_codes', 'property_preferences'])('a failed read of the stored codes (%s) answers unavailable: no text read, shown or signed', async (failTable) => {
    const sign = jest.fn();
    const rows = [row('f1', '2026-11-22T10:00:00Z', { message_body: 'the dogs are friendly' })];
    const db = fakeDb(rows, { failTable });
    const out = await visitTexts(db, SVC, { now: NOW, sign, withPhotos: true });
    expect(out).toEqual({ unavailable: true, texts: [], hidden: 0 });
    expect(db.calls.tables.some((t) => String(t).startsWith('sms_log'))).toBe(false);
    expect(sign).not.toHaveBeenCalled();
  });

  test('a stored code stands alone at either edge or beside punctuation: short codes hidden, a 1-character code ignored', async () => {
    const stored = { property_preferences: [{ garage_code: '12' }, { lockbox_code: 'ab7' }, { property_gate_code: 'Blue' }, { neighborhood_gate_code: 'x' }], customer_access_codes: [] };
    const hiddenBodies = ['gate is 12.', 'it is 12, ok', 'use 12!', '(ab7)', 'try "ab7"', "the 'blue' one", 'BLUE?', '12', 'ab7)', 'code: (12)', 'gate is \u0661\u0662.'];
    const shownBodies = ['I have x dogs', 'bring 120 feet of hose'.replace('120', 'two'), 'the blueberry bush', 'flab7ulous', 'abc12def', 'dogs are fine'];
    const rows = [
      ...hiddenBodies.map((body, i) => row(`h${String(i).padStart(2, '0')}`, `2026-11-22T10:${String(i).padStart(2, '0')}:00Z`, { message_body: body })),
      ...shownBodies.map((body, i) => row(`s${i}`, `2026-11-23T10:${String(i).padStart(2, '0')}:00Z`, { message_body: body })),
    ];
    const out = await visitTexts(fakeDb(rows, { tables: stored }), SVC, { now: NOW, sign: async () => [] });
    expect(out.texts.map((t) => t.body)).toEqual(shownBodies);
    expect(out.hidden).toBe(hiddenBodies.length);
  });

  test('digits of any script are read as digits: Arabic-Indic, Devanagari and full-width runs, and a card split across texts', async () => {
    const arabic = '\u0661\u0662\u0663\u0664';
    const devanagari = '\u0967\u0968\u0969\u096a';
    expect(hasNumberRun(arabic)).toBe(true);
    expect(hasNumberRun(devanagari)).toBe(true);
    expect(hasNumberRun('\u0661 \u0662-\u0663')).toBe(true);
    expect(hasNumberRun('\u0662 dogs')).toBe(false);
    expect(textVerdict(inbound({ message_body: `gate ${arabic}` }))).toBe('hidden');
    const sign = jest.fn();
    const card = ['\u0664\u0661\u0661\u0661', '\u0661\u0661\u0661\u0661', '\u0661\u0661\u0661\u0661', '\u0661\u0661\u0661\u0661'];
    const rows = card.map((digits, i) => row(`d${i}`, `2026-11-22T1${i}:00:00Z`, { message_body: digits, metadata: { media: [{ key: `sms-media/inbound/d${i}`, contentType: 'image/jpeg' }] } }));
    const out = await visitTexts(fakeDb(rows), SVC, { now: NOW, sign, withPhotos: true });
    expect(out).toEqual({ texts: [], hidden: 4, since: '2026-11-19' });
    expect(sign).not.toHaveBeenCalled();
  });

  test('ties and order: created_at decides first, id breaks a tie, never the id alone', async () => {
    const rows = [
      row('z-old', '2026-11-22T10:00:00Z', { message_body: 'first' }),
      row('a-new', '2026-11-22T12:00:00Z', { message_body: 'last' }),
      row('b-tie', '2026-11-22T11:00:00Z', { message_body: 'tie b' }),
      row('c-tie', '2026-11-22T11:00:00Z', { message_body: 'tie c' }),
    ];
    const out = await visitTexts(fakeDb(rows), SVC, { now: NOW, sign: async () => [] });
    expect(out.texts.map((t) => t.id)).toEqual(['z-old', 'b-tie', 'c-tie', 'a-new']);
  });

  test('a visit with no customer reads nothing', async () => {
    const db = jest.fn();
    expect(await visitTexts(db, { ...SVC, customer_id: null })).toEqual({ texts: [], hidden: 0 });
    expect(db).not.toHaveBeenCalled();
  });
});
