// One visit, one report (#2717 server hardening follow-up): a partial
// unique index on projects.scheduled_service_id so a double-tap, a stale
// week-row cache, or a two-device race can never mint a second report for
// the same scheduled visit. POST /admin/projects refuses duplicates with a
// 409 regardless; this index is the database backstop that makes the race
// lose deterministically.
//
// Legacy duplicates (created by the pre-hardening races this closes) are
// SELF-HEALED, not skipped — a skipped index would leave the race open for
// every other visit while knex marks the migration applied (Codex P1 on
// #2732). For each visit with multiple linked projects, exactly one keeps
// the link: the most-progressed report first (closed > sent > draft — the
// operative compliance document), oldest created_at as the tie-break. The
// others have both visit-link columns cleared — no report content is deleted;
// they remain intact and visible on the Jobs page as unlinked projects — and
// every unlink is logged loudly for operator review. Clearing service_record_id
// matters because that record's scheduled_service_id is also treated as an
// authoritative visit link by report lookup and invoice generation.

const INDEX_NAME = 'projects_scheduled_service_id_unique';

// Matches the keeper-preference used by POST /admin/projects' duplicate
// lookup so the migration and the route agree on which row is canonical.
const STATUS_RANK_SQL = "CASE status WHEN 'closed' THEN 0 WHEN 'sent' THEN 1 ELSE 2 END";

async function normalizeAndDedupeProjectVisitLinks(knex, { hasRecordLink }) {
  // The service record is authoritative for report billing. Normalize both
  // record-only rows and legacy non-null mismatches BEFORE ranking, while the
  // unique index is still absent. Otherwise a mismatched row can win the wrong
  // direct-id partition and cause the true report for that visit to lose its
  // service_record_id permanently.
  if (hasRecordLink) {
    const normalized = await knex.raw(`
      WITH authoritative_links AS (
        SELECT p.id,
               p.scheduled_service_id AS prior_visit,
               sr.scheduled_service_id AS authoritative_visit
        FROM projects p
        JOIN service_records sr ON sr.id = p.service_record_id
        WHERE sr.scheduled_service_id IS NOT NULL
          AND p.scheduled_service_id IS DISTINCT FROM sr.scheduled_service_id
      )
      UPDATE projects p
      SET scheduled_service_id = a.authoritative_visit,
          updated_at = NOW()
      FROM authoritative_links a
      WHERE p.id = a.id
      RETURNING p.id, a.prior_visit, a.authoritative_visit
    `);
    const normalizedRows = normalized.rows || [];
    if (normalizedRows.length) {
      console.warn(
        `[migration ${INDEX_NAME}] normalized ${normalizedRows.length} service-record-authoritative visit link(s): `
        + normalizedRows.map((row) => (
          `${row.id} (${row.prior_visit || 'none'} -> ${row.authoritative_visit})`
        )).join(', '),
      );
    }
  }

  // Deterministic dedup: rank every normalized linked row per visit, clear
  // both possible visit links on everything after the keeper. RETURNING gives
  // the loud audit trail.
  const unlinkAssignments = hasRecordLink
    ? 'scheduled_service_id = NULL, service_record_id = NULL, updated_at = NOW()'
    : 'scheduled_service_id = NULL, updated_at = NOW()';
  const unlinked = await knex.raw(`
    WITH ranked AS (
      SELECT id,
             scheduled_service_id,
             ROW_NUMBER() OVER (
               PARTITION BY scheduled_service_id
               ORDER BY ${STATUS_RANK_SQL}, created_at ASC, id ASC
             ) AS rn
      FROM projects
      WHERE scheduled_service_id IS NOT NULL
    )
    UPDATE projects p
    SET ${unlinkAssignments}
    FROM ranked r
    WHERE p.id = r.id AND r.rn > 1
    RETURNING p.id, r.scheduled_service_id AS was_linked_to
  `);
  const rows = unlinked.rows || [];
  if (rows.length) {
    console.warn(
      `[migration ${INDEX_NAME}] self-healed ${rows.length} duplicate link(s) before indexing — `
      + 'the strongest report kept each visit link; these projects were UNLINKED (content untouched): '
      + rows.map((r) => `${r.id} (was -> ${r.was_linked_to})`).join(', '),
    );
  }
}

exports.up = async function up(knex) {
  const hasTable = await knex.schema.hasTable('projects');
  if (!hasTable) return;
  const hasColumn = await knex.schema.hasColumn('projects', 'scheduled_service_id');
  if (!hasColumn) return;

  const indexCheck = await knex.raw(
    'SELECT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = ?) AS present',
    [INDEX_NAME],
  );
  if (indexCheck.rows?.[0]?.present) return;

  const hasRecordLink = await knex.schema.hasColumn('projects', 'service_record_id')
    && await knex.schema.hasTable('service_records')
    && await knex.schema.hasColumn('service_records', 'scheduled_service_id');
  await normalizeAndDedupeProjectVisitLinks(knex, { hasRecordLink });

  await knex.raw(
    `CREATE UNIQUE INDEX ${INDEX_NAME} ON projects (scheduled_service_id) WHERE scheduled_service_id IS NOT NULL`,
  );
};

exports.down = async function down(knex) {
  const hasTable = await knex.schema.hasTable('projects');
  if (!hasTable) return;
  await knex.raw(`DROP INDEX IF EXISTS ${INDEX_NAME}`);
};

exports._normalizeAndDedupeProjectVisitLinks = normalizeAndDedupeProjectVisitLinks;
