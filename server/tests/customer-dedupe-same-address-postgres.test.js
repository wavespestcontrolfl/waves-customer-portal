/**
 * "Same address, different phone" against live Postgres (skipped without
 * DATABASE_URL; CI runs it). Two halves:
 *   1. Detection — the real queries of findSameAddressGroups on TEMP tables that
 *      shadow customers / customer_properties / customer_duplicate_dismissals /
 *      scheduled_services on ONE pooled connection, so leftover rows in a shared
 *      test database can never leak into (or out of) the result.
 *   2. Merge — the real executeMerge / revertMerge on a synthetic pair: the
 *      merged-away person's phone is carried to the kept customer so the call
 *      pipeline's own matcher finds them again, consent is held, and the undo
 *      puts everything back.
 * Synthetic names and addresses only; the merge half removes every row it wrote.
 */
const { randomUUID } = require('node:crypto');
const knex = require('knex');

const SKIP = !process.env.DATABASE_URL;
const maybeDescribe = SKIP ? describe.skip : describe;
jest.setTimeout(120000);

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({})) }));

const dedupe = require('../services/customer-dedupe');

const digits = (n) => String(n).replace(/\d/g, (d) => 'abcdefghij'[d]);
const uniq = () => Math.floor(10000 + Math.random() * 89999);

maybeDescribe('findSameAddressGroups (TEMP tables)', () => {
  let conn;

  beforeAll(async () => {
    conn = knex({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 1, max: 1 } });
    for (const table of ['customers', 'customer_properties', 'customer_duplicate_dismissals', 'scheduled_services']) {
      await conn.raw('CREATE TEMP TABLE ?? (LIKE public.?? INCLUDING DEFAULTS)', [table, table]);
    }
  });
  afterAll(async () => { if (conn) await conn.destroy(); });
  beforeEach(async () => {
    for (const table of ['scheduled_services', 'customer_duplicate_dismissals', 'customer_properties', 'customers']) {
      await conn(table).del();
    }
  });

  let n = 0;
  async function customer(extra = {}) {
    n += 1;
    const id = randomUUID();
    await conn('customers').insert({
      id, first_name: 'Sample', last_name: 'Example', phone: `+1941555${String(2000 + n)}`,
      address_line1: '100 Example Loop', city: 'Sarasota', state: 'FL', zip: '34231',
      pipeline_stage: 'new_lead', active: true, ...extra,
    });
    return id;
  }
  const pairsOf = (groups) => groups.flatMap((g) => g.candidates.map((c) => [g.winner.id, c.loser.id].sort().join(':')));
  const pair = (a, b) => [a, b].sort().join(':');

  test('lists a same-address, different-phone pair; each customer carries its phone and upcoming-visit count', async () => {
    const a = await customer({ first_name: 'Alex' });
    const b = await customer({ first_name: 'Blake' });
    await conn('scheduled_services').insert({ customer_id: a, scheduled_date: '2099-01-05', service_type: 'General Pest Control', status: 'confirmed' });
    await conn('scheduled_services').insert({ customer_id: a, scheduled_date: '2099-01-06', service_type: 'General Pest Control', status: 'cancelled' });
    const groups = await dedupe.findSameAddressGroups(conn);
    expect(groups).toHaveLength(1);
    expect(pairsOf(groups)).toEqual([pair(a, b)]);
    const all = [groups[0].winner, groups[0].candidates[0].loser];
    expect(all.every((c) => /^\+1941555/.test(c.phone))).toBe(true);
    expect(all.find((c) => c.id === a).upcoming_visits).toBe(1);
    expect(all.find((c) => c.id === b).upcoming_visits).toBe(0);
    expect(groups[0].candidates[0].tier).toBe('yellow');
  });

  test('excludes a unit mismatch, a ZIP mismatch, commercial, inactive, soft-deleted, and a shared-phone pair', async () => {
    const base = await customer();
    await customer({ address_line2: 'Apt 9' });
    await customer({ zip: '34232' });
    await customer({ property_type: 'commercial' });
    await customer({ active: false });
    await customer({ deleted_at: new Date() });
    await customer({ phone: (await conn('customers').where({ id: base }).first('phone')).phone });
    expect(await dedupe.findSameAddressGroups(conn)).toEqual([]);
  });

  test('pairs through an ACTIVE property row, ignores an inactive one', async () => {
    const owner = await customer({ address_line1: '5 Elsewhere Rd', zip: '34202' });
    const tenant = await customer();
    await conn('customer_properties').insert({ customer_id: owner, address_line1: '100 Example Loop', city: 'Sarasota', zip: '34231', active: false });
    expect(await dedupe.findSameAddressGroups(conn)).toEqual([]);
    await conn('customer_properties').where({ customer_id: owner }).update({ active: true });
    expect(pairsOf(await dedupe.findSameAddressGroups(conn))).toEqual([pair(owner, tenant)]);
  });

  test('a dismissal hides the pair (the dismissals table is keyed on the pair, not a phone); an undo sentinel does not', async () => {
    const a = await customer();
    const b = await customer();
    const [lo, hi] = [a, b].sort();
    await conn('customer_duplicate_dismissals').insert({ customer_id_a: lo, customer_id_b: hi, reason: 'undo_merge', created_by: 'test' });
    expect(pairsOf(await dedupe.findSameAddressGroups(conn))).toEqual([pair(a, b)]);
    await conn('customer_duplicate_dismissals').update({ reason: 'two households' });
    expect(await dedupe.findSameAddressGroups(conn)).toEqual([]);
  });

  test('the manual eligibility recheck reads this queue only for kind same_address', async () => {
    const a = await customer({ pipeline_stage: 'active_customer' });
    const b = await customer();
    const group = (await dedupe.findSameAddressGroups(conn))[0];
    const winnerId = group.winner.id;
    const loserId = group.candidates[0].loser.id;
    expect([winnerId, loserId].sort()).toEqual([a, b].sort());
    expect((await dedupe.duplicatePairEligibility(winnerId, loserId, conn, { kind: 'same_address' })).code).toBe('eligible');
    // The phone queue does not know this pair.
    expect((await dedupe.duplicatePairEligibility(winnerId, loserId, conn)).code).toBe('not_in_queue');
  });

  test('the merge-time recheck reads only the pair, not the building', async () => {
    const a = await customer({ pipeline_stage: 'active_customer' });
    const b = await customer();
    for (let i = 0; i < 30; i += 1) await customer({ address_line1: '100 Example Loop', address_line2: `Unit ${i + 1}` });
    const seen = [];
    const spy = (q) => seen.push({ sql: q.sql, bindings: q.bindings });
    conn.on('query', spy);
    let verdict;
    try { verdict = await dedupe.duplicatePairEligibility(a, b, conn, { kind: 'same_address' }); } finally { conn.removeListener('query', spy); }
    expect(verdict.code).toBe('eligible');
    const customerReads = seen.filter((q) => /from "customers" as "c"/.test(q.sql));
    expect(customerReads.length).toBeGreaterThan(0);
    for (const q of customerReads) {
      expect(q.sql).toMatch(/"c"\."id" in \(/);
      expect(q.bindings).toEqual(expect.arrayContaining([a, b]));
    }
    // A pair that stopped sharing a premise is refused from the same pair-scoped read.
    await conn('customers').where({ id: b }).update({ address_line2: 'Apt 2' });
    expect((await dedupe.duplicatePairEligibility(a, b, conn, { kind: 'same_address' })).code).toBe('not_in_queue');
  });

  test('a rental / family-home property does not pair; the evidence carries the matched address', async () => {
    const owner = await customer({ address_line1: '5 Elsewhere Rd', zip: '34202' });
    const tenant = await customer();
    await conn('customer_properties').insert({ customer_id: owner, address_line1: '100 Example Loop', city: 'Sarasota', zip: '34231', active: true, relationship: 'rental_owned' });
    expect(await dedupe.findSameAddressGroups(conn)).toEqual([]);
    await conn('customer_properties').where({ customer_id: owner }).update({ relationship: 'own_home' });
    const [group] = await dedupe.findSameAddressGroups(conn);
    const ev = group.candidates[0].evidence.matched_address;
    const sides = group.winner.id === owner ? [ev.winner, ev.loser] : [ev.loser, ev.winner];
    expect(sides[0]).toMatchObject({ address_line1: '100 Example Loop', via: 'property' });
    expect(sides[1]).toMatchObject({ address_line1: '100 Example Loop', via: 'primary' });
    expect(pairsOf([group])).toEqual([pair(owner, tenant)]);
  });

  test('a pair with a blank phone is listed as phone-missing and passes the pair recheck', async () => {
    const a = await customer({ pipeline_stage: 'active_customer' });
    const b = await customer({ phone: '' });
    const [group] = await dedupe.findSameAddressGroups(conn);
    expect(pairsOf([group])).toEqual([pair(a, b)]);
    expect(group.candidates[0].evidence).toMatchObject({ phones_differ: false, phone_state: 'one_missing', phone_carry: { status: 'not_applicable' } });
    const verdict = await dedupe.duplicatePairEligibility(a, b, conn, { kind: 'same_address' });
    expect(verdict.code).toBe('eligible');
    expect(verdict.candidate.reasons[0]).toBe('same_address_phone_missing');
  });

  test('one bounded read: a fixed handful of queries however many customers there are', async () => {
    for (let i = 0; i < 40; i += 1) await customer({ address_line1: `${200 + i} Sample Row`, zip: '34233' });
    await customer({ address_line1: '200 Sample Row', zip: '34233' });
    const statements = [];
    const spy = (q) => statements.push(q.sql);
    conn.on('query', spy);
    try {
      const groups = await dedupe.findSameAddressGroups(conn);
      expect(groups).toHaveLength(1);
    } finally {
      conn.removeListener('query', spy);
    }
    expect(statements.length).toBeLessThanOrEqual(20);
  });
});

maybeDescribe('same-address merge carries the phone, holds consent, and the undo restores it (PostgreSQL)', () => {
  let db;
  const made = { customers: [] };

  beforeAll(() => { db = require('../models/db'); });
  afterAll(async () => {
    const ids = made.customers;
    const best = async (fn) => { try { await fn(); } catch { /* cleanup only */ } };
    if (ids.length) {
      // Every row that points at these synthetic customers (the merge writes
      // an activity-log row, a journal row, ...) goes first, discovered from
      // the catalog so a new FK table cannot leave a stray behind.
      const fks = await db.raw(`
        SELECT c.conrelid::regclass::text AS tbl, a.attname AS col
        FROM pg_constraint c
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
        WHERE c.contype = 'f' AND c.confrelid = 'public.customers'::regclass AND c.conrelid <> 'public.customers'::regclass`)
        .then((r) => r.rows).catch(() => []);
      for (const { tbl, col } of fks) {
        await best(() => db(tbl).whereIn(col, ids).del());
      }
      await best(() => db('customers').whereIn('id', ids).del());
    }
    await db.destroy();
  });

  async function pairAtNewAddress({ winnerExtra = {}, loserExtra = {} } = {}) {
    const street = { address_line1: `${uniq()} ${digits(uniq())} Loop`, city: 'Sarasota', state: 'FL', zip: '34231' };
    const stamp = String(uniq()).padStart(4, '0').slice(-4);
    const winnerPhone = `+1941777${stamp}`;
    const loserPhone = `+1941888${stamp}`;
    const winnerId = randomUUID();
    const loserId = randomUUID();
    made.customers.push(winnerId, loserId);
    await db('customers').insert({
      id: winnerId, first_name: 'Alex', last_name: 'Example', phone: winnerPhone, pipeline_stage: 'active_customer', active: true, ...street, ...winnerExtra,
    });
    await db('customers').insert({
      id: loserId, first_name: 'Blake', last_name: 'Sample', phone: loserPhone, pipeline_stage: 'new_lead', active: true, ...street, ...loserExtra,
    });
    return { winnerId, loserId, winnerPhone, loserPhone };
  }
  const mergeSameAddress = (winnerId, loserId) => dedupe.executeMerge({
    winnerId, loserId, mode: 'manual', performedBy: 'test:same-address', requireQueueEligibility: true, pairKind: 'same_address',
    evidence: { via: 'admin_review_queue', kind: 'same_address' },
  });

  test('merge: the loser phone is a slot on the kept customer, so the call pipeline finds them again; consent is held; undo restores both', async () => {
    const { winnerId, loserId, winnerPhone, loserPhone } = await pairAtNewAddress({
      loserExtra: { service_contacts_consent_at: new Date(), service_contacts_consent_source: 'call' },
    });
    const result = await mergeSameAddress(winnerId, loserId);
    expect(result.phoneCarry).toMatchObject({ status: 'carried', slot: 1 });

    const winner = await db('customers').where({ id: winnerId }).first();
    const loser = await db('customers').where({ id: loserId }).first();
    expect(winner.phone).toBe(winnerPhone);
    expect(winner.service_contact_phone).toBe(loserPhone);
    expect(winner.service_contact_name).toBe('Blake Sample');
    expect(winner.service_contact_role).toBe('family_member');
    // Consent: the loser's contact stamp is NOT copied, and the number is held out of texting.
    expect(winner.service_contacts_consent_at).toBeNull();
    const prefs = typeof winner.service_preferences === 'string' ? JSON.parse(winner.service_preferences) : winner.service_preferences;
    expect(prefs.unconsented_slot_phone_keys).toEqual([loserPhone.slice(-10)]);
    expect(loser.deleted_at).not.toBeNull();
    expect(loser.phone).toMatch(/^merged-/);

    // The pipeline's own matcher: the merged-away person calls again from their own number.
    const { findCustomerForCallContact } = require('../services/call-recording-processor')._test;
    const found = await findCustomerForCallContact(loserPhone, { first_name: 'Blake', last_name: 'Sample' });
    expect(found && found.id).toBe(winnerId);

    const undo = await dedupe.revertMerge({ journalId: result.journalId, performedBy: 'test:undo', performedById: null });
    expect(undo.winnerId).toBe(winnerId);
    const winnerAfter = await db('customers').where({ id: winnerId }).first();
    const loserAfter = await db('customers').where({ id: loserId }).first();
    expect(winnerAfter.service_contact_phone).toBeNull();
    expect(winnerAfter.service_contact_name).toBeNull();
    expect(winnerAfter.service_contact_role).toBeNull();
    const prefsAfter = winnerAfter.service_preferences;
    const parsedAfter = typeof prefsAfter === 'string' ? JSON.parse(prefsAfter) : prefsAfter;
    expect(parsedAfter?.unconsented_slot_phone_keys || []).toEqual([]);
    expect(loserAfter.deleted_at).toBeNull();
    expect(loserAfter.phone).toBe(loserPhone);
  });

  describe('undo after the carried phone was changed on the kept customer', () => {
    const prefsOf = (row) => {
      const raw = row.service_preferences;
      return (typeof raw === 'string' ? JSON.parse(raw) : raw) || {};
    };
    async function mergedPair() {
      const pair = await pairAtNewAddress();
      const result = await mergeSameAddress(pair.winnerId, pair.loserId);
      expect(result.phoneCarry).toMatchObject({ status: 'carried', slot: 1 });
      return { ...pair, journalId: result.journalId };
    }
    const undo = (journalId) => dedupe.revertMerge({ journalId, performedBy: 'test:undo', performedById: null });

    test('number kept but the contact edited: 409, nothing written, hold intact', async () => {
      const { winnerId, loserId, loserPhone, journalId } = await mergedPair();
      await db('customers').where({ id: winnerId }).update({ service_contact_name: 'Blake (edited)' });
      const before = await db('customers').where({ id: winnerId }).first();
      await expect(undo(journalId)).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/still saved on the kept customer/) });
      const after = await db('customers').where({ id: winnerId }).first();
      expect(after.service_contact_phone).toBe(loserPhone);
      expect(prefsOf(after)).toEqual(prefsOf(before));
      expect((await db('customers').where({ id: loserId }).first()).deleted_at).not.toBeNull();
    });

    test('number moved to another slot: 409 (it is still on the customer)', async () => {
      const { winnerId, loserPhone, journalId } = await mergedPair();
      await db('customers').where({ id: winnerId }).update({
        service_contact_name: null, service_contact_phone: null, service_contact_role: null,
        service_contact2_name: 'Blake', service_contact2_phone: loserPhone,
      });
      await expect(undo(journalId)).rejects.toMatchObject({ statusCode: 409 });
    });

    test('number removed by the admin: the undo goes through, the emptied slot is left alone, the orphaned hold is dropped', async () => {
      const { winnerId, loserId, loserPhone, journalId } = await mergedPair();
      await db('customers').where({ id: winnerId }).update({ service_contact_name: null, service_contact_phone: null, service_contact_role: null });
      const undone = await undo(journalId);
      expect(undone.loserId).toBe(loserId);
      const after = await db('customers').where({ id: winnerId }).first();
      expect(after.service_contact_phone).toBeNull();
      expect(prefsOf(after).unconsented_slot_phone_keys || []).not.toContain(loserPhone.slice(-10));
      expect((await db('customers').where({ id: loserId }).first()).deleted_at).toBeNull();
    });

    test('number removed AND preferences edited since: the undo goes through and drops only the orphaned hold entry', async () => {
      const { winnerId, loserPhone, journalId } = await mergedPair();
      const current = prefsOf(await db('customers').where({ id: winnerId }).first());
      await db('customers').where({ id: winnerId }).update({
        service_contact_name: null, service_contact_phone: null, service_contact_role: null,
        service_preferences: JSON.stringify({ ...current, unconsented_slot_phone_keys: [...current.unconsented_slot_phone_keys, '9415550188'], note: 'edited' }),
      });
      await undo(journalId);
      const prefs = prefsOf(await db('customers').where({ id: winnerId }).first());
      expect(prefs.unconsented_slot_phone_keys).toEqual(['9415550188']);
      expect(prefs.note).toBe('edited');
      expect(prefs.unconsented_slot_phone_keys).not.toContain(loserPhone.slice(-10));
    });

    test('slot now holds a different number: the undo goes through and that number is untouched', async () => {
      const { winnerId, loserId, journalId } = await mergedPair();
      await db('customers').where({ id: winnerId }).update({ service_contact_name: 'Someone', service_contact_phone: '+19415550155', service_contact_role: 'tenant' });
      await undo(journalId);
      const after = await db('customers').where({ id: winnerId }).first();
      expect([after.service_contact_name, after.service_contact_phone, after.service_contact_role]).toEqual(['Someone', '+19415550155', 'tenant']);
      expect((await db('customers').where({ id: loserId }).first()).deleted_at).toBeNull();
    });

    test('slot unchanged: the undo clears it (covered end to end above)', async () => {
      const { winnerId, journalId } = await mergedPair();
      await undo(journalId);
      expect((await db('customers').where({ id: winnerId }).first()).service_contact_phone).toBeNull();
    });
  });

  test('merging a pair whose loser has no phone succeeds and reports nothing to carry', async () => {
    const { winnerId, loserId } = await pairAtNewAddress({ loserExtra: { phone: '' } });
    const result = await mergeSameAddress(winnerId, loserId);
    expect(result.phoneCarry).toMatchObject({ status: 'not_applicable' });
    const winner = await db('customers').where({ id: winnerId }).first();
    expect(winner.service_contact_phone).toBeNull();
    expect((await db('customers').where({ id: loserId }).first()).deleted_at).not.toBeNull();
  });

  test('no free slot: the merge still succeeds, the phone is left, and the result says so', async () => {
    const { winnerId, loserId } = await pairAtNewAddress({
      winnerExtra: {
        service_contact_name: 'A', service_contact_phone: '+19415550171',
        service_contact2_name: 'B', service_contact2_phone: '+19415550172',
        service_contact3_name: 'C', service_contact3_phone: '+19415550173',
      },
    });
    const result = await mergeSameAddress(winnerId, loserId);
    expect(result.phoneCarry.status).toBe('no_free_slot');
    const winner = await db('customers').where({ id: winnerId }).first();
    expect([winner.service_contact_phone, winner.service_contact2_phone, winner.service_contact3_phone])
      .toEqual(['+19415550171', '+19415550172', '+19415550173']);
  });

  test('a same-address merge is refused without the locked queue pair: a pair at different addresses cannot be merged as same_address', async () => {
    const { winnerId, loserId } = await pairAtNewAddress({ loserExtra: { address_line1: `${uniq()} ${digits(uniq())} Court`, zip: '34202' } });
    await expect(mergeSameAddress(winnerId, loserId)).rejects.toThrow(/no longer mergeable/);
    expect((await db('customers').where({ id: loserId }).first()).deleted_at).toBeNull();
  });

  test('a pair that shares a phone is refused as same_address (it belongs to the phone queue)', async () => {
    const { winnerId, loserId, winnerPhone } = await pairAtNewAddress();
    await db('customers').where({ id: loserId }).update({ phone: winnerPhone });
    await expect(mergeSameAddress(winnerId, loserId)).rejects.toThrow(/no longer mergeable/);
  });
});
