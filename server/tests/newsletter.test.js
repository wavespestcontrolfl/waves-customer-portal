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
const { computeNewsletterEventUpdates } = sendgridWebhook;

describe('newsletter buildSubscriberQuery', () => {
  // Knex .toSQL() returns { sql, bindings } from the query builder
  // without opening a DB connection — perfect for shape assertions.
  const shapeOf = (filter) => buildSubscriberQuery(filter).toSQL();

  test('null filter targets every active subscriber', () => {
    const { sql, bindings } = shapeOf(null);
    expect(sql).toMatch(/from "newsletter_subscribers"/);
    expect(sql).toMatch(/"status" = \$1/);
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
    expect(sql).toMatch(/"source" in \(\$\d+, \$\d+\)/);
    expect(bindings).toEqual(expect.arrayContaining(['website', 'quote_wizard']));
  });

  test('empty sources array is a no-op (no whereIn injected)', () => {
    const { sql } = shapeOf({ sources: [] });
    expect(sql).not.toMatch(/"source" in/);
  });

  test('tags filter uses jsonb ?| operator with N bindings', () => {
    const { sql, bindings } = shapeOf({ tags: ['platinum-tier', 'hurricane-prep'] });
    // Knex emits the raw fragment we passed; verify both bindings made it
    // through and the ?| operator is present (escaped as ?\| by some
    // parameter parsers — accept either rendering).
    expect(sql).toMatch(/tags \?\|? array\[\?,\?\]/);
    expect(bindings).toEqual(expect.arrayContaining(['platinum-tier', 'hurricane-prep']));
  });

  test('combined filters compose all clauses', () => {
    const { sql, bindings } = shapeOf({
      customersOnly: true,
      tags: ['vip'],
      sources: ['admin_manual'],
    });
    expect(sql).toMatch(/"status" = \$1/);
    expect(sql).toMatch(/"customer_id" is not null/);
    expect(sql).toMatch(/"source" in/);
    expect(sql).toMatch(/tags \?\|? array/);
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
    ...overrides,
  });

  describe('delivered', () => {
    test('first event stamps delivered_at + delivered_count', () => {
      const u = computeNewsletterEventUpdates({ event: 'delivered' }, fresh(), now);
      expect(u).toEqual({
        delivery: { status: 'delivered', delivered_at: now, updated_at: now },
        sendIncrement: 'delivered_count',
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
    });
    test('click stamps timestamp + clicked_count', () => {
      const u = computeNewsletterEventUpdates({ event: 'click' }, fresh(), now);
      expect(u.delivery).toEqual({ clicked_at: now, updated_at: now });
      expect(u.sendIncrement).toBe('clicked_count');
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
      expect(u.subscriberAction).toBe('force_unsubscribe');
    });
    test('idempotent — already-complained row is a no-op', () => {
      expect(computeNewsletterEventUpdates({ event: 'spamreport' }, fresh({ complained_at: now }), now)).toBeNull();
    });
  });

  describe('unsubscribe / group_unsubscribe', () => {
    test.each(['unsubscribe', 'group_unsubscribe'])('%s increments unsubscribed_count + conditional unsub', (e) => {
      const u = computeNewsletterEventUpdates({ event: e }, fresh(), now);
      expect(u.sendIncrement).toBe('unsubscribed_count');
      expect(u.subscriberAction).toBe('unsubscribe_if_active');
      // No delivery-row write — unsub doesn't change the delivery state,
      // it only flips the subscriber.
      expect(u.delivery).toBeUndefined();
    });
  });

  describe('ignored events', () => {
    test.each(['processed', 'deferred', 'group_resubscribe', 'unknown_future_event'])('%s is a no-op', (e) => {
      expect(computeNewsletterEventUpdates({ event: e }, fresh(), now)).toBeNull();
    });
  });
});
