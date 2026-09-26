/**
 * Termite annual plan — renewal-notice ladder, slice 5 ("notice ladder").
 *
 * Seeds the 'termite_annual_renewal_notice' sms_templates row the 45- and
 * 30-day termite rungs render (server/services/annual-prepay-renewals.js's
 * sendCustomerTermNotice — 15/7 keep the existing generic
 * 'annual_prepay_renewal_reminder' template even for a termite term).
 * Single-brace {var} placeholder syntax, same as every other sms_templates
 * row (see 20260514000001_annual_prepay_terms.js seeding
 * 'annual_prepay_renewal_reminder' and server/routes/admin-sms-templates.js's
 * getTemplate renderer) — the owner-approved draft used {{double_brace}},
 * adapted here to the template system's actual syntax with no wording
 * change. Owner-approved wording (auto-renew + cancel-link disclosure,
 * ruling A-13):
 *
 *   "Hi {first_name}, your Waves Subterranean Termite Protection at
 *   {address_short} renews on {renewal_date} for another 12 months at
 *   {renewal_fee}. It renews automatically unless you cancel first:
 *   {cancel_link}. Questions? Reply here."
 *
 * cancel_link is only ever rendered when the portal's cancel-request flow
 * (GATE_CANCEL_FLOW_V2) is live — the caller fails closed and never renders
 * this template otherwise (see fileTermiteCancelLinkException).
 *
 * up() is idempotent (insert-if-absent, update-in-place if present — same
 * shape as the sibling seed). down() removes the row ONLY if it is still
 * exactly what this migration inserted (name/category/body/variables
 * unchanged) — an admin edit in the sms-templates UI after this ships is
 * preserved rather than silently deleted on a rollback.
 */

const TEMPLATE_KEY = 'termite_annual_renewal_notice';
const TEMPLATE = {
  template_key: TEMPLATE_KEY,
  name: 'Termite Annual Renewal Notice',
  category: 'retention',
  body: 'Hi {first_name}, your Waves Subterranean Termite Protection at {address_short} renews on {renewal_date} for another 12 months at {renewal_fee}. It renews automatically unless you cancel first: {cancel_link}. Questions? Reply here.',
  variables: JSON.stringify(['first_name', 'address_short', 'renewal_date', 'renewal_fee', 'cancel_link']),
};

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  const cols = await knex('sms_templates').columnInfo();
  const now = new Date();
  const row = {
    ...TEMPLATE,
    ...(cols.is_active ? { is_active: true } : {}),
    ...(cols.sort_order ? { sort_order: 51 } : {}),
    ...(cols.updated_at ? { updated_at: now } : {}),
    ...(cols.created_at ? { created_at: now } : {}),
  };

  const existing = await knex('sms_templates').where({ template_key: TEMPLATE_KEY }).first();
  if (existing) {
    await knex('sms_templates').where({ template_key: TEMPLATE_KEY }).update({
      name: row.name,
      category: row.category,
      body: row.body,
      variables: row.variables,
      ...(cols.is_active ? { is_active: true } : {}),
      ...(cols.updated_at ? { updated_at: now } : {}),
    });
  } else {
    await knex('sms_templates').insert(row);
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  const existing = await knex('sms_templates').where({ template_key: TEMPLATE_KEY }).first();
  if (!existing) return;
  // Only remove the row this migration owns if nobody has changed it since
  // (name/category/body all still match what up() inserted) — an operator
  // edit through the admin sms-templates UI survives a rollback. `variables`
  // is left out of this comparison: its column type (json/jsonb/text) isn't
  // pinned by this file, and body is the content that actually matters.
  const unchanged = existing.name === TEMPLATE.name
    && existing.category === TEMPLATE.category
    && existing.body === TEMPLATE.body;
  if (unchanged) {
    await knex('sms_templates').where({ template_key: TEMPLATE_KEY }).del();
  }
};
