// The email fan-out rewrites lead/estimate/newsletter EMAIL snapshots after a
// customer email edit — only rows still carrying the customer's OLD email,
// only non-terminal rows, never on an email removal — and resolves the open
// email read-back cards the edit answers (keeping call_log.review_status in
// sync). Origin: the 2026-07-13 charlesw.robb@ correction took four
// hand-written UPDATEs; this service makes the record edit do all of it.

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/newsletter-confirm', () => ({ sendConfirmationEmail: jest.fn().mockResolvedValue(true) }));

const mockResume = jest.fn();
const mockRepenMerged = jest.fn();
const mockDnc = jest.fn();
const mockSuppressed = jest.fn();
const mockSendFailedMarker = jest.fn();
const mockRenewClaim = jest.fn();
jest.mock('../services/lead-first-touch-resume', () => ({
  resumeHeldFirstTouch: (...a) => mockResume(...a),
  repenIfWorkMergedDuringClaim: (...a) => mockRepenMerged(...a),
  customerCallDoNotContact: (...a) => mockDnc(...a),
  emailSuppressedForNewLead: (...a) => mockSuppressed(...a),
  sendFailedMarkerFor: (...a) => mockSendFailedMarker(...a),
  renewClaim: (...a) => mockRenewClaim(...a),
  // Same contract as the real helper: with a stamp the write is fenced on
  // the claim's status+updated_at; without one it passes through.
  fencedHoldWrite: (qb, claimStamp) => {
    if (claimStamp) qb.where({ status: 'releasing', updated_at: new Date(claimStamp) });
    return qb;
  },
  // Same contract as the real r34/r35 pre-send gate: one fenced CAS that
  // refuses denials, consumes markers, extends the lease, and binds to
  // the captured target. The stub conn's consume knobs
  // (consumeError/consumeCounts) drive its outcome.
  gateHoldForSend: async (holdId, claimStamp, dbh, targetEmailLc = null) => {
    const qb = dbh('first_touch_holds').where({ id: holdId });
    if (claimStamp) qb.where({ status: 'releasing', updated_at: new Date(claimStamp) });
    if (targetEmailLc != null) qb.whereRaw("LOWER(COALESCE(held_email, '')) = ?", [targetEmailLc]);
    const stamp = new Date();
    const gated = await qb.update({ last_error: null, updated_at: stamp });
    return gated > 0 ? stamp : null;
  },
}));
beforeEach(() => {
  mockResume.mockReset().mockResolvedValue({ resumed: false, enrolled: false, newsletterResume: null });
  mockRepenMerged.mockReset().mockResolvedValue(undefined);
  mockDnc.mockReset().mockResolvedValue(false);
  mockSuppressed.mockReset().mockResolvedValue(false);
  mockSendFailedMarker.mockReset().mockResolvedValue('newsletter_doi_not_confirmed');
  mockRenewClaim.mockReset().mockImplementation(async () => new Date());
});

const { propagateCustomerEmailChange, resendPendingConfirmation, emailKey } = require('../services/customer-email-fanout');

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
    let denyProbe = false;
    const qb = {
      where: (arg) => {
        calls.push({ table, op: 'where', arg });
        if (arg && arg.last_error === 'email_denied_await_correction') denyProbe = true;
        // Grouped-where callbacks (knex style) run against the builder so
        // their inner clauses are recorded too (r31 prior-target sweep) —
        // both `this`-bound and parameter styles.
        if (typeof arg === 'function') arg.call(qb, qb);
        return qb;
      },
      whereRaw: (sql, bindings) => { calls.push({ table, op: 'whereRaw', arg: { sql, bindings } }); return qb; },
      orWhereRaw: (sql, bindings) => { calls.push({ table, op: 'orWhereRaw', arg: { sql, bindings } }); return qb; },
      orWhereNot: () => qb,
      orWhereNotIn: () => qb,
      whereNull: () => qb,
      whereIn: (col, vals) => { calls.push({ table, op: 'whereIn', arg: { col, vals } }); return qb; },
      whereNotIn: (col, vals) => { calls.push({ table, op: 'whereNotIn', arg: { col, vals } }); return qb; },
      forUpdate: () => { calls.push({ table, op: 'forUpdate' }); return qb; },
      select: () => qb,
      count: () => { counting = true; return qb; },
      first: () => Promise.resolve(counting
        ? ((t.countQueue || []).shift() ?? { n: 0 })
        : denyProbe
          ? (t.denyRow ?? null)
          : ((t.firstQueue || []).shift() ?? null)),
      update: (patch) => {
        calls.push({ table, op: 'update', arg: patch });
        // The r34 pre-send gate ({last_error: null, updated_at}) — and
        // the older bare consume shape — get their own knobs so
        // `updateError` can keep modeling post-send settle failures
        // without aborting the send. consumeCounts (r33) models per-gate
        // row counts: a zero means the fenced CAS missed (deny/reclaim
        // bumped the row).
        const patchKeys = Object.keys(patch || {});
        const isConsume = patch && patch.last_error === null
          && (patchKeys.length === 1 || (patchKeys.length === 2 && patch.updated_at !== undefined));
        if (isConsume) {
          if (t.consumeError) return Promise.reject(t.consumeError);
          if (Array.isArray(t.consumeCounts)) return Promise.resolve(t.consumeCounts.shift() ?? 1);
          return Promise.resolve(t.updateCount ?? 1);
        }
        // clearError (r35): fail only the pre-stamp LIFT ({confirmation_sent_at: null})
        if (patch && patch.confirmation_sent_at === null && t.clearError) return Promise.reject(t.clearError);
        if (t.updateError) return Promise.reject(t.updateError);
        return Promise.resolve(t.updateCount ?? 1);
      },
      del: () => { calls.push({ table, op: 'del' }); return Promise.resolve(1); },
      insert: (arg) => { calls.push({ table, op: 'insert', arg }); return qb; },
      onConflict: () => qb,
      ignore: () => Promise.resolve(1),
      merge: (arg) => { calls.push({ table, op: 'merge', arg }); return Promise.resolve(1); },
      distinct: () => qb,
      then: (resolve, reject) => Promise.resolve(
        (t.rowsQueue && t.rowsQueue.length) ? t.rowsQueue.shift() : (t.rows || [])
      ).then(resolve, reject),
    };
    return qb;
  };
  conn.raw = (sql) => ({ __raw: sql });
  conn.schema = { hasTable: async () => true };
  // Savepoint-style passthrough (the r33 all-or-nothing marker consume);
  // the counter lets tests pin that grouped clears share ONE transaction.
  let trxCount = 0;
  conn.transaction = async (fn) => { trxCount += 1; return fn(conn); };
  conn.__trxCount = () => trxCount;
  conn.__calls = calls;
  conn.__updates = (table) => calls.filter((c) => c.table === table && c.op === 'update');
  return conn;
}

const BEFORE = { id: 'cust-1', email: 'charlesw.robb@gmail.com' };
const AFTER = { id: 'cust-1', email: 'charleswrobb@gmail.com' };

// Synthetic pair for the 2026-07-30 hold-lane tests — the production-derived
// address above must not grow new occurrences (AGENTS.md PII rule).
const HOLD_BEFORE = { id: 'cust-1', email: 'sam.typo@example.com' };
const HOLD_AFTER = { id: 'cust-1', email: 'samtypo@example.com' };

describe('propagateCustomerEmailChange', () => {
  test('syncs lead, estimate, and newsletter copies and resolves the email review card', async () => {
    const conn = makeConn({
      newsletter_subscribers: { firstQueue: [{ id: 739, email: 'charlesw.robb@gmail.com' }, null] },
      email_template_automation_runs: {
        rows: [{ id: 'run-1', payload: { customer_email: 'charlesw.robb@gmail.com', first_name: 'Charles' } }],
      },
      triage_items: { rows: [{ id: 'ti-1', call_log_id: 'call-1' }], countQueue: [{ n: 0 }] },
    });
    const counts = await propagateCustomerEmailChange({ before: BEFORE, after: AFTER }, conn);
    // automations: 2 — the enrollment sweep runs twice (before AND after the
    // hold retargets, Codex #3084 r26); the stub counts each idempotent pass.
    expect(counts).toEqual({ leads: 1, estimates: 2, newsletter: 1, newsletterDeliveries: 1, automations: 2, templateRuns: 1, promoters: 1, billingPrefs: 1, contracts: 1, bookingIntents: 1, reviewCards: 1, heldDripResumed: 0 });

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
    const runSync = conn.__updates('email_template_automation_runs')[0].arg;
    expect(runSync.recipient_email).toBe('charleswrobb@gmail.com');
    // Payload template variables carrying the old email are rewritten too —
    // the executor renders the body from the stored payload.
    expect(JSON.parse(runSync.payload)).toEqual({ customer_email: 'charleswrobb@gmail.com', first_name: 'Charles' });
    expect(conn.__updates('referral_promoters')[0].arg.customer_email).toBe('charleswrobb@gmail.com');
    expect(conn.__updates('notification_prefs')[0].arg.billing_email).toBe('charleswrobb@gmail.com');
    expect(conn.__updates('customer_contracts')[0].arg.recipient_email).toBe('charleswrobb@gmail.com');
    expect(conn.__updates('booking_intents')[0].arg.email).toBe('charleswrobb@gmail.com');
    expect(conn.__updates('newsletter_subscribers')[0].arg.email).toBe('charleswrobb@gmail.com');

    const cardUpdate = conn.__updates('triage_items')[0].arg;
    expect(cardUpdate.status).toBe('resolved');
    expect(cardUpdate.resolution_note).toContain('Email corrected');

    // Lock-order discipline (Codex #3084 r30): the hold-row FOR UPDATE
    // locks are taken BEFORE any automation_enrollments write, matching
    // the release engine's first_touch_holds → enrollments order — no
    // deadlock cycle between a correction and an in-flight release.
    const lockIdx = conn.__calls.findIndex((c) => c.table === 'first_touch_holds' && c.op === 'forUpdate');
    const enrollIdx = conn.__calls.findIndex((c) => c.table === 'automation_enrollments' && c.op === 'update');
    expect(lockIdx).toBeGreaterThanOrEqual(0);
    expect(lockIdx).toBeLessThan(enrollIdx);

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
    expect(counts).toEqual({ leads: 0, estimates: 0, newsletter: 0, newsletterDeliveries: 0, automations: 0, templateRuns: 0, promoters: 0, billingPrefs: 0, contracts: 0, bookingIntents: 0, reviewCards: 0, heldDripResumed: 0 });
    expect(conn.__calls).toHaveLength(0);
  });

  test('an email removal is never propagated', async () => {
    const conn = makeConn();
    const counts = await propagateCustomerEmailChange({
      before: BEFORE,
      after: { id: 'cust-1', email: null },
    }, conn);
    expect(counts).toEqual({ leads: 0, estimates: 0, newsletter: 0, newsletterDeliveries: 0, automations: 0, templateRuns: 0, promoters: 0, billingPrefs: 0, contracts: 0, bookingIntents: 0, reviewCards: 0, heldDripResumed: 0 });
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
    // Delivered engagement tokens rotate BEFORE the del() — the delete sets
    // subscriber_id NULL, after which the rows would be unreachable by id.
    const rotation = conn.__updates('newsletter_send_deliveries')[0];
    expect(rotation.arg.engagement_token.__raw).toContain('gen_random_uuid()');
    const rotationIdx = conn.__calls.findIndex((c) => c.table === 'newsletter_send_deliveries' && c.op === 'update');
    const delIdx = conn.__calls.findIndex((c) => c.table === 'newsletter_subscribers' && c.op === 'del');
    expect(rotationIdx).toBeGreaterThan(-1);
    expect(rotationIdx).toBeLessThan(delIdx);
    const rotationScope = conn.__calls.find((c) => c.table === 'newsletter_send_deliveries' && c.op === 'where');
    expect(rotationScope.arg).toEqual({ subscriber_id: 739 });
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

  test('queued template-automation runs sync only in not-yet-claimed states', async () => {
    const conn = makeConn();
    await propagateCustomerEmailChange({ before: BEFORE, after: AFTER }, conn);
    const statusFilter = conn.__calls.find((c) => c.table === 'email_template_automation_runs' && c.op === 'whereIn' && c.arg.col === 'status');
    expect(statusFilter.arg.vals).toEqual(['queued', 'scheduled', 'retry_scheduled']);
  });

  test('enrollment and run syncs require the customer link — never email-only matching', async () => {
    // Email equality alone can't prove ownership: the typo can be a real
    // third party's address, and retargeting their sends is a P0.
    const conn = makeConn();
    await propagateCustomerEmailChange({ before: BEFORE, after: AFTER }, conn);
    const enrollmentScope = conn.__calls.find(
      (c) => c.table === 'automation_enrollments' && c.op === 'where' && c.arg && c.arg.customer_id);
    expect(enrollmentScope.arg).toEqual({ customer_id: 'cust-1', status: 'active' });
    const runScope = conn.__calls.find(
      (c) => c.table === 'email_template_automation_runs' && c.op === 'where' && c.arg && c.arg.recipient_id);
    expect(runScope.arg).toEqual({ recipient_id: 'cust-1' });
  });

  test('a moved PENDING subscriber row surfaces pendingConfirmation for the post-commit re-send', async () => {
    // The DOI confirmation went to the old typo; campaigns only send to
    // status='active' — without a re-send the customer is stuck pending.
    const conn = makeConn({
      newsletter_subscribers: {
        firstQueue: [
          { id: 739, email: 'charlesw.robb@gmail.com', customer_id: 'cust-1', status: 'pending', confirmation_token: 'tok-1', first_name: 'Charles' },
          null, // no row on the corrected spelling
        ],
      },
    });
    const result = await propagateCustomerEmailChange({ before: BEFORE, after: AFTER }, conn);
    expect(result.pendingConfirmation).toMatchObject({
      id: 739, email: 'charleswrobb@gmail.com', first_name: 'Charles',
    });
    // The OLD token was delivered to the typo mailbox — the re-send must use
    // a FRESH one, and the row rotates BOTH bearer tokens with the move.
    expect(result.pendingConfirmation.confirmation_token).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.pendingConfirmation.confirmation_token).not.toBe('tok-1');
    const moved = conn.__updates('newsletter_subscribers')[0].arg;
    expect(moved.confirmation_token).toBe(result.pendingConfirmation.confirmation_token);
    expect(moved.unsubscribe_token).toMatch(/^[0-9a-f-]{36}$/);
    // The delivered-stamp attested a DOI sent to the OLD address — a
    // pending move clears it via a status-guarded CASE so the resume
    // dedupe guard can never read it as delivery to the corrected address
    // (Codex #3084 r18). Confirmed rows keep theirs (audit only).
    expect(String(moved.confirmation_sent_at.__raw)).toContain("WHEN status = 'pending' THEN NULL");
  });

  test('bearer tokens rotate on ACTIVE subscriber moves too', async () => {
    // Newsletter footers delivered the unsubscribe link to the old mailbox.
    const conn = makeConn({
      newsletter_subscribers: {
        firstQueue: [{ id: 739, email: 'charlesw.robb@gmail.com', customer_id: 'cust-1', status: 'active' }, null],
      },
    });
    await propagateCustomerEmailChange({ before: BEFORE, after: AFTER }, conn);
    const moved = conn.__updates('newsletter_subscribers')[0].arg;
    expect(moved.unsubscribe_token).toMatch(/^[0-9a-f-]{36}$/);
    expect(moved.confirmation_token).toMatch(/^[0-9a-f-]{36}$/);
    // Already-delivered quiz/feedback/event links rotate on the move too.
    const rotation = conn.__updates('newsletter_send_deliveries')[0];
    expect(rotation.arg.engagement_token.__raw).toContain('gen_random_uuid()');
  });

  test('an ACTIVE subscriber move carries no pendingConfirmation', async () => {
    const conn = makeConn({
      newsletter_subscribers: {
        firstQueue: [{ id: 739, email: 'charlesw.robb@gmail.com', customer_id: 'cust-1', status: 'active' }, null],
      },
    });
    const result = await propagateCustomerEmailChange({ before: BEFORE, after: AFTER }, conn);
    expect(result.pendingConfirmation).toBeUndefined();
  });

  test('booking-intent sync mirrors the sender predicate — NULL flags count as unsent', async () => {
    const conn = makeConn();
    await propagateCustomerEmailChange({ before: BEFORE, after: AFTER }, conn);
    const raws = conn.__calls
      .filter((c) => c.table === 'booking_intents' && c.op === 'whereRaw')
      .map((c) => c.arg.sql);
    expect(raws).toContain('followup_email_sent IS NOT TRUE');
    expect(raws).toContain('suppressed IS NOT TRUE');
  });

  test('a payload without email keys gets a recipient-only run sync', async () => {
    const conn = makeConn({
      email_template_automation_runs: { rows: [{ id: 'run-2', payload: { first_name: 'Charles' } }] },
    });
    await propagateCustomerEmailChange({ before: BEFORE, after: AFTER }, conn);
    const runSync = conn.__updates('email_template_automation_runs')[0].arg;
    expect(runSync.recipient_email).toBe('charleswrobb@gmail.com');
    expect(runSync.payload).toBeUndefined();
  });

  test('contract sync skips terminal statuses', async () => {
    const conn = makeConn();
    await propagateCustomerEmailChange({ before: BEFORE, after: AFTER }, conn);
    const notIn = conn.__calls.find((c) => c.table === 'customer_contracts' && c.op === 'whereNotIn');
    expect(notIn.arg.vals).toEqual(['signed', 'cancelled', 'voided']);
  });

  test('an INVALID replacement email never fans out or resolves cards', async () => {
    const conn = makeConn({
      triage_items: { rows: [{ id: 'ti-1', call_log_id: 'call-1' }], countQueue: [{ n: 0 }] },
    });
    const counts = await propagateCustomerEmailChange({
      before: BEFORE,
      after: { id: 'cust-1', email: 'foo@bar' },
    }, conn);
    expect(counts).toEqual({ leads: 0, estimates: 0, newsletter: 0, newsletterDeliveries: 0, automations: 0, templateRuns: 0, promoters: 0, billingPrefs: 0, contracts: 0, bookingIntents: 0, reviewCards: 0, heldDripResumed: 0 });
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

  test('the held-first-touch release runs even when NO review card is still open', async () => {
    // A name-deny verdict resolves the email card BEFORE the correction
    // happens; the ledger row — not the card — carries the pending state, so
    // the correction must attempt the release unconditionally.
    const conn = makeConn(); // no triage rows → reviewCards stays 0
    const counts = await propagateCustomerEmailChange({ before: HOLD_BEFORE, after: HOLD_AFTER }, conn);
    expect(counts.reviewCards).toBe(0);
    expect(mockResume).toHaveBeenCalledWith(expect.objectContaining({
      customerId: 'cust-1',
      email: HOLD_AFTER.email,
      deferNewsletter: true,
    }));
  });

  test('DOI dedupe hands EVERY deferred hold to the post-commit re-send — nothing consumed in-trx', async () => {
    // pendingConfirmation (moved pending subscriber) + deferred holds from
    // TWO calls: the re-sent confirmation is the one DOI, but the holds must
    // NOT settle inside the edit transaction — the re-send can still fail
    // post-commit, and a consumed hold would leave nothing to retry.
    const stamp1 = new Date();
    mockResume.mockResolvedValueOnce({
      resumed: true,
      enrolled: true,
      newsletterResume: [
        { holdId: 'hold-1', customerId: 'cust-1', email: HOLD_AFTER.email, claimStamp: stamp1 },
        { holdId: 'hold-2', customerId: 'cust-1', email: HOLD_AFTER.email },
      ],
    });
    const conn = makeConn({
      newsletter_subscribers: {
        firstQueue: [
          { id: 811, email: HOLD_BEFORE.email, customer_id: 'cust-1', status: 'pending', confirmation_token: 'tok-1', first_name: 'Sam' },
          null,
        ],
      },
    });
    const result = await propagateCustomerEmailChange({ before: HOLD_BEFORE, after: HOLD_AFTER }, conn);
    expect(result.pendingConfirmation.heldNewsletterHoldIds).toEqual(['hold-1', 'hold-2']);
    // Claim fence stamps ride along per hold (r27); stamp-less legacy
    // payloads simply stay unfenced.
    expect(result.pendingConfirmation.heldNewsletterHoldClaims).toEqual({ 'hold-1': stamp1 });
    expect(result.heldNewsletterResume).toBeUndefined();
    // Nothing CONSUMED in-trx (the releasing-claim retarget is not a consume).
    expect(conn.__updates('first_touch_holds').filter((u) => u.arg.released_newsletter)).toHaveLength(0);
  });

  test('a newer correction retargets claims already in flight', async () => {
    const conn = makeConn();
    await propagateCustomerEmailChange({ before: HOLD_BEFORE, after: HOLD_AFTER }, conn);
    const retarget = conn.__updates('first_touch_holds').find((u) => u.arg.held_email === HOLD_AFTER.email);
    expect(retarget).toBeDefined();
    // Scoped to active claims only, and updated_at untouched — never extend
    // a possibly-dead claimant's stale-claim window.
    expect(conn.__calls.some((c) => c.table === 'first_touch_holds' && c.op === 'where'
      && c.arg && c.arg.status === 'releasing' && c.arg.customer_id === 'cust-1')).toBe(true);
    expect(retarget.arg.updated_at).toBeUndefined();
    // The correction lifts a deny stamp on active claims too (Codex #3084
    // r22) — the in-flight worker's deny-safe settle would otherwise
    // preserve the stamp and strand the corrected hold from the sweep.
    expect(String(retarget.arg.last_error.__raw)).toContain('email_denied_await_correction');
    expect(String(retarget.arg.last_error.__raw)).toContain('THEN NULL');
    // A deny-stamped releasing row is ownerless (the deny bump invalidated
    // every lease, Codex #3084 r29) — the retarget flips exactly those rows
    // back to 'pending' so THIS correction's resume claims them immediately
    // instead of waiting out the stale-claim timeout.
    expect(String(retarget.arg.status.__raw)).toContain("WHEN last_error = 'email_denied_await_correction' THEN 'pending'");
    expect(String(retarget.arg.status.__raw)).toContain('ELSE status');
  });

  test('a correction retargets PENDING holds — and lifts a deny stamp — before releasing', async () => {
    // Durable in the SAME transaction as the correction (Codex #3084 r18):
    // resumeHeldFirstTouch never throws — a transient failure re-pends and
    // returns — so without the retarget the sweep would later release the
    // ledger's OLD (rejected) address with no email override in sight.
    const conn = makeConn();
    await propagateCustomerEmailChange({ before: HOLD_BEFORE, after: HOLD_AFTER }, conn);
    expect(conn.__calls.some((c) => c.table === 'first_touch_holds' && c.op === 'where'
      && c.arg && c.arg.status === 'pending' && c.arg.customer_id === 'cust-1')).toBe(true);
    const pendingRetarget = conn.__updates('first_touch_holds')
      .find((u) => u.arg.held_email === HOLD_AFTER.email && u.arg.last_error && u.arg.last_error.__raw);
    expect(pendingRetarget).toBeDefined();
    // The correction is an explicit operator approval of the new address —
    // it lifts a deny stamp so the sweep can release the retargeted row.
    expect(String(pendingRetarget.arg.last_error.__raw)).toContain('email_denied_await_correction');
    expect(String(pendingRetarget.arg.last_error.__raw)).toContain('THEN NULL');
  });

  test('the marker persists even when the email card was ALREADY resolved (deny-then-correct)', async () => {
    // A non-releasing deny resolves the card before the correction arrives:
    // openItems is empty, but the call still needs its marker — otherwise
    // the processor records the stale extracted address and the end-of-run
    // reconciliation reads the resolved-during-run deny as confirmation.
    const conn = makeConn({
      triage_items: {
        rowsQueue: [
          [], // openItems: nothing open — the deny already resolved the card
          [{ call_log_id: 'call-1' }], // marker sweep: card exists (resolved)
        ],
      },
    });
    const counts = await propagateCustomerEmailChange({ before: HOLD_BEFORE, after: HOLD_AFTER }, conn);
    expect(counts.reviewCards).toBe(0);
    const inserts = conn.__calls.filter((c) => c.table === 'first_touch_holds' && c.op === 'insert');
    expect(inserts).toHaveLength(1);
    expect(inserts[0].arg).toMatchObject({
      call_log_id: 'call-1',
      held_email: HOLD_AFTER.email,
      status: 'released',
    });
    // A SECOND correction must retarget a zero-work released marker — the
    // conflict merge carries a CASE that adopts the newer address only for
    // marker rows (never real holds).
    const markerMerge = conn.__calls.find((c) => c.table === 'first_touch_holds' && c.op === 'merge');
    expect(markerMerge).toBeDefined();
    expect(String(markerMerge.arg.held_email.__raw)).toContain('excluded.held_email');
    expect(String(markerMerge.arg.held_email.__raw)).toContain("NOT first_touch_holds.held_newsletter");
  });

  test('a correction leaves a SETTLED ledger marker for reviewed calls with no hold row', async () => {
    // The card can exist BEFORE the processor's Step-6 hold write (customer
    // linked, hold not yet recorded). The correction resolves the card and
    // finds nothing to release — the marker row carries the corrected
    // address so the processor's released-during-run guard adopts it
    // instead of the stale pre-correction extraction.
    const conn = makeConn({
      triage_items: { rows: [{ id: 'ti-1', call_log_id: 'call-1' }], countQueue: [{ n: 0 }] },
    });
    await propagateCustomerEmailChange({ before: HOLD_BEFORE, after: HOLD_AFTER }, conn);
    const inserts = conn.__calls.filter((c) => c.table === 'first_touch_holds' && c.op === 'insert');
    expect(inserts).toHaveLength(1);
    expect(inserts[0].arg).toMatchObject({
      call_log_id: 'call-1',
      held_email: HOLD_AFTER.email,
      held_drip: false,
      held_newsletter: false,
      status: 'released',
    });
  });

  test('the post-lock enrollment sweep covers the holds\' PRIOR targets, not only the stored old email', async () => {
    // A release enrolls at the HELD extraction, which can deliberately
    // differ from the customer's stored old email (Codex #3084 r31): the
    // sweep must retarget that enrollment too, or its immediately-due
    // steps keep mailing the rejected address.
    const conn = makeConn({
      first_touch_holds: { rows: [{ id: 'hold-1', held_email: 'Extracted.X@example.com' }] },
    });
    await propagateCustomerEmailChange({ before: HOLD_BEFORE, after: HOLD_AFTER }, conn);
    const priorTargetClause = conn.__calls.find((c) => c.table === 'automation_enrollments'
      && c.op === 'orWhereRaw' && Array.isArray(c.arg.bindings) && c.arg.bindings[0] === 'extracted.x@example.com');
    expect(priorTargetClause).toBeDefined();
  });

  test('a correction flips a DISMISSED read-back card to resolved so the sweep owns the retry', async () => {
    // Dismissal is "not actionable", so the ledger sweep's latest-card-
    // resolved rule excludes the call — but the operator's correction IS
    // the answer, and a transient release failure would otherwise strand
    // the retargeted hold with no retry trigger left (Codex #3084 r34).
    const conn = makeConn({
      first_touch_holds: { rows: [{ id: 'hold-1', held_email: 'extracted.x@example.com', call_log_id: 'call-9' }] },
      // list reads: open-card resolve, reviewedCalls (marker set), carded
      triage_items: { rowsQueue: [[], [], [{ call_log_id: 'call-9' }]] },
    });
    await propagateCustomerEmailChange({ before: HOLD_BEFORE, after: HOLD_AFTER }, conn);
    const flip = conn.__updates('triage_items')
      .find((u) => String(u.arg.resolution_note || '').includes('after dismissal'));
    expect(flip).toBeTruthy();
    expect(flip.arg.status).toBe('resolved');
    // Scoped to DISMISSED cards on the held calls only.
    expect(conn.__calls.some((c) => c.table === 'triage_items' && c.op === 'where'
      && c.arg && c.arg.status === 'dismissed')).toBe(true);
    // The call already has a card — no synthetic insert.
    expect(conn.__calls.filter((c) => c.table === 'triage_items' && c.op === 'insert')).toHaveLength(0);
  });

  test('correction evidence covers marker-only calls — a pre-Step-6 dismissed card flips too', async () => {
    // The correction can land BEFORE the processor's Step-6 hold write:
    // no hold row exists yet (heldCallIds is empty), but the reviewed
    // call gets a zero-work marker — and its latest dismissed card must
    // still flip to resolved, or the merged-in work later re-pends
    // against a card state the sweep rejects forever (Codex #3084 r35).
    const conn = makeConn({
      triage_items: { rowsQueue: [[], [{ call_log_id: 'call-7' }], [{ call_log_id: 'call-7' }]] },
    });
    await propagateCustomerEmailChange({ before: HOLD_BEFORE, after: HOLD_AFTER }, conn);
    const flip = conn.__updates('triage_items')
      .find((u) => String(u.arg.resolution_note || '').includes('after dismissal'));
    expect(flip).toBeTruthy();
    expect(flip.arg.status).toBe('resolved');
    // The zero-work marker upsert for the reviewed call landed too.
    expect(conn.__calls.some((c) => c.table === 'first_touch_holds' && c.op === 'insert')).toBe(true);
  });

  test('a correction leaves a synthetic RESOLVED card when the held call never got one', async () => {
    // A hold whose read-back card was never created (the insert failed)
    // has no review surface at all — the correction is the review, and
    // the resolved card it leaves makes the sweep's latest-card-resolved
    // rule admit the call (Codex #3084 r34).
    const conn = makeConn({
      first_touch_holds: { rows: [{ id: 'hold-1', held_email: 'extracted.x@example.com', call_log_id: 'call-9' }] },
      triage_items: { rowsQueue: [[], [], []] },
    });
    await propagateCustomerEmailChange({ before: HOLD_BEFORE, after: HOLD_AFTER }, conn);
    const inserts = conn.__calls.filter((c) => c.table === 'triage_items' && c.op === 'insert');
    expect(inserts).toHaveLength(1);
    const row = inserts[0].arg[0];
    expect(row).toMatchObject({ call_log_id: 'call-9', reason_code: 'email_unverified', status: 'resolved' });
    expect(String(row.resolution_note)).toContain('no read-back card existed');
  });

  test('the correction marker merge retargets a real pending/releasing row too', async () => {
    // recordFirstTouchHold can insert the FIRST real row after this
    // transaction's retarget updates already found nothing — the marker
    // upsert's conflict merge is the last correction write that can
    // still see it (Codex #3084 r36). Deny-lift and the ownerless
    // releasing→pending flip mirror the retarget updates; updated_at is
    // never touched.
    const conn = makeConn({ triage_items: { rows: [{ id: 'ti-1', call_log_id: 'call-1' }] } });
    await propagateCustomerEmailChange({ before: HOLD_BEFORE, after: HOLD_AFTER }, conn);
    const merge = conn.__calls.find((c) => c.table === 'first_touch_holds' && c.op === 'merge');
    expect(String(merge.arg.held_email.__raw)).toContain("IN ('pending', 'releasing')");
    expect(String(merge.arg.last_error.__raw)).toContain('email_denied_await_correction');
    expect(String(merge.arg.status.__raw)).toContain("THEN 'pending'");
    expect(merge.arg.updated_at).toBeUndefined();
  });

  test('deferred newsletter holds pass through when no pending subscriber was moved', async () => {
    mockResume.mockResolvedValueOnce({
      resumed: true,
      enrolled: false,
      newsletterResume: [{ holdId: 'hold-1', customerId: 'cust-1', email: HOLD_AFTER.email }],
    });
    const conn = makeConn();
    const result = await propagateCustomerEmailChange({ before: HOLD_BEFORE, after: HOLD_AFTER }, conn);
    expect(result.heldNewsletterResume).toEqual([expect.objectContaining({ holdId: 'hold-1' })]);
    expect(conn.__updates('first_touch_holds').filter((u) => u.arg.released_newsletter)).toHaveLength(0);
  });
});

describe('resendPendingConfirmation', () => {
  const { sendConfirmationEmail } = require('../services/newsletter-confirm');

  // Every send-path test seeds the subscriber verify-read (Codex #3084
  // r18) TWICE: the pre-send payload verify and the read-only post-send
  // rotation check (r26) both re-read the row — the payload email/token
  // must still match or the send/settle is skipped as superseded.
  const matchRow = (payload) => {
    const row = { email: payload.email, confirmation_token: payload.confirmation_token, status: 'pending' };
    return { newsletter_subscribers: { firstQueue: [row, { ...row }] } };
  };

  test('sends to the corrected address and stamps confirmation_sent_at', async () => {
    sendConfirmationEmail.mockResolvedValueOnce(true);
    const payload = { id: 739, email: 'charleswrobb@gmail.com', first_name: 'Charles', confirmation_token: 'tok-1' };
    const conn = makeConn(matchRow(payload));
    const ok = await resendPendingConfirmation(payload, conn);
    expect(ok).toBe(true);
    expect(sendConfirmationEmail).toHaveBeenCalledWith(expect.objectContaining({ email: payload.email, confirmation_token: 'tok-1' }));
    expect(conn.__updates('newsletter_subscribers')[0].arg.confirmation_sent_at).toBeInstanceOf(Date);
  });

  test('settles deduped newsletter holds only AFTER the re-send succeeds', async () => {
    sendConfirmationEmail.mockResolvedValueOnce(true);
    const payload = { id: 811, email: 'samtypo@example.com', confirmation_token: 'tok-1', heldNewsletterHoldIds: ['hold-1', 'hold-2'] };
    const conn = makeConn({
      ...matchRow(payload),
      first_touch_holds: {
        firstQueue: [
          { held_drip: true, released_drip: true },
          { held_drip: false, released_drip: false },
        ],
      },
    });
    const ok = await resendPendingConfirmation(payload, conn);
    expect(ok).toBe(true);
    // The pre-send marker consumes (r31) precede the settles.
    const settles = conn.__updates('first_touch_holds').filter((u) => u.arg.status === 'released');
    expect(settles).toHaveLength(2);
    for (const u of settles) {
      expect(u.arg.released_newsletter).toBe(true);
      expect(u.arg.status).toBe('released');
    }
  });

  test('a post-send bookkeeping failure never re-pends as an unsent DOI', async () => {
    // The send succeeded; a hold-settle failure must NOT write
    // newsletter_doi_not_confirmed — retries treat that marker as "must
    // re-send" (skipDedupe) and would double-mail the confirmation. The
    // claim stays for the stale-claim reclaim + dedupe guard instead.
    sendConfirmationEmail.mockResolvedValueOnce(true);
    const dbErr = new Error('settle write failed');
    const payload = { id: 811, email: 'samtypo@example.com', confirmation_token: 'tok-1', heldNewsletterHoldIds: ['hold-1'] };
    const conn = makeConn({ ...matchRow(payload), first_touch_holds: { updateError: dbErr } });
    const ok = await resendPendingConfirmation(payload, conn);
    expect(ok).toBe(true);
    const repens = conn.__updates('first_touch_holds')
      .filter((u) => u.arg.last_error === 'newsletter_doi_not_confirmed');
    expect(repens).toHaveLength(0);
  });

  test('re-pends deduped holds when the re-send fails — the DOI stays retryable', async () => {
    sendConfirmationEmail.mockRejectedValueOnce(new Error('sendgrid down'));
    const payload = { id: 811, email: 'samtypo@example.com', confirmation_token: 'tok-1', heldNewsletterHoldIds: ['hold-1'] };
    const conn = makeConn(matchRow(payload));
    const ok = await resendPendingConfirmation(payload, conn);
    expect(ok).toBe(false);
    // [0] is the r34 pre-send gate; the send-failure re-pend follows.
    const holdUpdates = conn.__updates('first_touch_holds');
    expect(holdUpdates).toHaveLength(2);
    expect(holdUpdates[0].arg).toMatchObject({ last_error: null });
    expect(holdUpdates.at(-1).arg).toMatchObject({ status: 'pending', last_error: 'newsletter_doi_not_confirmed' });
  });

  test('a send-failure re-pend never buries a denial stamped mid-callback', async () => {
    // The send-failed marker goes through the deny-preserving repenHolds
    // helper (Codex #3084 r23): the guarded write refuses on a stamped row
    // and the fallback re-pends without touching last_error.
    sendConfirmationEmail.mockRejectedValueOnce(new Error('sendgrid down'));
    const payload = { id: 811, email: 'samtypo@example.com', confirmation_token: 'tok-1', heldNewsletterHoldIds: ['hold-1'] };
    // consumeCounts lets the r34 pre-send gate pass while every other
    // hold write (the guarded re-pend) refuses with zero rows.
    const conn = makeConn({ ...matchRow(payload), first_touch_holds: { updateCount: 0, consumeCounts: [1] } });
    const ok = await resendPendingConfirmation(payload, conn);
    expect(ok).toBe(false);
    // the gate, the guarded attempt, then the stamp-preserving fallback
    const holdUpdates = conn.__updates('first_touch_holds');
    expect(holdUpdates).toHaveLength(3);
    expect(holdUpdates[1].arg).toMatchObject({ status: 'pending', last_error: 'newsletter_doi_not_confirmed' });
    expect(holdUpdates[2].arg).toMatchObject({ status: 'pending' });
    expect(holdUpdates[2].arg.last_error).toBeUndefined();
  });

  test('a failed send never throws and clears the pre-stamp', async () => {
    // The expiry stamp lands BEFORE the send (Codex #3084 r26); an actual
    // send failure clears it again so the dedupe guard never buries an
    // undelivered DOI (the canonical subscribeOrResubscribe contract).
    sendConfirmationEmail.mockRejectedValueOnce(new Error('sendgrid down'));
    const payload = { id: 811, email: 'samtypo@example.com', confirmation_token: 'tok-1' };
    const conn = makeConn(matchRow(payload));
    const ok = await resendPendingConfirmation(payload, conn);
    expect(ok).toBe(false);
    const nsUpdates = conn.__updates('newsletter_subscribers');
    expect(nsUpdates).toHaveLength(2);
    expect(nsUpdates[0].arg.confirmation_sent_at).toBeInstanceOf(Date);
    expect(nsUpdates[1].arg.confirmation_sent_at).toBeNull();
  });

  test('the expiry stamp lands before the send — a post-send failure cannot leave a permanent token', async () => {
    // Token rotation cleared confirmation_sent_at before this callback;
    // lookupByToken's seven-day expiry and the stale-pending purge both
    // apply only to non-null timestamps. Stamping after the send meant any
    // post-send bookkeeping failure left the mailed token permanent (Codex
    // #3084 r26) — the stamp must be durable before anything is mailed.
    let stampsWhenSent = -1;
    const payload = { id: 811, email: 'samtypo@example.com', confirmation_token: 'tok-1', heldNewsletterHoldIds: ['hold-1'] };
    const conn = makeConn({
      ...matchRow(payload),
      first_touch_holds: { firstQueue: [{ held_drip: false, released_drip: false }] },
    });
    sendConfirmationEmail.mockImplementationOnce(async () => {
      stampsWhenSent = conn.__updates('newsletter_subscribers').length;
      return true;
    });
    const ok = await resendPendingConfirmation(payload, conn);
    expect(ok).toBe(true);
    expect(stampsWhenSent).toBe(1);
    expect(conn.__updates('newsletter_subscribers')[0].arg.confirmation_sent_at).toBeInstanceOf(Date);
  });

  test('a pre-stamp failure re-pends retryably without sending', async () => {
    // Nothing was mailed, so the holds keep the NON-force marker: the
    // retry's dedupe guard re-reads a row whose stamp never landed and
    // permits the fresh send (Codex #3084 r26).
    const sendsBefore = sendConfirmationEmail.mock.calls.length;
    const payload = { id: 811, email: 'samtypo@example.com', confirmation_token: 'tok-1', heldNewsletterHoldIds: ['hold-1'] };
    const conn = makeConn({
      newsletter_subscribers: {
        firstQueue: [{ email: payload.email, confirmation_token: payload.confirmation_token, status: 'pending' }],
        updateError: new Error('db down'),
      },
    });
    const ok = await resendPendingConfirmation(payload, conn);
    expect(ok).toBe(false);
    expect(sendConfirmationEmail.mock.calls.length).toBe(sendsBefore);
    expect(conn.__updates('first_touch_holds')[0].arg).toMatchObject({ status: 'pending', last_error: 'doi_state_unverified' });
  });

  test('a rotation after the send is caught by the read-only post-send check — nothing settles', async () => {
    // With the stamp moved pre-send (Codex #3084 r26) the mid-send rotation
    // detector is a read: zero rows → the link just mailed is dead, B's own
    // callback owns delivery, holds re-pend retryably.
    sendConfirmationEmail.mockResolvedValueOnce(true);
    const sendsBefore = sendConfirmationEmail.mock.calls.length;
    const payload = { id: 811, email: 'samtypo@example.com', confirmation_token: 'tok-1', heldNewsletterHoldIds: ['hold-1'] };
    const conn = makeConn({
      newsletter_subscribers: {
        firstQueue: [{ email: payload.email, confirmation_token: payload.confirmation_token, status: 'pending' }, null],
      },
    });
    const ok = await resendPendingConfirmation(payload, conn);
    expect(ok).toBe(false);
    expect(sendConfirmationEmail.mock.calls.length).toBe(sendsBefore + 1);
    // [0] is the r34 pre-send gate; the re-pend follows.
    const holdUpdates = conn.__updates('first_touch_holds');
    expect(holdUpdates).toHaveLength(2);
    expect(holdUpdates.at(-1).arg).toMatchObject({ status: 'pending', last_error: 'target_verify_failed' });
    expect(holdUpdates.at(-1).arg.released_newsletter).toBeUndefined();
  });

  test('one reclaimed hold abandons the whole coalesced re-send', async () => {
    // The re-sent DOI is shared across the deduped group: a sibling lost
    // to the sweep's reclaim means its reclaimer may already have re-sent
    // this exact confirmation, and this path sends directly with no
    // dedupe guard (Codex #3084 r27/r28). One lost lease abandons the
    // send; the still-owned hold re-pends retryably (the sweep's retry
    // runs under the resume path's dedupe guard).
    const stamp1 = new Date();
    const stamp2 = new Date();
    mockRenewClaim.mockImplementation(async (holdId) => (holdId === 'hold-2' ? null : new Date()));
    const sendsBefore = sendConfirmationEmail.mock.calls.length;
    const payload = {
      id: 811,
      email: 'samtypo@example.com',
      confirmation_token: 'tok-1',
      heldNewsletterHoldIds: ['hold-1', 'hold-2'],
      heldNewsletterHoldClaims: { 'hold-1': stamp1, 'hold-2': stamp2 },
    };
    const conn = makeConn(matchRow(payload));
    const ok = await resendPendingConfirmation(payload, conn);
    expect(ok).toBe(false);
    expect(sendConfirmationEmail.mock.calls.length).toBe(sendsBefore);
    expect(mockRenewClaim).toHaveBeenCalledWith('hold-1', stamp1, conn);
    expect(mockRenewClaim).toHaveBeenCalledWith('hold-2', stamp2, conn);
    expect(conn.__updates('newsletter_subscribers')).toHaveLength(0);
    // Both re-pends attempted (fenced — the lost row's write misses in
    // prod; the stub records the guarded attempts).
    const repens = conn.__updates('first_touch_holds')
      .filter((u) => u.arg.last_error === 'claim_lost');
    expect(repens).toHaveLength(2);
  });

  test('a failed pre-send gate aborts the re-send with the markers intact', async () => {
    // Proceeding would leave the marker armed while this send goes out —
    // recreating the duplicate-on-reclaim window the gate closes (Codex
    // #3084 r32/r34). Plain re-pends keep last_error untouched, and the
    // abort lifts the pre-stamp (r33): nothing was sent, so a marker-less
    // retry path must not trust it.
    const sendsBefore = sendConfirmationEmail.mock.calls.length;
    const payload = { id: 811, email: 'samtypo@example.com', confirmation_token: 'tok-1', heldNewsletterHoldIds: ['hold-1'] };
    const conn = makeConn({
      ...matchRow(payload),
      first_touch_holds: { consumeError: new Error('db down') },
    });
    const ok = await resendPendingConfirmation(payload, conn);
    expect(ok).toBe(false);
    expect(sendConfirmationEmail.mock.calls.length).toBe(sendsBefore);
    const repens = conn.__updates('first_touch_holds').filter((u) => u.arg.status === 'pending');
    expect(repens).toHaveLength(1);
    expect(repens[0].arg.last_error).toBeUndefined(); // marker untouched
    const nsUpdates = conn.__updates('newsletter_subscribers');
    expect(nsUpdates.at(-1).arg.confirmation_sent_at).toBeNull();
  });

  test('a refused pre-send gate aborts before the send — a denial fenced us out', async () => {
    // The gate's fenced CAS misses when a denial or reclaim bumped the
    // row after the lease renewal — for EVERY deduped hold, marked or
    // not (Codex #3084 r33/r34); sending would mail the operator-rejected
    // address.
    const sendsBefore = sendConfirmationEmail.mock.calls.length;
    const payload = { id: 811, email: 'samtypo@example.com', confirmation_token: 'tok-1', heldNewsletterHoldIds: ['hold-1'] };
    const conn = makeConn({
      ...matchRow(payload),
      first_touch_holds: { consumeCounts: [0] },
    });
    const ok = await resendPendingConfirmation(payload, conn);
    expect(ok).toBe(false);
    expect(sendConfirmationEmail.mock.calls.length).toBe(sendsBefore);
    // The plain re-pend keeps last_error untouched (the deny survives),
    // and the pre-stamp lifts for the unsent DOI.
    const repens = conn.__updates('first_touch_holds').filter((u) => u.arg.status === 'pending');
    expect(repens).toHaveLength(1);
    expect(repens[0].arg.last_error).toBeUndefined();
    expect(conn.__updates('newsletter_subscribers').at(-1).arg.confirmation_sent_at).toBeNull();
  });

  test('the pre-send gate binds to the captured target — a silent retarget cannot pass the fence', async () => {
    // A correction retargets a releasing hold WITHOUT bumping its fence
    // (extending a dead claimant's stale window would be worse), so the
    // gate's held_email CAS is the only thing standing between a
    // just-superseded target and the send (Codex #3084 r35).
    sendConfirmationEmail.mockRejectedValueOnce(new Error('sendgrid down'));
    const payload = { id: 811, email: 'samtypo@example.com', confirmation_token: 'tok-1', heldNewsletterHoldIds: ['hold-1'] };
    const conn = makeConn(matchRow(payload));
    await resendPendingConfirmation(payload, conn);
    // With the send failing, the only held_email predicate on the hold
    // table is the gate's target bind.
    const targetBind = conn.__calls.find((c) => c.table === 'first_touch_holds' && c.op === 'whereRaw'
      && String(c.arg.sql).includes('held_email')
      && Array.isArray(c.arg.bindings) && c.arg.bindings[0] === 'samtypo@example.com');
    expect(targetBind).toBeDefined();
  });

  test('a failed pre-stamp lift on gate abort arms the force-resend ticket', async () => {
    // The gate refused (nothing sent) but the best-effort lift of our own
    // pre-stamp ALSO failed — an unmarked hold re-pended plainly would
    // meet the retry's dedupe guard trusting that stamp and settle an
    // undelivered DOI (Codex #3084 r35). The abort arms the verified
    // force-resend ticket instead.
    const sendsBefore = sendConfirmationEmail.mock.calls.length;
    const payload = { id: 811, email: 'samtypo@example.com', confirmation_token: 'tok-1', heldNewsletterHoldIds: ['hold-1'] };
    const base = matchRow(payload);
    const conn = makeConn({
      ...base,
      first_touch_holds: { consumeCounts: [0] },
      newsletter_subscribers: { ...base.newsletter_subscribers, clearError: new Error('db down') },
    });
    const ok = await resendPendingConfirmation(payload, conn);
    expect(ok).toBe(false);
    expect(sendConfirmationEmail.mock.calls.length).toBe(sendsBefore);
    // Ticket verify bound to the attempted subscriber id + token (r31/r32).
    expect(mockSendFailedMarker).toHaveBeenCalledWith('samtypo@example.com', conn, 811, 'tok-1');
    const marked = conn.__updates('first_touch_holds').filter((u) => u.arg.last_error === 'newsletter_doi_not_confirmed');
    expect(marked).toHaveLength(1);
  });

  test('grouped pre-send gates run in ONE transaction — a mid-group miss aborts, nothing half-consumed', async () => {
    // Per-hold gates committing independently would let a mid-group
    // failure re-pend the group with the first marker already gone — the
    // next release then trusted the pre-stamp with no force-resend ticket
    // left, settling holds whose DOI never delivered (Codex #3084
    // r33/r34).
    const stamp1 = new Date();
    const stamp2 = new Date();
    const sendsBefore = sendConfirmationEmail.mock.calls.length;
    const payload = {
      id: 811,
      email: 'samtypo@example.com',
      confirmation_token: 'tok-1',
      heldNewsletterHoldIds: ['hold-1', 'hold-2'],
      heldNewsletterHoldClaims: { 'hold-1': stamp1, 'hold-2': stamp2 },
    };
    const conn = makeConn({
      ...matchRow(payload),
      first_touch_holds: { consumeCounts: [1, 0] },
    });
    const ok = await resendPendingConfirmation(payload, conn);
    expect(ok).toBe(false);
    expect(sendConfirmationEmail.mock.calls.length).toBe(sendsBefore);
    // Both clears attempted under a single transaction (the stub cannot
    // roll back, but the wrapper is the rollback boundary in prod).
    expect(conn.__trxCount()).toBe(1);
    const consumes = conn.__updates('first_touch_holds')
      .filter((u) => u.arg.last_error === null && u.arg.updated_at && Object.keys(u.arg).length === 2);
    expect(consumes).toHaveLength(2);
    const repens = conn.__updates('first_touch_holds').filter((u) => u.arg.status === 'pending');
    expect(repens).toHaveLength(2);
    for (const r of repens) expect(r.arg.last_error).toBeUndefined();
  });

  test('a send failure binds the marker verify to the attempted subscriber id', async () => {
    // An unrelated signup claiming the freed address must not satisfy an
    // email-only verify and arm the force-resend for a hold that
    // meanwhile targets the rotation (Codex #3084 r31).
    sendConfirmationEmail.mockRejectedValueOnce(new Error('sendgrid down'));
    const payload = { id: 811, email: 'samtypo@example.com', confirmation_token: 'tok-1', heldNewsletterHoldIds: ['hold-1'] };
    const conn = makeConn(matchRow(payload));
    await resendPendingConfirmation(payload, conn);
    // Bound to the attempted subscriber id AND confirmation token (r31/r32).
    expect(mockSendFailedMarker).toHaveBeenCalledWith('samtypo@example.com', conn, 811, 'tok-1');
  });

  test('a do-not-contact request vetoes the coalesced DOI re-send and blocks the holds', async () => {
    // The coalesced pending-subscriber path is a send site too (Codex #3084
    // r19) — consent vetoes landing after the correction committed must be
    // honored here, not only in runOnePostCommitResume.
    mockDnc.mockResolvedValue(true);
    const sendsBefore = sendConfirmationEmail.mock.calls.length;
    const payload = { id: 811, email: 'samtypo@example.com', confirmation_token: 'tok-1', heldNewsletterHoldIds: ['hold-1'] };
    const conn = makeConn({
      newsletter_subscribers: { firstQueue: [{ email: payload.email, confirmation_token: payload.confirmation_token, customer_id: 'cust-1', status: 'pending' }] },
    });
    const ok = await resendPendingConfirmation(payload, conn);
    expect(ok).toBe(false);
    expect(sendConfirmationEmail.mock.calls.length).toBe(sendsBefore);
    expect(conn.__updates('first_touch_holds')[0].arg).toMatchObject({ status: 'blocked', last_error: 'do_not_contact' });
  });

  test('a suppression vetoes the coalesced DOI re-send and re-pends the holds', async () => {
    mockSuppressed.mockResolvedValue(true);
    const sendsBefore = sendConfirmationEmail.mock.calls.length;
    const payload = { id: 811, email: 'samtypo@example.com', confirmation_token: 'tok-1', heldNewsletterHoldIds: ['hold-1'] };
    const conn = makeConn(matchRow(payload));
    const ok = await resendPendingConfirmation(payload, conn);
    expect(ok).toBe(false);
    expect(sendConfirmationEmail.mock.calls.length).toBe(sendsBefore);
    expect(conn.__updates('first_touch_holds')[0].arg).toMatchObject({ status: 'pending', last_error: 'email_suppressed' });
  });

  test('a rotation between verify and stamp is caught by the conditional pre-stamp — nothing sends or settles', async () => {
    // Correction B rotates email+token in the verify/stamp gap (Codex #3084
    // r19, pre-stamp since r26): the stamp's email+token predicate matches
    // 0 rows, so the holds re-pend retryably before anything is mailed and
    // B's corrected row is never marked delivered.
    sendConfirmationEmail.mockResolvedValueOnce(true);
    const payload = { id: 811, email: 'samtypo@example.com', confirmation_token: 'tok-1', heldNewsletterHoldIds: ['hold-1'] };
    const conn = makeConn({
      newsletter_subscribers: {
        firstQueue: [{ email: payload.email, confirmation_token: payload.confirmation_token, status: 'pending' }],
        updateCount: 0,
      },
    });
    const ok = await resendPendingConfirmation(payload, conn);
    expect(ok).toBe(false);
    const holdUpdates = conn.__updates('first_touch_holds');
    expect(holdUpdates).toHaveLength(1);
    expect(holdUpdates[0].arg).toMatchObject({ status: 'pending', last_error: 'target_verify_failed' });
    expect(holdUpdates[0].arg.released_newsletter).toBeUndefined();
  });

  test('an unsubscribed row is never re-confirmed by the coalesced resend', async () => {
    // An admin unsubscribe landing after the edit committed is an explicit
    // opt-out — this send bypasses SendGrid suppressions, so the verify
    // (and the delivered-stamp) require status='pending' (Codex #3084
    // r24). The re-pended holds retry through the subscribe helper, which
    // honors the unsubscribed state.
    const sendsBefore = sendConfirmationEmail.mock.calls.length;
    const payload = { id: 811, email: 'samtypo@example.com', confirmation_token: 'tok-1', heldNewsletterHoldIds: ['hold-1'] };
    const conn = makeConn({
      newsletter_subscribers: { firstQueue: [{ email: payload.email, confirmation_token: payload.confirmation_token, status: 'unsubscribed' }] },
    });
    const ok = await resendPendingConfirmation(payload, conn);
    expect(ok).toBe(false);
    expect(sendConfirmationEmail.mock.calls.length).toBe(sendsBefore);
    expect(conn.__updates('first_touch_holds')[0].arg).toMatchObject({ status: 'pending', last_error: 'target_verify_failed' });
  });

  test('a released settle re-checks for drip work merged during the callback', async () => {
    // Step 8 can add held_drip while this callback is in flight — the
    // merged-work re-check (same as the resume paths) re-pends it instead
    // of leaving a released row with an unreleased drip (Codex #3084 r19).
    sendConfirmationEmail.mockResolvedValueOnce(true);
    const payload = { id: 811, email: 'samtypo@example.com', confirmation_token: 'tok-1', heldNewsletterHoldIds: ['hold-1'] };
    const conn = makeConn({
      ...matchRow(payload),
      first_touch_holds: { firstQueue: [{ held_drip: false, released_drip: false }] },
    });
    const ok = await resendPendingConfirmation(payload, conn);
    expect(ok).toBe(true);
    expect(mockRepenMerged).toHaveBeenCalledWith('hold-1', conn);
  });

  test('a deny stamped on a deduped hold vetoes the DOI re-send', async () => {
    // A force-reprocess verdict can stamp a deduped hold between the
    // correction's commit and this callback (Codex #3084 r25): the veto
    // runs before the send, and the plain re-pend keeps the stamp.
    const sendsBefore = sendConfirmationEmail.mock.calls.length;
    const payload = { id: 811, email: 'samtypo@example.com', confirmation_token: 'tok-1', heldNewsletterHoldIds: ['hold-1'] };
    const conn = makeConn({
      ...matchRow(payload),
      first_touch_holds: { denyRow: { id: 'hold-1' } },
    });
    const ok = await resendPendingConfirmation(payload, conn);
    expect(ok).toBe(false);
    expect(sendConfirmationEmail.mock.calls.length).toBe(sendsBefore);
    const holdUpdates = conn.__updates('first_touch_holds');
    expect(holdUpdates).toHaveLength(1);
    expect(holdUpdates[0].arg).toMatchObject({ status: 'pending' });
    expect(holdUpdates[0].arg.last_error).toBeUndefined();
  });

  test('a superseded subscriber row skips the stale send and re-pends retryably', async () => {
    // A SECOND correction rotated the subscriber's email + token before
    // this callback ran (Codex #3084 r18): the captured link is a dead
    // token aimed at the outdated mailbox. Skip the send, hand the work to
    // the newer correction's callback, and re-pend WITHOUT the send-failed
    // marker (nothing was sent — the retry keeps its dedupe guard).
    const sendsBefore = sendConfirmationEmail.mock.calls.length;
    const conn = makeConn({
      newsletter_subscribers: { firstQueue: [{ email: 'newer@example.com', confirmation_token: 'tok-2' }] },
    });
    const ok = await resendPendingConfirmation(
      { id: 811, email: 'samtypo@example.com', confirmation_token: 'tok-1', heldNewsletterHoldIds: ['hold-1'] }, conn);
    expect(ok).toBe(false);
    expect(sendConfirmationEmail.mock.calls.length).toBe(sendsBefore);
    const holdUpdates = conn.__updates('first_touch_holds');
    expect(holdUpdates).toHaveLength(1);
    expect(holdUpdates[0].arg).toMatchObject({ status: 'pending', last_error: 'target_verify_failed' });
  });

  test('null input is a no-op', async () => {
    expect(await resendPendingConfirmation(null, makeConn())).toBe(false);
  });
});

describe('emailKey', () => {
  test('trims, lowercases, and rejects non-addresses', () => {
    expect(emailKey('  A@B.com ')).toBe('a@b.com');
    expect(emailKey('not-an-email')).toBe('');
    expect(emailKey(null)).toBe('');
  });
});
