// POST /admin/leads/:id/assign checks the technician before the lead changes: an unknown,
// malformed or non-assignable id never lands in leads.assigned_to. Synthetic data only.
jest.mock('../models/db', () => jest.fn());
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => {
    // technicians has one `name` column (no first_name / last_name).
    req.technician = { name: 'Ava Admin' };
    req.technicianId = 'admin-1';
    next();
  },
  requireTechOrAdmin: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const express = require('express');
const db = require('../models/db');
const leadsRouter = require('../routes/admin-leads');

const LEAD = '00000000-0000-4000-8000-0000000000a1';
const TECH = '00000000-0000-4000-8000-0000000000d1';
const ASSIGNABLE = { id: TECH, name: 'Sam Field', role: 'technician', employment_status: 'active', field_dispatchable: true, active: true };

let calls;
function fakeDb({ tech, leadExists = true } = {}) {
  calls = { technicians: [], leadUpdate: null, activities: [] };
  db.mockImplementation((table) => {
    if (table === 'technicians') {
      const q = { where: jest.fn((cond) => { calls.technicians.push(cond); return q; }), first: jest.fn(async () => tech) };
      return q;
    }
    if (table === 'leads') {
      const q = {
        where: jest.fn(() => q),
        whereNull: jest.fn(() => q),
        update: jest.fn((patch) => { calls.leadUpdate = patch; return q; }),
        returning: jest.fn(async () => (leadExists ? [{ id: LEAD, ...calls.leadUpdate }] : [])),
      };
      return q;
    }
    if (table === 'lead_activities') return { insert: jest.fn(async (row) => { calls.activities.push(row); return []; }) };
    throw new Error(`unexpected table ${table}`);
  });
}

async function assign(body) {
  const app = express();
  app.use(express.json());
  app.use('/admin/leads', leadsRouter);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message, code: err.code }));
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/admin/leads/${LEAD}/assign`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

beforeEach(() => db.mockReset());

test('a well-formed but unknown technician id answers 422 and leaves the lead unchanged', async () => {
  fakeDb({ tech: undefined });
  const res = await assign({ technician_id: TECH });
  expect(res.status).toBe(422);
  expect(res.json.code).toBe('TECH_NOT_ASSIGNABLE');
  expect(calls.leadUpdate).toBeNull();
  expect(calls.activities).toEqual([]);
});

test.each([
  ['offboarded', { employment_status: 'inactive', active: false }],
  ['not yet started', { employment_status: 'prospective' }],
  ['not field-dispatchable', { field_dispatchable: false }],
])('a technician who is %s answers 422 and leaves the lead unchanged', async (_name, change) => {
  fakeDb({ tech: { ...ASSIGNABLE, ...change } });
  const res = await assign({ technician_id: TECH });
  expect(res.status).toBe(422);
  expect(calls.leadUpdate).toBeNull();
});

test.each([
  ['a malformed id', { technician_id: 'not-a-uuid' }, /Invalid technician id/],
  ['no technician_id at all', {}, /Pick a technician/],
])('%s answers 400 before any query', async (_name, body, message) => {
  fakeDb({ tech: ASSIGNABLE });
  const res = await assign(body);
  expect(res.status).toBe(400);
  expect(res.json.error).toMatch(message);
  expect(db).not.toHaveBeenCalled();
});

test('an assignable technician is assigned and the activity names them', async () => {
  fakeDb({ tech: ASSIGNABLE });
  const res = await assign({ technician_id: TECH });
  expect(res.status).toBe(200);
  expect(calls.technicians).toEqual([{ id: TECH }]);
  expect(calls.leadUpdate).toMatchObject({ assigned_to: TECH });
  expect(res.json.lead.assigned_to).toBe(TECH);
  expect(calls.activities).toEqual([expect.objectContaining({
    lead_id: LEAD, activity_type: 'assigned', description: 'Assigned to Sam Field', performed_by: 'Ava Admin',
  })]);
});

test.each([[null], ['']])('technician_id %p unassigns without reading technicians', async (technicianId) => {
  fakeDb({ tech: ASSIGNABLE });
  const res = await assign({ technician_id: technicianId });
  expect(res.status).toBe(200);
  expect(calls.technicians).toEqual([]);
  expect(calls.leadUpdate).toMatchObject({ assigned_to: null });
  expect(calls.activities).toEqual([expect.objectContaining({ description: 'Unassigned', performed_by: 'Ava Admin' })]);
});

test('an unknown or deleted lead answers 404 and logs nothing', async () => {
  fakeDb({ tech: ASSIGNABLE, leadExists: false });
  const res = await assign({ technician_id: TECH });
  expect(res.status).toBe(404);
  expect(calls.activities).toEqual([]);
});
