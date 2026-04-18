// ============================================================
// index.js — Waves Pricing Engine Public API
// ============================================================
const constants = require('./constants');
const propertyCalculator = require('./property-calculator');
const servicePricing = require('./service-pricing');
const discountEngine = require('./discount-engine');
const { generateEstimate, quickQuote } = require('./estimate-engine');
const { syncConstantsFromDB, needsSync, invalidatePricingConfigCache } = require('./db-bridge');
const modifiers = require('./modifiers');

module.exports = {
  // Main entry points
  generateEstimate,
  quickQuote,

  // Individual service pricing (for admin tools, calculators)
  ...servicePricing,

  // Property calculations
  ...propertyCalculator,

  // Discount engine
  ...discountEngine,

  // DB bridge — syncs admin-edited pricing config into engine constants
  syncConstantsFromDB,
  needsSync,
  invalidatePricingConfigCache,

  // Property-driven modifiers (v2 port) — expose for admin tools
  modifiers,
  deriveModifiers: modifiers.deriveModifiers,
  deriveNotes: modifiers.deriveNotes,

  // Constants (for admin UI editing)
  constants,
};
