// The SQL behind the weekly buy list, on the migrated PostgreSQL (CI's DB-gated pass): the
// week's visit read, the catalog and eligible-price reads, the technician's supply store, and
// the alert store (standing row, close). The lawn forecast is mocked: its own suite covers it.
// Fixture tables are LIKE copies in a throwaway schema, dropped after the suite.
const SKIP = !process.env.DATABASE_URL;
const knex = require('knex');
const { randomUUID } = require('crypto');

let mockConn;
jest.mock('../models/db', () => {
  const proxy = (...args) => mockConn(...args);
  proxy.raw = (...args) => mockConn.raw(...args);
  proxy.transaction = (...args) => mockConn.transaction(...args);
  return proxy;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/waveguard-inventory-forecast', () => ({
  buildWaveGuardInventoryForecast: jest.fn(async () => ({ serviceIds: [], serviceCount: 0, products: [], errors: [], skippedNonProgram: [] })),
}));

const { buildWeeklyBuyList } = require('../services/procurement/weekly-buy-list');
const { runWeeklyBuyList } = require('../services/procurement/weekly-buy-alert');

const TABLES = ['scheduled_services', 'technicians', 'products_catalog', 'vendors', 'vendor_pricing', 'notifications', 'services', 'service_completion_profiles', 'product_restock_requests', 'vendor_orders'];
const NOW = new Date('2026-12-09T12:00:00Z'); // Wednesday; the week is Dec 7 to Dec 12

jest.setTimeout(60000);
(SKIP ? describe.skip : describe)('weekly buy list on PostgreSQL', () => {
  const schema = `weekly_buy_${randomUUID().replaceAll('-', '')}`;
  let techId;

  beforeAll(async () => {
    mockConn = knex({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema, 'public'], pool: { min: 0, max: 4 } });
    await mockConn.raw('CREATE SCHEMA ??', [schema]);
    for (const table of TABLES) await mockConn.raw('CREATE TABLE ??.?? (LIKE public.?? INCLUDING ALL)', [schema, table, table]);
    // The completion profile the Waves Assessment resolves to (internal-only), copied from the migrated catalog.
    await mockConn.raw("INSERT INTO ??.services SELECT * FROM public.services WHERE service_key = 'lawn_inspection'", [schema]);
    await mockConn.raw("INSERT INTO ??.service_completion_profiles SELECT * FROM public.service_completion_profiles WHERE service_key = 'lawn_inspection'", [schema]);
    // The DB-side defaults a LIKE copy loses on columns the app fills; ids are given in the inserts.
    [{ id: techId }] = await mockConn('technicians').insert({ id: randomUUID(), name: 'Alex Sample', email: 'alex@example.test', supply_store: 'Synthetic Supply North', role: 'technician' }).returning('id');
    const [vendor, other] = await mockConn('vendors').insert([{ id: randomUUID(), name: 'Synthetic Supply', code: 9998 }, { id: randomUUID(), name: 'Other Supply', code: 9999 }]).returning('id');
    const [cross] = await mockConn('products_catalog').insert({ id: randomUUID(), name: 'LESCO CrossCheck Plus', active: true, inventory_unit: 'gal', inventory_on_hand: '0.01' }).returning('id');
    await mockConn('products_catalog').insert({ id: randomUUID(), name: 'Synthetic Yard Sign', active: true, inventory_unit: 'each', inventory_on_hand: 0, per_completion_usage: 1, per_completion_service_lines: JSON.stringify(['pest']) });
    // A kit product (one per pest visit) with orders in every state the list must read: marked ordered by hand,
    // a placing automatic order on a still-open request, an ordered request whose order was revoked (its own
    // request figure counts, not the revoked order's), and the ones that are NOT supply (an open request with no
    // order, a received request).
    const [stake] = await mockConn('products_catalog').insert({ id: randomUUID(), name: 'Synthetic Stake', active: true, inventory_unit: 'each', inventory_on_hand: 0, per_completion_usage: 1, per_completion_service_lines: JSON.stringify(['pest']) }).returning('id');
    const request = (status, quantity) => ({ id: randomUUID(), product_id: stake.id, status, requested_quantity: quantity, unit: 'each' });
    const requests = [request('ordered', 1), request('open', 1), request('open', 50), request('received', 50), request('ordered', 1)];
    await mockConn('product_restock_requests').insert(requests);
    await mockConn('vendor_orders').insert([
      { id: randomUUID(), restock_request_id: requests[1].id, adapter: 'synthetic', status: 'placing', request_payload: JSON.stringify({ orderedQuantity: 1 }) },
      { id: randomUUID(), restock_request_id: requests[4].id, adapter: 'synthetic', status: 'placed', placed_at: new Date(), request_payload: JSON.stringify({ orderedQuantity: 99 }), evidence: JSON.stringify({ revokedAt: '2026-12-01T00:00:00Z' }) },
    ]);
    await mockConn('vendor_pricing').insert([
      { id: randomUUID(), product_id: cross.id, vendor_id: vendor.id, quantity: '2.5 gal', price: 100, price_amount: 100, is_best_price: true, is_active: true, approval_status: 'approved' },
      { id: randomUUID(), product_id: cross.id, vendor_id: other.id, quantity: '1 gal', price: 1, price_amount: 1, is_best_price: false, is_active: true, approval_status: 'pending' },
    ]);
    const visit = (service_type, scheduled_date, status, technician_id) => ({ id: randomUUID(), service_type, scheduled_date, status, technician_id, is_callback: false });
    await mockConn('scheduled_services').insert([
      visit('Quarterly Pest Control', '2026-12-10', 'confirmed', techId),
      visit('Quarterly Pest Control', '2026-12-11', 'pending', techId),
      visit('Quarterly Pest Control', '2026-12-08', 'pending', techId), // before today: not counted on a Wednesday run
      visit('Quarterly Pest Control', '2026-12-10', 'cancelled', techId),
      visit('Quarterly Pest Control', '2026-12-10', 'completed', techId),
      visit('Quarterly Pest Control', '2026-12-14', 'pending', techId), // next week
      visit('Quarterly Pest Control', '2026-12-12', 'pending', null),
      visit('Cockroach Control', '2026-12-10', 'pending', techId),
      // Not real bookings: moved, no-show and skipped visits, and an estimate-slot hold (live, and one awaiting cleanup).
      visit('Quarterly Pest Control', '2026-12-10', 'rescheduled', techId),
      visit('Quarterly Pest Control', '2026-12-10', 'no_show', techId),
      visit('Quarterly Pest Control', '2026-12-10', 'skipped', techId),
      { ...visit('Quarterly Pest Control', '2026-12-10', 'pending', techId), customer_id: null, reservation_expires_at: new Date(Date.now() + 600000) },
      { ...visit('Quarterly Pest Control', '2026-12-10', 'pending', techId), customer_id: null, reservation_expires_at: new Date(Date.now() - 600000) },
      // A genuine pending booking: a customer, no hold stamp.
      { ...visit('Quarterly Pest Control', '2026-12-11', 'pending', techId), customer_id: randomUUID() },
      // The Waves Assessment is an internal-only consultation: it leaves no yard sign.
      visit('Waves Assessment', '2026-12-10', 'pending', techId),
    ]);
  });
  afterAll(async () => {
    await mockConn.raw('DROP SCHEMA ?? CASCADE', [schema]);
    await mockConn.destroy();
  });

  test('reads the booked visits of the rest of the week, the eligible price row and the supply store', async () => {
    const list = await buildWeeklyBuyList({ knex: mockConn, now: NOW });
    expect(list).toMatchObject({ weekStart: '2026-12-07', weekEnd: '2026-12-12', fromDate: '2026-12-09' });
    const [tech] = list.technicians;
    expect(tech).toMatchObject({ technicianId: techId, technicianName: 'Alex Sample', supplyStore: 'Synthetic Supply North' });
    // Three booked pest visits (cancelled, completed, moved, no-show, skipped, hold, past and next-week ones are not counted;
    // the pending booking with a customer is): 7.5 fl oz of CrossCheck.
    expect(tech.warnings).toEqual([
      '1 visit of types this list does not plan yet', // the roach job; the assessment applies nothing
      'The pest house mix is missing from the catalog (surfactant, taurus sc), so it is left out', // only CrossCheck is in this fixture catalog
      'An order is being placed or waiting for review and is not confirmed yet: it is counted as on order for now.', // the placing stake order
    ]);
    const cross = tech.items.find((i) => i.name === 'LESCO CrossCheck Plus');
    // 0.01 gal on hand: the technician and the unassigned visit each buy a 2.5 gal pack; about 4.9 gal is left of
    // the 5 gal bought, which is over one pack, so no spare is added.
    expect(cross).toMatchObject({ unit: 'gal', packs: 1, packLabel: '2.5 gal', estCostCents: 10000, reasons: ['pest_mix'] });
    expect(list.unassigned.items.find((i) => i.name === 'LESCO CrossCheck Plus')).toMatchObject({ packs: 1, reasons: ['pest_mix'] });
    expect(cross.needQty).toBeCloseTo(7.5 / 128, 4);
    // The pending row at one dollar is not eligible: the approved 2.5 gal row decides the pack and the price.
    expect(list.unassigned.items.find((i) => i.name === 'Synthetic Yard Sign')).toMatchObject({ needQty: 1, shortQty: 1, packs: null }); // no price on file
    // 1 (marked ordered) + 1 (placing order) + 1 (revoked order: the request's own figure) = 3 on order for the 4 stakes needed
    expect(tech.items.find((i) => i.name === 'Synthetic Stake')).toMatchObject({ needQty: 4, onOrder: 3, shortQty: 1 });
    // one of those orders is still being placed (not confirmed): counted, and the list says so
    expect(tech.warnings).toContain('An order is being placed or waiting for review and is not confirmed yet: it is counted as on order for now.');
    expect(list.unassigned.items.find((i) => i.name === 'Synthetic Stake')).toMatchObject({ needQty: 1, onOrder: 3, shortQty: 1 }); // the same 3 are spoken for
    expect(tech.items.find((i) => i.name === 'Synthetic Yard Sign')).toMatchObject({ needQty: 4 }); // three pest visits and the roach job; not the assessment
    expect(list.unassigned.warnings).toEqual([
      'The pest house mix is missing from the catalog (surfactant, taurus sc), so it is left out',
      'An order is being placed or waiting for review and is not confirmed yet: it is counted as on order for now.',
    ]);
    expect(list.warnings).toEqual(['An order is being placed or waiting for review and is not confirmed yet: it is counted as on order for now.']);
  });

  test('the supply reads work in a snapshot of their own and inside a transaction the caller already holds', async () => {
    const alone = await buildWeeklyBuyList({ knex: mockConn, now: NOW });
    const inside = await mockConn.transaction((trx) => buildWeeklyBuyList({ knex: trx, now: NOW }));
    expect(inside.technicians[0].items).toEqual(alone.technicians[0].items);
  });

  test('alerts are written on the connection the run was given: inside a caller\'s transaction they roll back with it', async () => {
    const list = await buildWeeklyBuyList({ knex: mockConn, now: NOW });
    const key = `weekly-buy:${techId}:2026-12-07`;
    await expect(mockConn.transaction(async (trx) => {
      await runWeeklyBuyList({ knex: trx, list });
      expect(await trx('notifications').whereRaw("metadata->>'dedupeKey' = ?", [key])).toHaveLength(1); // visible to the caller's connection
      throw new Error('roll back');
    })).rejects.toThrow('roll back');
    expect(await mockConn('notifications').whereRaw("metadata->>'dedupeKey' = ?", [key])).toHaveLength(0); // and gone with it
  });

  test('the alert store: raise, rerun quietly, close when nothing is left, end last week', async () => {
    const list = await buildWeeklyBuyList({ knex: mockConn, now: NOW });
    const key = `weekly-buy:${techId}:2026-12-07`;
    const rows = () => mockConn('notifications').whereRaw("metadata->>'dedupeKey' = ?", [key]);
    expect((await runWeeklyBuyList({ knex: mockConn, list })).raised).toBeGreaterThanOrEqual(1);
    const [row] = await rows();
    expect(row.title).toBe("Inventory — buy Alex's supplies, week of Dec 7");
    expect(row.done_at).toBeNull();
    expect((await runWeeklyBuyList({ knex: mockConn, list })).unchanged).toBeGreaterThanOrEqual(1);
    expect(await rows()).toHaveLength(1);
    // Last week's alert closes on this week's run.
    await mockConn('notifications').insert({ id: randomUUID(), recipient_type: 'admin', category: 'system', title: 'Old week', body: 'x', metadata: JSON.stringify({ dedupeKey: `weekly-buy:${techId}:2026-11-30` }) });
    const empty = { ...list, technicians: [], unassigned: { ...list.unassigned, items: [], warnings: [] } };
    const result = await runWeeklyBuyList({ knex: mockConn, list: empty });
    expect(result.closed).toBe(3); // this week's two alerts (nothing short now) and last week's
    expect((await rows())[0].done_at).not.toBeNull();
    expect((await mockConn('notifications').whereRaw("metadata->>'dedupeKey' = ?", [`weekly-buy:${techId}:2026-11-30`]))[0].done_at).not.toBeNull();
  });
});
