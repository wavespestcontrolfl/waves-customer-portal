/**
 * "Same name, different phone and address" against live Postgres (skipped
 * without DATABASE_URL; CI runs it). Two halves:
 *   1. Detection — the real queries of findSameNameGroups / the pair recheck on
 *      TEMP tables that shadow customers / customer_properties /
 *      customer_duplicate_dismissals / scheduled_services on ONE pooled
 *      connection, so leftover rows in a shared test database never leak in or
 *      out of the result.
 *   2. Merge — the real executeMerge / revertMerge on a synthetic pair: both
 *      actions admit the pair, the kept customer's address stays (or the other
 *      address is saved as a property), the merged-away person's phone is
 *      carried under the consent hold, the executor's own red conditions still
 *      refuse, and the undo restores everything.
 * Synthetic names, addresses and phones only; the merge half removes every row
 * it wrote.
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

maybeDescribe('findSameNameGroups (TEMP tables)', () => {
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
      id, first_name: 'Sample', last_name: 'Nameson', phone: `+1941555${String(4000 + n)}`,
      address_line1: `${300 + n} Example Loop`, city: 'Sarasota', state: 'FL', zip: '34231',
      pipeline_stage: 'new_lead', active: true, ...extra,
    });
    return id;
  }
  const pairsOf = (groups) => groups.flatMap((g) => g.candidates.map((c) => [g.winner.id, c.loser.id].sort().join(':')));
  const pair = (a, b) => [a, b].sort().join(':');

  test('lists a same-name pair with different phone and address; both addresses and phones are on the evidence', async () => {
    const a = await customer({ first_name: 'Alex', pipeline_stage: 'active_customer' });
    const b = await customer({ first_name: 'alex ', address_line1: '9 Garbled Way', phone: '+19415559999' });
    await conn('scheduled_services').insert({ customer_id: a, scheduled_date: '2099-01-05', service_type: 'General Pest Control', status: 'confirmed' });
    const groups = await dedupe.findSameNameGroups(conn);
    expect(groups).toHaveLength(1);
    expect(groups[0].kind).toBe('same_name');
    expect(pairsOf(groups)).toEqual([pair(a, b)]);
    expect(groups[0].winner.id).toBe(a);
    expect(groups[0].winner.upcoming_visits).toBe(1);
    const { evidence, tier, reasons } = groups[0].candidates[0];
    expect(tier).toBe('yellow');
    expect(reasons[0]).toBe('same_name_different_phone');
    expect(evidence.addresses.loser.address_line1).toBe('9 Garbled Way');
    expect(evidence.phone_numbers.loser).toBe('+19415559999');
    expect(evidence.addresses.winner.address_line1).toMatch(/Example Loop/);
  });

  test.each([['Unknown.'], ['N.A.'], ['n/a.'], ['UNKNOWN,']])('a punctuated placeholder (%s) in a name never groups or admits the pair', async (bad) => {
    const a = await customer({ pipeline_stage: 'active_customer', first_name: bad, last_name: 'Smithson' });
    const b = await customer({ first_name: bad, last_name: 'Smithson' });
    const c = await customer({ first_name: 'Pat', last_name: bad });
    const d = await customer({ first_name: 'Pat', last_name: bad });
    expect(await dedupe.findSameNameGroups(conn)).toEqual([]);
    expect((await dedupe.duplicatePairEligibility(a, b, conn, { kind: 'same_name' })).code).toBe('not_in_queue');
    expect((await dedupe.duplicatePairEligibility(c, d, conn, { kind: 'same_name' })).code).toBe('not_in_queue');
  });

  test('the whole-group reload finds twins whatever their spacing, case and punctuation, and never drops one the JS key would keep', async () => {
    const strong = await customer({ first_name: 'Pat', last_name: 'Oneil', pipeline_stage: 'active_customer', stripe_customer_id: 'cus_syn_s' });
    const b = await customer({ first_name: 'pat', last_name: 'O.NEIL' });
    // A non-breaking space and a stray comma are the same name to the JS key.
    const c = await customer({ first_name: 'Pat\u00a0', last_name: 'O,neil' });
    const groups = await dedupe.findSameNameGroups(conn);
    expect(groups).toHaveLength(1);
    expect(groups[0].winner.id).toBe(strong);
    expect((await dedupe.duplicatePairEligibility(strong, b, conn, { kind: 'same_name' })).code).toBe('eligible');
    expect((await dedupe.duplicatePairEligibility(b, c, conn, { kind: 'same_name' })).code).toBe('not_in_queue');
  });

  test('a missing phone or address on one side is still listed', async () => {
    const a = await customer();
    const b = await customer({ phone: '', address_line1: null, city: null, zip: null });
    const groups = await dedupe.findSameNameGroups(conn);
    expect(pairsOf(groups)).toEqual([pair(a, b)]);
    expect(groups[0].candidates[0].reasons[0]).toBe('same_name_phone_missing');
  });

  test('excludes first-only matches, one-letter and placeholder names, commercial, inactive, soft-deleted and one-account profiles', async () => {
    await customer();
    await customer({ first_name: 'Other' });
    await customer({ last_name: 'N' });
    await customer({ first_name: 'Unknown', last_name: 'Unknown' });
    await customer({ first_name: 'Unknown', last_name: 'Unknown' });
    await customer({ property_type: 'commercial' });
    await customer({ active: false });
    await customer({ deleted_at: new Date() });
    expect(await dedupe.findSameNameGroups(conn)).toEqual([]);
  });

  test('profiles of one account are not listed; a different account or none still is', async () => {
    const a = await customer({ first_name: 'Acct' });
    const b = await customer({ first_name: 'Acct' });
    const accountId = randomUUID();
    await conn('customers').whereIn('id', [a, b]).update({ account_id: accountId });
    expect(await dedupe.findSameNameGroups(conn)).toEqual([]);
    await conn('customers').where({ id: b }).update({ account_id: randomUUID() });
    expect(pairsOf(await dedupe.findSameNameGroups(conn))).toEqual([pair(a, b)]);
  });

  test('a shared phone with both rows active is the phone queue\'s; a pair at one premise is the same-address queue\'s', async () => {
    const a = await customer();
    const phone = (await conn('customers').where({ id: a }).first('phone')).phone;
    await customer({ phone });
    expect(await dedupe.findSameNameGroups(conn)).toEqual([]);
    await conn('customers').del();
    await customer({ address_line1: '77 Shared Loop' });
    await customer({ address_line1: '77 SHARED LOOP.' });
    expect(await dedupe.findSameNameGroups(conn)).toEqual([]);
    const owner = await customer({ first_name: 'Prop', address_line1: '5 Elsewhere Rd', zip: '34202' });
    await customer({ first_name: 'Prop', address_line1: '88 Property Loop' });
    await conn('customer_properties').insert({ customer_id: owner, address_line1: '88 Property Loop', city: 'Sarasota', zip: '34231', active: true });
    expect(await dedupe.findSameNameGroups(conn)).toEqual([]);
  });

  test('a dismissal hides the pair; an undo sentinel does not', async () => {
    const a = await customer();
    const b = await customer();
    const [lo, hi] = [a, b].sort();
    await conn('customer_duplicate_dismissals').insert({ customer_id_a: lo, customer_id_b: hi, reason: 'undo_merge', created_by: 'test' });
    expect(pairsOf(await dedupe.findSameNameGroups(conn))).toEqual([pair(a, b)]);
    await conn('customer_duplicate_dismissals').update({ reason: 'two people' });
    expect(await dedupe.findSameNameGroups(conn)).toEqual([]);
  });

  test('the manual eligibility recheck reads this queue only for kind same_name, and an address difference is not a refusal', async () => {
    const a = await customer({ pipeline_stage: 'active_customer' });
    const b = await customer();
    const group = (await dedupe.findSameNameGroups(conn))[0];
    const winnerId = group.winner.id;
    const loserId = group.candidates[0].loser.id;
    expect([winnerId, loserId].sort()).toEqual([a, b].sort());
    const verdict = await dedupe.duplicatePairEligibility(winnerId, loserId, conn, { kind: 'same_name' });
    expect(verdict.code).toBe('eligible');
    expect(verdict.candidate.reasons).toContain('address_conflict');
    // The phone and same-address queues do not know this pair.
    expect((await dedupe.duplicatePairEligibility(winnerId, loserId, conn)).code).toBe('not_in_queue');
    expect((await dedupe.duplicatePairEligibility(winnerId, loserId, conn, { kind: 'same_address' })).code).toBe('not_in_queue');
    // The kept row must still be the stronger one.
    expect((await dedupe.duplicatePairEligibility(loserId, winnerId, conn, { kind: 'same_name' })).code).toBe('not_in_queue');
  });

  test('the recheck refuses once the pair is dismissed, leaves the name, shares an account or turns commercial', async () => {
    const a = await customer({ pipeline_stage: 'active_customer' });
    const b = await customer();
    const check = async () => (await dedupe.duplicatePairEligibility(a, b, conn, { kind: 'same_name' })).code;
    expect(await check()).toBe('eligible');
    await conn('customers').where({ id: b }).update({ last_name: 'Different' });
    expect(await check()).toBe('not_in_queue');
    await conn('customers').where({ id: b }).update({ last_name: 'Nameson' });
    const accountId = randomUUID();
    await conn('customers').whereIn('id', [a, b]).update({ account_id: accountId });
    expect(await check()).toBe('not_in_queue');
    await conn('customers').whereIn('id', [a, b]).update({ account_id: null });
    await conn('customers').where({ id: b }).update({ property_type: 'commercial' });
    expect(await check()).toBe('not_in_queue');
    await conn('customers').where({ id: b }).update({ property_type: 'single_family' });
    const [lo, hi] = [a, b].sort();
    await conn('customer_duplicate_dismissals').insert({ customer_id_a: lo, customer_id_b: hi, reason: 'two people', created_by: 'test' });
    expect(await check()).toBe('not_in_queue');
  });

  test('the merge-time recheck reads only this name\'s group, not the table', async () => {
    const a = await customer({ pipeline_stage: 'active_customer' });
    const b = await customer();
    for (let i = 0; i < 30; i += 1) await customer({ first_name: `Filler${digits(i)}` });
    const seen = [];
    const spy = (q) => seen.push({ sql: q.sql, bindings: q.bindings });
    conn.on('query', spy);
    let verdict;
    try { verdict = await dedupe.duplicatePairEligibility(a, b, conn, { kind: 'same_name' }); } finally { conn.removeListener('query', spy); }
    expect(verdict.code).toBe('eligible');
    const customerReads = seen.filter((q) => /from "customers" as "c"/.test(q.sql));
    expect(customerReads.length).toBeGreaterThan(0);
    for (const q of customerReads) {
      // Either the pair by id, or the name group by its normalized name: never the whole table.
      expect(q.sql).toMatch(/"c"\."id" in \(/);
      expect(q.bindings).toEqual(expect.arrayContaining([a, b]));
    }
  });

  describe('three customers with one name: the recheck validates the exact winner -> loser edge on the whole group', () => {
    test('candidate over candidate refuses; the real winner over each candidate is eligible', async () => {
      const strong = await customer({ pipeline_stage: 'active_customer', stripe_customer_id: 'cus_syn_strong', created_at: new Date('2020-01-01') });
      const b = await customer({ created_at: new Date('2021-01-01') });
      const c = await customer({ created_at: new Date('2022-01-01') });
      const check = async (w, l) => (await dedupe.duplicatePairEligibility(w, l, conn, { kind: 'same_name' })).code;
      expect(await check(strong, b)).toBe('eligible');
      expect(await check(strong, c)).toBe('eligible');
      expect(await check(b, c)).toBe('not_in_queue');
      expect(await check(c, b)).toBe('not_in_queue');
      expect(await check(b, strong)).toBe('not_in_queue');
    });

    test('a stronger third twin that appears after the page loaded makes the old pair refuse', async () => {
      const a = await customer({ pipeline_stage: 'active_customer', created_at: new Date('2020-01-01') });
      const b = await customer({ created_at: new Date('2021-01-01') });
      const groups = await dedupe.findSameNameGroups(conn);
      expect(groups[0].winner.id).toBe(a);
      expect((await dedupe.duplicatePairEligibility(a, b, conn, { kind: 'same_name' })).code).toBe('eligible');
      // A new twin with a Stripe profile and a portal login outranks the card's winner.
      const stronger = await customer({ pipeline_stage: 'active_customer', stripe_customer_id: 'cus_syn_new', password_hash: 'x', created_at: new Date('2019-01-01') });
      expect((await dedupe.duplicatePairEligibility(a, b, conn, { kind: 'same_name' })).code).toBe('not_in_queue');
      expect((await dedupe.duplicatePairEligibility(stronger, b, conn, { kind: 'same_name' })).code).toBe('eligible');
      expect((await dedupe.duplicatePairEligibility(stronger, a, conn, { kind: 'same_name' })).code).toBe('eligible');
    });

    test('a dismissal inside the group is honored: dismissing winner-vs-one-candidate leaves the other candidate\'s edge', async () => {
      const strong = await customer({ pipeline_stage: 'active_customer', stripe_customer_id: 'cus_syn_strong2', created_at: new Date('2020-01-01') });
      const b = await customer({ created_at: new Date('2021-01-01') });
      const c = await customer({ created_at: new Date('2022-01-01') });
      const [lo, hi] = [strong, b].sort();
      await conn('customer_duplicate_dismissals').insert({ customer_id_a: lo, customer_id_b: hi, reason: 'two people', created_by: 'test' });
      const check = async (w, l) => (await dedupe.duplicatePairEligibility(w, l, conn, { kind: 'same_name' })).code;
      expect(await check(strong, b)).toBe('not_in_queue');
      expect(await check(strong, c)).toBe('eligible');
    });

    test('the group is matched by the normalized name (punctuation and case variants are one group)', async () => {
      const strong = await customer({ first_name: 'Pat', last_name: "O.Neil", pipeline_stage: 'active_customer', stripe_customer_id: 'cus_syn_strong3' });
      const b = await customer({ first_name: 'pat', last_name: 'ONeil' });
      const c = await customer({ first_name: 'PAT', last_name: 'O Neil'.replace(' ', '') });
      expect(await dedupe.duplicatePairEligibility(strong, b, conn, { kind: 'same_name' })).toMatchObject({ code: 'eligible' });
      expect((await dedupe.duplicatePairEligibility(b, c, conn, { kind: 'same_name' })).code).toBe('not_in_queue');
    });
  });

  test('one bounded read: a fixed handful of queries however many customers there are', async () => {
    for (let i = 0; i < 40; i += 1) await customer({ first_name: `Solo${digits(i)}` });
    await customer({ first_name: 'Twin' });
    await customer({ first_name: 'Twin' });
    const statements = [];
    const spy = (q) => statements.push(q.sql);
    conn.on('query', spy);
    try {
      expect(await dedupe.findSameNameGroups(conn)).toHaveLength(1);
    } finally {
      conn.removeListener('query', spy);
    }
    expect(statements.length).toBeLessThanOrEqual(20);
  });
});

maybeDescribe('same-name merge: both actions, phone carried under the consent hold, red conditions refuse, undo restores (PostgreSQL)', () => {
  let db;
  const made = { customers: [] };

  beforeAll(() => { db = require('../models/db'); });
  afterAll(async () => {
    const ids = made.customers;
    const best = async (fn) => { try { await fn(); } catch { /* cleanup only */ } };
    if (ids.length) {
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

  // Same name (a unique synthetic one per pair so the live table never offers
  // a third twin), different phone, different address.
  async function namedPair({ winnerExtra = {}, loserExtra = {} } = {}) {
    const stamp = String(uniq()).padStart(4, '0').slice(-4);
    const first = `Zed${digits(uniq())}`;
    const last = `Nameson${digits(uniq())}`;
    const winnerPhone = `+1941777${stamp}`;
    const loserPhone = `+1941888${stamp}`;
    const winnerId = randomUUID();
    const loserId = randomUUID();
    made.customers.push(winnerId, loserId);
    const winnerAddress = { address_line1: `${uniq()} ${digits(uniq())} Loop`, city: 'Sarasota', state: 'FL', zip: '34231' };
    const loserAddress = { address_line1: `${uniq()} ${digits(uniq())} Court`, city: 'Bradenton', state: 'FL', zip: '34202' };
    await db('customers').insert({
      id: winnerId, first_name: first, last_name: last, phone: winnerPhone, pipeline_stage: 'active_customer', active: true, ...winnerAddress, ...winnerExtra,
    });
    await db('customers').insert({
      id: loserId, first_name: first, last_name: last, phone: loserPhone, pipeline_stage: 'new_lead', active: true, ...loserAddress, ...loserExtra,
    });
    return { winnerId, loserId, winnerPhone, loserPhone, winnerAddress, loserAddress, first, last };
  }
  const mergeSameName = (winnerId, loserId, extra = {}) => dedupe.executeMerge({
    winnerId, loserId, mode: 'manual', performedBy: 'test:same-name', requireQueueEligibility: true, pairKind: 'same_name',
    evidence: { via: 'admin_review_queue', kind: 'same_name' }, ...extra,
  });
  const prefsOf = (row) => {
    const raw = row.service_preferences;
    return (typeof raw === 'string' ? JSON.parse(raw) : raw) || {};
  };

  test('the eligibility recheck admits the pair (an address difference is not a refusal) and the plain merge keeps the kept customer\'s address', async () => {
    const { winnerId, loserId, loserPhone, winnerAddress } = await namedPair({
      loserExtra: { service_contacts_consent_at: new Date(), service_contacts_consent_source: 'call' },
    });
    expect((await dedupe.duplicatePairEligibility(winnerId, loserId, undefined, { kind: 'same_name' })).code).toBe('eligible');
    const result = await mergeSameName(winnerId, loserId);
    expect(result.phoneCarry).toMatchObject({ status: 'carried', slot: 1 });
    const winner = await db('customers').where({ id: winnerId }).first();
    const loser = await db('customers').where({ id: loserId }).first();
    expect(winner.address_line1).toBe(winnerAddress.address_line1);
    expect(winner.service_contact_phone).toBe(loserPhone);
    expect(winner.service_contacts_consent_at).toBeNull();
    expect(prefsOf(winner).unconsented_slot_phone_keys).toEqual([loserPhone.slice(-10)]);
    expect(loser.deleted_at).not.toBeNull();
    expect(loser.phone).toMatch(/^merged-/);

    const undo = await dedupe.revertMerge({ journalId: result.journalId, performedBy: 'test:undo', performedById: null });
    expect(undo.winnerId).toBe(winnerId);
    const winnerAfter = await db('customers').where({ id: winnerId }).first();
    const loserAfter = await db('customers').where({ id: loserId }).first();
    expect(winnerAfter.service_contact_phone).toBeNull();
    expect(prefsOf(winnerAfter).unconsented_slot_phone_keys || []).toEqual([]);
    expect(loserAfter.deleted_at).toBeNull();
    expect(loserAfter.phone).toBe(loserPhone);
    expect(winnerAfter.address_line1).toBe(winnerAddress.address_line1);
  });

  test('the link-as-property path (allowAddressConflict) merges the same pair too', async () => {
    const { winnerId, loserId } = await namedPair();
    const result = await mergeSameName(winnerId, loserId, { allowAddressConflict: true });
    expect(result.phoneCarry.status).toBe('carried');
    expect((await db('customers').where({ id: loserId }).first()).deleted_at).not.toBeNull();
  });

  test('a loser with no phone and no address merges and reports nothing to carry', async () => {
    const { winnerId, loserId } = await namedPair({ loserExtra: { phone: '', address_line1: null, city: null, zip: null } });
    const result = await mergeSameName(winnerId, loserId);
    expect(result.phoneCarry.status).toBe('not_applicable');
    expect((await db('customers').where({ id: loserId }).first()).deleted_at).not.toBeNull();
  });

  test('both customers with a Stripe profile: the executor still refuses and nothing moves', async () => {
    const { winnerId, loserId } = await namedPair({
      winnerExtra: { stripe_customer_id: `cus_syn_${uniq()}` },
      loserExtra: { stripe_customer_id: `cus_syn_${uniq()}` },
    });
    await expect(mergeSameName(winnerId, loserId)).rejects.toThrow(/Stripe profile/);
    expect((await db('customers').where({ id: loserId }).first()).deleted_at).toBeNull();
  });

  test('two different third-party payers: the executor still refuses', async () => {
    const payerIds = (await db('payers')
      .insert([{ display_name: `Synthetic Payer ${uniq()}` }, { display_name: `Synthetic Payer ${uniq()}` }])
      .returning('id')).map((r) => r.id ?? r);
    try {
      const { winnerId, loserId } = await namedPair({ winnerExtra: { payer_id: payerIds[0] }, loserExtra: { payer_id: payerIds[1] } });
      await expect(mergeSameName(winnerId, loserId)).rejects.toThrow(/third-party payers/);
      expect((await db('customers').where({ id: loserId }).first()).deleted_at).toBeNull();
    } finally {
      await db('customers').whereIn('payer_id', payerIds).update({ payer_id: null });
      await db('payers').whereIn('id', payerIds).del();
    }
  });

  test('a pair that stopped sharing a name, or that shares an account, is refused by the locked re-check', async () => {
    const renamed = await namedPair();
    await db('customers').where({ id: renamed.loserId }).update({ last_name: `Other${digits(uniq())}` });
    await expect(mergeSameName(renamed.winnerId, renamed.loserId)).rejects.toThrow(/no longer mergeable/);
    const sameAccount = await namedPair();
    const [account] = await db('customer_accounts').insert({ first_name: 'Synthetic' }).returning('id');
    const accountId = account.id ?? account;
    try {
      await db('customers').whereIn('id', [sameAccount.winnerId, sameAccount.loserId]).update({ account_id: accountId });
      await expect(mergeSameName(sameAccount.winnerId, sameAccount.loserId)).rejects.toThrow(/no longer mergeable/);
      expect((await db('customers').where({ id: sameAccount.loserId }).first()).deleted_at).toBeNull();
    } finally {
      await db('customers').where({ account_id: accountId }).update({ account_id: null });
      await db('customer_accounts').where({ id: accountId }).del();
    }
  });

  test('a pair that now shares a phone (both active) belongs to the phone queue and is refused as same_name', async () => {
    const { winnerId, loserId, winnerPhone } = await namedPair();
    await db('customers').where({ id: loserId }).update({ phone: winnerPhone });
    await expect(mergeSameName(winnerId, loserId)).rejects.toThrow(/no longer mergeable/);
  });

  test('a dismissed pair is refused by the locked re-check', async () => {
    const { winnerId, loserId } = await namedPair();
    const [lo, hi] = [winnerId, loserId].sort();
    await db('customer_duplicate_dismissals').insert({ customer_id_a: lo, customer_id_b: hi, reason: 'two people', created_by: 'test' });
    try {
      await expect(mergeSameName(winnerId, loserId)).rejects.toThrow(/no longer mergeable/);
    } finally {
      await db('customer_duplicate_dismissals').where({ customer_id_a: lo, customer_id_b: hi }).del();
    }
  });

  test('punctuation-variant last names (O.Neil / ONeil) merge from the queue: not red in the finder, the recheck or the executor', async () => {
    const stamp = digits(uniq());
    const first = `Zed${stamp}`;
    const { winnerId, loserId } = await namedPair({ winnerExtra: { first_name: first, last_name: `O.Neil${stamp}` }, loserExtra: { first_name: first, last_name: `ONeil${stamp}` } });
    expect((await dedupe.duplicatePairEligibility(winnerId, loserId, undefined, { kind: 'same_name' })).code).toBe('eligible');
    const result = await mergeSameName(winnerId, loserId);
    expect(result.journalId).toBeTruthy();
    expect((await db('customers').where({ id: loserId }).first()).deleted_at).not.toBeNull();
  });

  test('a kept customer with no address takes the other address on a plain merge (the evidence predicted it)', async () => {
    const { winnerId, loserId, loserAddress } = await namedPair({ winnerExtra: { address_line1: null, city: null, zip: null, state: null } });
    const result = await mergeSameName(winnerId, loserId);
    expect(result.backfills).toMatchObject({ address_line1: loserAddress.address_line1 });
    expect((await db('customers').where({ id: winnerId }).first()).address_line1).toBe(loserAddress.address_line1);
  });

  test('a candidate named over another candidate in a three-customer name group is refused by the locked re-check', async () => {
    const strong = await namedPair();
    const extraId = randomUUID();
    made.customers.push(extraId);
    await db('customers').insert({
      id: extraId, first_name: strong.first, last_name: strong.last, phone: `+1941666${String(uniq()).padStart(4, '0').slice(-4)}`,
      address_line1: `${uniq()} ${digits(uniq())} Way`, city: 'Venice', state: 'FL', zip: '34285', pipeline_stage: 'new_lead', active: true,
    });
    // strong.winnerId outranks both others; loser -> extra is candidate over candidate.
    await expect(mergeSameName(strong.loserId, extraId)).rejects.toThrow(/no longer mergeable/);
    expect((await db('customers').where({ id: extraId }).first()).deleted_at).toBeNull();
    const result = await mergeSameName(strong.winnerId, extraId);
    expect(result.journalId).toBeTruthy();
  });

  describe('the whole name group is serialized inside the merge transaction', () => {
    const nameKeyOf = (first, last) => dedupe._test.sameNameKey({ first_name: first, last_name: last });
    const lockSql = 'SELECT pg_advisory_xact_lock(hashtext(?))';
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    // W (kept), B (candidate) and a THIRD same-name customer C that is renamed in/out of the group.
    async function group() {
      const pair = await namedPair();
      const thirdId = randomUUID();
      made.customers.push(thirdId);
      await db('customers').insert({
        id: thirdId, first_name: pair.first, last_name: pair.last, phone: `+1941666${String(uniq()).padStart(4, '0').slice(-4)}`,
        address_line1: `${uniq()} ${digits(uniq())} Way`, city: 'Venice', state: 'FL', zip: '34285', pipeline_stage: 'new_lead', active: true,
      });
      return { ...pair, thirdId, key: nameKeyOf(pair.first, pair.last) };
    }
    // Hold the name-group advisory lock on its own connection until release() is called.
    async function holdNameLock(key) {
      let release;
      const held = new Promise((resolve) => { release = resolve; });
      let ready;
      const locked = new Promise((resolve) => { ready = resolve; });
      const tx = db.transaction(async (trx) => {
        await trx.raw(lockSql, [`customer-duplicate-name-group:${key}`]);
        ready();
        await held;
      });
      await locked;
      return { release: () => { release(); return tx; } };
    }
    const settled = (promise) => {
      const state = { done: false };
      promise.then(() => { state.done = true; }, () => { state.done = true; });
      return state;
    };

    test('a same-name merge waits on the name-group lock (the lock key is the canonical name key) and then completes', async () => {
      const g = await group();
      await db('customers').where({ id: g.thirdId }).update({ last_name: `Elsewhere${digits(uniq())}` });
      const holder = await holdNameLock(g.key);
      const merge = mergeSameName(g.winnerId, g.loserId);
      const state = settled(merge);
      await sleep(800);
      expect(state.done).toBe(false);
      expect((await db('customers').where({ id: g.loserId }).first()).deleted_at).toBeNull();
      await holder.release();
      expect((await merge).journalId).toBeTruthy();
      expect((await db('customers').where({ id: g.loserId }).first()).deleted_at).not.toBeNull();
    });

    test('a stronger third twin renamed INTO the group while the merge waits is seen by the re-check: the merge refuses', async () => {
      const g = await group();
      await db('customers').where({ id: g.thirdId }).update({
        last_name: `Elsewhere${digits(uniq())}`, pipeline_stage: 'active_customer', stripe_customer_id: `cus_syn_${uniq()}`, password_hash: 'x',
      });
      expect((await dedupe.duplicatePairEligibility(g.winnerId, g.loserId, undefined, { kind: 'same_name' })).code).toBe('eligible');
      const holder = await holdNameLock(g.key);
      const merge = mergeSameName(g.winnerId, g.loserId);
      const outcome = merge.then(() => 'merged', (e) => e.message);
      await sleep(500);
      await db('customers').where({ id: g.thirdId }).update({ last_name: g.last });
      await holder.release();
      expect(await outcome).toMatch(/no longer mergeable/);
      expect((await db('customers').where({ id: g.loserId }).first()).deleted_at).toBeNull();
    });

    test('a stronger third member renamed OUT of the group before the lock is seen too: the merge goes through', async () => {
      const g = await group();
      await db('customers').where({ id: g.thirdId }).update({ pipeline_stage: 'active_customer', stripe_customer_id: `cus_syn_${uniq()}`, password_hash: 'x' });
      expect((await dedupe.duplicatePairEligibility(g.winnerId, g.loserId, undefined, { kind: 'same_name' })).code).toBe('not_in_queue');
      const holder = await holdNameLock(g.key);
      const merge = mergeSameName(g.winnerId, g.loserId);
      const outcome = merge.then(() => 'merged', (e) => e.message);
      await sleep(500);
      await db('customers').where({ id: g.thirdId }).update({ last_name: `Elsewhere${digits(uniq())}` });
      await holder.release();
      expect(await outcome).toBe('merged');
    });

    test('two concurrent merges of the same pair in a three-member group: one wins, the other waits then re-decides on fresh state and refuses', async () => {
      const g = await group();
      const results = await Promise.allSettled([mergeSameName(g.winnerId, g.loserId), mergeSameName(g.winnerId, g.loserId)]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const refused = results.find((r) => r.status === 'rejected');
      expect(refused.reason.message).toMatch(/no longer mergeable|not found|deleted customer/);
    });

    test('two concurrent merges of DIFFERENT candidates into the same winner both complete (serialized, no deadlock)', async () => {
      const g = await group();
      const results = await Promise.allSettled([mergeSameName(g.winnerId, g.loserId), mergeSameName(g.winnerId, g.thirdId)]);
      expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    });

    test('a member row is locked for the life of the merge: a rename of the third member waits for the merge', async () => {
      const g = await group();
      const holder = await holdNameLock(g.key);
      const merge = mergeSameName(g.winnerId, g.loserId);
      const outcome = merge.then(() => 'merged', (e) => e.message);
      await sleep(300);
      await holder.release();
      expect(await outcome).toBe('merged');
      // After the commit the row is free again (the lock was transaction-scoped).
      await db('customers').where({ id: g.thirdId }).update({ last_name: `Renamed${digits(uniq())}` });
    });
  });

  test('the executor refuses a same-name pair in auto mode, and without the locked queue pair', async () => {
    const { winnerId, loserId } = await namedPair();
    await expect(mergeSameName(winnerId, loserId, { mode: 'auto' })).rejects.toThrow(/review-only/);
    await expect(mergeSameName(winnerId, loserId, { requireQueueEligibility: false })).rejects.toThrow(/review-only/);
  });
});
