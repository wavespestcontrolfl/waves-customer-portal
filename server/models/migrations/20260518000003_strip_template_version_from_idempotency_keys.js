exports.up = async function up(knex) {
  await knex.raw(`
    UPDATE email_template_automations
    SET idempotency_key_template = regexp_replace(idempotency_key_template, ':\\{template_version_id\\}', '', 'g'),
        updated_at = NOW()
    WHERE idempotency_key_template LIKE '%{template_version_id}%'
  `);
};

exports.down = async function down() {
  // no-op: re-introducing the bug is not a valid down path
};
