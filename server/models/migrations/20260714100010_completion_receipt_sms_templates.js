// Completion-time payment texts (owner request 2026-07-14):
//
// 1. `service_complete_paid_receipt` — ONE text instead of two when the
//    completion auto-charge settles inline: the service report line and the
//    receipt facts (amount, card, receipt link) combined. Seeded INACTIVE:
//    the dispatch completion path only engages the combined flow when this
//    row exists AND is active, so nothing changes until the owner reviews
//    the copy and enables it in /admin templates. While inactive, customers
//    keep today's two texts (service_complete_prepaid + invoice_receipt).
//    The receipt EMAIL leg is unaffected either way.
//
// 2. `payment_failed` — the row already exists (seeded in the 2026-07 SMS
//    template audit) and was never wired to a sender; the dispatch decline
//    path now sends it. This migration only widens its allowed-variables
//    list so the owner can add {amount}/{card_line}/{card_last4} to the body
//    from the template editor. The BODY is deliberately untouched — copy is
//    owner-managed.
const TEMPLATE = {
  template_key: 'service_complete_paid_receipt',
  name: 'Service Complete + Paid (with receipt)',
  category: 'billing',
  body: 'Hello {first_name}! Thanks for your payment today — ${amount}{card_line}. Your {service_type} service report is ready: {portal_url}\n\nReceipt: {receipt_url}\n\nQuestions or requests? Reply here.\n\nReply STOP to opt out.',
  variables: JSON.stringify(['first_name', 'service_type', 'portal_url', 'amount', 'card_line', 'receipt_url']),
  is_active: false,
  sort_order: 31,
  updated_at: new Date(),
};

const PAYMENT_FAILED_KEY = 'payment_failed';
const PAYMENT_FAILED_NEW_VARS = ['amount', 'card_line', 'card_last4'];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  await knex('sms_templates')
    .insert({ ...TEMPLATE, created_at: new Date() })
    .onConflict('template_key')
    .merge(TEMPLATE);

  const failed = await knex('sms_templates')
    .where({ template_key: PAYMENT_FAILED_KEY })
    .first();
  if (failed) {
    let vars = [];
    try {
      vars = Array.isArray(failed.variables) ? failed.variables : JSON.parse(failed.variables || '[]');
    } catch { vars = []; }
    const merged = [...new Set([...vars, ...PAYMENT_FAILED_NEW_VARS])];
    if (merged.length !== vars.length) {
      await knex('sms_templates')
        .where({ template_key: PAYMENT_FAILED_KEY })
        .update({ variables: JSON.stringify(merged), updated_at: new Date() });
    }
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  await knex('sms_templates')
    .where({ template_key: TEMPLATE.template_key })
    .del();
  // payment_failed variables widening is left in place on rollback — it is
  // additive metadata and the body was never touched.
};

// Exported so the copy contract (inactive seed, exact variables, receipt
// facts present) can be asserted against the source of truth in tests.
exports.TEMPLATE = TEMPLATE;
exports.PAYMENT_FAILED_NEW_VARS = PAYMENT_FAILED_NEW_VARS;
