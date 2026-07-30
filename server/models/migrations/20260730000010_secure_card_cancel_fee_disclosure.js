// Owner ruling 2026-07-30: appointment-lane card invites must disclose the
// late-cancel/no-show fee. Adds the {cancel_fee_line} token to the two
// secure-card SMS templates (base + plan-choice variant). The line itself is
// composed at send time from the same pricing_config the estimate card-hold
// lane charges from, so a fee change propagates without a template edit.
//
// Read-modify-write on admin-editable rows: the token is inserted into the
// CURRENT body (before the "We never take card numbers" trailer when
// present, appended otherwise) and only when not already present — an
// admin-edited body keeps its edits.
const KEYS = ['secure_appointment_card', 'secure_appointment_card_plans'];
const TOKEN = '{cancel_fee_line}';
const TRAILER = '\nWe never take card numbers by phone';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  for (const key of KEYS) {
    const row = await knex('sms_templates').where({ template_key: key }).first('id', 'body', 'variables');
    if (!row || typeof row.body !== 'string') continue;
    if (row.body.includes(TOKEN)) continue;
    const body = row.body.includes(TRAILER)
      ? row.body.replace(TRAILER, `${TOKEN}${TRAILER}`)
      : `${row.body}${TOKEN}`;
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
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
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
};
