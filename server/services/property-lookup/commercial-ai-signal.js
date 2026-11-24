'use strict';

/**
 * The lookup's rule for the answer of its model on the use of a property:
 * the `propertyUse` and the `commercialUseType` of the satellite analysis.
 *
 * Two readers ask it, and both must give the same answer:
 * - the lookup itself (routes/property-lookup-v2.js): it is the last vote of
 *   detectCategory for the category the lookup saves;
 * - the plan-start proof (services/plan-start-eligibility.js), of an answer
 *   that a lead or an estimate kept in its payload.
 *
 * A use of COMMERCIAL or MIXED is a business. Else a use type is a business
 * when it is not one of the model's words for "no" and the pricing engine
 * normalizes it to commercial, or it is OTHER.
 */
const { normalizePropertyType } = require('../pricing-engine/commercial-helpers');

const NON_COMMERCIAL_USE_TYPES = ['NONE', 'UNKNOWN', 'RESIDENTIAL', 'NO', 'FALSE', 'N/A', 'NA', 'NOT_COMMERCIAL', 'NON_COMMERCIAL'];

function hasStructuredCommercialAiSignal(ai = {}) {
  const propertyUse = String(ai?.propertyUse || '').trim().toUpperCase();
  const commercialUseType = String(ai?.commercialUseType || '').trim().toUpperCase();
  if (['COMMERCIAL', 'MIXED'].includes(propertyUse)) return true;
  if (!commercialUseType || NON_COMMERCIAL_USE_TYPES.includes(commercialUseType)) {
    return false;
  }
  return commercialUseType === 'OTHER' || normalizePropertyType(commercialUseType) === 'commercial';
}

module.exports = { hasStructuredCommercialAiSignal };
