/** Real PostgreSQL verification; run with COMPLETION_PRICING_TEST_DATABASE_URL
 * pointing to a disposable, schema-only local database. Every fixture rolls back. */
jest.setTimeout(60000);
const { randomUUID } = require('crypto');
const testUrl = process.env.COMPLETION_PRICING_TEST_DATABASE_URL;
const local = testUrl && ['localhost', '127.0.0.1'].includes(new URL(testUrl).hostname)
  && new URL(testUrl).pathname.includes('completion_qa');
if (testUrl && !local) throw new Error('Completion pricing tests require a dedicated local completion_qa database.');
const suite = local ? describe : describe.skip;
suite('completion pricing PostgreSQL and invoice replay', () => {
  let db;
  const pricing = require('../services/completion-pricing');
  const Invoice = require('../services/invoice');
  beforeAll(() => { db = require('knex')({ client: 'pg', connection: testUrl }); });
  afterAll(async () => { await db?.destroy(); });
  async function fixture(trx, { net = 85, jobPrice = 100, parent = false } = {}) {
    const customerId = randomUUID(); const serviceId = randomUUID(); const estimateId = randomUUID(); const jobId = randomUUID();
    await trx('customers').insert({ id: customerId, first_name: 'Synthetic pricing fixture', phone: `qa-${customerId.slice(0, 8)}`,
      active: true, waveguard_tier: 'Gold', billing_mode: 'per_application' });
    await trx('services').insert({ id: serviceId, service_key: 'pest_control_quarterly', name: 'Pest Control', category: 'pest', frequency: 'quarterly', billing_type: 'recurring', visits_per_year: 4 });
    const soldLine = { service: 'pest_control', name: 'Pest Control', perTreatment: 100, priceAfterDiscount: net,
      visitsPerYear: 4, frequency: 'quarterly', discount: { effectiveDiscount: (100 - net) / 100 } };
    await trx('estimates').insert({ id: estimateId, customer_id: customerId, status: 'accepted', waveguard_tier: 'Gold',
      address: '100 Synthetic Test Lane, Bradenton, FL 34201', estimate_data: { result: { recurring: { services: [soldLine] } } } });
    const fields = { customer_id: customerId, service_id: serviceId, service_type: 'Pest Control', service_key_snapshot: 'pest_control_quarterly',
      service_category_snapshot: 'pest', scheduled_date: new Date(), status: 'on_site', is_recurring: true,
      recurring_pattern: 'quarterly', estimated_price: jobPrice, primary_line_price: jobPrice, source_estimate_id: estimateId,
      service_address_line1: '100 Synthetic Test Lane', service_address_city: 'Bradenton', service_address_zip: '34201' };
    const parentId = randomUUID();
    if (!parent) await trx('scheduled_services').insert({ ...fields, id: parentId });
    await trx('scheduled_services').insert({ ...fields, id: jobId, recurring_parent_id: parent ? null : parentId });
    await trx('pricing_config').insert({ config_key: 'waveguard_tiers', name: 'Synthetic tiers', category: 'test', data: { gold: { discount: .15 } } });
    return { jobId, customerId, estimateId, soldLine, serviceId, parentId };
  }
  async function rollbackTest(fn) { const trx = await db.transaction(); try { await fn(trx); } finally { await trx.rollback(); } }
  test('accepted missing discount persists once and existing invoice lines equal the preview', () => rollbackTest(async (trx) => {
    const { jobId } = await fixture(trx);
    const before = await pricing.loadCompletionPricing(jobId, { database: trx, role: 'admin' });
    expect(before.view).toMatchObject({ canApply: true, proposedAmount: 85 });
    const review = { witness: before.view.witness, applyDiscounts: true };
    const plan = await pricing.prepareCompletionPricingReview(jobId, review, { database: trx, role: 'admin' });
    await pricing.commitCompletionPricingReview(trx, plan, { role: 'admin', technicianId: 'synthetic' });
    const saved = await trx('scheduled_services').where({ id: jobId }).first();
    expect(Number(saved.estimated_price)).toBe(85);
    const { lineItems } = await Invoice.buildLineItemsForScheduledService(jobId, { database: trx, fallbackAmount: 85 });
    expect(lineItems.reduce((sum, row) => sum + Number(row.amount), 0)).toBe(85);
    expect((await pricing.loadCompletionPricing(jobId, { database: trx, role: 'admin' })).view.canApply).toBe(false);
    await expect(pricing.prepareCompletionPricingReview(jobId, review, { database: trx, role: 'admin' })).rejects.toMatchObject({ code: 'completion_pricing_changed' });
    expect(Number((await trx('activity_log').where({ customer_id: saved.customer_id }).count('* as n').first()).n)).toBe(1);
  }));
  test('tier comes from DB and stacks with a recorded stackable fixed adjustment', () => rollbackTest(async (trx) => {
    const { jobId } = await fixture(trx, { net: 100 });
    const discountId = randomUUID();
    await trx('discounts').insert({ id: discountId, discount_key: 'synthetic-courtesy', name: 'Courtesy', discount_type: 'fixed_amount', amount: 5, is_stackable: true });
    await trx('scheduled_services').where({ id: jobId }).update({ estimated_price: 95, discount_id: discountId, discount_name: 'Courtesy', discount_type: 'fixed_amount', discount_amount: 5, discount_dollars: 5 });
    const plan = await pricing.loadCompletionPricing(jobId, { database: trx, role: 'admin' });
    expect(plan.view).toMatchObject({ canApply: true, proposedAmount: 80 });
    await pricing.commitCompletionPricingReview(trx, { ...plan, review: { witness: plan.view.witness, applyDiscounts: true } }, { role: 'admin', technicianId: 'synthetic' });
    const { lineItems } = await Invoice.buildLineItemsForScheduledService(jobId, { database: trx, fallbackAmount: 80 });
    expect(lineItems.reduce((sum, row) => sum + Number(row.amount), 0)).toBe(80);
  }));
  test.each(['customer', 'price', 'estimate'])('stale %s evidence refuses all writes', (change) => rollbackTest(async (trx) => {
    const ids = await fixture(trx, { net: 100 });
    const plan = await pricing.loadCompletionPricing(ids.jobId, { database: trx, role: 'admin' });
    if (change === 'customer') await trx('customers').where({ id: ids.customerId }).update({ active: false });
    if (change === 'price') await trx('scheduled_services').where({ id: ids.jobId }).update({ estimated_price: 90 });
    if (change === 'estimate') await trx('estimates').where({ id: ids.estimateId }).update({ status: 'declined' });
    await expect(pricing.commitCompletionPricingReview(trx, { ...plan, review: { witness: plan.view.witness, applyDiscounts: true } }, { role: 'admin', technicianId: 'synthetic' })).rejects.toMatchObject({ code: 'completion_pricing_changed' });
    expect(Number((await trx('activity_log').where({ customer_id: ids.customerId }).count('* as n').first()).n)).toBe(0);
  }));
  test('technicians can read the agreement but cannot authorize new prices', () => rollbackTest(async (trx) => {
    const { jobId } = await fixture(trx);
    const plan = await pricing.loadCompletionPricing(jobId, { database: trx, role: 'technician' });
    expect(plan.view).toMatchObject({ canApply: false, lines: [{ status: 'matched', quote: { amount: 85 } }] });
  }));
  test('already discounted, prepaid and callbacks receive no additional discount', () => rollbackTest(async (trx) => {
    const { jobId } = await fixture(trx, { jobPrice: 85 });
    expect((await pricing.loadCompletionPricing(jobId, { database: trx, role: 'admin' })).view.canApply).toBe(false);
    for (const patch of [{ estimated_price: 100, primary_line_price: 100, prepaid_amount: 100 }, { prepaid_amount: null, is_callback: true }]) {
      await trx('scheduled_services').where({ id: jobId }).update(patch);
      expect((await pricing.loadCompletionPricing(jobId, { database: trx, role: 'admin' })).view.canApply).toBe(false);
    }
  }));
  test('the first application keeps its original future-series template', () => rollbackTest(async (trx) => {
    const gates = require('../config/feature-gates').gates;
    const originalGate = gates.editApptPriceServiceScope;
    try {
      const { jobId } = await fixture(trx, { parent: true });
      gates.editApptPriceServiceScope = false;
      expect((await pricing.loadCompletionPricing(jobId, { database: trx, role: 'admin' })).view.canApply).toBe(false);
      gates.editApptPriceServiceScope = true;
      const plan = await pricing.loadCompletionPricing(jobId, { database: trx, role: 'admin' });
      await pricing.commitCompletionPricingReview(trx, { ...plan, review: { witness: plan.view.witness, applyDiscounts: true } }, { role: 'admin', technicianId: 'synthetic' });
      const saved = await trx('scheduled_services').where({ id: jobId }).first();
      expect(Number(saved.estimated_price)).toBe(85);
      const template = require('../routes/admin-schedule')._test.overlayRecurringTemplateOverrides(saved, { recurring_template_overrides: true });
      expect(Number(template.estimated_price)).toBe(100);
      expect(template.line_discount_type).toBeNull();
    } finally { gates.editApptPriceServiceScope = originalGate; }
  }));
  test('inherited source requires matching series property and never chooses a newer quote', () => rollbackTest(async (trx) => {
    const { jobId, estimateId, parentId, customerId } = await fixture(trx);
    await trx('scheduled_services').where({ id: jobId }).update({ source_estimate_id: null });
    await trx('estimates').insert({ customer_id: customerId, status: 'accepted', estimate_data: {}, monthly_total: 9999 });
    const inherited = await pricing.loadCompletionPricing(jobId, { database: trx, role: 'admin' });
    expect(inherited.view.estimate.id).toBe(estimateId);
    expect(inherited.view.proposedAmount).toBe(85);
    await trx('scheduled_services').where({ id: parentId }).update({ service_address_line1: '200 Different Synthetic Lane' });
    expect((await pricing.loadCompletionPricing(jobId, { database: trx, role: 'admin' })).view).toMatchObject({ canApply: false, estimate: null });
  }));
  test('ambiguous saved lines and a different property never authorize a price', () => rollbackTest(async (trx) => {
    const { jobId, estimateId, soldLine } = await fixture(trx);
    await trx('estimates').where({ id: estimateId }).update({ estimate_data: { result: { recurring: { services: [soldLine, soldLine] } } } });
    expect((await pricing.loadCompletionPricing(jobId, { database: trx, role: 'admin' })).view).toMatchObject({ canApply: false, lines: [{ status: 'ambiguous' }] });
    await trx('scheduled_services').where({ id: jobId }).update({ service_address_line1: '200 Different Synthetic Lane' });
    expect((await pricing.loadCompletionPricing(jobId, { database: trx, role: 'admin' })).view).toMatchObject({ canApply: false, lines: [{ status: 'property_mismatch' }] });
  }));
  test('a fully discounted application stays zero on invoice replay and committed resume', () => rollbackTest(async (trx) => {
    const { jobId, customerId } = await fixture(trx, { net: 0 });
    await trx('customers').where({ id: customerId }).update({ per_application_fee: 100 });
    const plan = await pricing.loadCompletionPricing(jobId, { database: trx, role: 'admin' });
    expect(plan.view).toMatchObject({ canApply: true, proposedAmount: 0 });
    const review = { witness: plan.view.witness, applyDiscounts: true };
    await pricing.commitCompletionPricingReview(trx, { ...plan, review }, { role: 'admin', technicianId: 'synthetic' });
    const { lineItems } = await Invoice.buildLineItemsForScheduledService(jobId, { database: trx, fallbackAmount: 0 });
    expect(lineItems.reduce((sum, row) => sum + Number(row.amount), 0)).toBe(0);
    const [record] = await trx('service_records').insert({ customer_id: customerId, scheduled_service_id: jobId,
      service_date: new Date(), service_type: 'Pest Control', structured_notes: { completionPricing: { witness: review.witness, amountCents: 0 } } }).returning('id');
    await trx('scheduled_services').where({ id: jobId }).update({ estimated_price: 150, status: 'completed' });
    expect((await pricing.loadCompletionPricing(jobId, { database: trx, role: 'admin' })).view).toMatchObject({ currentAmount: 0, completedPrice: true, canApply: false });
    expect(await pricing.committedCompletionPrice(trx, record.id, review)).toBe(0);
    await expect(pricing.committedCompletionPrice(trx, record.id, { witness: 'b'.repeat(64) })).rejects.toMatchObject({ code: 'completion_pricing_resume_unavailable' });
  }));
  test('missing tier rules, a changed tier and excluded line flags cannot introduce a benefit', () => rollbackTest(async (trx) => {
    const { jobId, customerId, estimateId, soldLine } = await fixture(trx, { net: 100 });
    await trx('estimates').where({ id: estimateId }).update({ estimate_data: { result: { recurring: { services: [{ ...soldLine, discountable: false }] } } } });
    expect((await pricing.loadCompletionPricing(jobId, { database: trx, role: 'admin' })).view.canApply).toBe(false);
    await trx('estimates').where({ id: estimateId }).update({ estimate_data: { result: { recurring: { services: [soldLine] } } } });
    await trx('customers').where({ id: customerId }).update({ waveguard_tier: 'Platinum' });
    expect((await pricing.loadCompletionPricing(jobId, { database: trx, role: 'admin' })).view.canApply).toBe(false);
    await trx('customers').where({ id: customerId }).update({ waveguard_tier: 'Gold' });
    await trx('pricing_config').where({ config_key: 'waveguard_tiers' }).delete();
    expect((await pricing.loadCompletionPricing(jobId, { database: trx, role: 'admin' })).view).toMatchObject({ canApply: false, tierRulesAvailable: false });
  }));
  test('grouped services use their own sold lines and invoice the combined net', () => rollbackTest(async (trx) => {
    const { jobId, estimateId, soldLine } = await fixture(trx);
    const addonServiceId = randomUUID();
    await trx('services').insert({ id: addonServiceId, service_key: 'mosquito_monthly', name: 'Mosquito Control', category: 'mosquito', frequency: 'monthly', billing_type: 'recurring', visits_per_year: 12 });
    await trx('scheduled_service_addons').insert({ scheduled_service_id: jobId, service_id: addonServiceId, service_name: 'Mosquito Control',
      service_key_snapshot: 'mosquito_monthly', service_category_snapshot: 'mosquito', recurring_pattern: 'monthly', base_price: 200, estimated_price: 200 });
    await trx('scheduled_services').where({ id: jobId }).update({ estimated_price: 300 });
    await trx('estimates').where({ id: estimateId }).update({ estimate_data: { result: { recurring: { services: [soldLine,
      { service: 'mosquito', name: 'Mosquito Control', frequency: 'monthly', visitsPerYear: 12, perTreatment: 200, priceAfterDiscount: 180, discount: { effectiveDiscount: .1 } }] } } } });
    const plan = await pricing.loadCompletionPricing(jobId, { database: trx, role: 'admin' });
    expect(plan.view).toMatchObject({ canApply: true, proposedAmount: 265 });
    expect(plan.view.lines.map((line) => line.quote.amount)).toEqual([85, 180]);
    await pricing.commitCompletionPricingReview(trx, { ...plan, review: { witness: plan.view.witness, applyDiscounts: true } }, { role: 'admin', technicianId: 'synthetic' });
    const { lineItems } = await Invoice.buildLineItemsForScheduledService(jobId, { database: trx, fallbackAmount: 265 });
    expect(lineItems.reduce((sum, row) => sum + Number(row.amount), 0)).toBe(265);
  }));

  test('unexplained job totals cannot be replaced by a reconstructed discount', () => rollbackTest(async (trx) => {
    const { jobId } = await fixture(trx);
    for (const amount of [0, 120]) {
      await trx('scheduled_services').where({ id: jobId }).update({ estimated_price: amount });
      expect((await pricing.loadCompletionPricing(jobId, { database: trx, role: 'admin' })).view.canApply).toBe(false);
    }
  }));
  test('lawn receives the configured tier benefit', () => rollbackTest(async (trx) => {
    const { jobId, estimateId, serviceId, soldLine } = await fixture(trx, { net: 100 });
    await trx('services').where({ id: serviceId }).update({ service_key: 'lawn_care_enhanced', name: 'Lawn Care', category: 'lawn' });
    await trx('scheduled_services').where({ id: jobId }).update({ service_key_snapshot: 'lawn_care_enhanced', service_category_snapshot: 'lawn', service_type: 'Lawn Care' });
    await trx('estimates').where({ id: estimateId }).update({ estimate_data: { result: { recurring: { services: [{ ...soldLine, service: 'lawn_care', name: 'Lawn Care' }] } } } });
    expect((await pricing.loadCompletionPricing(jobId, { database: trx, role: 'admin' })).view).toMatchObject({ canApply: true, proposedAmount: 85 });
  }));

});
