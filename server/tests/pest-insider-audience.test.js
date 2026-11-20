/**
 * Waves Pest Insider audience (services/pest-insider/audience.js): the fixed customer holdout
 * and selectIssueAudience's counts, order of work and cutoff. The database, the sender's
 * subscriber query and the relink sweep are mocked; the real SQL shape is pinned in
 * newsletter-sender-subscriber-ids.test.js.
 */
jest.mock('../models/db', () => {
  const db = jest.fn();
  db.raw = jest.fn((sql) => ({ raw: sql }));
  return db;
});
jest.mock('../services/newsletter-subscribers', () => ({ relinkArchivedLinkedSubscribers: jest.fn() }));
jest.mock('../services/newsletter-sender', () => ({ buildSubscriberQuery: jest.fn(), withMailboxCustomers: jest.fn() }));

const crypto = require('crypto');
const NewsletterSubscribers = require('../services/newsletter-subscribers');
const { buildSubscriberQuery, withMailboxCustomers } = require('../services/newsletter-sender');
const {
  isHeldOut, addressKey, isAddressKey, selectIssueAudience, audienceSegmentFilter, WARM_DAYS, HOLDOUT_PERCENT, HOLDOUT_SALT, HOLDOUT_NAME,
} = require('../services/pest-insider/audience');

// Runs a knex where-builder callback against a recorder: each call as [method, ...args], with a
// callback argument recorded the same way (nested), so a test can pin the subquery it builds.
function record(builder) {
  const calls = [];
  const recorder = new Proxy({}, {
    get: (_target, method) => (...args) => {
      calls.push([method, ...args.map((arg) => (typeof arg === 'function' ? record(arg) : arg))]);
      return recorder;
    },
  });
  builder.call(recorder);
  return calls;
}

// Synthetic customer ids (no real customers): the first two hash into the holdout, the last two do not.
const HELD = ['a9f7e979-65d6-cf79-9a52-9102a973b8b9', '4d3a21d8-c684-c09c-19b9-3be911827fd5'];
const KEPT = ['b0fce403-c178-fa57-404c-1cc4176547a8', '9ab62b5e-f34a-9854-38bf-df7ee0102229'];

describe('isHeldOut', () => {
  test('the salt and the share are the ones the measurement depends on', () => {
    expect(HOLDOUT_SALT).toBe('waves-pest-insider-holdout-v1');
    expect(HOLDOUT_PERCENT).toBe(10);
    expect(WARM_DAYS).toBe(90);
  });

  test('pinned customers stay in or out of the holdout (a salt change would move them)', () => {
    for (const id of HELD) expect(isHeldOut(id)).toBe(true);
    for (const id of KEPT) expect(isHeldOut(id)).toBe(false);
  });

  test('a subscriber with no customer is never held out', () => {
    for (const id of [null, undefined, '']) expect(isHeldOut(id)).toBe(false);
  });

  test('the same customer gets the same answer every time, and about 10% are held out', () => {
    let held = 0;
    const total = 20000;
    for (let i = 0; i < total; i += 1) {
      const id = crypto.createHash('md5').update(`synthetic-${i}`).digest('hex');
      const first = isHeldOut(id);
      expect(isHeldOut(id)).toBe(first);
      if (first) held += 1;
    }
    expect(held / total).toBeGreaterThan(0.085);
    expect(held / total).toBeLessThan(0.115);
  });
});

describe('selectIssueAudience', () => {
  let order;
  let captured;
  function fakeQuery(rows) {
    const q = {
      where: jest.fn((fn) => { captured.where = fn; return q; }),
      orderBy: jest.fn((...args) => { captured.orderBy = args; order.push('query'); return Promise.resolve(rows); }),
    };
    return q;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    order = [];
    captured = {};
    NewsletterSubscribers.relinkArchivedLinkedSubscribers.mockImplementation(async () => { order.push('relink'); return 0; });
    // The sender's join adds each reader's address and the customers behind its mailbox (mailbox_customer_ids).
    withMailboxCustomers.mockImplementation((query) => { captured.joined = query; return query; });
  });

  test('keeps leads and kept customers, drops held-out customers, and counts each', async () => {
    const query = fakeQuery([
      { id: 4, customer_id: KEPT[0], email: 'four@example.invalid', mailbox_customer_ids: [KEPT[0]] },
      { id: 7, customer_id: HELD[0], email: 'seven@example.invalid', mailbox_customer_ids: [HELD[0]] },
      { id: 9, customer_id: null, email: 'Nine@Example.invalid', mailbox_customer_ids: [KEPT[1]] },
      { id: '12', customer_id: KEPT[1], email: 'twelve@example.invalid', mailbox_customer_ids: [] },
      { id: 15, customer_id: HELD[1], email: 'fifteen@example.invalid', mailbox_customer_ids: [HELD[1]] },
      // A lead whose mailbox has a held-out customer behind it (an alias row or a customer email).
      { id: 20, customer_id: null, email: 'twenty@example.invalid', mailbox_customer_ids: [KEPT[1], HELD[0]] },
    ]);
    buildSubscriberQuery.mockReturnValue(query);
    const audience = await selectIssueAudience({ asOf: new Date('2026-12-02T12:00:00Z') });
    expect(audience).toEqual({
      subscriberIds: [4, 9, 12],
      // The key of the address that qualified, for each kept reader.
      addressKeys: { 4: addressKey('four@example.invalid'), 9: addressKey('nine@example.invalid'), 12: addressKey('twelve@example.invalid') },
      counts: { warm: 6, heldOut: 3, recipients: 3 },
    });
    // The warm query itself carries the mailbox's customers, read in the same snapshot as the reader.
    expect(withMailboxCustomers).toHaveBeenCalledTimes(1);
    expect(captured.joined).toBe(query);
    expect(buildSubscriberQuery).toHaveBeenCalledWith(null);
    expect(captured.orderBy).toEqual(['newsletter_subscribers.id', 'asc']);
  });

  test('runs the relink sweep before it reads the audience, as the send path does', async () => {
    buildSubscriberQuery.mockReturnValue(fakeQuery([]));
    await selectIssueAudience();
    expect(order).toEqual(['relink', 'query']);
  });

  test('asks for an open event on the current address in the SendGrid log, in the 90 days up to asOf', async () => {
    buildSubscriberQuery.mockReturnValue(fakeQuery([]));
    const asOf = new Date('2026-12-02T12:00:00Z');
    const since = new Date(asOf.getTime() - 90 * 24 * 60 * 60 * 1000);
    await selectIssueAudience({ asOf });
    // One row per open (a repeat open counts), matched on the address that opened it only.
    expect(record(captured.where)).toEqual([
      ['whereExists', [
        ['select', { raw: '1' }],
        ['from', 'sendgrid_webhook_events as opened'],
        ['where', 'opened.event_type', 'open'],
        ['whereRaw', 'lower(opened.email) = lower(newsletter_subscribers.email)'],
        // The open's own time; a row logged before occurred_at existed falls back to its log time.
        ['whereRaw', 'coalesce(opened.occurred_at, opened.created_at) >= ?', [since]],
        ['whereRaw', 'coalesce(opened.occurred_at, opened.created_at) <= ?', [asOf]],
      ]],
    ]);
  });

  test('no warm reader gives an empty list, which the sender matches to nobody', async () => {
    buildSubscriberQuery.mockReturnValue(fakeQuery([]));
    const audience = await selectIssueAudience();
    expect(audience).toEqual({ subscriberIds: [], addressKeys: {}, counts: { warm: 0, heldOut: 0, recipients: 0 } });
    expect(audienceSegmentFilter(audience)).toEqual({ subscriber_ids: [], holdout: 'pest-insider', address_keys: {} });
  });
});

test('isAddressKey accepts only addressKey\'s form: 32 lower-case hex characters', () => {
  expect(isAddressKey(addressKey('a@b.com'))).toBe(true);
  ['key-1', '', 'BF6A6E734818AB4C5A2EB5612E010E04', addressKey('a@b.com').slice(1), null, undefined, 42].forEach((value) => {
    expect(isAddressKey(value)).toBe(false);
  });
});

test('audienceSegmentFilter copies the ids and address keys and names the holdout the sender checks again at dispatch', () => {
  const audience = { subscriberIds: [1, 2], addressKeys: { 1: 'key-1', 2: 'key-2' } };
  const filter = audienceSegmentFilter(audience);
  audience.subscriberIds.push(3);
  audience.addressKeys[3] = 'key-3';
  expect(HOLDOUT_NAME).toBe('pest-insider');
  expect(filter).toEqual({ subscriber_ids: [1, 2], holdout: 'pest-insider', address_keys: { 1: 'key-1', 2: 'key-2' } });
});

test('addressKey: one fixed key per mailbox, whatever the case or spaces; none for an empty address', () => {
  // Pinned: a new prefix gives every address a new key, and a queued issue would then skip everyone.
  expect(addressKey('a@b.com')).toBe('bf6a6e734818ab4c5a2eb5612e010e04');
  expect(addressKey('  A@B.COM ')).toBe(addressKey('a@b.com'));
  expect(addressKey('a@b.co')).not.toBe(addressKey('a@b.com'));
  for (const empty of ['', '   ', null, undefined]) expect(addressKey(empty)).toBeNull();
});
