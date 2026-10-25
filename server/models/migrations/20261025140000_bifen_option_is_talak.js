/**
 * The pre-slab and trenching `bifen_it` option is the Atticus Talak 7.9 F bottle too (owner 2026-09-11: Bifen I/T was the
 * same bottle; owner 2026-10-25: "bifen i/t as talak is fine"). It takes exactly the Talak values 20261025130000 gave
 * talstar_p (read from that migration, so the two can never disagree). The bifen_it KEY stays because saved estimates store
 * it; the estimate tool now lists Talak once (talstar_p).
 *
 * Pricing is DB-authoritative (db-bridge loads pricing_config over constants.js), so the persisted rows must follow the code:
 *  1. onetime_preslab.products.bifen_it: catalog link Bifen I/T -> Atticus Talak 7.9 F, 128 oz at 41.53 -> 96 fl oz at 41.57,
 *     plus label, package label, positioning and warnings. Rewritten only while it still names Bifen I/T.
 *  2. onetime_trenching.products.bifen_it: 96 oz at 55 -> 96 fl oz at 41.57, plus label, positioning and warnings. Rewritten
 *     only while it still holds the seeded 55 / 96 and no label of its own.
 * A row that already holds the Talak values (production was updated by hand on 2026-10-25, with pricing_config_audit rows) is
 * left alone silently; a row an admin changed some other way is left alone with a warning. Neither gets a record.
 *
 * The rewrite drops camelCase and bottle aliases (catalogProductName, containerCost, ...) that db-bridge would read ahead of the
 * snake_case values written here.
 *
 * Ownership: up() writes one pricing_config_audit row (changed_by TAG) for each row it rewrote, and one pricing_changelog row
 * when it rewrote any. down() restores a row only when this migration's audit row for it exists AND the row's bifen_it still
 * deep-equals what up() wrote (an admin edit since then is kept), then deletes this migration's audit and changelog rows.
 * server/tests/bifen-option-is-talak-migration.test.js asserts the values equal the bifen_it products in constants.js.
 */
const { isDeepStrictEqual } = require('util');
const { TALAK_PRESLAB, TALAK_TRENCH } = require('./20261025130000_talstar_option_is_talak');

const TAG = 'migration:20261025140000_bifen_option_is_talak';
const LOG = '[bifen-option-is-talak]';
const REASON = 'Owner 2026-10-25: "bifen i/t as talak is fine" (Bifen I/T is the Atticus Talak 7.9 F bottle, owner 2026-09-11). The bifen_it option names and prices Talak (96 fl oz, $41.57, EPA 91234-145); the Bifen I/T catalog row is inactive. Key bifen_it kept so saved estimates replay.';
const CHANGELOG = {
  version_from: 'v4.6',
  version_to: 'v4.6',
  changed_by: TAG,
  category: 'rule',
  summary: 'Pre-slab + trenching: the bifen_it option is Atticus Talak 7.9 F (96 fl oz, $41.57), same as talstar_p.',
};
// Aliases db-bridge prefers over the snake_case keys written here.
const SHADOWING_ALIASES = ['catalogProductName', 'packageLabel', 'containerCost', 'containerOz', 'bottleCost', 'bottle_cost', 'bottleOz', 'bottle_oz'];

const parse = (data) => {
  if (typeof data !== 'string') return data;
  try { return JSON.parse(data); } catch { return null; }
};
const sameNumber = (a, b) => a !== null && a !== undefined && a !== '' && Number(a) === Number(b);
const firstDefined = (...values) => values.find((v) => v !== undefined && v !== null);

const PLANS = {
  onetime_preslab: {
    talak: TALAK_PRESLAB,
    isBifen: (p) => firstDefined(p.catalogProductName, p.catalog_product_name) === 'Bifen I/T',
  },
  onetime_trenching: {
    talak: TALAK_TRENCH,
    isBifen: (p) => sameNumber(firstDefined(p.containerCost, p.container_cost), 55)
      && sameNumber(firstDefined(p.containerOz, p.container_oz), 96)
      && !p.label,
  },
};

function toTalak(product, talak) {
  const next = { ...product };
  for (const alias of SHADOWING_ALIASES) delete next[alias];
  return { ...next, ...talak };
}

const holdsTalak = (product, talak) => Object.entries(talak).every(([k, v]) => isDeepStrictEqual(product[k], v))
  && SHADOWING_ALIASES.every((alias) => product[alias] === undefined);

exports.TAG = TAG;
exports.CHANGELOG = CHANGELOG;

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('pricing_config'))) return;
  const hasAudit = await knex.schema.hasTable('pricing_config_audit');
  const rewritten = [];
  for (const [key, plan] of Object.entries(PLANS)) {
    const row = await knex('pricing_config').where({ config_key: key }).forUpdate().first('data');
    const data = row && parse(row.data);
    const product = data && data.products && typeof data.products === 'object' ? data.products.bifen_it : null;
    if (!product || typeof product !== 'object') {
      if (row) console.warn(`${LOG} ${key} has no products.bifen_it - the code default (Talak) applies; leaving the row alone`);
      continue;
    }
    if (holdsTalak(product, plan.talak)) continue; // already Talak (production, 2026-10-25, or a re-run): not ours
    if (!plan.isBifen(product)) {
      console.warn(`${LOG} ${key}.products.bifen_it was edited since its seed - leaving the admin's values alone`);
      continue;
    }
    const next = { ...data, products: { ...data.products, bifen_it: toTalak(product, plan.talak) } };
    await knex('pricing_config').where({ config_key: key }).update({ data: JSON.stringify(next), updated_at: knex.fn.now() });
    if (hasAudit) {
      await knex('pricing_config_audit').insert({
        config_key: key,
        old_value: JSON.stringify(data),
        new_value: JSON.stringify(next),
        changed_by: TAG,
        reason: REASON,
      });
    }
    rewritten.push(key);
  }
  if (rewritten.length && await knex.schema.hasTable('pricing_changelog')
    && !(await knex('pricing_changelog').where(CHANGELOG).first('id'))) {
    await knex('pricing_changelog').insert({
      ...CHANGELOG,
      affected_services: JSON.stringify(['pre_slab_termiticide', 'trenching']),
      before_value: JSON.stringify({ bifen_it: 'Bifen I/T: pre-slab 128 oz at $41.53, trenching 96 oz at $55' }),
      after_value: JSON.stringify({ bifen_it: 'Atticus Talak 7.9 F: 96 fl oz at $41.57 (pre-slab links to the Talak catalog row)' }),
      rationale: REASON,
    });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('pricing_config_audit'))) return;
  const hasConfig = await knex.schema.hasTable('pricing_config');
  for (const key of hasConfig ? Object.keys(PLANS) : []) {
    const own = await knex('pricing_config_audit').where({ config_key: key, changed_by: TAG }).first('old_value', 'new_value');
    if (!own) continue;
    const before = parse(own.old_value);
    const written = parse(own.new_value);
    const row = await knex('pricing_config').where({ config_key: key }).forUpdate().first('data');
    const current = row && parse(row.data);
    const priorProduct = before && before.products && before.products.bifen_it;
    if (!current || !current.products || !priorProduct || !written || !written.products
      || !isDeepStrictEqual(current.products.bifen_it, written.products.bifen_it)) {
      console.warn(`${LOG} down: ${key}.products.bifen_it changed since this migration - leaving it alone`);
      continue;
    }
    const restored = { ...current, products: { ...current.products, bifen_it: priorProduct } };
    await knex('pricing_config').where({ config_key: key }).update({ data: JSON.stringify(restored), updated_at: knex.fn.now() });
  }
  await knex('pricing_config_audit').where({ changed_by: TAG }).del();
  if (await knex.schema.hasTable('pricing_changelog')) {
    await knex('pricing_changelog').where(CHANGELOG).del();
  }
};
