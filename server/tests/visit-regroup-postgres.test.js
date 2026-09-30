/**
 * Same-stop regroup sweep (server/services/visit-regroup.js) against a real
 * migrated schema. Set REGROUP_TEST_DATABASE_URL to a private database named
 * waves_test (localhost) or waves_qa_<32 hex>; the suite skips without it.
 *
 * Eligibility itself is visit-groups.js (maybeGroupRow / createOrJoinVisit);
 * these tests pin that the sweep finds the rows, respects today / started /
 * gate / reminder-state fences, writes nothing on a dry run, and is
 * idempotent.
 */
jest.mock('../models/db', () => new Proxy((...args) => mockPg(...args), {
  get: (_, key) => (typeof mockPg[key] === 'function' ? mockPg[key].bind(mockPg) : mockPg[key]),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/tech-visit-notifications', () => ({ notifyTechVisitChange: async () => {} }));

const knex = require('knex');
const { randomUUID } = require('node:crypto');
const { addETDays, etDateString } = require('../utils/datetime-et');

const connection = process.env.REGROUP_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
let mockPg;
jest.setTimeout(60000);

const { gates } = require('../config/feature-gates');
const { regroupUngroupedSameStopRows } = require('../services/visit-regroup');

postgres('same-stop regroup sweep', () => {
  let technicianId;
  let services;
  const created = { customers: [], properties: [], rows: [] };
  const daysOut = (n) => etDateString(addETDays(new Date(), n));
  let dayCursor = 40; // each test uses its own future date so sweeps never overlap

  beforeAll(async () => {
    const url = new URL(connection);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && url.pathname === '/waves_test';
    if (!local && !/^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname)) throw new Error('Use the verified private dev database');
    mockPg = knex({ client: 'pg', connection, pool: { min: 0, max: 4 } });
    technicianId = randomUUID();
    await mockPg('technicians').insert({
      id: technicianId, name: 'Synthetic Technician', email: `${technicianId}@example.invalid`,
      password_hash: 'synthetic-not-a-login-hash', role: 'technician', active: true,
      employment_status: 'active', field_dispatchable: true,
    });
    services = await mockPg('services').where({ groupable: true, group_family: 'recurring_property_service' })
      .orderBy('id').limit(2).select('id', 'name');
    expect(services).toHaveLength(2);
  });

  beforeEach(() => { gates.visitGroups = true; });
  afterEach(() => { gates.visitGroups = false; });

  afterAll(async () => {
    if (!mockPg) return;
    const ids = created.rows;
    if (ids.length) {
      await mockPg('scheduled_services').whereIn('id', ids).update({ visit_id: null });
      await mockPg('service_visits').whereIn('customer_id', created.customers).del();
      await mockPg('appointment_reminders').whereIn('scheduled_service_id', ids).del();
      await mockPg('scheduled_services').whereIn('id', ids).del();
    }
    await mockPg('customer_properties').whereIn('id', created.properties).del();
    await mockPg('customers').whereIn('id', created.customers).del();
    await mockPg('technicians').where({ id: technicianId }).del();
    await mockPg.destroy();
  });

  async function fixture({ date, windows, sameProperty = true, rowOverrides = [] }) {
    const customerId = randomUUID();
    await mockPg('customers').insert({
      id: customerId, first_name: 'Synthetic', last_name: 'Regroup',
      email: `${customerId}@example.invalid`, phone: '+19415550188', active: true,
      property_type: 'residential', address_line1: '1 Example Court', city: 'Parrish',
      state: 'FL', zip: '34219', pipeline_stage: 'active_customer', autopay_enabled: false,
    });
    created.customers.push(customerId);
    const propertyIds = [];
    for (let i = 0; i < (sameProperty ? 1 : 2); i += 1) {
      const propertyId = randomUUID();
      await mockPg('customer_properties').insert({
        id: propertyId, customer_id: customerId, is_primary: i === 0, active: true,
        address_line1: `${i + 1} Example Court`, city: 'Parrish', state: 'FL', zip: '34219', source: 'manual',
      });
      created.properties.push(propertyId);
      propertyIds.push(propertyId);
    }
    const rows = [];
    for (let i = 0; i < windows.length; i += 1) {
      const [row] = await mockPg('scheduled_services').insert({
        customer_id: customerId, property_id: propertyIds[sameProperty ? 0 : i], technician_id: technicianId,
        service_id: services[i].id, service_type: services[i].name,
        scheduled_date: date, window_start: windows[i][0], window_end: windows[i][1],
        status: 'pending', estimated_duration_minutes: 60, ...(rowOverrides[i] || {}),
      }).returning('*');
      rows.push(row);
      created.rows.push(row.id);
    }
    return { customerId, rows, date };
  }

  const nextDate = () => daysOut(dayCursor++);
  const sweep = (f, extra = {}) => regroupUngroupedSameStopRows({
    fromDate: f.date, toDate: f.date, dryRun: false, ...extra,
  });
  const visitIds = async (rows) => (await mockPg('scheduled_services').whereIn('id', rows.map((r) => r.id)).select('visit_id'))
    .map((r) => r.visit_id);
  const visitCount = (customerId) => mockPg('service_visits').where({ customer_id: customerId }).count('* as n').first().then((r) => Number(r.n));

  test('an eligible same-stop pair is grouped into one visit', async () => {
    const f = await fixture({ date: nextDate(), windows: [['09:00', '10:00'], ['09:30', '10:30']] });
    const out = await sweep(f);
    expect(out.groups).toHaveLength(1);
    expect(out.groups[0].rowIds.sort()).toEqual(f.rows.map((r) => String(r.id)).sort());
    const vids = await visitIds(f.rows);
    expect(vids[0]).toBeTruthy();
    expect(vids[0]).toBe(vids[1]);
    expect(await visitCount(f.customerId)).toBe(1);
    expect(out.groups[0].visitId).toBe(vids[0]);
  });

  test('windows with a gap between them are not grouped', async () => {
    const f = await fixture({ date: nextDate(), windows: [['09:00', '10:00'], ['13:00', '14:00']] });
    const out = await sweep(f);
    expect(out.groups).toHaveLength(0);
    expect((await visitIds(f.rows)).every((v) => v === null)).toBe(true);
    expect(await visitCount(f.customerId)).toBe(0);
  });

  test('back-to-back windows that share a boundary minute DO group (existing inclusive overlap rule)', async () => {
    // windowsOverlap is inclusive (as <= bHi && bs <= aHi), the same rule the
    // insert-time path uses, so 13:00-14:00 + 14:00-15:00 is one stop. Pinned
    // so a change to the shared rule is a deliberate decision, not a surprise.
    const f = await fixture({ date: nextDate(), windows: [['13:00', '14:00'], ['14:00', '15:00']] });
    expect((await sweep(f)).groups).toHaveLength(1);
    const vids = await visitIds(f.rows);
    expect(vids[0]).toBeTruthy();
    expect(vids[0]).toBe(vids[1]);
  });

  test('rows at different properties are not grouped', async () => {
    const f = await fixture({ date: nextDate(), windows: [['09:00', '10:00'], ['09:00', '10:00']], sameProperty: false });
    const out = await sweep(f);
    expect(out.candidates).toBe(0);
    expect(out.groups).toHaveLength(0);
    expect((await visitIds(f.rows)).every((v) => v === null)).toBe(true);
  });

  test('today and earlier are never touched', async () => {
    const today = etDateString(new Date());
    const f = await fixture({ date: today, windows: [['09:00', '10:00'], ['09:30', '10:30']] });
    const apply = await regroupUngroupedSameStopRows({ fromDate: today, toDate: today, dryRun: false });
    expect(apply.fromDate > today).toBe(true);
    expect(apply.groups).toHaveLength(0);
    expect((await visitIds(f.rows)).every((v) => v === null)).toBe(true);
    // Even the wide default window leaves them alone.
    const wide = await regroupUngroupedSameStopRows({ dryRun: false, limit: 5000 });
    expect(wide.groups.flatMap((g) => g.rowIds)).not.toEqual(expect.arrayContaining(f.rows.map((r) => String(r.id))));
    expect((await visitIds(f.rows)).every((v) => v === null)).toBe(true);
  });

  test('a dry run reports the group and writes nothing', async () => {
    const f = await fixture({ date: nextDate(), windows: [['09:00', '10:00'], ['09:30', '10:30']] });
    const before = await mockPg('scheduled_services').whereIn('id', f.rows.map((r) => r.id)).orderBy('id');
    const out = await regroupUngroupedSameStopRows({ fromDate: f.date, toDate: f.date });
    expect(out.dryRun).toBe(true);
    expect(out.groups).toHaveLength(1);
    expect(out.groups[0].visitId).toBeNull();
    expect(await visitCount(f.customerId)).toBe(0);
    const after = await mockPg('scheduled_services').whereIn('id', f.rows.map((r) => r.id)).orderBy('id');
    expect(after).toEqual(before);
  });

  test('a second apply is a no-op', async () => {
    const f = await fixture({ date: nextDate(), windows: [['09:00', '10:00'], ['09:30', '10:30']] });
    expect((await sweep(f)).groups).toHaveLength(1);
    const again = await sweep(f);
    expect(again.candidates).toBe(0);
    expect(again.groups).toHaveLength(0);
    expect(await visitCount(f.customerId)).toBe(1);
  });

  test('gate off is a no-op', async () => {
    const f = await fixture({ date: nextDate(), windows: [['09:00', '10:00'], ['09:30', '10:30']] });
    gates.visitGroups = false;
    const out = await sweep(f);
    expect(out.skipped).toBe('gate_off');
    expect(out.groups).toHaveLength(0);
    expect((await visitIds(f.rows)).every((v) => v === null)).toBe(true);
  });

  test('a partner already en route is never folded in', async () => {
    const f = await fixture({
      date: nextDate(), windows: [['09:00', '10:00'], ['09:30', '10:30']],
      rowOverrides: [{}, { status: 'en_route', track_state: 'en_route', en_route_at: new Date() }],
    });
    const out = await sweep(f);
    expect(out.groups).toHaveLength(0);
    expect(out.left.map((l) => l.reason)).toContain('already_started');
    expect((await visitIds(f.rows)).every((v) => v === null)).toBe(true);
  });

  test('a pair at different reminder states is left for the office', async () => {
    const f = await fixture({ date: nextDate(), windows: [['09:00', '10:00'], ['09:30', '10:30']] });
    await mockPg('appointment_reminders').insert({
      scheduled_service_id: f.rows[0].id, appointment_time: new Date(Date.now() + 86400000 * 30),
      source: 'test', reminder_72h_sent: true,
    });
    const out = await sweep(f);
    expect(out.groups).toHaveLength(0);
    expect(out.left.map((l) => l.reason)).toContain('reminder_state_differs');
    expect((await visitIds(f.rows)).every((v) => v === null)).toBe(true);
  });
});
