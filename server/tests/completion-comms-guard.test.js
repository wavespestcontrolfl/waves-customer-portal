/**
 * Completion-path comms guard (GATE_COMPLETION_COMMS_GUARD, dark by
 * default): a visit completed while the customer has a pending
 * reschedule/away flag (#3232's comms_guards rows) or an unanswered
 * inbound text surfaces ONE admin exception — bell notification +
 * dispatch_alerts card — and NEVER blocks completion or invoicing.
 *
 * Behavioral tests run the real service (and the real
 * notification-service / dispatch-alerts writers) against a filtering
 * knex stub with SYNTHETIC fixtures only; the giant /complete route is
 * pinned with source contracts in the house style of
 * admin-dispatch-followup-alert.test.js.
 */
const fs = require('fs');
const path = require('path');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();

// Synthetic ids only — never real customer data.
const CUSTOMER_ID = '00000000-0000-4000-8000-0000000000c1';
const SERVICE_ID = '00000000-0000-4000-8000-0000000000s1';
const OTHER_SERVICE_ID = '00000000-0000-4000-8000-0000000000s2';

// ---------------------------------------------------------------------------
// Filtering knex stub: rowsByTable feeds results; where/whereIn/whereNull/
// grouped-or clauses actually filter, so Leg A/Leg B predicates get real
// behavioral coverage instead of mocked query text (#3232's lane-2 paren bug
// shipped precisely because tests mocked the SQL away).
// ---------------------------------------------------------------------------
function opPredicate(col, op, val) {
  const v = val instanceof Date ? val.getTime() : val;
  return (row) => {
    const raw = row[col];
    const r = raw instanceof Date ? raw.getTime() : raw;
    if (op === '>=') return r >= v;
    if (op === '>') return r > v;
    if (op === '<=') return r <= v;
    if (op === '<') return r < v;
    if (op === '=') return r === v;
    throw new Error(`stub knex: unsupported operator ${op}`);
  };
}

// Grouped where callback — knex semantics: where* ANDs onto the current
// branch, orWhere* starts a new branch; result = OR over branches.
function groupPredicate(fn) {
  const branches = [[]];
  const current = () => branches[branches.length - 1];
  const group = {
    where(a, b, c) {
      if (typeof a === 'function') current().push(groupPredicate(a));
      else if (typeof a === 'object') current().push((r) => Object.entries(a).every(([k, v]) => r[k] === v));
      else if (c !== undefined) current().push(opPredicate(a, b, c));
      else current().push((r) => r[a] === b);
      return group;
    },
    orWhere(a, b, c) { branches.push([]); return group.where(a, b, c); },
    whereNull(col) { current().push((r) => r[col] == null); return group; },
    orWhereNull(col) { branches.push([]); return group.whereNull(col); },
    whereIn(col, list) { current().push((r) => list.includes(r[col])); return group; },
    whereNotIn(col, list) { current().push((r) => r[col] != null && !list.includes(r[col])); return group; },
    orWhereNotIn(col, list) { branches.push([]); return group.whereNotIn(col, list); },
  };
  fn.call(group, group);
  return (row) => branches.some((preds) => preds.every((p) => p(row)));
}

function makeStubKnex(rowsByTable = {}) {
  const data = {};
  for (const [table, rows] of Object.entries(rowsByTable)) data[table] = rows.map((r) => ({ ...r }));
  const tableCalls = [];
  const rawCalls = [];
  let seq = 0;

  function builder(table) {
    tableCalls.push(table);
    if (!data[table]) data[table] = [];
    const preds = [];
    let order = null;
    let limitN = null;
    const run = () => {
      let rows = data[table].filter((r) => preds.every((p) => p(r)));
      if (order) {
        const { col, dir } = order;
        rows = [...rows].sort((a, b) => {
          const av = a[col] instanceof Date ? a[col].getTime() : a[col];
          const bv = b[col] instanceof Date ? b[col].getTime() : b[col];
          return dir === 'desc' ? (bv > av ? 1 : bv < av ? -1 : 0) : (av > bv ? 1 : av < bv ? -1 : 0);
        });
      }
      return limitN == null ? rows : rows.slice(0, limitN);
    };
    const q = {
      where(a, b, c) {
        if (typeof a === 'function') preds.push(groupPredicate(a));
        else if (typeof a === 'object') preds.push((r) => Object.entries(a).every(([k, v]) => r[k] === v));
        else if (c !== undefined) preds.push(opPredicate(a, b, c));
        else preds.push((r) => r[a] === b);
        return q;
      },
      whereIn(col, list) { preds.push((r) => list.includes(r[col])); return q; },
      whereNull(col) { preds.push((r) => r[col] == null); return q; },
      whereNotNull(col) { preds.push((r) => r[col] != null); return q; },
      limit(n) { limitN = n; return q; },
      select() { return Promise.resolve(run()); },
      whereRaw(sql, bindings) {
        if (/metadata->>'dedupeKey'/.test(sql)) {
          const key = bindings[0];
          preds.push((r) => {
            let meta = r.metadata;
            if (typeof meta === 'string') { try { meta = JSON.parse(meta); } catch { meta = null; } }
            return meta?.dedupeKey === key;
          });
          return q;
        }
        throw new Error(`stub knex: unsupported whereRaw: ${sql}`);
      },
      orderBy(col, dir = 'asc') { order = { col, dir }; return q; },
      first() { return Promise.resolve(run()[0]); },
      insert(row) {
        seq += 1;
        const inserted = { id: `stub-${table}-${seq}`, created_at: new Date(), ...row };
        data[table].push(inserted);
        return {
          returning: () => Promise.resolve([inserted]),
          then: (res, rej) => Promise.resolve([inserted]).then(res, rej),
        };
      },
      then: (res, rej) => Promise.resolve(run()).then(res, rej),
    };
    return q;
  }

  const knex = (table) => builder(table);
  knex.transaction = async (fn) => {
    const trx = (table) => builder(table);
    trx.raw = async (sql, bindings) => { rawCalls.push({ sql, bindings }); return { rows: [] }; };
    return fn(trx);
  };
  knex._data = data;
  knex._tableCalls = tableCalls;
  knex._rawCalls = rawCalls;
  return knex;
}

// ---------------------------------------------------------------------------
// Synthetic fixture rows
// ---------------------------------------------------------------------------
function pendingFlagRow(overrides = {}) {
  return {
    id: 'decision-1',
    workflow: 'comms_guards',
    detected_intent: 'reschedule_or_away_needs_review',
    status: 'pending_review',
    entity_id: SERVICE_ID,
    customer_id: CUSTOMER_ID,
    created_at: new Date(NOW - 1 * DAY),
    ...overrides,
  };
}

// Synthetic phone numbers (555-01xx is the reserved fictional block).
const CUST_PHONE = '+19415550101';
const CUST_PHONE_2 = '+19415550102';   // same customer, second handset
const WAVES_ENDPOINT = '+19415550190';
const WAVES_ENDPOINT_2 = '+19415550191'; // a second Waves number

function inboundRow(overrides = {}) {
  return {
    id: 'sms-in-1',
    customer_id: CUSTOMER_ID,
    direction: 'inbound',
    message_type: null,
    message_body: 'are you still coming out friday?',
    status: 'received',
    from_phone: CUST_PHONE,
    to_phone: WAVES_ENDPOINT,
    created_at: new Date(NOW - 1 * DAY),
    ...overrides,
  };
}

function outboundRow(overrides = {}) {
  return {
    id: 'sms-out-1',
    customer_id: CUSTOMER_ID,
    direction: 'outbound',
    message_type: 'manual',
    status: 'delivered',
    from_phone: WAVES_ENDPOINT,
    to_phone: CUST_PHONE,
    created_at: new Date(NOW - 12 * 60 * 60 * 1000),
    ...overrides,
  };
}

function loadGuard({ gateOn }) {
  jest.resetModules();
  if (gateOn) process.env.GATE_COMPLETION_COMMS_GUARD = 'true';
  else delete process.env.GATE_COMPLETION_COMMS_GUARD;
   
  return require('../services/completion-comms-guard');
}

afterAll(() => { delete process.env.GATE_COMPLETION_COMMS_GUARD; });

// ---------------------------------------------------------------------------
// findOpenCommsExceptions — pure read legs
// ---------------------------------------------------------------------------
describe('findOpenCommsExceptions', () => {
  const { findOpenCommsExceptions } = loadGuard({ gateOn: true });

  test('Leg A: pending flag linked to THIS visit is returned', async () => {
    const knex = makeStubKnex({ agent_decisions: [pendingFlagRow()] });
    const out = await findOpenCommsExceptions({ customerId: CUSTOMER_ID, serviceId: SERVICE_ID, knex });
    expect(out.pendingFlag?.id).toBe('decision-1');
  });

  test('Leg A: customer-wide flag (entity_id NULL) matches; a flag linked to a DIFFERENT visit does not', async () => {
    const customerWide = await findOpenCommsExceptions({
      customerId: CUSTOMER_ID,
      serviceId: SERVICE_ID,
      knex: makeStubKnex({ agent_decisions: [pendingFlagRow({ entity_id: null })] }),
    });
    expect(customerWide.pendingFlag?.id).toBe('decision-1');

    const otherVisit = await findOpenCommsExceptions({
      customerId: CUSTOMER_ID,
      serviceId: SERVICE_ID,
      knex: makeStubKnex({ agent_decisions: [pendingFlagRow({ entity_id: OTHER_SERVICE_ID })] }),
    });
    expect(otherVisit.pendingFlag).toBeNull();
  });

  test('Leg A: resolved flags are ignored; a stale CUSTOMER-WIDE flag ages out', async () => {
    const out = await findOpenCommsExceptions({
      customerId: CUSTOMER_ID,
      serviceId: SERVICE_ID,
      knex: makeStubKnex({
        agent_decisions: [
          pendingFlagRow({ id: 'resolved', status: 'resolved' }),
          pendingFlagRow({ id: 'stale', entity_id: null, created_at: new Date(NOW - 15 * DAY) }),
        ],
      }),
    });
    expect(out.pendingFlag).toBeNull();
  });

  test('Leg A: a flag LINKED TO THIS VISIT never ages out (flagger books up to 14 days ahead)', async () => {
    // Raised the day the visit was booked, 14 days out; the visit completes
    // today, making the flag older than 14x24h. A strict cutoff would drop
    // exactly the request raised furthest in advance.
    const out = await findOpenCommsExceptions({
      customerId: CUSTOMER_ID,
      serviceId: SERVICE_ID,
      knex: makeStubKnex({
        agent_decisions: [pendingFlagRow({ id: 'booked-early', created_at: new Date(NOW - 15 * DAY) })],
      }),
    });
    expect(out.pendingFlag?.id).toBe('booked-early');
  });

  test('Leg B: latest in-window inbound with no later human outbound is unanswered (NULL message_type counts)', async () => {
    const out = await findOpenCommsExceptions({
      customerId: CUSTOMER_ID,
      serviceId: SERVICE_ID,
      knex: makeStubKnex({ sms_log: [inboundRow()] }),
    });
    expect(out.unansweredInbound?.id).toBe('sms-in-1');
  });

  test('Leg B: a later human-authored outbound answers the thread', async () => {
    for (const type of ['manual', 'ai_approved', 'ai_revised']) {
      const out = await findOpenCommsExceptions({
        customerId: CUSTOMER_ID,
        serviceId: SERVICE_ID,
        knex: makeStubKnex({ sms_log: [inboundRow(), outboundRow({ message_type: type })] }),
      });
      expect(out.unansweredInbound).toBeNull();
    }
  });

  test('Leg B ignores automated outbound types — a reminder/review broadcast does not clear a waiting customer', async () => {
    for (const type of ['reminder', 'review', 'completion', 'billing', 'campaign', 'en_route']) {
      const out = await findOpenCommsExceptions({
        customerId: CUSTOMER_ID,
        serviceId: SERVICE_ID,
        knex: makeStubKnex({ sms_log: [inboundRow(), outboundRow({ message_type: type })] }),
      });
      expect(out.unansweredInbound?.id).toBe('sms-in-1');
    }
  });

  test('only CONFIRMED delivery answers — a queued reply Twilio later fails must not permanently swallow the exception', async () => {
    // This hook is one-shot (deduped per visit forever), so it cannot wait
    // for a delivery receipt the way the daily digest can. Mirrors the
    // watcher's durable-resolution bar.
    for (const status of ['queued', 'sent', 'failed', 'undelivered']) {
      const legB = await findOpenCommsExceptions({
        customerId: CUSTOMER_ID,
        serviceId: SERVICE_ID,
        knex: makeStubKnex({ sms_log: [inboundRow(), outboundRow({ status })] }),
      });
      expect(legB.unansweredInbound?.id).toBe('sms-in-1');

      const legA = await findOpenCommsExceptions({
        customerId: CUSTOMER_ID,
        serviceId: SERVICE_ID,
        knex: makeStubKnex({
          agent_decisions: [pendingFlagRow({ created_at: new Date(NOW - 3 * DAY) })],
          sms_log: [outboundRow({ status, created_at: new Date(NOW - 2 * DAY) })],
        }),
      });
      expect(legA.pendingFlag?.id).toBe('decision-1');
    }
  });

  test('Leg B: excluded inbound intents never surface', async () => {

    for (const type of ['opt_out', 'opt_in', 'sms_reaction', 'help_request', 'reschedule_reply']) {
      const out = await findOpenCommsExceptions({
        customerId: CUSTOMER_ID,
        serviceId: SERVICE_ID,
        knex: makeStubKnex({ sms_log: [inboundRow({ message_type: type })] }),
      });
      expect(out.unansweredInbound).toBeNull();
    }
  });

  test('Leg B: a human-APPROVED proactive nudge is not an answer (mirrors the digest click_followup exclusion)', async () => {
    const inbound = inboundRow();
    const nudge = outboundRow({ created_at: new Date(NOW - 6 * 60 * 60 * 1000) });
    // Unanchored draft (sms_log_id NULL) finalized alongside the outbound =
    // proactive marketing, not a reply to this thread.
    const proactive = await findOpenCommsExceptions({
      customerId: CUSTOMER_ID,
      serviceId: SERVICE_ID,
      knex: makeStubKnex({
        sms_log: [inbound, nudge],
        message_drafts: [{
          id: 'draft-1', customer_id: CUSTOMER_ID, sms_log_id: null,
          sent_at: new Date(nudge.created_at.getTime() + 30 * 1000),
        }],
      }),
    });
    expect(proactive.unansweredInbound?.id).toBe('sms-in-1');

    // A draft ANCHORED to an inbound (sms_log_id set) is a real reply.
    const anchored = await findOpenCommsExceptions({
      customerId: CUSTOMER_ID,
      serviceId: SERVICE_ID,
      knex: makeStubKnex({
        sms_log: [inbound, nudge],
        message_drafts: [{
          id: 'draft-2', customer_id: CUSTOMER_ID, sms_log_id: 'sms-in-1',
          sent_at: new Date(nudge.created_at.getTime() + 30 * 1000),
        }],
      }),
    });
    expect(anchored.unansweredInbound).toBeNull();

    // A genuine reply alongside the proactive nudge still answers the thread.
    const alsoReplied = await findOpenCommsExceptions({
      customerId: CUSTOMER_ID,
      serviceId: SERVICE_ID,
      knex: makeStubKnex({
        sms_log: [inbound, nudge, outboundRow({ id: 'sms-out-2', created_at: new Date(NOW - 2 * 60 * 60 * 1000) })],
        message_drafts: [{
          id: 'draft-3', customer_id: CUSTOMER_ID, sms_log_id: null,
          sent_at: new Date(nudge.created_at.getTime() + 30 * 1000),
        }],
      }),
    });
    expect(alsoReplied.unansweredInbound).toBeNull();
  });

  test('Leg B: a later STOP retires the thread — an opted-out customer is never surfaced as waiting', async () => {
    const out = await findOpenCommsExceptions({
      customerId: CUSTOMER_ID,
      serviceId: SERVICE_ID,
      knex: makeStubKnex({
        sms_log: [
          inboundRow({ id: 'question', message_body: 'can we move friday?', created_at: new Date(NOW - 2 * DAY) }),
          inboundRow({ id: 'stop', message_type: 'opt_out', message_body: 'STOP', created_at: new Date(NOW - 1 * DAY) }),
        ],
      }),
    });
    expect(out.unansweredInbound).toBeNull();
  });

  test('Leg B: a standalone courtesy closer as the last message retires the thread', async () => {
    for (const body of ['Thanks!', 'thank you so much', 'Got it', 'ok', '10-4', 'sounds good']) {
      const out = await findOpenCommsExceptions({
        customerId: CUSTOMER_ID,
        serviceId: SERVICE_ID,
        knex: makeStubKnex({ sms_log: [inboundRow({ message_body: body })] }),
      });
      expect(out.unansweredInbound).toBeNull();
    }
    // A closer-prefixed but substantive message is still a waiting customer.
    const substantive = await findOpenCommsExceptions({
      customerId: CUSTOMER_ID,
      serviceId: SERVICE_ID,
      knex: makeStubKnex({ sms_log: [inboundRow({ message_body: 'thanks — but can we move friday?' })] }),
    });
    expect(substantive.unansweredInbound?.id).toBe('sms-in-1');
  });

  test('Leg B: thread identity is (peer, endpoint) — a reply on one thread does not answer another', async () => {
    // Customer texted TWO Waves numbers. Staff answered only the first.
    const out = await findOpenCommsExceptions({
      customerId: CUSTOMER_ID,
      serviceId: SERVICE_ID,
      knex: makeStubKnex({
        sms_log: [
          inboundRow({ id: 'thread-a', to_phone: WAVES_ENDPOINT, created_at: new Date(NOW - 3 * DAY) }),
          inboundRow({ id: 'thread-b', to_phone: WAVES_ENDPOINT_2, created_at: new Date(NOW - 2 * DAY) }),
          // Reply went out on thread A only.
          outboundRow({ from_phone: WAVES_ENDPOINT, created_at: new Date(NOW - 1 * DAY) }),
        ],
      }),
    });
    expect(out.unansweredInbound?.id).toBe('thread-b');
  });

  test('Leg B: a newer message on one thread does not hide an older unanswered thread', async () => {
    // Second handset, same customer: the newer (answered) thread must not
    // suppress the older thread nobody replied to.
    const out = await findOpenCommsExceptions({
      customerId: CUSTOMER_ID,
      serviceId: SERVICE_ID,
      knex: makeStubKnex({
        sms_log: [
          inboundRow({ id: 'old-unanswered', from_phone: CUST_PHONE_2, created_at: new Date(NOW - 4 * DAY) }),
          inboundRow({ id: 'new-answered', from_phone: CUST_PHONE, created_at: new Date(NOW - 2 * DAY) }),
          outboundRow({ to_phone: CUST_PHONE, created_at: new Date(NOW - 1 * DAY) }),
        ],
      }),
    });
    expect(out.unansweredInbound?.id).toBe('old-unanswered');
  });

  test('Leg B: a STOP retires every thread from that handset, but not the customer’s other handset', async () => {
    const out = await findOpenCommsExceptions({
      customerId: CUSTOMER_ID,
      serviceId: SERVICE_ID,
      knex: makeStubKnex({
        sms_log: [
          inboundRow({ id: 'opted-out-thread', from_phone: CUST_PHONE, created_at: new Date(NOW - 3 * DAY) }),
          inboundRow({
            id: 'stop', from_phone: CUST_PHONE, message_type: 'opt_out',
            message_body: 'STOP', created_at: new Date(NOW - 2 * DAY),
          }),
          inboundRow({ id: 'other-handset', from_phone: CUST_PHONE_2, created_at: new Date(NOW - 4 * DAY) }),
        ],
      }),
    });
    expect(out.unansweredInbound?.id).toBe('other-handset');
  });

  test('Leg A: resolution requires the reply to reach the number that RAISED the flag', async () => {
    const flag = pendingFlagRow({
      created_at: new Date(NOW - 3 * DAY),
      input_snapshot: JSON.stringify({ phone_tail: CUST_PHONE_2.slice(-10) }),
    });
    // Reply went to the account's PRIMARY phone, not the contact that texted.
    const wrongNumber = await findOpenCommsExceptions({
      customerId: CUSTOMER_ID,
      serviceId: SERVICE_ID,
      knex: makeStubKnex({
        agent_decisions: [flag],
        sms_log: [outboundRow({ to_phone: CUST_PHONE, created_at: new Date(NOW - 2 * DAY) })],
      }),
    });
    expect(wrongNumber.pendingFlag?.id).toBe('decision-1');

    // Reply to the flagging number resolves it.
    const rightNumber = await findOpenCommsExceptions({
      customerId: CUSTOMER_ID,
      serviceId: SERVICE_ID,
      knex: makeStubKnex({
        agent_decisions: [flag],
        sms_log: [outboundRow({ to_phone: CUST_PHONE_2, created_at: new Date(NOW - 2 * DAY) })],
      }),
    });
    expect(rightNumber.pendingFlag).toBeNull();

    // A proactive nudge to the right number is NOT resolution.
    const nudgeOnly = await findOpenCommsExceptions({
      customerId: CUSTOMER_ID,
      serviceId: SERVICE_ID,
      knex: makeStubKnex({
        agent_decisions: [flag],
        sms_log: [outboundRow({ to_phone: CUST_PHONE_2, created_at: new Date(NOW - 2 * DAY) })],
        message_drafts: [{
          id: 'draft-x', customer_id: CUSTOMER_ID, sms_log_id: null,
          sent_at: new Date(NOW - 2 * DAY),
        }],
      }),
    });
    expect(nudgeOnly.pendingFlag?.id).toBe('decision-1');

    // The AI STANDS DOWN on reschedule intent, so an AI message is NOT an
    // answer to a flag — the reschedule watcher's narrower set. (Leg B, the
    // general-thread leg, does count these; see the test below.)
    for (const type of ['ai_assistant', 'ai_assistant_reply', 'follow_up']) {
      const aiMessage = await findOpenCommsExceptions({
        customerId: CUSTOMER_ID,
        serviceId: SERVICE_ID,
        knex: makeStubKnex({
          agent_decisions: [flag],
          sms_log: [outboundRow({ to_phone: CUST_PHONE_2, message_type: type, created_at: new Date(NOW - 2 * DAY) })],
        }),
      });
      expect(aiMessage.pendingFlag?.id).toBe('decision-1');
    }
  });

  test('the two legs use DIFFERENT reply-type sets — an AI reply answers a thread but not a reschedule flag', async () => {
    for (const type of ['ai_assistant', 'ai_assistant_reply', 'follow_up']) {
      // Leg B: an AI-answered thread is answered.
      const thread = await findOpenCommsExceptions({
        customerId: CUSTOMER_ID,
        serviceId: SERVICE_ID,
        knex: makeStubKnex({ sms_log: [inboundRow(), outboundRow({ message_type: type })] }),
      });
      expect(thread.unansweredInbound).toBeNull();
    }
  });

  test('Leg A: a reschedule confirmation resolves ONLY a null-entity, non-ambiguous, customer-linked flag', async () => {
    const confirmation = outboundRow({
      to_phone: CUST_PHONE, message_type: 'appointment_rescheduled',
      created_at: new Date(NOW - 2 * DAY),
    });
    const base = { created_at: new Date(NOW - 3 * DAY), input_snapshot: JSON.stringify({}) };

    // Null-entity, non-ambiguous, customer-linked → resolved.
    const eligible = await findOpenCommsExceptions({
      customerId: CUSTOMER_ID,
      serviceId: SERVICE_ID,
      knex: makeStubKnex({
        agent_decisions: [pendingFlagRow({ ...base, entity_id: null })],
        sms_log: [confirmation],
      }),
    });
    expect(eligible.pendingFlag).toBeNull();

    // Visit-linked flag: the confirmed move may be a DIFFERENT visit.
    const entityLinked = await findOpenCommsExceptions({
      customerId: CUSTOMER_ID,
      serviceId: SERVICE_ID,
      knex: makeStubKnex({
        agent_decisions: [pendingFlagRow({ ...base, entity_id: SERVICE_ID })],
        sms_log: [confirmation],
      }),
    });
    expect(entityLinked.pendingFlag?.id).toBe('decision-1');

    // Ambiguous flag (several upcoming visits) stays pending.
    const ambiguous = await findOpenCommsExceptions({
      customerId: CUSTOMER_ID,
      serviceId: SERVICE_ID,
      knex: makeStubKnex({
        agent_decisions: [pendingFlagRow({
          ...base, entity_id: null, input_snapshot: JSON.stringify({ ambiguous: true }),
        })],
        sms_log: [confirmation],
      }),
    });
    expect(ambiguous.pendingFlag?.id).toBe('decision-1');
  });

  test('Leg A: a flag already worked (human reply after it was raised) does not raise a bell', async () => {
    // pending_review is only as fresh as the periodic resolution pass.
    const worked = await findOpenCommsExceptions({
      customerId: CUSTOMER_ID,
      serviceId: SERVICE_ID,
      knex: makeStubKnex({
        agent_decisions: [pendingFlagRow({ created_at: new Date(NOW - 3 * DAY) })],
        sms_log: [outboundRow({ created_at: new Date(NOW - 2 * DAY) })],
      }),
    });
    expect(worked.pendingFlag).toBeNull();

    // A reply BEFORE the flag was raised leaves it open.
    const stillOpen = await findOpenCommsExceptions({
      customerId: CUSTOMER_ID,
      serviceId: SERVICE_ID,
      knex: makeStubKnex({
        agent_decisions: [pendingFlagRow({ created_at: new Date(NOW - 1 * DAY) })],
        sms_log: [outboundRow({ created_at: new Date(NOW - 3 * DAY) })],
      }),
    });
    expect(stillOpen.pendingFlag?.id).toBe('decision-1');

    // A reply older than the 7-day inbound frame but inside the 14-day flag
    // window still resolves an old flag (the outbound scan spans the wider
    // window).
    const oldReply = await findOpenCommsExceptions({
      customerId: CUSTOMER_ID,
      serviceId: SERVICE_ID,
      knex: makeStubKnex({
        agent_decisions: [pendingFlagRow({ created_at: new Date(NOW - 12 * DAY) })],
        sms_log: [outboundRow({ created_at: new Date(NOW - 10 * DAY) })],
      }),
    });
    expect(oldReply.pendingFlag).toBeNull();
  });

  test('Leg B: inbound older than 7 days is out of window; other customers’ rows never match', async () => {
    const out = await findOpenCommsExceptions({
      customerId: CUSTOMER_ID,
      serviceId: SERVICE_ID,
      knex: makeStubKnex({
        sms_log: [
          inboundRow({ id: 'old', created_at: new Date(NOW - 8 * DAY) }),
          inboundRow({ id: 'foreign', customer_id: '00000000-0000-4000-8000-0000000000c2' }),
        ],
      }),
    });
    expect(out.unansweredInbound).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// runCompletionCommsGuard — gate, writes, dedupe, fail-soft
// ---------------------------------------------------------------------------
describe('runCompletionCommsGuard', () => {
  test('pending flag: notification + dispatch alert written exactly once; dedupe holds on double-complete', async () => {
    const { runCompletionCommsGuard } = loadGuard({ gateOn: true });
    const knex = makeStubKnex({ agent_decisions: [pendingFlagRow()] });

    const first = await runCompletionCommsGuard({ serviceId: SERVICE_ID, customerId: CUSTOMER_ID, knex });
    expect(first).toEqual({ flagged: true, reason: 'flagged' });

    const notifs = knex._data.notifications;
    expect(notifs).toHaveLength(1);
    expect(notifs[0].recipient_type).toBe('admin');
    expect(notifs[0].category).toBe('schedule');
    expect(notifs[0].title).toBe('Visit completed with an unanswered customer message');
    expect(notifs[0].link).toBe(`/admin/communications?thread=${CUSTOMER_ID}`);
    const meta = JSON.parse(notifs[0].metadata);
    expect(meta).toMatchObject({
      scheduledServiceId: SERVICE_ID,
      customerId: CUSTOMER_ID,
      decisionId: 'decision-1',
      dedupeKey: `completion-comms:${SERVICE_ID}`,
    });

    const alerts = knex._data.dispatch_alerts;
    expect(alerts).toHaveLength(1);
    expect(alerts[0].type).toBe('completed_with_open_comms');
    expect(alerts[0].severity).toBe('warn');
    expect(alerts[0].job_id).toBe(SERVICE_ID);
    expect(JSON.parse(alerts[0].payload)).toMatchObject({
      customerId: CUSTOMER_ID,
      decisionId: 'decision-1',
      pendingFlag: true,
      unansweredInbound: false,
    });

    // Advisory-lock dedupe key taken before the check-then-insert.
    expect(knex._rawCalls.some((c) => /pg_advisory_xact_lock/.test(c.sql)
      && c.bindings[0] === `completion-comms:${SERVICE_ID}`)).toBe(true);

    // Double-complete: same visit re-runs the guard — no second bell/card.
    const second = await runCompletionCommsGuard({ serviceId: SERVICE_ID, customerId: CUSTOMER_ID, knex });
    expect(second).toEqual({ flagged: false, reason: 'deduped' });
    expect(knex._data.notifications).toHaveLength(1);
    expect(knex._data.dispatch_alerts).toHaveLength(1);
  });

  test('unanswered inbound alone also flags (decisionId null)', async () => {
    const { runCompletionCommsGuard } = loadGuard({ gateOn: true });
    const knex = makeStubKnex({ sms_log: [inboundRow()] });
    const out = await runCompletionCommsGuard({ serviceId: SERVICE_ID, customerId: CUSTOMER_ID, knex });
    expect(out.flagged).toBe(true);
    const meta = JSON.parse(knex._data.notifications[0].metadata);
    expect(meta.decisionId).toBeNull();
    expect(JSON.parse(knex._data.dispatch_alerts[0].payload)).toMatchObject({
      pendingFlag: false,
      unansweredInbound: true,
    });
  });

  test('no flag / answered thread: zero writes', async () => {
    const { runCompletionCommsGuard } = loadGuard({ gateOn: true });
    const knex = makeStubKnex({ sms_log: [inboundRow(), outboundRow()] });
    const out = await runCompletionCommsGuard({ serviceId: SERVICE_ID, customerId: CUSTOMER_ID, knex });
    expect(out).toEqual({ flagged: false, reason: 'no_open_comms' });
    expect(knex._data.notifications || []).toHaveLength(0);
    expect(knex._data.dispatch_alerts || []).toHaveLength(0);
  });

  test('gate off: zero reads, zero writes', async () => {
    const { runCompletionCommsGuard } = loadGuard({ gateOn: false });
    const knex = makeStubKnex({ agent_decisions: [pendingFlagRow()], sms_log: [inboundRow()] });
    const out = await runCompletionCommsGuard({ serviceId: SERVICE_ID, customerId: CUSTOMER_ID, knex });
    expect(out).toEqual({ flagged: false, reason: 'gate_off' });
    expect(knex._tableCalls).toHaveLength(0);
    expect(knex._data.notifications || []).toHaveLength(0);
    expect(knex._data.dispatch_alerts || []).toHaveLength(0);
  });

  test('guard throw is swallowed — the caller (a committed completion) never sees it', async () => {
    const { runCompletionCommsGuard } = loadGuard({ gateOn: true });
    const knex = makeStubKnex({ agent_decisions: [pendingFlagRow()] });
    knex.transaction = async () => { throw new Error('synthetic transaction failure'); };
    await expect(runCompletionCommsGuard({ serviceId: SERVICE_ID, customerId: CUSTOMER_ID, knex }))
      .resolves.toEqual({ flagged: false, reason: 'error' });

    const readThrow = (table) => { throw new Error(`synthetic read failure on ${table}`); };
    await expect(runCompletionCommsGuard({ serviceId: SERVICE_ID, customerId: CUSTOMER_ID, knex: Object.assign(readThrow, { transaction: async () => {} }) }))
      .resolves.toEqual({ flagged: false, reason: 'error' });
  });
});

// ---------------------------------------------------------------------------
// Source contracts — the /complete wiring and the gate registration
// (house style: the giant route is pinned by source, behavior is tested
// above through the service the route delegates to).
// ---------------------------------------------------------------------------
describe('wiring source contracts', () => {
  const dispatchSource = fs.readFileSync(path.join(__dirname, '../routes/admin-dispatch.js'), 'utf8');
  const gatesSource = fs.readFileSync(path.join(__dirname, '../config/feature-gates.js'), 'utf8');

  test('BOTH /complete success exits invoke the guard — the incomplete-visit early return included', () => {
    // The isIncompleteVisit branch returns early and still leaves the
    // scheduled_services row 'completed' (the recurring-series hook is
    // duplicated there for the same reason). A single call site below it
    // would silently skip every incomplete completion.
    const callSites = dispatchSource.split("require('../services/completion-comms-guard')").length - 1;
    expect(callSites).toBe(2);
    // Both sites honor the route's quiet-closeout posture: a backdated
    // cleanup must not ring a live bell about a months-old visit.
    const backfillGuards = dispatchSource.split(
      "if (!isBackfillCompletion) {\n      try {\n        const { runCompletionCommsGuard }",
    ).length - 1
      + dispatchSource.split(
        "if (!isBackfillCompletion) {\n        try {\n          const { runCompletionCommsGuard }",
      ).length - 1;
    expect(backfillGuards).toBe(2);
    const incompleteBranch = dispatchSource.indexOf('if (isIncompleteVisit) {');
    expect(incompleteBranch).toBeGreaterThan(-1);
    const earlyReturn = dispatchSource.indexOf('return res.json(responsePayload);', incompleteBranch);
    const guardInBranch = dispatchSource.indexOf("require('../services/completion-comms-guard')", incompleteBranch);
    expect(guardInBranch).toBeGreaterThan(incompleteBranch);
    expect(guardInBranch).toBeLessThan(earlyReturn);
  });

  test('/complete invokes the guard POST-COMMIT, fail-soft, before the response payload', () => {
    const call = dispatchSource.lastIndexOf("require('../services/completion-comms-guard')");
    expect(call).toBeGreaterThan(-1);
    // After the durable-completion machinery and the dues-covered exemplar…
    expect(call).toBeGreaterThan(dispatchSource.indexOf('dues_covered_priced_series'));
    // …and before the /complete response payload is assembled/sent (the
    // handler's payload block is the next one after the call site).
    const respIdx = dispatchSource.indexOf('const responsePayload = {', call);
    expect(respIdx).toBeGreaterThan(call);
    expect(dispatchSource.indexOf('res.json(responsePayload)', respIdx)).toBeGreaterThan(respIdx);
    // Fail-soft: the call sits in its own try/catch that only warns.
    const block = dispatchSource.slice(call - 600, call + 600);
    expect(block).toMatch(/try\s*\{/);
    expect(block).toMatch(/runCompletionCommsGuard\(\{ serviceId: svc\.id, customerId: svc\.customer_id \}\)/);
    expect(block).toMatch(/catch \(commsGuardErr\)/);
    expect(block).toMatch(/logger\.warn/);
    // The guard must never touch the completion/invoice decision: no
    // res.status / return / throw inside its catch.
    const catchBody = block.slice(block.indexOf('catch (commsGuardErr)'));
    expect(catchBody).not.toMatch(/res\.status|throw/);
  });

  test('GATE_COMPLETION_COMMS_GUARD is registered opt-in (===\'true\') in every environment', () => {
    expect(gatesSource).toMatch(/completionCommsGuard: process\.env\.GATE_COMPLETION_COMMS_GUARD === 'true',/);
    // payerStatements pattern: no isProd ternary — dark in dev AND prod.
    expect(gatesSource).not.toMatch(/isProd \? process\.env\.GATE_COMPLETION_COMMS_GUARD/);
    // Doc-block line present.
    expect(gatesSource).toMatch(/GATE_COMPLETION_COMMS_GUARD=true/);
  });
});
