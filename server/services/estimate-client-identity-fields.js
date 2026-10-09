'use strict';

// Engine input keys that are SERVER-DERIVED only — recurring-customer
// identity (priorQualifyingServices, recurringCustomer…), transient catalog
// pricing, and the
// stored-estimate replay stamps (treeShrubPricingKnobs, termitePricingKnobs,
// rodent/palm/commercial replay signals). The authoritative replay paths
// inject them from the SAVED estimate row; a posted or model-supplied copy
// is never trusted. ONE list, one sanitizer: the persistence save path, the
// admin pricing sandbox and the Intelligence Bar estimate tools all read it
// from here, so a new posted-input door reuses this rather than growing its
// own denylist (pre-push audit #4424 P1).
const CLIENT_IDENTITY_FIELDS = Object.freeze([
  'priorQualifyingServices',
  'setupWaiverPriorQualifyingServices',
  'recurringCustomer',
  'isRecurringCustomer',
  'treeShrubPricingKnobs',
  'termitePricingKnobs',
  'palmAnnualRounding',
  'commercialFloorsArmedServices',
  'commercialFloorsArmed',
  'rodentBaitLegacyReplay',
  'rodentWaveguardPostureReplay',
  'catalogPricing',
  // The GATE_LAWN_V13 bahia review exemption: a stored estimate replayed as sold
  // (savedEstimateReplay), minus the service lines that same replay ADDS
  // (addedServiceKeys). Only the server replay branches set them.
  'savedEstimateReplay',
  'addedServiceKeys',
  // GATE_LAWN_COST_PLUS_LIST rollout state and its knob snapshot: written by the
  // engine's pricingMetadata stamp and injected by the saved-estimate replay.
  // A posted copy (here or as services.lawn.costPlusList) must never beat the gate.
  'lawnCostPlusList',
  'lawnCostPlusListBasis',
]);

// Deletes every server-owned field from `obj` IN PLACE (plain objects only;
// arrays and primitives pass through untouched) and returns it.
function sanitizeClientIdentityFields(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  for (const field of CLIENT_IDENTITY_FIELDS) delete obj[field];
  if (obj.services?.lawn && typeof obj.services.lawn === 'object' && 'costPlusList' in obj.services.lawn) {
    const { costPlusList: _posted, ...lawn } = obj.services.lawn;
    obj.services = { ...obj.services, lawn };
  }
  return obj;
}

module.exports = { CLIENT_IDENTITY_FIELDS, sanitizeClientIdentityFields };
