jest.mock('../services/appointment-tagger', () => ({
  classifyAppointmentType: jest.fn((type) => ({ tag: type === 'WDO' ? 'wdo_inspection' : 'general' })),
  triggerWDOPrep: jest.fn(async () => {}),
}));
jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn() }));
jest.mock('../services/scheduling/tech-day-lock', () => ({ lockTechDays: jest.fn() }));
jest.mock('../services/visit-groups', () => ({
  dateOnly: (value) => String(value).slice(0, 10),
  stopBaseKey: ({ propertyId, customerId, scheduledDate }) => `${propertyId || customerId}:${String(scheduledDate).slice(0, 10)}`,
  lockStop: jest.fn(),
  frozenVisitVerdict: jest.fn(async () => ({ frozen: false })),
}));
const { planAppointmentAddress, lockAppointmentAddress, applyAppointmentAddress } = require('../services/appointment-address');
const { recordAuditEvent } = require('../services/audit-log');
const { lockStop, frozenVisitVerdict } = require('../services/visit-groups');

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
    for (const name of ['where', 'whereIn', 'whereNotIn', 'orWhere', 'orderBy', 'forUpdate', 'forShare', 'forNoKeyUpdate']) {
      chain[name] = (...args) => {
        query.filters.push([name, ...args]);
        if (name === 'where') predicates.push(predicate(args));
        if (name === 'whereIn') predicates.push((r) => args[1].includes(r[args[0]]));
        if (name === 'whereNotIn') predicates.push((r) => !args[1].includes(r[args[0]]));
        return chain;
      };
    }
    chain.max = () => { query.max = true; return chain; };
    chain.first = async () => table === 'customer_properties' ? selected : query.max ? { max: 3 } : filtered()[0];
    chain.then = (resolve, reject) => Promise.resolve(filtered()).then(resolve, reject);
    chain.update = async (patch) => { query.patch = patch; return result.length; };
    return chain;
  });
  conn.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
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
    service_address_line2: '', zone: null, route_order: null, lat: null, lng: null, pre_service_brief: null });
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


test.each(['completed', 'rescheduled'])('changes future defaults without relocating a %s template or its siblings', async (status) => {
  const template = { ...row, id: 'template', status, visit_id: 'historic' };
  const sibling = { ...template, id: 'historic-sibling', is_recurring: false };
  const child = { ...row, id: 'child', recurring_parent_id: 'template' };
  const conn = connection({ rows: [child, sibling, template], visits: [{ id: 'historic', stop_base_key: 'old:2099-01-01' }] });
  const plan = await planAppointmentAddress(conn, child.id, property.id);
  expect(plan.rows.map((r) => r.id)).toEqual(['child', 'template']);
  await applyAppointmentAddress(conn, plan, 'admin-a');
  const addressWrite = conn.calls.find((call) => call.patch?.service_address_line1);
  expect(addressWrite.filters).toContainEqual(['whereIn', 'id', ['child']]);
  const defaultWrite = conn.calls.find((call) => call.patch?.recurring_template_overrides);
  expect(defaultWrite.filters).toContainEqual(['where', { id: 'template', customer_id: row.customer_id }]);
  expect(JSON.parse(defaultWrite.patch.recurring_template_overrides.bindings[0]).appointment_address.property_id).toBe(property.id);
  expect(frozenVisitVerdict).not.toHaveBeenCalled();
});

test.each(['issued_link', 'completion_in_flight', 'visit_not_open', 'unreadable'])('refuses frozen visit %s before any write', async (reason) => {
  frozenVisitVerdict.mockResolvedValueOnce({ frozen: true, reason });
  const conn = connection({ rows: [{ ...row, visit_id: 'visit-a' }], visits: [{ id: 'visit-a', stop_base_key: 'old:2099-01-01' }] });
  const plan = await planAppointmentAddress(conn, row.id, property.id);
  await expect(applyAppointmentAddress(conn, plan, 'admin-a')).rejects.toMatchObject({ statusCode: 409, reason });
  expect(conn.calls.some((call) => call.patch)).toBe(false);
});

test('locks the selected property before scheduled-service rows', async () => {
  const conn = connection();
  const plan = await planAppointmentAddress(conn, row.id, property.id);
  await applyAppointmentAddress(conn, plan, 'admin-a');
  const propertyLock = conn.calls.findIndex((call) => call.table === 'customer_properties' && call.filters.some(([name]) => name === 'forShare'));
  const rowLock = conn.calls.findIndex((call) => call.table === 'scheduled_services' && call.filters.some(([name]) => name === 'forUpdate'));
  expect(propertyLock).toBeGreaterThanOrEqual(0);
  expect(propertyLock).toBeLessThan(rowLock);
});


test('ordinary edit saves pre-acquire tech-day fences before maintenance too', () => {
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(path.join(__dirname, '../routes/admin-schedule.js'), 'utf8');
  const handler = source.slice(source.indexOf("router.put('/:id/update-details'"));
  const fence = handler.indexOf('await lockTechDays(trx, preFence)');
  const maintenance = handler.indexOf('await acquireRecurringSeriesMaintenanceLock(trx,');
  const conditionalStop = handler.indexOf('if (preReadVisitId)');
  expect(fence).toBeGreaterThan(-1);
  expect(fence).toBeLessThan(maintenance);
  expect(fence).toBeLessThan(conditionalStop);
});


test.each(['address_line1', 'city', 'state', 'zip'])('rejects an incomplete %s before any plan writes', async (field) => {
  for (const value of [null, undefined, '', '   ']) {
    const conn = connection({ selected: { ...property, [field]: value } });
    const plan = await planAppointmentAddress(conn, row.id, property.id);
    await expect(applyAppointmentAddress(conn, plan, 'admin-a')).rejects.toMatchObject({ statusCode: 422, isOperational: true });
    expect(conn.calls.some((call) => call.patch)).toBe(false);
  }
});

test('a deleted appointment returns an operational not-found error', async () => {
  await expect(planAppointmentAddress(connection({ rows: [] }), row.id, property.id))
    .rejects.toMatchObject({ statusCode: 404, isOperational: true });
});

test('address changes discard the stale route position echoed by the modal', () => {
  const source = require('fs').readFileSync(require('path').join(__dirname, '../routes/admin-schedule.js'), 'utf8');
  const addressBranch = source.slice(source.indexOf('    if (addressPlan) {'));
  expect(addressBranch.slice(0, 220)).toContain('delete updates.route_order');
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

test('address propagation leaves a rescheduled placeholder and its obsolete stop unchanged', async () => {
  const template = { ...row, id: 'template', status: 'completed' };
  const child = { ...row, id: 'child', recurring_parent_id: template.id };
  const phantom = { ...child, id: 'phantom', status: 'rescheduled', visit_id: 'obsolete', scheduled_date: '2098-12-01' };
  const conn = connection({ rows: [template, child, phantom], visits: [{
    id: 'obsolete', customer_id: row.customer_id, property_id: 'old',
    scheduled_date: phantom.scheduled_date, stop_base_key: 'old:2098-12-01',
  }] });
  const plan = await planAppointmentAddress(conn, child.id, property.id);
  expect(plan.rows.map((r) => r.id).sort()).toEqual(['child', 'template']);
  expect(plan.visits).toEqual([]);
  await applyAppointmentAddress(conn, plan, 'admin-a');
  const addressWrite = conn.calls.find((call) => call.patch?.service_address_line1);
  expect(addressWrite.filters).toContainEqual(['whereIn', 'id', ['child']]);
  expect(conn.calls.some((call) => call.table === 'service_visits' && call.patch)).toBe(false);
});


test('rejects a rescheduled anchor before planning or writing its live siblings', async () => {
  const anchor = { ...row, status: 'rescheduled', visit_id: 'obsolete' };
  const sibling = { ...row, id: 'live-child', recurring_parent_id: row.id };
  const conn = connection({ rows: [anchor, sibling] });
  await expect(planAppointmentAddress(conn, row.id, property.id))
    .rejects.toMatchObject({ statusCode: 409, isOperational: true });
  expect(conn.calls).toHaveLength(1);
  expect(conn.calls.some((call) => call.patch)).toBe(false);
});

test('rejects an anchor rescheduled after the address plan was read', async () => {
  const plan = await planAppointmentAddress(connection(), row.id, property.id);
  const conn = connection({ rows: [{ ...row, status: 'rescheduled' }] });
  await expect(applyAppointmentAddress(conn, plan, 'admin-a'))
    .rejects.toMatchObject({ statusCode: 409, isOperational: true });
  expect(conn.calls.some((call) => call.patch)).toBe(false);
});


test.each(require('../services/visit-context/statuses').JOIN_INELIGIBLE_STATUSES)(
  'propagation excludes a sibling with canonical join-ineligible status %s', async (status) => {
    const sibling = { ...row, id: 'inactive-sibling', recurring_parent_id: row.id, status };
    const conn = connection({ rows: [row, sibling] });
    const plan = await planAppointmentAddress(conn, row.id, property.id);
    expect(plan.rows.map((r) => r.id)).toEqual([row.id]);
    await applyAppointmentAddress(conn, plan, 'admin-a');
    const addressWrite = conn.calls.find((call) => call.patch?.service_address_line1);
    expect(addressWrite.filters).toContainEqual(['whereIn', 'id', [row.id]]);
  },
);


test('address stop locking takes the customer row lock first', async () => {
  const conn = connection();
  const plan = await planAppointmentAddress(conn, row.id, property.id);
  lockStop.mockImplementationOnce(async () => {
    expect(conn.calls.some((call) => call.table === 'customers'
      && call.filters.some(([name]) => name === 'forNoKeyUpdate'))).toBe(true);
  });
  await lockAppointmentAddress(conn, plan);
});

test('address refresh rebuilds only WDO research', async () => {
  const rows = [{ id: 'wdo', service_type: 'WDO' }, { id: 'pest', service_type: 'Pest' }];
  const query = {};
  for (const name of ['leftJoin', 'whereIn', 'whereNotIn']) query[name] = jest.fn(() => query);
  query.select = jest.fn(async () => rows);
  const conn = jest.fn(() => query);
  await require('../services/appointment-address').refreshAppointmentAddressBriefs(conn, ['wdo', 'pest']);
  expect(require('../services/appointment-tagger').triggerWDOPrep).toHaveBeenCalledTimes(1);
  expect(require('../services/appointment-tagger').triggerWDOPrep).toHaveBeenCalledWith(rows[0]);
  expect(query.whereNotIn).toHaveBeenCalledWith('ss.status', require('../services/visit-context/statuses').JOIN_INELIGIBLE_STATUSES);
});

test('address saves take maintenance and comms before customer and stop locks', () => {
  const source = require('fs').readFileSync(require('path').join(__dirname, '../routes/admin-schedule.js'), 'utf8');
  const handler = source.slice(source.indexOf("router.put('/:id/update-details'"));
  const maintenance = handler.indexOf('await acquireRecurringSeriesMaintenanceLock(trx,');
  const comms = handler.indexOf('await lockCustomerComms(trx,');
  const customerAndStops = handler.indexOf('await lockAppointmentAddress(trx,');
  expect(maintenance).toBeGreaterThan(-1);
  expect(comms).toBeGreaterThan(maintenance);
  expect(customerAndStops).toBeGreaterThan(comms);
});

test('combined-payment locking precedes address customer and stop locks on payer edits', () => {
  const source = require('fs').readFileSync(require('path').join(__dirname, '../routes/admin-schedule.js'), 'utf8');
  const handler = source.slice(source.indexOf("router.put('/:id/update-details'"));
  const comms = handler.indexOf('await lockCustomerComms(trx,');
  const combined = handler.indexOf('lockCombinedCustomers(trx,');
  const addressLocks = handler.indexOf('await lockAppointmentAddress(trx,');
  expect(combined).toBeGreaterThan(comms);
  expect(combined).toBeLessThan(addressLocks);
  expect(handler.slice(comms, combined)).toContain("Object.prototype.hasOwnProperty.call(updates, 'payer_id') && updates.payer_id");
  expect(handler.slice(comms, combined)).toContain("Object.prototype.hasOwnProperty.call(updates, 'self_pay_override') && !updates.self_pay_override");
});
