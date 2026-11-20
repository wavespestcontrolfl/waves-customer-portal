/**
 * I5: newsletter broadcast — resumable + lost-response self-heal.
 *
 * Pins the three guarantees added by this PR:
 *
 *   1. sendCampaign retries only explicitly transient delivery rows
 *      (queued / failed / abandoned sending with no success or engagement timestamps). A manual
 *      re-run after a partial failure must not double-email successes or
 *      terminal provider failures.
 *
 *   2. Every recipient passed to SendGrid carries custom_args.delivery_id
 *      so an event webhook can find the right row even when the
 *      X-Message-Id from the original batch was never observed (lost-
 *      response case).
 *
 *   3. resumeCampaign rejects 'sending' (active worker), rejects
 *      'draft'/'scheduled' (use sendCampaign), rejects when existing
 *      delivery rows are all terminal-success, and treats resume claim
 *      races as benign.
 */

const mockSendBroadcast = jest.fn(async () => ({ messageId: 'sg-batch-1', recipientCount: 1 }));
// A planned Waves Pest Insider issue that reached no reader raises one alert.
const mockTrigger = jest.fn(async () => ({ bellWritten: true }));

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/sendgrid-mail', () => ({
  isConfigured: () => true,
  sendBroadcast: mockSendBroadcast,
  unsubscribeUrl: jest.fn((t) => `https://portal/unsub/${t}`),
}));
jest.mock('../services/conversations', () => ({
  recordTouchpoint: jest.fn(async () => ({ ok: true })),
}));
jest.mock('../services/notification-triggers', () => ({ triggerNotification: (...args) => mockTrigger(...args) }));

const db = require('../models/db');
// The pre-send archived-link relink sweep (relinkArchivedLinkedSubscribers)
// runs in its own small transaction (advisory lock + one raw UPDATE) at the
// top of sendCampaign; nothing stale in these scenarios, so it's a 0-row
// no-op. A planned issue's count and per-chunk re-check read the customers
// behind each mailbox in their own query (withMailboxCustomers): none here
// unless a test says so (buildDb's mailboxCustomers).
db.raw = jest.fn(async () => ({ rowCount: 0, rows: [] }));
db.transaction = jest.fn(async (cb) => cb({ raw: db.raw }));
const { recordTouchpoint } = require('../services/conversations');
const RETRYABLE_DELIVERY_STATUSES_FOR_TEST = ['queued', 'failed', 'sending'];
// Synthetic customer ids (no real customers), pinned in pest-insider-audience.test.js: the first
// is in the Waves Pest Insider holdout, the second is not.
const HELD_CUSTOMER = 'a9f7e979-65d6-cf79-9a52-9102a973b8b9';
const KEPT_CUSTOMER = 'b0fce403-c178-fa57-404c-1cc4176547a8';
const { sendCampaign, prepareResumeCampaign, resumeCampaign, hasOutstandingDeliveries } = require('../services/newsletter-sender');
const { addressKey } = require('../services/pest-insider/audience');
// The plan's key for each reader's qualifying address (services/pest-insider/audience.js).
const PLANNED_KEYS = { 1: addressKey('a@example.com'), 2: addressKey('b@example.com') };
// A Waves Pest Insider issue goes out only with a planned audience (audienceRefusal in the sender).
const PLANNED_PI = { subscriber_ids: [1, 2], holdout: 'pest-insider', address_keys: PLANNED_KEYS };

// Tiny knex-shaped chain helper. Mirrors the pattern used in
// invoice-receipt-email-idempotency.test.js / portal-url.test.js so the
// failure surface stays familiar.
// `result` may be a function of the query's whereRaw calls ([sql, bindings] pairs), for a
// re-check whose rows depend on the SQL it was given.
function chain({ first, result, returning, count, updated, onUpdate, onWhereIn } = {}) {
  const q = {};
  const raws = [];
  ['where', 'whereRaw', 'whereNot', 'whereNotIn', 'whereNotNull', 'whereNull',
   'whereNotExists', 'select', 'orderBy', 'limit', 'leftJoin', 'join', 'joinRaw', 'forUpdate',
   // excludeMarketingOptedOut's pre-filtering CTE (codex #5165) — a no-op
   // chain link here, same as every other query-shape method above.
   'withMaterialized']
    .forEach((m) => { q[m] = jest.fn(() => q); });
  q.whereIn = jest.fn((...args) => {
    if (onWhereIn) onWhereIn(...args);
    return q;
  });
  q.whereRaw = jest.fn((sql, bindings) => { raws.push([sql, bindings]); return q; });
  const rows = () => (typeof result === 'function' ? result(raws) : (result ?? []));
  q.first = jest.fn(async () => first);
  q.count = jest.fn(() => ({
    first: jest.fn(async () => ({ c: count ?? 0 })),
  }));
  q.insert = jest.fn(() => ({
    onConflict: jest.fn(() => ({ ignore: jest.fn(async () => result || []) })),
    returning: jest.fn(async () => returning || []),
  }));
  q.update = jest.fn((payload) => {
    if (onUpdate) onUpdate(payload);
    return {
    returning: jest.fn(async () => returning ?? []),
    then: (resolve) => Promise.resolve(updated ?? 0).then(resolve),
    };
  });
  q.then = (resolve, reject) => Promise.resolve().then(rows).then(resolve, reject);
  q.catch = (reject) => Promise.resolve().then(rows).catch(reject);
  return q;
}

// `mailboxCustomers`: subscriber id -> the customers behind its mailbox, as the
// planned audience's own query reads them (withMailboxCustomers).
function buildDb({ send, deliveries = [], subscribers = [], eligibleAtDispatch = null, onSkipUpdate = null, skipUpdated = null, onCalendarUpdate, heartbeatUpdated = 1, finalUpdated = 1, truncateSendsQueueAfterHeartbeat = false, mailboxCustomers = {}, retryableLeft = 0, onIssueUpdate, onIssueWhereIn, deadlineReached = false, onFinalUpdate } = {}) {
  const heartbeat = chain({ updated: deadlineReached ? 0 : heartbeatUpdated }); // pre-batch heartbeat (0 = claim lost to a reclaim, or a passed deadline)
  const queues = {
    newsletter_sends: [
      chain({ first: send }),                              // fetch send
      chain({ updated: 1, returning: [{ id: send?.id }] }),// atomic claim
      heartbeat,
      // A deadline that passed: the re-read finds the claim still this worker's, so it stops and finalizes.
      ...(deadlineReached ? [chain({ first: { id: send?.id } })] : []),
      // A lost claim must consume nothing further from this queue.
      ...(truncateSendsQueueAfterHeartbeat ? [] : [
        chain({ updated: finalUpdated, onUpdate: onFinalUpdate }), // final status update (0 = claim rotated after last batch)
        // Loser at finalization never re-fetches for the social share.
        ...(finalUpdated ? [chain({ first: null })] : []),
      ]),
    ],
    newsletter_subscribers: [
      // 0-recipient guard: a count, or for a planned audience the rows the plan's rule is applied to.
      chain({ count: subscribers.length, result: subscribers.map((s) => ({
        id: s.id, customer_id: s.customer_id ?? null, email: s.email, mailbox_customer_ids: mailboxCustomers[s.id] || [],
      })) }),
      chain({ result: subscribers }),                       // fetch
      // Per-chunk eligibility re-check right before SendGrid (status='active'
      // + archived-customer anti-join). Selects id AND customer_id — the link
      // can have moved to a live twin since selection. Default: everyone still
      // eligible, on the same customer they were selected with.
      chain({ result: (eligibleAtDispatch || subscribers).map((e) => ({
        id: e.id,
        customer_id: e.customer_id !== undefined
          ? e.customer_id
          : ((subscribers.find((s) => s.id === e.id) || {}).customer_id ?? null),
        // The address on file at dispatch: the selected one unless a test moves it.
        email: e.email !== undefined ? e.email : ((subscribers.find((s) => s.id === e.id) || {}).email ?? null),
        mailbox_customer_ids: mailboxCustomers[e.id] || [],
      })) }),
    ],
    newsletter_send_deliveries: [
      chain({ first: null }),                               // ledger guard: no rows yet → seed
      chain({}),                                            // insert onConflict
      chain({ result: deliveries }),                        // SELECT after insert
      // Terminal 'skipped' update for recipients that failed the dispatch
      // re-check — only consumed when eligibleAtDispatch drops someone.
      ...(eligibleAtDispatch ? [chain({ updated: skipUpdated ?? (subscribers.length - eligibleAtDispatch.length), onUpdate: onSkipUpdate })] : []),
      // bulk update post-send (none when the deadline stopped the send before its batch)
      ...(deadlineReached ? [] : [chain({ updated: (eligibleAtDispatch || subscribers).length })]),
      chain({ count: retryableLeft }),                      // final retryable ledger count
    ],
    // A planned Waves Pest Insider issue's row (moveIssueForSend).
    pest_insider_issues: [chain({ updated: 1, onUpdate: onIssueUpdate, onWhereIn: onIssueWhereIn })],
    // Calendar lifecycle: sendCampaign advances the linked calendar row to
    // 'sent' on a successful send. (markEventsFeatured only touches events_raw
    // when send.event_ids is non-empty — the fixtures leave it empty, so no
    // events_raw queue is needed.)
    newsletter_calendar: [
      chain({ updated: 1, onUpdate: onCalendarUpdate }),
    ],
  };
  const subscriberQueries = [...queues.newsletter_subscribers];
  db.mockImplementation((table) => {
    const queue = queues[table];
    if (!queue || !queue.length) {
      throw new Error(`Unexpected db table: ${table} (queue exhausted)`);
    }
    return queue.shift();
  });
  return { guard: subscriberQueries[0], recheck: subscriberQueries[2], heartbeat };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('sendCampaign — per-recipient idempotency (I5 layer 2)', () => {
  test('a subscriber archived between selection and dispatch is skipped: no SendGrid payload, delivery row terminal, not counted', async () => {
    let skipUpdate = null;
    buildDb({
      send: {
        id: 'send-1', status: 'draft', html_body: '<p>Body</p>', text_body: 'Body', subject: 'Hello',
        from_email: 'newsletter@wavespestcontrol.com', from_name: 'Waves', reply_to: 'contact@wavespestcontrol.com',
        segment_filter: null, subject_b: null,
      },
      subscribers: [
        { id: 1, email: 'a@example.com', unsubscribe_token: 'tok-a', customer_id: 'cust-live' },
        { id: 2, email: 'b@example.com', unsubscribe_token: 'tok-b', customer_id: 'cust-archived' },
      ],
      deliveries: [
        { id: 'd-1', subscriber_id: 1, status: 'queued', ab_variant: null },
        { id: 'd-2', subscriber_id: 2, status: 'queued', ab_variant: null },
      ],
      // The re-check (same predicate as selection) no longer returns #2.
      eligibleAtDispatch: [{ id: 1 }],
      onSkipUpdate: (payload) => { skipUpdate = payload; },
    });

    const result = await sendCampaign('send-1');

    expect(mockSendBroadcast).toHaveBeenCalledTimes(1);
    expect(mockSendBroadcast.mock.calls[0][0].recipients.map((r) => r.email)).toEqual(['a@example.com']);
    expect(skipUpdate).toMatchObject({ status: 'skipped', bounce_reason: 'ineligible_at_dispatch', send_attempt_token: null });
    expect(RETRYABLE_DELIVERY_STATUSES_FOR_TEST).not.toContain('skipped');
    expect(result.skipped_ineligible).toBe(1);
    expect(result.recipients).toBe(1);
    expect(result.accepted).toBe(1);
  });

  test('a planned issue skips a reader whose customer, as linked at dispatch, is in its holdout (a lead linked after the plan)', async () => {
    let skipUpdate = null;
    buildDb({
      send: {
        id: 'send-1', status: 'draft', html_body: '<p>Body</p>', text_body: 'Body', subject: 'Hello',
        from_email: 'newsletter@wavespestcontrol.com', from_name: 'Waves', reply_to: 'contact@wavespestcontrol.com',
        segment_filter: { subscriber_ids: [1, 2], holdout: 'pest-insider', address_keys: PLANNED_KEYS }, subject_b: null,
      },
      // #1 was a lead when the issue was planned; #2 a kept customer.
      subscribers: [
        { id: 1, email: 'a@example.com', unsubscribe_token: 'tok-a', customer_id: null },
        { id: 2, email: 'b@example.com', unsubscribe_token: 'tok-b', customer_id: KEPT_CUSTOMER },
      ],
      deliveries: [
        { id: 'd-1', subscriber_id: 1, status: 'queued', ab_variant: null },
        { id: 'd-2', subscriber_id: 2, status: 'queued', ab_variant: null },
      ],
      // Both still pass the eligibility query, but #1 is now linked to a held-out customer.
      eligibleAtDispatch: [{ id: 1, customer_id: HELD_CUSTOMER }, { id: 2 }],
      skipUpdated: 1,
      onSkipUpdate: (payload) => { skipUpdate = payload; },
    });

    const result = await sendCampaign('send-1');

    expect(mockSendBroadcast).toHaveBeenCalledTimes(1);
    expect(mockSendBroadcast.mock.calls[0][0].recipients.map((r) => r.email)).toEqual(['b@example.com']);
    expect(skipUpdate).toMatchObject({ status: 'skipped', bounce_reason: 'ineligible_at_dispatch', send_attempt_token: null });
    expect(result.skipped_ineligible).toBe(1);
    expect(result.recipients).toBe(1);
  });

  test('a send that names no holdout mails the same held-out customer (the check is the send\'s own)', async () => {
    buildDb({
      send: {
        id: 'send-1', status: 'draft', html_body: '<p>Body</p>', text_body: 'Body', subject: 'Hello',
        from_email: 'newsletter@wavespestcontrol.com', from_name: 'Waves', reply_to: 'contact@wavespestcontrol.com',
        segment_filter: { subscriber_ids: [1] }, subject_b: null,
      },
      subscribers: [{ id: 1, email: 'a@example.com', unsubscribe_token: 'tok-a', customer_id: HELD_CUSTOMER }],
      deliveries: [{ id: 'd-1', subscriber_id: 1, status: 'queued', ab_variant: null }],
    });

    const result = await sendCampaign('send-1');

    expect(mockSendBroadcast.mock.calls[0][0].recipients.map((r) => r.email)).toEqual(['a@example.com']);
    expect(result.skipped_ineligible).toBe(0);
  });

  test('a planned issue mails each reader only at the address the plan qualified', async () => {
    let skipUpdate = null;
    buildDb({
      send: {
        id: 'send-1', status: 'draft', html_body: '<p>Body</p>', text_body: 'Body', subject: 'Hello',
        from_email: 'newsletter@wavespestcontrol.com', from_name: 'Waves', reply_to: 'contact@wavespestcontrol.com',
        segment_filter: { subscriber_ids: [1, 2], holdout: 'pest-insider', address_keys: PLANNED_KEYS }, subject_b: null,
      },
      // #1's address was corrected after the plan; #2 kept the address that opened Waves mail (case aside).
      subscribers: [
        { id: 1, email: 'a-corrected@example.com', unsubscribe_token: 'tok-a', customer_id: null },
        { id: 2, email: 'B@Example.com', unsubscribe_token: 'tok-b', customer_id: KEPT_CUSTOMER },
      ],
      deliveries: [
        { id: 'd-1', subscriber_id: 1, status: 'queued', ab_variant: null },
        { id: 'd-2', subscriber_id: 2, status: 'queued', ab_variant: null },
      ],
      eligibleAtDispatch: [{ id: 1 }, { id: 2, customer_id: KEPT_CUSTOMER }],
      skipUpdated: 1,
      onSkipUpdate: (payload) => { skipUpdate = payload; },
    });
    const info = jest.spyOn(require('../services/logger'), 'info');

    const result = await sendCampaign('send-1');

    expect(mockSendBroadcast.mock.calls[0][0].recipients.map((r) => r.email)).toEqual(['B@Example.com']);
    expect(skipUpdate).toMatchObject({ status: 'skipped', bounce_reason: 'ineligible_at_dispatch', send_attempt_token: null });
    expect(result.skipped_ineligible).toBe(1);
    // The send log shows the planned audience as counts: no id list, no address key.
    const logged = info.mock.calls.map(([line]) => String(line)).join('\n');
    info.mockRestore();
    expect(logged).toContain('"subscriber_ids":"2 ids"');
    expect(logged).toContain('"address_keys":"2 keys"');
    Object.values(PLANNED_KEYS).forEach((key) => expect(logged).not.toContain(key));
  });

  test('a planned issue skips a reader whose mailbox has a held-out customer behind it (an alias row or a customer email)', async () => {
    let skipUpdate = null;
    const { recheck } = buildDb({
      send: {
        id: 'send-1', status: 'draft', html_body: '<p>Body</p>', text_body: 'Body', subject: 'Hello',
        from_email: 'newsletter@wavespestcontrol.com', from_name: 'Waves', reply_to: 'contact@wavespestcontrol.com',
        segment_filter: PLANNED_PI, subject_b: null,
      },
      // #1 is a lead; a held-out customer sits behind its mailbox. #2 has only a kept customer.
      subscribers: [
        { id: 1, email: 'a@example.com', unsubscribe_token: 'tok-a', customer_id: null },
        { id: 2, email: 'b@example.com', unsubscribe_token: 'tok-b', customer_id: KEPT_CUSTOMER },
      ],
      deliveries: [
        { id: 'd-1', subscriber_id: 1, status: 'queued', ab_variant: null },
        { id: 'd-2', subscriber_id: 2, status: 'queued', ab_variant: null },
      ],
      eligibleAtDispatch: [{ id: 1 }, { id: 2 }],
      skipUpdated: 1,
      onSkipUpdate: (payload) => { skipUpdate = payload; },
      mailboxCustomers: { 1: [HELD_CUSTOMER], 2: [KEPT_CUSTOMER] },
    });
    // At the 0-recipient guard #1 does not count and #2 does, so the send goes ahead.

    const result = await sendCampaign('send-1');

    // The batch's re-check reads the mailbox's customers in its own query, not a second one.
    expect(recheck.joinRaw).toHaveBeenCalledWith(expect.stringContaining('LEFT JOIN mailbox_customers'));
    expect(mockSendBroadcast.mock.calls[0][0].recipients.map((r) => r.email)).toEqual(['b@example.com']);
    expect(skipUpdate).toMatchObject({ status: 'skipped', bounce_reason: 'ineligible_at_dispatch' });
    expect(result.skipped_ineligible).toBe(1);
  });

  test('a planned issue counts by the rule each batch applies: a reader whose address changed since the plan counts nobody, and nothing is claimed', async () => {
    const { guard } = buildDb({
      send: {
        id: 'send-1', status: 'draft', html_body: '<p>Body</p>', text_body: 'Body', subject: 'Hello',
        from_email: 'newsletter@wavespestcontrol.com', from_name: 'Waves', reply_to: 'contact@wavespestcontrol.com',
        segment_filter: { subscriber_ids: [1], holdout: 'pest-insider', address_keys: { 1: PLANNED_KEYS[1] } }, subject_b: null,
      },
      // The only planned reader's address was corrected after the plan.
      subscribers: [{ id: 1, email: 'a-corrected@example.com', unsubscribe_token: 'tok-a', customer_id: null }],
    });

    await expect(sendCampaign('send-1')).rejects.toMatchObject({ code: 'EMPTY_SEGMENT' });
    // The planned count reads rows through the mailbox join; it never takes a bare count.
    expect(guard.joinRaw).toHaveBeenCalledWith(expect.stringContaining('LEFT JOIN mailbox_customers'));
    expect(guard.count).not.toHaveBeenCalled();
    expect(mockSendBroadcast).not.toHaveBeenCalled();
  });

  test('a planned issue skips a reader whose address on file changed after the batch was loaded', async () => {
    let skipUpdate = null;
    buildDb({
      send: {
        id: 'send-1', status: 'draft', html_body: '<p>Body</p>', text_body: 'Body', subject: 'Hello',
        from_email: 'newsletter@wavespestcontrol.com', from_name: 'Waves', reply_to: 'contact@wavespestcontrol.com',
        segment_filter: { subscriber_ids: [1, 2], holdout: 'pest-insider', address_keys: PLANNED_KEYS }, subject_b: null,
      },
      // Loaded at the planned addresses; #1's was corrected while earlier batches went out.
      subscribers: [
        { id: 1, email: 'a@example.com', unsubscribe_token: 'tok-a', customer_id: null },
        { id: 2, email: 'b@example.com', unsubscribe_token: 'tok-b', customer_id: KEPT_CUSTOMER },
      ],
      deliveries: [
        { id: 'd-1', subscriber_id: 1, status: 'queued', ab_variant: null },
        { id: 'd-2', subscriber_id: 2, status: 'queued', ab_variant: null },
      ],
      eligibleAtDispatch: [{ id: 1, email: 'a-corrected@example.com' }, { id: 2 }],
      skipUpdated: 1,
      onSkipUpdate: (payload) => { skipUpdate = payload; },
    });

    const result = await sendCampaign('send-1');

    expect(mockSendBroadcast.mock.calls[0][0].recipients.map((r) => r.email)).toEqual(['b@example.com']);
    expect(skipUpdate).toMatchObject({ status: 'skipped', bounce_reason: 'ineligible_at_dispatch' });
    expect(result.skipped_ineligible).toBe(1);
  });

  test.each([
    ['no address keys', { subscriber_ids: [1, 2] }],
    ['address keys that are not an object', { subscriber_ids: [1, 2], address_keys: ['k1', 'k2'] }],
    ['no address key for one reader', { subscriber_ids: [1, 2], address_keys: { 1: PLANNED_KEYS[1] } }],
    ['an empty reader list', { subscriber_ids: [], address_keys: PLANNED_KEYS }],
    ['no reader list', { address_keys: PLANNED_KEYS }],
    ['a key that is not an address key', { subscriber_ids: [1, 2], address_keys: { 1: PLANNED_KEYS[1], 2: 'key-2' } }],
    ['an empty key', { subscriber_ids: [1, 2], address_keys: { 1: PLANNED_KEYS[1], 2: '' } }],
  ])('a planned issue with %s is refused before any claim work, so it never ends sent to nobody', async (_label, plan) => {
    const queues = {
      newsletter_sends: [chain({ first: {
        id: 'send-1', status: 'draft', html_body: '<p>Body</p>', text_body: 'Body', subject: 'Hello',
        segment_filter: { holdout: 'pest-insider', ...plan }, subject_b: null,
      } })], // the fetch, and nothing else: a claim would read the queue and throw
    };
    db.mockImplementation((table) => {
      const queue = queues[table];
      if (!queue || !queue.length) throw new Error(`unexpected ${table}`);
      return queue.shift();
    });

    await expect(sendCampaign('send-1')).rejects.toMatchObject({ code: 'INCOMPLETE_PLAN', audienceRefusal: true });
    expect(mockSendBroadcast).not.toHaveBeenCalled();
  });

  test.each([
    ['reached every reader: its planned issue row becomes sent', 0, expect.objectContaining({ status: 'sent' })],
    ['ended with a reader still to resume (a batch SendGrid refused): its row is left to settlePlannedIssues, which tells the owner', 1, null],
  ])('a planned issue whose send %s', async (_label, retryableLeft, expected) => {
    let issueUpdate = null;
    let issueFrom = null;
    buildDb({
      send: {
        id: 'send-1', status: 'draft', newsletter_type: 'pest-insider-monthly', html_body: '<p>Body</p>', text_body: 'Body',
        subject: 'Hello', from_email: 'newsletter@wavespestcontrol.com', from_name: 'Waves', reply_to: 'contact@wavespestcontrol.com',
        segment_filter: PLANNED_PI, subject_b: null,
      },
      subscribers: [
        { id: 1, email: 'a@example.com', unsubscribe_token: 'tok-a', customer_id: null },
        { id: 2, email: 'b@example.com', unsubscribe_token: 'tok-b', customer_id: null },
      ],
      deliveries: [
        { id: 'd-1', subscriber_id: 1, status: 'queued', ab_variant: null },
        { id: 'd-2', subscriber_id: 2, status: 'queued', ab_variant: null },
      ],
      retryableLeft,
      onIssueUpdate: (payload) => { issueUpdate = payload; },
      onIssueWhereIn: (column, values) => { if (column === 'status') issueFrom = values; },
    });

    await sendCampaign('send-1');

    expect(mockSendBroadcast).toHaveBeenCalledTimes(1);
    expect(issueUpdate).toEqual(expected);
    // A 'failed' row is settlePlannedIssues': the Resume that finishes its send moves it there, with one correction if told.
    if (expected) expect(issueFrom).toEqual(['drafted', 'scheduled', 'held']);
  });

  test('a planned issue whose every batch SendGrid refused ends failed; its planned issue row is left to settlePlannedIssues', async () => {
    mockTrigger.mockClear();
    mockSendBroadcast.mockRejectedValueOnce(new Error('SendGrid 503'));
    let issueUpdate = null;
    let finalUpdate = null;
    buildDb({
      send: {
        id: 'send-1', status: 'draft', newsletter_type: 'pest-insider-monthly', html_body: '<p>Body</p>', text_body: 'Body',
        subject: 'Hello', from_email: 'newsletter@wavespestcontrol.com', from_name: 'Waves', reply_to: 'contact@wavespestcontrol.com',
        segment_filter: PLANNED_PI, subject_b: null,
      },
      subscribers: [
        { id: 1, email: 'a@example.com', unsubscribe_token: 'tok-a', customer_id: null },
        { id: 2, email: 'b@example.com', unsubscribe_token: 'tok-b', customer_id: null },
      ],
      deliveries: [
        { id: 'd-1', subscriber_id: 1, status: 'queued', ab_variant: null },
        { id: 'd-2', subscriber_id: 2, status: 'queued', ab_variant: null },
      ],
      retryableLeft: 2,
      onIssueUpdate: (payload) => { issueUpdate = payload; },
      onFinalUpdate: (payload) => { finalUpdate = payload; },
    });

    const result = await sendCampaign('send-1');

    expect(result).toMatchObject({ accepted: 0, failed: 2 });
    expect(finalUpdate).toMatchObject({ status: 'failed' });
    // settlePlannedIssues reads the failed send, fails the row and raises the one alert.
    expect(issueUpdate).toBeNull();
    expect(mockTrigger).not.toHaveBeenCalled();
  });

  test('a planned issue whose every reader dropped out at dispatch is sent to nobody; its planned issue row is left to settlePlannedIssues', async () => {
    mockTrigger.mockClear();
    let issueUpdate = null;
    buildDb({
      send: {
        id: 'send-1', status: 'draft', newsletter_type: 'pest-insider-monthly', html_body: '<p>Body</p>', text_body: 'Body',
        subject: 'Hello', from_email: 'newsletter@wavespestcontrol.com', from_name: 'Waves', reply_to: 'contact@wavespestcontrol.com',
        segment_filter: PLANNED_PI, subject_b: null,
      },
      subscribers: [
        { id: 1, email: 'a@example.com', unsubscribe_token: 'tok-a', customer_id: null },
        { id: 2, email: 'b@example.com', unsubscribe_token: 'tok-b', customer_id: null },
      ],
      deliveries: [
        { id: 'd-1', subscriber_id: 1, status: 'queued', ab_variant: null },
        { id: 'd-2', subscriber_id: 2, status: 'queued', ab_variant: null },
      ],
      // Both readers unsubscribed between the count and the batch.
      eligibleAtDispatch: [],
      onIssueUpdate: (payload) => { issueUpdate = payload; },
    });

    const result = await sendCampaign('send-1');

    expect(mockSendBroadcast).not.toHaveBeenCalled();
    // Sent to nobody (recipient_count 0): settlePlannedIssues reads that as not delivered.
    expect(result).toMatchObject({ recipients: 0, skipped_ineligible: 2 });
    expect(issueUpdate).toBeNull();
    expect(mockTrigger).not.toHaveBeenCalled();
  });

  test("a send deadline (a planned issue's 10:00 AM ET) that passed before a batch stops the send there: no batch goes to SendGrid, and it ends failed", async () => {
    let finalUpdate = null;
    const { heartbeat } = buildDb({
      send: {
        id: 'send-1', status: 'scheduled', newsletter_type: 'pest-insider-monthly', html_body: '<p>Body</p>', text_body: 'Body',
        subject: 'Hello', from_email: 'newsletter@wavespestcontrol.com', from_name: 'Waves', reply_to: 'contact@wavespestcontrol.com',
        segment_filter: PLANNED_PI, subject_b: null,
      },
      subscribers: [
        { id: 1, email: 'a@example.com', unsubscribe_token: 'tok-a', customer_id: null },
        { id: 2, email: 'b@example.com', unsubscribe_token: 'tok-b', customer_id: null },
      ],
      deliveries: [
        { id: 'd-1', subscriber_id: 1, status: 'queued', ab_variant: null },
        { id: 'd-2', subscriber_id: 2, status: 'queued', ab_variant: null },
      ],
      retryableLeft: 2,
      deadlineReached: true,
      onFinalUpdate: (payload) => { finalUpdate = payload; },
    });
    const notAfter = new Date('2026-12-03T15:00:00Z');

    const result = await sendCampaign('send-1', { expect: { status: 'scheduled', notAfter } });

    // The heartbeat before the batch carries the deadline, on the database clock.
    expect(heartbeat.whereRaw).toHaveBeenCalledWith('clock_timestamp() < ?::timestamptz', [notAfter]);
    expect(mockSendBroadcast).not.toHaveBeenCalled();
    expect(result).toMatchObject({ accepted: 0 });
    expect(result.lostClaim).toBeUndefined();
    // Its unsent rows stay queued for a resume; settlePlannedIssues tells the owner.
    expect(finalUpdate).toMatchObject({ status: 'failed' });
  });

  test('a holdout name this server does not know stops a first send before anything is sent', async () => {
    buildDb({
      send: {
        id: 'send-1', status: 'draft', html_body: '<p>Body</p>', text_body: 'Body', subject: 'Hello',
        from_email: 'newsletter@wavespestcontrol.com', from_name: 'Waves', reply_to: 'contact@wavespestcontrol.com',
        segment_filter: { subscriber_ids: [1], holdout: 'pest-insider-v2' }, subject_b: null,
      },
      subscribers: [{ id: 1, email: 'a@example.com', unsubscribe_token: 'tok-a', customer_id: KEPT_CUSTOMER }],
      deliveries: [{ id: 'd-1', subscriber_id: 1, status: 'queued', ab_variant: null }],
    });

    await expect(sendCampaign('send-1')).rejects.toMatchObject({ code: 'UNKNOWN_HOLDOUT' });
    expect(mockSendBroadcast).not.toHaveBeenCalled();
  });

  test.each([
    ['no segment filter', null],
    ['a filter with no holdout', { subscriber_ids: [1, 2] }],
  ])('a Waves Pest Insider issue with %s stops a first send before any claim work', async (_label, segmentFilter) => {
    const queues = {
      newsletter_sends: [chain({ first: {
        id: 'send-1', status: 'draft', newsletter_type: 'pest-insider-monthly', html_body: '<p>Body</p>', text_body: 'Body',
        subject: 'Hello', segment_filter: segmentFilter, subject_b: null,
      } })], // the fetch, and nothing else: a claim would read the queue and throw
    };
    db.mockImplementation((table) => {
      const queue = queues[table];
      if (!queue || !queue.length) throw new Error(`unexpected ${table}`);
      return queue.shift();
    });

    await expect(sendCampaign('send-1')).rejects.toMatchObject({ code: 'UNPLANNED_AUDIENCE' });
    expect(mockSendBroadcast).not.toHaveBeenCalled();
  });

  test('a row a webhook already terminalized: recipient still excluded from the payload, but NOT counted as skipped here', async () => {
    let skipUpdate = null;
    buildDb({
      send: {
        id: 'send-1', status: 'draft', html_body: '<p>Body</p>', text_body: 'Body', subject: 'Hello',
        from_email: 'newsletter@wavespestcontrol.com', from_name: 'Waves', reply_to: 'contact@wavespestcontrol.com',
        segment_filter: null, subject_b: null,
      },
      subscribers: [
        { id: 1, email: 'a@example.com', unsubscribe_token: 'tok-a', customer_id: 'cust-live' },
        { id: 2, email: 'b@example.com', unsubscribe_token: 'tok-b', customer_id: 'cust-archived' },
      ],
      deliveries: [
        { id: 'd-1', subscriber_id: 1, status: 'queued', ab_variant: null },
        { id: 'd-2', subscriber_id: 2, status: 'queued', ab_variant: null },
      ],
      eligibleAtDispatch: [{ id: 1 }],
      // The skip write matches ZERO rows: a bounce webhook moved d-2 to a
      // terminal state between selection and dispatch.
      skipUpdated: 0,
      onSkipUpdate: (payload) => { skipUpdate = payload; },
    });

    const result = await sendCampaign('send-1');

    // Payload: excluded regardless — eligibility failed, so we do not mail it.
    expect(mockSendBroadcast).toHaveBeenCalledTimes(1);
    expect(mockSendBroadcast.mock.calls[0][0].recipients.map((r) => r.email)).toEqual(['a@example.com']);
    expect(skipUpdate).toMatchObject({ status: 'skipped' });
    // Counters: this write transitioned nothing, so nothing is counted here
    // (the webhook's own terminal state already accounts for that row).
    expect(result.skipped_ineligible).toBe(0);
    expect(result.recipients).toBe(2);
    expect(result.accepted).toBe(1);
  });

  test('a subscriber relinked to its live twin between selection and dispatch: payload personalization AND the touchpoint use the TWIN', async () => {
    const send = {
      id: 'send-1', status: 'draft', html_body: '<p>Body {{city}}</p>', text_body: 'Body {{city}}', subject: 'Hello',
      from_email: 'newsletter@wavespestcontrol.com', from_name: 'Waves', reply_to: 'contact@wavespestcontrol.com',
      segment_filter: null, subject_b: null, created_by: 'admin-1',
    };
    const recheckQuery = chain({ result: [{ id: 1, customer_id: 'cust-twin' }] });
    const queues = {
      newsletter_sends: [
        chain({ first: send }),
        chain({ returning: [{ id: 'send-1' }] }),                     // atomic claim
        chain({ updated: 1 }),                                        // per-chunk heartbeat
        chain({ updated: 1 }),                                        // final update
        chain({ first: null }),                                       // social-share refetch
      ],
      newsletter_subscribers: [
        chain({ count: 1 }),                                          // 0-recipient guard
        // Selection: still linked to the profile that is about to be archived.
        chain({ result: [{ id: 1, email: 'a@example.com', unsubscribe_token: 'tok-a', customer_id: 'cust-archived', first_name: null }] }),
        // Dispatch re-check: the archive transaction relinked this subscriber
        // to the live twin. Still eligible — but on a DIFFERENT customer.
        recheckQuery,
      ],
      newsletter_send_deliveries: [
        chain({ first: null }),                                      // ledger guard: no rows yet → seed
        chain({}),                                                    // insert onConflict
        chain({ result: [{ id: 'd-1', subscriber_id: 1, status: 'queued', ab_variant: null }] }),
        chain({ updated: 1 }),                                        // post-send bulk update
        chain({ count: 0 }),                                          // final retryable ledger count
      ],
      // loadPersonalizationContext: first for the selected (archived) id,
      // then the top-up for the twin the re-check returned.
      customers: [
        chain({ result: [{ id: 'cust-archived', city: 'Archived City', lawn_type: null }] }),
        chain({ result: [{ id: 'cust-twin', city: 'Twin City', lawn_type: null }] }),
      ],
      customer_turf_profiles: [chain({ result: [] }), chain({ result: [] })],
      newsletter_calendar: [chain({ updated: 1 })],
    };
    db.mockImplementation((table) => {
      const queue = queues[table];
      if (!queue || !queue.length) throw new Error(`unexpected ${table}`);
      return queue.shift();
    });

    const result = await sendCampaign('send-1');

    expect(result.accepted).toBe(1);
    // The re-check must ASK for customer_id — selecting only id would leave
    // the stale link in place with no way to notice.
    expect(recheckQuery.select).toHaveBeenCalledWith('id', 'customer_id', 'email');
    // Personalization resolves from the TWIN, not the archived profile.
    const recipient = mockSendBroadcast.mock.calls[0][0].recipients[0];
    expect(recipient.email).toBe('a@example.com');
    expect(recipient.substitutions['{{city}}']).toBe('Twin City');
    // …and the comms-history touchpoint is filed against the TWIN.
    expect(recordTouchpoint).toHaveBeenCalledTimes(1);
    expect(recordTouchpoint.mock.calls[0][0]).toMatchObject({ customerId: 'cust-twin', contactEmail: 'a@example.com' });
  });

  test('passes custom_args.delivery_id + send_id on each recipient', async () => {
    buildDb({
      send: {
        id: 'send-1',
        status: 'draft',
        html_body: '<p>Body</p>',
        text_body: 'Body',
        subject: 'Hello',
        from_email: 'newsletter@wavespestcontrol.com',
        from_name: 'Waves',
        reply_to: 'contact@wavespestcontrol.com',
        segment_filter: null,
        subject_b: null,
      },
      subscribers: [
        { id: 1, email: 'a@example.com', unsubscribe_token: 'tok-a', customer_id: null },
        { id: 2, email: 'b@example.com', unsubscribe_token: 'tok-b', customer_id: null },
      ],
      deliveries: [
        { id: 'd-1', subscriber_id: 1, status: 'queued', ab_variant: null },
        { id: 'd-2', subscriber_id: 2, status: 'queued', ab_variant: null },
      ],
    });

    await sendCampaign('send-1');

    expect(mockSendBroadcast).toHaveBeenCalledTimes(1);
    const args = mockSendBroadcast.mock.calls[0][0];
    expect(args.recipients).toHaveLength(2);
    expect(args.recipients[0].customArgs).toEqual({ delivery_id: 'd-1', send_id: 'send-1' });
    expect(args.recipients[1].customArgs).toEqual({ delivery_id: 'd-2', send_id: 'send-1' });
  });

  test('skips subscribers whose delivery row is in terminal-success state', async () => {
    buildDb({
      send: {
        id: 'send-1',
        status: 'draft',
        html_body: '<p>Body</p>',
        text_body: 'Body',
        subject: 'Hello',
        from_email: 'newsletter@wavespestcontrol.com',
        from_name: 'Waves',
        reply_to: 'contact@wavespestcontrol.com',
        segment_filter: null,
        subject_b: null,
      },
      subscribers: [
        { id: 1, email: 'a@example.com', unsubscribe_token: 'tok-a', customer_id: null },
        { id: 2, email: 'b@example.com', unsubscribe_token: 'tok-b', customer_id: null },
        { id: 3, email: 'c@example.com', unsubscribe_token: 'tok-c', customer_id: null },
      ],
      // subscriber 1 already delivered (resume scenario); 2 + 3 still queued
      deliveries: [
        { id: 'd-1', subscriber_id: 1, status: 'delivered', ab_variant: null },
        { id: 'd-2', subscriber_id: 2, status: 'queued', ab_variant: null },
        { id: 'd-3', subscriber_id: 3, status: 'failed', ab_variant: null },
      ],
    });

    await sendCampaign('send-1');

    expect(mockSendBroadcast).toHaveBeenCalledTimes(1);
    const args = mockSendBroadcast.mock.calls[0][0];
    expect(args.recipients).toHaveLength(2);
    expect(args.recipients.map((r) => r.email).sort()).toEqual(['b@example.com', 'c@example.com']);
  });

  test('does not retry bounced, complained, or engagement-recovered rows', async () => {
    buildDb({
      send: {
        id: 'send-1',
        status: 'draft',
        html_body: '<p>Body</p>',
        text_body: 'Body',
        subject: 'Hello',
        from_email: 'newsletter@wavespestcontrol.com',
        from_name: 'Waves',
        reply_to: 'contact@wavespestcontrol.com',
        segment_filter: null,
        subject_b: null,
      },
      subscribers: [
        { id: 1, email: 'retry@example.com', unsubscribe_token: 'tok-retry', customer_id: null },
        { id: 2, email: 'bounce@example.com', unsubscribe_token: 'tok-bounce', customer_id: null },
        { id: 3, email: 'complaint@example.com', unsubscribe_token: 'tok-complaint', customer_id: null },
        { id: 4, email: 'opened@example.com', unsubscribe_token: 'tok-opened', customer_id: null },
      ],
      deliveries: [
        { id: 'd-1', subscriber_id: 1, status: 'failed', ab_variant: null },
        { id: 'd-2', subscriber_id: 2, status: 'bounced', ab_variant: null },
        { id: 'd-3', subscriber_id: 3, status: 'complained', ab_variant: null },
        { id: 'd-4', subscriber_id: 4, status: 'failed', opened_at: new Date('2026-05-01T10:00:00Z'), ab_variant: null },
      ],
    });

    await sendCampaign('send-1');

    expect(mockSendBroadcast).toHaveBeenCalledTimes(1);
    expect(mockSendBroadcast.mock.calls[0][0].recipients.map((r) => r.email)).toEqual(['retry@example.com']);
  });

  test('all-skip case still completes without calling SendGrid', async () => {
    buildDb({
      send: {
        id: 'send-1',
        status: 'draft',
        html_body: '<p>Body</p>',
        text_body: 'Body',
        subject: 'Hello',
        from_email: 'newsletter@wavespestcontrol.com',
        from_name: 'Waves',
        reply_to: 'contact@wavespestcontrol.com',
        segment_filter: null,
        subject_b: null,
      },
      subscribers: [
        { id: 1, email: 'a@example.com', unsubscribe_token: 'tok-a', customer_id: null },
      ],
      deliveries: [
        { id: 'd-1', subscriber_id: 1, status: 'opened', ab_variant: null },
      ],
    });

    const result = await sendCampaign('send-1');

    expect(mockSendBroadcast).not.toHaveBeenCalled();
    expect(result.recipients).toBe(1);
    expect(result.skipped_already_sent).toBe(1);
  });

  test('a worker whose claim was reclaimed stops after the chunk and never finalizes', async () => {
    // Heartbeat returns 0 rows (stale-reclaim rotated sending_claim_token
    // under a new owner) → the loser must stop: no final status update, no
    // social-share re-fetch. The strict queue mock proves it — neither entry
    // is provided, so consuming one would throw.
    buildDb({
      send: {
        id: 'send-1',
        status: 'draft',
        html_body: '<p>Body</p>',
        text_body: 'Body',
        subject: 'Hello',
        from_email: 'newsletter@wavespestcontrol.com',
        from_name: 'Waves',
        reply_to: 'contact@wavespestcontrol.com',
        segment_filter: null,
        subject_b: null,
      },
      subscribers: [{ id: 1, email: 'a@example.com', unsubscribe_token: 'tok-a', customer_id: null }],
      deliveries: [{ id: 'd-1', subscriber_id: 1, status: 'queued', ab_variant: null }],
      heartbeatUpdated: 0,
      truncateSendsQueueAfterHeartbeat: true,
    });

    const result = await sendCampaign('send-1');
    expect(result.lostClaim).toBe(true);
    // The ownership check runs BEFORE the external call — a reclaimed
    // worker mails nothing (Codex r3: check before each batch, not after).
    expect(result.accepted).toBe(0);
    expect(mockSendBroadcast).not.toHaveBeenCalled();
  });

  test('a claim lost at FINALIZATION skips calendar/feature/social side effects', async () => {
    let calendarTouched = false;
    buildDb({
      send: {
        id: 'send-1',
        status: 'draft',
        html_body: '<p>Body</p>',
        text_body: 'Body',
        subject: 'Hello',
        from_email: 'newsletter@wavespestcontrol.com',
        from_name: 'Waves',
        reply_to: 'contact@wavespestcontrol.com',
        segment_filter: null,
        subject_b: null,
      },
      subscribers: [{ id: 1, email: 'a@example.com', unsubscribe_token: 'tok-a', customer_id: null }],
      deliveries: [{ id: 'd-1', subscriber_id: 1, status: 'queued', ab_variant: null }],
      finalUpdated: 0, // token rotated between the last batch and finalization
      onCalendarUpdate: () => { calendarTouched = true; },
    });

    const result = await sendCampaign('send-1');
    expect(result.lostClaim).toBe(true);
    expect(result.accepted).toBe(1); // the batch had already been accepted
    expect(calendarTouched).toBe(false); // the reclaiming owner runs the lifecycle
  });

  test('does not overwrite deliveries recovered by processed webhooks when SendGrid rejects', async () => {
    mockSendBroadcast.mockRejectedValueOnce(new Error('lost response'));
    let finalUpdate = null;
    const failureUpdate = chain({ updated: 1 });
    const queues = {
      newsletter_sends: [
        chain({
          first: {
            id: 'send-1',
            status: 'draft',
            html_body: '<p>Body</p>',
            text_body: 'Body',
            subject: 'Hello',
            from_email: 'newsletter@wavespestcontrol.com',
            from_name: 'Waves',
            reply_to: 'contact@wavespestcontrol.com',
            segment_filter: null,
            subject_b: null,
          },
        }),
        chain({ returning: [{ id: 'send-1' }] }),
        chain({ updated: 1 }), // per-chunk heartbeat (stale-lease keepalive)
        chain({ updated: 1, onUpdate: (payload) => { finalUpdate = payload; } }),
      ],
      newsletter_subscribers: [
        chain({ result: [
          { id: 1, email: 'a@example.com', unsubscribe_token: 'tok-a', customer_id: null },
          { id: 2, email: 'b@example.com', unsubscribe_token: 'tok-b', customer_id: null },
        ] }),
        // Per-chunk eligibility re-check right before SendGrid: everyone still eligible.
        chain({ result: [{ id: 1, customer_id: null }, { id: 2, customer_id: null }] }),
      ],
      newsletter_send_deliveries: [
        chain({ first: null }),                                      // ledger guard: no rows yet → seed
        chain({}),
        chain({ result: [
          { id: 'd-1', subscriber_id: 1, status: 'queued', ab_variant: null },
          { id: 'd-2', subscriber_id: 2, status: 'queued', ab_variant: null },
        ] }),
        failureUpdate,
        chain({ count: 0 }),
      ],
    };
    // Post-send side effects (PR D): on a successful 'sent' send the sender
    // advances the linked calendar row to 'sent' and the fire-and-forget
    // social share re-fetches the send row. Provide both so the strict mock
    // doesn't trip. (markEventsFeatured no-ops here — fixtures have no event_ids.)
    queues.newsletter_calendar = queues.newsletter_calendar || [chain({ updated: 1 })];
    queues.newsletter_sends.push(chain({ first: null }));
    db.mockImplementation((table) => {
      const queue = queues[table];
      if (!queue || !queue.length) throw new Error(`unexpected ${table}`);
      return queue.shift();
    });

    const result = await sendCampaign('send-1', { force: true });

    expect(failureUpdate.whereIn).toHaveBeenCalledWith('status', ['queued', 'failed', 'sending']);
    expect(failureUpdate.whereNull).toHaveBeenCalledWith('sent_at');
    expect(failureUpdate.whereNull).toHaveBeenCalledWith('opened_at');
    expect(result.failed).toBe(1);
    expect(finalUpdate.status).toBe('sent');
  });
});

describe('resumeCampaign — preconditions', () => {
  test("rejects 'draft' sends with NOT_RESUMABLE", async () => {
    db.mockImplementation((table) => {
      if (table === 'newsletter_sends') return chain({ first: { id: 's', status: 'draft', html_body: 'x', text_body: 'x' } });
      throw new Error(`unexpected ${table}`);
    });
    await expect(resumeCampaign('s')).rejects.toMatchObject({ code: 'NOT_RESUMABLE' });
  });

  test("rejects 'scheduled' sends with NOT_RESUMABLE", async () => {
    db.mockImplementation((table) => {
      if (table === 'newsletter_sends') return chain({ first: { id: 's', status: 'scheduled', html_body: 'x', text_body: 'x' } });
      throw new Error(`unexpected ${table}`);
    });
    await expect(resumeCampaign('s')).rejects.toMatchObject({ code: 'NOT_RESUMABLE' });
  });

  test("rejects 'sending' sends with STILL_SENDING (won't race a live worker)", async () => {
    db.mockImplementation((table) => {
      if (table === 'newsletter_sends') return chain({ first: { id: 's', status: 'sending', html_body: 'x', text_body: 'x' } });
      throw new Error(`unexpected ${table}`);
    });
    await expect(resumeCampaign('s')).rejects.toMatchObject({ code: 'STILL_SENDING' });
  });

  test("reclaims an expired 'sending' lease after a crash, even before delivery seeding", async () => {
    const staleSend = {
      id: 's',
      status: 'sending',
      updated_at: new Date(Date.now() - 60 * 60 * 1000),
      html_body: 'x',
      text_body: 'x',
    };
    const queues = {
      newsletter_sends: [
        chain({ first: staleSend }),
        chain({ returning: [{ id: 's' }] }),
      ],
      newsletter_send_deliveries: [chain({ count: 0 })],
    };
    db.mockImplementation((table) => queues[table].shift());

    await expect(prepareResumeCampaign('s')).resolves.toEqual({
      sendId: 's',
      existingDeliveriesOnly: false,
      preclaimed: true,
      claimToken: expect.any(String),
    });
  });

  test('hasOutstandingDeliveries applies the resume precheck\'s own eligibility: active subscriber, not globally suppressed, not archived, not explicitly opted out, retryable (codex round 17 P2; #5165)', async () => {
    const q = chain({ first: { id: 'd-1' } });
    db.mockImplementation((table) => { if (table !== 'newsletter_send_deliveries') throw new Error(`unexpected ${table}`); return q; });
    await expect(hasOutstandingDeliveries('s')).resolves.toBe(true);
    expect(q.join).toHaveBeenCalledWith('newsletter_subscribers', 'newsletter_subscribers.id', 'newsletter_send_deliveries.subscriber_id');
    expect(q.where).toHaveBeenCalledWith({ 'newsletter_subscribers.status': 'active' });
    expect(q.whereIn).toHaveBeenCalledWith('newsletter_send_deliveries.status', ['queued', 'failed', 'sending']);
    // global suppression + archived customer + explicit marketing opt-out
    // + non-mailable same-mailbox sibling + duplicate-ACTIVE-mailbox
    // canonical-row check (owner ruling 2026-09-29, #5165; codex P2 :224)
    expect(q.whereNotExists).toHaveBeenCalledTimes(5);
  });

  test('the correction-eligibility read and the resume precheck relink archived links BEFORE judging outstanding rows (codex round 18 P2)', async () => {
    const order = [];
    db.transaction.mockImplementation(async (cb) => { order.push('relink'); return cb({ raw: db.raw }); });
    const eligibility = chain({ first: { id: 'd-1' } });
    eligibility.first = jest.fn(async () => { order.push('eligibility'); return { id: 'd-1' }; });
    db.mockImplementation((table) => { if (table !== 'newsletter_send_deliveries') throw new Error(`unexpected ${table}`); return eligibility; });
    await expect(hasOutstandingDeliveries('s')).resolves.toBe(true);
    expect(order).toEqual(['relink', 'eligibility']);

    // The resume precheck: the ledger count, then the relink, then the
    // outstanding-eligible count — a row relinked to a live twin counts.
    order.length = 0;
    const failedSend = {
      id: 's', status: 'failed', newsletter_type: null, updated_at: new Date('2026-09-28T12:00:00Z'),
      subject: 'Hello', html_body: '<p>Body</p>', text_body: 'Body', event_ids: [],
    };
    const outstanding = chain();
    outstanding.count = jest.fn(() => ({ first: jest.fn(async () => { order.push('outstanding'); return { c: 0 }; }) }));
    const queues = {
      newsletter_sends: [chain({ first: failedSend }), chain({ first: null })],
      newsletter_send_deliveries: [chain({ count: 3 }), outstanding, chain({ updated: 0 })],
    };
    db.mockImplementation((table) => {
      const queue = queues[table];
      return queue && queue.length ? queue.shift() : chain();
    });
    await prepareResumeCampaign('s').catch(() => {});
    expect(order.slice(0, 2)).toEqual(['relink', 'outstanding']);
    db.transaction.mockImplementation(async (cb) => cb({ raw: db.raw }));
  });

  test('a correction saved between validation and the claim makes the claim miss: VERSION_CHANGED, nothing is sent (codex round 13 P1)', async () => {
    const failedSend = {
      id: 's', status: 'failed', newsletter_type: 'pest-insider-monthly', segment_filter: PLANNED_PI, updated_at: new Date('2026-09-28T12:00:00Z'),
      subject: 'Pest Insider — September', html_body: '<p>Fine copy about mowing height.</p>', text_body: 'Fine copy about mowing height.', event_ids: [],
    };
    const wheres = [];
    const claimChain = chain({ returning: [] }); // the version-bound claim finds no row: it was edited after validation
    const where = claimChain.where;
    claimChain.where = jest.fn((...args) => { wheres.push(args); return where(...args); });
    const queues = {
      newsletter_sends: [
        chain({ first: failedSend }),          // fetch + validate
        claimChain,                            // claim
        chain({ first: { status: 'failed' } }), // re-read: still failed → edited, not claimed elsewhere
      ],
      newsletter_send_deliveries: [
        chain({ count: 1 }),                   // ledger exists
        chain({ count: 1 }),                   // outstanding eligible rows
      ],
    };
    db.mockImplementation((table) => {
      const queue = queues[table];
      if (!queue || !queue.length) throw new Error(`unexpected ${table}`);
      return queue.shift();
    });
    await expect(prepareResumeCampaign('s')).rejects.toMatchObject({ code: 'VERSION_CHANGED' });
    expect(wheres).toContainEqual(['updated_at', '<', expect.any(Date)]);
  });

  test("a STALE 'sending' parent with zero eligible recipients is reclaimed and finalized — never left sending", async () => {
    const staleSend = {
      id: 's',
      status: 'sending',
      sent_at: new Date('2026-05-01T10:00:00Z'),
      updated_at: new Date(Date.now() - 60 * 60 * 1000),   // lease expired
      html_body: '<p>Body</p>',
      text_body: 'Body',
      subject: 'Hello',
      from_email: 'newsletter@wavespestcontrol.com',
      from_name: 'Waves',
      reply_to: 'contact@wavespestcontrol.com',
      segment_filter: null,
      subject_b: null,
      sending_claim_token: 'old-token',
    };
    let sweepUpdate = null;
    let finalUpdate = null;
    let finalQuery = null;
    const queues = {
      newsletter_sends: [
        chain({ first: staleSend }),                                  // resume fetch
        chain({ returning: [{ id: 's' }] }),                          // atomic reclaim (NOT skipped)
        chain({ first: { ...staleSend, status: 'sending' } }),        // sendCampaign fetch
      ],
      newsletter_send_deliveries: [
        chain({ count: 2 }),                                          // rows exist
        chain({ count: 0 }),                                          // none eligible
        chain({ updated: 2, onUpdate: (payload) => { sweepUpdate = payload; } }), // sweep
        chain({ result: [                                             // ledger after the sweep
          { id: 'd-1', subscriber_id: 1, status: 'skipped', ab_variant: null },
          { id: 'd-2', subscriber_id: 2, status: 'skipped', ab_variant: null },
        ] }),
        chain({ count: 0 }),                                          // final retryable ledger count
      ],
    };
    finalQuery = chain({ updated: 1, onUpdate: (payload) => { finalUpdate = payload; } });
    queues.newsletter_sends.push(finalQuery);                         // guarded final update
    db.mockImplementation((table) => {
      const queue = queues[table];
      if (!queue || !queue.length) throw new Error(`unexpected ${table}`);
      return queue.shift();
    });

    const result = await resumeCampaign('s');

    expect(sweepUpdate).toMatchObject({ status: 'skipped' });
    expect(mockSendBroadcast).not.toHaveBeenCalled();
    // The parent leaves 'sending' through the SAME guarded final update every
    // other send uses — no stale claim, terminal status, and skipped rows are
    // not counted as recipients.
    expect(finalUpdate).toMatchObject({ status: 'sent', recipient_count: 0 });
    expect(finalQuery.where).toHaveBeenCalledWith(expect.objectContaining({
      id: 's', status: 'sending', sending_claim_token: expect.any(String),
    }));
    expect(result.recipients).toBe(0);
  });

  test("rejects 'sent' with NOTHING_TO_RESUME when existing rows are all terminal-success", async () => {
    let sendsCalls = 0;
    let deliveriesCalls = 0;
    let sweepUpdate = null;
    db.mockImplementation((table) => {
      if (table === 'newsletter_sends') {
        sendsCalls++;
        return chain({ first: { id: 's', status: 'sent', html_body: 'x', text_body: 'x' } });
      }
      if (table === 'newsletter_send_deliveries') {
        deliveriesCalls++;
        if (deliveriesCalls === 1) return chain({ count: 1 });
        if (deliveriesCalls === 2) return chain({ count: 0 });
        // Pre-throw sweep. Its retryable filter matches nothing here (every
        // row is terminal-success), so it transitions zero rows.
        return chain({ updated: 0, onUpdate: (payload) => { sweepUpdate = payload; } });
      }
      throw new Error(`unexpected ${table}`);
    });
    await expect(resumeCampaign('s')).rejects.toMatchObject({ code: 'NOTHING_TO_RESUME' });
    expect(sendsCalls).toBe(1);
    expect(deliveriesCalls).toBe(3);
    expect(sweepUpdate).toMatchObject({ status: 'skipped' });
  });

  test('a partially delivered Pest Insider campaign that no longer passes the claim scan is refused BEFORE anything is claimed (codex round 8 P1 on #5187)', async () => {
    const tablesTouched = [];
    let sendUpdate = null;
    db.mockImplementation((table) => {
      if (table === 'newsletter_sends') {
        return chain({
          first: {
            id: 's', status: 'failed', newsletter_type: 'pest-insider-monthly', segment_filter: PLANNED_PI, subject: 'Pest Insider — September',
            html_body: '<p>Termites swarm again after storms.</p>', text_body: 'Termites swarm again after storms.', event_ids: [],
          },
          onUpdate: (payload) => { sendUpdate = payload; },
        });
      }
      tablesTouched.push(table);
      if (table === 'newsletter_send_deliveries') return chain({ count: 1 }); // somebody received it
      return chain({});
    });
    await expect(prepareResumeCampaign('s')).rejects.toMatchObject({ code: 'VALIDATION_FAILED', message: expect.stringMatching(/correct the copy and resume again/) });
    // only the ledger was read; nothing was claimed or written elsewhere
    expect(tablesTouched).toEqual(['newsletter_send_deliveries']);
    // …and the campaign KEEPS its delivered, publicly readable state — it is
    // corrected in place through PATCH, never demoted to draft (codex round 12 P2).
    expect(sendUpdate).toBeNull();
  });

  test('a promoted legacy flagship (newsletter_type NULL, calendar-linked) is validated as the flagship type on resume (codex round 12 P1)', async () => {
    let sendUpdate = null;
    db.mockImplementation((table) => {
      if (table === 'newsletter_sends') {
        return chain({
          first: {
            id: 's', status: 'failed', newsletter_type: null, subject: 'Weekend events',
            html_body: '<p>Tickets are $20 at the door.</p>', text_body: 'Tickets are $20 at the door.', event_ids: [],
          },
          onUpdate: (payload) => { sendUpdate = payload; },
        });
      }
      if (table === 'newsletter_send_deliveries') return chain({ count: 1 });
      if (table === 'newsletter_calendar') return chain({ first: { id: 'cal-1' } });
      throw new Error(`unexpected ${table}`);
    });
    await expect(prepareResumeCampaign('s')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(sendUpdate).toBeNull();
  });

  test('a ZERO-ledger failed campaign that fails the claim scan goes back to an editable draft — nobody received it (codex round 13 P2)', async () => {
    let sendUpdate = null;
    const wheres = [];
    db.mockImplementation((table) => {
      if (table === 'newsletter_sends') {
        const q = chain({
          first: {
            id: 's', status: 'failed', newsletter_type: 'pest-insider-monthly', segment_filter: PLANNED_PI, subject: 'Pest Insider — September',
            html_body: '<p>Termites swarm again after storms.</p>', text_body: 'Termites swarm again after storms.', event_ids: [],
          },
          updated: 1,
          onUpdate: (payload) => { sendUpdate = payload; },
        });
        const where = q.where;
        q.where = jest.fn((...args) => { wheres.push(args); return where(...args); });
        return q;
      }
      if (table === 'newsletter_send_deliveries') return chain({ count: 0 });
      throw new Error(`unexpected ${table}`);
    });
    await expect(prepareResumeCampaign('s')).rejects.toMatchObject({ code: 'VALIDATION_FAILED', message: expect.stringMatching(/returned to draft/) });
    expect(sendUpdate).toMatchObject({ status: 'draft', proof_approved_at: null, proof_refused_at: null, proof_token: null, sending_claim_token: null });
    expect(wheres).toContainEqual([{ id: 's', status: 'failed' }]);
  });

  test('an actively sending Pest Insider campaign that fails the claim scan is refused as STILL_SENDING and never reset to draft (pre-push audit P1)', async () => {
    let sendUpdate = null;
    db.mockImplementation((table) => {
      if (table === 'newsletter_sends') {
        return chain({
          first: {
            id: 's', status: 'sending', updated_at: new Date(), newsletter_type: 'pest-insider-monthly', segment_filter: PLANNED_PI, subject: 'Pest Insider — September',
            html_body: '<p>Termites swarm again after storms.</p>', text_body: 'Termites swarm again after storms.', event_ids: [],
          },
          onUpdate: (payload) => { sendUpdate = payload; },
        });
      }
      throw new Error(`unexpected ${table}`);
    });
    await expect(prepareResumeCampaign('s')).rejects.toMatchObject({ code: 'STILL_SENDING' });
    expect(sendUpdate).toBeNull();
  });

  test('a stale sending Pest Insider campaign that fails the claim scan is released to failed only if still stale, and its claim token is revoked', async () => {
    let sendUpdate = null;
    const wheres = [];
    db.mockImplementation((table) => {
      if (table === 'newsletter_sends') {
        const q = chain({
          first: {
            id: 's', status: 'sending', updated_at: new Date(Date.now() - 60 * 60 * 1000), sending_claim_token: 'old-token',
            newsletter_type: 'pest-insider-monthly', segment_filter: PLANNED_PI, subject: 'Pest Insider — September',
            html_body: '<p>Termites swarm again after storms.</p>', text_body: 'Termites swarm again after storms.', event_ids: [],
          },
          updated: 1,
          onUpdate: (payload) => { sendUpdate = payload; },
        });
        const where = q.where;
        q.where = jest.fn((...args) => { wheres.push(args); return where(...args); });
        return q;
      }
      if (table === 'newsletter_send_deliveries') return chain({ count: 1 }); // partially delivered
      throw new Error(`unexpected ${table}`);
    });
    await expect(prepareResumeCampaign('s')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    // released to 'failed' — publicly readable and correctable — never to draft (codex round 12 P2)
    expect(sendUpdate).toMatchObject({ status: 'failed', sending_claim_token: null });
    expect(sendUpdate.proof_approved_at).toBeUndefined();
    expect(wheres).toContainEqual([{ id: 's', status: 'sending' }]);
    expect(wheres.some(([col, op]) => col === 'updated_at' && op === '<=')).toBe(true);
  });

  test('resume with only ineligible outstanding rows terminalizes them, then reports NOTHING_TO_RESUME', async () => {
    let sweepUpdate = null;
    let sweepQuery = null;
    let deliveriesCalls = 0;
    let sendsCalls = 0;
    let sendUpdate = null;
    db.mockImplementation((table) => {
      if (table === 'newsletter_sends') {
        sendsCalls++;
        return chain({
          first: { id: 's', status: 'sent', html_body: 'x', text_body: 'x' },
          onUpdate: (payload) => { sendUpdate = payload; },
        });
      }
      if (table === 'newsletter_send_deliveries') {
        deliveriesCalls++;
        if (deliveriesCalls === 1) return chain({ count: 2 });   // rows exist
        if (deliveriesCalls === 2) return chain({ count: 0 });   // none ELIGIBLE (all archived/suppressed)
        // The two queued/failed rows are terminalized here — otherwise a
        // later restore/unsuppress would let the next resume mail this stale
        // campaign to them.
        sweepQuery = chain({ updated: 2, onUpdate: (payload) => { sweepUpdate = payload; } });
        return sweepQuery;
      }
      throw new Error(`unexpected ${table}`);
    });

    await expect(resumeCampaign('s')).rejects.toMatchObject({ code: 'NOTHING_TO_RESUME' });

    expect(deliveriesCalls).toBe(3);
    expect(sweepUpdate).toMatchObject({ status: 'skipped', bounce_reason: 'ineligible_at_dispatch', send_attempt_token: null });
    // The parent is already terminal ('sent') and holds no claim: rows are
    // swept, the send row itself is left completely untouched.
    expect(sendsCalls).toBe(1);
    expect(sendUpdate).toBeNull();
    // Scoped to this send's retryable, non-success rows only.
    expect(sweepQuery.where).toHaveBeenCalledWith({ send_id: 's' });
    expect(sweepQuery.whereIn).toHaveBeenCalledWith('status', RETRYABLE_DELIVERY_STATUSES_FOR_TEST);
    expect(sweepQuery.whereNull).toHaveBeenCalledWith('sent_at');
    expect(RETRYABLE_DELIVERY_STATUSES_FOR_TEST).not.toContain('skipped');
  });

  test("rejects 'sent' with NOTHING_TO_RESUME when no delivery rows exist", async () => {
    let sendsCalls = 0;
    let deliveriesCalls = 0;
    db.mockImplementation((table) => {
      if (table === 'newsletter_sends') {
        sendsCalls++;
        return chain({ first: { id: 's', status: 'sent', html_body: 'x', text_body: 'x' } });
      }
      if (table === 'newsletter_send_deliveries') {
        deliveriesCalls++;
        return chain({ count: 0 });
      }
      throw new Error(`unexpected ${table}`);
    });

    await expect(resumeCampaign('s')).rejects.toMatchObject({ code: 'NOTHING_TO_RESUME' });
    expect(sendsCalls).toBe(1);
    expect(deliveriesCalls).toBe(1);
    expect(mockSendBroadcast).not.toHaveBeenCalled();
  });

  test('allows failed sends with no delivery rows to reseed and send', async () => {
    let claimUpdate = null;
    const failedSend = {
      id: 's',
      status: 'failed',
      html_body: '<p>Body</p>',
      text_body: 'Body',
      subject: 'Hello',
      from_email: 'newsletter@wavespestcontrol.com',
      from_name: 'Waves',
      reply_to: 'contact@wavespestcontrol.com',
      segment_filter: null,
      subject_b: null,
    };
    const queues = {
      newsletter_sends: [
        chain({ first: failedSend }),                         // resume fetch
        chain({ returning: [{ id: 's' }], onUpdate: (payload) => { claimUpdate = payload; } }),
        chain({ first: { ...failedSend, status: 'sending' } }), // sendCampaign fetch after resume preclaim
        chain({ updated: 1 }),                                // per-chunk heartbeat (stale-lease keepalive)
        chain({ updated: 1 }),                                // final status update
      ],
      newsletter_send_deliveries: [
        chain({ count: 0 }),                                  // no rows exist yet
        chain({ first: null }),                               // ledger guard in sendCampaign: still none → seed
        chain({}),                                            // insert onConflict
        chain({ result: [{ id: 'd-1', subscriber_id: 1, status: 'queued', ab_variant: null }] }),
        chain({ updated: 1 }),                                // post-send bulk update
        chain({ count: 0 }),                                  // final retryable ledger count
      ],
      newsletter_subscribers: [
        chain({ result: [{ id: 1, email: 'a@example.com', unsubscribe_token: 'tok-a', customer_id: null }] }),
        // Per-chunk eligibility re-check right before SendGrid: everyone still
        // eligible, link unchanged.
        chain({ result: [{ id: 1, customer_id: null }] }),
      ],
    };
    // Post-send side effects (PR D): on a successful 'sent' send the sender
    // advances the linked calendar row to 'sent' and the fire-and-forget
    // social share re-fetches the send row. Provide both so the strict mock
    // doesn't trip. (markEventsFeatured no-ops here — fixtures have no event_ids.)
    queues.newsletter_calendar = queues.newsletter_calendar || [chain({ updated: 1 })];
    queues.newsletter_sends.push(chain({ first: null }));
    db.mockImplementation((table) => {
      const queue = queues[table];
      if (!queue || !queue.length) throw new Error(`unexpected ${table}`);
      return queue.shift();
    });

    const result = await resumeCampaign('s');

    expect(result.accepted).toBe(1);
    expect(claimUpdate.status).toBe('sending');
    expect(mockSendBroadcast).toHaveBeenCalledTimes(1);
    expect(mockSendBroadcast.mock.calls[0][0].recipients[0].customArgs).toEqual({ delivery_id: 'd-1', send_id: 's' });
  });

  test('resume with existing deliveries only sends to the original campaign audience', async () => {
    let finalUpdate = null;
    let deliveryClaimUpdate = null;
    let subscriberWhereIn = null;
    const sentSend = {
      id: 's',
      status: 'sent',
      sent_at: new Date('2026-05-01T10:00:00Z'),
      html_body: '<p>Body</p>',
      text_body: 'Body',
      subject: 'Hello',
      from_email: 'newsletter@wavespestcontrol.com',
      from_name: 'Waves',
      reply_to: 'contact@wavespestcontrol.com',
      segment_filter: null,
      subject_b: null,
    };
    const queues = {
      newsletter_sends: [
        chain({ first: sentSend }),                          // resume fetch
        chain({ returning: [{ id: 's' }] }),                  // conditional preclaim
        chain({ first: { ...sentSend, status: 'sending' } }), // sendCampaign fetch after resume preclaim
        chain({ updated: 1 }),                                // per-chunk heartbeat (stale-lease keepalive)
        chain({ updated: 1, onUpdate: (payload) => { finalUpdate = payload; } }),
      ],
      newsletter_send_deliveries: [
        chain({ count: 2 }),                                  // rows exist
        chain({ count: 1 }),                                  // one outstanding
        chain({ result: [
          { id: 'd-1', subscriber_id: 1, status: 'delivered', ab_variant: null },
          { id: 'd-2', subscriber_id: 2, status: 'failed', ab_variant: null },
        ] }),
        chain({
          returning: [{ id: 'd-2', subscriber_id: 2, send_attempt_token: 'attempt-2' }],
          onUpdate: (payload) => { deliveryClaimUpdate = payload; },
        }),                                                   // claim retryable row before SendGrid
        chain({ updated: 1 }),                                // post-send bulk update
        chain({ count: 0 }),                                  // final retryable ledger count
      ],
      newsletter_subscribers: [
        chain({
          result: [
            { id: 2, email: 'b@example.com', unsubscribe_token: 'tok-b', customer_id: null },
          ],
          onWhereIn: (...args) => { subscriberWhereIn = args; },
        }),
        // Per-chunk eligibility re-check right before SendGrid: everyone still eligible.
        chain({ result: [{ id: 2, customer_id: null }] }),
      ],
    };
    // Post-send side effects (PR D): on a successful 'sent' send the sender
    // advances the linked calendar row to 'sent' and the fire-and-forget
    // social share re-fetches the send row. Provide both so the strict mock
    // doesn't trip. (markEventsFeatured no-ops here — fixtures have no event_ids.)
    queues.newsletter_calendar = queues.newsletter_calendar || [chain({ updated: 1 })];
    queues.newsletter_sends.push(chain({ first: null }));
    db.mockImplementation((table) => {
      const queue = queues[table];
      if (!queue || !queue.length) throw new Error(`unexpected ${table}`);
      return queue.shift();
    });

    const result = await resumeCampaign('s');

    expect(result.recipients).toBe(2);
    expect(result.skipped_already_sent).toBe(1);
    expect(finalUpdate.recipient_count).toBe(2);
    expect(deliveryClaimUpdate).toMatchObject({ status: 'sending', provider_message_id: null });
    expect(subscriberWhereIn).toEqual(['id', [2]]);
    expect(mockSendBroadcast).toHaveBeenCalledTimes(1);
    expect(mockSendBroadcast.mock.calls[0][0].recipients.map((r) => r.email)).toEqual(['b@example.com']);
    expect(mockSendBroadcast.mock.calls[0][0].recipients[0].customArgs).toEqual({
      delivery_id: 'd-2',
      send_id: 's',
      send_attempt_token: 'attempt-2',
    });
  });

  // Codex round 11 on #5187: a partially delivered campaign returned to
  // draft by an invalid resume, then sent through the NORMAL Send path, must
  // not re-seed the segment — a subscriber who joined since the first pass
  // never receives the old partial campaign.
  test('a normal send of a campaign that already has a delivery ledger reaches only its outstanding rows — no new recipient is seeded', async () => {
    let finalUpdate = null;
    let subscriberWhereIn = null;
    const draftSend = {
      id: 's',
      status: 'draft',
      html_body: '<p>Body</p>',
      text_body: 'Body',
      subject: 'Hello',
      from_email: 'newsletter@wavespestcontrol.com',
      from_name: 'Waves',
      reply_to: 'contact@wavespestcontrol.com',
      segment_filter: null,
      subject_b: null,
    };
    const deliveryChains = [
      chain({ first: { id: 'd-1' } }),                      // ledger guard: rows exist → no seeding
      chain({ result: [
        { id: 'd-1', subscriber_id: 1, status: 'delivered', ab_variant: null },
        { id: 'd-2', subscriber_id: 2, status: 'failed', ab_variant: null },
      ] }),
      chain({ returning: [{ id: 'd-2', subscriber_id: 2, send_attempt_token: 'attempt-2' }] }), // claim retryable row
      chain({ updated: 1 }),                                // post-send bulk update
      chain({ count: 0 }),                                  // final retryable ledger count
    ];
    const queues = {
      newsletter_sends: [
        chain({ first: draftSend }),                          // fetch
        chain({ returning: [{ id: 's' }] }),                  // atomic claim draft → sending
        chain({ updated: 1 }),                                // per-chunk heartbeat
        chain({ updated: 1, onUpdate: (payload) => { finalUpdate = payload; } }),
        chain({ first: null }),                               // social-share refetch
      ],
      newsletter_send_deliveries: [...deliveryChains],
      newsletter_subscribers: [
        // 0-recipient guard: the segment now matches a THIRD subscriber who
        // joined after the first pass.
        chain({ count: 3 }),
        chain({
          result: [{ id: 2, email: 'b@example.com', unsubscribe_token: 'tok-b', customer_id: null }],
          onWhereIn: (...args) => { subscriberWhereIn = args; },
        }),
        chain({ result: [{ id: 2, customer_id: null }] }),   // per-chunk eligibility re-check
      ],
      newsletter_calendar: [chain({ updated: 1 })],
    };
    db.mockImplementation((table) => {
      const queue = queues[table];
      if (!queue || !queue.length) throw new Error(`unexpected ${table}`);
      return queue.shift();
    });

    const result = await sendCampaign('s');

    for (const q of deliveryChains) expect(q.insert).not.toHaveBeenCalled();
    expect(subscriberWhereIn).toEqual(['id', [2]]);
    expect(mockSendBroadcast).toHaveBeenCalledTimes(1);
    expect(mockSendBroadcast.mock.calls[0][0].recipients.map((r) => r.email)).toEqual(['b@example.com']);
    expect(result.recipients).toBe(2);
    expect(finalUpdate.recipient_count).toBe(2);
  });

  test('resume preflight: a retryable ledger row whose recipient is no longer eligible is terminalized before dispatch', async () => {
    let finalUpdate = null;
    let sweepUpdate = null;
    const sentSend = {
      id: 's',
      status: 'sent',
      sent_at: new Date('2026-05-01T10:00:00Z'),
      html_body: '<p>Body</p>',
      text_body: 'Body',
      subject: 'Hello',
      from_email: 'newsletter@wavespestcontrol.com',
      from_name: 'Waves',
      reply_to: 'contact@wavespestcontrol.com',
      segment_filter: null,
      subject_b: null,
    };
    const queues = {
      newsletter_sends: [
        chain({ first: sentSend }),                           // resume fetch
        chain({ returning: [{ id: 's' }] }),                  // conditional preclaim
        chain({ first: { ...sentSend, status: 'sending' } }), // sendCampaign fetch after resume preclaim
        chain({ updated: 1 }),                                // per-chunk heartbeat
        chain({ updated: 1, onUpdate: (payload) => { finalUpdate = payload; } }),
      ],
      newsletter_send_deliveries: [
        chain({ count: 2 }),                                  // rows exist
        chain({ count: 2 }),                                  // two outstanding
        chain({ result: [
          { id: 'd-1', subscriber_id: 1, status: 'queued', ab_variant: null },
          { id: 'd-2', subscriber_id: 2, status: 'failed', ab_variant: null },
        ] }),
        // Pre-dispatch sweep: d-2's subscriber is gone from the eligible
        // refetch, so its retryable row is terminalized here — NOT left
        // queued/failed for the next resume to pick up.
        chain({ updated: 1, onUpdate: (payload) => { sweepUpdate = payload; } }),
        chain({ returning: [{ id: 'd-1', subscriber_id: 1, send_attempt_token: 'attempt-1' }] }), // claim
        chain({ updated: 1 }),                                // post-send bulk update
        chain({ count: 0 }),                                  // final retryable ledger count
      ],
      newsletter_subscribers: [
        // Eligible refetch (status active + suppression + archived-customer
        // anti-join): subscriber 2's customer was archived after the send.
        chain({ result: [{ id: 1, email: 'a@example.com', unsubscribe_token: 'tok-a', customer_id: 'cust-live' }] }),
        // Per-chunk eligibility re-check right before SendGrid.
        chain({ result: [{ id: 1, customer_id: 'cust-live' }] }),
      ],
    };
    queues.newsletter_calendar = queues.newsletter_calendar || [chain({ updated: 1 })];
    queues.newsletter_sends.push(chain({ first: null }));
    db.mockImplementation((table) => {
      const queue = queues[table];
      if (!queue || !queue.length) throw new Error(`unexpected ${table}`);
      return queue.shift();
    });

    const result = await resumeCampaign('s');

    expect(sweepUpdate).toMatchObject({ status: 'skipped', bounce_reason: 'ineligible_at_dispatch', send_attempt_token: null });
    expect(RETRYABLE_DELIVERY_STATUSES_FOR_TEST).not.toContain('skipped');
    expect(mockSendBroadcast).toHaveBeenCalledTimes(1);
    expect(mockSendBroadcast.mock.calls[0][0].recipients.map((r) => r.email)).toEqual(['a@example.com']);
    expect(result.skipped_ineligible).toBe(1);
    // Ineligible, not "already sent" — and out of recipient_count.
    expect(result.skipped_already_sent).toBe(0);
    expect(result.recipients).toBe(1);
    expect(finalUpdate.recipient_count).toBe(1);
  });

  test('resume: a subscriber archived since the original send is skipped terminally, not re-sent', async () => {
    let finalUpdate = null;
    let skipUpdate = null;
    const sentSend = {
      id: 's',
      status: 'sent',
      sent_at: new Date('2026-05-01T10:00:00Z'),
      html_body: '<p>Body</p>',
      text_body: 'Body',
      subject: 'Hello',
      from_email: 'newsletter@wavespestcontrol.com',
      from_name: 'Waves',
      reply_to: 'contact@wavespestcontrol.com',
      segment_filter: null,
      subject_b: null,
    };
    const queues = {
      newsletter_sends: [
        chain({ first: sentSend }),                           // resume fetch
        chain({ returning: [{ id: 's' }] }),                  // conditional preclaim
        chain({ first: { ...sentSend, status: 'sending' } }), // sendCampaign fetch after resume preclaim
        chain({ updated: 1 }),                                // per-chunk heartbeat
        chain({ updated: 1, onUpdate: (payload) => { finalUpdate = payload; } }),
      ],
      newsletter_send_deliveries: [
        chain({ count: 2 }),                                  // rows exist
        chain({ count: 2 }),                                  // two outstanding
        chain({ result: [
          { id: 'd-1', subscriber_id: 1, status: 'queued', ab_variant: null },
          { id: 'd-2', subscriber_id: 2, status: 'queued', ab_variant: null },
        ] }),
        chain({ returning: [
          { id: 'd-1', subscriber_id: 1, send_attempt_token: 'attempt-1' },
          { id: 'd-2', subscriber_id: 2, send_attempt_token: 'attempt-2' },
        ] }),                                                 // claim both before SendGrid
        chain({ updated: 1, onUpdate: (payload) => { skipUpdate = payload; } }), // terminal skip
        chain({ updated: 1 }),                                // post-send bulk update
        chain({ count: 0 }),                                  // final retryable ledger count
      ],
      newsletter_subscribers: [
        chain({ result: [
          { id: 1, email: 'a@example.com', unsubscribe_token: 'tok-a', customer_id: 'cust-live' },
          { id: 2, email: 'b@example.com', unsubscribe_token: 'tok-b', customer_id: 'cust-archived' },
        ] }),
        // Dispatch re-check: #2's customer was archived after the original
        // selection and has no live twin, so it drops out here.
        chain({ result: [{ id: 1 }] }),
      ],
    };
    queues.newsletter_calendar = queues.newsletter_calendar || [chain({ updated: 1 })];
    queues.newsletter_sends.push(chain({ first: null }));
    db.mockImplementation((table) => {
      const queue = queues[table];
      if (!queue || !queue.length) throw new Error(`unexpected ${table}`);
      return queue.shift();
    });

    const result = await resumeCampaign('s');

    expect(mockSendBroadcast).toHaveBeenCalledTimes(1);
    expect(mockSendBroadcast.mock.calls[0][0].recipients.map((r) => r.email)).toEqual(['a@example.com']);
    expect(skipUpdate).toMatchObject({ status: 'skipped', bounce_reason: 'ineligible_at_dispatch', send_attempt_token: null });
    expect(RETRYABLE_DELIVERY_STATUSES_FOR_TEST).not.toContain('skipped');
    expect(result.skipped_ineligible).toBe(1);
    expect(result.recipients).toBe(1);
    expect(finalUpdate.recipient_count).toBe(1);
  });

  test.each([
    ['whose customer is now in its holdout', { customerAtDispatch: HELD_CUSTOMER, mailedAt: 'b@example.com' }],
    ['whose address changed since the plan', { customerAtDispatch: null, mailedAt: 'b-new@example.com' }],
  ])('resume: a planned issue skips a reader %s, terminally', async (_label, { customerAtDispatch, mailedAt }) => {
    let finalUpdate = null;
    let skipUpdate = null;
    const sentSend = {
      id: 's',
      status: 'sent',
      sent_at: new Date('2026-05-01T10:00:00Z'),
      html_body: '<p>Body</p>',
      text_body: 'Body',
      subject: 'Hello',
      from_email: 'newsletter@wavespestcontrol.com',
      from_name: 'Waves',
      reply_to: 'contact@wavespestcontrol.com',
      segment_filter: { subscriber_ids: [1, 2], holdout: 'pest-insider', address_keys: PLANNED_KEYS },
      subject_b: null,
    };
    const queues = {
      newsletter_sends: [
        chain({ first: sentSend }),                           // resume fetch
        chain({ returning: [{ id: 's' }] }),                  // conditional preclaim
        chain({ first: { ...sentSend, status: 'sending' } }), // sendCampaign fetch after resume preclaim
        chain({ updated: 1 }),                                // per-chunk heartbeat
        chain({ updated: 1, onUpdate: (payload) => { finalUpdate = payload; } }),
      ],
      newsletter_send_deliveries: [
        chain({ count: 2 }),                                  // rows exist
        chain({ count: 2 }),                                  // two outstanding
        chain({ result: [
          { id: 'd-1', subscriber_id: 1, status: 'queued', ab_variant: null },
          { id: 'd-2', subscriber_id: 2, status: 'queued', ab_variant: null },
        ] }),
        chain({ returning: [
          { id: 'd-1', subscriber_id: 1, send_attempt_token: 'attempt-1' },
          { id: 'd-2', subscriber_id: 2, send_attempt_token: 'attempt-2' },
        ] }),                                                 // claim both before SendGrid
        chain({ updated: 1, onUpdate: (payload) => { skipUpdate = payload; } }), // terminal skip
        chain({ updated: 1 }),                                // post-send bulk update
        chain({ count: 0 }),                                  // final retryable ledger count
      ],
      newsletter_subscribers: [
        chain({ result: [
          { id: 1, email: 'a@example.com', unsubscribe_token: 'tok-a', customer_id: KEPT_CUSTOMER },
          { id: 2, email: mailedAt, unsubscribe_token: 'tok-b', customer_id: null },
        ] }),
        // Dispatch re-check: both still eligible; #2 was a lead at the first send.
        chain({ result: [{ id: 1, customer_id: KEPT_CUSTOMER, email: 'a@example.com' }, { id: 2, customer_id: customerAtDispatch, email: mailedAt }] }),
      ],
    };
    queues.newsletter_calendar = [chain({ updated: 1 })];
    queues.newsletter_sends.push(chain({ first: null }));
    db.mockImplementation((table) => {
      const queue = queues[table];
      if (!queue || !queue.length) throw new Error(`unexpected ${table}`);
      return queue.shift();
    });

    const result = await resumeCampaign('s');

    expect(mockSendBroadcast).toHaveBeenCalledTimes(1);
    expect(mockSendBroadcast.mock.calls[0][0].recipients.map((r) => r.email)).toEqual(['a@example.com']);
    expect(skipUpdate).toMatchObject({ status: 'skipped', bounce_reason: 'ineligible_at_dispatch', send_attempt_token: null });
    expect(result.skipped_ineligible).toBe(1);
    expect(finalUpdate.recipient_count).toBe(1);
  });

  test.each([
    ['a list without the second reader', [1], ['a@example.com']],
  ])('resume: a planned issue whose subscriber_ids is %s mails only the readers that list holds', async (_label, subscriberIds, mailed) => {
    let skipUpdate = null;
    const sentSend = {
      id: 's',
      status: 'sent',
      sent_at: new Date('2026-05-01T10:00:00Z'),
      html_body: '<p>Body</p>',
      text_body: 'Body',
      subject: 'Hello',
      from_email: 'newsletter@wavespestcontrol.com',
      from_name: 'Waves',
      reply_to: 'contact@wavespestcontrol.com',
      segment_filter: { subscriber_ids: subscriberIds, holdout: 'pest-insider', address_keys: PLANNED_KEYS },
      subject_b: null,
    };
    const onFile = [{ id: 1, customer_id: KEPT_CUSTOMER, email: 'a@example.com' }, { id: 2, customer_id: null, email: 'b@example.com' }];
    // The dispatch re-check answers as SQL would: nobody for 1 = 0, the listed ids for ANY.
    const recheck = (raws) => {
      if (raws.some(([sql]) => sql === '1 = 0')) return [];
      const listed = raws.find(([sql]) => sql.includes('= ANY('));
      return listed ? onFile.filter((r) => listed[1][0].includes(r.id)) : onFile;
    };
    const queues = {
      newsletter_sends: [
        chain({ first: sentSend }),                           // resume fetch
        chain({ returning: [{ id: 's' }] }),                  // conditional preclaim
        chain({ first: { ...sentSend, status: 'sending' } }), // sendCampaign fetch after resume preclaim
        chain({ updated: 1 }),                                // per-chunk heartbeat
        chain({ updated: 1 }),                                // final status update
        chain({ first: null }),
      ],
      newsletter_send_deliveries: [
        chain({ count: 2 }),                                  // rows exist
        chain({ count: 2 }),                                  // two outstanding
        chain({ result: [
          { id: 'd-1', subscriber_id: 1, status: 'queued', ab_variant: null },
          { id: 'd-2', subscriber_id: 2, status: 'queued', ab_variant: null },
        ] }),
        chain({ returning: [
          { id: 'd-1', subscriber_id: 1, send_attempt_token: 'attempt-1' },
          { id: 'd-2', subscriber_id: 2, send_attempt_token: 'attempt-2' },
        ] }),                                                 // claim both before SendGrid
        chain({ updated: 2 - mailed.length, onUpdate: (payload) => { skipUpdate = payload; } }), // terminal skip
        chain({ updated: 1 }),                                // post-send bulk update
        chain({ count: 0 }),                                  // final retryable ledger count
      ],
      newsletter_subscribers: [
        chain({ result: [
          { id: 1, email: 'a@example.com', unsubscribe_token: 'tok-a', customer_id: KEPT_CUSTOMER },
          { id: 2, email: 'b@example.com', unsubscribe_token: 'tok-b', customer_id: null },
        ] }),
        chain({ result: recheck }),
      ],
      newsletter_calendar: [chain({ updated: 1 })],
    };
    db.mockImplementation((table) => {
      const queue = queues[table];
      if (!queue || !queue.length) throw new Error(`unexpected ${table}`);
      return queue.shift();
    });

    await resumeCampaign('s');

    const sent = mockSendBroadcast.mock.calls.flatMap(([args]) => args.recipients.map((r) => r.email));
    expect(sent).toEqual(mailed);
    expect(skipUpdate).toMatchObject({ status: 'skipped', bounce_reason: 'ineligible_at_dispatch' });
  });

  test.each([
    ['names a holdout this server does not know', { segment_filter: { subscriber_ids: [1, 2], holdout: 'pest-insider-v2' } }, 'UNKNOWN_HOLDOUT'],
    ['is a Waves Pest Insider issue with no plan', { newsletter_type: 'pest-insider-monthly', segment_filter: null }, 'UNPLANNED_AUDIENCE'],
    ['has a plan with no address keys', { segment_filter: { subscriber_ids: [1, 2], holdout: 'pest-insider' } }, 'INCOMPLETE_PLAN'],
    ['has a plan with an empty reader list', { segment_filter: { subscriber_ids: [], holdout: 'pest-insider', address_keys: PLANNED_KEYS } }, 'INCOMPLETE_PLAN'],
    ['has a plan with no reader list', { segment_filter: { holdout: 'pest-insider', address_keys: PLANNED_KEYS } }, 'INCOMPLETE_PLAN'],
  ])('resume: a delivered campaign that %s is refused and keeps its state: nothing is released, reset or claimed', async (_label, fields, code) => {
    const queues = {
      newsletter_sends: [chain({ first: {
        id: 's', status: 'sent', sent_at: new Date('2026-05-01T10:00:00Z'), html_body: '<p>Body</p>', text_body: 'Body',
        subject: 'Hello', subject_b: null, ...fields,
      } })], // the resume fetch, and nothing else: any release, reset or claim would throw
      newsletter_send_deliveries: [chain({ count: 2 })], // the ledger count the outcome depends on
    };
    db.mockImplementation((table) => {
      const queue = queues[table];
      if (!queue || !queue.length) throw new Error(`unexpected ${table}`);
      return queue.shift();
    });

    await expect(resumeCampaign('s')).rejects.toMatchObject({ code, audienceRefusal: true });
    expect(mockSendBroadcast).not.toHaveBeenCalled();
  });

  // A refused audience takes the path stored copy that fails validation takes, so a
  // stale claim never leaves the campaign stuck in 'sending'.
  test.each([
    ['a stale sending issue with a ledger releases its claim to failed', 'sending', 2,
      { status: 'failed', sending_claim_token: null }, 'its stale send claim was released'],
    ['a stale sending issue with no ledger returns to draft', 'sending', 0,
      { status: 'draft', scheduled_for: null, proof_approved_at: null, sending_claim_token: null }, 'returned to draft for editing'],
    ['a failed issue with no ledger returns to draft', 'failed', 0,
      { status: 'draft', scheduled_for: null, proof_approved_at: null, sending_claim_token: null }, 'returned to draft for editing'],
    ['a failed issue with a ledger stays failed', 'failed', 2, null, 'repair its audience and resume again'],
    // Bound to the version read: an issue repaired meanwhile is not reset by a stale refusal.
    ['a failed issue with no ledger, repaired since it was read, is left as it is', 'failed', 0,
      { status: 'draft' }, 'it changed state meanwhile and was left as is', 0],
  ])('resume: a refused audience on %s, and nothing is claimed', async (_label, status, ledger, written, outcome, updated = 1) => {
    let payload = null;
    const transition = chain({ updated, onUpdate: (p) => { payload = p; } });
    const queues = {
      newsletter_sends: [
        chain({ first: {
          id: 's', status, updated_at: new Date('2026-01-01T00:00:00Z'), html_body: '<p>Body</p>', text_body: 'Body',
          subject: 'Hello', subject_b: null, newsletter_type: 'pest-insider-monthly', segment_filter: null,
        } }),
        ...(written ? [transition] : []), // the one lease-guarded transition, and no claim after it
      ],
      newsletter_send_deliveries: [chain({ count: ledger })],
    };
    db.mockImplementation((table) => {
      const queue = queues[table];
      if (!queue || !queue.length) throw new Error(`unexpected ${table}`);
      return queue.shift();
    });

    const err = await resumeCampaign('s').catch((e) => e);
    expect(err).toMatchObject({ code: 'UNPLANNED_AUDIENCE', audienceRefusal: true });
    expect(err.message).toContain(outcome);
    if (written) {
      expect(payload).toMatchObject(written);
      expect(transition.where).toHaveBeenCalledWith(expect.objectContaining({ id: 's', status }));
      // The version read, as the resume claim binds it.
      expect(transition.where).toHaveBeenCalledWith('updated_at', '<', new Date(Date.parse('2026-01-01T00:00:00Z') + 1));
      if (status === 'sending') expect(transition.where).toHaveBeenCalledWith('updated_at', '<=', expect.any(Date));
    }
    expect(mockSendBroadcast).not.toHaveBeenCalled();
  });

  test('resume skips a delivery row that self-healed before the external send claim', async () => {
    let finalUpdate = null;
    const sentSend = {
      id: 's',
      status: 'sent',
      sent_at: new Date('2026-05-01T10:00:00Z'),
      html_body: '<p>Body</p>',
      text_body: 'Body',
      subject: 'Hello',
      from_email: 'newsletter@wavespestcontrol.com',
      from_name: 'Waves',
      reply_to: 'contact@wavespestcontrol.com',
      segment_filter: null,
      subject_b: null,
    };
    const queues = {
      newsletter_sends: [
        chain({ first: sentSend }),                          // resume fetch
        chain({ returning: [{ id: 's' }] }),                  // conditional preclaim
        chain({ first: { ...sentSend, status: 'sending' } }), // sendCampaign fetch after resume preclaim
        // No heartbeat entry: the self-healed chunk short-circuits (continue)
        // before the send, so the per-chunk keepalive never fires.
        chain({ updated: 1, onUpdate: (payload) => { finalUpdate = payload; } }),
      ],
      newsletter_send_deliveries: [
        chain({ count: 1 }),                                  // rows exist
        chain({ count: 1 }),                                  // one outstanding at preflight
        chain({ result: [{ id: 'd-1', subscriber_id: 1, status: 'failed', ab_variant: null }] }),
        chain({ returning: [] }),                             // webhook self-healed before claim
        chain({ count: 0 }),                                  // final retryable ledger count
      ],
      newsletter_subscribers: [
        chain({ result: [{ id: 1, email: 'a@example.com', unsubscribe_token: 'tok-a', customer_id: null }] }),
      ],
    };
    // Post-send side effects (PR D): on a successful 'sent' send the sender
    // advances the linked calendar row to 'sent' and the fire-and-forget
    // social share re-fetches the send row. Provide both so the strict mock
    // doesn't trip. (markEventsFeatured no-ops here — fixtures have no event_ids.)
    queues.newsletter_calendar = queues.newsletter_calendar || [chain({ updated: 1 })];
    queues.newsletter_sends.push(chain({ first: null }));
    db.mockImplementation((table) => {
      const queue = queues[table];
      if (!queue || !queue.length) throw new Error(`unexpected ${table}`);
      return queue.shift();
    });

    const result = await resumeCampaign('s');

    expect(mockSendBroadcast).not.toHaveBeenCalled();
    expect(result.accepted).toBe(0);
    expect(finalUpdate.status).toBe('sent');
  });

  test('throws ALREADY_CLAIMED when the resume status reset loses a race', async () => {
    let sendsCalls = 0;
    let deliveriesCalls = 0;
    db.mockImplementation((table) => {
      if (table === 'newsletter_sends') {
        sendsCalls++;
        return sendsCalls === 1
          ? chain({ first: { id: 's', status: 'failed', html_body: 'x', text_body: 'x' } })
          : chain({ returning: [] });
      }
      if (table === 'newsletter_send_deliveries') {
        deliveriesCalls++;
        return deliveriesCalls === 1 ? chain({ count: 1 }) : chain({ count: 1 });
      }
      throw new Error(`unexpected ${table}`);
    });

    await expect(resumeCampaign('s')).rejects.toMatchObject({ code: 'ALREADY_CLAIMED' });
    expect(mockSendBroadcast).not.toHaveBeenCalled();
  });

  test('admin resume route treats ALREADY_CLAIMED as a benign background race', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin-newsletter.js'), 'utf8');
    expect(src).toMatch(/err\.code === 'ALREADY_CLAIMED'/);
    expect(src).toMatch(/background resume .* already claimed by another worker/);
  });

  test('partial resume preserves the original sent_at timestamp', async () => {
    const firstSentAt = new Date('2026-05-01T10:00:00Z');
    let finalUpdate = null;
    const sentSend = {
      id: 's',
      status: 'sent',
      sent_at: firstSentAt,
      html_body: '<p>Body</p>',
      text_body: 'Body',
      subject: 'Hello',
      from_email: 'newsletter@wavespestcontrol.com',
      from_name: 'Waves',
      reply_to: 'contact@wavespestcontrol.com',
      segment_filter: null,
      subject_b: null,
    };
    const queues = {
      newsletter_sends: [
        chain({ first: sentSend }),                          // resume fetch
        chain({ returning: [{ id: 's' }] }),                  // conditional preclaim
        chain({ first: { ...sentSend, status: 'sending' } }), // sendCampaign fetch after resume preclaim
        chain({ updated: 1 }),                                // per-chunk heartbeat (stale-lease keepalive)
        chain({ updated: 1, onUpdate: (payload) => { finalUpdate = payload; } }),
      ],
      newsletter_send_deliveries: [
        chain({ count: 1 }),                                  // rows exist
        chain({ count: 1 }),                                  // one outstanding
        chain({ result: [{ id: 'd-1', subscriber_id: 1, status: 'failed', ab_variant: null }] }),
        chain({ returning: [{ id: 'd-1', subscriber_id: 1, send_attempt_token: 'attempt-1' }] }), // claim retryable row before SendGrid
        chain({ updated: 1 }),                                // post-send bulk update
        chain({ count: 0 }),                                  // final retryable ledger count
      ],
      newsletter_subscribers: [
        chain({ result: [{ id: 1, email: 'a@example.com', unsubscribe_token: 'tok-a', customer_id: null }] }),
        // Per-chunk eligibility re-check right before SendGrid: everyone still
        // eligible, link unchanged.
        chain({ result: [{ id: 1, customer_id: null }] }),
      ],
    };
    // Post-send side effects (PR D): on a successful 'sent' send the sender
    // advances the linked calendar row to 'sent' and the fire-and-forget
    // social share re-fetches the send row. Provide both so the strict mock
    // doesn't trip. (markEventsFeatured no-ops here — fixtures have no event_ids.)
    queues.newsletter_calendar = queues.newsletter_calendar || [chain({ updated: 1 })];
    queues.newsletter_sends.push(chain({ first: null }));
    db.mockImplementation((table) => {
      const queue = queues[table];
      if (!queue || !queue.length) throw new Error(`unexpected ${table}`);
      return queue.shift();
    });

    await resumeCampaign('s');

    expect(finalUpdate).toBeTruthy();
    expect(Object.prototype.hasOwnProperty.call(finalUpdate, 'sent_at')).toBe(false);
  });
});

// ── PR D: send-completion side effects ───────────────────────────────────
describe('sendCampaign — calendar lifecycle + times_featured on send (PR D)', () => {
  test('advances the linked calendar row to "sent" on a successful first send', async () => {
    let calUpdate = null;
    buildDb({
      send: {
        id: 'send-1', status: 'draft', html_body: '<p>x</p>', text_body: 'x',
        subject: 'Hi', from_email: 'newsletter@wavespestcontrol.com', from_name: 'Waves',
        reply_to: 'contact@wavespestcontrol.com', segment_filter: null, subject_b: null,
        // no sent_at → first send; no event_ids → markEventsFeatured no-ops
      },
      subscribers: [{ id: 1, email: 'a@example.com', unsubscribe_token: 't', customer_id: null }],
      deliveries: [{ id: 'd-1', subscriber_id: 1, status: 'queued', ab_variant: null }],
      onCalendarUpdate: (p) => { calUpdate = p; },
    });
    await sendCampaign('send-1');
    expect(calUpdate).toMatchObject({ status: 'sent' });
  });
});

describe('markEventsFeatured (PR D)', () => {
  const { markEventsFeatured } = require('../services/newsletter-sender');

  test('atomically increments times_featured + recomputes freshness under a row lock', async () => {
    const updates = [];
    // Per event: SELECT ... FOR UPDATE (.first) then the UPDATE, both via trx.
    const eventsRaw = [
      chain({ first: { id: 'e1', event_type: 'recurring_series', times_featured: 0, start_at: null, end_at: null } }),
      chain({ updated: 1, onUpdate: (p) => updates.push(p) }),
    ];
    const trx = jest.fn((table) => {
      if (table === 'events_raw') {
        if (!eventsRaw.length) throw new Error('events_raw queue exhausted');
        return eventsRaw.shift();
      }
      throw new Error(`unexpected ${table}`);
    });
    db.transaction = jest.fn(async (cb) => cb(trx));
    // Raw SQL fragment for the featured → approved demotion (star consumed
    // on ship); the mock passes the text through for assertion.
    db.raw = jest.fn((sql) => sql);

    await markEventsFeatured({ event_ids: ['e1'] });

    expect(updates[0].admin_status).toContain("WHEN admin_status = 'featured' THEN 'approved'");

    expect(db.transaction).toHaveBeenCalledTimes(1);
    // The read locks the row (forUpdate) before the write — no lost increment.
    expect(eventsRaw.length).toBe(0);
    expect(updates).toHaveLength(1);
    expect(updates[0].times_featured).toBe(1);
    // Routine recurring series are always stale under the weekend-guide policy.
    expect(updates[0].freshness_status).toBe('stale_recurring');
    expect(updates[0].freshness_score).toBe(10);
    expect(updates[0].last_featured_at).toBeInstanceOf(Date);
  });

  test('no-ops (no DB query) when event_ids is empty', async () => {
    db.mockImplementation(() => { throw new Error('should not query for empty event_ids'); });
    await expect(markEventsFeatured({ event_ids: '[]' })).resolves.toBeUndefined();
    await expect(markEventsFeatured({ event_ids: [] })).resolves.toBeUndefined();
    await expect(markEventsFeatured({})).resolves.toBeUndefined();
  });
});
