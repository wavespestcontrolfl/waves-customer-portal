exports.up = async function (knex) {
  const cols = await knex.raw("SELECT column_name FROM information_schema.columns WHERE table_name = 'scheduled_services'");
  const existing = cols.rows.map(r => r.column_name);

  await knex.schema.alterTable('scheduled_services', t => {
    if (!existing.includes('square_booking_id')) t.string('square_booking_id', 100);
    if (!existing.includes('source')) t.string('source', 30).defaultTo('admin');
  });

  if (!existing.includes('square_booking_id')) {
    try { await knex.schema.alterTable('scheduled_services', t => { t.index('square_booking_id'); }); } catch { /* index may exist */ }
  }
};

exports.down = async function (knex) {
  await knex.schema.alterTable('scheduled_services', t => {
    try { t.dropColumn('square_booking_id'); } catch {}
    try { t.dropColumn('source'); } catch {}
  });
};
