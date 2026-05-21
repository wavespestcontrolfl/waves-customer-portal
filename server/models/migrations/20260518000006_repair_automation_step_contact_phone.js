async function hasMigration(knex, name) {
  try {
    const row = await knex('knex_migrations').where({ name }).first();
    return !!row;
  } catch {
    return false;
  }
}

async function applyAutomationStepContactPhoneRepair(knex) {
  await knex('automation_steps')
    .whereIn('template_key', ['new_lead', 'service_renewal'])
    .update({
      html_body: knex.raw(
        'REPLACE(REPLACE(html_body, ?, ?), ?, ?)',
        ['+19412101983', '+19412975749', '(941) 210-1983', '(941) 297-5749']
      ),
      text_body: knex.raw(
        'REPLACE(text_body, ?, ?)',
        ['(941) 210-1983', '(941) 297-5749']
      ),
      updated_at: knex.fn.now(),
    });
}

async function revertAutomationStepContactPhoneRepair(knex) {
  await knex('automation_steps')
    .whereIn('template_key', ['new_lead', 'service_renewal'])
    .update({
      html_body: knex.raw(
        'REPLACE(REPLACE(html_body, ?, ?), ?, ?)',
        ['+19412975749', '+19412101983', '(941) 297-5749', '(941) 210-1983']
      ),
      text_body: knex.raw(
        'REPLACE(text_body, ?, ?)',
        ['(941) 297-5749', '(941) 210-1983']
      ),
      updated_at: knex.fn.now(),
    });
}

exports.up = async function up(knex) {
  if (await hasMigration(knex, '20260518000007_repair_automation_step_contact_phone.js')) return;
  await applyAutomationStepContactPhoneRepair(knex);
};

exports.down = async function down(knex) {
  if (await hasMigration(knex, '20260518000007_repair_automation_step_contact_phone.js')) return;
  await revertAutomationStepContactPhoneRepair(knex);
};

exports.applyAutomationStepContactPhoneRepair = applyAutomationStepContactPhoneRepair;
exports.revertAutomationStepContactPhoneRepair = revertAutomationStepContactPhoneRepair;
exports.hasMigration = hasMigration;
