jest.mock('../models/db', () => jest.fn());
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => {
    req.technician = { first_name: 'Ava', last_name: 'Admin' };
    req.technicianId = 'admin-1';
    next();
  },
  requireTechOrAdmin: (_req, _res, next) => next(),
  // admin-leads.js transitively loads admin-customers.js, whose route
  // registration references requireAdmin at import time — mock it so the suite
  // can load (otherwise: "Route.post() requires a callback ... got Undefined").
  requireAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const express = require('express');
const db = require('../models/db');
const leadsRouter = require('../routes/admin-leads');

function appServer() {
  const app = express();
  app.use(express.json());
  app.use('/admin/leads', leadsRouter);
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message });
  });
  const server = app.listen(0);
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

async function withServer(fn) {
  const { server, baseUrl } = appServer();
  try {
    return await fn(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function makeQuery({ first } = {}) {
  const q = {};
  q.where = jest.fn(() => q);
  q.whereNull = jest.fn(() => q);
  q.first = jest.fn(async () => first);
  return q;
}

// Transaction stub for the soft-delete path: leads.where(...).whereNull(...)
// .update(patch) stamps the row (returns `updatedRows`), lead_activities
// .insert(row) logs the audit entry. `.del()` is intentionally present so a
// regression back to hard-deleting shows up as a recorded call, not a crash.
function makeSoftDeleteTransaction(calls, { updatedRows = 1 } = {}) {
  const trx = jest.fn((table) => {
    const q = {};
    q.where = jest.fn((clause) => {
      calls.push({ table, op: 'where', clause });
      return q;
    });
    q.whereNull = jest.fn((col) => {
      calls.push({ table, op: 'whereNull', col });
      return q;
    });
    q.update = jest.fn(async (patch) => {
      calls.push({ table, op: 'update', patch });
      return updatedRows;
    });
    q.insert = jest.fn(async (row) => {
      calls.push({ table, op: 'insert', row });
      return [row];
    });
    q.del = jest.fn(async () => {
      calls.push({ table, op: 'del' });
      return 1;
    });
    return q;
  });
  trx.schema = { hasTable: jest.fn(async () => true) };
  return trx;
}

// Chainable recorder for the paginated list route: every builder method is
// captured; the count query terminates in .first(), the row query is awaited
// directly (thenable).
function makeListDb(recorded) {
  db.mockImplementation((table) => {
    const calls = [];
    recorded.push({ table, calls });
    const builder = {};
    for (const method of [
      'leftJoin', 'select', 'where', 'whereIn', 'whereNull', 'whereNotIn',
      'whereRaw', 'orderBy', 'limit', 'offset', 'count',
    ]) {
      builder[method] = jest.fn((...args) => {
        calls.push([method, ...args]);
        return builder;
      });
    }
    builder.first = jest.fn(async () => ({ count: '0' }));
    builder.then = (resolve, reject) => Promise.resolve([]).then(resolve, reject);
    return builder;
  });
}

describe('admin leads delete route (soft delete)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.raw = jest.fn(async () => undefined);
  });

  test('soft-deletes: stamps deleted_at/deleted_by, keeps activities, logs a deleted activity', async () => {
    const calls = [];
    const lead = { id: 'lead-1', phone: '9415550101', deleted_at: null };
    db.mockImplementation((table) => {
      if (table === 'leads') return makeQuery({ first: lead });
      throw new Error(`Unexpected table ${table}`);
    });
    db.transaction = jest.fn(async (callback) => callback(makeSoftDeleteTransaction(calls)));

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/leads/lead-1`, { method: 'DELETE' });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body).toEqual({ success: true, deleted: true });
    });

    // The lead row is UPDATED (deleted_at + deleted_by), never .del()'d, and
    // the activity trail is preserved — the only lead_activities write is the
    // new 'deleted' audit row. No lead_agent_responses detach: the row stays,
    // so the FK stays valid.
    const update = calls.find((c) => c.table === 'leads' && c.op === 'update');
    expect(update).toBeDefined();
    expect(update.patch.deleted_at).toBeInstanceOf(Date);
    expect(update.patch.deleted_by).toBe('admin-1');
    expect(calls).toContainEqual({ table: 'leads', op: 'where', clause: { id: 'lead-1' } });
    expect(calls).toContainEqual({ table: 'leads', op: 'whereNull', col: 'deleted_at' });

    const activityInsert = calls.find((c) => c.table === 'lead_activities' && c.op === 'insert');
    expect(activityInsert).toBeDefined();
    expect(activityInsert.row.activity_type).toBe('deleted');
    expect(activityInsert.row.description).toContain('Ava Admin');

    expect(calls.filter((c) => c.op === 'del')).toEqual([]);
    expect(calls.filter((c) => c.table === 'lead_agent_responses')).toEqual([]);
    expect(calls.filter((c) => c.table === 'lead_activities' && c.op !== 'insert')).toEqual([]);
  });

  test('second delete is a no-op success (idempotent) — no transaction, no new activity', async () => {
    const lead = { id: 'lead-1', deleted_at: new Date('2026-07-01T12:00:00Z') };
    db.mockImplementation((table) => {
      if (table === 'leads') return makeQuery({ first: lead });
      throw new Error(`Unexpected table ${table}`);
    });
    db.transaction = jest.fn();

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/leads/lead-1`, { method: 'DELETE' });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body).toEqual({ success: true, deleted: true, alreadyDeleted: true });
    });

    expect(db.transaction).not.toHaveBeenCalled();
  });

  test('missing lead still 404s', async () => {
    db.mockImplementation((table) => {
      if (table === 'leads') return makeQuery({ first: undefined });
      throw new Error(`Unexpected table ${table}`);
    });
    db.transaction = jest.fn();

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/leads/lead-404`, { method: 'DELETE' });
      expect(res.status).toBe(404);
    });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  test('concurrent delete race: 0 stamped rows logs no duplicate activity', async () => {
    const calls = [];
    const lead = { id: 'lead-1', deleted_at: null };
    db.mockImplementation((table) => {
      if (table === 'leads') return makeQuery({ first: lead });
      throw new Error(`Unexpected table ${table}`);
    });
    db.transaction = jest.fn(async (callback) =>
      callback(makeSoftDeleteTransaction(calls, { updatedRows: 0 })));

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/leads/lead-1`, { method: 'DELETE' });
      expect(res.status).toBe(200);
    });

    expect(calls.filter((c) => c.table === 'lead_activities')).toEqual([]);
  });
});

describe('admin leads list route — soft-delete exclusion + open filter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.raw = jest.fn((...args) => `raw(${args[0]})`);
  });

  test('list and count queries both exclude soft-deleted leads', async () => {
    const recorded = [];
    makeListDb(recorded);

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/leads`);
      expect(res.status).toBe(200);
    });

    const leadQueries = recorded.filter((r) => r.table === 'leads');
    expect(leadQueries.length).toBe(2); // row query + count query
    for (const q of leadQueries) {
      expect(q.calls).toContainEqual(['whereNull', 'leads.deleted_at']);
    }
  });

  test('status=open expands to the open-status set on both queries', async () => {
    const recorded = [];
    makeListDb(recorded);

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/leads?status=open`);
      expect(res.status).toBe(200);
    });

    const leadQueries = recorded.filter((r) => r.table === 'leads');
    expect(leadQueries.length).toBe(2);
    for (const q of leadQueries) {
      expect(q.calls).toContainEqual([
        'whereIn', 'leads.status', ['new', 'contacted', 'estimate_sent', 'estimate_viewed'],
      ]);
      // 'open' is a virtual filter — it must NOT hit the status column as an
      // equality (there is no 'open' status value in the DB).
      expect(q.calls).not.toContainEqual(['where', 'leads.status', 'open']);
    }
  });

  test('an explicit individual status still filters by equality (unchanged)', async () => {
    const recorded = [];
    makeListDb(recorded);

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/leads?status=won`);
      expect(res.status).toBe(200);
    });

    const leadQueries = recorded.filter((r) => r.table === 'leads');
    for (const q of leadQueries) {
      expect(q.calls).toContainEqual(['where', 'leads.status', 'won']);
    }
  });
});
