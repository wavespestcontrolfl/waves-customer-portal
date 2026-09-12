/**
 * App property scope, PR 3 — GET/PUT /notifications/property-preferences
 * under the saved-property scope: one entry per saved property, the primary
 * answering its profile row byte-for-byte, a non-primary answering its own
 * toggles (chosen) or the ruling-R1 default; PUT with propertyId writes the
 * property row (upsert) and never touches notification_prefs; contacts on a
 * non-primary property are refused (ruling R2 pending); gate off = today's
 * profile list and a 404 on propertyId.
 */
jest.mock('../models/db', () => { const fn = jest.fn(); fn.transaction = jest.fn(); return fn; });
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../middleware/auth', () => ({ authenticate: (req, _res, next) => { req.customerId = 'c1'; req.customer = { id: 'c1', active: true, account_id: 'a1' }; next(); } }));
jest.mock('../services/account-membership-email', () => ({ sendAccountUpdated: jest.fn(async () => ({})) }));
jest.mock('../utils/customer-comms-lock', () => ({ lockCustomerComms: jest.fn(), lockAssignedCustomerEmails: jest.fn(), withCustomerCommsLock: jest.fn(async (_db, _id, fn) => fn(require('../models/db'))) }));
jest.mock('../services/service-contact-events', () => ({ recordServiceContactChanges: jest.fn(async () => {}) }));
jest.mock('../services/account-properties', () => {
  const actual = jest.requireActual('../services/account-properties');
  return {
    ...actual,
    appPropertyScopeEnabled: jest.fn(() => global.__SCOPE_ON__ === true),
    accountPropertyIds: jest.fn(async () => ['c1']),
    // The real return shape: { properties, selected } (GitHub codex r0 P1).
    accountSavedProperties: jest.fn(async () => ({ properties: global.__ENTRIES__ || [], selected: null })),
  };
});

const express = require('express');
const db = require('../models/db');
const router = require('../routes/notifications');

const ENTRIES = [
  { key: 'c1:pa', customerId: 'c1', propertyId: 'pa', isPrimaryProfile: true, profileLabel: 'Primary', isPrimaryProperty: true, label: null, relationship: 'own_home', address: { line1: '1 Main St' } },
  { key: 'c1:pb', customerId: 'c1', propertyId: 'pb', isPrimaryProfile: true, profileLabel: 'Primary', isPrimaryProperty: false, label: 'Lake house', relationship: 'family_home', address: { line1: '2 Shore Ln' } },
  { key: 'c1:pr', customerId: 'c1', propertyId: 'pr', isPrimaryProfile: true, profileLabel: 'Primary', isPrimaryProperty: false, label: null, relationship: 'rental_owned', address: { line1: '3 Rent Rd' } },
];
const CUSTOMER_PREFS = { customer_id: 'c1', appointment_confirmation: true, service_reminder_72h: false, service_reminder_24h: true, tech_en_route: true, tech_arrived: true, appointment_notify_primary: true, sms_enabled: true, email_enabled: true };

function chain(rows, { onInsert, onUpdate } = {}) {
  const c = { calls: [] };
  for (const m of ['where', 'whereIn', 'select', 'orderBy', 'limit', 'forUpdate', 'onConflict']) c[m] = jest.fn((...a) => { c.calls.push([m, ...a]); return c; });
  c.first = jest.fn(async () => rows[0]);
  // insert(...).onConflict('property_id').merge(updates) — the upsert the
  // route uses; a bare insert stays awaitable for the profile path.
  c.insert = jest.fn((r) => { c.pendingInsert = r; c.then = (resolve, reject) => Promise.resolve((onInsert && onInsert(r), [1])).then(resolve, reject); return c; });
  c.merge = jest.fn(async (u) => { if (onInsert) onInsert({ ...c.pendingInsert, ...u }); return [1]; });
  c.update = jest.fn(async (r) => { if (onUpdate) onUpdate(r); return 1; });
  c.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
  return c;
}

let server; let base; let writes;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/notifications', router);
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  server = app.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.close(done); });

function setDb({ propertyRows = [], property = null, prefsRow = CUSTOMER_PREFS } = {}) {
  writes = [];
  let propertyRowState = propertyRows;
  db.mockImplementation((table) => {
    if (table === 'customers') return chain([{ id: 'c1', service_contact_name: 'Sam', service_contact_phone: '+19415550101', service_contact_email: null }]);
    if (table === 'notification_prefs') return chain([prefsRow], { onUpdate: (r) => writes.push(['notification_prefs', r]) });
    if (table === 'property_notification_prefs') {
      return chain(propertyRowState, {
        onInsert: (r) => { writes.push(['upsert', r]); propertyRowState = [{ ...(propertyRowState[0] || {}), ...r }]; },
        onUpdate: (r) => { writes.push(['update', r]); propertyRowState = [{ ...(propertyRowState[0] || {}), ...r }]; },
      });
    }
    if (table === 'customer_properties') return chain(property ? [property] : []);
    throw new Error(`unexpected table ${table}`);
  });
}
beforeEach(() => { jest.clearAllMocks(); global.__SCOPE_ON__ = true; global.__ENTRIES__ = ENTRIES; process.env.GATE_APP_PROPERTY_TEXTS = 'true'; });
afterEach(() => { delete process.env.GATE_APP_PROPERTY_TEXTS; });

describe('GET /property-preferences (saved scope)', () => {
  test('one entry per saved property; primary = profile row; family home inherits; rental starts quiet; chosen toggles win', async () => {
    setDb({ propertyRows: [{ property_id: 'pr', tech_arrived: true }] });
    const res = await fetch(`${base}/notifications/property-preferences`);
    expect(res.status).toBe(200);
    const { properties } = await res.json();
    expect(properties.map((p) => p.id)).toEqual(['c1:pa', 'c1:pb', 'c1:pr']);
    const [pa, pb, pr] = properties;
    expect(pa.preferences).toMatchObject({ serviceReminder72h: false, techEnRoute: true, appointmentNotifyPrimary: true });
    expect(pa.chosen).toBeUndefined();
    expect(pb.preferences).toMatchObject({ serviceReminder72h: false, techEnRoute: true, techArrived: true });
    expect(pb.quietByDefault).toBe(false);
    expect(pb.chosen.techArrived).toBe(false);
    expect(pr.preferences).toMatchObject({ appointmentConfirmation: false, serviceReminder24h: false, techEnRoute: false, techArrived: true, appointmentNotifyPrimary: true });
    expect(pr.quietByDefault).toBe(true);
    expect(pr.chosen.techArrived).toBe(true);
    expect(pr.contactsShared).toBe(true);
    expect(pr.serviceContacts.length).toBeGreaterThan(0);
    expect(pr.label).toBeNull();
  });
  test('SHADOW mode (texts gate off): today\'s profile list — the card shows and edits what actually sends', async () => {
    delete process.env.GATE_APP_PROPERTY_TEXTS;
    setDb({});
    const res = await fetch(`${base}/notifications/property-preferences`);
    const { properties } = await res.json();
    expect(properties).toHaveLength(1);
    expect(properties[0].id).toBe('c1');
    expect(require('../services/account-properties').accountSavedProperties).not.toHaveBeenCalled();
  });
  test('scope gate off: today\'s profile list (no saved read)', async () => {
    global.__SCOPE_ON__ = false;
    setDb({});
    const res = await fetch(`${base}/notifications/property-preferences`);
    const { properties } = await res.json();
    expect(properties).toHaveLength(1);
    expect(properties[0].id).toBe('c1');
    expect(require('../services/account-properties').accountSavedProperties).not.toHaveBeenCalled();
  });
  test('profile-shaped saved list (no propertyId on any entry) keeps today\'s list', async () => {
    global.__ENTRIES__ = [{ key: 'c1:profile', customerId: 'c1', propertyId: null, isPrimaryProperty: true }];
    setDb({});
    const { properties } = await (await fetch(`${base}/notifications/property-preferences`)).json();
    expect(properties[0].id).toBe('c1');
  });
});

describe('PUT /property-preferences/:customerId with propertyId', () => {
  test('non-primary: upserts the property row under the comms lock (insert … on conflict merge), never touches notification_prefs', async () => {
    setDb({ property: { id: 'pr', customer_id: 'c1', is_primary: false, active: true, relationship: 'rental_owned', label: null, address_line1: '3 Rent Rd' } });
    let res = await fetch(`${base}/notifications/property-preferences/c1`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ propertyId: '6f1c2e2a-1111-4a2b-8c3d-0123456789ab', techEnRoute: true }) });
    expect(res.status).toBe(200);
    let body = await res.json();
    expect(body.preferences).toMatchObject({ techEnRoute: true, techArrived: false, appointmentConfirmation: false });
    expect(writes[0][0]).toBe('upsert');
    expect(writes[0][1]).toMatchObject({ property_id: 'pr', customer_id: 'c1', tech_en_route: true });
    expect(writes.some(([t]) => t === 'notification_prefs')).toBe(false);
    expect(require('../utils/customer-comms-lock').withCustomerCommsLock).toHaveBeenCalledWith(expect.anything(), 'c1', expect.any(Function));
    res = await fetch(`${base}/notifications/property-preferences/c1`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ propertyId: '6f1c2e2a-1111-4a2b-8c3d-0123456789ab', techArrived: true }) });
    body = await res.json();
    expect(writes[writes.length - 1][0]).toBe('upsert');
    expect(body.preferences).toMatchObject({ techEnRoute: true, techArrived: true });
  });
  test('a property promoted to primary between the read and the locked write is refused (409), nothing written', async () => {
    setDb({ property: { id: 'pb', customer_id: 'c1', is_primary: false, active: true, relationship: 'family_home' } });
    // The locked re-read answers "primary now".
    const lock = require('../utils/customer-comms-lock').withCustomerCommsLock;
    lock.mockImplementationOnce(async (_db, _id, fn) => fn((table) => {
      if (table === 'customer_properties') { const c = chain([{ is_primary: true, active: true }]); c.forUpdate = jest.fn(() => c); return c; }
      return db(table);
    }));
    const res = await fetch(`${base}/notifications/property-preferences/c1`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ propertyId: '6f1c2e2a-1111-4a2b-8c3d-0123456789ab', techEnRoute: false }) });
    expect(res.status).toBe(409);
    expect(writes.some(([t]) => t === 'upsert')).toBe(false);
  });
  test('the PRIMARY property writes the profile row (today\'s path)', async () => {
    setDb({ property: { id: 'pa', customer_id: 'c1', is_primary: true, active: true } });
    const res = await fetch(`${base}/notifications/property-preferences/c1`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ propertyId: '6f1c2e2a-1111-4a2b-8c3d-0123456789ab', techEnRoute: false }) });
    expect(res.status).toBe(200);
    expect(writes.some(([t, r]) => t === 'notification_prefs' && r.tech_en_route === false)).toBe(true);
    expect(writes.some(([t]) => t === 'upsert' || t === 'update')).toBe(false);
  });
  test('contacts on a non-primary property are refused (contacts stay per profile)', async () => {
    setDb({ property: { id: 'pb', customer_id: 'c1', is_primary: false, active: true, relationship: 'family_home' } });
    const res = await fetch(`${base}/notifications/property-preferences/c1`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ propertyId: '6f1c2e2a-1111-4a2b-8c3d-0123456789ab', serviceContacts: [{ firstName: 'T', phone: '9415550102' }], serviceContactsConsent: true }) });
    expect(res.status).toBe(400);
    expect(writes).toHaveLength(0);
  });
  test('shadow mode (texts gate off): propertyId is 404 — nothing per-property is writable until enforced', async () => {
    delete process.env.GATE_APP_PROPERTY_TEXTS;
    setDb({ property: { id: 'pb', customer_id: 'c1', is_primary: false, active: true } });
    const res = await fetch(`${base}/notifications/property-preferences/c1`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ propertyId: '6f1c2e2a-1111-4a2b-8c3d-0123456789ab', techEnRoute: false }) });
    expect(res.status).toBe(404);
    expect(writes).toHaveLength(0);
  });
  test('a retired or foreign property is 404; gate off is 404', async () => {
    setDb({ property: { id: 'pb', customer_id: 'c1', is_primary: false, active: false } });
    let res = await fetch(`${base}/notifications/property-preferences/c1`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ propertyId: '6f1c2e2a-1111-4a2b-8c3d-0123456789ab', techEnRoute: false }) });
    expect(res.status).toBe(404);
    global.__SCOPE_ON__ = false;
    setDb({ property: { id: 'pb', customer_id: 'c1', is_primary: false, active: true } });
    res = await fetch(`${base}/notifications/property-preferences/c1`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ propertyId: '6f1c2e2a-1111-4a2b-8c3d-0123456789ab', techEnRoute: false }) });
    expect(res.status).toBe(404);
    expect(writes).toHaveLength(0);
  });
});
