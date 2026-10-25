/**
 * Mosquito misting system moves from the MistAway model to the Pynamite system at RETAIL prices (owner 2026-10-24: "build
 * at retail for now" until dealer pricing arrives; GATE_MOSQUITO_MISTING stays dark, this migration changes no gate).
 * The tier KEYS (essential, smart) stay because estimates store them; only labels and numbers change:
 *   smart      Standard system (55-gallon)  4,195  (was Smart system (tankless + app) 4,595), 30 nozzles
 *   essential  Compact system (10-gallon)   2,795  (was Essential system (drum) 3,795), 10 nozzles
 * Every riser is priced individually (0 included, 75 each), and the install is 2 techs for 6 hours.
 *
 * Production pricing is DB-authoritative, so two rows must follow the code (constants.js MOSQUITO_MISTING):
 *  1. pricing_config `mosquito_misting_pricing` (seeded by the frozen 20261023000010). Replaced with NEXT only while it still
 *     deep-equals that migration's SEED, i.e. no admin has edited it. An edited or missing row is left alone with a warning.
 *     The replacement writes a pricing_config_audit row and a pricing_changelog row, like the seed did.
 *  2. services `mosquito_misting_install` (frozen 20261023100000). Each field moves on its own, only while it still holds the
 *     seeded value: base_price 4595 -> 4195, price_range_min 3795 -> 2795, and the description and internal notes (which drop the
 *     "pump or tankless unit" and the old list prices) only while they equal the seeded text. A field an operator edited is left
 *     alone with a warning and the others still move.
 *
 * down() reverses each part (and each services field) only while it still holds exactly what up() wrote, and removes only the audit
 * and changelog rows this migration wrote. A part an admin changed since is left alone.
 *
 * NEXT is an inlined literal (a pushed migration is frozen): server/tests/mosquito-misting-pynamite-retail-migration.test.js
 * asserts it equals mosquitoMistingPricingDefaults() in constants.js, so a later constant change fails the test instead of
 * silently rewriting this migration.
 */
const { isDeepStrictEqual } = require('util');
const seeded = require('./20261023000010_mosquito_misting_pricing_config');
const catalog = require('./20261023100000_mosquito_misting_catalog_rows');

const KEY = seeded.KEY;
const SERVICE_KEY = 'mosquito_misting_install';
const TAG = 'migration:20261025090000_mosquito_misting_pynamite_retail_prices';
const LOG = '[mosquito-misting-pynamite-retail]';
const REASON = 'Move the mosquito misting system pricing from the MistAway model to the Pynamite system at retail sale prices read 2026-10-24 (owner: build at retail for now; dealer pricing will replace them): Standard 55-gallon 4,195 (30 nozzles), Compact 10-gallon 2,795 (10 nozzles), risers priced individually at 75, install 2 techs x 6 hours, standard refill cost 70, premium refill cost 203. Dark behind GATE_MOSQUITO_MISTING.';
const CHANGELOG = {
  version_from: 'v4.6',
  version_to: 'v4.6',
  changed_by: TAG,
  category: 'rule',
  summary: 'Mosquito misting pricing moves to the Pynamite system at retail (pricing_config mosquito_misting_pricing).',
};

const SEED = seeded.SEED;
const NEXT = {
  tiers: {
    essential: {
      price: 2795,
      hardwareCost: 1620,
      includedNozzles: 10
    },
    smart: {
      price: 4195,
      hardwareCost: 2560,
      includedNozzles: 30
    }
  },
  extraNozzlePrice: 75,
  extraNozzleCost: 22,
  includedRisers: 0,
  extraRiserPrice: 75,
  extraRiserCost: 30,
  install: {
    techs: 2,
    hours: 6
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
      productCost: 70
    },
    natural: {
      price: 219,
      productCost: 95
    },
    premium: {
      price: 319,
      productCost: 203
    }
  },
  serviceCallNoPlan: 149
};

const OLD_SERVICE = catalog.SERVICES.find((s) => s.service_key === SERVICE_KEY);
const NEW_SERVICE = {
  base_price: 4195,
  price_range_min: 2795,
  description: 'Installation of an automatic mosquito misting system: pump unit, tubing, nozzles and risers, calibration and a customer walkthrough. Priced by system size, nozzle count and riser count on the estimate.',
  internal_notes: 'Priced by priceMosquitoMisting; engine_keys mosquito_misting_installation. Standard 55-gallon list 4,195, Compact 10-gallon list 2,795 (Pynamite retail cost basis 2026-10-24; dealer pricing pending). Two techs, about one day. Follows the design visit (mosquito_misting_system).',
};

const parse = (data) => {
  if (typeof data !== 'string') return data;
  try { return JSON.parse(data); } catch { return null; }
};
// numeric columns come back as strings from pg
const sameNumber = (a, b) => a !== null && a !== undefined && Number(a) === Number(b);

exports.NEXT = NEXT;
exports.SEED = SEED;
exports.KEY = KEY;
exports.TAG = TAG;
exports.CHANGELOG = CHANGELOG;
exports.NEW_SERVICE = NEW_SERVICE;

async function upPricingConfig(knex) {
  if (!(await knex.schema.hasTable('pricing_config'))) return;
  const row = await knex('pricing_config').where({ config_key: KEY }).first('data');
  if (!row) {
    console.warn(`${LOG} pricing_config ${KEY} is missing - leaving it alone`);
    return;
  }
  const current = parse(row.data);
  if (isDeepStrictEqual(current, NEXT)) return; // already applied (re-run)
  // jsonb does not keep key order: compare the values.
  if (!isDeepStrictEqual(current, SEED)) {
    console.warn(`${LOG} pricing_config ${KEY} was edited since the 20261023 seed - leaving the admin's prices alone`);
    return;
  }
  await knex('pricing_config').where({ config_key: KEY }).update({ data: JSON.stringify(NEXT), updated_at: knex.fn.now() });
  if (await knex.schema.hasTable('pricing_config_audit')
    && !(await knex('pricing_config_audit').where({ config_key: KEY, changed_by: TAG }).first('id'))) {
    await knex('pricing_config_audit').insert({
      config_key: KEY,
      old_value: JSON.stringify(SEED),
      new_value: JSON.stringify(NEXT),
      changed_by: TAG,
      reason: REASON,
    });
  }
  if (await knex.schema.hasTable('pricing_changelog')
    && !(await knex('pricing_changelog').where(CHANGELOG).first('id'))) {
    await knex('pricing_changelog').insert({
      ...CHANGELOG,
      affected_services: JSON.stringify(['mosquito_misting']),
      before_value: JSON.stringify({ [KEY]: SEED }),
      after_value: JSON.stringify({ [KEY]: NEXT }),
      rationale: REASON,
    });
  }
}

// Each field is guarded on its own: a price moves only while it still holds the seeded list, and a text field only while it still
// holds the seeded text, so an operator who edited the copy (or the prices) keeps that work and the other fields still move.
async function upService(knex) {
  if (!(await knex.schema.hasTable('services'))) return;
  const row = await knex('services').where({ service_key: SERVICE_KEY })
    .first('base_price', 'price_range_min', 'description', 'internal_notes');
  if (!row) {
    console.warn(`${LOG} services ${SERVICE_KEY} is missing - leaving it alone`);
    return;
  }
  const patch = {};
  const left = [];
  const field = (name, isSeeded, isDone, next) => {
    if (isSeeded) patch[name] = next;
    else if (!isDone) left.push(name);
  };
  field('base_price', sameNumber(row.base_price, OLD_SERVICE.base_price), sameNumber(row.base_price, NEW_SERVICE.base_price), NEW_SERVICE.base_price);
  field('price_range_min', sameNumber(row.price_range_min, OLD_SERVICE.price_range_min), sameNumber(row.price_range_min, NEW_SERVICE.price_range_min), NEW_SERVICE.price_range_min);
  field('description', row.description === OLD_SERVICE.description, row.description === NEW_SERVICE.description, NEW_SERVICE.description);
  field('internal_notes', row.internal_notes === OLD_SERVICE.internal_notes, row.internal_notes === NEW_SERVICE.internal_notes, NEW_SERVICE.internal_notes);
  if (left.length) console.warn(`${LOG} services ${SERVICE_KEY}: ${left.join(', ')} changed since the 20261023 catalog seed - leaving ${left.length === 1 ? 'it' : 'them'} alone`);
  if (Object.keys(patch).length) await knex('services').where({ service_key: SERVICE_KEY }).update(patch);
}

exports.up = async function up(knex) {
  await upPricingConfig(knex);
  await upService(knex);
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('pricing_config_audit')) {
    await knex('pricing_config_audit').where({ config_key: KEY, changed_by: TAG }).del();
  }
  if (await knex.schema.hasTable('pricing_changelog')) {
    await knex('pricing_changelog').where(CHANGELOG).del();
  }
  if (await knex.schema.hasTable('pricing_config')) {
    const row = await knex('pricing_config').where({ config_key: KEY }).first('data');
    if (row && isDeepStrictEqual(parse(row.data), NEXT)) {
      await knex('pricing_config').where({ config_key: KEY }).update({ data: JSON.stringify(SEED), updated_at: knex.fn.now() });
    }
  }
  if (await knex.schema.hasTable('services')) {
    const row = await knex('services').where({ service_key: SERVICE_KEY })
      .first('base_price', 'price_range_min', 'description', 'internal_notes');
    if (row) {
      // Each field goes back only while it still holds exactly what up() wrote.
      const patch = {};
      if (sameNumber(row.base_price, NEW_SERVICE.base_price)) patch.base_price = OLD_SERVICE.base_price;
      if (sameNumber(row.price_range_min, NEW_SERVICE.price_range_min)) patch.price_range_min = OLD_SERVICE.price_range_min;
      if (row.description === NEW_SERVICE.description) patch.description = OLD_SERVICE.description;
      if (row.internal_notes === NEW_SERVICE.internal_notes) patch.internal_notes = OLD_SERVICE.internal_notes;
      if (Object.keys(patch).length) await knex('services').where({ service_key: SERVICE_KEY }).update(patch);
    }
  }
};
