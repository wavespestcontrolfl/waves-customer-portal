/**
 * Lawn protocol v13, before the GATE_LAWN_V13 flip: one yearly prodiamine cap
 * across every formulation (Codex round 6 on #5988, deferred by the owner's
 * stopping rule).
 *
 * The only prodiamine limit in product_limits was a product-id row for
 * "Prodiamine 65 WDG" (20260401000020). v13 plans LESCO Stonewall 4FL in January
 * and LESCO Stonewall 0.43% 15-0-15 in October, products that had no limit row,
 * so their applications were invisible to the cap and to each other.
 *
 * What this adds: one annual_max_rate row per prodiamine product, with
 * match_type 'active_ingredient' and match_value 'prodiamine'. The label cap is
 * 1.5 lb ai per acre per year (St. Augustine). Each row writes that cap in ITS
 * product's own rate unit per 1,000 sq ft, so application-limits can add the
 * products up as shares of one cap without converting between formulations:
 *
 *   cap per 1,000 sq ft          = 1.5 lb ai / 43.56         = 0.034435 lb ai
 *   Stonewall 4FL (4 lb ai/gal)  = 0.034435 / (4 / 128)      = 1.1019 fl oz
 *   Prodiamine 65 WDG (65%)      = 0.034435 / (0.65 / 16)    = 0.8476 oz
 *   Stonewall 0.43% granular     = 0.034435 / 0.0043         = 8.0082 lb
 *
 * The v13 plan (Jan 4FL 0.5 fl oz = 45% of the cap, Oct granular 4.02 lb = 50%)
 * stays under it; a season that already holds more prodiamine blocks the next
 * selected prodiamine product.
 *
 * Which rows: every products_catalog row whose active_ingredient starts with
 * "prodiamine" (any case, any strength suffix). The strength comes from the
 * catalog row itself: a "4FL" in a liquid's name (lb ai per gallon), else the
 * first percent in active_ingredient, else in the name. A row that gives
 * neither is skipped with a warning (application-limits then names its history
 * rows as unsized instead of counting them as nothing). The older 65 WDG
 * product-id row is left as it is.
 *
 * Idempotent (a product that already has its row is skipped). down() deletes
 * only the rows this migration wrote (matched by their description).
 */

const MATCH_VALUE = 'prodiamine';
const DESCRIPTION_PREFIX = 'Prodiamine yearly cap, all products:';
const CAP_LB_AI_PER_ACRE = 1.5;
const SQFT_PER_ACRE = 43560;
const CAP_LB_AI_PER_1000 = CAP_LB_AI_PER_ACRE / (SQFT_PER_ACRE / 1000);

const round4 = (value) => Math.round(value * 10000) / 10000;

// The product's rate unit and how many lb ai one of that unit holds, or null.
function aiPerRateUnit(row) {
  const unit = String(row.rate_unit || '').trim().toLowerCase().replace(/[\s_]+/g, ' ');
  const text = `${row.active_ingredient || ''} | ${row.name || ''}`;
  if (unit === 'fl oz') {
    const lbPerGal = /\b(\d+(?:\.\d+)?)\s*FL\b/i.exec(row.name || '');
    return lbPerGal ? { unit: 'fl oz', aiPerUnit: Number(lbPerGal[1]) / 128 } : null;
  }
  if (unit !== 'lb' && unit !== 'oz') return null;
  const percent = /(\d+(?:\.\d+)?)\s*%/.exec(row.active_ingredient || '') || /(\d+(?:\.\d+)?)\s*%/.exec(text.split('|')[1]);
  if (!percent || !(Number(percent[1]) > 0)) return null;
  const share = Number(percent[1]) / 100;
  return { unit, aiPerUnit: unit === 'lb' ? share : share / 16 };
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('product_limits')) || !(await knex.schema.hasTable('products_catalog'))) return;

  const products = await knex('products_catalog')
    .whereRaw('active_ingredient ILIKE ?', [`${MATCH_VALUE}%`])
    .select('id', 'name', 'active_ingredient', 'rate_unit');
  const have = new Set((await knex('product_limits')
    .where({ match_type: 'active_ingredient', match_value: MATCH_VALUE, limit_type: 'annual_max_rate' })
    .select('product_id')).map((row) => String(row.product_id)));

  for (const product of products) {
    if (have.has(String(product.id))) continue;
    const ai = aiPerRateUnit(product);
    if (!ai) {
      console.warn(`[lawn-v13-prodiamine-cap] no strength for "${product.name}" (rate_unit ${product.rate_unit}); no cap row written`);
      continue;
    }
    const cap = round4(CAP_LB_AI_PER_1000 / ai.aiPerUnit);
    await knex('product_limits').insert({
      product_id: product.id,
      match_type: 'active_ingredient',
      match_value: MATCH_VALUE,
      limit_type: 'annual_max_rate',
      limit_value: cap,
      limit_unit: `${ai.unit}/1000sf/year`,
      severity: 'hard_block',
      description: `${DESCRIPTION_PREFIX} ${CAP_LB_AI_PER_ACRE} lb ai/acre/year (label), written as ${cap} ${ai.unit} of ${product.name} per 1,000 sq ft. Every prodiamine product shares this one cap.`,
    });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('product_limits'))) return;
  await knex('product_limits')
    .where({ match_type: 'active_ingredient', match_value: MATCH_VALUE, limit_type: 'annual_max_rate' })
    .whereRaw('description LIKE ?', [`${DESCRIPTION_PREFIX}%`])
    .del();
};

exports.aiPerRateUnit = aiPerRateUnit;
exports.CAP_LB_AI_PER_1000 = CAP_LB_AI_PER_1000;
