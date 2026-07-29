/**
 * Google Contacts sync (owner directive 2026-07-28): customers + incoming
 * leads become starred Google Contacts, hands-off. These tests pin the
 * safety model: the explicit external-writer gate, ownership rules (the
 * customer row owns the contact — conversion transfers refresh the in-run
 * snapshot, siblings adopt, shared contacts are never deleted), the
 * ms-precision stamp (synced_at copies the column via SQL, never a lossy
 * JS Date), scope-missing abort, compensating rollback ONLY for genuinely
 * fresh creates, the tombstone lane for soft-deleted rows, and the
 * verification lane for external drift.
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

const RAW_UPDATED_AT = { __raw: 'updated_at' };

/**
 * Chainable knex mock. Select order per table: main pass, tombstone lane,
 * verification lane — pass full queues via customersSelects/leadsSelects to
 * target the later lanes.
 */
function setupDb({
  customers = [], leads = [], customersSelects = null, leadsSelects = null,
  firstResults = {}, updateResults = {},
} = {}) {
  const state = { updates: [] };
  const selectQueues = {
    customers: customersSelects ? [...customersSelects] : [customers],
    leads: leadsSelects ? [...leadsSelects] : [leads],
  };
  const firstQueues = Object.fromEntries(Object.entries(firstResults).map(([t, rows]) => [t, [...rows]]));
  const updateQueues = Object.fromEntries(Object.entries(updateResults).map(([t, rows]) => [t, [...rows]]));
  db.raw = jest.fn((sql) => ({ __raw: sql }));
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
const BASE_COUNTS = { synced: 0, skipped: 0, failed: 0, retired: 0, verified: 0, blocked: null };

describe('runContactsSync', () => {
  test('the external-writer gate defaults OFF — nothing runs without the owner opt-in', async () => {
    delete process.env.GATE_CONTACTS_SYNC;
    setupDb({ customers: [CUSTOMER] });
    const counts = await runContactsSync({ gapMs: 0 });
    expect(counts.blocked).toBe('gate_off');
    expect(gmailClient.getAuthClient).not.toHaveBeenCalled();
    expect(mockPeopleApi.people.createContact).not.toHaveBeenCalled();
  });

  test('creates a starred, source-tagged contact and stamps synced_at from the COLUMN, not a JS Date', async () => {
    const state = setupDb({ customers: [CUSTOMER] });
    mockPeopleApi.people.createContact.mockResolvedValueOnce({ data: { resourceName: 'people/abc' } });
    const counts = await runContactsSync({ gapMs: 0 });
    expect(counts).toEqual({ ...BASE_COUNTS, synced: 1 });
    const body = mockPeopleApi.people.createContact.mock.calls[0][0].requestBody;
    expect(body.memberships.map((m) => m.contactGroupMembership.contactGroupResourceName))
      .toEqual(['contactGroups/myContacts', 'contactGroups/starred']);
    expect(body.clientData).toEqual([{ key: 'waves_row', value: 'customers:c-1' }]);
    const patch = state.updates.find((u) => u.table === 'customers').patch;
    expect(patch.google_contact_id).toBe('people/abc');
    // Full-precision copy of updated_at — a rebound JS Date loses Postgres
    // microseconds and would wedge the ms-equality guard forever.
    expect(patch.google_contact_synced_at).toEqual(RAW_UPDATED_AT);
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

  test('a converted lead TRANSFERS its contact and refreshes the in-run customer snapshot', async () => {
    const queuedCustomer = { ...CUSTOMER, email: 'jane2@customer.example' };
    const state = setupDb({
      customers: [queuedCustomer],
      leads: [{ id: 'l-1', first_name: 'Jane', email: 'jane2@customer.example', phone: null, customer_id: 'c-1', google_contact_id: 'people/lead1', updated_at: '2026-07-28T11:00:00Z' }],
    });
    mockPeopleApi.people.get.mockResolvedValueOnce({ data: { etag: 'e1', memberships: [] } });
    mockPeopleApi.people.updateContact.mockResolvedValueOnce({ data: { resourceName: 'people/lead1' } });
    const counts = await runContactsSync({ gapMs: 0 });
    expect(counts.skipped).toBe(1);
    expect(counts.synced).toBe(1);
    // customers.google_contact_id adopted the lead's contact...
    expect(state.updates.find((u) => u.table === 'customers' && u.patch.google_contact_id === 'people/lead1' && !u.patch.google_contact_synced_at)).toBeDefined();
    // ...the lead released it...
    expect(state.updates.find((u) => u.table === 'leads').patch.google_contact_id).toBeNull();
    // ...and the SAME RUN's customer pass UPDATED that contact (snapshot
    // refreshed) instead of creating a duplicate.
    expect(mockPeopleApi.people.createContact).not.toHaveBeenCalled();
    expect(mockPeopleApi.people.updateContact.mock.calls[0][0].resourceName).toBe('people/lead1');
    expect(mockPeopleApi.people.deleteContact).not.toHaveBeenCalled();
  });

  test('a converted lead whose customer ALREADY has a different contact deletes the unshared duplicate', async () => {
    setupDb({
      leads: [{ id: 'l-1', first_name: 'Jane', email: 'jane@customer.example', phone: null, customer_id: 'c-1', google_contact_id: 'people/dup', updated_at: '2026-07-28T11:00:00Z' }],
      updateResults: { customers: [0] }, // whereNull(google_contact_id) matches nothing
      firstResults: { customers: [{ id: 'c-1', google_contact_id: 'people/cust' }] }, // fresh re-read
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
  });

  test('a contact still referenced by a sibling row is RELEASED, never deleted', async () => {
    const state = setupDb({
      leads: [{ id: 'l-2', first_name: '', email: null, phone: '  ', customer_id: null, google_contact_id: 'people/shared', updated_at: '2026-07-28T11:00:00Z' }],
      // contactInUseElsewhere: customers → null, leads → sibling holds it
      firstResults: { customers: [null], leads: [{ id: 'l-1' }] },
    });
    const counts = await runContactsSync({ gapMs: 0 });
    expect(counts.skipped).toBe(1);
    expect(mockPeopleApi.people.deleteContact).not.toHaveBeenCalled();
    expect(state.updates.find((u) => u.table === 'leads').patch.google_contact_id).toBeNull();
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

  test('an UNTAGGED exact-email search hit (operator-authored) is never adopted or touched', async () => {
    setupDb({ customers: [CUSTOMER] });
    // Same email, but no waves_row tag — could be an operator's own contact;
    // adopting it would overwrite it and expose it to the delete paths.
    mockPeopleApi.people.searchContacts.mockResolvedValueOnce({ data: { results: [
      { person: { resourceName: 'people/operator', emailAddresses: [{ value: 'jane@customer.example' }] } },
    ] } });
    mockPeopleApi.people.createContact.mockResolvedValueOnce({ data: { resourceName: 'people/fresh' } });
    const counts = await runContactsSync({ gapMs: 0 });
    expect(counts.synced).toBe(1);
    expect(mockPeopleApi.people.updateContact).not.toHaveBeenCalled();
    expect(mockPeopleApi.people.deleteContact).not.toHaveBeenCalled();
    expect(mockPeopleApi.people.createContact).toHaveBeenCalled();
  });

  test('a raced-edit stamp veto (0 rows) compensates a fresh create — no silent success', async () => {
    setupDb({
      customers: [CUSTOMER],
      updateResults: { customers: [0] }, // concurrent edit vetoed the stamp
    });
    mockPeopleApi.people.createContact.mockResolvedValueOnce({ data: { resourceName: 'people/fresh' } });
    const counts = await runContactsSync({ gapMs: 0 });
    expect(counts.synced).toBe(0);
    expect(counts.failed).toBe(0);
    expect(mockPeopleApi.people.deleteContact).toHaveBeenCalledWith({ resourceName: 'people/fresh' });
  });

  test('a row stripped of ALL contact info deletes its (unshared) Google contact', async () => {
    const state = setupDb({ customers: [{ ...CUSTOMER, email: null, phone: '  ', google_contact_id: 'people/old' }] });
    const counts = await runContactsSync({ gapMs: 0 });
    expect(counts.skipped).toBe(1);
    expect(mockPeopleApi.people.deleteContact).toHaveBeenCalledWith({ resourceName: 'people/old' });
    const patch = state.updates.find((u) => u.table === 'customers').patch;
    expect(patch.google_contact_id).toBeNull();
  });

  test('tombstone lane retires soft-deleted rows — merged-away customers stop serving stale PII', async () => {
    const state = setupDb({
      customersSelects: [[], [{ id: 'c-dead', google_contact_id: 'people/loser' }], []],
      leadsSelects: [[], [], []],
    });
    const counts = await runContactsSync({ gapMs: 0 });
    expect(counts.retired).toBe(1);
    expect(mockPeopleApi.people.deleteContact).toHaveBeenCalledWith({ resourceName: 'people/loser' });
    expect(state.updates.find((u) => u.table === 'customers').patch).toEqual({ google_contact_id: null });
  });

  test('verification lane re-pushes long-unverified rows — external drift heals', async () => {
    const staleVerified = { ...CUSTOMER, google_contact_id: 'people/drifted', google_contact_synced_at: '2026-07-01T00:00:00Z' };
    setupDb({
      customersSelects: [[], [], [staleVerified]],
      leadsSelects: [[], [], []],
    });
    // Contact was deleted externally → 404 → recreate.
    const err = new Error('not found');
    err.code = 404;
    mockPeopleApi.people.get.mockRejectedValueOnce(err);
    mockPeopleApi.people.createContact.mockResolvedValueOnce({ data: { resourceName: 'people/reborn' } });
    const counts = await runContactsSync({ gapMs: 0, now: new Date('2026-07-28T12:00:00Z') });
    expect(counts.verified).toBe(1);
    expect(mockPeopleApi.people.createContact).toHaveBeenCalled();
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
