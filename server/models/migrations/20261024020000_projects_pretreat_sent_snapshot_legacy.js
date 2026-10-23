// Backfill the pre-treat as-sent copy for certificates sent before sent_at
// existed (pre-push P1 on 20261024010000): a migrated historical delivery
// ('legacy_sent', migration 20260511000001) or a row whose status is 'sent'
// has no sent_at, so the first backfill skipped it. Same rule: the current
// findings become the copy, marked backfilled. A copy a send wrote is kept.
function findingsObject(value) {
  let parsed = value;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch { parsed = {}; }
  }
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

exports.up = async function up(knex) {
  if (!await knex.schema.hasColumn('projects', 'pretreat_sent_snapshot')) return;
  const rows = await knex('projects')
    .where({ project_type: 'pre_treatment_termite_certificate' })
    .whereNull('pretreat_sent_snapshot')
    .where((builder) => builder.where('status', 'sent').orWhere('delivery_status', 'legacy_sent'))
    .select('id', 'findings', knex.raw("to_char(project_date, 'YYYY-MM-DD') as day"), 'sent_at');
  for (const row of rows) {
    await knex('projects').where({ id: row.id }).whereNull('pretreat_sent_snapshot').update({
      pretreat_sent_snapshot: JSON.stringify({
        findings: findingsObject(row.findings),
        project_date: row.day || null,
        sent_at: row.sent_at ? new Date(row.sent_at).toISOString() : null,
        backfilled: true,
      }),
    });
  }
};

// The rows it fills are not marked apart from the first backfill's, and a
// filled copy is the safe state, so rollback leaves them.
exports.down = async function down() {};
