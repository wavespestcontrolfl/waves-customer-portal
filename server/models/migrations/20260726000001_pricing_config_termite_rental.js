/**
 * Seed pricing_config.termite_rental — the amortization horizon behind the
 * termite bait station RENTAL option (owner 2026-07-26).
 *
 * Rental is the Massey/Sentricon-shaped alternative to outright purchase:
 * the customer pays $0 to install, Waves retains ownership of the in-ground
 * stations, and the install price they did not pay is recovered as a fixed
 * per-application uplift on the same quarterly station check.
 *
 * `recovery_quarters` sizes that uplift (uplift = install price / quarters);
 * it is NOT a term after which the charge stops — the uplift is permanent
 * for the life of the agreement (owner ruling: it is a rental fee, not a
 * payment plan). At the seeded 20 quarters, a rental customer reaches parity
 * with outright purchase at the 5-year mark:
 *
 *   18-station Advance home, install $500, monitoring $105/quarter
 *     own  @ 5yr = $500 + 20 x $105          = $2,600
 *     rent @ 5yr = 20 x ($105 + $25 uplift)  = $2,600
 *
 * Pricing is DB-authoritative — db-bridge.syncConstantsFromDB loads this row
 * over TERMITE.rental.recoveryQuarters in constants.js, so the constant is
 * inert in any env carrying the row.
 *
 * Insert-if-absent: an existing row (admin-edited or re-run) is never
 * overwritten.
 */

const CONFIG_KEY = 'termite_rental';
const MIGRATION_TAG = 'migration:20260726000001';
const UP_REASON = 'Seed termite station rental amortization horizon (owner 2026-07-26)';
const SEED_DATA = { recovery_quarters: 20 };
const CHANGELOG_IDENTITY = {
  version_from: 'v4.3',
  version_to: 'v4.3',
  changed_by: 'claude-2026-07-26',
  category: 'rule',
  summary: 'Add termite bait station rental option (amortized hardware recovery).',
};

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('pricing_config'))) return;
  const existing = await knex('pricing_config').where({ config_key: CONFIG_KEY }).first('id');
  if (existing) return;

  await knex('pricing_config').insert({
    config_key: CONFIG_KEY,
    name: 'Termite Station Rental',
    category: 'termite',
    sort_order: 5,
    description: 'Quarters over which a rented station set\'s install price is recovered. Sizes the per-application rental uplift; the uplift itself does not expire.',
    data: JSON.stringify(SEED_DATA),
  });

  if (await knex.schema.hasTable('pricing_config_audit')) {
    await knex('pricing_config_audit').insert({
      config_key: CONFIG_KEY,
      old_value: null,
      new_value: JSON.stringify(SEED_DATA),
      changed_by: MIGRATION_TAG,
      reason: UP_REASON,
    });
  }

  if (await knex.schema.hasTable('pricing_changelog')) {
    const already = await knex('pricing_changelog').where(CHANGELOG_IDENTITY).first('id');
    if (!already) {
      await knex('pricing_changelog').insert({
        ...CHANGELOG_IDENTITY,
        affected_services: JSON.stringify(['termite_bait']),
        before_value: JSON.stringify({ termite_station_rental: 'not offered' }),
        after_value: JSON.stringify({ termite_station_rental: SEED_DATA }),
        rationale: 'Owner 2026-07-26: offer rented bait stations alongside outright purchase so builder-warranty takeovers (Massey/Sentricon expirations) can be quoted in the shape those customers already know — $0 install, Waves retains the hardware. 20 quarters puts rental at parity with buying at the 5-year mark. The uplift rides its own non-discountable line (termite_station_rental) so a WaveGuard bundle percentage cannot erode hardware cost recovery.',
      });
    }
  }
};

exports.down = async function down(knex) {
  // Two conditions before deleting live pricing config, because rollback is
  // not always followed by staying rolled back — a down/up cycle that resets
  // a tuned horizon back to the seed is silent pricing drift.
  //
  //   1. The audit row proves THIS migration inserted the row (an
  //      admin-created termite_rental config is not ours to remove).
  //   2. The row still holds exactly what up() seeded (an admin who has
  //      since tuned the horizon keeps their value; a later re-run is
  //      insert-if-absent and leaves it alone).
  //
  // No audit table means no proof of ownership; leave everything alone.
  if (!(await knex.schema.hasTable('pricing_config_audit'))) return;
  const ownUp = await knex('pricing_config_audit')
    .where({ config_key: CONFIG_KEY, changed_by: MIGRATION_TAG, reason: UP_REASON })
    .first('id');
  if (!ownUp) return;

  let untouched = false;
  if (await knex.schema.hasTable('pricing_config')) {
    const row = await knex('pricing_config').where({ config_key: CONFIG_KEY }).first('data');
    if (row) {
      const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
      untouched = Number(data?.recovery_quarters) === SEED_DATA.recovery_quarters;
      if (untouched) {
        await knex('pricing_config').where({ config_key: CONFIG_KEY }).del();
      }
    } else {
      // Already gone (manually removed) — nothing to preserve, so the
      // bookkeeping rows below are safe to clear too.
      untouched = true;
    }
  }
  if (!untouched) return;

  if (await knex.schema.hasTable('pricing_changelog')) {
    await knex('pricing_changelog').where(CHANGELOG_IDENTITY).del();
  }
  await knex('pricing_config_audit')
    .where({ config_key: CONFIG_KEY, changed_by: MIGRATION_TAG, reason: UP_REASON })
    .del();
};
