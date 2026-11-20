// Runs with the existing CI PostgreSQL pass; never a production connection.
// Promo code on the estimate page (GATE_ESTIMATE_PROMO_CODE) against real
// Postgres: what entering a code saves, what acceptance posts through the real
// credit ledger, and the exactly-once indexes of the real migration. A private
// schema keeps CI's migrated tables untouched.
const SKIP = !process.env.DATABASE_URL;
const { randomUUID } = require('crypto');

const mockSchema = `estimate_promo_${randomUUID().replaceAll('-', '')}`;
jest.mock('../models/db', () => {
  const knex = require('knex');
  return knex({
    client: 'pg',
    connection: process.env.DATABASE_URL,
    searchPath: [mockSchema],
    pool: { min: 0, max: 4 },
  });
});
jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
const mockGate = { on: true };
jest.mock('../config/feature-gates', () => ({
  gates: {},
  isEnabled: (key) => ['estimatePromoCode', 'payPromoCode'].includes(key) && mockGate.on,
}));

(SKIP ? describe.skip : describe)('estimate promo code (live Postgres)', () => {
  let db;
  let promo;

  const customer = async () => (await db('customers').insert({}).returning('*'))[0];
  const estimate = async (fields = {}) => (await db('estimates').insert({ status: 'viewed', ...fields }).returning('*'))[0];
  const discount = async (fields = {}) => (await db('discounts').insert({
    discount_key: `promo_${randomUUID()}`,
    name: 'Fixture promo',
    discount_type: 'fixed_amount',
    amount: 25,
    promo_code: `FIX${randomUUID().slice(0, 8).toUpperCase()}`,
    is_active: true,
    ...fields,
  }).returning('*'))[0];
  const balanceOf = async (id) => Number((await db('customers').where({ id }).first('account_credits')).account_credits);
  const ledgerOf = (id) => db('customer_credit_ledger').where({ customer_id: id });
  const usesOf = async (id) => (await db('discounts').where({ id }).first('promo_code_current_uses')).promo_code_current_uses;
  const enter = (est, rawCode) => promo.enterPromoCode({ estimate: est, rawCode });
  // The accept commits first (status and owner on the row), then the credit step runs.
  const accept = async (est, customerId) => {
    await db('estimates').where({ id: est.id }).update({ status: 'accepted', customer_id: customerId });
    return promo.redeemPromoCodeForAcceptedEstimate({ estimateId: est.id });
  };

  beforeAll(async () => {
    db = require('../models/db');
    await db.raw('CREATE SCHEMA ??', [mockSchema]);
    // A fresh builder per table: one builder would replay its earlier statements.
    const schema = { createTable: (name, build) => db.schema.withSchema(mockSchema).createTable(name, build) };
    const id = (t) => t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'));
    await schema.createTable('customers', (t) => {
      id(t);
      t.decimal('account_credits', 10, 2).defaultTo(0);
      t.boolean('auto_apply_account_credit').defaultTo(false);
      t.timestamp('updated_at', { useTz: true });
    });
    await schema.createTable('estimates', (t) => {
      id(t);
      t.uuid('customer_id');
      t.string('status');
      t.timestamp('archived_at', { useTz: true });
      t.jsonb('estimate_data');
    });
    await schema.createTable('discounts', (t) => {
      id(t);
      t.string('discount_key').unique().notNullable();
      t.string('name');
      t.string('discount_type');
      t.decimal('amount', 10, 2);
      t.string('service_key_filter');
      t.boolean('requires_new_customer').defaultTo(false);
      t.string('promo_code', 50).unique();
      t.timestamp('promo_code_expiry');
      t.integer('promo_code_max_uses');
      t.integer('promo_code_current_uses').defaultTo(0);
      t.boolean('is_active').defaultTo(true);
    });
    await schema.createTable('customer_discounts', (t) => {
      id(t);
      t.uuid('customer_id');
      t.uuid('discount_id');
    });
    await schema.createTable('service_records', (t) => {
      id(t);
      t.uuid('customer_id');
      t.uuid('scheduled_service_id');
      t.string('status');
    });
    await schema.createTable('invoices', (t) => {
      id(t);
      t.uuid('customer_id');
      t.uuid('payer_id');
      t.uuid('payer_statement_id');
      t.uuid('service_record_id');
      t.uuid('scheduled_service_id');
      t.string('status').defaultTo('sent');
      t.decimal('total', 10, 2);
      t.decimal('credit_applied', 10, 2).defaultTo(0);
      t.decimal('amount_paid', 10, 2).defaultTo(0);
      t.string('stripe_payment_intent_id');
      t.string('prepaid_prev_status');
      t.timestamp('prepaid_at');
      t.string('prepaid_by');
      t.timestamp('paid_at');
      t.timestamp('updated_at', { useTz: true });
    });
    await schema.createTable('stripe_invoice_charge_attempts', (t) => {
      id(t);
      t.uuid('invoice_id');
      t.string('status');
      t.string('decline_code');
      t.string('stripe_payment_intent_id');
      t.string('authentication_canceled_intent_id');
      t.string('worker_payment_intent_id');
      t.string('idempotency_key');
      t.decimal('credit_applied_delta', 12, 2).defaultTo(0);
      t.decimal('credit_applied_total', 12, 2).defaultTo(0);
      t.timestamp('created_at');
      t.timestamp('submitted_at');
      t.timestamp('resolved_at');
    });
    await schema.createTable('stripe_orphan_charges', (t) => {
      t.uuid('invoice_id');
      t.boolean('resolved');
      t.string('stripe_payment_intent_id');
    });
    await schema.createTable('payments', (t) => {
      id(t);
      t.string('status');
      t.string('stripe_payment_intent_id');
      t.jsonb('metadata');
      t.uuid('superseded_by_payment_id');
    });
    await schema.createTable('payment_plans', (t) => {
      id(t);
      t.uuid('invoice_id');
      t.string('status');
    });
    await schema.createTable('activity_log', (t) => {
      id(t);
      t.uuid('customer_id');
      t.uuid('estimate_id');
      t.string('action');
      t.text('description');
      t.jsonb('metadata');
    });
    await schema.createTable('customer_credit_ledger', (t) => {
      id(t);
      t.uuid('customer_id');
      t.decimal('delta', 10, 2);
      t.decimal('balance_after', 10, 2);
      t.string('source', 40);
      t.uuid('invoice_id');
      t.uuid('referral_id');
      t.text('note');
      t.string('created_by', 200);
      t.timestamp('created_at').defaultTo(db.fn.now());
    });
    // The real migration: its unique indexes are what the tests below lean on.
    await require('../models/migrations/20261118120000_estimate_promo_codes').up(db);
    await require('../models/migrations/20261118230000_invoice_promo_codes').up(db);
    promo = require('../services/estimate-promo-code');
  });

  afterAll(async () => {
    await db.raw('DROP SCHEMA IF EXISTS ?? CASCADE', [mockSchema]);
    await db.destroy();
  });

  beforeEach(() => { mockGate.on = true; });

  test('entering a code saves it and moves no money; acceptance posts the credit once and counts one use', async () => {
    const cust = await customer();
    const est = await estimate({ customer_id: cust.id });
    const disc = await discount();

    expect(await enter(est, ` ${disc.promo_code.toLowerCase()} `)).toEqual({
      ok: true, applied: { code: disc.promo_code, creditAmount: 25, credited: false },
    });
    expect(await balanceOf(cust.id)).toBe(0);
    expect(await usesOf(disc.id)).toBe(0);
    expect(await promo.promoCodeViewForEstimate(est, { open: true }))
      .toEqual({ canEnter: false, applied: { code: disc.promo_code, creditAmount: 25, credited: false } });

    expect(await accept(est, cust.id)).toBe('redeemed');
    expect(await accept(est, cust.id)).toBe('none');
    expect(await balanceOf(cust.id)).toBe(25);
    expect(await usesOf(disc.id)).toBe(1);
    const ledger = await ledgerOf(cust.id);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ delta: '25.00', balance_after: '25.00', source: 'promo_code' });
    expect((await promo.promoCodeViewForEstimate(est)).applied.credited).toBe(true);
    expect((await db('activity_log').where({ estimate_id: est.id }).orderBy('action')).map((r) => r.action))
      .toEqual(['estimate_promo_code_credited', 'estimate_promo_code_entered']);
  });

  test('the amount is frozen at entry: a later edit to the discount does not move it', async () => {
    const cust = await customer();
    const est = await estimate({ customer_id: cust.id });
    const disc = await discount({ amount: 40 });
    await enter(est, disc.promo_code);
    await db('discounts').where({ id: disc.id }).update({ amount: 400 });
    expect(await accept(est, cust.id)).toBe('redeemed');
    expect(await balanceOf(cust.id)).toBe(40);
  });

  test('every code that cannot be a credit gets the one generic refusal and saves nothing', async () => {
    const cust = await customer();
    await db('service_records').insert({ customer_id: cust.id, status: 'completed' });
    const est = await estimate({ customer_id: cust.id });
    const refused = [
      'NOSUCHCODE',
      '!!',
      (await discount({ discount_type: 'percentage', amount: 10 })).promo_code,
      (await discount({ promo_code_expiry: new Date(Date.now() - 86400000) })).promo_code,
      (await discount({ is_active: false })).promo_code,
      (await discount({ service_key_filter: 'pest_control' })).promo_code,
      (await discount({ promo_code_max_uses: 1, promo_code_current_uses: 1 })).promo_code,
      // This customer has a completed visit.
      (await discount({ requires_new_customer: true })).promo_code,
    ];
    for (const code of refused) {
      expect(await enter(est, code)).toEqual({ ok: false, reason: 'invalid_code' });
    }
    expect(await db('estimate_promo_codes').where({ estimate_id: est.id })).toHaveLength(0);
  });

  test('one code per estimate, and none on an estimate the office already discounted', async () => {
    const first = await discount();
    const second = await discount();
    const est = await estimate();
    expect((await enter(est, first.promo_code)).ok).toBe(true);
    expect((await enter(est, first.promo_code)).ok).toBe(true);
    expect(await enter(est, second.promo_code)).toEqual({ ok: false, reason: 'code_already_entered' });
    expect(await db('estimate_promo_codes').where({ estimate_id: est.id })).toHaveLength(1);

    const discounted = await estimate({
      estimate_data: { summary: { manualDiscount: { type: 'PERCENT', value: 10, amount: 55 } } },
    });
    expect(await enter(discounted, second.promo_code)).toEqual({ ok: false, reason: 'discount_already_applied' });
    expect(await promo.promoCodeViewForEstimate(discounted, { open: true })).toBeNull();
  });

  test('a code waiting on an open estimate holds one of its uses; one on a dead estimate does not', async () => {
    const disc = await discount({ promo_code_max_uses: 1 });
    const dead = await estimate({ status: 'expired' });
    await db('estimate_promo_codes').insert({ estimate_id: dead.id, discount_id: disc.id, code: disc.promo_code, credit_amount: 25 });
    expect((await enter(await estimate(), disc.promo_code)).ok).toBe(true);
    expect(await enter(await estimate(), disc.promo_code)).toEqual({ ok: false, reason: 'invalid_code' });
  });

  test('acceptance posts nothing, and says why in the activity log, when the cap is spent or the code was switched off', async () => {
    const cust = await customer();
    const capped = await discount({ promo_code_max_uses: 1 });
    const est = await estimate({ customer_id: cust.id });
    await enter(est, capped.promo_code);
    await db('discounts').where({ id: capped.id }).update({ promo_code_current_uses: 1 });
    expect(await accept(est, cust.id)).toBe('void');

    const off = await discount();
    const est2 = await estimate({ customer_id: cust.id });
    await enter(est2, off.promo_code);
    await db('discounts').where({ id: off.id }).update({ is_active: false });
    expect(await accept(est2, cust.id)).toBe('void');

    expect(await balanceOf(cust.id)).toBe(0);
    expect(await usesOf(capped.id)).toBe(1);
    expect((await db('estimate_promo_codes').whereIn('estimate_id', [est.id, est2.id]).orderBy('void_reason'))
      .map((r) => [r.status, r.void_reason]))
      .toEqual([['void', 'code_inactive'], ['void', 'uses_exhausted']]);
    expect(await db('activity_log').where({ action: 'estimate_promo_code_not_credited' })
      .whereIn('estimate_id', [est.id, est2.id])).toHaveLength(2);
    // A voided code leaves the page with nothing to show.
    expect(await promo.promoCodeViewForEstimate(est)).toBeNull();
  });

  test('an estimate accepted with no customer account closes its code with an activity row; one not accepted is left alone', async () => {
    const disc = await discount();
    const open = await estimate();
    await enter(open, disc.promo_code);
    expect(await promo.redeemPromoCodeForAcceptedEstimate({ estimateId: open.id })).toBe('none');
    expect((await db('estimate_promo_codes').where({ estimate_id: open.id }).first()).status).toBe('entered');

    expect(await accept(open, null)).toBe('void');
    expect(await db('estimate_promo_codes').where({ estimate_id: open.id }).first())
      .toMatchObject({ status: 'void', void_reason: 'no_customer' });
    expect(await db('activity_log').where({ estimate_id: open.id, action: 'estimate_promo_code_not_credited' })).toHaveLength(1);
    expect(await usesOf(disc.id)).toBe(0);
  });

  test('two customers entering a code with one use left: one is saved, the other gets the generic refusal', async () => {
    const disc = await discount({ promo_code_max_uses: 1 });
    const [a, b] = [await estimate(), await estimate()];
    // Each entry on its own transaction, as the route runs it.
    const inTrx = (est) => db.transaction((trx) => promo.enterPromoCode({ estimate: est, rawCode: disc.promo_code }, trx));
    const outcomes = await Promise.all([inTrx(a), inTrx(b)]);
    expect(outcomes.map((o) => o.ok).sort()).toEqual([false, true]);
    expect(outcomes.find((o) => !o.ok)).toEqual({ ok: false, reason: 'invalid_code' });
    expect(await db('estimate_promo_codes').where({ discount_id: disc.id })).toHaveLength(1);
  });

  test('an office discount added after the code was entered: acceptance posts no credit', async () => {
    const cust = await customer();
    const disc = await discount();
    const est = await estimate({ customer_id: cust.id });
    await enter(est, disc.promo_code);
    await db('estimates').where({ id: est.id })
      .update({ estimate_data: { summary: { manualDiscount: { type: 'PERCENT', value: 10, amount: 55 } } } });
    expect(await accept(est, cust.id)).toBe('void');
    expect(await balanceOf(cust.id)).toBe(0);
    expect(await usesOf(disc.id)).toBe(0);
    expect((await db('estimate_promo_codes').where({ estimate_id: est.id }).first()).void_reason).toBe('office_discount');
  });

  test('a customer redeems a code once: a second accepted estimate with it posts nothing', async () => {
    const cust = await customer();
    const disc = await discount();
    const [a, b] = [await estimate(), await estimate()];
    await enter(a, disc.promo_code);
    await enter(b, disc.promo_code);
    const outcomes = await Promise.all([accept(a, cust.id), accept(b, cust.id)]);
    expect(outcomes.sort()).toEqual(['redeemed', 'void']);
    expect(await balanceOf(cust.id)).toBe(25);
    expect(await ledgerOf(cust.id)).toHaveLength(1);
    expect(await usesOf(disc.id)).toBe(1);
  });

  test('a credit the accept step did not post is redeemed by the hourly sweep, once', async () => {
    const cust = await customer();
    const disc = await discount();
    const est = await estimate({ customer_id: cust.id });
    await enter(est, disc.promo_code);
    // The accept committed but its credit step never ran (a failure, or the gate was off then).
    await db('estimates').where({ id: est.id }).update({ status: 'accepted' });
    const stillOpen = await estimate();
    await enter(stillOpen, disc.promo_code);

    expect(await promo.sweepAcceptedPromoCodes()).toMatchObject({ redeemed: 1 });
    expect((await promo.sweepAcceptedPromoCodes()).redeemed).toBe(0);
    expect(await balanceOf(cust.id)).toBe(25);
    expect(await ledgerOf(cust.id)).toHaveLength(1);
    expect((await db('estimate_promo_codes').where({ estimate_id: stillOpen.id }).first()).status).toBe('entered');
  });

  test('the office promo path refuses a code this customer already redeemed as a credit', async () => {
    const cust = await customer();
    const disc = await discount();
    const est = await estimate({ customer_id: cust.id });
    await enter(est, disc.promo_code);
    await accept(est, cust.id);
    expect(await require('../services/discount-engine').applyPromoCode(cust.id, disc.promo_code))
      .toEqual({ success: false, error: 'Promo code already applied to this account' });
    expect(await usesOf(disc.id)).toBe(1);
    expect(await db('customer_discounts').where({ customer_id: cust.id })).toHaveLength(0);
  });

  test('gate off: no field, and an accepted estimate posts nothing and keeps its code', async () => {
    const cust = await customer();
    const disc = await discount();
    const est = await estimate({ customer_id: cust.id });
    await enter(est, disc.promo_code);
    mockGate.on = false;
    expect(await promo.promoCodeViewForEstimate(est, { open: true })).toBeNull();
    expect(await accept(est, cust.id)).toBe('off');
    expect(await promo.sweepAcceptedPromoCodes()).toEqual({ checked: 0, redeemed: 0 });
    expect(await balanceOf(cust.id)).toBe(0);
    expect((await db('estimate_promo_codes').where({ estimate_id: est.id }).first()).status).toBe('entered');
  });

  describe('on the invoice pay page (GATE_PAY_PROMO_CODE)', () => {
    let pay;
    let credit;
    beforeAll(() => {
      pay = require('../services/invoice-promo-code');
      credit = require('../services/customer-credit');
    });

    const invoice = async (fields = {}) => (await db('invoices').insert({ total: 100, ...fields }).returning('*'))[0];
    const enterOn = (inv, rawCode) => pay.enterPromoCodeOnInvoice({ invoice: inv, rawCode });
    // What the pay page's payment setup does with a code, in its one
    // transaction under the invoice lock. Returns the amount applied.
    const setup = (inv) => db.transaction(async (trx) => {
      const locked = await trx('invoices').where({ id: inv.id }).forUpdate().first();
      return pay.redeemAndApplyPromoCode(trx, locked);
    });
    const fresh = (inv) => db('invoices').where({ id: inv.id }).first();

    test('a pending card challenge keeps the promo code available until the bank decision', async () => {
      const cust = await customer();
      const inv = await invoice({ customer_id: cust.id });
      const disc = await discount();
      await enterOn(inv, disc.promo_code);
      await db('stripe_invoice_charge_attempts').insert({
        invoice_id: inv.id, status: 'failed', decline_code: 'authentication_required',
        stripe_payment_intent_id: 'pi_promo_auth', worker_payment_intent_id: 'pi_promo_auth', submitted_at: new Date(), resolved_at: new Date(),
      });
      expect(await setup(inv)).toBe(0);
      expect(await usesOf(disc.id)).toBe(0);
      expect(await ledgerOf(cust.id)).toHaveLength(0);
      await db('stripe_invoice_charge_attempts').where({ invoice_id: inv.id })
        .update({ authentication_canceled_intent_id: 'pi_promo_auth' });
      expect(await setup(inv)).toBe(25);
      expect(await usesOf(disc.id)).toBe(1);
    });

    test('entering a code only saves it; the setup that follows posts the credit once and lowers what is due by exactly that', async () => {
      const cust = await customer();
      // Credit the customer already had and has not chosen to apply (automatic credit off).
      await credit.postCreditMovement({ customerId: cust.id, delta: 15, source: 'manual' });
      const disc = await discount();
      const inv = await invoice({ customer_id: cust.id });

      expect(await pay.promoCodeViewForInvoice(inv)).toEqual({ canEnter: true, applied: null });
      expect(await enterOn(inv, disc.promo_code.toLowerCase())).toEqual({
        ok: true, applied: { code: disc.promo_code, creditAmount: 25, credited: false },
      });
      expect(await balanceOf(cust.id)).toBe(15);
      expect(Number((await fresh(inv)).credit_applied)).toBe(0);
      expect(await usesOf(disc.id)).toBe(0);

      // Nothing to report before the code is redeemed, or for an invoice with no code.
      expect(await pay.promoCodeVerdictAfterSetup(inv.id)).toBeNull();
      expect(await pay.promoCodeVerdictAfterSetup(randomUUID())).toBeUndefined();
      expect(await setup(inv)).toBe(25);
      expect(await setup(inv)).toBe(0);
      expect(await pay.promoCodeVerdictAfterSetup(inv.id))
        .toEqual({ canEnter: false, applied: { code: disc.promo_code, creditAmount: 25, credited: true } });
      expect(Number((await fresh(inv)).credit_applied)).toBe(25);
      // Only the promo amount was drawn: the customer's own $15 is untouched.
      expect(await balanceOf(cust.id)).toBe(15);
      expect(await usesOf(disc.id)).toBe(1);
      expect((await ledgerOf(cust.id).orderBy('created_at').orderBy('delta', 'desc')).map((r) => [r.source, Number(r.delta)]))
        .toEqual([['manual', 15], ['promo_code', 25], ['invoice_application', -25]]);
      expect(await pay.promoCodeViewForInvoice(await fresh(inv)))
        .toEqual({ canEnter: false, applied: { code: disc.promo_code, creditAmount: 25, credited: true } });
    });

    test('a credit larger than the invoice covers it and leaves the rest on the account', async () => {
      const cust = await customer();
      const disc = await discount({ amount: 60 });
      const inv = await invoice({ customer_id: cust.id, total: 40 });
      await enterOn(inv, disc.promo_code);
      expect(await setup(inv)).toBe(40);
      expect(await fresh(inv)).toMatchObject({ status: 'prepaid', credit_applied: '40.00' });
      expect(await balanceOf(cust.id)).toBe(20);
    });

    test('a new-customer-only code works on the first invoice, whose own visit does not count, and not once another visit is done', async () => {
      const cust = await customer();
      const disc = await discount({ requires_new_customer: true });
      const [visit] = await db('service_records').insert({ customer_id: cust.id, status: 'completed' }).returning('*');
      const first = await invoice({ customer_id: cust.id, service_record_id: visit.id });
      expect((await enterOn(first, disc.promo_code)).ok).toBe(true);

      const other = await customer();
      await db('service_records').insert({ customer_id: other.id, status: 'completed' });
      const [second] = await db('service_records').insert({ customer_id: other.id, status: 'completed' }).returning('*');
      const later = await invoice({ customer_id: other.id, service_record_id: second.id });
      expect(await enterOn(later, disc.promo_code)).toEqual({ ok: false, reason: 'invalid_code' });
    });

    test('no code on a payer-billed, statement-billed, paid or fully covered invoice, and one code per invoice', async () => {
      const cust = await customer();
      const disc = await discount();
      const other = await discount();
      const refused = [
        await invoice({ customer_id: cust.id, payer_id: randomUUID() }),
        await invoice({ customer_id: cust.id, payer_statement_id: randomUUID() }),
        await invoice({ customer_id: cust.id, status: 'paid' }),
        await invoice({ customer_id: cust.id, credit_applied: 100 }),
      ];
      for (const inv of refused) {
        expect(await pay.promoCodeViewForInvoice(inv)).toBeNull();
        expect(await enterOn(inv, disc.promo_code)).toEqual({ ok: false, reason: 'invalid_code' });
      }
      const inv = await invoice({ customer_id: cust.id });
      expect((await enterOn(inv, disc.promo_code)).ok).toBe(true);
      expect((await enterOn(inv, disc.promo_code)).ok).toBe(true);
      expect(await enterOn(inv, other.promo_code)).toEqual({ ok: false, reason: 'code_already_entered' });
      expect(await db('invoice_promo_codes').where({ invoice_id: inv.id })).toHaveLength(1);
    });

    test('once per customer across the estimate and the pay page', async () => {
      const cust = await customer();
      const disc = await discount();
      const est = await estimate({ customer_id: cust.id });
      await enter(est, disc.promo_code);
      const inv = await invoice({ customer_id: cust.id });
      expect((await enterOn(inv, disc.promo_code)).ok).toBe(true);

      // The pay page redeems first; the estimate accepted afterwards posts nothing.
      expect(await setup(inv)).toBe(25);
      expect(await accept(est, cust.id)).toBe('void');
      expect(await usesOf(disc.id)).toBe(1);
      expect((await ledgerOf(cust.id).where({ source: 'promo_code' }))).toHaveLength(1);

      // And a later invoice takes no second use of it.
      expect(await enterOn(await invoice({ customer_id: cust.id }), disc.promo_code)).toEqual({ ok: false, reason: 'invalid_code' });
    });

    test('a code switched off before the setup posts nothing, says why in the activity log, and the setup carries on', async () => {
      const cust = await customer();
      const disc = await discount();
      const inv = await invoice({ customer_id: cust.id });
      await enterOn(inv, disc.promo_code);
      await db('discounts').where({ id: disc.id }).update({ is_active: false });
      expect(await setup(inv)).toBe(0);
      expect(await balanceOf(cust.id)).toBe(0);
      expect(Number((await fresh(inv)).credit_applied)).toBe(0);
      expect(await db('invoice_promo_codes').where({ invoice_id: inv.id }).first()).toMatchObject({ status: 'void', void_reason: 'code_inactive' });
      expect(await db('activity_log').where({ customer_id: cust.id, action: 'invoice_promo_code_not_credited' })).toHaveLength(1);
      expect(await pay.promoCodeViewForInvoice(await fresh(inv))).toBeNull();
      // The setup tells the page to drop its note: no credit was priced in.
      expect(await pay.promoCodeVerdictAfterSetup(inv.id)).toBeNull();
    });

    test('a code is never spent on an invoice it cannot lower: nothing posts and it stays entered for a later setup', async () => {
      const cust = await customer();
      const disc = await discount();
      const inv = await invoice({ customer_id: cust.id });
      await enterOn(inv, disc.promo_code);
      // The invoice is on a payment plan, which takes no account credit.
      const [plan] = await db('payment_plans').insert({ invoice_id: inv.id, status: 'active' }).returning('*');
      expect(await pay.pendingPromoCredit(inv)).toBe(25);
      expect(await setup(inv)).toBe(0);
      expect(await balanceOf(cust.id)).toBe(0);
      expect(await ledgerOf(cust.id)).toHaveLength(0);
      expect(await usesOf(disc.id)).toBe(0);
      expect((await db('invoice_promo_codes').where({ invoice_id: inv.id }).first()).status).toBe('entered');
      expect(await pay.promoCodeVerdictAfterSetup(inv.id)).toBeNull();

      await db('payment_plans').where({ id: plan.id }).update({ status: 'completed' });
      expect(await setup(inv)).toBe(25);
      expect(Number((await fresh(inv)).credit_applied)).toBe(25);
      expect(await pay.pendingPromoCredit(await fresh(inv))).toBe(0);
    });

    test('gate off: no field, and a setup redeems nothing', async () => {
      const cust = await customer();
      const disc = await discount();
      const inv = await invoice({ customer_id: cust.id });
      await enterOn(inv, disc.promo_code);
      mockGate.on = false;
      expect(await pay.promoCodeViewForInvoice(inv)).toBeNull();
      expect(await setup(inv)).toBe(0);
      expect(await balanceOf(cust.id)).toBe(0);
    });
  });
});
