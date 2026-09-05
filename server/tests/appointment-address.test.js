jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn() }));
jest.mock('../services/scheduling/tech-day-lock', () => ({ lockTechDays: jest.fn() }));
jest.mock('../services/visit-groups', () => ({
  dateOnly: (value) => String(value).slice(0, 10),
  stopBaseKey: ({ propertyId, customerId, scheduledDate }) => `${propertyId || customerId}:${String(scheduledDate).slice(0, 10)}`,
  lockStop: jest.fn(),
}));
const { planAppointmentAddress, lockAppointmentAddress, applyAppointmentAddress } = require('../services/appointment-address');
const { recordAuditEvent } = require('../services/audit-log');
const { lockStop } = require('../services/visit-groups');

const row = { id: 'row-a', customer_id: 'customer-a', is_recurring: true, property_id: 'old',
  scheduled_date: '2099-01-01', technician_id: 'tech-a', status: 'en_route', visit_id: null };
const property = { id: 'property-b', address_line1: '100 Example Street', city: 'Example', state: 'FL', zip: '00000', latitude: null, longitude: null };
// Evaluate target selection as well as the mutations in this fixture.
function predicateGroup() {
  const predicates = [];
  return {
    where(...args) { predicates.push(['and', predicate(args)]); return this; },
    orWhere(...args) { predicates.push(['or', predicate(args)]); return this; },
    whereNotIn(key, values) { predicates.push(['and', (r) => !values.includes(r[key])]); return this; },
    test(row) { return predicates.reduce((value, [op, p], index) => index === 0 ? p(row) : op === 'or' ? value || p(row) : value && p(row), true); },
  };
}
function predicate(args) {
  if (typeof args[0] === 'function') {
    const group = predicateGroup(); args[0](group); return (row) => group.test(row);
  }
  if (typeof args[0] === 'object') return (row) => Object.entries(args[0]).every(([k, v]) => row[k] === v);
  return (row) => row[args[0]] === args[1];
}
function connection({ rows = [row], visits = [], selected = property } = {}) {
  const calls = [];
  const conn = jest.fn((table) => {
    const query = { table, filters: [], patch: null };
    calls.push(query);
    const result = table === 'scheduled_services' ? rows : table === 'service_visits' ? visits : [];
    const predicates = [];
    const filtered = () => result.filter((r) => predicates.every((p) => p(r)));
    const chain = {};
    for (const name of ['where', 'whereIn', 'whereNotIn', 'orWhere', 'orderBy', 'forUpdate', 'forShare']) {
      chain[name] = (...args) => {
        query.filters.push([name, ...args]);
        if (name === 'where') predicates.push(predicate(args));
        if (name === 'whereIn') predicates.push((r) => args[1].includes(r[args[0]]));
        return chain;
      };
    }
    chain.max = () => { query.max = true; return chain; };
    chain.first = async () => table === 'customer_properties' ? selected : query.max ? { max: 3 } : filtered()[0];
    chain.then = (resolve, reject) => Promise.resolve(filtered()).then(resolve, reject);
    chain.update = async (patch) => { query.patch = patch; return result.length; };
    return chain;
  });
  conn.fn = { now: () => 'now' };
  conn.calls = calls;
  return conn;
}
beforeEach(() => jest.clearAllMocks());

test.each(['pending', 'confirmed', 'en_route', 'on_site', 'completed', 'cancelled', 'skipped'])('address correction preserves %s lifecycle and clears obsolete coordinates', async (status) => {
  const conn = connection({ rows: [{ ...row, status }] });
  const plan = await planAppointmentAddress(conn, row.id, property.id);
  expect(await applyAppointmentAddress(conn, plan, 'admin-a')).toEqual([row.id]);
  const patch = conn.calls.find((call) => call.table === 'scheduled_services' && call.patch).patch;
  expect(patch).toMatchObject({ property_id: property.id, service_address_line1: property.address_line1,
    service_address_line2: '', lat: null, lng: null, pre_service_brief: null });
  expect(patch).not.toHaveProperty('status');
  expect(patch).not.toHaveProperty('en_route_at');
  expect(recordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ trx: conn, critical: true }));
});

test('rejects an unavailable or foreign property before any write', async () => {
  const conn = connection({ selected: undefined });
  // Explicit null represents the owner-filtered lookup finding no row.
  const denied = connection({ selected: null });
  const plan = await planAppointmentAddress(conn, row.id, property.id);
  await expect(applyAppointmentAddress(denied, plan, 'admin-a')).rejects.toMatchObject({ statusCode: 422 });
  expect(denied.calls.some((call) => call.patch)).toBe(false);
  const lookup = denied.calls.find((call) => call.table === 'customer_properties');
  expect(lookup.filters).toContainEqual(['where', { id: property.id, customer_id: row.customer_id, active: true }]);
});

test('concurrent property or status changes refuse the stale plan', async () => {
  const plan = await planAppointmentAddress(connection(), row.id, property.id);
  const changed = connection({ rows: [{ ...row, property_id: 'another' }] });
  await expect(applyAppointmentAddress(changed, plan, 'admin-a')).rejects.toMatchObject({ statusCode: 409 });
  expect(changed.calls.some((call) => call.patch)).toBe(false);
});

test('grouped stops retain membership and get a unique destination identity', async () => {
  const rows = [{ ...row, visit_id: 'visit-a' }, { ...row, id: 'row-b', visit_id: 'visit-a', is_recurring: false }];
  const visits = [{ id: 'visit-a', customer_id: row.customer_id, property_id: 'old', scheduled_date: row.scheduled_date, stop_base_key: 'old:2099-01-01' }];
  const conn = connection({ rows, visits });
  const plan = await planAppointmentAddress(conn, row.id, property.id);
  await lockAppointmentAddress(conn, plan);
  await applyAppointmentAddress(conn, plan, 'admin-a');
  expect(lockStop.mock.calls.map((call) => call[1])).toEqual(['old:2099-01-01', 'property-b:2099-01-01']);
  expect(conn.calls.find((call) => call.table === 'service_visits' && call.patch).patch)
    .toEqual({ property_id: property.id, stop_base_key: 'property-b:2099-01-01', stop_seq: 4 });
  expect(conn.calls.find((call) => call.table === 'scheduled_services' && call.patch).patch).not.toHaveProperty('visit_id');
});


test('editing a child includes its template and outstanding siblings, not another plan or completed history', async () => {
  const template = { ...row, id: 'template', status: 'completed' };
  const child = { ...row, id: 'child', recurring_parent_id: template.id };
  const pending = { ...child, id: 'pending', status: 'pending' };
  const completed = { ...child, id: 'completed', status: 'completed' };
  const unrelated = { ...child, id: 'unrelated', recurring_parent_id: 'another-template' };
  const conn = connection({ rows: [template, child, pending, completed, unrelated] });
  const plan = await planAppointmentAddress(conn, child.id, property.id);
  expect(plan.rows.map((r) => r.id).sort()).toEqual(['child', 'pending', 'template']);
  expect(plan.parentId).toBe('template');
});


test('visit scope changes the child and its grouped lines without selecting the recurrence template or siblings', async () => {
  const template = { ...row, id: 'template', status: 'completed' };
  const child = { ...row, id: 'child', recurring_parent_id: template.id, visit_id: 'visit-a' };
  const grouped = { ...child, id: 'grouped', is_recurring: false };
  const sibling = { ...child, id: 'future', visit_id: null, scheduled_date: '2099-02-01' };
  const conn = connection({ rows: [template, child, grouped, sibling] });
  const plan = await planAppointmentAddress(conn, child.id, property.id, 'visit');
  expect(plan.rows.map(r => r.id)).toEqual(['child', 'grouped']);
  await applyAppointmentAddress(conn, plan, 'fixture-admin');
  const changed = conn.calls.find(call => call.table === 'scheduled_services' && call.patch);
  expect(changed.filters).toContainEqual(['whereIn', 'id', ['child', 'grouped']]);
});
