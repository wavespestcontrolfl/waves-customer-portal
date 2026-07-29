/**
 * Google Contacts sync (owner directive 2026-07-28): customers + incoming
 * leads become starred Google Contacts, hands-off. These tests pin the
 * safety model: the explicit external-writer gate, ownership rules (the
 * customer row owns the contact — conversion transfers, siblings adopt,
 * never duplicate), scope-missing abort (nothing stamped until the
 * one-time re-consent), membership merge (operator labels survive),
 * create rollback (no leaked duplicates), and contact deletion when the
 * source row loses all contact info.
 */

const mockPeopleApi = {
  people: {
    get: jest.fn(),
    updateContact: jest.fn(),
    createContact: jest.fn(),
    deleteContact: jest.fn(async () => ({})),
    searchContacts: jest.fn(async () => ({ data: { results: [] } })),
  },
};
jest.mock('googleapis', () => ({ google: { people: jest.fn(() => mockPeopleApi) } }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/email/gmail-client', () => ({ getAuthClient: jest.fn(async () => ({})) }));

const db = require('../models/db');
const gmailClient = require('../services/email/gmail-client');
const { runContactsSync } = require('../services/google-contacts-sync');

/**
 * Chainable knex mock: per-table thenable select queues + FIFO first()
 * queues; updates recorded with their table and configurable return.
 */
function setupDb({ customers = [], leads = [], firstResults = {}, updateResults = {} } = {}) {
  const state = { updates: [] };
  const selectQueues = { customers: [customers], leads: [leads] };
  const firstQueues = Object.fromEntries(Object.entries(firstResults).map(([t, rows]) => [t, [...rows]]));
  const updateQueues = Object.fromEntries(Object.entries(updateResults).map(([t, rows]) => [t, [...rows]]));
  db.mockImplementation((table) => {
    const builder = {};
    for (const m of ['where', 'whereRaw', 'whereNull', 'whereNot', 'whereNotNull', 'orWhere', 'orWhereRaw', 'orderBy', 'limit', 'select']) {
      builder[m] = jest.fn((...args) => {
        if (typeof args[0] === 'function') args[0].call(builder, builder);
        return builder;
      });
    }
    builder.then = (resolve, reject) => {
      const q = selectQueues[table];
      return Promise.resolve(q && q.length ? q.shift() : []).then(resolve, reject);
    };
    builder.first = jest.fn(async () => {
      const q = firstQueues[table];
      return q && q.length ? q.shift() : null;
    });
    builder.update = jest.fn(async (patch) => {
      state.updates.push({ table, patch });
      const q = updateQueues[table];
      if (q && q.length) {
        const v = q.shift();
        if (v instanceof Error) throw v;
        return v;
      }
      return 1;
    });
    return builder;
  });
  return state;
}

beforeEach(() => { process.env.GATE_CONTACTS_SYNC = 'true'; });
afterEach(() => {
  jest.clearAllMocks();
  mockPeopleApi.people.searchContacts.mockImplementation(async () => ({ data: { results: [] } }));
  mockPeopleApi.people.deleteContact.mockImplementation(async () => ({}));
  delete process.env.GATE_CONTACTS_SYNC;
});

const CUSTOMER = {
  id: 'c-1', first_name: 'Jane', last_name: 'Customer', email: 'jane@customer.example',
  phone: '9415550100', address_line1: '1 Palm Way', city: 'Parrish', state: 'FL', zip: '34219',
  google_contact_id: null, updated_at: '2026-07-28T12:00:00Z',
};

describe('runContactsSync', () => {
  test('the external-writer gate defaults OFF — nothing runs without the owner opt-in', async () => {
    delete process.env.GATE_CONTACTS_SYNC;
    setupDb({ customers: [CUSTOMER] });
    const counts = await runContactsSync({ gapMs: 0 });
    expect(counts.blocked).toBe('gate_off');
    expect(gmailClient.getAuthClient).not.toHaveBeenCalled();
    expect(mockPeopleApi.people.createContact).not.toHaveBeenCalled();
  });

  test('creates a starred, source-tagged contact for a new customer and stamps the row', async () => {
    const state = setupDb({ customers: [CUSTOMER] });
    mockPeopleApi.people.createContact.mockResolvedValueOnce({ data: { resourceName: 'people/abc' } });
    const counts = await runContactsSync({ gapMs: 0 });
    expect(counts).toEqual({ synced: 1, skipped: 0, failed: 0, blocked: null });
    const body = mockPeopleApi.people.createContact.mock.calls[0][0].requestBody;
    expect(body.memberships.map((m) => m.contactGroupMembership.contactGroupResourceName))
      .toEqual(['contactGroups/myContacts', 'contactGroups/starred']);
    expect(body.clientData).toEqual([{ key: 'waves_row', value: 'customers:c-1' }]);
    expect(body.emailAddresses).toEqual([{ value: 'jane@customer.example' }]);
    const patch = state.updates.find((u) => u.table === 'customers').patch;
    expect(patch.google_contact_id).toBe('people/abc');
    expect(patch.google_contact_synced_at).toBeInstanceOf(Date);
  });

  test('whitespace-only fields are never sent — the valid field still publishes', async () => {
    setupDb({ customers: [{ ...CUSTOMER, email: '  ' }] });
    mockPeopleApi.people.createContact.mockResolvedValueOnce({ data: { resourceName: 'people/abc' } });
    await runContactsSync({ gapMs: 0 });
    const body = mockPeopleApi.people.createContact.mock.calls[0][0].requestBody;
    expect(body.emailAddresses).toBeUndefined();
    expect(body.phoneNumbers).toEqual([{ value: '9415550100' }]);
  });

  test('updates merge memberships — operator-added groups survive the sync', async () => {
    setupDb({ customers: [{ ...CUSTOMER, google_contact_id: 'people/abc' }] });
    mockPeopleApi.people.get.mockResolvedValueOnce({ data: {
      etag: 'e1',
      memberships: [{ contactGroupMembership: { contactGroupResourceName: 'contactGroups/vipCustomLabel' } }],
    } });
    mockPeopleApi.people.updateContact.mockResolvedValueOnce({ data: { resourceName: 'people/abc' } });
    await runContactsSync({ gapMs: 0 });
    const sent = mockPeopleApi.people.updateContact.mock.calls[0][0].requestBody.memberships
      .map((m) => m.contactGroupMembership.contactGroupResourceName);
    expect(sent).toEqual(['contactGroups/vipCustomLabel', 'contactGroups/myContacts', 'contactGroups/starred']);
  });

  test('a converted lead TRANSFERS its contact to the customer row', async () => {
    const state = setupDb({
      leads: [{ id: 'l-1', first_name: 'Jane', email: 'jane@customer.example', phone: null, customer_id: 'c-1', google_contact_id: 'people/lead1', updated_at: '2026-07-28T11:00:00Z' }],
    });
    const counts = await runContactsSync({ gapMs: 0 });
    expect(counts.skipped).toBe(1);
    // customers.google_contact_id adopted the lead's contact...
    const transfer = state.updates.find((u) => u.table === 'customers');
    expect(transfer.patch).toEqual({ google_contact_id: 'people/lead1' });
    // ...and the lead released it.
    const leadPatch = state.updates.find((u) => u.table === 'leads').patch;
    expect(leadPatch.google_contact_id).toBeNull();
    expect(mockPeopleApi.people.deleteContact).not.toHaveBeenCalled();
  });

  test('a converted lead whose customer ALREADY has a contact deletes the duplicate', async () => {
    setupDb({
      leads: [{ id: 'l-1', first_name: 'Jane', email: 'jane@customer.example', phone: null, customer_id: 'c-1', google_contact_id: 'people/dup', updated_at: '2026-07-28T11:00:00Z' }],
      updateResults: { customers: [0] }, // whereNull(google_contact_id) matches nothing
    });
    const counts = await runContactsSync({ gapMs: 0 });
    expect(counts.skipped).toBe(1);
    expect(mockPeopleApi.people.deleteContact).toHaveBeenCalledWith({ resourceName: 'people/dup' });
  });

  test('a repeat-inquiry lead ADOPTS the sibling lead contact instead of minting another', async () => {
    setupDb({
      leads: [{ id: 'l-2', first_name: 'Sam', email: 'sam@new.example', phone: '9415550101', customer_id: null, google_contact_id: null, updated_at: '2026-07-28T11:00:00Z' }],
      firstResults: { customers: [null], leads: [{ id: 'l-1', google_contact_id: 'people/sib' }] },
    });
    mockPeopleApi.people.get.mockResolvedValueOnce({ data: { etag: 'e1', memberships: [] } });
    mockPeopleApi.people.updateContact.mockResolvedValueOnce({ data: { resourceName: 'people/sib' } });
    const counts = await runContactsSync({ gapMs: 0 });
    expect(counts.synced).toBe(1);
    expect(mockPeopleApi.people.createContact).not.toHaveBeenCalled();
    expect(mockPeopleApi.people.updateContact.mock.calls[0][0].resourceName).toBe('people/sib');
  });

  test('pre-create search adopts a contact from a LOST create response (waves_row tag)', async () => {
    setupDb({ customers: [CUSTOMER] });
    mockPeopleApi.people.searchContacts.mockResolvedValueOnce({ data: { results: [
      { person: { resourceName: 'people/lost', clientData: [{ key: 'waves_row', value: 'customers:c-1' }] } },
    ] } });
    mockPeopleApi.people.get.mockResolvedValueOnce({ data: { etag: 'e1', memberships: [] } });
    mockPeopleApi.people.updateContact.mockResolvedValueOnce({ data: { resourceName: 'people/lost' } });
    const counts = await runContactsSync({ gapMs: 0 });
    expect(counts.synced).toBe(1);
    expect(mockPeopleApi.people.createContact).not.toHaveBeenCalled();
  });

  test('a failed stamp after a FRESH create rolls the contact back — no leaked duplicate', async () => {
    setupDb({
      customers: [CUSTOMER],
      updateResults: { customers: [new Error('db down')] },
    });
    mockPeopleApi.people.createContact.mockResolvedValueOnce({ data: { resourceName: 'people/fresh' } });
    const counts = await runContactsSync({ gapMs: 0 });
    expect(counts.failed).toBe(1);
    expect(mockPeopleApi.people.deleteContact).toHaveBeenCalledWith({ resourceName: 'people/fresh' });
  });

  test('a row stripped of ALL contact info deletes its Google contact', async () => {
    const state = setupDb({ customers: [{ ...CUSTOMER, email: null, phone: '  ', google_contact_id: 'people/old' }] });
    const counts = await runContactsSync({ gapMs: 0 });
    expect(counts.skipped).toBe(1);
    expect(mockPeopleApi.people.deleteContact).toHaveBeenCalledWith({ resourceName: 'people/old' });
    const patch = state.updates.find((u) => u.table === 'customers').patch;
    expect(patch.google_contact_id).toBeNull();
  });

  test('scope-missing aborts WITHOUT stamping — rows retry after the one-time re-consent', async () => {
    const state = setupDb({ customers: [CUSTOMER] });
    const err = new Error('Request had insufficient authentication scopes.');
    err.code = 403;
    mockPeopleApi.people.createContact.mockRejectedValueOnce(err);
    const counts = await runContactsSync({ gapMs: 0 });
    expect(counts.blocked).toBe('contacts_scope_missing');
    expect(state.updates).toEqual([]);
  });

  test('a contact deleted on the Google side is recreated (404 fallthrough)', async () => {
    const state = setupDb({ customers: [{ ...CUSTOMER, google_contact_id: 'people/gone' }] });
    const err = new Error('not found');
    err.code = 404;
    mockPeopleApi.people.get.mockRejectedValueOnce(err);
    mockPeopleApi.people.createContact.mockResolvedValueOnce({ data: { resourceName: 'people/new' } });
    const counts = await runContactsSync({ gapMs: 0 });
    expect(counts.synced).toBe(1);
    expect(state.updates.find((u) => u.table === 'customers').patch.google_contact_id).toBe('people/new');
  });

  test('no Gmail connection = blocked, nothing attempted', async () => {
    setupDb();
    gmailClient.getAuthClient.mockResolvedValueOnce(null);
    const counts = await runContactsSync({ gapMs: 0 });
    expect(counts.blocked).toBe('gmail_not_connected');
  });
});
