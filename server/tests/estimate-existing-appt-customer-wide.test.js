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
const LINKED_ROW = { id: 'ss-linked', customer_id: 'cust-1', source_estimate_id: 'est-1' };
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
    // Both queries pin the requested id (the fallback qualifies its column —
    // it joins `services`, where a bare `id` would be ambiguous).
    expect(clauseArgs(conn.queries[0], 'where')).toEqual(
      expect.arrayContaining([['id', 'ss-anywhere']])
    );
    expect(clauseArgs(conn.queries[1], 'where')).toEqual(
      expect.arrayContaining([['scheduled_services.id', 'ss-anywhere']])
    );
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
