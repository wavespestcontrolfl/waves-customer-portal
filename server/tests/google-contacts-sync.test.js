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

beforeEach(() => {
  // FULL reset (clearAllMocks leaves unconsumed mockResolvedValueOnce
  // queues behind, leaking one test's staged responses into the next),
  // then re-prime the standing defaults.
  jest.resetAllMocks();
  process.env.GATE_CONTACTS_SYNC = 'true';
  gmailClient.getAuthClient.mockImplementation(async () => ({}));
  require('googleapis').google.people.mockImplementation(() => mockPeopleApi);
  mockPeopleApi.people.searchContacts.mockImplementation(async () => ({ data: { results: [] } }));
  mockPeopleApi.people.deleteContact.mockImplementation(async () => ({}));
});
afterEach(() => { delete process.env.GATE_CONTACTS_SYNC; });

const CUSTOMER = {
  id: 'c-1', first_name: 'Jane', last_name: 'Customer', email: 'jane@customer.example',
  phone: '9415550100', address_line1: '1 Palm Way', city: 'Parrish', state: 'FL', zip: '34219',
  google_contact_id: null, account_id: null, updated_at: '2026-07-28T12:00:00Z',
};
const BASE_COUNTS = { synced: 0, skipped: 0, failed: 0, retired: 0, verified: 0, blocked: null };

describe('runContactsSync', () => {
  test('the external-writer gate defaults OFF — nothing runs without the owner opt-in', async () => {
    delete process.env.GATE_CONTACTS_SYNC;
    setupDb({ customers: [{ ...CUSTOMER }] });
    const counts = await runContactsSync({ gapMs: 0 });
    expect(counts.blocked).toBe('gate_off');
    expect(gmailClient.getAuthClient).not.toHaveBeenCalled();
    expect(mockPeopleApi.people.createContact).not.toHaveBeenCalled();
  });

  test('creates a starred, source-tagged contact and stamps synced_at from the COLUMN, not a JS Date', async () => {
    const state = setupDb({ customers: [{ ...CUSTOMER }] });
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
      metadata: { sources: [{ type: 'CONTACT', id: 'abc', etag: 'se1' }] },
      memberships: [{ contactGroupMembership: { contactGroupResourceName: 'contactGroups/vipCustomLabel' } }],
    } });
    mockPeopleApi.people.updateContact.mockResolvedValueOnce({ data: { resourceName: 'people/abc' } });
    await runContactsSync({ gapMs: 0 });
    const sentBody = mockPeopleApi.people.updateContact.mock.calls[0][0].requestBody;
    expect(sentBody.memberships.map((m) => m.contactGroupMembership.contactGroupResourceName))
      .toEqual(['contactGroups/vipCustomLabel', 'contactGroups/myContacts', 'contactGroups/starred']);
    // The People API 400s updates that omit the fetched source metadata.
    expect(sentBody.metadata).toEqual({ sources: [{ type: 'CONTACT', id: 'abc', etag: 'se1' }] });
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
    setupDb({ customers: [{ ...CUSTOMER }] });
    mockPeopleApi.people.searchContacts.mockImplementation(async ({ query }) => (query === '' ? { data: {} } : { data: { results: [{ person: { resourceName: 'people/lost', clientData: [{ key: 'waves_row', value: 'customers:c-1' }] } }] } }));
    mockPeopleApi.people.get.mockResolvedValueOnce({ data: { etag: 'e1', memberships: [] } });
    mockPeopleApi.people.updateContact.mockResolvedValueOnce({ data: { resourceName: 'people/lost' } });
    const counts = await runContactsSync({ gapMs: 0 });
    expect(counts.synced).toBe(1);
    expect(mockPeopleApi.people.createContact).not.toHaveBeenCalled();
  });

  test('a failed stamp after a FRESH create rolls the contact back — no leaked duplicate', async () => {
    setupDb({
      customers: [{ ...CUSTOMER }],
      updateResults: { customers: [new Error('db down')] },
    });
    mockPeopleApi.people.createContact.mockResolvedValueOnce({ data: { resourceName: 'people/fresh' } });
    const counts = await runContactsSync({ gapMs: 0 });
    expect(counts.failed).toBe(1);
    expect(mockPeopleApi.people.deleteContact).toHaveBeenCalledWith({ resourceName: 'people/fresh' });
  });

  test('an UNTAGGED exact-email search hit (operator-authored) is never adopted or touched', async () => {
    setupDb({ customers: [{ ...CUSTOMER }] });
    // Same email, but no waves_row tag — could be an operator's own contact;
    // adopting it would overwrite it and expose it to the delete paths.
    mockPeopleApi.people.searchContacts.mockImplementation(async ({ query }) => (query === '' ? { data: {} } : { data: { results: [{ person: { resourceName: 'people/operator', emailAddresses: [{ value: 'jane@customer.example' }] } }] } }));
    mockPeopleApi.people.createContact.mockResolvedValueOnce({ data: { resourceName: 'people/fresh' } });
    const counts = await runContactsSync({ gapMs: 0 });
    expect(counts.synced).toBe(1);
    expect(mockPeopleApi.people.updateContact).not.toHaveBeenCalled();
    expect(mockPeopleApi.people.deleteContact).not.toHaveBeenCalled();
    expect(mockPeopleApi.people.createContact).toHaveBeenCalled();
  });

  test('a raced-edit stamp veto (0 rows) compensates a fresh create — no silent success', async () => {
    setupDb({
      customers: [{ ...CUSTOMER }],
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
    // Watermark clears too — a restore (deleted_at flip only) finds the
    // row stale and re-mints the contact.
    expect(state.updates.find((u) => u.table === 'customers').patch).toEqual({ google_contact_id: null, google_contact_synced_at: null });
  });

  test('verification lane re-pushes long-unverified rows — external drift heals', async () => {
    const staleVerified = { ...CUSTOMER, updated_at: '2026-06-30T00:00:00Z', google_contact_id: 'people/drifted', google_contact_synced_at: '2026-07-01T00:00:00Z' };
    const verifyState = setupDb({
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
    // The watermark advances to the CHECK time — writing the old
    // updated_at back would pin the lane to the same oldest rows forever.
    const patch = verifyState.updates.find((u) => u.table === 'customers' && u.patch.google_contact_synced_at).patch;
    expect(patch.google_contact_synced_at).toEqual(new Date('2026-07-28T12:00:00Z'));
  });

  test('a thrown verification stamp compensates the fresh 404-replacement', async () => {
    const staleVerified = { ...CUSTOMER, updated_at: '2026-06-30T00:00:00Z', google_contact_id: 'people/drifted', google_contact_synced_at: '2026-07-01T00:00:00Z' };
    setupDb({
      customersSelects: [[], [], [staleVerified]],
      leadsSelects: [[], [], []],
      updateResults: { customers: [new Error('db down')] },
    });
    const err = new Error('not found');
    err.code = 404;
    mockPeopleApi.people.get.mockRejectedValueOnce(err);
    mockPeopleApi.people.createContact.mockResolvedValueOnce({ data: { resourceName: 'people/reborn' } });
    const counts = await runContactsSync({ gapMs: 0, now: new Date('2026-07-28T12:00:00Z') });
    expect(counts.verified).toBe(0);
    expect(counts.failed).toBe(1);
    // The replacement is rolled back — retries can't leak one per pass.
    expect(mockPeopleApi.people.deleteContact).toHaveBeenCalledWith({ resourceName: 'people/reborn' });
  });

  test('a multi-property account adopts ONE contact across its customer rows', async () => {
    setupDb({
      customers: [{ ...CUSTOMER, id: 'c-2', account_id: 'acct-1' }],
      firstResults: { customers: [{ id: 'c-1', google_contact_id: 'people/acct' }] },
    });
    mockPeopleApi.people.get.mockResolvedValueOnce({ data: { etag: 'e1', metadata: { sources: [] }, memberships: [] } });
    mockPeopleApi.people.updateContact.mockResolvedValueOnce({ data: { resourceName: 'people/acct' } });
    const counts = await runContactsSync({ gapMs: 0 });
    expect(counts.synced).toBe(1);
    expect(mockPeopleApi.people.createContact).not.toHaveBeenCalled();
    expect(mockPeopleApi.people.updateContact.mock.calls[0][0].resourceName).toBe('people/acct');
  });

  test('a lead whose identity DIVERGED from its shared contact releases it and mints its own', async () => {
    setupDb({
      leads: [{ id: 'l-2', first_name: 'Newname', email: 'different@new.example', phone: '9415550199', customer_id: null, google_contact_id: 'people/shared', updated_at: '2026-07-28T11:00:00Z' }],
      // ownership probe: no customer match, no sibling match; in-use check:
      // customers → null, leads → the OTHER lead still referencing it.
      firstResults: { customers: [null, null], leads: [null, { id: 'l-1' }] },
    });
    mockPeopleApi.people.createContact.mockResolvedValueOnce({ data: { resourceName: 'people/own' } });
    const counts = await runContactsSync({ gapMs: 0 });
    expect(counts.synced).toBe(1);
    // The sibling's contact was never updated with the new identity...
    expect(mockPeopleApi.people.updateContact).not.toHaveBeenCalled();
    // ...this lead minted its own instead.
    expect(mockPeopleApi.people.createContact).toHaveBeenCalled();
  });

  test('an inconclusive orphan search DEFERS creation instead of risking a duplicate', async () => {
    setupDb({ customers: [{ ...CUSTOMER }] });
    mockPeopleApi.people.searchContacts.mockImplementation(async ({ query }) => {
      if (query === '') return { data: {} };
      throw new Error('search down');
    });
    const counts = await runContactsSync({ gapMs: 0 });
    expect(counts.failed).toBe(1);
    expect(mockPeopleApi.people.createContact).not.toHaveBeenCalled();
  });

  test('an ambiguous createContact failure marks the row for conclusive-search recovery', async () => {
    const state = setupDb({ customers: [{ ...CUSTOMER }] });
    mockPeopleApi.people.createContact.mockRejectedValueOnce(new Error('socket hang up'));
    const counts = await runContactsSync({ gapMs: 0 });
    expect(counts.failed).toBe(1);
    const marker = state.updates.find((u) => u.table === 'customers');
    // Marker carries the create-time search identity for later recovery.
    expect(marker.patch.google_contact_id).toBe('pending_create_recovery::jane%40customer.example');
    expect(marker.patch.google_contact_synced_at).toBeInstanceOf(Date);
  });

  test('recovery inside the index-lag grace window defers even on a conclusively empty search', async () => {
    setupDb({ customers: [{ ...CUSTOMER, google_contact_id: 'pending_create_recovery', google_contact_synced_at: new Date() }] });
    const counts = await runContactsSync({ gapMs: 0 });
    expect(counts.failed).toBe(1);
    expect(mockPeopleApi.people.createContact).not.toHaveBeenCalled();
  });

  test('recovery past the grace window adopts the found orphan by tag', async () => {
    setupDb({ customers: [{ ...CUSTOMER, google_contact_id: 'pending_create_recovery', google_contact_synced_at: '2026-07-01T00:00:00Z' }] });
    mockPeopleApi.people.searchContacts.mockImplementation(async ({ query }) => (query === '' ? { data: {} } : { data: { results: [{ person: { resourceName: 'people/orphan', clientData: [{ key: 'waves_row', value: 'customers:c-1' }] } }] } }));
    mockPeopleApi.people.get.mockResolvedValueOnce({ data: { etag: 'e1', metadata: { sources: [] }, memberships: [] } });
    mockPeopleApi.people.updateContact.mockResolvedValueOnce({ data: { resourceName: 'people/orphan' } });
    const counts = await runContactsSync({ gapMs: 0 });
    expect(counts.synced).toBe(1);
    expect(mockPeopleApi.people.createContact).not.toHaveBeenCalled();
  });

  test('a customer inserted AFTER a synced same-email lead adopts the lead contact', async () => {
    setupDb({
      customers: [{ ...CUSTOMER }],
      firstResults: { leads: [{ id: 'l-1', google_contact_id: 'people/lead-first' }] },
    });
    mockPeopleApi.people.get.mockResolvedValueOnce({ data: { etag: 'e1', metadata: { sources: [] }, memberships: [] } });
    mockPeopleApi.people.updateContact.mockResolvedValueOnce({ data: { resourceName: 'people/lead-first' } });
    const counts = await runContactsSync({ gapMs: 0 });
    expect(counts.synced).toBe(1);
    // Insertion order didn't matter — no second contact minted.
    expect(mockPeopleApi.people.createContact).not.toHaveBeenCalled();
  });

  test('a 404-recreate repoints EVERY sharer of the dead resource', async () => {
    const state = setupDb({ customers: [{ ...CUSTOMER, google_contact_id: 'people/dead' }] });
    const err = new Error('not found');
    err.code = 404;
    mockPeopleApi.people.get.mockRejectedValueOnce(err);
    mockPeopleApi.people.createContact.mockResolvedValueOnce({ data: { resourceName: 'people/reborn' } });
    const counts = await runContactsSync({ gapMs: 0 });
    expect(counts.synced).toBe(1);
    // Both tables' sharers were repointed off the dead resource.
    const repoints = state.updates.filter((u) => u.patch.google_contact_id === 'people/reborn' && !u.patch.google_contact_synced_at);
    expect(repoints.map((u) => u.table).sort()).toEqual(['customers', 'leads']);
  });

  test('an ambiguous REPLACEMENT create marks the row even though it held a dead id', async () => {
    const state = setupDb({ customers: [{ ...CUSTOMER, google_contact_id: 'people/dead' }] });
    const gone = new Error('not found');
    gone.code = 404;
    mockPeopleApi.people.get.mockRejectedValueOnce(gone);
    mockPeopleApi.people.createContact.mockRejectedValueOnce(new Error('socket hang up'));
    const counts = await runContactsSync({ gapMs: 0 });
    expect(counts.failed).toBe(1);
    // The marker CARRIES the dead id (sharer repoint) and the create-time
    // search identity (merge-scramble-proof recovery).
    const marker = state.updates.find((u) => String(u.patch.google_contact_id || '').startsWith('pending_create_recovery:people/dead'));
    expect(marker).toBeDefined();
    expect(marker.patch.google_contact_id).toBe('pending_create_recovery:people/dead:jane%40customer.example');
  });

  test('a scope error from the pre-create SEARCH still reports contacts_scope_missing', async () => {
    setupDb({ customers: [{ ...CUSTOMER }] });
    const err = new Error('Request had insufficient authentication scopes.');
    err.code = 403;
    mockPeopleApi.people.searchContacts.mockImplementation(async ({ query }) => {
      if (query === '') return { data: {} };
      throw err;
    });
    const counts = await runContactsSync({ gapMs: 0 });
    expect(counts.blocked).toBe('contacts_scope_missing');
    expect(mockPeopleApi.people.createContact).not.toHaveBeenCalled();
  });

  test('a tombstoned pending-create resolves the orphan BEFORE clearing the marker', async () => {
    const state = setupDb({
      customersSelects: [[], [{ id: 'c-dead', google_contact_id: 'pending_create_recovery', google_contact_synced_at: '2026-07-01T00:00:00Z', first_name: 'Jane', last_name: 'X', email: 'jane@customer.example', phone: null }], []],
      leadsSelects: [[], [], []],
    });
    mockPeopleApi.people.searchContacts.mockImplementation(async ({ query }) => (query === '' ? { data: {} } : { data: { results: [{ person: { resourceName: 'people/orphan', clientData: [{ key: 'waves_row', value: 'customers:c-dead' }] } }] } }));
    const counts = await runContactsSync({ gapMs: 0 });
    expect(counts.retired).toBe(1);
    // The committed-but-unrecorded contact was found by tag and deleted —
    // no deleted-customer PII left serving from Google.
    expect(mockPeopleApi.people.deleteContact).toHaveBeenCalledWith({ resourceName: 'people/orphan' });
    expect(state.updates.find((u) => u.table === 'customers').patch).toEqual({ google_contact_id: null, google_contact_synced_at: null });
  });

  test('a deterministic Google rejection PARKS the row instead of pinning the batch', async () => {
    const state = setupDb({ customers: [{ ...CUSTOMER }] });
    const err = new Error('Invalid phoneNumbers');
    err.code = 400;
    mockPeopleApi.people.createContact.mockRejectedValueOnce(err);
    const counts = await runContactsSync({ gapMs: 0 });
    expect(counts.failed).toBe(1);
    const park = state.updates.find((u) => u.table === 'customers');
    // Watermark stamped current (row leaves the batch); no recovery marker
    // for a definitive rejection; a contact-field edit re-queues it.
    expect(park.patch.google_contact_synced_at).toBeInstanceOf(Date);
    expect(park.patch.google_contact_id).toBeUndefined();
  });

  test('a 429 rate limit is RETRYABLE — the row is neither parked nor marked', async () => {
    const state = setupDb({ customers: [{ ...CUSTOMER }] });
    const err = new Error('Rate limit exceeded');
    err.code = 429;
    mockPeopleApi.people.createContact.mockRejectedValueOnce(err);
    const counts = await runContactsSync({ gapMs: 0 });
    expect(counts.failed).toBe(1);
    // No park, no recovery marker — the row stays stale and retries after
    // the quota recovers.
    expect(state.updates).toEqual([]);
  });

  test('verification never lets a NON-OWNER lead overwrite the shared contact', async () => {
    const state = setupDb({
      customersSelects: [[], [], []],
      leadsSelects: [[], [], [{
        id: 'l-old', first_name: 'Old', email: 'old@x.example', phone: null, customer_id: 'c-1',
        google_contact_id: 'people/shared', updated_at: '2026-06-30T00:00:00Z', google_contact_synced_at: '2026-07-01T00:00:00Z',
      }]],
    });
    const counts = await runContactsSync({ gapMs: 0, now: new Date('2026-07-28T12:00:00Z') });
    // Watermark advanced, contact untouched — the OWNER's verification
    // maintains it.
    expect(counts.verified).toBe(1);
    expect(mockPeopleApi.people.get).not.toHaveBeenCalled();
    expect(mockPeopleApi.people.updateContact).not.toHaveBeenCalled();
    expect(state.updates.find((u) => u.table === 'leads').patch.google_contact_synced_at).toEqual(new Date('2026-07-28T12:00:00Z'));
  });

  test('retiring a shared contact requeues a surviving owner to scrub the dead row PII', async () => {
    const state = setupDb({
      customersSelects: [[], [{ id: 'c-dead', google_contact_id: 'people/shared', google_contact_synced_at: '2026-07-01T00:00:00Z', first_name: 'Gone', last_name: '', email: 'gone@x.example', phone: null }], []],
      leadsSelects: [[], [], []],
      // in-use probe: customers → null, leads → sharer; survivor probe:
      // customers → null, leads → sharer
      firstResults: { customers: [null, null], leads: [{ id: 'l-9' }, { id: 'l-9' }] },
    });
    const counts = await runContactsSync({ gapMs: 0 });
    expect(counts.retired).toBe(1);
    expect(mockPeopleApi.people.deleteContact).not.toHaveBeenCalled();
    // The survivor is requeued so its next main-lane pass re-pushes the
    // LIVE identity over the retired row's PII/tag.
    expect(state.updates.find((u) => u.table === 'leads').patch).toEqual({ google_contact_synced_at: null });
    expect(state.updates.find((u) => u.table === 'customers').patch).toEqual({ google_contact_id: null, google_contact_synced_at: null });
  });

  test('a name-only lead mints its OWN contact — never adopts via an empty identity predicate', async () => {
    setupDb({
      leads: [{ id: 'l-n', first_name: 'Walkup', last_name: 'Prospect', email: null, phone: '  ', customer_id: null, google_contact_id: null, updated_at: '2026-07-28T11:00:00Z' }],
      // A contact-holding lead exists — an unguarded empty predicate group
      // would have matched it and overwritten the unrelated person.
      firstResults: { leads: [{ id: 'l-other', google_contact_id: 'people/stranger' }] },
    });
    mockPeopleApi.people.createContact.mockResolvedValueOnce({ data: { resourceName: 'people/nameonly' } });
    const counts = await runContactsSync({ gapMs: 0 });
    expect(counts.synced).toBe(1);
    expect(mockPeopleApi.people.updateContact).not.toHaveBeenCalled();
    const body = mockPeopleApi.people.createContact.mock.calls[0][0].requestBody;
    expect(body.names[0].givenName).toBe('Walkup');
    expect(body.emailAddresses).toBeUndefined();
  });

  test('a failed warmup is INCONCLUSIVE — creation defers', async () => {
    setupDb({ customers: [{ ...CUSTOMER }] });
    mockPeopleApi.people.searchContacts.mockImplementation(async ({ query }) => {
      if (query === '') throw new Error('warmup down');
      return { data: { results: [] } };
    });
    const counts = await runContactsSync({ gapMs: 0 });
    expect(counts.failed).toBe(1);
    expect(mockPeopleApi.people.createContact).not.toHaveBeenCalled();
  });

  test('a restore racing the tombstone batch keeps its contact (claim conditioned on deleted_at)', async () => {
    const state = setupDb({
      customersSelects: [[], [{ id: 'c-back', google_contact_id: 'people/keep', google_contact_synced_at: '2026-07-01T00:00:00Z', first_name: 'B', last_name: '', email: 'b@x.example', phone: null, updated_at: '2026-07-01T00:00:00Z' }], []],
      leadsSelects: [[], [], []],
      // The conditional claim (whereNotNull deleted_at) matches nothing —
      // the row was restored after selection.
      updateResults: { customers: [0] },
    });
    const counts = await runContactsSync({ gapMs: 0 });
    expect(counts.retired).toBe(0);
    expect(mockPeopleApi.people.deleteContact).not.toHaveBeenCalled();
  });

  test('a failed verification rotates its watermark instead of pinning the slot', async () => {
    const staleVerified = { ...CUSTOMER, updated_at: '2026-06-30T00:00:00Z', google_contact_id: 'people/drifted', google_contact_synced_at: '2026-07-01T00:00:00Z' };
    const state = setupDb({
      customersSelects: [[], [], [staleVerified]],
      leadsSelects: [[], [], []],
    });
    const err = new Error('backend error');
    err.code = 500;
    mockPeopleApi.people.get.mockRejectedValueOnce(err);
    mockPeopleApi.people.createContact.mockRejectedValueOnce(err);
    const counts = await runContactsSync({ gapMs: 0, now: new Date('2026-07-28T12:00:00Z') });
    expect(counts.failed).toBe(1);
    // Watermark pushed to cutoff-minus-a-day: retries tomorrow, not every tick.
    const rotate = state.updates.find((u) => u.table === 'customers' && u.patch.google_contact_synced_at instanceof Date);
    expect(rotate.patch.google_contact_synced_at).toEqual(new Date('2026-07-22T12:00:00Z'));
  });

  test('a 409 etag conflict is retryable — the row is not parked', async () => {
    const state = setupDb({ customers: [{ ...CUSTOMER, google_contact_id: 'people/abc' }] });
    const err = new Error('precondition failed');
    err.code = 409;
    mockPeopleApi.people.get.mockRejectedValueOnce(err);
    const counts = await runContactsSync({ gapMs: 0 });
    expect(counts.failed).toBe(1);
    expect(state.updates).toEqual([]);
  });

  test('tombstone recovery searches by the MARKER identity, surviving merge-scrambled PII', async () => {
    const state = setupDb({
      customersSelects: [[], [{
        id: 'c-merged', google_contact_id: 'pending_create_recovery::original%40x.example',
        google_contact_synced_at: '2026-07-01T00:00:00Z',
        first_name: 'Merged', last_name: '', email: 'scrambled+dedupe@x.invalid', phone: null,
      }], []],
      leadsSelects: [[], [], []],
    });
    mockPeopleApi.people.searchContacts.mockImplementation(async ({ query }) => {
      if (query === 'original@x.example') {
        return { data: { results: [{ person: { resourceName: 'people/orphan', clientData: [{ key: 'waves_row', value: 'customers:c-merged' }] } }] } };
      }
      return { data: { results: [] } };
    });
    const counts = await runContactsSync({ gapMs: 0 });
    expect(counts.retired).toBe(1);
    // Found by the ORIGINAL identity, not the scrambled row values.
    expect(mockPeopleApi.people.deleteContact).toHaveBeenCalledWith({ resourceName: 'people/orphan' });
    expect(state.updates.find((u) => u.table === 'customers').patch).toEqual({ google_contact_id: null, google_contact_synced_at: null });
  });

  test('account siblings aggregate ALL live property addresses onto the shared contact', async () => {
    setupDb({
      customers: [{ ...CUSTOMER, id: 'c-2', account_id: 'acct-1', google_contact_id: 'people/acct' }],
      customersSelects: [[{ ...CUSTOMER, id: 'c-2', account_id: 'acct-1', google_contact_id: 'people/acct' }],
        [{ address_line1: '1 Palm Way', address_line2: null, city: 'Parrish', state: 'FL', zip: '34219' },
          { address_line1: '2 Oak St', address_line2: null, city: 'Venice', state: 'FL', zip: '34285' }], [], []],
      leadsSelects: [[], [], []],
    });
    mockPeopleApi.people.get.mockResolvedValueOnce({ data: { etag: 'e1', metadata: { sources: [] }, memberships: [] } });
    mockPeopleApi.people.updateContact.mockResolvedValueOnce({ data: { resourceName: 'people/acct' } });
    const counts = await runContactsSync({ gapMs: 0 });
    expect(counts.synced).toBe(1);
    const sent = mockPeopleApi.people.updateContact.mock.calls[0][0].requestBody.addresses;
    expect(sent.map((a) => a.streetAddress)).toEqual(['1 Palm Way', '2 Oak St']);
  });

  test('scope-missing aborts WITHOUT stamping — rows retry after the one-time re-consent', async () => {
    const state = setupDb({ customers: [{ ...CUSTOMER }] });
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
