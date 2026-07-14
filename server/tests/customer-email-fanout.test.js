// The email fan-out rewrites lead/estimate/newsletter EMAIL snapshots after a
// customer email edit — only rows still carrying the customer's OLD email,
// only non-terminal rows, never on an email removal — and resolves the open
// email read-back cards the edit answers (keeping call_log.review_status in
// sync). Origin: the 2026-07-13 charlesw.robb@ correction took four
// hand-written UPDATEs; this service makes the record edit do all of it.

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { propagateCustomerEmailChange, emailKey } = require('../services/customer-email-fanout');

/**
 * Minimal knex-shaped stub. Per-table config:
 *   rows        — what an awaited select() resolves
 *   firstQueue  — successive first() results (non-count)
 *   countQueue  — successive count().first() results ({ n })
 *   updateCount — what update() resolves (default 1)
 * Builders are thenable so they work both awaited (select) and embedded
 * (the call_log subquery inside whereIn). Every mutation is recorded in
 * conn.__calls as { table, op, arg }.
 */
function makeConn(cfg = {}) {
  const calls = [];
  const conn = (table) => {
    const t = cfg[table] || {};
    let counting = false;
    const qb = {
      where: (arg) => { calls.push({ table, op: 'where', arg }); return qb; },
      whereRaw: (sql, bindings) => { calls.push({ table, op: 'whereRaw', arg: { sql, bindings } }); return qb; },
      whereNull: () => qb,
      whereIn: (col, vals) => { calls.push({ table, op: 'whereIn', arg: { col, vals } }); return qb; },
      select: () => qb,
      count: () => { counting = true; return qb; },
      first: () => Promise.resolve(counting
        ? ((t.countQueue || []).shift() ?? { n: 0 })
        : ((t.firstQueue || []).shift() ?? null)),
      update: (patch) => { calls.push({ table, op: 'update', arg: patch }); return Promise.resolve(t.updateCount ?? 1); },
      del: () => { calls.push({ table, op: 'del' }); return Promise.resolve(1); },
      then: (resolve, reject) => Promise.resolve(t.rows || []).then(resolve, reject),
    };
    return qb;
  };
  conn.__calls = calls;
  conn.__updates = (table) => calls.filter((c) => c.table === table && c.op === 'update');
  return conn;
}

const BEFORE = { id: 'cust-1', email: 'charlesw.robb@gmail.com' };
const AFTER = { id: 'cust-1', email: 'charleswrobb@gmail.com' };

describe('propagateCustomerEmailChange', () => {
  test('syncs lead, estimate, and newsletter copies and resolves the email review card', async () => {
    const conn = makeConn({
      newsletter_subscribers: { firstQueue: [{ id: 739, email: 'charlesw.robb@gmail.com' }, null] },
      triage_items: { rows: [{ id: 'ti-1', call_log_id: 'call-1' }], countQueue: [{ n: 0 }] },
    });
    const counts = await propagateCustomerEmailChange({ before: BEFORE, after: AFTER }, conn);
    expect(counts).toEqual({ leads: 1, estimates: 1, newsletter: 1, reviewCards: 1 });

    expect(conn.__updates('leads')[0].arg.email).toBe('charleswrobb@gmail.com');
    expect(conn.__updates('estimates')[0].arg.customer_email).toBe('charleswrobb@gmail.com');
    expect(conn.__updates('newsletter_subscribers')[0].arg.email).toBe('charleswrobb@gmail.com');

    const cardUpdate = conn.__updates('triage_items')[0].arg;
    expect(cardUpdate.status).toBe('resolved');
    expect(cardUpdate.resolution_note).toContain('Email corrected');

    // No other cards remain open on the call → review_status resolves.
    const callSync = conn.__updates('call_log')[0].arg;
    expect(callSync.review_status).toBe('resolved');
  });

  test('matches copies by the OLD email only', async () => {
    const conn = makeConn();
    await propagateCustomerEmailChange({ before: BEFORE, after: AFTER }, conn);
    const leadFilter = conn.__calls.find((c) => c.table === 'leads' && c.op === 'whereRaw');
    expect(leadFilter.arg.bindings).toEqual(['charlesw.robb@gmail.com']);
    const estFilter = conn.__calls.find((c) => c.table === 'estimates' && c.op === 'whereRaw');
    expect(estFilter.arg.bindings).toEqual(['charlesw.robb@gmail.com']);
  });

  test('no-ops when the email did not actually change (case-insensitive)', async () => {
    const conn = makeConn();
    const counts = await propagateCustomerEmailChange({
      before: { id: 'cust-1', email: 'Charleswrobb@Gmail.com' },
      after: AFTER,
    }, conn);
    expect(counts).toEqual({ leads: 0, estimates: 0, newsletter: 0, reviewCards: 0 });
    expect(conn.__calls).toHaveLength(0);
  });

  test('an email removal is never propagated', async () => {
    const conn = makeConn();
    const counts = await propagateCustomerEmailChange({
      before: BEFORE,
      after: { id: 'cust-1', email: null },
    }, conn);
    expect(counts).toEqual({ leads: 0, estimates: 0, newsletter: 0, reviewCards: 0 });
    expect(conn.__calls).toHaveLength(0);
  });

  test('newsletter: deletes the misspelled row when the corrected spelling already subscribes', async () => {
    const conn = makeConn({
      newsletter_subscribers: {
        firstQueue: [
          { id: 739, email: 'charlesw.robb@gmail.com' }, // old row
          { id: 900, email: 'charleswrobb@gmail.com' },  // target already exists
        ],
      },
    });
    const counts = await propagateCustomerEmailChange({ before: BEFORE, after: AFTER }, conn);
    expect(counts.newsletter).toBe(1);
    expect(conn.__calls.some((c) => c.table === 'newsletter_subscribers' && c.op === 'del')).toBe(true);
    expect(conn.__updates('newsletter_subscribers')).toHaveLength(0);
  });

  test('filling a previously EMPTY email skips snapshots but still resolves review cards', async () => {
    const conn = makeConn({
      triage_items: { rows: [{ id: 'ti-1', call_log_id: 'call-1' }], countQueue: [{ n: 0 }] },
    });
    const counts = await propagateCustomerEmailChange({
      before: { id: 'cust-1', email: null },
      after: AFTER,
    }, conn);
    expect(counts.leads).toBe(0);
    expect(counts.estimates).toBe(0);
    expect(counts.newsletter).toBe(0);
    expect(counts.reviewCards).toBe(1);
    expect(conn.__updates('leads')).toHaveLength(0);
  });

  test('call_log.review_status stays open while OTHER cards remain on the call', async () => {
    const conn = makeConn({
      triage_items: { rows: [{ id: 'ti-1', call_log_id: 'call-1' }], countQueue: [{ n: 2 }] },
    });
    await propagateCustomerEmailChange({ before: BEFORE, after: AFTER }, conn);
    expect(conn.__updates('call_log')[0].arg.review_status).toBe('open');
  });

  test('only email review reason codes are resolved', async () => {
    const conn = makeConn({
      triage_items: { rows: [{ id: 'ti-1', call_log_id: 'call-1' }], countQueue: [{ n: 0 }] },
    });
    await propagateCustomerEmailChange({ before: BEFORE, after: AFTER }, conn);
    const reasonFilter = conn.__calls.find((c) => c.table === 'triage_items' && c.op === 'whereIn' && c.arg.col === 'reason_code');
    expect(reasonFilter.arg.vals).toEqual(['email_unverified', 'email_invalid']);
  });
});

describe('emailKey', () => {
  test('trims, lowercases, and rejects non-addresses', () => {
    expect(emailKey('  A@B.com ')).toBe('a@b.com');
    expect(emailKey('not-an-email')).toBe('');
    expect(emailKey(null)).toBe('');
  });
});
