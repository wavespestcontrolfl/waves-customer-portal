/**
 * Migration — Tree & Shrub: 6-visit Standard mandate + 4-visit Light tier
 *
 * Retires the 9x Enhanced and 12x Premium Tree & Shrub tiers and makes the
 * 6-visit Standard program the mandated default. Adds a 4-visit Light tier
 * (protocol four_x) as a downsell for clean / low-pest-history landscapes.
 *
 * The documented "10/10 SWFL Tree & Shrub Protocol" (server/config/protocols.json)
 * tops out at a 6-visit (six_x) cadence, so pricing 9/12-visit programs charged
 * customers for visits that were never scheduled. This aligns the priced
 * cadence with the protocol we actually deliver.
 *
 * Updates the live JSONB pricing_config rows the engine reads at runtime
 * (db-bridge.syncConstantsFromDB) and records a pricing_changelog entry.
 * Legacy estimates keep their stamped pricing_version and are not re-priced.
 */
exports.up = async function (knex) {
  if (await knex.schema.hasTable('pricing_config')) {
    const updates = [
      // Annual $/sqft material rates. Light ≈ 4/6 of Standard (scales w/ apps).
      { config_key: 'ts_material_rates', data: { '4x_light': 0.075, '6x_standard': 0.110 } },
      // Pre-discount monthly list-price floors.
      { config_key: 'ts_monthly_floors', data: { light: 40, standard: 50 } },
      // Visits per year.
      { config_key: 'ts_frequencies', data: { light: 4, standard: 6, unit: 'visits/yr' } },
    ];
    for (const u of updates) {
      await knex('pricing_config')
        .where({ config_key: u.config_key })
        .update({ data: JSON.stringify(u.data), updated_at: knex.fn.now() });
    }
  }

  if (await knex.schema.hasTable('pricing_changelog')) {
    await knex('pricing_changelog').insert({
      version_from: 'v4.4',
      version_to: 'v4.5',
      changed_by: 'claude-code',
      category: 'rule',
      summary: 'Tree & Shrub: 6-visit Standard is the mandated default; retired 9x Enhanced and 12x Premium; added 4x Light downsell.',
      affected_services: JSON.stringify(['tree_shrub']),
      before_value: JSON.stringify({
        tiers: { standard: { frequency: 6, materialRate: 0.110, monthlyFloor: 50 }, enhanced: { frequency: 9, materialRate: 0.190, monthlyFloor: 65 } },
        recommendedTier: 'enhanced',
        deprecatedPremium: { frequency: 12, materialRate: 0.220, monthlyFloor: 80 },
      }),
      after_value: JSON.stringify({
        tiers: { light: { frequency: 4, materialRate: 0.075, monthlyFloor: 40 }, standard: { frequency: 6, materialRate: 0.110, monthlyFloor: 50 } },
        recommendedTier: 'standard',
        retiredTiers: ['enhanced', 'premium'],
        directCostRatioTarget: 0.43,
      }),
      rationale: 'The "10/10 SWFL Tree & Shrub Protocol" only schedules up to a 6-visit (six_x) cadence, but the engine sold a 9-visit Enhanced default (and a deprecated 12-visit Premium), charging labor + amortized material for visits we do not run — which inflated quotes (the default auto-escalated to Enhanced on any signal, including the unknown-bed-area fallback). 6-visit Standard is now the mandated default. The 4-visit Light tier (protocol four_x, "best for cleaner properties with low pest history") is available as a manual downsell but is never auto-recommended. The directCostRatioTarget multiplier is unchanged at 0.43. Legacy enhanced/premium tier requests map to Standard with a warning.',
    });
  }
};

exports.down = async function (knex) {
  if (await knex.schema.hasTable('pricing_config')) {
    const reverts = [
      { config_key: 'ts_material_rates', data: { '6x_standard': 0.110, '9x_enhanced': 0.190, '12x_premium': 0.220 } },
      { config_key: 'ts_monthly_floors', data: { standard: 50, enhanced: 65, premium: 80 } },
      { config_key: 'ts_frequencies', data: { standard: 6, enhanced: 9, premium: 12, unit: 'visits/yr' } },
    ];
    for (const rv of reverts) {
      await knex('pricing_config')
        .where({ config_key: rv.config_key })
        .update({ data: JSON.stringify(rv.data), updated_at: knex.fn.now() });
    }
  }
  if (await knex.schema.hasTable('pricing_changelog')) {
    await knex('pricing_changelog').where({ version_to: 'v4.5', category: 'rule' }).del();
  }
};
