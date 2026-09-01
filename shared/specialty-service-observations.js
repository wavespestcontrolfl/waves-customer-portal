'use strict';

const SPECIALTY_SERVICE_OBSERVATIONS_BY_KEY = Object.freeze({
  dethatching: ['Full quoted area completed', 'Partial quoted area completed', 'Inspection only', 'Work deferred', 'Light debris removed', 'Moderate debris removed', 'Heavy debris removed', 'Debris consolidated onsite', 'Debris removal not included', 'Not applicable'],
  plugging: ['6-inch spacing', '9-inch spacing', '12-inch spacing', 'Mixed spacing per site conditions', 'Not installed', 'Full quoted area completed', 'Partial quoted area completed', 'Inspection only', 'Work deferred'],
  mosquito: ['No mosquito activity observed', 'Light mosquito activity', 'Moderate mosquito activity', 'Heavy mosquito activity', 'Customer-reported activity only', 'No standing-water source found', 'Removable standing water found', 'Breeding source could not be removed', 'Drainage or irrigation issue observed', 'Likely off-property pressure', 'Source not determined'],
  fire_ant: ['Active mounds observed', 'Foraging activity observed', 'Mounds and foraging activity observed', 'Customer-reported activity only', 'No active fire ants observed', 'Identification uncertain', 'One isolated area', 'Several localized areas', 'Scattered throughout property', 'Widespread activity', 'Unable to fully determine'],
  tick_control: ['Live tick observed', 'Multiple live ticks observed', 'Tick found on pet', 'Customer-reported tick activity', 'Evidence in monitoring device', 'No tick activity observed', 'Identification uncertain', 'Brown dog tick', 'American dog tick', 'Gulf Coast tick', 'Lone star tick', 'Other identified tick', 'Species not confirmed'],
  bee_wasp_removal: ['Paper wasp', 'Yellowjacket', 'Hornet', 'Honey bee', 'Carpenter bee', 'Other solitary wasp', 'Other wasp', 'Identification uncertain', 'Exposed paper nest', 'Enclosed structural void', 'Ground nest', 'Carpenter bee gallery', 'Honey bee swarm', 'Established honey bee colony', 'Flying activity with no nest located', 'Inactive or abandoned nest', 'Active', 'Light activity', 'Heavy activity', 'Inactive', 'Unable to confirm'],
  mud_dauber_removal: ['Active mud nests', 'Sealed nests; activity uncertain', 'Inactive or abandoned nests', 'Empty nest remnants', 'Mud dauber activity without completed nests', 'No current evidence observed', 'Identification uncertain', '1–3 nests', '4–10 nests', '11–20 nests', 'More than 20 nests', 'Exact count not practical'],
  bed_bug_treatment: ['Initial inspection', 'Initial treatment', 'Scheduled follow-up treatment', 'Post-treatment inspection', 'Callback or renewed activity inspection', 'Live adults', 'Live nymphs', 'Eggs', 'Cast skins', 'Fecal spotting', 'Bed bugs captured in monitor', 'Customer-reported bites only', 'Customer-reported sighting', 'No confirmed evidence', 'Evidence inconclusive', 'Preparation complete', 'Preparation mostly complete', 'Preparation partially complete', 'Preparation not completed', 'Preparation not required for this visit'],
});

const SPECIALTY_SERVICE_KEY_ALIASES = Object.freeze({
  mosquito_monthly: 'mosquito', mosquito_seasonal: 'mosquito', mosquito_one_time: 'mosquito',
  bed_bug: 'bed_bug_treatment',
});

function observationsForSpecialtyService(serviceKey) {
  const key = String(serviceKey || '').trim();
  return SPECIALTY_SERVICE_OBSERVATIONS_BY_KEY[SPECIALTY_SERVICE_KEY_ALIASES[key] || key] || [];
}

module.exports = { SPECIALTY_SERVICE_OBSERVATIONS_BY_KEY, observationsForSpecialtyService };
