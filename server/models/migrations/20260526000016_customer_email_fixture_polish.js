/**
 * Polish customer-facing email review fixtures.
 *
 * Keeps the production active templates and send contracts unchanged while
 * replacing review-only fixture values that made the export look like a live
 * customer would see generic or company-owned data.
 */

const FIXTURES = {
  'account.updated': {
    change_summary: 'Your appointment reminder preference was updated.',
    changed_items_summary: '72-hour appointment reminder: On to Off',
    customer_portal_url: 'https://portal.wavespestcontrol.com',
    property_label: '123 Harbor View Dr, Sarasota, FL 34236',
    company_phone: '(941) 297-5749',
    company_email: 'contact@wavespestcontrol.com',
  },
  'portal.invite': {
    customer_name: 'Taylor Morgan',
    customer_email: 'taylor@example.com',
    portal_invite_url: 'https://portal.wavespestcontrol.com/login',
    property_address: '123 Harbor View Dr, Sarasota, FL 34236',
    company_phone: '(941) 297-5749',
    company_email: 'contact@wavespestcontrol.com',
  },
};

function parsePayload(value) {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) || {};
    } catch {
      return {};
    }
  }
  return value;
}

exports.up = async function up(knex) {
  const hasTemplates = await knex.schema.hasTable('email_templates');
  const hasFixtures = await knex.schema.hasTable('email_template_fixtures');
  if (!hasTemplates || !hasFixtures) return;

  for (const [templateKey, patch] of Object.entries(FIXTURES)) {
    const template = await knex('email_templates').where({ template_key: templateKey }).first();
    if (!template) continue;

    const fixture = await knex('email_template_fixtures')
      .where({ template_id: template.id, is_default: true })
      .first();

    if (!fixture) {
      await knex('email_template_fixtures').insert({
        template_id: template.id,
        name: 'Happy path',
        payload: JSON.stringify({ first_name: 'Taylor', ...patch }),
        is_default: true,
      });
      continue;
    }

    const payload = parsePayload(fixture.payload);
    await knex('email_template_fixtures').where({ id: fixture.id }).update({
      payload: JSON.stringify({ ...payload, ...patch }),
      updated_at: new Date(),
    });
  }
};

exports.down = async function down() {
  // Review fixture changes are intentionally retained.
};
