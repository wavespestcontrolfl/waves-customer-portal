/**
 * customer-dedupe — the review-only "same address, different phone" group kind
 * (owner ruling 2026-10-03, GATE_DUPLICATES_SAME_ADDRESS): grouping rules, the
 * structural never-green / never-auto pins, and what a merge does with the
 * merged-away person's phone and consent. Synthetic customers only.
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
const { pairCustomersAtSameAddress } = require('../services/customer-address-match');

const { buildSameAddressGroups, SAME_ADDRESS_REASON } = dedupe._test;

let seq = 0;
function cust(overrides = {}) {
  seq += 1;
  const n = String(seq).padStart(12, '0');
  return {
    id: `aaaaaaaa-0000-4000-8000-${n}`,
    first_name: 'Sample', last_name: 'Example', phone: `+1941555${String(1000 + seq)}`,
    email: null, address_line1: '100 Example Loop', address_line2: null, city: 'Sarasota', zip: '34231',
    active: true, deleted_at: null, pipeline_stage: 'new_lead', created_at: `2026-09-${String(10 + (seq % 15))}`,
    stripe_customer_id: null, password_hash: null, property_type: 'single_family', waveguard_tier: null,
    ...overrides,
  };
}

const flat = (groups) => groups.map((g) => [g.winner.id, ...g.candidates.map((c) => c.loser.id)].sort());

describe('same-address grouping', () => {
  test('two residential customers at one address with different phones form one review group', () => {
    const a = cust({ first_name: 'Alex' });
    const b = cust({ first_name: 'Blake' });
    const groups = buildSameAddressGroups({ customers: [a, b] });
    expect(groups).toHaveLength(1);
    expect(groups[0].kind).toBe('same_address');
    expect(groups[0].phone10).toBeNull();
    expect(flat(groups)).toEqual([[a.id, b.id].sort()]);
    expect(groups[0].candidates[0].reasons[0]).toBe(SAME_ADDRESS_REASON);
    expect(groups[0].candidates[0].evidence).toMatchObject({ kind: 'same_address', phones_differ: true });
  });

  test('suffix, case and punctuation variants are the same premise; ZIP+4 is still ZIP-5', () => {
    const a = cust({ address_line1: '100 Example Loop', zip: '34231' });
    const b = cust({ address_line1: '100 EXAMPLE LOOP.', zip: '34231-1234', city: 'sarasota' });
    expect(buildSameAddressGroups({ customers: [a, b] })).toHaveLength(1);
    const c = cust({ address_line1: '200 Sample Street' });
    const d = cust({ address_line1: '200 sample st' });
    expect(buildSameAddressGroups({ customers: [c, d] })).toHaveLength(1);
  });

  test('a unit mismatch is not the same household, and a unit on one side only is not either', () => {
    const apt4 = cust({ address_line2: 'Apt 4' });
    const apt7 = cust({ address_line2: 'Apt 7' });
    const bare = cust({ address_line2: null });
    expect(buildSameAddressGroups({ customers: [apt4, apt7] })).toEqual([]);
    expect(buildSameAddressGroups({ customers: [apt4, bare] })).toEqual([]);
    const apt4Again = cust({ address_line1: '100 Example Loop Unit 4', address_line2: null });
    expect(buildSameAddressGroups({ customers: [apt4, apt4Again] })).toHaveLength(1);
  });

  test('a different ZIP, or a different city when ZIP is missing, is a different premise', () => {
    expect(buildSameAddressGroups({ customers: [cust(), cust({ zip: '34232' })] })).toEqual([]);
    expect(buildSameAddressGroups({
      customers: [cust({ zip: null }), cust({ zip: null, city: 'Bradenton' })],
    })).toEqual([]);
  });

  test('commercial customers and commercial properties never group', () => {
    expect(buildSameAddressGroups({ customers: [cust(), cust({ property_type: 'Commercial' })] })).toEqual([]);
    expect(buildSameAddressGroups({ customers: [cust(), cust({ property_type: 'office' })] })).toEqual([]);
    expect(buildSameAddressGroups({ customers: [cust(), cust({ property_type: 'multi_family' })] })).toEqual([]);
    expect(buildSameAddressGroups({ customers: [cust(), cust({ waveguard_tier: 'Commercial' })] })).toEqual([]);
    const a = cust();
    const b = cust({ address_line1: '999 Elsewhere Rd', zip: '34202' });
    expect(buildSameAddressGroups({
      customers: [a, b],
      properties: [{ customer_id: b.id, address_line1: '100 Example Loop', city: 'Sarasota', zip: '34231', property_type: 'commercial' }],
    })).toEqual([]);
  });

  test('inactive, soft-deleted and address-less customers never group', () => {
    expect(buildSameAddressGroups({ customers: [cust(), cust({ active: false })] })).toEqual([]);
    expect(buildSameAddressGroups({ customers: [cust(), cust({ deleted_at: '2026-09-01' })] })).toEqual([]);
    expect(buildSameAddressGroups({ customers: [cust({ address_line1: null }), cust({ address_line1: null })] })).toEqual([]);
    expect(buildSameAddressGroups({ customers: [cust({ address_line1: 'PO Box 5' }), cust({ address_line1: 'PO Box 5' })] })).toEqual([]);
  });

  test('a null active column counts as live (the address finder\'s rule)', () => {
    expect(buildSameAddressGroups({ customers: [cust({ active: null }), cust()] })).toHaveLength(1);
  });

  test('customers already in the same phone group are the phone queue\'s, not this one\'s', () => {
    const a = cust({ phone: '+19415550199' });
    const b = cust({ phone: '941-555-0199' });
    expect(buildSameAddressGroups({ customers: [a, b] })).toEqual([]);
  });

  test('a dismissed pair is excluded; an undismissed third customer still pairs', () => {
    const a = cust();
    const b = cust();
    const c = cust();
    const [lo, hi] = a.id < b.id ? [a.id, b.id] : [b.id, a.id];
    const groups = buildSameAddressGroups({ customers: [a, b, c], dismissed: new Set([`${lo}:${hi}`]) });
    const pairs = new Set();
    for (const g of groups) for (const cand of g.candidates) pairs.add([g.winner.id, cand.loser.id].sort().join(':'));
    expect(pairs.has(`${lo}:${hi}`)).toBe(false);
    expect(pairs.size).toBeGreaterThan(0);
  });

  test('a second address on an active property pairs a customer with the home\'s other customer', () => {
    const owner = cust({ address_line1: '999 Elsewhere Rd', zip: '34202', first_name: 'Owner' });
    const tenant = cust({ first_name: 'Tenant' });
    const groups = buildSameAddressGroups({
      customers: [owner, tenant],
      properties: [{ customer_id: owner.id, address_line1: '100 Example Loop', city: 'Sarasota', zip: '34231', property_type: 'single_family' }],
    });
    expect(groups).toHaveLength(1);
    expect(groups[0].candidates[0].evidence.matched_via).toEqual(expect.objectContaining({}));
    const via = Object.values(groups[0].candidates[0].evidence.matched_via).sort();
    expect(via).toEqual(['primary', 'property']);
  });

  test('a customer never pairs with its own property rows', () => {
    const a = cust();
    expect(buildSameAddressGroups({
      customers: [a],
      properties: [{ customer_id: a.id, address_line1: '100 Example Loop', city: 'Sarasota', zip: '34231' }],
    })).toEqual([]);
  });

  test('three customers at one premise: every pair is reachable, nothing is dropped', () => {
    const rows = [cust(), cust(), cust()];
    const groups = buildSameAddressGroups({ customers: rows });
    const covered = new Set(flat(groups).flat());
    expect(covered).toEqual(new Set(rows.map((r) => r.id)));
    expect(groups.reduce((n, g) => n + g.candidates.length, 0)).toBe(2);
  });

  test('credential material never ships; visit counts ride along when supplied', () => {
    const a = cust({ stripe_customer_id: 'cus_synthetic', password_hash: 'hash' });
    const b = cust();
    const [group] = buildSameAddressGroups({ customers: [a, b], upcomingVisits: new Map([[a.id, 2]]) });
    const text = JSON.stringify(group);
    expect(text).not.toContain('cus_synthetic');
    expect(text).not.toContain('"password_hash"');
    expect(group.winner.has_stripe || group.candidates[0].loser.has_stripe).toBe(true);
    const keep = [group.winner, group.candidates[0].loser].find((c) => c.id === a.id);
    expect(keep.upcoming_visits).toBe(2);
  });
});

describe('same-address tier is review-only, never green', () => {
  test('a name-compatible, billing-free shell pair that would be GREEN in a phone group is yellow here', () => {
    const real = cust({ first_name: 'Sample', last_name: 'Example', pipeline_stage: 'active_customer' });
    const shell = cust({ first_name: 'Sample', last_name: null, address_line1: '100 Example Loop' });
    const [group] = buildSameAddressGroups({ customers: [real, shell] });
    expect(group.candidates).toHaveLength(1);
    expect(group.candidates[0].tier).toBe('yellow');
    expect(group.candidates[0].reasons).toContain(SAME_ADDRESS_REASON);
    // Same pair, same phone, phone-group classification: green. The kind is
    // what holds it back, not the rows.
    expect(dedupe._test.classifyPair(real, shell, []).tier).toBe('green');
  });

  test('no tier but yellow or red ever leaves the builder, across mixed fixtures', () => {
    const rows = [
      cust({ first_name: 'A', last_name: 'One' }), cust({ first_name: 'A', last_name: null }),
      cust({ first_name: 'B', last_name: 'Two' }),
    ];
    const tiers = buildSameAddressGroups({ customers: rows }).flatMap((g) => g.candidates.map((c) => c.tier));
    expect(tiers.length).toBeGreaterThan(0);
    expect(tiers.every((t) => t === 'yellow' || t === 'red')).toBe(true);
  });
});

describe('the auto-merge cron cannot see same-address pairs', () => {
  function chain(table, route) {
    const q = {};
    for (const m of ['where', 'whereIn', 'whereRaw', 'whereNull', 'whereNotNull', 'select', 'groupBy', 'orderBy', 'count', 'limit', 'orWhereNull', 'orWhereExists', 'join']) {
      q[m] = jest.fn(() => q);
    }
    q.then = (resolve, reject) => Promise.resolve().then(() => route(table)).then(resolve, reject);
    return q;
  }

  test('runAutoMergeSweep over two name-compatible shells at one address with different phones merges and skips nothing', async () => {
    const calls = [];
    const rows = [
      cust({ first_name: 'Sample', last_name: 'Example', phone: '+19415550101' }),
      cust({ first_name: 'Sample', last_name: null, phone: '+19415550102' }),
    ];
    db.mockImplementation((table) => {
      calls.push(table);
      return chain(table, (t) => (t === 'customers' ? rows : []));
    });
    const results = await dedupe.runAutoMergeSweep({ performedBy: 'test' });
    expect(results).toEqual({ merged: [], skipped: [] });
    expect(db.transaction).not.toHaveBeenCalled();
    // The sweep read the phone queue only: never the property table the
    // same-address detection joins.
    expect(calls).not.toContain('customer_properties');
  });

  test('findDuplicateGroups (the cron\'s only candidate source) returns no group for them', async () => {
    const rows = [cust({ phone: '+19415550101' }), cust({ phone: '+19415550102' })];
    db.mockImplementation((table) => chain(table, (t) => (t === 'customers' ? rows : [])));
    expect(await dedupe.findDuplicateGroups()).toEqual([]);
  });

  test('executeMerge refuses a same-address pair in auto mode, and without the locked queue re-check', async () => {
    const ids = { winnerId: 'aaaaaaaa-0000-4000-8000-0000000000a1', loserId: 'aaaaaaaa-0000-4000-8000-0000000000a2', performedBy: 'test' };
    await expect(dedupe.executeMerge({ ...ids, mode: 'auto', requireQueueEligibility: true, pairKind: 'same_address' }))
      .rejects.toThrow(/review-only/);
    await expect(dedupe.executeMerge({ ...ids, mode: 'manual', pairKind: 'same_address' }))
      .rejects.toThrow(/review-only/);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  test('the auto sweep\'s under-lock recheck refuses a pair with different phones', async () => {
    const trx = jest.fn((table) => chain(table, () => []));
    const winner = cust({ phone: '+19415550101' });
    const loser = cust({ phone: '+19415550102' });
    const verdict = await dedupe._test.lockedPairAutoEligibility(trx, winner, loser);
    expect(verdict.eligible).toBe(false);
    expect(verdict.code).toBe('not_in_queue');
  });
});

describe('pairCustomersAtSameAddress (the one comparator, set-wide)', () => {
  const row = (customerId, extra = {}) => ({ customerId, matchedVia: 'primary', address_line1: '100 Example Loop', city: 'Sarasota', zip: '34231', ...extra });

  test('pairs once per customer pair and skips unparseable rows', () => {
    const pairs = pairCustomersAtSameAddress([
      row('b'), row('a'), row('a', { matchedVia: 'property' }),
      row('c', { address_line1: 'Example Loop' }), row('d', { address_line1: null }),
    ]);
    expect(pairs).toEqual([{ a: 'a', b: 'b', via: { a: 'primary', b: 'primary' } }]);
  });

  test('uses the unit-strict rule: one-sided unit is not a pair', () => {
    expect(pairCustomersAtSameAddress([row('a', { address_line2: 'Unit 2' }), row('b')])).toEqual([]);
  });
});

describe('merge carries the merged-away person\'s phone (predictWinnerBackfills)', () => {
  const winnerRow = (extra = {}) => cust({ first_name: 'Alex', last_name: 'Example', phone: '+19415550101', ...extra });
  const loserRow = (extra = {}) => cust({ first_name: 'Blake', last_name: 'Example', phone: '+19415550102', ...extra });
  const { predictWinnerBackfills } = dedupe;

  test('the loser\'s phone lands in the first free slot with its name, a household role, and an unconsented hold', () => {
    const { backfills, phoneCarry } = predictWinnerBackfills(winnerRow(), loserRow());
    expect(phoneCarry).toEqual({ status: 'carried', phone_key: '9415550102', slot: 1 });
    expect(backfills).toMatchObject({
      service_contact_phone: '+19415550102', service_contact_name: 'Blake Example', service_contact_role: 'family_member',
    });
    expect(backfills.service_preferences.unconsented_slot_phone_keys).toEqual(['9415550102']);
  });

  test('consent is not copied: the loser\'s contact-consent stamp never rides along for its own phone', () => {
    const loser = loserRow({
      service_contacts_consent_at: '2026-09-01T00:00:00Z', service_contacts_consent_source: 'call', service_contacts_consent_text_version: 'v1',
    });
    const { backfills } = predictWinnerBackfills(winnerRow(), loser);
    expect(backfills).not.toHaveProperty('service_contacts_consent_at');
    expect(backfills.service_preferences.unconsented_slot_phone_keys).toContain('9415550102');
  });

  test('a winner with its own consent stamp keeps it; only the new number is held out of texting', () => {
    const winner = winnerRow({
      service_contact_name: 'Pat', service_contact_phone: '+19415550177',
      service_contacts_consent_at: '2026-08-01T00:00:00Z', service_preferences: { unconsented_slot_phone_keys: ['9415550188'], other: 1 },
    });
    const { backfills, winnerPriorValues, phoneCarry } = predictWinnerBackfills(winner, loserRow());
    expect(phoneCarry.slot).toBe(2);
    expect(backfills).not.toHaveProperty('service_contacts_consent_at');
    expect(backfills.service_preferences).toEqual({ other: 1, unconsented_slot_phone_keys: ['9415550188', '9415550102'] });
    // The winner's prior preferences blob is journaled so an undo restores it.
    expect(winnerPriorValues.service_preferences).toEqual(winner.service_preferences);
  });

  test('the loser\'s own contact slots move first (existing rule); the phone takes the next free slot', () => {
    const loser = loserRow({ service_contact_name: 'Pat', service_contact_phone: '+19415550177' });
    const { backfills, phoneCarry } = predictWinnerBackfills(winnerRow(), loser);
    expect(backfills.service_contact_phone).toBe('+19415550177');
    expect(phoneCarry.slot).toBe(2);
    expect(backfills.service_contact2_phone).toBe('+19415550102');
  });

  test('no free slot: nothing is written for the phone and the result says so', () => {
    const winner = winnerRow({
      service_contact_name: 'A', service_contact_phone: '+19415550171',
      service_contact2_name: 'B', service_contact2_phone: '+19415550172',
      service_contact3_name: 'C', service_contact3_phone: '+19415550173',
    });
    const { backfills, phoneCarry } = predictWinnerBackfills(winner, loserRow());
    expect(phoneCarry).toEqual({ status: 'no_free_slot', phone_key: '9415550102', slot: null });
    expect(JSON.stringify(backfills)).not.toContain('9415550102');
    expect(backfills).not.toHaveProperty('service_preferences');
  });

  test('a number the winner already holds (slot or secondary) is not duplicated', () => {
    const inSlot = winnerRow({ service_contact_name: 'Blake', service_contact_phone: '(941) 555-0102' });
    expect(predictWinnerBackfills(inSlot, loserRow()).phoneCarry.status).toBe('already_on_winner');
    const inSecondary = winnerRow({ secondary_phone: '9415550102' });
    const res = predictWinnerBackfills(inSecondary, loserRow());
    expect(res.phoneCarry.status).toBe('already_on_winner');
    expect(res.backfills).not.toHaveProperty('service_contact_phone');
  });

  test('a phone-group pair (shared phone) is untouched by the carry', () => {
    const { backfills, phoneCarry } = predictWinnerBackfills(winnerRow(), loserRow({ phone: '941-555-0101' }));
    expect(phoneCarry.status).toBe('not_applicable');
    expect(backfills).not.toHaveProperty('service_contact_phone');
    expect(backfills).not.toHaveProperty('service_preferences');
  });
});
