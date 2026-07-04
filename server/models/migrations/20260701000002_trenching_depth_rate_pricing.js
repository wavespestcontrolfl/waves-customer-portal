// Trenching depth + application-rate install premiums (Phase 2, 2026-07-01).
// Makes trench depth and the high/problem-soil application rate move the price:
//   baseInstallPrice = LF model × trenchDepthMultiplier × highRatePriceMultiplier
// The 0.5 ft baseline + standard rate leave the LF model unchanged, so every
// previously-quoted standard job keeps its price. Also flips the stored default
// trench depth 1.0 → 0.5 ft (6 in, the label-standard residential trench) so
// depth-less calls price at the ×1.0 baseline rather than the +15% (1.0 ft) tier.
// Engine defaults live in server/services/pricing-engine/constants.js; this keeps
// the DB pricing_config row (which the db-bridge overlays on top) in sync.

const NEW_FIELDS = {
  default_trench_depth_ft: 0.5,
  baseline_trench_depth_ft: 0.5,
  trench_depth_premium_per_half_ft: 0.15,
  high_rate_price_multiplier: 1.12,
};

const PRIOR_FIELDS = {
  default_trench_depth_ft: 1.0,
};

const REMOVED_ON_DOWN = [
  'baseline_trench_depth_ft',
  'trench_depth_premium_per_half_ft',
  'high_rate_price_multiplier',
];

function parseConfigData(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Buffer.isBuffer(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

async function applyFields(knex, fields, removeKeys = []) {
  if (!(await knex.schema.hasTable('pricing_config'))) return;
  const existing = await knex('pricing_config')
    .where({ config_key: 'onetime_trenching' })
    .first('id', 'data');
  if (!existing) return; // seed migration 20260520000003 owns row creation
  const nextData = { ...parseConfigData(existing.data), ...fields };
  for (const key of removeKeys) delete nextData[key];
  await knex('pricing_config')
    .where({ config_key: 'onetime_trenching' })
    .update({ data: JSON.stringify(nextData), updated_at: knex.fn.now() });
}

exports.up = async function up(knex) {
  await applyFields(knex, NEW_FIELDS);
};

exports.down = async function down(knex) {
  await applyFields(knex, PRIOR_FIELDS, REMOVED_ON_DOWN);
};
