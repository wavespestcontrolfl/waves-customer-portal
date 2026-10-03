/**
 * customer-dedupe — the review-only "same name, different phone and address"
 * group kind (GATE_DUPLICATES_SAME_NAME): bucketing and exclusion rules, the
 * structural never-green / never-auto pins, and the evidence each card needs.
 * Synthetic customers only.
 */
jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.transaction = jest.fn();
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => null) }));
jest.mock('../services/stripe', () => ({
  retrievePaymentIntent: jest.fn(async () => null),
  cancelPaymentIntent: jest.fn(async () => ({})),
}));

const db = require('../models/db');
const dedupe = require('../services/customer-dedupe');

const { buildSameNameGroups, sameNameKey, SAME_NAME_REASON, SAME_NAME_PHONE_MISSING_REASON, SAME_NAME_PHONE_SHARED_REASON } = dedupe._test;

let seq = 0;
function cust(overrides = {}) {
  seq += 1;
  const n = String(seq).padStart(12, '0');
  return {
    id: `bbbbbbbb-0000-4000-8000-${n}`,
    first_name: 'Sample', last_name: 'Example', phone: `+1941555${String(3000 + seq)}`,
    email: null, address_line1: `${100 + seq} Example Loop`, address_line2: null, city: 'Sarasota', zip: '34231',
    active: true, deleted_at: null, pipeline_stage: 'new_lead', created_at: `2026-09-${String(10 + (seq % 15))}`,
    stripe_customer_id: null, password_hash: null, property_type: 'single_family', waveguard_tier: null, account_id: null,
    ...overrides,
  };
}
const pairsOf = (groups) => {
  const out = new Set();
  for (const g of groups) for (const c of g.candidates) out.add([g.winner.id, c.loser.id].sort().join(':'));
  return out;
};

describe('same-name grouping', () => {
  test('two live customers with the same first and last name, different phone and address, form one review group', () => {
    const a = cust();
    const b = cust();
    const groups = buildSameNameGroups({ customers: [a, b] });
    expect(groups).toHaveLength(1);
    expect(groups[0].kind).toBe('same_name');
    expect(groups[0].phone10).toBeNull();
    expect(pairsOf(groups)).toEqual(new Set([[a.id, b.id].sort().join(':')]));
    expect(groups[0].candidates[0].reasons[0]).toBe(SAME_NAME_REASON);
    expect(groups[0].candidates[0].evidence).toMatchObject({ kind: 'same_name', phones_differ: true, names_compatible: true });
  });

  test('evidence carries both addresses and both phones for the card', () => {
    const a = cust({ address_line1: '1584 Sample Crest Loop', address_line2: null, phone: '+19415550111', pipeline_stage: 'active_customer' });
    const b = cust({ address_line1: '15-84 Sample Crest Loop', address_line2: 'Unit 2', phone: '+19415550222' });
    const [group] = buildSameNameGroups({ customers: [a, b] });
    expect(group.winner.id).toBe(a.id);
    const { evidence } = group.candidates[0];
    expect(evidence.phone_numbers).toEqual({ winner: '+19415550111', loser: '+19415550222' });
    expect(evidence.addresses.winner).toEqual({ address_line1: '1584 Sample Crest Loop', address_line2: null, city: 'Sarasota', zip: '34231' });
    expect(evidence.addresses.loser).toEqual({ address_line1: '15-84 Sample Crest Loop', address_line2: 'Unit 2', city: 'Sarasota', zip: '34231' });
    expect(evidence.phone_carry).toEqual({ status: 'carried', slot: 1 });
  });

  test('case, spacing and punctuation variants share a name; a typo variant does not', () => {
    expect(buildSameNameGroups({ customers: [cust({ first_name: 'ALEX ', last_name: 'o.neil' }), cust({ first_name: 'alex', last_name: 'oneil' })] })).toHaveLength(1);
    expect(buildSameNameGroups({ customers: [cust({ first_name: 'Mary  Ann' }), cust({ first_name: 'mary ann' })] })).toHaveLength(1);
    expect(buildSameNameGroups({ customers: [cust({ last_name: 'Ryles' }), cust({ last_name: 'Ryals' })] })).toEqual([]);
    expect(buildSameNameGroups({ customers: [cust({ first_name: 'Alex' }), cust({ first_name: 'Alexa' })] })).toEqual([]);
  });

  test('a blank, placeholder or one-letter name never keys, so such rows never pair', () => {
    for (const bad of [null, '', '   ', 'Unknown', 'unknown', 'N/A', 'na', 'J', 'j.', 'Unknown.', 'N.A.', 'n/a.', 'UNKNOWN,', ' unknown. ', 'Na,']) {
      expect(sameNameKey(cust({ first_name: bad }))).toBeNull();
      expect(sameNameKey(cust({ last_name: bad }))).toBeNull();
      expect(buildSameNameGroups({ customers: [cust({ first_name: bad }), cust({ first_name: bad })] })).toEqual([]);
      expect(buildSameNameGroups({ customers: [cust({ last_name: bad }), cust({ last_name: bad })] })).toEqual([]);
    }
    expect(sameNameKey(cust({ first_name: 'Sam', last_name: 'Lee' }))).toBe('sam|lee');
  });

  test('a punctuated placeholder in one name never groups the rows on the other name alone', () => {
    for (const bad of ['Unknown.', 'N.A.', 'n/a.', 'UNKNOWN,']) {
      expect(buildSameNameGroups({ customers: [cust({ first_name: bad, last_name: 'Smithson' }), cust({ first_name: bad, last_name: 'Smithson' })] })).toEqual([]);
      expect(buildSameNameGroups({ customers: [cust({ first_name: 'Pat', last_name: bad }), cust({ first_name: 'Pat', last_name: bad })] })).toEqual([]);
    }
    expect(dedupe._test.sameNamePart('N.A.')).toBe('');
    expect(dedupe._test.sameNamePart('Mary  Ann.')).toBe('mary ann');
  });

  test('a first-name-only match (or last-name-only match) is not a pair', () => {
    expect(buildSameNameGroups({ customers: [cust({ first_name: 'Alex' }), cust({ first_name: 'Blake' })] })).toEqual([]);
  });

  test('a missing phone on one or both sides is fine and says so', () => {
    const one = buildSameNameGroups({ customers: [cust({ phone: '' }), cust()] });
    expect(one).toHaveLength(1);
    expect(one[0].candidates[0].reasons[0]).toBe(SAME_NAME_PHONE_MISSING_REASON);
    expect(one[0].candidates[0].evidence).toMatchObject({ phones_differ: false, phone_state: expect.stringMatching(/one_missing|both_missing/) });
    const both = buildSameNameGroups({ customers: [cust({ phone: null }), cust({ phone: '' })] });
    expect(both[0].candidates[0].evidence.phone_state).toBe('both_missing');
  });

  test('a missing address on one side is fine', () => {
    const groups = buildSameNameGroups({ customers: [cust({ address_line1: null, city: null, zip: null }), cust()] });
    expect(groups).toHaveLength(1);
    expect(groups[0].candidates[0].tier).toBe('yellow');
  });

  test('inactive, soft-deleted and commercial customers never group; a null active column is live', () => {
    expect(buildSameNameGroups({ customers: [cust(), cust({ active: false })] })).toEqual([]);
    expect(buildSameNameGroups({ customers: [cust(), cust({ deleted_at: '2026-09-01' })] })).toEqual([]);
    expect(buildSameNameGroups({ customers: [cust(), cust({ property_type: 'Commercial' })] })).toEqual([]);
    expect(buildSameNameGroups({ customers: [cust(), cust({ waveguard_tier: 'Commercial' })] })).toEqual([]);
    expect(buildSameNameGroups({ customers: [cust({ active: null }), cust()] })).toHaveLength(1);
  });

  test('profiles of one account are not duplicates of each other', () => {
    const acct = 'cccccccc-0000-4000-8000-000000000001';
    expect(buildSameNameGroups({ customers: [cust({ account_id: acct }), cust({ account_id: acct })] })).toEqual([]);
    expect(buildSameNameGroups({ customers: [cust({ account_id: acct }), cust({ account_id: 'cccccccc-0000-4000-8000-000000000002' })] })).toHaveLength(1);
    expect(buildSameNameGroups({ customers: [cust({ account_id: acct }), cust({ account_id: null })] })).toHaveLength(1);
  });

  test('a pair the phone queue lists is not repeated here, but a shared phone with a not-active row stays', () => {
    const shared = '+19415550199';
    expect(buildSameNameGroups({ customers: [cust({ phone: shared }), cust({ phone: '941-555-0199' })] })).toEqual([]);
    const groups = buildSameNameGroups({ customers: [cust({ phone: shared }), cust({ phone: shared, active: null })] });
    expect(groups).toHaveLength(1);
    expect(groups[0].candidates[0].reasons[0]).toBe(SAME_NAME_PHONE_SHARED_REASON);
  });

  test('a pair at one premise belongs to the same-address queue, not this one (customer row or saved property)', () => {
    expect(buildSameNameGroups({ customers: [cust({ address_line1: '100 Example Loop' }), cust({ address_line1: '100 EXAMPLE LOOP.' })] })).toEqual([]);
    const owner = cust({ address_line1: '999 Elsewhere Rd', zip: '34202' });
    const tenant = cust({ address_line1: '100 Example Loop' });
    expect(buildSameNameGroups({
      customers: [owner, tenant],
      properties: [{ customer_id: owner.id, address_line1: '100 Example Loop', city: 'Sarasota', zip: '34231', property_type: 'single_family' }],
    })).toEqual([]);
  });

  test('a dismissed pair is excluded; an undismissed third customer still pairs', () => {
    const a = cust();
    const b = cust();
    const c = cust();
    const [lo, hi] = a.id < b.id ? [a.id, b.id] : [b.id, a.id];
    const pairs = pairsOf(buildSameNameGroups({ customers: [a, b, c], dismissed: new Set([`${lo}:${hi}`]) }));
    expect(pairs.has(`${lo}:${hi}`)).toBe(false);
    expect(pairs.size).toBeGreaterThan(0);
  });

  test('three same-name customers: one card with both candidates (the edge between them is covered by merging both into the winner)', () => {
    const a = cust();
    const b = cust();
    const c = cust();
    const groups = buildSameNameGroups({ customers: [a, b, c] });
    expect(groups).toHaveLength(1);
    expect([groups[0].winner.id, ...groups[0].candidates.map((x) => x.loser.id)].sort()).toEqual([a.id, b.id, c.id].sort());
  });

  test('buckets by name key: the pairing never compares customers with different names', () => {
    const many = Array.from({ length: 200 }, (_, i) => cust({ first_name: `Person${i}`, last_name: 'Distinct' }));
    expect(buildSameNameGroups({ customers: many })).toEqual([]);
  });

  test('credential material never ships; visit counts ride along when supplied; slot columns are stripped', () => {
    const winner = cust({ stripe_customer_id: 'cus_synthetic', password_hash: 'x', service_contact_phone: '+19415550001', pipeline_stage: 'active_customer' });
    const loser = cust();
    const [group] = buildSameNameGroups({ customers: [winner, loser], upcomingVisits: new Map([[winner.id, 2]]) });
    expect(group.winner).not.toHaveProperty('password_hash');
    expect(group.winner).not.toHaveProperty('stripe_customer_id');
    expect(group.winner).not.toHaveProperty('service_contact_phone');
    expect(group.winner).toMatchObject({ has_stripe: true, has_portal_login: true, upcoming_visits: 2 });
  });
});

describe('winner choice reuses the existing logic', () => {
  test('the record with Stripe wins over a shell, and the other side is the candidate', () => {
    const shell = cust();
    const billed = cust({ stripe_customer_id: 'cus_synthetic', created_at: '2026-09-28' });
    const [group] = buildSameNameGroups({ customers: [shell, billed], blockersById: new Map([[billed.id, ['stripe_customer_id']], [shell.id, []]]) });
    expect(group.winner.id).toBe(billed.id);
    expect(group.candidates[0].loser.id).toBe(shell.id);
  });

  test('activity (a business blocker) outranks a Stripe-only shell', () => {
    const stripeShell = cust({ stripe_customer_id: 'cus_synthetic' });
    const withInvoices = cust();
    const blockersById = new Map([[stripeShell.id, ['stripe_customer_id']], [withInvoices.id, ['invoices', 'scheduled_services']]]);
    const [group] = buildSameNameGroups({ customers: [stripeShell, withInvoices], blockersById });
    expect(group.winner.id).toBe(withInvoices.id);
  });

  test('equal scores and identical created_at: the winner does not depend on row order', () => {
    const a = cust({ created_at: '2026-04-06' });
    const b = cust({ created_at: '2026-04-06' });
    const blockersById = new Map([[a.id, []], [b.id, []]]);
    const [forward] = buildSameNameGroups({ customers: [a, b], blockersById });
    const [reversed] = buildSameNameGroups({ customers: [b, a], blockersById });
    const expected = [a.id, b.id].sort((x, y) => String(x).localeCompare(String(y)))[0];
    expect(forward.winner.id).toBe(expected);
    expect(reversed.winner.id).toBe(expected);
  });
});

describe('same-name tier is review-only, never green', () => {
  test('a name-compatible, billing-free shell pair that would be GREEN in a phone group is yellow here', () => {
    const groups = buildSameNameGroups({ customers: [cust(), cust()] });
    expect(groups[0].candidates.every((c) => c.tier === 'yellow')).toBe(true);
  });

  test('loser blockers surface as reasons and keep the pair yellow', () => {
    const winner = cust({ pipeline_stage: 'active_customer', created_at: '2020-01-01' });
    const loser = cust();
    const blockersById = new Map([[winner.id, ['invoices', 'payments', 'scheduled_services']], [loser.id, ['third_party_payer', 'billing_mode']]]);
    const [group] = buildSameNameGroups({ customers: [winner, loser], blockersById });
    expect(group.winner.id).toBe(winner.id);
    expect(group.candidates[0].tier).toBe('yellow');
    expect(group.candidates[0].reasons).toEqual(expect.arrayContaining(['loser_has_third_party_payer', 'loser_has_billing_mode']));
  });

  test('no tier but yellow or red ever leaves the builder', () => {
    const customers = [cust(), cust(), cust({ first_name: 'Other' }), cust({ first_name: 'Other', address_line1: null }), cust({ phone: '' })];
    for (const g of buildSameNameGroups({ customers })) {
      for (const c of g.candidates) expect(['yellow', 'red']).toContain(c.tier);
    }
  });
});

describe('the auto-merge cron cannot see same-name pairs', () => {
  function chain(table, route) {
    const q = {};
    for (const m of ['where', 'whereIn', 'whereRaw', 'whereNull', 'whereNotNull', 'select', 'groupBy', 'orderBy', 'count', 'limit', 'orWhereNull', 'orWhereExists', 'join']) {
      q[m] = jest.fn(() => q);
    }
    q.then = (resolve, reject) => Promise.resolve().then(() => route(table)).then(resolve, reject);
    return q;
  }

  test('runAutoMergeSweep over two same-name shells with different phones merges and skips nothing, and never reads the property table', async () => {
    const calls = [];
    const rows = [cust({ phone: '+19415550101' }), cust({ phone: '+19415550102' })];
    db.mockImplementation((table) => {
      calls.push(table);
      return chain(table, (t) => (t === 'customers' ? rows : []));
    });
    expect(await dedupe.runAutoMergeSweep({ performedBy: 'test' })).toEqual({ merged: [], skipped: [] });
    expect(db.transaction).not.toHaveBeenCalled();
    expect(calls).not.toContain('customer_properties');
  });

  test('findDuplicateGroups (the cron\'s only candidate source) returns no group for them', async () => {
    const rows = [cust({ phone: '+19415550101' }), cust({ phone: '+19415550102' })];
    db.mockImplementation((table) => chain(table, (t) => (t === 'customers' ? rows : [])));
    expect(await dedupe.findDuplicateGroups()).toEqual([]);
  });

  test('executeMerge refuses a same-name pair in auto mode, and without the locked queue re-check', async () => {
    const ids = { winnerId: 'bbbbbbbb-0000-4000-8000-0000000000a1', loserId: 'bbbbbbbb-0000-4000-8000-0000000000a2', performedBy: 'test' };
    await expect(dedupe.executeMerge({ ...ids, mode: 'auto', requireQueueEligibility: true, pairKind: 'same_name' })).rejects.toThrow(/review-only/);
    await expect(dedupe.executeMerge({ ...ids, mode: 'manual', pairKind: 'same_name' })).rejects.toThrow(/review-only/);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  test('the auto sweep\'s under-lock recheck refuses a pair with different phones', async () => {
    const trx = jest.fn((table) => chain(table, () => []));
    const verdict = await dedupe._test.lockedPairAutoEligibility(trx, cust({ phone: '+19415550101' }), cust({ phone: '+19415550102' }));
    expect(verdict).toMatchObject({ eligible: false, code: 'not_in_queue' });
  });
});

describe('merge carries the merged-away person\'s phone (existing same-address rule, reused)', () => {
  test('the loser\'s phone is predicted into the first free slot under the unconsented hold', () => {
    const winner = cust({ phone: '+19415550101' });
    const loser = cust({ phone: '+19415550102' });
    const { phoneCarry } = dedupe.predictWinnerBackfills(winner, loser);
    expect(phoneCarry).toMatchObject({ status: 'carried', slot: 1, phone_key: '9415550102' });
  });
});
