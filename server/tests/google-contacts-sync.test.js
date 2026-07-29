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

const RAW_UPDATED_AT = { __raw: 'GREATEST(updated_at, now())' };

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
      const v = q && q.length ? q.shift() : [];
      if (v instanceof Error) return Promise.reject(v).then(resolve, reject);
      return Promise.resolve(v).then(resolve, reject);
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
      clientData: [{ key: 'other_integration', value: 'keep-me' }, { key: 'waves_row', value: 'customers:old' }],
      memberships: [{ contactGroupMembership: { contactGroupResourceName: 'contactGroups/vipCustomLabel' } }],
    } });
    mockPeopleApi.people.updateContact.mockResolvedValueOnce({ data: { resourceName: 'people/abc' } });
    await runContactsSync({ gapMs: 0 });
    const sentBody = mockPeopleApi.people.updateContact.mock.calls[0][0].requestBody;
    expect(sentBody.memberships.map((m) => m.contactGroupMembership.contactGroupResourceName))
      .toEqual(['contactGroups/vipCustomLabel', 'contactGroups/myContacts', 'contactGroups/starred']);
    // The People API 400s updates that omit the fetched source metadata.
    expect(sentBody.metadata).toEqual({ sources: [{ type: 'CONTACT', id: 'abc', etag: 'se1' }] });
    // Foreign clientData survives; only the waves_row key is replaced.
    expect(sentBody.clientData).toEqual([
      { key: 'other_integration', value: 'keep-me' },
      { key: 'waves_row', value: 'customers:c-1' },
    ]);
  });

  test('a converted lead TRANSFERS its contact and refreshes the in-run customer snapshot', async () => {
    const queuedCustomer = { ...CUSTOMER, email: 'jane2@customer.example' };
    const state = setupDb({
      customers: [queuedCustomer],
      leads: [{ id: 'l-1', first_name: 'Jane', email: 'jane2@customer.example', phone: null, customer_id: 'c-1', google_contact_id: 'people/lead1', updated_at: '2026-07-28T11:00:00Z' }],
      // live-customer link check
      firstResults: { customers: [{ id: 'c-1' }] },
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
      // live-link check, then the fresh re-read after the transfer miss
      firstResults: { customers: [{ id: 'c-1' }, { id: 'c-1', google_contact_id: 'people/cust' }] },
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
      // in-use probes (null, null) then the last-instant deleted_at revalidation
      firstResults: { customers: [null, { id: 'c-dead' }], leads: [null] },
    });
    const counts = await runContactsSync({ gapMs: 0 });
    expect(counts.retired).toBe(1);
    expect(mockPeopleApi.people.deleteContact).toHaveBeenCalledWith({ resourceName: 'people/loser' });
    // Durable retirement: pointer → RETIRE marker → external delete →
    // clear. A crash at any point leaves a recoverable record.
    const patches = state.updates.filter((u) => u.table === 'customers').map((u) => u.patch);
    expect(patches[0]).toEqual({ google_contact_id: 'pending_retire_recovery:people/loser', google_contact_synced_at: null });
    expect(patches[patches.length - 1]).toEqual({ google_contact_id: null });
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
      // ownership probes (customer email, sibling email, sibling phone) all
      // miss; in-use check: customers → null, leads → the OTHER lead still
      // referencing it.
      firstResults: { customers: [null, null], leads: [null, null, { id: 'l-1' }] },
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
      firstResults: { customers: [{ id: 'c-dead' }] },
    });
    mockPeopleApi.people.searchContacts.mockImplementation(async ({ query }) => (query === '' ? { data: {} } : { data: { results: [{ person: { resourceName: 'people/orphan', clientData: [{ key: 'waves_row', value: 'customers:c-dead' }] } }] } }));
    const counts = await runContactsSync({ gapMs: 0 });
    expect(counts.retired).toBe(1);
    // The committed-but-unrecorded contact was found by tag and deleted —
    // no deleted-customer PII left serving from Google. (The first update
    // is the restore-race claim's updated_at bump.)
    expect(mockPeopleApi.people.deleteContact).toHaveBeenCalledWith({ resourceName: 'people/orphan' });
    expect(state.updates.find((u) => u.table === 'customers' && 'google_contact_id' in u.patch).patch)
      .toEqual({ google_contact_id: null, google_contact_synced_at: null });
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
      // live-customer link check → defer (non-owner)
      firstResults: { customers: [{ id: 'c-1' }] },
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
      // last-instant deleted_at revalidation before the orphan delete
      firstResults: { customers: [{ id: 'c-merged' }] },
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
    expect(state.updates.find((u) => u.table === 'customers' && 'google_contact_id' in u.patch).patch)
      .toEqual({ google_contact_id: null, google_contact_synced_at: null });
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

  test('a DANGLING customer_id does not defer — the lead keeps normal ownership', async () => {
    setupDb({
      leads: [{ id: 'l-d', first_name: 'Dana', email: 'dana@x.example', phone: null, customer_id: 'c-gone', google_contact_id: null, updated_at: '2026-07-28T11:00:00Z' }],
      // live-link check → null (deleted/dangling); email customer probe →
      // null; email sibling probe → null
      firstResults: { customers: [null, null], leads: [null] },
    });
    mockPeopleApi.people.createContact.mockResolvedValueOnce({ data: { resourceName: 'people/dana' } });
    const counts = await runContactsSync({ gapMs: 0 });
    // Synced as its own contact instead of being stamped null into oblivion.
    expect(counts.synced).toBe(1);
    expect(mockPeopleApi.people.createContact).toHaveBeenCalled();
  });

  test('a shared PHONE with conflicting identity never merges two people', async () => {
    setupDb({
      leads: [{ id: 'l-2', first_name: 'Bob', last_name: 'Renter', email: 'bob@x.example', phone: '9415550100', customer_id: null, google_contact_id: null, updated_at: '2026-07-28T11:00:00Z' }],
      // customer probe null; email sibling null; phone sibling = DIFFERENT
      // person (household number, other email + name)
      firstResults: {
        customers: [null],
        leads: [null, { id: 'l-1', google_contact_id: 'people/alice', email: 'alice@x.example', first_name: 'Alice', last_name: 'Owner' }],
      },
    });
    mockPeopleApi.people.createContact.mockResolvedValueOnce({ data: { resourceName: 'people/bob' } });
    const counts = await runContactsSync({ gapMs: 0 });
    expect(counts.synced).toBe(1);
    // Alice's contact was never adopted or overwritten.
    expect(mockPeopleApi.people.updateContact).not.toHaveBeenCalled();
    expect(mockPeopleApi.people.createContact).toHaveBeenCalled();
  });

  test('a pending create on a CONVERTED lead is recovered and TRANSFERRED, never erased', async () => {
    const state = setupDb({
      leads: [{ id: 'l-p', first_name: 'Jane', email: 'jane@x.example', phone: null, customer_id: 'c-1', google_contact_id: 'pending_create_recovery::jane%40x.example', google_contact_synced_at: '2026-07-01T00:00:00Z', updated_at: '2026-07-28T11:00:00Z' }],
      firstResults: { customers: [{ id: 'c-1' }] },
    });
    mockPeopleApi.people.searchContacts.mockImplementation(async ({ query }) => (
      query === 'jane@x.example'
        ? { data: { results: [{ person: { resourceName: 'people/orphan', clientData: [{ key: 'waves_row', value: 'leads:l-p' }] } }] } }
        : { data: { results: [] } }
    ));
    const counts = await runContactsSync({ gapMs: 0 });
    expect(counts.skipped).toBe(1);
    // The recovered orphan TRANSFERRED to the customer instead of the
    // marker being stamped away over a live contact.
    expect(state.updates.find((u) => u.table === 'customers').patch).toEqual({ google_contact_id: 'people/orphan' });
    expect(state.updates.find((u) => u.table === 'leads').patch.google_contact_id).toBeNull();
  });

  test('a crashed retirement (retire marker) is completed by the next tombstone pass', async () => {
    const state = setupDb({
      customersSelects: [[], [{ id: 'c-dead', google_contact_id: 'pending_retire_recovery:people/ghost', google_contact_synced_at: null, first_name: 'G', last_name: '', email: null, phone: null }], []],
      leadsSelects: [[], [], []],
      firstResults: { customers: [{ id: 'c-dead' }] },
    });
    const counts = await runContactsSync({ gapMs: 0 });
    expect(counts.retired).toBe(1);
    expect(mockPeopleApi.people.deleteContact).toHaveBeenCalledWith({ resourceName: 'people/ghost' });
    const clear = state.updates.find((u) => u.table === 'customers' && 'google_contact_id' in u.patch);
    expect(clear.patch).toEqual({ google_contact_id: null, google_contact_synced_at: null });
  });

  test('recovered replacements repoint sharers from the MARKER dead id', async () => {
    const state = setupDb({
      customers: [{ ...CUSTOMER, google_contact_id: 'pending_create_recovery:people/dead:jane%40customer.example', google_contact_synced_at: '2026-07-01T00:00:00Z' }],
    });
    mockPeopleApi.people.searchContacts.mockImplementation(async ({ query }) => (
      query === 'jane@customer.example'
        ? { data: { results: [{ person: { resourceName: 'people/reborn', clientData: [{ key: 'waves_row', value: 'customers:c-1' }] } }] } }
        : { data: { results: [] } }
    ));
    mockPeopleApi.people.get.mockResolvedValueOnce({ data: { etag: 'e1', metadata: { sources: [] }, memberships: [] } });
    mockPeopleApi.people.updateContact.mockResolvedValueOnce({ data: { resourceName: 'people/reborn' } });
    const counts = await runContactsSync({ gapMs: 0 });
    expect(counts.synced).toBe(1);
    // Sharers of the DEAD id (kept by the marker) converge on the recovery.
    const repoints = state.updates.filter((u) => u.patch.google_contact_id === 'people/reborn' && !u.patch.google_contact_synced_at);
    expect(repoints.map((u) => u.table).sort()).toEqual(['customers', 'leads']);
  });

  test('account contacts publish the CANONICAL account identity, not the property row copy', async () => {
    setupDb({
      customers: [{ ...CUSTOMER, id: 'c-2', account_id: 'acct-1', google_contact_id: 'people/acct', first_name: 'StaleCopy' }],
      firstResults: { customer_accounts: [{ id: 'acct-1', first_name: 'Canonical', last_name: 'Person', email: 'canon@x.example', phone: '9415550100' }] },
    });
    mockPeopleApi.people.get.mockResolvedValueOnce({ data: { etag: 'e1', metadata: { sources: [] }, memberships: [] } });
    mockPeopleApi.people.updateContact.mockResolvedValueOnce({ data: { resourceName: 'people/acct' } });
    await runContactsSync({ gapMs: 0 });
    const body = mockPeopleApi.people.updateContact.mock.calls[0][0].requestBody;
    expect(body.names[0].givenName).toBe('Canonical');
    expect(body.emailAddresses).toEqual([{ value: 'canon@x.example' }]);
  });

  test('batched sharers of a dead resource create ONE replacement, not one each', async () => {
    const dead1 = { ...CUSTOMER, id: 'c-a', google_contact_id: 'people/dead', updated_at: '2026-06-30T00:00:00Z', google_contact_synced_at: '2026-07-01T00:00:00Z' };
    const dead2 = { ...CUSTOMER, id: 'c-b', email: 'jane2@customer.example', google_contact_id: 'people/dead', updated_at: '2026-06-30T00:00:00Z', google_contact_synced_at: '2026-07-01T00:00:00Z' };
    setupDb({
      customersSelects: [[], [], [dead1, dead2]],
      leadsSelects: [[], [], []],
    });
    const gone = new Error('not found');
    gone.code = 404;
    // Row 1: get 404 → create replacement. Row 2: repointed in-memory →
    // get succeeds on the replacement.
    mockPeopleApi.people.get
      .mockRejectedValueOnce(gone)
      .mockResolvedValueOnce({ data: { etag: 'e1', metadata: { sources: [] }, memberships: [] } });
    mockPeopleApi.people.createContact.mockResolvedValueOnce({ data: { resourceName: 'people/reborn' } });
    mockPeopleApi.people.updateContact.mockResolvedValueOnce({ data: { resourceName: 'people/reborn' } });
    const counts = await runContactsSync({ gapMs: 0, now: new Date('2026-07-28T12:00:00Z') });
    expect(counts.verified).toBe(2);
    expect(mockPeopleApi.people.createContact).toHaveBeenCalledTimes(1);
    expect(mockPeopleApi.people.get.mock.calls[1][0].resourceName).toBe('people/reborn');
  });

  test('a 400 FAILED_PRECONDITION (stale etag) is retryable, not parked', async () => {
    const state = setupDb({ customers: [{ ...CUSTOMER, google_contact_id: 'people/abc' }] });
    const err = new Error('precondition check failed');
    err.code = 400;
    err.response = { data: { error: { status: 'FAILED_PRECONDITION', message: 'etag mismatch' } } };
    mockPeopleApi.people.get.mockResolvedValueOnce({ data: { etag: 'stale', metadata: { sources: [] }, memberships: [] } });
    mockPeopleApi.people.updateContact.mockRejectedValueOnce(err);
    const counts = await runContactsSync({ gapMs: 0 });
    expect(counts.failed).toBe(1);
    expect(state.updates).toEqual([]);
  });

  test('a REPEATED ambiguous recovery create refreshes the marker (prior id preserved)', async () => {
    const state = setupDb({
      customers: [{ ...CUSTOMER, google_contact_id: 'pending_create_recovery:people/dead:jane%40customer.example', google_contact_synced_at: '2026-07-01T00:00:00Z' }],
    });
    // Past-grace conclusive-empty search → create attempts → ambiguous again.
    mockPeopleApi.people.createContact.mockRejectedValueOnce(new Error('socket hang up'));
    const counts = await runContactsSync({ gapMs: 0 });
    expect(counts.failed).toBe(1);
    const marker = state.updates.find((u) => String(u.patch.google_contact_id || '').startsWith('pending_create_recovery'));
    // Attempt timestamp refreshed (grace restarts) AND the dead id survives.
    expect(marker.patch.google_contact_id).toBe('pending_create_recovery:people/dead:jane%40customer.example');
    expect(marker.patch.google_contact_synced_at).toBeInstanceOf(Date);
  });

  test('a 404 adopts a PRIOR replacement by tag instead of minting another', async () => {
    setupDb({ customers: [{ ...CUSTOMER, google_contact_id: 'people/dead', google_contact_synced_at: '2026-07-01T00:00:00Z' }] });
    const gone = new Error('not found');
    gone.code = 404;
    mockPeopleApi.people.get
      .mockRejectedValueOnce(gone)
      .mockResolvedValueOnce({ data: { etag: 'e1', metadata: { sources: [] }, memberships: [] } });
    mockPeopleApi.people.searchContacts.mockImplementation(async ({ query }) => (
      query === '' ? { data: {} } : { data: { results: [{ person: { resourceName: 'people/prior-replacement', clientData: [{ key: 'waves_row', value: 'customers:c-1' }] } }] } }
    ));
    mockPeopleApi.people.updateContact.mockResolvedValueOnce({ data: { resourceName: 'people/prior-replacement' } });
    const counts = await runContactsSync({ gapMs: 0 });
    expect(counts.synced).toBe(1);
    expect(mockPeopleApi.people.createContact).not.toHaveBeenCalled();
  });

  test('a failed sharer repoint falls back to a durable requeue of the stranded rows', async () => {
    const state = setupDb({
      customers: [{ ...CUSTOMER, google_contact_id: 'people/dead', google_contact_synced_at: '2026-07-01T00:00:00Z' }],
      // stamp OK, customers repoint fails, fallback requeue succeeds
      updateResults: { customers: [1, new Error('db blip'), 1] },
    });
    const gone = new Error('not found');
    gone.code = 404;
    mockPeopleApi.people.get.mockRejectedValueOnce(gone);
    mockPeopleApi.people.createContact.mockResolvedValueOnce({ data: { resourceName: 'people/reborn' } });
    const counts = await runContactsSync({ gapMs: 0 });
    expect(counts.synced).toBe(1);
    // The stranded sharers were requeued (synced_at cleared) so adoption
    // re-resolves them to the replacement.
    const requeue = state.updates.filter((u) => u.table === 'customers').map((u) => u.patch);
    expect(requeue).toContainEqual({ google_contact_id: null, google_contact_synced_at: null });
  });

  test('a converted lead never gives a multi-property ACCOUNT a second contact', async () => {
    const state = setupDb({
      leads: [{ id: 'l-1', first_name: 'Jane', email: 'jane@x.example', phone: null, customer_id: 'c-1', google_contact_id: 'people/lead1', updated_at: '2026-07-28T11:00:00Z' }],
      firstResults: {
        // live-link → fresh read (row null but has account) → account
        // sibling holds the contact → in-use probe for the lead's dup
        customers: [{ id: 'c-1' }, { id: 'c-1', account_id: 'acct-1', google_contact_id: null }, { id: 'c-9', google_contact_id: 'people/acct' }, null],
        leads: [null],
      },
    });
    const counts = await runContactsSync({ gapMs: 0 });
    expect(counts.skipped).toBe(1);
    // The customer adopted the ACCOUNT's contact...
    expect(state.updates.find((u) => u.table === 'customers').patch).toEqual({ google_contact_id: 'people/acct' });
    // ...and the lead's duplicate was retired, not transferred.
    expect(mockPeopleApi.people.deleteContact).toHaveBeenCalledWith({ resourceName: 'people/lead1' });
  });

  test('a failed tombstone QUERY marks the run failed — job health cannot stay green', async () => {
    setupDb({
      customersSelects: [[], new Error('db down'), []],
      leadsSelects: [[], [], []],
    });
    const counts = await runContactsSync({ gapMs: 0 });
    expect(counts.failed).toBeGreaterThanOrEqual(1);
  });

  test('a failed survivor requeue keeps the tombstone pointer for retry', async () => {
    const state = setupDb({
      customersSelects: [[], [{ id: 'c-dead', google_contact_id: 'people/shared', google_contact_synced_at: '2026-07-01T00:00:00Z', first_name: 'Gone', last_name: '', email: 'gone@x.example', phone: null }], []],
      leadsSelects: [[], [], []],
      firstResults: { customers: [null, null], leads: [{ id: 'l-9' }, { id: 'l-9' }] },
      updateResults: { leads: [new Error('db blip')] },
    });
    const counts = await runContactsSync({ gapMs: 0 });
    expect(counts.retired).toBe(0);
    expect(counts.failed).toBe(1);
    // Pointer intact — no customers patch released it; the rotation bump
    // retries this tombstone later.
    expect(state.updates.find((u) => u.table === 'customers' && u.patch.google_contact_id === null)).toBeUndefined();
    expect(state.updates.find((u) => u.table === 'customers' && u.patch.updated_at instanceof Date)).toBeDefined();
  });

  test('a canonical NULL (cleared account email) is authoritative — no sibling republish', async () => {
    setupDb({
      customers: [{ ...CUSTOMER, id: 'c-2', account_id: 'acct-1', google_contact_id: 'people/acct' }],
      firstResults: { customer_accounts: [{ id: 'acct-1', first_name: 'Canonical', last_name: 'Person', email: null, phone: '9415550100', updated_at: '2026-07-28T11:00:00Z' }] },
    });
    mockPeopleApi.people.get.mockResolvedValueOnce({ data: { etag: 'e1', metadata: { sources: [] }, memberships: [] } });
    mockPeopleApi.people.updateContact.mockResolvedValueOnce({ data: { resourceName: 'people/acct' } });
    await runContactsSync({ gapMs: 0 });
    const body = mockPeopleApi.people.updateContact.mock.calls[0][0].requestBody;
    // The property row's stale email does NOT resurrect the cleared value.
    expect(body.emailAddresses || []).toEqual([]);
    expect(body.phoneNumbers).toEqual([{ value: '9415550100' }]);
  });

  test('revoked Google credentials BLOCK the run — no rows parked, job health sees it', async () => {
    const state = setupDb({ customers: [{ ...CUSTOMER, google_contact_id: 'people/abc' }] });
    const err = new Error('invalid_grant');
    err.code = 400;
    err.response = { data: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } };
    mockPeopleApi.people.get.mockRejectedValueOnce(err);
    const counts = await runContactsSync({ gapMs: 0 });
    expect(counts.blocked).toBe('google_auth_failed');
    expect(state.updates).toEqual([]);
  });

  test('a failed VERIFICATION query marks the run failed', async () => {
    setupDb({
      customersSelects: [[], [], new Error('db down')],
      leadsSelects: [[], [], []],
    });
    const counts = await runContactsSync({ gapMs: 0 });
    expect(counts.failed).toBeGreaterThanOrEqual(1);
  });

  test('a 404-recreate DEFERS while a sharer marker carries the same dead id', async () => {
    setupDb({
      customers: [{ ...CUSTOMER, google_contact_id: 'people/dead', google_contact_synced_at: '2026-07-01T00:00:00Z' }],
      // marker-carrier probe finds a sibling row mid-recovery
      firstResults: { customers: [{ id: 'c-9', google_contact_id: 'pending_create_recovery:people/dead:x' }] },
    });
    const gone = new Error('not found');
    gone.code = 404;
    mockPeopleApi.people.get.mockRejectedValueOnce(gone);
    const counts = await runContactsSync({ gapMs: 0 });
    expect(counts.failed).toBe(1);
    // No parallel replacement raced the in-flight recovery.
    expect(mockPeopleApi.people.createContact).not.toHaveBeenCalled();
  });

  test('an auth failure inside the SEARCH still blocks the run', async () => {
    setupDb({ customers: [{ ...CUSTOMER }] });
    const err = new Error('invalid_grant');
    err.code = 400;
    err.response = { data: { error: 'invalid_grant' } };
    mockPeopleApi.people.searchContacts.mockRejectedValue(err);
    const counts = await runContactsSync({ gapMs: 0 });
    expect(counts.blocked).toBe('google_auth_failed');
    expect(mockPeopleApi.people.createContact).not.toHaveBeenCalled();
  });

  test('a recovered orphan DEFERS to an established sibling contact', async () => {
    setupDb({
      leads: [{ id: 'l-p', first_name: 'Sam', email: 'sam@new.example', phone: null, customer_id: null, google_contact_id: 'pending_create_recovery::sam%40new.example', google_contact_synced_at: '2026-07-01T00:00:00Z', updated_at: '2026-07-28T11:00:00Z' }],
      // ownership: no customer match; sibling EMAIL match owns the
      // established contact; in-use probe for the orphan: none share it
      firstResults: { customers: [null, null], leads: [{ id: 'l-1', google_contact_id: 'people/established' }, null] },
    });
    mockPeopleApi.people.searchContacts.mockImplementation(async ({ query }) => (
      query === 'sam@new.example'
        ? { data: { results: [{ person: { resourceName: 'people/orphan', clientData: [{ key: 'waves_row', value: 'leads:l-p' }] } }] } }
        : { data: { results: [] } }
    ));
    mockPeopleApi.people.get.mockResolvedValueOnce({ data: { etag: 'e1', metadata: { sources: [] }, memberships: [] } });
    mockPeopleApi.people.updateContact.mockResolvedValueOnce({ data: { resourceName: 'people/established' } });
    const counts = await runContactsSync({ gapMs: 0 });
    expect(counts.synced).toBe(1);
    // The orphan lost the race — deleted, and the sibling's contact wins.
    expect(mockPeopleApi.people.deleteContact).toHaveBeenCalledWith({ resourceName: 'people/orphan' });
    expect(mockPeopleApi.people.updateContact.mock.calls[0][0].resourceName).toBe('people/established');
    expect(mockPeopleApi.people.createContact).not.toHaveBeenCalled();
  });

  test('a FULL (truncated) search defers RECOVERY but not first-time creation', async () => {
    // First-time create: no lost contact to find — truncation must not pin
    // the lane; creation proceeds.
    setupDb({ customers: [{ ...CUSTOMER }] });
    const fullSet = { data: { results: Array.from({ length: 30 }, (_, i) => ({ person: { resourceName: `people/x${i}` } })) } };
    mockPeopleApi.people.searchContacts.mockImplementation(async ({ query }) => (query === '' ? { data: {} } : fullSet));
    mockPeopleApi.people.createContact.mockResolvedValueOnce({ data: { resourceName: 'people/new' } });
    const counts = await runContactsSync({ gapMs: 0 });
    expect(counts.synced).toBe(1);
    expect(mockPeopleApi.people.createContact).toHaveBeenCalledTimes(1);

    // Recovery (pending marker): truncation IS inconclusive — defers.
    jest.clearAllMocks();
    require('googleapis').google.people.mockImplementation(() => mockPeopleApi);
    require('../services/email/gmail-client').getAuthClient.mockImplementation(async () => ({}));
    mockPeopleApi.people.deleteContact.mockImplementation(async () => ({}));
    process.env.GATE_CONTACTS_SYNC = 'true';
    setupDb({ customers: [{ ...CUSTOMER, google_contact_id: 'pending_create_recovery::jane%40customer.example', google_contact_synced_at: '2026-07-01T00:00:00Z' }] });
    mockPeopleApi.people.searchContacts.mockImplementation(async ({ query }) => (query === '' ? { data: {} } : fullSet));
    const counts2 = await runContactsSync({ gapMs: 0 });
    expect(counts2.failed).toBe(1);
    expect(mockPeopleApi.people.createContact).not.toHaveBeenCalled();
  });

  test('updates PRESERVE operator-added secondary emails/phones/addresses', async () => {
    setupDb({ customers: [{ ...CUSTOMER, google_contact_id: 'people/abc' }] });
    mockPeopleApi.people.get.mockResolvedValueOnce({ data: {
      etag: 'e1',
      metadata: { sources: [] },
      memberships: [],
      emailAddresses: [{ value: 'jane@customer.example' }, { value: 'work@customer.example' }],
      phoneNumbers: [{ value: '(941) 555-0100' }, { value: '941-555-0199' }],
      addresses: [{ streetAddress: '1 Palm Way', postalCode: '34219' }, { streetAddress: '99 Cabin Rd', postalCode: '34285' }],
    } });
    mockPeopleApi.people.updateContact.mockResolvedValueOnce({ data: { resourceName: 'people/abc' } });
    await runContactsSync({ gapMs: 0 });
    const body = mockPeopleApi.people.updateContact.mock.calls[0][0].requestBody;
    // Ours lead; operator-added extras survive; identical values dedupe.
    expect(body.emailAddresses.map((e) => e.value)).toEqual(['jane@customer.example', 'work@customer.example']);
    expect(body.phoneNumbers.map((e) => e.value)).toEqual(['9415550100', '941-555-0199']);
    expect(body.addresses.some((a) => a.streetAddress === '99 Cabin Rd')).toBe(true);
  });

  test('a disabled People API BLOCKS the run — no rows parked', async () => {
    const state = setupDb({ customers: [{ ...CUSTOMER }] });
    const err = new Error('People API has not been used in project 12345 before or it is disabled.');
    err.code = 403;
    err.response = { data: { error: { status: 'PERMISSION_DENIED', message: err.message, details: [{ reason: 'SERVICE_DISABLED' }] } } };
    mockPeopleApi.people.createContact.mockRejectedValueOnce(err);
    const counts = await runContactsSync({ gapMs: 0 });
    expect(counts.blocked).toBe('people_api_disabled');
    expect(state.updates).toEqual([]);
  });

  test('contact info restored mid-batch keeps its Google contact (last-instant revalidation)', async () => {
    const state = setupDb({
      customers: [{ ...CUSTOMER, email: null, phone: '  ', google_contact_id: 'people/keep' }],
      // in-use probes null; revalidation finds the RESTORED phone
      firstResults: { customers: [null, { email: null, phone: '9415550100', first_name: 'J', last_name: 'C' }], leads: [null] },
    });
    const counts = await runContactsSync({ gapMs: 0 });
    expect(mockPeopleApi.people.deleteContact).not.toHaveBeenCalled();
    // No stamp either — the row's own edit re-queues it with data intact.
    expect(state.updates).toEqual([]);
    expect(counts.skipped).toBe(0);
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
