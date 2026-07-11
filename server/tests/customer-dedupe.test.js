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
  mergeSingletonPrefRow, repointRowwiseDropCollisions, mergeConversationRows, resetFkCache,
} = dedupe._test;

// Chainable knex stub: every builder method returns the chain; awaiting the
// chain resolves whatever the per-table router decides after inspecting the
// recorded calls.
function makeChain(table, route) {
  const q = { _table: table, _calls: [] };
  const methods = [
    'where', 'whereIn', 'whereRaw', 'whereNull', 'whereNotNull', 'whereNotIn', 'whereNot', 'select', 'groupBy',
    'orderBy', 'forUpdate', 'update', 'insert', 'del', 'count', 'onConflict',
    'ignore', 'returning', 'first', 'increment',
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
  it('routes non-empty unparsable addresses to review, never to "missing"', () => {
    // PO Box vs street: incomparable, not a match and not a positive conflict
    expect(addressCompat({ address_line1: 'PO Box 742' }, base).status).toBe('unparsable');
    // Identical raw strings (case/space variants) still match
    expect(addressCompat({ address_line1: 'PO Box 742' }, { address_line1: 'po  box 742' }).status).toBe('match');
    // Truly blank sides keep the missing statuses — blank is not unparsable
    expect(addressCompat({ address_line1: 'PO Box 742' }, { address_line1: null }).status).toBe('loser_missing');
    expect(addressCompat({ address_line1: '' }, { address_line1: 'Lot 12 Palm Grove' }).status).toBe('winner_missing');
  });
  it('loser_missing when the duplicate is an address-less shell', () => {
    expect(addressCompat(base, { address_line1: null, zip: null }).status).toBe('loser_missing');
  });
  it('conflict on different streets', () => {
    expect(addressCompat(base, { address_line1: '901 31st Avenue West', zip: '34207' }).status).toBe('conflict');
  });
  it('hyphenated unit suffixes are identity-bearing: Apt 12-B ≠ Apt 12-C, ≡ Apt 12B', () => {
    expect(addressCompat(
      { address_line1: '5350 Desoto Rd Apt 12-B', zip: '34243' },
      { address_line1: '5350 De Soto Rd Apt 12-C', zip: '34243' },
    ).status).toBe('unit_conflict');
    expect(addressCompat(
      { address_line1: '5350 Desoto Rd Apt 12-B', zip: '34243' },
      { address_line1: '5350 De Soto Rd Apt 12B', zip: '34243' },
    ).status).toBe('match');
    // line2 variants get the same treatment
    expect(addressCompat(
      { address_line1: '5350 Desoto Rd', address_line2: '12-B', zip: '34243' },
      { address_line1: '5350 De Soto Rd', address_line2: '12-C', zip: '34243' },
    ).status).toBe('unit_conflict');
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

  it('demotes a same-name pair with an unparsable address to yellow — never auto-merged', async () => {
    const poBox = { ...shell, address_line1: 'PO Box 742' };
    installDb(router({ customers: [complete, poBox] }));
    const groups = await dedupe.findDuplicateGroups();
    expect(groups[0].candidates[0].tier).toBe('yellow');
    expect(groups[0].candidates[0].reasons).toContain('address_unparsable');
  });

  it('blocks a discount-carrying shell from green — assigned discounts are billing state', async () => {
    installDb(router({
      customers: [complete, shell],
      blockerRows: { customer_discounts: [{ customer_id: shell.id, n: 1 }] },
    }));
    const groups = await dedupe.findDuplicateGroups();
    expect(groups[0].candidates[0].tier).toBe('yellow');
    expect(groups[0].candidates[0].reasons).toContain('loser_has_customer_discounts');
  });

  it('blocks a won-stage shell from green — live stages carry account state the merge does not copy', async () => {
    const wonShell = { ...shell, pipeline_stage: 'won' };
    installDb(router({ customers: [complete, wonShell] }));
    const groups = await dedupe.findDuplicateGroups();
    expect(groups[0].winner.id).toBe(complete.id);
    expect(groups[0].candidates[0].tier).toBe('yellow');
    expect(groups[0].candidates[0].reasons).toContain('loser_has_live_stage');
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

  it('property_preferences: empty jsonb defaults ([]/{}) count as empty; real details copy stringified', async () => {
    const { trx, state } = stubTrx({
      winnerRow: { id: 'p1', customer_id: 'W', special_features: [], pets_structured: {}, watering_days: null, created_at: 'x', updated_at: 'x' },
      loserRow: { id: 'p2', customer_id: 'L', special_features: ['gate code 4482'], pets_structured: { dogs: 1 }, watering_days: [], created_at: 'x', updated_at: 'x' },
    });
    await mergeSingletonPrefRow(trx, 'property_preferences', 'customer_id', 'W', 'L');
    // Loser's real access/pet details survive onto the winner, stringified so
    // the pg driver sends jsonb (not a Postgres ARRAY literal).
    expect(state.updated.special_features).toBe(JSON.stringify(['gate code 4482']));
    expect(state.updated.pets_structured).toBe(JSON.stringify({ dogs: 1 }));
    // The loser's own empty [] is defaultish too — never copied over null.
    expect(state.updated.watering_days).toBeUndefined();
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
        if (q.called('increment')) { state.credited = q.args('increment'); return 1; }
        if (q.called('update')) {
          const payload = q.args('update')[0];
          const whereArg = q.args('where')?.[0];
          if (payload.referred_by_customer_id === null && whereArg?.referred_by_customer_id) return 0;
          if (payload.deleted_at) { state.retired = payload; return 1; }
          if (payload.crm_notes || payload.technician_notes) { state.notesAppended = payload; return 1; }
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
      if (table === 'customer_tags') {
        if (q.called('select')) return [{ id: 'tag1' }, { id: 'tag2' }];
        if (q.called('del')) { state.tagsDropped = (state.tagsDropped || 0) + 1; return 1; }
        if (q.called('update')) {
          const w = q.args('where')[0];
          // The bulk repoint collides (winner already has a shared tag), and
          // so does tag2's row-wise move; tag1 moves cleanly.
          if (w === 'customer_id' || (w && w.id === 'tag2')) {
            const err = new Error('duplicate key value violates unique constraint');
            err.code = '23505';
            throw err;
          }
          state.repointUpdates.push(table);
          return 1;
        }
      }
      if (table === 'notifications' && q.called('update')) {
        state.notificationsWhere = q.args('where')[0];
        state.repointUpdates.push(table);
        return 1;
      }
      // Default: not enrolled in referrals (tests that need enrollment use
      // their own routers) — .first() must resolve a row or null, never [].
      if (table === 'referral_promoters' && q.called('first')) return null;
      if (table === 'scheduled_services' && q.called('update')) {
        state.serviceStamp = { whereNull: q.args('whereNull'), payload: q.args('update')[0] };
        return 2;
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

  it('refuses when the locked rows now read as two different people (post-recheck edit race)', async () => {
    const { trx } = buildTrx({
      winner: { id: WINNER, first_name: 'Nicole', last_name: 'Kenedy', address_line1: '100 Main St', city: 'Bradenton', zip: '34205', phone: '+19995550003' },
      loser: { id: LOSER, first_name: 'Tina', last_name: 'Tommelleo', address_line1: '200 Oak Ave', city: 'Sarasota', zip: '34236', phone: '9995550003' },
      fkRows: FK_ROWS,
    });
    db.transaction.mockImplementation(async (fn) => fn(trx));
    await expect(dedupe.executeMerge({ winnerId: WINNER, loserId: LOSER, performedBy: 'test' }))
      .rejects.toThrow(/two different people/);
  });

  it('moves non-colliding CRM tags and drops duplicate tags instead of aborting', async () => {
    const winner = { id: WINNER, first_name: 'A', last_name: 'B', phone: '+19995550003' };
    const loser = { id: LOSER, first_name: 'A', last_name: 'B', phone: '9995550003' };
    const { trx, state } = buildTrx({
      winner,
      loser,
      fkRows: [{ table_name: 'customer_tags', column_name: 'customer_id' }],
    });
    db.transaction.mockImplementation(async (fn) => fn(trx));
    const result = await dedupe.executeMerge({ winnerId: WINNER, loserId: LOSER, performedBy: 'test' });
    expect(result.repointed['customer_tags.customer_id']).toMatch(/moved 1, dropped 1/);
    expect(state.tagsDropped).toBe(1);
  });

  it('repoints customer-typed polymorphic recipients (notifications, email_messages)', async () => {
    const winner = { id: WINNER, first_name: 'Diana', last_name: 'Blowers', phone: '+19995550003' };
    const loser = { id: LOSER, first_name: 'Diana', last_name: null, phone: '9995550003' };
    const { trx, state } = buildTrx({
      winner,
      loser,
      fkRows: [{ table_name: 'leads', column_name: 'customer_id' }],
    });
    db.transaction.mockImplementation(async (fn) => fn(trx));
    const result = await dedupe.executeMerge({ winnerId: WINNER, loserId: LOSER, performedBy: 'test' });
    // Only rows explicitly typed 'customer' repoint — admin notifications
    // must not be touched by a customer merge.
    expect(state.notificationsWhere).toEqual({ recipient_type: 'customer', recipient_id: LOSER });
    expect(result.repointed['notifications.recipient_id']).toBe(1);
    expect(result.repointed['email_messages.recipient_id']).toBe(1);
  });

  it('moves the cached account_credits with the ledger and zeroes the retired row', async () => {
    const winner = { id: WINNER, first_name: 'A', last_name: 'B', phone: '+19995550003', account_credits: '10.00' };
    const loser = { id: LOSER, first_name: 'A', last_name: 'B', phone: '9995550003', account_credits: '25.50' };
    const { trx, state } = buildTrx({
      winner,
      loser,
      fkRows: [{ table_name: 'customer_credit_ledger', column_name: 'customer_id' }],
    });
    db.transaction.mockImplementation(async (fn) => fn(trx));
    const result = await dedupe.executeMerge({ winnerId: WINNER, loserId: LOSER, performedBy: 'test' });
    // Ledger rows moved via the sweep, so the cached balance moves too —
    // cache == ledger-sum stays true on both rows (customer-credit invariant).
    expect(state.credited).toEqual(['account_credits', 25.5]);
    expect(state.retired.account_credits).toBe(0);
    expect(result.repointed['customers.account_credits']).toMatch(/25.5/);
  });

  it("stamps the loser's unstamped visits with the loser's own address before the repoint", async () => {
    const winner = { id: WINNER, first_name: 'A', last_name: 'B', address_line1: '100 Main St', city: 'Bradenton', zip: '34205', phone: '+19995550003' };
    const loser = {
      id: LOSER, first_name: 'A', last_name: 'B', address_line1: '100 Main St', address_line2: 'Apt 3',
      city: 'Bradenton', state: 'FL', zip: '34205', phone: '9995550003',
    };
    const { trx, state } = buildTrx({ winner, loser, fkRows: FK_ROWS });
    db.transaction.mockImplementation(async (fn) => fn(trx));
    const result = await dedupe.executeMerge({ winnerId: WINNER, loserId: LOSER, performedBy: 'test' });
    // Only unstamped visits, stamped with the LOSER's address (the visits
    // were at their property) — never the winner's.
    expect(state.serviceStamp.whereNull).toEqual(['service_address_line1']);
    expect(state.serviceStamp.payload).toEqual({
      service_address_line1: '100 Main St',
      service_address_line2: 'Apt 3',
      service_address_city: 'Bradenton',
      service_address_state: 'FL',
      service_address_zip: '34205',
    });
    expect(result.repointed['scheduled_services.service_address_stamp']).toBe(2);
  });

  it('folds a duplicate referral enrollment into the winner promoter row', async () => {
    const winner = { id: WINNER, first_name: 'A', last_name: 'B', phone: '+19995550003' };
    const loser = { id: LOSER, first_name: 'A', last_name: 'B', phone: '9995550003' };
    // NOTE: no click_balance_cents — 20260401000100 dropped it; row shapes
    // here mirror the LIVE schema so a stale column reference fails the test.
    const winnerPromoter = {
      id: 7, customer_id: WINNER, referral_balance_cents: 0,
      total_earned_cents: 100, total_paid_out_cents: 0, total_clicks: 4,
      total_referrals_sent: 1, total_referrals_converted: 0,
      available_balance_cents: 0, pending_earnings_cents: 100,
    };
    const loserPromoterRow = {
      id: 9, customer_id: LOSER, referral_balance_cents: 200,
      total_earned_cents: 250, total_paid_out_cents: 0, total_clicks: 2,
      total_referrals_sent: 3, total_referrals_converted: 1,
      available_balance_cents: 300, pending_earnings_cents: 50,
    };
    const state = {
      referralRepoint: null, inviteRepoint: null, clickRepoint: null, payoutRepoint: null,
      promoterUpdates: {}, promoterDeleted: null,
    };
    const trx = jest.fn((table) => makeChain(table, (q) => {
      if (table === 'customers') {
        if (q.called('forUpdate')) return [winner, loser];
        if (q.called('update')) return 1;
        return [];
      }
      if (table === 'customer_merge_journal') return [{ id: 'j1' }];
      if (table === 'referral_promoters') {
        if (q.called('del')) { state.promoterDeleted = q.args('where')[0]; return 1; }
        if (q.called('first')) {
          const w = q.args('where')[0];
          if (w.customer_id === LOSER) return { id: 9 };
          if (w.customer_id === WINNER) return winnerPromoter;
          if (w.id === 9) return loserPromoterRow;
          return null;
        }
        if (q.called('update')) {
          state.promoterUpdates[q.args('where')[0].id] = q.args('update')[0];
          return 1;
        }
      }
      if (table === 'referrals' && q.called('update')) {
        state.referralRepoint = [q.args('where')[0], q.args('update')[0]];
        return 1;
      }
      if (table === 'referral_invites' && q.called('update')) {
        state.inviteRepoint = [q.args('where')[0], q.args('update')[0]];
        return 1;
      }
      if (table === 'referral_clicks' && q.called('update')) {
        state.clickRepoint = [q.args('where')[0], q.args('update')[0]];
        return 1;
      }
      if (table === 'referral_payouts' && q.called('update')) {
        state.payoutRepoint = [q.args('where')[0], q.args('update')[0]];
        return 1;
      }
      if (q.called('update')) return 1;
      return [];
    }));
    trx.raw = jest.fn(async () => ({ rows: [] }));
    trx.transaction = jest.fn(async (fn) => fn(trx));
    trx.fn = { now: () => 'NOW' };
    db.transaction.mockImplementation(async (fn) => fn(trx));

    const result = await dedupe.executeMerge({ winnerId: WINNER, loserId: LOSER, performedBy: 'test' });
    expect(state.referralRepoint).toEqual([{ promoter_id: 9 }, { promoter_id: 7 }]);
    expect(state.inviteRepoint).toEqual([{ promoter_id: 9 }, { promoter_id: 7 }]);
    // Click history and payout rows follow the promoter — payout approval
    // looks the promoter back up, so orphans would strand pending payouts.
    expect(state.clickRepoint).toEqual([{ promoter_id: 9 }, { promoter_id: 7 }]);
    expect(state.payoutRepoint).toEqual([{ promoter_id: 9 }, { promoter_id: 7 }]);
    // Balances/counters sum — including the live v2 balances the portal
    // displays (available/pending); zero-add columns untouched.
    expect(state.promoterUpdates[7]).toEqual({
      referral_balance_cents: 200,
      total_earned_cents: 350,
      total_clicks: 6,
      total_referrals_sent: 4,
      total_referrals_converted: 1,
      available_balance_cents: 300,
      pending_earnings_cents: 150,
      updated_at: 'NOW',
    });
    // The loser row is NOT deleted — it survives as a code alias so /r/:code
    // links already in the wild keep attributing to the winner.
    expect(state.promoterDeleted).toBe(null);
    expect(state.promoterUpdates[9]).toEqual({
      customer_id: null,
      status: 'merged',
      merged_into_promoter_id: 7,
      referral_balance_cents: 0,
      total_earned_cents: 0,
      total_paid_out_cents: 0,
      total_clicks: 0,
      total_referrals_sent: 0,
      total_referrals_converted: 0,
      available_balance_cents: 0,
      pending_earnings_cents: 0,
      updated_at: 'NOW',
    });
    expect(result.repointed['referral_promoters.consolidated']).toMatch(/9 into 7/);
  });

  it('refuses when the two customers have different third-party payers', async () => {
    const { trx } = buildTrx({
      winner: { id: WINNER, first_name: 'A', last_name: 'B', phone: '+19995550003', payer_id: 1 },
      loser: { id: LOSER, first_name: 'A', last_name: 'B', phone: '9995550003', payer_id: 2 },
      fkRows: FK_ROWS,
    });
    db.transaction.mockImplementation(async (fn) => fn(trx));
    await expect(dedupe.executeMerge({ winnerId: WINNER, loserId: LOSER, performedBy: 'test' }))
      .rejects.toThrow(/different third-party payers/);
  });

  it('transfers a loser-only payer default and clears it on the retired row', async () => {
    const winner = { id: WINNER, first_name: 'A', last_name: 'B', phone: '+19995550003', payer_id: null };
    const loser = { id: LOSER, first_name: 'A', last_name: 'B', phone: '9995550003', payer_id: 5 };
    const { trx, state } = buildTrx({ winner, loser, fkRows: FK_ROWS });
    db.transaction.mockImplementation(async (fn) => fn(trx));
    const result = await dedupe.executeMerge({ winnerId: WINNER, loserId: LOSER, performedBy: 'test' });
    expect(result.backfills.payer_id).toBe(5);
    expect(state.retired.payer_id).toBe(null);
  });

  it('auto mode refuses a payer-linked loser — third-party billing is never a disposable shell', async () => {
    const { trx } = buildTrx({
      winner: { id: WINNER, first_name: 'A', last_name: 'B', phone: '+19995550003' },
      loser: { id: LOSER, first_name: 'A', last_name: 'B', phone: '9995550003', payer_id: 5 },
      fkRows: FK_ROWS,
    });
    db.transaction.mockImplementation(async (fn) => fn(trx));
    await expect(dedupe.executeMerge({ winnerId: WINNER, loserId: LOSER, performedBy: 'test', mode: 'auto' }))
      .rejects.toThrow(/not a shell \(third_party_payer\)/);
  });

  it('refuses two different billing modes; transfers a loser-only mode + fee; clears them on retire', async () => {
    const conflicted = buildTrx({
      winner: { id: WINNER, first_name: 'A', last_name: 'B', phone: '+19995550003', billing_mode: 'annual_prepay' },
      loser: { id: LOSER, first_name: 'A', last_name: 'B', phone: '9995550003', billing_mode: 'per_application' },
      fkRows: FK_ROWS,
    });
    db.transaction.mockImplementation(async (fn) => fn(conflicted.trx));
    await expect(dedupe.executeMerge({ winnerId: WINNER, loserId: LOSER, performedBy: 'test' }))
      .rejects.toThrow(/different billing modes/);

    const { trx, state } = buildTrx({
      winner: { id: WINNER, first_name: 'A', last_name: 'B', phone: '+19995550003', billing_mode: null, per_application_fee: null },
      loser: { id: LOSER, first_name: 'A', last_name: 'B', phone: '9995550003', billing_mode: 'per_application', per_application_fee: '65.00' },
      fkRows: FK_ROWS,
    });
    db.transaction.mockImplementation(async (fn) => fn(trx));
    const result = await dedupe.executeMerge({ winnerId: WINNER, loserId: LOSER, performedBy: 'test' });
    expect(result.backfills.billing_mode).toBe('per_application');
    expect(result.backfills.per_application_fee).toBe('65.00');
    expect(state.retired.billing_mode).toBe(null);
  });

  it('auto mode refuses a loser carrying a billing mode', async () => {
    const { trx } = buildTrx({
      winner: { id: WINNER, first_name: 'A', last_name: 'B', phone: '+19995550003' },
      loser: { id: LOSER, first_name: 'A', last_name: 'B', phone: '9995550003', billing_mode: 'annual_prepay' },
      fkRows: FK_ROWS,
    });
    db.transaction.mockImplementation(async (fn) => fn(trx));
    await expect(dedupe.executeMerge({ winnerId: WINNER, loserId: LOSER, performedBy: 'test', mode: 'auto' }))
      .rejects.toThrow(/not a shell \(billing_mode\)/);
  });

  it('service contacts backfill SLOT-wise — never mixing fields across customers', async () => {
    const winner = {
      id: WINNER, first_name: 'A', last_name: 'B', phone: '+19995550003',
      // Slot 1 fully empty; slot 2 partially filled (name only).
      service_contact_name: null, service_contact_phone: null, service_contact_email: null, service_contact_role: null,
      service_contact2_name: 'Existing PM', service_contact2_phone: null, service_contact2_email: null, service_contact2_role: null,
    };
    const loser = {
      id: LOSER, first_name: 'A', last_name: 'B', phone: '9995550003',
      service_contact_name: 'Tenant Tia', service_contact_phone: '+19415550142', service_contact_email: null, service_contact_role: 'tenant',
      service_contact2_name: 'Other PM', service_contact2_phone: '+19415550199', service_contact2_email: null, service_contact2_role: 'property_manager',
    };
    const { trx } = buildTrx({ winner, loser, fkRows: FK_ROWS });
    db.transaction.mockImplementation(async (fn) => fn(trx));
    const result = await dedupe.executeMerge({ winnerId: WINNER, loserId: LOSER, performedBy: 'test' });
    // Slot 1: winner empty → the loser's whole slot moves.
    expect(result.backfills.service_contact_name).toBe('Tenant Tia');
    expect(result.backfills.service_contact_phone).toBe('+19415550142');
    expect(result.backfills.service_contact_role).toBe('tenant');
    // Slot 2: winner has a name → the loser's phone must NOT graft onto it.
    expect(result.backfills.service_contact2_phone).toBeUndefined();
    expect(result.backfills.service_contact2_name).toBeUndefined();
  });

  it('carries a loser autopay opt-out and live pause onto the winner (most-restrictive)', async () => {
    const future = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    const winner = {
      id: WINNER, first_name: 'A', last_name: 'B', phone: '+19995550003',
      autopay_enabled: true, autopay_paused_until: null,
    };
    const loser = {
      id: LOSER, first_name: 'A', last_name: 'B', phone: '9995550003',
      autopay_enabled: false, autopay_paused_until: future, autopay_pause_reason: 'customer asked to hold',
    };
    const state = { autopayUpdate: null };
    const trx = jest.fn((table) => makeChain(table, (q) => {
      if (table === 'customers') {
        if (q.called('forUpdate')) return [winner, loser];
        if (q.called('update')) {
          const payload = q.args('update')[0];
          if (payload.autopay_enabled === false) state.autopayUpdate = payload;
          return 1;
        }
        return [];
      }
      if (table === 'customer_merge_journal') return [{ id: 'j1' }];
      if (table === 'referral_promoters' && q.called('first')) return null;
      if (q.called('update')) return 1;
      return [];
    }));
    trx.raw = jest.fn(async () => ({ rows: [] }));
    trx.transaction = jest.fn(async (fn) => fn(trx));
    trx.fn = { now: () => 'NOW' };
    db.transaction.mockImplementation(async (fn) => fn(trx));

    const result = await dedupe.executeMerge({ winnerId: WINNER, loserId: LOSER, performedBy: 'test' });
    expect(state.autopayUpdate).toMatchObject({
      autopay_enabled: false,
      autopay_paused_until: future,
      autopay_pause_reason: 'customer asked to hold',
    });
    expect(result.repointed['customers.autopay_restrictions'])
      .toBe('autopay_enabled, autopay_paused_until, autopay_pause_reason');
  });

  it('carries a loser-only unit onto a street-only winner (address_line2 backfill)', async () => {
    const winner = {
      id: WINNER, first_name: 'A', last_name: 'B', phone: '+19995550003',
      address_line1: '5350 De Soto Rd', address_line2: null, zip: '34243',
    };
    const loser = {
      id: LOSER, first_name: 'A', last_name: 'B', phone: '9995550003',
      address_line1: '5350 Desoto Rd Apt 1418', address_line2: null, zip: '34243',
    };
    const { trx } = buildTrx({ winner, loser, fkRows: FK_ROWS });
    db.transaction.mockImplementation(async (fn) => fn(trx));
    const result = await dedupe.executeMerge({ winnerId: WINNER, loserId: LOSER, performedBy: 'test' });
    // Case preserved from the loser's raw line1.
    expect(result.backfills.address_line2).toBe('Apt 1418');
  });

  it('promotes the winner when retiring the same-account primary profile', async () => {
    const winner = {
      id: WINNER, first_name: 'A', last_name: 'B', phone: '+19995550003',
      account_id: 'acct-1', is_primary_profile: false,
    };
    const loser = {
      id: LOSER, first_name: 'A', last_name: 'B', phone: '9995550003',
      account_id: 'acct-1', is_primary_profile: true,
    };
    const { trx, state } = buildTrx({ winner, loser, fkRows: FK_ROWS });
    db.transaction.mockImplementation(async (fn) => fn(trx));
    const result = await dedupe.executeMerge({ winnerId: WINNER, loserId: LOSER, performedBy: 'test' });
    expect(result.backfills.is_primary_profile).toBe(true);
    expect(state.retired.is_primary_profile).toBe(false);
  });

  it('refuses when the loser saved cards belong to a foreign Stripe profile', async () => {
    const winner = { id: WINNER, first_name: 'A', last_name: 'B', phone: '+19995550003', stripe_customer_id: 'cus_winner' };
    const loser = { id: LOSER, first_name: 'A', last_name: 'B', phone: '9995550003', stripe_customer_id: null };
    const trx = jest.fn((table) => makeChain(table, (q) => {
      if (table === 'customers' && q.called('forUpdate')) return [winner, loser];
      if (table === 'payment_methods' && q.called('select')) return [{ stripe_customer_id: 'cus_other' }];
      return [];
    }));
    trx.raw = jest.fn(async () => ({ rows: [] }));
    trx.transaction = jest.fn(async (fn) => fn(trx));
    trx.fn = { now: () => 'NOW' };
    db.transaction.mockImplementation(async (fn) => fn(trx));
    await expect(dedupe.executeMerge({ winnerId: WINNER, loserId: LOSER, performedBy: 'test' }))
      .rejects.toThrow(/different Stripe profile/);
  });

  it('derives the Stripe customer from the moved cards when neither row names one', async () => {
    const winner = { id: WINNER, first_name: 'A', last_name: 'B', phone: '+19995550003', stripe_customer_id: null };
    const loser = { id: LOSER, first_name: 'A', last_name: 'B', phone: '9995550003', stripe_customer_id: null };
    const { trx } = buildTrx({ winner, loser, fkRows: [] });
    // Override payment_methods: the saved cards agree on one Stripe customer.
    const baseImpl = trx.getMockImplementation();
    trx.mockImplementation((table) => {
      if (table === 'payment_methods') {
        return makeChain(table, (q) => {
          if (q.called('select')) return [{ stripe_customer_id: 'cus_derived' }];
          if (q.called('first')) return null;
          if (q.called('update')) return 1;
          return [];
        });
      }
      return baseImpl(table);
    });
    db.transaction.mockImplementation(async (fn) => fn(trx));
    const result = await dedupe.executeMerge({ winnerId: WINNER, loserId: LOSER, performedBy: 'test' });
    expect(result.backfills.stripe_customer_id).toBe('cus_derived');
  });

  it('auto mode refuses a priced lead row — monthly_rate is accepted billing terms', async () => {
    const { trx } = buildTrx({
      winner: { id: WINNER, first_name: 'A', last_name: 'B', phone: '+19995550003' },
      loser: { id: LOSER, first_name: 'A', last_name: 'B', phone: '9995550003', monthly_rate: '89.00' },
      fkRows: FK_ROWS,
    });
    db.transaction.mockImplementation(async (fn) => fn(trx));
    await expect(dedupe.executeMerge({ winnerId: WINNER, loserId: LOSER, performedBy: 'test', mode: 'auto' }))
      .rejects.toThrow(/not a shell \(monthly_rate\)/);
  });

  it('appends loser notes onto the winner instead of dropping them', async () => {
    const winner = {
      id: WINNER, first_name: 'A', last_name: 'B', phone: '+19995550003',
      crm_notes: 'Winner context.', technician_notes: null,
    };
    const loser = {
      id: LOSER, first_name: 'A', last_name: 'B', phone: '9995550003',
      crm_notes: 'Gate code 4482, beware of dog.', technician_notes: 'Use side gate.',
    };
    const { trx, state } = buildTrx({ winner, loser, fkRows: FK_ROWS });
    db.transaction.mockImplementation(async (fn) => fn(trx));
    const result = await dedupe.executeMerge({ winnerId: WINNER, loserId: LOSER, performedBy: 'test' });
    expect(state.notesAppended.crm_notes).toBe(
      `Winner context.\n\n[From merged duplicate ${LOSER.slice(0, 8)}]: Gate code 4482, beware of dog.`,
    );
    expect(state.notesAppended.technician_notes).toBe('Use side gate.');
    expect(result.repointed['customers.notes_appended']).toBe('crm_notes, technician_notes');
  });

  it("refuses when the WINNER's own cards sit on a foreign profile the backfill would strand", async () => {
    // Winner row unnamed, its cards on cus_X; loser transfers cus_B — the
    // backfill would repoint the survivor to cus_B and strand the X cards.
    const winner = { id: WINNER, first_name: 'A', last_name: 'B', phone: '+19995550003', stripe_customer_id: null };
    const loser = { id: LOSER, first_name: 'A', last_name: 'B', phone: '9995550003', stripe_customer_id: 'cus_b' };
    const trx = jest.fn((table) => makeChain(table, (q) => {
      if (table === 'customers' && q.called('forUpdate')) return [winner, loser];
      if (table === 'payment_methods' && q.called('select')) {
        const w = q.args('where')[0];
        return w.customer_id === WINNER ? [{ stripe_customer_id: 'cus_x' }] : [];
      }
      return [];
    }));
    trx.raw = jest.fn(async () => ({ rows: [] }));
    trx.transaction = jest.fn(async (fn) => fn(trx));
    trx.fn = { now: () => 'NOW' };
    db.transaction.mockImplementation(async (fn) => fn(trx));
    await expect(dedupe.executeMerge({ winnerId: WINNER, loserId: LOSER, performedBy: 'test' }))
      .rejects.toThrow(/different Stripe profile/);
  });

  it('derivation considers BOTH sides: agreeing cards derive, disagreeing cards refuse', async () => {
    const mk = (winnerPm, loserPm) => {
      const winner = { id: WINNER, first_name: 'A', last_name: 'B', phone: '+19995550003', stripe_customer_id: null };
      const loser = { id: LOSER, first_name: 'A', last_name: 'B', phone: '9995550003', stripe_customer_id: null };
      const { trx } = buildTrx({ winner, loser, fkRows: [] });
      const baseImpl = trx.getMockImplementation();
      trx.mockImplementation((table) => {
        if (table === 'payment_methods') {
          return makeChain(table, (q) => {
            if (q.called('select')) {
              const w = q.args('where')[0];
              const ids = w.customer_id === WINNER ? winnerPm : loserPm;
              return ids.map((id) => ({ stripe_customer_id: id }));
            }
            if (q.called('first')) return null;
            if (q.called('update')) return 1;
            return [];
          });
        }
        return baseImpl(table);
      });
      db.transaction.mockImplementation(async (fn) => fn(trx));
      return dedupe.executeMerge({ winnerId: WINNER, loserId: LOSER, performedBy: 'test' });
    };
    // Both sides' cards agree → derive.
    const agreed = await mk(['cus_same'], ['cus_same']);
    expect(agreed.backfills.stripe_customer_id).toBe('cus_same');
    // Sides disagree → refuse.
    await expect(mk(['cus_x'], ['cus_y'])).rejects.toThrow(/different Stripe profile/);
  });

  it('backfills the address as a whole tuple — never the loser street with winner stale city', async () => {
    const winner = {
      id: WINNER, first_name: 'A', last_name: 'B', phone: '+19995550003',
      address_line1: null, address_line2: null, city: 'Sarasota', state: 'FL', zip: '34236',
    };
    const loser = {
      id: LOSER, first_name: 'A', last_name: 'B', phone: '9995550003',
      address_line1: '100 Main St', address_line2: 'Apt 2', city: 'Bradenton', state: 'FL', zip: '34205',
    };
    const { trx } = buildTrx({ winner, loser, fkRows: FK_ROWS });
    db.transaction.mockImplementation(async (fn) => fn(trx));
    const result = await dedupe.executeMerge({ winnerId: WINNER, loserId: LOSER, performedBy: 'test' });
    expect(result.backfills).toMatchObject({
      address_line1: '100 Main St',
      address_line2: 'Apt 2',
      city: 'Bradenton',
      state: 'FL',
      zip: '34205',
    });
  });

  it('repoints customer-typed data-hygiene proposal scopes and resources', async () => {
    const winner = { id: WINNER, first_name: 'A', last_name: 'B', phone: '+19995550003' };
    const loser = { id: LOSER, first_name: 'A', last_name: null, phone: '9995550003' };
    const state = { hygiene: [] };
    const trx = jest.fn((table) => makeChain(table, (q) => {
      if (table === 'customers') {
        if (q.called('forUpdate')) return [winner, loser];
        if (q.called('update')) return 1;
        return [];
      }
      if (table === 'customer_merge_journal') return [{ id: 'j1' }];
      if (table === 'data_hygiene_proposals' && q.called('update')) {
        state.hygiene.push([q.args('where')[0], q.args('update')[0]]);
        return 1;
      }
      if (table === 'referral_promoters' && q.called('first')) return null;
      if (q.called('update')) return 1;
      return [];
    }));
    trx.raw = jest.fn(async () => ({ rows: [] }));
    trx.transaction = jest.fn(async (fn) => fn(trx));
    trx.fn = { now: () => 'NOW' };
    db.transaction.mockImplementation(async (fn) => fn(trx));
    const result = await dedupe.executeMerge({ winnerId: WINNER, loserId: LOSER, performedBy: 'test' });
    expect(state.hygiene).toEqual(expect.arrayContaining([
      [{ scope_type: 'customer', scope_id: LOSER }, { scope_id: WINNER }],
      [{ resource_type: 'customer', resource_id: LOSER }, { resource_id: WINNER }],
    ]));
    expect(result.repointed['data_hygiene_proposals.scope_id']).toBe(1);
    expect(result.repointed['data_hygiene_proposals.resource_id']).toBe(1);
  });

  it('refuses matching per-application modes with different fees', async () => {
    const { trx } = buildTrx({
      winner: { id: WINNER, first_name: 'A', last_name: 'B', phone: '+19995550003', billing_mode: 'per_application', per_application_fee: '65.00' },
      loser: { id: LOSER, first_name: 'A', last_name: 'B', phone: '9995550003', billing_mode: 'per_application', per_application_fee: '80.00' },
      fkRows: FK_ROWS,
    });
    db.transaction.mockImplementation(async (fn) => fn(trx));
    await expect(dedupe.executeMerge({ winnerId: WINNER, loserId: LOSER, performedBy: 'test' }))
      .rejects.toThrow(/different per-application fees/);
  });

  it('refuses when the loser has live multi-property account siblings', async () => {
    const winner = { id: WINNER, first_name: 'A', last_name: 'B', phone: '+19995550003', account_id: 'acct-w' };
    const loser = { id: LOSER, first_name: 'A', last_name: 'B', phone: '9995550003', account_id: 'acct-l' };
    const trx = jest.fn((table) => makeChain(table, (q) => {
      if (table === 'customers') {
        if (q.called('forUpdate')) return [winner, loser];
        if (q.called('whereNotIn')) return { id: 'sibling-1' }; // live sibling on acct-l
        return [];
      }
      return [];
    }));
    trx.raw = jest.fn(async () => ({ rows: [] }));
    trx.transaction = jest.fn(async (fn) => fn(trx));
    trx.fn = { now: () => 'NOW' };
    db.transaction.mockImplementation(async (fn) => fn(trx));
    await expect(dedupe.executeMerge({ winnerId: WINNER, loserId: LOSER, performedBy: 'test' }))
      .rejects.toThrow(/multi-property account/);
  });

  it('demotes the loser cards when the winner already has a default payment method', async () => {
    const winner = { id: WINNER, first_name: 'A', last_name: 'B', phone: '+19995550003', stripe_customer_id: 'cus_shared' };
    const loser = { id: LOSER, first_name: 'A', last_name: 'B', phone: '9995550003', stripe_customer_id: 'cus_shared' };
    const state = { demoted: null };
    const trx = jest.fn((table) => makeChain(table, (q) => {
      if (table === 'customers') {
        if (q.called('forUpdate')) return [winner, loser];
        if (q.called('update')) return 1;
        return [];
      }
      if (table === 'customer_merge_journal') return [{ id: 'j1' }];
      if (table === 'payment_methods') {
        if (q.called('first')) return { id: 'pm-winner-default' };
        if (q.called('select')) {
          return q.args('select')[0] === 'stripe_customer_id'
            ? [{ stripe_customer_id: 'cus_shared' }] // cards live on the shared profile
            : [{ id: 'pm-loser-1' }, { id: 'pm-loser-2' }];
        }
        if (q.called('update') && q.called('whereIn')) {
          state.demoted = { ids: q.args('whereIn')[1], payload: q.args('update')[0] };
          return 2;
        }
        if (q.called('update')) return 1;
      }
      if (table === 'referral_promoters' && q.called('first')) return null;
      if (q.called('update')) return 1;
      return [];
    }));
    trx.raw = jest.fn(async () => ({ rows: [] }));
    trx.transaction = jest.fn(async (fn) => fn(trx));
    trx.fn = { now: () => 'NOW' };
    db.transaction.mockImplementation(async (fn) => fn(trx));

    const result = await dedupe.executeMerge({ winnerId: WINNER, loserId: LOSER, performedBy: 'test' });
    // The winner's own pre-merge default stays THE default: every loser card
    // arrives demoted from default/autopay.
    expect(state.demoted.ids).toEqual(['pm-loser-1', 'pm-loser-2']);
    expect(state.demoted.payload).toMatchObject({ is_default: false, autopay_enabled: false });
    expect(result.repointed['payment_methods.demoted_defaults']).toBe(2);
  });
});

describe('mergeConversationRows', () => {
  it('moves clean threads; colliding threads merge — messages first (CASCADE), counters fold, loser row drops', async () => {
    const loserConvs = [
      { id: 'c-clean', channel: 'sms', our_endpoint_id: '+1941', message_count: 2, last_message_at: '2026-07-01', last_inbound_at: null },
      { id: 'c-dup', channel: 'sms', our_endpoint_id: '+1942', message_count: 3, last_message_at: '2026-07-09', last_inbound_at: '2026-07-09' },
    ];
    const winnerConv = { id: 'c-win', channel: 'sms', our_endpoint_id: '+1942', message_count: 5, last_message_at: '2026-07-08', last_inbound_at: null };
    const state = { childRepoints: [], counterUpdate: null, deleted: [], moved: [] };
    const trx = jest.fn((table) => makeChain(table, (q) => {
      if (table === 'conversations') {
        if (q.called('select')) return loserConvs;
        if (q.called('del')) { state.deleted.push(q.args('where')[0]); return 1; }
        if (q.called('first')) return winnerConv;
        if (q.called('update')) {
          const w = q.args('where')[0];
          if (w.id === 'c-dup') { const e = new Error('dup'); e.code = '23505'; throw e; }
          if (w.id === 'c-win') { state.counterUpdate = q.args('update')[0]; return 1; }
          state.moved.push(w.id);
          return 1;
        }
      }
      if (['messages', 'agent_decisions', 'reply_training_examples'].includes(table) && q.called('update')) {
        state.childRepoints.push([table, q.args('where')[0].conversation_id, q.args('update')[0].conversation_id]);
        return 1;
      }
      return [];
    }));
    trx.transaction = jest.fn(async (fn) => fn(trx));
    trx.fn = { now: () => 'NOW' };

    const summary = await mergeConversationRows(trx, 'conversations', 'customer_id', 'W', 'L');
    expect(summary).toMatch(/moved 1, merged 1/);
    expect(state.moved).toEqual(['c-clean']);
    expect(state.childRepoints).toEqual(expect.arrayContaining([
      ['messages', 'c-dup', 'c-win'],
      ['agent_decisions', 'c-dup', 'c-win'],
      ['reply_training_examples', 'c-dup', 'c-win'],
    ]));
    expect(state.counterUpdate.message_count).toBe(8);
    expect(state.counterUpdate.last_message_at).toBe('2026-07-09');
    expect(state.counterUpdate.last_inbound_at).toBe('2026-07-09');
    expect(state.deleted).toEqual([{ id: 'c-dup' }]);
  });
});

describe('runAutoMergeSweep', () => {
  it('notifies with a routable Customer 360 deep link (?customerId=, not a path segment)', async () => {
    const winnerRow = {
      id: 'cccccccc-0000-0000-0000-000000000001',
      first_name: 'Diana', last_name: 'Blowers', phone: '+16124074763',
      address_line1: '4414 Ozark Ave', zip: '34207',
      pipeline_stage: 'new_lead', created_at: '2026-07-08',
    };
    const loserRow = {
      id: 'cccccccc-0000-0000-0000-000000000002',
      first_name: 'Diana', last_name: null, phone: '6124074763',
      address_line1: null, zip: null,
      pipeline_stage: 'new_lead', created_at: '2026-07-09',
    };
    // Detection path (module-level db mock)
    installDb((table) => {
      if (table === 'customers') return [winnerRow, loserRow];
      if (table === 'customer_duplicate_dismissals') return [];
      return [];
    });
    // Merge path (transaction mock)
    const trx = jest.fn((table) => makeChain(table, (q) => {
      if (table === 'customers' && q.called('forUpdate')) return [winnerRow, loserRow];
      if (table === 'customer_merge_journal') return [{ id: 'j1' }];
      if (q.called('update')) return 1;
      return [];
    }));
    trx.raw = jest.fn(async () => ({ rows: [] }));
    trx.transaction = jest.fn(async (fn) => fn(trx));
    trx.fn = { now: () => 'NOW' };
    db.transaction.mockImplementation(async (fn) => fn(trx));

    const results = await dedupe.runAutoMergeSweep({ performedBy: 'test' });
    expect(results.merged).toHaveLength(1);
    const { notifyAdmin } = require('../services/notification-service');
    expect(notifyAdmin).toHaveBeenCalledTimes(1);
    expect(notifyAdmin.mock.calls[0][3].link).toBe(`/admin/customers?customerId=${winnerRow.id}`);
  });
});
