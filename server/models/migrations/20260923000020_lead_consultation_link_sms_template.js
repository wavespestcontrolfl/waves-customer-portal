/**
 * SMS template for the lead consultation-link text — Virginia's "Insert
 * link" / Leads-page send (lead-inspection-link-scope.md §4), gated by
 * GATE_LEAD_INSPECTION_LINK. Rendered via admin-sms-templates.getTemplate
 * with {first_name, consultation_url} by both the SMS composer's
 * `consultation` customer-link kind and the Leads page's consultation-link
 * action; both fall back to buildLeadConsultationLink's own `line` when
 * this row is inactive or missing (server/services/lead-consultation-link.js).
 *
 * Keeps the "Reply STOP to opt out." line: this is our first text to a
 * lead who is not yet a customer, same class as `voicemail_quote_link` /
 * `lead_auto_reply_biz` per docs/sms-stop-line-policy.md test 2. See the
 * keep-list there and the pinned keep-list in
 * server/tests/stop-line-off-remaining-transactional-migration.test.js.
 *
 * Idempotent — skips if the key already exists. down() is a documented
 * no-op: seed rollbacks never delete an admin-editable row once it may
 * have been hand-edited (waves-db skill §4).
 */

const TEMPLATE = {
  template_key: 'lead_consultation_link',
  name: 'Lead — Consultation Link',
  category: 'leads',
  body: "Hi {first_name}, it's Waves. Pick a time for us to stop by for a free consultation: {consultation_url}\n\nOr reply here and we'll set it up.\n\nReply STOP to opt out.",
  variables: ['first_name', 'consultation_url'],
  sort_order: 126,
};

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;

  const existing = await knex('sms_templates')
    .where({ template_key: TEMPLATE.template_key })
    .first();
  if (existing) return;

  // recordAuditEvent after a successful insert, matching the current
  // seeded-template migration pattern (20260906000040_recurring_dispatch_sms).
  const inserted = await knex('sms_templates').insert({
    template_key: TEMPLATE.template_key,
    name: TEMPLATE.name,
    category: TEMPLATE.category,
    body: TEMPLATE.body,
    variables: JSON.stringify(TEMPLATE.variables),
    sort_order: TEMPLATE.sort_order,
    is_active: true,
  }).returning('id');

  if (inserted.length && await knex.schema.hasTable('audit_log')) {
    await require('../../services/audit-log').recordAuditEvent({
      actor_type: 'system', action: 'sms_template.seeded', resource_type: 'sms_template',
      resource_id: inserted[0].id,
      metadata: { templateKey: TEMPLATE.template_key, migration: '20260923000020_lead_consultation_link_sms_template' },
      trx: knex, critical: true,
    });
  }
};

// Documented no-op (waves-db skill §4): a seed migration's down() must
// never delete an admin-editable row — an operator may have already
// edited this template's body/status, and a blanket revert would erase
// that edit along with the seed.
exports.down = async function down() {};
