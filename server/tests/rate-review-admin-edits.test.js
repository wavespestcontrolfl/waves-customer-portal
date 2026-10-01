/**
 * Annual rate review — the admin screen's edits (services/rate-review.js:
 * updateRow / approveBatch / updateConfig / readConfig / batchDigest).
 *
 * What a row edit may do before a batch is sent (proposed amount in whole
 * dollars, never below the current rate; green ↔ skipped; an exception only
 * with an explicit include), what approval stamps (green → approved, nothing
 * else touched, refused on a stale digest), and the config knob validation
 * + cost block. Every number and id is invented; the db is an in-memory
 * stand-in for the exact knex shapes these functions use.
 */
process.env.GATE_RATE_REVIEW = 'true';

const mockAudit = jest.fn(async () => null);

jest.mock('../models/db', () => {
  const fn = jest.fn(() => { throw new Error('inject a fake db'); });
  fn.raw = jest.fn();
  fn.transaction = jest.fn();
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/audit-log', () => ({ recordAuditEvent: (...args) => mockAudit(...args) }));
jest.mock('../services/ops-digest', () => ({ deliverOpsDigest: jest.fn(async () => ({ ok: true, channel: 'in_app', id: 'bell-1' })) }));
jest.mock('../services/sendgrid-mail', () => ({ isConfigured: () => true, sendOne: jest.fn(async () => ({ ok: true })) }));

const db = require('../models/db');
const rateReview = require('../services/rate-review');
const { deliverOpsDigest } = require('../services/ops-digest');

const ROW_A = 'a1a1a1a1-1111-4111-8111-111111111111';
const ROW_B = 'b2b2b2b2-2222-4222-8222-222222222222';
const ROW_C = 'c3c3c3c3-3333-4333-8333-333333333333';
const ROW_D = 'd4d4d4d4-4444-4444-8444-444444444444';
const ROW_NEW = 'e5e5e5e5-5555-4555-8555-555555555555';
const ADMIN = '99999999-9999-4999-8999-999999999999';
const CUST = (n) => `00000000-0000-4000-8000-00000000000${n}`;

// ── in-memory knex stand-in ─────────────────────────────────────────────

function fakeDb(seed) {
  const tables = JSON.parse(JSON.stringify(seed));
  const strip = (col) => String(col).replace(/^[a-z]+\./, '');
  // Every builder call is logged with whether it ran inside a transaction
  // (depth > 0) and each transaction's config, so a test can prove WHERE a
  // read happened, not only what it returned.
  const reads = [];
  const transactions = [];
  let depth = 0;
  function builder(rawTable) {
    const table = rawTable.replace(/\s+as\s+\w+$/i, '');
    reads.push({ table, inTx: depth > 0 });
    const filters = [];
    let joined = null;
    let counted = false;
    let columns = null;
    const q = {};
    const rows = () => {
      let out = (tables[table] || []).filter((row) => filters.every((f) => f(row)));
      if (joined === 'customers') {
        out = out.map((row) => {
          const c = (tables.customers || []).find((x) => x.id === row.customer_id) || {};
          return { ...row, first_name: c.first_name, last_name: c.last_name, city: c.city };
        });
      }
      if (columns && !joined) out = out.map((row) => Object.fromEntries(columns.map((c) => [c, row[c]])));
      return out.map((row) => ({ ...row }));
    };
    q.where = (a, b) => {
      if (a && typeof a === 'object') filters.push((row) => Object.entries(a).every(([k, v]) => row[strip(k)] === v));
      else filters.push((row) => row[strip(a)] === b);
      return q;
    };
    q.whereIn = (col, list) => { filters.push((row) => list.includes(row[strip(col)])); return q; };
    q.whereNotIn = (col, list) => { filters.push((row) => !list.includes(row[strip(col)])); return q; };
    q.delete = async () => {
      const keep = [];
      let n = 0;
      for (const row of tables[table] || []) { if (filters.every((f) => f(row))) n += 1; else keep.push(row); }
      tables[table] = keep;
      return n;
    };
    q.forUpdate = () => q;
    q.leftJoin = (t) => { joined = t.replace(/\s+as\s+\w+$/i, ''); return q; };
    q.select = (...cols) => { columns = cols.filter((c) => c !== 'r.*' && !c.startsWith('c.')).map(strip); if (cols.includes('r.*')) columns = null; return q; };
    q.orderBy = () => q;
    q.orderByRaw = () => q;
    q.count = () => { counted = true; return q; };
    q.first = async () => (counted ? { n: rows().length } : rows()[0] || null);
    q.update = async (patch) => {
      let n = 0;
      for (const row of tables[table] || []) if (filters.every((f) => f(row))) { Object.assign(row, patch); n += 1; }
      return n;
    };
    // insert(row | rows) — awaited directly, or through .onConflict(col).merge(cols) (an upsert on `col`)
    q.insert = (rows) => {
      const list = (Array.isArray(rows) ? rows : [rows]).map((r) => ({ ...r }));
      let conflict = null;
      const pending = {
        onConflict: (col) => ({ merge: (cols) => { conflict = { col, cols }; return pending; } }),
        then: (resolve, reject) => Promise.resolve().then(() => {
          for (const row of list) {
            const existing = conflict ? (tables[table] || []).find((x) => x[conflict.col] === row[conflict.col]) : null;
            if (existing) for (const c of conflict.cols) existing[c] = row[c];
            else (tables[table] = tables[table] || []).push(row);
          }
          return [1];
        }).then(resolve, reject),
      };
      return pending;
    };
    q.then = (resolve, reject) => Promise.resolve().then(rows).then(resolve, reject);
    return q;
  }
  const db = jest.fn(builder);
  db.transaction = jest.fn(async (fn, config) => {
    transactions.push(config || null);
    depth += 1;
    try { return await fn(db); } finally { depth -= 1; }
  });
  db.raw = jest.fn(async () => ({ rows: [] })); // the writers' advisory lock
  db.tables = tables;
  db.reads = reads;
  db.transactions = transactions;
  return db;
}

function snapshot(id, overrides = {}) {
  return {
    id, batch_key: '2027-01', customer_id: CUST(1), family_key: 'pest_control', cadence: 'quarterly', visits_per_year: 4,
    rate_unit: 'application', current_rate_cents: 10500, list_rate_cents: 11700, band: 'C', proposed_rate_cents: 11700,
    delta_cents: 1200, annual_delta_cents: 4800, flags: JSON.stringify([]), status: 'green', ...overrides,
  };
}

const CONFIG_ROW = { id: 1, pass_through_pct: '3.500', band_b_tolerance_pct: '5.000', band_c_max_pct: '10.000', cap_pct: '12.000', cap_cents: 1500, min_delta_cents: 300, min_usable_visits: 3, lock_months: 12, exception_callback_days: 60, exception_manual_edit_months: 6, cost_block: null, cost_block_set_at: null, cost_block_set_by: null, updated_at: null, updated_by: null };

function seed() {
  return {
    rate_review_config: [{ ...CONFIG_ROW }],
    rate_review_batches: [{ batch_key: '2027-01', window_from: '2027-01-01', window_to: '2027-01-31', email_sent_at: null, computed_at: '2026-11-27T11:20:00.000Z' }],
    rate_review_snapshots: [
      snapshot(ROW_A),
      snapshot(ROW_B, { customer_id: CUST(2), band: 'A', current_rate_cents: 13000, list_rate_cents: 11700, proposed_rate_cents: 13000, delta_cents: 0, annual_delta_cents: 0, status: 'no_change' }),
      snapshot(ROW_C, { customer_id: CUST(3), status: 'exception', flags: JSON.stringify(['callback_recent']) }),
      snapshot(ROW_D, { customer_id: CUST(4), rate_unit: 'month', cadence: 'monthly', visits_per_year: 12, current_rate_cents: 6500, list_rate_cents: 6800, proposed_rate_cents: 6800, delta_cents: 300, annual_delta_cents: 3600, band: 'B' }),
    ],
    customers: [
      { id: CUST(1), first_name: 'Fixture', last_name: 'One', city: 'Bradenton' },
      { id: CUST(2), first_name: 'Fixture', last_name: 'Two', city: 'Sarasota' },
      { id: CUST(3), first_name: 'Fixture', last_name: 'Three', city: 'Parrish' },
      { id: CUST(4), first_name: 'Fixture', last_name: 'Four', city: 'Venice' },
    ],
    technicians: [{ id: ADMIN, name: 'Owner Fixture' }],
  };
}

afterEach(() => { jest.clearAllMocks(); });

// ── digest ──────────────────────────────────────────────────────────────

describe('batchDigest', () => {
  test('is order-independent and moves with a proposed amount or a status', () => {
    const a = [{ id: ROW_A, proposed_rate_cents: 11700, status: 'green' }, { id: ROW_B, proposed_rate_cents: 13000, status: 'no_change' }];
    const same = rateReview.batchDigest([...a].reverse());
    expect(rateReview.batchDigest(a)).toBe(same);
    expect(rateReview.batchDigest(a)).toMatch(/^[0-9a-f]{16}$/);
    expect(rateReview.batchDigest([{ ...a[0], proposed_rate_cents: 11800 }, a[1]])).not.toBe(same);
    expect(rateReview.batchDigest([{ ...a[0], status: 'skipped' }, a[1]])).not.toBe(same);
  });

  test('getBatch carries the digest of its rows and each row\u2019s review date (the occurrence the ranking stored; the start date for an older row)', async () => {
    const db = fakeDb(seed());
    db.tables.rate_review_snapshots[0].anniversary_date = '2026-01-06'; // the line started Jan 6, 2026 …
    db.tables.rate_review_snapshots[0].review_date = '2027-01-06'; // … and this batch reviews its 2027 occurrence
    const out = await rateReview.getBatch('2027-01', db);
    expect(out.approvalDigest).toBe(rateReview.batchDigest(out.rows));
    // The batch row and its rows are read from ONE repeatable-read snapshot.
    expect(db.transactions).toEqual([{ isolationLevel: 'repeatable read' }]);
    expect(db.reads.filter((r) => ['rate_review_batches', 'rate_review_snapshots'].includes(r.table)).every((r) => r.inTx)).toBe(true);
    // Inside a caller's transaction, that caller's snapshot is used — no nested transaction.
    const trxLike = fakeDb(seed());
    trxLike.isTransaction = true;
    await rateReview.getBatch('2027-01', trxLike);
    expect(trxLike.transactions).toEqual([]);
    expect(out.rows.map((r) => r.customer_name)).toContain('Fixture One');
    const first = out.rows.find((r) => r.id === ROW_A);
    expect(first).toMatchObject({ anniversary_date: '2026-01-06', review_date: '2027-01-06' });
    // A row from before the column (no stored review_date) falls back to its start date.
    const other = out.rows.find((r) => r.id === ROW_B);
    expect(other.review_date).toBe(other.anniversary_date);
  });
});

// ── row edits ───────────────────────────────────────────────────────────

describe('updateRow', () => {
  test('a line with no visit count refuses an amount above its current rate; an include lands at no change, never green', async () => {
    const db = fakeDb(seed());
    // the ranking holds such a line at its current rate (no_visits_per_year)
    Object.assign(db.tables.rate_review_snapshots.find((r) => r.id === ROW_C), { cadence: 'other', visits_per_year: null, proposed_rate_cents: 10500, delta_cents: 0, annual_delta_cents: 0, flags: JSON.stringify(['past_due', 'no_visits_per_year']) });
    const refused = await rateReview.updateRow({ batchKey: '2027-01', rowId: ROW_C, proposedRateCents: 11000, status: 'green', includeException: true, actorId: ADMIN, dbh: db });
    expect(refused).toMatchObject({ ok: false, reason: 'no_visits_per_year' });
    expect(mockAudit).not.toHaveBeenCalled();
    const included = await rateReview.updateRow({ batchKey: '2027-01', rowId: ROW_C, status: 'green', includeException: true, actorId: ADMIN, dbh: db });
    expect(included.ok).toBe(true);
    expect(included.row).toMatchObject({ status: 'no_change', delta_cents: 0, annual_delta_cents: 0 });
    expect(included.row.flags).toEqual(expect.arrayContaining(['exception_included', 'no_visits_per_year']));
  });

  test('a new proposed amount recomputes delta, annual delta and status, flags the hand edit and audits it', async () => {
    const db = fakeDb(seed());
    const out = await rateReview.updateRow({ batchKey: '2027-01', rowId: ROW_A, proposedRateCents: 11200, actorId: ADMIN, dbh: db });
    expect(out.ok).toBe(true);
    expect(db.raw).toHaveBeenCalledWith('SELECT pg_advisory_xact_lock(hashtext(?))', ['rate_review_batch:2027-01']);
    // The live config (a best-effort read) is read on the pool, never inside
    // the row's transaction, where a failed statement would abort the save.
    expect(db.reads.filter((r) => r.table === 'rate_review_config').length).toBeGreaterThan(0);
    expect(db.reads.filter((r) => r.table === 'rate_review_config').every((r) => !r.inTx)).toBe(true);
    expect(out.row).toMatchObject({ id: ROW_A, proposed_rate_cents: 11200, delta_cents: 700, annual_delta_cents: 2800, status: 'green', customer_name: 'Fixture One', city: 'Bradenton' });
    expect(out.row.flags).toContain('admin_edited');
    expect(out.approvalDigest).toMatch(/^[0-9a-f]{16}$/);
    expect(out.summary).toMatchObject({ green: 2, no_change: 1, exception: 1 });
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'rate_review.row.update', actor_id: ADMIN, resource_type: 'rate_review_snapshot', resource_id: ROW_A, critical: true,
      metadata: expect.objectContaining({ batch_key: '2027-01', from: { proposed_rate_cents: 11700, status: 'green' }, to: { proposed_rate_cents: 11200, status: 'green' } }),
    }));
  });

  test('an amount under the minimum change makes the row no_change; back over it, green again', async () => {
    const db = fakeDb(seed());
    const small = await rateReview.updateRow({ batchKey: '2027-01', rowId: ROW_A, proposedRateCents: 10700, dbh: db });
    expect(small.row).toMatchObject({ status: 'no_change', delta_cents: 200, annual_delta_cents: 800 });
    const back = await rateReview.updateRow({ batchKey: '2027-01', rowId: ROW_A, proposedRateCents: 11000, dbh: db });
    expect(back.row).toMatchObject({ status: 'green', delta_cents: 500 });
  });

  test('a monthly line spreads the annual delta over 12 months, keeps its cents, and is judged on the per-application minimum', async () => {
    const db = fakeDb(seed());
    const out = await rateReview.updateRow({ batchKey: '2027-01', rowId: ROW_D, proposedRateCents: 7000, dbh: db });
    expect(out.row).toMatchObject({ delta_cents: 500, annual_delta_cents: 6000, status: 'green' });
    // Monthly dues carry cents (a whole-dollar per-application amount spread over 12).
    const cents = await rateReview.updateRow({ batchKey: '2027-01', rowId: ROW_D, proposedRateCents: 6933, dbh: db });
    expect(cents.row).toMatchObject({ proposed_rate_cents: 6933, delta_cents: 433 });
    // $38.67 → $40 a month on a QUARTERLY line is $3.99 per application — green, not no_change.
    const quarterlyDues = seed();
    quarterlyDues.rate_review_snapshots[3] = { ...quarterlyDues.rate_review_snapshots[3], cadence: 'quarterly', visits_per_year: 4, current_rate_cents: 3867, proposed_rate_cents: 4000, delta_cents: 133, annual_delta_cents: 1596 };
    const db2 = fakeDb(quarterlyDues);
    const off = await rateReview.updateRow({ batchKey: '2027-01', rowId: ROW_D, status: 'skipped', dbh: db2 });
    expect(off.row.status).toBe('skipped');
    const on = await rateReview.updateRow({ batchKey: '2027-01', rowId: ROW_D, status: 'green', dbh: db2 });
    expect(on.row).toMatchObject({ status: 'green', delta_cents: 133, annual_delta_cents: 1596 });
    // A $1 a month move on the same line is $3 per application — exactly the minimum.
    const small = await rateReview.updateRow({ batchKey: '2027-01', rowId: ROW_D, proposedRateCents: 3967, dbh: db2 });
    expect(small.row.status).toBe('green');
    const tiny = await rateReview.updateRow({ batchKey: '2027-01', rowId: ROW_D, proposedRateCents: 3900, dbh: db2 });
    expect(tiny.row.status).toBe('no_change');
    // A boundary proposal the ranking made green stays green: $1 per
    // application on a quarterly line is 33¢ a month ($10.00 → $10.33).
    const boundary = seed();
    boundary.rate_review_batches[0].config = JSON.stringify({ min_delta_cents: 100 });
    boundary.rate_review_snapshots[3] = { ...boundary.rate_review_snapshots[3], cadence: 'quarterly', visits_per_year: 4, current_rate_cents: 1000, proposed_rate_cents: 1033, delta_cents: 33, annual_delta_cents: 396 };
    const db3 = fakeDb(boundary);
    expect((await rateReview.updateRow({ batchKey: '2027-01', rowId: ROW_D, status: 'skipped', dbh: db3 })).row.status).toBe('skipped');
    expect((await rateReview.updateRow({ batchKey: '2027-01', rowId: ROW_D, status: 'green', dbh: db3 })).row).toMatchObject({ status: 'green', delta_cents: 33 });
    expect((await rateReview.updateRow({ batchKey: '2027-01', rowId: ROW_D, proposedRateCents: 1032, dbh: db3 })).row.status).toBe('no_change');
  });

  test('an edit is judged by the config the batch was ranked with, not a setting changed since', async () => {
    const frozen = seed();
    frozen.rate_review_batches[0].config = JSON.stringify({ min_delta_cents: 100 });
    frozen.rate_review_config[0].min_delta_cents = 1000; // raised after the build
    const db = fakeDb(frozen);
    const out = await rateReview.updateRow({ batchKey: '2027-01', rowId: ROW_A, proposedRateCents: 10700, dbh: db });
    expect(out.row).toMatchObject({ delta_cents: 200, status: 'green' });
  });

  test('include toggles green ↔ skipped; a skipped row keeps an amount edit but stays skipped', async () => {
    const db = fakeDb(seed());
    const off = await rateReview.updateRow({ batchKey: '2027-01', rowId: ROW_A, status: 'skipped', dbh: db });
    expect(off.row.status).toBe('skipped');
    expect(off.row.flags).toContain('admin_skipped'); // an owner's skip, never a carry-forward hold
    const edited = await rateReview.updateRow({ batchKey: '2027-01', rowId: ROW_A, proposedRateCents: 11500, dbh: db });
    expect(edited.row).toMatchObject({ status: 'skipped', proposed_rate_cents: 11500 });
    expect(edited.row.flags).toContain('admin_skipped');
    const on = await rateReview.updateRow({ batchKey: '2027-01', rowId: ROW_A, status: 'green', dbh: db });
    expect(on.row).toMatchObject({ status: 'green', proposed_rate_cents: 11500, delta_cents: 1000 });
    expect(on.row.flags).not.toContain('admin_skipped');
  });

  test('ticking include on a band-A row records no_change (there is no letter to send) — even under a zero minimum', async () => {
    const db = fakeDb(seed());
    const out = await rateReview.updateRow({ batchKey: '2027-01', rowId: ROW_B, status: 'green', dbh: db });
    expect(out.row.status).toBe('no_change');
    const zero = seed();
    zero.rate_review_batches[0].config = JSON.stringify({ min_delta_cents: 0 });
    zero.rate_review_config[0].min_delta_cents = 0;
    const db2 = fakeDb(zero);
    expect((await rateReview.updateRow({ batchKey: '2027-01', rowId: ROW_B, status: 'green', dbh: db2 })).row.status).toBe('no_change');
    expect((await rateReview.updateRow({ batchKey: '2027-01', rowId: ROW_A, proposedRateCents: 10600, dbh: db2 })).row.status).toBe('green');
  });

  test('refuses: below current, not whole dollars, a typo-sized amount, a bad status, nothing to change', async () => {
    const db = fakeDb(seed());
    expect(await rateReview.updateRow({ batchKey: '2027-01', rowId: ROW_A, proposedRateCents: 10400, dbh: db })).toMatchObject({ ok: false, reason: 'proposed_below_current' });
    expect(await rateReview.updateRow({ batchKey: '2027-01', rowId: ROW_A, proposedRateCents: 11750, dbh: db })).toMatchObject({ ok: false, reason: 'proposed_not_whole_dollars' });
    expect(await rateReview.updateRow({ batchKey: '2027-01', rowId: ROW_A, proposedRateCents: 117000, dbh: db })).toMatchObject({ ok: false, reason: 'proposed_too_high' });
    expect(await rateReview.updateRow({ batchKey: '2027-01', rowId: ROW_A, proposedRateCents: '11700.5', dbh: db })).toMatchObject({ ok: false, reason: 'proposed_invalid' });
    expect(await rateReview.updateRow({ batchKey: '2027-01', rowId: ROW_A, status: 'approved', dbh: db })).toMatchObject({ ok: false, reason: 'status_invalid' });
    expect(await rateReview.updateRow({ batchKey: '2027-01', rowId: ROW_A, dbh: db })).toMatchObject({ ok: false, reason: 'nothing_to_change' });
    expect(await rateReview.updateRow({ batchKey: '2027-01', rowId: 'not-a-uuid', status: 'green', dbh: db })).toMatchObject({ ok: false, reason: 'row_not_found' });
    expect(await rateReview.updateRow({ batchKey: '2027-02', rowId: ROW_A, status: 'green', dbh: db })).toMatchObject({ ok: false, reason: 'row_not_found' });
    expect(db.tables.rate_review_snapshots.find((r) => r.id === ROW_A)).toMatchObject({ proposed_rate_cents: 11700, status: 'green' });
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test('an exception row needs includeException AND a status; included → green with the exception_included flag; skip → skipped', async () => {
    const db = fakeDb(seed());
    expect(await rateReview.updateRow({ batchKey: '2027-01', rowId: ROW_C, status: 'green', dbh: db })).toMatchObject({ ok: false, reason: 'row_is_exception' });
    expect(await rateReview.updateRow({ batchKey: '2027-01', rowId: ROW_C, proposedRateCents: 11700, includeException: true, dbh: db })).toMatchObject({ ok: false, reason: 'status_required' });
    const included = await rateReview.updateRow({ batchKey: '2027-01', rowId: ROW_C, status: 'green', includeException: true, dbh: db });
    expect(included.row).toMatchObject({ status: 'green', delta_cents: 1200 });
    expect(included.row.flags).toEqual(['callback_recent', 'exception_included']);
    expect(mockAudit).toHaveBeenLastCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ include_exception: true }) }));

    const db2 = fakeDb(seed());
    const skipped = await rateReview.updateRow({ batchKey: '2027-01', rowId: ROW_C, status: 'skipped', includeException: true, dbh: db2 });
    expect(skipped.row.status).toBe('skipped');
    expect(skipped.row.flags).toEqual(['callback_recent', 'admin_skipped']);
  });

  test('refused once the batch has a sent row, and on an approved row', async () => {
    const sent = seed();
    sent.rate_review_snapshots.push(snapshot('e5e5e5e5-5555-4555-8555-555555555555', { customer_id: CUST(1), family_key: 'lawn_care', status: 'sent' }));
    expect(await rateReview.updateRow({ batchKey: '2027-01', rowId: ROW_A, status: 'skipped', dbh: fakeDb(sent) })).toMatchObject({ ok: false, reason: 'batch_has_sent_rows' });

    const approved = seed();
    approved.rate_review_snapshots[0].status = 'approved';
    expect(await rateReview.updateRow({ batchKey: '2027-01', rowId: ROW_A, status: 'skipped', dbh: fakeDb(approved) })).toMatchObject({ ok: false, reason: 'row_locked' });
  });
});

// ── approval ────────────────────────────────────────────────────────────

describe('approveBatch', () => {
  test('green rows become approved with who/when; the batch is stamped; everything else is untouched; audited', async () => {
    const db = fakeDb(seed());
    const before = await rateReview.getBatch('2027-01', db);
    const out = await rateReview.approveBatch({ batchKey: '2027-01', expectedDigest: before.approvalDigest, actorId: ADMIN, dbh: db });
    expect(out).toMatchObject({ ok: true, approved: 2, annual_delta_cents: 8400 });
    // The writers' shared advisory lock, keyed by batch, taken first.
    expect(db.raw).toHaveBeenCalledWith('SELECT pg_advisory_xact_lock(hashtext(?))', ['rate_review_batch:2027-01']);
    expect(out.approved_at).toBeInstanceOf(Date);
    const rows = db.tables.rate_review_snapshots;
    expect(rows.find((r) => r.id === ROW_A)).toMatchObject({ status: 'approved', approved_by: ADMIN });
    expect(rows.find((r) => r.id === ROW_A).approved_at).toBeInstanceOf(Date);
    expect(rows.find((r) => r.id === ROW_D).status).toBe('approved');
    expect(rows.find((r) => r.id === ROW_B).status).toBe('no_change');
    expect(rows.find((r) => r.id === ROW_B).approved_at).toBeUndefined();
    expect(rows.find((r) => r.id === ROW_C).status).toBe('exception');
    expect(db.tables.rate_review_batches[0]).toMatchObject({ approved_by: ADMIN, approval_digest: before.approvalDigest });
    expect(out.approvalDigest).toBe((await rateReview.getBatch('2027-01', db)).approvalDigest);
    expect(out.approvalDigest).not.toBe(before.approvalDigest);
    expect(out.summary).toMatchObject({ approved: 2, green: 0, no_change: 1, exception: 1 });
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'rate_review.batch.approve', actor_id: ADMIN, critical: true, metadata: { batch_key: '2027-01', digest: before.approvalDigest, approved: 2, annual_delta_cents: 8400 } }));
  });

  test('a stale digest refuses and returns the fresh one; nothing is written', async () => {
    const db = fakeDb(seed());
    const fresh = (await rateReview.getBatch('2027-01', db)).approvalDigest;
    const out = await rateReview.approveBatch({ batchKey: '2027-01', expectedDigest: 'stale0000stale00', dbh: db });
    expect(out).toMatchObject({ ok: false, reason: 'digest_mismatch', approvalDigest: fresh });
    expect(db.tables.rate_review_snapshots.every((r) => r.status !== 'approved')).toBe(true);
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test('refuses an empty digest, an unknown batch, a batch with sent rows, and one with nothing green', async () => {
    expect(await rateReview.approveBatch({ batchKey: '2027-01', expectedDigest: '', dbh: fakeDb(seed()) })).toMatchObject({ ok: false, reason: 'digest_required' });
    expect(await rateReview.approveBatch({ batchKey: '2027-02', expectedDigest: 'x', dbh: fakeDb(seed()) })).toMatchObject({ ok: false, reason: 'batch_not_found' });
    const sent = seed();
    sent.rate_review_snapshots[0].status = 'sent';
    expect(await rateReview.approveBatch({ batchKey: '2027-01', expectedDigest: 'x', dbh: fakeDb(sent) })).toMatchObject({ ok: false, reason: 'batch_has_sent_rows' });
    const nothing = seed();
    nothing.rate_review_snapshots = nothing.rate_review_snapshots.filter((r) => r.status !== 'green');
    const db = fakeDb(nothing);
    const digest = (await rateReview.getBatch('2027-01', db)).approvalDigest;
    expect(await rateReview.approveBatch({ batchKey: '2027-01', expectedDigest: digest, dbh: db })).toMatchObject({ ok: false, reason: 'nothing_to_approve', approvalDigest: digest });
  });
});

// ── config ──────────────────────────────────────────────────────────────

describe('readConfig / updateConfig', () => {
  test('readConfig = the numeric knobs plus the cost block and the editors’ names', async () => {
    const db = fakeDb(seed());
    db.tables.rate_review_config[0].cost_block = 'Technician pay is up 6% since last January.';
    db.tables.rate_review_config[0].cost_block_set_by = ADMIN;
    db.tables.rate_review_config[0].cost_block_set_at = '2026-10-28T14:00:00.000Z';
    const config = await rateReview.readConfig(db);
    expect(config).toMatchObject({ pass_through_pct: 3.5, cap_cents: 1500, min_delta_cents: 300, cost_block: 'Technician pay is up 6% since last January.', cost_block_set_by: ADMIN, cost_block_set_by_name: 'Owner Fixture', cost_block_set_at: '2026-10-28T14:00:00.000Z' });
  });

  test('a partial patch changes only what was sent, stamps the editor, audits before/after; the display read runs after the commit', async () => {
    const db = fakeDb(seed());
    const out = await rateReview.updateConfig({ patch: { pass_through_pct: '4', cap_cents: 2000 }, actorId: ADMIN, dbh: db });
    expect(out.ok).toBe(true);
    // The best-effort editor-name lookup (and the config re-read) never run
    // inside the write transaction: a failed statement there would abort it
    // and roll the valid save back.
    expect(db.reads.filter((r) => r.table === 'technicians').length).toBeGreaterThan(0);
    expect(db.reads.filter((r) => r.table === 'technicians').every((r) => !r.inTx)).toBe(true);
    const afterCommit = db.reads.slice(db.reads.findIndex((r) => r.table === 'audit_log' || (r.table === 'rate_review_config' && r.inTx)) + 1);
    expect(afterCommit.some((r) => r.table === 'rate_review_config' && !r.inTx)).toBe(true);
    expect(out.changed).toEqual({ pass_through_pct: { from: 3.5, to: 4 }, cap_cents: { from: 1500, to: 2000 } });
    expect(out.config).toMatchObject({ pass_through_pct: 4, cap_cents: 2000, band_b_tolerance_pct: 5, updated_by: ADMIN, updated_by_name: 'Owner Fixture' });
    expect(db.tables.rate_review_config[0]).toMatchObject({ pass_through_pct: 4, cap_cents: 2000, band_c_max_pct: '10.000', updated_by: ADMIN });
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'rate_review.config.update', actor_id: ADMIN, critical: true, metadata: { changed: { pass_through_pct: { from: 3.5, to: 4 }, cap_cents: { from: 1500, to: 2000 } } } }));
  });

  test('the cost block is stored trimmed with who/when; clearing it clears the stamp; the audit carries lengths only', async () => {
    const db = fakeDb(seed());
    const set = await rateReview.updateConfig({ patch: { cost_block: '  Technician pay is up 6%.\r\nProducts cost 9% more.  ' }, actorId: ADMIN, dbh: db });
    expect(set.config.cost_block).toBe('Technician pay is up 6%.\nProducts cost 9% more.');
    expect(set.config.cost_block_set_by).toBe(ADMIN);
    expect(set.config.cost_block_set_at).toBeInstanceOf(Date);
    expect(mockAudit.mock.calls[0][0].metadata).toEqual({ changed: { cost_block: { from_chars: 0, to_chars: 47 } } });
    const cleared = await rateReview.updateConfig({ patch: { cost_block: '' }, actorId: ADMIN, dbh: db });
    expect(cleared.config).toMatchObject({ cost_block: '', cost_block_set_at: null, cost_block_set_by: null });
  });

  test('an unchanged patch writes and audits nothing', async () => {
    const db = fakeDb(seed());
    const out = await rateReview.updateConfig({ patch: { pass_through_pct: 3.5, cost_block: '' }, actorId: ADMIN, dbh: db });
    expect(out).toMatchObject({ ok: true, changed: {} });
    expect(db.tables.rate_review_config[0].updated_by).toBeNull();
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test('validation: unknown keys, negatives, over-100 percentages, fractional integers, an oversized cost block, B tolerance above C max', async () => {
    const db = fakeDb(seed());
    const bad = await rateReview.updateConfig({ patch: { bogus: 1, cap_pct: 150, lock_months: 1.5, min_delta_cents: -1, cost_block: 'x'.repeat(4001) }, dbh: db });
    expect(bad.ok).toBe(false);
    expect(bad.errors).toEqual(expect.arrayContaining([
      'bogus is not a rate review setting', 'cap_pct must be at most 100', 'lock_months must be a whole number',
      'min_delta_cents must be at least 1', 'cost_block must be at most 4000 characters',
    ]));
    expect(await rateReview.updateConfig({ patch: {}, dbh: db })).toMatchObject({ ok: false, errors: ['Nothing to change'] });
    expect(await rateReview.updateConfig({ patch: { min_delta_cents: 0 }, dbh: db })).toMatchObject({ ok: false, errors: ['min_delta_cents must be at least 1'] });
    // a zero floor would let the ranking prefer an empty not-home sample over the account's home visits
    expect(await rateReview.updateConfig({ patch: { min_usable_visits: 0 }, dbh: db })).toMatchObject({ ok: false, errors: ['min_usable_visits must be at least 1'] });
    expect(await rateReview.updateConfig({ patch: { band_b_tolerance_pct: 15 }, dbh: db })).toMatchObject({ ok: false, errors: ['Band B tolerance must not exceed the band C maximum'] });
    expect(await rateReview.updateConfig({ patch: [1], dbh: db })).toMatchObject({ ok: false });
    expect(db.tables.rate_review_config[0]).toMatchObject({ ...CONFIG_ROW });
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test('a missing config row is created from the defaults plus the patch', async () => {
    const empty = seed();
    empty.rate_review_config = [];
    const db = fakeDb(empty);
    const out = await rateReview.updateConfig({ patch: { lock_months: 18 }, actorId: ADMIN, dbh: db });
    expect(out.ok).toBe(true);
    expect(db.tables.rate_review_config[0]).toMatchObject({ id: 1, lock_months: 18, pass_through_pct: 3.5, cap_cents: 1500, updated_by: ADMIN });
  });
});

// ── an owner's skip never carries forward ───────────────────────────────

describe('selectReviewEntries vs admin_skipped', () => {
  test('a line whose latest snapshot the owner skipped is not carried into the next batch; a ranking skip still is', () => {
    const { selectReviewEntries } = rateReview._private;
    const customer = { id: CUST(1), member_since: '2024-03-10', created_at: '2024-03-10T12:00:00Z' };
    const entry = () => ({ customer, familyKey: 'pest_control', first: { completed_dates: ['2024-03-15'], first_visit: '2024-03-15' }, acceptedAt: null, visitsPerYear: 4 });
    const latest = (flags) => new Map([[`${CUST(1)}|pest_control`, { status: 'skipped', review_date: '2027-01-10', batch_key: '2027-01', computed_at: '2026-12-01T11:20:00Z', flags: JSON.stringify(flags) }]]);
    const args = { from: '2027-02-05', to: '2027-03-07', now: new Date('2027-01-31T11:20:00Z'), firstVisits: null };
    const carried = selectReviewEntries([entry()], { ...args, latestByLine: latest([]) });
    expect(carried.map((e) => e.carriedFrom)).toEqual(['2027-01']);
    const owned = selectReviewEntries([entry()], { ...args, latestByLine: latest(['admin_skipped']) });
    expect(owned).toEqual([]);
  });

  test('consecutive windows share their boundary day: the occurrence the owner skipped is not listed again, a new occurrence is', () => {
    const { selectReviewEntries } = rateReview._private;
    // first visit 2026-01-05 → anniversary 2027-01-05, in both the Dec 6–Jan 5 and the Jan 5–Feb 4 windows
    const customer = { id: CUST(1), member_since: '2026-01-05', created_at: '2026-01-05T12:00:00Z' };
    const entry = () => ({ customer, familyKey: 'pest_control', first: { completed_dates: ['2026-01-05'], first_visit: '2026-01-05' }, acceptedAt: null, visitsPerYear: 4 });
    const latest = (reviewDate, flags) => new Map([[`${CUST(1)}|pest_control`, { status: 'skipped', review_date: reviewDate, batch_key: '2026-12', computed_at: '2026-11-01T11:20:00Z', flags: JSON.stringify(flags) }]]);
    const args = { from: '2027-01-05', to: '2027-02-04', now: new Date('2026-12-01T11:20:00Z'), firstVisits: null };
    // the same occurrence, skipped by the owner in the previous batch → not listed again
    expect(selectReviewEntries([entry()], { ...args, latestByLine: latest('2027-01-05', ['admin_skipped']) })).toEqual([]);
    // the same occurrence skipped by the ranking (no owner decision) → listed, as before
    expect(selectReviewEntries([entry()], { ...args, latestByLine: latest('2027-01-05', []) }).map((e) => e.reviewDate)).toEqual(['2027-01-05']);
    // an owner skip of an EARLIER occurrence never hides the new one
    expect(selectReviewEntries([entry()], { ...args, latestByLine: latest('2026-01-05', ['admin_skipped']) }).map((e) => e.reviewDate)).toEqual(['2027-01-05']);
  });
});

// ── a decided batch is never recomputed ─────────────────────────────────

describe('rebuild vs decisions', () => {
  function useModuleDb(fake) {
    db.mockImplementation((table) => fake(table));
    db.transaction.mockImplementation((fn) => fake.transaction(fn));
    db.raw.mockImplementation(async () => { throw new Error('no build SQL expected'); });
  }

  test('buildBatch refuses a batch with approved rows before any ranking query runs; the ranking pins no transaction', async () => {
    const approved = seed();
    approved.rate_review_snapshots[0].status = 'approved';
    const fake = fakeDb(approved);
    useModuleDb(fake);
    const out = await rateReview.buildBatch({ batchKey: '2027-01' });
    expect(out).toEqual({ ok: false, reason: 'batch_has_approved_rows', batchKey: '2027-01' });
    expect(db.raw).not.toHaveBeenCalled();
    // The early refusal is a plain read: no transaction, no lock — the ranking
    // runs on the pool and only the write (below) takes the batch lock.
    expect(fake.transactions).toHaveLength(0);
    expect(fake.raw).not.toHaveBeenCalled();
    const sent = seed();
    sent.rate_review_snapshots[0].status = 'sent';
    useModuleDb(fakeDb(sent));
    expect(await rateReview.buildBatch({ batchKey: '2027-01' })).toMatchObject({ ok: false, reason: 'batch_has_sent_rows' });
  });

  test('the write judges the rows again under the batch lock: an edit that landed during the ranking refuses the rebuild; otherwise the undecided rows are replaced', async () => {
    const { commitBatchRows, batchRowsForDigest } = rateReview._private;
    const fake = fakeDb(seed());
    const before = rateReview.batchDigest(await batchRowsForDigest(fake, '2027-01'));
    const ranked = [snapshot(ROW_NEW, { customer_id: CUST(5), flags: [] })];
    const commit = (expectedDigest) => commitBatchRows(fake, {
      batchKey: '2027-01', expectedDigest, rows: ranked, computedAt: new Date('2026-12-01T11:20:00Z'),
      batch: { window_from: '2027-01-01', window_to: '2027-01-31', allowances: '{}', config: '{}', line_rph: '{}', book_lines: 1 },
    });
    // an edit lands after the ranking read the rows → refused, nothing replaced, the edit stands
    fake.tables.rate_review_snapshots.find((r) => r.id === ROW_A).proposed_rate_cents = 11200;
    let start = fake.reads.length;
    expect(await commit(before)).toEqual({ refused: 'batch_changed' });
    expect(fake.tables.rate_review_snapshots.map((r) => r.id).sort()).toEqual([ROW_A, ROW_B, ROW_C, ROW_D].sort());
    expect(fake.tables.rate_review_snapshots.find((r) => r.id === ROW_A).proposed_rate_cents).toBe(11200);
    expect(fake.transactions).toHaveLength(1);
    expect(fake.raw).toHaveBeenCalledWith('SELECT pg_advisory_xact_lock(hashtext(?))', ['rate_review_batch:2027-01']);
    expect(fake.reads.slice(start).every((r) => r.inTx)).toBe(true);
    // the rows as the ranking saw them → the undecided rows are replaced and the batch row is upserted
    start = fake.reads.length;
    expect(await commit(rateReview.batchDigest(await batchRowsForDigest(fake, '2027-01')))).toEqual({ refused: null });
    expect(fake.tables.rate_review_snapshots.map((r) => r.id)).toEqual([ROW_NEW]);
    expect(fake.tables.rate_review_snapshots.find((r) => r.id === ROW_NEW)).toMatchObject({ flags: '[]', computed_at: new Date('2026-12-01T11:20:00Z') });
    expect(fake.tables.rate_review_batches).toHaveLength(1);
    expect(fake.tables.rate_review_batches[0]).toMatchObject({ batch_key: '2027-01', window_from: '2027-01-01', book_lines: 1, email_sent_at: null, email_subject: null });
    expect(fake.reads.slice(start + 1).every((r) => r.inTx)).toBe(true); // slice past the digest read made here, outside
  });

  test('a retried monthly tick re-delivers a batch the owner edited instead of rebuilding over the edits', async () => {
    const edited = seed(); // built on day 1, digest not delivered, one amount edited from the screen since
    edited.rate_review_snapshots[0].flags = JSON.stringify(['admin_edited']);
    edited.rate_review_snapshots[0].proposed_rate_cents = 11200;
    const fake = fakeDb(edited);
    useModuleDb(fake);
    const out = await rateReview.runMonthlyRateReview({ now: new Date('2027-01-05T11:20:00Z'), dbh: fake });
    expect(out).toMatchObject({ ok: true, batchKey: '2027-01', rows: 4, rebuilt: false, emailed: true });
    expect(db.raw).not.toHaveBeenCalled(); // no ranking query ran
    // nothing was replaced: no lock taken, the only transaction is the digest's repeatable read
    expect(fake.raw).not.toHaveBeenCalledWith('SELECT pg_advisory_xact_lock(hashtext(?))', expect.anything());
    expect(fake.transactions).toEqual([{ isolationLevel: 'repeatable read' }]);
    expect(fake.tables.rate_review_snapshots.find((r) => r.id === ROW_A)).toMatchObject({ proposed_rate_cents: 11200, flags: JSON.stringify(['admin_edited']) });
    expect(fake.tables.rate_review_batches[0].email_sent_at).toBeTruthy(); // the delivery was retried and stamped
    expect(await rateReview._private.batchOwnerDecisions(fake, '2027-01')).toEqual({ decided: true, rows: 4 });
    // a batch the ranking alone produced (no owner decision) still rebuilds on a retry
    expect(await rateReview._private.batchOwnerDecisions(fakeDb(seed()), '2027-01')).toEqual({ decided: false, rows: 4 });
  });

  test('a retried monthly tick never recomputes a batch the owner approved (the ranking\u2019s own retry keeps an unsent batch\u2019s window)', async () => {
    const approved = seed(); // the January 2027 build month's batch, approved, not yet emailed
    approved.rate_review_snapshots[0].status = 'approved';
    const fake = fakeDb(approved);
    useModuleDb(fake);
    const out = await rateReview.runMonthlyRateReview({ now: new Date('2027-01-05T11:20:00Z'), dbh: fake });
    // an approval is the owner's decision: the batch stands, only the digest is (re)delivered
    expect(out).toMatchObject({ ok: true, batchKey: '2027-01', rebuilt: false, emailed: true });
    expect(db.raw).not.toHaveBeenCalled();
    expect(fake.tables.rate_review_snapshots.find((r) => r.id === ROW_A)).toMatchObject({ status: 'approved', proposed_rate_cents: 11700 });
  });
});

// ── the ops digest after an approval ────────────────────────────────────

describe('composeBatchEmail with approved rows', () => {
  test('approved rows get their own section and total; the subject and the "if all approved" figure count pending green only', () => {
    const rows = seed().rate_review_snapshots.map((r) => ({ ...r, flags: [], customer_name: `Fixture ${r.id.slice(0, 1)}` }));
    rows[0].status = 'approved'; // ROW_A, +$48/yr, now a decision
    const summary = rateReview._private.summarizeRows(rows);
    const out = rateReview.composeBatchEmail({ batchKey: '2027-01', rows, summary });
    expect(out.subject).toBe('ACT: Rate review — January 2027 batch · 1 green · 1 exception · +$36/yr');
    expect(out.text).toContain('1 green (+$36/yr if all approved), 1 approved (+$48/yr, waiting to send), 1 held out as exceptions');
    expect(out.text).toContain('APPROVED — waiting to send (1)');
    expect(out.text).toContain('GREEN — proposed increases (1)');
    expect(out.text).toContain('Nothing has been sent to a customer');
    expect(out.html).toContain('APPROVED — waiting to send (1)');
    expect(out.headline).toBe('Rate review — January 2027: 1 green, 1 exceptions, 1 approved');
    expect(out.summary).toBe('+$36/yr proposed across 1 accounts; 1 need a look. 1 approved (+$48/yr) wait to send.');
    // Everything approved and nothing left to decide: OK, with the approved count.
    const done = rows.map((r) => (r.status === 'green' || r.status === 'exception' ? { ...r, status: 'approved' } : r));
    const quiet = rateReview.composeBatchEmail({ batchKey: '2027-01', rows: done, summary: rateReview._private.summarizeRows(done) });
    expect(quiet.subject).toBe('OK: Rate review — January 2027 batch: nothing to decide (3 approved, 1 no-change, 0 skipped)');
    expect(quiet.text).toContain('APPROVED — waiting to send (3)');
  });
});

// ── email resend ────────────────────────────────────────────────────────

describe('sendBatchEmail channel', () => {
  test('reports in_app when the ops digest landed on the bell instead of the inbox', async () => {
    const db = fakeDb(seed());
    const out = await rateReview.sendBatchEmail({ batchKey: '2027-01', dbh: db });
    expect(out).toMatchObject({ sent: true, channel: 'in_app', rows: 4 });
    expect(deliverOpsDigest).toHaveBeenCalledWith(expect.objectContaining({ key: 'rate-review', link: '/admin/pricing-logic?area=rate-review&batch=2027-01' }));
    expect(db.tables.rate_review_batches[0].email_sent_at).toBeInstanceOf(Date);
  });
});

// ── the build's recoverable reads ───────────────────────────────────────

describe('loadReviewFacts', () => {
  test('the facts and signal reads, which recover from a failed statement, run on the pool — never on the build transaction', async () => {
    const trx = fakeDb(seed());
    trx.isTransaction = true;
    const pool = fakeDb(seed());
    const dbModule = require('../models/db');
    dbModule.mockImplementation((table) => pool(table));
    dbModule.raw.mockImplementation((...args) => pool.raw(...args));
    try {
      const out = await rateReview._private.loadReviewFacts(trx, [{ customer: { id: CUST(1) } }], { now: new Date('2026-12-01T12:00:00Z'), config: { exception_callback_days: 90 }, batchKey: '2027-01' });
      expect(out.priorReviews).toBeInstanceOf(Set);
      expect(out.signalsByCustomer.get(CUST(1))).toBeDefined();
      // The prior-review read (no recovery) stays on the transaction; nothing else runs there —
      // a failed statement there would abort the whole build (PostgreSQL ignores the rest of the block).
      expect(trx.reads.map((r) => r.table)).toEqual(['rate_review_snapshots']);
      expect(trx.raw).not.toHaveBeenCalled();
      // Every signal read — the raw callback count included — and the facts fan-out went to the pool.
      expect(pool.reads.map((r) => r.table)).toEqual(expect.arrayContaining(['cancellation_cases', 'retention_offers', 'plan_holds']));
      expect(pool.raw).toHaveBeenCalled();
    } finally {
      dbModule.mockImplementation(() => { throw new Error('inject a fake db'); });
      dbModule.raw.mockReset();
    }
  });
});
