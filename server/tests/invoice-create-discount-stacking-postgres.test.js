/**
 * Slice 5 of #4405 — REAL Postgres round trip. The mocked-db unit suites
 * (invoice-create-discount-stacking-parity.test.js,
 * invoice-discount-stacking-scoped-stamps.test.js) prove the arithmetic; this
 * file proves the REAL columns this slice reads — scheduled_services.
 * discount_service_key_filter / discount_service_category_filter /
 * service_key_snapshot and scheduled_service_addons.service_key_snapshot /
 * service_category_snapshot (migration 20260716000000) — actually exist and
 * round-trip through the real pg driver into InvoiceService.create's saved
 * discount_amount, not just a hand-typed mock shape.
 */
jest.setTimeout(30000);
let mockConnection;
jest.mock('../models/db', () => new Proxy((...args) => mockConnection(...args), {
  get(_target, key) {
    const value = mockConnection?.[key];
    return typeof value === 'function' ? value.bind(mockConnection) : value;
  },
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const postgres = process.env.DATABASE_URL ? describe : describe.skip;

postgres('InvoiceService.create discount stacking — real Postgres round trip', () => {
  const { randomUUID } = require('node:crypto');
  const InvoiceService = require('../services/invoice');
  let database;
  let trx;

  beforeAll(() => {
    const url = new URL(process.env.DATABASE_URL);
    if (!['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('Use an isolated local/CI database');
    if (!/^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname) && process.env.CI !== 'true') {
      throw new Error('Use a verified, task-private waves_qa_ database (or CI)');
    }
    database = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 2 } });
  });
  beforeEach(async () => {
    delete process.env.GATE_DISCOUNT_STACKING;
    trx = await database.transaction();
    mockConnection = trx;
  });
  afterEach(async () => { await trx.rollback(); mockConnection = database; });
  afterAll(async () => { await database.destroy(); });

  async function insertCustomer() {
    const id = randomUUID();
    await trx('customers').insert({
      id, first_name: 'Synthetic', last_name: 'DiscountStack', property_type: 'residential',
      phone: `+1555${id.replace(/-/g, '').slice(0, 7)}`, active: true,
    });
    return id;
  }

  test('a scoped appointment stamp only discounts the line it names, compounds with a fresh manual pick, and persists exactly that total', async () => {
    process.env.GATE_DISCOUNT_STACKING = 'true';
    const customerId = await insertCustomer();
    const schedId = randomUUID();
    await trx('scheduled_services').insert({
      id: schedId,
      customer_id: customerId,
      service_type: 'Pest Control',
      scheduled_date: '2099-01-15',
      status: 'confirmed',
      estimated_price: 150,
      primary_line_price: 100,
      service_key_snapshot: 'pest_control',
      service_category_snapshot: 'pest',
      discount_id: randomUUID(),
      discount_name: 'Lawn Add-on Credit',
      discount_type: 'fixed_amount',
      discount_amount: 12,
      discount_dollars: 12,
      discount_service_key_filter: 'lawn_care',
    });
    await trx('scheduled_service_addons').insert({
      id: randomUUID(),
      scheduled_service_id: schedId,
      service_name: 'Lawn Care',
      base_price: 50,
      estimated_price: 50,
      service_key_snapshot: 'lawn_care',
      service_category_snapshot: 'lawn',
    });

    const scheduledInvoice = await InvoiceService.buildLineItemsForScheduledService(schedId, {
      fallbackAmount: 150,
      fallbackDescription: 'Service visit',
    });
    // Real columns exist and round-tripped: the lawn line carries its
    // service_key, and its discount item carries the scope filter.
    expect(scheduledInvoice.lineItems.find((li) => li.description === 'Lawn Care').service_key).toBe('lawn_care');
    const stampItem = scheduledInvoice.lineItems.find((li) => li.discount_id && li.discount_for == null);
    expect(stampItem.document_scope_service_key).toBe('lawn_care');

    const invoice = await InvoiceService.create({
      customerId,
      scheduledServiceId: schedId,
      title: 'Pest Control',
      lineItems: scheduledInvoice.lineItems,
      trustedStoredDiscountSources: ['scheduled_service'],
    });

    expect(Number(invoice.subtotal)).toBe(150);
    expect(Number(invoice.discount_amount)).toBe(12);
    expect(Number(invoice.total)).toBe(138);

    const stored = await trx('invoices').where({ id: invoice.id }).first();
    expect(Number(stored.subtotal)).toBe(150);
    expect(Number(stored.discount_amount)).toBe(12);
    expect(Number(stored.total)).toBe(138);
  });

  test('the same scoped stamp resolves to $0 when its target service is not on this invoice (orphaned), never a silent overcharge', async () => {
    process.env.GATE_DISCOUNT_STACKING = 'true';
    const customerId = await insertCustomer();
    const schedId = randomUUID();
    await trx('scheduled_services').insert({
      id: schedId,
      customer_id: customerId,
      service_type: 'Pest Control',
      scheduled_date: '2099-01-15',
      status: 'confirmed',
      estimated_price: 150,
      primary_line_price: 100,
      service_key_snapshot: 'pest_control',
      service_category_snapshot: 'pest',
      discount_id: randomUUID(),
      discount_name: 'Lawn Add-on Credit',
      discount_type: 'fixed_amount',
      discount_amount: 12,
      discount_dollars: 12,
      discount_service_key_filter: 'lawn_care', // scoped to a service this visit no longer carries
    });
    await trx('scheduled_service_addons').insert({
      id: randomUUID(),
      scheduled_service_id: schedId,
      service_name: 'Mosquito',
      base_price: 50,
      estimated_price: 50,
      service_key_snapshot: 'mosquito',
      service_category_snapshot: 'mosquito',
    });

    const scheduledInvoice = await InvoiceService.buildLineItemsForScheduledService(schedId, {
      fallbackAmount: 150,
      fallbackDescription: 'Service visit',
    });
    const invoice = await InvoiceService.create({
      customerId,
      scheduledServiceId: schedId,
      title: 'Pest Control',
      lineItems: scheduledInvoice.lineItems,
      trustedStoredDiscountSources: ['scheduled_service'],
    });

    expect(Number(invoice.subtotal)).toBe(150);
    expect(Number(invoice.discount_amount)).toBe(0);
    expect(Number(invoice.total)).toBe(150);
  });

  test('gate off: the same fixture replays its full frozen amount regardless of scope — byte-identical to before this lane', async () => {
    const customerId = await insertCustomer();
    const schedId = randomUUID();
    await trx('scheduled_services').insert({
      id: schedId,
      customer_id: customerId,
      service_type: 'Pest Control',
      scheduled_date: '2099-01-15',
      status: 'confirmed',
      estimated_price: 150,
      primary_line_price: 100,
      service_key_snapshot: 'pest_control',
      service_category_snapshot: 'pest',
      discount_id: randomUUID(),
      discount_name: 'Lawn Add-on Credit',
      discount_type: 'fixed_amount',
      discount_amount: 12,
      discount_dollars: 12,
      discount_service_key_filter: 'lawn_care',
    });
    await trx('scheduled_service_addons').insert({
      id: randomUUID(),
      scheduled_service_id: schedId,
      service_name: 'Mosquito',
      base_price: 50,
      estimated_price: 50,
      service_key_snapshot: 'mosquito',
      service_category_snapshot: 'mosquito',
    });

    const scheduledInvoice = await InvoiceService.buildLineItemsForScheduledService(schedId, {
      fallbackAmount: 150,
      fallbackDescription: 'Service visit',
    });
    const invoice = await InvoiceService.create({
      customerId,
      scheduledServiceId: schedId,
      title: 'Pest Control',
      lineItems: scheduledInvoice.lineItems,
      trustedStoredDiscountSources: ['scheduled_service'],
    });

    expect(Number(invoice.discount_amount)).toBe(12);
    expect(Number(invoice.total)).toBe(138);
  });

  // Codex pre-push audit P1, round 1 on PR #4655: a stamp scoped by BOTH
  // key AND category must require BOTH to match (AND) — real columns,
  // real round trip.
  test('a stamp scoped by BOTH key and category does not match a line sharing only the category', async () => {
    process.env.GATE_DISCOUNT_STACKING = 'true';
    const customerId = await insertCustomer();
    const schedId = randomUUID();
    await trx('scheduled_services').insert({
      id: schedId,
      customer_id: customerId,
      service_type: 'Pest Control',
      scheduled_date: '2099-01-15',
      status: 'confirmed',
      estimated_price: 100,
      primary_line_price: 100,
      service_key_snapshot: 'mosquito_lawn_addon',
      service_category_snapshot: 'lawn',
      discount_id: randomUUID(),
      discount_name: 'Lawn Add-on Credit',
      discount_type: 'fixed_amount',
      discount_amount: 30,
      discount_dollars: 30,
      discount_service_key_filter: 'lawn_care',
      discount_service_category_filter: 'lawn',
    });

    const scheduledInvoice = await InvoiceService.buildLineItemsForScheduledService(schedId, {
      fallbackAmount: 100,
      fallbackDescription: 'Service visit',
    });
    const invoice = await InvoiceService.create({
      customerId,
      scheduledServiceId: schedId,
      title: 'Pest Control',
      lineItems: scheduledInvoice.lineItems,
      trustedStoredDiscountSources: ['scheduled_service'],
    });

    expect(Number(invoice.subtotal)).toBe(100);
    expect(Number(invoice.discount_amount)).toBe(0);
    expect(Number(invoice.total)).toBe(100);
  });

  // Codex pre-push audit P1, round 2 on PR #4655: two non-stackable
  // tier-group discounts on different lines are rejected — real catalog
  // rows, real round trip.
  test('WaveGuard Silver on one line plus Gold on another is REJECTED — real catalog rows, real round trip', async () => {
    process.env.GATE_DISCOUNT_STACKING = 'true';
    const customerId = await insertCustomer();
    const silverId = randomUUID();
    const goldId = randomUUID();
    await trx('discounts').insert([
      { id: silverId, discount_key: `silver_${silverId.slice(0, 8)}`, name: 'WaveGuard Silver', discount_type: 'percentage', amount: 10, is_active: true, show_in_invoices: true, stack_group: 'tier', is_stackable: false },
      { id: goldId, discount_key: `gold_${goldId.slice(0, 8)}`, name: 'WaveGuard Gold', discount_type: 'percentage', amount: 15, is_active: true, show_in_invoices: true, stack_group: 'tier', is_stackable: false },
    ]);

    await expect(InvoiceService.create({
      customerId,
      title: 'Two-tier invoice',
      lineItems: [
        { client_id: 'line-1', description: 'Pest', quantity: 1, unit_price: 100, amount: 100 },
        { client_id: 'line-2', description: 'Lawn', quantity: 1, unit_price: 100, amount: 100 },
        { discount_id: silverId, discount_for: 'line-1', description: 'WaveGuard Silver', quantity: 1, unit_price: -1, amount: -1 },
        { discount_id: goldId, discount_for: 'line-2', description: 'WaveGuard Gold', quantity: 1, unit_price: -1, amount: -1 },
      ],
    })).rejects.toThrow(/Only one WaveGuard tier discount can apply/);
  });

  // Codex pre-push audit P0, round 3 ("the gate-transition class"): a
  // persisted discount row survives a gate rollback unchanged — real
  // catalog rows, real round trip through calculateUpdateFinancials.
  test('a compounded $10+$4.50 invoice edited under gate OFF stays $14.50, never recomputed to the additive $15', async () => {
    const { calculateUpdateFinancials } = InvoiceService._internals;
    const tenId = randomUUID();
    const fiveId = randomUUID();
    await trx('discounts').insert([
      { id: tenId, discount_key: `ten_${tenId.slice(0, 8)}`, name: 'Ten Percent', discount_type: 'percentage', amount: 10, is_active: true, show_in_invoices: true },
      { id: fiveId, discount_key: `five_${fiveId.slice(0, 8)}`, name: 'Five Percent', discount_type: 'percentage', amount: 5, is_active: true, show_in_invoices: true },
    ]);
    const persisted = [
      { client_id: 'line-1', description: 'Pest', quantity: 1, unit_price: 100, amount: 100 },
      { client_id: 'd1', discount_id: tenId, discount_for: 'line-1', description: 'Ten Percent', quantity: 1, unit_price: -10, amount: -10 },
      { client_id: 'd2', discount_id: fiveId, discount_for: 'line-1', description: 'Five Percent', quantity: 1, unit_price: -4.5, amount: -4.5 },
    ];
    // Gate OFF at edit time — deliberately NOT setting GATE_DISCOUNT_STACKING.
    const result = await calculateUpdateFinancials({
      lineItems: persisted,
      customer: { property_type: 'residential' },
      invoice: { id: 'invoice-1', line_items: JSON.stringify(persisted) },
    });
    expect(result.discount_amount).toBe(14.5);
  });

  // Codex pre-push audit P1, round 4 ("the gate-transition class",
  // continued): a line-scoped trusted stamp whose target line was removed
  // resolves to $0, never a silent replay of its frozen face value — real
  // round trip through calculateUpdateFinancials.
  test('a line-scoped frozen stamp whose target line was removed resolves to $0, not its frozen $30', async () => {
    process.env.GATE_DISCOUNT_STACKING = 'true';
    const persisted = [
      { client_id: 'line-1', description: 'Pest (about to be removed)', quantity: 1, unit_price: 100, amount: 100 },
      { client_id: 'line-2', description: 'Lawn', quantity: 1, unit_price: 50, amount: 50 },
      {
        client_id: 'd1', discount_id: null, discount_for: 'line-1', description: 'Frozen Stamp',
        quantity: 1, unit_price: -30, amount: -30,
        use_stored_discount: true, stored_discount_source: 'scheduled_service', discount_dollars: 30,
      },
    ];
    const submitted = [
      { client_id: 'line-2', description: 'Lawn', quantity: 1, unit_price: 50, amount: 50 },
      {
        client_id: 'd1', discount_id: null, discount_for: 'line-1', description: 'Frozen Stamp',
        quantity: 1, unit_price: -30, amount: -30,
        use_stored_discount: true, stored_discount_source: 'scheduled_service', discount_dollars: 30,
      },
    ];
    const result = await InvoiceService._internals.calculateUpdateFinancials({
      lineItems: submitted,
      customer: { property_type: 'residential' },
      invoice: { id: 'invoice-1', line_items: JSON.stringify(persisted) },
    });
    expect(result.subtotal).toBe(50);
    expect(result.discount_amount).toBe(0);
    expect(result.total).toBe(50);
  });

  // Codex pre-push audit P0, round 4 (LAST patch round on this lane): a
  // visit booked before the gate existed, carrying two conflicting
  // non-stackable tier stamps on separate lines, mints cleanly at
  // create() — real catalog rows, real round trip. Before this fix,
  // create() always calls computeStackedDocumentDiscountLines with an
  // empty persistedClientIds (nothing IS persisted yet — the invoice
  // doesn't exist), so both booking-time stamps were marked "new" and the
  // group check threw at mint even though neither was newly added.
  test('two conflicting WaveGuard tier stamps booked before the gate existed mint cleanly — real catalog rows, real round trip', async () => {
    process.env.GATE_DISCOUNT_STACKING = 'true';
    const customerId = await insertCustomer();
    const silverId = randomUUID();
    const goldId = randomUUID();
    await trx('discounts').insert([
      { id: silverId, discount_key: `silver_${silverId.slice(0, 8)}`, name: 'WaveGuard Silver', discount_type: 'percentage', amount: 10, is_active: true, show_in_invoices: true, stack_group: 'tier', is_stackable: false },
      { id: goldId, discount_key: `gold_${goldId.slice(0, 8)}`, name: 'WaveGuard Gold', discount_type: 'percentage', amount: 15, is_active: true, show_in_invoices: true, stack_group: 'tier', is_stackable: false },
    ]);
    const invoice = await InvoiceService.create({
      customerId,
      title: 'Booked-before-gate two-tier invoice',
      lineItems: [
        { client_id: 'line-1', description: 'Pest', quantity: 1, unit_price: 100, amount: 100 },
        { client_id: 'line-2', description: 'Lawn', quantity: 1, unit_price: 100, amount: 100 },
        {
          client_id: 'd1', discount_id: silverId, discount_for: 'line-1', description: 'WaveGuard Silver',
          quantity: 1, unit_price: -10, amount: -10,
          use_stored_discount: true, stored_discount_source: 'scheduled_service', discount_dollars: 10,
        },
        {
          client_id: 'd2', discount_id: goldId, discount_for: 'line-2', description: 'WaveGuard Gold',
          quantity: 1, unit_price: -15, amount: -15,
          use_stored_discount: true, stored_discount_source: 'scheduled_service', discount_dollars: 15,
        },
      ],
      trustedStoredDiscountSources: ['scheduled_service'],
    });
    expect(Number(invoice.subtotal)).toBe(200);
    expect(Number(invoice.discount_amount)).toBe(25);
    expect(Number(invoice.total)).toBe(175);
  });

  // Codex pre-push audit P1, round 4: a persisted discount retired since
  // it was applied still blocks a fresh same-group pick — real catalog
  // rows (one flipped inactive after insert, mirroring a real retirement),
  // real round trip through calculateUpdateFinancials.
  test('a persisted-but-retired Silver still blocks a fresh same-group Gold pick on edit — real catalog rows, real round trip', async () => {
    process.env.GATE_DISCOUNT_STACKING = 'true';
    const silverId = randomUUID();
    const goldId = randomUUID();
    await trx('discounts').insert([
      { id: silverId, discount_key: `silver_${silverId.slice(0, 8)}`, name: 'WaveGuard Silver', discount_type: 'percentage', amount: 10, is_active: false, show_in_invoices: false, stack_group: 'tier', is_stackable: false },
      { id: goldId, discount_key: `gold_${goldId.slice(0, 8)}`, name: 'WaveGuard Gold', discount_type: 'percentage', amount: 15, is_active: true, show_in_invoices: true, stack_group: 'tier', is_stackable: false },
    ]);
    const persisted = [
      { client_id: 'line-1', description: 'Pest', quantity: 1, unit_price: 100, amount: 100 },
      { client_id: 'd1', discount_id: silverId, discount_for: 'line-1', description: 'WaveGuard Silver', quantity: 1, unit_price: -10, amount: -10 },
    ];
    const submitted = [
      ...persisted,
      { client_id: 'line-2', description: 'Lawn', quantity: 1, unit_price: 100, amount: 100 },
      { client_id: 'd2', discount_id: goldId, discount_for: 'line-2', description: 'WaveGuard Gold', quantity: 1, unit_price: -1, amount: -1 },
    ];
    await expect(InvoiceService._internals.calculateUpdateFinancials({
      lineItems: submitted,
      customer: { property_type: 'residential' },
      invoice: { id: 'invoice-1', line_items: JSON.stringify(persisted) },
    })).rejects.toThrow(/Only one WaveGuard tier discount can apply/);
  });
});
