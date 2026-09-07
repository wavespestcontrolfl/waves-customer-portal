jest.mock('../services/dispatch-assignment', () => ({ emitDispatchJobUpdate: jest.fn(async () => ({})) }));
jest.mock('../services/scheduling/tech-day-lock', () => ({ lockTechDays: jest.fn() }));
jest.mock('../utils/customer-comms-lock', () => ({ lockCustomerComms: jest.fn() }));
jest.mock('../models/db', () => {
  const db = jest.fn();
  db.transaction = jest.fn(async cb => cb(db));
  return db;
});
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => true) }));
jest.mock('../services/appointment-address', () => ({ planAppointmentAddress: jest.fn(), lockAppointmentAddress: jest.fn(), applyAppointmentAddress: jest.fn(async () => ['stop']), refreshAppointmentAddressBriefs: jest.fn(async () => {}) }));
jest.mock('../services/appointment-tagger', () => ({ classifyAppointmentType: jest.fn(() => ({ tag: 'general_pest', label: 'General Pest' })) }));
jest.mock('../services/scheduling/occupancy', () => ({ acquireOccupancyLocks: jest.fn() }));
jest.mock('../services/logger', () => ({ error: jest.fn(), warn: jest.fn() }));
const db = require('../models/db');
const address = require('../services/appointment-address');
const gates = require('../config/feature-gates');
const { emitDispatchJobUpdate } = require('../services/dispatch-assignment');
const tagger = require('../services/appointment-tagger');
const { executeScheduleTool } = require('../services/intelligence-bar/schedule-tools');
const { previewFingerprint } = require('../services/intelligence-bar/authorization-contract');
const input = { appointment_id: '00000000-0000-0000-0000-000000000001', property_id: '00000000-0000-0000-0000-000000000002' };
let plan;
let property;
beforeEach(() => {
  jest.clearAllMocks();
  gates.isEnabled.mockReturnValue(true);
  property = { id: input.property_id, address_line1: '200 Test Street', city: 'Test City', state: 'FL', zip: '34201', customer_id: 'customer' };
  plan = { anchor: { id: input.appointment_id, customer_id: 'customer' }, propertyId: input.property_id, scope: 'visit', rows: [
    { id: input.appointment_id, customer_id: 'customer', scheduled_date: '2099-01-02', status: 'en_route', recurring_parent_id: 'template' },
  ] };
  address.planAppointmentAddress.mockImplementation(async () => structuredClone(plan));
  db.mockImplementation(table => {
    const row = table === 'customers' ? { id: 'customer', address_line1: '100 Test Street' } : property;
    const chain = {};
    for (const name of ['where', 'whereNull', 'whereIn', 'orderBy', 'forUpdate', 'forShare']) chain[name] = () => chain;
    chain.first = async () => row;
    chain.then = resolve => Promise.resolve([]).then(resolve);
    return chain;
  });
});
const call = (params = input, context = {}) => executeScheduleTool('switch_appointment_property', params, context);

test('en-route preview is mutation-free and scoped to this visit', async () => {
  const preview = await call();
  expect(preview.destination).toContain('200 Test Street');
  expect(preview.stops[0].status).toBe('en_route');
  expect(address.planAppointmentAddress).toHaveBeenCalledWith(db, input.appointment_id, input.property_id, 'visit');
  expect(address.applyAppointmentAddress).not.toHaveBeenCalled();
  expect(db.transaction).not.toHaveBeenCalled();
});

test('confirmed execution holds locks and applies only the pinned preview', async () => {
  const preview = await call();
  const result = await call({ ...input, confirmed: true, _verified_address_fingerprint: previewFingerprint(preview) }, { confirmed: true, technicianId: 'actor' });
  expect(result).toMatchObject({ success: true, messages_sent: false });
  expect(address.lockAppointmentAddress).toHaveBeenCalled();
  expect(address.applyAppointmentAddress).toHaveBeenCalledWith(db, expect.objectContaining({ scope: 'visit' }), 'actor');
  expect(emitDispatchJobUpdate).toHaveBeenCalledWith({ jobId: 'stop', actorId: 'actor' });
  expect(emitDispatchJobUpdate.mock.invocationCallOrder[0]).toBeGreaterThan(address.applyAppointmentAddress.mock.invocationCallOrder[0]);
});

test('confirmed execution rebuilds WDO research after commit, never inside the transaction', async () => {
  const preview = await call();
  await call({ ...input, confirmed: true, _verified_address_fingerprint: previewFingerprint(preview) }, { confirmed: true, technicianId: 'actor' });
  expect(address.refreshAppointmentAddressBriefs).toHaveBeenCalledWith(db, ['stop']);
  expect(address.refreshAppointmentAddressBriefs.mock.invocationCallOrder[0]).toBeGreaterThan(address.applyAppointmentAddress.mock.invocationCallOrder[0]);
  // A refused confirmation never triggers research.
  jest.clearAllMocks();
  gates.isEnabled.mockReturnValue(true);
  property.address_line1 = '300 Test Street';
  await call({ ...input, confirmed: true, _verified_address_fingerprint: previewFingerprint(preview) }, { confirmed: true });
  expect(address.refreshAppointmentAddressBriefs).not.toHaveBeenCalled();
});

test('effects keep the cleared-brief and no-regroup disclosures, and mention WDO research only for a WDO visit', async () => {
  let preview = await call();
  expect(preview.effects).toContain('clears the route position and cached pre-service brief.');
  expect(preview.effects).toContain('keeps its current grouping and is not combined');
  expect(preview.effects).not.toContain('WDO');
  tagger.classifyAppointmentType.mockReturnValue({ tag: 'wdo_inspection', label: 'WDO Inspection' });
  preview = await call();
  expect(preview.effects).toContain('cached pre-service brief, then rebuilds WDO research for the new address.');
});

test('destination changes between approval and commit refuse without writes', async () => {
  const preview = await call();
  property.address_line1 = '300 Test Street';
  const result = await call({ ...input, confirmed: true, _verified_address_fingerprint: previewFingerprint(preview) }, { confirmed: true });
  expect(result.preview_changed).toBe(true);
  expect(address.applyAppointmentAddress).not.toHaveBeenCalled();
});

test('missing server confirmation, dark gate, terminal visits, and recurring templates fail closed', async () => {
  expect((await call({ ...input, confirmed: true })).error).toMatch(/confirmation card/);
  gates.isEnabled.mockReturnValue(false);
  expect((await call()).error).toMatch(/not enabled/);
  gates.isEnabled.mockReturnValue(true);
  plan.rows[0].status = 'completed';
  expect((await call()).error).toMatch(/completed/);
  plan.rows[0] = { ...plan.rows[0], status: 'pending', is_recurring: true, recurring_parent_id: null };
  expect((await call()).error).toMatch(/template/);
  expect(address.applyAppointmentAddress).not.toHaveBeenCalled();
});

test('broadcast failure preserves committed success with a refresh warning', async () => {
  const preview = await call();
  emitDispatchJobUpdate.mockRejectedValueOnce(new Error('fixture broadcast failure'));
  const result = await call({ ...input, confirmed: true, _verified_address_fingerprint: previewFingerprint(preview) }, { confirmed: true });
  expect(result).toMatchObject({ success: true, warning: expect.stringContaining('refresh') });
});
