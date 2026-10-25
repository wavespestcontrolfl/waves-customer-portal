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
 * Ownership is recorded, same contract as 20261024100000: up() writes a system_settings state row (STATE_KEY) holding exactly what it
 * changed, { pricingConfig: true|false, serviceFields: [...] }. A row or field that already held the new value (an operator set it
 * before this deployed, or a re-run) is NOT written and NOT recorded, so down() never reverts a value this migration did not set.
 * down() with no readable state row changes nothing in pricing_config or services. With a state row it restores the pricing_config row
 * only if recorded AND still deep-equal to NEXT, and each services field only if recorded AND still equal to what up() wrote (a value
 * an admin changed since is left alone), then deletes the state row. It always removes the audit and changelog rows this migration
 * wrote (tagged with TAG; up() writes them only when it actually replaced the pricing row).
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
const STATE_KEY = 'migration.20261025090000.state';
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
exports.STATE_KEY = STATE_KEY;

const emptyState = () => ({ pricingConfig: false, serviceFields: [] });
const normalizeState = (parsed) => ({
  pricingConfig: parsed && parsed.pricingConfig === true,
  serviceFields: Array.isArray(parsed && parsed.serviceFields) ? parsed.serviceFields.filter((f) => typeof f === 'string') : [],
});

async function readState(knex) {
  if (!(await knex.schema.hasTable('system_settings'))) return null;
  const row = await knex('system_settings').where({ key: STATE_KEY }).first();
  if (!row) return null;
  try {
    return normalizeState(typeof row.value === 'string' ? JSON.parse(row.value) : row.value);
  } catch {
    return null;
  }
}

// Union with the prior run so a re-run can never shrink what down() may restore, and never claims a field up() did not write.
// Nothing changed and no prior row: no row is written.
async function recordState(knex, changed) {
  if (!changed.pricingConfig && !changed.serviceFields.length) return;
  if (!(await knex.schema.hasTable('system_settings'))) return;
  const existing = await knex('system_settings').where({ key: STATE_KEY }).first();
  let prior = emptyState();
  if (existing) { try { prior = normalizeState(JSON.parse(existing.value)); } catch { /* keep empty */ } }
  const value = JSON.stringify({
    pricingConfig: prior.pricingConfig || changed.pricingConfig,
    serviceFields: [...new Set([...prior.serviceFields, ...changed.serviceFields])],
  });
  if (existing) await knex('system_settings').where({ key: STATE_KEY }).update({ value });
  else await knex('system_settings').insert({ key: STATE_KEY, value });
}

async function upPricingConfig(knex) {
  if (!(await knex.schema.hasTable('pricing_config'))) return false;
  const row = await knex('pricing_config').where({ config_key: KEY }).first('data');
  if (!row) {
    console.warn(`${LOG} pricing_config ${KEY} is missing - leaving it alone`);
    return false;
  }
  const current = parse(row.data);
  if (isDeepStrictEqual(current, NEXT)) return false; // already holds the new prices (a re-run, or set before this deployed): not ours
  // jsonb does not keep key order: compare the values.
  if (!isDeepStrictEqual(current, SEED)) {
    console.warn(`${LOG} pricing_config ${KEY} was edited since the 20261023 seed - leaving the admin's prices alone`);
    return false;
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
  return true;
}

// Each field is guarded on its own: a price moves only while it still holds the seeded list, and a text field only while it still
// holds the seeded text, so an operator who edited the copy (or the prices) keeps that work and the other fields still move.
async function upService(knex) {
  if (!(await knex.schema.hasTable('services'))) return [];
  const row = await knex('services').where({ service_key: SERVICE_KEY })
    .first('base_price', 'price_range_min', 'description', 'internal_notes');
  if (!row) {
    console.warn(`${LOG} services ${SERVICE_KEY} is missing - leaving it alone`);
    return [];
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
  const written = Object.keys(patch);
  if (written.length) await knex('services').where({ service_key: SERVICE_KEY }).update(patch);
  return written;
}

exports.up = async function up(knex) {
  const pricingConfig = await upPricingConfig(knex);
  const serviceFields = await upService(knex);
  await recordState(knex, { pricingConfig, serviceFields });
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('pricing_config_audit')) {
    await knex('pricing_config_audit').where({ config_key: KEY, changed_by: TAG }).del();
  }
  if (await knex.schema.hasTable('pricing_changelog')) {
    await knex('pricing_changelog').where(CHANGELOG).del();
  }
  const state = await readState(knex);
  if (!state) {
    console.warn(`${LOG} down: no readable state row - restoring nothing`);
    return;
  }
  if (state.pricingConfig && await knex.schema.hasTable('pricing_config')) {
    const row = await knex('pricing_config').where({ config_key: KEY }).first('data');
    // jsonb does not keep key order: compare the values. An admin edit since up() is left alone.
    if (row && isDeepStrictEqual(parse(row.data), NEXT)) {
      await knex('pricing_config').where({ config_key: KEY }).update({ data: JSON.stringify(SEED), updated_at: knex.fn.now() });
    } else {
      console.warn(`${LOG} down: pricing_config ${KEY} changed since up() - leaving it alone`);
    }
  }
  if (state.serviceFields.length && await knex.schema.hasTable('services')) {
    const row = await knex('services').where({ service_key: SERVICE_KEY })
      .first('base_price', 'price_range_min', 'description', 'internal_notes');
    if (row) {
      // Each recorded field goes back only while it still holds exactly what up() wrote.
      const wrote = {
        base_price: sameNumber(row.base_price, NEW_SERVICE.base_price),
        price_range_min: sameNumber(row.price_range_min, NEW_SERVICE.price_range_min),
        description: row.description === NEW_SERVICE.description,
        internal_notes: row.internal_notes === NEW_SERVICE.internal_notes,
      };
      const patch = {};
      for (const field of state.serviceFields) {
        if (!Object.prototype.hasOwnProperty.call(wrote, field)) continue;
        if (wrote[field]) patch[field] = OLD_SERVICE[field];
        else console.warn(`${LOG} down: services ${SERVICE_KEY}.${field} changed since up() - leaving it alone`);
      }
      if (Object.keys(patch).length) await knex('services').where({ service_key: SERVICE_KEY }).update(patch);
    }
  }
  await knex('system_settings').where({ key: STATE_KEY }).del();
};
