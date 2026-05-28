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
const { lockEventFactsFromDb } = require('../services/newsletter-draft');
const { findHallucinatedClaims, validateNewsletterDraft } = require('../services/newsletter-validator');
const { preflightDigest } = require('../services/newsletter-autopilot');
const { getFlagshipType } = require('../config/newsletter-types');
const { EMAIL_RE, escapeHtml } = publicRouter;
const {
  computeNewsletterEventUpdates,
  computeEmailMessageEventUpdates,
  suppressionForEmailEvent,
  automationSuppressionGroupKeyForEvent,
  isFreshTimestamp,
  deliveryEmailMismatchLogMessage,
  canUseDeliveryIdFallback,
  canUseProviderMessageMatch,
  bindNewsletterDeliveryMessageId,
  reconcileNewsletterSendStatus,
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

    test('processed marks token-matched in-flight resume rows as sent', () => {
      expect(computeNewsletterEventUpdates(
        { event: 'processed', send_attempt_token: 'attempt-1' },
        fresh({ status: 'sending', send_attempt_token: 'attempt-1' }),
        now,
      )).toEqual({
        delivery: { status: 'sent', sent_at: now, updated_at: now },
        reconcileSendStatus: true,
      });
    });

    test('processed ignores in-flight resume rows when attempt token is stale', () => {
      expect(computeNewsletterEventUpdates(
        { event: 'processed', send_attempt_token: 'old-attempt' },
        fresh({ status: 'sending', send_attempt_token: 'new-attempt' }),
        now,
      )).toBeNull();
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

  test('automation group unsubscribes map SendGrid ASM ids to local preference groups', () => {
    const originalNewsletter = process.env.SENDGRID_ASM_GROUP_NEWSLETTER;
    const originalService = process.env.SENDGRID_ASM_GROUP_SERVICE;
    try {
      process.env.SENDGRID_ASM_GROUP_NEWSLETTER = '101';
      process.env.SENDGRID_ASM_GROUP_SERVICE = '202';

      expect(automationSuppressionGroupKeyForEvent({
        event: 'group_unsubscribe',
        asm_group_id: 101,
      })).toBe('marketing_newsletter');
      expect(automationSuppressionGroupKeyForEvent({
        event: 'group_unsubscribe',
        asm_group_id: '202',
      })).toBe('service_operational');
      expect(automationSuppressionGroupKeyForEvent({
        event: 'group_unsubscribe',
        asm_group_id: '999',
      })).toBeNull();
      expect(automationSuppressionGroupKeyForEvent({
        event: 'unsubscribe',
        asm_group_id: '101',
      })).toBeNull();
    } finally {
      if (originalNewsletter === undefined) delete process.env.SENDGRID_ASM_GROUP_NEWSLETTER;
      else process.env.SENDGRID_ASM_GROUP_NEWSLETTER = originalNewsletter;
      if (originalService === undefined) delete process.env.SENDGRID_ASM_GROUP_SERVICE;
      else process.env.SENDGRID_ASM_GROUP_SERVICE = originalService;
    }
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
    expect(canUseDeliveryIdFallback({ provider_message_id: null, status: 'sending' }, 'new-msg')).toBe(false);
    expect(canUseDeliveryIdFallback({ provider_message_id: null, status: 'sending', send_attempt_token: 'tok-1' }, 'new-msg', 'tok-1')).toBe(true);
    expect(canUseDeliveryIdFallback({ provider_message_id: null, status: 'sending', send_attempt_token: 'tok-1' }, 'new-msg', 'tok-2')).toBe(false);
    expect(canUseDeliveryIdFallback({ provider_message_id: 'new-msg' }, 'new-msg')).toBe(true);
    expect(canUseDeliveryIdFallback({ provider_message_id: 'old-msg' }, 'new-msg')).toBe(false);
    expect(canUseDeliveryIdFallback({ provider_message_id: 'old-msg', send_attempt_token: 'tok-1' }, 'new-msg', 'tok-1')).toBe(true);
    expect(canUseDeliveryIdFallback({ provider_message_id: 'old-msg', send_attempt_token: 'tok-1' }, 'new-msg', 'tok-2')).toBe(false);
  });

  test('provider message fast path honors active attempt tokens', () => {
    expect(canUseProviderMessageMatch({ provider_message_id: 'sg-old' }, null)).toBe(true);
    expect(canUseProviderMessageMatch({ provider_message_id: 'sg-new', send_attempt_token: 'tok-1' }, 'tok-1')).toBe(true);
    expect(canUseProviderMessageMatch({ provider_message_id: 'sg-old', send_attempt_token: 'tok-1' }, 'tok-2')).toBe(false);
    expect(canUseProviderMessageMatch({ provider_message_id: 'sg-old', send_attempt_token: 'tok-1' }, null)).toBe(false);
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
      null,
      client,
    );

    expect(result.provider_message_id).toBe('sg-msg-1');
    expect(query.where).toHaveBeenCalledWith({ id: 'delivery-1' });
    expect(nested.whereNull).toHaveBeenCalledWith('provider_message_id');
    expect(nested.orWhere).toHaveBeenCalledWith({ provider_message_id: 'sg-msg-1' });
  });

  test('rebinds a stale provider message id when the attempt token matches', async () => {
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
      { id: 'delivery-1', provider_message_id: 'sg-old', send_attempt_token: 'tok-1' },
      'sg-new',
      'tok-1',
      client,
    );

    expect(result.provider_message_id).toBe('sg-new');
    expect(nested.orWhere).toHaveBeenCalledWith({ send_attempt_token: 'tok-1' });
    expect(query.where).toHaveBeenCalledWith({ send_attempt_token: 'tok-1' });
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
      null,
      client,
    );

    expect(result.provider_message_id).toBe('sg-other');
    expect(rereadQuery.where).toHaveBeenCalledWith({ id: 'delivery-1' });
  });

  test('reconcile treats abandoned sending rows as retryable', async () => {
    const deliveryQuery = {};
    deliveryQuery.where = jest.fn(() => deliveryQuery);
    deliveryQuery.whereIn = jest.fn(() => deliveryQuery);
    deliveryQuery.whereNull = jest.fn(() => deliveryQuery);
    deliveryQuery.count = jest.fn(() => deliveryQuery);
    deliveryQuery.first = jest.fn(async () => ({ c: 1 }));
    const client = jest.fn((table) => {
      if (table === 'newsletter_send_deliveries') return deliveryQuery;
      throw new Error(`unexpected table ${table}`);
    });

    await reconcileNewsletterSendStatus('send-1', client);

    expect(deliveryQuery.where).toHaveBeenCalledWith({ send_id: 'send-1' });
    expect(deliveryQuery.whereIn).toHaveBeenCalledWith('status', ['queued', 'failed', 'sending']);
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

// ── Factual locking on AI-generated event objects ────────────────────
//
// The flagship draft pipeline asks Claude for commentary keyed by an
// eventId UUID, then re-locks date/venue/address/URL/image from the
// events_raw row at render time. These tests cover the locker's three
// drop paths (missing id, unknown id, duplicate id) and the DB-override
// shape so a regression here can't silently let AI-fabricated dates or
// admission strings reach a customer's inbox.

describe('newsletter lockEventFactsFromDb', () => {
  const id1 = '11111111-1111-1111-1111-111111111111';
  const id2 = '22222222-2222-2222-2222-222222222222';

  const dbRow = (overrides = {}) => ({
    id: id1,
    title: 'Bradenton Blues',
    start_at: new Date('2026-05-30T23:00:00Z'), // Sat May 30 7pm ET
    venue_name: 'Riverwalk Pavilion',
    venue_address: '452 3rd Ave W, Bradenton, FL',
    city: 'Bradenton',
    event_url: 'https://example.com/blues',
    image_url: 'https://cdn.example.com/blues.jpg',
    ...overrides,
  });

  test('overrides AI date/venue/url with DB-sourced strings', () => {
    const aiEvents = [{
      eventId: id1,
      title: 'AI rewrote this',
      date: 'AI HALLUCINATED DATE',
      location: 'AI HALLUCINATED VENUE',
      address: 'AI HALLUCINATED ADDRESS',
      admission: 'Free admission!', // hallucination — DB has no admission
      eventUrl: 'https://malicious.example.com',
      imageUrl: 'https://malicious.example.com/img.jpg',
      description: 'AI-written vibe copy',
    }];
    const { locked, dropped } = lockEventFactsFromDb(aiEvents, [dbRow()]);
    expect(dropped).toEqual([]);
    expect(locked).toHaveLength(1);
    expect(locked[0].address).toBe('452 3rd Ave W, Bradenton, FL');
    expect(locked[0].eventUrl).toBe('https://example.com/blues');
    expect(locked[0].imageUrl).toBe('https://cdn.example.com/blues.jpg');
    expect(locked[0].location).toBe('Riverwalk Pavilion, Bradenton');
    expect(locked[0].admission).toBeNull(); // admission is never trusted from AI
    expect(locked[0].date).toMatch(/Saturday, May 30/);
    expect(locked[0].description).toBe('AI-written vibe copy'); // commentary preserved
  });

  test('drops events with no eventId', () => {
    const { locked, dropped } = lockEventFactsFromDb(
      [{ title: 'Anonymous Event' }],
      [dbRow()],
    );
    expect(locked).toHaveLength(0);
    expect(dropped).toEqual([{ index: 0, reason: 'missing eventId', title: 'Anonymous Event' }]);
  });

  test('drops events whose eventId is not in the approved pool', () => {
    const { locked, dropped } = lockEventFactsFromDb(
      [{ eventId: '99999999-9999-9999-9999-999999999999', title: 'Hallucinated Event' }],
      [dbRow()],
    );
    expect(locked).toHaveLength(0);
    expect(dropped[0].reason).toBe('eventId not in approved list');
  });

  test('drops duplicate eventIds — keeps first, drops the rest', () => {
    const { locked, dropped } = lockEventFactsFromDb(
      [
        { eventId: id1, title: 'First mention' },
        { eventId: id1, title: 'Second mention' },
      ],
      [dbRow()],
    );
    expect(locked).toHaveLength(1);
    expect(locked[0].title).toBe('First mention');
    expect(dropped[0].reason).toBe('duplicate eventId in draft');
  });

  test('matches eventIds case-insensitively', () => {
    const { locked, dropped } = lockEventFactsFromDb(
      [{ eventId: id1.toUpperCase(), title: 'Uppercase id from model' }],
      [dbRow()],
    );
    expect(dropped).toEqual([]);
    expect(locked).toHaveLength(1);
    expect(locked[0].eventId).toBe(id1);
  });

  test('handles a mix of valid and invalid events', () => {
    const { locked, dropped } = lockEventFactsFromDb(
      [
        { eventId: id1, title: 'Valid' },
        { eventId: 'bogus', title: 'Bad' },
        { eventId: id2, title: 'Also valid' },
      ],
      [dbRow({ id: id1 }), dbRow({ id: id2, title: 'Sunday Market', city: 'Sarasota', venue_name: 'Bayfront Park' })],
    );
    expect(locked.map((e) => e.title)).toEqual(['Valid', 'Also valid']);
    expect(dropped).toHaveLength(1);
    expect(dropped[0].reason).toBe('eventId not in approved list');
  });

  test('strips URLs the model slips into commentary prose (Codex P2)', () => {
    const { locked } = lockEventFactsFromDb(
      [{
        eventId: id1,
        title: 'Bradenton Blues',
        description: 'Grab tickets at https://scammy.example.com before they sell out.',
        proTip: 'More info at www.evil.example.com',
        highlights: ['Buy passes here: http://phish.example.com', 'Live music all night'],
        closingLine: 'See the lineup at [the site](https://bad.example.com).',
      }],
      [dbRow()],
    );
    const ev = locked[0];
    // No raw URLs survive in any commentary field
    const blob = [ev.description, ev.proTip, ev.closingLine, ...ev.highlights].join(' ');
    expect(blob).not.toMatch(/https?:\/\//i);
    expect(blob).not.toMatch(/www\./i);
    // Connector + URL strip cleanly (no dangling "at"/"here:")
    expect(ev.description).toBe('Grab tickets before they sell out.');
    // Markdown link keeps its label, drops the URL
    expect(ev.closingLine).toContain('the site');
    // Non-URL commentary is preserved
    expect(ev.highlights).toContain('Live music all night');
    // The DB-locked eventUrl is untouched and authoritative
    expect(ev.eventUrl).toBe('https://example.com/blues');
  });
});

// ── Hallucinated-claim hard-block scanner ────────────────────────────
//
// Encodes the contract that voice validation can warn about (advisory)
// vs what newsletter-validator must hard-block (factual/legal risk).
// Anything in this scanner is an error — the send route returns 400
// instead of dispatching.

describe('newsletter findHallucinatedClaims', () => {
  test('blocks dollar amounts in body', () => {
    const errors = findHallucinatedClaims('<p>Tickets are $15 at the door</p>');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes('dollar amount'))).toBe(true);
  });

  test('blocks "free admission" / "free tickets" claims', () => {
    expect(findHallucinatedClaims('<p>Free admission for all!</p>').length).toBeGreaterThan(0);
    expect(findHallucinatedClaims('<p>Grab your free tickets at the booth</p>').length).toBeGreaterThan(0);
  });

  test('blocks "no cost" / "complimentary" admission language', () => {
    expect(findHallucinatedClaims('<p>complimentary entry for kids</p>').length).toBeGreaterThan(0);
    expect(findHallucinatedClaims('<p>free of charge for everyone</p>').length).toBeGreaterThan(0);
  });

  test('blocks inverted "X is free" phrasing (Codex P2)', () => {
    expect(findHallucinatedClaims('<p>Show up — admission is free.</p>').length).toBeGreaterThan(0);
    expect(findHallucinatedClaims('<p>tickets are free this year</p>').length).toBeGreaterThan(0);
    expect(findHallucinatedClaims('<p>entry is free for members</p>').length).toBeGreaterThan(0);
    expect(findHallucinatedClaims('<p>the event is free to attend</p>').length).toBeGreaterThan(0);
    expect(findHallucinatedClaims('<p>parking is free downtown</p>').length).toBeGreaterThan(0);
  });

  test('blocks pest-control efficacy and safety guarantee phrases', () => {
    expect(findHallucinatedClaims('<p>guaranteed safe for pets</p>').length).toBeGreaterThan(0);
    expect(findHallucinatedClaims('<p>100% effective</p>').length).toBeGreaterThan(0);
    expect(findHallucinatedClaims('<p>Our pet-safe formula</p>').length).toBeGreaterThan(0);
    expect(findHallucinatedClaims('<p>child-safe spray</p>').length).toBeGreaterThan(0);
    expect(findHallucinatedClaims('<p>EPA-approved blend</p>').length).toBeGreaterThan(0);
  });

  test('dedupes repeated patterns — one error per label', () => {
    const errors = findHallucinatedClaims('<p>$5 here. $10 there. $20 everywhere.</p>');
    expect(errors).toHaveLength(1);
  });

  test('decodes HTML entities before matching (Codex P2)', () => {
    expect(findHallucinatedClaims('<p>Tickets are &#36;15 at the door</p>').length).toBeGreaterThan(0); // numeric &#36;
    expect(findHallucinatedClaims('<p>Cover is &#x24;20</p>').length).toBeGreaterThan(0); // hex &#x24;
    expect(findHallucinatedClaims('<p>Cover is &dollar;20</p>').length).toBeGreaterThan(0); // named &dollar;
    expect(findHallucinatedClaims('<p>admission&nbsp;is&nbsp;free</p>').length).toBeGreaterThan(0); // &nbsp; word-break
    expect(findHallucinatedClaims('<p>Tickets are &amp;#36;15</p>').length).toBeGreaterThan(0); // double-encoded
  });

  test('returns empty for clean body', () => {
    const clean = '<h2>Bradenton Blues</h2><p>Live music on the riverwalk Saturday night — bring a chair.</p>';
    expect(findHallucinatedClaims(clean)).toEqual([]);
  });

  test('returns empty for missing body', () => {
    expect(findHallucinatedClaims('')).toEqual([]);
    expect(findHallucinatedClaims(null)).toEqual([]);
  });
});

describe('newsletter validateNewsletterDraft — hallucinated claims hard-block', () => {
  const baseSend = {
    subject: 'Weekend Lineup',
    html_body: '<h2>Bradenton Blues</h2><p>Live music Saturday — schedule service via wavespestcontrol.com. Homeowner Minute: prep your lawn.</p>',
    text_body: 'Weekend events',
    preview_text: 'Live music + markets this weekend',
    newsletter_type: 'local-weekly-fresh-events',
  };

  test('clean flagship body has no errors', () => {
    const { errors } = validateNewsletterDraft(baseSend, { recipientCount: 100 });
    expect(errors).toEqual([]);
  });

  test('dollar amount in flagship body produces an error', () => {
    const send = { ...baseSend, html_body: baseSend.html_body + '<p>Tickets $15</p>' };
    const { errors } = validateNewsletterDraft(send, { recipientCount: 100 });
    expect(errors.some((e) => e.includes('Hallucinated claim'))).toBe(true);
  });

  test('non-flagship type skips the hallucination scan', () => {
    const send = {
      ...baseSend,
      newsletter_type: 'service-promo',
      html_body: '<p>Limited-time offer: $99 setup!</p>',
    };
    const { errors } = validateNewsletterDraft(send, { recipientCount: 100 });
    // Non-flagship types intentionally allow pricing — service promos quote prices
    expect(errors.filter((e) => e.includes('Hallucinated claim'))).toEqual([]);
  });

  test('hallucinated claim in plain-text fallback is blocked even when HTML is clean (Codex P2)', () => {
    const send = {
      ...baseSend,
      // HTML body is clean; the text-only fallback SendGrid delivers is not
      text_body: 'Bradenton Blues this Saturday. Tickets are $15 at the door.',
    };
    const { errors } = validateNewsletterDraft(send, { recipientCount: 100 });
    expect(errors.some((e) => e.includes('Hallucinated claim'))).toBe(true);
  });

  test('flagship send with only a text body (no HTML) is still scanned', () => {
    const send = {
      subject: 'Weekend Lineup',
      html_body: null,
      text_body: 'Free admission for everyone this weekend!',
      preview_text: 'Weekend',
      newsletter_type: 'local-weekly-fresh-events',
    };
    const { errors } = validateNewsletterDraft(send, { recipientCount: 100 });
    expect(errors.some((e) => e.includes('Hallucinated claim'))).toBe(true);
  });
});

// ── Autopilot preflight gate ─────────────────────────────────────────
//
// preflightDigest enforces the flagship type's declared quality contract
// before the Thursday auto-draft. Hard-fail (skip) on too few events or
// too few sources; city diversity + image coverage are soft warnings.
// A regression here either ships thin newsletters (gate too loose) or
// silences the autopilot every week (gate too strict).

describe('newsletter preflightDigest', () => {
  // Minimal scored-event shape — only the fields preflight reads.
  const ev = (i, { source = `s${i}`, city = `city${i}`, image = true } = {}) => ({
    id: `e${i}`,
    source_id: source,
    city,
    image_url: image ? `https://img/${i}.jpg` : null,
  });
  const plan = (events) => ({ scored: events });
  // Default thresholds match the flagship config (5 / 2 / 2 / 0.5).

  test('passes a healthy week (6 events, 3 sources, 3 cities, full images)', () => {
    const events = [0, 1, 2, 3, 4, 5].map((i) => ev(i, { source: `s${i % 3}`, city: `c${i % 3}` }));
    const r = preflightDigest(plan(events));
    expect(r.pass).toBe(true);
    expect(r.hardFailures).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.stats.eligibleCount).toBe(6);
    expect(r.stats.sourceCount).toBe(3);
  });

  test('hard-fails when fewer than 5 eligible events', () => {
    const events = [0, 1, 2, 3].map((i) => ev(i, { source: `s${i % 2}` }));
    const r = preflightDigest(plan(events));
    expect(r.pass).toBe(false);
    expect(r.hardFailures.some((f) => /Eligible fresh approved events: 4 \/ required 5/.test(f))).toBe(true);
  });

  test('hard-fails when fewer than 2 distinct sources (single-source week)', () => {
    const events = [0, 1, 2, 3, 4].map((i) => ev(i, { source: 'only-one' }));
    const r = preflightDigest(plan(events));
    expect(r.pass).toBe(false);
    expect(r.hardFailures.some((f) => /Source diversity: 1 \/ required 2/.test(f))).toBe(true);
  });

  test('soft-warns on low city diversity but still passes', () => {
    const events = [0, 1, 2, 3, 4].map((i) => ev(i, { source: `s${i % 2}`, city: 'sarasota' }));
    const r = preflightDigest(plan(events));
    expect(r.pass).toBe(true);
    expect(r.hardFailures).toEqual([]);
    expect(r.warnings.some((w) => /City diversity: 1 \/ recommended 2/.test(w))).toBe(true);
  });

  test('soft-warns on low image coverage but still passes', () => {
    const events = [0, 1, 2, 3, 4].map((i) => ev(i, { source: `s${i % 2}`, city: `c${i % 3}`, image: i === 0 }));
    const r = preflightDigest(plan(events));
    expect(r.pass).toBe(true);
    expect(r.warnings.some((w) => /Image coverage: 20% \/ recommended 50%/.test(w))).toBe(true);
  });

  test('measures diversity over the top-12 lineup, not the whole pool', () => {
    // 20 events but only from 1 source → still a single-source lineup
    const events = Array.from({ length: 20 }, (_, i) => ev(i, { source: 'mono' }));
    const r = preflightDigest(plan(events));
    expect(r.stats.eligibleCount).toBe(20);
    expect(r.stats.lineupSize).toBe(12);
    expect(r.pass).toBe(false); // source diversity 1 < 2
  });

  test('reads thresholds from the flagship type config', () => {
    const reqs = getFlagshipType().sourceRequirements;
    expect(reqs.minVerifiedFreshEvents).toBe(5);
    expect(reqs.minSourceDiversity).toBe(2);
    const events = [0, 1, 2, 3].map((i) => ev(i, { source: `s${i % 2}` })); // 4 events
    const r = preflightDigest(plan(events), reqs);
    expect(r.thresholds.minVerifiedFreshEvents).toBe(5);
    expect(r.pass).toBe(false); // 4 < config's 5
  });

  test('empty plan hard-fails on both gates', () => {
    const r = preflightDigest(plan([]));
    expect(r.pass).toBe(false);
    expect(r.hardFailures).toHaveLength(2);
  });
});
