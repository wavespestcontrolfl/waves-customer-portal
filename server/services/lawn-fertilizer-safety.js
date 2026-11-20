const { fertilizerJurisdictionId } = require('../config/address-county');

// The fertilizer safety block of the v13 lawn program (owner 2026-10-06), in ONE place. A staged
// protocol row that carries gates.fertilizerSafety = true (every N-carrying spreader row, migration
// 20261007159000) makes its window an N visit; the job card procedure and the wiki-synced SOP both
// print this block for such a window, and say nothing for a window with no such row (hose visits).
// The recipe file keeps its own short track-level lines for the reference tab.
const FERTILIZER_SAFETY_GATE = 'fertilizerSafety';

const PRE_APPLICATION_MAP_RULE = 'Before applying, check the property\'s shared lawn/bed fertilizer map and keep each product in its recorded area.';
const NORTH_PORT_FALLBACK_RULE = 'North Port exception: its turf nitrogen/phosphorus restriction starts April 1, not June 1, and runs through September 30; also keep fertilizer out of wetlands and their 25 ft buffers, swale flow channels, and the 10 ft water setback.';

const DEFLECTOR_RULE = 'Use the deflector shield on the rotary spreader.';
const WATER_BUFFER_RULE = 'Keep a 10 ft fertilizer-free band from any water body, wetland, seawall or top of bank.';
const CLEANUP_AND_WEATHER_RULES = [
  'Do not fertilize when a severe thunderstorm, flood or tropical watch or warning is forecast.',
  'Sweep fertilizer off driveways, sidewalks and streets back onto the lawn.',
  PRE_APPLICATION_MAP_RULE,
];
const MANATEE_DECAL_RULE = 'In Manatee County, display the Manatee BMP decal or a recognized equivalent on the vehicle.';

const FERTILIZER_SAFETY_RULES = [
  DEFLECTOR_RULE, WATER_BUFFER_RULE, ...CLEANUP_AND_WEATHER_RULES,
  'Confirm the fertilizer rules for the service property before applying.',
  NORTH_PORT_FALLBACK_RULE, MANATEE_DECAL_RULE,
];

function countySafetyRules(county) {
  return [
    DEFLECTOR_RULE,
    `${county} County restricts fertilizers containing nitrogen or phosphorus on turf and landscape plants from June 1 through September 30.`,
    WATER_BUFFER_RULE,
    ...CLEANUP_AND_WEATHER_RULES,
  ];
}

const SARASOTA_FERTILIZER_SAFETY_RULES = countySafetyRules('Sarasota');
const MANATEE_FERTILIZER_SAFETY_RULES = [...countySafetyRules('Manatee'), MANATEE_DECAL_RULE];
const CHARLOTTE_FERTILIZER_SAFETY_RULES = countySafetyRules('Charlotte');

// City of North Port fertilizer fact sheet, revised May 10, 2023:
// https://www.northportfl.gov/files/assets/main/v/1/city-services-amp-safety/public-works/fertilizer-fact-sheet-updated.pdf
const NORTH_PORT_FERTILIZER_SETBACKS = [
  'Keep fertilizer at least 10 ft from a pond, stream, canal or top of a seawall. If a pond\'s water edge is more than 10 ft from the top of bank, stop at the top of bank.',
  'Do not apply fertilizer in a wetland, within the wetland\'s 25 ft buffer, or in the flow channel of any swale.',
];
const NORTH_PORT_FERTILIZER_SAFETY_RULES = [
  DEFLECTOR_RULE,
  'North Port rule: do not apply fertilizer containing nitrogen or phosphorus to turf from April 1 through September 30; landscape plants are outside this seasonal turf restriction.',
  ...NORTH_PORT_FERTILIZER_SETBACKS,
  ...CLEANUP_AND_WEATHER_RULES,
];

const RULES_BY_JURISDICTION = {
  north_port_fl: NORTH_PORT_FERTILIZER_SAFETY_RULES,
  sarasota_county_fl: SARASOTA_FERTILIZER_SAFETY_RULES,
  manatee_county_fl: MANATEE_FERTILIZER_SAFETY_RULES,
  charlotte_county_fl: CHARLOTTE_FERTILIZER_SAFETY_RULES,
  generic_swfl: FERTILIZER_SAFETY_RULES,
};

function gatesOf(row) {
  const gates = row?.gates;
  if (typeof gates === 'string') {
    try { return JSON.parse(gates) || {}; } catch { return {}; }
  }
  return gates && typeof gates === 'object' ? gates : {};
}

// The block for a window's protocol rows: the rules when any row is gated, else none. A property-aware
// field card gets its city/county wording; SOP readers with no property context keep the generic block,
// whose explicit North Port exception prevents the June 1 county date from being applied there.
function fertilizerSafetyRules(rows, area = {}) {
  if (!(rows || []).some((row) => gatesOf(row)[FERTILIZER_SAFETY_GATE] === true)) return [];
  return RULES_BY_JURISDICTION[fertilizerJurisdictionId({ city: area.municipality, county: area.county })];
}

module.exports = {
  NORTH_PORT_FERTILIZER_SETBACKS,
  FERTILIZER_SAFETY_GATE,
  FERTILIZER_SAFETY_RULES,
  NORTH_PORT_FERTILIZER_SAFETY_RULES,
  SARASOTA_FERTILIZER_SAFETY_RULES,
  fertilizerSafetyRules,
};
