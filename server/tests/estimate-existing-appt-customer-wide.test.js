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
    ['whereIn', 'where', 'andWhere', 'orWhere', 'whereNull', 'orWhereRaw', 'orderBy'].forEach((m) => {
      q[m] = record(m);
    });
    q.first = async () => resultsByQuery[index] ?? null;
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

const ESTIMATE = { id: 'est-1', customer_id: 'cust-1', estimate_data: '{}' };
const LINKED_ROW = { id: 'ss-linked', customer_id: 'cust-1', source_estimate_id: 'est-1' };
const CW_ROW = { id: 'ss-anywhere', customer_id: 'cust-1', source_estimate_id: null };

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

  it('gate ON: no linked row → falls back to any upcoming unclaimed appointment for the customer', async () => {
    featureGates.isEnabled.mockImplementation((k) => k === 'estimateExistingApptCustomerWide');
    const conn = makeFakeConn([null, CW_ROW]);
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
    // Same upcoming/status guards as the linked query.
    expect(clauseArgs(cw, 'whereIn')).toEqual(
      expect.arrayContaining([['status', ['pending', 'confirmed']]])
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

  it('gate ON: the accept-side re-resolve (appointmentId) reaches the fallback query too', async () => {
    featureGates.isEnabled.mockImplementation((k) => k === 'estimateExistingApptCustomerWide');
    const conn = makeFakeConn([null, CW_ROW]);
    const row = await findLinkedUpcomingAppointment(ESTIMATE, null, {
      database: conn,
      appointmentId: 'ss-anywhere',
    });
    expect(row).toEqual(CW_ROW);
    // Both queries pin the requested id.
    expect(clauseArgs(conn.queries[0], 'where')).toEqual(
      expect.arrayContaining([['id', 'ss-anywhere']])
    );
    expect(clauseArgs(conn.queries[1], 'where')).toEqual(
      expect.arrayContaining([['id', 'ss-anywhere']])
    );
  });

  it('gate ON: a fallback row that is not the requested id is rejected (id pinning)', async () => {
    featureGates.isEnabled.mockImplementation((k) => k === 'estimateExistingApptCustomerWide');
    const conn = makeFakeConn([null, { ...CW_ROW, id: 'ss-other' }]);
    const row = await findLinkedUpcomingAppointment(ESTIMATE, null, {
      database: conn,
      appointmentId: 'ss-anywhere',
    });
    expect(row).toBe(null);
  });
});
