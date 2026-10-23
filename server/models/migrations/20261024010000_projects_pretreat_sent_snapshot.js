// projects.pretreat_sent_snapshot — the pre-treat certificate as it went out
// (owner 2026-10-23 option A on #6515). Each delivered send overwrites it
// with that send's findings and treatment date; the new construction
// warranty is built from it, never from edits made after the send.
//
// A certificate sent before this column existed gets its current findings as
// the copy (marked `backfilled`), the best record there is of what was sent.
// No warranty had been issued yet when this shipped.
function findingsObject(value) {
  let parsed = value;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch { parsed = {}; }
  }
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

exports.up = async function up(knex) {
  const has = await knex.schema.hasColumn('projects', 'pretreat_sent_snapshot');
  if (!has) {
    await knex.schema.alterTable('projects', (t) => {
      t.jsonb('pretreat_sent_snapshot').nullable();
    });
  }
  // findings is jsonb, but an older row may hold a JSON string inside it (the
  // route's normalizeFindings reads both), so each row is parsed in JS.
  const rows = await knex('projects')
    .where({ project_type: 'pre_treatment_termite_certificate' })
    .whereNotNull('sent_at')
    .whereNull('pretreat_sent_snapshot')
    .select('id', 'findings', knex.raw("to_char(project_date, 'YYYY-MM-DD') as day"), 'sent_at');
  for (const row of rows) {
    await knex('projects').where({ id: row.id }).whereNull('pretreat_sent_snapshot').update({
      pretreat_sent_snapshot: JSON.stringify({
        findings: findingsObject(row.findings),
        project_date: row.day || null,
        sent_at: new Date(row.sent_at).toISOString(),
        backfilled: true,
      }),
    });
  }
};

exports.down = async function down(knex) {
  const has = await knex.schema.hasColumn('projects', 'pretreat_sent_snapshot');
  if (has) {
    await knex.schema.alterTable('projects', (t) => {
      t.dropColumn('pretreat_sent_snapshot');
    });
  }
};
