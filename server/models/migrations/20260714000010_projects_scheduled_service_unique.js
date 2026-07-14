// One visit, one report (#2717 server hardening follow-up): a partial
// unique index on projects.scheduled_service_id so a double-tap, a stale
// week-row cache, or a two-device race can never mint a second report for
// the same scheduled visit. POST /admin/projects is idempotent regardless
// (it returns the existing linked project); this index is the database
// backstop that makes the race lose deterministically.
//
// Duplicate-safe by design: if the environment already holds duplicate
// links (created by the pre-hardening races this closes), a unique index
// cannot build — so we detect them first, log the offending visit ids
// LOUDLY, and skip index creation instead of failing the deploy (a failed
// migration blocks every Railway deploy). The route-level idempotency
// still protects new creates in that state. After resolving the logged
// duplicates (unlink or delete the stray report), re-create the index via
// a follow-up migration or a manual CREATE UNIQUE INDEX.

const INDEX_NAME = 'projects_scheduled_service_id_unique';

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

  const dupes = (await knex.raw(`
    SELECT scheduled_service_id, COUNT(*) AS n
    FROM projects
    WHERE scheduled_service_id IS NOT NULL
    GROUP BY scheduled_service_id
    HAVING COUNT(*) > 1
  `)).rows || [];
  if (dupes.length) {
     
    console.warn(
      `[migration ${INDEX_NAME}] SKIPPED: ${dupes.length} visit(s) carry duplicate linked projects — `
      + `resolve them, then re-create the index. Visits: `
      + dupes.map((d) => `${d.scheduled_service_id} (x${d.n})`).join(', '),
    );
    return;
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
