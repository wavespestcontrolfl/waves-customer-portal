// The fertilizer safety block of the v13 lawn program (owner 2026-10-06), in ONE place. A staged
// protocol row that carries gates.fertilizerSafety = true (every N-carrying spreader row, migration
// 20261007159000) makes its window an N visit; the job card procedure and the wiki-synced SOP both
// print this block for such a window, and say nothing for a window with no such row (hose visits).
// The recipe file keeps its own short track-level lines for the reference tab.
const FERTILIZER_SAFETY_GATE = 'fertilizerSafety';

const PRE_APPLICATION_MAP_RULE = 'Before applying, check the property\'s shared lawn/bed fertilizer map and keep each product in its recorded area.';
const NORTH_PORT_FALLBACK_RULE = 'North Port exception: its turf nitrogen/phosphorus restriction starts April 1, not June 1, and runs through September 30; also keep fertilizer out of wetlands and their 25 ft buffers, swale flow channels, and the 10 ft water setback.';

const FERTILIZER_SAFETY_RULES = [
  'Use the deflector shield on the rotary spreader.',
  'Keep a 10 ft fertilizer-free band from any water body, wetland, seawall or top of bank.',
  'Do not fertilize when a severe thunderstorm, flood or tropical watch or warning is forecast.',
  'Sweep fertilizer off driveways, sidewalks and streets back onto the lawn.',
  PRE_APPLICATION_MAP_RULE,
  NORTH_PORT_FALLBACK_RULE,
  'Keep the Manatee BMP decal on the vehicle.',
];

const SARASOTA_FERTILIZER_SAFETY_RULES = [
  'Use the deflector shield on the rotary spreader.',
  'Sarasota County rule: do not apply fertilizer containing nitrogen or phosphorus to turf or landscape plants from June 1 through September 30.',
  'Keep a 10 ft fertilizer-free band from any water body, wetland, seawall or top of bank.',
  'Do not fertilize when a severe thunderstorm, flood or tropical watch or warning is forecast.',
  'Sweep fertilizer off driveways, sidewalks and streets back onto the lawn.',
  PRE_APPLICATION_MAP_RULE,
];

// City of North Port fertilizer fact sheet, revised May 10, 2023:
// https://www.northportfl.gov/files/assets/main/v/1/city-services-amp-safety/public-works/fertilizer-fact-sheet-updated.pdf
const NORTH_PORT_FERTILIZER_SETBACKS = [
  'Keep fertilizer at least 10 ft from a pond, stream, canal or top of a seawall. If a pond\'s water edge is more than 10 ft from the top of bank, stop at the top of bank.',
  'Do not apply fertilizer in a wetland, within the wetland\'s 25 ft buffer, or in the flow channel of any swale.',
];
const NORTH_PORT_FERTILIZER_SAFETY_RULES = [
  'Use the deflector shield on the rotary spreader.',
  'North Port rule: do not apply fertilizer containing nitrogen or phosphorus to turf from April 1 through September 30; landscape plants are outside this seasonal turf restriction.',
  ...NORTH_PORT_FERTILIZER_SETBACKS,
  'Do not fertilize when a severe thunderstorm, flood or tropical watch or warning is forecast.',
  'Sweep fertilizer off driveways, sidewalks and streets back onto the lawn.',
  PRE_APPLICATION_MAP_RULE,
];

function gatesOf(row) {
  const gates = row?.gates;
  if (typeof gates === 'string') {
    try { return JSON.parse(gates) || {}; } catch { return {}; }
  }
  return gates && typeof gates === 'object' ? gates : {};
}

const isNorthPort = (value) => /\bnorth\s*port\b/i.test(String(value || ''));
const isSarasotaArea = ({ municipality, county } = {}) => /\bsarasota\b/i.test(String(county || ''))
  || /\b(?:sarasota|venice|nokomis|osprey|englewood)\b/i.test(String(municipality || ''));

// The block for a window's protocol rows: the rules when any row is gated, else none. A property-aware
// field card gets its city/county wording; SOP readers with no property context keep the generic block,
// whose explicit North Port exception prevents the June 1 county date from being applied there.
function fertilizerSafetyRules(rows, area = {}) {
  if (!(rows || []).some((row) => gatesOf(row)[FERTILIZER_SAFETY_GATE] === true)) return [];
  if (isNorthPort(area.municipality)) return NORTH_PORT_FERTILIZER_SAFETY_RULES;
  if (isSarasotaArea(area)) return SARASOTA_FERTILIZER_SAFETY_RULES;
  return FERTILIZER_SAFETY_RULES;
}

module.exports = {
  NORTH_PORT_FERTILIZER_SETBACKS,
  FERTILIZER_SAFETY_GATE,
  FERTILIZER_SAFETY_RULES,
  NORTH_PORT_FERTILIZER_SAFETY_RULES,
  SARASOTA_FERTILIZER_SAFETY_RULES,
  fertilizerSafetyRules,
};
