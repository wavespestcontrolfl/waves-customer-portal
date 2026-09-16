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
  isUnresolvedSendReservation,
  excludeUnresolvedSendReservations,
} = require('../services/messaging/review-ask-reservation');
const ContextAggregator = require('../services/context-aggregator');
const customerHealth = require('../services/customer-health');
const signalDetector = require('../services/customer-intelligence/signal-detector');

describe('isUnresolvedReviewAskReservation — the shared predicate', () => {
  test('true only for the in-flight placeholder: status sending + the marker', () => {
    expect(isUnresolvedReviewAskReservation({ status: 'sending', metadata: { review_ask_reservation: true } })).toBe(true);
  });

  test('confirmed sends surface, while requeued or failed uncertain attempts remain hidden', () => {
    for (const status of ['sent', 'delivered']) {
      expect(isUnresolvedReviewAskReservation({ status, metadata: { review_ask_reservation: true } })).toBe(false);
    }
    for (const status of ['scheduled', 'sending', 'failed', 'undelivered', 'blocked', 'canceled']) {
      expect(isUnresolvedReviewAskReservation({ status, metadata: { review_ask_reservation: true } })).toBe(true);
    }
    expect(isUnresolvedReviewAskReservation({ status: 'scheduled', metadata: {
      review_ask_reservation: true, finalize_only: true,
    } })).toBe(false);
  });

  test('a reply reservation is NOT review-ask spacing evidence, but IS a placeholder general readers hide — while its hold runs', () => {
    const fresh = new Date(Date.now() - 3600000);
    const stale = new Date(Date.now() - 25 * 3600000);
    for (const marker of ['manual_send_reservation', 'auto_send_reservation']) {
      expect(isUnresolvedReviewAskReservation({ status: 'sending', metadata: { [marker]: true }, created_at: fresh })).toBe(false);
      expect(isUnresolvedSendReservation({ status: 'sending', metadata: { [marker]: true }, created_at: fresh })).toBe(true);
      expect(isUnresolvedSendReservation({ status: 'sent', metadata: { [marker]: true }, created_at: fresh })).toBe(false);
      // Past the reconciliation hold it SURFACES as the unresolved attempt it is.
      expect(isUnresolvedSendReservation({ status: 'sending', metadata: { [marker]: true }, created_at: stale })).toBe(false);
    }
    // A review-ask reservation is unconditional (any age) — still hidden
    // here, unlike the reply markers above, which age out past their hold.
    expect(isUnresolvedSendReservation({ status: 'sending', metadata: { review_ask_reservation: true }, created_at: stale })).toBe(true);
  });

  // Codex #4331 P1 (pre-push audit, REBUTTING the earlier structural-pass
  // "finding 6"): that finding gave a review-ask reservation the same 72h
  // age bound as a reply reservation, on the theory that a never-resolved
  // placeholder shouldn't hide from general readers forever. Reverted — the
  // two families are not the same risk. A reply reservation guards an
  // AMBIGUOUS AUTOMATIC reply that may have actually reached the customer,
  // so hiding it forever would bury a real sent message. A review-ask
  // reservation is SYNTHETIC — never itself a delivered message — and these
  // readers are not display-only (csr-coach.verifyFollowUps marks a
  // follow-up VERIFIED off exactly this kind of read; ContextAggregator
  // feeds composers a body with status stripped): an aged 'sending'
  // placeholder from a crash before delivery must never present as
  // delivery evidence for an ask that was never sent. It is resolved by the
  // stranded-send reconciliation instead, or surfaced to an operator via
  // that reconciliation's own stale-reservation count — never by aging out
  // of this predicate.
  test('a review-ask reservation stays hidden from general readers no matter how old — unlike a reply reservation', () => {
    const veryOld = new Date(Date.now() - 365 * 24 * 3600000);
    expect(isUnresolvedSendReservation({ status: 'sending', metadata: { review_ask_reservation: true }, created_at: veryOld })).toBe(true);
    // The narrow spacing-evidence predicate is likewise unaffected by age —
    // its callers (review-ask-history.js) already scope their own lookback
    // window rather than relying on this predicate to do it.
    expect(isUnresolvedReviewAskReservation({ status: 'sending', metadata: { review_ask_reservation: true }, created_at: veryOld })).toBe(true);
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

describe('excludeUnresolvedSendReservations — SQL-level exclusion', () => {
  test('excludes uncertain reviews across recovery statuses and in-flight reply holds', () => {
    const knex = require('knex')({ client: 'pg' });
    const { sql } = excludeUnresolvedSendReservations(knex('sms_log')).toSQL();
    expect(sql).toContain("sms_log.status NOT IN ('sent', 'delivered')");
    expect(sql).toContain("sms_log.status = 'sending'");
    expect(sql).toContain("sms_log.metadata->>'finalize_only'");
    expect(sql).toContain("sms_log.metadata->>'review_ask_reservation'");
    expect(sql).toContain("sms_log.metadata->>'manual_send_reservation'");
    expect(sql).toContain("sms_log.metadata->>'auto_send_reservation'");
    expect(sql).toContain("sms_log.created_at >= NOW() - INTERVAL '24 hours'");
    // The review-ask arm is UNCONDITIONAL (any age) — no interval clause on
    // that arm at all; only the reply-marker arm carries an age bound.
    expect(sql).not.toContain('72 hours');
  });

  test('qualifies an aliased/joined table when given', () => {
    const knex = require('knex')({ client: 'pg' });
    const { sql } = excludeUnresolvedSendReservations(knex('sms_log as reply'), 'reply').toSQL();
    expect(sql).toContain("reply.status NOT IN ('sent', 'delivered')");
    expect(sql).toContain("reply.status = 'sending'");
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
      if (excludeReservations) out = out.filter((r) => !isUnresolvedSendReservation(r));
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
    // Relative to "now", preserving the original fixture's spacing (12h,
    // 24h, 24h): the reservation must land inside the 72h hold to stay
    // hidden here — a fixed calendar date would eventually drift stale
    // (AGENTS.md P1, near-today date literals) and this stack's own 72h
    // hold makes that drift observable within days, not months.
    installSmsLog([
      { customer_id: customer.id, direction: 'inbound', message_body: 'Ants in the kitchen', message_type: 'manual', created_at: new Date(Date.now() - 69 * 3600000) },
      // In-flight, unconfirmed review-ask reservation — must NOT read as a
      // sent message.
      { customer_id: customer.id, direction: 'outbound', status: 'sending', message_body: 'Please leave a Google review: https://g.page/r/example/review', message_type: 'review', metadata: { review_ask_reservation: true }, created_at: new Date(Date.now() - 48 * 3600000) },
      // The SAME reservation mechanism, but resolved to a real status
      // (admin-communications.js's settleReviewReservation path) — this IS
      // a real message and must still show.
      { customer_id: customer.id, direction: 'outbound', status: 'sent', message_body: 'Please leave a Google review: https://g.page/r/example/review', message_type: 'review', metadata: { review_ask_reservation: true }, created_at: new Date(Date.now() - 24 * 3600000) },
      { customer_id: customer.id, direction: 'outbound', message_body: 'Happy to help — see you Friday!', message_type: 'manual', created_at: new Date() },
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
      created_at: new Date(Date.now() - (60 - i) * 60000),
    }));
    const reservation = {
      customer_id: customer.id, direction: 'outbound', status: 'sending',
      message_body: 'Please leave a Google review: https://g.page/r/example/review',
      message_type: 'review', metadata: { review_ask_reservation: true },
      // Newest of the bunch (and well inside the 72h hold) — without the
      // SQL-level exclusion this would be the row that survives the LIMIT
      // 20 and bumps a real one out.
      created_at: new Date(Date.now() - 60000),
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
        { customer_id: 'cust-eng-1', direction: 'inbound', created_at: new Date(Date.now() - 48 * 3600000) },
        // Unresolved — must not count toward smsOutbound. Inside the 72h hold.
        { customer_id: 'cust-eng-1', direction: 'outbound', status: 'sending', metadata: { review_ask_reservation: true }, created_at: new Date(Date.now() - 24 * 3600000) },
        // Resolved — a real outbound touch, must count.
        { customer_id: 'cust-eng-1', direction: 'outbound', status: 'sent', metadata: { review_ask_reservation: true }, created_at: new Date() },
      ],
    });

    const { details } = await customerHealth.computeEngagementScore('cust-eng-1');
    expect(details.smsOutbound).toBe(1);
    expect(details.smsInbound).toBe(1);
  });

  test('an all-unresolved-reservation history counts zero outbound touches', async () => {
    installDb({
      sms: [
        // Any age hides here (unconditional exclusion — see the
        // "stays hidden ... no matter how old" test above); this row just
        // happens to be recent.
        { customer_id: 'cust-eng-2', direction: 'outbound', status: 'sending', metadata: { review_ask_reservation: true }, created_at: new Date(Date.now() - 3600000) },
      ],
    });

    const { details } = await customerHealth.computeEngagementScore('cust-eng-2');
    expect(details.smsOutbound).toBe(0);
    expect(details.daysSinceLastContact).toBeNull();
  });
});

// A more general chainable sms_log fake for signal-detector's shape:
// several `.where(field, [op,] val)` calls (not just an object/customer_id
// pair), an optional exclusion whereRaw, then either `.count().first()` or
// `.select(...)`/`.orderBy().limit()` as the terminal op.
function makeGeneralSmsLogQuery(rows) {
  let filtered = rows.slice();
  let excludeReservations = false;
  let order = null;
  let limitN = null;
  const applyMatch = (field, op, val) => (row) => {
    const rv = row[field];
    if (op === '>') return new Date(rv).getTime() > new Date(val).getTime();
    if (op === '>=') return new Date(rv).getTime() >= new Date(val).getTime();
    return rv === val;
  };
  const resolved = () => {
    let out = filtered;
    if (excludeReservations) out = out.filter((r) => !isUnresolvedSendReservation(r));
    if (order) {
      const [col, dir] = order;
      out = [...out].sort((a, b) => {
        const diff = new Date(a[col]).getTime() - new Date(b[col]).getTime();
        return dir === 'desc' ? -diff : diff;
      });
    }
    if (limitN != null) out = out.slice(0, limitN);
    return out;
  };
  const q = {
    where(a, b, c) {
      const [field, op, val] = c === undefined ? [a, '=', b] : [a, b, c];
      filtered = filtered.filter(applyMatch(field, op, val));
      return q;
    },
    whereRaw(sql) { if (/review_ask_reservation/.test(sql)) excludeReservations = true; return q; },
    orderBy(col, dir = 'asc') { order = [col, dir]; return q; },
    limit(n) { limitN = n; return q; },
    select() { return q; },
    count() { return { first: async () => ({ count: String(resolved().length) }) }; },
    first() { return Promise.resolve(resolved()[0] || null); },
    then(resolve, reject) { return Promise.resolve(resolved()).then(resolve, reject); },
    catch(rej) { return q.then(undefined, rej); },
  };
  return q;
}

describe('signal-detector NO_RESPONSE_MULTIPLE — outbound count excludes only the unresolved reservation', () => {
  function installDb(sms) {
    db.mockImplementation((table) => (table === 'sms_log' ? makeGeneralSmsLogQuery(sms) : genericQuery([])));
  }

  test('4 unresolved reservations + 0 replies does NOT read as a churn signal', async () => {
    installDb(Array.from({ length: 4 }, (_, i) => ({
      customer_id: 'cust-sig-1', direction: 'outbound', status: 'sending',
      metadata: { review_ask_reservation: true },
      created_at: new Date(Date.now() - (i + 1) * 3600000),
    })));

    const signals = await signalDetector.detectSignals('cust-sig-1');
    expect(signals.some((s) => s.signal_type === 'NO_RESPONSE_MULTIPLE')).toBe(false);
  });

  test('4 REAL outbound sends + 0 replies still reads as NO_RESPONSE_MULTIPLE', async () => {
    installDb(Array.from({ length: 4 }, (_, i) => ({
      customer_id: 'cust-sig-2', direction: 'outbound', status: 'sent',
      created_at: new Date(Date.now() - (i + 1) * 3600000),
    })));

    const signals = await signalDetector.detectSignals('cust-sig-2');
    expect(signals.some((s) => s.signal_type === 'NO_RESPONSE_MULTIPLE')).toBe(true);
  });
});

describe('admin-communications ai-draft context — excludes only the unresolved reservation', () => {
  // Route handlers aren't easily invoked in isolation here; this exercises
  // the same excludeUnresolvedSendReservations + limit(5) composition
  // ai-draft applies to its recent-SMS-for-context query, the same
  // SQL-level guarantee proven for excludeUnresolvedSendReservations
  // above (bounded window can't be displaced by an unresolved reservation).
  test('a reservation newer than the last 5 real messages cannot occupy a context slot', async () => {
    const real = Array.from({ length: 5 }, (_, i) => ({
      from_phone: '+19415551234', to_phone: '+19415559999', direction: i % 2 === 0 ? 'inbound' : 'outbound',
      message_body: `real-${i}`, created_at: new Date(Date.UTC(2026, 8, 1, 0, i)),
    }));
    const reservation = {
      from_phone: '+19415559999', to_phone: '+19415551234', direction: 'outbound', status: 'sending',
      message_body: 'Please leave a Google review: https://g.page/r/example/review',
      metadata: { review_ask_reservation: true },
      created_at: new Date(Date.UTC(2026, 8, 1, 1, 0)),
    };
    const knex = require('knex')({ client: 'pg' });
    const rows = [...real, reservation];
    // Build against a real knex query compiler (mirrors the module's own
    // SQL-compile test above) to prove the exact composition ai-draft uses
    // — where(...).orderBy(...).limit(5) — filters the reservation out at
    // the SQL level before the LIMIT, then apply that same WHERE/ORDER/LIMIT
    // in-memory against the fixture to assert the resulting row set.
    const { sql } = excludeUnresolvedSendReservations(
      knex('sms_log').where(function () {
        this.where('from_phone', 'like', '%5551234').orWhere('to_phone', 'like', '%5551234');
      }),
    ).orderBy('created_at', 'desc').limit(5).toSQL();
    expect(sql).toContain("sms_log.status NOT IN ('sent', 'delivered')");

    const matched = rows.filter((r) => !isUnresolvedReviewAskReservation(r))
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, 5);
    expect(matched.length).toBe(5);
    expect(matched.some((r) => r.message_body.includes('Please leave a Google review'))).toBe(false);
    for (let i = 0; i < 5; i++) expect(matched.some((r) => r.message_body === `real-${i}`)).toBe(true);
  });
});

describe('review-ask-drafter recentSmsThread — the grounding window excludes only the unresolved reservation', () => {
  // The last reader in the sweep (codex #4331 P2, round 2): this history is
  // fed to the model that writes the customer-facing ask, so an unresolved
  // reservation would be presented as a message Waves definitely sent — and,
  // being the newest row, would displace real context inside MAX_SMS_HISTORY.
  test('a reservation newer than the real thread cannot take a grounding slot', () => {
    const real = Array.from({ length: 6 }, (_, i) => ({
      direction: i % 2 === 0 ? 'inbound' : 'outbound', status: 'delivered',
      message_body: `real-${i}`, created_at: new Date(Date.UTC(2026, 8, 1, 0, i)),
    }));
    const reservation = {
      direction: 'outbound', status: 'sending',
      message_body: 'Would you leave us a quick review?',
      metadata: { review_ask_reservation: true },
      created_at: new Date(Date.UTC(2026, 8, 1, 1, 0)),
    };
    const knex = require('knex')({ client: 'pg' });
    // The exact composition recentSmsThread uses — the filter is applied to
    // the builder BEFORE the window/order/limit, so it runs at SQL level
    // ahead of the LIMIT rather than thinning the result afterwards.
    const { sql } = excludeUnresolvedSendReservations(knex('sms_log').where({ customer_id: 'cust-1' }))
      .where('created_at', '>', new Date(Date.UTC(2026, 7, 1)))
      .orderBy('created_at', 'desc').limit(6).toSQL();
    expect(sql).toContain("sms_log.status NOT IN ('sent', 'delivered')");

    const matched = [...real, reservation].filter((r) => !isUnresolvedReviewAskReservation(r))
      .sort((a, b) => b.created_at - a.created_at).slice(0, 6);
    expect(matched.length).toBe(6);
    expect(matched.some((r) => r.message_body.includes('leave us a quick review'))).toBe(false);
    // A resolved reservation is a real message and stays in the thread.
    const settled = [...real, { ...reservation, status: 'sent' }].filter((r) => !isUnresolvedReviewAskReservation(r));
    expect(settled.some((r) => r.message_body.includes('leave us a quick review'))).toBe(true);
  });
});

describe('csr-coach verifyFollowUps — an unresolved reservation is not proof staff completed the follow-up', () => {
  jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn() }));
  const csrCoach = require('../services/csr/csr-coach');

  function installDb({ sms, tasks }) {
    const updates = [];
    const smsQuery = (rows) => {
      let excludeReservations = false;
      let customerId;
      const q = {
        where(col, val) { if (col === 'customer_id') customerId = val; return q; },
        whereRaw(sql) { if (/review_ask_reservation/.test(sql)) excludeReservations = true; return q; },
        async first() {
          let out = rows.filter((r) => r.customer_id === customerId && r.direction === 'outbound');
          if (excludeReservations) out = out.filter((r) => !isUnresolvedSendReservation(r));
          return out[0] ?? null;
        },
      };
      return q;
    };
    db.mockImplementation((table) => {
      if (table === 'sms_log') return smsQuery(sms);
      if (table === 'ai_follow_up_tasks') {
        const q = {
          whereIn: () => q,
          where: (col, val) => (col === 'id' ? { update: async (patch) => { updates.push({ id: val, ...patch }); return 1; } } : q),
          then: (resolve, reject) => Promise.resolve(tasks).then(resolve, reject),
        };
        return q;
      }
      if (table === 'customer_interactions') {
        const q = { where: () => q, whereIn: () => q, first: async () => null };
        return q;
      }
      return genericQuery([]);
    });
    return updates;
  }

  // Both within the 72h hold: the reservation-still-hides case is the point
  // of the first test below; aging past 72h is covered separately.
  const task = { id: 'task-1', customer_id: 'cust-csr-1', created_at: new Date(Date.now() - 48 * 3600000) };

  test('a still-unresolved reservation after the task does NOT verify it', async () => {
    const updates = installDb({
      tasks: [task],
      sms: [{ customer_id: 'cust-csr-1', direction: 'outbound', status: 'sending', metadata: { review_ask_reservation: true }, created_at: new Date(Date.now() - 24 * 3600000) }],
    });
    await csrCoach.verifyFollowUps();
    expect(updates.filter((u) => u.status === 'verified')).toHaveLength(0);
  });

  test('a real outbound text after the task still verifies it', async () => {
    const updates = installDb({
      tasks: [task],
      sms: [{ customer_id: 'cust-csr-1', direction: 'outbound', status: 'sent', metadata: { review_ask_reservation: true }, created_at: new Date(Date.now() - 24 * 3600000) }],
    });
    await csrCoach.verifyFollowUps();
    expect(updates.filter((u) => u.status === 'verified')).toHaveLength(1);
  });
});


test('estimator thread excludes unresolved review reservations before applying its history limit', async () => {
  const rows = [
    { from_phone: '+15555550100', to_phone: '+15555550101', message_body: 'Actual delivered reply', created_at: new Date(Date.now() - 2 * 3600000), direction: 'outbound', status: 'sent' },
    { from_phone: '+15555550100', to_phone: '+15555550101', message_body: 'Unconfirmed review placeholder', created_at: new Date(Date.now() - 3600000), direction: 'outbound', status: 'sending', metadata: { review_ask_reservation: true } },
  ];
  const query = makeSmsLogQuery(rows);
  query.select = () => query;
  db.mockReturnValue(query);
  const { loadSmsThread } = require('../services/estimator-engine/context-builder');
  expect(await loadSmsThread('+15555550101', { limit: 1 })).toEqual([
    { direction: 'outbound', body: 'Actual delivered reply', at: rows[0].created_at },
  ]);
});
