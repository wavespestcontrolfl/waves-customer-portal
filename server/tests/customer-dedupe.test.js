/**
 * customer-dedupe — matcher normalization (pinned to real prod duplicate
 * pairs), tier assignment, and merge-executor guards.
 */
jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.transaction = jest.fn();
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => null) }));

const db = require('../models/db');
const dedupe = require('../services/customer-dedupe');
const {
  phone10, normalizeStreetKey, namesCompatible, addressCompat, pickWinner,
  mergeSingletonPrefRow, repointRowwiseDropCollisions, resetFkCache,
} = dedupe._test;

// Chainable knex stub: every builder method returns the chain; awaiting the
// chain resolves whatever the per-table router decides after inspecting the
// recorded calls.
function makeChain(table, route) {
  const q = { _table: table, _calls: [] };
  const methods = [
    'where', 'whereIn', 'whereRaw', 'whereNull', 'whereNotIn', 'select', 'groupBy',
    'orderBy', 'forUpdate', 'update', 'insert', 'del', 'count', 'onConflict',
    'ignore', 'returning', 'first',
  ];
  for (const m of methods) {
    q[m] = jest.fn((...args) => { q._calls.push([m, args]); return q; });
  }
  q.called = (m) => q._calls.some(([name]) => name === m);
  q.args = (m) => q._calls.find(([name]) => name === m)?.[1];
  q.then = (resolve, reject) => Promise.resolve().then(() => route(q)).then(resolve, reject);
  return q;
}

function installDb(router) {
  db.mockImplementation((table) => makeChain(table, (q) => router(table, q)));
}

beforeEach(() => {
  jest.clearAllMocks();
  resetFkCache();
});

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

describe('phone10', () => {
  it('normalizes formats to the last 10 digits', () => {
    expect(phone10('+19413840224')).toBe('9413840224');
    expect(phone10('(941) 384-0224')).toBe('9413840224');
    expect(phone10('941-384-0224')).toBe('9413840224');
  });
  it('rejects short and sentinel values', () => {
    expect(phone10('merged-7449e4f7')).toBe(null);
    expect(phone10('')).toBe(null);
    expect(phone10(null)).toBe(null);
  });
});

describe('normalizeStreetKey (pinned to real prod pairs)', () => {
  it('matches suffix/directional variants: 221 36th St NE ≡ 221 36th Street Northeast', () => {
    expect(normalizeStreetKey('221 36th St NE').key)
      .toBe(normalizeStreetKey('221 36th Street Northeast').key);
  });
  it('matches spacing variants: 5350 Desoto Rd ≡ 5350 De Soto Rd', () => {
    expect(normalizeStreetKey('5350 Desoto Rd').key)
      .toBe(normalizeStreetKey('5350 De Soto Rd').key);
  });
  it('captures the unit separately: 5350 De Soto Rd Apt 1418', () => {
    const parsed = normalizeStreetKey('5350 De Soto Rd Apt 1418');
    expect(parsed.key).toBe(normalizeStreetKey('5350 Desoto Rd').key);
    expect(parsed.unit).toBe('1418');
  });
  it('does not collapse different streets', () => {
    expect(normalizeStreetKey('18018 Littleton Pl').key)
      .not.toBe(normalizeStreetKey('8120 Sternway Rd').key);
  });
  it('keeps the street type: 100 Oak St ≠ 100 Oak Ave', () => {
    expect(normalizeStreetKey('100 Oak St').key)
      .not.toBe(normalizeStreetKey('100 Oak Ave').key);
  });
  it('keeps directionals: 100 1st St N ≠ 100 1st St S', () => {
    expect(normalizeStreetKey('100 1st St N').key)
      .not.toBe(normalizeStreetKey('100 1st St S').key);
    expect(normalizeStreetKey('100 1st St N').key)
      .toBe(normalizeStreetKey('100 1st Street North').key);
  });
  it('canonicalizes a suffix-word street name: Loop Rd ≡ Loop Road', () => {
    expect(normalizeStreetKey('123 Loop Rd').key).toBe('123 looprd');
    expect(normalizeStreetKey('123 Loop Road').key).toBe('123 looprd');
  });
  it('returns null when there is no leading street number', () => {
    expect(normalizeStreetKey('PO Box 12')).toBe(null);
    expect(normalizeStreetKey('')).toBe(null);
    expect(normalizeStreetKey(null)).toBe(null);
  });
});

describe('namesCompatible', () => {
  it('treats empty and "Unknown" as wildcards', () => {
    expect(namesCompatible(
      { first_name: 'Diana', last_name: 'Blowers' },
      { first_name: 'Unknown', last_name: '' },
    )).toBe(true);
    expect(namesCompatible(
      { first_name: 'Diana', last_name: 'Blowers' },
      { first_name: 'Diana', last_name: null },
    )).toBe(true);
  });
  it('flags typo-variants as conflicts (review queue, never auto)', () => {
    expect(namesCompatible(
      { first_name: 'Trent', last_name: 'Ryles' },
      { first_name: 'Trent', last_name: 'Ryals' },
    )).toBe(false);
  });
});

describe('addressCompat', () => {
  const base = { address_line1: '4414 Ozark Ave', zip: '34207' };
  it('match on same normalized street', () => {
    expect(addressCompat(base, { address_line1: '4414 Ozark Avenue', zip: '34207' }).status).toBe('match');
  });
  it('loser_missing when the duplicate is an address-less shell', () => {
    expect(addressCompat(base, { address_line1: null, zip: null }).status).toBe('loser_missing');
  });
  it('conflict on different streets', () => {
    expect(addressCompat(base, { address_line1: '901 31st Avenue West', zip: '34207' }).status).toBe('conflict');
  });
  it('unit_conflict on same building, different units', () => {
    expect(addressCompat(
      { address_line1: '5350 Desoto Rd Apt 2', zip: '34243' },
      { address_line1: '5350 De Soto Rd Apt 1418', zip: '34243' },
    ).status).toBe('unit_conflict');
  });
  it('unit_conflict when the units live in address_line2', () => {
    expect(addressCompat(
      { address_line1: '5350 Desoto Rd', address_line2: 'Apt 2', zip: '34243' },
      { address_line1: '5350 De Soto Rd', address_line2: '#1418', zip: '34243' },
    ).status).toBe('unit_conflict');
    // A bare token in line2 is a unit too
    expect(addressCompat(
      { address_line1: '5350 Desoto Rd', address_line2: '2', zip: '34243' },
      { address_line1: '5350 De Soto Rd', address_line2: '1418', zip: '34243' },
    ).status).toBe('unit_conflict');
    // One side without a unit is not a conflict
    expect(addressCompat(
      { address_line1: '5350 Desoto Rd', address_line2: null, zip: '34243' },
      { address_line1: '5350 De Soto Rd', address_line2: 'Apt 1418', zip: '34243' },
    ).status).toBe('match');
  });
  it('zip_conflict on same street key in different ZIPs', () => {
    expect(addressCompat(
      { address_line1: '100 Oak St', zip: '34205' },
      { address_line1: '100 Oak Street', zip: '34293' },
    ).status).toBe('zip_conflict');
  });
  it('city_conflict when ZIP cannot disambiguate the same street key', () => {
    expect(addressCompat(
      { address_line1: '100 Main St', city: 'Bradenton', zip: '' },
      { address_line1: '100 Main Street', city: 'Sarasota', zip: null },
    ).status).toBe('city_conflict');
  });
});

describe('pickWinner', () => {
  it('prefers Stripe, then portal login, then active stage, then oldest', () => {
    const shell = { id: 'a', created_at: '2026-07-01', pipeline_stage: 'new_lead' };
    const stripe = { id: 'b', created_at: '2026-07-05', pipeline_stage: 'new_lead', stripe_customer_id: 'cus_1' };
    const active = { id: 'c', created_at: '2026-07-03', pipeline_stage: 'active_customer' };
    expect(pickWinner([shell, stripe, active]).id).toBe('b');
    expect(pickWinner([shell, active]).id).toBe('c');
    expect(pickWinner([shell, { ...shell, id: 'd', created_at: '2026-06-01' }]).id).toBe('d');
  });
});

// ---------------------------------------------------------------------------
// Detection + tiering
// ---------------------------------------------------------------------------

describe('findDuplicateGroups', () => {
  const complete = {
    id: 'aaaaaaaa-0000-0000-0000-000000000001',
    first_name: 'Diana', last_name: 'Blowers', phone: '+16124074763',
    address_line1: '4414 Ozark Ave', zip: '34207',
    pipeline_stage: 'active_customer', created_at: '2026-07-08',
  };
  const shell = {
    id: 'aaaaaaaa-0000-0000-0000-000000000002',
    first_name: 'Diana', last_name: null, phone: '6124074763',
    address_line1: null, zip: null,
    pipeline_stage: 'new_lead', created_at: '2026-07-09',
  };
  const stranger = {
    id: 'aaaaaaaa-0000-0000-0000-000000000003',
    first_name: 'Nicole', last_name: 'Tommelleo', phone: '+16124074763',
    address_line1: '13712 Saw Palm Creek Trl', zip: '34211',
    pipeline_stage: 'active_customer', created_at: '2026-07-01',
  };

  function router({ customers = [], dismissals = [], blockerRows = {} }) {
    return (table, q) => {
      if (table === 'customers') return customers;
      if (table === 'customer_duplicate_dismissals') return dismissals;
      // blocker tables: grouped counts keyed by table name
      return blockerRows[table] || [];
    };
  }

  it('tiers an address-less same-name shell green', async () => {
    installDb(router({ customers: [complete, shell] }));
    const groups = await dedupe.findDuplicateGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].winner.id).toBe(complete.id);
    expect(groups[0].candidates).toHaveLength(1);
    expect(groups[0].candidates[0].tier).toBe('green');
  });

  it('never ships credential material to callers', async () => {
    installDb(router({ customers: [{ ...complete, password_hash: 'hash', stripe_customer_id: 'cus_1' }, shell] }));
    const groups = await dedupe.findDuplicateGroups();
    expect(groups[0].winner.password_hash).toBeUndefined();
    expect(groups[0].winner.stripe_customer_id).toBeUndefined();
    expect(groups[0].winner.has_portal_login).toBe(true);
    expect(groups[0].winner.has_stripe).toBe(true);
    expect(groups[0].candidates[0].loser.password_hash).toBeUndefined();
    expect(groups[0].candidates[0].loser.has_portal_login).toBe(false);
  });

  it('tiers a different-name different-address row red (winner has priority signals)', async () => {
    const winner = { ...complete, stripe_customer_id: 'cus_9' };
    installDb(router({ customers: [winner, stranger] }));
    const groups = await dedupe.findDuplicateGroups();
    expect(groups[0].candidates[0].tier).toBe('red');
  });

  it('downgrades green to yellow when the loser has billing history', async () => {
    installDb(router({
      customers: [complete, shell],
      blockerRows: { invoices: [{ customer_id: shell.id, n: '2' }] },
    }));
    const groups = await dedupe.findDuplicateGroups();
    expect(groups[0].candidates[0].tier).toBe('yellow');
    expect(groups[0].candidates[0].reasons).toContain('loser_has_invoices');
  });

  it('tiers red on a different last name with a unit conflict, not just a street conflict', async () => {
    const unitA = { ...complete, address_line1: '5350 Desoto Rd Apt 2', zip: '34243' };
    const unitB = {
      ...stranger,
      id: 'aaaaaaaa-0000-0000-0000-000000000004',
      address_line1: '5350 De Soto Rd Apt 1418',
      zip: '34243',
    };
    installDb(router({ customers: [unitA, unitB] }));
    const groups = await dedupe.findDuplicateGroups();
    expect(groups[0].candidates[0].tier).toBe('red');
  });

  it('demotes green shells to review when the group has an identity conflict', async () => {
    // Nicole (different name+address = red) proves the phone is shared by two
    // people — the address-less shell can no longer safely attach to Diana.
    // Stripe on Diana pins her as the picked winner.
    installDb(router({ customers: [{ ...complete, stripe_customer_id: 'cus_d' }, stranger, shell] }));
    const groups = await dedupe.findDuplicateGroups();
    const byId = Object.fromEntries(groups[0].candidates.map((c) => [c.loser.id, c]));
    expect(byId[stranger.id].tier).toBe('red');
    expect(byId[shell.id].tier).toBe('yellow');
    expect(byId[shell.id].reasons).toContain('group_has_identity_conflict');
  });

  it('excludes dismissed pairs', async () => {
    const [a, b] = [complete.id, shell.id].sort();
    installDb(router({
      customers: [complete, shell],
      dismissals: [{ customer_id_a: a, customer_id_b: b }],
    }));
    const groups = await dedupe.findDuplicateGroups();
    expect(groups).toHaveLength(0);
  });

  it('keeps shells demoted after the conflicting pair is dismissed', async () => {
    // Dismissing the red Diana↔Nicole pair hides it from the queue, but
    // Nicole still exists on the phone — the shell must NOT re-green.
    const winner = { ...complete, stripe_customer_id: 'cus_d' };
    const [a, b] = [winner.id, stranger.id].sort();
    installDb(router({
      customers: [winner, stranger, shell],
      dismissals: [{ customer_id_a: a, customer_id_b: b }],
    }));
    const groups = await dedupe.findDuplicateGroups();
    const shellCandidate = groups.flatMap((g) => g.candidates).find((c) => c.loser.id === shell.id);
    expect(shellCandidate.tier).toBe('yellow');
    expect(shellCandidate.reasons).toContain('group_has_identity_conflict');
    expect(groups.flatMap((g) => g.candidates).some((c) => c.loser.id === stranger.id)).toBe(false);
  });

  it('prefers a newer billed row over an older shell as the kept winner', async () => {
    const oldShell = {
      id: 'aaaaaaaa-0000-0000-0000-000000000021',
      first_name: 'Kim', last_name: 'Gilliam', phone: '+19995550001',
      address_line1: null, zip: null,
      pipeline_stage: 'new_lead', created_at: '2026-05-01',
    };
    const billed = {
      id: 'aaaaaaaa-0000-0000-0000-000000000022',
      first_name: 'Kim', last_name: 'Gilliam', phone: '9995550001',
      address_line1: '10 Pine St', zip: '34205',
      pipeline_stage: 'new_lead', created_at: '2026-06-20',
    };
    installDb(router({
      customers: [oldShell, billed],
      blockerRows: { invoices: [{ customer_id: billed.id, n: '3' }] },
    }));
    const groups = await dedupe.findDuplicateGroups();
    // Without the business boost, oldest-first tiebreak would keep the shell
    // and retire the row that owns the invoices' account state.
    expect(groups[0].winner.id).toBe(billed.id);
    expect(groups[0].candidates[0].loser.id).toBe(oldShell.id);
  });

  it('prefers a billed row over a Stripe-only shell as the kept winner', async () => {
    const stripeShell = {
      id: 'aaaaaaaa-0000-0000-0000-000000000041',
      first_name: 'Sam', last_name: 'Green', phone: '+19995550004',
      address_line1: null, zip: null, stripe_customer_id: 'cus_shell',
      pipeline_stage: 'new_lead', created_at: '2026-05-01',
    };
    const billed = {
      id: 'aaaaaaaa-0000-0000-0000-000000000042',
      first_name: 'Sam', last_name: 'Green', phone: '9995550004',
      address_line1: '3 Third St', zip: '34205',
      pipeline_stage: 'new_lead', created_at: '2026-06-20',
    };
    installDb(router({
      customers: [stripeShell, billed],
      blockerRows: {
        invoices: [{ customer_id: billed.id, n: '3' }],
        scheduled_services: [{ customer_id: billed.id, n: '2' }],
      },
    }));
    const groups = await dedupe.findDuplicateGroups();
    expect(groups[0].winner.id).toBe(billed.id);
  });

  it('re-picks the winner after unnamed rows join — an unnamed real account beats a named shell', async () => {
    const namedShell = {
      id: 'aaaaaaaa-0000-0000-0000-000000000051',
      first_name: 'Pat', last_name: 'Lee', phone: '+19995550005',
      address_line1: null, zip: null,
      pipeline_stage: 'new_lead', created_at: '2026-05-01',
    };
    const unnamedAccount = {
      id: 'aaaaaaaa-0000-0000-0000-000000000052',
      first_name: 'Unknown', last_name: '', phone: '9995550005',
      address_line1: '9 Ninth St', zip: '34205',
      pipeline_stage: 'active_customer', created_at: '2026-06-01',
    };
    installDb(router({
      customers: [namedShell, unnamedAccount],
      blockerRows: { invoices: [{ customer_id: unnamedAccount.id, n: '4' }] },
    }));
    const groups = await dedupe.findDuplicateGroups();
    // The account row is kept (name backfills on merge); the shell is the loser.
    expect(groups[0].winner.id).toBe(unnamedAccount.id);
    expect(groups[0].candidates[0].loser.id).toBe(namedShell.id);
  });

  it('never lets an unknown-name row seed a cluster and hide identity conflicts', async () => {
    const oldUnknown = {
      id: 'aaaaaaaa-0000-0000-0000-000000000031',
      first_name: 'Unknown', last_name: '', phone: '+19995550002',
      address_line1: null, zip: null,
      pipeline_stage: 'active_customer', created_at: '2026-04-01',
    };
    const john = {
      id: 'aaaaaaaa-0000-0000-0000-000000000032',
      first_name: 'John', last_name: 'Alpha', phone: '9995550002',
      address_line1: '1 First St', zip: '34205',
      pipeline_stage: 'new_lead', created_at: '2026-06-01',
    };
    const mary = {
      id: 'aaaaaaaa-0000-0000-0000-000000000033',
      first_name: 'Mary', last_name: 'Beta', phone: '(999) 555-0002',
      address_line1: '2 Second St', zip: '34205',
      pipeline_stage: 'new_lead', created_at: '2026-06-02',
    };
    installDb(router({ customers: [oldUnknown, john, mary] }));
    const groups = await dedupe.findDuplicateGroups();
    const candidates = groups.flatMap((g) => g.candidates);
    // Two known identities share the phone — NOTHING may tier green, and the
    // unknown shell must not have absorbed John and Mary into one cluster.
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.every((c) => c.tier !== 'green')).toBe(true);
  });

  it('surfaces second-identity duplicates as their own mergeable group', async () => {
    const john = {
      id: 'aaaaaaaa-0000-0000-0000-000000000011',
      first_name: 'John', last_name: 'Alpha', phone: '+16124074763',
      address_line1: '1 First St', zip: '34205',
      pipeline_stage: 'active_customer', created_at: '2026-06-01', stripe_customer_id: 'cus_j',
    };
    const mary = {
      id: 'aaaaaaaa-0000-0000-0000-000000000012',
      first_name: 'Mary', last_name: 'Beta', phone: '6124074763',
      address_line1: '2 Second St', zip: '34205',
      pipeline_stage: 'active_customer', created_at: '2026-06-05',
    };
    const maryDup = {
      id: 'aaaaaaaa-0000-0000-0000-000000000013',
      first_name: 'Mary', last_name: 'Beta', phone: '(612) 407-4763',
      address_line1: null, zip: null,
      pipeline_stage: 'new_lead', created_at: '2026-07-01',
    };
    installDb(router({ customers: [john, mary, maryDup] }));
    const groups = await dedupe.findDuplicateGroups();
    // Mary's own duplicate is mergeable under Mary, not stuck behind John.
    const maryGroup = groups.find((g) => g.winner.id === mary.id);
    expect(maryGroup).toBeTruthy();
    expect(maryGroup.candidates[0].loser.id).toBe(maryDup.id);
    expect(maryGroup.candidates[0].tier).toBe('yellow'); // demoted: shared-phone identities
    // The cross-identity conflict still surfaces once, under John's group.
    const johnGroup = groups.find((g) => g.winner.id === john.id);
    expect(johnGroup.candidates.some((c) => c.loser.id === mary.id)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Singleton preference-row merge semantics
// ---------------------------------------------------------------------------

describe('mergeSingletonPrefRow', () => {
  function stubTrx({ loserRow, winnerRow }) {
    const state = { updated: null, deleted: false };
    const trx = jest.fn((table) => makeChain(table, (q) => {
      if (q.called('del')) { state.deleted = true; return 1; }
      if (q.called('first')) return q.args('where')[1] === 'L' ? loserRow : winnerRow;
      if (q.called('update')) { state.updated = q.args('update')[0]; return 1; }
      return [];
    }));
    trx.fn = { now: () => 'NOW' };
    return { trx, state };
  }

  it('notification_prefs: consent ANDs, channels take the least-SMS value, empty fields fill', async () => {
    const { trx, state } = stubTrx({
      winnerRow: { id: 'p1', customer_id: 'W', sms_enabled: true, billing_channel: 'sms', quiet_hours_start: null, created_at: 'x', updated_at: 'x' },
      loserRow: { id: 'p2', customer_id: 'L', sms_enabled: false, billing_channel: 'email', quiet_hours_start: '22:00', created_at: 'x', updated_at: 'x' },
    });
    await mergeSingletonPrefRow(trx, 'notification_prefs', 'customer_id', 'W', 'L');
    expect(state.updated.sms_enabled).toBe(false);          // opted out survives
    expect(state.updated.billing_channel).toBe('email');    // never resume SMS
    expect(state.updated.quiet_hours_start).toBe('22:00');  // fill-if-empty
    expect(state.deleted).toBe(true);
  });

  it('notification_prefs: never widens — winner email-only keeps email over loser both', async () => {
    const { trx, state } = stubTrx({
      winnerRow: { id: 'p1', customer_id: 'W', billing_channel: 'email', created_at: 'x', updated_at: 'x' },
      loserRow: { id: 'p2', customer_id: 'L', billing_channel: 'both', created_at: 'x', updated_at: 'x' },
    });
    await mergeSingletonPrefRow(trx, 'notification_prefs', 'customer_id', 'W', 'L');
    expect(state.updated).toBe(null);
    expect(state.deleted).toBe(true);
  });

  it('repointRowwiseDropCollisions: keeps winner rows, drops colliding loser snapshots', async () => {
    const state = { updated: [], deleted: [] };
    const trx = jest.fn((table) => makeChain(table, (q) => {
      if (q.called('select')) return [{ id: 's1' }, { id: 's2' }];
      if (q.called('del')) { state.deleted.push(q.args('where')[0].id); return 1; }
      if (q.called('update')) {
        const rowId = q.args('where')[0].id;
        if (rowId === 's2') { const e = new Error('duplicate key'); e.code = '23505'; throw e; }
        state.updated.push(rowId);
        return 1;
      }
      return [];
    }));
    trx.transaction = jest.fn(async (fn) => fn(trx));
    const result = await repointRowwiseDropCollisions(trx, 'customer_mrr_snapshots', 'customer_id', 'W', 'L');
    expect(state.updated).toEqual(['s1']);
    expect(state.deleted).toEqual(['s2']);
    expect(result).toMatch(/moved 1, dropped 1/);
  });

  it('property_preferences: booleans are facts and OR — safety details survive', async () => {
    const { trx, state } = stubTrx({
      winnerRow: { id: 'p1', customer_id: 'W', irrigation_system: false, pet_details: null, created_at: 'x', updated_at: 'x' },
      loserRow: { id: 'p2', customer_id: 'L', irrigation_system: true, pet_details: 'Large dog — gate must stay closed', created_at: 'x', updated_at: 'x' },
    });
    await mergeSingletonPrefRow(trx, 'property_preferences', 'customer_id', 'W', 'L');
    expect(state.updated.irrigation_system).toBe(true);
    expect(state.updated.pet_details).toBe('Large dog — gate must stay closed');
    expect(state.deleted).toBe(true);
  });

  it('property_preferences: default sentinels (0, no_preference) count as empty', async () => {
    const { trx, state } = stubTrx({
      winnerRow: { id: 'p1', customer_id: 'W', pet_count: 0, preferred_day: 'no_preference', created_at: 'x', updated_at: 'x' },
      loserRow: { id: 'p2', customer_id: 'L', pet_count: 2, preferred_day: 'monday', created_at: 'x', updated_at: 'x' },
    });
    await mergeSingletonPrefRow(trx, 'property_preferences', 'customer_id', 'W', 'L');
    expect(state.updated.pet_count).toBe(2);
    expect(state.updated.preferred_day).toBe('monday');
    expect(state.deleted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Merge executor
// ---------------------------------------------------------------------------

describe('executeMerge', () => {
  const WINNER = 'bbbbbbbb-0000-0000-0000-000000000001';
  const LOSER = 'bbbbbbbb-0000-0000-0000-000000000002';

  function buildTrx({ winner, loser, fkRows, updates = {}, journalId = 'j1', prefsConflict = false }) {
    const state = { repointUpdates: [], retired: null, backfilled: null, journal: null, prefsDeleted: false, prefsMerged: null };
    const route = (table, q) => {
      if (table === 'customers') {
        if (q.called('forUpdate')) return [winner, loser].filter(Boolean);
        if (q.called('update')) {
          const payload = q.args('update')[0];
          const whereArg = q.args('where')?.[0];
          if (payload.referred_by_customer_id === null && whereArg?.referred_by_customer_id) return 0;
          if (payload.deleted_at) { state.retired = payload; return 1; }
          state.backfilled = payload;
          return 1;
        }
        return [];
      }
      if (table === 'customer_merge_journal') {
        state.journal = q.args('insert')[0];
        return [{ id: journalId }];
      }
      if (table === 'notification_prefs' && prefsConflict) {
        if (q.called('del')) { state.prefsDeleted = true; return 1; }
        if (q.called('first')) {
          const whereArgs = q.args('where');
          return whereArgs[1] === loser.id
            ? { id: 'p2', customer_id: loser.id, sms_enabled: false, email_enabled: true, created_at: 'x', updated_at: 'x' }
            : { id: 'p1', customer_id: winner.id, sms_enabled: true, email_enabled: true, created_at: 'x', updated_at: 'x' };
        }
        if (q.called('update')) {
          const payload = q.args('update')[0];
          if (payload.customer_id === winner.id && Object.keys(payload).length === 1) {
            const err = new Error('duplicate key value violates unique constraint');
            err.code = '23505';
            throw err;
          }
          state.prefsMerged = payload;
          return 1;
        }
      }
      if (q.called('del')) { state.prefsDeleted = true; return 1; }
      if (q.called('update')) {
        state.repointUpdates.push(table);
        return updates[table] ?? 1;
      }
      // blocker count checks (auto mode)
      return [];
    };
    const trx = jest.fn((table) => makeChain(table, (q) => route(table, q)));
    trx.raw = jest.fn(async () => ({ rows: fkRows }));
    trx.transaction = jest.fn(async (fn) => fn(trx));
    trx.fn = { now: () => 'NOW()' };
    return { trx, state };
  }

  const FK_ROWS = [
    { table_name: 'leads', column_name: 'customer_id' },
    { table_name: 'call_log', column_name: 'customer_id' },
    { table_name: 'notification_prefs', column_name: 'customer_id' },
  ];

  it('refuses when both rows have Stripe profiles', async () => {
    const { trx } = buildTrx({
      winner: { id: WINNER, stripe_customer_id: 'cus_a', phone: '+19995550003' },
      loser: { id: LOSER, stripe_customer_id: 'cus_b', phone: '9995550003' },
      fkRows: FK_ROWS,
    });
    db.transaction.mockImplementation(async (fn) => fn(trx));
    await expect(dedupe.executeMerge({ winnerId: WINNER, loserId: LOSER, performedBy: 'test' }))
      .rejects.toThrow(/Stripe profiles/);
  });

  it('refuses when the rows no longer share a phone (post-detection edit race)', async () => {
    const { trx } = buildTrx({
      winner: { id: WINNER, first_name: 'Diana', last_name: 'Blowers', phone: '+19995550003' },
      loser: { id: LOSER, first_name: 'Diana', last_name: null, phone: '+19995550099' },
      fkRows: FK_ROWS,
    });
    db.transaction.mockImplementation(async (fn) => fn(trx));
    await expect(dedupe.executeMerge({ winnerId: WINNER, loserId: LOSER, performedBy: 'test' }))
      .rejects.toThrow(/no longer share a phone/);
  });

  it('refuses auto mode when the loser is not a shell', async () => {
    const { trx } = buildTrx({
      winner: { id: WINNER, first_name: 'Diana', last_name: 'Blowers', phone: '+19995550003' },
      loser: { id: LOSER, first_name: 'Diana', last_name: 'Blowers', password_hash: 'x', phone: '9995550003' },
      fkRows: FK_ROWS,
    });
    db.transaction.mockImplementation(async (fn) => fn(trx));
    await expect(dedupe.executeMerge({ winnerId: WINNER, loserId: LOSER, performedBy: 'test', mode: 'auto' }))
      .rejects.toThrow(/not a shell/);
  });

  it('transfers a loser-only Stripe profile to the winner and clears it on the retired row', async () => {
    const winner = { id: WINNER, first_name: 'Diana', last_name: 'Blowers', email: 'd@x.com', stripe_customer_id: null, phone: '+19995550003' };
    const loser = { id: LOSER, first_name: 'Diana', last_name: null, email: null, stripe_customer_id: 'cus_only', phone: '9995550003' };
    const { trx, state } = buildTrx({ winner, loser, fkRows: [{ table_name: 'leads', column_name: 'customer_id' }] });
    db.transaction.mockImplementation(async (fn) => fn(trx));
    const result = await dedupe.executeMerge({ winnerId: WINNER, loserId: LOSER, performedBy: 'test' });
    expect(result.backfills.stripe_customer_id).toBe('cus_only');
    expect(state.retired.stripe_customer_id).toBe(null);
  });

  it('repoints FKs, merges the prefs collision most-restrictively, retires the loser, and journals', async () => {
    const winner = {
      id: WINNER, first_name: 'Diana', last_name: 'Blowers', email: null,
      address_line1: '4414 Ozark Ave', phone: '+16124074763',
    };
    const loser = {
      id: LOSER, first_name: 'Diana', last_name: null, email: 'diana@example.com',
      address_line1: null, phone: '6124074763',
    };
    const { trx, state } = buildTrx({ winner, loser, fkRows: FK_ROWS, prefsConflict: true });
    db.transaction.mockImplementation(async (fn) => fn(trx));

    const result = await dedupe.executeMerge({ winnerId: WINNER, loserId: LOSER, performedBy: 'test' });

    expect(state.repointUpdates).toEqual(expect.arrayContaining(['leads', 'call_log']));
    // Opted-out consent on the loser survives the merge: sms_enabled false
    // wins over the winner's true, and only then is the loser's row dropped.
    expect(state.prefsMerged.sms_enabled).toBe(false);
    expect(state.prefsMerged.email_enabled).toBeUndefined();
    expect(state.prefsDeleted).toBe(true);
    expect(result.repointed['notification_prefs.customer_id']).toMatch(/merged 1 fields/);
    // Loser retired with an unmatchable phone sentinel and cleared email
    expect(state.retired.phone).toBe(`merged-${LOSER.slice(0, 8)}`);
    expect(state.retired.email).toBe(null);
    expect(state.retired.deleted_at).toBeTruthy();
    // Winner backfilled only where empty
    expect(result.backfills).toEqual({ email: 'diana@example.com' });
    // Journal snapshot keeps the ORIGINAL loser contact identity
    expect(state.journal.loser_customer_id).toBe(LOSER);
    expect(JSON.parse(state.journal.loser_snapshot).phone).toBe('6124074763');
    expect(result.journalId).toBe('j1');
    expect(result.loserSnapshot.id).toBe(LOSER);
  });

  it('aborts the merge on an unexpected repoint failure (non-droppable table)', async () => {
    const winner = { id: WINNER, first_name: 'A', last_name: 'B', phone: '+19995550003' };
    const loser = { id: LOSER, first_name: 'A', last_name: 'B', phone: '9995550003' };
    const { trx } = buildTrx({ winner, loser, fkRows: [{ table_name: 'invoices', column_name: 'customer_id' }] });
    db.transaction.mockImplementation(async (fn) => fn(trx));
    trx.transaction = jest.fn(async () => { const e = new Error('boom'); e.code = '23505'; throw e; });
    await expect(dedupe.executeMerge({ winnerId: WINNER, loserId: LOSER, performedBy: 'test' }))
      .rejects.toThrow(/repoint failed on invoices/);
  });

  it('refuses identical or missing ids', async () => {
    await expect(dedupe.executeMerge({ winnerId: WINNER, loserId: WINNER })).rejects.toThrow(/distinct/);
  });
});
