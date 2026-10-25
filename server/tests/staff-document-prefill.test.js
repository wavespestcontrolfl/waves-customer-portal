// Form prefill from the staff record (GATE_STAFF_DOC_PREFILL): service unit tests with a fake db,
// plus the route gate. No database needed.
const express = require('express');

const mockQueues = {};
const mockCalls = [];
jest.mock('../models/db', () => jest.fn(table => {
  mockCalls.push(table);
  const builder = {};
  for (const name of ['where', 'whereNotNull', 'orderBy', 'select', 'modify']) builder[name] = jest.fn(() => builder);
  builder.first = jest.fn(async () => (mockQueues[table] || []).shift());
  return builder;
}));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => { req.techRole = req.headers['x-role'] || 'technician'; req.technicianId = req.headers['x-self'] || ME; next(); },
  requireTechOrAdmin: (req, res, next) => next(),
  requireAdmin: (req, res, next) => next(),
}));

const ME = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';
const VERSION = '00000000-0000-4000-8000-0000000000aa';
const TEMPLATE = '00000000-0000-4000-8000-0000000000bb';
const db = require('../models/db');
const documents = require('../services/staff-documents');

const field = (id, type = 'text') => ({ id, label: id, type, required: false });
const FIELDS = [field('vehicle'), field('home-address'), field('start-date', 'date'), field('agree', 'checkbox'), field('signed-name')];
const version = (fields = FIELDS) => ({ id: VERSION, template_id: TEMPLATE, staff_metadata: { fields } });
const document = (extra = {}) => ({ id: TEMPLATE, audience: 'staff', staff_access: 'staff', staff_kind: 'form', template_key: 'staff.vehicle-use-commuting-agreement', ...extra });
const tech = { vehicle_name: 'Truck 7', address: '1 Test Lane, Sampleton, FL', hire_date: '2026-11-02' };

function seed({ ver = version(), doc = document(), current = { id: VERSION }, owner = { id: ME, role: 'technician' }, row = tech } = {}) {
  mockQueues.document_template_versions = ver ? [ver, current] : [undefined];
  mockQueues.document_templates = [doc, doc, doc];
  mockQueues.technicians = [owner || undefined, row];
}
const actorMe = { id: ME, role: 'technician' };

beforeEach(() => { jest.clearAllMocks(); mockCalls.length = 0; for (const key of Object.keys(mockQueues)) delete mockQueues[key]; });

test('the commuting agreement fills vehicle, home address and start date from the staff row', async () => {
  seed();
  expect(await documents.prefillAnswers(VERSION, ME, actorMe)).toEqual({
    answers: { vehicle: 'Truck 7', 'home-address': '1 Test Lane, Sampleton, FL', 'start-date': '2026-11-02' },
    fields: ['vehicle', 'home-address', 'start-date'],
  });
});

test('a date column that arrives as a Date becomes a date-only string', async () => {
  seed({ row: { ...tech, hire_date: new Date(Date.UTC(2026, 10, 2, 12)) } });
  expect((await documents.prefillAnswers(VERSION, ME, actorMe)).answers['start-date']).toBe('2026-11-02');
});

test('empty and null source values are left out', async () => {
  seed({ row: { vehicle_name: null, address: '  ', hire_date: null } });
  expect(await documents.prefillAnswers(VERSION, ME, actorMe)).toEqual({ answers: {}, fields: [] });
});

test('a checkbox or typed signature is never filled, even when the map would name it', async () => {
  // Same ids, but the version makes vehicle a checkbox and home-address a signed-name field.
  seed({ ver: version([field('vehicle', 'checkbox'), field('signed-name'), field('start-date', 'date')]) });
  const result = await documents.prefillAnswers(VERSION, ME, actorMe);
  expect(result.answers).toEqual({ 'start-date': '2026-11-02' });
  expect(Object.keys(result.answers)).not.toContain('signed-name');
});

test('prefillValues enforces the checkbox and signed-name rules even for a map that names them', () => {
  const map = { vehicle: 'vehicle_name', agree: 'vehicle_name', 'signed-name': 'vehicle_name', ghost: 'vehicle_name' };
  const result = documents.prefillValues(map, FIELDS, tech);
  expect(result).toEqual({ answers: { vehicle: 'Truck 7' }, fields: ['vehicle'] });
});

test('only fields present on the version are returned', async () => {
  seed({ ver: version([field('vehicle')]) });
  expect((await documents.prefillAnswers(VERSION, ME, actorMe)).fields).toEqual(['vehicle']);
});

test('a form with no map entry gets nothing and reads no staff row', async () => {
  seed({ doc: document({ template_key: 'staff.vehicle-inspection-record' }) });
  expect(await documents.prefillAnswers(VERSION, ME, actorMe)).toEqual({ answers: {}, fields: [] });
  expect(mockQueues.technicians).toHaveLength(1);
});

test('a non-admin may not prefill for another staff member', async () => {
  seed({ owner: { id: OTHER, role: 'technician' } });
  await expect(documents.prefillAnswers(VERSION, OTHER, actorMe)).rejects.toMatchObject({ status: 403 });
  expect(mockCalls).not.toContain('technicians');
});

test('an admin may prefill for another active staff member', async () => {
  seed({ owner: { id: OTHER, role: 'technician' } });
  const result = await documents.prefillAnswers(VERSION, OTHER, { id: ME, role: 'admin' });
  expect(result.fields).toEqual(['vehicle', 'home-address', 'start-date']);
});

test('an inactive or unknown owner is refused', async () => {
  seed({ owner: null });
  await expect(documents.prefillAnswers(VERSION, ME, actorMe)).rejects.toMatchObject({ status: 400 });
});

test('a policy is refused, and so is a procedure', async () => {
  seed({ doc: document({ staff_kind: 'policy' }) });
  await expect(documents.prefillAnswers(VERSION, ME, actorMe)).rejects.toMatchObject({ status: 400 });
  seed({ doc: document({ staff_kind: 'procedure' }) });
  await expect(documents.prefillAnswers(VERSION, ME, actorMe)).rejects.toMatchObject({ status: 400 });
});

test('a superseded or unissued version is refused', async () => {
  seed({ current: { id: '00000000-0000-4000-8000-0000000000cc' } });
  await expect(documents.prefillAnswers(VERSION, ME, actorMe)).rejects.toMatchObject({ status: 409 });
  seed({ ver: null });
  await expect(documents.prefillAnswers(VERSION, ME, actorMe)).rejects.toMatchObject({ status: 404 });
});

describe('route gate', () => {
  let server; let origin;
  const previous = { prefill: process.env.GATE_STAFF_DOC_PREFILL, docs: process.env.GATE_CONTROLLED_STAFF_DOCUMENTS };
  beforeAll(async () => {
    const app = express(); app.use(express.json());
    app.use('/documents', require('../routes/tech-staff-documents'));
    server = require('node:http').createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
    for (const [key, name] of [['prefill', 'GATE_STAFF_DOC_PREFILL'], ['docs', 'GATE_CONTROLLED_STAFF_DOCUMENTS']]) {
      if (previous[key] === undefined) delete process.env[name]; else process.env[name] = previous[key];
    }
  });
  beforeEach(() => { process.env.GATE_CONTROLLED_STAFF_DOCUMENTS = 'true'; delete process.env.GATE_STAFF_DOC_PREFILL; });
  const url = `/documents/versions/${VERSION}/prefill?owner_id=${ME}`;

  test('gate off answers 404 { enabled: false } with no query', async () => {
    const response = await fetch(origin + url);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ enabled: false });
    expect(db).not.toHaveBeenCalled();
  });
  test('the gate is strict: only the string true turns it on', async () => {
    process.env.GATE_STAFF_DOC_PREFILL = '1';
    expect((await fetch(origin + url)).status).toBe(404);
    expect(db).not.toHaveBeenCalled();
  });
  test('gate on returns the answers and a non-admin asking for another owner gets 403', async () => {
    process.env.GATE_STAFF_DOC_PREFILL = 'true';
    seed();
    const ok = await fetch(origin + url);
    expect(ok.status).toBe(200);
    expect((await ok.json()).fields).toEqual(['vehicle', 'home-address', 'start-date']);
    seed({ owner: { id: OTHER, role: 'technician' } });
    expect((await fetch(`${origin}/documents/versions/${VERSION}/prefill?owner_id=${OTHER}`)).status).toBe(403);
    expect((await fetch(`${origin}/documents/versions/${VERSION}/prefill`)).status).toBe(400);
  });
});
