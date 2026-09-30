const db = require('../models/db');

async function activeVariants(templateKey) {
  try {
    return await db('sms_template_variants')
      .where({ template_key: templateKey, status: 'active' })
      .orderBy('created_at', 'asc');
  } catch (err) {
    if (/does not exist|sms_template_variants/i.test(err.message)) return [];
    throw err;
  }
}

function pickWeightedVariant(variants, random = Math.random) {
  const active = (variants || []).filter((variant) => Number(variant.weight || 0) > 0);
  if (!active.length) return null;
  const total = active.reduce((sum, variant) => sum + Number(variant.weight || 0), 0);
  let cursor = random() * total;
  for (const variant of active) {
    cursor -= Number(variant.weight || 0);
    if (cursor <= 0) return variant;
  }
  return active[active.length - 1];
}

async function selectVariant(templateKey, options = {}) {
  const variants = await activeVariants(templateKey);
  return pickWeightedVariant(variants, options.random);
}

module.exports = {
  activeVariants,
  pickWeightedVariant,
  selectVariant,
};
