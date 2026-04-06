exports.up = async function (knex) {
  const cols = await knex.raw("SELECT column_name FROM information_schema.columns WHERE table_name = 'customers'");
  const existing = cols.rows.map(r => r.column_name);
  await knex.schema.alterTable('customers', t => {
    if (!existing.includes('health_score')) t.integer('health_score');
    if (!existing.includes('health_risk')) t.string('health_risk', 20);
  });
};
exports.down = async function (knex) {
  try { await knex.schema.alterTable('customers', t => { t.dropColumn('health_score'); t.dropColumn('health_risk'); }); } catch {}
};
