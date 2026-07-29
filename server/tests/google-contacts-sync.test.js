/**
 * Google Contacts sync (owner directive 2026-07-28): customers + incoming
 * leads become starred Google Contacts, hands-off. Row-level staleness is
 * the whole state model — these tests pin the ownership rules (customer row
 * owns the contact; sibling leads adopt, never duplicate), the
 * scope-missing abort (nothing stamped until the one-time re-consent), and
 * the 404-recreate path.
 */

const mockPeopleApi = {
  people: {
    get: jest.fn(),
    updateContact: jest.fn(),
    createContact: jest.fn(),
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
 * queues; updates recorded with their table.
 */
function setupDb({ customers = [], leads = [], firstResults = {} } = {}) {
  const state = { updates: [] };
  const selectQueues = { customers: [customers], leads: [leads] };
  const firstQueues = Object.fromEntries(Object.entries(firstResults).map(([t, rows]) => [t, [...rows]]));
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
      return 1;
    });
    return builder;
  });
  return state;
}

afterEach(() => jest.clearAllMocks());

const CUSTOMER = {
  id: 'c-1', first_name: 'Jane', last_name: 'Customer', email: 'jane@customer.example',
  phone: '9415550100', address_line1: '1 Palm Way', city: 'Parrish', state: 'FL', zip: '34219',
  google_contact_id: null,
};

describe('runContactsSync', () => {
  test('creates a starred contact for a new customer and stamps the row', async () => {
    const state = setupDb({ customers: [CUSTOMER] });
    mockPeopleApi.people.createContact.mockResolvedValueOnce({ data: { resourceName: 'people/abc' } });
    const counts = await runContactsSync({ gapMs: 0 });
    expect(counts).toEqual({ synced: 1, skipped: 0, failed: 0, blocked: null });
    const body = mockPeopleApi.people.createContact.mock.calls[0][0].requestBody;
    expect(body.memberships.map((m) => m.contactGroupMembership.contactGroupResourceName))
      .toEqual(['contactGroups/myContacts', 'contactGroups/starred']);
    expect(body.emailAddresses).toEqual([{ value: 'jane@customer.example' }]);
    const patch = state.updates.find((u) => u.table === 'customers').patch;
    expect(patch.google_contact_id).toBe('people/abc');
    expect(patch.google_contact_synced_at).toBeInstanceOf(Date);
  });

  test('a lead matching a live customer email defers — no duplicate contact', async () => {
    const state = setupDb({
      leads: [{ id: 'l-1', first_name: 'Jane', email: 'jane@customer.example', phone: null, customer_id: null, google_contact_id: null }],
      firstResults: { customers: [{ id: 'c-1' }] },
    });
    const counts = await runContactsSync({ gapMs: 0 });
    expect(counts.skipped).toBe(1);
    expect(mockPeopleApi.people.createContact).not.toHaveBeenCalled();
    expect(state.updates.find((u) => u.table === 'leads').patch.google_contact_id).toBeUndefined();
  });

  test('a repeat-inquiry lead ADOPTS the sibling lead contact instead of minting another', async () => {
    setupDb({
      leads: [{ id: 'l-2', first_name: 'Sam', email: 'sam@new.example', phone: '9415550101', customer_id: null, google_contact_id: null }],
      firstResults: { customers: [null], leads: [{ id: 'l-1', google_contact_id: 'people/sib' }] },
    });
    mockPeopleApi.people.get.mockResolvedValueOnce({ data: { etag: 'e1' } });
    mockPeopleApi.people.updateContact.mockResolvedValueOnce({ data: { resourceName: 'people/sib' } });
    const counts = await runContactsSync({ gapMs: 0 });
    expect(counts.synced).toBe(1);
    expect(mockPeopleApi.people.createContact).not.toHaveBeenCalled();
    expect(mockPeopleApi.people.updateContact.mock.calls[0][0].resourceName).toBe('people/sib');
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

  test('no email AND no phone = stamped synced with nothing published', async () => {
    const state = setupDb({ customers: [{ id: 'c-2', first_name: 'Ghost', last_name: '', email: null, phone: null, google_contact_id: null }] });
    const counts = await runContactsSync({ gapMs: 0 });
    expect(counts.skipped).toBe(1);
    expect(mockPeopleApi.people.createContact).not.toHaveBeenCalled();
    expect(state.updates.find((u) => u.table === 'customers').patch.google_contact_synced_at).toBeInstanceOf(Date);
  });

  test('no Gmail connection = blocked, nothing attempted', async () => {
    setupDb();
    gmailClient.getAuthClient.mockResolvedValueOnce(null);
    const counts = await runContactsSync({ gapMs: 0 });
    expect(counts.blocked).toBe('gmail_not_connected');
  });
});
