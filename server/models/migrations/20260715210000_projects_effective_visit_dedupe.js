/**
 * Finish the one-visit/one-report repair for databases that already ran
 * 20260714000010 before its duplicate unlink cleared service_record_id.
 *
 * A project can identify its visit either directly through
 * projects.scheduled_service_id or indirectly through
 * projects.service_record_id -> service_records.scheduled_service_id. The
 * latter is authoritative in report billing, so clearing only the direct link
 * leaves the duplicate report attached to the same visit.
 *
 * This data repair keeps the strongest report for each effective visit and
 * clears both link columns on every loser. It then restores the direct visit
 * column for any surviving record-only project so the existing partial unique
 * index remains the cross-request database fence.
 */

const STATUS_RANK_SQL = "CASE p.status WHEN 'closed' THEN 0 WHEN 'sent' THEN 1 ELSE 2 END";

exports.up = async function up(knex) {
  const hasProjects = await knex.schema.hasTable('projects');
  const hasServiceRecords = await knex.schema.hasTable('service_records');
  if (!hasProjects || !hasServiceRecords) return;

  const hasProjectVisit = await knex.schema.hasColumn('projects', 'scheduled_service_id');
  const hasProjectRecord = await knex.schema.hasColumn('projects', 'service_record_id');
  const hasRecordVisit = await knex.schema.hasColumn('service_records', 'scheduled_service_id');
  if (!hasProjectVisit || !hasProjectRecord || !hasRecordVisit) return;

  await knex.transaction(async (trx) => {
    // Older create paths accepted these ids independently. The service record
    // is authoritative for report billing, so release any conflicting direct
    // id before ranking. Otherwise a record-only project for that direct id
    // can survive in a separate partition and normalization can collide with
    // the existing unique index.
    const mismatches = await trx.raw(`
      WITH mismatched_links AS (
        SELECT p.id,
               p.scheduled_service_id AS released_visit,
               sr.scheduled_service_id AS authoritative_visit
        FROM projects p
        JOIN service_records sr ON sr.id = p.service_record_id
        WHERE p.scheduled_service_id IS NOT NULL
          AND sr.scheduled_service_id IS NOT NULL
          AND p.scheduled_service_id <> sr.scheduled_service_id
      )
      UPDATE projects p
      SET scheduled_service_id = NULL,
          updated_at = NOW()
      FROM mismatched_links m
      WHERE p.id = m.id
      RETURNING p.id,
                m.released_visit,
                m.authoritative_visit
    `);

    const mismatchRows = mismatches.rows || [];
    if (mismatchRows.length) {
      console.warn(
        '[migration projects_effective_visit_dedupe] released '
        + `${mismatchRows.length} mismatched direct visit link(s) before dedupe: `
        + mismatchRows.map((row) => (
          `${row.id} (${row.released_visit} -> ${row.authoritative_visit})`
        )).join(', '),
      );
    }

    const unlinked = await trx.raw(`
      WITH effective_links AS (
        SELECT p.id,
               COALESCE(sr.scheduled_service_id, p.scheduled_service_id) AS effective_visit_id,
               ROW_NUMBER() OVER (
                 PARTITION BY COALESCE(sr.scheduled_service_id, p.scheduled_service_id)
                 ORDER BY ${STATUS_RANK_SQL}, p.created_at ASC, p.id ASC
               ) AS rn
        FROM projects p
        LEFT JOIN service_records sr ON sr.id = p.service_record_id
        WHERE COALESCE(sr.scheduled_service_id, p.scheduled_service_id) IS NOT NULL
      )
      UPDATE projects p
      SET scheduled_service_id = NULL,
          service_record_id = NULL,
          updated_at = NOW()
      FROM effective_links e
      WHERE p.id = e.id AND e.rn > 1
      RETURNING p.id, e.effective_visit_id AS was_linked_to
    `);

    const rows = unlinked.rows || [];
    if (rows.length) {
      console.warn(
        '[migration projects_effective_visit_dedupe] self-healed '
        + `${rows.length} effective visit duplicate(s); cleared both project visit links: `
        + rows.map((row) => `${row.id} (was -> ${row.was_linked_to})`).join(', '),
      );
    }

    const normalized = await trx.raw(`
      UPDATE projects p
      SET scheduled_service_id = sr.scheduled_service_id,
          updated_at = NOW()
      FROM service_records sr
      WHERE p.service_record_id = sr.id
        AND p.scheduled_service_id IS NULL
        AND sr.scheduled_service_id IS NOT NULL
      RETURNING p.id, sr.scheduled_service_id AS adopted_visit
    `);

    const normalizedRows = normalized.rows || [];
    if (normalizedRows.length) {
      console.warn(
        '[migration projects_effective_visit_dedupe] restored the direct visit fence on '
        + `${normalizedRows.length} record-linked project(s): `
        + normalizedRows.map((row) => `${row.id} (-> ${row.adopted_visit})`).join(', '),
      );
    }
  });
};

// The removed links were ambiguous legacy duplicates and cannot be restored
// safely. Rolling back code leaves the repaired data in its safer state.
exports.down = async function down() {};
