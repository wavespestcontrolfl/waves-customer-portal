/**
 * email-division/ledger.js — unit coverage for the codex round-1 findings
 * (mocked db; the PG suite proves the real concurrency/locking behavior).
 */

jest.mock('../models/db', () => {
  const db = jest.fn();
  db.transaction = jest.fn(async (run) => run(db));
  db.fn = { now: jest.fn(() => 'NOW()') };
  db.raw = jest.fn((expr) => expr);
  return db;
});
jest.mock('../services/email-template-library', () => ({ sendTemplate: jest.fn() }));
// The verdict is mocked; the class resolver, group mapping and REASONS are
// the real ones (the ledger stores the resolved class and the real reasons).
jest.mock('../services/email-division/eligibility', () => {
  const actual = jest.requireActual('../services/email-division/eligibility');
  return {
    eligibleForEmail: jest.fn(),
    resolveMarketingClass: actual.resolveMarketingClass,
    groupKeyFor: actual.groupKeyFor,
    REASONS: actual.REASONS,
  };
});

const db = require('../models/db');
const { sendTemplate } = require('../services/email-template-library');
const { eligibleForEmail, REASONS } = require('../services/email-division/eligibility');
const Ledger = require('../services/email-division/ledger');

// Two tables are queried by ledger.js — `marketing_email_ledger` and, for the
// reconciliation with the delivery authority, `email_messages`. One queue per
// table, one chain per call in the order the code makes them. A chain awaited
// directly (the stale-row select) resolves to `rows`.
function chain({ first, result = [], rows = [], updateReturn = 1 } = {}) {
  const calls = [];
  const q = { calls };
  ['where', 'whereNot', 'whereNotNull', 'whereIn', 'select', 'onConflict', 'ignore'].forEach((m) => {
    q[m] = jest.fn((...a) => { calls.push([m, ...a]); return q; });
  });
  q.first = jest.fn(async (...a) => { calls.push(['first', ...a]); return first; });
  q.update = jest.fn(async (patch) => { calls.push(['update', patch]); return updateReturn; });
  q.returning = jest.fn(async (...a) => { calls.push(['returning', ...a]); return result; });
  q.insert = jest.fn((row) => { calls.push(['insert', row]); return q; });
  q.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
  return q;
}

function setQueue(entries, emailMessages = []) {
  const queues = { marketing_email_ledger: [...entries], email_messages: [...emailMessages] };
  db.mockImplementation((table) => {
    const queue = queues[table];
    if (!queue) throw new Error(`unexpected table ${table}`);
    if (!queue.length) throw new Error(`exhausted ${table} queue`);
    return queue.shift();
  });
}

beforeEach(() => jest.clearAllMocks());

test('finding 1: a stale reservation is settled to failed/abandoned_reservation before the cap is honored', async () => {
  eligibleForEmail.mockResolvedValue({ ok: true, reason: null, checks: { customerEmail: 'sandy@example.test' } });
  const staleQ = chain({ rows: [{ id: 'row-stale', idempotency_key: 'key-old' }] });
  const settleQ = chain({ updateReturn: 1 });
  const idempQ = chain({ first: undefined });
  const outstandingQ = chain({ first: undefined });
  const insertQ = chain({ result: [{ id: 'row-1', status: 'reserved' }] });
  const failedQ = chain({ rows: [] }); // no recently failed rows to reconcile
  setQueue([staleQ, settleQ, failedQ, idempQ, outstandingQ, insertQ], [chain({ first: undefined })]); // no accepted message for key-old

  const result = await Ledger.reserveWithCap({
    customerId: 'cust-1', stream: 'broadcast', marketingClass: 'marketing',
    emailKey: 'mkt.broadcast.fall', idempotencyKey: 'key-1', now: new Date('2026-09-28T12:00:00Z'),
  });

  expect(result.ok).toBe(true);
  const settleUpdate = settleQ.calls.find((c) => c[0] === 'update');
  expect(settleUpdate[1]).toMatchObject({ status: 'failed', reason: 'abandoned_reservation' });
  expect(settleQ.calls.some((c) => c[0] === 'where' && c[1]?.status === 'reserved')).toBe(true);
  // …and only while still stale: a lease renewed since the select stays reserved (codex GitHub round P1 fence).
  expect(settleQ.calls).toEqual(expect.arrayContaining([['where', 'reserved_at', '<=', expect.any(Date)]]));
  expect(staleQ.calls.some((c) => c[0] === 'where' && c[1]?.status === 'reserved')).toBe(true);
});

test('GitHub round P1: a stale reservation whose key email_messages shows as accepted completes as SENT (linked), never abandoned', async () => {
  eligibleForEmail.mockResolvedValue({ ok: true, reason: null, checks: { customerEmail: 'sandy@example.test' } });
  const staleQ = chain({ rows: [{ id: 'row-stale', idempotency_key: 'key-old' }] });
  const settleQ = chain({ updateReturn: 1 });
  const idempQ = chain({ first: undefined });
  const outstandingQ = chain({ first: undefined });
  const insertQ = chain({ result: [{ id: 'row-1', status: 'reserved' }] });
  const accepted = { id: 'msg-9', sent_at: new Date('2026-09-28T11:31:00Z') };
  const acceptedQ = chain({ first: accepted });
  setQueue([staleQ, settleQ, chain({ rows: [] }), idempQ, outstandingQ, insertQ], [acceptedQ]);

  await Ledger.reserveWithCap({
    customerId: 'cust-1', stream: 'broadcast', marketingClass: 'marketing',
    emailKey: 'mkt.broadcast.fall', idempotencyKey: 'key-1', now: new Date('2026-09-28T12:00:00Z'),
  });

  expect(acceptedQ.calls).toEqual(expect.arrayContaining([['where', { idempotency_key: 'key-old' }]]));
  const settleUpdate = settleQ.calls.find((c) => c[0] === 'update');
  expect(settleUpdate[1]).toMatchObject({ status: 'sent', email_message_id: 'msg-9', sent_at: accepted.sent_at, reason: 'reconciled_from_email_messages' });
  // scoped to the still-reserved row (a settled row is never re-completed)
  expect(settleQ.calls.some((c) => c[0] === 'where' && c[1]?.id === 'row-stale')).toBe(true);
  expect(settleQ.calls).toEqual(expect.arrayContaining([['whereIn', 'status', ['reserved']]]));
});

test.each([
  ['handoff started, response lost', { id: 'msg-u', sent_at: null, status: 'queued', provider_handoff_phase: 'started', updated_at: new Date('2026-09-28T11:20:00Z') }, { status: 'sent', email_message_id: 'msg-u', reason: 'provider_handoff_uncertain' }],
  ['provider rejected', { id: 'msg-r', sent_at: null, status: 'queued', provider_handoff_phase: 'rejected', updated_at: new Date() }, { status: 'failed', reason: 'provider_rejected' }],
  ['terminal failure before handoff', { id: 'msg-f', sent_at: null, status: 'failed', provider_handoff_phase: 'pending', updated_at: new Date() }, { status: 'failed', reason: 'provider_rejected' }],
  ['never reached the provider', { id: 'msg-p', sent_at: null, status: 'queued', provider_handoff_phase: 'pending', updated_at: new Date() }, { status: 'failed', reason: 'abandoned_reservation' }],
])('GitHub round P1: a stale reservation is settled from the handoff phase — %s', async (_label, message, expected) => {
  eligibleForEmail.mockResolvedValue({ ok: true, reason: null, checks: { customerEmail: 'sandy@example.test' } });
  const staleQ = chain({ rows: [{ id: 'row-stale', idempotency_key: 'key-old' }] });
  const settleQ = chain({ updateReturn: 1 });
  setQueue([staleQ, settleQ, chain({ rows: [] }), chain({ first: undefined }), chain({ first: undefined }), chain({ result: [{ id: 'row-1' }] })], [chain({ first: message })]);

  await Ledger.reserveWithCap({
    customerId: 'cust-1', stream: 'broadcast', marketingClass: 'marketing',
    emailKey: 'mkt.broadcast.fall', idempotencyKey: 'key-1', now: new Date('2026-09-28T12:00:00Z'),
  });

  expect(settleQ.calls.find((c) => c[0] === 'update')[1]).toMatchObject(expected);
});

test('finding 2: an existing idempotency key returns duplicate:true for whatever status it holds, without checking eligibility', async () => {
  const staleQ = chain({ rows: [] });
  const existingRow = { id: 'row-existing', status: 'sent', customer_id: 'cust-1', stream: 'broadcast', email_key: 'mkt.broadcast.fall', marketing_class: 'marketing', pest_key: null };
  const idempQ = chain({ first: existingRow });
  setQueue([staleQ, chain({ rows: [] }), idempQ]);

  const result = await Ledger.reserveWithCap({
    customerId: 'cust-1', stream: 'broadcast', marketingClass: 'marketing',
    emailKey: 'mkt.broadcast.fall', idempotencyKey: 'existing-key', now: new Date(),
  });

  expect(result).toEqual({ ok: true, reason: null, row: existingRow, duplicate: true });
  expect(eligibleForEmail).not.toHaveBeenCalled();
});

test('GitHub round P2: an idempotency key that already names ANOTHER customer/stream/email is refused, not returned as a duplicate', async () => {
  const otherCustomersRow = { id: 'row-other', status: 'reserved', customer_id: 'cust-2', stream: 'broadcast', email_key: 'mkt.broadcast.fall', marketing_class: 'marketing', pest_key: null };
  setQueue([chain({ rows: [] }), chain({ rows: [] }), chain({ first: otherCustomersRow })]);

  const result = await Ledger.reserveWithCap({
    customerId: 'cust-1', stream: 'broadcast', marketingClass: 'marketing',
    emailKey: 'mkt.broadcast.fall', idempotencyKey: 'campaign-key', now: new Date(),
  });

  expect(result).toEqual({ ok: false, reason: 'IDEMPOTENCY_KEY_CONFLICT', row: null, duplicate: false });
  expect(eligibleForEmail).not.toHaveBeenCalled();

  // …and the same key for the same customer but a different email is a conflict too.
  setQueue([chain({ rows: [] }), chain({ rows: [] }), chain({ first: { ...otherCustomersRow, customer_id: 'cust-1', email_key: 'mkt.broadcast.other' } })]);
  const sameCustomer = await Ledger.reserveWithCap({
    customerId: 'cust-1', stream: 'broadcast', marketingClass: 'marketing',
    emailKey: 'mkt.broadcast.fall', idempotencyKey: 'campaign-key', now: new Date(),
  });
  expect(sameCustomer.reason).toBe('IDEMPOTENCY_KEY_CONFLICT');
});

test('finding 3: markFailed/markSkipped only move a still-reserved row, and report whether one changed', async () => {
  setQueue([chain({ first: { customer_id: 'cust-1', idempotency_key: 'k1' } }), chain({ updateReturn: 0 })], [chain({ first: undefined })]);
  await expect(Ledger.markFailed('row-1', 'provider_rejected')).resolves.toBe(false);

  const lookupQ = chain({ first: { customer_id: 'cust-1', idempotency_key: 'k1' } });
  const updateQ = chain({ updateReturn: 1 });
  setQueue([lookupQ, updateQ], [chain({ first: undefined })]);
  await expect(Ledger.markSkipped('row-2', 'unsubscribed')).resolves.toBe(true);
  const updateWhere = updateQ.calls.find((c) => c[0] === 'where');
  expect(updateWhere[1]).toEqual({ id: 'row-2', status: 'reserved' });
  expect(updateQ.calls.find((c) => c[0] === 'update')[1]).toMatchObject({ status: 'skipped', reason: 'unsubscribed' });
});

test('CI push audit: a markSent retry on an already-sent row is a no-op (scoped to status: reserved)', async () => {
  const lookupQ = chain({ first: { customer_id: 'cust-1' } });
  const updateQ = chain({ updateReturn: 0 }); // already 'sent' — the WHERE no longer matches
  setQueue([lookupQ, updateQ]);

  const changed = await Ledger.markSent('row-1', { emailMessageId: 'msg-retry' });
  expect(changed).toBe(0);
  const updateWhere = updateQ.calls.find((c) => c[0] === 'where');
  expect(updateWhere[1]).toEqual({ id: 'row-1' });
  // reserved OR failed (a same-key provider retry that succeeded) — never sent, never skipped.
  expect(updateQ.calls).toEqual(expect.arrayContaining([['whereIn', 'status', ['reserved', 'failed']]]));
});

test('GitHub round P1: a same-key retry of a FAILED reservation completes as sent when the provider accepted the retried message', async () => {
  const failedRow = { id: 'row-failed', status: 'failed', customer_id: 'cust-1', stream: 'broadcast', email_key: 'mkt.broadcast.fall', marketing_class: 'marketing', pest_key: null };
  const completed = { ...failedRow, status: 'sent', email_message_id: 'msg-2' };
  const completeQ = chain({ updateReturn: 1 });
  setQueue([chain({ rows: [] }), chain({ rows: [] }), chain({ first: failedRow }), completeQ, chain({ first: completed })],
    [chain({ first: { id: 'msg-2', sent_at: new Date('2026-09-28T13:00:00Z'), status: 'sent', provider_handoff_phase: 'started' } })]);

  const result = await Ledger.reserveWithCap({
    customerId: 'cust-1', stream: 'broadcast', marketingClass: 'marketing',
    emailKey: 'mkt.broadcast.fall', idempotencyKey: 'retry-key', now: new Date(),
  });

  expect(result).toEqual({ ok: true, reason: null, row: completed, duplicate: true });
  expect(completeQ.calls).toEqual(expect.arrayContaining([['whereIn', 'status', ['failed']]]));
  expect(completeQ.calls.find((c) => c[0] === 'update')[1]).toMatchObject({ status: 'sent', email_message_id: 'msg-2' });
  expect(eligibleForEmail).not.toHaveBeenCalled();
});

test('GitHub round P1: a same-key retry of a FAILED reservation whose message is definitely unsent reopens it as reserved — through eligibility and the cap', async () => {
  eligibleForEmail.mockResolvedValue({ ok: true, reason: null, checks: { customerEmail: 'sandy@example.test' } });
  const failedRow = { id: 'row-failed', status: 'failed', customer_id: 'cust-1', stream: 'broadcast', email_key: 'mkt.broadcast.fall', marketing_class: 'marketing', pest_key: null };
  const reopened = { ...failedRow, status: 'reserved' };
  const reopenQ = chain({ updateReturn: 1 });
  setQueue([chain({ rows: [] }), chain({ rows: [] }), chain({ first: failedRow }), chain({ first: undefined }), reopenQ, chain({ first: reopened })],
    [chain({ first: undefined })]);

  const result = await Ledger.reserveWithCap({
    customerId: 'cust-1', stream: 'broadcast', marketingClass: 'marketing',
    emailKey: 'mkt.broadcast.fall', idempotencyKey: 'retry-key', now: new Date(),
  });

  expect(result).toEqual({ ok: true, reason: null, row: reopened, duplicate: false, reopened: true });
  expect(eligibleForEmail).toHaveBeenCalledTimes(1);
  expect(reopenQ.calls.find((c) => c[0] === 'update')[1]).toMatchObject({ status: 'reserved', reason: null, recipient_email: 'sandy@example.test' });
});

test('GitHub round P2: losing the insert race to another customer\'s same key is the structured conflict, never a thrown error', async () => {
  eligibleForEmail.mockResolvedValue({ ok: true, reason: null, checks: { customerEmail: 'sandy@example.test' } });
  const theirs = { id: 'row-theirs', status: 'reserved', customer_id: 'cust-2', stream: 'broadcast', email_key: 'mkt.broadcast.fall', marketing_class: 'marketing', pest_key: null };
  // pre-insert lookup misses; ON CONFLICT DO NOTHING inserts nothing; the read-back is the other customer's row
  setQueue([chain({ rows: [] }), chain({ rows: [] }), chain({ first: undefined }), chain({ first: undefined }), chain({ result: [] }), chain({ first: theirs })]);

  const result = await Ledger.reserveWithCap({
    customerId: 'cust-1', stream: 'broadcast', marketingClass: 'marketing',
    emailKey: 'mkt.broadcast.fall', idempotencyKey: 'shared-key', now: new Date(),
  });

  expect(result).toEqual({ ok: false, reason: 'IDEMPOTENCY_KEY_CONFLICT', row: null, duplicate: false });
});

// ---------------------------------------------------------------------------
// Round 8: class resolution in the ledger, policy fields in the identity, the
// provider-boundary fence and the one dispatch path.
// ---------------------------------------------------------------------------

const OK_VERDICT = { ok: true, reason: null, checks: { customerEmail: 'sandy@example.test', marketingClass: 'marketing' } };
const RESERVED_ROW = {
  id: 'row-1', status: 'reserved', customer_id: 'cust-1', stream: 'broadcast', email_key: 'mkt.broadcast.fall',
  marketing_class: 'marketing', pest_key: null, idempotency_key: 'key-1', recipient_email: 'sandy@example.test',
};
// reserveWithCap's query sequence for a fresh key: stale select, failed-row
// select, key lookup, outstanding-reservation lookup, insert.
function freshReservationQueue(insertRow = RESERVED_ROW) {
  return [chain({ rows: [] }), chain({ rows: [] }), chain({ first: undefined }), chain({ first: undefined }), chain({ result: [insertRow] })];
}

test('pre-push audit P1: a broadcast passed as relationship is reserved and guarded as MARKETING — the class is resolved, never trusted', async () => {
  eligibleForEmail.mockResolvedValue(OK_VERDICT);
  const outstandingQ = chain({ first: undefined });
  const insertQ = chain({ result: [RESERVED_ROW] });
  setQueue([chain({ rows: [] }), chain({ rows: [] }), chain({ first: undefined }), outstandingQ, insertQ]);

  const result = await Ledger.reserveWithCap({
    customerId: 'cust-1', stream: 'broadcast', marketingClass: 'relationship',
    emailKey: 'mkt.broadcast.fall', idempotencyKey: 'key-1', now: new Date(),
  });

  expect(result.ok).toBe(true);
  expect(eligibleForEmail).toHaveBeenCalledWith(expect.objectContaining({ marketingClass: 'marketing' }));
  // the outstanding-reservation guard ran (marketing only)…
  expect(outstandingQ.calls.some((c) => c[0] === 'where' && c[1]?.marketing_class === 'marketing' && c[1]?.status === 'reserved')).toBe(true);
  // …and the row stores the resolved class
  expect(insertQ.calls.find((c) => c[0] === 'insert')[1]).toMatchObject({ marketing_class: 'marketing' });
});

test('an unknown marketing class is the fail-closed LOOKUP_FAILED denial, and touches no table', async () => {
  setQueue([]);
  const result = await Ledger.reserveWithCap({
    customerId: 'cust-1', stream: 'lifecycle', marketingClass: 'promo', emailKey: 'lc.welcome', idempotencyKey: 'k', now: new Date(),
  });
  expect(result).toEqual({ ok: false, reason: REASONS.LOOKUP_FAILED, row: null, duplicate: false });
  expect(db).not.toHaveBeenCalled();
});

test.each([
  ['a different pest', { stream: 'lifecycle', email_key: 'lc.pest_tip', marketing_class: 'marketing', pest_key: 'ants' }, { stream: 'lifecycle', marketingClass: 'marketing', emailKey: 'lc.pest_tip', pestKey: 'roaches' }],
  ['a relationship row retried as marketing', { stream: 'lifecycle', email_key: 'lc.welcome', marketing_class: 'relationship', pest_key: null }, { stream: 'lifecycle', marketingClass: 'marketing', emailKey: 'lc.welcome' }],
])('GitHub round P2: a same-key retry of a FAILED row with %s is refused, never reopened under the old policy fields', async (_label, rowFields, args) => {
  const failedRow = { id: 'row-failed', status: 'failed', customer_id: 'cust-1', ...rowFields };
  setQueue([chain({ rows: [] }), chain({ rows: [] }), chain({ first: failedRow })]);

  const result = await Ledger.reserveWithCap({ customerId: 'cust-1', idempotencyKey: 'retry-key', now: new Date(), ...args });

  expect(result).toEqual({ ok: false, reason: REASONS.IDEMPOTENCY_KEY_CONFLICT, row: null, duplicate: false });
  expect(eligibleForEmail).not.toHaveBeenCalled();
});

// The library's locked handoff, as the mocked sendTemplate runs it: the
// closure gets a `dispatch(database, boundaryCheck)`; the boundary check is
// sendOne's providerBoundaryCheck, awaited after the library's preparation
// and immediately before the provider request; a `providerBoundaryBlocked`
// veto is the library's own definite non-send, and an ok:false verdict
// before dispatch its ABORTED_BEFORE_DISPATCH.
function libraryLike({ result = { sent: true, providerAccepted: true, message: { id: 'msg-1' } } } = {}) {
  return async (args) => {
    let dispatched = false;
    let vetoed = null;
    const verdict = await args.withProviderHandoff(async (database, boundaryCheck) => {
      try {
        await boundaryCheck({ database });
      } catch (err) {
        if (!err.providerBoundaryBlocked) throw err;
        vetoed = err.reason;
        return;
      }
      dispatched = true;
    });
    if (verdict?.ok !== true) return { sent: false, aborted: true, reason: 'aborted_by_caller_before_dispatch' };
    if (vetoed) return { sent: false, aborted: true, reason: 'provider_boundary_blocked' };
    if (!dispatched) throw new Error('handoff returned without dispatching');
    return result;
  };
}

// A dispatch as the library would run it: the boundary check first, a veto
// counts as not dispatched.
function dispatchLike(record) {
  return async (database, boundaryCheck) => {
    try {
      await boundaryCheck({ database });
    } catch (err) {
      if (!err.providerBoundaryBlocked) throw err;
      record.vetoed = err.reason;
      return;
    }
    record.dispatched = true;
  };
}

describe('reservationHandoff — the fence inside the provider handoff (codex GitHub round P1s)', () => {
  test('holds the row under the customer lock, renews the lease, dispatches, and judges consent from the ROW inside the boundary check', async () => {
    eligibleForEmail.mockResolvedValue(OK_VERDICT);
    const renewQ = chain({ updateReturn: 1 });
    setQueue([chain({ first: RESERVED_ROW }), renewQ], [chain({ first: undefined })]);
    const verdicts = [];
    const record = {};

    const result = await Ledger.reservationHandoff('row-1', { onVerdict: (v) => verdicts.push(v) })(dispatchLike(record));

    expect(result).toEqual({ ok: true });
    expect(record).toEqual({ dispatched: true });
    expect(db.raw).toHaveBeenCalledWith('SELECT pg_advisory_xact_lock(hashtext(?))', ['marketing-email:cust-1']);
    expect(renewQ.calls.find((c) => c[0] === 'where')[1]).toEqual({ id: 'row-1', status: 'reserved' });
    expect(renewQ.calls.find((c) => c[0] === 'update')[1]).toMatchObject({ reserved_at: expect.any(Date) });
    // judged from the row's own fields, never caller arguments, on the handoff's transaction
    expect(eligibleForEmail).toHaveBeenCalledWith(expect.objectContaining({
      customerId: 'cust-1', stream: 'broadcast', marketingClass: 'marketing', emailKey: 'mkt.broadcast.fall', pestKey: null, conn: db,
    }));
    expect(verdicts.map((v) => v.ok)).toEqual([true, true]);
  });

  test('a row the sweep already settled cannot be held: RESERVATION_RECLAIMED, no dispatch, consent not even asked', async () => {
    setQueue([chain({ first: { ...RESERVED_ROW, status: 'failed' } }), chain({ updateReturn: 0 })], [chain({ first: undefined })]);
    const verdicts = [];
    const record = {};
    const result = await Ledger.reservationHandoff('row-1', { onVerdict: (v) => verdicts.push(v) })(dispatchLike(record));
    expect(result).toEqual({ ok: false, reason: REASONS.RESERVATION_RECLAIMED });
    expect(record).toEqual({});
    expect(verdicts).toHaveLength(1);
    expect(eligibleForEmail).not.toHaveBeenCalled();
  });

  test('a still-reserved row whose key email_messages shows accepted is an email that went out: completed as sent, ALREADY_DISPATCHED, no dispatch', async () => {
    const completeQ = chain({ updateReturn: 1 });
    setQueue([chain({ first: RESERVED_ROW }), completeQ],
      [chain({ first: { id: 'msg-a', sent_at: new Date('2026-09-28T11:59:00Z'), status: 'sent', provider_handoff_phase: 'started' } })]);
    const record = {};
    const result = await Ledger.reservationHandoff('row-1')(dispatchLike(record));
    expect(result).toEqual({ ok: false, reason: REASONS.ALREADY_DISPATCHED });
    expect(record).toEqual({});
    expect(completeQ.calls.find((c) => c[0] === 'update')[1]).toMatchObject({ status: 'sent', email_message_id: 'msg-a', reason: 'reconciled_from_email_messages' });
    expect(eligibleForEmail).not.toHaveBeenCalled();
  });

  test("consent withdrawn since the reservation is caught at the boundary: the row is skipped with the verdict's reason and the request vetoed", async () => {
    eligibleForEmail.mockResolvedValue({ ok: false, reason: 'EMAIL_SWITCH_OFF', checks: {} });
    const skipQ = chain({ updateReturn: 1 });
    setQueue([chain({ first: RESERVED_ROW }), chain({ updateReturn: 1 }), skipQ], [chain({ first: undefined })]);
    const verdicts = [];
    const record = {};
    const result = await Ledger.reservationHandoff('row-1', { onVerdict: (v) => verdicts.push(v) })(dispatchLike(record));
    expect(result).toEqual({ ok: true }); // the library's dispatch ran; its own veto protocol carried the refusal
    expect(record).toEqual({ vetoed: 'EMAIL_SWITCH_OFF' });
    expect(verdicts[1]).toMatchObject({ ok: false, reason: 'EMAIL_SWITCH_OFF' });
    expect(skipQ.calls.find((c) => c[0] === 'where')[1]).toEqual({ id: 'row-1', status: 'reserved' });
    expect(skipQ.calls.find((c) => c[0] === 'update')[1]).toMatchObject({ status: 'skipped', reason: 'EMAIL_SWITCH_OFF' });
  });

  test('an address changed since the reservation vetoes the request: the message was built for the reserved address (RECIPIENT_CHANGED)', async () => {
    eligibleForEmail.mockResolvedValue({ ok: true, reason: null, checks: { customerEmail: 'new@example.test' } });
    const skipQ = chain({ updateReturn: 1 });
    setQueue([chain({ first: RESERVED_ROW }), chain({ updateReturn: 1 }), skipQ], [chain({ first: undefined })]);
    const record = {};
    await Ledger.reservationHandoff('row-1')(dispatchLike(record));
    expect(record).toEqual({ vetoed: REASONS.RECIPIENT_CHANGED });
    expect(skipQ.calls.find((c) => c[0] === 'update')[1]).toMatchObject({ status: 'skipped', reason: REASONS.RECIPIENT_CHANGED });
  });
});

describe('sendWithLedger — the one dispatch path', () => {
  const template = { templateKey: 'mkt.broadcast.fall', payload: { first_name: 'Sandy' } };
  const args = { customerId: 'cust-1', stream: 'broadcast', emailKey: 'mkt.broadcast.fall', idempotencyKey: 'key-1', template };
  // reserve (5 chains) → the handoff's row read + lease renewal
  const throughHandoff = () => [...freshReservationQueue(), chain({ first: RESERVED_ROW }), chain({ updateReturn: 1 })];

  test("reserve → sendTemplate under the reservation's own key/recipient/group/template/handoff → markSent with the message id", async () => {
    eligibleForEmail.mockResolvedValue(OK_VERDICT);
    sendTemplate.mockImplementation(libraryLike());
    const markSentQ = chain({ updateReturn: 1 });
    setQueue([...throughHandoff(), chain({ first: { customer_id: 'cust-1' } }), markSentQ], [chain({ first: undefined })]);
    const callerHandoff = jest.fn();

    const result = await Ledger.sendWithLedger({
      ...args, marketingClass: 'relationship',
      // a caller cannot redirect the send, reuse another key, pick another group or supply its own handoff
      template: { ...template, to: 'someone-else@example.test', idempotencyKey: 'other-key', suppressionGroupKey: 'service_operational', withProviderHandoff: callerHandoff },
    });

    expect(result).toMatchObject({ ok: true, sent: true, duplicate: false, message: { id: 'msg-1' } });
    expect(sendTemplate).toHaveBeenCalledTimes(1);
    const sent = sendTemplate.mock.calls[0][0];
    expect(sent).toMatchObject({
      templateKey: 'mkt.broadcast.fall', payload: { first_name: 'Sandy' },
      to: 'sandy@example.test', recipientType: 'customer', recipientId: 'cust-1', idempotencyKey: 'key-1', suppressionGroupKey: 'marketing_newsletter',
    });
    expect(sent.withProviderHandoff).toEqual(expect.any(Function));
    expect(sent.withProviderHandoff).not.toBe(callerHandoff);
    expect(callerHandoff).not.toHaveBeenCalled();
    expect(markSentQ.calls.find((c) => c[0] === 'update')[1]).toMatchObject({ status: 'sent', email_message_id: 'msg-1' });
    // consent judged twice: at the reservation and again inside the handoff
    expect(eligibleForEmail).toHaveBeenCalledTimes(2);
  });

  test('GitHub round P1: a template that is not the judged email key is refused before anything is reserved', async () => {
    setQueue([]);
    const result = await Ledger.sendWithLedger({ ...args, emailKey: 'lc.welcome', template: { templateKey: 'lc.winback_60', payload: {} } });
    expect(result).toEqual({ ok: false, sent: false, reason: REASONS.TEMPLATE_KEY_MISMATCH, row: null, duplicate: false });
    expect(db).not.toHaveBeenCalled();
    expect(sendTemplate).not.toHaveBeenCalled();
  });

  test('a denial never reaches the provider', async () => {
    eligibleForEmail.mockResolvedValue({ ok: false, reason: 'STAFF_DNC', checks: {} });
    setQueue([chain({ rows: [] }), chain({ rows: [] }), chain({ first: undefined })]);
    const result = await Ledger.sendWithLedger(args);
    expect(result).toEqual({ ok: false, sent: false, reason: 'STAFF_DNC', row: null, duplicate: false });
    expect(sendTemplate).not.toHaveBeenCalled();
  });

  test('a duplicate key (an earlier attempt owns the send) returns duplicate:true without dispatching', async () => {
    setQueue([chain({ rows: [] }), chain({ rows: [] }), chain({ first: { ...RESERVED_ROW, status: 'sent' } })]);
    const result = await Ledger.sendWithLedger(args);
    expect(result).toMatchObject({ ok: true, sent: false, duplicate: true, reason: 'duplicate' });
    expect(sendTemplate).not.toHaveBeenCalled();
  });

  test('a reservation the sweep reclaimed before the handoff is not sent (RESERVATION_RECLAIMED), and the library aborts', async () => {
    eligibleForEmail.mockResolvedValue(OK_VERDICT);
    sendTemplate.mockImplementation(libraryLike());
    setQueue([...freshReservationQueue(), chain({ first: { ...RESERVED_ROW, status: 'failed' } }), chain({ updateReturn: 0 })], [chain({ first: undefined })]);
    const result = await Ledger.sendWithLedger(args);
    expect(result).toMatchObject({ ok: false, sent: false, reason: REASONS.RESERVATION_RECLAIMED });
    expect(eligibleForEmail).toHaveBeenCalledTimes(1); // the reservation's; the boundary check never ran
  });

  test('consent withdrawn between the reservation and the provider request skips the row and is not sent', async () => {
    eligibleForEmail.mockResolvedValueOnce(OK_VERDICT).mockResolvedValueOnce({ ok: false, reason: 'STREAM_FLAG_OFF', checks: {} });
    sendTemplate.mockImplementation(libraryLike());
    const skipQ = chain({ updateReturn: 1 });
    setQueue([...throughHandoff(), skipQ], [chain({ first: undefined })]);
    const result = await Ledger.sendWithLedger(args);
    expect(result).toMatchObject({ ok: false, sent: false, reason: 'STREAM_FLAG_OFF' });
    expect(skipQ.calls.find((c) => c[0] === 'update')[1]).toMatchObject({ status: 'skipped', reason: 'STREAM_FLAG_OFF' });
  });

  test('a library throw after the handoff started (EMAIL_PROVIDER_RETRY_HELD) settles the row as SENT from email_messages, never as a free slot', async () => {
    eligibleForEmail.mockResolvedValue(OK_VERDICT);
    const held = Object.assign(new Error('provider retry held'), { code: 'EMAIL_PROVIDER_RETRY_HELD', deliveryOutcome: 'uncertain' });
    sendTemplate.mockRejectedValue(held);
    const settleQ = chain({ updateReturn: 1 });
    setQueue(
      [...freshReservationQueue(), chain({ first: { customer_id: 'cust-1', idempotency_key: 'key-1' } }), settleQ],
      [chain({ first: { id: 'msg-u', sent_at: null, status: 'queued', provider_handoff_phase: 'started', updated_at: new Date('2026-09-28T12:00:01Z') } })],
    );
    const result = await Ledger.sendWithLedger(args);
    expect(result).toMatchObject({ ok: false, sent: false, reason: 'dispatch_failed', error: held });
    expect(settleQ.calls.find((c) => c[0] === 'update')[1]).toMatchObject({ status: 'sent', email_message_id: 'msg-u', reason: 'provider_handoff_uncertain' });
  });

  test('a library throw before any handoff settles the row as failed and frees the slot', async () => {
    eligibleForEmail.mockResolvedValue(OK_VERDICT);
    sendTemplate.mockRejectedValue(Object.assign(new Error('template disabled'), { code: 'EMAIL_TEMPLATE_DISABLED' }));
    const settleQ = chain({ updateReturn: 1 });
    setQueue(
      [...freshReservationQueue(), chain({ first: { customer_id: 'cust-1', idempotency_key: 'key-1' } }), settleQ],
      [chain({ first: undefined })],
    );
    const result = await Ledger.sendWithLedger(args);
    expect(result.reason).toBe('dispatch_failed');
    expect(settleQ.calls.find((c) => c[0] === 'update')[1]).toMatchObject({ status: 'failed', reason: 'dispatch_error:EMAIL_TEMPLATE_DISABLED' });
  });

  test("a library block (its own guards said no) is a skip with the library's reason", async () => {
    eligibleForEmail.mockResolvedValue(OK_VERDICT);
    sendTemplate.mockImplementation(libraryLike({ result: { sent: false, blocked: true, reason: 'suppressed' } }));
    const settleQ = chain({ updateReturn: 1 });
    setQueue(
      [...throughHandoff(), chain({ first: { customer_id: 'cust-1', idempotency_key: 'key-1' } }), settleQ],
      [chain({ first: undefined }), chain({ first: undefined })],
    );
    const result = await Ledger.sendWithLedger(args);
    expect(result).toMatchObject({ ok: false, sent: false, reason: 'suppressed' });
    expect(settleQ.calls.find((c) => c[0] === 'update')[1]).toMatchObject({ status: 'skipped', reason: 'suppressed' });
  });
});
