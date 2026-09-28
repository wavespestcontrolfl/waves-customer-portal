/**
 * Owner ruling 2026-09-28 (stopping rule for PR #5244, Codex round 7 P0):
 * the shared scheduled-service invoice mint must refuse to mint for a
 * cancelled/terminal visit. Codex found that when a cancellation acquires
 * the `schedule.invoice.mint` advisory lock before a concurrently
 * initiated scheduled-invoice mint, the waiting mint resumes after the
 * cancellation commits — and neither InvoiceService.create nor
 * mintScheduledServiceInvoiceWithDeposit / acquireScheduledMintLockChain
 * ever selected or validated the visit's status, so a cancelled visit
 * could still get a payable invoice.
 *
 * Real PostgreSQL round trip (not a hand-typed mock): proves the actual
 * FOR UPDATE read + status check against the real scheduled_services
 * columns and the real InvoiceService.create insert path, at BOTH places
 * Codex named:
 *   1. acquireScheduledMintLockChain's own final FOR UPDATE read (the
 *      chokepoint every mintScheduledServiceInvoiceWithDeposit /
 *      createFromService replay caller shares).
 *   2. InvoiceService.create's bare advisory-lock branch (every OTHER
 *      linked caller — a manual admin invoice, a project invoice, … —
 *      that never routes through the shared lock chain at all).
 * And proves completion billing on a COMPLETED visit is unaffected —
 * 'completed' is deliberately absent from the refusal set.
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

postgres('scheduled-service invoice mint refuses a non-live visit (Codex #5244 r7 P0)', () => {
  const { randomUUID } = require('node:crypto');
  const InvoiceService = require('../services/invoice');
  const {
    acquireScheduledMintLockChain,
    mintScheduledServiceInvoiceWithDeposit,
  } = require('../services/scheduled-invoice-mint');
  let database;
  let trx;

  beforeAll(() => {
    const url = new URL(process.env.DATABASE_URL);
    if (!['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('Use an isolated local/CI database');
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname);
    const ciTest = process.env.CI === 'true' && url.pathname === '/waves_test';
    const localDev = url.pathname === '/waves_portal';
    if (!privateQa && !ciTest && !localDev) {
      throw new Error('Use a verified, task-private waves_qa_ database, CI, or the local waves_portal dev database');
    }
    database = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 2 } });
  });
  beforeEach(async () => {
    trx = await database.transaction();
    mockConnection = trx;
  });
  afterEach(async () => { await trx.rollback(); mockConnection = database; });
  afterAll(async () => { await database.destroy(); });

  async function insertCustomer() {
    const id = randomUUID();
    await trx('customers').insert({
      id, first_name: 'Synthetic', last_name: 'MintRefusal', property_type: 'residential',
      phone: `+1555${id.replace(/-/g, '').slice(0, 7)}`, active: true,
    });
    return id;
  }

  async function insertVisit(customerId, status, overrides = {}) {
    const id = randomUUID();
    await trx('scheduled_services').insert({
      id,
      customer_id: customerId,
      service_type: 'Pest Control',
      scheduled_date: '2099-01-15',
      status,
      estimated_price: 120,
      ...overrides,
    });
    return id;
  }

  // ── Chokepoint 1: acquireScheduledMintLockChain ───────────────────────
  test('acquireScheduledMintLockChain refuses a cancelled visit with SCHEDULED_VISIT_NOT_LIVE (409)', async () => {
    const customerId = await insertCustomer();
    const visitId = await insertVisit(customerId, 'cancelled');
    await expect(
      acquireScheduledMintLockChain(trx, { scheduledServiceId: visitId, customerId }),
    ).rejects.toMatchObject({ status: 409, code: 'SCHEDULED_VISIT_NOT_LIVE', visitStatus: 'cancelled' });
  });

  test('acquireScheduledMintLockChain refuses a no-show visit too', async () => {
    const customerId = await insertCustomer();
    const visitId = await insertVisit(customerId, 'no_show');
    await expect(
      acquireScheduledMintLockChain(trx, { scheduledServiceId: visitId, customerId }),
    ).rejects.toMatchObject({ status: 409, code: 'SCHEDULED_VISIT_NOT_LIVE', visitStatus: 'no_show' });
  });

  test('acquireScheduledMintLockChain still returns the locked row for a COMPLETED visit — completion billing keeps working', async () => {
    const customerId = await insertCustomer();
    const visitId = await insertVisit(customerId, 'completed');
    const locked = await acquireScheduledMintLockChain(trx, {
      scheduledServiceId: visitId, customerId, visitColumns: ['id', 'estimated_price'],
    });
    expect(locked.id).toBe(visitId);
    expect(Number(locked.estimated_price)).toBe(120);
  });

  // ── Chokepoint 2: InvoiceService.create's bare advisory-lock branch ───
  test('InvoiceService.create refuses when its linked scheduled_service is cancelled, and mints NO invoice', async () => {
    const customerId = await insertCustomer();
    const visitId = await insertVisit(customerId, 'cancelled');
    await expect(InvoiceService.create({
      database: trx,
      customerId,
      scheduledServiceId: visitId,
      title: 'Pest Control',
      lineItems: [{ description: 'Pest Control', quantity: 1, unit_price: 120, amount: 120 }],
    })).rejects.toMatchObject({ status: 409, code: 'SCHEDULED_VISIT_NOT_LIVE', visitStatus: 'cancelled' });
    const invoices = await trx('invoices').where({ scheduled_service_id: visitId });
    expect(invoices).toHaveLength(0);
  });

  test('InvoiceService.create mints normally for a COMPLETED visit (completion billing unaffected)', async () => {
    const customerId = await insertCustomer();
    const visitId = await insertVisit(customerId, 'completed');
    const invoice = await InvoiceService.create({
      database: trx,
      customerId,
      scheduledServiceId: visitId,
      title: 'Pest Control',
      lineItems: [{ description: 'Pest Control', quantity: 1, unit_price: 120, amount: 120 }],
    });
    expect(invoice.id).toBeTruthy();
    expect(Number(invoice.total)).toBeGreaterThan(0);
    const stored = await trx('invoices').where({ id: invoice.id }).first();
    expect(stored.scheduled_service_id).toBe(visitId);
  });

  // ── mintScheduledServiceInvoiceWithDeposit (the deposit-aware helper
  //    every Charge Now / pre-completion / recap mint shares) ───────────
  test('mintScheduledServiceInvoiceWithDeposit refuses a skipped visit and never creates an invoice', async () => {
    const customerId = await insertCustomer();
    const visitId = await insertVisit(customerId, 'skipped');
    await expect(mintScheduledServiceInvoiceWithDeposit({
      svc: { id: visitId, customer_id: customerId },
      buildCreateParams: () => ({
        customerId,
        scheduledServiceId: visitId,
        title: 'Pest Control',
        lineItems: [{ description: 'Pest Control', quantity: 1, unit_price: 120, amount: 120 }],
      }),
    })).rejects.toMatchObject({ status: 409, code: 'SCHEDULED_VISIT_NOT_LIVE', visitStatus: 'skipped' });
    const invoices = await trx('invoices').where({ scheduled_service_id: visitId });
    expect(invoices).toHaveLength(0);
  });

  test('mintScheduledServiceInvoiceWithDeposit mints normally for a still-live (confirmed) visit', async () => {
    const customerId = await insertCustomer();
    const visitId = await insertVisit(customerId, 'confirmed');
    const minted = await mintScheduledServiceInvoiceWithDeposit({
      svc: { id: visitId, customer_id: customerId, estimated_price: 120 },
      buildCreateParams: () => ({
        customerId,
        scheduledServiceId: visitId,
        title: 'Pest Control',
        lineItems: [{ description: 'Pest Control', quantity: 1, unit_price: 120, amount: 120 }],
      }),
    });
    expect(minted.invoice.id).toBeTruthy();
    expect(minted.reused).toBe(false);
    const stored = await trx('invoices').where({ id: minted.invoice.id }).first();
    expect(stored.scheduled_service_id).toBe(visitId);
  });

  // ── The exact race Codex found: cancel commits WHILE a concurrent mint
  //    waits — proved with two REAL connections/transactions, not a
  //    single-connection savepoint (which cannot produce genuine
  //    cross-session lock contention). ──────────────────────────────────
  test('a mint that starts BEFORE a concurrent cancel commits still refuses once its FOR UPDATE read wakes behind it', async () => {
    // This test needs its own two independent sessions — roll back the
    // shared outer trx's insert isn't visible to a second connection, so
    // insert on the real database directly and clean up after.
    await trx.rollback();
    mockConnection = database;
    const customerId = randomUUID();
    const visitId = randomUUID();
    await database('customers').insert({
      id: customerId, first_name: 'Synthetic', last_name: 'RaceRefusal', property_type: 'residential',
      phone: `+1555${customerId.replace(/-/g, '').slice(0, 7)}`, active: true,
    });
    await database('scheduled_services').insert({
      id: visitId, customer_id: customerId, service_type: 'Pest Control', scheduled_date: '2099-01-15',
      status: 'confirmed', estimated_price: 120,
    });
    try {
      const mintTrx = await database.transaction();
      const cancelTrx = await database.transaction();
      try {
        // The mint takes the advisory lock + visit FOR UPDATE first...
        const mintLockedPromise = acquireScheduledMintLockChain(mintTrx, {
          scheduledServiceId: visitId, customerId,
        });
        const mintLocked = await mintLockedPromise;
        expect(mintLocked.status).toBe('confirmed');
        // ...the cancel's own UPDATE queues behind the mint's row lock...
        const cancelPromise = cancelTrx('scheduled_services')
          .where({ id: visitId }).update({ status: 'cancelled' });
        // ...the mint releases its lock without minting (simulating the
        // real caller's decision to hold/replay), the cancel proceeds and
        // commits...
        await mintTrx.rollback();
        await cancelPromise;
        await cancelTrx.commit();
        // ...and a FRESH mint attempt starting now must see the committed
        // cancellation under its own FOR UPDATE read and refuse.
        const secondMintTrx = await database.transaction();
        try {
          await expect(
            acquireScheduledMintLockChain(secondMintTrx, { scheduledServiceId: visitId, customerId }),
          ).rejects.toMatchObject({ status: 409, code: 'SCHEDULED_VISIT_NOT_LIVE', visitStatus: 'cancelled' });
        } finally {
          await secondMintTrx.rollback().catch(() => {});
        }
      } finally {
        await mintTrx.rollback().catch(() => {});
        await cancelTrx.rollback().catch(() => {});
      }
    } finally {
      await database('invoices').where({ scheduled_service_id: visitId }).del();
      await database('scheduled_services').where({ id: visitId }).del();
      await database('customers').where({ id: customerId }).del();
      trx = await database.transaction();
      mockConnection = trx;
    }
  });
});
