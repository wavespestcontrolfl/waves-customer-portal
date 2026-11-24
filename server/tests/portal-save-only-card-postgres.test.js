/**
 * Save-only add-card completion against the real migrated schema (skipped without DATABASE_URL; CI runs it).
 * finishSaveOnlyAdd is what POST /billing/cards and the portal_add_method webhook both end in for the add-a-card email's
 * form: it keeps what the customer saw as one audit event per method, settles the default role the same way whichever of
 * the two lands first, and writes NO payment_method_consents row and no Auto Pay state. Synthetic data only.
 */
const { randomUUID } = require('node:crypto');

const SKIP = !process.env.DATABASE_URL;
const maybeDescribe = SKIP ? describe.skip : describe;
jest.setTimeout(60000);

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

maybeDescribe('finishSaveOnlyAdd (real schema)', () => {
  let db;
  let finishSaveOnlyAdd;
  const customerIds = [];

  beforeAll(() => {
    db = require('../models/db');
    ({ finishSaveOnlyAdd } = require('../services/portal-save-only-card'));
  });

  afterEach(async () => {
    const ids = customerIds.splice(0);
    if (!ids.length) return;
    await db('audit_log').where({ action: 'customer.payment_method.saved_card_only' }).whereIn('actor_id', ids).del();
    await db('payment_method_consents').whereIn('customer_id', ids).del();
    await db('payment_methods').whereIn('customer_id', ids).del();
    await db('customers').whereIn('id', ids).del();
  });

  afterAll(async () => {
    await db.destroy();
  });

  async function customer() {
    const id = randomUUID();
    customerIds.push(id);
    await db('customers').insert({
      id, first_name: 'Sample', last_name: 'SaveOnly', phone: `+1941555${String(8000 + customerIds.length)}`, email: `so-${id}@example.invalid`,
      address_line1: '12 Example Loop', city: 'Sarasota', state: 'FL', zip: '34231', pipeline_stage: 'new_lead', active: true,
      billing_mode: 'per_application', autopay_enabled: false,
    });
    return id;
  }
  async function card(customerId, extra = {}) {
    const [row] = await db('payment_methods').insert({
      customer_id: customerId, processor: 'stripe', stripe_payment_method_id: `pm_${randomUUID()}`, method_type: 'card',
      card_brand: 'visa', last_four: '4242', exp_month: '12', exp_year: '2031', is_default: false, autopay_enabled: false, ...extra,
    }).returning('*');
    return row;
  }
  const finish = (customerId, method, extra = {}) => finishSaveOnlyAdd({
    customerId, method, consentTextVersion: 'v12_2026-09-30', ip: '203.0.113.9', userAgent: 'test-agent', via: 'portal_add_card', ...extra,
  });
  const defaults = async (customerId) => (await db('payment_methods').where({ customer_id: customerId, is_default: true }).select('id')).map((r) => r.id);

  test('keeps what the customer saw once per method, writes no consent row, and leaves Auto Pay alone', async () => {
    const id = await customer();
    const method = await card(id, { is_default: true });
    await finish(id, method);
    await finish(id, method, { via: 'portal_add_method_webhook', ip: null, userAgent: null });
    const events = await db('audit_log').where({ action: 'customer.payment_method.saved_card_only', resource_id: method.id });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor_type: 'customer', actor_id: id, resource_type: 'payment_method', ip_address: '203.0.113.9', user_agent: 'test-agent' });
    expect(events[0].metadata).toMatchObject({ via: 'portal_add_card', consentTextVersion: 'v12_2026-09-30', stripePaymentMethodId: method.stripe_payment_method_id });
    expect(events[0].metadata.consentText).toContain('authorize Waves Pest Control, LLC');
    expect(await db('payment_method_consents').where({ customer_id: id })).toHaveLength(0);
    const after = await db('customers').where({ id }).first('autopay_enabled', 'autopay_payment_method_id');
    expect(after).toMatchObject({ autopay_enabled: false, autopay_payment_method_id: null });
    expect((await db('payment_methods').where({ id: method.id }).first()).autopay_enabled).toBe(false);
  });

  test('the first usable card is the default whichever of the browser save and the webhook inserted it first', async () => {
    const webhookFirst = await customer();
    const insertedByWebhook = await card(webhookFirst, { is_default: false });
    expect((await finish(webhookFirst, insertedByWebhook)).is_default).toBe(true);
    expect(await defaults(webhookFirst)).toEqual([insertedByWebhook.id]);

    const browserFirst = await customer();
    const insertedByBrowser = await card(browserFirst, { is_default: true });
    expect((await finish(browserFirst, insertedByBrowser, { via: 'portal_add_method_webhook' })).is_default).toBe(true);
    expect(await defaults(browserFirst)).toEqual([insertedByBrowser.id]);
  });

  test('another usable default keeps the role; an expired default gives it up to the new card', async () => {
    const keeper = await customer();
    const existing = await card(keeper, { is_default: true });
    const added = await card(keeper, { is_default: true });
    expect((await finish(keeper, added)).is_default).toBe(false);
    expect(await defaults(keeper)).toEqual([existing.id]);

    const expiredHolder = await customer();
    const expired = await card(expiredHolder, { is_default: true, exp_month: '01', exp_year: '2020' });
    const fresh = await card(expiredHolder, { is_default: false });
    expect((await finish(expiredHolder, fresh)).is_default).toBe(true);
    expect(await defaults(expiredHolder)).toEqual([fresh.id]);
    expect((await db('payment_methods').where({ id: expired.id }).first()).is_default).toBe(false);
  });
});
