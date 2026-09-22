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
    // Round 6: "compounded" means priced under computeStackedDocumentDiscountLines
    // while the gate was live, which stamps stacking_regime: "compound" —
    // carried explicitly so this fixture represents that history.
    const persisted = [
      { client_id: 'line-1', description: 'Pest', quantity: 1, unit_price: 100, amount: 100 },
      { client_id: 'd1', discount_id: tenId, discount_for: 'line-1', description: 'Ten Percent', quantity: 1, unit_price: -10, amount: -10, stacking_regime: 'compound' },
      { client_id: 'd2', discount_id: fiveId, discount_for: 'line-1', description: 'Five Percent', quantity: 1, unit_price: -4.5, amount: -4.5, stacking_regime: 'compound' },
    ];
    // Gate OFF at edit time — deliberately NOT setting GATE_DISCOUNT_STACKING.
    const result = await calculateUpdateFinancials({
      lineItems: persisted,
      customer: { property_type: 'residential' },
      invoice: { id: 'invoice-1', line_items: JSON.stringify(persisted) },
    });
    expect(result.discount_amount).toBe(14.5);
  });

  // Round 6 companion: a PRE-LANE persisted percentage discount (no
  // stacking_regime marker at all — never once saved while the gate was
  // live) still live-recomputes against a changed parent gross under gate
  // OFF — byte-identical to main — real catalog rows, real round trip.
  test('a PRE-LANE persisted 10% discount recomputes live on a price edit under gate OFF — byte-identical to main', async () => {
    const { calculateUpdateFinancials } = InvoiceService._internals;
    const tenId = randomUUID();
    await trx('discounts').insert([
      { id: tenId, discount_key: `ten_${tenId.slice(0, 8)}`, name: 'Ten Percent', discount_type: 'percentage', amount: 10, is_active: true, show_in_invoices: true },
    ]);
    const persisted = [
      { client_id: 'line-1', description: 'Pest', quantity: 1, unit_price: 100, amount: 100 },
      { client_id: 'd1', discount_id: tenId, discount_for: 'line-1', description: 'Ten Percent', quantity: 1, unit_price: -10, amount: -10 },
    ];
    const submitted = [
      { client_id: 'line-1', description: 'Pest', quantity: 1, unit_price: 200, amount: 200 },
      { client_id: 'd1', discount_id: tenId, discount_for: 'line-1', description: 'Ten Percent', quantity: 1, unit_price: -10, amount: -10 },
    ];
    const result = await calculateUpdateFinancials({
      lineItems: submitted,
      customer: { property_type: 'residential' },
      invoice: { id: 'invoice-1', line_items: JSON.stringify(persisted) },
    });
    expect(result.discount_amount).toBe(20);
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

  // Coordinator scope extension (2026-09, slice 8 of #4405 / PR #4659):
  // a FRESH document-wide (unparented) FIXED-type catalog pick — real
  // catalog row, real round trip — must SAVE and must record its
  // catalog attribution in invoice_discounts for discounts.times_applied
  // / total_discount_given to roll up.
  test('a document-wide $25 FIXED catalog pick alongside a 10% line pick on the same $100 line saves correctly and records real catalog attribution', async () => {
    process.env.GATE_DISCOUNT_STACKING = 'true';
    const linePctId = randomUUID();
    const docFixedId = randomUUID();
    await trx('discounts').insert([
      { id: linePctId, discount_key: `line10_${linePctId.slice(0, 8)}`, name: 'Ten Percent', discount_type: 'percentage', amount: 10, is_active: true, show_in_invoices: true },
      { id: docFixedId, discount_key: `doc25_${docFixedId.slice(0, 8)}`, name: 'Twenty Five Invoice-Wide', discount_type: 'fixed_amount', amount: 25, is_active: true, show_in_invoices: true },
    ]);
    const invoice = await InvoiceService.create({
      customerId: await insertCustomer(),
      title: 'Document-wide catalog pick',
      lineItems: [
        { client_id: 'line-1', description: 'Quarterly Pest', quantity: 1, unit_price: 100, amount: 100 },
        { client_id: 'd-line', discount_id: linePctId, discount_for: 'line-1', description: 'Ten Percent', quantity: 1, unit_price: -1, amount: -1 },
        { client_id: 'd-doc', discount_id: docFixedId, discount_for: null, description: 'Twenty Five Invoice-Wide', quantity: 1, unit_price: -1, amount: -1 },
      ],
    });
    // Fixed credit ($25) resolves first against the $100 line, leaving
    // $75; the 10% line pick then takes $7.50 off that remainder.
    expect(Number(invoice.discount_amount)).toBe(32.5);
    expect(Number(invoice.total)).toBe(67.5);
    const auditRows = await trx('invoice_discounts').where({ invoice_id: invoice.id });
    const docRow = auditRows.find((r) => r.discount_id === docFixedId);
    expect(docRow).toBeTruthy();
    expect(Number(docRow.discount_dollars)).toBe(25);
  });

  // Same fixture, through the EDIT save path — calculateUpdateFinancials
  // shares computeStackedDocumentDiscountLines with create(), so a
  // no-op resubmit of the same document-wide pick must retotal to the
  // identical figure, not silently drift on a later, unrelated edit —
  // the exact invariant a document-wide PERCENTAGE pick would have
  // broken (see the rejection test below).
  test('the same document-wide fixed pick resubmitted unchanged through calculateUpdateFinancials still totals the same $32.50', async () => {
    process.env.GATE_DISCOUNT_STACKING = 'true';
    const linePctId = randomUUID();
    const docFixedId = randomUUID();
    await trx('discounts').insert([
      { id: linePctId, discount_key: `line10b_${linePctId.slice(0, 8)}`, name: 'Ten Percent', discount_type: 'percentage', amount: 10, is_active: true, show_in_invoices: true },
      { id: docFixedId, discount_key: `doc25b_${docFixedId.slice(0, 8)}`, name: 'Twenty Five Invoice-Wide', discount_type: 'fixed_amount', amount: 25, is_active: true, show_in_invoices: true },
    ]);
    const items = [
      { client_id: 'line-1', description: 'Quarterly Pest', quantity: 1, unit_price: 100, amount: 100 },
      { client_id: 'd-line', discount_id: linePctId, discount_for: 'line-1', description: 'Ten Percent', quantity: 1, unit_price: -1, amount: -1 },
      { client_id: 'd-doc', discount_id: docFixedId, discount_for: null, description: 'Twenty Five Invoice-Wide', quantity: 1, unit_price: -1, amount: -1 },
    ];
    const result = await InvoiceService._internals.calculateUpdateFinancials({
      lineItems: items,
      customer: { property_type: 'residential' },
      invoice: { id: 'invoice-1', line_items: JSON.stringify([]) },
    });
    expect(result.discount_amount).toBe(32.5);
  });

  // Round 2 of this scope extension rejected a document-wide PERCENTAGE
  // pick outright (a real, then-necessary guard against the exact
  // replay-drift bug the next test below reproduces). Round 3 fixes the
  // ROOT cause in discount-stack.js (persisted sortKind/sortValue/sortCap
  // — see that file's own module header and
  // discount-stack-replay-invariance-property.test.js) instead of
  // excluding the type, so this now SAVES correctly — real catalog row,
  // real round trip.
  test('a document-wide 10% PERCENTAGE catalog pick alongside a 10% line pick on the same $100 line saves $81, real catalog rows, real round trip', async () => {
    process.env.GATE_DISCOUNT_STACKING = 'true';
    const linePctId = randomUUID();
    const docPctId = randomUUID();
    await trx('discounts').insert([
      { id: linePctId, discount_key: `linepct_${linePctId.slice(0, 8)}`, name: 'Ten Percent', discount_type: 'percentage', amount: 10, is_active: true, show_in_invoices: true },
      { id: docPctId, discount_key: `docpct_${docPctId.slice(0, 8)}`, name: 'Ten Percent Invoice-Wide', discount_type: 'percentage', amount: 10, is_active: true, show_in_invoices: true },
    ]);
    const invoice = await InvoiceService.create({
      customerId: await insertCustomer(),
      title: 'Document-wide percentage pick',
      lineItems: [
        { client_id: 'line-1', description: 'Quarterly Pest', quantity: 1, unit_price: 100, amount: 100 },
        { client_id: 'd-line', discount_id: linePctId, discount_for: 'line-1', description: 'Ten Percent', quantity: 1, unit_price: -1, amount: -1 },
        { client_id: 'd-doc', discount_id: docPctId, discount_for: null, description: 'Ten Percent Invoice-Wide', quantity: 1, unit_price: -1, amount: -1 },
      ],
    });
    expect(Number(invoice.discount_amount)).toBe(19);
    expect(Number(invoice.total)).toBe(81);
    const auditRows = await trx('invoice_discounts').where({ invoice_id: invoice.id });
    const docRow = auditRows.find((r) => r.discount_id === docPctId);
    expect(docRow).toBeTruthy();
    expect(Number(docRow.discount_dollars)).toBe(9);
  });

  // The auditor's OWN round-1 reproduction, end to end through a REAL
  // create() save followed by a REAL calculateUpdateFinancials resubmit
  // of the saved line_items unchanged — real catalog rows, real
  // Postgres round trip. Pre-fix, this totaled $50 on save and $66.67 on
  // the unchanged resubmit.
  test("round-1 auditor repro, real round trip: a $50 line-1 credit + a 50% invoice-wide discount on $50/$100 lines totals $50 on save AND on an unchanged resubmit, never $66.67", async () => {
    process.env.GATE_DISCOUNT_STACKING = 'true';
    const fixedId = randomUUID();
    const docPctId = randomUUID();
    await trx('discounts').insert([
      { id: fixedId, discount_key: `fifty_${fixedId.slice(0, 8)}`, name: 'Fifty Dollars', discount_type: 'fixed_amount', amount: 50, is_active: true, show_in_invoices: true },
      { id: docPctId, discount_key: `fiftypct_${docPctId.slice(0, 8)}`, name: 'Fifty Percent Invoice-Wide', discount_type: 'percentage', amount: 50, is_active: true, show_in_invoices: true },
    ]);
    const invoice = await InvoiceService.create({
      customerId: await insertCustomer(),
      title: 'Round-1 auditor repro',
      lineItems: [
        { client_id: 'line-1', description: 'Pest', quantity: 1, unit_price: 50, amount: 50 },
        { client_id: 'line-2', description: 'Lawn', quantity: 1, unit_price: 100, amount: 100 },
        { client_id: 'd-line', discount_id: fixedId, discount_for: 'line-1', description: 'Fifty Dollars', quantity: 1, unit_price: -1, amount: -1 },
        { client_id: 'd-doc', discount_id: docPctId, discount_for: null, description: 'Fifty Percent Invoice-Wide', quantity: 1, unit_price: -1, amount: -1 },
      ],
    });
    expect(Number(invoice.total)).toBe(50);

    // Resubmit the SAVED line_items (as persisted, straight off the
    // invoice row) completely unchanged through the edit path.
    const savedLineItems = typeof invoice.line_items === 'string' ? JSON.parse(invoice.line_items) : invoice.line_items;
    const resaved = await InvoiceService._internals.calculateUpdateFinancials({
      lineItems: savedLineItems,
      customer: { property_type: 'residential' },
      invoice: { id: invoice.id, line_items: JSON.stringify(savedLineItems) },
    });
    expect(resaved.total).toBe(50);
    expect(resaved.total).not.toBeCloseTo(66.67, 2);
  });

  // Pre-push audit P1 (coordinator scope extension, round 4): a direct
  // API request (bypassing the client picker, which never offers
  // free_service invoice-wide) must not be able to zero out every line —
  // real catalog row, real create() round trip.
  test('a document-wide free_service catalog pick is REJECTED by create() with a clean operational 400 — real catalog row, real round trip', async () => {
    process.env.GATE_DISCOUNT_STACKING = 'true';
    const freeSvcId = randomUUID();
    await trx('discounts').insert([
      { id: freeSvcId, discount_key: `freesvc_${freeSvcId.slice(0, 8)}`, name: 'Free Service', discount_type: 'free_service', amount: 0, is_active: true, show_in_invoices: true },
    ]);
    let caught;
    try {
      await InvoiceService.create({
        customerId: await insertCustomer(),
        title: 'Document-wide free_service pick, rejected',
        lineItems: [
          { client_id: 'line-1', description: 'Pest', quantity: 1, unit_price: 100, amount: 100 },
          { client_id: 'line-2', description: 'Lawn', quantity: 1, unit_price: 100, amount: 100 },
          { client_id: 'd-doc', discount_id: freeSvcId, discount_for: null, description: 'Free Service', quantity: 1, unit_price: -1, amount: -1 },
        ],
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeTruthy();
    expect(caught.message).toMatch(/free_service discounts cannot be applied invoice-wide/);
    expect(caught.statusCode).toBe(400);
    expect(caught.code).toBe('DISCOUNT_DOCUMENT_WIDE_TYPE_UNSUPPORTED');
    // Nothing was minted — the rejection happens before any invoice row
    // is inserted.
    const rows = await trx('invoices').where({ title: 'Document-wide free_service pick, rejected' });
    expect(rows).toHaveLength(0);
  });
});
