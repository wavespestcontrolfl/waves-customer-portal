// "Estimate created from lead" history rows written while lead-estimate-link.js
// built the performer from technicians.first_name / last_name, which the table
// does not have: every estimate staff created from a lead read 'system'. The
// estimate keeps who created it (created_by_technician_id), so those rows get
// that person's name back. A contact-match link (metadata.linkedBy) is the
// system's own action and stays 'system', as does a row whose estimate has no
// creator or whose creator has no name.
const REQUIRED_COLUMNS = [
  ['lead_activities', 'activity_type'],
  ['lead_activities', 'description'],
  ['lead_activities', 'performed_by'],
  ['lead_activities', 'metadata'],
  ['estimates', 'created_by_technician_id'],
  ['technicians', 'name'],
];

exports.up = async function up(knex) {
  for (const [table, column] of REQUIRED_COLUMNS) {
    if (!(await knex.schema.hasTable(table))) return;
    if (!(await knex.schema.hasColumn(table, column))) return;
  }
  await knex.raw(`
    UPDATE lead_activities AS la
       SET performed_by = left(btrim(t.name), 100)
      FROM estimates AS e
      JOIN technicians AS t ON t.id = e.created_by_technician_id
     WHERE la.activity_type = 'estimate_created'
       AND la.performed_by = 'system'
       AND la.description LIKE 'Estimate created from lead (%'
       AND la.metadata->>'linkedBy' IS NULL
       AND e.id::text = la.metadata->>'estimateId'
       AND btrim(coalesce(t.name, '')) <> ''
  `);
};

exports.down = async function down() {
  // One-way data repair: 'system' never created these estimates.
};
