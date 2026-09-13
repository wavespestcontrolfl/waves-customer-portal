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
// Stamped sessions are classified through Stripe (pay-combined
// stampedSessionOutcome): tests plant intents in mockStripePis by id.
let mockStripePis = {};
jest.mock('../services/stripe', () => ({
  retrievePaymentIntent: jest.fn(async (id) => mockStripePis[id] || null),
  cancelPaymentIntent: jest.fn(async () => ({})),
}));

const db = require('../models/db');
const StripeService = require('../services/stripe');
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
    'ignore', 'returning', 'first', 'increment', 'limit',
  ];
  for (const m of methods) {
    q[m] = jest.fn((...args) => { q._calls.push([m, args]); return q; });
  }
  q.called = (m) => q._calls.some(([name]) => name === m);
  q.args = (m) => q._calls.find(([name]) => name === m)?.[1];
  q.then = (resolve, reject) => Promise.resolve().then(() => {
    // Dial-defer probe (gh-r10): the routers here predate collection_cases
    // and default unknown tables to [] (truthy), which would false-fire the
    // defer. .first() must resolve a row or null — serve it centrally; the
    // defer pin test plants a row via DIALING_CASE.
    if (table === 'collection_cases') {
      if (COLLECTION_CASES_ERROR) throw COLLECTION_CASES_ERROR;
      return q.called('first') ? DIALING_CASE : COLLECTION_CASES_ROWS;
    }
    return route(q);
  }).then(resolve, reject);
  return q;
}

let DIALING_CASE = null;
let COLLECTION_CASES_ERROR = null;
let COLLECTION_CASES_ROWS = [];
afterEach(() => { DIALING_CASE = null; COLLECTION_CASES_ERROR = null; COLLECTION_CASES_ROWS = []; mockStripePis = {}; });

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

  it.each([
    ['sms', 'push', 'push'], ['push', 'sms', null],
    ['both', 'push', 'push'], ['push', 'email', 'email'], ['email', 'push', null],
    [null, 'push', 'push'], ['push', null, null],
  ])('notification_prefs: payment problems merge %s + %s preserves the least-SMS choice', async (winner, loser, expected) => {
    const { trx, state } = stubTrx({
      winnerRow: { customer_id: 'W', payment_issue_channel: winner },
      loserRow: { customer_id: 'L', payment_issue_channel: loser },
    });
    await mergeSingletonPrefRow(trx, 'notification_prefs', 'customer_id', 'W', 'L');
    expect(state.updated?.payment_issue_channel ?? null).toBe(expected);
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

  function buildTrx({ winner, loser, fkRows, updates = {}, journalId = 'j1', prefsConflict = false, sessions = null, queueCustomers = null }) {
    // `events` is an ORDERED log (the stamped-session reads and every repoint
    // update) so a test can assert what the executor does before the sweep.
    const state = { repointUpdates: [], retired: null, backfilled: null, journal: null, prefsDeleted: false, prefsMerged: null, events: [] };
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
        // The unlocked scan behind requireQueueEligibility (findDuplicateGroups):
        // tests that need a live queue plant its rows here; default = empty.
        return queueCustomers || [];
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
      // Billing-artifact probes (legacy-vs-special guard): null unless a
      // test plants rows via cfg-free state.
      if ((table === 'scheduled_services' || table === 'invoices') && q.called('first')) {
        return (state.billingArtifacts && state.billingArtifacts[table]) || null;
      }
      // Stamped combined-session read (pay-combined stampedCombinedSessionRows).
      if (table === 'invoices' && q.called('whereNotNull') && q.called('select')) {
        const owner = q.args('where')[0].customer_id;
        state.events.push(['sessions_read', owner]);
        return (sessions && sessions[owner]) || [];
      }
      if (table === 'scheduled_services' && q.called('update')) {
        state.serviceStamp = { whereNull: q.args('whereNull'), payload: q.args('update')[0] };
        return 2;
      }
      if (q.called('del')) { state.prefsDeleted = true; return 1; }
      if (q.called('update')) {
        state.repointUpdates.push(table);
        state.events.push(['update', table]);
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

  it('defers when either customer has a collection case mid-dial (gh-r10)', async () => {
    const { trx } = buildTrx({
      winner: { id: WINNER, first_name: 'Diana', last_name: 'Blowers', phone: '+19995550003' },
      loser: { id: LOSER, first_name: 'Diana', last_name: null, phone: '9995550003' },
      fkRows: FK_ROWS,
    });
    DIALING_CASE = { id: 'case-dialing-1' };
    db.transaction.mockImplementation(async (fn) => fn(trx));
    await expect(dedupe.executeMerge({ winnerId: WINNER, loserId: LOSER, performedBy: 'test' }))
      .rejects.toThrow(/deferred — a collection call is in flight/);
  });

  it('resolves both sides\' stamped payment sessions BEFORE the FK sweep repoints the loser\'s invoices, and still cancels them after (Codex r8 P1)', async () => {
    // The sweep moves invoices.customer_id from the loser to the winner. A
    // release that read AFTER it would find nothing on the loser (its
    // sessions silently survive the retire) and the union on the winner
    // (refusing a pin that never actually changed).
    mockStripePis = { pi_loser: { id: 'pi_loser', status: 'requires_payment_method', metadata: { combined_allocation: '{"x":1}' } } };
    const winner = { id: WINNER, first_name: 'Diana', last_name: 'Blowers', phone: '+19995550003' };
    const loser = { id: LOSER, first_name: 'Diana', last_name: null, phone: '9995550003' };
    const { trx, state } = buildTrx({
      winner, loser,
      fkRows: [...FK_ROWS, { table_name: 'invoices', column_name: 'customer_id' }],
      sessions: { [LOSER]: [{ id: 'inv-1', invoice_number: 'INV-1', stripe_payment_intent_id: 'pi_loser' }] },
    });
    db.transaction.mockImplementation(async (fn) => fn(trx));
    await dedupe.executeMerge({ winnerId: WINNER, loserId: LOSER, performedBy: 'test' });

    const loserRead = state.events.findIndex(([kind, id]) => kind === 'sessions_read' && id === LOSER);
    const winnerRead = state.events.findIndex(([kind, id]) => kind === 'sessions_read' && id === WINNER);
    const invoiceSweep = state.events.findIndex(([kind, table]) => kind === 'update' && table === 'invoices');
    expect(loserRead).toBeGreaterThanOrEqual(0);
    expect(winnerRead).toBeGreaterThanOrEqual(0);
    expect(invoiceSweep).toBeGreaterThan(loserRead);
    expect(invoiceSweep).toBeGreaterThan(winnerRead);
    // And NOTHING re-reads a side's sessions after the sweep: a post-sweep
    // read is the bug itself (the loser reads empty, the winner reads the
    // union), so the executor must work from the snapshot alone.
    expect(state.events.slice(invoiceSweep).filter(([kind]) => kind === 'sessions_read')).toEqual([]);
    // ...and the loser's session is still actually cancelled in Stripe.
    expect(StripeService.cancelPaymentIntent).toHaveBeenCalledWith('pi_loser');
  });

  it('takes the invoice-issued-closeout gate lock right after the property-preferences pair, sorted, before any customer row lock (GitHub r7 P2 #4127)', async () => {
    const winner = { id: WINNER, first_name: 'Diana', last_name: 'Blowers', phone: '+19995550003' };
    const loser = { id: LOSER, first_name: 'Diana', last_name: null, phone: '9995550003' };
    const { trx } = buildTrx({ winner, loser, fkRows: FK_ROWS });
    db.transaction.mockImplementation(async (fn) => fn(trx));
    await dedupe.executeMerge({ winnerId: WINNER, loserId: LOSER, performedBy: 'test' });
    // Order: collections_case[0,1], property-preferences[0,1], THEN the
    // invoice-issued-closeout gate[0,1] — the same lock the invoice-issued
    // closeout (complete-scheduled-service.js) takes before it touches the
    // invoice row, so whichever transaction gets here first runs to
    // completion before the other takes any row lock (no ABBA is
    // reachable between this merge's customer-first order and the
    // closeout's invoice-first order).
    const sortedParties = [WINNER, LOSER].map(String).sort();
    const calls = trx.raw.mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(6);
    for (const [i, args] of [[0, ['collections_case', sortedParties[0]]], [1, ['collections_case', sortedParties[1]]],
      [2, ['property-preferences', sortedParties[0]]], [3, ['property-preferences', sortedParties[1]]],
      [4, ['invoice-issued-closeout', sortedParties[0]]], [5, ['invoice-issued-closeout', sortedParties[1]]]]) {
      expect(String(calls[i][0])).toContain('pg_advisory_xact_lock');
      expect(calls[i][1]).toEqual(args);
    }
  });

  it('gh-r12: a collection-case reconcile failure FAILS the merge (atomic) — except undefined_table', async () => {
    const build = () => buildTrx({
      winner: { id: WINNER, first_name: 'Diana', last_name: 'Blowers', phone: '+19995550003' },
      loser: { id: LOSER, first_name: 'Diana', last_name: null, phone: '9995550003' },
      fkRows: FK_ROWS,
    });
    // A real failure (timeout, bad query) must not commit a merge that
    // leaves two live approvals under the winner.
    db.transaction.mockImplementation(async (fn) => fn(build().trx));
    COLLECTION_CASES_ERROR = Object.assign(new Error('statement timeout'), { code: '57014' });
    await expect(dedupe.executeMerge({ winnerId: WINNER, loserId: LOSER, performedBy: 'test' }))
      .rejects.toThrow(/statement timeout/);
    // An absent table (pre-collections env) stays tolerable.
    db.transaction.mockImplementation(async (fn) => fn(build().trx));
    COLLECTION_CASES_ERROR = Object.assign(new Error('relation "collection_cases" does not exist'), { code: '42P01' });
    await expect(dedupe.executeMerge({ winnerId: WINNER, loserId: LOSER, performedBy: 'test' }))
      .resolves.toBeTruthy();
  });

  it('validates an approved snapshot (expectedVersions) under the row locks and refuses drift with previewChanged', async () => {
    const build = () => buildTrx({
      winner: { id: WINNER, first_name: 'Synthetic', last_name: 'Winner', phone: '+19995550003', version: '2026-09-10 20:00:00.000001+00' },
      loser: { id: LOSER, first_name: 'Synthetic', last_name: null, phone: '9995550003', version: '2026-09-10 20:05:00.000002+00' },
      fkRows: FK_ROWS,
    });
    db.transaction.mockImplementation(async (fn) => fn(build().trx));
    await expect(dedupe.executeMerge({
      winnerId: WINNER, loserId: LOSER, performedBy: 'test',
      expectedVersions: { winner: '2026-09-10 20:00:00.000001+00', loser: '2026-09-10 20:05:00.000002+00' },
    })).resolves.toBeTruthy();
    db.transaction.mockImplementation(async (fn) => fn(build().trx));
    const drift = dedupe.executeMerge({
      winnerId: WINNER, loserId: LOSER, performedBy: 'test',
      expectedVersions: { winner: '2026-09-10 20:00:00.000001+00', loser: '2026-09-10 20:06:00.000000+00' },
    });
    await expect(drift).rejects.toMatchObject({ previewChanged: true, message: expect.stringMatching(/loser customer changed since this merge was approved/) });
  });

  it('validates an approved effect fingerprint (expectedEffectsFingerprint) over the LOCKED rows and refuses drift with previewChanged', async () => {
    const winner = { id: WINNER, first_name: 'Synthetic', last_name: 'Winner', phone: '+19995550003', account_credits: '0' };
    const loser = { id: LOSER, first_name: 'Synthetic', last_name: null, phone: '9995550003', account_credits: '5' };
    const build = () => buildTrx({ winner, loser, fkRows: FK_ROWS });
    const approved = (await dedupe.describeMergeEffects(build().trx, winner, loser)).fingerprint;
    db.transaction.mockImplementation(async (fn) => fn(build().trx));
    await expect(dedupe.executeMerge({ winnerId: WINNER, loserId: LOSER, performedBy: 'test', expectedEffectsFingerprint: approved }))
      .resolves.toBeTruthy();
    db.transaction.mockImplementation(async (fn) => fn(build().trx));
    await expect(dedupe.executeMerge({ winnerId: WINNER, loserId: LOSER, performedBy: 'test', expectedEffectsFingerprint: 'stale-card' }))
      .rejects.toMatchObject({ previewChanged: true, message: expect.stringMatching(/rows that would move changed since this merge was approved/) });
  });

  it('requireQueueEligibility re-decides duplicate eligibility INSIDE the transaction under the pair adjudication lock and refuses a pair that is no longer in the queue', async () => {
    const { trx } = buildTrx({
      winner: { id: WINNER, first_name: 'Synthetic', last_name: 'Winner', phone: '+19995550003' },
      loser: { id: LOSER, first_name: 'Synthetic', last_name: null, phone: '9995550003' },
      fkRows: FK_ROWS,
    });
    db.transaction.mockImplementation(async (fn) => fn(trx));
    // The harness serves no queue rows to the unlocked customers read → not_in_queue.
    await expect(dedupe.executeMerge({ winnerId: WINNER, loserId: LOSER, performedBy: 'test', requireQueueEligibility: true }))
      .rejects.toMatchObject({ previewChanged: true, message: expect.stringMatching(/no longer mergeable \(not_in_queue\)/) });
    const lockCall = trx.raw.mock.calls.find(([sql]) => /pg_advisory_xact_lock\(hashtext\(\?\)\)/.test(String(sql)));
    expect(lockCall).toBeTruthy();
    expect(lockCall[1]).toEqual([`customer-duplicate-pair:${[WINNER, LOSER].sort().join(':')}`]);
  });

  it('requireQueueEligibility + allowAddressConflict: an address_conflict pair merges ONLY when the caller admits it (link-as-property), and still refuses without the flag', async () => {
    // A live yellow candidate whose only refusal is the loser's different
    // street — exactly the pair /link-as-property exists for. The winner's
    // Stripe profile pins it as the cluster winner in the scan.
    const winner = { id: WINNER, first_name: 'Synthetic', last_name: 'Winner', phone: '+19995550003', address_line1: '100 Test Street', zip: '34207', stripe_customer_id: 'cus_winner', pipeline_stage: 'active_customer', created_at: '2026-07-08' };
    const loser = { id: LOSER, first_name: 'Synthetic', last_name: null, phone: '9995550003', address_line1: '999 Different St', zip: '34211', pipeline_stage: 'new_lead', created_at: '2026-07-09' };
    const build = () => buildTrx({ winner, loser, fkRows: FK_ROWS, queueCustomers: [winner, loser] });
    db.transaction.mockImplementation(async (fn) => fn(build().trx));
    await expect(dedupe.executeMerge({ winnerId: WINNER, loserId: LOSER, performedBy: 'test', requireQueueEligibility: true }))
      .rejects.toMatchObject({ previewChanged: true, message: expect.stringMatching(/no longer mergeable \(address_conflict\)/) });
    db.transaction.mockImplementation(async (fn) => fn(build().trx));
    await expect(dedupe.executeMerge({ winnerId: WINNER, loserId: LOSER, performedBy: 'test', requireQueueEligibility: true, allowAddressConflict: true }))
      .resolves.toBeTruthy();
    // The flag admits address_conflict and nothing else: an empty queue is still not_in_queue.
    db.transaction.mockImplementation(async (fn) => fn(buildTrx({ winner, loser, fkRows: FK_ROWS }).trx));
    await expect(dedupe.executeMerge({ winnerId: WINNER, loserId: LOSER, performedBy: 'test', requireQueueEligibility: true, allowAddressConflict: true }))
      .rejects.toMatchObject({ previewChanged: true, message: expect.stringMatching(/no longer mergeable \(not_in_queue\)/) });
  });

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

  it('registers customer_alerts with the rowwise drop-collisions handler (shared advisory rows fold, never abort — codex #3390)', () => {
    const { UNIQUE_COLLISION_HANDLERS, repointRowwiseDropCollisions } = dedupe._test;
    expect(UNIQUE_COLLISION_HANDLERS.customer_alerts).toBe(repointRowwiseDropCollisions);
  });

  it('registers irrigation_week_plans with the keep-available handler (same-week snapshots fold, never abort — codex #3565 gh-r14)', () => {
    const { UNIQUE_COLLISION_HANDLERS, repointWeekPlansKeepAvailable } = dedupe._test;
    expect(UNIQUE_COLLISION_HANDLERS.irrigation_week_plans).toBe(repointWeekPlansKeepAvailable);
  });

  describe('repointWeekPlansKeepAvailable (codex #3565 gh-r15: the delivered snapshot survives)', () => {
    // Minimal in-memory irrigation_week_plans with the (customer_id,
    // week_ending) unique enforced on update, so the handler's collision
    // branches run against real row state.
    const fakeTrx = (seed, messages = []) => {
      const rows = seed.map((r) => ({ ...r }));
      const matches = (row, where) => Object.entries(where).every(([k, v]) => row[k] === v);
      const unique = (id, customerId) => {
        const me = rows.find((r) => r.id === id);
        if (rows.some((r) => r.id !== id && r.customer_id === customerId && r.week_ending === me.week_ending)) {
          const e = new Error('duplicate key'); e.code = '23505'; throw e;
        }
      };
      const qb = (table) => {
        if (table === 'email_messages') {
          // The durable customer-week delivery record the delivered check reads.
          let w = {}; let statuses = null;
          const mq = {
            where(a) { w = { ...w, ...a }; return mq; },
            whereIn(col, vals) { statuses = vals; return mq; },
            select() { return Promise.resolve(messages.filter((m) => matches(m, w) && (!statuses || statuses.includes(m.status))).map((m) => ({ ...m }))); },
          };
          return mq;
        }
        expect(table).toBe('irrigation_week_plans');
        let where = {};
        const api = {
          where(a, b) { where = typeof a === 'object' ? { ...where, ...a } : { ...where, [a]: b }; return api; },
          select() { return Promise.resolve(rows.filter((r) => matches(r, where)).map((r) => ({ ...r }))); },
          first() { const r = rows.find((x) => matches(x, where)); return Promise.resolve(r ? { ...r } : undefined); },
          update(patch) {
            const hit = rows.filter((r) => matches(r, where));
            for (const r of hit) { if (patch.customer_id) unique(r.id, patch.customer_id); Object.assign(r, patch); }
            return Promise.resolve(hit.length);
          },
          del() { const before = rows.length; for (let i = rows.length - 1; i >= 0; i -= 1) if (matches(rows[i], where)) rows.splice(i, 1); return Promise.resolve(before - rows.length); },
        };
        return api;
      };
      const trx = (table) => qb(table);
      trx.transaction = async (fn) => fn(trx);
      trx.fn = { now: () => 'NOW()' };
      trx.rows = rows;
      return trx;
    };
    const { repointWeekPlansKeepAvailable } = dedupe._test;

    it('retains an app publication over a draft without inventing email delivery', async () => {
      const trx = fakeTrx([
        { id: 'w1', customer_id: WINNER, week_ending: '2026-08-23', sent_at: null },
        { id: 'l1', customer_id: LOSER, week_ending: '2026-08-23', sent_at: null, published_at: '2026-08-24T10:00:00Z' },
      ]);
      await repointWeekPlansKeepAvailable(trx, 'irrigation_week_plans', 'customer_id', WINNER, LOSER);
      expect(trx.rows).toEqual([{ id: 'l1', customer_id: WINNER, week_ending: '2026-08-23', sent_at: null, published_at: '2026-08-24T10:00:00Z' }]);
    });

    it('keeps the winner when both plans are published', async () => {
      const trx = fakeTrx([
        { id: 'w1', customer_id: WINNER, week_ending: '2026-08-23', sent_at: null, published_at: '2026-08-24T10:00:00Z' },
        { id: 'l1', customer_id: LOSER, week_ending: '2026-08-23', sent_at: null, published_at: '2026-08-24T11:00:00Z' },
      ]);
      await repointWeekPlansKeepAvailable(trx, 'irrigation_week_plans', 'customer_id', WINNER, LOSER);
      expect(trx.rows.map(row => row.id)).toEqual(['w1']);
      expect(trx.rows[0].sent_at).toBeNull();
    });

    it.each([
      [WINNER, 'stamped'], [LOSER, 'stamped'],
      [WINNER, 'provider_accepted'], [LOSER, 'provider_accepted'],
    ])('keeps %s actual email decision over a different publication (%s)', async (emailedCustomer, evidence) => {
      const emailedId = emailedCustomer === WINNER ? 'w1' : 'l1';
      const rows = [WINNER, LOSER].map((customerId, index) => ({
        id: index === 0 ? 'w1' : 'l1', customer_id: customerId, week_ending: '2026-08-23',
        decision_hash: `hash-${customerId}`,
        sent_at: customerId === emailedCustomer && evidence === 'stamped' ? '2026-08-24T10:00:00Z' : null,
        published_at: customerId === emailedCustomer ? null : '2026-08-24T09:00:00Z',
      }));
      const messages = evidence === 'provider_accepted' ? [{
        trigger_event_id: `irrigation.weekly:${emailedCustomer}:2026-08-23`, status: 'sent',
        categories: JSON.stringify([`plan:hash-${emailedCustomer}`]),
      }] : [];
      const trx = fakeTrx(rows, messages);
      await repointWeekPlansKeepAvailable(trx, 'irrigation_week_plans', 'customer_id', WINNER, LOSER);
      expect(trx.rows).toEqual([expect.objectContaining({
        id: emailedId, customer_id: WINNER, decision_hash: `hash-${emailedCustomer}`,
        sent_at: evidence === 'stamped' ? '2026-08-24T10:00:00Z' : 'NOW()',
      })]);
    });

    it('moves a non-colliding week and drops the loser copy when the winner already SENT that week', async () => {
      const trx = fakeTrx([
        { id: 'w1', customer_id: WINNER, week_ending: '2026-08-23', sent_at: '2026-08-24T10:00:00Z' },
        { id: 'l1', customer_id: LOSER, week_ending: '2026-08-23', sent_at: '2026-08-24T10:01:00Z' },
        { id: 'l2', customer_id: LOSER, week_ending: '2026-08-16', sent_at: '2026-08-17T10:00:00Z' },
      ]);
      const out = await repointWeekPlansKeepAvailable(trx, 'irrigation_week_plans', 'customer_id', WINNER, LOSER);
      expect(out).toMatch(/moved 1, replaced 0 .* dropped 1/);
      expect(trx.rows.map((r) => [r.id, r.customer_id]).sort()).toEqual([['l2', WINNER], ['w1', WINNER]]);
    });

    it('replaces the winner UNSENT row with the loser SENT snapshot (the delivered decision survives)', async () => {
      const trx = fakeTrx([
        { id: 'w1', customer_id: WINNER, week_ending: '2026-08-23', sent_at: null },
        { id: 'l1', customer_id: LOSER, week_ending: '2026-08-23', sent_at: '2026-08-24T10:01:00Z' },
      ]);
      const out = await repointWeekPlansKeepAvailable(trx, 'irrigation_week_plans', 'customer_id', WINNER, LOSER);
      expect(out).toMatch(/replaced 1/);
      expect(trx.rows).toEqual([{ id: 'l1', customer_id: WINNER, week_ending: '2026-08-23', sent_at: '2026-08-24T10:01:00Z' }]);
    });

    it('both UNSENT but the loser\'s email was provider-accepted (delivery record names its decision hash) → the delivered snapshot survives (codex gh-r17)', async () => {
      const trx = fakeTrx([
        { id: 'w1', customer_id: WINNER, week_ending: '2026-08-23', sent_at: null, decision_hash: 'hash-w' },
        { id: 'l1', customer_id: LOSER, week_ending: '2026-08-23', sent_at: null, decision_hash: 'hash-l' },
      ], [
        { trigger_event_id: `irrigation.weekly:${LOSER}:2026-08-23`, status: 'sent', categories: JSON.stringify(['irrigation', 'plan:hash-l']) },
        // A pre-provider failure on the winner's side is not a delivery.
        { trigger_event_id: `irrigation.weekly:${WINNER}:2026-08-23`, status: 'failed', categories: JSON.stringify(['irrigation', 'plan:hash-w']) },
      ]);
      const out = await repointWeekPlansKeepAvailable(trx, 'irrigation_week_plans', 'customer_id', WINNER, LOSER);
      expect(out).toMatch(/replaced 1 .* stamped 1/);
      // The accepted-but-unstamped survivor is stamped so the report can render it.
      expect(trx.rows.map((r) => [r.id, r.customer_id, r.sent_at])).toEqual([['l1', WINNER, 'NOW()']]);
    });

    it('a NON-colliding moved row that the provider accepted but never stamped is stamped on the way over (codex gh-r21)', async () => {
      const trx = fakeTrx([
        { id: 'l1', customer_id: LOSER, week_ending: '2026-08-23', sent_at: null, decision_hash: 'hash-l' },
        { id: 'l2', customer_id: LOSER, week_ending: '2026-08-16', sent_at: null, decision_hash: 'hash-old' },
      ], [{ trigger_event_id: `irrigation.weekly:${LOSER}:2026-08-23`, status: 'delivered', categories: JSON.stringify(['plan:hash-l']) }]);
      const out = await repointWeekPlansKeepAvailable(trx, 'irrigation_week_plans', 'customer_id', WINNER, LOSER);
      expect(out).toMatch(/moved 2, .* stamped 1/);
      expect(trx.rows.map((r) => [r.id, r.customer_id, r.sent_at])).toEqual([['l1', WINNER, 'NOW()'], ['l2', WINNER, null]]);
    });

    it('both provider-accepted, winner UNSTAMPED + loser STAMPED → the stamped (renderable) row survives (codex gh-r18)', async () => {
      const trx = fakeTrx([
        { id: 'w1', customer_id: WINNER, week_ending: '2026-08-23', sent_at: null, decision_hash: 'hash-w' },
        { id: 'l1', customer_id: LOSER, week_ending: '2026-08-23', sent_at: '2026-08-24T10:01:00Z', decision_hash: 'hash-l' },
      ], [
        { trigger_event_id: `irrigation.weekly:${WINNER}:2026-08-23`, status: 'sent', categories: JSON.stringify(['plan:hash-w']) },
        { trigger_event_id: `irrigation.weekly:${LOSER}:2026-08-23`, status: 'sent', categories: JSON.stringify(['plan:hash-l']) },
      ]);
      const out = await repointWeekPlansKeepAvailable(trx, 'irrigation_week_plans', 'customer_id', WINNER, LOSER);
      expect(out).toMatch(/replaced 1 .* stamped 0/);
      expect(trx.rows.map((r) => [r.id, r.customer_id, r.sent_at])).toEqual([['l1', WINNER, '2026-08-24T10:01:00Z']]);
    });

    it('both provider-accepted and both UNSTAMPED → the winner row stays and is stamped', async () => {
      const trx = fakeTrx([
        { id: 'w1', customer_id: WINNER, week_ending: '2026-08-23', sent_at: null, decision_hash: 'hash-w' },
        { id: 'l1', customer_id: LOSER, week_ending: '2026-08-23', sent_at: null, decision_hash: 'hash-l' },
      ], [
        { trigger_event_id: `irrigation.weekly:${WINNER}:2026-08-23`, status: 'delivered', categories: JSON.stringify(['plan:hash-w']) },
        { trigger_event_id: `irrigation.weekly:${LOSER}:2026-08-23`, status: 'sent', categories: JSON.stringify(['plan:hash-l']) },
      ]);
      const out = await repointWeekPlansKeepAvailable(trx, 'irrigation_week_plans', 'customer_id', WINNER, LOSER);
      expect(out).toMatch(/replaced 0 .* dropped 1 duplicate row\(s\), stamped 1/);
      expect(trx.rows.map((r) => [r.id, r.customer_id, r.sent_at])).toEqual([['w1', WINNER, 'NOW()']]);
    });

    it('a delivery record naming a DIFFERENT decision does not make an unsent row delivered', async () => {
      const trx = fakeTrx([
        { id: 'w1', customer_id: WINNER, week_ending: '2026-08-23', sent_at: null, decision_hash: 'hash-w' },
        { id: 'l1', customer_id: LOSER, week_ending: '2026-08-23', sent_at: null, decision_hash: 'hash-l' },
      ], [{ trigger_event_id: `irrigation.weekly:${LOSER}:2026-08-23`, status: 'sent', categories: JSON.stringify(['plan:hash-older']) }]);
      const out = await repointWeekPlansKeepAvailable(trx, 'irrigation_week_plans', 'customer_id', WINNER, LOSER);
      expect(out).toMatch(/replaced 0 .* dropped 1/);
      expect(trx.rows.map((r) => r.id)).toEqual(['w1']);
    });

    it('both unsent → the winner row stays, the loser copy drops', async () => {
      const trx = fakeTrx([
        { id: 'w1', customer_id: WINNER, week_ending: '2026-08-23', sent_at: null },
        { id: 'l1', customer_id: LOSER, week_ending: '2026-08-23', sent_at: null },
      ]);
      const out = await repointWeekPlansKeepAvailable(trx, 'irrigation_week_plans', 'customer_id', WINNER, LOSER);
      expect(out).toMatch(/replaced 0 .* dropped 1/);
      expect(trx.rows.map((r) => r.id)).toEqual(['w1']);
    });

    it('rethrows a non-unique failure', async () => {
      const trx = fakeTrx([{ id: 'l1', customer_id: LOSER, week_ending: '2026-08-23', sent_at: null }]);
      trx.transaction = async () => { throw new Error('connection reset'); };
      await expect(repointWeekPlansKeepAvailable(trx, 'irrigation_week_plans', 'customer_id', WINNER, LOSER)).rejects.toThrow('connection reset');
    });
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

  it('retains immutable field credit ownership while merging ordinary account references', async () => {
    const { trx, state } = buildTrx({
      winner: { id: WINNER, phone: '+19995550003' }, loser: { id: LOSER, phone: '9995550003' },
      fkRows: [
        { table_name: 'field_credit_allocations', column_name: 'customer_id' },
        { table_name: 'leads', column_name: 'customer_id' },
      ],
      updates: { field_credit_allocations: 1 },
    });
    db.transaction.mockImplementation(async fn => fn(trx));
    const result = await dedupe.executeMerge({ winnerId: WINNER, loserId: LOSER, performedBy: 'test' });
    expect(state.repointUpdates).not.toContain('field_credit_allocations');
    expect(result.repointed['field_credit_allocations.customer_id']).toBeUndefined();
    expect(state.repointUpdates).toContain('leads');
    expect(state.retired).toBeTruthy();
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

  it('rewrites the irrigation weekly delivery identity (trigger_event_id) from the loser to the winner (codex #3565 gh-r16)', async () => {
    const winner = { id: WINNER, first_name: 'A', last_name: 'B', phone: '+19995550003' };
    const loser = { id: LOSER, first_name: 'A', last_name: 'B', phone: '9995550003' };
    const { trx, state } = buildTrx({ winner, loser, fkRows: [{ table_name: 'leads', column_name: 'customer_id' }] });
    const base = trx.getMockImplementation();
    state.triggerRewrites = [];
    trx.mockImplementation((table) => {
      if (table !== 'email_messages') return base(table);
      return makeChain(table, (q) => {
        if (q.called('select')) {
          const like = q.args('where');
          expect(like).toEqual(['trigger_event_id', 'like', `irrigation.weekly:${LOSER}:%`]);
          return [{ id: 'em1', trigger_event_id: `irrigation.weekly:${LOSER}:2026-08-23` }];
        }
        // The polymorphic recipient repoint also updates email_messages —
        // only the identity rewrite is under test here.
        if (q.called('update')) { if (q.args('update')[0].trigger_event_id) state.triggerRewrites.push([q.args('where')[0], q.args('update')[0]]); return 1; }
        return 1;
      });
    });
    db.transaction.mockImplementation(async (fn) => fn(trx));
    const result = await dedupe.executeMerge({ winnerId: WINNER, loserId: LOSER, performedBy: 'test' });
    expect(state.triggerRewrites).toEqual([[{ id: 'em1' }, { trigger_event_id: `irrigation.weekly:${WINNER}:2026-08-23` }]]);
    expect(result.repointed['email_messages.trigger_event_id']).toBe(1);
    // Journaled row-precisely so the undo can rewrite exactly these back.
    expect(JSON.parse(state.journal.repointed_ids).irrigation_trigger_ids).toEqual(['em1']);
  });

  it("rewrites an operator's call link (call_log.metadata.customer_link_override) from the loser to the winner and journals the call ids (codex #3736 gh-r5)", async () => {
    const winner = { id: WINNER, first_name: 'A', last_name: 'B', phone: '+19995550003' };
    const loser = { id: LOSER, first_name: 'A', last_name: 'B', phone: '9995550003' };
    const { trx, state } = buildTrx({ winner, loser, fkRows: [{ table_name: 'leads', column_name: 'customer_id' }] });
    const base = trx.getMockImplementation();
    state.overrideRewrites = [];
    trx.mockImplementation((table) => {
      if (table !== 'call_log') return base(table);
      return makeChain(table, (q) => {
        expect(q.args('whereRaw')).toEqual(["metadata -> 'customer_link_override' ->> 'customer_id' = ?", [LOSER]]);
        if (q.called('select')) return [{ id: 'cl1' }];
        if (q.called('update')) { state.overrideRewrites.push(q.args('update')[0]); return 1; }
        return 1;
      });
    });
    db.transaction.mockImplementation(async (fn) => fn(trx));
    const result = await dedupe.executeMerge({ winnerId: WINNER, loserId: LOSER, performedBy: 'test' });
    expect(state.overrideRewrites).toHaveLength(1);
    expect(state.overrideRewrites[0].updated_at).toBe('NOW()');
    // The rewrite is a one-key jsonb_set of the embedded id, never a blob written back.
    const rewrite = trx.raw.mock.calls.find(([sql]) => String(sql).includes("'{customer_link_override,customer_id}'"));
    // …plus this merge's stamp, so the undo can tell the rewrite from a later relink to the same winner (codex #3764 gh-r1 P2).
    // The stamp is PUSHED onto merge_stamps (a stack), never a scalar overwrite: a chained merge's undo pops only its own.
    expect(rewrite).toEqual([expect.stringContaining("'{customer_link_override,merge_stamps}', COALESCE(metadata -> 'customer_link_override' -> 'merge_stamps', '[]'::jsonb) || ?::jsonb"), [JSON.stringify(WINNER), expect.any(String)]]);
    expect(rewrite[0]).toContain('jsonb_set(jsonb_set(metadata');
    expect(result.repointed['call_log.customer_link_override']).toBe(1);
    const ids = JSON.parse(state.journal.repointed_ids);
    expect(ids.customer_link_override_call_ids).toEqual(['cl1']);
    expect(JSON.parse(rewrite[1][1])).toEqual([ids.customer_link_override_merged_at]);
  });

  it('merging DIFFERENT homes marks the surviving sprinkler settings moved (stamp + confirmation reset); the same home does not (codex #3565 gh-r22)', async () => {
    const run = async (loserAddr) => {
      const winner = { id: WINNER, first_name: 'A', last_name: 'B', phone: '+19995550003', address_line1: '100 Main St', city: 'Bradenton', zip: '34205' };
      const loser = { id: LOSER, first_name: 'A', last_name: 'B', phone: '9995550003', ...loserAddr };
      const { trx } = buildTrx({ winner, loser, fkRows: [{ table_name: 'leads', column_name: 'customer_id' }] });
      const base = trx.getMockImplementation();
      const stamps = [];
      trx.mockImplementation((table) => (table !== 'property_preferences' ? base(table) : makeChain(table, (q) => {
        if (q.called('update')) { stamps.push([q.args('where')[0], q.args('update')[0]]); return 1; }
        return [];
      })));
      db.transaction.mockImplementation(async (fn) => fn(trx));
      const result = await dedupe.executeMerge({ winnerId: WINNER, loserId: LOSER, performedBy: 'test' });
      return { stamps, result };
    };
    const moved = await run({ address_line1: '200 Oak Ave', city: 'Sarasota', zip: '34236' });
    expect(moved.stamps).toHaveLength(1);
    expect(moved.stamps[0][0]).toEqual({ customer_id: WINNER });
    expect(moved.stamps[0][1].irrigation_home_changed_at).toBeInstanceOf(Date);
    expect(moved.stamps[0][1].irrigation_confirmed_fields).toBe('[]');
    expect(moved.result.repointed['property_preferences.irrigation_home_changed_at']).toBe(1);
    const same = await run({ address_line1: '100 MAIN ST', city: 'bradenton', zip: '34205' });
    expect(same.stamps).toEqual([]);
  });

  it('an addressless surviving shell inherits the loser\'s home — no move stamp (codex gh-r25)', async () => {
    const winner = { id: WINNER, first_name: 'A', last_name: 'B', phone: '+19995550003', address_line1: null, city: null, zip: null };
    const loser = { id: LOSER, first_name: 'A', last_name: 'B', phone: '9995550003', address_line1: '200 Oak Ave', city: 'Sarasota', zip: '34236' };
    const { trx } = buildTrx({ winner, loser, fkRows: [{ table_name: 'leads', column_name: 'customer_id' }] });
    const base = trx.getMockImplementation();
    const stamps = [];
    trx.mockImplementation((table) => (table !== 'property_preferences' ? base(table) : makeChain(table, (q) => { if (q.called('update')) stamps.push(q.args('update')[0]); return q.called('update') ? 1 : []; })));
    db.transaction.mockImplementation(async (fn) => fn(trx));
    await dedupe.executeMerge({ winnerId: WINNER, loserId: LOSER, performedBy: 'test' });
    expect(stamps).toEqual([]);
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
          const w = q.args('where')[0];
          if (w.merged_into_promoter_id !== undefined) {
            state.chainFlatten = [w, q.args('update')[0]];
            return 1;
          }
          state.promoterUpdates[w.id] = q.args('update')[0];
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
    // Older aliases chained onto the retiring promoter follow it to the
    // survivor — the /r resolver stays single-hop.
    expect(state.chainFlatten).toEqual([
      { merged_into_promoter_id: 9 },
      { merged_into_promoter_id: 7 },
    ]);
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

  it('defers a payer-changing merge while a combined-visit invoice send is in flight on either side', async () => {
    const Packets = require('../services/visit-completion-packets');
    const inFlight = jest.spyOn(Packets, 'packetInvoiceSendInFlight').mockImplementation(async ({ customerId }) => customerId === WINNER);
    try {
      const { trx } = buildTrx({
        winner: { id: WINNER, first_name: 'A', last_name: 'B', phone: '+19995550003', payer_id: null },
        loser: { id: LOSER, first_name: 'A', last_name: 'B', phone: '9995550003', payer_id: 5 },
        fkRows: FK_ROWS,
      });
      db.transaction.mockImplementation(async (fn) => fn(trx));
      await expect(dedupe.executeMerge({ winnerId: WINNER, loserId: LOSER, performedBy: 'test' }))
        .rejects.toThrow(/surviving record is being sent/);
      // The merged-away side: a self-pay loser absorbed by a payer-linked winner.
      inFlight.mockImplementation(async ({ customerId }) => customerId === LOSER);
      const reverse = buildTrx({
        winner: { id: WINNER, first_name: 'A', last_name: 'B', phone: '+19995550003', payer_id: 5 },
        loser: { id: LOSER, first_name: 'A', last_name: 'B', phone: '9995550003', payer_id: null },
        fkRows: FK_ROWS,
      });
      db.transaction.mockImplementation(async (fn) => fn(reverse.trx));
      await expect(dedupe.executeMerge({ winnerId: WINNER, loserId: LOSER, performedBy: 'test' }))
        .rejects.toThrow(/merged-away record is being sent/);
    } finally {
      inFlight.mockRestore();
    }
  });

  it('withdraws the surviving record\'s packet invoices when the merge inherits a payer', async () => {
    // The in-flight fence above only refuses a send mid-dispatch. An invoice
    // the homeowner already holds a link for needs the withdrawal, and the
    // merge is the ownership writer that must run it (round-24 P1).
    const Packets = require('../services/visit-completion-packets');
    const inFlight = jest.spyOn(Packets, 'packetInvoiceSendInFlight').mockResolvedValue(false);
    const withdraw = jest.spyOn(Packets, 'withdrawPacketInvoicesForOwner').mockResolvedValue(['inv-withdrawn-1']);
    try {
      const { trx } = buildTrx({
        winner: { id: WINNER, first_name: 'A', last_name: 'B', phone: '+19995550003', payer_id: null },
        loser: { id: LOSER, first_name: 'A', last_name: 'B', phone: '9995550003', payer_id: 5 },
        fkRows: FK_ROWS,
      });
      db.transaction.mockImplementation(async (fn) => fn(trx));
      await dedupe.executeMerge({ winnerId: WINNER, loserId: LOSER, performedBy: 'test' });
      // The WINNER, in the merge's own transaction: after the sweep repointed
      // the loser's invoices onto it, its ownership covers them too.
      expect(withdraw).toHaveBeenCalledWith(trx, { customerId: WINNER });

      // A merge that changes nothing about Bill-To runs no withdrawal.
      withdraw.mockClear();
      const { trx: noPayer } = buildTrx({
        winner: { id: WINNER, first_name: 'A', last_name: 'B', phone: '+19995550003', payer_id: null },
        loser: { id: LOSER, first_name: 'A', last_name: 'B', phone: '9995550003', payer_id: null },
        fkRows: FK_ROWS,
      });
      db.transaction.mockImplementation(async (fn) => fn(noPayer));
      await dedupe.executeMerge({ winnerId: WINNER, loserId: LOSER, performedBy: 'test' });
      expect(withdraw).not.toHaveBeenCalled();
    } finally {
      inFlight.mockRestore();
      withdraw.mockRestore();
    }
  });

  it('withdraws the surviving record\'s packet invoices when the WINNER already had the payer', async () => {
    // The opposite merge direction (codex r25 P1): a payer-linked winner
    // absorbing a self-pay loser writes no backfill at all, yet the sweep just
    // repointed the loser's sent/viewed/overdue packet invoices onto a
    // payer-owned record. Gating the withdrawal on `backfills.payer_id` left
    // exactly this direction collectible through the homeowner's link.
    const Packets = require('../services/visit-completion-packets');
    const inFlight = jest.spyOn(Packets, 'packetInvoiceSendInFlight').mockResolvedValue(false);
    const withdraw = jest.spyOn(Packets, 'withdrawPacketInvoicesForOwner').mockResolvedValue(['inv-withdrawn-1']);
    try {
      const { trx } = buildTrx({
        winner: { id: WINNER, first_name: 'A', last_name: 'B', phone: '+19995550003', payer_id: 5 },
        loser: { id: LOSER, first_name: 'A', last_name: 'B', phone: '9995550003', payer_id: null },
        fkRows: FK_ROWS,
      });
      db.transaction.mockImplementation(async (fn) => fn(trx));
      await dedupe.executeMerge({ winnerId: WINNER, loserId: LOSER, performedBy: 'test' });
      expect(withdraw).toHaveBeenCalledWith(trx, { customerId: WINNER });
    } finally {
      inFlight.mockRestore();
      withdraw.mockRestore();
    }
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

  it('accepted_terms_version: a newer (or only) loser version folds into the winner; an older one never downgrades it', async () => {
    const base = { first_name: 'Fay', last_name: 'Manager', email: 'fay@example.com', phone: '+16124074763' };
    // Winner never accepted terms, loser did → winner absorbs the loser's version.
    let built = buildTrx({ winner: { id: WINNER, ...base, accepted_terms_version: null }, loser: { id: LOSER, ...base, phone: '6124074763', accepted_terms_version: 'v2026-09' }, fkRows: FK_ROWS });
    db.transaction.mockImplementation(async (fn) => fn(built.trx));
    let result = await dedupe.executeMerge({ winnerId: WINNER, loserId: LOSER, performedBy: 'test' });
    expect(result.backfills.accepted_terms_version).toBe('v2026-09');
    expect(built.state.backfilled.accepted_terms_version).toBe('v2026-09');

    // Loser accepted a NEWER version → winner moves forward.
    built = buildTrx({ winner: { id: WINNER, ...base, accepted_terms_version: 'v2026-09' }, loser: { id: LOSER, ...base, phone: '6124074763', accepted_terms_version: 'v2027-01' }, fkRows: FK_ROWS });
    db.transaction.mockImplementation(async (fn) => fn(built.trx));
    result = await dedupe.executeMerge({ winnerId: WINNER, loserId: LOSER, performedBy: 'test' });
    expect(result.backfills.accepted_terms_version).toBe('v2027-01');

    // Loser's version is OLDER → winner keeps its own.
    built = buildTrx({ winner: { id: WINNER, ...base, accepted_terms_version: 'v2027-01' }, loser: { id: LOSER, ...base, phone: '6124074763', accepted_terms_version: 'v2026-09' }, fkRows: FK_ROWS });
    db.transaction.mockImplementation(async (fn) => fn(built.trx));
    result = await dedupe.executeMerge({ winnerId: WINNER, loserId: LOSER, performedBy: 'test' });
    expect(result.backfills.accepted_terms_version).toBeUndefined();
  });

  it('contact_role backfills from a loser-only role and never overrides an explicit winner role', async () => {
    // A property-manager duplicate merged into a NULL-role winner must not
    // revert the surviving profile to assumed-owner semantics.
    const winnerNoRole = { id: WINNER, first_name: 'Fay', last_name: 'Manager', email: 'fay@example.com', phone: '+16124074763', contact_role: null };
    const loserManager = { id: LOSER, first_name: 'Fay', last_name: null, email: null, phone: '6124074763', contact_role: 'property_manager' };
    let built = buildTrx({ winner: winnerNoRole, loser: loserManager, fkRows: FK_ROWS });
    db.transaction.mockImplementation(async (fn) => fn(built.trx));
    let result = await dedupe.executeMerge({ winnerId: WINNER, loserId: LOSER, performedBy: 'test' });
    expect(result.backfills.contact_role).toBe('property_manager');
    expect(built.state.backfilled.contact_role).toBe('property_manager');

    // Explicit winner role wins over a differing loser role (backfill only where empty).
    const winnerOwner = { ...winnerNoRole, contact_role: 'owner' };
    const loserTenant = { ...loserManager, contact_role: 'tenant' };
    built = buildTrx({ winner: winnerOwner, loser: loserTenant, fkRows: FK_ROWS });
    db.transaction.mockImplementation(async (fn) => fn(built.trx));
    result = await dedupe.executeMerge({ winnerId: WINNER, loserId: LOSER, performedBy: 'test' });
    expect(result.backfills.contact_role).toBeUndefined();
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

  it('carries a loser account-credit auto-apply opt-out onto an opted-in winner (most-restrictive; its credit moves with it)', async () => {
    const winner = {
      id: WINNER, first_name: 'A', last_name: 'B', phone: '+19995550003',
      autopay_enabled: true, autopay_paused_until: null, auto_apply_account_credit: true,
    };
    const loser = {
      id: LOSER, first_name: 'A', last_name: 'B', phone: '9995550003',
      autopay_enabled: true, autopay_paused_until: null, auto_apply_account_credit: false, account_credits: '40.00',
    };
    const state = { restrictionUpdate: null };
    const trx = jest.fn((table) => makeChain(table, (q) => {
      if (table === 'customers') {
        if (q.called('forUpdate')) return [winner, loser];
        if (q.called('update')) {
          const payload = q.args('update')[0];
          if (payload.auto_apply_account_credit === false) state.restrictionUpdate = payload;
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
    expect(state.restrictionUpdate).toMatchObject({ auto_apply_account_credit: false });
    expect(state.restrictionUpdate.autopay_enabled).toBeUndefined();
    expect(result.repointed['customers.autopay_restrictions']).toBe('auto_apply_account_credit');
    // the reverse (loser opted IN, winner opted OUT) never re-enables
    winner.auto_apply_account_credit = false; loser.auto_apply_account_credit = true; state.restrictionUpdate = null;
    const again = await dedupe.executeMerge({ winnerId: WINNER, loserId: LOSER, performedBy: 'test' });
    expect(state.restrictionUpdate).toBeNull();
    expect(again.repointed['customers.autopay_restrictions']).toBeUndefined();
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
        // The transaction-wide FOR UPDATE lock reads both sides by whereIn
        // and selects only ids; the per-side derivation uses where().
        const w = q.args('where')?.[0];
        if (!w) return [];
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
              // whereIn = the transaction-wide FOR UPDATE lock over both sides.
              const w = q.args('where')?.[0];
              if (!w) return [];
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

  it('refuses legacy-vs-special billing merges when the flipping side has billing history', async () => {
    // Special-mode winner absorbing a legacy loser WITH visits → refuse.
    const a = buildTrx({
      winner: { id: WINNER, first_name: 'A', last_name: 'B', phone: '+19995550003', billing_mode: 'per_application' },
      loser: { id: LOSER, first_name: 'A', last_name: 'B', phone: '9995550003', billing_mode: null },
      fkRows: FK_ROWS,
    });
    a.state.billingArtifacts = { scheduled_services: { id: 'ss-1' } };
    db.transaction.mockImplementation(async (fn) => fn(a.trx));
    await expect(dedupe.executeMerge({ winnerId: WINNER, loserId: LOSER, performedBy: 'test' }))
      .rejects.toThrow(/legacy and special billing modes/);

    // Null-mode winner adopting the loser's special mode with its OWN
    // invoices → refuse (its history would flip cadence).
    const b = buildTrx({
      winner: { id: WINNER, first_name: 'A', last_name: 'B', phone: '+19995550003', billing_mode: null },
      loser: { id: LOSER, first_name: 'A', last_name: 'B', phone: '9995550003', billing_mode: 'annual_prepay' },
      fkRows: FK_ROWS,
    });
    b.state.billingArtifacts = { invoices: { id: 'inv-1' } };
    db.transaction.mockImplementation(async (fn) => fn(b.trx));
    await expect(dedupe.executeMerge({ winnerId: WINNER, loserId: LOSER, performedBy: 'test' }))
      .rejects.toThrow(/legacy and special billing modes/);
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

  it('demotes the loser cards when the winner already has a default payment method, journaling their ORIGINAL flags', async () => {
    const winner = { id: WINNER, first_name: 'A', last_name: 'B', phone: '+19995550003', stripe_customer_id: 'cus_shared' };
    const loser = { id: LOSER, first_name: 'A', last_name: 'B', phone: '9995550003', stripe_customer_id: 'cus_shared' };
    const state = { demoted: null, journal: null, events: [] };
    // A REAL card table: the FK sweep repoints payment_methods.customer_id
    // onto the winner, and every later read sees the moved rows. The
    // demotion reader looks for the LOSER's cards, so a post-sweep
    // derivation finds none and the demotion silently vanishes (pre-push
    // Codex P0) — this harness reproduces that, the old unconditional
    // fixture could not.
    const cards = [
      { id: 'pm-loser-1', customer_id: LOSER, is_default: true, autopay_enabled: true, stripe_customer_id: 'cus_shared' },
      { id: 'pm-loser-2', customer_id: LOSER, is_default: false, autopay_enabled: false, stripe_customer_id: 'cus_shared' },
      { id: 'pm-winner-default', customer_id: WINNER, is_default: true, autopay_enabled: true, stripe_customer_id: 'cus_shared' },
    ];
    const trx = jest.fn((table) => makeChain(table, (q) => {
      if (table === 'customers') {
        if (q.called('forUpdate')) return [winner, loser];
        if (q.called('update')) return 1;
        return [];
      }
      if (table === 'customer_merge_journal') {
        state.journal = q.args('insert')[0];
        return [{ id: 'j1' }];
      }
      if (table === 'payment_methods') {
        const w = q.args('where')?.[0];
        const owned = (id) => cards.filter((c) => c.customer_id === id);
        if (q.called('update') && q.called('whereIn')) {
          state.demoted = { ids: q.args('whereIn')[1], payload: q.args('update')[0] };
          state.events.push('demote');
          return state.demoted.ids.length;
        }
        if (q.called('update')) {
          // The sweep: loser → winner.
          const moving = owned(q.args('where')[1]);
          moving.forEach((c) => { c.customer_id = q.args('update')[0].customer_id; });
          state.events.push('sweep');
          return moving.length;
        }
        if (q.called('first')) {
          return owned(w.customer_id).find((c) => c.is_default) ? { id: 'pm-winner-default' } : undefined;
        }
        if (q.called('whereIn')) return cards.map((c) => ({ id: c.id })); // the FOR UPDATE lock
        if (q.called('select')) {
          const mine = typeof w === 'object' ? owned(w.customer_id) : owned(q.args('where')[1]);
          if (q.args('select')[0] === 'stripe_customer_id') return mine.map((c) => ({ stripe_customer_id: c.stripe_customer_id }));
          // The demotion reader's flag filter is a nested where callback.
          const flagFilter = q._calls.some(([name, args]) => name === 'where' && typeof args[0] === 'function');
          if (flagFilter) return mine.filter((c) => c.is_default || c.autopay_enabled).map((c) => ({ id: c.id, is_default: c.is_default, autopay_enabled: c.autopay_enabled }));
          return mine.map((c) => ({ id: c.id, is_default: c.is_default, autopay_enabled: c.autopay_enabled }));
        }
      }
      if (table === 'referral_promoters' && q.called('first')) return null;
      if (q.called('update')) return 1;
      return [];
    }));
    trx.raw = jest.fn(async () => ({ rows: [{ table_name: 'payment_methods', column_name: 'customer_id' }] }));
    trx.transaction = jest.fn(async (fn) => fn(trx));
    trx.fn = { now: () => 'NOW' };
    db.transaction.mockImplementation(async (fn) => fn(trx));

    const result = await dedupe.executeMerge({ winnerId: WINNER, loserId: LOSER, performedBy: 'test' });
    // The winner's own pre-merge default stays THE default: every loser card
    // arrives demoted from default/autopay.
    expect(state.demoted).not.toBeNull();
    expect(state.demoted.ids).toEqual(['pm-loser-1']);
    expect(state.demoted.payload).toMatchObject({ is_default: false, autopay_enabled: false });
    expect(result.repointed['payment_methods.demoted_defaults']).toBe(1);
    // The demotion is written BEFORE the sweep moves the cards.
    expect(state.events).toEqual(['demote', 'sweep']);
    // The journal keeps each card's PRE-demotion flags so the revert can
    // restore the loser's default/autopay setup exactly.
    const recorded = JSON.parse(state.journal.repointed_ids);
    expect(recorded.payment_method_flags).toEqual({
      'pm-loser-1': { is_default: true, autopay_enabled: true },
      'pm-loser-2': { is_default: false, autopay_enabled: false },
    });
    // r23: the winner's pre-merge invoice/payment id snapshot is captured
    // under the merge's row locks — the undo's transferred-profile gate
    // matches new rows by set difference, never transaction timestamps.
    expect(recorded.winner_premerge_billing_ids).toEqual({ invoices: [], payments: [] });
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
  it('aborts (merges nothing) when the dismissals table is unreadable — fail closed for the writer', async () => {
    installDb((table) => {
      if (table === 'customers') {
        return [
          { id: 'cccccccc-0000-0000-0000-000000000001', first_name: 'D', last_name: 'B', phone: '+16124074763', pipeline_stage: 'new_lead', created_at: '2026-07-08' },
          { id: 'cccccccc-0000-0000-0000-000000000002', first_name: 'D', last_name: null, phone: '6124074763', pipeline_stage: 'new_lead', created_at: '2026-07-09' },
        ];
      }
      if (table === 'customer_duplicate_dismissals') throw new Error('relation unavailable');
      return [];
    });
    const results = await dedupe.runAutoMergeSweep({ performedBy: 'test' });
    expect(results).toEqual({ merged: [], skipped: [], aborted: 'dismissals_unreadable' });
    const { notifyAdmin } = require('../services/notification-service');
    expect(notifyAdmin).not.toHaveBeenCalled();
  });

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

describe('collections_flags merge (codex 2026-08-15 r6)', () => {
  it('registers collections_flags with the release-collisions handler (shared active flags fold, never abort)', () => {
    const { UNIQUE_COLLISION_HANDLERS, repointFlagsReleaseCollisions } = dedupe._test;
    expect(UNIQUE_COLLISION_HANDLERS.collections_flags).toBe(repointFlagsReleaseCollisions);
  });

  it('repointFlagsReleaseCollisions: moves the winner-lacking flag, RELEASES the colliding one (history kept, never dropped)', async () => {
    const { repointFlagsReleaseCollisions } = dedupe._test;
    const state = { updated: [] };
    const trx = jest.fn((table) => makeChain(table, (q) => {
      if (q.called('select')) return [{ id: 'f1' }, { id: 'f2' }];
      if (q.called('update')) {
        const rowId = q.args('where')[0].id;
        const patch = q.args('update')[0];
        if (rowId === 'f2' && !patch.released_at) { const e = new Error('duplicate key'); e.code = '23505'; throw e; }
        state.updated.push({ rowId, patch });
        return 1;
      }
      return [];
    }));
    trx.transaction = jest.fn(async (fn) => fn(trx));
    trx.fn = { now: jest.fn(() => 'CURRENT_TIMESTAMP') };
    const result = await repointFlagsReleaseCollisions(trx, 'collections_flags', 'customer_id', 'W', 'L');
    expect(state.updated).toEqual([
      { rowId: 'f1', patch: { customer_id: 'W' } },
      { rowId: 'f2', patch: { customer_id: 'W', released_at: 'CURRENT_TIMESTAMP' } },
    ]);
    expect(result).toMatch(/moved 1, released 1/);
  });
});

// ---------------------------------------------------------------------------
// duplicatePairEligibility — canonical merge eligibility recheck, reused by
// admin-customer-duplicates.js handleMerge, the IB merge_customers tool, and
// task-context.js's pair authority (never re-derived in any of them).
// ---------------------------------------------------------------------------
describe('duplicatePairEligibility', () => {
  const winner = {
    id: 'bbbbbbbb-0000-0000-0000-000000000001',
    first_name: 'Synthetic', last_name: 'Winner', phone: '+15550100123',
    address_line1: '100 Test Street', zip: '34207',
    // stripe_customer_id pins this row as the cluster winner regardless of
    // created_at tie-break — findDuplicateGroups() picks the strongest
    // business-signal row, not the fixture the test author calls "winner".
    stripe_customer_id: 'cus_winner',
    pipeline_stage: 'active_customer', created_at: '2026-07-08',
  };
  const shellLoser = {
    id: 'bbbbbbbb-0000-0000-0000-000000000002',
    first_name: 'Synthetic', last_name: null, phone: '5550100123',
    address_line1: null, zip: null,
    pipeline_stage: 'new_lead', created_at: '2026-07-09',
  };
  const addressConflictLoser = {
    id: 'bbbbbbbb-0000-0000-0000-000000000003',
    first_name: 'Synthetic', last_name: null, phone: '5550100123',
    address_line1: '999 Different St', zip: '34211',
    pipeline_stage: 'new_lead', created_at: '2026-07-09',
  };
  const strangerLoser = {
    id: 'bbbbbbbb-0000-0000-0000-000000000004',
    first_name: 'Other', last_name: 'Person', phone: '+15550100123',
    address_line1: '200 Different Test Street', zip: '34211',
    pipeline_stage: 'active_customer', created_at: '2026-07-01',
  };

  function router({ customers = [], dismissals = [], blockerRows = {} }) {
    return (table) => {
      if (table === 'customers') return customers;
      if (table === 'customer_duplicate_dismissals') return dismissals;
      return blockerRows[table] || [];
    };
  }

  it('fails CLOSED when the dismissals table is unreadable (pre-push Codex P1): a merge decision never falls open past operator verdicts', async () => {
    const base = router({ customers: [winner, shellLoser] });
    installDb((table) => { if (table === 'customer_duplicate_dismissals') throw new Error('relation unreadable'); return base(table); });
    const result = await dedupe.duplicatePairEligibility(winner.id, shellLoser.id);
    expect(result).toEqual({ eligible: false, code: 'dismissals_unreadable', reason: expect.stringMatching(/could not be read/), candidate: null });
  });

  it('eligible: returns the live candidate with its tier and reasons', async () => {
    installDb(router({ customers: [winner, shellLoser] }));
    const result = await dedupe.duplicatePairEligibility(winner.id, shellLoser.id);
    expect(result).toMatchObject({ eligible: true, code: 'eligible', reason: null });
    expect(result.candidate.tier).toBe('green');
  });

  it('not_in_queue: the pair is not a live candidate under this winner', async () => {
    installDb(router({ customers: [winner, shellLoser] }));
    // A real, unrelated id — never appears as a candidate under `winner`.
    const result = await dedupe.duplicatePairEligibility(winner.id, 'bbbbbbbb-0000-0000-0000-000000000099');
    expect(result).toMatchObject({ eligible: false, code: 'not_in_queue', reason: 'Pair is no longer in the duplicate queue', candidate: null });
  });

  it('not_in_queue: the winner id itself is not a live winner (e.g. it lost its own group)', async () => {
    installDb(router({ customers: [winner, shellLoser] }));
    const result = await dedupe.duplicatePairEligibility(shellLoser.id, winner.id);
    expect(result.eligible).toBe(false);
    expect(result.code).toBe('not_in_queue');
  });

  it('red_pair: different last names at a conflicting address', async () => {
    installDb(router({ customers: [winner, strangerLoser] }));
    const result = await dedupe.duplicatePairEligibility(winner.id, strangerLoser.id);
    expect(result).toMatchObject({ eligible: false, code: 'red_pair' });
    expect(result.candidate.tier).toBe('red');
  });

  it('address_conflict: a positive address_* reason refuses even though the pair is otherwise a live yellow candidate', async () => {
    installDb(router({ customers: [winner, addressConflictLoser] }));
    const result = await dedupe.duplicatePairEligibility(winner.id, addressConflictLoser.id);
    expect(result.eligible).toBe(false);
    expect(result.code).toBe('address_conflict');
    expect(result.candidate.reasons.some((r) => r.startsWith('address_'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// customerFkColumns — FK discovery export, cached per process.
// ---------------------------------------------------------------------------
describe('inheritedAutopayRestrictions (pure rule shared by executeMerge and the IB preview)', () => {
  const NOW = Date.parse('2026-09-10T12:00:00Z');
  it('nothing inherited when the loser is no more restrictive', () => {
    expect(dedupe.inheritedAutopayRestrictions({ autopay_enabled: true, auto_apply_account_credit: true }, { autopay_enabled: true, auto_apply_account_credit: true, autopay_paused_until: '2026-01-01T00:00:00Z' }, NOW)).toEqual({});
  });
  it('loser autopay off, credit opt-out, and a longer future pause (with reason) all carry to the winner', () => {
    expect(dedupe.inheritedAutopayRestrictions(
      { autopay_enabled: true, auto_apply_account_credit: true, autopay_paused_until: '2026-10-01T00:00:00Z' },
      { autopay_enabled: false, auto_apply_account_credit: false, autopay_paused_until: '2026-12-01T00:00:00Z', autopay_pause_reason: 'disputed charge' },
      NOW,
    )).toEqual({ autopay_enabled: false, auto_apply_account_credit: false, autopay_paused_until: '2026-12-01T00:00:00Z', autopay_pause_reason: 'disputed charge' });
  });
  it('a shorter or expired loser pause does not shorten the winner\'s', () => {
    expect(dedupe.inheritedAutopayRestrictions({ autopay_paused_until: '2026-12-01T00:00:00Z' }, { autopay_paused_until: '2026-10-01T00:00:00Z' }, NOW)).toEqual({});
    expect(dedupe.inheritedAutopayRestrictions({}, { autopay_paused_until: '2026-01-01T00:00:00Z', autopay_pause_reason: 'old' }, NOW)).toEqual({});
  });
});

describe('predictWinnerBackfills (pure — the executor\'s rule, disclosed by the IB preview)', () => {
  it('fills empty identity fields, replaces a partial address as a TUPLE and journals the overwritten prior values', () => {
    const winner = { id: 'W', first_name: 'Real', last_name: null, email: null, address_line1: null, city: 'Bradenton', state: 'FL', zip: '34207' };
    const loser = { id: 'L', first_name: 'Unknown', last_name: 'Customer', email: 'stub@example.com', address_line1: '100 Test St', address_line2: null, city: 'Sarasota', state: 'FL', zip: '34231' };
    const { backfills, winnerPriorValues } = dedupe.predictWinnerBackfills(winner, loser);
    expect(backfills).toMatchObject({ last_name: 'Customer', email: 'stub@example.com', address_line1: '100 Test St', address_line2: null, city: 'Sarasota', state: 'FL', zip: '34231' });
    expect(backfills.first_name).toBeUndefined();
    expect(winnerPriorValues).toEqual({ city: 'Bradenton', state: 'FL', zip: '34207' });
  });

  it('carries a loser-side rented-termite-station flag onto the winner with OR semantics — the flag is the only ownership evidence when no stations were ever mapped, and clearing it makes a later cancellation report no_rented_stations (Codex r15 P1)', () => {
    const winner = { id: 'W', termite_stations_rented: false };
    const loser = { id: 'L', termite_stations_rented: true };
    const carried = dedupe.predictWinnerBackfills(winner, loser);
    expect(carried.backfills.termite_stations_rented).toBe(true);
    // The column is NOT NULL, and revertMerge vacates any backfill without a
    // journaled prior to null — so the winner's own `false` must be recorded
    // or the undo throws and rolls back entirely.
    expect(carried.winnerPriorValues.termite_stations_rented).toBe(false);
    // Nothing to carry when the survivor already rents, or when neither does —
    // the backfill must not churn the row or the fingerprint.
    expect(dedupe.predictWinnerBackfills({ id: 'W', termite_stations_rented: true }, loser).backfills.termite_stations_rented).toBeUndefined();
    expect(dedupe.predictWinnerBackfills(winner, { id: 'L', termite_stations_rented: false }).backfills.termite_stations_rented).toBeUndefined();
  });

  it('a street-only winner absorbing a same-street unit-bearing loser keeps the unit; loser-only billing mode + fee and payer transfer', () => {
    const winner = { id: 'W', address_line1: '100 Test St', address_line2: null, billing_mode: null, per_application_fee: null, payer_id: null };
    const loser = { id: 'L', address_line1: '100 Test St Apt 4B', address_line2: null, billing_mode: 'per_application', per_application_fee: '85.00', payer_id: 'payer-1' };
    const { backfills } = dedupe.predictWinnerBackfills(winner, loser);
    expect(backfills.address_line1).toBeUndefined();
    expect(backfills.address_line2).toMatch(/4B/);
    expect(backfills).toMatchObject({ billing_mode: 'per_application', per_application_fee: '85.00', payer_id: 'payer-1' });
  });

  it('a loser-only Stripe profile (or the executor\'s saved-card derivation) transfers; contact slots move slot-wise with their consent stamp only when the winner had none', () => {
    const winner = { id: 'W', stripe_customer_id: null, service_contact_name: null, service_contact_phone: null, service_contact_email: null, service_contact_role: null, service_contacts_consent_at: null };
    const loser = { id: 'L', stripe_customer_id: null, service_contact_name: 'Pat', service_contact_phone: '9415550199', service_contact_email: null, service_contact_role: 'tenant', service_contacts_consent_at: '2026-08-01T00:00:00Z', service_contacts_consent_source: 'portal', service_contacts_consent_text_version: 'v3' };
    const rowOnly = dedupe.predictWinnerBackfills(winner, loser).backfills;
    expect(rowOnly.stripe_customer_id).toBeUndefined();
    expect(rowOnly).toMatchObject({ service_contact_name: 'Pat', service_contact_phone: '9415550199', service_contact_role: 'tenant', service_contacts_consent_at: '2026-08-01T00:00:00Z', service_contacts_consent_source: 'portal', service_contacts_consent_text_version: 'v3' });
    const derived = dedupe.predictWinnerBackfills(winner, loser, { derivedStripeCustomerId: 'cus_derived' }).backfills;
    expect(derived.stripe_customer_id).toBe('cus_derived');
    expect(dedupe.predictWinnerBackfills(winner, { ...loser, stripe_customer_id: 'cus_loser' }).backfills.stripe_customer_id).toBe('cus_loser');
  });

  it('same-account primary handoff promotes the winner; a newer accepted-terms version is absorbed', () => {
    const winner = { id: 'W', account_id: 'acct', is_primary_profile: false, accepted_terms_version: 'v2026-01' };
    const loser = { id: 'L', account_id: 'acct', is_primary_profile: true, accepted_terms_version: 'v2026-08' };
    const { backfills, winnerPriorValues } = dedupe.predictWinnerBackfills(winner, loser);
    expect(backfills).toMatchObject({ is_primary_profile: true, accepted_terms_version: 'v2026-08' });
    expect(winnerPriorValues).toEqual({ accepted_terms_version: 'v2026-01' });
  });
});

describe('predictLoserStateDiscarded (the loser state the merge never copies — Codex r14 P1)', () => {
  it('names the rate, tier, live stage and portal login the archived record carries and the survivor will not, both-sided', () => {
    const winner = { monthly_rate: '98.00', waveguard_tier: null, pipeline_stage: 'active_customer', password_hash: null };
    const loser = { monthly_rate: '122.00', waveguard_tier: 'gold', pipeline_stage: 'won', password_hash: 'x' };
    expect(dedupe.predictLoserStateDiscarded(winner, loser)).toEqual({
      monthly_rate: { loser: 122, winner: 98 },
      membership_tier: { loser: 'gold', winner: null },
      pipeline_stage: { loser: 'won', winner: 'active_customer' },
      portal_login: { loser: true, winner: false },
    });
  });
  it('is null when the loser carries nothing the winner would not keep anyway (same rate, no tier, a lead stage, no login)', () => {
    expect(dedupe.predictLoserStateDiscarded({ monthly_rate: '98', pipeline_stage: 'active_customer' }, { monthly_rate: '98.00', pipeline_stage: 'new_lead' })).toBeNull();
    expect(dedupe.predictLoserStateDiscarded({ monthly_rate: null }, { monthly_rate: '0', waveguard_tier: null })).toBeNull();
  });
});

describe('stableStringify / normalizeDisclosedTimestamps (Codex r15 P1)', () => {
  const { stableStringify, normalizeDisclosedTimestamps } = dedupe._test;
  const d = new Date('2026-03-04T05:06:07.000Z');

  it('serializes a Date as its ISO string instead of {}, at any depth', () => {
    expect(stableStringify(d)).toBe('"2026-03-04T05:06:07.000Z"');
    expect(stableStringify({ a: d })).toBe('{"a":"2026-03-04T05:06:07.000Z"}');
    expect(stableStringify([{ a: d }])).toBe('[{"a":"2026-03-04T05:06:07.000Z"}]');
  });

  it('normalizes Dates through nested objects and arrays and leaves everything else identical', () => {
    expect(normalizeDisclosedTimestamps({ a: [{ b: d }], c: 1, e: null })).toEqual({ a: [{ b: '2026-03-04T05:06:07.000Z' }], c: 1, e: null });
    // Non-plain objects other than Date are returned as-is, never rebuilt
    // into an index map.
    const buf = Buffer.from('x');
    expect(normalizeDisclosedTimestamps({ buf }).buf).toBe(buf);
  });
});

describe('describeMergeEffects (the card\'s disclosure + fingerprint, engine-owned)', () => {
  const FK_ROWS = { rows: [{ table_name: 'invoices', column_name: 'customer_id' }] };
  const winner = { id: 'W', first_name: 'Real', last_name: 'Customer', billing_mode: null, per_application_fee: null, account_credits: '0', address_line1: '100 Test St', email: null };
  const loser = { id: 'L', first_name: 'Unknown', last_name: '', billing_mode: 'per_application', per_application_fee: '85.00', account_credits: '12.50', address_line1: null, email: 'stub@example.com', autopay_enabled: false };
  // `defaults`: { W: true } plants a winner default card; `flagged`:
  // { L: [{ id, is_default, autopay_enabled }] } are the loser cards the
  // demotion reader lists (predictSavedCardDemotions).
  function install(counts = {}, { sessions = {}, cards = {}, defaults = {}, flagged = {}, collisions = {} } = {}) {
    db.raw = jest.fn(async () => FK_ROWS);
    installDb((table, q) => {
      if (table === 'referral_promoters') return null;
      // The collision-fold prediction reads both sides' rows of each
      // unique-keyed table (predictCollisionFolds).
      if (['notification_prefs', 'property_preferences', 'customer_tags', 'conversations'].includes(table)) return collisions[table] || [];
      if (table === 'payment_methods') {
        const owner = q.args('where')[0].customer_id;
        if (q.called('first')) return defaults[owner] ? { id: `${owner}-default` } : null;
        if (q.called('orderBy')) return flagged[owner] || [];
        return (cards[owner] || []).map((id) => ({ stripe_customer_id: id }));
      }
      if (table === 'invoices' && !q.called('count')) return sessions[q.args('where')[0].customer_id] || [];
      if (table === 'customer_plan_rates') return { n: counts.customer_plan_rates || 0 };
      return { n: counts[table] || 0 };
    });
  }
  it('predicts every deterministic collision fold from the current rows — singleton prefs on both sides, shared tags, shared conversation threads — pins them and turns the undo state off (Codex r14 P2)', async () => {
    install({}, { collisions: {
      notification_prefs: [{ customer_id: 'W' }, { customer_id: 'L' }],
      property_preferences: [{ customer_id: 'L' }],
      customer_tags: [{ customer_id: 'W', tag: 'vip' }, { customer_id: 'W', tag: 'lawn' }, { customer_id: 'L', tag: 'vip' }, { customer_id: 'L', tag: 'pets' }],
      conversations: [{ customer_id: 'W', channel: 'sms', our_endpoint_id: 'ep1' }, { customer_id: 'L', channel: 'sms', our_endpoint_id: 'ep1' }, { customer_id: 'L', channel: 'email', our_endpoint_id: null }],
    } });
    const out = await dedupe.describeMergeEffects(db, winner, loser);
    expect(out.financial_effects.predicted_collision_handlers).toEqual(['conversations', 'customer_tags', 'notification_prefs']);
    expect(out.financial_effects.predicted_collision_folds).toEqual({
      notification_prefs: expect.stringMatching(/both records have a row/),
      customer_tags: { shared: ['vip'] },
      conversations: { shared_threads: ['sms:ep1'] },
    });
    expect(out.financial_effects.revertible_from_queue).toBe(false);
    expect(JSON.parse(out.fingerprint).financial_effects.predicted_collision_folds).toEqual(out.financial_effects.predicted_collision_folds);
    // A pref row on ONE side only, tags that do not overlap, threads on different endpoints: nothing folds.
    install({}, { collisions: { property_preferences: [{ customer_id: 'L' }], customer_tags: [{ customer_id: 'W', tag: 'a' }, { customer_id: 'L', tag: 'b' }], conversations: [{ customer_id: 'W', channel: 'sms', our_endpoint_id: 'ep1' }, { customer_id: 'L', channel: 'sms', our_endpoint_id: 'ep2' }] } });
    expect((await dedupe.describeMergeEffects(db, winner, loser)).financial_effects.predicted_collision_handlers).toEqual([]);
  });

  it('renders and pins transferred timestamps as ISO strings — Postgres returns a Date, a Date has no own keys, so it used to serialize as {} in both the card and the fingerprint (Codex r15 P1)', async () => {
    const loserWithConsent = (iso) => ({
      ...loser,
      service_contact_name: 'Tenant',
      service_contacts_consent_at: new Date(iso),
      service_contacts_consent_source: 'portal',
      service_contacts_consent_text_version: 'v3',
    });
    install({});
    const out = await dedupe.describeMergeEffects(db, winner, loserWithConsent('2026-03-04T05:06:07.000Z'));
    expect(out.financial_effects.winner_backfills.service_contacts_consent_at).toBe('2026-03-04T05:06:07.000Z');
    expect(JSON.parse(out.fingerprint).financial_effects.winner_backfills.service_contacts_consent_at).toBe('2026-03-04T05:06:07.000Z');
    // And it MOVES the fingerprint: the bug pinned EVERY Date as the same
    // `{}`, so an edited consent stamp during the pending window read as no
    // change at all.
    install({});
    const later = await dedupe.describeMergeEffects(db, winner, loserWithConsent('2026-03-04T05:06:08.000Z'));
    expect(later.fingerprint).not.toBe(out.fingerprint);
  });

  it('discloses and pins the loser state the merge never copies (Codex r14 P1)', async () => {
    install({});
    const out = await dedupe.describeMergeEffects(db, { ...winner, monthly_rate: '98.00' }, { ...loser, monthly_rate: '122.00', password_hash: 'h' });
    expect(out.financial_effects.loser_state_discarded).toEqual({ monthly_rate: { loser: 122, winner: 98 }, portal_login: { loser: true, winner: false } });
    expect(JSON.parse(out.fingerprint).financial_effects.loser_state_discarded).toEqual(out.financial_effects.loser_state_discarded);
  });

  it('states moving counts, money effects, inherited restrictions, predicted backfills (row-derived, with the Stripe caveat) and the undo state, key-sorted in one fingerprint', async () => {
    install({ invoices: 2, customer_plan_rates: 1 });
    const out = await dedupe.describeMergeEffects(db, winner, loser);
    expect(out.moving).toEqual({ invoices: 2, total_rows: 2 });
    expect(out.financial_effects).toEqual({
      account_credits_moved_to_winner: 12.5,
      billing_mode_adopted_from_loser: 'per_application',
      per_application_fee_adopted_from_loser: 85,
      loser_plan_rate_rows_deleted: 1,
      note_appends: {},
      referral_fold: { loser_enrolled: false },
      autopay_restrictions_inherited: { autopay_enabled: false },
      winner_backfills: { email: 'stub@example.com', billing_mode: 'per_application', per_application_fee: '85.00' },
      stripe_profile_from_saved_cards: null,
      saved_card_profile_conflict: false,
      saved_card_demotions: { winner_has_default: false, cards: [] },
      combined_payment_sessions: { winner: [], loser: [] },
      collection_cases: { available: true, live: [], demoted_to_proposed: [], defers_on_dialing: false },
      loser_state_discarded: null,
      predicted_collision_handlers: [],
      predicted_collision_folds: {},
      revertible_from_queue: expect.stringMatching(/unless the sweep has to fold/),
    });
    const parsed = JSON.parse(out.fingerprint);
    expect(parsed).toEqual({ moving: out.moving, financial_effects: out.financial_effects });
    expect(Object.keys(parsed.financial_effects)).toEqual([...Object.keys(parsed.financial_effects)].sort());
    // Same rows, same answer: the executor recomputes this over its locked rows and compares strings.
    install({ invoices: 2, customer_plan_rates: 1 });
    expect((await dedupe.describeMergeEffects(db, winner, loser)).fingerprint).toBe(out.fingerprint);
    // One more invoice on the loser → a different fingerprint.
    install({ invoices: 3, customer_plan_rates: 1 });
    expect((await dedupe.describeMergeEffects(db, winner, loser)).fingerprint).not.toBe(out.fingerprint);
  });

  it('discloses and pins the loser cards the merge strips of default/autopay when the winner already has a default (Codex r6 P1)', async () => {
    const loserCards = [
      { id: 'pm_l1', is_default: true, autopay_enabled: true },
      { id: 'pm_l2', is_default: false, autopay_enabled: true },
    ];
    install({}, { defaults: { W: true }, flagged: { L: loserCards } });
    const out = await dedupe.describeMergeEffects(db, winner, loser);
    expect(out.financial_effects.saved_card_demotions).toEqual({ winner_has_default: true, cards: loserCards });
    // The same rows → the same pin; a flag flip on one card with the SAME
    // count → a different pin (the executor recomputes under its locks).
    install({}, { defaults: { W: true }, flagged: { L: loserCards } });
    expect((await dedupe.describeMergeEffects(db, winner, loser)).fingerprint).toBe(out.fingerprint);
    install({}, { defaults: { W: true }, flagged: { L: [{ ...loserCards[0], is_default: false }, loserCards[1]] } });
    expect((await dedupe.describeMergeEffects(db, winner, loser)).fingerprint).not.toBe(out.fingerprint);
    // No winner default → nothing is demoted, whatever the loser's flags.
    install({}, { defaults: {}, flagged: { L: loserCards } });
    expect((await dedupe.describeMergeEffects(db, winner, loser)).financial_effects.saved_card_demotions).toEqual({ winner_has_default: false, cards: [] });
  });

  it('discloses and pins the saved-card Stripe profile the winner will adopt and every stamped combined payment session (Codex r4 P1s)', async () => {
    mockStripePis = {
      pi_a: { id: 'pi_a', status: 'requires_payment_method', metadata: { combined_allocation: '1' } },
      pi_b: { id: 'pi_b', status: 'requires_confirmation', metadata: { invoice_id: 'inv-2' } },
    };
    install({}, {
      cards: { W: ['cus_shared'], L: ['cus_shared'] },
      sessions: { L: [{ id: 'inv-2', invoice_number: 'INV-2', stripe_payment_intent_id: 'pi_b' }, { id: 'inv-1', invoice_number: 'INV-1', stripe_payment_intent_id: 'pi_a' }] },
    });
    const out = await dedupe.describeMergeEffects(db, winner, loser);
    expect(out.financial_effects.stripe_profile_from_saved_cards).toEqual({ stripe_customer_id: 'cus_shared', from: 'both' });
    expect(out.financial_effects.winner_backfills.stripe_customer_id).toBe('cus_shared'); // the backfill prediction uses the REAL derivation
    expect(out.financial_effects.saved_card_profile_conflict).toBe(false);
    expect(out.financial_effects.combined_payment_sessions).toEqual({
      winner: [],
      // Per-intent outcome from the same Stripe read the release makes (r5 P1). pi_b is a single-invoice checkout — kept on the WINNER, but this is
      // the LOSER's, and its PI metadata names the record about to be retired, so the merge cancels it too (r7 P1).
      loser: [{ invoice_id: 'inv-1', invoice_number: 'INV-1', payment_intent_id: 'pi_a', outcome: 'cancel' }, { invoice_id: 'inv-2', invoice_number: 'INV-2', payment_intent_id: 'pi_b', outcome: 'cancel_single_invoice' }],
    });
    // The same session moving to money-in-flight → a different fingerprint (the outcome is pinned, not just the id).
    mockStripePis.pi_a = { ...mockStripePis.pi_a, status: 'processing' };
    install({}, { cards: { W: ['cus_shared'], L: ['cus_shared'] }, sessions: { L: [{ id: 'inv-2', invoice_number: 'INV-2', stripe_payment_intent_id: 'pi_b' }, { id: 'inv-1', invoice_number: 'INV-1', stripe_payment_intent_id: 'pi_a' }] } });
    const moved = await dedupe.describeMergeEffects(db, winner, loser);
    expect(moved.financial_effects.combined_payment_sessions.loser[0].outcome).toBe('in_flight');
    expect(moved.fingerprint).not.toBe(out.fingerprint);
    // An unverifiable intent fails the preview closed — no card.
    mockStripePis = {};
    install({}, { cards: { W: ['cus_shared'], L: ['cus_shared'] }, sessions: { L: [{ id: 'inv-1', invoice_number: 'INV-1', stripe_payment_intent_id: 'pi_a' }] } });
    await expect(dedupe.describeMergeEffects(db, winner, loser)).rejects.toThrow(/Could not verify payment session pi_a/);
    mockStripePis = { pi_a: { id: 'pi_a', status: 'requires_payment_method', metadata: { combined_allocation: '1' } }, pi_b: { id: 'pi_b', status: 'requires_confirmation', metadata: {} } };
    // A new session on the loser → a different fingerprint.
    install({}, { cards: { W: ['cus_shared'], L: ['cus_shared'] }, sessions: { L: [{ id: 'inv-1', invoice_number: 'INV-1', stripe_payment_intent_id: 'pi_a' }] } });
    expect((await dedupe.describeMergeEffects(db, winner, loser)).fingerprint).not.toBe(out.fingerprint);
    // Cards on a third profile: the executor would refuse — the disclosure says so.
    install({}, { cards: { W: ['cus_other'], L: ['cus_shared'] } });
    expect((await dedupe.describeMergeEffects(db, winner, loser)).financial_effects.saved_card_profile_conflict).toBe(true);
  });

  it('cancels the single-invoice checkouts the merge invalidates — the loser\'s always, the winner\'s only on a payer transfer (Codex r7 P1)', async () => {
    // A single-invoice PI is NOT a combined session, so nothing in its
    // metadata says who owns it except waves_customer_id — which keeps
    // naming the record the merge is about to retire.
    mockStripePis = {
      pi_l: { id: 'pi_l', status: 'requires_confirmation', metadata: { invoice_id: 'inv-l' } },
      pi_w: { id: 'pi_w', status: 'requires_confirmation', metadata: { invoice_id: 'inv-w' } },
    };
    const sessions = {
      W: [{ id: 'inv-w', invoice_number: 'INV-W', stripe_payment_intent_id: 'pi_w' }],
      L: [{ id: 'inv-l', invoice_number: 'INV-L', stripe_payment_intent_id: 'pi_l' }],
    };
    // Self-pay merge (neither side has a payer): only the LOSER's checkout
    // is invalidated — a save-card success on it would mirror consent and
    // autopay onto the archived customer.
    install({}, { sessions });
    const selfPay = await dedupe.describeMergeEffects(db, winner, loser);
    expect(selfPay.financial_effects.combined_payment_sessions.loser[0].outcome).toBe('cancel_single_invoice');
    expect(selfPay.financial_effects.combined_payment_sessions.winner[0].outcome).toBe('kept_single_invoice');
    // A merge that transfers the loser's third-party payer onto a
    // blank-payer winner invalidates the SURVIVOR's self-pay checkout too:
    // the homeowner would otherwise pay a debt that now belongs to the payer.
    install({}, { sessions });
    const payerMove = await dedupe.describeMergeEffects(db, { ...winner }, { ...loser, payer_id: 'payer-1' });
    expect(payerMove.financial_effects.combined_payment_sessions.winner[0].outcome).toBe('cancel_single_invoice');
    // A winner that ALREADY has that payer changes nothing about who pays,
    // so its open checkout survives.
    install({}, { sessions });
    const samePayer = await dedupe.describeMergeEffects(db, { ...winner, payer_id: 'payer-1' }, { ...loser, payer_id: 'payer-1' });
    expect(samePayer.financial_effects.combined_payment_sessions.winner[0].outcome).toBe('kept_single_invoice');
    // Money already moving is never cancelled, single-invoice or not — it
    // is reported so the executor defers.
    mockStripePis.pi_l = { ...mockStripePis.pi_l, status: 'processing' };
    install({}, { sessions });
    expect((await dedupe.describeMergeEffects(db, winner, loser)).financial_effects.combined_payment_sessions.loser[0].outcome).toBe('in_flight');
    // Already cancelled in Stripe → only the stamp cleanup, never a second
    // cancel promised on the card.
    mockStripePis.pi_l = { ...mockStripePis.pi_l, status: 'canceled' };
    install({}, { sessions });
    expect((await dedupe.describeMergeEffects(db, winner, loser)).financial_effects.combined_payment_sessions.loser[0].outcome).toBe('stamps_cleared');
  });

  it('fingerprints deterministically: nested keys sorted at every depth, and one PaymentIntent across several invoices in a fixed order (Codex r9 P2)', async () => {
    // A combined session is stamped onto EVERY invoice in its allocation, so
    // the same PI id comes back once per invoice. Without a unique
    // tie-breaker the two reads (unlocked card, locked recheck) could order
    // those rows differently and the exact string compare would refuse a
    // merge nothing had touched.
    mockStripePis = { pi_a: { id: 'pi_a', status: 'requires_payment_method', metadata: { combined_allocation: '{"x":1}' } } };
    const rows = [
      { id: 'inv-b', invoice_number: 'INV-B', stripe_payment_intent_id: 'pi_a' },
      { id: 'inv-a', invoice_number: 'INV-A', stripe_payment_intent_id: 'pi_a' },
    ];
    install({}, { sessions: { L: rows } });
    const first = await dedupe.describeMergeEffects(db, winner, loser);
    expect(first.financial_effects.combined_payment_sessions.loser.map((sess) => sess.invoice_id)).toEqual(['inv-a', 'inv-b']);
    // The SAME rows handed back in the opposite order fingerprint identically.
    install({}, { sessions: { L: [...rows].reverse() } });
    expect((await dedupe.describeMergeEffects(db, winner, loser)).fingerprint).toBe(first.fingerprint);
    // Keys are sorted at every depth, not just the two top-level objects:
    // collection_cases is built { available, live, demoted_to_proposed,
    // defers_on_dialing } and must serialize alphabetically.
    expect(first.fingerprint).toContain('"collection_cases":{"available":true,"defers_on_dialing"');
    // ...and the string still round-trips to exactly what the card shows.
    expect(JSON.parse(first.fingerprint)).toEqual({ moving: first.moving, financial_effects: first.financial_effects });
  });

  it('re-derives the saved-card demotion set at write time and refuses if it moved since the card (pre-push audit P1)', async () => {
    // The early snapshot cannot see a card INSERTED mid-merge (no row to
    // lock), and applying a stale id list would leave the winner with two
    // default/autopay cards — the exact thing this demotion prevents.
    const src = require('fs').readFileSync(require.resolve('../services/customer-dedupe.js'), 'utf8');
    // The write applies the FRESH set, never the snapshot.
    expect(src).toContain("const demotionsNow = await predictSavedCardDemotions(trx, winnerId, loserId);");
    expect(src).toContain(".whereIn('id', demotionsNow.cards.map((c) => c.id))");
    expect(src).not.toContain(".whereIn('id', savedCardDemotions.cards.map((c) => c.id))");
    // A pinned merge whose demotion set moved refuses with previewChanged,
    // and it does so BEFORE the Stripe fence (nothing external yet).
    const body = src.split('const demotionsNow = await predictSavedCardDemotions')[1];
    expect(body.indexOf('previewChanged = true')).toBeLessThan(body.indexOf('planStampedSessionRelease'));
    // Both sides' cards are locked for the life of the transaction.
    expect(src).toContain("await trx('payment_methods').whereIn('customer_id', [winnerId, loserId]).orderBy('id').forUpdate().select('id');");
  });

  it('locks both promoter rows under the executor transaction before fingerprinting the fold, and re-reads them (Codex r10 P1)', async () => {
    // Referral writes take neither the customer nor the pair lock (a unique
    // click increments total_clicks straight off the row), so the balances
    // the card states must be read under FOR UPDATE and held to the fold.
    const promoters = {
      'promo-L': { id: 'promo-L', customer_id: 'L', total_clicks: 4 },
      'promo-W': { id: 'promo-W', customer_id: 'W', total_clicks: 9 },
    };
    const calls = [];
    const trxDb = jest.fn((table) => {
      const q = makeChain(table, (qq) => {
        calls.push({ table, locked: qq.called('forUpdate'), where: qq.args('where')?.[0] });
        if (table !== 'referral_promoters') return { n: 0 };
        const w = qq.args('where')?.[0] || {};
        if (qq.called('whereIn')) return [{ id: 'promo-L' }, { id: 'promo-W' }];
        if (w.customer_id === 'L') return promoters['promo-L'];
        if (w.customer_id === 'W') return promoters['promo-W'];
        if (w.id) return promoters[w.id];
        return null;
      });
      return q;
    });
    trxDb.isTransaction = true;
    trxDb.raw = jest.fn(async () => FK_ROWS);
    const out = await dedupe.previewMergeEffects(trxDb, 'W', 'L');
    expect(out.referral).toMatchObject({ loser_enrolled: true, folded_into_winner_promoter: true, loser_promoter_id: 'promo-L', winner_promoter_id: 'promo-W' });
    // Exactly one id-ordered FOR UPDATE over both promoter rows...
    const locking = calls.filter((c) => c.table === 'referral_promoters' && c.locked);
    expect(locking).toHaveLength(1);
    // ...and the rows are re-read AFTER it, not trusted from before.
    const lockIndex = calls.findIndex((c) => c.locked);
    expect(calls.slice(lockIndex + 1).filter((c) => c.table === 'referral_promoters' && c.where?.id)).toHaveLength(2);
  });

  it('does not take row locks on the unlocked card read (no transaction, nothing to hold)', async () => {
    install({});
    const seen = [];
    const plain = jest.fn((table) => makeChain(table, (q) => {
      seen.push(q.called('forUpdate'));
      return table === 'referral_promoters' ? null : { n: 0 };
    }));
    plain.raw = jest.fn(async () => FK_ROWS);
    await dedupe.previewMergeEffects(plain, 'W', 'L');
    expect(seen.some(Boolean)).toBe(false);
  });

  it('discloses and pins the non-FK rewrites the row sweep cannot see (Codex r9 P2)', async () => {
    // jsonb-embedded ids and trigger-id identities: not FK columns, so the
    // sweep's counts never mention them, yet the executor rewrites them.
    const movedHome = { ...loser, address_line1: '900 Other Ave' };
    const route = (counts) => (table, q) => {
      if (table === 'referral_promoters') return null;
      if (table === 'payment_methods') return q.called('first') ? null : [];
      if (['notification_prefs', 'property_preferences', 'customer_tags', 'conversations'].includes(table)) return [];
      if (table === 'invoices' && !q.called('count')) return [];
      if (table === 'customer_plan_rates') return { n: 0 };
      return { n: counts[table] || 0 };
    };
    db.raw = jest.fn(async () => FK_ROWS);
    installDb(route({ scheduled_services: 3, call_log: 2, email_messages: 1 }));
    const out = await dedupe.describeMergeEffects(db, winner, movedHome);
    expect(out.moving.non_fk_rewrites).toEqual({
      'scheduled_services.service_address_stamp': 3,
      'call_log.customer_link_override': 2,
      'email_messages.trigger_event_id': 1,
      // winner '100 Test St' vs loser '900 Other Ave' — different homes.
      'property_preferences.irrigation_home_changed_at': 'stamped',
    });
    // Pinned: it is inside `moving`, which the fingerprint covers, so a row
    // added during the pending window invalidates the approval.
    expect(JSON.parse(out.fingerprint).moving.non_fk_rewrites['call_log.customer_link_override']).toBe(2);
    const before = out.fingerprint;
    // One hand-linked call appears during the pending window.
    installDb(route({ scheduled_services: 3, call_log: 3, email_messages: 1 }));
    expect((await dedupe.describeMergeEffects(db, winner, movedHome)).fingerprint).not.toBe(before);
    // An addressless loser is not a different home and has no visits to stamp.
    install({});
    const quiet = await dedupe.describeMergeEffects(db, winner, loser);
    expect(quiet.moving.non_fk_rewrites).toBeUndefined();
  });

  it('discloses and pins the CRM / technician notes the merge appends onto the winner (Codex r7 P2)', async () => {
    const withNotes = { ...loser, crm_notes: 'Gate code 4417', technician_notes: 'Dog in the back yard' };
    install({});
    const out = await dedupe.describeMergeEffects(db, { ...winner, crm_notes: 'Prefers morning' }, withNotes);
    expect(out.financial_effects.note_appends).toEqual({
      crm_notes: 'Prefers morning\n\n[From merged duplicate L]: Gate code 4417',
      technician_notes: 'Dog in the back yard',
    });
    // Editing the loser's notes during the pending window moves the pin.
    install({});
    const edited = await dedupe.describeMergeEffects(db, { ...winner, crm_notes: 'Prefers morning' }, { ...withNotes, technician_notes: 'Dog in the back yard — muzzle' });
    expect(edited.fingerprint).not.toBe(out.fingerprint);
    // Text the winner already carries is not re-appended, so the card does
    // not claim a change that will not happen.
    install({});
    const already = await dedupe.describeMergeEffects(db, { ...winner, technician_notes: 'Note: Dog in the back yard today' }, { ...loser, technician_notes: 'Dog in the back yard' });
    expect(already.financial_effects.note_appends).toEqual({});
  });
});

describe('dbLevelMergeConflict (the executor\'s DB-dependent refusals, shared with the preview — Codex r7 P2)', () => {
  const winner = { id: 'W', billing_mode: null, account_id: null };
  const loser = { id: 'L', billing_mode: 'per_application', account_id: null };
  function install({ artifacts = {}, sibling = null } = {}) {
    installDb((table, q) => {
      if (table === 'customers') return sibling;
      return artifacts[q.args('where')[0].customer_id] ? { id: 'row-1' } : null;
    });
  }

  it('refuses a legacy/special billing-mode pair only when the flipping side has live billing history', async () => {
    // The winner is the flipping side (null mode adopting per_application).
    install({ artifacts: { W: true } });
    expect(await dedupe.dbLevelMergeConflict(db, winner, loser)).toEqual({
      code: 'billing_mode_history_conflict',
      message: expect.stringMatching(/legacy and special billing modes/),
    });
    // History on the OTHER side does not flip anyone's cadence.
    install({ artifacts: { L: true } });
    expect(await dedupe.dbLevelMergeConflict(db, winner, loser)).toBeNull();
    // Same mode on both sides is not a cadence flip at all.
    install({ artifacts: { W: true, L: true } });
    expect(await dedupe.dbLevelMergeConflict(db, { ...winner, billing_mode: 'per_application' }, loser)).toBeNull();
  });

  it('refuses a loser whose multi-property account still has other live members', async () => {
    install({ sibling: { id: 'sibling-1' } });
    expect(await dedupe.dbLevelMergeConflict(db, { ...winner, billing_mode: 'per_application' }, { ...loser, account_id: 'acct-9' })).toEqual({
      code: 'multi_property_account_conflict',
      message: expect.stringMatching(/multi-property account/),
    });
    // No siblings left → nothing is stranded.
    install({ sibling: null });
    expect(await dedupe.dbLevelMergeConflict(db, { ...winner, billing_mode: 'per_application' }, { ...loser, account_id: 'acct-9' })).toBeNull();
    // Same account on both sides is not a multi-property group.
    install({ sibling: { id: 'sibling-1' } });
    expect(await dedupe.dbLevelMergeConflict(db, { ...winner, billing_mode: 'per_application', account_id: 'acct-9' }, { ...loser, account_id: 'acct-9' })).toBeNull();
  });
});

describe('previewCollectionCaseReconciliation (the executor\'s reconcile rule, disclosed and pinned — Codex r5 P1)', () => {
  const FK_ROWS = { rows: [{ table_name: 'invoices', column_name: 'customer_id' }] };
  const winner = { id: 'W', first_name: 'Real', last_name: 'Customer', account_credits: '0' };
  const loser = { id: 'L', first_name: 'Unknown', last_name: '', account_credits: '0' };
  function install() {
    db.raw = jest.fn(async () => FK_ROWS);
    installDb((table, q) => {
      if (table === 'referral_promoters') return null;
      if (table === 'payment_methods') return [];
      if (['notification_prefs', 'property_preferences', 'customer_tags', 'conversations'].includes(table)) return [];
      if (table === 'invoices' && !q.called('count')) return [];
      return { n: 0 };
    });
  }
  it('plans BOTH sides before cancelling anything, so a deferring in-flight session never leaves a cancelled checkout behind (Codex r11 P1)', async () => {
    // The merge aborts on a loser-side in-flight session. If the winner's
    // cancellable checkout had already been cancelled in Stripe, the
    // rollback could not undo it — the invoice would point at a dead
    // payment link on a merge that never happened.
    const pay = require('../services/pay-combined');
    const order = [];
    const planSpy = jest.spyOn(pay, 'planStampedSessionRelease').mockImplementation(async (_db, rows) => {
      const side = rows[0]?.side;
      order.push(`plan:${side}`);
      return { intents: [{ piId: `pi_${side}`, outcome: side === 'loser' ? 'in_flight' : 'cancel' }], inFlight: side === 'loser' ? 1 : 0 };
    });
    const applySpy = jest.spyOn(pay, 'applyStampedSessionRelease').mockImplementation(async (_db, plan) => {
      order.push(`apply:${plan.intents[0].piId}`);
      return { released: 1, inFlight: plan.inFlight };
    });
    try {
      // Both sides are planned; the loser's in-flight verdict aborts before
      // either apply runs.
      const plans = [
        await pay.planStampedSessionRelease(null, [{ side: 'winner' }]),
        await pay.planStampedSessionRelease(null, [{ side: 'loser' }]),
      ];
      expect(order).toEqual(['plan:winner', 'plan:loser']);
      expect(plans[1].inFlight).toBe(1);
      expect(applySpy).not.toHaveBeenCalled();
      // The executor's fence reads exactly this way: every plan first, the
      // defer checks next, applies last.
      const src = require('fs').readFileSync(require.resolve('../services/customer-dedupe.js'), 'utf8');
      const fence = src.split('const winnerPlan = await PayCombined.planStampedSessionRelease')[1].split('if (Object.keys(backfills).length)')[0];
      expect(fence.indexOf('loserPlan.inFlight')).toBeLessThan(fence.indexOf('applyStampedSessionRelease'));
      expect(fence.indexOf('winnerPlan.inFlight')).toBeLessThan(fence.indexOf('applyStampedSessionRelease'));
    } finally {
      planSpy.mockRestore();
      applySpy.mockRestore();
    }
  });

  it('the pair adjudication lock folds UUID case, so an uppercase dismissal and a lowercase merge take the SAME lock (Codex r10 P1)', async () => {
    const keys = [];
    const trx = { raw: jest.fn(async (_sql, bindings) => { keys.push(bindings[0]); return { rows: [] }; }) };
    await dedupe.acquirePairAdjudicationLock(trx, 'A1B2C3D4-0000-4000-8000-00000000000F', 'b0000000-0000-4000-8000-000000000001');
    await dedupe.acquirePairAdjudicationLock(trx, 'a1b2c3d4-0000-4000-8000-00000000000f', 'B0000000-0000-4000-8000-000000000001');
    // ...and in the opposite argument order, since the key is sorted.
    await dedupe.acquirePairAdjudicationLock(trx, 'b0000000-0000-4000-8000-000000000001', 'A1B2C3D4-0000-4000-8000-00000000000F');
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toBe('customer-duplicate-pair:a1b2c3d4-0000-4000-8000-00000000000f:b0000000-0000-4000-8000-000000000001');
  });

  it('surplusApprovedCollectionCases is the executor rule: newest approval survives, all revert beside a dialing/held row', () => {
    const a1 = { id: 'c1', current_state: 'approved', case_version: 3 };
    const a2 = { id: 'c2', current_state: 'approved', case_version: 1 };
    expect(dedupe.surplusApprovedCollectionCases([a1, a2])).toEqual([a2]);
    expect(dedupe.surplusApprovedCollectionCases([a1])).toEqual([]);
    expect(dedupe.surplusApprovedCollectionCases([{ id: 'h', current_state: 'held', case_version: 1 }, a1, a2])).toEqual([a1, a2]);
  });
  it('orders live cases the SAME way in the preview and the executor, so a tied approved_at cannot revoke the approval the card promised to keep (pre-push Codex P1)', async () => {
    // surplusApprovedCollectionCases keeps the FIRST row and reverts the
    // rest, so the two sides must agree on "first" — on an approved_at tie
    // only the unique id decides, and the fingerprint matches either way.
    const orderOf = (calls) => calls.filter(([m]) => m === 'orderBy').map(([, args]) => args.join(' '));
    const seen = [];
    db.raw = jest.fn(async () => FK_ROWS);
    db.mockImplementation((table) => {
      const q = makeChain(table, () => (table === 'customer_plan_rates' ? { n: 0 } : { n: 0 }));
      if (table === 'collection_cases') seen.push(q);
      return q;
    });
    COLLECTION_CASES_ROWS = [
      { id: 'c-b', customer_id: 'W', current_state: 'approved', case_version: 1 },
      { id: 'c-a', customer_id: 'W', current_state: 'approved', case_version: 1 },
    ];
    await dedupe.previewCollectionCaseReconciliation(db, 'W', 'L');
    expect(orderOf(seen[0]._calls)).toEqual(['approved_at desc', 'id']);
    // The executor's own query, read from the source it shares with nobody:
    // both orderBy clauses must be present, in the same order.
    const executorQuery = require('fs').readFileSync(require.resolve('../services/customer-dedupe.js'), 'utf8')
      .split("const liveCases = await sp('collection_cases')")[1].split('.select(')[0];
    expect(executorQuery).toContain(".orderBy('approved_at', 'desc')");
    expect(executorQuery).toContain(".orderBy('id')");
  });

  it('states every live case with state + version, the approvals the merge revokes, and a dialing defer; a new approval in the pending window changes the fingerprint', async () => {
    COLLECTION_CASES_ROWS = [
      { id: 'c-w', customer_id: 'W', current_state: 'approved', case_version: 4 },
      { id: 'c-l', customer_id: 'L', current_state: 'approved', case_version: 2 },
    ];
    install();
    const out = await dedupe.describeMergeEffects(db, winner, loser);
    expect(out.financial_effects.collection_cases).toEqual({
      available: true,
      live: [{ id: 'c-w', side: 'winner', state: 'approved', case_version: 4 }, { id: 'c-l', side: 'loser', state: 'approved', case_version: 2 }],
      demoted_to_proposed: ['c-l'],
      defers_on_dialing: false,
    });
    expect(JSON.parse(out.fingerprint).financial_effects.collection_cases.demoted_to_proposed).toEqual(['c-l']);
    // The loser's case was 'proposed' at card time and got approved since → different fingerprint (the executor refuses with previewChanged).
    COLLECTION_CASES_ROWS = [{ id: 'c-w', customer_id: 'W', current_state: 'approved', case_version: 4 }];
    install();
    const before = await dedupe.describeMergeEffects(db, winner, loser);
    expect(before.financial_effects.collection_cases.demoted_to_proposed).toEqual([]);
    expect(before.fingerprint).not.toBe(out.fingerprint);
    // A held row beside approvals: every approval reverts. A dialing row: the merge defers.
    COLLECTION_CASES_ROWS = [{ id: 'h', customer_id: 'L', current_state: 'held', case_version: 1 }, { id: 'c-w', customer_id: 'W', current_state: 'approved', case_version: 4 }];
    install();
    expect((await dedupe.describeMergeEffects(db, winner, loser)).financial_effects.collection_cases.demoted_to_proposed).toEqual(['c-w']);
    COLLECTION_CASES_ROWS = [{ id: 'd', customer_id: 'W', current_state: 'dialing', case_version: 1 }];
    install();
    expect((await dedupe.describeMergeEffects(db, winner, loser)).financial_effects.collection_cases.defers_on_dialing).toBe(true);
  });
  it('an absent table reads as unavailable; any other read error fails the preview closed (as the executor\'s reconcile does)', async () => {
    COLLECTION_CASES_ERROR = Object.assign(new Error('relation "collection_cases" does not exist'), { code: '42P01' });
    install();
    expect((await dedupe.describeMergeEffects(db, winner, loser)).financial_effects.collection_cases).toEqual({ available: false, live: [], demoted_to_proposed: [], defers_on_dialing: false });
    COLLECTION_CASES_ERROR = Object.assign(new Error('statement timeout'), { code: '57014' });
    install();
    await expect(dedupe.describeMergeEffects(db, winner, loser)).rejects.toThrow(/statement timeout/);
  });
});

describe('deriveSavedCardStripeCustomer (shared by the executor and the preview)', () => {
  const rowsFor = (cards) => (table, q) => (table === 'payment_methods' ? (cards[q.args('where')[0].customer_id] || []).map((id) => ({ stripe_customer_id: id })) : []);
  it('no foreign cards → nothing derived, no conflict', async () => {
    installDb(rowsFor({ W: ['cus_w'] }));
    expect(await dedupe.deriveSavedCardStripeCustomer(db, { id: 'W', stripe_customer_id: 'cus_w' }, { id: 'L' })).toEqual({ derivedStripeCustomerId: null, stripeDerivedFrom: null, conflict: false });
  });
  it('neither row names a profile, the cards agree on one → derived, with whose cards identified it', async () => {
    installDb(rowsFor({ L: ['cus_x'] }));
    expect(await dedupe.deriveSavedCardStripeCustomer(db, { id: 'W' }, { id: 'L' })).toEqual({ derivedStripeCustomerId: 'cus_x', stripeDerivedFrom: 'loser', conflict: false });
    installDb(rowsFor({ W: ['cus_x'], L: ['cus_x'] }));
    expect((await dedupe.deriveSavedCardStripeCustomer(db, { id: 'W' }, { id: 'L' })).stripeDerivedFrom).toBe('both');
  });
  it('cards on a profile other than the survivor\'s, or on two profiles → conflict', async () => {
    installDb(rowsFor({ L: ['cus_other'] }));
    expect((await dedupe.deriveSavedCardStripeCustomer(db, { id: 'W', stripe_customer_id: 'cus_w' }, { id: 'L' })).conflict).toBe(true);
    installDb(rowsFor({ W: ['cus_a'], L: ['cus_b'] }));
    expect((await dedupe.deriveSavedCardStripeCustomer(db, { id: 'W' }, { id: 'L' })).conflict).toBe(true);
  });
});

describe('previewMergeEffects (shared merge-effect reader)', () => {
  const FK_ROWS = { rows: [
    { table_name: 'scheduled_services', column_name: 'customer_id' },
    { table_name: 'invoices', column_name: 'customer_id' },
    { table_name: 'sms_log', column_name: 'customer_id' },
    { table_name: 'customer_merge_journal', column_name: 'winner_customer_id' }, // repoint-excluded
  ] };
  const PROMOTER_TABLES = ['referrals', 'referral_invites', 'referral_clicks', 'referral_payouts'];

  it('counts the FK sweep (information_schema once, cached, excluded tables dropped) + polymorphic pointers; a failing table is unknown, zero counts drop', async () => {
    db.raw = jest.fn(async () => FK_ROWS);
    const counts = { scheduled_services: 3, sms_log: 5, notifications: 2 };
    installDb((table, q) => {
      if (table === 'invoices') throw new Error('relation "invoices" is unreadable');
      if (table === 'referral_promoters') return null; // not enrolled
      return { n: counts[table] || 0 };
    });
    const out = await dedupe.previewMergeEffects(db, 'W', 'L');
    expect(out.moving).toEqual({ scheduled_services: 3, invoices: 'unknown', sms_log: 5, 'notifications.recipient_id': 2, total_rows: 10 });
    expect(out.referral).toEqual({ loser_enrolled: false });
    expect(db.raw).toHaveBeenCalledTimes(1);
    await dedupe.previewMergeEffects(db, 'W', 'L');
    expect(db.raw).toHaveBeenCalledTimes(1); // cached — no second information_schema query
  });

  it('reads the referral fold through the executor\'s own counter list when both customers are enrolled', async () => {
    db.raw = jest.fn(async () => FK_ROWS);
    const loserPromoter = { id: 'p-loser', available_balance_cents: 2500, total_clicks: 4, total_paid_out_cents: 0 };
    installDb((table, q) => {
      if (table === 'referral_promoters') return q.args('where')[0].customer_id === 'L' ? loserPromoter : { id: 'p-winner' };
      if (PROMOTER_TABLES.includes(table)) {
        expect(q.args('where')[0]).toEqual({ promoter_id: 'p-loser' });
        return { n: table === 'referral_clicks' ? 4 : 0 };
      }
      return { n: 0 };
    });
    const out = await dedupe.previewMergeEffects(db, 'W', 'L');
    expect(out.moving).toEqual({ total_rows: 0 });
    expect(out.referral).toEqual({
      loser_enrolled: true, folded_into_winner_promoter: true, loser_promoter_id: 'p-loser', winner_promoter_id: 'p-winner',
      balances_added: { available_balance_cents: 2500, total_clicks: 4 },
      promoter_rows: { referrals: 0, referral_invites: 0, referral_clicks: 4, referral_payouts: 0 },
    });
    expect(dedupe.REFERRAL_FOLD_COUNTERS).toEqual(expect.arrayContaining(['available_balance_cents', 'pending_earnings_cents', 'total_clicks']));
  });

  it('loser enrolled, winner not: no fold — the enrollment row repoints unchanged', async () => {
    db.raw = jest.fn(async () => FK_ROWS);
    installDb((table, q) => {
      if (table === 'referral_promoters') return q.args('where')[0].customer_id === 'L' ? { id: 'p-loser', available_balance_cents: 900 } : null;
      return { n: 0 };
    });
    const out = await dedupe.previewMergeEffects(db, 'W', 'L');
    expect(out.referral).toMatchObject({ loser_enrolled: true, folded_into_winner_promoter: false, loser_promoter_id: 'p-loser', winner_promoter_id: null, balances_added: {} });
  });
});
