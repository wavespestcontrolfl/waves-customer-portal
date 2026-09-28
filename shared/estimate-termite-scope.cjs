'use strict';

const TERMITE_SCOPE = Object.freeze({
  WDO: 'wdo_inspection',
  PRE_SLAB: 'pre_slab_termiticide',
  FOAM: 'termite_foam',
  RECURRING_FOAM: 'foam_recurring',
  TERMITE: 'termite',
});

function classifyTermiteScope(value) {
  const text = String(value || '').toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[_-]+/g, ' ');
  if (!text.trim()) return null;

  if (/\bwdo\b|wood\s+destroying/.test(text)) return TERMITE_SCOPE.WDO;
  if (/\bpre\s*slab\b|\bslab\s+pre\s*treat/.test(text)) return TERMITE_SCOPE.PRE_SLAB;

  // "termidor" and "foam" tolerate a missing separator ("TermidorFoam"), the
  // legacy engine label forms the replaced regexes accepted (Codex #5195 r1).
  const explicitTermite = /\btermites?\b|\btermiticide\b|\btermidor|\bbora\s*care\b|\bboracare\b|\bborates?\b|\btrelona\b/.test(text);
  // Termite foam is the ADJACENT form the schedule keeps verbatim ("Termite
  // Foam Treatment", "Termidor Foam", "TermidorFoam", "Termite Foaming"):
  // the same adjacency the replaced foam-label regex required, so "Termite
  // Treatment (Foam)" still normalizes like any termite treatment.
  if (/\b(?:termites?|termidor)\s*foam(?:ing)?/.test(text)) return TERMITE_SCOPE.FOAM;

  // Drill/recurring foam product names, checked BEFORE the generic termite
  // scope so "Drill-and-Foam Termite Treatment (Quarterly)" keeps the foam
  // scope the schedule preserves verbatim (pre-push audit P1 on ac72a01eab).
  // Historical forms omit "termite"; a rodent word rules those out (foam
  // sealant is rodent-exclusion material), while the forms themselves are
  // specific enough that "sealing" alone is not excluded ("Drill & Foam
  // Treatment – Seal Holes" stays termite work). Separators are optional:
  // "FoamRecurring", "RecurringFoam", "FoamDrill" and "DrillAndFoam" are
  // legacy engine-backed labels (Codex #5195 r1).
  const drillOrRecurringFoam = /\bfoam(?:ing)?\s*drill\b|\bdrill\s*(?:and\s*)?foam(?:ing)?\b|\brecurring\s*foam(?:ing)?\b|\bfoam(?:ing)?(?:\s+treatment)?\s*recurring\b/.test(text);
  const rodentWord = /\brodents?\b|\brats?\b|\bmice\b|\bmouse\b/.test(text);
  if (drillOrRecurringFoam && (explicitTermite || !rodentWord)) return TERMITE_SCOPE.RECURRING_FOAM;
  if (explicitTermite) return TERMITE_SCOPE.TERMITE;
  return null;
}

module.exports = { TERMITE_SCOPE, classifyTermiteScope };
