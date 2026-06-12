/**
 * Migration — Tree & Shrub v4.6 reprice: protocol-derived material model + 45% margin target
 *
 * The June 2026 pricing audit found the flat materialRate (0.110 $/sqft-yr,
 * set by the April 2026 vendor audit) had no bottom-up derivation and
 * over-modeled actual "10/10 SWFL Tree & Shrub Protocol" material cost by
 * 36-66%, with the error growing with bed size (service_product_usage holds
 * a single row for Tree & Shrub, so the rate never traced to real usage).
 * The /0.43 direct-cost divisor then amplified every over-modeled dollar
 * into $2.33 of price, and the $50/mo Standard floor pushed small properties
 * to $100/application regardless of the formula.
 *
 * v4.6 replaces this with:
 *   materials = max(freq*10, (fixed + per_tree*treeCount + per_sqft*bedArea) * tierFactor)
 *     fixed   $15/yr   minimum foliar/micros program load
 *     per_tree $4/yr   8-2-12 @ 1.5 lb/100 sqft canopy x 3 in-window apps x ~$0.93/lb
 *     per_sqft $0.055  Snapshot 2.5TG quarterly + 13-0-13 + spray-volume scaling
 *     light_factor 0.75 for the 4-visit program
 *   price = (direct cost + $51 admin) / (1 - 0.45)   // admin-INCLUSIVE 45% margin
 *   floors drop to backstops: light $22/mo, standard $35/mo
 *
 * The global_margin_target_ts row gains a `semantics: 'margin_admin_inclusive'`
 * marker; db-bridge only honors rows carrying it, so a stale pre-v4.6 row
 * (0.43 = direct-cost RATIO, different math) can never be applied as a margin.
 *
 * Reference quote (estimate token e9077c1f..., 350 sqft beds / 6 trees):
 * was $100/application at the old floor; reprices to ~$76/application at a
 * true 45% margin. Legacy estimates keep their stamped pricing_version and
 * are not re-priced.
 */
exports.up = async function (knex) {
  if (await knex.schema.hasTable('pricing_config')) {
    const updates = [
      {
        config_key: 'ts_material_rates',
        name: 'T&S Material Model (annual)',
        data: {
          fixed: 15,
          per_tree: 4,
          per_sqft: 0.055,
          light_factor: 0.75,
          note: 'v4.6 protocol-derived annual material model: fixed foliar/micros load + 8-2-12 per tree/palm + Snapshot/13-0-13/spray per bed sqft. Light 4x runs light_factor of the spend. 6-visit Standard is the mandated default; Light 4x is a downsell. Enhanced 9x / Premium 12x retired.',
        },
      },
      {
        config_key: 'ts_monthly_floors',
        name: 'T&S Monthly Floor Prices',
        data: {
          light: 22,
          standard: 35,
          note: 'Backstops, not expected prices — the v4.6 formula prices nearly all real properties above these. Keep light <= 2/3 of standard so a floored Light never exceeds Standard per month.',
        },
      },
      {
        config_key: 'global_margin_target_ts',
        name: 'T&S Margin Target',
        data: {
          value: 0.45,
          unit: 'ratio',
          semantics: 'margin_admin_inclusive',
          description: 'Tree & Shrub target margin, admin-inclusive: price = (direct cost + admin) / (1 - target). The semantics field is required — db-bridge ignores rows without it (guards against stale pre-v4.6 ratio rows).',
        },
      },
    ];
    for (const u of updates) {
      await knex('pricing_config')
        .where({ config_key: u.config_key })
        .update({ name: u.name, data: JSON.stringify(u.data), updated_at: knex.fn.now() });
    }
  }

  if (await knex.schema.hasTable('pricing_changelog')) {
    await knex('pricing_changelog').insert({
      version_from: 'v4.5',
      version_to: 'v4.6',
      changed_by: 'claude-code',
      category: 'cost',
      summary: 'Tree & Shrub reprice: protocol-derived material model (fixed + per-tree + per-sqft) replaces the flat 0.110 $/sqft rate; 45% admin-inclusive margin target replaces the 0.43 direct-cost divisor; floors drop to backstops (light $22/mo, standard $35/mo).',
      affected_services: JSON.stringify(['tree_shrub']),
      before_value: JSON.stringify({
        materialRates: { '4x_light': 0.075, '6x_standard': 0.110 },
        monthlyFloors: { light: 40, standard: 50 },
        directCostRatioTarget: 0.43,
        adminInPriceBasis: false,
      }),
      after_value: JSON.stringify({
        materialModel: { fixed: 15, per_tree: 4, per_sqft: 0.055, light_factor: 0.75 },
        monthlyFloors: { light: 22, standard: 35 },
        marginTarget: 0.45,
        marginTargetSemantics: 'margin_admin_inclusive',
        adminInPriceBasis: true,
        treeDensityFallbackCounts: { none: 0, light: 3, moderate: 6, heavy: 10 },
      }),
      rationale: 'June 2026 audit: the flat 0.110 $/sqft-yr material rate had no bottom-up derivation (service_product_usage has one T&S row) and over-modeled documented protocol cost by 36-66%, growing with bed size — Snapshot is the only truly linear material (~$0.034/sqft-yr); palm/ornamental 8-2-12 scales with tree count, not beds, and foliar concentrate is cheap per marginal sqft. The /0.43 divisor amplified the inflation 2.33x and the $50/mo floor forced small properties to $100/application (above the $89 lawn per-app on the same quote while covering ~1/12 the area). v4.6 derives materials bottom-up from products_catalog prices at protocol label rates, prices to a true 45% admin-inclusive margin, adds a per-tree material term (treeCount previously only added labor minutes), falls back to treeDensity when treeCount is missing instead of pricing zero trees, and demotes floors to backstops. At a 45% list margin, Gold (15%) collects 35.3% and survives the 35% post-discount guard; Platinum (20%) computes to 31.25% and is intentionally clamped by the guard.',
    });
  }
};

exports.down = async function (knex) {
  if (await knex.schema.hasTable('pricing_config')) {
    const reverts = [
      {
        config_key: 'ts_material_rates',
        name: 'T&S Material Rates per SqFt',
        data: { '4x_light': 0.075, '6x_standard': 0.110, note: '6-visit Standard is the mandated default; Light 4x is a downsell. Enhanced 9x / Premium 12x retired.' },
      },
      {
        config_key: 'ts_monthly_floors',
        name: 'T&S Monthly Floor Prices',
        data: { light: 40, standard: 50 },
      },
      {
        config_key: 'global_margin_target_ts',
        name: 'T&S Direct Cost Ratio Target',
        data: { value: 0.43, unit: 'ratio', description: 'Tree & Shrub direct-cost ratio target' },
      },
    ];
    for (const u of reverts) {
      await knex('pricing_config')
        .where({ config_key: u.config_key })
        .update({ name: u.name, data: JSON.stringify(u.data), updated_at: knex.fn.now() });
    }
  }

  if (await knex.schema.hasTable('pricing_changelog')) {
    await knex('pricing_changelog')
      .where({ version_from: 'v4.5', version_to: 'v4.6' })
      .whereRaw("summary LIKE 'Tree & Shrub reprice:%'")
      .del();
  }
};
