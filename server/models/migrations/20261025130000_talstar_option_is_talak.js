/**
 * The pre-slab and trenching `talstar_p` option is the Atticus Talak 7.9 F bottle (owner 2026-10-24: "swap talstar for talak").
 * Techs say "Talstar P", but the bottle is Talak 7.9 F, 96 fl oz, EPA 91234-145, and the Talstar P catalog row is inactive. The
 * talstar_p KEY stays because saved estimates store it; only the product it names, its cost and its copy change.
 *
 * Pricing is DB-authoritative (db-bridge loads pricing_config over constants.js), so the persisted rows must follow the code:
 *  1. onetime_preslab.products.talstar_p: catalog link Talstar P -> Atticus Talak 7.9 F, 128 oz at 38.99 -> 96 fl oz at 41.57, plus
 *     label, package label, positioning and warnings. Rewritten only while it still names Talstar P.
 *  2. onetime_trenching.products.talstar_p: 96 oz at 65 -> 96 fl oz at 41.57, plus label, positioning and warnings. Rewritten only
 *     while it still holds the seeded 65 / 96 and no label of its own.
 * A row that already holds the Talak values (production was updated by hand on 2026-10-24, with pricing_config_audit rows) is left
 * alone silently; a row an admin changed some other way is left alone with a warning. Neither gets a record.
 *
 * db-bridge reads `catalogProductName ?? catalog_product_name`, `containerCost ?? container_cost ?? bottleCost ?? bottle_cost`, and so
 * on, so a camelCase or bottle alias would win over the snake_case value written here: the rewrite drops those aliases.
 *
 * Ownership: up() writes one pricing_config_audit row (changed_by TAG) for each row it rewrote, and one pricing_changelog row when it
 * rewrote any. down() restores a row only when this migration's audit row for it exists AND the row's talstar_p still deep-equals what
 * up() wrote (an admin edit since then is kept), then deletes this migration's audit and changelog rows.
 *
 * TALAK_PRESLAB and TALAK_TRENCH are inlined (a pushed migration is frozen): server/tests/talstar-option-is-talak-migration.test.js
 * asserts they equal the talstar_p products in constants.js, so a later constant change fails that test instead of silently
 * disagreeing with this migration.
 */
const { isDeepStrictEqual } = require('util');

const TAG = 'migration:20261025130000_talstar_option_is_talak';
const LOG = '[talstar-option-is-talak]';
const REASON = 'Owner 2026-10-24: "swap talstar for talak". The talstar_p option is the Atticus Talak 7.9 F bottle (96 fl oz, $41.57, EPA 91234-145); the Talstar P catalog row is inactive. Key talstar_p kept so saved estimates replay.';
const CHANGELOG = {
  version_from: 'v4.6',
  version_to: 'v4.6',
  changed_by: TAG,
  category: 'rule',
  summary: 'Pre-slab + trenching: the talstar_p option is Atticus Talak 7.9 F (96 fl oz, $41.57).',
};

const PRODUCT_WARNING = 'Bifenthrin repellent barrier (Atticus Talak 7.9 F, EPA 91234-145).';
const TALAK_PRESLAB = {
  label: 'Talak 7.9 F - Bifenthrin',
  catalog_product_name: 'Atticus Talak 7.9 F',
  package_label: '96 fl oz',
  positioning: 'standard_repellent',
  container_cost: 41.57,
  container_oz: 96,
  warnings: [
    PRODUCT_WARNING,
    'Use only when the Talak 7.9 F label supports pre-construction subterranean termite treatment.',
  ],
};
const TALAK_TRENCH = {
  label: 'Talak 7.9 F - Bifenthrin',
  positioning: 'standard_repellent',
  container_cost: 41.57,
  container_oz: 96,
  warnings: [
    PRODUCT_WARNING,
    'Do not attach long repair-and-retreat warranty without admin approval.',
  ],
};
// Aliases db-bridge prefers over the snake_case keys written above.
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
    isTalstar: (p) => firstDefined(p.catalogProductName, p.catalog_product_name) === 'Talstar P',
  },
  onetime_trenching: {
    talak: TALAK_TRENCH,
    isTalstar: (p) => sameNumber(firstDefined(p.containerCost, p.container_cost), 65)
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
exports.TALAK_PRESLAB = TALAK_PRESLAB;
exports.TALAK_TRENCH = TALAK_TRENCH;

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('pricing_config'))) return;
  const hasAudit = await knex.schema.hasTable('pricing_config_audit');
  const rewritten = [];
  for (const [key, plan] of Object.entries(PLANS)) {
    const row = await knex('pricing_config').where({ config_key: key }).forUpdate().first('data');
    const data = row && parse(row.data);
    const product = data && data.products && typeof data.products === 'object' ? data.products.talstar_p : null;
    if (!product || typeof product !== 'object') {
      if (row) console.warn(`${LOG} ${key} has no products.talstar_p - the code default (Talak) applies; leaving the row alone`);
      continue;
    }
    if (holdsTalak(product, plan.talak)) continue; // already Talak (production, 2026-10-24, or a re-run): not ours
    if (!plan.isTalstar(product)) {
      console.warn(`${LOG} ${key}.products.talstar_p was edited since its seed - leaving the admin's values alone`);
      continue;
    }
    const next = { ...data, products: { ...data.products, talstar_p: toTalak(product, plan.talak) } };
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
      before_value: JSON.stringify({ talstar_p: 'Talstar P: pre-slab 128 oz at $38.99, trenching 96 oz at $65' }),
      after_value: JSON.stringify({ talstar_p: 'Atticus Talak 7.9 F: 96 fl oz at $41.57 (pre-slab links to the Talak catalog row)' }),
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
    const priorProduct = before && before.products && before.products.talstar_p;
    if (!current || !current.products || !priorProduct || !written || !written.products
      || !isDeepStrictEqual(current.products.talstar_p, written.products.talstar_p)) {
      console.warn(`${LOG} down: ${key}.products.talstar_p changed since this migration - leaving it alone`);
      continue;
    }
    const restored = { ...current, products: { ...current.products, talstar_p: priorProduct } };
    await knex('pricing_config').where({ config_key: key }).update({ data: JSON.stringify(restored), updated_at: knex.fn.now() });
  }
  await knex('pricing_config_audit').where({ changed_by: TAG }).del();
  if (await knex.schema.hasTable('pricing_changelog')) {
    await knex('pricing_changelog').where(CHANGELOG).del();
  }
};
