/**
 * Record the annual-plan price schedule seeded by 20260911000020 in the
 * Pricing Logic Changelog. This follows the already-applied seed migration;
 * rerunning it must not rewrite an admin-authored pricing row.
 */
// Read-only reference to the earlier seed's audit row. This migration owns
// only its own changelog identity below; it never writes under the seed tag.
const SEED_MIGRATION = '20260911000020';
const SEED_TAG = `migration:${SEED_MIGRATION}`;
const KEY = 'termite_annual_plan';
const CHANGELOG_IDENTITY = {
  version_from: 'v4.9',
  version_to: 'v4.9',
  changed_by: 'migration:20260914000001',
  category: 'rule',
  summary: 'Introduce the gated termite annual protection pricing schedule.',
};

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('pricing_changelog'))
    || !(await knex.schema.hasTable('pricing_config_audit'))) return;
  const seedAudit = await knex('pricing_config_audit')
    .where({ config_key: KEY, changed_by: SEED_TAG }).whereNull('old_value').first();
  if (!seedAudit) return; // The plan row existed before our seed; no price change to record.
  const existing = await knex('pricing_changelog').where(CHANGELOG_IDENTITY).first('id');
  if (existing) return;
  await knex('pricing_changelog').insert({
    ...CHANGELOG_IDENTITY,
    affected_services: JSON.stringify(['termite_bait']),
    before_value: null,
    after_value: seedAudit.new_value,
    rationale: 'Owner-approved P1 schedule: $30 per bait station setup, plus $249 annual base and $50 per five-station bracket above ten. The annual selection remains dark behind GATE_TERMITE_ANNUAL_PLAN pending agreement sign-off; this records the seed that introduced the schedule.',
  });
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('pricing_changelog')) {
    await knex('pricing_changelog').where(CHANGELOG_IDENTITY).del();
  }
};
