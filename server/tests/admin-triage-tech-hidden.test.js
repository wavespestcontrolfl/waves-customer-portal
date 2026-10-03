/**
 * Technician logins never see household_address_match cards (GATE_CALL_HOUSEHOLD_HOLD): the
 * caller's number, heard name, exact address and matched customer id are admin-only evidence.
 * The GET list excludes the reason from BOTH the item rows and the per-status counts for a
 * non-admin, exactly like property_role_confirm; an admin's queries carry no such filter.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn(async () => {}) }));
jest.mock('../utils/triage-locks', () => ({ lockTriageCall: jest.fn(async () => {}) }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => {
    req.technician = { id: 'tech-1', role: 'admin' };
    req.technicianId = 'tech-1';
    req.techRole = req.headers['x-test-role'] || 'admin';
    next();
  },
  requireTechOrAdmin: (_req, _res, next) => next(),
}));

const express = require('express');
const db = require('../models/db');
const triageRouter = require('../routes/admin-triage');

// Recording knex stand-in: every chain method returns the builder, awaiting yields the rows
// registered for the call order (items first, then the counts query).
function recordingDb({ itemRows = [], countRows = [] } = {}) {
  const filters = [];
  let n = 0;
  const conn = (table) => {
    const mine = { table, whereNot: [], whereNotIn: [] };
    filters.push(mine);
    const order = n; n += 1;
    const b = {};
    for (const m of ['leftJoin', 'join', 'whereIn', 'where', 'whereRaw', 'orderBy', 'limit', 'select', 'count', 'groupBy', 'andWhere']) b[m] = () => b;
    b.modify = (fn) => { fn(b); return b; };
    b.whereNot = (...args) => { mine.whereNot.push(args); return b; };
    b.whereNotIn = (...args) => { mine.whereNotIn.push(args); return b; };
    b.then = (resolve, reject) => Promise.resolve(order === 0 ? itemRows : countRows).then(resolve, reject);
    return b;
  };
  conn.raw = (sql) => ({ __raw: sql });
  return { conn, filters };
}

async function get(role) {
  const app = express();
  app.use('/admin/triage', triageRouter);
  const server = app.listen(0);
  try {
    return await fetch(`http://127.0.0.1:${server.address().port}/admin/triage?status=open`, { headers: { 'x-test-role': role } });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

beforeEach(() => db.mockReset());

describe('GET /admin/triage hides household_address_match from technicians', () => {
  test('a technician: both the item query and the counts query exclude the card', async () => {
    const { conn, filters } = recordingDb({ countRows: [{ status: 'open', n: '1' }] });
    db.mockImplementation(conn); db.raw = conn.raw;
    const res = await get('technician');
    expect(res.status).toBe(200);
    const [items, counts] = filters;
    expect(items.whereNotIn).toEqual([['triage_items.reason_code', ['property_role_confirm', 'household_address_match']]]);
    expect(counts.whereNotIn).toEqual([['reason_code', ['property_role_confirm', 'household_address_match']]]);
  });

  test('an admin: no exclusion on either query', async () => {
    const { conn, filters } = recordingDb({ countRows: [{ status: 'open', n: '1' }] });
    db.mockImplementation(conn); db.raw = conn.raw;
    const res = await get('admin');
    expect(res.status).toBe(200);
    expect(filters[0].whereNotIn).toEqual([]);
    expect(filters[1].whereNotIn).toEqual([]);
  });
});
