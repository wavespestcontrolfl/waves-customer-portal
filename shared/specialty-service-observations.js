'use strict';

// Customer-report-safe values from the controlled specialty completion
// dropdowns. The client parity test requires every configured option to be
// present here; the completion endpoint rejects anything outside this set.
const SPECIALTY_SERVICE_OBSERVATIONS = Object.freeze([
  'Full quoted area completed', 'Partial quoted area completed', 'Inspection only', 'Work deferred',
  'Light debris removed', 'Moderate debris removed', 'Heavy debris removed', 'Debris consolidated onsite',
  'Debris removal not included', 'Not applicable', '6-inch spacing', '9-inch spacing', '12-inch spacing',
  'Mixed spacing per site conditions', 'Not installed',
  'No mosquito activity observed', 'Light mosquito activity', 'Moderate mosquito activity',
  'Heavy mosquito activity', 'Customer-reported activity only', 'No standing-water source found',
  'Removable standing water found', 'Breeding source could not be removed',
  'Drainage or irrigation issue observed', 'Likely off-property pressure', 'Source not determined',
  'Active mounds observed', 'Foraging activity observed', 'Mounds and foraging activity observed',
  'No active fire ants observed', 'Identification uncertain', 'One isolated area',
  'Several localized areas', 'Scattered throughout property', 'Widespread activity',
  'Unable to fully determine', 'Live tick observed', 'Multiple live ticks observed', 'Tick found on pet',
  'Customer-reported tick activity', 'Evidence in monitoring device', 'No tick activity observed',
  'Brown dog tick', 'American dog tick', 'Gulf Coast tick', 'Lone star tick',
  'Other identified tick', 'Species not confirmed', 'Paper wasp', 'Yellowjacket', 'Hornet', 'Honey bee',
  'Carpenter bee', 'Other solitary wasp', 'Other wasp', 'Identification uncertain',
  'Exposed paper nest', 'Enclosed structural void', 'Ground nest', 'Carpenter bee gallery',
  'Honey bee swarm', 'Established honey bee colony', 'Flying activity with no nest located',
  'Inactive or abandoned nest', 'Active', 'Light activity', 'Heavy activity', 'Inactive',
  'Unable to confirm', 'Active mud nests', 'Sealed nests; activity uncertain',
  'Inactive or abandoned nests', 'Empty nest remnants', 'Mud dauber activity without completed nests',
  'No current evidence observed', '1–3 nests', '4–10 nests', '11–20 nests', 'More than 20 nests',
  'Exact count not practical', 'Initial inspection', 'Initial treatment', 'Scheduled follow-up treatment',
  'Post-treatment inspection', 'Callback or renewed activity inspection', 'Live adults', 'Live nymphs',
  'Eggs', 'Cast skins', 'Fecal spotting', 'Bed bugs captured in monitor',
  'Customer-reported bites only', 'Customer-reported sighting', 'No confirmed evidence',
  'Evidence inconclusive', 'Preparation complete', 'Preparation mostly complete',
  'Preparation partially complete', 'Preparation not completed', 'Preparation not required for this visit',
]);

const SPECIALTY_SERVICE_OBSERVATION_SET = new Set(SPECIALTY_SERVICE_OBSERVATIONS);

module.exports = { SPECIALTY_SERVICE_OBSERVATIONS, SPECIALTY_SERVICE_OBSERVATION_SET };
