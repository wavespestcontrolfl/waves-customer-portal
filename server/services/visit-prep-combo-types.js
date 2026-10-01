/**
 * Visit prep reads — which service_type labels are a COMBINED lawn + pest (or
 * tree & shrub + pest) service, e.g. "Quarterly Pest Control Service + Lawn
 * Care Service", "Lawn Care + Pest Control", "Pest and Lawn".
 *
 * Owner ruling 2026-09-30: a combined Lawn & Pest visit gets BOTH visit-prep
 * photo reads (the pest read and the lawn / tree & shrub read). Before this,
 * neither engine took such a label: isPestOnlyServiceType rejects it and the
 * plant applicability's other-line tokens exclude it.
 *
 * Kept as its own leaf module (no service dependencies beyond the two label
 * classifiers) so visit-prep-pest-applicability.js and
 * visit-prep-plant-applicability.js can both use it without a require cycle.
 *
 * A label is a combo only when it splits (on + & / , "and" "plus") into at
 * least one PEST part and at least one lawn / tree & shrub part:
 *   - "Lawn Pest Control" (a lawn-line product, no joiner) is NOT a combo;
 *   - "Tree & Shrub Pest Control" is NOT a combo (its only pest segment also
 *     names a plant line);
 *   - a label naming mosquito, termite, rodent, WDO or palm is NOT a combo
 *     ("Pest & Mosquito" is a pest + mosquito service, never lawn + pest).
 */
const { detectServiceCategory } = require('../utils/service-normalizer');

const EXCLUDED_LINE_RE = /mosquito|termite|rodent|wdo|\bpalms?\b/;
const JOINER_RE = /\s*(?:\+|&|\/|,|\band\b|\bplus\b)\s*/;
// A segment that names a plant line itself (so a "pest" word in it is the
// lawn-line product's, not a separate pest service).
const PLANT_WORD_RE = /\b(?:lawn|turf|sod|trees?|shrubs?|ornamentals?|palms?)\b/;

function normalizedLabel(serviceType) {
  return String(serviceType || '').toLowerCase().replace(/[_-]+/g, ' ');
}

function plantCategoryOfSegment(segment) {
  if (segment.includes('pest')) return null;
  const category = detectServiceCategory(segment);
  return category === 'lawn' || category === 'tree_shrub' ? category : null;
}

// 'lawn' | 'tree_shrub' | null. Lawn wins when the label names both, the same
// arbitrary order plantSubjectForTypes uses.
function comboSubjectForType(serviceType) {
  const raw = normalizedLabel(serviceType);
  if (!raw.includes('pest') || EXCLUDED_LINE_RE.test(raw)) return null;
  const segments = raw.split(JOINER_RE).map((s) => s.trim()).filter(Boolean);
  if (segments.length < 2) return null;
  const hasPestPart = segments.some((s) => s.includes('pest') && !PLANT_WORD_RE.test(s));
  if (!hasPestPart) return null;
  const plantCategories = segments.map(plantCategoryOfSegment).filter(Boolean);
  if (!plantCategories.length) return null;
  return plantCategories.includes('lawn') ? 'lawn' : 'tree_shrub';
}

function isComboServiceType(serviceType) {
  return comboSubjectForType(serviceType) !== null;
}

module.exports = { comboSubjectForType, isComboServiceType };
