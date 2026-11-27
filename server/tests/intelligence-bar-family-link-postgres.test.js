/**
 * IB link_customer_family / unlink_customer_family against real Postgres (committed fixture rows, cleaned up): the
 * confirmed run takes the family-change lock, re-reads the card under it and runs the real linkFamily / unlinkFamily
 * inside that one transaction, so a family that changed after the card refuses with preview_changed and writes
 * nothing, and a link writes one audit row per profile. Synthetic names only.
 */
const SKIP = !process.env.DATABASE_URL;
const { randomUUID } = require('crypto');
jest.setTimeout(60000);
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const LOCAL = (() => { try { return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(process.env.DATABASE_URL).hostname); } catch { return false; } })();

(SKIP || !LOCAL ? describe.skip : describe)('IB Same family link (real PG)', () => {
  let db;
  let executeFamilyLinkTool;
  const created = [];
  const ADMIN = { isAdmin: true, technicianId: null };

  beforeAll(async () => {
    process.env.GATE_IB_PLATFORM = 'true';
    db = require('../models/db');
    ({ executeFamilyLinkTool } = require('../services/intelligence-bar/family-link-tools'));
  });

  afterAll(async () => {
    delete process.env.GATE_IB_PLATFORM;
    if (!db) return;
    if (created.length) {
      await db('multi_home_family_members').whereIn('customer_id', created).del();
      await db('audit_log').whereIn('resource_id', created).whereIn('action', ['multi_home_family_link', 'multi_home_family_unlink']).del();
      await db('customers').whereIn('id', created).del();
    }
    await db.destroy();
  });

  async function profile(last) {
    const id = randomUUID();
    await db('customers').insert({ id, first_name: 'Fixture', last_name: last, phone: `+1202555${String(1000 + created.length).slice(-4)}`, email: `${id}@example.invalid`, address_line1: '1 Fixture Way', city: 'Bradenton', state: 'FL', zip: '34201', property_type: 'residential', active: true });
    created.push(id);
    return id;
  }

  const card = (tool, input) => executeFamilyLinkTool(tool, input, ADMIN);
  const confirm = (tool, input, preview) => executeFamilyLinkTool(tool, { ...input, confirmed: true, _verified_family_link_version: preview._version }, ADMIN);
  const familyOf = async (id) => (await db('multi_home_family_members').where({ customer_id: id }).first('family_id'))?.family_id || null;

  it('links two profiles, then unlinks and dissolves the family', async () => {
    const a = await profile('FamA');
    const b = await profile('FamB');
    const input = { customer_id: a, other_customer_id: b };
    const preview = await card('link_customer_family', input);
    expect(preview).toMatchObject({ preview: true, joins_existing: false });
    expect(await familyOf(a)).toBeNull();
    expect(await confirm('link_customer_family', input, preview)).toMatchObject({ success: true });
    expect(await familyOf(a)).toBeTruthy();
    expect(await familyOf(a)).toBe(await familyOf(b));
    expect(await db('audit_log').whereIn('resource_id', [a, b]).where({ action: 'multi_home_family_link' }).count('* as n').first()).toMatchObject({ n: '2' });

    const unlinkPreview = await card('unlink_customer_family', { customer_id: a });
    expect(unlinkPreview).toMatchObject({ dissolves: true });
    expect(await confirm('unlink_customer_family', { customer_id: a }, unlinkPreview)).toMatchObject({ success: true });
    expect(await familyOf(a)).toBeNull();
    expect(await familyOf(b)).toBeNull();
  });

  it('refuses a card whose family changed after it was shown, and writes nothing', async () => {
    const a = await profile('DriftA');
    const b = await profile('DriftB');
    const c = await profile('DriftC');
    const input = { customer_id: a, other_customer_id: b };
    const preview = await card('link_customer_family', input);
    // Someone links B to C on the customer page after the card was shown.
    await require('../services/multi-home-family').linkFamily(db, { customerId: b, otherCustomerId: c });
    expect(await confirm('link_customer_family', input, preview)).toMatchObject({ code: 'preview_changed' });
    expect(await familyOf(a)).toBeNull();
  });
});
