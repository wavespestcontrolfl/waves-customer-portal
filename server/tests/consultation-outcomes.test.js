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
function pick(row, cols) {
  if (!cols.length) return row;
  const out = {};
  cols.forEach((c) => { out[c] = row[c]; });
  return out;
}

function makeFakeDb(seed = {}) {
  const store = {
    scheduled_services: seed.scheduled_services || [],
    services: seed.services || [],
    leads: seed.leads || [],
    consultation_outcomes: seed.consultation_outcomes || [],
  };
  let nextId = 1;

  function table(name) {
    const rows = store[name] || (store[name] = []);
    let filtered = rows;
    let insertPayload = null;

    function applyObjectWhere(cond) {
      filtered = filtered.filter((r) => Object.entries(cond).every(([k, v]) => r[k] === v));
    }
    function applyFnWhere(fn) {
      const clauses = { eq: [], orIn: [] };
      fn.call({
        where(col, val) { clauses.eq.push([col, val]); return this; },
        orWhereIn(col, arr) { clauses.orIn.push([col, arr]); return this; },
      });
      filtered = filtered.filter((r) => {
        const eqMatch = clauses.eq.every(([c, v]) => r[c] === v);
        if (eqMatch) return true;
        return clauses.orIn.some(([c, arr]) => arr.includes(r[c]));
      });
    }

    const api = {
      where(...args) {
        if (args.length === 1 && typeof args[0] === 'function') applyFnWhere(args[0]);
        else if (args.length === 1 && typeof args[0] === 'object') applyObjectWhere(args[0]);
        else if (args.length === 2) filtered = filtered.filter((r) => r[args[0]] === args[1]);
        else if (args.length === 3) {
          const [col, op, val] = args;
          filtered = filtered.filter((r) => {
            const rv = r[col];
            if (op === '>=') return rv >= val;
            if (op === '<=') return rv <= val;
            return rv === val;
          });
        }
        return api;
      },
      whereNull(col) { filtered = filtered.filter((r) => r[col] == null); return api; },
      whereIn(col, arr) { filtered = filtered.filter((r) => arr.includes(r[col])); return api; },
      orderBy(col, dir = 'asc') {
        filtered = [...filtered].sort((a, b) => {
          if (a[col] === b[col]) return 0;
          const gt = a[col] > b[col];
          return dir === 'desc' ? (gt ? -1 : 1) : (gt ? 1 : -1);
        });
        return api;
      },
      select: (...cols) => Promise.resolve(filtered.map((r) => pick(r, cols))),
      first: (...cols) => Promise.resolve(filtered[0] ? pick(filtered[0], cols) : undefined),
      insert(payload) { insertPayload = { ...payload }; return api; },
      onConflict() { return api; },
      merge(fields) {
        const idx = rows.findIndex((r) => r.scheduled_service_id === insertPayload.scheduled_service_id);
        if (idx >= 0) {
          rows[idx] = { ...rows[idx], ...fields };
          return { returning: () => Promise.resolve([rows[idx]]) };
        }
        const row = { id: `gen-${nextId++}`, ...insertPayload };
        rows.push(row);
        return { returning: () => Promise.resolve([row]) };
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
        const result = Promise.resolve(filtered.length);
        result.returning = () => Promise.resolve(filtered.slice());
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
      ],
      leads: [{ id: 'lead-9', customer_id: 'cust-1' }],
      consultation_outcomes: [
        { id: 'co-recent', scheduled_service_id: 'visit-recent', customer_id: 'cust-1', lead_id: null, outcome: 'warm' },
        { id: 'co-old', scheduled_service_id: 'visit-old', customer_id: 'cust-1', lead_id: null, outcome: 'cold' },
        { id: 'co-lead', scheduled_service_id: 'visit-lead', customer_id: null, lead_id: 'lead-9', outcome: 'warm' },
        { id: 'co-already-lost', scheduled_service_id: 'visit-already-lost', customer_id: 'cust-1', lead_id: null, outcome: 'lost' },
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
});
