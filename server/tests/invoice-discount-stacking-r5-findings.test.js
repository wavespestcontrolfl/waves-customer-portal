/**
 * GitHub round 4 on PR #4655 (90d4eba989) — 1 P0 + 3 P1 + 1 P2, the LAST
 * patch round on this lane. Filename says r5 (an earlier round already
 * claimed r4-findings.test.js for its own, DIFFERENT fix) — this covers
 * the SERVER-side findings from that round:
 *
 * P0 (invoice.js ~813): scheduled-service invoice mint (create(), and
 * every create()-backed path — createFromService, the retention-offer
 * sizing helper) called computeStackedDocumentDiscountLines with the
 * default EMPTY persistedClientIds, so every booking-time trusted stamp
 * was marked "new" for the non-stackable stack_group check — a visit
 * legitimately booked before the gate existed, with conflicting tier
 * stamps on separate lines, threw at completion mint even though neither
 * discount was newly added to the request. Fixed by deciding "new" from
 * entry.stored (source-trusted OR positionally-frozen) instead of position
 * alone — correct in every create() path AND the edit path, one change.
 *
 * P1 (invoice.js ~810): the non-stackable group check must still see a
 * PERSISTED/trusted discount's stack_group even after that catalog row is
 * retired (disabled/hidden) — loadInvoiceDiscountRows' active/visible
 * filter otherwise drops it from the check entirely, letting a fresh
 * same-group pick silently compound next to it. Fixed via
 * widenDiscountRowsForTrustedItems + loadDiscountStackMetaRows (bare,
 * unfiltered catalog metadata for trusted/persisted ids only — a retired
 * row still can never be picked FRESH).
 *
 * P2 (invoice.js ~684 / ~3253): a document term that resolves to $0
 * (an earlier credit already exhausted its eligible balance) must not
 * still contribute its name to discount_label — two $100 fixed discounts
 * on a $100 invoice must print only the first, positive-dollars name.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/tax-calculator', () => ({
  calculateTax: jest.fn(async () => ({ rate: 0, amount: 0 })),
}));
jest.mock('../services/discount-engine', () => ({
  getDiscountForTier: jest.fn(),
  recordInvoiceDiscounts: jest.fn(),
  calculateDiscounts: jest.fn(async () => ({ discounts: [] })),
}));
jest.mock('../utils/datetime-et', () => ({
  etDateString: jest.fn(() => '2026-09-22'),
  addETDays: jest.fn(() => new Date('2026-10-22T12:00:00Z')),
}));
jest.mock('../services/short-url', () => ({
  shortenOrPassthrough: jest.fn(async (url) => url),
  invoiceShortCodePrefix: jest.fn(() => 'INV'),
}));

const db = require('../models/db');
const InvoiceService = require('../services/invoice');
const { calculateUpdateFinancials } = InvoiceService._internals;

let nextId = 0;
function discountRow(overrides) {
  return {
    id: `discount-${nextId++}`,
    discount_key: `key-${nextId}`,
    name: `Discount ${nextId}`,
    discount_type: 'fixed_amount',
    amount: 10,
    max_discount_dollars: null,
    is_active: true,
    show_in_invoices: true,
    is_stackable: true,
    stack_group: null,
    ...overrides,
  };
}

// discounts table mock that ACTUALLY respects the active/visible filter —
// distinguishes loadInvoiceDiscountRows' `.where({is_active,show_in_invoices})`
// from loadDiscountStackMetaRows' bare `.whereIn` (no `.where` at all), so a
// retired row is invisible to the first and visible to the second, exactly
// like real Postgres.
// Factory (not tied to the global `db` mock) so a test can build a SECOND,
// independent connection (e.g. a fake trx) with its own discounts rows —
// used by the round-5 P1 transaction-scoping test below to prove a
// retired-metadata read lands on the CALLER'S connection, not the pool.
function makeDbImpl({ customer = null, discounts = [], tableCalls = null } = {}) {
  let insertedInvoice = null;
  const byId = new Map(discounts.map((d) => [String(d.id), d]));
  const impl = (table) => {
    if (tableCalls) tableCalls.push(table);
    if (table === 'customers') {
      return { where: jest.fn(() => ({ first: jest.fn(async () => customer) })) };
    }
    if (table === 'payers') {
      return { where: jest.fn(() => ({ first: jest.fn(async () => null), catch: () => null })) };
    }
    if (table === 'discounts') {
      const q = {
        _ids: null,
        _activeOnly: false,
        whereIn: jest.fn((_field, ids) => { q._ids = ids.map(String); return q; }),
        where: jest.fn((cond) => {
          if (cond && cond.is_active === true) q._activeOnly = true;
          return q;
        }),
        orderBy: jest.fn(() => q),
        select: jest.fn(() => q),
        first: jest.fn(async () => null),
        then: (resolve, reject) => {
          let rows = q._ids ? q._ids.map((id) => byId.get(id)).filter(Boolean) : discounts;
          if (q._activeOnly) rows = rows.filter((r) => r.is_active !== false && r.show_in_invoices !== false);
          return Promise.resolve(rows).then(resolve, reject);
        },
      };
      return q;
    }
    if (table === 'invoices') {
      const q = {
        where: jest.fn(() => q),
        whereNot: jest.fn(() => q),
        whereNotIn: jest.fn(() => q),
        orderBy: jest.fn(() => q),
        first: jest.fn(async () => null),
        insert: jest.fn((data) => {
          insertedInvoice = data;
          return { returning: jest.fn(async () => [{ id: 'invoice-1', invoice_number: data.invoice_number, ...data }]) };
        }),
      };
      return q;
    }
    const q = {
      where: jest.fn(() => q),
      whereIn: jest.fn(() => q),
      andWhere: jest.fn(() => q),
      leftJoin: jest.fn(() => q),
      orderBy: jest.fn(() => q),
      select: jest.fn(async () => []),
      first: jest.fn(async () => null),
      insert: jest.fn(async () => []),
      then: (resolve, reject) => Promise.resolve([]).then(resolve, reject),
    };
    return q;
  };
  impl.getInsertedInvoice = () => insertedInvoice;
  return impl;
}

function setupDb(opts = {}) {
  const impl = makeDbImpl(opts);
  db.mockImplementation(impl);
  return { getInsertedInvoice: impl.getInsertedInvoice };
}

const CUSTOMER = { id: 'customer-1', property_type: 'residential' };
afterEach(() => { delete process.env.GATE_DISCOUNT_STACKING; });

describe('P0: trusted stored stamps are grandfathered for the group check in EVERY create() path, not just edits', () => {
  test('two conflicting WaveGuard tier stamps booked before the gate existed mint cleanly at create() time — never throws', async () => {
    process.env.GATE_DISCOUNT_STACKING = 'true';
    const silverId = 'silver-1';
    const goldId = 'gold-1';
    setupDb({
      customer: CUSTOMER,
      discounts: [
        discountRow({ id: silverId, name: 'WaveGuard Silver', discount_type: 'percentage', amount: 10, stack_group: 'tier', is_stackable: false }),
        discountRow({ id: goldId, name: 'WaveGuard Gold', discount_type: 'percentage', amount: 15, stack_group: 'tier', is_stackable: false }),
      ],
    });
    const invoice = await InvoiceService.create({
      customerId: 'customer-1',
      title: 'Two-tier booked-before-gate invoice',
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
    expect(invoice.subtotal).toBe(200);
    expect(invoice.discount_amount).toBe(25);
    expect(invoice.total).toBe(175);
  });

  test('a trusted stamp next to a GENUINELY NEW same-group admin pick is still rejected — grandfathering never covers a fresh pick', async () => {
    process.env.GATE_DISCOUNT_STACKING = 'true';
    const silverId = 'silver-2';
    const goldId = 'gold-2';
    setupDb({
      customer: CUSTOMER,
      discounts: [
        discountRow({ id: silverId, name: 'WaveGuard Silver', discount_type: 'percentage', amount: 10, stack_group: 'tier', is_stackable: false }),
        discountRow({ id: goldId, name: 'WaveGuard Gold', discount_type: 'percentage', amount: 15, stack_group: 'tier', is_stackable: false }),
      ],
    });
    await expect(InvoiceService.create({
      customerId: 'customer-1',
      title: 'Stamp plus fresh same-group pick',
      lineItems: [
        { client_id: 'line-1', description: 'Pest', quantity: 1, unit_price: 100, amount: 100 },
        { client_id: 'line-2', description: 'Lawn', quantity: 1, unit_price: 100, amount: 100 },
        {
          client_id: 'd1', discount_id: silverId, discount_for: 'line-1', description: 'WaveGuard Silver',
          quantity: 1, unit_price: -10, amount: -10,
          use_stored_discount: true, stored_discount_source: 'scheduled_service', discount_dollars: 10,
        },
        // NOT stored — an operator's own fresh pick added in this same request.
        { client_id: 'd2', discount_id: goldId, discount_for: 'line-2', description: 'WaveGuard Gold', quantity: 1, unit_price: -1, amount: -1 },
      ],
      trustedStoredDiscountSources: ['scheduled_service'],
    })).rejects.toThrow(/Only one WaveGuard tier discount can apply/);
  });

  test('two genuinely fresh (non-stored) conflicting tier picks are still rejected — unaffected regression check', async () => {
    process.env.GATE_DISCOUNT_STACKING = 'true';
    const silverId = 'silver-3';
    const goldId = 'gold-3';
    setupDb({
      customer: CUSTOMER,
      discounts: [
        discountRow({ id: silverId, name: 'WaveGuard Silver', discount_type: 'percentage', amount: 10, stack_group: 'tier', is_stackable: false }),
        discountRow({ id: goldId, name: 'WaveGuard Gold', discount_type: 'percentage', amount: 15, stack_group: 'tier', is_stackable: false }),
      ],
    });
    await expect(InvoiceService.create({
      customerId: 'customer-1',
      title: 'Two fresh tier picks',
      lineItems: [
        { client_id: 'line-1', description: 'Pest', quantity: 1, unit_price: 100, amount: 100 },
        { client_id: 'line-2', description: 'Lawn', quantity: 1, unit_price: 100, amount: 100 },
        { discount_id: silverId, discount_for: 'line-1', description: 'WaveGuard Silver', quantity: 1, unit_price: -1, amount: -1 },
        { discount_id: goldId, discount_for: 'line-2', description: 'WaveGuard Gold', quantity: 1, unit_price: -1, amount: -1 },
      ],
    })).rejects.toThrow(/Only one WaveGuard tier discount can apply/);
  });
});

describe('P1: retired discounts still count in the non-stackable group check', () => {
  test('a persisted-but-since-retired Silver still blocks a fresh same-group Gold pick on edit', async () => {
    process.env.GATE_DISCOUNT_STACKING = 'true';
    const silverId = 'retired-silver';
    const goldId = 'active-gold';
    setupDb({
      discounts: [
        // Retired: is_active false. loadInvoiceDiscountRows would miss it —
        // widenDiscountRowsForTrustedItems must still surface its stack_group.
        discountRow({ id: silverId, name: 'WaveGuard Silver', discount_type: 'percentage', amount: 10, is_active: false, show_in_invoices: false, stack_group: 'tier', is_stackable: false }),
        discountRow({ id: goldId, name: 'WaveGuard Gold', discount_type: 'percentage', amount: 15, stack_group: 'tier', is_stackable: false }),
      ],
    });
    const persisted = [
      { client_id: 'line-1', description: 'Pest', quantity: 1, unit_price: 100, amount: 100 },
      { client_id: 'd1', discount_id: silverId, discount_for: 'line-1', description: 'WaveGuard Silver', quantity: 1, unit_price: -10, amount: -10 },
    ];
    const submitted = [
      ...persisted,
      { client_id: 'line-2', description: 'Lawn', quantity: 1, unit_price: 100, amount: 100 },
      { client_id: 'd2', discount_id: goldId, discount_for: 'line-2', description: 'WaveGuard Gold', quantity: 1, unit_price: -1, amount: -1 },
    ];
    await expect(calculateUpdateFinancials({
      lineItems: submitted,
      customer: { property_type: 'residential' },
      invoice: { id: 'invoice-1', line_items: JSON.stringify(persisted) },
    })).rejects.toThrow(/Only one WaveGuard tier discount can apply/);
  });

  test('the SAME retired Silver alone (no new same-group pick) keeps saving fine — widening never blocks an untouched edit', async () => {
    process.env.GATE_DISCOUNT_STACKING = 'true';
    const silverId = 'retired-silver-2';
    setupDb({
      discounts: [
        discountRow({ id: silverId, name: 'WaveGuard Silver', discount_type: 'percentage', amount: 10, is_active: false, show_in_invoices: false, stack_group: 'tier', is_stackable: false }),
      ],
    });
    const persisted = [
      { client_id: 'line-1', description: 'Pest', quantity: 1, unit_price: 100, amount: 100 },
      { client_id: 'd1', discount_id: silverId, discount_for: 'line-1', description: 'WaveGuard Silver', quantity: 1, unit_price: -10, amount: -10 },
    ];
    const result = await calculateUpdateFinancials({
      lineItems: persisted,
      customer: { property_type: 'residential' },
      invoice: { id: 'invoice-1', line_items: JSON.stringify(persisted) },
    });
    expect(result.discount_amount).toBe(10);
  });

  test('a FRESH pick of a retired discount_id is still refused as "Invalid line-item discount" — widening never makes it pickable', async () => {
    process.env.GATE_DISCOUNT_STACKING = 'true';
    const retiredId = 'retired-fresh-pick';
    setupDb({
      discounts: [
        discountRow({ id: retiredId, name: 'Old Promo', discount_type: 'fixed_amount', amount: 5, is_active: false, show_in_invoices: false }),
      ],
    });
    await expect(calculateUpdateFinancials({
      lineItems: [
        { client_id: 'line-1', description: 'Pest', quantity: 1, unit_price: 100, amount: 100 },
        { client_id: 'd1', discount_id: retiredId, discount_for: 'line-1', description: 'Old Promo', quantity: 1, unit_price: -5, amount: -5 },
      ],
      customer: { property_type: 'residential' },
      invoice: { id: 'invoice-1', line_items: '[]' },
    })).rejects.toThrow('Invalid line-item discount');
  });
});

describe('P2: discount_label only names terms whose resolved dollars are positive', () => {
  test('two $100 fixed discounts on a $100 invoice: only the first (positive) name is in the label', async () => {
    process.env.GATE_DISCOUNT_STACKING = 'true';
    const firstId = 'exhaust-first';
    const secondId = 'exhaust-second';
    setupDb({
      customer: CUSTOMER,
      discounts: [
        discountRow({ id: firstId, name: 'Referral Credit', discount_type: 'fixed_amount', amount: 100 }),
        discountRow({ id: secondId, name: 'Loyalty Credit', discount_type: 'fixed_amount', amount: 100 }),
      ],
    });
    const invoice = await InvoiceService.create({
      customerId: 'customer-1',
      title: 'Fully exhausted second discount',
      lineItems: [{ client_id: 'line-1', description: 'Pest', quantity: 1, unit_price: 100, amount: 100 }],
      discountIds: [firstId, secondId],
    });
    expect(invoice.discount_amount).toBe(100);
    expect(invoice.discount_label).toBe('Referral Credit');
    expect(invoice.discount_label).not.toMatch(/Loyalty Credit/);
  });

  test('control: two discounts that BOTH resolve positive still join with " + "', async () => {
    process.env.GATE_DISCOUNT_STACKING = 'true';
    const firstId = 'both-positive-first';
    const secondId = 'both-positive-second';
    setupDb({
      customer: CUSTOMER,
      discounts: [
        discountRow({ id: firstId, name: 'Referral Credit', discount_type: 'fixed_amount', amount: 20 }),
        discountRow({ id: secondId, name: 'Loyalty Credit', discount_type: 'fixed_amount', amount: 30 }),
      ],
    });
    const invoice = await InvoiceService.create({
      customerId: 'customer-1',
      title: 'Both discounts apply',
      lineItems: [{ client_id: 'line-1', description: 'Pest', quantity: 1, unit_price: 100, amount: 100 }],
      discountIds: [firstId, secondId],
    });
    expect(invoice.discount_amount).toBe(50);
    expect(invoice.discount_label).toBe('Referral Credit + Loyalty Credit');
  });
});

describe('P1: the write binds the CONFIRMED gate state it was previewed under — server rejects a mismatch', () => {
  test('calculateUpdateFinancials rejects with a retryable 409 when expectedDiscountStacking diverges from the live gate', async () => {
    delete process.env.GATE_DISCOUNT_STACKING; // live = false
    await expect(calculateUpdateFinancials({
      lineItems: [{ client_id: 'line-1', description: 'Pest', quantity: 1, unit_price: 100, amount: 100 }],
      customer: { property_type: 'residential' },
      invoice: { id: 'invoice-1', line_items: '[]' },
      expectedDiscountStacking: true, // client previewed gate ON, server is now OFF
    })).rejects.toMatchObject({ statusCode: 409, isOperational: true, code: 'DISCOUNT_STACKING_GATE_DIVERGED' });
  });

  test('calculateUpdateFinancials proceeds normally when expectedDiscountStacking matches the live gate', async () => {
    process.env.GATE_DISCOUNT_STACKING = 'true';
    const result = await calculateUpdateFinancials({
      lineItems: [{ client_id: 'line-1', description: 'Pest', quantity: 1, unit_price: 100, amount: 100 }],
      customer: { property_type: 'residential' },
      invoice: { id: 'invoice-1', line_items: '[]' },
      expectedDiscountStacking: true,
    });
    expect(result.subtotal).toBe(100);
  });

  test('calculateUpdateFinancials never checks when expectedDiscountStacking is omitted — backward compatible', async () => {
    delete process.env.GATE_DISCOUNT_STACKING;
    const result = await calculateUpdateFinancials({
      lineItems: [{ client_id: 'line-1', description: 'Pest', quantity: 1, unit_price: 100, amount: 100 }],
      customer: { property_type: 'residential' },
      invoice: { id: 'invoice-1', line_items: '[]' },
    });
    expect(result.subtotal).toBe(100);
  });

  test('create() rejects with the same retryable 409 when expectedDiscountStacking diverges', async () => {
    delete process.env.GATE_DISCOUNT_STACKING; // live = false
    setupDb({ customer: CUSTOMER, discounts: [] });
    await expect(InvoiceService.create({
      customerId: 'customer-1',
      title: 'Gate-diverged create',
      lineItems: [{ description: 'Pest', quantity: 1, unit_price: 100, amount: 100 }],
      expectedDiscountStacking: true,
    })).rejects.toMatchObject({ statusCode: 409, isOperational: true, code: 'DISCOUNT_STACKING_GATE_DIVERGED' });
  });

  test('create() proceeds normally when no caller (mint, batch, retry) passes expectedDiscountStacking at all', async () => {
    delete process.env.GATE_DISCOUNT_STACKING;
    setupDb({ customer: CUSTOMER, discounts: [] });
    const invoice = await InvoiceService.create({
      customerId: 'customer-1',
      title: 'Ordinary internal create',
      lineItems: [{ description: 'Pest', quantity: 1, unit_price: 100, amount: 100 }],
    });
    expect(invoice.subtotal).toBe(100);
  });
});

describe('P1 (post-push): the group-conflict error carries isOperational/statusCode/code, not just a bare .status', () => {
  test('the REAL error calculateUpdateFinancials throws for a conflict has the full operational shape the PUT route reads', async () => {
    process.env.GATE_DISCOUNT_STACKING = 'true';
    const silverId = 'shape-silver';
    const goldId = 'shape-gold';
    setupDb({
      discounts: [
        discountRow({ id: silverId, name: 'WaveGuard Silver', discount_type: 'percentage', amount: 10, stack_group: 'tier', is_stackable: false }),
        discountRow({ id: goldId, name: 'WaveGuard Gold', discount_type: 'percentage', amount: 15, stack_group: 'tier', is_stackable: false }),
      ],
    });
    let caught = null;
    try {
      await calculateUpdateFinancials({
        lineItems: [
          { client_id: 'line-1', description: 'Pest', quantity: 1, unit_price: 100, amount: 100 },
          { client_id: 'line-2', description: 'Lawn', quantity: 1, unit_price: 100, amount: 100 },
          { discount_id: silverId, discount_for: 'line-1', description: 'WaveGuard Silver', quantity: 1, unit_price: -1, amount: -1 },
          { discount_id: goldId, discount_for: 'line-2', description: 'WaveGuard Gold', quantity: 1, unit_price: -1, amount: -1 },
        ],
        customer: { property_type: 'residential' },
        invoice: { id: 'invoice-1', line_items: '[]' },
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeNull();
    expect(caught.statusCode).toBe(400);
    expect(caught.isOperational).toBe(true);
    expect(caught.code).toBe('DISCOUNT_STACK_GROUP_CONFLICT');
    expect(caught.message).toMatch(/Only one WaveGuard tier discount can apply/);
  });

  test('create() throws the same fully-shaped error for a conflict', async () => {
    process.env.GATE_DISCOUNT_STACKING = 'true';
    const silverId = 'shape-silver-2';
    const goldId = 'shape-gold-2';
    setupDb({
      customer: CUSTOMER,
      discounts: [
        discountRow({ id: silverId, name: 'WaveGuard Silver', discount_type: 'percentage', amount: 10, stack_group: 'tier', is_stackable: false }),
        discountRow({ id: goldId, name: 'WaveGuard Gold', discount_type: 'percentage', amount: 15, stack_group: 'tier', is_stackable: false }),
      ],
    });
    let caught = null;
    try {
      await InvoiceService.create({
        customerId: 'customer-1',
        title: 'Two-tier invoice',
        lineItems: [
          { client_id: 'line-1', description: 'Pest', quantity: 1, unit_price: 100, amount: 100 },
          { client_id: 'line-2', description: 'Lawn', quantity: 1, unit_price: 100, amount: 100 },
          { discount_id: silverId, discount_for: 'line-1', description: 'WaveGuard Silver', quantity: 1, unit_price: -1, amount: -1 },
          { discount_id: goldId, discount_for: 'line-2', description: 'WaveGuard Gold', quantity: 1, unit_price: -1, amount: -1 },
        ],
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeNull();
    expect(caught.statusCode).toBe(400);
    expect(caught.isOperational).toBe(true);
    expect(caught.code).toBe('DISCOUNT_STACK_GROUP_CONFLICT');
  });
});

describe('P1 (GitHub round 5): retired-discount metadata reads through the caller\'s transaction, never a second pooled connection', () => {
  test('create() called with a trx database reads retired metadata off THAT trx, not the global pool', async () => {
    process.env.GATE_DISCOUNT_STACKING = 'true';
    const silverId = 'trx-silver';
    const goldId = 'trx-gold';
    // Global pool: missing the retired Silver row entirely. If the
    // retired-metadata lookup ever fell back to this instead of the
    // supplied trx, Silver's stack_group would be invisible to the
    // conflict check and this would resolve instead of rejecting.
    setupDb({
      customer: CUSTOMER,
      discounts: [
        discountRow({ id: goldId, name: 'WaveGuard Gold', discount_type: 'percentage', amount: 15, stack_group: 'tier', is_stackable: false }),
      ],
    });
    const trxTableCalls = [];
    const trx = jest.fn(makeDbImpl({
      customer: CUSTOMER,
      tableCalls: trxTableCalls,
      discounts: [
        discountRow({ id: silverId, name: 'WaveGuard Silver', discount_type: 'percentage', amount: 10, is_active: false, show_in_invoices: false, stack_group: 'tier', is_stackable: false }),
        discountRow({ id: goldId, name: 'WaveGuard Gold', discount_type: 'percentage', amount: 15, stack_group: 'tier', is_stackable: false }),
      ],
    }));
    trx.isTransaction = true;

    await expect(InvoiceService.create({
      database: trx,
      customerId: 'customer-1',
      title: 'Trx-scoped conflict invoice',
      lineItems: [
        { client_id: 'line-1', description: 'Pest', quantity: 1, unit_price: 100, amount: 100 },
        { client_id: 'line-2', description: 'Lawn', quantity: 1, unit_price: 100, amount: 100 },
        {
          client_id: 'd1', discount_id: silverId, discount_for: 'line-1', description: 'WaveGuard Silver',
          quantity: 1, unit_price: -10, amount: -10,
          use_stored_discount: true, stored_discount_source: 'scheduled_service', discount_dollars: 10,
        },
        { client_id: 'd2', discount_id: goldId, discount_for: 'line-2', description: 'WaveGuard Gold', quantity: 1, unit_price: -1, amount: -1 },
      ],
      trustedStoredDiscountSources: ['scheduled_service'],
    })).rejects.toThrow(/Only one WaveGuard tier discount can apply/);

    // The retired-metadata read (and everything else create() does) went
    // through the supplied trx — proving the connection was actually used,
    // not merely accepted and ignored.
    expect(trxTableCalls).toContain('discounts');
  });
});

describe('P2 x2 (GitHub round 5): widened retired-discount metadata is scoped to the item that caused the lookup, never a fresh item sharing the same discount_id', () => {
  test('a FRESH line reusing a retired discount_id already trusted elsewhere on the invoice still fails "Invalid line-item discount"', async () => {
    process.env.GATE_DISCOUNT_STACKING = 'true';
    const retiredId = 'shared-retired-id';
    setupDb({
      discounts: [
        // Retired — loadInvoiceDiscountRows (active-filtered) won't return
        // it; only the trusted item's own group-check lookup should ever
        // see its metadata.
        discountRow({ id: retiredId, name: 'Old Promo', discount_type: 'fixed_amount', amount: 5, is_active: false, show_in_invoices: false }),
      ],
    });
    const persisted = [
      { client_id: 'line-1', description: 'Pest', quantity: 1, unit_price: 100, amount: 100 },
      {
        client_id: 'd1', discount_id: retiredId, discount_for: 'line-1', description: 'Old Promo',
        quantity: 1, unit_price: -5, amount: -5,
        use_stored_discount: true, stored_discount_source: 'scheduled_service', discount_dollars: 5,
      },
    ];
    // A brand-new line item (new client_id) reusing the SAME retired
    // discount_id — a stale picker cache or a direct API call, never
    // legitimately trusted itself.
    const submitted = [
      ...persisted,
      { client_id: 'line-2', description: 'Lawn', quantity: 1, unit_price: 100, amount: 100 },
      { client_id: 'd2', discount_id: retiredId, discount_for: 'line-2', description: 'Old Promo (fresh)', quantity: 1, unit_price: -5, amount: -5 },
    ];
    await expect(calculateUpdateFinancials({
      lineItems: submitted,
      customer: { property_type: 'residential' },
      invoice: { id: 'invoice-1', line_items: JSON.stringify(persisted) },
    })).rejects.toThrow('Invalid line-item discount');
  });

  test('the SAME fresh-reuse case in create() (empty persistedClientIds) also refuses, never silently re-applying the retired discount', async () => {
    process.env.GATE_DISCOUNT_STACKING = 'true';
    const retiredId = 'shared-retired-id-2';
    setupDb({
      customer: CUSTOMER,
      discounts: [
        discountRow({ id: retiredId, name: 'Old Promo', discount_type: 'fixed_amount', amount: 5, is_active: false, show_in_invoices: false }),
      ],
    });
    await expect(InvoiceService.create({
      customerId: 'customer-1',
      title: 'Fresh reuse of a retired id',
      lineItems: [
        { client_id: 'line-1', description: 'Pest', quantity: 1, unit_price: 100, amount: 100 },
        { client_id: 'line-2', description: 'Lawn', quantity: 1, unit_price: 100, amount: 100 },
        {
          client_id: 'd1', discount_id: retiredId, discount_for: 'line-1', description: 'Old Promo',
          quantity: 1, unit_price: -5, amount: -5,
          use_stored_discount: true, stored_discount_source: 'scheduled_service', discount_dollars: 5,
        },
        // Fresh — no stored source — reuses the same retired id on a different line.
        { client_id: 'd2', discount_id: retiredId, discount_for: 'line-2', description: 'Old Promo (fresh)', quantity: 1, unit_price: -1, amount: -1 },
      ],
      trustedStoredDiscountSources: ['scheduled_service'],
    })).rejects.toThrow('Invalid line-item discount');
  });
});
