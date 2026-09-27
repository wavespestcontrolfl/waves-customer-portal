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

  const explicitTermite = /\btermites?\b|\btermiticide\b|\btermidor\b|\bbora\s*care\b|\bboracare\b|\bborates?\b|\btrelona\b/.test(text);
  if (explicitTermite && /\bfoam\b/.test(text)) return TERMITE_SCOPE.FOAM;
  if (explicitTermite) return TERMITE_SCOPE.TERMITE;

  // Historical drill/recurring foam product names omit "termite." Keep this
  // narrow so rodent exclusion foam and sealant never become termite work.
  const rodentSealant = /\brodents?\b|\brats?\b|\bmice\b|\bmouse\b|\bseal(?:ant|ing)?\b/.test(text);
  if (rodentSealant) return null;
  if (/\bfoam\s+drill\b|\bdrill\s+(?:and\s+)?foam\b|\brecurring\s+foam\b|\bfoam(?:\s+treatment)?\s+recurring\b/.test(text)) {
    return TERMITE_SCOPE.RECURRING_FOAM;
  }
  return null;
}

module.exports = { TERMITE_SCOPE, classifyTermiteScope };
