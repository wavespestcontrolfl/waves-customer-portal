/**
 * Record the owner-approved post-discount lawn margin guard.
 *
 * The 2026-06-17 reprice made 35% the recurring lawn list-price margin floor,
 * while intentionally allowing WaveGuard discounts below that floor. The
 * Agent Estimate accuracy boundary supersedes that policy: new quotes now cap
 * the lawn discount at the greater of the $600 annual program minimum and the
 * line's computed minimum collected annual price.
 */

const CHANGELOG_IDENTITY = {
  version_from: 'v4.6',
  version_to: 'v4.6',
  changed_by: 'codex-2026-07-16',
  category: 'rule',
  summary: 'Keep recurring lawn at the 35% collected-margin floor after WaveGuard discounts.',
};

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('pricing_changelog'))) return;

  const existing = await knex('pricing_changelog').where(CHANGELOG_IDENTITY).first('id');
  if (existing) return;

  await knex('pricing_changelog').insert({
    ...CHANGELOG_IDENTITY,
    affected_services: JSON.stringify(['lawn_care', 'waveguard_bundle_totals']),
    before_value: JSON.stringify({
      post_discount_floor: '600 annual program minimum only',
      margin_policy: '35% fully loaded margin shaped list price but could be discounted below',
    }),
    after_value: JSON.stringify({
      post_discount_floor: 'max(600 annual program minimum, minimumCollectedAnnualPrice)',
      margin_policy: '35% fully loaded collected margin survives WaveGuard discounts',
    }),
    rationale: 'Owner-approved Agent Estimate accuracy boundary, 2026-07-16: a deterministic quote must not trade below the recurring lawn 35% fully loaded collected-margin target. WaveGuard still discounts lawn when room exists, but the discount caps at the engine-computed minimum collected annual price (or the $600 program minimum when higher). Existing accepted services are not repriced.',
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('pricing_changelog'))) return;
  await knex('pricing_changelog').where(CHANGELOG_IDENTITY).del();
};
