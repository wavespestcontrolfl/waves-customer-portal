/**
 * Repair service_records.is_callback for rows the pest-recap path created:
 * that insert omitted the field until #3617, and the column defaults to
 * FALSE — so a real callback completed through the recap reads as
 * non-callback forever, and the callback report block (which requires
 * is_callback === true) never renders for it. The June backfill
 * (20260618000002) predates the July recap path and cannot have repaired
 * these rows.
 *
 * Source of truth: the record's OWN creation-time evidence — the recap
 * marker in field_flags plus the FROZEN catalog identity
 * (service_data.completedServiceKey ∈ pest_re_service/lawn_re_service).
 * Only false/NULL records are promoted; nothing is ever demoted.
 *
 * down(): intentionally a no-op — the repaired value IS the authoritative
 * value; reverting would reintroduce the defect.
 */
exports.up = async function up(knex) {
  const hasRecordFlag = await knex.schema.hasColumn('service_records', 'is_callback');
  const hasVisitFlag = await knex.schema.hasColumn('scheduled_services', 'is_callback');
  if (!hasRecordFlag || !hasVisitFlag) {
    console.log('[migration] is_callback column missing — nothing to repair');
    return;
  }
  // Scope: ONLY rows the recap path created (field_flags.recap = true)
  // whose FROZEN catalog identity is a re-service key — service_data.
  // completedServiceKey is stamped at record creation from the completion
  // profile, so the repair rests on durable creation-time evidence: not the
  // scheduled row's CURRENT is_callback (update-details can repoint a visit
  // after the fact — codex GH-r3 P2) and not the editable display name
  // (a "Re-Service" name can belong to a non-callback — codex r9 P1).
  // Recap rows whose identity freeze transiently failed carry no key and
  // are deliberately left alone (fail closed).
  const hasFieldFlags = await knex.schema.hasColumn('service_records', 'field_flags');
  if (!hasFieldFlags) {
    console.log('[migration] field_flags column missing — no recap-created rows to repair');
    return;
  }
  const repaired = await knex('service_records')
    .whereRaw("(field_flags ->> 'recap') = 'true'")
    .whereRaw("(service_data ->> 'completedServiceKey') in ('pest_re_service', 'lawn_re_service')")
    .where(function notTrue() {
      this.where('is_callback', false).orWhereNull('is_callback');
    })
    .update({ is_callback: true, updated_at: knex.fn.now() });
  console.log(`[migration] repaired is_callback on ${repaired} recap-created service_records row(s) from their scheduled rows`);
};

exports.down = async function down() {
  // No-op by design: the repaired flag is the authoritative value.
};
