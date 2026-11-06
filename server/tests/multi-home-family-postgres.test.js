/**
 * "Same family" link against live Postgres (skipped without DATABASE_URL; CI runs it).
 * The real linkFamily / unlinkFamily / familyMultiHomeEligible and the real
 * DiscountEngine.manualEligibilityFailures run on TEMP tables that shadow customers, audit_log and
 * multi_home_family_members on ONE pooled connection, so rows in a shared test database never leak in or out.
 * Synthetic names and addresses only.
 */
const { randomUUID } = require('node:crypto');
const knex = require('knex');

const SKIP = !process.env.DATABASE_URL;
const maybeDescribe = SKIP ? describe.skip : describe;
jest.setTimeout(120000);

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({})) }));

const family = require('../services/multi-home-family');
const DiscountEngine = require('../services/discount-engine');
const dedupe = require('../services/customer-dedupe');

const multiHomeDiscount = {
  id: 'discount-mh', discount_key: 'multi_home', name: 'Multi-Home Discount', requires_multi_home: true,
  requires_military: false, requires_senior: false, requires_waveguard_tier: null,
  service_key_filter: null, service_category_filter: null, min_subtotal: null, min_service_count: null,
};

maybeDescribe('Same family link (TEMP tables)', () => {
  let conn;

  beforeAll(async () => {
    conn = knex({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 1, max: 1 } });
    await conn.raw('CREATE TEMP TABLE customers (LIKE public.customers INCLUDING DEFAULTS INCLUDING INDEXES)');
    await conn.raw('CREATE TEMP TABLE audit_log (LIKE public.audit_log INCLUDING DEFAULTS)');
    await conn.raw('CREATE TEMP TABLE multi_home_family_members (LIKE public.multi_home_family_members INCLUDING DEFAULTS INCLUDING INDEXES)');
  });
  afterAll(async () => { if (conn) await conn.destroy(); });
  beforeEach(async () => {
    await conn('multi_home_family_members').del();
    await conn('audit_log').del();
    await conn('customers').del();
  });

  let n = 0;
  async function customer(extra = {}) {
    n += 1;
    const id = randomUUID();
    await conn('customers').insert({
      id, first_name: 'Sample', last_name: `Example${n}`, phone: `+1941555${String(3000 + n)}`,
      address_line1: `${100 + n} Example Loop`, city: 'Sarasota', state: 'FL', zip: '34231',
      pipeline_stage: 'new_lead', active: true, ...extra,
    });
    return id;
  }
  const link = (a, b) => family.linkFamily(conn, { customerId: a, otherCustomerId: b, actorId: null });
  const rowsFor = (ids) => conn('multi_home_family_members').whereIn('customer_id', ids).select('customer_id', 'family_id');
  const memberIds = (view) => view.members.map((m) => m.id).sort();

  test('linking two profiles makes one family; each side sees the other', async () => {
    const a = await customer();
    const b = await customer();
    const view = await link(a, b);
    expect(memberIds(view)).toEqual([a, b].sort());
    expect(view.members.find((m) => m.id === a).isSelf).toBe(true);
    expect(view.members.find((m) => m.id === b).isSelf).toBe(false);
    expect(view.members.find((m) => m.id === b).address).toMatch(/Example Loop, Sarasota, FL 34231/);
    const rows = await rowsFor([a, b]);
    expect(new Set(rows.map((r) => r.family_id)).size).toBe(1);
    expect(memberIds(await family.familyMembers(conn, b))).toEqual([a, b].sort());
    // One audit row per changed profile.
    expect(await conn('audit_log').where({ action: 'multi_home_family_link' })).toHaveLength(2);
    // The link never writes has_multi_home.
    expect((await conn('customers').whereIn('id', [a, b]).select('has_multi_home')).every((r) => !r.has_multi_home)).toBe(true);
  });

  test('linking a third profile joins the same family', async () => {
    const [a, b, c] = [await customer(), await customer(), await customer()];
    await link(a, b);
    const view = await link(c, a);
    expect(memberIds(view)).toEqual([a, b, c].sort());
    expect(new Set((await rowsFor([a, b, c])).map((r) => r.family_id)).size).toBe(1);
  });

  test('linking two profiles already in the same family is a no-op success', async () => {
    const [a, b] = [await customer(), await customer()];
    await link(a, b);
    const before = await conn('audit_log').count('* as c').first();
    const view = await link(b, a);
    expect(memberIds(view)).toEqual([a, b].sort());
    expect(await conn('multi_home_family_members').count('* as c').first()).toEqual({ c: '2' });
    expect(await conn('audit_log').count('* as c').first()).toEqual(before);
  });

  test('two different families is a 409 and nothing changes', async () => {
    const [a, b, c, d] = [await customer(), await customer(), await customer(), await customer()];
    await link(a, b);
    await link(c, d);
    await expect(link(a, c)).rejects.toMatchObject({ statusCode: 409, message: 'Both profiles are already in different families. Unlink one first.' });
    expect(new Set((await rowsFor([a, b, c, d])).map((r) => r.family_id)).size).toBe(2);
  });

  test('refuses a self-link (400) and a missing, inactive or deleted profile (409)', async () => {
    const a = await customer();
    await expect(link(a, a)).rejects.toMatchObject({ statusCode: 400 });
    await expect(link(a, randomUUID())).rejects.toMatchObject({ statusCode: 409 });
    const inactive = await customer({ active: false });
    await expect(link(a, inactive)).rejects.toMatchObject({ statusCode: 409 });
    const deleted = await customer({ deleted_at: new Date() });
    await expect(link(a, deleted)).rejects.toMatchObject({ statusCode: 409 });
    expect(await conn('multi_home_family_members').count('* as c').first()).toEqual({ c: '0' });
  });

  test('unlinking one of three leaves a two-profile family; unlinking one of two leaves no one-member family', async () => {
    const [a, b, c] = [await customer(), await customer(), await customer()];
    await link(a, b);
    await link(a, c);
    const afterFirst = await family.unlinkFamily(conn, { customerId: c, actorId: null });
    expect(afterFirst).toEqual({ familyId: null, members: [] });
    expect(memberIds(await family.familyMembers(conn, a))).toEqual([a, b].sort());
    await family.unlinkFamily(conn, { customerId: a, actorId: null });
    expect(await conn('multi_home_family_members').count('* as c').first()).toEqual({ c: '0' });
    expect(await family.familyMembers(conn, b)).toEqual({ familyId: null, members: [] });
    expect(await conn('audit_log').where({ action: 'multi_home_family_unlink' })).toHaveLength(3);
  });

  test('unlinking a profile that is not linked is a no-op success', async () => {
    const a = await customer();
    await expect(family.unlinkFamily(conn, { customerId: a, actorId: null })).resolves.toEqual({ familyId: null, members: [] });
  });

  test('a soft-deleted member is left out of the family view', async () => {
    const [a, b] = [await customer(), await customer()];
    await link(a, b);
    await conn('customers').where({ id: b }).update({ deleted_at: new Date() });
    expect(memberIds(await family.familyMembers(conn, a))).toEqual([a]);
  });

  test('eligible with 2 active members; not with one inactive, one deleted, no link, or a lone row', async () => {
    const [a, b] = [await customer(), await customer()];
    expect(await family.familyMultiHomeEligible(conn, a)).toBe(false);
    await link(a, b);
    expect(await family.familyMultiHomeEligible(conn, a)).toBe(true);
    expect(await family.familyMultiHomeEligible(conn, b)).toBe(true);
    await conn('customers').where({ id: b }).update({ active: false });
    expect(await family.familyMultiHomeEligible(conn, a)).toBe(false);
    await conn('customers').where({ id: b }).update({ active: true });
    expect(await family.familyMultiHomeEligible(conn, a)).toBe(true);
    await conn('customers').where({ id: b }).update({ deleted_at: new Date() });
    expect(await family.familyMultiHomeEligible(conn, a)).toBe(false);
    // A third active profile restores the count to two live members.
    await conn('customers').where({ id: b }).update({ deleted_at: null });
    const c = await customer();
    await link(a, c);
    await conn('customers').where({ id: b }).update({ active: false });
    expect(await family.familyMultiHomeEligible(conn, c)).toBe(true);
  });

  test('manualEligibilityFailures accepts the Multi-Home Discount for a linked single-home profile and refuses an unlinked one', async () => {
    const [a, b, loner] = [await customer(), await customer(), await customer()];
    await link(a, b);
    const linked = await conn('customers').where({ id: a }).first();
    const unlinked = await conn('customers').where({ id: loner }).first();
    expect(Boolean(linked.has_multi_home)).toBe(false);
    await expect(DiscountEngine.manualEligibilityFailures(multiHomeDiscount, linked, {}, conn)).resolves.toEqual([]);
    await expect(DiscountEngine.manualEligibilityFailures(multiHomeDiscount, unlinked, {}, conn)).resolves.toEqual(['multi-home status']);
  });

  test('a customer merge keeps the winner\'s membership and drops the loser\'s copy (UNIQUE_COLLISION_HANDLERS)', async () => {
    const [winner, loser, other] = [await customer(), await customer(), await customer()];
    await link(winner, other);
    await link(loser, other);
    expect(await rowsFor([winner, loser, other])).toHaveLength(3);
    const handler = dedupe._test.UNIQUE_COLLISION_HANDLERS.multi_home_family_members;
    expect(handler).toBe(dedupe._test.repointRowwiseDropCollisions);
    // Winner is already a member: the loser's row collides on UNIQUE(customer_id) and drops.
    await conn.transaction((trx) => handler(trx, 'multi_home_family_members', 'customer_id', winner, loser));
    expect((await rowsFor([winner, loser, other])).map((r) => r.customer_id).sort()).toEqual([winner, other].sort());
    // A loser alone in a family moves to the winner.
    const [w2, l2, o2] = [await customer(), await customer(), await customer()];
    await link(l2, o2);
    await conn.transaction((trx) => handler(trx, 'multi_home_family_members', 'customer_id', w2, l2));
    expect((await rowsFor([w2, o2])).map((r) => r.customer_id).sort()).toEqual([w2, o2].sort());
  });

  test('a customer deleted from the table by a merge cascade leaves no orphan row', async () => {
    const [a, b] = [await customer(), await customer()];
    await link(a, b);
    // TEMP copies carry no foreign key, so the cascade is proven by the real table definition below.
    const fk = await conn.raw(`SELECT confdeltype FROM pg_constraint
      WHERE conrelid = 'public.multi_home_family_members'::regclass AND contype = 'f'`);
    expect(fk.rows.map((r) => r.confdeltype)).toEqual(['c']);
  });

  test('link and unlink wait for the one family-changes lock, so they run one at a time', async () => {
    const [a, b, c] = [await customer(), await customer(), await customer()];
    await link(a, b);
    // A second connection holds the advisory lock every link and unlink takes first.
    const holder = knex({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 1, max: 1 } });
    try {
      const release = await new Promise((resolveHeld, rejectHeld) => {
        holder.transaction(async (trx) => {
          await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', ['multi_home_family_members:changes']);
          await new Promise((finish) => resolveHeld(finish));
        }).catch(rejectHeld);
      });
      let unlinked = false;
      const pending = family.unlinkFamily(conn, { customerId: a, actorId: null }).then(() => { unlinked = true; });
      await new Promise((r) => setTimeout(r, 300));
      expect(unlinked).toBe(false);
      release();
      await pending;
      expect(unlinked).toBe(true);
    } finally {
      await holder.destroy();
    }
    // With the lock serializing changes, a later link starts a fresh family for b and c.
    expect(memberIds(await link(b, c))).toEqual([b, c].sort());
  });
});
