/**
 * gatherReserviceAsks (GATE_RESERVICE_ASKS, step S1 of the consolidated
 * re-service report): every message in which a customer described the problem
 * behind a pest or lawn re-service, from 10 days before the booking to now.
 * A fake knex serves each table's rows; synthetic names only.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const logger = require('../services/logger');
const {
  gatherReserviceAsks, ASKS_LOOKBACK_DAYS, MAX_ITEMS, _test,
} = require('../services/reservice-asks');

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-11-02T15:00:00Z');
const BOOKED = new Date('2026-10-28T14:00:00Z');

function baseVisit(over = {}) {
  return {
    id: 'visit-1',
    customer_id: 'cust-1',
    service_type: 'Pest Control Re-Service',
    is_callback: true,
    service_key: 'pest_re_service',
    created_at: BOOKED,
    notes: null,
    customer_request: null,
    customer_request_source: null,
    customer_request_pests: null,
    ...over,
  };
}

// Chainable stand-in: the visit read ends in first(); every other read is
// awaited as a list. `fail` makes a table's read reject with that error.
function fakeKnex({
  visit = baseVisit(), sms = [], calls = [], emails = [], requests = [], properties = [], fail = {},
} = {}) {
  const rowsByTable = {
    sms_log: sms, call_log: calls, emails, service_requests: requests, customer_properties: properties,
  };
  const seen = [];
  const wheres = [];
  const knex = (table) => {
    seen.push(table);
    const q = {};
    for (const m of ['where', 'whereRaw', 'leftJoin', 'select', 'orderBy', 'limit', 'modify']) q[m] = (...args) => { if (m === 'modify' && typeof args[0] === 'function') args[0](q); return q; };
    q.where = (...args) => { wheres.push([table, args]); return q; };
    q.first = async () => visit;
    q.then = (resolve, reject) => (fail[table]
      ? Promise.reject(fail[table])
      : Promise.resolve(rowsByTable[table] || [])).then(resolve, reject);
    return q;
  };
  knex.seen = seen;
  knex.wheres = wheres;
  return knex;
}

const gather = (opts = {}, visitId = 'visit-1') => gatherReserviceAsks(visitId, { knex: fakeKnex(opts), now: NOW });

const sms = (id, body, at = new Date(NOW - 2 * DAY), extra = {}) => ({
  id, message_body: body, message_type: 'sms_inbound', created_at: at, ...extra,
});

function v2Call(id, quote, at = new Date(NOW - 3 * DAY), extra = {}) {
  return {
    id,
    created_at: at,
    v2_extraction_status: 'valid',
    processing_status: 'completed',
    call_outcome: null,
    answered_by: null,
    ai_extraction: null,
    ai_extraction_enriched: { evidence: [{ speaker: 'caller', field_path: 'service_request.description', quote }] },
    ...extra,
  };
}

beforeEach(() => jest.clearAllMocks());

describe('visit gate', () => {
  test('no row is not_found', async () => {
    expect(await gather({ visit: null })).toEqual({ ok: false, reason: 'not_found' });
  });

  test('an ordinary visit is not_reservice', async () => {
    expect(await gather({ visit: baseVisit({ is_callback: false, service_key: 'pest_quarterly' }) }))
      .toEqual({ ok: false, reason: 'not_reservice' });
  });

  test('the rodent trapping follow-up is refused even as a callback', async () => {
    expect(await gather({ visit: baseVisit({ is_callback: true, service_key: 'rodent_trapping_followup' }) }))
      .toEqual({ ok: false, reason: 'not_reservice' });
  });

  test.each([
    [{ is_callback: false, service_key: 'lawn_re_service' }, 'lawn'],
    [{ is_callback: false, service_key: 'pest_re_service' }, 'pest'],
    [{ is_callback: true, service_key: null, service_type: 'Lawn Care Re-Service' }, 'lawn'],
    [{ is_callback: true, service_key: null, service_type: 'Pest Control Re-Service' }, 'pest'],
  ])('a re-service %j has lane %s', async (over, lane) => {
    const out = await gather({ visit: baseVisit(over) });
    expect(out.ok).toBe(true);
    expect(out.lane).toBe(lane);
  });

  test('the window runs from 10 days before the booking to now', async () => {
    const out = await gather();
    expect(ASKS_LOOKBACK_DAYS).toBe(10);
    expect(out.window).toEqual({
      from: new Date(BOOKED.getTime() - 10 * DAY).toISOString(),
      to: NOW.toISOString(),
    });
    expect(out.items).toEqual([]);
  });

  test('a visit read failure throws', async () => {
    const knex = () => { throw new Error('db down'); };
    await expect(gatherReserviceAsks('visit-1', { knex, now: NOW })).rejects.toThrow('db down');
  });
});

describe('booking words', () => {
  test('picker words are quoted and carry the request_form source', async () => {
    const { items } = await gather({ visit: baseVisit({ customer_request: 'Ants are back in the kitchen.', customer_request_source: 'picker' }) });
    expect(items).toEqual([{
      id: 'booking:visit-1',
      source: 'request_form',
      at: BOOKED.toISOString(),
      text: 'Ants are back in the kitchen.',
      quoted: true,
      lead: null,
      kind: 'problem',
      pests: ['Ants'],
    }]);
  });

  test('picker words win over the chips', async () => {
    const { items } = await gather({ visit: baseVisit({ customer_request: 'Ants in the pantry', customer_request_source: 'picker', customer_request_pests: ['spiders'] }) });
    expect(items).toHaveLength(1);
    expect(items[0].text).toBe('Ants in the pantry');
  });

  test('chips only read "Picked: ..." and are not quoted', async () => {
    const { items } = await gather({ visit: baseVisit({ customer_request_source: 'picker', customer_request_pests: ['ants', 'roaches', 'bogus'] }) });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      text: 'Picked: Ants, Roaches', quoted: false, lead: null, source: 'request_form', kind: 'problem',
    });
    expect(items[0].pests).toEqual(expect.arrayContaining(['Ants', 'Cockroaches']));
  });

  test('lawn chips use the lawn labels', async () => {
    const { items } = await gather({ visit: baseVisit({ service_key: 'lawn_re_service', customer_request_pests: ['weeds', 'brown_patches'] }) });
    expect(items[0].text).toBe('Picked: Weeds, Brown or dead patches');
  });

  test.each([
    ['text', { source: 'text', quoted: true, lead: null }],
    ['call', { source: 'call', quoted: false, lead: 'On your call, you mentioned' }],
    ['office', { source: 'office', quoted: false, lead: 'As reported to our office:' }],
  ])('a %s booking source follows its quote and lead rule', async (source, expected) => {
    const { items } = await gather({ visit: baseVisit({ customer_request: 'Roaches under the sink.', customer_request_source: source }) });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ text: 'Roaches under the sink.', ...expected });
  });

  test('words with an unknown source are not shown', async () => {
    const { items } = await gather({ visit: baseVisit({ customer_request: 'Roaches under the sink.', customer_request_source: 'mystery' }) });
    expect(items).toEqual([]);
  });

  test('a legacy booking falls back to its "Re-service request: " notes line', async () => {
    const { items } = await gather({
      visit: baseVisit({ notes: 'Self-booked. Notes: Re-service request: wasps are back at the porch — Unit: 5' }),
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: 'booking:visit-1', source: 'request_form', quoted: true, text: 'wasps are back at the porch', lead: null,
    });
  });

  test('the notes fallback needs a request line, not the plain self-serve note', async () => {
    const { items } = await gather({ visit: baseVisit({ notes: 'Self-booked. Notes: Re-service requested via self-serve link' }) });
    expect(items).toEqual([]);
  });

  test('legacyRequestText reads the chip form too', () => {
    expect(_test.legacyRequestText('Re-service request (Ants, Wasps): ants are back')).toBe('ants are back');
    expect(_test.legacyRequestText('nothing here')).toBeNull();
  });
});

describe('texts', () => {
  test('an inbound text is quoted and keeps its id and time', async () => {
    const at = new Date(NOW - 2 * DAY);
    const { items } = await gather({ sms: [sms('s1', 'The ants came back after the spray.', at)] });
    expect(items).toEqual([{
      id: 'text:s1', source: 'text', at: at.toISOString(), text: 'The ants came back after the spray.', quoted: true, lead: null, kind: 'problem', pests: ['Ants'],
    }]);
  });

  test('the office-only screen reads the original words, before the scrub keeps only the pest talk', async () => {
    const at = new Date(NOW - 2 * DAY);
    const { items } = await gather({ sms: [sms('s2', 'The ants came back after the spray. I want a refund.', at)] });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: 'text:s2', officeOnly: 'billing' });
    expect(items[0].text).not.toMatch(/refund/);
  });

  test('a text longer than the 400-character cap is screened whole: a refund at its end still counts', async () => {
    const at = new Date(NOW - 2 * DAY);
    const long = `${'The ants came back after the spray, all along the kitchen counter and the back door. '.repeat(6)}I want a refund.`;
    expect(long.length).toBeGreaterThan(400);
    const { items } = await gather({ sms: [sms('s3', long, at)] });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: 'text:s3', officeOnly: 'billing' });
  });

  test('a message for the office with no pest talk freezes with no words, for the bell only', async () => {
    const at = new Date(NOW - 2 * DAY);
    const { items } = await gather({ sms: [sms('s4', 'I want a refund.', at), sms('s5', 'Nobody came today.', new Date(NOW - DAY))] });
    expect(items.map((item) => [item.id, item.text, item.officeOnly, item.pests])).toEqual([
      ['text:s4', '', 'billing', []],
      ['text:s5', '', 'schedule', []],
    ]);
  });

  test('an office-only message is never folded into an item with the same pest words', async () => {
    const at = new Date(NOW - 2 * DAY);
    const { items } = await gather({
      visit: baseVisit({ customer_request: 'The ants came back after the spray.', customer_request_source: 'picker' }),
      sms: [sms('s6', 'The ants came back after the spray. I want a refund.', at)],
    });
    expect(items.map((item) => item.officeOnly || null)).toEqual([null, 'billing']);
  });

  test('an account with several properties: the channel items are account-wide, the booking words are not', async () => {
    const visit = baseVisit({ customer_request: 'Ants in the kitchen', customer_request_source: 'picker' });
    const several = await gather({ visit, sms: [sms('s7', 'Roaches are back at the rental')], properties: [{ id: 'p1' }, { id: 'p2' }] });
    expect(several.items.map((item) => [item.id, item.accountWide || false])).toEqual([['booking:visit-1', false], ['text:s7', true]]);
    const one = await gather({ visit, sms: [sms('s7', 'Roaches are back at the rental')], properties: [{ id: 'p1' }] });
    expect(one.items.some((item) => item.accountWide)).toBe(false);
    // A failed property read counts as several: nothing account-wide can print.
    const failed = await gather({ visit, sms: [sms('s7', 'Roaches are back at the rental')], fail: { customer_properties: new Error('db down') } });
    expect(failed.items.find((item) => item.id === 'text:s7').accountWide).toBe(true);
  });

  test('tapbacks, STOP and empty texts are dropped', async () => {
    const { items } = await gather({
      sms: [
        sms('s1', 'Liked "Your visit is confirmed for Tuesday"'),
        sms('s2', 'STOP'),
        sms('s3', '   '),
        sms('s4', 'Roaches in the garage again', undefined, { message_type: 'sms_reaction' }),
        sms('s5', 'Still seeing ants by the door'),
      ],
    });
    expect(items.map((item) => item.id)).toEqual(['text:s5']);
  });

  test('a text that repeats the booking words is dropped', async () => {
    const { items } = await gather({
      visit: baseVisit({ customer_request: 'Ants are back in the kitchen', customer_request_source: 'text' }),
      sms: [sms('s1', 'ants are BACK in the kitchen!'), sms('s2', 'Also some spiders by the window')],
    });
    expect(items.map((item) => item.id)).toEqual(['booking:visit-1', 'text:s2']);
  });

  test('a text whose first 400 characters repeat the booking words still counts when the whole message is for the office', async () => {
    const words = 'The ants came back along the kitchen counter and the back slider and the pantry shelves again this week. '.repeat(4).trim();
    const body = `${words} I want a refund.`;
    expect(words.length).toBeGreaterThan(400);
    const { items } = await gather({
      visit: baseVisit({ customer_request: words.slice(0, 400), customer_request_source: 'text' }),
      sms: [sms('s9', body)],
    });
    expect(items.map((item) => [item.id, item.officeOnly || null])).toEqual([['booking:visit-1', null], ['text:s9', 'billing']]);
  });

  test('a copy is judged on the scrubbed words: the booking words plus an off-topic sentence is one ask', async () => {
    const { items } = await gather({
      visit: baseVisit({ customer_request: 'Ants are back.', customer_request_source: 'picker' }),
      sms: [sms('s1', 'Ants are back. See you Tuesday.'), sms('s2', 'Spiders on the lanai too.')],
    });
    expect(items.map((item) => item.id)).toEqual(['booking:visit-1', 'text:s2']);
  });

  test('the same words sent twice, or in two channels, keep only the oldest copy', async () => {
    const { items } = await gather({
      sms: [sms('s1', 'Roaches under the sink.', new Date(NOW - 4 * DAY)), sms('s2', 'Roaches under the sink. Thanks!', new Date(NOW - 2 * DAY))],
      emails: [{ id: 'e1', received_at: new Date(NOW - DAY), from_address: 'c@example.com', label_ids: [], body_text: 'Roaches under the sink.' }],
    });
    expect(items.map((item) => item.id)).toEqual(['text:s1']);
  });

  test('copies do not use up the allowance: ten distinct asks survive twelve copies', async () => {
    const distinct = Array.from({ length: 10 }, (_, i) => sms(`d${i}`, `Ants in room ${i}.`, new Date(NOW - (20 - i) * 3600 * 1000)));
    const copies = Array.from({ length: 12 }, (_, i) => sms(`c${i}`, 'Ants in room 0. Call me.', new Date(NOW - i * 60 * 1000)));
    const { items } = await gather({ sms: [...distinct, ...copies] });
    expect(items).toHaveLength(10);
    expect(new Set(items.map((item) => item.text)).size).toBe(10);
  });

  test('a text with nothing about the problem is left out after the scrub', async () => {
    const { items } = await gather({ sms: [sms('s1', 'Thanks, see you Tuesday.')] });
    expect(items).toEqual([]);
  });
});

describe('calls', () => {
  test('a validated V2 caller quote is paraphrased with the Eastern call day', async () => {
    const at = new Date('2026-10-26T01:30:00Z'); // 9:30 PM ET on Oct 25
    const { items } = await gather({ calls: [v2Call('c1', 'There are ants all over the kitchen counter', at)] });
    expect(items).toEqual([{
      id: 'call:c1',
      source: 'call',
      at: at.toISOString(),
      text: 'There are ants all over the kitchen counter',
      quoted: false,
      lead: 'On your call on Oct 25, you mentioned',
      kind: 'problem',
      pests: ['Ants'],
    }]);
  });

  test('a call without a valid V2 extraction, or a voicemail, adds nothing', async () => {
    const { items } = await gather({
      calls: [
        v2Call('c1', 'Ants in the kitchen', undefined, { v2_extraction_status: 'invalid' }),
        v2Call('c2', 'Ants in the kitchen', undefined, { processing_status: 'voicemail' }),
        { id: 'c3', created_at: new Date(NOW - DAY), call_summary: 'Customer reports ants.', v2_extraction_status: null },
      ],
    });
    expect(items).toEqual([]);
  });

  test('reads inbound calls only: on a call Waves placed, the caller lines are Waves', async () => {
    const knex = fakeKnex({ calls: [v2Call('c1', 'Ants in the kitchen')] });
    await gatherReserviceAsks('visit-1', { knex, now: NOW });
    const callWheres = knex.wheres.filter(([table, args]) => table === 'call_log' && args[0] && typeof args[0] === 'object');
    expect(callWheres.some(([, args]) => args[0].direction === 'inbound')).toBe(true);
  });

  test('callDay uses the Eastern calendar day', () => {
    expect(_test.callDay('2026-10-26T01:30:00Z')).toBe('Oct 25');
    expect(_test.callDay('2026-10-26T12:00:00Z')).toBe('Oct 26');
  });
});

describe('emails and portal requests', () => {
  test('an email keeps only the customer reply, not the quoted thread or signature', async () => {
    const { items } = await gather({
      emails: [{
        id: 'e1',
        received_at: new Date(NOW - 4 * DAY),
        from_address: 'customer@example.com',
        label_ids: ['INBOX'],
        body_text: 'We still see ants near the sink.\n\nThanks,\nSam\n\nOn Mon, Oct 26, 2026 at 9:00 AM Waves <hello@wavespestcontrol.com> wrote:\n> Your technician will arrive Tuesday for roaches.',
      }],
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: 'email:e1', source: 'email', quoted: true, lead: null });
    expect(items[0].text).toContain('We still see ants near the sink.');
    expect(items[0].text).not.toMatch(/technician will arrive|roaches/i);
  });

  test('mail Waves sent is dropped', async () => {
    const { items } = await gather({
      emails: [
        { id: 'e1', received_at: new Date(NOW - DAY), from_address: 'x@example.com', label_ids: ['SENT'], body_text: 'Ants are handled.' },
        { id: 'e2', received_at: new Date(NOW - DAY), from_address: 'Office <office@wavespestcontrol.com>', label_ids: [], body_text: 'Ants are handled.' },
      ],
    });
    expect(items).toEqual([]);
  });

  test('the portal request table is never read: it mixes the portal form with server-written rows', async () => {
    const knex = fakeKnex({
      requests: [{ id: 'r1', created_at: new Date(NOW - DAY), source: null, subject: 'Re-service requested from the cancel flow', description: 'Customer accepted the free re-service card. Book the callback.' }],
    });
    const { items } = await gatherReserviceAsks('visit-1', { knex, now: NOW });
    expect(knex.seen).not.toContain('service_requests');
    expect(items.some((item) => item.source === 'portal_request')).toBe(false);
  });
});

describe('scrub in the reservice lane', () => {
  test('keeps product and household talk, drops scheduling talk', async () => {
    const { items } = await gather({
      sms: [sms('s1', 'Do you know when you will be here? Used Bifenthrin before? Our cat gets sick if we let her out on the lanai.')],
    });
    expect(items).toHaveLength(1);
    expect(items[0].text).toBe('Used Bifenthrin before? Our cat gets sick if we let her out on the lanai.');
    expect(items[0].kind).toBe('question');
  });

  test('access details and codes never come through', async () => {
    const { items } = await gather({
      sms: [sms('s1', 'The gate code is 4821. The ants are by the side gate.')],
    });
    expect(JSON.stringify(items)).not.toContain('4821');
  });

  test('booking words pass the scrub too', async () => {
    const { items } = await gather({ visit: baseVisit({ customer_request: 'Please come after lunch. Ants in the bathroom.', customer_request_source: 'picker' }) });
    expect(items[0].text).toBe('Ants in the bathroom.');
  });

  test('words with nothing relevant are dropped whole', async () => {
    const { items } = await gather({ visit: baseVisit({ customer_request: 'Call me first.', customer_request_source: 'office' }) });
    expect(items).toEqual([]);
  });
});

describe('caps and order', () => {
  test('items come oldest first', async () => {
    const { items } = await gather({
      visit: baseVisit({ customer_request: 'Ants in the kitchen', customer_request_source: 'picker' }),
      sms: [sms('s1', 'More ants today', new Date(NOW - DAY)), sms('s2', 'Ants last week', new Date(BOOKED.getTime() - 4 * DAY))],
    });
    expect(items.map((item) => item.id)).toEqual(['text:s2', 'booking:visit-1', 'text:s1']);
  });

  test('over 10 items keeps the booking item and the 9 newest others, oldest first', async () => {
    const texts = Array.from({ length: 14 }, (_, i) => sms(`s${i}`, `Ants again, sighting ${i}`, new Date(BOOKED.getTime() - 9 * DAY + i * DAY / 2)));
    const { items } = await gather({
      visit: baseVisit({ customer_request: 'Ants in the kitchen', customer_request_source: 'picker' }),
      sms: texts,
    });
    expect(MAX_ITEMS).toBe(10);
    expect(items).toHaveLength(10);
    expect(items.some((item) => item.id === 'booking:visit-1')).toBe(true);
    const others = items.filter((item) => item.id !== 'booking:visit-1').map((item) => item.id);
    expect(others).toEqual(texts.slice(5).map((row) => `text:${row.id}`));
    expect(items.map((item) => item.at)).toEqual([...items.map((item) => item.at)].sort());
  });

  test('office-only messages with no words never crowd out an ask: the cap counts asks, and the newest 5 of them ride along', async () => {
    const asks = Array.from({ length: 14 }, (_, i) => sms(`a${i}`, `Ants again, sighting ${i}`, new Date(BOOKED.getTime() - 9 * DAY + i * DAY / 2)));
    const office = Array.from({ length: 7 }, (_, i) => sms(`o${i}`, `I want a refund, note ${i}.`, new Date(BOOKED.getTime() - 9 * DAY + i * DAY / 3)));
    const { items } = await gather({
      visit: baseVisit({ customer_request: 'Ants in the kitchen', customer_request_source: 'picker' }),
      sms: [...asks, ...office],
    });
    expect(items.filter((item) => item.text)).toHaveLength(10);
    expect(items.filter((item) => !item.text).map((item) => item.id)).toEqual(office.slice(2).map((row) => `text:${row.id}`));
    expect(items.map((item) => item.at)).toEqual([...items.map((item) => item.at)].sort());
  });

  test('a long text is cut at a word boundary within 280 characters', async () => {
    const long = `${'The ants keep coming back into the kitchen and the pantry '.repeat(8)}end.`;
    const { items } = await gather({ sms: [sms('s1', long)] });
    expect(items[0].text.length).toBeLessThanOrEqual(280);
    expect(items[0].text.endsWith('…')).toBe(true);
    expect(items[0].text).not.toMatch(/\s…$/);
  });

  test('a question mark makes the item a question', async () => {
    const { items } = await gather({ sms: [sms('s1', 'Are the ants gone for good?'), sms('s2', 'The ants are gone.')] });
    expect(Object.fromEntries(items.map((item) => [item.id, item.kind]))).toEqual({ 'text:s1': 'question', 'text:s2': 'problem' });
  });
});

describe('failed channel', () => {
  test('one failed read leaves the other channels intact and logs its code', async () => {
    const err = Object.assign(new Error('relation missing'), { code: '42P01' });
    const out = await gather({
      visit: baseVisit({ customer_request: 'Ants in the kitchen', customer_request_source: 'picker' }),
      sms: [sms('s1', 'Ants again today')],
      emails: [{ id: 'e1', received_at: new Date(NOW - DAY), from_address: 'c@example.com', label_ids: [], body_text: 'Spiders on the porch' }],
      fail: { call_log: err },
    });
    expect(out.ok).toBe(true);
    expect(out.items.map((item) => item.id).sort()).toEqual(['booking:visit-1', 'email:e1', 'text:s1']);
    expect(logger.warn).toHaveBeenCalledWith('[reservice-asks] call unavailable: 42P01');
  });

  test('an error without a code logs its name', async () => {
    await gather({ fail: { emails: new TypeError('boom') } });
    expect(logger.warn).toHaveBeenCalledWith('[reservice-asks] email unavailable: TypeError');
  });
});

describe('pestsIn', () => {
  test('finds whole picker names and families, singular or plural', () => {
    expect(_test.pestsIn('Fire ants by the mailbox')).toEqual(['Fire ants']);
    expect(_test.pestsIn('an ant and a roach')).toEqual(expect.arrayContaining(['Ants', 'Cockroaches']));
    expect(_test.pestsIn('Nothing to see')).toEqual([]);
  });

  test('plural picker names match as written, not only their singular (flies, roaches)', () => {
    expect(_test.pestsIn('Drain flies in the guest bath')).toEqual(['Drain flies']);
    expect(_test.pestsIn('one house fly and many house flies')).toEqual(['House flies']);
    expect(_test.pestsIn('flies all over the patio')).toEqual(['Flies']);
    expect(_test.pestsIn('roaches under the sink')).toEqual(['Cockroaches']);
  });

  test('wordForms spells a singular, its plurals and the word as written', () => {
    const re = new RegExp(`^${_test.wordForms('flies')}$`, 'i');
    for (const word of ['fly', 'flies', 'flys']) expect(re.test(word)).toBe(true);
    const roach = new RegExp(`^${_test.wordForms('roach')}$`, 'i');
    for (const word of ['roach', 'roaches']) expect(roach.test(word)).toBe(true);
  });
});
