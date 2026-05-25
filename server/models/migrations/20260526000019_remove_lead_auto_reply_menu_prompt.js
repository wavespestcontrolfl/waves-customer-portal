const TEMPLATE_KEY = 'lead_auto_reply_biz';

const MENU_PROMPT_RE = /What are you interested in[:\s—-]+Pest Control,\s*Lawn Care,\s*or a One-Time Service\?/i;

const OLD_BODY =
  "Hello {first_name}! Thanks for reaching out to Waves!\n\nWhat are you interested in: Pest Control, Lawn Care, or a One-Time Service?\n\nReply and we'll get you a quote.";

const NEW_BODY =
  'Hello {first_name}! Waves here! We received your quote request. A specialist will be calling soon. Thank you!';

function rowFor(cols, now, body, { activate = false } = {}) {
  return {
    ...(cols.name ? { name: 'Lead Auto-Reply (Business Hours)' } : {}),
    ...(cols.category ? { category: 'estimates' } : {}),
    body,
    ...(cols.variables ? { variables: JSON.stringify(['first_name']) } : {}),
    ...(cols.is_active && activate ? { is_active: true } : {}),
    ...(cols.sort_order ? { sort_order: 21 } : {}),
    ...(cols.updated_at ? { updated_at: now } : {}),
  };
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;

  const cols = await knex('sms_templates').columnInfo();
  const now = new Date();
  const existing = await knex('sms_templates')
    .where({ template_key: TEMPLATE_KEY })
    .first();

  if (!existing) {
    await knex('sms_templates').insert({
      template_key: TEMPLATE_KEY,
      ...rowFor(cols, now, NEW_BODY, { activate: true }),
      ...(cols.created_at ? { created_at: now } : {}),
    });
    return;
  }

  if (!MENU_PROMPT_RE.test(existing.body || '')) return;

  await knex('sms_templates')
    .where({ template_key: TEMPLATE_KEY })
    .update(rowFor(cols, now, NEW_BODY));
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;

  const cols = await knex('sms_templates').columnInfo();
  const existing = await knex('sms_templates')
    .where({ template_key: TEMPLATE_KEY })
    .first();

  if (!existing || existing.body !== NEW_BODY) return;

  await knex('sms_templates')
    .where({ template_key: TEMPLATE_KEY })
    .update(rowFor(cols, new Date(), OLD_BODY));
};
