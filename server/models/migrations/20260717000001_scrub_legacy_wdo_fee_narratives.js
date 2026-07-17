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
const {
  PROJECT_TYPE_KEYS,
  projectTypeHasInternalFindingKeys,
  PROJECT_TITLE_MAX_LENGTH,
} = require('../../services/project-types');

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
    // Per-field compare-and-swap: Railway runs this in preDeployCommand
    // while the OLD instance still serves traffic, so an admin edit can land
    // between the bulk SELECT and this row. The CAS predicate makes such a
    // row a no-op here instead of clobbering the edit — and that's safe to
    // skip entirely, because the new instance's write guard scrubs every
    // subsequent save (and the old instance's window closes with the deploy;
    // any text it wrote that still carries a cue is covered by the egress
    // guards until the row is next saved).
    for (const field of ['recommendations', 'title']) {
      const value = row[field];
      if (!value || !containsInspectionFeeCue(value)) continue;
      let scrubbed = redactInspectionFeeCues(value);
      // the marker is longer than a short amount ("$1" → "[fee removed]"),
      // and projects.title is varchar(200) — clamp so a near-limit title
      // can't abort the migration on the column constraint
      if (field === 'title') scrubbed = scrubbed.slice(0, PROJECT_TITLE_MAX_LENGTH);
      if (scrubbed === value) continue;
      await knex('projects')
        .where({ id: row.id })
        .where(field, value)
        .update({ [field]: scrubbed, updated_at: knex.fn.now() });
    }
  }

  await scrubNoteSnapshots(knex, feeTypes);
};

// The completion flow COPIED fee-type narratives into
// service_records.technician_notes, and invoice creation snapshots those
// notes again into invoices.tech_notes — served on an UNAUTHENTICATED
// invoice token (pay-v2). Clean both snapshot columns at rest with the same
// CAS pattern; the type gate rides on the service record's
// structured_notes.projectType (codex #2817).
async function scrubNoteSnapshots(knex, feeTypes) {
  if (!(await knex.schema.hasTable('service_records'))) return;
  const hasStructured = await knex.schema.hasColumn('service_records', 'structured_notes');
  if (!hasStructured) return;

  const srRows = await knex('service_records')
    .whereNotNull('technician_notes')
    .whereIn(knex.raw("structured_notes->>'projectType'"), feeTypes)
    .select('id', 'technician_notes');
  for (const row of srRows) {
    if (!containsInspectionFeeCue(row.technician_notes)) continue;
    const scrubbed = redactInspectionFeeCues(row.technician_notes);
    if (scrubbed === row.technician_notes) continue;
    await knex('service_records')
      .where({ id: row.id })
      .where('technician_notes', row.technician_notes)
      .update({ technician_notes: scrubbed });
  }

  if (!(await knex.schema.hasTable('invoices'))) return;
  const hasTechNotes = await knex.schema.hasColumn('invoices', 'tech_notes');
  if (!hasTechNotes) return;
  const invRows = await knex('invoices')
    .join('service_records', 'invoices.service_record_id', 'service_records.id')
    .whereNotNull('invoices.tech_notes')
    .whereIn(knex.raw("service_records.structured_notes->>'projectType'"), feeTypes)
    .select('invoices.id as id', 'invoices.tech_notes as tech_notes');
  for (const row of invRows) {
    if (!containsInspectionFeeCue(row.tech_notes)) continue;
    const scrubbed = redactInspectionFeeCues(row.tech_notes);
    if (scrubbed === row.tech_notes) continue;
    await knex('invoices')
      .where({ id: row.id })
      .where('tech_notes', row.tech_notes)
      .update({ tech_notes: scrubbed });
  }
}

exports.down = async function down() {
  // Deliberate no-op: removing an internal fee from customer-facing text is
  // one-way data hygiene.
};
