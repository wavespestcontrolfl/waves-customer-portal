/**
 * GATE_TECH_TRAINING_DATES on the Compliance licenses routes (routes/admin-compliance-v2.js), through a real Express app with
 * a stand-in database. What this proves:
 *  - gate off: GET /licenses, PUT /licenses/:techId and the unknown-route answer are exactly today's (no new query, no new key,
 *    the four new dates are refused like any unknown field, the training routes do not exist);
 *  - gate on: the dates and statuses ride on GET only for a technician with a hire date; the PUT takes the four dates with
 *    validation; the training-day routes validate before they touch the database; every write is admin-only.
 * The SQL runs against Postgres in technician-training-dates-postgres.test.js.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/compliance', () => ({}));
jest.mock('../services/technician-training-reminders', () => ({ runTechnicianTrainingReminders: jest.fn(async () => ({ closed: 0 })) }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const users = { admin: { id: '99999999-9999-4999-8999-999999999999', role: 'admin' }, tech: { id: 'tech-1', role: 'technician' } };
    const user = users[token];
    if (!user) return res.status(401).json({ error: 'Admin authentication required' });
    req.technicianId = user.id;
    req.techRole = user.role;
    return next();
  },
  requireAdmin: (req, res, next) => (req.techRole === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' })),
}));

const express = require('express');
const db = require('../models/db');
const { runTechnicianTrainingReminders } = require('../services/technician-training-reminders');
const router = require('../routes/admin-compliance-v2');

const TECH = '11111111-1111-4111-8111-111111111111';
const DAY = '22222222-2222-4222-8222-222222222222';
const GATE = 'GATE_TECH_TRAINING_DATES';

// A thenable query builder: every method returns the builder, awaiting it yields `result`, and the calls are recorded.
function builder(result, calls = []) {
  const b = new Proxy({}, {
    get(_t, name) {
      if (name === 'then') return (resolve, reject) => Promise.resolve(typeof result === 'function' ? result(calls) : result).then(resolve, reject);
      return (...args) => { calls.push([name, args]); return b; };
    },
  });
  return b;
}
const tables = {};
const calls = {};
function table(name, result) { tables[name] = result; calls[name] = []; }
db.mockImplementation((name) => builder(tables[name], calls[name] || (calls[name] = [])));
db.raw = jest.fn((sql) => ({ raw: sql }));

let server;
let base;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/compliance-v2', router);
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${server.address().port}/api/admin/compliance-v2`;
});
afterAll(() => new Promise((resolve) => server.close(resolve)));
beforeEach(() => {
  jest.clearAllMocks();
  delete process.env[GATE];
  for (const key of Object.keys(tables)) delete tables[key];
  for (const key of Object.keys(calls)) delete calls[key];
});
afterEach(() => { delete process.env[GATE]; });

async function call(method, path, body, token = 'admin') {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text };
}

const licenseRow = (over = {}) => ({
  id: TECH, name: 'Test Tech', email: 't@example.invalid', phone: '+15555550100', fl_applicator_license: 'JE1',
  license_expiry: '2027-06-30', license_categories: ['core'], active: true, ...over,
});
const goodDay = (over = {}) => ({ training_date: '2026-10-01', hours: 8, category: 'GHP', topics: 'Label reading, PPE', trainer_name: 'Certified Operator', materials: 'Labels, SDS', ...over });

describe('gate off: today\'s behavior', () => {
  test('GET /licenses reads technicians once and adds no new key', async () => {
    table('technicians', [licenseRow({ license_expiry: null })]);
    const { status, json } = await call('GET', '/licenses');
    expect(status).toBe(200);
    expect(Object.keys(json.technicians[0]).sort()).toEqual(['active', 'email', 'id', 'license', 'licenseCategories', 'licenseExpiry', 'licenseStatus', 'name', 'phone']);
    expect(db).toHaveBeenCalledTimes(1);
    expect(db).toHaveBeenCalledWith('technicians');
  });

  test('PUT refuses the four new dates like any unknown field, and a license update writes and returns exactly the old columns', async () => {
    const refused = await call('PUT', `/licenses/${TECH}`, { id_card_applied_on: '2026-10-01' });
    expect(refused.status).toBe(400);
    expect(refused.json).toEqual({ error: 'Only license fields may be updated' });
    expect(db).not.toHaveBeenCalled();

    table('technicians', [{ id: TECH, fl_applicator_license: 'JE2', license_expiry: '2027-06-30', license_categories: ['core'] }]);
    const ok = await call('PUT', `/licenses/${TECH}`, { fl_applicator_license: 'JE2' });
    expect(ok.status).toBe(200);
    expect(ok.json).toEqual({ success: true, technician: { id: TECH, license: 'JE2', licenseExpiry: '2027-06-30', licenseCategories: ['core'] } });
    expect(calls.technicians).toEqual([
      ['where', [{ id: TECH }]],
      ['update', [{ fl_applicator_license: 'JE2' }]],
      ['returning', [['id', 'fl_applicator_license', 'license_expiry', 'license_categories']]],
    ]);
    expect(runTechnicianTrainingReminders).not.toHaveBeenCalled();
  });

  test.each([
    ['GET', `/licenses/${TECH}/training-days`],
    ['POST', `/licenses/${TECH}/training-days`],
    ['DELETE', `/licenses/${TECH}/training-days/${DAY}`],
    ['GET', `/licenses/${TECH}/training-record`],
  ])('%s %s does not exist', async (method, path) => {
    const { status } = await call(method, path, method === 'POST' ? goodDay() : undefined);
    expect(status).toBe(404);
    expect(db).not.toHaveBeenCalled();
  });
});

describe('gate on', () => {
  beforeEach(() => { process.env[GATE] = 'true'; });

  test('GET /licenses adds the blocks only for a technician with a hire date', async () => {
    const owner = licenseRow({ id: '33333333-3333-4333-8333-333333333333', name: 'Owner', license_expiry: null });
    table('technicians', (c) => (c.some(([name]) => name === 'whereNotNull')
      ? [{ id: TECH, hire_date: '2026-10-01', license_expiry: '2027-06-30', id_card_applied_on: null, id_card_issued_on: null, classroom_hours_done_on: null, renewal_training_done_on: null }]
      : [licenseRow(), owner]));
    table('technician_training_days', [
      { technician_id: TECH, training_date: '2026-10-02', hours: '8.00', category: 'GHP' },
      { technician_id: TECH, training_date: '2026-10-03', hours: '8.00', category: 'GHP' },
    ]);
    // Both reads share one call log: the list query has no whereNotNull, the hire-date query does.
    const { status, json } = await call('GET', '/licenses');
    expect(status).toBe(200);
    const [tech, ownerRow] = json.technicians;
    expect(tech.idCard).toMatchObject({ appliedOn: null, applicationDueOn: '2026-10-31', issuedOn: null });
    expect(tech.training).toMatchObject({ days: 2, hours: 16, categories: ['GHP'], fiveDaysDone: false, fortyHoursDone: false });
    expect(tech.classroom).toEqual({ dueOn: null, doneOn: null, status: null });
    expect(tech.renewalTraining).toMatchObject({ dueBy: '2027-06-30', doneOn: null });
    expect(ownerRow).not.toHaveProperty('idCard');
    expect(ownerRow).not.toHaveProperty('training');
  });

  test('PUT takes the four dates (null or empty clears) and closes settled reminders; a bad date is refused first', async () => {
    const bad = await call('PUT', `/licenses/${TECH}`, { id_card_issued_on: '2026-02-30' });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toMatch(/id_card_issued_on must be a valid YYYY-MM-DD/);
    expect(db).not.toHaveBeenCalled();
    // A completion date records something that happened: a date after today would read as done.
    const future = await call('PUT', `/licenses/${TECH}`, { classroom_hours_done_on: '2999-01-01' });
    expect(future.status).toBe(400);
    expect(future.json.error).toMatch(/classroom_hours_done_on cannot be in the future/);
    expect(db).not.toHaveBeenCalled();

    table('technicians', [{
      id: TECH, fl_applicator_license: 'JE1', license_expiry: '2027-06-30', license_categories: ['core'],
      id_card_applied_on: '2026-10-05', id_card_issued_on: null, classroom_hours_done_on: null, renewal_training_done_on: null,
    }]);
    const ok = await call('PUT', `/licenses/${TECH}`, { id_card_applied_on: '2026-10-05', id_card_issued_on: '', classroom_hours_done_on: null });
    expect(ok.status).toBe(200);
    expect(calls.technicians.find(([name]) => name === 'update')[1][0]).toEqual({ id_card_applied_on: '2026-10-05', id_card_issued_on: null, classroom_hours_done_on: null });
    expect(ok.json.technician).toMatchObject({ id: TECH, idCardAppliedOn: '2026-10-05', idCardIssuedOn: null });
    expect(runTechnicianTrainingReminders).toHaveBeenCalledWith({ technicianId: TECH, closeOnly: true });
  });

  test('a failed reminder close never fails the save', async () => {
    table('technicians', [{ id: TECH, fl_applicator_license: 'JE1', license_expiry: null, license_categories: null }]);
    runTechnicianTrainingReminders.mockRejectedValueOnce(new Error('boom'));
    const { status } = await call('PUT', `/licenses/${TECH}`, { renewal_training_done_on: '2026-10-05' });
    expect(status).toBe(200);
  });

  test.each([
    ['not an object', [], 'Training day body must be an object'],
    ['an unknown field', goodDay({ created_by: 'x' }), 'Only training day fields may be sent'],
    ['an impossible date', goodDay({ training_date: '2026-02-30' }), 'training_date must be a valid YYYY-MM-DD date'],
    ['a future date', goodDay({ training_date: '2999-01-01' }), 'training_date cannot be in the future'],
    ['zero hours', goodDay({ hours: 0 }), 'hours must be more than 0 and at most 16, in hundredths'],
    ['17 hours', goodDay({ hours: 17 }), 'hours must be more than 0 and at most 16, in hundredths'],
    ['hours as text', goodDay({ hours: '8' }), 'hours must be more than 0 and at most 16, in hundredths'],
    ['thousandths of an hour', goodDay({ hours: 1.005 }), 'hours must be more than 0 and at most 16, in hundredths'],
    ['an unknown category', goodDay({ category: 'Rodent' }), 'category must be one of GHP, L&O, Termite/WDO, Fumigation'],
    ['blank topics', goodDay({ topics: '   ' }), 'topics is required (2000 characters or fewer)'],
    ['no trainer', goodDay({ trainer_name: undefined }), 'trainer_name is required (200 characters or fewer)'],
    ['long materials', goodDay({ materials: 'x'.repeat(1001) }), 'materials must be text of 1000 characters or fewer'],
  ])('POST training-days refuses %s before any query', async (_label, body, message) => {
    const { status, json } = await call('POST', `/licenses/${TECH}/training-days`, body);
    expect(status).toBe(400);
    expect(json.error).toBe(message);
    expect(db).not.toHaveBeenCalled();
  });

  test('POST adds a day (trimmed, hours in hundredths, created_by the admin) and a duplicate answers 409', async () => {
    table('technicians', { id: TECH });
    table('technician_training_days', [{ id: DAY, training_date: '2026-10-01', hours: '7.25', category: 'GHP', topics: 'Label reading', trainer_name: 'Certified Operator', materials: null, created_by: null, created_at: 'now' }]);
    const ok = await call('POST', `/licenses/${TECH}/training-days`, goodDay({ hours: 7.25, topics: '  Label reading ', materials: '' }));
    expect(ok.status).toBe(201);
    expect(ok.json.day).toMatchObject({ id: DAY, trainingDate: '2026-10-01', hours: 7.25, category: 'GHP', trainerName: 'Certified Operator' });
    expect(calls.technician_training_days.find(([name]) => name === 'insert')[1][0]).toEqual({
      training_date: '2026-10-01', hours: 7.25, category: 'GHP', topics: 'Label reading', trainer_name: 'Certified Operator', materials: null,
      technician_id: TECH, created_by: '99999999-9999-4999-8999-999999999999',
    });

    table('technician_training_days', []); // ON CONFLICT DO NOTHING returns no row
    const dup = await call('POST', `/licenses/${TECH}/training-days`, goodDay());
    expect(dup.status).toBe(409);
  });

  test('POST for a technician that does not exist answers 404, and a bad id answers 400', async () => {
    table('technicians', undefined);
    expect((await call('POST', `/licenses/${TECH}/training-days`, goodDay())).status).toBe(404);
    expect((await call('POST', '/licenses/not-a-uuid/training-days', goodDay())).status).toBe(400);
  });

  test('DELETE removes by day and technician; unknown answers 404; a bad day id answers 400', async () => {
    table('technician_training_days', 1);
    expect((await call('DELETE', `/licenses/${TECH}/training-days/${DAY}`)).json).toEqual({ success: true });
    expect(calls.technician_training_days[0]).toEqual(['where', [{ id: DAY, technician_id: TECH }]]);
    table('technician_training_days', 0);
    expect((await call('DELETE', `/licenses/${TECH}/training-days/${DAY}`)).status).toBe(404);
    expect((await call('DELETE', `/licenses/${TECH}/training-days/nope`)).status).toBe(400);
  });

  test('the training record carries the heading, dated days, totals and the certified operator signature lines', async () => {
    table('technicians', { id: TECH, name: 'Test Tech', hire_date: '2026-10-01', fl_applicator_license: 'JE1' });
    table('technician_training_days', [
      { id: DAY, training_date: '2026-10-02', hours: '8.00', category: 'GHP', topics: 'Label reading', trainer_name: 'CO', materials: 'SDS', created_by: null, created_at: 'now' },
    ]);
    const { status, json } = await call('GET', `/licenses/${TECH}/training-record`);
    expect(status).toBe(200);
    expect(json.authority).toMatch(/5E-14\.1421/);
    expect(json.retention).toBe('Keep this record for 2 years.');
    expect(json.technician).toEqual({ id: TECH, name: 'Test Tech', hireDate: '2026-10-01' });
    expect(json.days).toHaveLength(1);
    expect(json.totals).toEqual({ days: 1, hours: 8, categories: ['GHP'], fiveDaysDone: false, fortyHoursDone: false });
    expect(json.signatures).toEqual([{ role: 'Certified operator in charge', lines: ['Printed name', 'License number', 'Signature', 'Date'] }]);
  });

  test.each([
    ['PUT', `/licenses/${TECH}`, { id_card_applied_on: '2026-10-05' }],
    ['GET', `/licenses/${TECH}/training-days`, undefined],
    ['POST', `/licenses/${TECH}/training-days`, goodDay()],
    ['DELETE', `/licenses/${TECH}/training-days/${DAY}`, undefined],
    ['GET', `/licenses/${TECH}/training-record`, undefined],
  ])('a technician (not an admin) is refused on %s %s', async (method, path, body) => {
    const { status } = await call(method, path, body, 'tech');
    expect(status).toBe(403);
    expect(db).not.toHaveBeenCalled();
  });
});
