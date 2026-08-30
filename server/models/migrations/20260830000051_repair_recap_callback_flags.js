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
 * marker in field_flags plus the frozen service_type naming a re-service.
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
  // whose OWN frozen service_type names a re-service — both stamped at
  // record creation, so the repair rests on creation-time evidence alone.
  // The scheduled row's CURRENT is_callback is deliberately not consulted:
  // update-details can repoint a visit after the fact in either direction,
  // and this migration must never rewrite what was true at completion
  // (codex GH-r3 P2 + local r8 P1). The name regex is the same safety net
  // re-service.js uses (\bre-?service\b, case-insensitive).
  const hasFieldFlags = await knex.schema.hasColumn('service_records', 'field_flags');
  if (!hasFieldFlags) {
    console.log('[migration] field_flags column missing — no recap-created rows to repair');
    return;
  }
  const repaired = await knex('service_records')
    .whereRaw("(field_flags ->> 'recap') = 'true'")
    .whereRaw("service_type ~* '\\mre-?service\\M'")
    .where(function notTrue() {
      this.where('is_callback', false).orWhereNull('is_callback');
    })
    .update({ is_callback: true, updated_at: knex.fn.now() });
  console.log(`[migration] repaired is_callback on ${repaired} recap-created service_records row(s) from their scheduled rows`);
};

exports.down = async function down() {
  // No-op by design: the repaired flag is the authoritative value.
};
