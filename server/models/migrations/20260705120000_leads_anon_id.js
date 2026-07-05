/**
 * leads → anon_id (experimentation initiative, Phase 3 — marketing site).
 *
 * The Astro marketing site's client-side GrowthBook SDK assigns anonymous
 * visitors an experiment unit id (localStorage `waves_exp_uid`) and logs
 * assignments into experiment_exposures (unit_type 'anon') via
 * POST /api/public/experiments/exposure. The same id now rides lead
 * submissions as `attribution.anon_id`, and this column is where it lands —
 * making "lead submitted" a joinable conversion metric for marketing
 * experiments (experiment_exposures.unit_id = leads.anon_id).
 *
 * A first-class column (not extracted_data jsonb) for the same reason
 * gclid/fbclid/fbc/fbp are columns: the webhook lane's AI triage REPLACES
 * extracted_data wholesale on fresh form leads, so anything jsonb-only is
 * clobbered minutes after insert. 190 matches the exposure route's
 * UNIT_ID_RE upper bound. Partial index because the overwhelming bulk of
 * historical leads carry NULL — GrowthBook's metric query filters
 * `anon_id IS NOT NULL`.
 */
exports.up = async function (knex) {
  const cols = await knex('leads').columnInfo();
  if (!cols.anon_id) {
    await knex.schema.alterTable('leads', (t) => {
      t.string('anon_id', 190);
    });
  }
  await knex.raw(
    'CREATE INDEX IF NOT EXISTS leads_anon_id_idx ON leads (anon_id) WHERE anon_id IS NOT NULL'
  );
};

exports.down = async function (knex) {
  await knex.raw('DROP INDEX IF EXISTS leads_anon_id_idx');
  const cols = await knex('leads').columnInfo();
  if (cols.anon_id) {
    await knex.schema.alterTable('leads', (t) => {
      t.dropColumn('anon_id');
    });
  }
};
