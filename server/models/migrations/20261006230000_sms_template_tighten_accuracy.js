/**
 * Accuracy fixes to 20261006220000_sms_template_tighten (Codex review on
 * PR #6051, plus a re-read of every shortened promise). That migration was
 * pushed, so it is frozen; this one swaps its new bodies once more.
 *
 *   - service_request_confirmation: {response_time} is a review window, not
 *     a follow-up deadline (20260926120400; routes/requests.js).
 *   - service_cancellation_end_of_term_confirmation: "nothing new is
 *     scheduled or charged" again; a completed-visit balance can still be
 *     collected after the effective date (20260831000070).
 *   - ach_payment_processing: "send a receipt", not "text": the receipt goes
 *     by email when the customer's preferences skip the SMS leg.
 *   - upsell_tier_upgrade: savings only; a tier adds no services.
 *   - service_complete_paid_receipt: names Waves again (a payment text with
 *     an amount and card suffix must say who it is from).
 *   - invoice_sent_annual_prepay: "prepays", the original verb.
 *   - service_complete_annual_prepay: "nothing is due today", the original
 *     scope.
 *   - secure_appointment_card: "Nothing is charged today, only after
 *     service." again; the {cancel_fee_line} that follows can describe a
 *     charge before service.
 *
 * Same exact-body CAS contract: a row whose body is not this PR's new text
 * (an administrator edit, or 20261006220000 skipped it) is left alone.
 */
const SWAPS = [
  [
    "service_request_confirmation",
    "Hi {first_name}, Waves got your {category} request. We'll follow up within {response_time}.",
    "Hi {first_name}, Waves got your {category} request. We'll review it within {response_time}, then follow up."
  ],
  [
    "service_cancellation_end_of_term_confirmation",
    "Hi {first_name}, your Waves plan is cancelled and won't renew. Paid visits stay on the calendar through {effective_date}, and nothing is charged after that. Completed visits are still payable.\n\nQuestions or change your mind? Reply here.",
    "Hi {first_name}, your Waves plan is cancelled and won't renew. Paid visits stay on the calendar through {effective_date}. After that, nothing new is scheduled or charged. Completed visits are still payable.\n\nQuestions or change your mind? Reply here."
  ],
  [
    "ach_payment_processing",
    "Hi {first_name}, Waves got your bank payment for invoice {invoice_number}. It usually clears in 5 business days, and we'll text a receipt then.",
    "Hi {first_name}, Waves got your bank payment for invoice {invoice_number}. It usually clears in 5 business days, and we'll send a receipt then."
  ],
  [
    "upsell_tier_upgrade",
    "Hi {first_name}, it's Waves. WaveGuard {next_tier} adds more coverage and bigger savings. Want the numbers? Reply YES and we'll send a breakdown.",
    "Hi {first_name}, it's Waves. Upgrading to WaveGuard {next_tier} can add service savings. Want the numbers? Reply YES and we'll send a breakdown."
  ],
  [
    "service_complete_paid_receipt",
    "Hi {first_name}, your {service_type} is done and paid: ${amount}{card_line}. Thank you!\n\nReport: {portal_url}\nReceipt: {receipt_url}",
    "Hi {first_name}, your Waves {service_type} is done and paid: ${amount}{card_line}. Thank you!\n\nReport: {portal_url}\nReceipt: {receipt_url}"
  ],
  [
    "invoice_sent_annual_prepay",
    "Hi {first_name}, your Waves annual prepay invoice is ready. It covers {coverage_summary}.{first_visit_clause}\n\nPay here: {pay_url}",
    "Hi {first_name}, your Waves annual prepay invoice is ready. It prepays {coverage_summary}.{first_visit_clause}\n\nPay here: {pay_url}"
  ],
  [
    "service_complete_annual_prepay",
    "Hi {first_name}, your {service_type} is done. Your Waves annual plan covers it, so nothing is due.\n\nReport: {portal_url}",
    "Hi {first_name}, your {service_type} is done. Your Waves annual plan covers it, so nothing is due today.\n\nReport: {portal_url}"
  ],
  [
    "secure_appointment_card",
    "Hi {first_name}, to finish booking your Waves {service_type}{date_line}, add a card on file: {secure_link}\n\nNothing is charged until after service.\n\n{cancel_fee_line}We never take card numbers by phone.",
    "Hi {first_name}, to finish booking your Waves {service_type}{date_line}, add a card on file: {secure_link}\n\nNothing is charged today, only after service.\n\n{cancel_fee_line}We never take card numbers by phone."
  ]
];

const MIGRATION = '20261006230000_sms_template_tighten_accuracy';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  const hasAudit = await knex.schema.hasTable('audit_log');
  const tables = ['sms_templates'];
  if (await knex.schema.hasTable('sms_template_variants')) tables.push('sms_template_variants');
  const swaps = new Map(SWAPS.map(([key, before, after]) => [key, { before, after }]));
  for (const table of tables) {
    const rows = await knex(table).whereIn('template_key', [...swaps.keys()]).select('id', 'template_key', 'body');
    for (const row of rows) {
      const { before, after } = swaps.get(row.template_key);
      if (row.body !== before) continue; // an admin edit already changed it — leave it alone
      // Exact-body CAS protects an administrator save racing this migration.
      const changed = await knex(table)
        .where({ id: row.id, body: before })
        .update({ body: after, updated_at: knex.fn.now() });
      if (changed && hasAudit) {
        const { recordAuditEvent } = require('../../services/audit-log');
        await recordAuditEvent({
          actor_type: 'system', action: 'sms_template.delivery_copy_updated',
          resource_type: table, resource_id: String(row.id),
          metadata: { migration: MIGRATION, template_key: row.template_key },
          critical: true, trx: knex,
        });
      }
    }
  }
};

exports.down = async function down() {
  // Intentionally no-op: up() preserves admin edits, and a body matching
  // this migration's copy may be an administrator's own — reverting seeded
  // copy would erase it (waves-db data-correction rule).
};

exports._SWAPS = SWAPS;
