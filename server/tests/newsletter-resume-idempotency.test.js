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

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/sendgrid-mail', () => ({
  isConfigured: () => true,
  sendBroadcast: mockSendBroadcast,
  unsubscribeUrl: jest.fn((t) => `https://portal/unsub/${t}`),
}));
jest.mock('../services/conversations', () => ({
  recordTouchpoint: jest.fn(async () => ({ ok: true })),
}));

const db = require('../models/db');
const { sendCampaign, prepareResumeCampaign, resumeCampaign } = require('../services/newsletter-sender');

// Tiny knex-shaped chain helper. Mirrors the pattern used in
// invoice-receipt-email-idempotency.test.js / portal-url.test.js so the
// failure surface stays familiar.
function chain({ first, result, returning, count, updated, onUpdate, onWhereIn } = {}) {
  const q = {};
  ['where', 'whereRaw', 'whereNot', 'whereNotIn', 'whereNotNull', 'whereNull',
   'whereNotExists', 'select', 'orderBy', 'limit', 'leftJoin', 'join', 'forUpdate']
    .forEach((m) => { q[m] = jest.fn(() => q); });
  q.whereIn = jest.fn((...args) => {
    if (onWhereIn) onWhereIn(...args);
    return q;
  });
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
  q.then = (resolve, reject) => Promise.resolve(result ?? []).then(resolve, reject);
  q.catch = (reject) => Promise.resolve(result ?? []).catch(reject);
  return q;
}

function buildDb({ send, deliveries = [], subscribers = [], onCalendarUpdate, heartbeatUpdated = 1, finalUpdated = 1, truncateSendsQueueAfterHeartbeat = false } = {}) {
  const queues = {
    newsletter_sends: [
      chain({ first: send }),                              // fetch send
      chain({ updated: 1, returning: [{ id: send?.id }] }),// atomic claim
      chain({ updated: heartbeatUpdated }),                // pre-batch heartbeat (0 = claim lost to a reclaim)
      // A lost claim must consume nothing further from this queue.
      ...(truncateSendsQueueAfterHeartbeat ? [] : [
        chain({ updated: finalUpdated }),                  // final status update (0 = claim rotated after last batch)
        // Loser at finalization never re-fetches for the social share.
        ...(finalUpdated ? [chain({ first: null })] : []),
      ]),
    ],
    newsletter_subscribers: [
      chain({ count: subscribers.length }),                 // 0-recipient guard
      chain({ result: subscribers }),                       // fetch
    ],
    newsletter_send_deliveries: [
      chain({}),                                            // insert onConflict
      chain({ result: deliveries }),                        // SELECT after insert
      chain({ updated: subscribers.length }),               // bulk update post-send
      chain({ count: 0 }),                                  // final retryable ledger count
    ],
    // Calendar lifecycle: sendCampaign advances the linked calendar row to
    // 'sent' on a successful send. (markEventsFeatured only touches events_raw
    // when send.event_ids is non-empty — the fixtures leave it empty, so no
    // events_raw queue is needed.)
    newsletter_calendar: [
      chain({ updated: 1, onUpdate: onCalendarUpdate }),
    ],
  };
  db.mockImplementation((table) => {
    const queue = queues[table];
    if (!queue || !queue.length) {
      throw new Error(`Unexpected db table: ${table} (queue exhausted)`);
    }
    return queue.shift();
  });
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('sendCampaign — per-recipient idempotency (I5 layer 2)', () => {
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
      ],
      newsletter_send_deliveries: [
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

  test("rejects 'sent' with NOTHING_TO_RESUME when existing rows are all terminal-success", async () => {
    let sendsCalls = 0;
    let deliveriesCalls = 0;
    db.mockImplementation((table) => {
      if (table === 'newsletter_sends') {
        sendsCalls++;
        return chain({ first: { id: 's', status: 'sent', html_body: 'x', text_body: 'x' } });
      }
      if (table === 'newsletter_send_deliveries') {
        deliveriesCalls++;
        return deliveriesCalls === 1 ? chain({ count: 1 }) : chain({ count: 0 });
      }
      throw new Error(`unexpected ${table}`);
    });
    await expect(resumeCampaign('s')).rejects.toMatchObject({ code: 'NOTHING_TO_RESUME' });
    expect(sendsCalls).toBe(1);
    expect(deliveriesCalls).toBe(2);
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
        chain({}),                                            // insert onConflict
        chain({ result: [{ id: 'd-1', subscriber_id: 1, status: 'queued', ab_variant: null }] }),
        chain({ updated: 1 }),                                // post-send bulk update
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
