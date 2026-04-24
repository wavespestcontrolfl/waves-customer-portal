/**
 * Durable consent ledger for saved payment methods.
 *
 * Every time a customer opts in to "save this card" we write one row here
 * with a verbatim snapshot of the consent copy they saw, plus client
 * metadata (IP, user agent, source surface). This is separate from
 * payment_methods on purpose — cards come and go (expired, replaced,
 * removed) but the consent record must survive for audit / chargeback
 * / recurring-authorization disputes.
 *
 * Never delete rows from this table. When a card is removed we keep the
 * consent record; it shows what the customer agreed to at the time.
 */

exports.up = async function (knex) {
  await knex.schema.createTable('payment_method_consents', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('customer_id').notNullable().references('id').inTable('customers').onDelete('CASCADE');
    // Nullable FK — for /pay/:token flow we may capture consent before
    // the payment_methods row is written (webhook is async). The
    // stripe_payment_method_id is always set so we can backfill the FK
    // once the webhook lands.
    t.uuid('payment_method_id').nullable().references('id').inTable('payment_methods').onDelete('SET NULL');
    t.string('stripe_payment_method_id', 100).notNullable();
    t.string('source', 40).notNullable(); // pay_page | onboarding | portal_add_card | admin_tap_to_pay
    t.string('consent_text_version', 20).notNullable();
    t.text('consent_text_snapshot').notNullable();
    t.string('ip', 45).nullable(); // IPv6-safe
    t.text('user_agent').nullable();
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.index('customer_id', 'idx_pmc_customer_id');
    t.index('stripe_payment_method_id', 'idx_pmc_stripe_pm_id');
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('payment_method_consents');
};
