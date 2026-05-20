/**
 * Newsletter unit tests — pure-function regression coverage for the
 * highest-blast-radius helpers. No DB access (Knex .toSQL() inspects
 * generated SQL without executing). No SendGrid calls.
 *
 * Scope:
 *   - buildSubscriberQuery: encodes the segment-filter contract that
 *     Compose's audience picker depends on. A regression here silently
 *     mails the wrong audience.
 *   - EMAIL_RE / escapeHtml from public-newsletter: defenses for the
 *     stored-XSS class of bug fixed in PR §2.1.
 *   - computeNewsletterEventUpdates: the per-event update planner
 *     extracted from the webhook handler. Encodes the §1.1 fix
 *     (per-recipient event matching) and the idempotency guards
 *     (already-delivered events are no-ops). A regression here
 *     silently corrupts campaign analytics or double-applies events.
 */

const { buildSubscriberQuery } = require('../services/newsletter-sender');
const publicRouter = require('../routes/public-newsletter');
const sendgridWebhook = require('../routes/webhooks-sendgrid');
const { EMAIL_RE, escapeHtml } = publicRouter;
const {
  computeNewsletterEventUpdates,
  computeEmailMessageEventUpdates,
  suppressionForEmailEvent,
  isFreshTimestamp,
  deliveryEmailMismatchLogMessage,
  canUseDeliveryIdFallback,
  bindNewsletterDeliveryMessageId,
} = sendgridWebhook;

describe('newsletter buildSubscriberQuery', () => {
  // Knex .toSQL() returns { sql, bindings } from the query builder
  // without opening a DB connection — perfect for shape assertions.
  const shapeOf = (filter) => buildSubscriberQuery(filter).toSQL();

  test('null filter targets every active subscriber', () => {
    const { sql, bindings } = shapeOf(null);
    expect(sql).toMatch(/from "newsletter_subscribers"/);
    expect(sql).toMatch(/"status" = (?:\$1|\?)/);
    expect(bindings).toContain('active');
    expect(sql).not.toMatch(/customer_id/);
    expect(sql).not.toMatch(/source/);
    expect(sql).not.toMatch(/tags/);
  });

  test('customersOnly adds customer_id IS NOT NULL', () => {
    const { sql } = shapeOf({ customersOnly: true });
    expect(sql).toMatch(/"customer_id" is not null/);
    expect(sql).not.toMatch(/"customer_id" is null/);
  });

  test('leadsOnly adds customer_id IS NULL', () => {
    const { sql } = shapeOf({ leadsOnly: true });
    expect(sql).toMatch(/"customer_id" is null/);
  });

  test('sources filter binds each value via whereIn', () => {
    const { sql, bindings } = shapeOf({ sources: ['website', 'quote_wizard'] });
    expect(sql).toMatch(/"source" in \((?:\$\d+|\?), (?:\$\d+|\?)\)/);
    expect(bindings).toEqual(expect.arrayContaining(['website', 'quote_wizard']));
  });

  test('empty sources array is a no-op (no whereIn injected)', () => {
    const { sql } = shapeOf({ sources: [] });
    expect(sql).not.toMatch(/"source" in/);
  });

  test('tags filter uses jsonb ?| operator with N bindings', () => {
    const { sql, bindings } = shapeOf({ tags: ['platinum-tier', 'hurricane-prep'] });
    expect(sql).toMatch(/tags \\?\?\| array\[\?,\?\]/);
    expect(bindings).toEqual(expect.arrayContaining(['platinum-tier', 'hurricane-prep']));
  });

  test('combined filters compose all clauses', () => {
    const { sql, bindings } = shapeOf({
      customersOnly: true,
      tags: ['vip'],
      sources: ['admin_manual'],
    });
    expect(sql).toMatch(/"status" = (?:\$1|\?)/);
    expect(sql).toMatch(/"customer_id" is not null/);
    expect(sql).toMatch(/"source" in/);
    expect(sql).toMatch(/tags \\?\?\| array/);
    expect(bindings).toEqual(expect.arrayContaining(['active', 'admin_manual', 'vip']));
  });

  test('customersOnly + leadsOnly is a contradiction the query expresses verbatim', () => {
    // The route doesn't reject this — the audit recommended adding a
    // 0-recipient guard at send time (§3.10) and that's where the empty
    // result is caught. The query itself is still well-formed.
    const { sql } = shapeOf({ customersOnly: true, leadsOnly: true });
    expect(sql).toMatch(/"customer_id" is not null/);
    expect(sql).toMatch(/"customer_id" is null/);
  });
});

describe('newsletter EMAIL_RE', () => {
  const ok = ['a@b.co', 'first.last@example.com', 'with+tag@gmail.com', 'h@host.io'];
  const bad = [
    '',
    'no-at-sign',
    '@nolocal.com',
    'noTld@host',
    'with space@host.com',
    'two@@host.com',
    'trailing.dot@host.',
  ];

  test.each(ok)('accepts %s', (e) => {
    expect(EMAIL_RE.test(e)).toBe(true);
  });

  test.each(bad)('rejects %s', (e) => {
    expect(EMAIL_RE.test(e)).toBe(false);
  });
});

describe('newsletter escapeHtml', () => {
  test('escapes the five HTML metacharacters', () => {
    expect(escapeHtml('<img onerror="x">')).toBe('&lt;img onerror=&quot;x&quot;&gt;');
    expect(escapeHtml("it's & <them>")).toBe('it&#39;s &amp; &lt;them&gt;');
  });

  test('returns empty string for null/undefined', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });

  test('passes through plain ascii unchanged', () => {
    expect(escapeHtml('foo@bar.co')).toBe('foo@bar.co');
  });

  test('coerces non-strings before escaping', () => {
    expect(escapeHtml(123)).toBe('123');
  });
});

describe('newsletter computeNewsletterEventUpdates', () => {
  // Fixed clock so timestamp expectations don't drift between assertion
  // and now() inside the function under test.
  const now = new Date('2026-04-29T12:00:00Z');

  // Minimal delivery row shape — only the fields the planner reads.
  const fresh = (overrides = {}) => ({
    id: 'd-1',
    send_id: 's-1',
    subscriber_id: 99,
    delivered_at: null,
    bounced_at: null,
    opened_at: null,
    clicked_at: null,
    complained_at: null,
    unsubscribed_at: null,
    ...overrides,
  });

  describe('delivered', () => {
    test('first event stamps delivered_at + delivered_count', () => {
      const u = computeNewsletterEventUpdates({ event: 'delivered' }, fresh(), now);
      expect(u).toEqual({
        delivery: { status: 'delivered', delivered_at: now, updated_at: now },
        sendIncrement: 'delivered_count',
        reconcileSendStatus: true,
      });
    });
    test('idempotent — already-delivered row is a no-op', () => {
      const u = computeNewsletterEventUpdates({ event: 'delivered' }, fresh({ delivered_at: now }), now);
      expect(u).toBeNull();
    });
  });

  describe('bounce / blocked / dropped', () => {
    test.each(['bounce', 'blocked', 'dropped'])('%s stamps bounce + increments + bounce_count', (eventName) => {
      const u = computeNewsletterEventUpdates(
        { event: eventName, reason: 'mailbox does not exist' },
        fresh(),
        now,
      );
      expect(u.delivery.status).toBe('bounced');
      expect(u.delivery.bounced_at).toBe(now);
      expect(u.delivery.bounce_reason).toBe('mailbox does not exist');
      expect(u.sendIncrement).toBe('bounced_count');
      expect(u.reconcileSendStatus).toBe(true);
      expect(u.subscriberAction).toBe('bounce_increment');
      expect(u.subscriberAt).toBe(now);
    });
    test('truncates very long bounce_reason to 500 chars', () => {
      const long = 'x'.repeat(800);
      const u = computeNewsletterEventUpdates({ event: 'bounce', reason: long }, fresh(), now);
      expect(u.delivery.bounce_reason).toHaveLength(500);
    });
    test('falls back through reason → response → type', () => {
      const u = computeNewsletterEventUpdates({ event: 'bounce', response: '550 ...' }, fresh(), now);
      expect(u.delivery.bounce_reason).toBe('550 ...');
      const u2 = computeNewsletterEventUpdates({ event: 'bounce', type: 'hard' }, fresh(), now);
      expect(u2.delivery.bounce_reason).toBe('hard');
    });
    test('skips subscriber action when no subscriber_id (legacy import row)', () => {
      const u = computeNewsletterEventUpdates({ event: 'bounce' }, fresh({ subscriber_id: null }), now);
      expect(u.subscriberAction).toBeNull();
    });
    test('idempotent — already-bounced row is a no-op', () => {
      const u = computeNewsletterEventUpdates({ event: 'bounce' }, fresh({ bounced_at: now }), now);
      expect(u).toBeNull();
    });
  });

  describe('open / click', () => {
    test('open stamps timestamp + opened_count, leaves status alone', () => {
      const u = computeNewsletterEventUpdates({ event: 'open' }, fresh(), now);
      expect(u.delivery).toEqual({ opened_at: now, updated_at: now });
      expect(u.delivery.status).toBeUndefined();
      expect(u.sendIncrement).toBe('opened_count');
      expect(u.reconcileSendStatus).toBe(true);
    });
    test('click stamps timestamp + clicked_count', () => {
      const u = computeNewsletterEventUpdates({ event: 'click' }, fresh(), now);
      expect(u.delivery).toEqual({ clicked_at: now, updated_at: now });
      expect(u.sendIncrement).toBe('clicked_count');
      expect(u.reconcileSendStatus).toBe(true);
    });
    test('open is idempotent', () => {
      expect(computeNewsletterEventUpdates({ event: 'open' }, fresh({ opened_at: now }), now)).toBeNull();
    });
    test('click is idempotent', () => {
      expect(computeNewsletterEventUpdates({ event: 'click' }, fresh({ clicked_at: now }), now)).toBeNull();
    });
  });

  describe('spamreport', () => {
    test('flips delivery to complained AND force-unsubscribes the subscriber', () => {
      const u = computeNewsletterEventUpdates({ event: 'spamreport' }, fresh(), now);
      expect(u.delivery).toEqual({ status: 'complained', complained_at: now, updated_at: now });
      expect(u.sendIncrement).toBe('complained_count');
      expect(u.reconcileSendStatus).toBe(true);
      expect(u.subscriberAction).toBe('force_unsubscribe');
    });
    test('idempotent — already-complained row is a no-op', () => {
      expect(computeNewsletterEventUpdates({ event: 'spamreport' }, fresh({ complained_at: now }), now)).toBeNull();
    });
  });

  describe('unsubscribe / group_unsubscribe', () => {
    test.each(['unsubscribe', 'group_unsubscribe'])('%s stamps unsubscribe + increments + conditional unsub', (e) => {
      const u = computeNewsletterEventUpdates({ event: e }, fresh(), now);
      expect(u.delivery).toEqual({ unsubscribed_at: now, updated_at: now });
      expect(u.sendIncrement).toBe('unsubscribed_count');
      expect(u.subscriberAction).toBe('unsubscribe_if_active');
    });
    test('idempotent — already-unsubscribed delivery row is a no-op', () => {
      expect(computeNewsletterEventUpdates({ event: 'unsubscribe' }, fresh({ unsubscribed_at: now }), now)).toBeNull();
    });
  });

  describe('webhook timestamp freshness', () => {
    test('accepts timestamps inside the replay window', () => {
      expect(isFreshTimestamp('1772380800', Date.parse('2026-03-01T16:02:00Z'))).toBe(true);
    });

    test('rejects stale timestamps outside the replay window', () => {
      expect(isFreshTimestamp('1772380800', Date.parse('2026-03-01T16:10:01Z'))).toBe(false);
    });
  });

  describe('ignored events', () => {
    test.each(['processed', 'deferred', 'group_resubscribe', 'unknown_future_event'])('%s is a no-op', (e) => {
      expect(computeNewsletterEventUpdates({ event: e }, fresh(), now)).toBeNull();
    });

    test.each(['queued', 'failed'])('processed marks %s delivery rows as sent', (status) => {
      expect(computeNewsletterEventUpdates({ event: 'processed' }, fresh({ status }), now)).toEqual({
        delivery: { status: 'sent', sent_at: now, updated_at: now },
        reconcileSendStatus: true,
      });
    });

    test('processed stays a no-op after the row is already sent', () => {
      expect(computeNewsletterEventUpdates({ event: 'processed' }, fresh({ status: 'sent' }), now)).toBeNull();
    });
  });
});

describe('email template suppression event mapping', () => {
  test('spam complaints and global unsubscribes create global suppressions', () => {
    expect(suppressionForEmailEvent({ event: 'spamreport' }, 'service_operational')).toEqual({
      suppression_type: 'spam_complaint',
      group_key: null,
    });
    expect(suppressionForEmailEvent({ event: 'unsubscribe' }, 'marketing_newsletter')).toEqual({
      suppression_type: 'unsubscribe',
      group_key: null,
    });
  });

  test('group unsubscribe is scoped to the template suppression group', () => {
    expect(suppressionForEmailEvent({ event: 'group_unsubscribe' }, 'service_operational')).toEqual({
      suppression_type: 'unsubscribe',
      group_key: 'service_operational',
    });
  });

  test('hard bounce suppresses but blocked and dropped do not', () => {
    expect(suppressionForEmailEvent({ event: 'bounce', type: 'bounce' })).toEqual({
      suppression_type: 'bounce',
      group_key: null,
    });
    expect(suppressionForEmailEvent({ event: 'blocked' })).toBeNull();
    expect(suppressionForEmailEvent({ event: 'dropped' })).toBeNull();
  });
});

describe('sendgrid webhook PII-safe diagnostics', () => {
  test('redacts recipient emails in delivery_id mismatch warnings', () => {
    const msg = deliveryEmailMismatchLogMessage(
      'delivery-1',
      'customer.person@example.com',
      'tampered.person@example.net',
    );
    expect(msg).toContain('cu***@example.com');
    expect(msg).toContain('ta***@example.net');
    expect(msg).not.toContain('customer.person@example.com');
    expect(msg).not.toContain('tampered.person@example.net');
  });
});

describe('sendgrid webhook delivery_id fallback guard', () => {
  test('accepts unbound rows and rejects rows bound to a different provider message id', () => {
    expect(canUseDeliveryIdFallback({ provider_message_id: null }, 'new-msg')).toBe(true);
    expect(canUseDeliveryIdFallback({ provider_message_id: 'new-msg' }, 'new-msg')).toBe(true);
    expect(canUseDeliveryIdFallback({ provider_message_id: 'old-msg' }, 'new-msg')).toBe(false);
  });

  test('binds provider message id behind an unbound-or-same guard', async () => {
    const nested = {};
    nested.whereNull = jest.fn(() => nested);
    nested.orWhere = jest.fn(() => nested);
    const query = {};
    query.where = jest.fn((arg) => {
      if (typeof arg === 'function') arg(nested);
      return query;
    });
    query.update = jest.fn(async () => 1);
    const client = jest.fn(() => query);

    const result = await bindNewsletterDeliveryMessageId(
      { id: 'delivery-1', provider_message_id: null },
      'sg-msg-1',
      client,
    );

    expect(result.provider_message_id).toBe('sg-msg-1');
    expect(query.where).toHaveBeenCalledWith({ id: 'delivery-1' });
    expect(nested.whereNull).toHaveBeenCalledWith('provider_message_id');
    expect(nested.orWhere).toHaveBeenCalledWith({ provider_message_id: 'sg-msg-1' });
  });

  test('re-reads the delivery row when a concurrent message bind wins', async () => {
    const nested = {};
    nested.whereNull = jest.fn(() => nested);
    nested.orWhere = jest.fn(() => nested);
    const updateQuery = {};
    updateQuery.where = jest.fn((arg) => {
      if (typeof arg === 'function') arg(nested);
      return updateQuery;
    });
    updateQuery.update = jest.fn(async () => 0);
    const rereadQuery = {};
    rereadQuery.where = jest.fn(() => rereadQuery);
    rereadQuery.first = jest.fn(async () => ({ id: 'delivery-1', provider_message_id: 'sg-other' }));
    const client = jest.fn()
      .mockReturnValueOnce(updateQuery)
      .mockReturnValueOnce(rereadQuery);

    const result = await bindNewsletterDeliveryMessageId(
      { id: 'delivery-1', provider_message_id: null },
      'sg-msg-1',
      client,
    );

    expect(result.provider_message_id).toBe('sg-other');
    expect(rereadQuery.where).toHaveBeenCalledWith({ id: 'delivery-1' });
  });
});

describe('email template send history webhook updates', () => {
  const now = new Date('2026-04-29T12:00:00Z');
  const fresh = (overrides = {}) => ({
    delivered_at: null,
    bounced_at: null,
    opened_at: null,
    clicked_at: null,
    complained_at: null,
    ...overrides,
  });

  test('delivered stamps status and delivered_at', () => {
    expect(computeEmailMessageEventUpdates({ event: 'delivered' }, fresh(), now)).toEqual({
      status: 'delivered',
      delivered_at: now,
      updated_at: now,
    });
  });

  test('open and click only stamp engagement timestamps', () => {
    expect(computeEmailMessageEventUpdates({ event: 'open' }, fresh(), now)).toEqual({
      opened_at: now,
      updated_at: now,
    });
    expect(computeEmailMessageEventUpdates({ event: 'click' }, fresh(), now)).toEqual({
      clicked_at: now,
      updated_at: now,
    });
  });

  test('bounce, blocked, and dropped preserve the provider reason', () => {
    const bounced = computeEmailMessageEventUpdates({ event: 'bounce', reason: 'mailbox missing' }, fresh(), now);
    expect(bounced.status).toBe('bounced');
    expect(bounced.bounced_at).toBe(now);
    expect(bounced.error_message).toBe('mailbox missing');

    expect(computeEmailMessageEventUpdates({ event: 'blocked', response: 'rate limited' }, fresh(), now).status).toBe('blocked');
    expect(computeEmailMessageEventUpdates({ event: 'dropped', type: 'suppressed' }, fresh(), now).status).toBe('dropped');
  });

  test('complaints and unsubscribes update customer-facing send history status', () => {
    expect(computeEmailMessageEventUpdates({ event: 'spamreport' }, fresh(), now)).toEqual({
      status: 'spam_report',
      complained_at: now,
      updated_at: now,
    });
    expect(computeEmailMessageEventUpdates({ event: 'unsubscribe' }, fresh(), now)).toEqual({
      status: 'unsubscribed',
      updated_at: now,
    });
  });

  test('idempotent engagement and delivery events are no-ops', () => {
    expect(computeEmailMessageEventUpdates({ event: 'delivered' }, fresh({ delivered_at: now }), now)).toBeNull();
    expect(computeEmailMessageEventUpdates({ event: 'open' }, fresh({ opened_at: now }), now)).toBeNull();
    expect(computeEmailMessageEventUpdates({ event: 'click' }, fresh({ clicked_at: now }), now)).toBeNull();
    expect(computeEmailMessageEventUpdates({ event: 'spamreport' }, fresh({ complained_at: now }), now)).toBeNull();
  });
});
