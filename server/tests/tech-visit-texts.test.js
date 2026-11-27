/**
 * Technician Visit Brief texts (GATE_TECH_VISIT_TEXTS, owner 2026-11-26): services/tech-visit-texts.js, the pure
 * verdict + window rules and the sms_log read. Synthetic data only. The route's gate, ownership and payload are in
 * tech-visit-texts-route.test.js.
 */
const { textVerdict, hasMoneyWords, windowStart, visitTexts, MAX_TEXTS } = require('../services/tech-visit-texts');

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

  test('a photo with no words shows', () => {
    expect(textVerdict(inbound({ message_body: '', metadata: JSON.stringify({ media: [{ key: 'sms-media/inbound/a' }] }) }))).toBe('show');
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
    const q = {
      where(a, op, val) {
        calls.where.push([a, op, val]);
        if (typeof a === 'object') list = list.filter((r) => Object.entries(a).every(([k, v]) => r[k] === v));
        else if (op === '>=') list = list.filter((r) => r[a] >= val);
        else if (op === '<=') list = list.filter((r) => r[a] <= val);
        return q;
      },
      orderBy(col, dir) { list.sort((x, y) => (dir === 'desc' ? -1 : 1) * (x[col] < y[col] ? -1 : x[col] > y[col] ? 1 : 0)); return q; },
      limit(n) { list = list.slice(0, n); return q; },
      select() { return Promise.resolve(list); },
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

  test('photos: only a stored key is linked, a provider URL never leaves', async () => {
    const media = [{ key: 'sms-media/inbound/a', providerUrl: 'https://api.twilio.com/x/Media/1', contentType: 'image/jpeg' }, { providerUrl: 'https://api.twilio.com/x/Media/2' }];
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
