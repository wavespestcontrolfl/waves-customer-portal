// ============================================================
// index.js — Waves Pricing Engine Public API
// ============================================================
const constants = require('./constants');
const propertyCalculator = require('./property-calculator');
const servicePricing = require('./service-pricing');
const discountEngine = require('./discount-engine');
const { generateEstimate, quickQuote } = require('./estimate-engine');
const { syncConstantsFromDB, needsSync } = require('./db-bridge');

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

  // Constants (for admin UI editing)
  constants,
};
