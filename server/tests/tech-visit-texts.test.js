/**
 * Technician Visit Brief texts (GATE_TECH_VISIT_TEXTS, owner 2026-11-26): services/tech-visit-texts.js, the pure
 * verdict + window rules and the sms_log read. Synthetic data only. The route's gate, ownership and payload are in
 * tech-visit-texts-route.test.js.
 */
const { textVerdict, hasMoneyWords, hasCardCredentials, windowStart, visitTexts, MAX_TEXTS, MAX_PAGES, PAGE_SIZE } = require('../services/tech-visit-texts');

const inbound = (over = {}) => ({ direction: 'inbound', message_type: 'inbound', status: 'received', message_body: 'The gate code changed', metadata: null, ...over });
const outbound = (over = {}) => ({ direction: 'outbound', message_type: 'manual', status: 'sent', message_body: 'We will be there Tuesday', metadata: null, ...over });

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

  test('a photo with no words shows only when it is a displayable image', () => {
    const media = (contentType) => JSON.stringify({ media: [{ key: 'sms-media/inbound/a', contentType }] });
    expect(textVerdict(inbound({ message_body: '', metadata: media('image/jpeg') }))).toBe('show');
    expect(textVerdict(inbound({ message_body: '', metadata: media('image/HEIC; charset=x') }))).toBe('show');
    expect(textVerdict(inbound({ message_body: '', metadata: media('application/pdf') }))).toBe('skip');
    expect(textVerdict(inbound({ message_body: '', metadata: media(null) }))).toBe('skip');
  });

  test.each([
    '4111 1111 1111 1111', '4111111111111111', 'the number is 5555-5555-5555-4444', 'cvv 123', 'security code is 456', 'expires 08/27',
    'my routing is 021000021', 'account number 123456789', 'acct # 99887766',
  ])('a card or bank detail hides the whole text even with no money word: %s', (body) => {
    expect(hasCardCredentials(body)).toBe(true);
    expect(textVerdict(inbound({ message_body: body }))).toBe('hidden');
    expect(textVerdict(outbound({ message_body: body }))).toBe('hidden');
  });

  test('an ordinary number is not a card number', () => {
    expect(hasCardCredentials('gate code 4521, call 941 555 0100')).toBe(false);
    expect(textVerdict(inbound({ message_body: 'gate code is 4521' }))).toBe('show');
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

// A tiny sms_log: applies the customer, the created_at bounds, the order and the limit the service asks for.
function fakeDb(rows) {
  const calls = { where: [] };
  const db = () => {
    let list = rows.slice();
    let skip = 0;
    let max = Infinity;
    const q = {
      where(a, op, val) {
        calls.where.push([a, op, val]);
        if (typeof a === 'object') list = list.filter((r) => Object.entries(a).every(([k, v]) => r[k] === v));
        else if (op === '>=') list = list.filter((r) => r[a] >= val);
        else if (op === '<=') list = list.filter((r) => r[a] <= val);
        return q;
      },
      orderBy(col, dir) { list.sort((x, y) => (dir === 'desc' ? -1 : 1) * (x[col] < y[col] ? -1 : x[col] > y[col] ? 1 : 0)); return q; },
      limit(n) { max = n; return q; },
      offset(n) { skip = n; return q; },
      select() { calls.selects = (calls.selects || 0) + 1; return Promise.resolve(list.slice(skip, skip + max)); },
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
      row('mid', '2026-11-22T15:00:00Z', { direction: 'outbound', message_type: 'manual', status: 'sent' }),
      row('money', '2026-11-23T15:00:00Z', { message_body: 'what is my balance' }),
      row('invoice', '2026-11-24T15:00:00Z', { direction: 'outbound', message_type: 'invoice', status: 'sent' }),
      row('late', '2026-11-27T12:00:01Z'),
      row('other', '2026-11-22T16:00:00Z', { customer_id: 'cust-2' }),
    ]);
    const out = await visitTexts(db, SVC, { now: NOW, sign: async () => [] });
    expect(out.texts.map((t) => t.id)).toEqual(['edge', 'mid']);
    expect(out.hidden).toBe(2);
    expect(JSON.stringify(out)).not.toMatch(/balance/);
    expect(Object.keys(out.texts[0]).sort()).toEqual(['at', 'body', 'direction', 'id', 'photos']);
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

  test('a document is never signed, and a row left with nothing to show is dropped', async () => {
    const media = [
      { key: 'sms-media/inbound/pic', contentType: 'image/png' },
      { key: 'sms-media/inbound/doc', contentType: 'application/pdf' },
    ];
    const sign = jest.fn(async (items) => items.map((m) => ({ ...m, url: `https://signed.example/${m.key}` })));
    const only = row('docs', '2026-11-22T15:00:00Z', { message_body: '', metadata: { media: [media[1]] } });
    const both = row('both', '2026-11-22T16:00:00Z', { message_body: '', metadata: { media } });
    const out = await visitTexts(fakeDb([only, both]), SVC, { now: NOW, sign });
    expect(out.texts.map((t) => t.id)).toEqual(['both']);
    expect(out.texts[0].photos).toEqual([{ url: 'https://signed.example/sms-media/inbound/pic', contentType: 'image/png' }]);
    expect(sign).toHaveBeenCalledTimes(1);
    expect(sign).toHaveBeenCalledWith([media[0]]);
  });

  test('a tapback in the window is neither shown nor counted', async () => {
    const out = await visitTexts(fakeDb([row('tap', '2026-11-22T15:00:00Z', { message_body: 'Liked \u201cWe will be there Tuesday\u201d' })]), SVC, { now: NOW, sign: async () => [] });
    expect(out).toEqual({ texts: [], hidden: 0 });
  });

  test('photos: only a stored key is linked, a provider URL never leaves', async () => {
    const media = [{ key: 'sms-media/inbound/a', providerUrl: 'https://api.twilio.com/x/Media/1', contentType: 'image/jpeg' }, { providerUrl: 'https://api.twilio.com/x/Media/2', contentType: 'image/jpeg' }];
    const sign = jest.fn(async (items) => items.map((m) => ({ ...m, url: 'https://signed.example/a?sig=1' })));
    const failed = jest.fn(async (items) => items.map((m) => ({ ...m, url: m.providerUrl })));
    const db = () => fakeDb([row('p1', '2026-11-22T15:00:00Z', { message_body: '', metadata: { media } })])();
    const ok = await visitTexts(db, SVC, { now: NOW, sign });
    expect(sign).toHaveBeenCalledWith([media[0]]);
    expect(ok.texts[0].photos).toEqual([{ url: 'https://signed.example/a?sig=1', contentType: 'image/jpeg' }]);
    const bad = await visitTexts(db, SVC, { now: NOW, sign: failed });
    expect(bad.texts[0].photos).toEqual([]);
    expect(JSON.stringify(bad)).not.toMatch(/twilio/);
  });

  test('a visit with no customer reads nothing', async () => {
    const db = jest.fn();
    expect(await visitTexts(db, { ...SVC, customer_id: null })).toEqual({ texts: [], hidden: 0 });
    expect(db).not.toHaveBeenCalled();
  });
});
