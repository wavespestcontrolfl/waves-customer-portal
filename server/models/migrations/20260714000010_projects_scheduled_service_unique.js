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
// others have ONLY their scheduled_service_id cleared — no report content
// is deleted; they remain intact and visible on the Jobs page as unlinked
// projects — and every unlink is logged loudly for operator review.

const INDEX_NAME = 'projects_scheduled_service_id_unique';

// Matches the keeper-preference used by POST /admin/projects' duplicate
// lookup so the migration and the route agree on which row is canonical.
const STATUS_RANK_SQL = "CASE status WHEN 'closed' THEN 0 WHEN 'sent' THEN 1 ELSE 2 END";

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

  // Deterministic dedup: rank every linked row per visit, clear the link on
  // everything after the keeper. RETURNING gives the loud audit trail.
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
    SET scheduled_service_id = NULL, updated_at = NOW()
    FROM ranked r
    WHERE p.id = r.id AND r.rn > 1
    RETURNING p.id, r.scheduled_service_id AS was_linked_to
  `);
  const rows = unlinked.rows || [];
  if (rows.length) {
     
    console.warn(
      `[migration ${INDEX_NAME}] self-healed ${rows.length} duplicate link(s) before indexing — `
      + 'the strongest report kept each visit link; these projects were UNLINKED (content untouched): '
      + rows.map((r) => `${r.id} (was → ${r.was_linked_to})`).join(', '),
    );
  }

  await knex.raw(
    `CREATE UNIQUE INDEX ${INDEX_NAME} ON projects (scheduled_service_id) WHERE scheduled_service_id IS NOT NULL`,
  );
};

exports.down = async function down(knex) {
  const hasTable = await knex.schema.hasTable('projects');
  if (!hasTable) return;
  await knex.raw(`DROP INDEX IF EXISTS ${INDEX_NAME}`);
};
