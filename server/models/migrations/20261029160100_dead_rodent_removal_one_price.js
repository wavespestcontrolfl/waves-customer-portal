/**
 * Dead Rodent Removal & Odor Treatment: one price per access tier (owner 2026-10-29: "make easy reach 199, and attic
 * search 299", then "think we just have the 3 options, and can discount if they have other work"). Other rodent work on
 * the same estimate no longer lowers the price; staff discount on the estimate itself.
 *
 * Moves, only where a row still holds the 2026-10-29 seed values (an admin's edit is left alone):
 *  - pricing_config.rodent_dead_animal_removal: the seed { reachable 169 / riding 119 / 45 min, attic 269 / riding 219 /
 *    90 min } becomes { reachable { alone 199, on_site_min 45 }, attic { alone 299, on_site_min 90 } }, dropping the
 *    retired `riding` key. Production already holds 199 / 199 and 299 / 299 (set on 2026-10-29 through the admin path's
 *    steps, with pricing_config_audit rows), which the validator accepts, so this leaves it as it is; it brings every
 *    other database (fresh installs, previews, CI) level with production.
 *  - services.rodent_dead_animal_removal base_price / price_range_min / price_range_max (169 / 119 / 269 -> 199 / 199 /
 *    299): the no-estimate scheduling fallback and the Service Library range. This one moves in production too.
 *  - one pricing_config_audit row per moved row, and one pricing_changelog row when anything moved.
 * Every write is under the row lock the admin pricing writer also takes.
 *
 * down() is a documented no-op (waves-db SKILL.md section 4): a seed whose up() keeps admin edits never rolls back
 * destructively, and the values it would restore are the retired ones.
 */
const { isDeepStrictEqual } = require('util');

const KEY = 'rodent_dead_animal_removal';
const TAG = 'migration:20261029160100_dead_rodent_removal_one_price';
const CATALOG_KEY = 'services_rodent_dead_animal_removal';
const OLD_SEED = {
  reachable: { alone: 169, riding: 119, on_site_min: 45 },
  attic: { alone: 269, riding: 219, on_site_min: 90 },
};
const NEW_ROW = {
  reachable: { alone: 199, on_site_min: 45 },
  attic: { alone: 299, on_site_min: 90 },
};
const OLD_CATALOG = { base_price: 169, price_range_min: 119, price_range_max: 269 };
const NEW_CATALOG = { base_price: 199, price_range_min: 199, price_range_max: 299 };
const REASON = 'One price per access tier (owner 2026-10-29): easy reach $199, attic search $299, inside a wall a custom quote. '
  + 'Other rodent work on the estimate no longer lowers it; staff discount on the estimate.';
const CHANGELOG = {
  version_from: 'v4.6',
  version_to: 'v4.6',
  changed_by: TAG,
  category: 'rule',
  summary: 'Dead Rodent Removal & Odor Treatment: one price per access tier ($199 easy reach, $299 attic search).',
};

const parse = (data) => {
  if (typeof data !== 'string') return data;
  try { return JSON.parse(data); } catch { return null; }
};
const sameNumber = (a, b) => a !== null && a !== undefined && Math.abs(Number(a) - b) < 0.005;
const holdsAll = (values, expected) => Object.entries(expected).every(([key, value]) => sameNumber(values?.[key], value));

async function auditInsert(knex, configKey, oldValue, newValue) {
  if (!(await knex.schema.hasTable('pricing_config_audit'))) return;
  await knex('pricing_config_audit').insert({
    config_key: configKey,
    old_value: JSON.stringify(oldValue),
    new_value: JSON.stringify(newValue),
    changed_by: TAG,
    reason: REASON,
  });
}

async function upConfig(knex) {
  if (!(await knex.schema.hasTable('pricing_config'))) return false;
  const row = await knex('pricing_config').where({ config_key: KEY }).forUpdate().first('data');
  // jsonb does not keep key order: compare the values. Anything but the exact seed is left alone.
  if (!row || !isDeepStrictEqual(parse(row.data), OLD_SEED)) return false;
  await knex('pricing_config').where({ config_key: KEY }).update({ data: JSON.stringify(NEW_ROW), updated_at: knex.fn.now() });
  await auditInsert(knex, KEY, OLD_SEED, NEW_ROW);
  return true;
}

async function upCatalog(knex) {
  if (!(await knex.schema.hasTable('services'))) return false;
  const svc = await knex('services').where({ service_key: KEY }).forUpdate()
    .first('base_price', 'price_range_min', 'price_range_max');
  if (!svc || !holdsAll(svc, OLD_CATALOG)) return false;
  await knex('services').where({ service_key: KEY }).update({ ...NEW_CATALOG, updated_at: knex.fn.now() });
  await auditInsert(knex, CATALOG_KEY, OLD_CATALOG, NEW_CATALOG);
  return true;
}

exports.KEY = KEY;
exports.TAG = TAG;
exports.OLD_SEED = OLD_SEED;
exports.NEW_ROW = NEW_ROW;
exports.OLD_CATALOG = OLD_CATALOG;
exports.NEW_CATALOG = NEW_CATALOG;
exports.CHANGELOG = CHANGELOG;

exports.up = async function up(knex) {
  const configMoved = await upConfig(knex);
  const catalogMoved = await upCatalog(knex);
  if (!configMoved && !catalogMoved) return;
  if (!(await knex.schema.hasTable('pricing_changelog'))) return;
  if (await knex('pricing_changelog').where(CHANGELOG).first('id')) return;
  await knex('pricing_changelog').insert({
    ...CHANGELOG,
    affected_services: JSON.stringify([KEY]),
    before_value: JSON.stringify({ ...(configMoved ? { [KEY]: OLD_SEED } : {}), ...(catalogMoved ? { [CATALOG_KEY]: OLD_CATALOG } : {}) }),
    after_value: JSON.stringify({ ...(configMoved ? { [KEY]: NEW_ROW } : {}), ...(catalogMoved ? { [CATALOG_KEY]: NEW_CATALOG } : {}) }),
    rationale: REASON,
  });
};

exports.down = async function down() {
  // Non-destructive on purpose: an admin may have edited either row since, and the values a revert would restore (a
  // lower price with other rodent work, $169 / $269) are the ones the owner retired on 2026-10-29.
};
