/**
 * Repair service_records.is_callback for rows the pest-recap path created:
 * that insert omitted the field until #3617, and the column defaults to
 * FALSE — so a real callback completed through the recap reads as
 * non-callback forever, and the callback report block (which requires
 * is_callback === true) never renders for it. The June backfill
 * (20260618000002) predates the July recap path and cannot have repaired
 * these rows.
 *
 * Source of truth: the linked scheduled_services row's is_callback — the
 * flag the scheduler stamps from the catalog. Only false/NULL records
 * linked to an authoritative TRUE visit are promoted; nothing is ever
 * demoted (an operator-set true record stays true).
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
  const repaired = await knex('service_records')
    .whereIn('scheduled_service_id', knex('scheduled_services').select('id').where({ is_callback: true }))
    .where(function notTrue() {
      this.where('is_callback', false).orWhereNull('is_callback');
    })
    .update({ is_callback: true, updated_at: knex.fn.now() });
  console.log(`[migration] repaired is_callback on ${repaired} service_records row(s) from their scheduled rows`);
};

exports.down = async function down() {
  // No-op by design: the repaired flag is the authoritative value.
};
