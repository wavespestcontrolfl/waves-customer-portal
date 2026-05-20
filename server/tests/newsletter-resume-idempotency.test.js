/**
 * I5: newsletter broadcast — resumable + lost-response self-heal.
 *
 * Pins the three guarantees added by this PR:
 *
 *   1. sendCampaign skips subscribers whose existing delivery row is in a
 *      terminal-success state (sent / delivered / opened / clicked). A
 *      manual re-run after a partial failure must not double-email the
 *      successes.
 *
 *   2. Every recipient passed to SendGrid carries custom_args.delivery_id
 *      so an event webhook can find the right row even when the
 *      X-Message-Id from the original batch was never observed (lost-
 *      response case).
 *
 *   3. resumeCampaign rejects 'sending' (active worker), rejects
 *      'draft'/'scheduled' (use sendCampaign), and rejects when there are
 *      no outstanding non-success deliveries.
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
const { sendCampaign, resumeCampaign } = require('../services/newsletter-sender');

// Tiny knex-shaped chain helper. Mirrors the pattern used in
// invoice-receipt-email-idempotency.test.js / portal-url.test.js so the
// failure surface stays familiar.
function chain({ first, result, returning, count, updated } = {}) {
  const q = {};
  ['where', 'whereRaw', 'whereIn', 'whereNot', 'whereNotIn', 'whereNotNull', 'whereNull',
   'select', 'orderBy', 'limit', 'leftJoin', 'join']
    .forEach((m) => { q[m] = jest.fn(() => q); });
  q.first = jest.fn(async () => first);
  q.count = jest.fn(() => ({
    first: jest.fn(async () => ({ c: count ?? 0 })),
  }));
  q.insert = jest.fn(() => ({
    onConflict: jest.fn(() => ({ ignore: jest.fn(async () => result || []) })),
    returning: jest.fn(async () => returning || []),
  }));
  q.update = jest.fn(() => ({
    returning: jest.fn(async () => returning ?? []),
    then: (resolve) => Promise.resolve(updated ?? 0).then(resolve),
  }));
  q.then = (resolve, reject) => Promise.resolve(result ?? []).then(resolve, reject);
  q.catch = (reject) => Promise.resolve(result ?? []).catch(reject);
  return q;
}

function buildDb({ send, deliveries = [], subscribers = [] }) {
  const queues = {
    newsletter_sends: [
      chain({ first: send }),                              // fetch send
      chain({ updated: 1, returning: [{ id: send?.id }] }),// atomic claim
      chain({ updated: 1 }),                               // final status update
    ],
    newsletter_subscribers: [
      chain({ count: subscribers.length }),                 // 0-recipient guard
      chain({ result: subscribers }),                       // fetch
    ],
    newsletter_send_deliveries: [
      chain({}),                                            // insert onConflict
      chain({ result: deliveries }),                        // SELECT after insert
      chain({ updated: subscribers.length }),               // bulk update post-send
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

  test("rejects 'sent' with NOTHING_TO_RESUME when all rows are terminal-success", async () => {
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
  });
});
