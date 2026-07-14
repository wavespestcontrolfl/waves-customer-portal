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
  conn.raw = (sql) => ({ __raw: sql });
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
    expect(counts).toEqual({ leads: 1, estimates: 2, newsletter: 1, automations: 1, templateRuns: 1, promoters: 1, billingPrefs: 1, reviewCards: 1 });

    expect(conn.__updates('leads')[0].arg.email).toBe('charleswrobb@gmail.com');
    expect(conn.__updates('estimates')[0].arg.customer_email).toBe('charleswrobb@gmail.com');
    // The stale "PDF emailed" marker (stamped for the OLD address) drops with the sync.
    expect(conn.__updates('estimates')[0].arg.estimate_data.__raw).toContain("- 'proposalDelivery'");
    // In-flight ('sending') rows get a COLUMN-ONLY sync — never an
    // estimate_data write under an active send claim.
    const sendingSync = conn.__updates('estimates')[1].arg;
    expect(sendingSync.customer_email).toBe('charleswrobb@gmail.com');
    expect(sendingSync.estimate_data).toBeUndefined();
    expect(conn.__calls.some((c) => c.table === 'estimates' && c.op === 'where'
      && c.arg && c.arg.status === 'sending')).toBe(true);
    expect(conn.__updates('automation_enrollments')[0].arg.email).toBe('charleswrobb@gmail.com');
    expect(conn.__updates('email_template_automation_runs')[0].arg.recipient_email).toBe('charleswrobb@gmail.com');
    expect(conn.__updates('referral_promoters')[0].arg.customer_email).toBe('charleswrobb@gmail.com');
    expect(conn.__updates('notification_prefs')[0].arg.billing_email).toBe('charleswrobb@gmail.com');
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
    expect(counts).toEqual({ leads: 0, estimates: 0, newsletter: 0, automations: 0, templateRuns: 0, promoters: 0, billingPrefs: 0, reviewCards: 0 });
    expect(conn.__calls).toHaveLength(0);
  });

  test('an email removal is never propagated', async () => {
    const conn = makeConn();
    const counts = await propagateCustomerEmailChange({
      before: BEFORE,
      after: { id: 'cust-1', email: null },
    }, conn);
    expect(counts).toEqual({ leads: 0, estimates: 0, newsletter: 0, automations: 0, templateRuns: 0, promoters: 0, billingPrefs: 0, reviewCards: 0 });
    expect(conn.__calls).toHaveLength(0);
  });

  test('newsletter: deletes the misspelled row when the corrected spelling already subscribes', async () => {
    const conn = makeConn({
      newsletter_subscribers: {
        firstQueue: [
          { id: 739, email: 'charlesw.robb@gmail.com', customer_id: 'cust-1' },   // old row
          { id: 900, email: 'charleswrobb@gmail.com', customer_id: 'cust-other' }, // target, already linked elsewhere
        ],
      },
    });
    const counts = await propagateCustomerEmailChange({ before: BEFORE, after: AFTER }, conn);
    expect(counts.newsletter).toBe(1);
    expect(conn.__calls.some((c) => c.table === 'newsletter_subscribers' && c.op === 'del')).toBe(true);
    // A row linked to ANOTHER customer is never re-linked.
    expect(conn.__updates('newsletter_subscribers')).toHaveLength(0);
  });

  test('newsletter: an UNLINKED row on the corrected spelling is adopted before the misspelled row is deleted', async () => {
    // Public signup with the correct spelling while customers.email held the
    // typo → linkToCustomer never matched it. Deleting the misspelled row
    // must not sever the customer's only linked subscription.
    const conn = makeConn({
      newsletter_subscribers: {
        firstQueue: [
          { id: 739, email: 'charlesw.robb@gmail.com', customer_id: 'cust-1' }, // old row
          { id: 900, email: 'charleswrobb@gmail.com', customer_id: null },      // unlinked target
        ],
      },
    });
    await propagateCustomerEmailChange({ before: BEFORE, after: AFTER }, conn);
    const adoption = conn.__updates('newsletter_subscribers')[0].arg;
    expect(adoption.customer_id).toBe('cust-1');
    expect(conn.__calls.some((c) => c.table === 'newsletter_subscribers' && c.op === 'del')).toBe(true);
  });

  test('queued template-automation runs sync only in pre-send/running states', async () => {
    const conn = makeConn();
    await propagateCustomerEmailChange({ before: BEFORE, after: AFTER }, conn);
    const statusFilter = conn.__calls.find((c) => c.table === 'email_template_automation_runs' && c.op === 'whereIn' && c.arg.col === 'status');
    expect(statusFilter.arg.vals).toEqual(['queued', 'scheduled', 'retry_scheduled', 'running']);
  });

  test('enrollment sync includes customer_id-NULL rows via the old-email guard', async () => {
    // Estimate follow-ups enroll with customer_id null; the where-callback
    // (customer match OR null) plus the old-email whereRaw scopes them.
    const conn = makeConn();
    await propagateCustomerEmailChange({ before: BEFORE, after: AFTER }, conn);
    const enrollmentEmailGuard = conn.__calls.find(
      (c) => c.table === 'automation_enrollments' && c.op === 'whereRaw');
    expect(enrollmentEmailGuard.arg.bindings).toEqual(['charlesw.robb@gmail.com']);
  });

  test('an INVALID replacement email never fans out or resolves cards', async () => {
    const conn = makeConn({
      triage_items: { rows: [{ id: 'ti-1', call_log_id: 'call-1' }], countQueue: [{ n: 0 }] },
    });
    const counts = await propagateCustomerEmailChange({
      before: BEFORE,
      after: { id: 'cust-1', email: 'foo@bar' },
    }, conn);
    expect(counts).toEqual({ leads: 0, estimates: 0, newsletter: 0, automations: 0, templateRuns: 0, promoters: 0, billingPrefs: 0, reviewCards: 0 });
    expect(conn.__calls).toHaveLength(0);
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
