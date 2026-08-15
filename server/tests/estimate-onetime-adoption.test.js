/**
 * One-time estimate adoption (owner ruling 2026-08-15; #3328 follow-up).
 *
 * Before this change the accept preflight and its under-lock revalidation
 * family-checked with the RAW request serviceMode. A structurally one-time
 * estimate renders no mode toggle, so the request mode defaulted to
 * 'recurring' — whose family set is EMPTY for a one-time-only estimate — and
 * the very appointment the /data contract offered was rejected with a 409 the
 * customer could not act on. The offer sites already scoped eligibility with
 * adoptionServiceModesForContract; the accept path now does the same, and the
 * adopted row gains the #3328 catalog-identity stamp
 * (adoptedAppointmentCatalogStamp) with fail-toward-no-stamp guards.
 *
 * Suite drives the REAL helpers with realistic estimate_data (lane doctrine:
 * fabricated profiles hid this bug class three times in #3328).
 */

jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn(() => false),
  gates: {},
}));

const {
  findLinkedUpcomingAppointment,
  adoptionServiceModesForContract,
  estimateFamilyKeysForAdoption,
  appointmentMatchesEstimateFamily,
  adoptedAppointmentCatalogStamp,
} = require('../routes/estimate-public');

// A structurally ONE-TIME-ONLY estimate: one-time spec items, no recurring
// services and no recurring totals — the shape a wasp-nest / roach-cleanout /
// pre-slab quote actually persists.
const oneTimeEstimate = (specItems) => ({
  id: 'est-1',
  customer_id: 'cust-1',
  service_interest: 'Pest Control',
  show_one_time_option: false,
  estimate_data: {
    scheduled_service_id: 'appt-1',
    result: {
      oneTime: {
        specItems: specItems || [{ service: 'stinging_insect', name: 'Wasp Nest Removal', price: 250 }],
        total: (specItems || [{ price: 250 }]).reduce((s, i) => s + (i.price || 0), 0),
      },
    },
  },
});

const WASP_ROW = {
  id: 'appt-1',
  customer_id: 'cust-1',
  status: 'confirmed',
  service_type: 'Wasp Nest Removal',
  is_callback: false,
};

// Chainable fake knex connection (pattern from
// estimate-existing-appt-customer-wide.test.js): `.first()` resolves the
// queued result for the Nth conn() invocation.
function makeFakeConn(resultsByQuery) {
  const queries = [];
  const conn = () => {
    const rec = { clauses: [] };
    const index = queries.length;
    queries.push(rec);
    const record = (method) => (...args) => {
      rec.clauses.push([method, args]);
      if (typeof args[0] === 'function') args[0](nestedBuilder(rec));
      return q;
    };
    const q = {};
    ['whereIn', 'where', 'andWhere', 'orWhere', 'whereNull', 'orWhereRaw', 'orderBy', 'limit', 'offset', 'leftJoin', 'select'].forEach((m) => {
      q[m] = record(m);
    });
    q.first = async () => {
      const r = resultsByQuery[index] ?? null;
      return Array.isArray(r) ? (r[0] ?? null) : r;
    };
    q.then = (resolve, reject) => Promise.resolve(resultsByQuery[index] ?? null).then(resolve, reject);
    return q;
  };
  conn.queries = queries;
  return conn;
}

function nestedBuilder(rec) {
  const b = {};
  ['where', 'orWhere', 'whereNull', 'orWhereNull', 'orWhereRaw', 'whereRaw'].forEach((m) => {
    b[m] = (...args) => {
      rec.clauses.push([`nested.${m}`, args]);
      if (typeof args[0] === 'function') args[0](nestedBuilder(rec));
      return b;
    };
  });
  return b;
}

describe('contract modes for a structurally one-time estimate', () => {
  test('resolve to exactly [one_time] — no toggle, no recurring mode', () => {
    const est = oneTimeEstimate();
    expect(adoptionServiceModesForContract(est, est.estimate_data)).toEqual(['one_time']);
  });

  test('family keys are NON-empty under the contract modes but EMPTY under the raw recurring default — the exact 409 mechanism this change removes', () => {
    const est = oneTimeEstimate();
    const contractKeys = estimateFamilyKeysForAdoption(est, est.estimate_data, {
      serviceModes: adoptionServiceModesForContract(est, est.estimate_data),
    });
    expect(contractKeys.size).toBeGreaterThan(0);
    expect(appointmentMatchesEstimateFamily(WASP_ROW, contractKeys)).toBe(true);
    // The pre-change accept passed { serviceMode: 'recurring' } here.
    const rawRecurringKeys = estimateFamilyKeysForAdoption(est, est.estimate_data, {
      serviceMode: 'recurring',
    });
    expect(rawRecurringKeys.size).toBe(0);
  });
});

describe('findLinkedUpcomingAppointment for a one-time estimate', () => {
  test('returns the linked same-family row under contract modes', async () => {
    const est = oneTimeEstimate();
    const row = await findLinkedUpcomingAppointment(est, est.estimate_data, {
      appointmentId: 'appt-1',
      serviceModes: adoptionServiceModesForContract(est, est.estimate_data),
      database: makeFakeConn([WASP_ROW]),
    });
    expect(row).toBeTruthy();
    expect(row.id).toBe('appt-1');
  });

  test('REGRESSION PIN: the raw recurring default rejected that same row', async () => {
    const est = oneTimeEstimate();
    const row = await findLinkedUpcomingAppointment(est, est.estimate_data, {
      appointmentId: 'appt-1',
      serviceMode: 'recurring',
      database: makeFakeConn([WASP_ROW]),
    });
    expect(row).toBeNull();
  });

  test('cross-family rows still never adopt (codex #3228 r4/r8 preserved)', async () => {
    const est = oneTimeEstimate();
    const lawnRow = { ...WASP_ROW, service_type: 'Lawn Care' };
    const row = await findLinkedUpcomingAppointment(est, est.estimate_data, {
      appointmentId: 'appt-1',
      serviceModes: adoptionServiceModesForContract(est, est.estimate_data),
      database: makeFakeConn([lawnRow]),
    });
    expect(row).toBeNull();
  });
});

describe('accept-path wiring (source pins)', () => {
  // The eligibility scope is a wiring property of the route handler — a unit
  // test cannot observe which opts the handler passes, so the wiring is
  // pinned at the source level (pattern: #3401 guard test).
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'estimate-public.js'), 'utf8');

  test('the accept preflight passes contract modes, not the raw request mode', () => {
    expect(src).toMatch(/appointmentId: existingAppointmentId,\s*\n\s*serviceModes: adoptionServiceModesForContract\(estimate, estData\),/);
  });

  test('the under-lock revalidation uses the same contract-modes scope', () => {
    expect(src).toMatch(/const lockedFamilyKeys = estimateFamilyKeysForAdoption\(estimate, estData, \{\s*\n\s*serviceModes: adoptionServiceModesForContract\(estimate, estData\),/);
  });

  test('the adopted row is stamped with the accept-path triple, reading the row loaded UNDER LOCK', () => {
    // `lockedAdoptRow`, not the stale preflight `existingAppointmentRow`: a
    // service_id assigned by an admin between the preflight read and the
    // FOR UPDATE reload must win the no-overwrite guard (pre-push codex P1).
    expect(src).toMatch(/adoptedAppointmentCatalogStamp\(trx, \{\s*\n\s*existingAppointmentRow: lockedAdoptRow,\s*\n\s*estimate: acceptedEstimateForScheduling,\s*\n\s*serviceMode: treatAsOneTime \? 'one_time' : serviceMode,\s*\n\s*selectedFrequency: acceptedSchedulingFrequencyKey,/);
  });
});

describe('adoptedAppointmentCatalogStamp', () => {
  // Fake conn modeling the savepoint contract of catalogServiceIdForProfile
  // (pattern: accept-path-service-identity.test.js).
  const makeCatalogConn = (onQuery) => {
    const builder = () => ({
      whereRaw: (_sql, b) => ({
        andWhere: (w) => ({ limit: () => ({ select: async () => onQuery(b, w) }) }),
      }),
    });
    builder.transaction = async (cb) => cb(builder);
    return builder;
  };

  test('stamps the catalog id for a single-service one-time accept, querying the RAW engine key', async () => {
    let bindings = null;
    const stamp = await adoptedAppointmentCatalogStamp(
      makeCatalogConn((b) => { bindings = b; return [{ id: 'svc-wasp' }]; }),
      {
        existingAppointmentRow: { ...WASP_ROW, service_id: null },
        estimate: oneTimeEstimate(),
        serviceMode: 'one_time',
        selectedFrequency: '',
      },
    );
    expect(stamp).toEqual({ service_id: 'svc-wasp' });
    expect(bindings).toEqual([JSON.stringify(['stinging_insect'])]);
  });

  test('NEVER overwrites a pre-existing service_id (admin repoint outranks) — and never queries', async () => {
    const conn = makeCatalogConn(() => { throw new Error('must not query'); });
    const stamp = await adoptedAppointmentCatalogStamp(conn, {
      existingAppointmentRow: { ...WASP_ROW, service_id: 'svc-admin' },
      estimate: oneTimeEstimate(),
      serviceMode: 'one_time',
    });
    expect(stamp).toBeNull();
  });

  test('REGRESSION (pre-push codex P1): a service_id assigned BETWEEN preflight and lock wins — the locked row is authoritative and no stamp is computed', async () => {
    // Preflight saw service_id null; an admin repointed the visit before the
    // FOR UPDATE reload. The stamp call receives the LOCKED row (see the
    // wiring pin above), so the guard must see the new id and stand down.
    const preflightRow = { ...WASP_ROW, service_id: null };
    const lockedRow = { ...preflightRow, service_id: 'svc-admin-race' };
    const conn = makeCatalogConn(() => { throw new Error('must not query'); });
    const stamp = await adoptedAppointmentCatalogStamp(conn, {
      existingAppointmentRow: lockedRow,
      estimate: oneTimeEstimate(),
      serviceMode: 'one_time',
    });
    expect(stamp).toBeNull();
  });

  test('multi-service one-time bundles stay UNTAGGED (owner ruling 2026-08-15)', async () => {
    const conn = makeCatalogConn(() => { throw new Error('must not query'); });
    const stamp = await adoptedAppointmentCatalogStamp(conn, {
      existingAppointmentRow: { ...WASP_ROW, service_id: null },
      estimate: oneTimeEstimate([
        { service: 'stinging_insect', name: 'Wasp Nest Removal', price: 175 },
        { service: 'german_roach', name: 'German Roach Cleanout', price: 350 },
      ]),
      serviceMode: 'one_time',
    });
    expect(stamp).toBeNull();
  });

  test('unmapped engine key stamps nothing (today\'s behavior, fail open)', async () => {
    const stamp = await adoptedAppointmentCatalogStamp(makeCatalogConn(() => []), {
      existingAppointmentRow: { ...WASP_ROW, service_id: null },
      estimate: oneTimeEstimate(),
      serviceMode: 'one_time',
    });
    expect(stamp).toBeNull();
  });

  test('no estimate → no stamp', async () => {
    const stamp = await adoptedAppointmentCatalogStamp(makeCatalogConn(() => [{ id: 'x' }]), {
      existingAppointmentRow: { ...WASP_ROW, service_id: null },
      estimate: null,
      serviceMode: 'one_time',
    });
    expect(stamp).toBeNull();
  });
});
