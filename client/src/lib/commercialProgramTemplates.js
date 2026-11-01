// Starting points for the proposal builder's "Add program" chooser (owner 2026-10-29 "yes do phase 2"; visit counts
// corrected to the commercial engine, owner 2026-11-01 "fix all", audit fix 6). The visit counts are the engine's
// commercial programs (server/services/pricing-engine/constants.js programVisits): COMMERCIAL_PEST 12,
// COMMERCIAL_RODENT_BAIT 4, COMMERCIAL_TERMITE_BAIT 4, COMMERCIAL_MOSQUITO 9, COMMERCIAL_LAWN 8, COMMERCIAL_TREE_SHRUB 6.
// They are what priceCommercialPest / priceCommercialLawn / buildCommercialPestFamilyLine price with and what "Generate
// from estimate" fills, so a template row starts on the cadence the engine would quote. server/tests/
// commercial-program-templates-parity.test.js fails when a count here and the engine's differ. There is no template
// price: the engine prices a commercial program only when the building size is known, so the operator types the
// price. Staff can still edit each row's visits.
export const PROGRAM_TEMPLATES = [
  { service: 'pest', label: 'Pest control', frequencyPerYear: 12 },
  { service: 'rodent', label: 'Rodent control', frequencyPerYear: 4 },
  { service: 'termite', label: 'Termite monitoring', frequencyPerYear: 4 },
  { service: 'mosquito', label: 'Mosquito control', frequencyPerYear: 9 },
  { service: 'lawn', label: 'Lawn care', frequencyPerYear: 8 },
  { service: 'tree_shrub', label: 'Tree & shrub care', frequencyPerYear: 6 },
];
