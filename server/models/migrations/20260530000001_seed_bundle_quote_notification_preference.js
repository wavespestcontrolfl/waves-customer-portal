exports.up = async function (knex) {
  const hasPrefs = await knex.schema.hasTable('notification_preferences');
  const hasTechs = await knex.schema.hasTable('technicians');
  if (!hasPrefs || !hasTechs) return;

  const users = await knex('technicians').where({ active: true }).select('id');
  if (!users.length) return;

  const rows = users.map((u) => ({
    admin_user_id: u.id,
    trigger_key: 'bundle_quote_requested',
    push_enabled: true,
    bell_enabled: true,
    sound_enabled: true,
  }));

  await knex('notification_preferences')
    .insert(rows)
    .onConflict(['admin_user_id', 'trigger_key'])
    .ignore();
};

exports.down = async function (knex) {
  const hasPrefs = await knex.schema.hasTable('notification_preferences');
  if (!hasPrefs) return;
  await knex('notification_preferences')
    .where({ trigger_key: 'bundle_quote_requested' })
    .del();
};
