exports.up = async function (knex) {
  const hasPrefs = await knex.schema.hasTable('notification_preferences');
  const hasTechs = await knex.schema.hasTable('technicians');
  if (!hasPrefs || !hasTechs) return;

  const users = await knex('technicians').where({ active: true }).select('id');
  if (!users.length) return;

  const triggerKeys = ['kb_audit_flagged', 'internal_admin_alert'];
  const rows = users.flatMap((u) => triggerKeys.map((triggerKey) => ({
    admin_user_id: u.id,
    trigger_key: triggerKey,
    push_enabled: true,
    bell_enabled: true,
    sound_enabled: true,
  })));

  await knex('notification_preferences')
    .insert(rows)
    .onConflict(['admin_user_id', 'trigger_key'])
    .ignore();
};

exports.down = async function (knex) {
  const hasPrefs = await knex.schema.hasTable('notification_preferences');
  if (!hasPrefs) return;
  await knex('notification_preferences')
    .whereIn('trigger_key', ['kb_audit_flagged', 'internal_admin_alert'])
    .del();
};
