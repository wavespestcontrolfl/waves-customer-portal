/**
 * Codex round-3 rework of the V1/V2 email-disagreement hold (PR #4802):
 * mintEmailReviewCardsFenced now SUPERSEDES a live email card whose evidence
 * no longer matches the current pass, rather than refreshing it in place.
 * Round 2's in-place refresh left three holes round 3 caught:
 *   - a `.first()` pick over live cards could grab the wrong sibling when
 *     both email_unverified and email_invalid were live (finding #2);
 *   - the reconcile-on-agreement branch only ran when the caller's own
 *     needsConfirmation list was non-empty, so a full-agreement shadow-mode
 *     reprocess never reached it (finding #3);
 *   - `email_release_target ?? candidates[0]` auto-picked a spelling when
 *     the target was explicitly null (an ambiguous dictation) — finding #6.
 *
 * These tests drive the REAL mintEmailReviewCardsFenced against a small
 * table+predicate-aware in-memory fake db, plus direct unit tests of the
 * pure helpers (emailCardSignature, deriveEmailHoldTarget, emailPassEvidence)
 * per the design. Fixtures use synthetic example.com addresses, never a real
 * customer's.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../utils/triage-locks', () => ({ lockTriageCall: jest.fn(async () => {}) }));

const db = require('../models/db');
const { _test } = require('../services/call-recording-processor');

const {
  mintEmailReviewCardsFenced, emailCardSignature, deriveEmailHoldTarget, emailPassEvidence,
} = _test;

function pick(row, cols) {
  if (!cols.length) return row;
  const out = {};
  for (const c of cols) out[c] = row[c];
  return out;
}

// Small knex-shaped in-memory table simulator — table AND predicate aware,
// unlike a single-shared-chain mock, which this supersession logic needs
// (it queries first_touch_holds and triage_items with DIFFERENT filters,
// and loads MULTIPLE live triage_items rows, in the same transaction).
function makeFakeDb(seed = {}) {
  const tables = {};
  for (const [name, rows] of Object.entries(seed)) tables[name] = rows.map((r) => ({ ...r }));
  const ensure = (name) => tables[name] || (tables[name] = []);

  function builder(tableName) {
    const rows = ensure(tableName);
    const eq = {};
    const whereInClauses = [];
    const matches = (row) => Object.entries(eq).every(([k, v]) => row[k] === v)
      && whereInClauses.every(({ col, vals }) => vals.includes(row[col]));
    const filtered = () => rows.filter(matches);
    const api = {
      where(a, b) {
        if (a && typeof a === 'object') Object.assign(eq, a); else eq[a] = b;
        return api;
      },
      whereIn(col, vals) { whereInClauses.push({ col, vals }); return api; },
      forUpdate() { return api; },
      count(spec) {
        const alias = spec && typeof spec === 'object' ? Object.keys(spec)[0] : 'count';
        return { first: async () => ({ [alias]: filtered().length }) };
      },
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

function disagreementCardRow(overrides = {}) {
  return {
    id: 'card-1', call_log_id: CALL_ID, reason_code: 'email_unverified', status: 'open',
    payload: JSON.stringify(DISAGREEMENT_PAYLOAD), created_at: '2026-09-24T09:00:00.000Z',
    ...overrides,
  };
}

function fixture(extra = {}) {
  return makeFakeDb({
    triage_items: [disagreementCardRow()],
    first_touch_holds: [{
      id: 'hold-1', call_log_id: CALL_ID, customer_id: 'cust-1', status: 'pending', held_email: '',
    }],
    call_log: [{ id: CALL_ID, processing_token: 'tok', review_status: 'open' }],
    ...extra,
  });
}

beforeEach(() => { db.mockReset(); });

describe('mintEmailReviewCardsFenced — supersession (codex round 3)', () => {
  test('disagreement → agreement: the old card is superseded (resolved/auto) and the hold becomes the single address', async () => {
    const { conn, tables } = fixture();
    wireDb(db, { conn });
    await mintEmailReviewCardsFenced({
      callLogId: CALL_ID, procToken: 'tok', cards: [], callSid: 'CA1', invalidateClaims: false,
      resolvedEmail: 'janedoe@example.com',
    });
    // Old row is CLOSED, never rewritten in place.
    const old = tables.triage_items.find((c) => c.id === 'card-1');
    expect(old.status).toBe('resolved');
    expect(old.resolution_source).toBe('auto');
    const oldPayload = JSON.parse(old.payload);
    // The closed row's OWN evidence survives untouched (a historical
    // record) — only supersession metadata is added.
    expect(oldPayload.email_disagreement).toEqual(DISAGREEMENT_PAYLOAD.email_disagreement);
    expect(oldPayload.superseded_reason).toBe('stale_email_evidence');
    expect(oldPayload.superseded_by).toBeNull(); // no replacement card minted (full agreement)
    expect(typeof oldPayload.superseded_at).toBe('string');
    // No fresh card exists (nothing to review) — only the one closed row.
    expect(tables.triage_items).toHaveLength(1);
    expect(tables.first_touch_holds[0].held_email).toBe('janedoe@example.com');
  });

  test('agreement → disagreement: a plain live card is superseded and the hold blanks', async () => {
    const PLAIN_PAYLOAD = { flag: 'email_unverified', email_candidates: [{ value: 'plain@example.com' }], email_release_target: 'plain@example.com' };
    const { conn, tables } = fixture({
      triage_items: [disagreementCardRow({ payload: JSON.stringify(PLAIN_PAYLOAD) })],
      first_touch_holds: [{ id: 'hold-1', call_log_id: CALL_ID, customer_id: 'cust-1', status: 'pending', held_email: 'plain@example.com' }],
    });
    wireDb(db, { conn });
    const DISAGREEMENT_CARD = {
      call_log_id: CALL_ID, reason_code: 'email_unverified', status: 'open', payload: JSON.stringify(DISAGREEMENT_PAYLOAD),
    };
    await mintEmailReviewCardsFenced({
      callLogId: CALL_ID, procToken: 'tok', cards: [DISAGREEMENT_CARD], callSid: 'CA1', invalidateClaims: false,
    });
    const old = tables.triage_items.find((c) => c.id === 'card-1');
    expect(old.status).toBe('resolved');
    const oldPayload = JSON.parse(old.payload);
    expect(oldPayload.email_disagreement).toBeUndefined(); // its OWN (plain) evidence, untouched
    // A fresh live card was inserted with the disagreement evidence, and the
    // closed row points at it.
    const fresh = tables.triage_items.find((c) => c.status === 'open');
    expect(fresh).toBeDefined();
    expect(JSON.parse(fresh.payload).email_disagreement).toEqual(DISAGREEMENT_PAYLOAD.email_disagreement);
    expect(oldPayload.superseded_by).toBe(fresh.id);
    expect(tables.first_touch_holds[0].held_email).toBe('');
  });

  test('identical evidence is a no-op — the live card is untouched, not superseded or reinserted', async () => {
    const { conn, tables } = fixture();
    wireDb(db, { conn });
    const SAME_CARD = { call_log_id: CALL_ID, reason_code: 'email_unverified', payload: JSON.stringify(DISAGREEMENT_PAYLOAD) };
    await mintEmailReviewCardsFenced({
      callLogId: CALL_ID, procToken: 'tok', cards: [SAME_CARD], callSid: 'CA1', invalidateClaims: false,
    });
    expect(tables.triage_items).toHaveLength(1);
    expect(tables.triage_items[0].status).toBe('open');
    expect(tables.triage_items[0].payload).toBe(JSON.stringify(DISAGREEMENT_PAYLOAD));
  });

  test('two live sibling cards (email_unverified AND email_invalid) are BOTH superseded when neither matches this pass', async () => {
    const { conn, tables } = fixture({
      triage_items: [
        disagreementCardRow({ id: 'card-unverified', reason_code: 'email_unverified' }),
        disagreementCardRow({
          id: 'card-invalid', reason_code: 'email_invalid',
          payload: JSON.stringify({ flag: 'email_invalid', email_candidates: [] }),
        }),
      ],
    });
    wireDb(db, { conn });
    // Full agreement this cycle — neither sibling's evidence survives.
    await mintEmailReviewCardsFenced({
      callLogId: CALL_ID, procToken: 'tok', cards: [], callSid: 'CA1', invalidateClaims: false,
      resolvedEmail: 'janedoe@example.com',
    });
    expect(tables.triage_items.find((c) => c.id === 'card-unverified').status).toBe('resolved');
    expect(tables.triage_items.find((c) => c.id === 'card-invalid').status).toBe('resolved');
    expect(tables.first_touch_holds[0].held_email).toBe('janedoe@example.com');
  });

  test('a mid-run correction (corrected_at) is untouched by supersession — the fresh card still supersedes the old one', async () => {
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
    expect(tables.triage_items[0].status).toBe('resolved');
    // The operator's correction always wins over fresh evidence.
    expect(tables.first_touch_holds[0].held_email).toBe('corrected@example.com');
  });

  test('an explicit-null release target (ambiguous dictation) keeps the hold blank rather than auto-picking a candidate', async () => {
    const { conn, tables } = fixture();
    wireDb(db, { conn });
    const AMBIGUOUS_CARD = {
      call_log_id: CALL_ID,
      reason_code: 'email_unverified',
      status: 'open',
      payload: JSON.stringify({
        flag: 'email_unverified',
        email_candidates: [{ value: 'janedoe@example.com' }],
        email_release_target: null, // explicitly ambiguous — never auto-pick
      }),
    };
    await mintEmailReviewCardsFenced({
      callLogId: CALL_ID, procToken: 'tok', cards: [AMBIGUOUS_CARD], callSid: 'CA1', invalidateClaims: false,
    });
    expect(tables.first_touch_holds[0].held_email).toBe('');
  });

  test('no live card and nothing held → the fenced transaction never opens (fast path)', async () => {
    const { conn, tables } = fixture({
      triage_items: [],
      first_touch_holds: [],
    });
    wireDb(db, { conn });
    await mintEmailReviewCardsFenced({
      callLogId: CALL_ID, procToken: 'tok', cards: [], callSid: 'CA1', invalidateClaims: false,
      resolvedEmail: 'plain@example.com',
    });
    expect(conn.transaction).not.toHaveBeenCalled();
    expect(tables.triage_items).toHaveLength(0);
  });

  test('resolvedEmail undefined and no cards → returns immediately, no transaction', async () => {
    const { conn } = fixture();
    wireDb(db, { conn });
    await mintEmailReviewCardsFenced({ callLogId: CALL_ID, procToken: 'tok', cards: [], callSid: 'CA1' });
    expect(conn.transaction).not.toHaveBeenCalled();
  });
});

// Codex round-4 P1 (finding #4): superseding the call's LAST live card with
// no replacement (full agreement on reprocess) previously left
// call_log.review_status stuck 'open' forever — the finalizer only writes
// 'open' when the pass has confirmation reasons, so a full-agreement pass
// never re-closes it, and call-intelligence keeps telling staff to clear a
// card that no longer exists.
describe('mintEmailReviewCardsFenced — call_log.review_status sync (codex round 4, finding #4)', () => {
  test('the last live card is superseded with NO replacement → review_status clears to resolved', async () => {
    const { conn, tables } = fixture(); // call_log seeded review_status: 'open'
    wireDb(db, { conn });
    await mintEmailReviewCardsFenced({
      callLogId: CALL_ID, procToken: 'tok', cards: [], callSid: 'CA1', invalidateClaims: false,
      resolvedEmail: 'janedoe@example.com',
    });
    expect(tables.triage_items).toHaveLength(1); // only the closed row — nothing replaces it
    expect(tables.triage_items[0].status).toBe('resolved');
    expect(tables.call_log[0].review_status).toBe('resolved');
  });

  test('the live card is superseded WITH a fresh replacement → review_status stays open', async () => {
    const PLAIN_PAYLOAD = { flag: 'email_unverified', email_candidates: [{ value: 'plain@example.com' }], email_release_target: 'plain@example.com' };
    const { conn, tables } = fixture({
      triage_items: [disagreementCardRow({ payload: JSON.stringify(PLAIN_PAYLOAD) })],
    });
    wireDb(db, { conn });
    const DISAGREEMENT_CARD = {
      call_log_id: CALL_ID, reason_code: 'email_unverified', status: 'open', payload: JSON.stringify(DISAGREEMENT_PAYLOAD),
    };
    await mintEmailReviewCardsFenced({
      callLogId: CALL_ID, procToken: 'tok', cards: [DISAGREEMENT_CARD], callSid: 'CA1', invalidateClaims: false,
    });
    const fresh = tables.triage_items.find((c) => c.status === 'open');
    expect(fresh).toBeDefined();
    expect(tables.call_log[0].review_status).toBe('open');
  });
});

describe('emailCardSignature (pure)', () => {
  test('same reason_code/candidates/target/disagreement → identical signature regardless of key order or case', () => {
    const a = emailCardSignature('email_unverified', { email_candidates: [{ value: 'A@Example.com' }, { value: 'b@example.com' }], email_release_target: null, email_disagreement: { v1: 'a', v2: 'b' } });
    const b = emailCardSignature('email_unverified', { email_disagreement: { v1: 'a', v2: 'b' }, email_release_target: null, email_candidates: [{ value: 'b@example.com' }, { value: 'a@example.com' }] });
    expect(a).toBe(b);
  });

  test('a different candidate set changes the signature', () => {
    const a = emailCardSignature('email_unverified', { email_candidates: [{ value: 'a@example.com' }] });
    const b = emailCardSignature('email_unverified', { email_candidates: [{ value: 'b@example.com' }] });
    expect(a).not.toBe(b);
  });

  test('an explicit null target differs from a target that is simply absent', () => {
    const explicitNull = emailCardSignature('email_unverified', { email_release_target: null });
    const absent = emailCardSignature('email_unverified', {});
    expect(explicitNull).not.toBe(absent);
  });

  test('a different reason_code changes the signature even with identical evidence', () => {
    const a = emailCardSignature('email_unverified', { email_candidates: [{ value: 'a@example.com' }] });
    const b = emailCardSignature('email_invalid', { email_candidates: [{ value: 'a@example.com' }] });
    expect(a).not.toBe(b);
  });
});

describe('deriveEmailHoldTarget (pure) — codex round-3 findings #1 and #6', () => {
  test('a corrected_at hold keeps its OWN held_email regardless of the evidence', () => {
    const hold = { held_email: 'corrected@example.com', corrected_at: '2026-09-24T10:00:00.000Z' };
    expect(deriveEmailHoldTarget({ email_disagreement: { v1: 'a', v2: 'b' } }, hold))
      .toEqual({ held_email: 'corrected@example.com', email_release_target: 'corrected@example.com' });
  });

  test('a corrected_at hold with a BLANK held_email is not treated as corrected (falls through to evidence)', () => {
    const hold = { held_email: '', corrected_at: '2026-09-24T10:00:00.000Z' };
    expect(deriveEmailHoldTarget({ email_release_target: 'agreed@example.com' }, hold))
      .toEqual({ held_email: 'agreed@example.com', email_release_target: 'agreed@example.com' });
  });

  test('a disagreement payload holds blank', () => {
    expect(deriveEmailHoldTarget({ email_disagreement: { v1: 'a', v2: 'b' }, email_candidates: [{ value: 'a' }, { value: 'b' }] }, null))
      .toEqual({ held_email: '', email_release_target: null });
  });

  test('finding #6: an EXPLICIT null release target holds blank, never auto-picking the sole candidate', () => {
    expect(deriveEmailHoldTarget({ email_candidates: [{ value: 'janedoe@example.com' }], email_release_target: null }, null))
      .toEqual({ held_email: '', email_release_target: null });
  });

  test('more than one candidate with no explicit target holds blank (never guesses)', () => {
    expect(deriveEmailHoldTarget({ email_candidates: [{ value: 'a@example.com' }, { value: 'b@example.com' }] }, null))
      .toEqual({ held_email: '', email_release_target: null });
  });

  test('a single candidate with no explicit target is used', () => {
    expect(deriveEmailHoldTarget({ email_candidates: [{ value: 'Jane.Doe@Example.com' }] }, null))
      .toEqual({ held_email: 'jane.doe@example.com', email_release_target: 'jane.doe@example.com' });
  });

  test('an explicit non-null target is used directly, even without candidates', () => {
    expect(deriveEmailHoldTarget({ email_release_target: 'agreed@example.com' }, null))
      .toEqual({ held_email: 'agreed@example.com', email_release_target: 'agreed@example.com' });
  });

  test('no evidence at all (null payload) holds blank', () => {
    expect(deriveEmailHoldTarget(null, null)).toEqual({ held_email: '', email_release_target: null });
  });
});

describe('emailPassEvidence (pure)', () => {
  test('a single card this pass: its own parsed payload', () => {
    const card = { payload: JSON.stringify({ email_release_target: 'a@example.com' }) };
    expect(emailPassEvidence([card], undefined)).toEqual({ email_release_target: 'a@example.com' });
  });

  test('no card this pass: resolvedEmail becomes the release target', () => {
    expect(emailPassEvidence([], 'agreed@example.com')).toEqual({ email_release_target: 'agreed@example.com' });
  });

  test('no card and no email this pass (resolvedEmail null): release target is null', () => {
    expect(emailPassEvidence([], null)).toEqual({ email_release_target: null });
  });

  test('more than one card this pass is treated as a disagreement (never auto-resolved)', () => {
    const cards = [{ payload: JSON.stringify({}) }, { payload: JSON.stringify({}) }];
    expect(emailPassEvidence(cards, 'x@example.com')).toEqual({ email_disagreement: true });
  });
});
