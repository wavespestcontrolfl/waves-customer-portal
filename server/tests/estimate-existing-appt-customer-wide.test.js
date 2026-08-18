jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn(() => false),
  gates: {},
}));

const featureGates = require('../config/feature-gates');
const { findLinkedUpcomingAppointment } = require('../routes/estimate-public');

// Chainable fake knex connection: records every clause per query so the tests
// can assert WHICH query ran and what it filtered on; `.first()` resolves the
// next queued result (one per conn() invocation, in order).
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
    // The family-scoped fallback awaits the builder itself (a candidate LIST,
    // not .first()) — make the fake thenable, resolving the queued result.
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

function clauseArgs(rec, method) {
  return rec.clauses.filter(([m]) => m === method).map(([, args]) => args);
}

// The estimate covers quarterly pest — the fallback may only offer rows of
// that family (family-scoped, owner case 2026-08-05).
const ESTIMATE = {
  id: 'est-1',
  customer_id: 'cust-1',
  estimate_data: JSON.stringify({
    result: {
      recurring: {
        services: [{
          name: 'Quarterly Pest Control Service',
          service: 'pest_control',
          frequency: 'quarterly',
          selected: true,
          isSelected: true,
        }],
      },
    },
  }),
};
const LINKED_ROW = {
  id: 'ss-linked',
  customer_id: 'cust-1',
  source_estimate_id: 'est-1',
  service_type: 'Quarterly Pest Control Service',
};
// An estimate-linked row of a DIFFERENT family — the r8 gate rejects it so a
// cross-family selection can't commit and overwrite it.
const LINKED_ROW_CROSS_FAMILY = {
  id: 'ss-linked-ts',
  customer_id: 'cust-1',
  source_estimate_id: 'est-1',
  service_type: 'Bi-Monthly Tree & Shrub Care Service',
};
const CW_ROW = {
  id: 'ss-anywhere',
  customer_id: 'cust-1',
  source_estimate_id: null,
  service_type: 'Quarterly Pest Control Service',
};
// An upcoming visit of a DIFFERENT family — must never stand in for this
// estimate's first visit (the owner-case 2026-08-05 clobber).
const CW_ROW_CROSS_FAMILY = {
  id: 'ss-tree-shrub',
  customer_id: 'cust-1',
  source_estimate_id: null,
  service_type: 'Bi-Monthly Tree & Shrub Care Service',
};

beforeEach(() => {
  featureGates.isEnabled.mockReset();
  featureGates.isEnabled.mockReturnValue(false);
});

describe('findLinkedUpcomingAppointment — customer-wide fallback (gated)', () => {
  it('gate OFF: no linked row → null, and the customer-wide query never runs', async () => {
    const conn = makeFakeConn([null]);
    const row = await findLinkedUpcomingAppointment(ESTIMATE, null, { database: conn });
    expect(row).toBe(null);
    expect(conn.queries).toHaveLength(1);
  });

  it('gate OFF: linked row behavior is unchanged', async () => {
    const conn = makeFakeConn([LINKED_ROW]);
    const row = await findLinkedUpcomingAppointment(ESTIMATE, null, { database: conn });
    expect(row).toEqual(LINKED_ROW);
    expect(conn.queries).toHaveLength(1);
  });

  it('gate ON: linked row still takes precedence — customer-wide query never runs', async () => {
    featureGates.isEnabled.mockImplementation((k) => k === 'estimateExistingApptCustomerWide');
    const conn = makeFakeConn([LINKED_ROW, CW_ROW]);
    const row = await findLinkedUpcomingAppointment(ESTIMATE, null, { database: conn });
    expect(row).toEqual(LINKED_ROW);
    expect(conn.queries).toHaveLength(1);
  });

  it('gate ON: no linked row → falls back to an upcoming unclaimed SAME-FAMILY appointment', async () => {
    featureGates.isEnabled.mockImplementation((k) => k === 'estimateExistingApptCustomerWide');
    const conn = makeFakeConn([null, [CW_ROW]]);
    const row = await findLinkedUpcomingAppointment(ESTIMATE, null, { database: conn });
    expect(row).toEqual(CW_ROW);
    expect(conn.queries).toHaveLength(2);

    // The fallback query is strictly scoped: this customer's rows only, never
    // a row another estimate already claimed, never a reservation hold.
    const cw = conn.queries[1];
    expect(clauseArgs(cw, 'where')).toEqual(
      expect.arrayContaining([['customer_id', 'cust-1']])
    );
    const nullChecks = clauseArgs(cw, 'whereNull').flat();
    expect(nullChecks).toEqual(
      expect.arrayContaining(['source_estimate_id', 'reservation_expires_at'])
    );
    // Same upcoming/status guards as the linked query (columns qualified —
    // the fallback left-joins `services` for catalog identity).
    expect(clauseArgs(cw, 'whereIn')).toEqual(
      expect.arrayContaining([['scheduled_services.status', ['pending', 'confirmed']]])
    );
    expect(clauseArgs(cw, 'leftJoin')).toEqual(
      expect.arrayContaining([['services', 'services.id', 'scheduled_services.service_id']])
    );
  });

  it('gate ON but the estimate has no customer → fallback never runs', async () => {
    featureGates.isEnabled.mockImplementation((k) => k === 'estimateExistingApptCustomerWide');
    const conn = makeFakeConn([null, CW_ROW]);
    const row = await findLinkedUpcomingAppointment(
      { id: 'est-1', customer_id: null, estimate_data: '{}' },
      null,
      { database: conn }
    );
    expect(row).toBe(null);
    expect(conn.queries).toHaveLength(1);
  });

  it('gate ON: a cross-family upcoming appointment is NEVER offered — falls through to the slot picker', async () => {
    featureGates.isEnabled.mockImplementation((k) => k === 'estimateExistingApptCustomerWide');
    const conn = makeFakeConn([null, [CW_ROW_CROSS_FAMILY]]);
    const row = await findLinkedUpcomingAppointment(ESTIMATE, null, { database: conn });
    expect(row).toBe(null);
  });

  it('gate ON: with mixed candidates only the same-family row is offered', async () => {
    featureGates.isEnabled.mockImplementation((k) => k === 'estimateExistingApptCustomerWide');
    const conn = makeFakeConn([null, [CW_ROW_CROSS_FAMILY, CW_ROW]]);
    const row = await findLinkedUpcomingAppointment(ESTIMATE, null, { database: conn });
    expect(row).toEqual(CW_ROW);
  });

  it('gate ON: an estimate with no resolvable service families never adopts (fallback query never runs)', async () => {
    featureGates.isEnabled.mockImplementation((k) => k === 'estimateExistingApptCustomerWide');
    const conn = makeFakeConn([null, [CW_ROW]]);
    const row = await findLinkedUpcomingAppointment(
      { id: 'est-1', customer_id: 'cust-1', estimate_data: '{}' },
      null,
      { database: conn }
    );
    expect(row).toBe(null);
    expect(conn.queries).toHaveLength(1);
  });

  it('gate ON: the accept-side re-resolve (appointmentId) reaches the fallback query too', async () => {
    featureGates.isEnabled.mockImplementation((k) => k === 'estimateExistingApptCustomerWide');
    const conn = makeFakeConn([null, [CW_ROW]]);
    const row = await findLinkedUpcomingAppointment(ESTIMATE, null, {
      database: conn,
      appointmentId: 'ss-anywhere',
    });
    expect(row).toEqual(CW_ROW);
    // Both queries pin the requested id (columns qualified — both join
    // `services`, where a bare `id` would be ambiguous).
    expect(clauseArgs(conn.queries[0], 'where')).toEqual(
      expect.arrayContaining([['scheduled_services.id', 'ss-anywhere']])
    );
    expect(clauseArgs(conn.queries[1], 'where')).toEqual(
      expect.arrayContaining([['scheduled_services.id', 'ss-anywhere']])
    );
  });

  it('a CROSS-FAMILY estimate-linked row is rejected by the family gate (codex r8)', async () => {
    featureGates.isEnabled.mockReturnValue(false);
    const conn = makeFakeConn([LINKED_ROW_CROSS_FAMILY]);
    const row = await findLinkedUpcomingAppointment(ESTIMATE, null, { database: conn });
    expect(row).toBe(null);
  });

  it('a linked row is exempt from the family gate when the estimate derives NO families (legacy shapes)', async () => {
    featureGates.isEnabled.mockReturnValue(false);
    const conn = makeFakeConn([LINKED_ROW_CROSS_FAMILY]);
    const row = await findLinkedUpcomingAppointment(
      { id: 'est-1', customer_id: 'cust-1', estimate_data: '{}' },
      null,
      { database: conn }
    );
    expect(row).toEqual(LINKED_ROW_CROSS_FAMILY);
  });

  it('gate ON: a fallback row that is not the requested id is rejected (id pinning)', async () => {
    featureGates.isEnabled.mockImplementation((k) => k === 'estimateExistingApptCustomerWide');
    const conn = makeFakeConn([null, [{ ...CW_ROW, id: 'ss-other' }]]);
    const row = await findLinkedUpcomingAppointment(ESTIMATE, null, {
      database: conn,
      appointmentId: 'ss-anywhere',
    });
    expect(row).toBe(null);
  });
});

// ── Property scope (cross-property accept incident, 08-15) ──────────────
// The customer-wide fallback was property-blind for UNGROUPED estimates:
// an existing customer accepting a plan for a NEW property adopted their
// old property's upcoming visit as the plan's first visit. The scope now
// arms for every estimate with property evidence: property_id equality
// when both sides carry it, otherwise the locality-qualified street
// compare with the customer's primary address as the unstamped fallback.
// Addresses below are synthetic fixtures, not customer data.
describe('findLinkedUpcomingAppointment — property scope on the customer-wide fallback', () => {
  const ESTIMATE_NEW_PROPERTY = {
    ...ESTIMATE,
    // Ungrouped (no estimate_group_id) — the pre-fix blind spot.
    address: '200 Second Home Rd, Venice, FL 34285',
  };
  const PRIMARY_CUSTOMER_ROW = {
    address_line1: '100 Primary Home St',
    address_line2: null,
    city: 'Venice',
    zip: '34285',
  };

  beforeEach(() => {
    featureGates.isEnabled.mockImplementation((k) => k === 'estimateExistingApptCustomerWide');
  });

  it('REGRESSION: an ungrouped new-property estimate must NOT adopt an unstamped visit at the primary property', async () => {
    // Query order: linked → null; candidates → [unstamped CW_ROW];
    // lazy primary-address read → the primary street. Primary ≠ estimate street ⇒
    // the primary-property visit is refused and the slot picker books the new property.
    const conn = makeFakeConn([null, [CW_ROW], PRIMARY_CUSTOMER_ROW]);
    const row = await findLinkedUpcomingAppointment(ESTIMATE_NEW_PROPERTY, null, { database: conn });
    expect(row).toBe(null);
  });

  it('an estimate at the customer PRIMARY property still adopts an unstamped visit (single-property common case)', async () => {
    const est = { ...ESTIMATE, address: '100 Primary Home St, Venice, FL 34285' };
    const conn = makeFakeConn([null, [CW_ROW], PRIMARY_CUSTOMER_ROW]);
    const row = await findLinkedUpcomingAppointment(est, null, { database: conn });
    expect(row).toEqual(CW_ROW);
  });

  it('a candidate STAMPED at the estimate property adopts even when the primary differs', async () => {
    const stamped = {
      ...CW_ROW,
      service_address_line1: '200 Second Home Rd',
      service_address_city: 'Venice',
      service_address_zip: '34285',
    };
    // No customers read needed — the stamped street resolves directly.
    const conn = makeFakeConn([null, [stamped]]);
    const row = await findLinkedUpcomingAppointment(ESTIMATE_NEW_PROPERTY, null, { database: conn });
    expect(row).toEqual(stamped);
  });

  it('property_id is authoritative when both sides carry it: mismatch refuses, match adopts, no street compare', async () => {
    const estWithPid = { ...ESTIMATE_NEW_PROPERTY, property_id: 'prop-second-home' };
    const wrongProp = { ...CW_ROW, property_id: 'prop-primary-home' };
    const rightProp = { ...CW_ROW, property_id: 'prop-second-home' };

    let conn = makeFakeConn([null, [wrongProp]]);
    expect(await findLinkedUpcomingAppointment(estWithPid, null, { database: conn })).toBe(null);

    conn = makeFakeConn([null, [rightProp]]);
    expect(await findLinkedUpcomingAppointment(estWithPid, null, { database: conn })).toEqual(rightProp);
    // The id compare decided it — the lazy primary-address read never fired.
    expect(conn.queries).toHaveLength(2);
  });

  it('an estimate with NO property evidence keeps the historical fail-open adopt', async () => {
    // ESTIMATE has no address and no property_id — legacy escape.
    const conn = makeFakeConn([null, [CW_ROW]]);
    const row = await findLinkedUpcomingAppointment(ESTIMATE, null, { database: conn });
    expect(row).toEqual(CW_ROW);
  });

  it('fails CLOSED on a street-only stamped candidate that cannot prove its locality', async () => {
    const streetOnly = {
      ...CW_ROW,
      service_address_line1: '200 Second Home Rd',
      service_address_city: null,
      service_address_zip: null,
    };
    const conn = makeFakeConn([null, [streetOnly]]);
    const row = await findLinkedUpcomingAppointment(ESTIMATE_NEW_PROPERTY, null, { database: conn });
    expect(row).toBe(null);
  });

  // Unit semantics (codex #3431 r2): the unit token discriminates only when
  // the ESTIMATE supplies one — the estimateQuotesCustomerAddress contract.
  it('a UNITLESS estimate still adopts at the customer\'s unit-bearing primary (unit ignored when the estimate omits it)', async () => {
    const est = { ...ESTIMATE, address: '100 Primary Home St, Venice, FL 34285' };
    const primaryWithUnit = { ...PRIMARY_CUSTOMER_ROW, address_line2: 'Apt 4' };
    // Unstamped candidate → primary fallback; primary carries a unit the
    // estimate doesn't. Pre-fix the unit token poisoned the key compare and
    // the customer's own visit was refused.
    const conn = makeFakeConn([null, [CW_ROW], primaryWithUnit]);
    const row = await findLinkedUpcomingAppointment(est, null, { database: conn });
    expect(row).toEqual(CW_ROW);
  });

  // Street-only + free-text evidence bars (codex #3431 r3).
  it('a STREET-ONLY estimate refuses a same-named street stamped in ANOTHER city (locality borrowed from the primary)', async () => {
    const streetOnly = { ...ESTIMATE, address: '100 Primary Home St' };
    const otherCity = {
      ...CW_ROW,
      service_address_line1: '100 Primary Home St',
      service_address_city: 'Nokomis',
      service_address_zip: '34275',
    };
    const conn = makeFakeConn([null, [otherCity], PRIMARY_CUSTOMER_ROW]);
    expect(await findLinkedUpcomingAppointment(streetOnly, null, { database: conn })).toBe(null);
  });

  it('a STREET-ONLY estimate matching the primary street still adopts the unstamped candidate (single-property case)', async () => {
    const streetOnly = { ...ESTIMATE, address: '100 Primary Home St' };
    const conn = makeFakeConn([null, [CW_ROW], PRIMARY_CUSTOMER_ROW]);
    expect(await findLinkedUpcomingAppointment(streetOnly, null, { database: conn })).toEqual(CW_ROW);
  });

  it('a STREET-ONLY estimate whose street differs from the primary fails CLOSED (no locality evidence)', async () => {
    const streetOnly = { ...ESTIMATE, address: '200 Second Home Rd' };
    const conn = makeFakeConn([null, [CW_ROW], PRIMARY_CUSTOMER_ROW]);
    expect(await findLinkedUpcomingAppointment(streetOnly, null, { database: conn })).toBe(null);
  });

  it('free-text non-address snapshots carry NO property evidence — the historical fail-open adopt stands', async () => {
    const freeText = { ...ESTIMATE, address: 'the yellow house behind the marina' };
    const conn = makeFakeConn([null, [CW_ROW]]);
    expect(await findLinkedUpcomingAppointment(freeText, null, { database: conn })).toEqual(CW_ROW);
  });

  it('disjoint locality evidence refuses adoption; shared evidence adopts (codex r6)', async () => {
    // Two-segment estimate carries city but no zip; a zip-only stamped
    // candidate shares NO locality field — sameScopeKey alone would
    // wildcard through. Refuse to the slot picker.
    const cityOnlyEstimate = { ...ESTIMATE, address: '100 Primary Home St, Venice' };
    const zipOnlyCand = {
      ...CW_ROW,
      service_address_line1: '100 Primary Home St',
      service_address_city: null,
      service_address_zip: '34275',
    };
    let conn = makeFakeConn([null, [zipOnlyCand]]);
    expect(await findLinkedUpcomingAppointment(cityOnlyEstimate, null, { database: conn })).toBe(null);

    const cityCand = {
      ...CW_ROW,
      service_address_line1: '100 Primary Home St',
      service_address_city: 'Venice',
      service_address_zip: null,
    };
    conn = makeFakeConn([null, [cityCand]]);
    expect(await findLinkedUpcomingAppointment(cityOnlyEstimate, null, { database: conn })).toEqual(cityCand);
  });

  it('a STRUCTURED numberless address (named building) fails CLOSED instead of fail-open (codex r12)', async () => {
    const building = { ...ESTIMATE, address: 'Harbor Plaza Building, Venice, FL 34285' };
    const conn = makeFakeConn([null, [CW_ROW]]);
    expect(await findLinkedUpcomingAppointment(building, null, { database: conn })).toBe(null);
  });

  it('a property_id-LINKED estimate with no usable address fails CLOSED against unstamped candidates (codex r5)', async () => {
    // The estimate has property evidence (the id) even though its address
    // is free text; a legacy candidate without an id cannot prove it
    // belongs to that property — slot picker instead of adoption.
    const pidOnly = { ...ESTIMATE, address: 'the yellow house behind the marina', property_id: 'prop-second-home' };
    const conn = makeFakeConn([null, [CW_ROW]]);
    expect(await findLinkedUpcomingAppointment(pidOnly, null, { database: conn })).toBe(null);
  });

  it('an estimate WITH a unit stays strict: Apt 5 must not adopt the Apt 4-stamped candidate, Apt 4 does', async () => {
    const stampedApt4 = {
      ...CW_ROW,
      service_address_line1: '100 Primary Home St',
      service_address_line2: 'Apt 4',
      service_address_city: 'Venice',
      service_address_zip: '34285',
    };
    let conn = makeFakeConn([null, [stampedApt4], PRIMARY_CUSTOMER_ROW]);
    const wrongUnit = { ...ESTIMATE, address: '100 Primary Home St Apt 5, Venice, FL 34285' };
    expect(await findLinkedUpcomingAppointment(wrongUnit, null, { database: conn })).toBe(null);

    conn = makeFakeConn([null, [stampedApt4]]);
    const rightUnit = { ...ESTIMATE, address: '100 Primary Home St Apt 4, Venice, FL 34285' };
    expect(await findLinkedUpcomingAppointment(rightUnit, null, { database: conn })).toEqual(stampedApt4);
  });
});
