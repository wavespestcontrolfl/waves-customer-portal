/**
 * Codex round-2/round-3 P1s on the V1/V2 email-disagreement hold (PR #4802):
 *
 *   P1-B: a mid-run operator correction (customer-email-fanout stamps
 *   `corrected_at` + retargets `held_email`) must survive a fresh
 *   disagreement mint on the SAME run — the unconditional held_email clear
 *   in mintEmailReviewCardsFenced previously erased it before
 *   recordFirstTouchHold's own preservation branch ever ran (it requires a
 *   NONEMPTY held_email to restore).
 *
 *   P1-C: a reprocess that no longer disagrees (V1/V2 now agree, or this
 *   cycle simply finds a single address) must reconcile a STALE open
 *   disagreement card down to the current evidence and retarget the hold to
 *   match — not leave the two-candidate card open behind a hold that
 *   already recorded the agreed address (or, worse, a card an operator
 *   could still resolve into releasing an address they never reviewed).
 *
 * Drives the REAL mintEmailReviewCardsFenced against a small in-memory fake
 * db (table + filter aware — the shared single-chain mock in
 * lead-email-enrollment-hold.test.js can't distinguish which table a
 * `.first()` targets, which these tests need). Fixtures use synthetic
 * example.com addresses, never a real customer's.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../utils/triage-locks', () => ({ lockTriageCall: jest.fn(async () => {}) }));

const db = require('../models/db');
const { _test } = require('../services/call-recording-processor');

const { mintEmailReviewCardsFenced } = _test;

function pick(row, cols) {
  if (!cols.length) return row;
  const out = {};
  for (const c of cols) out[c] = row[c];
  return out;
}

// Small knex-shaped in-memory table simulator — table AND predicate aware,
// unlike the single-shared-chain mock other tests in this suite use, which
// this reconciliation logic needs (it queries first_touch_holds and
// triage_items with DIFFERENT filters in the same transaction).
function makeFakeDb(seed = {}) {
  const tables = {};
  for (const [name, rows] of Object.entries(seed)) tables[name] = rows.map((r) => ({ ...r }));
  const ensure = (name) => tables[name] || (tables[name] = []);

  function builder(tableName) {
    const rows = ensure(tableName);
    const eq = {};
    const whereInClauses = [];
    const whereNotNullCols = [];
    const whereNullCols = [];
    const matches = (row) => Object.entries(eq).every(([k, v]) => row[k] === v)
      && whereInClauses.every(({ col, vals }) => vals.includes(row[col]))
      && whereNotNullCols.every((col) => row[col] != null)
      && whereNullCols.every((col) => row[col] == null);
    const filtered = () => rows.filter(matches);
    const api = {
      where(a, b) {
        if (a && typeof a === 'object') Object.assign(eq, a); else eq[a] = b;
        return api;
      },
      whereIn(col, vals) { whereInClauses.push({ col, vals }); return api; },
      whereNotNull(col) { whereNotNullCols.push(col); return api; },
      whereNull(col) { whereNullCols.push(col); return api; },
      forUpdate() { return api; },
      select: async (...cols) => filtered().map((r) => pick(r, cols)),
      first: async (...cols) => {
        const r = filtered()[0];
        if (!r) return undefined;
        return cols.length ? pick(r, cols) : r;
      },
      update: async (patch) => {
        const found = filtered();
        for (const row of found) Object.assign(row, patch);
        return found.length;
      },
      insert(data) {
        const row = { ...data };
        return {
          onConflict: () => ({
            ignore: async () => {
              const conflict = rows.find((r) => r.call_log_id === row.call_log_id
                && r.reason_code === row.reason_code
                && ['open', 'in_progress'].includes(r.status));
              if (conflict) return 0;
              rows.push(row);
              return 1;
            },
          }),
        };
      },
    };
    return api;
  }
  const conn = (table) => builder(table);
  conn.transaction = jest.fn(async (fn) => fn(conn));
  conn.raw = (sql, bindings) => ({ __raw: sql, bindings });
  conn.schema = { hasTable: async (name) => Object.prototype.hasOwnProperty.call(tables, name) };
  return { conn, tables };
}

function wireDb(dbMock, { conn }) {
  dbMock.mockImplementation(conn);
  dbMock.transaction = conn.transaction;
  dbMock.schema = conn.schema;
  dbMock.raw = conn.raw;
}

const CALL_ID = 'call-1';
const DISAGREEMENT_PAYLOAD = {
  flag: 'email_unverified',
  email_candidates: [{ value: 'janedoee@example.com' }, { value: 'janedoe@example.com' }],
  email_as_heard: 'janedoee@example.com',
  confirmation_question: 'Which spelling is right — janedoee@example.com or janedoe@example.com?',
  email_disagreement: { v1: 'janedoee@example.com', v2: 'janedoe@example.com' },
};

function fixture(extra = {}) {
  return makeFakeDb({
    triage_items: [{
      id: 'card-1', call_log_id: CALL_ID, reason_code: 'email_unverified', status: 'open',
      payload: JSON.stringify(DISAGREEMENT_PAYLOAD),
    }],
    first_touch_holds: [{
      id: 'hold-1', call_log_id: CALL_ID, customer_id: 'cust-1', status: 'pending', held_email: '',
    }],
    call_log: [{ id: CALL_ID, processing_token: 'tok' }],
    ...extra,
  });
}

beforeEach(() => { db.mockReset(); });

describe('P1-B: a mid-run correction (corrected_at) survives a fresh disagreement mint', () => {
  test('held_email is preserved (not cleared) and the refreshed card notes the correction', async () => {
    const { conn, tables } = fixture({
      first_touch_holds: [{
        id: 'hold-1', call_log_id: CALL_ID, customer_id: 'cust-1', status: 'pending',
        held_email: 'corrected@example.com', corrected_at: '2026-09-24T10:00:00.000Z',
      }],
    });
    wireDb(db, { conn });

    const DISAGREEMENT_CARD = { call_log_id: CALL_ID, reason_code: 'email_unverified', payload: JSON.stringify(DISAGREEMENT_PAYLOAD) };
    await mintEmailReviewCardsFenced({
      callLogId: CALL_ID, procToken: 'tok', cards: [DISAGREEMENT_CARD], callSid: 'CA1', invalidateClaims: false,
    });

    // NOT cleared to '' — the operator's correction survives.
    expect(tables.first_touch_holds[0].held_email).toBe('corrected@example.com');
    const mergedPayload = JSON.parse(tables.triage_items[0].payload);
    expect(mergedPayload.email_disagreement).toEqual(DISAGREEMENT_PAYLOAD.email_disagreement);
    expect(mergedPayload.mid_run_correction).toEqual({
      held_email: 'corrected@example.com', corrected_at: '2026-09-24T10:00:00.000Z',
    });
  });

  test('with no corrected_at, held_email is cleared as before (regression)', async () => {
    const { conn, tables } = fixture(); // held_email: '', no corrected_at
    wireDb(db, { conn });
    const DISAGREEMENT_CARD = { call_log_id: CALL_ID, reason_code: 'email_unverified', payload: JSON.stringify(DISAGREEMENT_PAYLOAD) };
    await mintEmailReviewCardsFenced({
      callLogId: CALL_ID, procToken: 'tok', cards: [DISAGREEMENT_CARD], callSid: 'CA1', invalidateClaims: false,
    });
    expect(tables.first_touch_holds[0].held_email).toBe('');
    const mergedPayload = JSON.parse(tables.triage_items[0].payload);
    expect(mergedPayload.mid_run_correction).toBeUndefined();
  });
});

describe('P1-C: reconciling a stale disagreement card when a reprocess no longer disagrees', () => {
  test('direction A — this cycle mints its own non-disagreement card for the same reason_code: the stale card refreshes to it', async () => {
    const { conn, tables } = fixture();
    wireDb(db, { conn });
    const NON_DISAGREEMENT_CARD = {
      call_log_id: CALL_ID,
      reason_code: 'email_unverified',
      payload: JSON.stringify({
        flag: 'email_unverified',
        email_candidates: [{ value: 'janedoe@example.com' }],
        email_release_target: 'janedoe@example.com',
      }),
    };
    await mintEmailReviewCardsFenced({
      callLogId: CALL_ID, procToken: 'tok', cards: [NON_DISAGREEMENT_CARD], callSid: 'CA1', invalidateClaims: false,
    });
    // The ordinary insert was skipped (conflict with the still-open card) —
    // no duplicate row.
    expect(tables.triage_items).toHaveLength(1);
    const reconciled = JSON.parse(tables.triage_items[0].payload);
    expect(reconciled.email_disagreement).toBeNull();
    expect(reconciled.disagreement_resolved_on_reprocess).toBe(true);
    expect(reconciled.email_release_target).toBe('janedoe@example.com');
    expect(reconciled.email_candidates).toEqual([{ value: 'janedoe@example.com' }]);
    // The hold is retargeted to match what the card now shows — never left
    // blank behind a card that no longer asks the question.
    expect(tables.first_touch_holds[0].held_email).toBe('janedoe@example.com');
  });

  test('direction B — full agreement, no email card minted at all: resolvedEmail reconciles the stale card', async () => {
    const { conn, tables } = fixture();
    wireDb(db, { conn });
    await mintEmailReviewCardsFenced({
      callLogId: CALL_ID, procToken: 'tok', cards: [], callSid: 'CA1', invalidateClaims: false,
      resolvedEmail: 'janedoe@example.com',
    });
    const reconciled = JSON.parse(tables.triage_items[0].payload);
    expect(reconciled.email_disagreement).toBeNull();
    expect(reconciled.disagreement_resolved_on_reprocess).toBe(true);
    expect(reconciled.email_release_target).toBe('janedoe@example.com');
    expect(tables.first_touch_holds[0].held_email).toBe('janedoe@example.com');
  });

  test('full agreement with NO email at all (resolvedEmail null) clears the stale card down to nothing held', async () => {
    const { conn, tables } = fixture();
    wireDb(db, { conn });
    await mintEmailReviewCardsFenced({
      callLogId: CALL_ID, procToken: 'tok', cards: [], callSid: 'CA1', invalidateClaims: false,
      resolvedEmail: null,
    });
    const reconciled = JSON.parse(tables.triage_items[0].payload);
    expect(reconciled.email_disagreement).toBeNull();
    expect(reconciled.email_release_target).toBeNull();
    expect(tables.first_touch_holds[0].held_email).toBe('');
  });

  test('a mid-run correction (corrected_at) outranks the reconciliation retarget too', async () => {
    const { conn, tables } = fixture({
      first_touch_holds: [{
        id: 'hold-1', call_log_id: CALL_ID, customer_id: 'cust-1', status: 'pending',
        held_email: 'corrected@example.com', corrected_at: '2026-09-24T10:00:00.000Z',
      }],
    });
    wireDb(db, { conn });
    await mintEmailReviewCardsFenced({
      callLogId: CALL_ID, procToken: 'tok', cards: [], callSid: 'CA1', invalidateClaims: false,
      resolvedEmail: 'janedoe@example.com',
    });
    // The card still reconciles to the current evidence...
    const reconciled = JSON.parse(tables.triage_items[0].payload);
    expect(reconciled.email_disagreement).toBeNull();
    // ...but the operator's correction is never overwritten by the
    // reconciliation's own retarget.
    expect(tables.first_touch_holds[0].held_email).toBe('corrected@example.com');
  });

  test('no open disagreement card at all → the fenced transaction never opens (fast path)', async () => {
    const { conn, tables } = fixture({
      triage_items: [{
        id: 'card-1', call_log_id: CALL_ID, reason_code: 'email_unverified', status: 'open',
        payload: JSON.stringify({ flag: 'email_unverified', email_candidates: [{ value: 'plain@example.com' }] }),
      }],
    });
    wireDb(db, { conn });
    await mintEmailReviewCardsFenced({
      callLogId: CALL_ID, procToken: 'tok', cards: [], callSid: 'CA1', invalidateClaims: false,
      resolvedEmail: 'plain@example.com',
    });
    expect(conn.transaction).not.toHaveBeenCalled();
    // Untouched.
    expect(tables.triage_items[0].payload).toBe(JSON.stringify({ flag: 'email_unverified', email_candidates: [{ value: 'plain@example.com' }] }));
  });

  test('resolvedEmail undefined and no cards → returns immediately, no transaction', async () => {
    const { conn } = fixture();
    wireDb(db, { conn });
    await mintEmailReviewCardsFenced({ callLogId: CALL_ID, procToken: 'tok', cards: [], callSid: 'CA1' });
    expect(conn.transaction).not.toHaveBeenCalled();
  });
});
