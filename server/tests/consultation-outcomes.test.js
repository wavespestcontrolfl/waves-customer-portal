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

const { etDateString, addETDays, parseETDateTime } = require('../utils/datetime-et');
const {
  recordOutcome,
  markWonForCustomer,
  reconcileOpenConsultationOutcomes,
  markNoShow,
  consultationStats,
  isQualifyingSaleBooking,
} = require('../services/consultation-outcomes');
// reconcileOpenConsultationOutcomes (round 10) reads the module-level `db`
// singleton directly — every other function here takes `trx` as a param
// instead, so this is the only describe block that installs a fake
// implementation onto the mocked module rather than passing one in.
const db = require('../models/db');
const {
  VOICE_AGENT_BOOKING_SOURCE_ACTION,
  CALL_OUTBOUND_REVIEW_SOURCE_ACTION,
} = require('../services/call-booking-source-actions');

// ---- tiny in-memory knex-shim -------------------------------------------
// Real enough to prove the ATOMIC guards (waves-db P1 fix): the ON
// CONFLICT ... WHERE and the UPDATE ... WHERE predicates are evaluated
// against the row at write time, in the same call, exactly like Postgres —
// there is no separate JS read-then-check step to race.
// Supports plain names ('outcome'), a table-prefixed name whose result key
// is just the field ('ss.scheduled_date' -> scheduled_date), and an
// explicit alias ('co.id as outcome_id' -> outcome_id) — the three shapes
// reconcileOpenConsultationOutcomes' join select uses (real knex resolves
// all three the same way).
function pick(row, cols) {
  if (!cols.length) return row;
  const out = {};
  cols.forEach((c) => {
    const parts = c.split(' ');
    const source = parts[0];
    const alias = parts.length >= 3 ? parts[2] : null;
    const fieldKey = source.includes('.') ? source.split('.').pop() : source;
    out[alias || fieldKey] = row[fieldKey];
  });
  return out;
}

// Strip a "table." qualifier so `'consultation_outcomes.outcome'` reads the
// same field as `'outcome'` — real Postgres needs the qualifier only to
// disambiguate from `excluded.*`; our flat row objects don't have that
// ambiguity.
function resolveField(row, col) {
  // The no-show repair's ss-rooted source keeps the LEFT-joined outcome's id
  // apart from the visit's own id (whereNull('co.id') = "no outcome row").
  if (col === 'co.id' && row && Object.prototype.hasOwnProperty.call(row, '__coId')) return row.__coId;
  const key = col.includes('.') ? col.split('.').pop() : col;
  return row[key];
}

// whereRaw shim for the one raw shape these queries use:
// lower(trim(<alias>.<col>)) = '<literal>'
function rawPredicate(sql) {
  const m = /lower\(trim\(\w+\.(\w+)\)\)\s*=\s*'([^']*)'/.exec(sql);
  if (!m) return () => false;
  return (r) => String(r[m[1]] == null ? '' : r[m[1]]).trim().toLowerCase() === m[2];
}

// A grouped where(fn) callback as OR-of-AND-chains, recursing into nested
// groups — enough for knex's where/orWhere/whereIn/orWhereIn/whereNull/
// whereNotNull/whereRaw/orWhereRaw builder shapes used by the service.
function groupPredicate(fn) {
  const groups = [[]];
  const cur = () => groups[groups.length - 1];
  const argPred = (args) => (args.length === 1 && typeof args[0] === 'function'
    ? groupPredicate(args[0])
    : (r) => applyWhereArgs([r], args).length === 1);
  const ctx = {
    where(...args) { cur().push(argPred(args)); return ctx; },
    orWhere(...args) { groups.push([argPred(args)]); return ctx; },
    whereIn(col, arr) { cur().push((r) => arr.includes(resolveField(r, col))); return ctx; },
    orWhereIn(col, arr) { groups.push([(r) => arr.includes(resolveField(r, col))]); return ctx; },
    whereNull(col) { cur().push((r) => resolveField(r, col) == null); return ctx; },
    whereNotNull(col) { cur().push((r) => resolveField(r, col) != null); return ctx; },
    whereRaw(sql) { cur().push(rawPredicate(sql)); return ctx; },
    orWhereRaw(sql) { groups.push([rawPredicate(sql)]); return ctx; },
    // SQL `<>`: a NULL column never matches either way.
    whereNot(col, val) { cur().push((r) => resolveField(r, col) != null && resolveField(r, col) !== val); return ctx; },
    orWhereNot(col, val) { groups.push([(r) => resolveField(r, col) != null && resolveField(r, col) !== val]); return ctx; },
    orWhereNull(col) { groups.push([(r) => resolveField(r, col) == null]); return ctx; },
  };
  fn.call(ctx);
  return (r) => groups.some((g) => g.length > 0 && g.every((pred) => pred(r)));
}

function compare(rv, op, val) {
  if (op === '>=') return rv >= val;
  if (op === '<=') return rv <= val;
  if (op === '<>') return rv !== val;
  return rv === val;
}

function applyWhereArgs(rows, args) {
  if (args.length === 1 && typeof args[0] === 'function') {
    return rows.filter(groupPredicate(args[0]));
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
      whereNot(col, val) { subRows = subRows.filter((r) => resolveField(r, col) !== val); return subCtx; },
      whereNotIn(col, arr) { subRows = subRows.filter((r) => !arr.includes(resolveField(r, col))); return subCtx; },
    };
    fn.call(subCtx);
    return subRows.map((r) => resolveField(r, subCol));
  }

  function table(name) {
    // reconcileOpenConsultationOutcomes' sweep query is the one join this
    // shim supports — a small purpose-built row source (real knex would do
    // this with .join()) rather than a generic SQL-join engine. Every
    // chain method below then runs unmodified against the merged rows
    // (co fields win on the 'id' collision, matching that the sweep
    // selects 'co.id as outcome_id', never bare 'id').
    const rows = name === 'consultation_outcomes as co'
      ? (store.consultation_outcomes || []).map((co) => {
        const ss = (store.scheduled_services || []).find((s) => s.id === co.scheduled_service_id);
        return ss ? { ...ss, ...co } : null;
      }).filter(Boolean)
      : name === 'scheduled_services as ss'
        // repairMissedNoShowOutcomes: visits LEFT JOIN their outcome row.
        ? (store.scheduled_services || []).map((ss) => {
          const co = (store.consultation_outcomes || []).find((c) => c.scheduled_service_id === ss.id);
          return { ...ss, outcome: co ? co.outcome : null, __coId: co ? co.id : null };
        })
        : (store[name] || (store[name] = []));
    let filtered = rows;
    let insertPayload = null;

    const api = {
      join() { return api; }, // the row source above already performed the one join shape this shim supports
      leftJoin() { return api; }, // likewise — the ss-rooted row source above did the outcome join
      whereRaw(sql) { filtered = filtered.filter(rawPredicate(sql)); return api; },
      where(...args) { filtered = applyWhereArgs(filtered, args); return api; },
      whereNull(col) { filtered = filtered.filter((r) => resolveField(r, col) == null); return api; },
      whereNotNull(col) { filtered = filtered.filter((r) => resolveField(r, col) != null); return api; },
      whereNot(col, val) { filtered = filtered.filter((r) => resolveField(r, col) !== val); return api; },
      whereNotIn(col, valueOrFn) {
        const values = typeof valueOrFn === 'function' ? runSubquery(valueOrFn) : valueOrFn;
        filtered = filtered.filter((r) => !values.includes(resolveField(r, col)));
        return api;
      },
      whereIn(col, valueOrFn) {
        const values = typeof valueOrFn === 'function' ? runSubquery(valueOrFn) : valueOrFn;
        filtered = filtered.filter((r) => values.includes(resolveField(r, col)));
        return api;
      },
      // Supports both the plain `.orderBy('col', 'asc')` shape and knex's
      // multi-key `.orderBy([{ column, order, nulls }, ...])` shape (round
      // 12: reconcileOpenConsultationOutcomes' fairness ordering,
      // last_reconciled_at NULLS FIRST then recorded_at ASC) — a string
      // first arg is normalized into the same one-spec array the array
      // form uses, so every existing single-column caller is unaffected.
      orderBy(colOrSpecs, dir = 'asc') {
        const specs = Array.isArray(colOrSpecs)
          ? colOrSpecs.map((s) => ({ column: s.column, order: s.order || 'asc', nulls: s.nulls || null }))
          : [{ column: colOrSpecs, order: dir, nulls: null }];
        filtered = [...filtered].sort((a, b) => {
          for (let i = 0; i < specs.length; i += 1) {
            const spec = specs[i];
            const av = resolveField(a, spec.column);
            const bv = resolveField(b, spec.column);
            const aNull = av === null || av === undefined;
            const bNull = bv === null || bv === undefined;
            if (aNull || bNull) {
              if (aNull && bNull) continue;
              // Postgres default (no NULLS clause given): NULLS LAST for
              // ASC, NULLS FIRST for DESC — matched here for parity, but
              // every real caller in this file passes an explicit `nulls`.
              const nullsFirst = spec.nulls ? spec.nulls === 'first' : spec.order === 'desc';
              return (aNull ? nullsFirst : !nullsFirst) ? -1 : 1;
            }
            if (av === bv) continue;
            const gt = av > bv;
            return spec.order === 'desc' ? (gt ? -1 : 1) : (gt ? 1 : -1);
          }
          return 0;
        });
        return api;
      },
      limit(n) { filtered = filtered.slice(0, n); return api; },
      select: (...cols) => Promise.resolve(filtered.map((r) => pick(r, cols))),
      first: (...cols) => Promise.resolve(filtered[0] ? pick(filtered[0], cols) : undefined),
      insert(payload) { insertPayload = { ...payload }; return api; },
      // P1-A (round 5): the row-lock read (`.forNoKeyUpdate().first('id')`)
      // — a chainable no-op here, same as onConflict; the shim has no real
      // lock-conflict semantics, only the call-ORDER assertions the
      // P1-A-specific tests below build with their own spy wrapper.
      forNoKeyUpdate() { return api; },
      noWait() { api.__noWait = true; return api; },
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
        // A column reference (`sp.raw('??', ['outcome'])`) reads the row's
        // value BEFORE the update, as Postgres SET does.
        filtered.forEach((r) => {
          const resolved = {};
          for (const [k, v] of Object.entries(fields)) {
            resolved[k] = v && v.__raw ? r[v.bindings[0]] : v;
          }
          Object.assign(r, resolved);
        });
        const snapshot = filtered.slice();
        const result = Promise.resolve(snapshot.length);
        result.returning = () => Promise.resolve(snapshot);
        return result;
      },
    };
    return api;
  }
  table.transaction = async (fn) => fn(table);
  table.raw = (sql, bindings = []) => ({ __raw: true, sql, bindings });
  table.__store = store;
  return table;
}

// ---- isQualifyingSaleBooking (round 8) -------------------------------------

describe('isQualifyingSaleBooking — the ONE positive-allow-list predicate for "is this row a real, confirmed sale"', () => {
  const BASE = { status: 'confirmed', service_type: 'Quarterly Pest Control' };

  it.each([
    ['a confirmed manual booking', { ...BASE, status: 'confirmed' }, true],
    ['a plain pending booking (the default initial status for every ordinary booking — NOT itself an office-review signal)', { ...BASE, status: 'pending' }, true],
    ['a completed real visit', { ...BASE, status: 'completed' }, true],
    ['en_route', { ...BASE, status: 'en_route' }, true],
    ['on_site', { ...BASE, status: 'on_site' }, true],
    ['rescheduled', { ...BASE, status: 'rescheduled' }, true],

    ['a pending voice-agent request awaiting office review (relay-booking.js shape)', {
      ...BASE, status: 'pending', source_action: VOICE_AGENT_BOOKING_SOURCE_ACTION, customer_confirmed: false,
    }, false],
    ['a pending outbound-callback review booking (the OTHER office-review source_action)', {
      ...BASE, status: 'pending', source_action: CALL_OUTBOUND_REVIEW_SOURCE_ACTION, customer_confirmed: false,
    }, false],
    ['a voice-agent booking the office HAS confirmed (customer_confirmed true) — office confirm is what makes it real', {
      ...BASE, status: 'confirmed', source_action: VOICE_AGENT_BOOKING_SOURCE_ACTION, customer_confirmed: true,
    }, true],
    ['a plain manual booking with customer_confirmed at its schema default (false) and no office-review source_action — must NOT be disqualified by that field alone', {
      ...BASE, status: 'pending', source_action: null, customer_confirmed: false,
    }, true],

    ['cancelled', { ...BASE, status: 'cancelled' }, false],
    ['skipped', { ...BASE, status: 'skipped' }, false],
    ['no_show', { ...BASE, status: 'no_show' }, false],

    ['a free re-service callback (is_callback)', { ...BASE, is_callback: true }, false],
    ['a recurring-series child (recurring_parent_id)', { ...BASE, recurring_parent_id: 'parent-visit-0' }, false],
    ['an included $0 follow-up (followup_included)', { ...BASE, followup_included: true }, false],
    ['an always-free-by-name service type (isAlwaysFreeServiceType)', { ...BASE, service_type: 'Estimate Visit' }, false],

    // round 11: health-alerts.js's retention "free_service"/"complimentary"
    // action — exact insert shape (service_type e.g. "General Pest -
    // Complimentary" doesn't match isAlwaysFreeServiceType's fixed term
    // list, and none of the other flags are set — estimated_price:0 alone
    // is what disqualifies it).
    ['health-alerts.js complimentary $0 retention visit (estimated_price: 0, a JS number)', {
      ...BASE, service_type: 'General Pest - Complimentary', status: 'pending', estimated_price: 0,
    }, false],
    ['the same complimentary visit as Postgres would actually return it — estimated_price is a `decimal` column, so pg hands back the STRING "0.00", never the JS number 0', {
      ...BASE, service_type: 'General Pest - Complimentary', status: 'pending', estimated_price: '0.00',
    }, false],
    ['estimated_price NULL (no price stamped at insert — the common case for a real booking) still qualifies — never mistaken for a genuine zero', {
      ...BASE, estimated_price: null,
    }, true],
    ['a real non-zero estimated_price still qualifies', { ...BASE, estimated_price: '149.00' }, true],
    ['an existing member\'s covered recurring series (no price stamp, invoicing off — memberSeriesCovered) is not a new sale', {
      ...BASE, is_recurring: true, estimated_price: null, create_invoice_on_complete: false,
    }, false],
    ['a covered member visit carrying a priced add-on still qualifies', {
      ...BASE, is_recurring: true, estimated_price: '45.00', create_invoice_on_complete: false,
    }, true],
    ['a recurring booking that invoices on completion still qualifies', {
      ...BASE, is_recurring: true, estimated_price: null, create_invoice_on_complete: true,
    }, true],

    // round 11: annual-prepay-renewals.js's buildInsert — every visit it
    // seeds for a term (first-ever seed or a later renewal alike) stamps
    // annual_prepay_term_id; the term's own payment is the real sale
    // evidence (an accepted estimate, evidence type (b)), never this
    // scheduled_services insert.
    ['an annual-prepay term coverage seed (annual_prepay_term_id set)', {
      ...BASE, status: 'pending', annual_prepay_term_id: 'term-uuid-0',
    }, false],

    ['a null row', null, false],
  ])('%s → %s', (_label, row, expected) => {
    expect(isQualifyingSaleBooking(row)).toBe(expected);
  });
});

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

  // Round 12 fix (codex P1, post-push): the pre-fix guard
  // (`Number.isFinite(Number(quotedAmount))`) accepted '' (Number('')===0),
  // whitespace, booleans (Number(true)===1), negatives, and values past
  // decimal(10,2)'s range (1e9) — and wrote the RAW value through, so an
  // out-of-range save threw a raw, unmapped Postgres 22P02/numeric-overflow
  // 500 instead of a clean 400. Table-driven over exactly the values the
  // audit named.
  it.each([
    ['', 'valid', null],
    ['  ', 'valid', null],
    [true, 'invalid', undefined],
    [-1, 'invalid', undefined],
    ['abc', 'invalid', undefined],
    [1e9, 'invalid', undefined],
    ['149.50', 'valid', 149.5],
    [149.5, 'valid', 149.5],
    [null, 'valid', null],
  ])('quotedAmount %p is %s', async (quotedAmount, expectation, expectedStored) => {
    const promise = recordOutcome({ scheduledServiceId: 'visit-1', outcome: 'warm', quotedAmount }, { trx: baseDb() });
    if (expectation === 'invalid') {
      // Never a raw DB error — the guard rejects with a clean 400 before
      // any write is even attempted (these values never reach the row
      // object, let alone a query).
      await expect(promise).rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION' });
    } else {
      const saved = await promise;
      expect(saved.quoted_amount).toBe(expectedStored);
    }
  });

  test('the boundary value decimal(10,2) can actually hold (99,999,999.99) is accepted, not rejected as "beyond range"', async () => {
    const saved = await recordOutcome(
      { scheduledServiceId: 'visit-1', outcome: 'warm', quotedAmount: 99999999.99 },
      { trx: baseDb() },
    );
    expect(saved.quoted_amount).toBe(99999999.99);
  });

  test('a value one cent over the boundary (100,000,000.00) is rejected, not written raw', async () => {
    await expect(recordOutcome(
      { scheduledServiceId: 'visit-1', outcome: 'warm', quotedAmount: 100000000 },
      { trx: baseDb() },
    )).rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION' });
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

  // Codex #4710 r11 P2: a visit retyped off the assessment after the
  // unlocked check is refused under the lock.
  test('a visit retyped to an ordinary service before the lock is refused (NOT_CONSULTATION), nothing written', async () => {
    const fakeDb = seededDb();
    const spyDb = (name) => {
      if (name === 'customers') fakeDb.__store.scheduled_services[0].service_type = 'Quarterly Pest Control';
      return fakeDb(name);
    };
    Object.assign(spyDb, fakeDb);
    spyDb.transaction = async (fn) => fn(spyDb);
    await expect(recordOutcome({ scheduledServiceId: 'visit-1', outcome: 'warm' }, { trx: spyDb }))
      .rejects.toMatchObject({ code: 'NOT_CONSULTATION' });
    expect(fakeDb.__store.consultation_outcomes || []).toHaveLength(0);
  });

  test('Codex #4710 r12 P2: a technician cannot record lostReason no_show — the status transition owns it', async () => {
    await expect(recordOutcome({ scheduledServiceId: 'visit-1', outcome: 'lost', lostReason: 'no_show' }, { trx: seededDb() }))
      .rejects.toMatchObject({ code: 'VALIDATION' });
  });

  test('cold defaults follow_up_at to +30 ET days; lost has none', async () => {
    const coldSaved = await recordOutcome({ scheduledServiceId: 'visit-1', outcome: 'cold' }, { trx: seededDb() });
    expect(etDateString(new Date(coldSaved.follow_up_at))).toBe(etDateString(addETDays(new Date(), 30)));

    const lostSaved = await recordOutcome({ scheduledServiceId: 'visit-1', outcome: 'lost', lostReason: 'price' }, { trx: seededDb() });
    expect(lostSaved.follow_up_at).toBeNull();
    expect(lostSaved.lost_reason).toBe('price');
  });

  test('P1-B: a naive followUpAt string is read as ET wall-clock, not UTC', async () => {
    // Railway runs TZ=UTC — a bare `new Date('2026-09-25T09:00')` would have
    // read this as 09:00 UTC (05:00 ET), four hours early.
    const saved = await recordOutcome(
      { scheduledServiceId: 'visit-1', outcome: 'warm', followUpAt: '2026-09-25T09:00' },
      { trx: seededDb() },
    );
    expect(new Date(saved.follow_up_at).toISOString()).toBe(parseETDateTime('2026-09-25T09:00').toISOString());
    // 2026-09-25 is EDT (UTC-4): 9am ET is 13:00 UTC.
    expect(new Date(saved.follow_up_at).toISOString()).toBe('2026-09-25T13:00:00.000Z');
  });

  test('P1-B: an explicit-offset/Z followUpAt is taken as-is, not re-interpreted as ET', async () => {
    const saved = await recordOutcome(
      { scheduledServiceId: 'visit-1', outcome: 'warm', followUpAt: '2026-09-25T09:00:00Z' },
      { trx: seededDb() },
    );
    expect(new Date(saved.follow_up_at).toISOString()).toBe('2026-09-25T09:00:00.000Z');
  });

  test('Codex #4710 r13 P2: a naive followUpAt in the fall-back DST fold (occurs twice) is rejected', async () => {
    // 2026-11-01 is the November fall-back Sunday: 01:00-01:59 ET happens
    // twice (once EDT, once EST). A naive value there is ambiguous —
    // parseETDateTime would silently keep the first (EDT) occurrence,
    // which could fire the follow-up an hour earlier than typed.
    const fakeDb = seededDb();
    await expect(recordOutcome(
      { scheduledServiceId: 'visit-1', outcome: 'warm', followUpAt: '2026-11-01T01:30' },
      { trx: fakeDb },
    )).rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION' });
  });

  test('Codex #4710 r13 P2: the same fall-back hour with an explicit offset names one instant and is accepted', async () => {
    const saved = await recordOutcome(
      { scheduledServiceId: 'visit-1', outcome: 'warm', followUpAt: '2026-11-01T01:30-05:00' },
      { trx: seededDb() },
    );
    expect(new Date(saved.follow_up_at).toISOString()).toBe('2026-11-01T06:30:00.000Z');
  });

  test('Codex #4710 r13 P2: a normal naive follow-up time outside the DST fold is still accepted', async () => {
    const saved = await recordOutcome(
      { scheduledServiceId: 'visit-1', outcome: 'warm', followUpAt: '2026-11-02T09:00' },
      { trx: seededDb() },
    );
    expect(new Date(saved.follow_up_at).toISOString()).toBe(parseETDateTime('2026-11-02T09:00').toISOString());
  });

  test('P1-B: an invalid followUpAt is rejected with 400 before any write', async () => {
    const fakeDb = seededDb();
    await expect(recordOutcome(
      { scheduledServiceId: 'visit-1', outcome: 'warm', followUpAt: 'not-a-real-date' },
      { trx: fakeDb },
    )).rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION' });
    expect(fakeDb.__store.consultation_outcomes).toHaveLength(0);
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
    spyDb.transaction = async (fn) => fn(spyDb);

    await expect(recordOutcome({ scheduledServiceId: 'visit-1', outcome: 'warm' }, { trx: spyDb }))
      .rejects.toMatchObject({ statusCode: 409, code: 'ALREADY_WON' });
    // The pre-fix version did `consultation_outcomes.where(...).first('outcome')`
    // BEFORE the insert/merge — a TOCTOU window a concurrent markWonForCustomer
    // could land in. Exactly one touch of consultation_outcomes now: the
    // insert/onConflict/merge/where/returning statement itself.
    expect(tableCalls.filter((n) => n === 'consultation_outcomes')).toHaveLength(1);
  });

  test('P1-A (round 5): locks the `customers` row FOR NO KEY UPDATE FIRST, before the insert/merge (also on the ALREADY_WON path) — no advisory key', async () => {
    const fakeDb = seededDb();
    const calls = [];
    const spyDb = (name) => { calls.push({ type: 'table', name }); return fakeDb(name); };
    spyDb.transaction = async (fn) => fn(spyDb);
    // The round-4 advisory lock is gone entirely — a `.raw()` call here
    // would be a regression back toward it. Fail loudly instead of
    // silently no-op'ing so a reintroduced advisory-lock call breaks this
    // test rather than passing unnoticed.
    spyDb.raw = () => { throw new Error('unexpected trx.raw() call — the advisory lock should be gone (P1-A round 5)'); };

    await recordOutcome({ scheduledServiceId: 'visit-1', outcome: 'warm' }, { trx: spyDb });

    const customersIdx = calls.findIndex((c) => c.type === 'table' && c.name === 'customers');
    const outcomesIdx = calls.findIndex((c) => c.type === 'table' && c.name === 'consultation_outcomes');
    expect(customersIdx).toBeGreaterThanOrEqual(0);
    // The row lock precedes the write it's meant to serialize — and by
    // extension the evidence check that follows it in the same locked
    // transaction (see the reconciliation describe block below).
    expect(outcomesIdx).toBeGreaterThan(customersIdx);
  });

  test('P1-A (round 5): a deadlock-abort (SQLSTATE 40P01) on the locked transaction surfaces as a retryable 409, not an unmapped 500', async () => {
    const fakeDb = seededDb();
    const spyDb = (name) => fakeDb(name);
    spyDb.transaction = async () => {
      const err = new Error('deadlock detected');
      err.code = '40P01';
      throw err;
    };

    await expect(recordOutcome({ scheduledServiceId: 'visit-1', outcome: 'warm' }, { trx: spyDb }))
      .rejects.toMatchObject({ statusCode: 409, code: 'CONCURRENT_UPDATE' });
  });

  test('P1-A (round 5): a non-deadlock error from the locked transaction is NOT remapped — it propagates as-is', async () => {
    const fakeDb = seededDb();
    const spyDb = (name) => fakeDb(name);
    const boom = new Error('some unrelated failure');
    spyDb.transaction = async () => { throw boom; };

    await expect(recordOutcome({ scheduledServiceId: 'visit-1', outcome: 'warm' }, { trx: spyDb }))
      .rejects.toBe(boom);
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

  test('Codex #4710 r10 P2 :890: attribution uses the LOCKED visit schedule, not the pre-lock read — a dispatch move between the two reads is honored', async () => {
    const fakeDb = seededDb({
      estimates: [{ id: 'est-1', customer_id: 'cust-1', status: 'accepted', accepted_at: new Date('2026-09-07T12:00:00Z') }],
    });
    // The pre-lock read sees the OLD (stale) date; the visit is moved to
    // the NEW date the instant the customer lock fires below, simulating
    // dispatch moving it between recordOutcome's first read and the lock
    // (same injection point as the customer-merge-mid-write test above).
    fakeDb.__store.scheduled_services[0].scheduled_date = '2026-09-05';
    fakeDb.__store.scheduled_services[0].window_start = null;
    let flipped = false;
    const spyDb = (name) => {
      const q = fakeDb(name);
      if (name === 'customers' && !flipped) {
        flipped = true;
        fakeDb.__store.scheduled_services[0].scheduled_date = '2026-09-10'; // the dispatch move
      }
      return q;
    };
    spyDb.transaction = async (fn) => fn(spyDb);

    const saved = await recordOutcome({ scheduledServiceId: 'visit-1', outcome: 'warm' }, { trx: spyDb });

    // The Sept-7 acceptance precedes the consultation's REAL (moved)
    // Sept-10 date, so it is not this consultation's sale. Using the stale
    // pre-lock date (Sept-5) would have wrongly counted it as in-window
    // evidence and won this outcome.
    expect(saved.outcome).toBe('warm');
  });

  test('local audit P1: re-recording a NO-SHOWED consultation warm never wins it, even with sale evidence', async () => {
    const fakeDb = makeFakeDb({
      scheduled_services: [
        { id: 'visit-1', status: 'no_show', service_type: 'Waves Assessment', customer_id: 'cust-1', technician_id: 'tech-1', service_id: null, scheduled_date: SCHEDULED_DATE, created_at: new Date(`${SCHEDULED_DATE}T09:00:00Z`) },
      ],
      estimates: [{ id: 'est-1', customer_id: 'cust-1', status: 'accepted', accepted_at: new Date('2026-09-15T00:00:00Z') }],
      leads: [],
    });
    // Codex #4710 P2: refused outright now — a no-showed consultation's
    // outcome cannot be re-recorded at all, so it can never be won either.
    await expect(recordOutcome({ scheduledServiceId: 'visit-1', outcome: 'warm' }, { trx: fakeDb }))
      .rejects.toMatchObject({ statusCode: 409, code: 'CONSULTATION_NOT_HELD' });
    expect(fakeDb.__store.consultation_outcomes).toHaveLength(0);
  });

  test('Codex #4710 P2: the outcome keeps the lead that existed when the consultation was booked, not a later unrelated inquiry', async () => {
    const fakeDb = makeFakeDb({
      scheduled_services: [
        { id: 'visit-1', status: 'completed', service_type: 'Waves Assessment', customer_id: 'cust-1', technician_id: 'tech-1', scheduled_date: SCHEDULED_DATE, created_at: new Date('2026-09-01T12:00:00Z') },
      ],
      leads: [
        { id: 'lead-original', customer_id: 'cust-1', deleted_at: null, created_at: new Date('2026-08-30T12:00:00Z') },
        { id: 'lead-later', customer_id: 'cust-1', deleted_at: null, created_at: new Date('2026-09-15T12:00:00Z') },
      ],
    });
    const saved = await recordOutcome({ scheduledServiceId: 'visit-1', outcome: 'warm' }, { trx: fakeDb });
    expect(saved.lead_id).toBe('lead-original');
  });

  test('Codex #4710 r7 P2: an outcome for a consultation scheduled after today is refused', async () => {
    const fakeDb = makeFakeDb({
      scheduled_services: [{ id: 'visit-1', status: 'confirmed', service_type: 'Waves Assessment', customer_id: 'cust-1', technician_id: 'tech-1', scheduled_date: etDateString(addETDays(new Date(), 3)) }],
      leads: [],
    });
    await expect(recordOutcome({ scheduledServiceId: 'visit-1', outcome: 'warm' }, { trx: fakeDb }))
      .rejects.toMatchObject({ statusCode: 409, code: 'CONSULTATION_IN_FUTURE' });
  });

  test('Codex #4710 r8 P2: an outcome before today\'s arrival window opens is refused', async () => {
    const fakeDb = makeFakeDb({
      scheduled_services: [{ id: 'visit-1', status: 'confirmed', service_type: 'Waves Assessment', customer_id: 'cust-1', technician_id: 'tech-1', scheduled_date: etDateString(new Date()), window_start: '23:59' }],
      leads: [],
    });
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    jest.setSystemTime(parseETDateTime(`${etDateString(new Date())}T08:00`));
    try {
      await expect(recordOutcome({ scheduledServiceId: 'visit-1', outcome: 'warm' }, { trx: fakeDb }))
        .rejects.toMatchObject({ statusCode: 409, code: 'CONSULTATION_IN_FUTURE' });
    } finally {
      jest.useRealTimers();
    }
  });

  test('Codex #4710 P2: a technician reassigned off the visit cannot write its outcome (checked under the lock); an admin can', async () => {
    const fakeDb = makeFakeDb({
      scheduled_services: [
        { id: 'visit-1', status: 'completed', service_type: 'Waves Assessment', customer_id: 'cust-1', technician_id: 'tech-new', scheduled_date: SCHEDULED_DATE },
      ],
      leads: [],
    });
    await expect(recordOutcome({ scheduledServiceId: 'visit-1', outcome: 'warm', actingTechnicianId: 'tech-old' }, { trx: fakeDb }))
      .rejects.toMatchObject({ statusCode: 403, code: 'NOT_ASSIGNED' });
    const saved = await recordOutcome({ scheduledServiceId: 'visit-1', outcome: 'warm', actingTechnicianId: 'admin-1', actingIsAdmin: true }, { trx: fakeDb });
    expect(saved.outcome).toBe('warm');
  });

  test.each(['2026-02-31T09:00-05:00', '2026-09-25T25:00Z', '2026-04-31T10:00:00.000+00:00'])(
    'Codex #4710 r6 P2: an impossible offset/Z timestamp (%s) is rejected too',
    async (followUpAt) => {
      const fakeDb = makeFakeDb({ scheduled_services: [], leads: [] });
      await expect(recordOutcome({ scheduledServiceId: 'visit-1', outcome: 'warm', followUpAt }, { trx: fakeDb }))
        .rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION' });
    },
  );

  test('Codex #4710 r6 P2: a rescheduled (pending-rebook) consultation cannot be closed out', async () => {
    const fakeDb = makeFakeDb({
      scheduled_services: [{ id: 'visit-1', status: 'rescheduled', service_type: 'Waves Assessment', customer_id: 'cust-1', technician_id: 'tech-1', scheduled_date: SCHEDULED_DATE }],
      leads: [],
    });
    await expect(recordOutcome({ scheduledServiceId: 'visit-1', outcome: 'warm' }, { trx: fakeDb }))
      .rejects.toMatchObject({ statusCode: 409, code: 'CONSULTATION_NOT_HELD' });
  });

  test('Codex #4710 r6 P2: a customer merge that repoints the visit mid-write is retried against the surviving customer', async () => {
    const fakeDb = makeFakeDb({
      scheduled_services: [{ id: 'visit-1', status: 'completed', service_type: 'Waves Assessment', customer_id: 'cust-old', technician_id: 'tech-1', scheduled_date: SCHEDULED_DATE }],
      leads: [],
    });
    // The merge lands between the first read and the lock: flip customer_id
    // on the first locked re-read only.
    let flipped = false;
    const spyDb = (name) => {
      const q = fakeDb(name);
      if (name === 'customers' && !flipped) {
        flipped = true;
        fakeDb.__store.scheduled_services[0].customer_id = 'cust-new';
      }
      return q;
    };
    spyDb.transaction = async (fn) => fn(spyDb);
    const saved = await recordOutcome({ scheduledServiceId: 'visit-1', outcome: 'warm' }, { trx: spyDb });
    expect(saved.customer_id).toBe('cust-new');
  });

  test.each(['2026-02-31T09:00', '2026-09-25T99:99', '2026-03-08T02:30'])(
    'Codex #4710 P2: an impossible follow-up wall time (%s) is rejected, never normalized onto another day',
    async (followUpAt) => {
      const fakeDb = makeFakeDb({ scheduled_services: [], leads: [] });
      await expect(recordOutcome({ scheduledServiceId: 'visit-1', outcome: 'warm', followUpAt }, { trx: fakeDb }))
        .rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION' });
    },
  );

  // Codex #4710 r10 P2 :335: neither documented shape (naive ET, or ISO with
  // an explicit offset/Z) — the old code fell through to
  // parseETDateTime's host-UTC `new Date(...)` fallback and ACCEPTED these,
  // silently reading a free-text date as UTC (a boolean/number happened to
  // coerce to a "valid" Date too).
  test.each(['09/25/2026 09:00', true, 1758790800000])(
    'Codex #4710 r10 P2 :335: an unsupported followUpAt shape (%s) is rejected, not silently accepted',
    async (followUpAt) => {
      const fakeDb = makeFakeDb({ scheduled_services: [], leads: [] });
      await expect(recordOutcome({ scheduledServiceId: 'visit-1', outcome: 'warm', followUpAt }, { trx: fakeDb }))
        .rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION' });
    },
  );

  test('local audit P1: a converted lead whose only booking is a free Estimate Visit is NOT a win — converted_at alone is never evidence', async () => {
    const fakeDb = seededDb({
      leads: [{ id: 'lead-1', customer_id: 'cust-1', converted_at: new Date('2026-09-16T00:00:00Z'), deleted_at: null, created_at: SCHEDULED_DATE }],
      extraTables: {},
    });
    fakeDb.__store.scheduled_services.push({
      id: 'est-visit', service_type: 'Estimate Visit', customer_id: 'cust-1', status: 'confirmed', scheduled_date: '2026-09-18', created_at: new Date('2026-09-16T00:00:00Z'),
    });
    const saved = await recordOutcome({ scheduledServiceId: 'visit-1', outcome: 'warm' }, { trx: fakeDb });
    expect(saved.outcome).toBe('warm');
  });

  test('a non-assessment booking created after the visit flips a freshly-recorded warm to won (won_via office_booking); another assessment does not', async () => {
    const fakeDb = seededDb();
    fakeDb.__store.scheduled_services.push(
      { id: 'visit-2', service_type: 'Waves Assessment', customer_id: 'cust-1', created_at: new Date('2026-09-14T00:00:00Z'), status: 'pending' }, // another consultation — not a sale
      { id: 'visit-3', service_type: 'Quarterly Pest Control', customer_id: 'cust-1', created_at: new Date('2026-09-17T00:00:00Z'), status: 'confirmed' },
    );
    const saved = await recordOutcome({ scheduledServiceId: 'visit-1', outcome: 'warm' }, { trx: fakeDb });
    expect(saved.outcome).toBe('won');
    expect(saved.won_via).toBe('office_booking');
    expect(new Date(saved.won_at).toISOString()).toBe(new Date('2026-09-17T00:00:00Z').toISOString());
  });

  test('P1-B: a free re-service callback (is_callback) is NOT sale evidence — stays warm', async () => {
    const fakeDb = seededDb();
    fakeDb.__store.scheduled_services.push(
      { id: 'visit-cb', service_type: 'Pest Control Re-Service', customer_id: 'cust-1', created_at: new Date('2026-09-14T00:00:00Z'), is_callback: true },
    );
    const saved = await recordOutcome({ scheduledServiceId: 'visit-1', outcome: 'warm' }, { trx: fakeDb });
    expect(saved.outcome).toBe('warm');
  });

  test('P1-B: a recurring-series child spawned onto an EXISTING plan (recurring_parent_id set) is NOT sale evidence — stays warm', async () => {
    const fakeDb = seededDb();
    fakeDb.__store.scheduled_services.push(
      { id: 'visit-child', service_type: 'Quarterly Pest Control', customer_id: 'cust-1', created_at: new Date('2026-09-14T00:00:00Z'), is_recurring: true, recurring_parent_id: 'parent-visit-0' },
    );
    const saved = await recordOutcome({ scheduledServiceId: 'visit-1', outcome: 'warm' }, { trx: fakeDb });
    expect(saved.outcome).toBe('warm');
  });

  test('P1-B (round 8): an included $0 follow-up minted from a typed completion (followup_included) is NOT sale evidence — stays warm', async () => {
    // Exact booking shape admin-dispatch.js's POST /:serviceId/schedule-followup
    // inserts: service_type is INHERITED from the source visit (so it does
    // NOT match an always-free name pattern), is_recurring: false, no
    // recurring_parent_id, no is_callback — followup_included is the ONLY
    // signal that marks it not-a-sale.
    const fakeDb = seededDb();
    fakeDb.__store.scheduled_services.push({
      id: 'visit-followup',
      service_type: 'Quarterly Pest Control', // inherited from svc.service_type, not a free-name match
      customer_id: 'cust-1',
      created_at: new Date('2026-09-14T00:00:00Z'),
      is_recurring: false,
      followup_included: true,
      followup_source_service_id: 'some-completed-visit',
    });
    const saved = await recordOutcome({ scheduledServiceId: 'visit-1', outcome: 'warm' }, { trx: fakeDb });
    expect(saved.outcome).toBe('warm');
  });

  test('P1-B (round 8): an always-free-by-name service type (e.g. a free estimate/appointment visit) is NOT sale evidence — stays warm', async () => {
    const fakeDb = seededDb();
    fakeDb.__store.scheduled_services.push({
      id: 'visit-estimate', service_type: 'Estimate Visit', customer_id: 'cust-1', created_at: new Date('2026-09-14T00:00:00Z'),
    });
    const saved = await recordOutcome({ scheduledServiceId: 'visit-1', outcome: 'warm' }, { trx: fakeDb });
    expect(saved.outcome).toBe('warm');
  });

  test('P1-B: a genuine new booking (none of: another consultation, a callback, a recurring child, an included follow-up, an always-free name) still flips warm to won, even alongside earlier non-qualifying rows that must all be skipped', async () => {
    const fakeDb = seededDb();
    fakeDb.__store.scheduled_services.push(
      // All dated BEFORE the real sale — proves the loop doesn't just skip
      // the first non-qualifying row and stop; it keeps scanning until it
      // finds (or exhausts) real evidence.
      { id: 'visit-cb', service_type: 'Pest Control Re-Service', customer_id: 'cust-1', created_at: new Date('2026-09-11T00:00:00Z'), status: 'confirmed', is_callback: true },
      { id: 'visit-child', service_type: 'Quarterly Pest Control', customer_id: 'cust-1', created_at: new Date('2026-09-12T00:00:00Z'), status: 'confirmed', recurring_parent_id: 'parent-visit-0' },
      { id: 'visit-followup', service_type: 'Quarterly Pest Control', customer_id: 'cust-1', created_at: new Date('2026-09-13T00:00:00Z'), status: 'confirmed', followup_included: true },
      { id: 'visit-estimate', service_type: 'Estimate Visit', customer_id: 'cust-1', created_at: new Date('2026-09-14T00:00:00Z'), status: 'confirmed' },
      { id: 'visit-real', service_type: 'Quarterly Pest Control', customer_id: 'cust-1', created_at: new Date('2026-09-17T00:00:00Z'), status: 'confirmed' },
    );
    const saved = await recordOutcome({ scheduledServiceId: 'visit-1', outcome: 'warm' }, { trx: fakeDb });
    expect(saved.outcome).toBe('won');
    expect(saved.won_via).toBe('office_booking');
    expect(new Date(saved.won_at).toISOString()).toBe(new Date('2026-09-17T00:00:00Z').toISOString());
  });

  test('Codex #4710 r10 P2 :600: a non-qualifying booking (a free callback) is filtered by the cheap sync rule BEFORE any catalog (services table) lookup', async () => {
    const fakeDb = seededDb({
      extraTables: {
        // A real, non-assessment catalog row — if isAssessmentBooking's
        // async services lookup ran at all for visit-cb below, it would
        // find this row (proving the lookup happened, not merely that it
        // was harmless to skip).
        services: [{ id: 'svc-1', service_key: 'quarterly_pest_control', name: 'Quarterly Pest Control' }],
      },
    });
    fakeDb.__store.scheduled_services.push({
      id: 'visit-cb', service_type: 'Pest Control Re-Service', service_id: 'svc-1', customer_id: 'cust-1',
      created_at: new Date('2026-09-11T00:00:00Z'), status: 'confirmed', is_callback: true,
    });
    const calls = [];
    const spyDb = (name) => { calls.push(name); return fakeDb(name); };
    spyDb.transaction = async (fn) => fn(spyDb);

    const saved = await recordOutcome({ scheduledServiceId: 'visit-1', outcome: 'warm' }, { trx: spyDb });

    expect(saved.outcome).toBe('warm'); // the only candidate booking is a non-qualifying callback
    // Pre-fix, isAssessmentBooking (async, a `services` catalog query) ran
    // FIRST for every candidate row regardless of whether the cheap sync
    // rule would already reject it — a recurring series creates all its
    // children in one batch, so this could mean thousands of avoidable
    // catalog queries per sweep tick.
    expect(calls.filter((n) => n === 'services')).toHaveLength(0);
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

  test('P1-1: scheduled_date read back as a UTC-midnight Date object still bounds the window on the CORRECT calendar day', async () => {
    // pg on Railway (TZ=UTC) hands scheduled_date '2026-09-10' back as a JS
    // Date at UTC midnight, not a string. Running that Date through
    // etDateString (the bug) reads it in ET and reports '2026-09-09' — a
    // full calendar day early — which would let evidence from the day
    // BEFORE the actual visit count as "on/after the visit". Seed the visit
    // with scheduled_date as that exact Date object (all the other tests in
    // this block use a plain string) and an estimate accepted the day
    // before the visit: under the bug this estimate falls inside the
    // (wrongly shifted-back) window and wins; fixed, it must be excluded
    // and the outcome stays warm.
    const fakeDb = makeFakeDb({
      scheduled_services: [{
        id: 'visit-1', service_type: 'Waves Assessment', customer_id: 'cust-1', technician_id: 'tech-1', service_id: null,
        scheduled_date: new Date(`${SCHEDULED_DATE}T00:00:00.000Z`),
        created_at: new Date(`${SCHEDULED_DATE}T09:00:00Z`),
      }],
      estimates: [{ id: 'est-1', customer_id: 'cust-1', status: 'accepted', accepted_at: new Date('2026-09-09T15:00:00Z') }],
    });
    const saved = await recordOutcome({ scheduledServiceId: 'visit-1', outcome: 'warm' }, { trx: fakeDb });
    expect(saved.outcome).toBe('warm');
  });

  test('P1-2: an accepted estimate from BEFORE the visit does not hide a LATER qualifying acceptance', async () => {
    // The pre-fix read ordered by accepted_at ASC and took .first() before
    // ever checking the date range — so a customer's oldest-ever acceptance
    // always won that .first() and (failing the in-range check) hid a real,
    // later, in-window acceptance entirely.
    const fakeDb = seededDb({
      estimates: [
        { id: 'est-old', customer_id: 'cust-1', status: 'accepted', accepted_at: new Date('2026-08-01T00:00:00Z') }, // out of window — would win a naive ORDER BY ASC LIMIT 1
        { id: 'est-new', customer_id: 'cust-1', status: 'accepted', accepted_at: new Date('2026-09-15T00:00:00Z') }, // in window — the real sale
      ],
    });
    const saved = await recordOutcome({ scheduledServiceId: 'visit-1', outcome: 'warm' }, { trx: fakeDb });
    expect(saved.outcome).toBe('won');
    expect(saved.won_via).toBe('estimate_accept');
    expect(new Date(saved.won_at).toISOString()).toBe(new Date('2026-09-15T00:00:00Z').toISOString());
  });

  test('round 12 fix (codex P1 audit, post-push): a booking created SAME-DAY and ASSIGNED to the consultation\'s own technician is NOT closeout evidence — office/admin routes have no real "who booked this" signal, so it resolves office_booking, the exact bug the audit caught (technician_id is the assignee, never the creator)', async () => {
    const fakeDb = seededDb();
    fakeDb.__store.scheduled_services.push({
      id: 'visit-closeout', service_type: 'Quarterly Pest Control', customer_id: 'cust-1',
      created_at: new Date(`${SCHEDULED_DATE}T15:00:00Z`), status: 'confirmed', technician_id: 'tech-1',
    });
    const saved = await recordOutcome({ scheduledServiceId: 'visit-1', outcome: 'warm' }, { trx: fakeDb });
    expect(saved.outcome).toBe('won');
    expect(saved.won_via).toBe('office_booking');
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
        // Within window, lost as a no-show — must not be re-touched.
        { id: 'visit-already-lost', scheduled_date: etDateString(addETDays(NOW, -3)) },
        // P1-2: scheduled NEXT WEEK — a booking landing today must not win it.
        { id: 'visit-future', scheduled_date: etDateString(addETDays(NOW, 7)) },
        // Evidence for the wins below (the P1 fix removed the `via`
        // fallback — every win now needs a REAL qualifying booking or
        // accepted estimate): a confirmed non-assessment booking for
        // cust-1, dated `now`. Its effective timestamp (>= NOW-5d ET
        // midnight, <= now) falls inside every convertible visit's own
        // window above — visit-recent, visit-lead and visit-already-lost —
        // but never matters for visit-old (excluded by the 90-day
        // candidate cutoff regardless) or visit-future (excluded before
        // evidence is even checked, since it's scheduled after `now`).
        { id: 'sale-evidence-1', status: 'confirmed', service_type: 'Quarterly Pest Control', customer_id: 'cust-1', created_at: NOW },
      ],
      leads: [{ id: 'lead-9', customer_id: 'cust-1' }],
      consultation_outcomes: [
        { id: 'co-recent', scheduled_service_id: 'visit-recent', customer_id: 'cust-1', lead_id: null, outcome: 'warm' },
        { id: 'co-old', scheduled_service_id: 'visit-old', customer_id: 'cust-1', lead_id: null, outcome: 'cold' },
        { id: 'co-lead', scheduled_service_id: 'visit-lead', customer_id: null, lead_id: 'lead-9', outcome: 'warm' },
        // A no-show loss never converts (Codex #4710 r4 P2 — other lost rows do).
        { id: 'co-already-lost', scheduled_service_id: 'visit-already-lost', customer_id: 'cust-1', lead_id: null, outcome: 'lost', lost_reason: 'no_show' },
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
    // Evidence-derived (the seeded booking, sale-evidence-1) — not `via`
    // echoed through, and not the same Date reference as `now` (a NEW Date
    // built from the booking's own created_at), just the same instant.
    expect(byId['co-recent'].won_via).toBe('office_booking');
    expect(byId['co-recent'].won_evidence_booking_id).toBe('sale-evidence-1');
    expect(new Date(byId['co-recent'].won_at).getTime()).toBe(NOW.getTime());
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

  test('Codex #4710 r4 P2: lock, then one candidate SELECT, then a guarded UPDATE per open row — a no-show loss is never touched', async () => {
    const fakeDb = seededDb();
    const tableCalls = [];
    const spyDb = (name) => { tableCalls.push(name); return fakeDb(name); };
    spyDb.transaction = async (fn) => fn(spyDb);

    const count = await markWonForCustomer('cust-1', { via: 'office_booking', trx: spyDb, now: NOW });
    expect(count).toBe(2);
    // 'customers' first (P1-A round 5's row lock), then leads, then the one
    // candidate SELECT; every write after it is a guarded UPDATE keyed on
    // the row's still-current outcome.
    expect(tableCalls.slice(0, 3)).toEqual(['customers', 'leads', 'consultation_outcomes as co']);
    expect(tableCalls.filter((n) => n === 'consultation_outcomes')).toHaveLength(2);

    const byId = Object.fromEntries(fakeDb.__store.consultation_outcomes.map((r) => [r.id, r]));
    expect(byId['co-already-lost'].outcome).toBe('lost');
  });

  test('Codex #4710 r4 P2: the direct hook wins with the EARLIEST evidence (an earlier accepted estimate), not its own booking/now', async () => {
    const fakeDb = makeFakeDb({
      scheduled_services: [
        { id: 'visit-1', status: 'completed', service_type: 'Waves Assessment', scheduled_date: etDateString(addETDays(NOW, -10)), customer_id: 'cust-1' },
        { id: 'sale-1', status: 'confirmed', service_type: 'Quarterly Pest Control', scheduled_date: etDateString(addETDays(NOW, 5)), customer_id: 'cust-1', created_at: NOW },
      ],
      estimates: [{ id: 'est-1', customer_id: 'cust-1', status: 'accepted', accepted_at: addETDays(NOW, -4) }],
      leads: [],
      consultation_outcomes: [
        { id: 'co-1', scheduled_service_id: 'visit-1', customer_id: 'cust-1', lead_id: null, outcome: 'warm' },
      ],
    });
    await markWonForCustomer('cust-1', { via: 'office_booking', trx: fakeDb, now: NOW });
    const row = fakeDb.__store.consultation_outcomes[0];
    expect(row).toMatchObject({ outcome: 'won', won_via: 'estimate_accept', won_evidence_booking_id: null });
    expect(new Date(row.won_at).getTime()).toBe(addETDays(NOW, -4).getTime());
  });

  test('Codex #4710 r4 P2: a lost outcome with a real reason converts when the customer buys, keeping lost as its prior outcome', async () => {
    const fakeDb = seededDb();
    Object.assign(fakeDb.__store.consultation_outcomes.find((r) => r.id === 'co-already-lost'), { lost_reason: 'price' });
    const count = await markWonForCustomer('cust-1', { via: 'office_booking', trx: fakeDb, now: NOW });
    expect(count).toBe(3);
    expect(fakeDb.__store.consultation_outcomes.find((r) => r.id === 'co-already-lost')).toMatchObject({ outcome: 'won', pre_win_outcome: 'lost' });
  });

  test('P1-A (round 5): locks the `customers` row FOR NO KEY UPDATE FIRST — inside the savepoint, no advisory key', async () => {
    const fakeDb = seededDb();
    const calls = [];
    const spyDb = (name) => { calls.push({ type: 'table', name }); return fakeDb(name); };
    spyDb.transaction = async (fn) => fn(spyDb);
    // Same regression guard as recordOutcome's companion test — the
    // advisory lock is gone entirely; a `.raw()` call would be a
    // reintroduction of it.
    spyDb.raw = () => { throw new Error('unexpected trx.raw() call — the advisory lock should be gone (P1-A round 5)'); };

    await markWonForCustomer('cust-1', { via: 'office_booking', trx: spyDb, now: NOW });

    // The customer row is THE lock — taken as the very first statement
    // inside the savepoint, same key/row recordOutcome locks, so whichever
    // side gets there first fully commits before the other proceeds.
    expect(calls[0]).toMatchObject({ type: 'table', name: 'customers' });
    expect(calls.slice(1).some((c) => c.type === 'table' && c.name === 'leads')).toBe(true);
    expect(calls.slice(1).some((c) => c.type === 'table' && c.name === 'consultation_outcomes')).toBe(true);
  });

  test('P1-A (round 5): the lock sits inside the savepoint — a failure there is swallowed (best-effort), never thrown', async () => {
    // Placement regression guard: round 4 took the (now-removed) lock
    // directly on `trx`, BEFORE the savepoint opened — a failure there
    // would have had no savepoint to roll back to, aborting the caller's
    // WHOLE transaction (not just this reconciliation). Simulating the
    // savepoint itself throwing on its first statement proves the outer
    // best-effort contract still holds regardless of what that first
    // statement is.
    const fakeDb = seededDb();
    const spyDb = (name) => fakeDb(name);
    spyDb.transaction = async () => { throw new Error('simulated lock failure inside the savepoint'); };

    await expect(markWonForCustomer('cust-1', { via: 'office_booking', trx: spyDb, now: NOW }))
      .resolves.toBe(0);
  });

  test('regression: a booking earlier the SAME day, before the consultation\'s own afternoon window_start, is not its evidence (Codex #4710 r9 P2)', async () => {
    const todayStr = etDateString(NOW);
    const fakeDb = makeFakeDb({
      scheduled_services: [
        {
          id: 'visit-today-pm',
          status: 'completed',
          scheduled_date: todayStr,
          window_start: '13:00', // afternoon consultation
          customer_id: 'cust-1',
        },
        // The ONLY booking evidence for this customer — created that SAME
        // morning, before the consultation's own window_start. The window
        // opens at the consultation's own arrival time, not ET midnight
        // (findSaleEvidenceForConsultation's doc comment, Codex #4710 r9
        // P2), so this booking precedes the consultation and is never its
        // sale.
        {
          id: 'sale-am',
          status: 'confirmed',
          service_type: 'Quarterly Pest Control',
          scheduled_date: todayStr,
          customer_id: 'cust-1',
          created_at: parseETDateTime(`${todayStr}T09:00`),
        },
      ],
      leads: [],
      consultation_outcomes: [
        { id: 'co-today-pm', scheduled_service_id: 'visit-today-pm', customer_id: 'cust-1', lead_id: null, outcome: 'warm' },
      ],
    });
    const count = await markWonForCustomer('cust-1', { via: 'office_booking', trx: fakeDb, now: NOW });
    expect(count).toBe(0);
    expect(fakeDb.__store.consultation_outcomes[0].outcome).toBe('warm');
  });
});

// ---- markWonForCustomer — won_via provenance (round 12, P2 :411 origin;
// updated for the later evidence-only P1 fix, Codex #4710 r10, that removed
// the `via` fallback) -------------------------------------------------------
//
// The dormant same-day/same-technician closeout auto-detection is gone: no
// scheduled_services column says who BOOKED a row. won_via now ALWAYS comes
// from findSaleEvidenceForConsultation's own evidence — never the caller's
// `via` (kept only for the log line) — so this automatic reconciliation
// path can never produce 'closeout_booking' on its own; that value is
// written only by a caller (the future PR1b tech-closeout route) that
// stamps recordOutcome directly with won_via: 'closeout_booking', bypassing
// this function entirely.

describe('markWonForCustomer — won_via provenance (round 12, P2 :411)', () => {
  function seededDb() {
    return makeFakeDb({
      scheduled_services: [
        { id: 'visit-last-week', scheduled_date: '2026-09-03', technician_id: 'tech-1' },
        { id: 'visit-today', scheduled_date: '2026-09-10', technician_id: 'tech-1' },
        // Evidence for the wins below (the P1 fix removed the `via`
        // fallback) — a confirmed non-assessment booking for cust-1, dated
        // mid-day on 2026-09-10 (before every test's `now` of 20:00Z that
        // day, and after both visits' own ET-midnight window starts), so
        // it qualifies for both visit-last-week and visit-today.
        {
          id: 'sale-evidence-1', status: 'confirmed', service_type: 'Quarterly Pest Control', customer_id: 'cust-1', created_at: new Date('2026-09-10T12:00:00Z'),
        },
      ],
      leads: [],
      consultation_outcomes: [
        { id: 'co-last-week', scheduled_service_id: 'visit-last-week', customer_id: 'cust-1', lead_id: null, outcome: 'warm' },
        { id: 'co-today', scheduled_service_id: 'visit-today', customer_id: 'cust-1', lead_id: null, outcome: 'warm' },
      ],
    });
  }

  test('every open row wins with the evidence-derived won_via (office_booking) — via is not echoed through', async () => {
    const fakeDb = seededDb();
    const count = await markWonForCustomer('cust-1', { via: 'office_booking', trx: fakeDb, now: new Date('2026-09-10T20:00:00Z') });
    expect(count).toBe(2);
    for (const row of fakeDb.__store.consultation_outcomes) {
      expect(row.outcome).toBe('won');
      // The seeded booking (sale-evidence-1) is BOTH rows' evidence, so
      // both land on 'office_booking' — coincidentally the same value as
      // `via` here, but derived from findSaleEvidenceForConsultation, not
      // from `via` (the next test covers the case where they diverge).
      expect(row.won_via).toBe('office_booking');
      expect(row.won_evidence_booking_id).toBe('sale-evidence-1');
    }
  });

  test.each(['cancelled', 'skipped', 'no_show'])('local audit P1: a %s consultation is never won by a later booking', async (status) => {
    const fakeDb = seededDb();
    fakeDb.__store.scheduled_services.find((r) => r.id === 'visit-today').status = status;
    const count = await markWonForCustomer('cust-1', { via: 'office_booking', trx: fakeDb, now: new Date('2026-09-10T20:00:00Z') });
    expect(count).toBe(1); // only last week's live visit
    expect(fakeDb.__store.consultation_outcomes.find((r) => r.id === 'co-today').outcome).toBe('warm');
  });

  test('Codex #4710 r3 P1: a win records its OWN evidence booking id and each row\'s prior outcome', async () => {
    const fakeDb = seededDb();
    fakeDb.__store.consultation_outcomes.find((r) => r.id === 'co-last-week').outcome = 'cold';
    // won_evidence_booking_id always comes from the evidence search's own
    // booking (sale-evidence-1).
    await markWonForCustomer('cust-1', { via: 'office_booking', trx: fakeDb, now: new Date('2026-09-10T20:00:00Z') });
    const byId = Object.fromEntries(fakeDb.__store.consultation_outcomes.map((r) => [r.id, r]));
    expect(byId['co-today']).toMatchObject({ outcome: 'won', won_evidence_booking_id: 'sale-evidence-1', pre_win_outcome: 'warm' });
    expect(byId['co-last-week']).toMatchObject({ outcome: 'won', won_evidence_booking_id: 'sale-evidence-1', pre_win_outcome: 'cold' });
  });

  test('Codex #4710 r7 P2: an outcome snapshotted to ANOTHER customer is not won through a relinked lead', async () => {
    const fakeDb = makeFakeDb({
      scheduled_services: [{ id: 'visit-a', scheduled_date: '2026-09-08' }],
      leads: [{ id: 'lead-relinked', customer_id: 'cust-1' }],
      consultation_outcomes: [
        { id: 'co-a', scheduled_service_id: 'visit-a', customer_id: 'cust-A', lead_id: 'lead-relinked', outcome: 'warm' },
      ],
    });
    const count = await markWonForCustomer('cust-1', { via: 'office_booking', trx: fakeDb, now: new Date('2026-09-10T20:00:00Z') });
    expect(count).toBe(0);
    expect(fakeDb.__store.consultation_outcomes[0].outcome).toBe('warm');
  });

  test('via never becomes won_via through this automatic path — even an explicit closeout_booking is overridden by the real evidence', async () => {
    const fakeDb = seededDb();
    await markWonForCustomer('cust-1', { via: 'closeout_booking', trx: fakeDb, now: new Date('2026-09-10T20:00:00Z') });
    // `via` is for the log line only (see the function's doc comment) — the
    // written won_via always comes from findSaleEvidenceForConsultation,
    // here the seeded booking's 'office_booking', never the caller's
    // 'closeout_booking'. That value is written only by a caller that
    // stamps recordOutcome directly (the future PR1b tech-closeout route),
    // never through this reconciliation.
    expect(fakeDb.__store.consultation_outcomes.find((r) => r.id === 'co-today').won_via).toBe('office_booking');
  });
});

// ---- reconcileOpenConsultationOutcomes (round 10 — the hourly sweep) ------

describe('reconcileOpenConsultationOutcomes — the completeness guarantee (round 10)', () => {
  const SCHEDULED_DATE = '2026-09-10';
  const NOW = new Date('2026-09-23T12:00:00Z');

  function install(seed) {
    const fakeDb = makeFakeDb(seed);
    db.mockImplementation(fakeDb);
    db.transaction = fakeDb.transaction;
    return fakeDb;
  }

  afterEach(() => {
    db.mockReset();
    delete db.transaction;
  });

  test('outcome recorded FIRST, the qualifying booking created SECOND — the sweep finds it on its next tick and wins it', async () => {
    const fakeDb = install({
      scheduled_services: [
        // The consultation visit itself.
        { id: 'visit-1', scheduled_date: SCHEDULED_DATE, customer_id: 'cust-1', service_type: 'Waves Assessment' },
        // The real sale, booked well after the outcome was recorded — no
        // direct hook ever ran for it in this test (that's the point).
        {
          id: 'visit-real', scheduled_date: '2026-09-17', customer_id: 'cust-1', service_type: 'Quarterly Pest Control',
          status: 'confirmed', created_at: new Date('2026-09-17T00:00:00Z'),
        },
      ],
      consultation_outcomes: [
        { id: 'co-1', scheduled_service_id: 'visit-1', customer_id: 'cust-1', outcome: 'warm' },
      ],
    });

    const result = await reconcileOpenConsultationOutcomes({ now: NOW });

    expect(result).toEqual({ scanned: 1, won: 1, errors: 0, no_show_repaired: 0, reopened: 0 });
    const row = fakeDb.__store.consultation_outcomes.find((r) => r.id === 'co-1');
    expect(row.outcome).toBe('won');
    expect(row.won_via).toBe('office_booking');
    expect(new Date(row.won_at).toISOString()).toBe(new Date('2026-09-17T00:00:00Z').toISOString());
  });

  test('skips a visit scheduled outside the 90-day attribution window (stays warm, not counted as scanned)', async () => {
    const fakeDb = install({
      scheduled_services: [
        { id: 'visit-old', scheduled_date: '2026-01-01', customer_id: 'cust-1', service_type: 'Waves Assessment' },
        { id: 'visit-real', scheduled_date: '2026-01-05', customer_id: 'cust-1', service_type: 'Quarterly Pest Control', status: 'confirmed', created_at: new Date('2026-01-05T00:00:00Z') },
      ],
      consultation_outcomes: [
        { id: 'co-old', scheduled_service_id: 'visit-old', customer_id: 'cust-1', outcome: 'warm' },
      ],
    });

    const result = await reconcileOpenConsultationOutcomes({ now: NOW });

    expect(result).toEqual({ scanned: 0, won: 0, errors: 0, no_show_repaired: 0, reopened: 0 });
    expect(fakeDb.__store.consultation_outcomes.find((r) => r.id === 'co-old').outcome).toBe('warm');
  });

  test('P1 :924 grace period — a sale at 23:40 ET on the visit\'s last in-window day (day 90) is still won by the sweep tick just after midnight (day 91) even though the bare 90-day cutoff would have already dropped the row from selection', async () => {
    // day0 = 2026-06-01 (the visit); day90 = 2026-08-30 (the last day
    // inside the window); day91 = 2026-08-31. Without the grace period,
    // a sweep tick running with `now` on day91 computes cutoff = now - 90
    // = day91-90 = a date AFTER day0, so day0's row falls out of the
    // SELECTION entirely — even though the evidence below is genuinely
    // dated on day90, inside the window.
    const fakeDb = install({
      scheduled_services: [
        { id: 'visit-1', scheduled_date: '2026-06-01', customer_id: 'cust-1', service_type: 'Waves Assessment' },
        {
          id: 'visit-real', scheduled_date: '2026-08-30', customer_id: 'cust-1', service_type: 'Quarterly Pest Control',
          status: 'confirmed', created_at: new Date('2026-08-31T03:40:00Z'), // 2026-08-30 23:40 ET (EDT, UTC-4)
        },
      ],
      consultation_outcomes: [
        { id: 'co-1', scheduled_service_id: 'visit-1', customer_id: 'cust-1', outcome: 'warm' },
      ],
    });

    // The sweep's hourly tick just after midnight on day91 — the FIRST
    // tick after the sale, since the sale landed after the last tick on
    // day90 itself (this is exactly the missed-tick scenario the grace
    // period exists for).
    const result = await reconcileOpenConsultationOutcomes({ now: new Date('2026-08-31T04:27:00Z') }); // 00:27 ET day91

    expect(result).toEqual({ scanned: 1, won: 1, errors: 0, no_show_repaired: 0, reopened: 0 });
    expect(fakeDb.__store.consultation_outcomes.find((r) => r.id === 'co-1').outcome).toBe('won');
  });

  test('P1 :924 — a "sale" dated AFTER the window closes (day 91) is still never a win, even though the grace period keeps the row selectable', async () => {
    const fakeDb = install({
      scheduled_services: [
        { id: 'visit-1', scheduled_date: '2026-06-01', customer_id: 'cust-1', service_type: 'Waves Assessment' },
        {
          id: 'visit-late', scheduled_date: '2026-08-31', customer_id: 'cust-1', service_type: 'Quarterly Pest Control',
          status: 'confirmed', created_at: new Date('2026-08-31T15:00:00Z'), // day 91 — one day past the window's last day
        },
      ],
      consultation_outcomes: [
        { id: 'co-1', scheduled_service_id: 'visit-1', customer_id: 'cust-1', outcome: 'warm' },
      ],
    });

    const result = await reconcileOpenConsultationOutcomes({ now: new Date('2026-08-31T20:27:00Z') }); // 16:27 ET day91

    // The grace period keeps the row IN the sweep's candidate set (it's
    // examined — scanned: 1), but findSaleEvidenceForConsultation's own
    // strict 90-day evidence bound (untouched by this fix) still excludes
    // a booking created after the window closed — no evidence, no win.
    expect(result).toEqual({ scanned: 1, won: 0, errors: 0, no_show_repaired: 0, reopened: 0 });
    expect(fakeDb.__store.consultation_outcomes.find((r) => r.id === 'co-1').outcome).toBe('warm');
  });

  test('skips an already-won row whose evidence still stands (idempotent — the win pass reads only open rows)', async () => {
    // Real evidence behind the win (Codex #4710 r10 pre-push P1: the reopen
    // pass re-judges every win against its evidence).
    const fakeDb = install({
      scheduled_services: [
        { id: 'visit-1', status: 'completed', scheduled_date: SCHEDULED_DATE, customer_id: 'cust-1', service_type: 'Waves Assessment' },
      ],
      estimates: [{ id: 'est-1', customer_id: 'cust-1', status: 'accepted', accepted_at: new Date('2026-09-11T00:00:00Z') }],
      consultation_outcomes: [
        { id: 'co-1', scheduled_service_id: 'visit-1', customer_id: 'cust-1', outcome: 'won', won_via: 'estimate_accept', won_at: new Date('2026-09-11T00:00:00Z'), won_evidence_booking_id: null },
      ],
    });

    const result = await reconcileOpenConsultationOutcomes({ now: NOW });

    expect(result).toEqual({ scanned: 0, won: 0, errors: 0, no_show_repaired: 0, reopened: 0 });
    expect(fakeDb.__store.consultation_outcomes.find((r) => r.id === 'co-1')).toMatchObject({ outcome: 'won', won_via: 'estimate_accept' });
  });

  test('an estimate win whose acceptance no longer qualifies is re-pointed to the later acceptance that does', async () => {
    const fakeDb = install({
      scheduled_services: [
        // Moved to 09-14 after the win; the 09-11 acceptance now precedes it.
        { id: 'visit-1', status: 'completed', scheduled_date: '2026-09-14', customer_id: 'cust-1', service_type: 'Waves Assessment' },
      ],
      estimates: [
        { id: 'est-old', customer_id: 'cust-1', status: 'accepted', accepted_at: new Date('2026-09-11T00:00:00Z') },
        { id: 'est-new', customer_id: 'cust-1', status: 'accepted', accepted_at: new Date('2026-09-16T15:00:00Z') },
      ],
      consultation_outcomes: [
        { id: 'co-1', scheduled_service_id: 'visit-1', customer_id: 'cust-1', outcome: 'won', won_via: 'estimate_accept', won_at: new Date('2026-09-11T00:00:00Z'), won_evidence_booking_id: null },
      ],
    });

    const result = await reconcileOpenConsultationOutcomes({ now: NOW });

    expect(result.reopened).toBe(1);
    const row = fakeDb.__store.consultation_outcomes.find((r) => r.id === 'co-1');
    expect(row.outcome).toBe('won');
    expect(new Date(row.won_at).toISOString()).toBe('2026-09-16T15:00:00.000Z');
  });

  test('continues past a row whose reconciliation throws — the rest of the sweep still runs', async () => {
    const fakeDb = install({
      scheduled_services: [
        { id: 'visit-a', scheduled_date: SCHEDULED_DATE, customer_id: 'cust-a', service_type: 'Waves Assessment' },
        { id: 'visit-a-real', scheduled_date: '2026-09-17', customer_id: 'cust-a', service_type: 'Quarterly Pest Control', status: 'confirmed', created_at: new Date('2026-09-17T00:00:00Z') },
        { id: 'visit-b', scheduled_date: SCHEDULED_DATE, customer_id: 'cust-b', service_type: 'Waves Assessment' },
        { id: 'visit-b-real', scheduled_date: '2026-09-18', customer_id: 'cust-b', service_type: 'Quarterly Pest Control', status: 'confirmed', created_at: new Date('2026-09-18T00:00:00Z') },
      ],
      consultation_outcomes: [
        // Recorded first (by created order/recorded_at) — this is the one
        // whose per-row reconciliation blows up.
        { id: 'co-a', scheduled_service_id: 'visit-a', customer_id: 'cust-a', outcome: 'warm', recorded_at: new Date('2026-09-20T00:00:00Z') },
        { id: 'co-b', scheduled_service_id: 'visit-b', customer_id: 'cust-b', outcome: 'cold', recorded_at: new Date('2026-09-21T00:00:00Z') },
      ],
    });
    // Make customer 'cust-a's row lock throw — simulates a transient DB
    // error on exactly one row's reconciliation. cust-b's lock is
    // unaffected (this fake db has no customers rows seeded, but
    // forNoKeyUpdate().first('id') against an empty table just resolves to
    // undefined — harmless).
    const spyDb = (name) => {
      if (name === 'customers') {
        return {
          where: (cond) => {
            if (cond && cond.id === 'cust-a') {
              return { forNoKeyUpdate: () => ({ first: async () => { throw new Error('simulated lock failure for cust-a'); } }) };
            }
            return fakeDb('customers').where(cond);
          },
        };
      }
      return fakeDb(name);
    };
    spyDb.raw = fakeDb.raw; // Codex #4710 r10 P1 :692 — the bounded lock-wait SET LOCAL
    spyDb.transaction = async (fn) => fn(spyDb);
    db.mockImplementation(spyDb);
    db.transaction = spyDb.transaction;

    const result = await reconcileOpenConsultationOutcomes({ now: NOW });

    expect(result.scanned).toBe(2);
    expect(result.errors).toBe(1);
    expect(result.won).toBe(1);
    expect(fakeDb.__store.consultation_outcomes.find((r) => r.id === 'co-a').outcome).toBe('warm'); // untouched by the throw
    expect(fakeDb.__store.consultation_outcomes.find((r) => r.id === 'co-b').outcome).toBe('won'); // the sweep kept going
  });

  test('Codex #4710 r10 P1 :692: bounds the per-row reconciliation customer lock wait (SET LOCAL lock_timeout), set before the row lock itself', async () => {
    const fakeDb = install({
      scheduled_services: [
        { id: 'visit-1', scheduled_date: SCHEDULED_DATE, customer_id: 'cust-1', service_type: 'Waves Assessment' },
      ],
      consultation_outcomes: [
        { id: 'co-1', scheduled_service_id: 'visit-1', customer_id: 'cust-1', outcome: 'warm' },
      ],
    });
    const calls = [];
    const spyDb = (name) => { calls.push({ type: 'table', name }); return fakeDb(name); };
    spyDb.raw = (sql, bindings) => { calls.push({ type: 'raw', sql }); return fakeDb.raw(sql, bindings); };
    spyDb.transaction = async (fn) => fn(spyDb);
    db.mockImplementation(spyDb);
    db.transaction = spyDb.transaction;

    await reconcileOpenConsultationOutcomes({ now: NOW });

    // Pre-fix, reconcileOneOpenOutcome never called `.raw()` at all — a
    // wedged customer lock could wait forever (unlimited default
    // lock_timeout) and, because scheduler.js's runExclusive serializes the
    // whole hourly sweep, block every OTHER row too, on every later tick.
    const rawIdx = calls.findIndex((c) => c.type === 'raw' && /lock_timeout/i.test(c.sql));
    const customersIdx = calls.findIndex((c) => c.type === 'table' && c.name === 'customers');
    expect(rawIdx).toBeGreaterThanOrEqual(0);
    expect(customersIdx).toBeGreaterThan(rawIdx);
  });

  test('bounded by limit — a large backlog does not all run in one tick', async () => {
    const outcomes = [];
    const visits = [];
    for (let i = 0; i < 5; i += 1) {
      visits.push({ id: `visit-${i}`, scheduled_date: SCHEDULED_DATE, customer_id: `cust-${i}`, service_type: 'Waves Assessment' });
      outcomes.push({ id: `co-${i}`, scheduled_service_id: `visit-${i}`, customer_id: `cust-${i}`, outcome: 'warm', recorded_at: new Date(`2026-09-1${i}T00:00:00Z`) });
    }
    install({ scheduled_services: visits, consultation_outcomes: outcomes });

    const result = await reconcileOpenConsultationOutcomes({ now: NOW, limit: 2 });

    expect(result.scanned).toBe(2); // only the 2 oldest-recorded rows this tick
  });

  test('P1 :755 fairness — a row this tick already examined is not re-selected before an older-recorded row this tick has not looked at yet', async () => {
    // row A: recorded earliest, examined tick 1 (stamped last_reconciled_at
    // whether or not it won — it stays warm here, no qualifying evidence).
    // row B: recorded LATER than A but never examined. Pre-fix (ORDER BY
    // recorded_at ASC alone), A would sort first on EVERY tick forever,
    // since staying warm never advances recorded_at — starving B.
    const fakeDb = install({
      scheduled_services: [
        { id: 'visit-a', scheduled_date: SCHEDULED_DATE, customer_id: 'cust-a', service_type: 'Waves Assessment' },
        { id: 'visit-b', scheduled_date: SCHEDULED_DATE, customer_id: 'cust-b', service_type: 'Waves Assessment' },
      ],
      consultation_outcomes: [
        { id: 'co-a', scheduled_service_id: 'visit-a', customer_id: 'cust-a', outcome: 'warm', recorded_at: new Date('2026-09-01T00:00:00Z') },
        { id: 'co-b', scheduled_service_id: 'visit-b', customer_id: 'cust-b', outcome: 'warm', recorded_at: new Date('2026-09-05T00:00:00Z') },
      ],
    });

    const tick1 = await reconcileOpenConsultationOutcomes({ now: NOW, limit: 1 });
    expect(tick1.scanned).toBe(1);
    // Both rows start with null last_reconciled_at — recorded_at ASC is the
    // tiebreak, so the older-recorded row (A) goes first.
    expect(fakeDb.__store.consultation_outcomes.find((r) => r.id === 'co-a').last_reconciled_at).toBeTruthy();
    expect(fakeDb.__store.consultation_outcomes.find((r) => r.id === 'co-b').last_reconciled_at).toBeFalsy();

    const tick2 = await reconcileOpenConsultationOutcomes({ now: NOW, limit: 1 });
    expect(tick2.scanned).toBe(1);
    // B (never examined — null last_reconciled_at, NULLS FIRST) is reached
    // on tick 2 BEFORE A is re-examined, even though A's recorded_at is
    // still the earlier of the two — the fairness fix under test.
    expect(fakeDb.__store.consultation_outcomes.find((r) => r.id === 'co-b').last_reconciled_at).toBeTruthy();
  });

  test('P1 :755 fairness — a 200-row backlog of still-unresolved rows does not permanently starve a qualifying row behind them; it is reached on the SECOND tick', async () => {
    const visits = [];
    const outcomes = [];
    // 200 rows that stay open on every reconciliation attempt (no matching
    // evidence anywhere) — recorded BEFORE the qualifying row below, so a
    // naive `ORDER BY recorded_at ASC LIMIT 200` (the pre-fix query) selects
    // exactly this backlog on EVERY tick, forever, since none of them ever
    // change.
    for (let i = 0; i < 200; i += 1) {
      visits.push({ id: `visit-stale-${i}`, scheduled_date: SCHEDULED_DATE, customer_id: `cust-stale-${i}`, service_type: 'Waves Assessment' });
      outcomes.push({
        id: `co-stale-${i}`, scheduled_service_id: `visit-stale-${i}`, customer_id: `cust-stale-${i}`,
        outcome: 'warm', recorded_at: new Date(2026, 8, 1, 0, 0, i),
      });
    }
    // The qualifying row: recorded AFTER all 200 stale rows, so it sorts to
    // position 201 — one past the default `limit` — on every tick, under
    // the pre-fix ordering.
    visits.push({ id: 'visit-real', scheduled_date: SCHEDULED_DATE, customer_id: 'cust-real', service_type: 'Waves Assessment' });
    visits.push({
      id: 'visit-real-sale', scheduled_date: '2026-09-17', customer_id: 'cust-real', service_type: 'Quarterly Pest Control',
      status: 'confirmed', created_at: new Date('2026-09-17T00:00:00Z'),
    });
    outcomes.push({ id: 'co-real', scheduled_service_id: 'visit-real', customer_id: 'cust-real', outcome: 'warm', recorded_at: new Date('2026-09-02T00:00:00Z') });

    const fakeDb = install({ scheduled_services: visits, consultation_outcomes: outcomes });

    const tick1 = await reconcileOpenConsultationOutcomes({ now: NOW }); // default limit: 200
    expect(tick1.scanned).toBe(200);
    expect(tick1.won).toBe(0); // none of the 200 stale rows have qualifying evidence
    // Every row this tick EXAMINED is stamped, win or not — what lets the
    // next tick advance past them.
    const stamped = fakeDb.__store.consultation_outcomes.filter((r) => r.last_reconciled_at != null);
    expect(stamped.length).toBe(200);
    expect(fakeDb.__store.consultation_outcomes.find((r) => r.id === 'co-real').last_reconciled_at).toBeFalsy();

    const tick2 = await reconcileOpenConsultationOutcomes({ now: NOW });
    // co-real (still-null last_reconciled_at) sorts before every now-stamped
    // stale row, so it is reached on this second tick and wins.
    expect(fakeDb.__store.consultation_outcomes.find((r) => r.id === 'co-real').outcome).toBe('won');
    expect(tick2.won).toBe(1);
  });
});

// ---- markNoShow -------------------------------------------------------------

describe('markNoShow', () => {
  function seededDb(extraOutcomes = []) {
    return makeFakeDb({
      scheduled_services: [
        // status no_show: job-status moves the row there in the same
        // transaction before calling markNoShow.
        { id: 'visit-1', status: 'no_show', service_type: 'Waves Assessment', customer_id: 'cust-1', technician_id: 'tech-1', service_id: null },
        { id: 'visit-2', status: 'no_show', service_type: 'Quarterly Pest Control', customer_id: 'cust-2', technician_id: 'tech-2', service_id: null },
      ],
      leads: [{ id: 'lead-1', customer_id: 'cust-1', deleted_at: null, created_at: '2026-01-01' }],
      consultation_outcomes: extraOutcomes,
    });
  }

  test('local audit P1: a visit reopened since the sweep selected it (no longer no_show) is left alone', async () => {
    const fakeDb = seededDb([{ id: 'co-1', scheduled_service_id: 'visit-1', customer_id: 'cust-1', outcome: 'warm' }]);
    fakeDb.__store.scheduled_services.find((r) => r.id === 'visit-1').status = 'confirmed';
    expect(await markNoShow('visit-1', { trx: fakeDb })).toBeNull();
    expect(fakeDb.__store.consultation_outcomes.find((r) => r.id === 'co-1').outcome).toBe('warm');
  });

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

  // Codex #4710 r8 P2: a visit that never happened cannot keep a
  // price/competitor loss beside its no-show — normalized to lost/no_show.
  test('normalizes an existing lost outcome with another reason to lost/no_show', async () => {
    const fakeDb = seededDb([{ id: 'co-1', scheduled_service_id: 'visit-1', outcome: 'lost', lost_reason: 'price' }]);
    const result = await markNoShow('visit-1', { trx: fakeDb });
    expect(result).toMatchObject({ outcome: 'lost', lost_reason: 'no_show' });
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
    // a TOCTOU window a concurrent markWonForCustomer could win. Now:
    // exactly ONE consultation_outcomes touch (the atomic conditional
    // UPDATE that both applies the change AND returns the updated row — no
    // separate read). TWO scheduled_services reads (Codex #4710 r10 P2
    // :1307 — customer → visit lock order): an unlocked preview to learn
    // which customer to lock, then the locked ownership/consultation
    // recheck.
    expect(tableCalls.filter((n) => n === 'scheduled_services')).toHaveLength(2);
    expect(tableCalls.filter((n) => n === 'consultation_outcomes')).toHaveLength(1);
  });

  test('Codex #4710 r10 P2 :1307: locks the customer row BEFORE the visit lock (customer -> visit, matching customer-dedupe.js\'s executeMerge order)', async () => {
    const fakeDb = seededDb();
    const calls = [];
    const spyDb = (name) => { calls.push(name); return fakeDb(name); };

    await markNoShow('visit-1', { trx: spyDb });

    const customersIdx = calls.indexOf('customers');
    const scheduledIdx = calls.indexOf('scheduled_services'); // first touch: the unlocked customer-id preview
    const lockedScheduledIdx = calls.lastIndexOf('scheduled_services'); // second touch: the locked recheck
    expect(customersIdx).toBeGreaterThanOrEqual(0);
    // customers is locked strictly BETWEEN the two scheduled_services
    // reads — after learning which customer to lock, before the visit's
    // own row lock. The pre-fix version never touched `customers` at all
    // (no lock order to get wrong, which was the bug).
    expect(customersIdx).toBeGreaterThan(scheduledIdx);
    expect(customersIdx).toBeLessThan(lockedScheduledIdx);
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

describe('deriveLinkage (via markNoShow) — the best-effort lead lookup is isolated in its own savepoint (Codex #4710 r10 P2 :305)', () => {
  // A small connection wrapper that mirrors real Postgres transaction
  // semantics the plain table-shim doesn't model: once ANY query on a
  // connection throws/rejects, every LATER query on that SAME connection
  // throws "current transaction is aborted" too — UNLESS the failing query
  // ran inside a nested `.transaction()` (a SAVEPOINT), whose own poison
  // state is isolated from its parent's, exactly like a real
  // ROLLBACK TO SAVEPOINT. This is what actually distinguishes "caught the
  // error in JS" from "the surrounding transaction is still usable" — the
  // gap the P2 :305 finding is about.
  function abortedError() {
    const err = new Error('current transaction is aborted, commands ignored until end of transaction block');
    err.code = '25P02';
    return err;
  }
  function proxifyConnection(obj, poisonState) {
    if (obj == null || typeof obj !== 'object') return obj;
    return new Proxy(obj, {
      get(target, prop) {
        const value = target[prop];
        if (typeof value !== 'function') return value;
        return (...args) => {
          if (poisonState.poisoned) throw abortedError();
          let result;
          try {
            result = value.apply(target, args);
          } catch (err) {
            poisonState.poisoned = true;
            throw err;
          }
          if (result && typeof result.then === 'function') {
            const wrapped = result.then((v) => v, (err) => { poisonState.poisoned = true; throw err; });
            // The shim's update() hands back a hybrid: a Promise (its
            // resolved value the row count) that ALSO carries a
            // `.returning()` method for callers that want the updated
            // rows. `.then()` returns a brand-new promise that would drop
            // that extra property — copy it across so callers depending on
            // it (markNoShow's own atomic UPDATE) keep working.
            Object.keys(result).forEach((key) => { wrapped[key] = result[key]; });
            return wrapped;
          }
          return proxifyConnection(result, poisonState);
        };
      },
    });
  }
  function wrapConnection(rawDb, poisonState) {
    const conn = (name) => {
      if (poisonState.poisoned) throw abortedError();
      try {
        return proxifyConnection(rawDb(name), poisonState);
      } catch (err) {
        poisonState.poisoned = true;
        throw err;
      }
    };
    // A nested `.transaction()` call is a SAVEPOINT: its own fresh poison
    // state, never propagated back to the parent — a failure inside is
    // contained, matching knex's automatic ROLLBACK TO SAVEPOINT.
    conn.transaction = async (fn) => fn(wrapConnection(rawDb, { poisoned: false }));
    conn.raw = rawDb.raw;
    conn.__store = rawDb.__store;
    return conn;
  }

  test('a lead-lookup failure does not abort the enclosing transaction — the no-show write still completes with lead_id: null', async () => {
    const fakeDb = makeFakeDb({
      scheduled_services: [
        { id: 'visit-1', status: 'no_show', service_type: 'Waves Assessment', customer_id: 'cust-1', technician_id: 'tech-1', service_id: null },
      ],
      leads: [{ id: 'lead-1', customer_id: 'cust-1', deleted_at: null, created_at: '2026-01-01' }],
      consultation_outcomes: [],
    });
    // The lead lookup's own first query throws — same shape a real
    // constraint violation or transient error would take.
    const failingDb = (name) => {
      if (name === 'lead_activities as la') throw new Error('simulated lead lookup failure');
      return fakeDb(name);
    };
    failingDb.raw = fakeDb.raw;
    failingDb.__store = fakeDb.__store;
    const poisonableDb = wrapConnection(failingDb, { poisoned: false });

    // Pre-fix, deriveLinkage ran the failing query directly on the SAME
    // connection markNoShow's insert uses right after — the throw poisoned
    // that connection, so the insert below would reject with "current
    // transaction is aborted" even though deriveLinkage's own try/catch
    // already logged the lookup failure and set leadId: null. Post-fix, the
    // lookup runs inside its own savepoint, so only that isolated state is
    // poisoned — the insert on the parent connection still succeeds.
    const result = await markNoShow('visit-1', { trx: poisonableDb });

    expect(result).not.toBeNull();
    expect(result.outcome).toBe('lost');
    expect(result.lost_reason).toBe('no_show');
    expect(result.lead_id).toBeNull();
  });
});

// ---- consultationStats — median_days_to_close --------------------------

describe('consultationStats — P1-1 median_days_to_close preserves the scheduled_date DATE column\'s calendar day', () => {
  // consultationStats' own db access is a leftJoin-then-where-then-select
  // knex chain the store-based table() shim above doesn't model (no joins).
  // Stub the chain to hand back a fixed `visits` row set, exactly as if the
  // joins/where clauses had already produced it — the fix under test lives
  // entirely in the per-row JS below the query, not in the SQL shape.
  function statsDb(visits) {
    const builder = { leftJoin: () => builder, where: () => builder, select: () => Promise.resolve(visits) };
    return () => builder;
  }

  test('Codex #4710 r9 P2: an outcome on a consultation later cancelled is not counted; a no-show still counts as lost', async () => {
    const visits = [
      { status: 'cancelled', scheduled_date: '2026-09-10', technician_id: 't1', technician_name: 'Adam', outcome: 'warm' },
      { status: 'no_show', scheduled_date: '2026-09-11', technician_id: 't1', technician_name: 'Adam', outcome: 'lost', lost_reason: 'no_show' },
    ];
    const stats = await consultationStats({ trx: statsDb(visits) });
    expect(stats.warm).toBe(0);
    expect(stats.lost).toBe(1);
    expect(stats.lost_by_reason).toEqual({ no_show: 1 });
  });

  test('Codex #4710 r12 P2: a recorded outcome on a still-confirmed visit counts as a show, overall and per group', async () => {
    const visits = [
      { status: 'confirmed', scheduled_date: '2026-09-10', technician_id: 't1', technician_name: 'Adam', outcome: 'won', won_via: 'office_booking', won_at: new Date('2026-09-12T16:00:00Z') },
      { status: 'confirmed', scheduled_date: '2026-09-11', technician_id: 't1', technician_name: 'Adam', outcome: null },
    ];
    const stats = await consultationStats({ trx: statsDb(visits) });
    expect(stats.showed).toBe(1);
    expect(stats.by_technician[0]).toMatchObject({ showed: 1, won: 1 });
  });

  test('Codex #4710 r3 P2: an even cohort reports the arithmetic midpoint (2 and 3 days → 2.5), not a rounded value', async () => {
    const visits = [
      { status: 'completed', scheduled_date: '2026-09-10', technician_id: 't1', technician_name: 'Adam', outcome: 'won', won_via: 'office_booking', won_at: new Date('2026-09-12T16:00:00Z') },
      { status: 'completed', scheduled_date: '2026-09-10', technician_id: 't1', technician_name: 'Adam', outcome: 'won', won_via: 'office_booking', won_at: new Date('2026-09-13T16:00:00Z') },
    ];
    const stats = await consultationStats({ trx: statsDb(visits) });
    expect(stats.median_days_to_close).toBe(2.5);
  });

  test('Codex #4710 r3 P2: credit goes to the technician who recorded the outcome, not the current assignee', async () => {
    const visits = [
      { status: 'completed', scheduled_date: '2026-09-10', technician_id: 't2', technician_name: 'Bea', outcome_technician_id: 't1', outcome_technician_name: 'Adam', outcome: 'won', won_via: 'office_booking', won_at: new Date('2026-09-12T16:00:00Z') },
      { status: 'scheduled', scheduled_date: '2026-09-11', technician_id: 't2', technician_name: 'Bea', outcome_technician_id: null, outcome: null },
    ];
    const stats = await consultationStats({ trx: statsDb(visits) });
    const byTech = Object.fromEntries(stats.by_technician.map((t) => [t.technician_id, t]));
    expect(byTech.t1).toMatchObject({ name: 'Adam', won: 1 });
    expect(byTech.t2).toMatchObject({ name: 'Bea', won: 0 });
  });

  test('a scheduled_date read back as a UTC-midnight Date is not shifted a day by etDateString', async () => {
    // pg on Railway (TZ=UTC) hands scheduled_date '2026-09-10' back as a JS
    // Date at UTC midnight. Running it through etDateString (the bug) reads
    // that instant in ET and reports '2026-09-09' — a day early — which
    // used to send median_days_to_close negative/inflated whenever won_at
    // landed on the visit's own calendar day.
    const visits = [{
      status: 'completed',
      scheduled_date: new Date('2026-09-10T00:00:00.000Z'),
      technician_id: 't1',
      technician_name: 'Adam',
      outcome: 'won',
      won_via: 'closeout_booking',
      won_at: new Date('2026-09-10T18:00:00.000Z'), // same ET calendar day, that evening
      lead_source: 'referral',
    }];
    const stats = await consultationStats({ trx: statsDb(visits) });
    // Correct: 0 days between the visit's scheduled_date and won_at (same ET
    // calendar day). The pre-fix bug computes this as 1 (etDateString reads
    // the UTC-midnight scheduled_date as the ET day before).
    expect(stats.median_days_to_close).toBe(0);
  });

  test('Codex #4710 r13 P2: a no-show visit whose stale outcome is still `won` counts only as no_show, not as a win', async () => {
    // markNoShow's outcome write is best-effort (NOWAIT customer lock busy,
    // or ON CONFLICT ... IGNORE when the prior outcome is already 'won') —
    // the visit's status commits to 'no_show' while consultation_outcomes
    // still holds the old outcome until the hourly repair pass catches up.
    const visits = [
      { status: 'no_show', scheduled_date: '2026-09-11', technician_id: 't1', technician_name: 'Adam', outcome: 'won', won_via: 'office_booking', won_at: new Date('2026-09-10T15:00:00Z') },
    ];
    const stats = await consultationStats({ trx: statsDb(visits) });
    expect(stats.won).toBe(0);
    expect(stats.no_show).toBe(1);
    expect(stats.won_by_via).toEqual({});
  });

  test('round 12 (P2 :411): won rows count once in `won` with a won_by_via breakdown (no permanently-zero at-door metric)', async () => {
    const visits = [
      {
        status: 'completed', scheduled_date: '2026-09-10', technician_id: 't1', technician_name: 'Adam',
        outcome: 'won', won_via: 'closeout_booking', won_at: new Date('2026-09-10T18:00:00.000Z'), lead_source: 'referral',
      },
      {
        status: 'completed', scheduled_date: '2026-09-11', technician_id: 't2', technician_name: 'Bea',
        outcome: 'won', won_via: 'office_booking', won_at: new Date('2026-09-14T00:00:00.000Z'), lead_source: 'referral',
      },
    ];
    const stats = await consultationStats({ trx: statsDb(visits) });
    expect(stats.won).toBe(2);
    expect(stats.won_by_via).toEqual({ closeout_booking: 1, office_booking: 1 });
    expect(stats).not.toHaveProperty('won_at_door');
  });
});

// ---- repairMissedNoShowOutcomes (round 12, P2 job-status.js:514) ----------
//
// The no-show transition's outcome write is best-effort; the hourly sweep
// re-runs markNoShow for any no-showed consultation whose outcome is still
// missing or open, so a failed write there is retried rather than lost.

describe('reconcileOpenConsultationOutcomes — no-show outcome repair (round 12, P2 job-status.js:514)', () => {
  const NOW = new Date('2026-09-23T12:00:00Z');

  function install(seed) {
    const fakeDb = makeFakeDb(seed);
    db.mockImplementation(fakeDb);
    db.transaction = fakeDb.transaction;
    return fakeDb;
  }

  afterEach(() => {
    db.mockReset();
  });

  test('a no-showed consultation with NO outcome row gets lost/no_show written', async () => {
    const fakeDb = install({
      scheduled_services: [
        { id: 'visit-ns', status: 'no_show', service_type: 'Waves Assessment', scheduled_date: '2026-09-20', customer_id: 'cust-1' },
      ],
    });
    const result = await reconcileOpenConsultationOutcomes({ now: NOW });
    expect(result.no_show_repaired).toBe(1);
    expect(result.errors).toBe(0);
    const row = fakeDb.__store.consultation_outcomes.find((r) => r.scheduled_service_id === 'visit-ns');
    expect(row).toMatchObject({ outcome: 'lost', lost_reason: 'no_show' });
  });

  test('a no-showed consultation left open (warm) is closed lost/no_show', async () => {
    const fakeDb = install({
      scheduled_services: [
        { id: 'visit-ns', status: 'no_show', service_type: 'Waves Assessment', scheduled_date: '2026-09-20', customer_id: null },
      ],
      consultation_outcomes: [
        { id: 'co-ns', scheduled_service_id: 'visit-ns', customer_id: null, outcome: 'warm' },
      ],
    });
    const result = await reconcileOpenConsultationOutcomes({ now: NOW });
    expect(result.no_show_repaired).toBe(1);
    expect(fakeDb.__store.consultation_outcomes.find((r) => r.id === 'co-ns')).toMatchObject({ outcome: 'lost', lost_reason: 'no_show' });
  });

  test('local audit P1: the sweep never wins a cancelled consultation, even with sale evidence', async () => {
    const fakeDb = install({
      scheduled_services: [
        { id: 'visit-c', status: 'cancelled', service_type: 'Waves Assessment', scheduled_date: '2026-09-20', customer_id: 'cust-1' },
        { id: 'sale', status: 'confirmed', service_type: 'Quarterly Pest Control', scheduled_date: '2026-09-25', customer_id: 'cust-1', created_at: new Date('2026-09-21T15:00:00Z') },
      ],
      consultation_outcomes: [
        { id: 'co-c', scheduled_service_id: 'visit-c', customer_id: 'cust-1', outcome: 'warm', recorded_at: new Date('2026-09-20T15:00:00Z') },
      ],
    });
    const result = await reconcileOpenConsultationOutcomes({ now: NOW });
    expect(result.won).toBe(0);
    expect(fakeDb.__store.consultation_outcomes.find((r) => r.id === 'co-c').outcome).toBe('warm');
  });

  test('local audit P1: a customer-linked warm no-show WITH sale evidence closes lost/no_show — the win pass never takes it', async () => {
    const fakeDb = install({
      scheduled_services: [
        { id: 'visit-ns', status: 'no_show', service_type: 'Waves Assessment', scheduled_date: '2026-09-20', customer_id: 'cust-1' },
        { id: 'sale', status: 'confirmed', service_type: 'Quarterly Pest Control', scheduled_date: '2026-09-25', customer_id: 'cust-1', created_at: new Date('2026-09-21T15:00:00Z') },
      ],
      consultation_outcomes: [
        { id: 'co-ns', scheduled_service_id: 'visit-ns', customer_id: 'cust-1', outcome: 'warm', recorded_at: new Date('2026-09-20T15:00:00Z') },
      ],
      customers: [{ id: 'cust-1' }],
    });
    const result = await reconcileOpenConsultationOutcomes({ now: NOW });
    expect(result.no_show_repaired).toBe(1);
    expect(result.won).toBe(0);
    expect(fakeDb.__store.consultation_outcomes.find((r) => r.id === 'co-ns')).toMatchObject({ outcome: 'lost', lost_reason: 'no_show' });
  });

  test('a non-consultation no-show is left alone; a won outcome on a no-showed consultation is cleared to lost/no_show', async () => {
    const fakeDb = install({
      scheduled_services: [
        { id: 'visit-won', status: 'no_show', service_type: 'Waves Assessment', scheduled_date: '2026-09-20', customer_id: null },
        { id: 'visit-pest', status: 'no_show', service_type: 'Quarterly Pest Control', scheduled_date: '2026-09-20', customer_id: null },
      ],
      consultation_outcomes: [
        { id: 'co-won', scheduled_service_id: 'visit-won', customer_id: null, outcome: 'won' },
      ],
    });
    const result = await reconcileOpenConsultationOutcomes({ now: NOW });
    expect(result.no_show_repaired).toBe(0);
    expect(fakeDb.__store.consultation_outcomes).toHaveLength(1);
    // Codex #4710 r4 P2: a win on a consultation that was no-showed
    // afterwards is cleared by the reopen pass, to markNoShow's own shape.
    expect(fakeDb.__store.consultation_outcomes[0]).toMatchObject({ outcome: 'lost', lost_reason: 'no_show', won_at: null });
  });
});

// ---- Codex #4710 pre-push P1s on the r10 fixes -------------------------------

describe('Codex #4710 pre-push P1: every sweep pass bounds its lock wait; the job-status hook never waits on the customer', () => {
  const NOW = new Date('2026-09-23T12:00:00Z');
  afterEach(() => { db.mockReset(); });

  test('the no-show repair and dead-win reopen passes set lock_timeout before any customer lock in their transaction', async () => {
    const fakeDb = makeFakeDb({
      scheduled_services: [
        { id: 'visit-ns', status: 'no_show', service_type: 'Waves Assessment', scheduled_date: '2026-09-20', customer_id: 'cust-2' },
        { id: 'visit-1', status: 'completed', service_type: 'Waves Assessment', scheduled_date: '2026-09-10', customer_id: 'cust-1' },
        { id: 'sale-1', status: 'cancelled', service_type: 'Quarterly Pest Control', scheduled_date: '2026-09-20', customer_id: 'cust-1', created_at: new Date('2026-09-12T15:00:00Z') },
      ],
      consultation_outcomes: [
        { id: 'co-1', scheduled_service_id: 'visit-1', customer_id: 'cust-1', outcome: 'won', won_via: 'office_booking', won_at: new Date('2026-09-12T15:00:00Z'), won_evidence_booking_id: 'sale-1', pre_win_outcome: 'cold' },
      ],
    });
    let depth = 0;
    let boundedInTx = false;
    const unboundedCustomerLocks = [];
    const spyDb = (name) => {
      if (name === 'customers' && depth > 0 && !boundedInTx) unboundedCustomerLocks.push(name);
      return fakeDb(name);
    };
    spyDb.raw = (sql, bindings) => {
      if (/lock_timeout/i.test(sql)) boundedInTx = true;
      return fakeDb.raw(sql, bindings);
    };
    spyDb.transaction = async (fn) => {
      if (depth === 0) boundedInTx = false;
      depth += 1;
      try { return await fn(spyDb); } finally { depth -= 1; }
    };
    db.mockImplementation(spyDb);
    db.transaction = spyDb.transaction;

    const result = await reconcileOpenConsultationOutcomes({ now: NOW });
    expect(result.no_show_repaired).toBe(1);
    expect(result.reopened).toBe(1);
    expect(unboundedCustomerLocks).toEqual([]);
  });

  test('markNoShow with customerLockNowait takes the customer lock NOWAIT (the job-status hook already holds the visit)', async () => {
    const fakeDb = makeFakeDb({
      scheduled_services: [
        { id: 'visit-ns', status: 'no_show', service_type: 'Waves Assessment', scheduled_date: '2026-09-20', customer_id: 'cust-1' },
      ],
    });
    const customerChains = [];
    const spyDb = (name) => {
      const chain = fakeDb(name);
      if (name === 'customers') customerChains.push(chain);
      return chain;
    };
    spyDb.raw = fakeDb.raw;
    spyDb.transaction = async (fn) => fn(spyDb);
    await markNoShow('visit-ns', { trx: spyDb, customerLockNowait: true });
    expect(customerChains.some((c) => c.__noWait)).toBe(true);
    const src = require('fs').readFileSync(require('path').join(__dirname, '../services/job-status.js'), 'utf8');
    expect(src).toContain('markNoShow(jobId, { trx: sp, customerLockNowait: true })');
  });
});

describe('Codex #4710 r10 pre-push P1: the sweep attributes against the schedule re-read under lock', () => {
  const NOW = new Date('2026-09-23T20:00:00Z');
  afterEach(() => { db.mockReset(); });

  test('a consultation moved later after the batch SELECT is not won by a sale that precedes its new time', async () => {
    const fakeDb = makeFakeDb({
      scheduled_services: [
        { id: 'visit-1', status: 'completed', service_type: 'Waves Assessment', scheduled_date: '2026-09-05', customer_id: 'cust-1' },
        { id: 'sale-1', status: 'confirmed', service_type: 'Quarterly Pest Control', scheduled_date: '2026-09-20', customer_id: 'cust-1', created_at: new Date('2026-09-07T15:00:00Z') },
      ],
      consultation_outcomes: [
        { id: 'co-1', scheduled_service_id: 'visit-1', customer_id: 'cust-1', outcome: 'warm' },
      ],
    });
    // Dispatch moves the consultation to 09-10 the moment the sweep takes
    // the customer lock (after its batch SELECT saw 09-05).
    const spyDb = (name) => {
      if (name === 'customers') {
        const visit = fakeDb.__store.scheduled_services.find((r) => r.id === 'visit-1');
        visit.scheduled_date = '2026-09-10';
      }
      return fakeDb(name);
    };
    spyDb.raw = fakeDb.raw;
    spyDb.transaction = async (fn) => fn(spyDb);
    db.mockImplementation(spyDb);
    db.transaction = spyDb.transaction;

    const result = await reconcileOpenConsultationOutcomes({ now: NOW });
    expect(result.won).toBe(0);
    expect(fakeDb.__store.consultation_outcomes[0].outcome).toBe('warm');
  });
});

// ---- reopenWinsWithDeadEvidence (Codex #4710 r3 P1) ------------------------

describe('reconcileOpenConsultationOutcomes — a win whose evidence booking died is reopened', () => {
  const NOW = new Date('2026-09-23T12:00:00Z');
  function install(seed) {
    const fakeDb = makeFakeDb(seed);
    db.mockImplementation(fakeDb);
    db.transaction = fakeDb.transaction;
    return fakeDb;
  }
  afterEach(() => { db.mockReset(); });

  test.each(['cancelled', 'skipped', 'no_show'])('evidence booking now %s → the row returns to its prior outcome', async (status) => {
    const fakeDb = install({
      scheduled_services: [
        { id: 'visit-1', status: 'completed', service_type: 'Waves Assessment', scheduled_date: '2026-09-10', customer_id: 'cust-1' },
        { id: 'sale-1', status, service_type: 'Quarterly Pest Control', scheduled_date: '2026-09-20', customer_id: 'cust-1', created_at: new Date('2026-09-12T15:00:00Z') },
      ],
      consultation_outcomes: [
        { id: 'co-1', scheduled_service_id: 'visit-1', customer_id: 'cust-1', outcome: 'won', won_via: 'office_booking', won_at: new Date('2026-09-12T15:00:00Z'), won_evidence_booking_id: 'sale-1', pre_win_outcome: 'cold' },
      ],
    });
    const result = await reconcileOpenConsultationOutcomes({ now: NOW });
    expect(result.reopened).toBe(1);
    expect(fakeDb.__store.consultation_outcomes[0]).toMatchObject({ outcome: 'cold', won_at: null, won_via: null, won_evidence_booking_id: null });
  });

  test('local audit P1: an OLD consultation whose win booking died is re-pointed to surviving in-window evidence, not reopened', async () => {
    const fakeDb = install({
      scheduled_services: [
        { id: 'visit-old', status: 'completed', service_type: 'Waves Assessment', scheduled_date: '2026-03-01', customer_id: 'cust-1' },
        { id: 'sale-dead', status: 'cancelled', service_type: 'Quarterly Pest Control', scheduled_date: '2026-03-20', customer_id: 'cust-1', created_at: new Date('2026-03-05T15:00:00Z') },
        { id: 'sale-live', status: 'completed', service_type: 'Lawn Care', scheduled_date: '2026-03-25', customer_id: 'cust-1', created_at: new Date('2026-03-10T15:00:00Z') },
      ],
      consultation_outcomes: [
        { id: 'co-old', scheduled_service_id: 'visit-old', customer_id: 'cust-1', outcome: 'won', won_via: 'office_booking', won_at: new Date('2026-03-05T15:00:00Z'), won_evidence_booking_id: 'sale-dead', pre_win_outcome: 'warm' },
      ],
    });
    const result = await reconcileOpenConsultationOutcomes({ now: NOW });
    expect(result.reopened).toBe(1);
    expect(fakeDb.__store.consultation_outcomes[0]).toMatchObject({ outcome: 'won', won_evidence_booking_id: 'sale-live' });
  });

  test('local audit P1: live wins never starve a dead one — the last_reconciled_at cursor reaches it within ceil(rows/limit) ticks', async () => {
    // Each live win has real in-window evidence (its booking's created_at) —
    // wins are re-judged against evidence (Codex #4710 r10 pre-push P1).
    const live = Array.from({ length: 5 }, (_, i) => ({ id: `sale-live-${i}`, status: 'confirmed', service_type: 'Quarterly Pest Control', scheduled_date: '2026-09-20', customer_id: `cust-${i}`, created_at: new Date('2026-09-12T15:00:00Z') }));
    const fakeDb = install({
      scheduled_services: [
        { id: 'visit-1', status: 'completed', service_type: 'Waves Assessment', scheduled_date: '2026-09-10', customer_id: 'cust-x' },
        { id: 'sale-dead', status: 'skipped', service_type: 'Quarterly Pest Control', scheduled_date: '2026-09-20', customer_id: 'cust-x' },
        ...live,
      ],
      consultation_outcomes: [
        ...live.map((b, i) => ({ id: `co-live-${i}`, scheduled_service_id: 'visit-1', customer_id: `cust-${i}`, outcome: 'won', won_via: 'office_booking', won_at: new Date('2026-09-12T15:00:00Z'), won_evidence_booking_id: b.id })),
        { id: 'co-dead', scheduled_service_id: 'visit-1', customer_id: 'cust-x', outcome: 'won', won_at: new Date('2026-09-19T15:00:00Z'), won_evidence_booking_id: 'sale-dead', pre_win_outcome: 'warm' },
      ],
    });
    let reopened = 0;
    for (let tick = 0; tick < 3; tick += 1) {
       
      reopened += (await reconcileOpenConsultationOutcomes({ now: new Date(NOW.getTime() + tick * 3600e3), limit: 2 })).reopened;
    }
    expect(reopened).toBe(1);
    expect(fakeDb.__store.consultation_outcomes.find((r) => r.id === 'co-dead').outcome).toBe('warm');
  });

  test('local audit P1: a win booking edited into a free re-service (not cancelled) is reopened too', async () => {
    const fakeDb = install({
      scheduled_services: [
        { id: 'visit-1', status: 'completed', service_type: 'Waves Assessment', scheduled_date: '2026-09-10', customer_id: 'cust-1' },
        { id: 'sale-1', status: 'confirmed', service_type: 'Quarterly Pest Control', scheduled_date: '2026-09-20', customer_id: 'cust-1', is_callback: true, estimated_price: '0.00' },
      ],
      consultation_outcomes: [
        { id: 'co-1', scheduled_service_id: 'visit-1', customer_id: 'cust-1', outcome: 'won', won_via: 'office_booking', won_at: new Date('2026-09-12T15:00:00Z'), won_evidence_booking_id: 'sale-1', pre_win_outcome: 'warm' },
      ],
    });
    const result = await reconcileOpenConsultationOutcomes({ now: NOW });
    expect(result.reopened).toBe(1);
    expect(fakeDb.__store.consultation_outcomes[0]).toMatchObject({ outcome: 'warm', won_evidence_booking_id: null });
  });

  test('Codex #4710 r4 P2: an ESTIMATE win (no booking behind it) on a consultation cancelled afterwards is cleared back to its prior outcome', async () => {
    const fakeDb = install({
      scheduled_services: [
        { id: 'visit-1', status: 'cancelled', service_type: 'Waves Assessment', scheduled_date: '2026-09-10', customer_id: 'cust-1' },
      ],
      consultation_outcomes: [
        { id: 'co-1', scheduled_service_id: 'visit-1', customer_id: 'cust-1', outcome: 'won', won_via: 'estimate_accept', won_at: new Date('2026-09-12T15:00:00Z'), won_evidence_booking_id: null, pre_win_outcome: 'cold' },
      ],
    });
    const result = await reconcileOpenConsultationOutcomes({ now: NOW });
    expect(result.reopened).toBe(1);
    expect(fakeDb.__store.consultation_outcomes[0]).toMatchObject({ outcome: 'cold', won_via: null, won_at: null });
  });

  test('local audit P1: a win whose booking now belongs to ANOTHER customer is reopened', async () => {
    const fakeDb = install({
      scheduled_services: [
        { id: 'visit-1', status: 'completed', service_type: 'Waves Assessment', scheduled_date: '2026-09-10', customer_id: 'cust-1' },
        { id: 'sale-1', status: 'confirmed', service_type: 'Quarterly Pest Control', scheduled_date: '2026-09-20', customer_id: 'cust-other' },
      ],
      consultation_outcomes: [
        { id: 'co-1', scheduled_service_id: 'visit-1', customer_id: 'cust-1', outcome: 'won', won_via: 'office_booking', won_at: new Date('2026-09-12T15:00:00Z'), won_evidence_booking_id: 'sale-1', pre_win_outcome: 'warm' },
      ],
    });
    const result = await reconcileOpenConsultationOutcomes({ now: NOW });
    expect(result.reopened).toBe(1);
    expect(fakeDb.__store.consultation_outcomes[0]).toMatchObject({ outcome: 'warm', won_evidence_booking_id: null });
  });

  test('Codex #4710 r9 P2: a sale earlier the SAME day, before the consultation window, is not its evidence', async () => {
    const fakeDb = install({
      scheduled_services: [
        { id: 'visit-1', status: 'completed', service_type: 'Waves Assessment', scheduled_date: '2026-09-10', window_start: '14:00', customer_id: 'cust-1' },
      ],
      estimates: [{ id: 'est-am', customer_id: 'cust-1', status: 'accepted', accepted_at: parseETDateTime('2026-09-10T09:00') }],
      consultation_outcomes: [
        { id: 'co-1', scheduled_service_id: 'visit-1', customer_id: 'cust-1', outcome: 'warm', recorded_at: new Date('2026-09-10T20:00:00Z') },
      ],
    });
    const result = await reconcileOpenConsultationOutcomes({ now: NOW });
    expect(result.won).toBe(0);
    expect(fakeDb.__store.consultation_outcomes[0].outcome).toBe('warm');
  });

  // Codex #4710 r10 pre-push P1: a won consultation moved AFTER its sale is
  // re-judged against its current schedule and cleared.
  // Codex #4710 r11 pre-push P1: a merge repointing the outcome after the
  // batch SELECT must not clear the win against the retired customer.
  test('an outcome repointed to a surviving customer mid-sweep is left won, not cleared', async () => {
    const fakeDb = makeFakeDb({
      scheduled_services: [
        { id: 'visit-1', status: 'completed', service_type: 'Waves Assessment', scheduled_date: '2026-09-10', customer_id: 'cust-old' },
        { id: 'sale-1', status: 'confirmed', service_type: 'Quarterly Pest Control', scheduled_date: '2026-09-20', customer_id: 'cust-old', created_at: new Date('2026-09-12T15:00:00Z') },
      ],
      consultation_outcomes: [
        { id: 'co-1', scheduled_service_id: 'visit-1', customer_id: 'cust-old', outcome: 'won', won_via: 'office_booking', won_at: new Date('2026-09-12T15:00:00Z'), won_evidence_booking_id: 'sale-1', pre_win_outcome: 'warm' },
      ],
    });
    // The merge lands the moment the sweep takes the (old) customer lock.
    let merged = false;
    const spyDb = (name) => {
      if (name === 'customers' && !merged) {
        merged = true;
        fakeDb.__store.consultation_outcomes[0].customer_id = 'cust-new';
        for (const r of fakeDb.__store.scheduled_services) r.customer_id = 'cust-new';
      }
      return fakeDb(name);
    };
    spyDb.raw = fakeDb.raw;
    spyDb.transaction = async (fn) => fn(spyDb);
    db.mockImplementation(spyDb);
    db.transaction = spyDb.transaction;

    const result = await reconcileOpenConsultationOutcomes({ now: NOW });
    expect(result.reopened).toBe(0);
    expect(fakeDb.__store.consultation_outcomes[0]).toMatchObject({ outcome: 'won', won_evidence_booking_id: 'sale-1' });
  });

  test('a won consultation moved later than its sale loses the win', async () => {
    const fakeDb = install({
      scheduled_services: [
        { id: 'visit-1', status: 'confirmed', service_type: 'Waves Assessment', scheduled_date: '2026-09-18', customer_id: 'cust-1' },
        { id: 'sale-1', status: 'confirmed', service_type: 'Quarterly Pest Control', scheduled_date: '2026-09-20', customer_id: 'cust-1', created_at: new Date('2026-09-12T15:00:00Z') },
      ],
      consultation_outcomes: [
        { id: 'co-1', scheduled_service_id: 'visit-1', customer_id: 'cust-1', outcome: 'won', won_via: 'office_booking', won_at: new Date('2026-09-12T15:00:00Z'), won_evidence_booking_id: 'sale-1', pre_win_outcome: 'warm' },
      ],
    });
    const result = await reconcileOpenConsultationOutcomes({ now: NOW });
    expect(result.reopened).toBe(1);
    expect(fakeDb.__store.consultation_outcomes[0]).toMatchObject({ outcome: 'warm', won_evidence_booking_id: null });
  });

  test('a live evidence booking, or a win with no recorded evidence, is left won', async () => {
    const fakeDb = install({
      scheduled_services: [
        { id: 'visit-1', status: 'completed', service_type: 'Waves Assessment', scheduled_date: '2026-09-10', customer_id: 'cust-1' },
        { id: 'sale-1', status: 'confirmed', service_type: 'Quarterly Pest Control', scheduled_date: '2026-09-20', customer_id: 'cust-1', created_at: new Date('2026-09-12T15:00:00Z') },
        { id: 'visit-2', status: 'completed', service_type: 'Waves Assessment', scheduled_date: '2026-09-10', customer_id: 'cust-2' },
      ],
      estimates: [{ id: 'est-2', customer_id: 'cust-2', status: 'accepted', accepted_at: new Date('2026-09-14T15:00:00Z') }],
      consultation_outcomes: [
        { id: 'co-1', scheduled_service_id: 'visit-1', customer_id: 'cust-1', outcome: 'won', won_via: 'office_booking', won_at: new Date('2026-09-12T15:00:00Z'), won_evidence_booking_id: 'sale-1', pre_win_outcome: 'warm' },
        { id: 'co-2', scheduled_service_id: 'visit-2', customer_id: 'cust-2', outcome: 'won', won_via: 'estimate_accept', won_at: new Date('2026-09-14T15:00:00Z'), won_evidence_booking_id: null },
      ],
    });
    const result = await reconcileOpenConsultationOutcomes({ now: NOW });
    expect(result.reopened).toBe(0);
    expect(fakeDb.__store.consultation_outcomes.every((r) => r.outcome === 'won')).toBe(true);
  });

  test('Codex #4710 r13 P2: the visit is locked (forNoKeyUpdate) while its evidence is rejudged, under the already-held customer lock', async () => {
    // Outcome stays 'won' (live evidence still stands, stampOnly branch) so
    // this row is NOT re-selected by the ordinary win pass that runs after
    // reopenWinsWithDeadEvidence within the same sweep (that pass only
    // picks up CONVERTIBLE_OUTCOMES = warm/cold/lost, and it has its own,
    // separate forNoKeyUpdate call via lockedConsultationVisit) — isolating
    // the lock call under test to reopenWinsWithDeadEvidence's own read.
    const fakeDb = install({
      scheduled_services: [
        { id: 'visit-1', status: 'completed', service_type: 'Waves Assessment', scheduled_date: '2026-09-10', customer_id: 'cust-1' },
        { id: 'sale-1', status: 'confirmed', service_type: 'Quarterly Pest Control', scheduled_date: '2026-09-20', customer_id: 'cust-1', created_at: new Date('2026-09-12T15:00:00Z') },
      ],
      consultation_outcomes: [
        { id: 'co-1', scheduled_service_id: 'visit-1', customer_id: 'cust-1', outcome: 'won', won_via: 'office_booking', won_at: new Date('2026-09-12T15:00:00Z'), won_evidence_booking_id: 'sale-1', pre_win_outcome: 'warm' },
      ],
    });
    let sawVisitLock = false;
    let customerLockedBeforeVisitLock = false;
    let customerLocked = false;
    // The fake table shim's forNoKeyUpdate is a no-op (returns the same
    // chainable api) — wrap it per-table so the visit-lock call is
    // observable, same technique as the customer -> visit lock-order test
    // above.
    const spyDb = (name) => {
      const q = fakeDb(name);
      if (name === 'customers') {
        const orig = q.forNoKeyUpdate;
        q.forNoKeyUpdate = (...args) => { customerLocked = true; return orig.apply(q, args); };
      }
      if (name === 'scheduled_services') {
        const orig = q.forNoKeyUpdate;
        q.forNoKeyUpdate = (...args) => {
          sawVisitLock = true;
          if (customerLocked) customerLockedBeforeVisitLock = true;
          return orig.apply(q, args);
        };
      }
      return q;
    };
    spyDb.raw = fakeDb.raw;
    spyDb.transaction = async (fn) => fn(spyDb);
    db.mockImplementation(spyDb);
    db.transaction = spyDb.transaction;

    const result = await reconcileOpenConsultationOutcomes({ now: NOW });
    expect(result.reopened).toBe(0);
    expect(fakeDb.__store.consultation_outcomes[0].outcome).toBe('won');
    expect(sawVisitLock).toBe(true);
    expect(customerLockedBeforeVisitLock).toBe(true);
  });
});
