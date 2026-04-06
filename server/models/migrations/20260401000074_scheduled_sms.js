exports.up = async function (knex) {
  const cols = await knex.raw("SELECT column_name FROM information_schema.columns WHERE table_name = 'sms_log'");
  const colNames = cols.rows.map(r => r.column_name);

  if (!colNames.includes('scheduled_for')) {
    await knex.schema.alterTable('sms_log', t => {
      t.timestamp('scheduled_for');
    });
  }
};

exports.down = async function (knex) {
  try {
    await knex.schema.alterTable('sms_log', t => {
      t.dropColumn('scheduled_for');
    });
  } catch { /* ignore */ }
};
