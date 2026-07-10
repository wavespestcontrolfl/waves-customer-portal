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
  mergeSingletonPrefRow, resetFkCache,
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
      winner: { id: WINNER, stripe_customer_id: 'cus_a' },
      loser: { id: LOSER, stripe_customer_id: 'cus_b' },
      fkRows: FK_ROWS,
    });
    db.transaction.mockImplementation(async (fn) => fn(trx));
    await expect(dedupe.executeMerge({ winnerId: WINNER, loserId: LOSER, performedBy: 'test' }))
      .rejects.toThrow(/Stripe profiles/);
  });

  it('refuses auto mode when the loser is not a shell', async () => {
    const { trx } = buildTrx({
      winner: { id: WINNER, first_name: 'Diana', last_name: 'Blowers' },
      loser: { id: LOSER, first_name: 'Diana', last_name: 'Blowers', password_hash: 'x' },
      fkRows: FK_ROWS,
    });
    db.transaction.mockImplementation(async (fn) => fn(trx));
    await expect(dedupe.executeMerge({ winnerId: WINNER, loserId: LOSER, performedBy: 'test', mode: 'auto' }))
      .rejects.toThrow(/not a shell/);
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
    const winner = { id: WINNER, first_name: 'A', last_name: 'B' };
    const loser = { id: LOSER, first_name: 'A', last_name: 'B' };
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
