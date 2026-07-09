/**
 * Customer-visible estimate numbers (owner ask 2026-07-09).
 *
 * estimates.estimate_slug has existed since 20260401000014 but nothing ever
 * wrote it — the public serializer sends `slug` (estimate-public.js) and the
 * estimate page already renders "Estimate {slug}" above the issued/valid
 * dates, so every estimate shipped without a number. Format mirrors the
 * invoice convention (WPC-2026-NNNN) as EST-YYYY-NNNN: ET-pinned year (the
 * business day frame everywhere else) + one global gapless-enough sequence —
 * the counter does not reset per year, which keeps stamping race-free with
 * no per-year bookkeeping; uniqueness matters, per-year density does not.
 *
 * A BEFORE INSERT trigger (not an app-level helper) because estimates are
 * inserted from six call sites today (lead-webhook, public-quote,
 * lead-intake, admin persistence, IB estimate-tools, lead-response-tools)
 * and a trigger also covers any future path. Explicit estimate_slug values
 * are respected — the trigger only fills NULL.
 *
 * Backfill numbers existing rows in created_at order so already-sent links
 * (live tokens) show a number consistent with their age.
 */

exports.up = async function up(knex) {
  const hasTable = await knex.schema.hasTable('estimates');
  if (!hasTable) return;
  const hasColumn = await knex.schema.hasColumn('estimates', 'estimate_slug');
  if (!hasColumn) return;

  await knex.raw("CREATE SEQUENCE IF NOT EXISTS estimate_slug_seq START 1");

  await knex.raw(`
    CREATE OR REPLACE FUNCTION waves_stamp_estimate_slug()
    RETURNS trigger AS $$
    DECLARE
      seq_val bigint;
    BEGIN
      IF NEW.estimate_slug IS NULL THEN
        seq_val := nextval('estimate_slug_seq');
        NEW.estimate_slug := 'EST-'
          || to_char(COALESCE(NEW.created_at, now()) AT TIME ZONE 'America/New_York', 'YYYY')
          || '-'
          || lpad(seq_val::text, GREATEST(4, length(seq_val::text)), '0');
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);

  await knex.raw(`
    DROP TRIGGER IF EXISTS estimates_stamp_slug ON estimates;
    CREATE TRIGGER estimates_stamp_slug
      BEFORE INSERT ON estimates
      FOR EACH ROW
      EXECUTE FUNCTION waves_stamp_estimate_slug()
  `);

  // Trigger is installed BEFORE the backfill (codex P1): an estimate the
  // still-running old deployment inserts mid-migration gets stamped by the
  // trigger and skipped by the backfill's IS NULL filter — nothing can fall
  // between the two paths. Backfill in created_at order; interleaved
  // sequence values across the two paths stay unique by construction.
  await knex.raw(`
    UPDATE estimates e
    SET estimate_slug = 'EST-'
      || to_char(e.created_at AT TIME ZONE 'America/New_York', 'YYYY')
      || '-'
      || lpad(n.seq::text, GREATEST(4, length(n.seq::text)), '0')
    FROM (
      SELECT id, nextval('estimate_slug_seq') AS seq
      FROM (
        SELECT id FROM estimates
        WHERE estimate_slug IS NULL
        ORDER BY created_at ASC, id ASC
      ) ordered
    ) n
    WHERE e.id = n.id AND e.estimate_slug IS NULL
  `);

  // Re-run safety (codex P1): rollback drops the sequence but keeps stamped
  // slugs, so a recreated sequence would restart at 1 and duplicate numbers
  // customers already saw. Continue from the highest existing EST-* suffix.
  await knex.raw(`
    SELECT setval('estimate_slug_seq', GREATEST(
      (SELECT last_value FROM estimate_slug_seq),
      COALESCE((
        SELECT max((regexp_match(estimate_slug, '^EST-\\d{4}-(\\d+)$'))[1]::bigint)
        FROM estimates
        WHERE estimate_slug ~ '^EST-\\d{4}-\\d+$'
      ), 1)
    ))
  `);

  // Duplicates are a P1 in their own right — make them impossible at the
  // schema level (partial: legacy NULLs stay legal until stamped).
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS estimates_estimate_slug_unique
    ON estimates (estimate_slug)
    WHERE estimate_slug IS NOT NULL
  `);

};

exports.down = async function down(knex) {
  const hasTable = await knex.schema.hasTable('estimates');
  if (!hasTable) return;
  // Stamped numbers are left in place on rollback — they are inert display
  // data, and nulling them would renumber estimates customers already saw.
  await knex.raw('DROP TRIGGER IF EXISTS estimates_stamp_slug ON estimates');
  await knex.raw('DROP FUNCTION IF EXISTS waves_stamp_estimate_slug()');
  await knex.raw('DROP SEQUENCE IF EXISTS estimate_slug_seq');
  await knex.raw('DROP INDEX IF EXISTS estimates_estimate_slug_unique');
};
