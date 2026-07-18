// Scrub legacy inspection-fee disclosures from WDO project narratives AT
// REST. The #2817 write/egress guards protect every enumerated reader
// (create/PUT, public /data, assistant, PDF, completion copy, service
// history), but rows written before those guards still hold the fee in
// projects.recommendations — this one-time pass cleans the stored text so
// unenumerated readers and future exports don't depend on request-time
// redaction. Two passes per row, both from @waves/report-redaction so
// at-rest text and served text agree:
//   1. cue-based (the literal "inspection fee" phrase), and
//   2. VALUE-based — legacy AI output can paraphrase the structured fee
//      ("the quoted $250 charge") without the literal cue, so the amounts
//      the project actually recorded (findings.inspection_fee + archived
//      filing snapshots) are scrubbed wherever they appear (codex #2817).
//
// Idempotent: a re-run finds no remaining cues or values. Plain UPDATEs —
// fires ZERO customer communications. Per-field CAS: a concurrent edit
// during the deploy window is skipped, and the new instance's write guard
// scrubs every subsequent save. Down is a no-op — the redaction is
// deliberate data hygiene, not reversible.
const {
  redactInspectionFeeCues,
  containsInspectionFeeCue,
  redactSpecificAmounts,
} = require('@waves/report-redaction');
const {
  PROJECT_TYPE_KEYS,
  projectTypeHasInternalFindingKeys,
  projectRecordedFeeValues,
  PROJECT_TITLE_MAX_LENGTH,
} = require('../../services/project-types');

function parseMaybeJson(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
}

function scrubText(value, feeValues) {
  let scrubbed = value;
  if (containsInspectionFeeCue(scrubbed)) scrubbed = redactInspectionFeeCues(scrubbed);
  if (feeValues.length) scrubbed = redactSpecificAmounts(scrubbed, feeValues);
  return scrubbed;
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('projects'))) return;
  // Only types whose form carries the internal fee field (today: WDO) —
  // "inspection fee" prose on any other project type is a legitimate
  // customer disclosure and must not be touched (codex #2817 P1).
  const feeTypes = PROJECT_TYPE_KEYS.filter(projectTypeHasInternalFindingKeys);
  if (!feeTypes.length) return;

  const hasFilings = await knex.schema.hasColumn('projects', 'wdo_sent_filings');
  const rows = await knex('projects')
    .whereIn('project_type', feeTypes)
    .select(['id', 'recommendations', 'title', 'findings'].concat(hasFilings ? ['wdo_sent_filings'] : []));

  // id → recorded fee values, reused by the snapshot pass below.
  const feeValuesByProject = new Map();
  for (const row of rows) feeValuesByProject.set(row.id, projectRecordedFeeValues(row));

  for (const row of rows) {
    const feeValues = feeValuesByProject.get(row.id) || [];
    for (const field of ['recommendations', 'title']) {
      const value = row[field];
      if (!value) continue;
      let scrubbed = scrubText(value, feeValues);
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

  await scrubNoteSnapshots(knex, feeTypes, feeValuesByProject);
};

// The completion flow COPIED fee-type narratives into
// service_records.technician_notes, and invoice creation snapshots those
// notes again into invoices.tech_notes — served on an UNAUTHENTICATED
// invoice token (pay-v2). Clean both snapshot columns at rest with the same
// two passes and CAS pattern; the type gate and project linkage ride on the
// service record's structured_notes (codex #2817).
async function scrubNoteSnapshots(knex, feeTypes, feeValuesByProject) {
  if (!(await knex.schema.hasTable('service_records'))) return;
  const hasStructured = await knex.schema.hasColumn('service_records', 'structured_notes');
  if (!hasStructured) return;

  const valuesFor = (structuredNotes) => {
    const parsed = parseMaybeJson(structuredNotes);
    return (parsed?.projectId && feeValuesByProject.get(parsed.projectId)) || [];
  };

  const srRows = await knex('service_records')
    .whereNotNull('technician_notes')
    .whereIn(knex.raw("structured_notes->>'projectType'"), feeTypes)
    .select('id', 'technician_notes', 'structured_notes');
  for (const row of srRows) {
    const scrubbed = scrubText(row.technician_notes, valuesFor(row.structured_notes));
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
    .select('invoices.id as id', 'invoices.tech_notes as tech_notes', 'service_records.structured_notes as structured_notes');
  for (const row of invRows) {
    const scrubbed = scrubText(row.tech_notes, valuesFor(row.structured_notes));
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
