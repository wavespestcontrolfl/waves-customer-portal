/**
 * Mosquito misting system prices in pricing_config (GATE_MOSQUITO_MISTING, DRAFT prices, dealer cost unknown).
 *
 * Production pricing is DB-authoritative, so the misting table (constants.js MOSQUITO_MISTING) seeds the row
 * `mosquito_misting_pricing` (category mosquito, so the Pricing Logic panel lists it on its Mosquito tab and edits it
 * through the generic row editor) with the values the code carries today. db-bridge syncs it over MOSQUITO_MISTING on
 * every sync with bounds and a fail-closed fallback to the code defaults (pricing-engine/mosquito-misting-config.js).
 *
 * Label-bound and policy fields stay in code and are not in the row: the labels, minNozzles, maxNozzles, maxRisers,
 * maxRefillsPerYear, defaultTier, defaultSolution and defaultRefillsPerYear.
 *
 * Insert-if-missing: an existing row is never overwritten (an admin may already have edited it). down() deletes the row
 * only while it still holds exactly the seeded data; an edited row is left alone.
 *
 * The SEED is built from the code defaults so the migration and the code table cannot drift (a test pins them equal).
 */
const { isDeepStrictEqual } = require('util');

const KEY = 'mosquito_misting_pricing';
const TAG = 'migration:20261023000010_mosquito_misting_pricing_config';
const REASON = 'Seed the mosquito misting system pricing (DRAFT, dealer cost unknown; scope 2026-09-24 section 4.3): two system tiers, nozzle and riser overage, the install labor, the monthly plan application and the refill rates. Dark behind GATE_MOSQUITO_MISTING.';
const CHANGELOG = {
  version_from: 'v4.6',
  version_to: 'v4.6',
  changed_by: TAG,
  category: 'rule',
  summary: 'Add mosquito misting system pricing (pricing_config mosquito_misting_pricing).',
};
// Inlined literal (a pushed migration is frozen): server/tests/mosquito-misting-pricing-config.test.js asserts it
// equals mosquitoMistingPricingDefaults() in constants.js, so a later constant change fails the test instead of
// silently rewriting this seed.
const SEED = {
  tiers: {
    essential: {
      price: 3795,
      hardwareCost: 1800,
      includedNozzles: 35
    },
    smart: {
      price: 4595,
      hardwareCost: 2600,
      includedNozzles: 35
    }
  },
  extraNozzlePrice: 75,
  extraNozzleCost: 22,
  includedRisers: 10,
  extraRiserPrice: 45,
  extraRiserCost: 14,
  install: {
    techs: 2,
    hours: 10
  },
  plan: {
    monthly: 59,
    visitsPerYear: 12,
    laborMinutesPerVisit: 25,
    partsReservePerMonth: 10
  },
  refills: {
    standard: {
      price: 129,
      productCost: 45
    },
    natural: {
      price: 219,
      productCost: 95
    },
    premium: {
      price: 319,
      productCost: 140
    }
  },
  serviceCallNoPlan: 149
};

const parse = (data) => {
  if (typeof data !== 'string') return data;
  try { return JSON.parse(data); } catch { return null; }
};

exports.SEED = SEED;
exports.KEY = KEY;
exports.TAG = TAG;
exports.CHANGELOG = CHANGELOG;

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('pricing_config'))) return;
  const existing = await knex('pricing_config').where({ config_key: KEY }).first('config_key');
  if (existing) return;
  await knex('pricing_config').insert({
    config_key: KEY,
    name: 'Mosquito Misting System Pricing',
    category: 'mosquito',
    sort_order: 10,
    data: JSON.stringify(SEED),
    updated_at: knex.fn.now(),
  }).onConflict('config_key').ignore();
  // The audit and changelog records of the seed (only the migration that inserted the row writes them, once).
  if (await knex.schema.hasTable('pricing_config_audit')
    && !(await knex('pricing_config_audit').where({ config_key: KEY, changed_by: TAG }).first('id'))) {
    await knex('pricing_config_audit').insert({
      config_key: KEY,
      old_value: null,
      new_value: JSON.stringify(SEED),
      changed_by: TAG,
      reason: REASON,
    });
  }
  if (await knex.schema.hasTable('pricing_changelog')
    && !(await knex('pricing_changelog').where(CHANGELOG).first('id'))) {
    await knex('pricing_changelog').insert({
      ...CHANGELOG,
      affected_services: JSON.stringify(['mosquito_misting']),
      before_value: JSON.stringify(null),
      after_value: JSON.stringify({ [KEY]: SEED }),
      rationale: REASON,
    });
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('pricing_config_audit')) {
    await knex('pricing_config_audit').where({ config_key: KEY, changed_by: TAG }).del();
  }
  if (await knex.schema.hasTable('pricing_changelog')) {
    await knex('pricing_changelog').where(CHANGELOG).del();
  }
  if (!(await knex.schema.hasTable('pricing_config'))) return;
  const row = await knex('pricing_config').where({ config_key: KEY }).first('data');
  // jsonb does not keep key order: compare the values.
  if (!row || !isDeepStrictEqual(parse(row.data), SEED)) return;
  await knex('pricing_config').where({ config_key: KEY }).del();
};
