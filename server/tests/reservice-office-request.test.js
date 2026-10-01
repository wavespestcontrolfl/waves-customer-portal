/**
 * Office "Customer's words" on a pest/lawn re-service
 * (services/reservice-office-request.js, GATE_RESERVICE_OFFICE_REQUEST):
 * the suggestion picker (newest of the customer's latest inbound text vs call
 * note inside 72 hours, only that customer's rows, opt-out keywords skipped)
 * and the server-decided source (unchanged text/call keeps its source, an
 * edit, a forged id or another customer's suggestion is 'office').
 */

const {
  pickSuggestion,
  resolveCustomerRequest,
  cleanRequestText,
  callSuggestionText,
  isOfficeRequestServiceKey,
} = require('../services/reservice-office-request');

const NOW = Date.parse('2026-10-01T16:00:00Z');
const hoursAgo = (h) => new Date(NOW - h * 3600 * 1000);

const CUST = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// Minimal in-memory knex: honors where({..}) / where(col, op, val) /
// whereNotNull / orderBy / limit / select / first, so a query that forgets a
// customer or window filter fails the test instead of passing on a blind fake.
function fakeDb(tables) {
  return (name) => {
    let rows = (tables[name] || []).slice();
    const q = {
      where(a, b, c) {
        if (a && typeof a === 'object') {
          rows = rows.filter((r) => Object.entries(a).every(([k, v]) => r[k] === v));
        } else if (c === undefined) {
          rows = rows.filter((r) => r[a] === b);
        } else if (b === '>=') {
          rows = rows.filter((r) => r[a] >= c);
        }
        return q;
      },
      orderBy(col, dir) {
        const keys = Array.isArray(col) ? col : [{ column: col, order: dir }];
        rows.sort((x, y) => {
          for (const { column, order } of keys) {
            const a = x[column]; const b = y[column];
            if (a < b) return order === 'desc' ? 1 : -1;
            if (a > b) return order === 'desc' ? -1 : 1;
          }
          return 0;
        });
        return q;
      },
      offset(n) { rows = rows.slice(n); return q; },
      modify(fn) { return q; },
      whereRaw() { return q; },
      limit(n) { rows = rows.slice(0, n); return q; },
      select() { return q; },
      first() { return Promise.resolve(rows[0]); },
      then(ok, err) { return Promise.resolve(rows).then(ok, err); },
    };
    return q;
  };
}

const sms = (n, customer, body, h, direction = 'inbound') => ({
  id: id(n), customer_id: customer, direction, message_body: body, created_at: hoursAgo(h),
});
const call = (n, customer, h, extra = {}) => ({
  id: id(n), customer_id: customer, direction: 'inbound', created_at: hoursAgo(h), call_summary: null, ai_extraction: null, processing_status: 'processed', call_outcome: 'info_given', ...extra,
});

describe('pickSuggestion', () => {
  test('returns the newest of text vs call', async () => {
    const db = fakeDb({
      sms_log: [sms(1, CUST, 'Ants are back in the kitchen', 5)],
      call_log: [call(2, CUST, 2, { ai_extraction: JSON.stringify({ pain_points: 'Roaches under the sink' }) })],
    });
    const s = await pickSuggestion(db, CUST, { now: NOW });
    expect(s).toEqual({ id: id(2), kind: 'call', text: 'Roaches under the sink', at: hoursAgo(2).toISOString() });
  });

  test('a newer text beats an older call', async () => {
    const db = fakeDb({
      sms_log: [sms(1, CUST, 'Still seeing spiders', 1)],
      call_log: [call(2, CUST, 20, { call_summary: 'Customer called about spiders.' })],
    });
    const s = await pickSuggestion(db, CUST, { now: NOW });
    expect(s.kind).toBe('text');
    expect(s.id).toBe(id(1));
    expect(s.text).toBe('Still seeing spiders');
  });

  test('call falls back to call_summary when pain_points is empty', async () => {
    const db = fakeDb({
      sms_log: [],
      call_log: [call(2, CUST, 3, { ai_extraction: { pain_points: '  ' }, call_summary: 'Wasps by the garage door.' })],
    });
    expect((await pickSuggestion(db, CUST, { now: NOW })).text).toBe('Wasps by the garage door.');
  });

  test('nothing older than 72 hours', async () => {
    const db = fakeDb({
      sms_log: [sms(1, CUST, 'Ants again', 73)],
      call_log: [call(2, CUST, 80, { call_summary: 'Ants.' })],
    });
    expect(await pickSuggestion(db, CUST, { now: NOW })).toBeNull();
  });

  test('another customer\'s rows and outbound texts are ignored', async () => {
    const db = fakeDb({
      sms_log: [sms(1, OTHER, 'Not mine', 1), sms(2, CUST, 'We will be there Tuesday', 1, 'outbound')],
      call_log: [call(3, OTHER, 1, { call_summary: 'Not mine either' })],
    });
    expect(await pickSuggestion(db, CUST, { now: NOW })).toBeNull();
  });

  test.each(['STOP', 'stop.', 'Unsubscribe', 'please stop texting me', 'HELP', 'START', '   ', null])(
    'skips an opt-out / keyword / empty text (%p) and offers the real message behind it',
    async (body) => {
      const db = fakeDb({
        sms_log: [sms(1, CUST, body, 1), sms(2, CUST, 'Ants in the pantry', 6)],
        call_log: [],
      });
      const s = await pickSuggestion(db, CUST, { now: NOW });
      expect(s.id).toBe(id(2));
      expect(s.text).toBe('Ants in the pantry');
    },
  );

  test('an outbound office call is never suggested', async () => {
    const db = fakeDb({
      sms_log: [],
      call_log: [call(1, CUST, 1, { direction: 'outbound', call_summary: 'Office called to confirm Tuesday.' })],
    });
    expect(await pickSuggestion(db, CUST, { now: NOW })).toBeNull();
  });

  test('skips spam / voicemail call rows', async () => {
    const db = fakeDb({
      sms_log: [],
      call_log: [
        call(1, CUST, 1, { processing_status: 'spam', call_summary: 'Warranty offer' }),
        call(2, CUST, 2, { processing_status: 'voicemail', call_summary: 'Left a message' }),
        call(3, CUST, 3, { ai_extraction: { is_spam: true, pain_points: 'x' } }),
      ],
    });
    expect(await pickSuggestion(db, CUST, { now: NOW })).toBeNull();
  });

  test('caps the text at 400 characters', async () => {
    const db = fakeDb({ sms_log: [sms(1, CUST, 'a'.repeat(900), 1)], call_log: [] });
    expect((await pickSuggestion(db, CUST, { now: NOW })).text).toHaveLength(400);
  });

  test('no customer, no read', async () => {
    expect(await pickSuggestion(fakeDb({}), '', { now: NOW })).toBeNull();
  });
});

describe('resolveCustomerRequest — the server decides the source', () => {
  const tables = () => ({
    sms_log: [sms(1, CUST, '  Ants are back in the kitchen ', 5), sms(2, OTHER, 'Another customer text', 5), sms(3, CUST, 'Old text', 90), sms(4, CUST, 'Outbound reply', 5, 'outbound')],
    call_log: [call(10, CUST, 4, { ai_extraction: { pain_points: 'Roaches under the sink' } }), call(11, OTHER, 4, { call_summary: 'Other customer call' })],
  });
  const run = (input) => resolveCustomerRequest(fakeDb(tables()), CUST, input, { now: NOW });

  test('unchanged text from an inbound SMS keeps source text', async () => {
    expect(await run({ text: 'Ants are back in the kitchen', suggestionId: id(1), suggestionKind: 'text' }))
      .toEqual({ text: 'Ants are back in the kitchen', source: 'text' });
  });

  test('unchanged call note keeps source call', async () => {
    expect(await run({ text: 'Roaches under the sink', suggestionId: id(10), suggestionKind: 'call' }))
      .toEqual({ text: 'Roaches under the sink', source: 'call' });
  });

  test('an edit by staff is office', async () => {
    expect(await run({ text: 'Ants are back in the kitchen and the pantry', suggestionId: id(1), suggestionKind: 'text' }).then((r) => r.source)).toBe('office');
    expect(await run({ text: 'Roaches under the sink!', suggestionId: id(10), suggestionKind: 'call' }).then((r) => r.source)).toBe('office');
  });

  test('typed with no suggestion is office', async () => {
    expect(await run({ text: 'Customer says ants' })).toEqual({ text: 'Customer says ants', source: 'office' });
  });

  test('a forged / other customer\'s / outbound / expired / wrong-kind id is office', async () => {
    expect((await run({ text: 'Another customer text', suggestionId: id(2), suggestionKind: 'text' })).source).toBe('office');
    expect((await run({ text: 'Other customer call', suggestionId: id(11), suggestionKind: 'call' })).source).toBe('office');
    expect((await run({ text: 'Outbound reply', suggestionId: id(4), suggestionKind: 'text' })).source).toBe('office');
    expect((await run({ text: 'Old text', suggestionId: id(3), suggestionKind: 'text' })).source).toBe('office');
    expect((await run({ text: 'Ants are back in the kitchen', suggestionId: id(1), suggestionKind: 'call' })).source).toBe('office');
    expect((await run({ text: 'Ants are back in the kitchen', suggestionId: 'not-a-uuid', suggestionKind: 'text' })).source).toBe('office');
    expect((await run({ text: 'Ants are back in the kitchen', suggestionId: id(99), suggestionKind: 'text' })).source).toBe('office');
  });

  test('an outbound call never keeps source call', async () => {
    const t = tables();
    t.call_log.push(call(12, CUST, 4, { direction: 'outbound', call_summary: 'Office called to confirm Tuesday.' }));
    const r = await resolveCustomerRequest(fakeDb(t), CUST, { text: 'Office called to confirm Tuesday.', suggestionId: id(12), suggestionKind: 'call' }, { now: NOW });
    expect(r.source).toBe('office');
  });

  test('a client-sent source is never read', async () => {
    expect((await run({ text: 'Typed by staff', source: 'text', suggestionKind: 'text' })).source).toBe('office');
  });

  test('empty or whitespace words save nothing; long words are capped at 400', async () => {
    expect(await run({ text: '   ' })).toBeNull();
    expect(await run({})).toBeNull();
    expect((await run({ text: 'x'.repeat(900) })).text).toHaveLength(400);
  });

  test('a failed lookup lands on office, never a quotable source', async () => {
    const broken = () => { throw new Error('db down'); };
    expect(await resolveCustomerRequest(broken, CUST, { text: 'Ants', suggestionId: id(1), suggestionKind: 'text' }, { now: NOW }))
      .toEqual({ text: 'Ants', source: 'office' });
  });
});

describe('helpers', () => {
  test('only pest_re_service / lawn_re_service qualify', () => {
    expect(isOfficeRequestServiceKey('pest_re_service')).toBe(true);
    expect(isOfficeRequestServiceKey('lawn_re_service')).toBe(true);
    expect(isOfficeRequestServiceKey('rodent_trapping_followup')).toBe(false);
    expect(isOfficeRequestServiceKey('pest_control_quarterly')).toBe(false);
    expect(isOfficeRequestServiceKey(null)).toBe(false);
  });

  test('cleanRequestText trims, normalizes CRLF, caps', () => {
    expect(cleanRequestText('  a\r\nb  ')).toBe('a\nb');
    expect(cleanRequestText('')).toBeNull();
    expect(callSuggestionText(null)).toBeNull();
  });
});

describe('Codex r1 (#5518)', () => {
  test.each([
    [{ call_outcome: 'voicemail' }],
    [{ answered_by: 'voicemail' }],
  ])('a voicemail recorded as %j is never suggested', async (extra) => {
    const db = fakeDb({ sms_log: [], call_log: [call(1, CUST, 1, { call_summary: 'Left a message about ants', ...extra })] });
    expect(await pickSuggestion(db, CUST, { now: NOW })).toBeNull();
  });

  test('thirty newer skipped texts never hide an older real request in the window', async () => {
    const stops = Array.from({ length: 30 }, (_, i) => sms(100 + i, CUST, 'STOP', 1 + i * 0.01));
    const db = fakeDb({ sms_log: [...stops, sms(1, CUST, 'Ants are back in the kitchen', 40)], call_log: [] });
    const s = await pickSuggestion(db, CUST, { now: NOW });
    expect(s).toMatchObject({ kind: 'text', text: 'Ants are back in the kitchen' });
  });
});

describe('terminal Codex pass 1 (#5518)', () => {
  test('a tapback quoting a Waves text never hides the real request, and is never saved as the customer\'s words', async () => {
    const tapback = 'Liked \u201cWe can come Tuesday to treat the ants.\u201d';
    const db = fakeDb({
      sms_log: [sms(2, CUST, tapback, 1), sms(1, CUST, 'Ants are back in the kitchen', 5)],
      call_log: [],
    });
    expect(await pickSuggestion(db, CUST, { now: NOW })).toMatchObject({ id: id(1), text: 'Ants are back in the kitchen' });
    expect(await resolveCustomerRequest(db, CUST, { text: tapback, suggestionId: id(2), suggestionKind: 'text' }, { now: NOW }))
      .toEqual({ text: tapback, source: 'office' });
  });

  test('a row typed sms_reaction is skipped', async () => {
    const db = fakeDb({ sms_log: [{ ...sms(1, CUST, 'thumbs', 1), message_type: 'sms_reaction' }], call_log: [] });
    expect(await pickSuggestion(db, CUST, { now: NOW })).toBeNull();
  });

  test.each([
    [{ call_outcome: 'wrong_number' }],
    [{ ai_extraction: JSON.stringify({ call_type: 'spam', pain_points: 'Free cruise' }) }],
    [{ ai_extraction: JSON.stringify({ call_type: 'wrong_number', pain_points: 'Wrong business' }) }],
  ])('a call excluded as %j never replaces an older real request', async (extra) => {
    const db = fakeDb({
      sms_log: [sms(1, CUST, 'Ants are back in the kitchen', 10)],
      call_log: [call(2, CUST, 1, { call_summary: 'Not a customer', ...extra })],
    });
    expect(await pickSuggestion(db, CUST, { now: NOW })).toMatchObject({ kind: 'text', id: id(1) });
    expect((await resolveCustomerRequest(db, CUST, { text: 'Not a customer', suggestionId: id(2), suggestionKind: 'call' }, { now: NOW })).source).toBe('office');
  });
});
