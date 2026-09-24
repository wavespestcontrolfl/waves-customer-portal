/**
 * consultation-outcomes.js — the won/warm/cold/lost record on a Waves
 * Assessment (consultation) visit.
 *
 * Mock-db pattern (assessment-booking-not-won.test.js): a small in-memory
 * table shim stands in for knex so the query SHAPES exercised here
 * (where/whereIn/whereNull/orderBy/insert-onConflict-merge/update) are real,
 * but this is NOT a substitute for the waves-db §5b live-Postgres proof that
 * a SAVEPOINT truly isolates a failed statement from the caller's
 * transaction — no dev/preview Postgres was available in this sandbox (see
 * PR notes). What IS verified here: markWonForCustomer's own contract of
 * catching any error and returning 0 rather than throwing/propagating.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { etDateString, addETDays } = require('../utils/datetime-et');
const {
  recordOutcome,
  markWonForCustomer,
  markNoShow,
} = require('../services/consultation-outcomes');

// ---- tiny in-memory knex-shim -------------------------------------------
// Real enough to prove the ATOMIC guards (waves-db P1 fix): the ON
// CONFLICT ... WHERE and the UPDATE ... WHERE predicates are evaluated
// against the row at write time, in the same call, exactly like Postgres —
// there is no separate JS read-then-check step to race.
function pick(row, cols) {
  if (!cols.length) return row;
  const out = {};
  cols.forEach((c) => { out[c] = row[c]; });
  return out;
}

// Strip a "table." qualifier so `'consultation_outcomes.outcome'` reads the
// same field as `'outcome'` — real Postgres needs the qualifier only to
// disambiguate from `excluded.*`; our flat row objects don't have that
// ambiguity.
function resolveField(row, col) {
  const key = col.includes('.') ? col.split('.').pop() : col;
  return row[key];
}

function compare(rv, op, val) {
  if (op === '>=') return rv >= val;
  if (op === '<=') return rv <= val;
  if (op === '<>') return rv !== val;
  return rv === val;
}

function applyWhereArgs(rows, args) {
  if (args.length === 1 && typeof args[0] === 'function') {
    const clauses = { eq: [], orIn: [] };
    args[0].call({
      where(col, val) { clauses.eq.push([col, val]); return this; },
      orWhereIn(col, arr) { clauses.orIn.push([col, arr]); return this; },
    });
    return rows.filter((r) => {
      const eqMatch = clauses.eq.every(([c, v]) => resolveField(r, c) === v);
      if (eqMatch) return true;
      return clauses.orIn.some(([c, arr]) => arr.includes(resolveField(r, c)));
    });
  }
  if (args.length === 1 && typeof args[0] === 'object') {
    return rows.filter((r) => Object.entries(args[0]).every(([k, v]) => resolveField(r, k) === v));
  }
  if (args.length === 2) return rows.filter((r) => resolveField(r, args[0]) === args[1]);
  if (args.length === 3) {
    const [col, op, val] = args;
    return rows.filter((r) => compare(resolveField(r, col), op, val));
  }
  return rows;
}

function makeFakeDb(seed = {}) {
  const store = {
    scheduled_services: seed.scheduled_services || [],
    services: seed.services || [],
    leads: seed.leads || [],
    estimates: seed.estimates || [],
    consultation_outcomes: seed.consultation_outcomes || [],
  };
  let nextId = 1;

  // Evaluates a whereIn(...) subquery callback (e.g. `.whereIn('x', function () { this.select('id').from('t').where(...) })`)
  // against the SAME store, synchronously — real knex defers this to
  // Postgres; a JS shim can just resolve it immediately since nothing else
  // in these tests mutates the source table mid-query.
  function runSubquery(fn) {
    let subRows = [];
    let subCol = 'id';
    const subCtx = {
      select(...cols) { subCol = cols[0] || 'id'; return subCtx; },
      from(tbl) { subRows = store[tbl] ? [...store[tbl]] : []; return subCtx; },
      where(...args) { subRows = applyWhereArgs(subRows, args); return subCtx; },
      whereIn(col, arr) { subRows = subRows.filter((r) => arr.includes(resolveField(r, col))); return subCtx; },
    };
    fn.call(subCtx);
    return subRows.map((r) => resolveField(r, subCol));
  }

  function table(name) {
    const rows = store[name] || (store[name] = []);
    let filtered = rows;
    let insertPayload = null;

    const api = {
      where(...args) { filtered = applyWhereArgs(filtered, args); return api; },
      whereNull(col) { filtered = filtered.filter((r) => resolveField(r, col) == null); return api; },
      whereNotNull(col) { filtered = filtered.filter((r) => resolveField(r, col) != null); return api; },
      whereIn(col, valueOrFn) {
        const values = typeof valueOrFn === 'function' ? runSubquery(valueOrFn) : valueOrFn;
        filtered = filtered.filter((r) => values.includes(resolveField(r, col)));
        return api;
      },
      orderBy(col, dir = 'asc') {
        filtered = [...filtered].sort((a, b) => {
          const av = resolveField(a, col);
          const bv = resolveField(b, col);
          if (av === bv) return 0;
          const gt = av > bv;
          return dir === 'desc' ? (gt ? -1 : 1) : (gt ? 1 : -1);
        });
        return api;
      },
      select: (...cols) => Promise.resolve(filtered.map((r) => pick(r, cols))),
      first: (...cols) => Promise.resolve(filtered[0] ? pick(filtered[0], cols) : undefined),
      insert(payload) { insertPayload = { ...payload }; return api; },
      onConflict() { return api; },
      // ON CONFLICT ... DO UPDATE SET ... [WHERE ...] — matches real Postgres:
      // no conflicting row -> insert always applies, the WHERE never runs;
      // a conflicting row -> the WHERE (if any) gates whether the UPDATE
      // fires, and a blocked update returns zero rows (never throws).
      merge(fields) {
        let extraWhere = null;
        const mergeApi = {
          where(...args) { extraWhere = args; return mergeApi; },
          returning: () => {
            const idx = rows.findIndex((r) => r.scheduled_service_id === insertPayload.scheduled_service_id);
            if (idx < 0) {
              const row = { id: `gen-${nextId++}`, ...insertPayload };
              rows.push(row);
              return Promise.resolve([row]);
            }
            if (extraWhere && !applyWhereArgs([rows[idx]], extraWhere).length) {
              return Promise.resolve([]); // WHERE blocked the conflict UPDATE
            }
            rows[idx] = { ...rows[idx], ...fields };
            return Promise.resolve([rows[idx]]);
          },
        };
        return mergeApi;
      },
      ignore() {
        const idx = rows.findIndex((r) => r.scheduled_service_id === insertPayload.scheduled_service_id);
        if (idx >= 0) return { returning: () => Promise.resolve([]) };
        const row = { id: `gen-${nextId++}`, ...insertPayload };
        rows.push(row);
        return { returning: () => Promise.resolve([row]) };
      },
      returning() {
        const row = { id: `gen-${nextId++}`, ...insertPayload };
        rows.push(row);
        return Promise.resolve([row]);
      },
      update(fields) {
        filtered.forEach((r) => Object.assign(r, fields));
        const snapshot = filtered.slice();
        const result = Promise.resolve(snapshot.length);
        result.returning = () => Promise.resolve(snapshot);
        return result;
      },
    };
    return api;
  }
  table.transaction = async (fn) => fn(table);
  table.__store = store;
  return table;
}

// ---- recordOutcome --------------------------------------------------------

describe('recordOutcome — validation', () => {
  function baseDb() {
    return makeFakeDb({
      scheduled_services: [
        { id: 'visit-1', service_type: 'Waves Assessment', customer_id: 'cust-1', technician_id: 'tech-1', service_id: null },
        { id: 'visit-2', service_type: 'Quarterly Pest Control', customer_id: 'cust-2', technician_id: 'tech-2', service_id: null },
      ],
      leads: [{ id: 'lead-1', customer_id: 'cust-1', deleted_at: null, created_at: '2026-01-01' }],
    });
  }

  test('rejects a missing scheduledServiceId', async () => {
    await expect(recordOutcome({ outcome: 'warm' }, { trx: baseDb() }))
      .rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION' });
  });

  test('rejects outcome "won" directly', async () => {
    await expect(recordOutcome({ scheduledServiceId: 'visit-1', outcome: 'won' }, { trx: baseDb() }))
      .rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION' });
  });

  test('rejects an unknown outcome value', async () => {
    await expect(recordOutcome({ scheduledServiceId: 'visit-1', outcome: 'maybe' }, { trx: baseDb() }))
      .rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION' });
  });

  test('404s an unknown visit', async () => {
    await expect(recordOutcome({ scheduledServiceId: 'nope', outcome: 'warm' }, { trx: baseDb() }))
      .rejects.toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
  });

  test('409s a visit that is not a consultation', async () => {
    await expect(recordOutcome({ scheduledServiceId: 'visit-2', outcome: 'warm' }, { trx: baseDb() }))
      .rejects.toMatchObject({ statusCode: 409, code: 'NOT_CONSULTATION' });
  });

  test('lost requires a lostReason', async () => {
    await expect(recordOutcome({ scheduledServiceId: 'visit-1', outcome: 'lost' }, { trx: baseDb() }))
      .rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION' });
  });

  test('rejects an unknown lostReason', async () => {
    await expect(recordOutcome({ scheduledServiceId: 'visit-1', outcome: 'lost', lostReason: 'bad_vibes' }, { trx: baseDb() }))
      .rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION' });
  });

  test('rejects an unknown quotedCadence', async () => {
    await expect(recordOutcome({ scheduledServiceId: 'visit-1', outcome: 'warm', quotedCadence: 'decade' }, { trx: baseDb() }))
      .rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION' });
  });
});

describe('recordOutcome — success + upsert', () => {
  function seededDb() {
    return makeFakeDb({
      scheduled_services: [
        { id: 'visit-1', service_type: 'Waves Assessment', customer_id: 'cust-1', technician_id: 'tech-1', service_id: null },
      ],
      leads: [{ id: 'lead-1', customer_id: 'cust-1', deleted_at: null, created_at: '2026-01-01' }],
    });
  }

  test('derives lead_id/customer_id/technician_id from the visit and stringifies interests', async () => {
    const fakeDb = seededDb();
    const saved = await recordOutcome({
      scheduledServiceId: 'visit-1',
      outcome: 'warm',
      interests: ['mosquito', 'lawn'],
      quotedAmount: 129.5,
      quotedCadence: 'month',
      quoteNotes: 'internal only',
      recordedBy: 'Adam',
    }, { trx: fakeDb });

    expect(saved.customer_id).toBe('cust-1');
    expect(saved.technician_id).toBe('tech-1');
    expect(saved.lead_id).toBe('lead-1');
    expect(saved.outcome).toBe('warm');
    expect(JSON.parse(saved.interests)).toEqual(['mosquito', 'lawn']);
    // Default follow-up: warm = +3 ET days.
    expect(etDateString(new Date(saved.follow_up_at))).toBe(etDateString(addETDays(new Date(), 3)));
  });

  test('cold defaults follow_up_at to +30 ET days; lost has none', async () => {
    const coldSaved = await recordOutcome({ scheduledServiceId: 'visit-1', outcome: 'cold' }, { trx: seededDb() });
    expect(etDateString(new Date(coldSaved.follow_up_at))).toBe(etDateString(addETDays(new Date(), 30)));

    const lostSaved = await recordOutcome({ scheduledServiceId: 'visit-1', outcome: 'lost', lostReason: 'price' }, { trx: seededDb() });
    expect(lostSaved.follow_up_at).toBeNull();
    expect(lostSaved.lost_reason).toBe('price');
  });

  test('re-recording the same visit upserts (one row, latest values win)', async () => {
    const fakeDb = seededDb();
    await recordOutcome({ scheduledServiceId: 'visit-1', outcome: 'warm', interests: ['mosquito'] }, { trx: fakeDb });
    const second = await recordOutcome({ scheduledServiceId: 'visit-1', outcome: 'cold', interests: ['termite'] }, { trx: fakeDb });

    expect(fakeDb.__store.consultation_outcomes).toHaveLength(1);
    expect(second.outcome).toBe('cold');
    expect(JSON.parse(second.interests)).toEqual(['termite']);
  });

  test('refuses to edit a consultation that already converted (won)', async () => {
    const fakeDb = seededDb();
    fakeDb.__store.consultation_outcomes.push({
      id: 'co-1', scheduled_service_id: 'visit-1', outcome: 'won', won_via: 'closeout_booking', won_at: new Date(),
    });
    await expect(recordOutcome({ scheduledServiceId: 'visit-1', outcome: 'warm' }, { trx: fakeDb }))
      .rejects.toMatchObject({ statusCode: 409, code: 'ALREADY_WON' });
  });

  test('atomic guard (P1 fix): the ALREADY_WON guard is the ON CONFLICT ... WHERE itself, not a prior SELECT', async () => {
    const fakeDb = seededDb();
    fakeDb.__store.consultation_outcomes.push({
      id: 'co-1', scheduled_service_id: 'visit-1', outcome: 'won', won_via: 'closeout_booking', won_at: new Date(),
    });
    const tableCalls = [];
    const spyDb = (name) => { tableCalls.push(name); return fakeDb(name); };

    await expect(recordOutcome({ scheduledServiceId: 'visit-1', outcome: 'warm' }, { trx: spyDb }))
      .rejects.toMatchObject({ statusCode: 409, code: 'ALREADY_WON' });
    // The pre-fix version did `consultation_outcomes.where(...).first('outcome')`
    // BEFORE the insert/merge — a TOCTOU window a concurrent markWonForCustomer
    // could land in. Exactly one touch of consultation_outcomes now: the
    // insert/onConflict/merge/where/returning statement itself.
    expect(tableCalls.filter((n) => n === 'consultation_outcomes')).toHaveLength(1);
  });
});

describe('recordOutcome — P1-1 post-record reconciliation (the sale closed before the tech recorded the outcome)', () => {
  const SCHEDULED_DATE = '2026-09-10';
  const NOW = new Date('2026-09-23T12:00:00Z'); // 13 days after the visit

  function seededDb(overrides = {}) {
    return makeFakeDb({
      scheduled_services: [
        // created_at set to the scheduled_date itself — a real row is never
        // NULL here (NOT NULL default now()); this is the consultation's own
        // booking moment, which the (c) evidence check must exclude via the
        // isAssessmentBooking filter, not by never seeing the row.
        { id: 'visit-1', service_type: 'Waves Assessment', customer_id: 'cust-1', technician_id: 'tech-1', service_id: null, scheduled_date: SCHEDULED_DATE, created_at: new Date(`${SCHEDULED_DATE}T09:00:00Z`) },
      ],
      leads: overrides.leads || [],
      estimates: overrides.estimates || [],
      ...overrides.extraTables,
    });
  }

  test('an accepted estimate dated after the visit flips a freshly-recorded warm to won (won_via estimate_accept)', async () => {
    const fakeDb = seededDb({
      estimates: [{ id: 'est-1', customer_id: 'cust-1', status: 'accepted', accepted_at: new Date('2026-09-15T00:00:00Z') }],
    });
    const saved = await recordOutcome({ scheduledServiceId: 'visit-1', outcome: 'warm' }, { trx: fakeDb });
    expect(saved.outcome).toBe('won');
    expect(saved.won_via).toBe('estimate_accept');
    expect(new Date(saved.won_at).toISOString()).toBe(new Date('2026-09-15T00:00:00Z').toISOString());
  });

  test('a converted lead dated after the visit flips a freshly-recorded warm to won (won_via office_booking)', async () => {
    const fakeDb = seededDb({
      leads: [{ id: 'lead-1', customer_id: 'cust-1', converted_at: new Date('2026-09-16T00:00:00Z'), deleted_at: null, created_at: SCHEDULED_DATE }],
    });
    const saved = await recordOutcome({ scheduledServiceId: 'visit-1', outcome: 'warm' }, { trx: fakeDb });
    expect(saved.outcome).toBe('won');
    expect(saved.won_via).toBe('office_booking');
  });

  test('a non-assessment booking created after the visit flips a freshly-recorded warm to won (won_via office_booking); another assessment does not', async () => {
    const fakeDb = seededDb();
    fakeDb.__store.scheduled_services.push(
      { id: 'visit-2', service_type: 'Waves Assessment', customer_id: 'cust-1', created_at: new Date('2026-09-14T00:00:00Z') }, // another consultation — not a sale
      { id: 'visit-3', service_type: 'Quarterly Pest Control', customer_id: 'cust-1', created_at: new Date('2026-09-17T00:00:00Z') },
    );
    const saved = await recordOutcome({ scheduledServiceId: 'visit-1', outcome: 'warm' }, { trx: fakeDb });
    expect(saved.outcome).toBe('won');
    expect(saved.won_via).toBe('office_booking');
    expect(new Date(saved.won_at).toISOString()).toBe(new Date('2026-09-17T00:00:00Z').toISOString());
  });

  test('no qualifying evidence anywhere → stays warm', async () => {
    const fakeDb = seededDb({
      // An estimate that never got accepted, and a lead never converted —
      // neither counts.
      estimates: [{ id: 'est-1', customer_id: 'cust-1', status: 'sent', accepted_at: null }],
      leads: [{ id: 'lead-1', customer_id: 'cust-1', converted_at: null, deleted_at: null, created_at: SCHEDULED_DATE }],
    });
    const saved = await recordOutcome({ scheduledServiceId: 'visit-1', outcome: 'warm' }, { trx: fakeDb });
    expect(saved.outcome).toBe('warm');
  });

  test('evidence dated BEFORE the visit does not count (a pre-existing estimate is not this consultation\'s sale)', async () => {
    const fakeDb = seededDb({
      estimates: [{ id: 'est-1', customer_id: 'cust-1', status: 'accepted', accepted_at: new Date('2026-08-01T00:00:00Z') }],
    });
    const saved = await recordOutcome({ scheduledServiceId: 'visit-1', outcome: 'warm' }, { trx: fakeDb });
    expect(saved.outcome).toBe('warm');
  });

  test('P1-2: evidence dated in the FUTURE relative to `now` does not count', async () => {
    // Sanity companion to the markWonForCustomer future-consultation test
    // below — the upper bound applies to evidence dates here too.
    const fakeDb = seededDb({
      estimates: [{ id: 'est-1', customer_id: 'cust-1', status: 'accepted', accepted_at: new Date('2026-10-01T00:00:00Z') }],
    });
    // Freeze "now" inside recordOutcome via a fixed-clock test is not
    // available (it reads `new Date()` internally), so this proves the
    // window arithmetic directly: an estimate accepted well after today
    // must not be picked up by a call made "today".
    jest.useFakeTimers().setSystemTime(NOW);
    try {
      const saved = await recordOutcome({ scheduledServiceId: 'visit-1', outcome: 'warm' }, { trx: fakeDb });
      expect(saved.outcome).toBe('warm');
    } finally {
      jest.useRealTimers();
    }
  });
});

// ---- markWonForCustomer ----------------------------------------------------

describe('markWonForCustomer', () => {
  const NOW = new Date('2026-09-23T12:00:00Z');

  function seededDb() {
    return makeFakeDb({
      scheduled_services: [
        // Within the 90-day window (customer-linked).
        { id: 'visit-recent', scheduled_date: etDateString(addETDays(NOW, -10)) },
        // Outside the 90-day window.
        { id: 'visit-old', scheduled_date: etDateString(addETDays(NOW, -200)) },
        // Within window, linked through a LEAD rather than customer_id directly.
        { id: 'visit-lead', scheduled_date: etDateString(addETDays(NOW, -5)) },
        // Within window, but already resolved lost — must not be re-touched.
        { id: 'visit-already-lost', scheduled_date: etDateString(addETDays(NOW, -3)) },
        // P1-2: scheduled NEXT WEEK — a booking landing today must not win it.
        { id: 'visit-future', scheduled_date: etDateString(addETDays(NOW, 7)) },
      ],
      leads: [{ id: 'lead-9', customer_id: 'cust-1' }],
      consultation_outcomes: [
        { id: 'co-recent', scheduled_service_id: 'visit-recent', customer_id: 'cust-1', lead_id: null, outcome: 'warm' },
        { id: 'co-old', scheduled_service_id: 'visit-old', customer_id: 'cust-1', lead_id: null, outcome: 'cold' },
        { id: 'co-lead', scheduled_service_id: 'visit-lead', customer_id: null, lead_id: 'lead-9', outcome: 'warm' },
        { id: 'co-already-lost', scheduled_service_id: 'visit-already-lost', customer_id: 'cust-1', lead_id: null, outcome: 'lost' },
        { id: 'co-future', scheduled_service_id: 'visit-future', customer_id: 'cust-1', lead_id: null, outcome: 'warm' },
      ],
    });
  }

  test('wins every warm/cold row for the customer or its leads within 90 days; leaves older/lost rows alone', async () => {
    const fakeDb = seededDb();
    const count = await markWonForCustomer('cust-1', { via: 'office_booking', trx: fakeDb, now: NOW });
    expect(count).toBe(2); // co-recent + co-lead; co-old is outside the window

    const byId = Object.fromEntries(fakeDb.__store.consultation_outcomes.map((r) => [r.id, r]));
    expect(byId['co-recent'].outcome).toBe('won');
    expect(byId['co-recent'].won_via).toBe('office_booking');
    expect(byId['co-recent'].won_at).toBe(NOW);
    expect(byId['co-lead'].outcome).toBe('won');
    expect(byId['co-old'].outcome).toBe('cold'); // untouched — outside the window
    expect(byId['co-already-lost'].outcome).toBe('lost'); // untouched — not warm/cold
    expect(byId['co-future'].outcome).toBe('warm'); // untouched — visit is scheduled AFTER today
  });

  test('P1-2: a consultation scheduled next week stays warm when a booking lands today (upper bound on the window)', async () => {
    const fakeDb = seededDb();
    const count = await markWonForCustomer('cust-1', { via: 'office_booking', trx: fakeDb, now: NOW });
    const coFuture = fakeDb.__store.consultation_outcomes.find((r) => r.id === 'co-future');
    expect(coFuture.outcome).toBe('warm');
    expect(coFuture.won_at).toBeUndefined();
    // Sanity: it's excluded from the count too, not just left with stale
    // fields — 2 is co-recent + co-lead only (asserted in detail above).
    expect(count).toBe(2);
  });

  test('idempotent — a second call finds nothing left to win', async () => {
    const fakeDb = seededDb();
    await markWonForCustomer('cust-1', { via: 'office_booking', trx: fakeDb, now: NOW });
    const second = await markWonForCustomer('cust-1', { via: 'office_booking', trx: fakeDb, now: NOW });
    expect(second).toBe(0);
  });

  test('missing customerId/via/trx short-circuits to 0 with no writes', async () => {
    const fakeDb = seededDb();
    expect(await markWonForCustomer(null, { via: 'office_booking', trx: fakeDb, now: NOW })).toBe(0);
    expect(await markWonForCustomer('cust-1', { trx: fakeDb, now: NOW })).toBe(0);
    expect(await markWonForCustomer('cust-1', { via: 'office_booking', now: NOW })).toBe(0);
    // Nothing in the fixture should have moved to 'won'.
    expect(fakeDb.__store.consultation_outcomes.some((r) => r.outcome === 'won')).toBe(false);
  });

  test('best-effort: a failure inside the savepoint body is swallowed, never thrown (waves-db §5b contract)', async () => {
    const fakeDb = seededDb();
    fakeDb.transaction = async () => { throw new Error('savepoint boom'); };
    await expect(markWonForCustomer('cust-1', { via: 'office_booking', trx: fakeDb, now: NOW }))
      .resolves.toBe(0);
  });

  test('atomic guard (P1 fix): the outcome + 90-day window are one UPDATE statement, not a SELECT-candidates-then-update TOCTOU', async () => {
    const fakeDb = seededDb();
    const tableCalls = [];
    const spyDb = (name) => { tableCalls.push(name); return fakeDb(name); };
    spyDb.transaction = async (fn) => fn(spyDb);

    const count = await markWonForCustomer('cust-1', { via: 'office_booking', trx: spyDb, now: NOW });
    expect(count).toBe(2);
    // Exactly one touch of consultation_outcomes (the atomic UPDATE) — the
    // pre-fix version made a SEPARATE `select('id','scheduled_service_id')`
    // read of consultation_outcomes before ever writing, which is the
    // TOCTOU window a concurrent recordOutcome/markNoShow could land in.
    // scheduled_services is never queried as a standalone step either — its
    // 90-day check rides inside the UPDATE's WHERE as a subquery.
    expect(tableCalls.filter((n) => n === 'consultation_outcomes')).toHaveLength(1);
    expect(tableCalls.filter((n) => n === 'scheduled_services')).toHaveLength(0);
    expect(tableCalls).toEqual(['leads', 'consultation_outcomes']);

    // And the guard is real, not just "fewer calls": a row whose outcome is
    // NOT warm/cold at UPDATE time is provably excluded by the same
    // statement (see the 'leaves older/lost rows alone' case above) —
    // there is no separate JS branch that could diverge from the WHERE.
    const byId = Object.fromEntries(fakeDb.__store.consultation_outcomes.map((r) => [r.id, r]));
    expect(byId['co-already-lost'].outcome).toBe('lost');
  });
});

// ---- markNoShow -------------------------------------------------------------

describe('markNoShow', () => {
  function seededDb(extraOutcomes = []) {
    return makeFakeDb({
      scheduled_services: [
        { id: 'visit-1', service_type: 'Waves Assessment', customer_id: 'cust-1', technician_id: 'tech-1', service_id: null },
        { id: 'visit-2', service_type: 'Quarterly Pest Control', customer_id: 'cust-2', technician_id: 'tech-2', service_id: null },
      ],
      leads: [{ id: 'lead-1', customer_id: 'cust-1', deleted_at: null, created_at: '2026-01-01' }],
      consultation_outcomes: extraOutcomes,
    });
  }

  test('no-op for a non-consultation visit', async () => {
    const fakeDb = seededDb();
    const result = await markNoShow('visit-2', { trx: fakeDb });
    expect(result).toBeNull();
    expect(fakeDb.__store.consultation_outcomes).toHaveLength(0);
  });

  test('no-op for an unknown visit', async () => {
    expect(await markNoShow('nope', { trx: seededDb() })).toBeNull();
  });

  test('writes a fresh lost/no_show row when none exists', async () => {
    const fakeDb = seededDb();
    const result = await markNoShow('visit-1', { trx: fakeDb });
    expect(result.outcome).toBe('lost');
    expect(result.lost_reason).toBe('no_show');
    expect(result.customer_id).toBe('cust-1');
    expect(result.lead_id).toBe('lead-1');
    expect(result.recorded_by).toBe('system:no_show');
  });

  test('overwrites an open warm/cold outcome to lost/no_show', async () => {
    const fakeDb = seededDb([{ id: 'co-1', scheduled_service_id: 'visit-1', outcome: 'warm', won_via: null }]);
    const result = await markNoShow('visit-1', { trx: fakeDb });
    expect(result.outcome).toBe('lost');
    expect(result.lost_reason).toBe('no_show');
    expect(result.won_via).toBeNull();
    expect(fakeDb.__store.consultation_outcomes).toHaveLength(1);
  });

  test('leaves an already-lost outcome untouched', async () => {
    const fakeDb = seededDb([{ id: 'co-1', scheduled_service_id: 'visit-1', outcome: 'lost', lost_reason: 'price' }]);
    const result = await markNoShow('visit-1', { trx: fakeDb });
    expect(result.lost_reason).toBe('price'); // unchanged, not re-stamped 'no_show'
  });

  test('leaves an already-won outcome untouched', async () => {
    const fakeDb = seededDb([{ id: 'co-1', scheduled_service_id: 'visit-1', outcome: 'won', won_via: 'closeout_booking' }]);
    const result = await markNoShow('visit-1', { trx: fakeDb });
    expect(result.outcome).toBe('won');
    expect(result.won_via).toBe('closeout_booking');
  });

  test('atomic guard (P1 fix): overwriting an open row is one UPDATE ... WHERE outcome IN (warm, cold), not a read-then-write', async () => {
    const fakeDb = seededDb([{ id: 'co-1', scheduled_service_id: 'visit-1', outcome: 'warm', won_via: null }]);
    const tableCalls = [];
    const spyDb = (name) => { tableCalls.push(name); return fakeDb(name); };

    const result = await markNoShow('visit-1', { trx: spyDb });
    expect(result.outcome).toBe('lost');
    // The pre-fix version read the existing row first, branched in JS, THEN
    // issued a plain `.where({id}).update(...)` with no outcome re-check —
    // a TOCTOU window a concurrent markWonForCustomer could win. Now: one
    // scheduled_services read (ownership/consultation check) + exactly ONE
    // consultation_outcomes touch (the atomic conditional UPDATE that both
    // applies the change AND returns the updated row — no separate read).
    expect(tableCalls.filter((n) => n === 'scheduled_services')).toHaveLength(1);
    expect(tableCalls.filter((n) => n === 'consultation_outcomes')).toHaveLength(1);
  });

  test('atomic guard: an already-won row is left alone by the same single UPDATE (no separate read decides it)', async () => {
    const fakeDb = seededDb([{ id: 'co-1', scheduled_service_id: 'visit-1', outcome: 'won', won_via: 'closeout_booking' }]);
    const tableCalls = [];
    const spyDb = (name) => { tableCalls.push(name); return fakeDb(name); };

    const result = await markNoShow('visit-1', { trx: spyDb });
    expect(result.outcome).toBe('won');
    // Two consultation_outcomes touches here IS expected and correct: the
    // conditional UPDATE (0 rows — outcome isn't warm/cold) plus the
    // documented read-only fallback that returns the current state. That
    // fallback is not a guard (the UPDATE's WHERE already decided nothing
    // should change) — it only supplies the return value.
    expect(tableCalls.filter((n) => n === 'consultation_outcomes')).toHaveLength(2);
  });
});
