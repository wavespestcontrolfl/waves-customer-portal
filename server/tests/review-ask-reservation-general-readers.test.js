/**
 * Codex #4331 P2 — general readers of sms_log (conversation history,
 * outbound counts, message context) must not treat an unresolved review-ask
 * reservation (the synthetic 'sending' placeholder — review-request.js's
 * reserveReviewSms) as a message Waves definitely sent, but a reservation
 * that HAS resolved to a real status (e.g. 'sent') is a real message and
 * must still appear. Covers the shared predicate/helper itself, then two
 * concrete general readers: ContextAggregator.getContextForCustomer
 * (smsHistory — the case named in the finding) and customer-health's
 * outbound-count signal.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../models/db', () => jest.fn());

const db = require('../models/db');
db.schema = { hasTable: async () => true };

const {
  isUnresolvedReviewAskReservation,
  excludeUnresolvedReviewAskReservations,
} = require('../services/messaging/review-ask-reservation');
const ContextAggregator = require('../services/context-aggregator');
const customerHealth = require('../services/customer-health');

describe('isUnresolvedReviewAskReservation — the shared predicate', () => {
  test('true only for the in-flight placeholder: status sending + the marker', () => {
    expect(isUnresolvedReviewAskReservation({ status: 'sending', metadata: { review_ask_reservation: true } })).toBe(true);
  });

  test('false once the row resolves to a real status, even though the marker survives', () => {
    for (const status of ['sent', 'delivered', 'failed', 'undelivered', 'blocked', 'canceled']) {
      expect(isUnresolvedReviewAskReservation({ status, metadata: { review_ask_reservation: true } })).toBe(false);
    }
  });

  test('false for an ordinary sending row without the marker', () => {
    expect(isUnresolvedReviewAskReservation({ status: 'sending', metadata: {} })).toBe(false);
    expect(isUnresolvedReviewAskReservation({ status: 'sending', metadata: null })).toBe(false);
  });

  test('tolerates a stringified metadata column and a missing row', () => {
    expect(isUnresolvedReviewAskReservation({ status: 'sending', metadata: JSON.stringify({ review_ask_reservation: true }) })).toBe(true);
    expect(isUnresolvedReviewAskReservation(null)).toBe(false);
  });
});

describe('excludeUnresolvedReviewAskReservations — SQL-level exclusion', () => {
  test('compiles a NOT(status=sending AND marker) filter against the bare table', () => {
    const knex = require('knex')({ client: 'pg' });
    const { sql } = excludeUnresolvedReviewAskReservations(knex('sms_log')).toSQL();
    expect(sql).toContain("NOT (sms_log.status = 'sending'");
    expect(sql).toContain("sms_log.metadata->>'review_ask_reservation'");
  });

  test('qualifies an aliased/joined table when given', () => {
    const knex = require('knex')({ client: 'pg' });
    const { sql } = excludeUnresolvedReviewAskReservations(knex('sms_log as reply'), 'reply').toSQL();
    expect(sql).toContain("NOT (reply.status = 'sending'");
  });
});

// A generic chainable stub for every table a test doesn't care about —
// every other Promise.all leg in getContextForCustomer resolves to an
// empty result instead of throwing.
function genericQuery(resolveValue = []) {
  const proxy = new Proxy(function () {}, {
    get(_target, prop) {
      if (prop === 'then') return (res, rej) => Promise.resolve(resolveValue).then(res, rej);
      if (prop === 'catch') return (rej) => Promise.resolve(resolveValue).then(undefined, rej);
      if (prop === 'first') return () => Promise.resolve(Array.isArray(resolveValue) ? (resolveValue[0] ?? null) : (resolveValue ?? null));
      if (prop === 'count') return () => ({ first: async () => ({ count: '0', c: '0' }) });
      return () => proxy;
    },
  });
  return proxy;
}

// A real (filtering) fake for sms_log: applies the customer_id equality and
// — when the query modifier ran — the reservation exclusion, THEN sorts and
// limits, exactly mirroring real SQL semantics (WHERE before ORDER/LIMIT
// regardless of chain order) so a bounded-window displacement bug would
// actually show up here.
function makeSmsLogQuery(rows, { customerIdFromObject = true } = {}) {
  let customerId;
  let excludeReservations = false;
  let order = null;
  let limitN = null;
  const q = {
    where(a, b) {
      if (customerIdFromObject) { if (a && typeof a === 'object' && 'customer_id' in a) customerId = a.customer_id; }
      else customerId = b;
      return q;
    },
    whereRaw(sql) { if (/review_ask_reservation/.test(sql)) excludeReservations = true; return q; },
    orderBy(col, dir = 'asc') { order = [col, dir]; return q; },
    limit(n) { limitN = n; return q; },
    then(resolve, reject) {
      let out = rows.filter((r) => customerId === undefined || r.customer_id === customerId);
      if (excludeReservations) out = out.filter((r) => !isUnresolvedReviewAskReservation(r));
      if (order) {
        const [col, dir] = order;
        out = [...out].sort((a, b) => {
          const diff = new Date(a[col]).getTime() - new Date(b[col]).getTime();
          return dir === 'desc' ? -diff : diff;
        });
      }
      if (limitN != null) out = out.slice(0, limitN);
      return Promise.resolve(out).then(resolve, reject);
    },
    catch(rej) { return q.then(undefined, rej); },
  };
  return q;
}

describe('ContextAggregator.getContextForCustomer — smsHistory excludes only the unresolved reservation', () => {
  function installSmsLog(rows) {
    db.mockImplementation((table) => {
      const name = String(table).split(/\s+as\s+/i)[0];
      return name === 'sms_log' ? makeSmsLogQuery(rows) : genericQuery([]);
    });
  }

  const customer = {
    id: 'cust-history-1', first_name: 'Pat', last_name: 'Doe', phone: '+19415551234',
    email: 'pat@example.com', address_line1: '1 Main St', city: 'Bradenton', zip: '34205',
    waveguard_tier: null, monthly_rate: 0, pipeline_stage: 'active_customer', lead_score: null,
    customer_since: '2024-01-01', deleted_at: null, autopay_enabled: false,
    billing_mode: null, ach_status: null, autopay_paused_until: null, autopay_payment_method_id: null,
  };

  test('an unresolved reservation is hidden, a resolved one appears, real messages are unaffected', async () => {
    installSmsLog([
      { customer_id: customer.id, direction: 'inbound', message_body: 'Ants in the kitchen', message_type: 'manual', created_at: new Date('2026-09-01T12:00:00Z') },
      // In-flight, unconfirmed review-ask reservation — must NOT read as a
      // sent message.
      { customer_id: customer.id, direction: 'outbound', status: 'sending', message_body: 'Please leave a Google review: https://g.page/r/example/review', message_type: 'review', metadata: { review_ask_reservation: true }, created_at: new Date('2026-09-02T09:00:00Z') },
      // The SAME reservation mechanism, but resolved to a real status
      // (admin-communications.js's settleReviewReservation path) — this IS
      // a real message and must still show.
      { customer_id: customer.id, direction: 'outbound', status: 'sent', message_body: 'Please leave a Google review: https://g.page/r/example/review', message_type: 'review', metadata: { review_ask_reservation: true }, created_at: new Date('2026-09-03T09:00:00Z') },
      { customer_id: customer.id, direction: 'outbound', message_body: 'Happy to help — see you Friday!', message_type: 'manual', created_at: new Date('2026-09-04T09:00:00Z') },
    ]);

    const context = await ContextAggregator.getContextForCustomer(customer);

    const bodies = context.smsHistory.map((m) => m.body);
    expect(context.smsHistory.filter((m) => m.body.includes('Please leave a Google review')).length).toBe(1);
    expect(bodies).toContain('Ants in the kitchen');
    expect(bodies).toContain('Happy to help — see you Friday!');
    expect(context.smsHistory.length).toBe(3);
  });

  test('an unresolved reservation cannot displace a real row out of the bounded (limit 20) window', async () => {
    const real = Array.from({ length: 20 }, (_, i) => ({
      customer_id: customer.id, direction: i % 2 === 0 ? 'inbound' : 'outbound',
      message_body: `msg-${i}`, message_type: 'manual',
      created_at: new Date(Date.UTC(2026, 8, 1, 0, i)),
    }));
    const reservation = {
      customer_id: customer.id, direction: 'outbound', status: 'sending',
      message_body: 'Please leave a Google review: https://g.page/r/example/review',
      message_type: 'review', metadata: { review_ask_reservation: true },
      // Newest of the bunch — without the SQL-level exclusion this would be
      // the row that survives the LIMIT 20 and bumps a real one out.
      created_at: new Date(Date.UTC(2026, 8, 1, 1, 0)),
    };
    installSmsLog([...real, reservation]);

    const context = await ContextAggregator.getContextForCustomer(customer);

    expect(context.smsHistory.length).toBe(20);
    expect(context.smsHistory.some((m) => m.body.includes('Please leave a Google review'))).toBe(false);
    for (let i = 0; i < 20; i++) {
      expect(context.smsHistory.some((m) => m.body === `msg-${i}`)).toBe(true);
    }
  });
});

describe('customer-health computeEngagementScore — outbound-count signal excludes only the unresolved reservation', () => {
  function installDb({ sms }) {
    db.mockImplementation((table) => {
      if (table === 'sms_log') return makeSmsLogQuery(sms, { customerIdFromObject: false });
      if (table === 'customer_interactions') {
        return { where: () => ({ count: () => ({ first: async () => ({ cnt: '0' }) }) }) };
      }
      return genericQuery([]);
    });
  }

  test('an unresolved reservation does not count as an outbound touch; a resolved one does', async () => {
    installDb({
      sms: [
        { customer_id: 'cust-eng-1', direction: 'inbound', created_at: new Date('2026-09-01T00:00:00Z') },
        // Unresolved — must not count toward smsOutbound.
        { customer_id: 'cust-eng-1', direction: 'outbound', status: 'sending', metadata: { review_ask_reservation: true }, created_at: new Date('2026-09-02T00:00:00Z') },
        // Resolved — a real outbound touch, must count.
        { customer_id: 'cust-eng-1', direction: 'outbound', status: 'sent', metadata: { review_ask_reservation: true }, created_at: new Date('2026-09-03T00:00:00Z') },
      ],
    });

    const { details } = await customerHealth.computeEngagementScore('cust-eng-1');
    expect(details.smsOutbound).toBe(1);
    expect(details.smsInbound).toBe(1);
  });

  test('an all-unresolved-reservation history counts zero outbound touches', async () => {
    installDb({
      sms: [
        { customer_id: 'cust-eng-2', direction: 'outbound', status: 'sending', metadata: { review_ask_reservation: true }, created_at: new Date('2026-09-01T00:00:00Z') },
      ],
    });

    const { details } = await customerHealth.computeEngagementScore('cust-eng-2');
    expect(details.smsOutbound).toBe(0);
    expect(details.daysSinceLastContact).toBeNull();
  });
});
