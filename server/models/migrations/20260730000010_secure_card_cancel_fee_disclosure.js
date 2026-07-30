// Owner ruling 2026-07-30: appointment-lane card invites must disclose the
// late-cancel/no-show fee. Adds the {cancel_fee_line} token to the two
// secure-card SMS templates (base + plan-choice variant) AND to any
// sms_template_variants rows for those keys — production rendering prefers a
// selected experiment variant's body over the base (admin-sms-templates),
// so a variant without the token would silently drop the disclosure for its
// assigned recipients. The line itself is composed at send time from the
// same pricing_config the estimate card-hold lane charges from (deliberately
// compact: the rendered plan-choice invite stays within the card_request
// three-segment target).
//
// Read-modify-write on admin-editable rows: the token is inserted into the
// CURRENT body (before the "We never take card numbers" trailer when
// present, appended otherwise) and only when not already present — admin
// edits are preserved.
const KEYS = ['secure_appointment_card', 'secure_appointment_card_plans'];
const TOKEN = '{cancel_fee_line}';
const TRAILER = '\nWe never take card numbers by phone';

function withToken(body) {
  if (typeof body !== 'string' || body.includes(TOKEN)) return null;
  return body.includes(TRAILER)
    ? body.replace(TRAILER, `${TOKEN}${TRAILER}`)
    : `${body}${TOKEN}`;
}

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('sms_templates')) {
    for (const key of KEYS) {
      const row = await knex('sms_templates').where({ template_key: key }).first('id', 'body', 'variables');
      if (!row) continue;
      const body = withToken(row.body);
      if (!body) continue;
      let variables = row.variables;
      try {
        const list = Array.isArray(variables) ? variables : JSON.parse(variables || '[]');
        if (!list.includes('cancel_fee_line')) list.push('cancel_fee_line');
        variables = JSON.stringify(list);
      } catch {
        variables = row.variables;
      }
      await knex('sms_templates').where({ id: row.id }).update({ body, variables, updated_at: new Date() });
    }
  }
  if (await knex.schema.hasTable('sms_template_variants')) {
    const variants = await knex('sms_template_variants').whereIn('template_key', KEYS).select('id', 'body');
    for (const variant of variants) {
      const body = withToken(variant.body);
      if (!body) continue;
      await knex('sms_template_variants').where({ id: variant.id }).update({ body, updated_at: new Date() });
    }
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('sms_templates')) {
    for (const key of KEYS) {
      const row = await knex('sms_templates').where({ template_key: key }).first('id', 'body', 'variables');
      if (!row || typeof row.body !== 'string' || !row.body.includes(TOKEN)) continue;
      const body = row.body.replace(TOKEN, '');
      let variables = row.variables;
      try {
        const list = Array.isArray(variables) ? variables : JSON.parse(variables || '[]');
        variables = JSON.stringify(list.filter((v) => v !== 'cancel_fee_line'));
      } catch {
        variables = row.variables;
      }
      await knex('sms_templates').where({ id: row.id }).update({ body, variables, updated_at: new Date() });
    }
  }
  if (await knex.schema.hasTable('sms_template_variants')) {
    const variants = await knex('sms_template_variants').whereIn('template_key', KEYS).select('id', 'body');
    for (const variant of variants) {
      if (typeof variant.body !== 'string' || !variant.body.includes(TOKEN)) continue;
      await knex('sms_template_variants').where({ id: variant.id }).update({ body: variant.body.replace(TOKEN, ''), updated_at: new Date() });
    }
  }
};
