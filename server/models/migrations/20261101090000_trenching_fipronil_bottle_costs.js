/**
 * The trenching fipronil bottles take SiteOne's live member prices (owner 2026-11-01, estimator margin audit D1: "yes"):
 * Termidor SC 78 oz $375 -> $174.72 and Taurus SC 78 oz $85 -> $95 (SiteOne Lakewood Ranch #238, read 2026-11-01). The
 * $375 / $85 seeds of 20260520000003 had no source. Only the Termidor upgrade fee on a trenching quote moves (about $129-$342
 * down to $36-$94 on typical jobs); the base trenching price does not use these costs.
 *
 * Pricing is DB-authoritative (db-bridge loads pricing_config over constants.js), so the persisted row must follow the code:
 * onetime_trenching.products.termidor_sc / taurus_sc container_cost is rewritten only while it still holds its seeded value
 * and no camelCase containerCost (which db-bridge reads first) shadows it. A product that already holds the new cost is left
 * alone silently; a product an admin changed some other way is left alone with a warning. Neither gets a record.
 *
 * Ownership: up() writes one pricing_config_audit row (changed_by TAG) and one pricing_changelog row when it rewrote anything.
 * down() restores a product only when this migration's audit row exists AND the product still deep-equals what up() wrote
 * (an admin edit since then is kept), then deletes this migration's audit and changelog rows.
 * server/tests/trenching-fipronil-bottle-costs-migration.test.js asserts the costs equal the trenching products in constants.js.
 */
const { isDeepStrictEqual } = require('util');

const TAG = 'migration:20261101090000_trenching_fipronil_bottle_costs';
const LOG = '[trenching-fipronil-bottle-costs]';
const KEY = 'onetime_trenching';
const COSTS = {
  termidor_sc: { seeded: 375, siteOne: 174.72 },
  taurus_sc: { seeded: 85, siteOne: 95 },
};
const REASON = 'Owner 2026-11-01 (estimator margin audit D1, "yes"): trenching Termidor SC and Taurus SC take SiteOne\'s live member prices, $174.72 and $95 per 78 oz (Lakewood Ranch #238, read 2026-11-01). The $375 / $85 seeds had no source and made the Termidor upgrade fee 3-4 times too high.';
const CHANGELOG = {
  version_from: 'v4.9',
  version_to: 'v4.9',
  changed_by: TAG,
  category: 'cost',
  summary: 'Trenching: Termidor SC $375 -> $174.72 and Taurus SC $85 -> $95 per 78 oz (SiteOne live member prices).',
};

const parse = (data) => {
  if (typeof data !== 'string') return data;
  try { return JSON.parse(data); } catch { return null; }
};
const sameNumber = (a, b) => a !== null && a !== undefined && a !== '' && Number(a) === Number(b);

// 'rewrite' only for a product that still holds its seed with no camelCase alias in front of it.
function planFor(product, cost) {
  if (!product || typeof product !== 'object') return 'absent';
  if (product.containerCost === undefined && sameNumber(product.container_cost, cost.siteOne)) return 'current';
  if (product.containerCost === undefined && sameNumber(product.container_cost, cost.seeded)) return 'rewrite';
  return 'edited';
}

exports.TAG = TAG;
exports.COSTS = COSTS;
exports.CHANGELOG = CHANGELOG;

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('pricing_config'))) return;
  const row = await knex('pricing_config').where({ config_key: KEY }).forUpdate().first('data');
  const data = row && parse(row.data);
  const products = data && data.products && typeof data.products === 'object' ? data.products : null;
  if (!products) {
    if (row) console.warn(`${LOG} ${KEY} has no products - the code defaults apply; leaving the row alone`);
    return;
  }
  const nextProducts = { ...products };
  const rewritten = [];
  for (const [key, cost] of Object.entries(COSTS)) {
    const plan = planFor(products[key], cost);
    if (plan === 'edited') console.warn(`${LOG} ${KEY}.products.${key} was edited since its seed - leaving the admin's value alone`);
    if (plan !== 'rewrite') continue;
    nextProducts[key] = { ...products[key], container_cost: cost.siteOne };
    rewritten.push(key);
  }
  if (!rewritten.length) return;
  const next = { ...data, products: nextProducts };
  await knex('pricing_config').where({ config_key: KEY }).update({ data: JSON.stringify(next), updated_at: knex.fn.now() });
  if (await knex.schema.hasTable('pricing_config_audit')) {
    await knex('pricing_config_audit').insert({
      config_key: KEY,
      old_value: JSON.stringify(data),
      new_value: JSON.stringify(next),
      changed_by: TAG,
      reason: REASON,
    });
  }
  if (await knex.schema.hasTable('pricing_changelog') && !(await knex('pricing_changelog').where(CHANGELOG).first('id'))) {
    await knex('pricing_changelog').insert({
      ...CHANGELOG,
      affected_services: JSON.stringify(['trenching']),
      before_value: JSON.stringify(Object.fromEntries(rewritten.map((key) => [key, { container_cost: COSTS[key].seeded, container_oz: 78 }]))),
      after_value: JSON.stringify(Object.fromEntries(rewritten.map((key) => [key, { container_cost: COSTS[key].siteOne, container_oz: 78 }]))),
      rationale: REASON,
    });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('pricing_config_audit'))) return;
  const own = await knex('pricing_config_audit').where({ config_key: KEY, changed_by: TAG }).first('old_value', 'new_value');
  const before = own && parse(own.old_value);
  const written = own && parse(own.new_value);
  const row = own && await knex.schema.hasTable('pricing_config')
    ? await knex('pricing_config').where({ config_key: KEY }).forUpdate().first('data')
    : null;
  const current = row && parse(row.data);
  if (current && current.products && before && before.products && written && written.products) {
    const restored = { ...current.products };
    const keys = Object.keys(COSTS).filter((key) => !isDeepStrictEqual(written.products[key], before.products[key]));
    for (const key of keys) {
      if (isDeepStrictEqual(current.products[key], written.products[key])) restored[key] = before.products[key];
      else console.warn(`${LOG} down: ${KEY}.products.${key} changed since this migration - leaving it alone`);
    }
    if (!isDeepStrictEqual(restored, current.products)) {
      await knex('pricing_config').where({ config_key: KEY }).update({
        data: JSON.stringify({ ...current, products: restored }),
        updated_at: knex.fn.now(),
      });
    }
  }
  await knex('pricing_config_audit').where({ config_key: KEY, changed_by: TAG }).del();
  if (await knex.schema.hasTable('pricing_changelog')) {
    await knex('pricing_changelog').where(CHANGELOG).del();
  }
};
