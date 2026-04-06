exports.up = async function (knex) {
  const cols = await knex.raw("SELECT column_name FROM information_schema.columns WHERE table_name = 'estimates'");
  const existing = cols.rows.map(r => r.column_name);
  await knex.schema.alterTable('estimates', t => {
    if (!existing.includes('follow_up_count')) t.integer('follow_up_count').defaultTo(0);
    if (!existing.includes('last_follow_up_at')) t.timestamp('last_follow_up_at');
  });
};
exports.down = async function (knex) {
  try { await knex.schema.alterTable('estimates', t => { t.dropColumn('follow_up_count'); t.dropColumn('last_follow_up_at'); }); } catch {}
};
