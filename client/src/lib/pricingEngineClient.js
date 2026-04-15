/**
 * pricingEngineClient — thin client wrapper around the server pricing engine.
 *
 * The server at POST /admin/pricing-config/estimate runs the modular engine
 * in server/services/pricing-engine/ with live DB-synced constants from the
 * 📐 Pricing Logic admin UI. All estimators (admin EstimatePage, public
 * estimate view, property lookup, tech portal, AI agents) should go through
 * this helper so there is one pricing source of truth.
 *
 * Input shape: matches modular engine's generateEstimate()
 *   {
 *     homeSqFt, stories, lotSqFt, lawnSqFt, bedArea,
 *     propertyType, features: { treeCount, hasPool, ... },
 *     zone: 'A' | 'B' | ... ,
 *     paymentMethod: 'card' | 'us_bank_account',
 *     promoDiscount: 0.05,
 *     services: {
 *       pest:       { frequency, roachType, version },
 *       lawn:       { track, tier, shadeClassification },
 *       treeShrub:  { tier, access, treeCount },
 *       palm:       { palmCount, treatmentType },
 *       mosquito:   { tier },
 *       termite:    { system, monitoringTier },
 *       rodentBait: true,
 *       // one-time + specialty flags...
 *     },
 *   }
 */
import { adminFetch } from './adminFetch';

export async function generateEstimate(input) {
  const { estimate } = await adminFetch('/admin/pricing-config/estimate', {
    method: 'POST',
    body: JSON.stringify(input || {}),
  });
  return estimate;
}

export async function quickQuote(input) {
  const { quote } = await adminFetch('/admin/pricing-config/quick-quote', {
    method: 'POST',
    body: JSON.stringify(input || {}),
  });
  return quote;
}

// Re-export formatters so callers don't need a second import
export { fmt, fmtInt } from './estimateEngine';
