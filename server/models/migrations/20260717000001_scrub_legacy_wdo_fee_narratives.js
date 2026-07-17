// Scrub legacy inspection-fee disclosures from WDO project narratives AT
// REST. The #2817 write/egress guards protect every enumerated reader
// (create/PUT, public /data, assistant, PDF, completion copy, service
// history), but rows written before those guards still hold the fee in
// projects.recommendations — this one-time pass cleans the stored text so
// unenumerated readers and future exports don't depend on request-time
// redaction. Uses the same shared redactor as every boundary
// (@waves/report-redaction), so at-rest text and served text agree.
//
// Idempotent: a re-run finds no remaining cues. Plain UPDATEs — fires ZERO
// customer communications. No CAS/retry needed (unlike the retired
// value-based 20260716150000 design): any concurrent edit is scrubbed by
// the write guard itself. Down is a no-op — the redaction is deliberate
// data hygiene, not reversible.
const { redactInspectionFeeCues, containsInspectionFeeCue } = require('@waves/report-redaction');
const { PROJECT_TYPE_KEYS, projectTypeHasInternalFindingKeys } = require('../../services/project-types');

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('projects'))) return;
  // Only types whose form carries the internal fee field (today: WDO) —
  // "inspection fee" prose on any other project type is a legitimate
  // customer disclosure and must not be touched (codex #2817 P1).
  const feeTypes = PROJECT_TYPE_KEYS.filter(projectTypeHasInternalFindingKeys);
  if (!feeTypes.length) return;

  const rows = await knex('projects')
    .whereIn('project_type', feeTypes)
    .select('id', 'recommendations', 'title');

  for (const row of rows) {
    const updates = {};
    for (const field of ['recommendations', 'title']) {
      const value = row[field];
      if (!value || !containsInspectionFeeCue(value)) continue;
      const scrubbed = redactInspectionFeeCues(value);
      if (scrubbed !== value) updates[field] = scrubbed;
    }
    if (!Object.keys(updates).length) continue;
    await knex('projects')
      .where({ id: row.id })
      .update({ ...updates, updated_at: knex.fn.now() });
  }
};

exports.down = async function down() {
  // Deliberate no-op: removing an internal fee from customer-facing text is
  // one-way data hygiene.
};
