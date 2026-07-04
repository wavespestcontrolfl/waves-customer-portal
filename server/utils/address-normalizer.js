const DIRECTIONALS = new Set(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']);
const CITY_PREFIX_TOKENS = new Set(['st', 'lake', 'key', 'ridge']);
const UNIT_DESIGNATORS = new Set([
  'apt', 'apartment', 'bldg', 'building', 'fl', 'floor', 'lot', 'spc',
  'space', 'ste', 'suite', 'unit',
]);
// 'fl' the floor designator collides with FL the state — a ZIP-shaped value
// after 'fl' means "FL 34236" (state+ZIP tail), never a floor number.
const ZIP_SHAPED = /^\d{5}(-\d{4})?$/;
function isStateZipPair(designator, value) {
  return designator === 'fl' && ZIP_SHAPED.test(value);
}
const STREET_SUFFIX_ALIASES = {
  street: 'ST',
  st: 'ST',
  avenue: 'AVE',
  ave: 'AVE',
  road: 'RD',
  rd: 'RD',
  drive: 'DR',
  dr: 'DR',
  boulevard: 'BLVD',
  blvd: 'BLVD',
  lane: 'LN',
  ln: 'LN',
  court: 'CT',
  ct: 'CT',
  circle: 'CIR',
  cir: 'CIR',
  way: 'WAY',
  place: 'PL',
  pl: 'PL',
  terrace: 'TER',
  ter: 'TER',
  trail: 'TRL',
  trl: 'TRL',
  parkway: 'PKWY',
  pkwy: 'PKWY',
  highway: 'HWY',
  hwy: 'HWY',
  loop: 'LOOP',
  pass: 'PASS',
  path: 'PATH',
  run: 'RUN',
  walk: 'WALK',
  point: 'PT',
  pt: 'PT',
  cove: 'CV',
  cv: 'CV',
  beach: 'BCH',
  bch: 'BCH',
  harbor: 'HBR',
  hbr: 'HBR',
  shore: 'SHR',
  shores: 'SHRS',
  isle: 'ISLE',
  island: 'IS',
  islands: 'ISS',
  key: 'KY',
  keys: 'KYS',
  causeway: 'CSWY',
  cswy: 'CSWY',
  crossing: 'XING',
  xing: 'XING',
  plaza: 'PLZ',
  plz: 'PLZ',
  ridge: 'RDG',
  rdg: 'RDG',
  glen: 'GLN',
  glens: 'GLNS',
  green: 'GRN',
  greens: 'GRNS',
  grove: 'GRV',
  groves: 'GRVS',
  lake: 'LK',
  lakes: 'LKS',
  estate: 'EST',
  estates: 'ESTS',
  manor: 'MNR',
  manors: 'MNRS',
  village: 'VLG',
  villages: 'VLGS',
  vista: 'VIS',
  vis: 'VIS',
};
const COMPOUND_SUFFIX_PAIRS = new Set([
  'street:circle',
  'street:cir',
  'st:circle',
  'st:cir',
]);
const LEGACY_STREET_SPLIT_SUFFIXES = ['aly', 'alley'];
// Comma-free raw address splitting needs stronger boundary markers than display
// normalization; city-prone suffixes like harbor/beach/grove stay normalize-only.
const STREET_SPLIT_SUFFIX_ALIAS_KEYS = [
  'street', 'st',
  'avenue', 'ave',
  'road', 'rd',
  'drive', 'dr',
  'boulevard', 'blvd',
  'lane', 'ln',
  'court', 'ct',
  'circle', 'cir',
  'way',
  'place', 'pl',
  'terrace', 'ter',
  'trail', 'trl',
  'parkway', 'pkwy',
  'highway', 'hwy',
  'loop',
  'pass',
  'path',
  'run',
  'walk',
  'point', 'pt',
  'cove', 'cv',
  'causeway', 'cswy',
  'crossing', 'xing',
  'plaza', 'plz',
  'ridge', 'rdg',
  'glen', 'gln',
];
const STREET_SPLIT_SUFFIXES = new Set([
  ...STREET_SPLIT_SUFFIX_ALIAS_KEYS.flatMap((key) => [key, STREET_SUFFIX_ALIASES[key]?.toLowerCase()].filter(Boolean)),
  ...LEGACY_STREET_SPLIT_SUFFIXES,
]);
const US_STATE_ABBREVIATIONS = {
  alabama: 'AL',
  alaska: 'AK',
  arizona: 'AZ',
  arkansas: 'AR',
  california: 'CA',
  colorado: 'CO',
  connecticut: 'CT',
  delaware: 'DE',
  florida: 'FL',
  georgia: 'GA',
  hawaii: 'HI',
  idaho: 'ID',
  illinois: 'IL',
  indiana: 'IN',
  iowa: 'IA',
  kansas: 'KS',
  kentucky: 'KY',
  louisiana: 'LA',
  maine: 'ME',
  maryland: 'MD',
  massachusetts: 'MA',
  michigan: 'MI',
  minnesota: 'MN',
  mississippi: 'MS',
  missouri: 'MO',
  montana: 'MT',
  nebraska: 'NE',
  nevada: 'NV',
  'new hampshire': 'NH',
  'new jersey': 'NJ',
  'new mexico': 'NM',
  'new york': 'NY',
  'north carolina': 'NC',
  'north dakota': 'ND',
  ohio: 'OH',
  oklahoma: 'OK',
  oregon: 'OR',
  pennsylvania: 'PA',
  'rhode island': 'RI',
  'south carolina': 'SC',
  'south dakota': 'SD',
  tennessee: 'TN',
  texas: 'TX',
  utah: 'UT',
  vermont: 'VT',
  virginia: 'VA',
  washington: 'WA',
  'west virginia': 'WV',
  wisconsin: 'WI',
  wyoming: 'WY',
};
const US_STATE_CODES = new Set(Object.values(US_STATE_ABBREVIATIONS));
const STATE_TOKENS = [
  ...Object.keys(US_STATE_ABBREVIATIONS),
  ...US_STATE_CODES,
].sort((a, b) => b.length - a.length);

function cleanString(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseJsonMaybe(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function titleToken(token) {
  if (!token) return token;
  const bare = token.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
  if (DIRECTIONALS.has(bare)) return token.toUpperCase();
  const ordinal = token.match(/^(\d+)(st|nd|rd|th)$/i);
  if (ordinal) return `${ordinal[1]}${ordinal[2].toLowerCase()}`;
  return token
    .toLowerCase()
    .replace(/(^|[-'])([a-z])/g, (_, prefix, c) => `${prefix}${c.toUpperCase()}`);
}

function titleCaseWords(value) {
  return cleanString(value)
    .split(' ')
    .filter(Boolean)
    .map(titleToken)
    .join(' ');
}

function normalizeStreetLine(value) {
  const tokens = titleCaseWords(value).split(' ').filter(Boolean);
  if (!tokens.length) return '';

  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    const key = tokens[i].replace(/[.,]/g, '').toLowerCase();
    const alias = STREET_SUFFIX_ALIASES[key];
    if (!alias) continue;

    const tail = tokens.slice(i + 1);
    const suffixIsTerminal = tail.length === 0;
    const suffixBeforeDirection = tail.length > 0 && tail.every((token) => DIRECTIONALS.has(token.replace(/[.,]/g, '').toLowerCase()));
    const nextToken = tail[0]?.replace(/[.,]/g, '').toLowerCase() || '';
    const suffixBeforeUnit = !!tail[0] && (tail[0].startsWith('#') || UNIT_DESIGNATORS.has(nextToken));
    if (!suffixIsTerminal && !suffixBeforeDirection && !suffixBeforeUnit) continue;

    tokens[i] = titleToken(alias);
    for (let j = i - 1; j >= 0; j -= 1) {
      const compoundKey = tokens[j].replace(/[.,]/g, '').toLowerCase();
      const nextKey = tokens[j + 1]?.replace(/[.,]/g, '').toLowerCase();
      const compoundAlias = STREET_SUFFIX_ALIASES[compoundKey];
      if (!compoundAlias || !COMPOUND_SUFFIX_PAIRS.has(`${compoundKey}:${nextKey}`)) break;
      tokens[j] = titleToken(compoundAlias);
    }
    break;
  }

  return tokens.join(' ');
}

function normalizeState(value) {
  const state = cleanString(value).replace(/[.,]/g, '').toUpperCase();
  if (!state) return '';
  if (US_STATE_CODES.has(state)) return state;
  return US_STATE_ABBREVIATIONS[state.toLowerCase()] || '';
}

function findState(value) {
  const text = cleanString(value).replace(/[.,]/g, ' ');
  if (!text) return { raw: '', state: '' };
  for (const token of STATE_TOKENS) {
    const match = text.match(new RegExp(`\\b${escapeRegExp(token)}\\b`, 'i'));
    if (match) return { raw: match[0], state: normalizeState(token) };
  }
  return { raw: '', state: '' };
}

function findTrailingState(value) {
  const text = cleanString(value).replace(/[.,]\s*$/, '');
  if (!text) return { raw: '', state: '' };
  for (const token of STATE_TOKENS) {
    const match = text.match(new RegExp(`(?:^|\\s)(${escapeRegExp(token)})$`, 'i'));
    if (match) return { raw: match[1], state: normalizeState(token) };
  }
  return { raw: '', state: '' };
}

function removeState(value, stateMatch) {
  if (!stateMatch?.raw) return value;
  return String(value).replace(new RegExp(`\\b${escapeRegExp(stateMatch.raw)}\\b`, 'i'), '');
}

function normalizeZip(value) {
  const matches = cleanString(value).match(/\b\d{5}(?:-\d{4})?\b/g);
  return matches?.length ? matches[matches.length - 1] : '';
}

function normalizeUnitToken(token) {
  return /^[A-Za-z]?\d+[A-Za-z]?$/.test(token) ? token.toUpperCase() : titleToken(token);
}

// Second address line (unit / apt / suite). Kept separate from line1 so the
// street line stays clean for geocoding and house-number parcel matching. A
// bare value ("4B", "#12") gains a "Unit" designator; a value that already
// leads with one keeps it, title-cased. '#' is decoration, not unit identity
// — "Apt #4", "#4", and "Apt 4" all mean unit 4 — so it's stripped globally
// to keep stored values comparable across notations.
function normalizeUnitLine(value) {
  const cleaned = cleanString(value).replace(/[#,]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60).trim();
  if (!cleaned) return '';
  const tokens = cleaned.split(' ').filter(Boolean);
  const firstKey = tokens[0].replace(/\./g, '').toLowerCase();
  if (UNIT_DESIGNATORS.has(firstKey)) {
    return [titleToken(firstKey), ...tokens.slice(1).map(normalizeUnitToken)].join(' ');
  }
  return ['Unit', ...tokens.map(normalizeUnitToken)].join(' ');
}

// Canonical form per designator. The dwelling designators (apt / apartment /
// unit / ste / suite) are interchangeable across notations ("Apt 4" =
// "Unit 4" = "#4") and canonicalize to 'unit'. Structural designators are
// NOT interchangeable with dwellings — Bldg 2 is a different door than
// Apt 2 — but their own long/short spellings are the same thing
// (Building 2 = Bldg 2, Floor 2 = Fl 2, Space 7 = Spc 7).
const UNIT_DESIGNATOR_CANONICAL = {
  apt: 'unit', apartment: 'unit', unit: 'unit', ste: 'unit', suite: 'unit',
  bldg: 'bldg', building: 'bldg',
  fl: 'fl', floor: 'fl',
  spc: 'spc', space: 'spc',
  lot: 'lot',
};

// Comparison key for a NORMALIZED unit line: a lone dwelling designator is
// dropped ("Apt 4B" / "Unit 4B" → "4b"); structural designators stay, alias-
// canonicalized ("Building 2" / "Bldg 2" → "bldg 2"). Multi-token units keep
// their full shape so "Bldg 2 Apt 4" never collides with "Apt 4".
function unitLineValueKey(normalizedUnitLine) {
  const tokens = String(normalizedUnitLine || '').toLowerCase().split(' ').filter(Boolean)
    .map((token) => UNIT_DESIGNATOR_CANONICAL[token] || token);
  return tokens.length === 2 && tokens[0] === 'unit' ? tokens[1] : tokens.join(' ');
}

// Split a street line into its street part and a trailing inline unit —
// "123 Main St Apt A" → { street: '123 Main St', unit: 'Apt A' }, and
// multi-part units peel fully: "123 Main St Bldg 2 Apt 4" →
// { street: '123 Main St', unit: 'Bldg 2 Apt 4' }. Legacy records stored
// units inline in address_line1 before dedicated unit capture existed.
// Conservative on purpose: only trailing "<designator> <unit-ish value>"
// pairs or a trailing "#<value>" token peel, so street names that contain
// designator words ("4501 Space Coast Blvd") stay intact — and the remaining
// street must still lead with a house number, so a line that is ONLY units
// never splits down to a nonsense street.
function splitStreetLineUnit(value) {
  const segments = cleanString(value).split(',').map((s) => s.trim()).filter(Boolean);
  let line = segments[0] || '';
  // Legacy values often carry the unit as its own comma segment — possibly
  // several ("123 Main St, Bldg 2, Apt 4, Sarasota") — pull consecutive
  // unit-leading segments back into the line so the peel below sees them
  // instead of treating the record as street-only. A "FL <zip>" segment is a
  // state tail, not a floor.
  for (let i = 1; i < segments.length; i += 1) {
    const segTokens = segments[i].split(' ').filter(Boolean);
    const firstTok = (segTokens[0] || '').replace(/\./g, '').toLowerCase();
    const isUnitSegment = (firstTok.startsWith('#') || UNIT_DESIGNATORS.has(firstTok))
      && !isStateZipPair(firstTok, (segTokens[1] || '').replace(/[.,]/g, ''));
    if (!isUnitSegment) break;
    line = `${line} ${segments[i]}`;
  }
  let tokens = line.split(' ').filter(Boolean);
  const unitParts = [];
  while (tokens.length >= 2) {
    const last = tokens[tokens.length - 1].replace(/[.,]/g, '');
    const secondLast = tokens[tokens.length - 2].replace(/[.,]/g, '').toLowerCase();
    if (/^#\S+$/.test(last)) {
      // "Apt #4" — the designator belongs to the unit, not the street.
      if (UNIT_DESIGNATORS.has(secondLast)) {
        unitParts.unshift(`${tokens[tokens.length - 2]} ${last}`);
        tokens = tokens.slice(0, -2);
      } else {
        unitParts.unshift(last);
        tokens = tokens.slice(0, -1);
      }
      continue;
    }
    if (tokens.length >= 3 && UNIT_DESIGNATORS.has(secondLast)
        && !isStateZipPair(secondLast, last)
        && /^#?[A-Za-z]?\d+[A-Za-z]?$|^[A-Za-z]$/.test(last)) {
      unitParts.unshift(`${tokens[tokens.length - 2]} ${last}`);
      tokens = tokens.slice(0, -2);
      continue;
    }
    break;
  }
  if (!unitParts.length || !/^\d/.test(tokens[0] || '')) return { street: segments[0] || '', unit: '' };
  return { street: tokens.join(' '), unit: unitParts.join(' ') };
}

function splitStreetAndCity(value) {
  const tokens = cleanString(value).split(' ').filter(Boolean);
  if (tokens.length < 2) return { line1: value, city: '' };

  const suffixIndices = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i].replace(/[.,]/g, '').toLowerCase();
    if (STREET_SPLIT_SUFFIXES.has(token)) {
      suffixIndices.push(i);
    }
  }
  const eligibleSuffixIndices = suffixIndices.filter((index) => index < tokens.length - 1);
  let suffixPosition = eligibleSuffixIndices.length - 1;
  while (suffixPosition > 0) {
    const selectedSuffix = tokens[eligibleSuffixIndices[suffixPosition]]?.replace(/[.,]/g, '').toLowerCase();
    if (!CITY_PREFIX_TOKENS.has(selectedSuffix)) break;
    suffixPosition -= 1;
  }
  const suffixIndex = eligibleSuffixIndices[suffixPosition] ?? -1;

  if (suffixIndex >= 0 && suffixIndex < tokens.length - 1) {
    const tail = tokens.slice(suffixIndex + 1);
    const rawFirstTailToken = tail[0].replace(/[.,]/g, '').toLowerCase();
    const firstTailToken = rawFirstTailToken.replace(/^#/, '');
    const unitTokenCount = rawFirstTailToken.startsWith('#') && rawFirstTailToken.length > 1 ? 1 : 2;
    if ((rawFirstTailToken.startsWith('#') || UNIT_DESIGNATORS.has(firstTailToken)) && tail.length >= unitTokenCount) {
      const cityIndex = suffixIndex + 1 + unitTokenCount;
      return {
        line1: tokens.slice(0, cityIndex).join(' '),
        city: tokens.slice(cityIndex).join(' '),
      };
    }

    return {
      line1: tokens.slice(0, suffixIndex + 1).join(' '),
      city: tail.join(' '),
    };
  }

  return { line1: value, city: '' };
}

function parseRawAddress(raw) {
  const cleaned = cleanString(raw).replace(/\s*,\s*/g, ', ');
  if (!cleaned) return {};

  const withoutCountry = cleaned.replace(/,\s*(USA|United States)$/i, '').trim();
  const parts = withoutCountry.split(',').map(p => cleanString(p)).filter(Boolean);
  let line1 = '';
  let city = '';
  let state = '';
  let zip = '';

  if (parts.length >= 3) {
    // Consecutive unit segments after the street all belong to line1
    // ("123 Main St, Bldg 2, Apt 4, Sarasota, FL 34236") — never the city.
    // A "FL <zip>" segment is the state tail, not a floor.
    let unitEnd = 1;
    while (unitEnd < parts.length) {
      const segTokens = parts[unitEnd].split(' ').filter(Boolean);
      const firstTok = (segTokens[0] || '').replace(/[.,]/g, '').toLowerCase();
      const isUnitSegment = (firstTok.startsWith('#') || UNIT_DESIGNATORS.has(firstTok.replace(/^#/, '')))
        && !isStateZipPair(firstTok, (segTokens[1] || '').replace(/[.,]/g, ''));
      if (!isUnitSegment) break;
      unitEnd += 1;
    }
    line1 = parts.slice(0, unitEnd).join(' ');
    city = parts[unitEnd] || '';
    const stateZip = parts.slice(unitEnd + 1).join(' ');
    zip = normalizeZip(stateZip);
    state = findState(stateZip).state;
  } else if (parts.length === 2) {
    line1 = parts[0];
    const tail = parts[1];
    zip = normalizeZip(tail);
    const stateMatch = findState(tail);
    state = stateMatch.state;
    let cityTail = zip ? tail.replace(zip, '') : tail;
    cityTail = removeState(cityTail, stateMatch);
    city = cleanString(cityTail.replace(/,/g, ''));
  } else {
    let remainder = withoutCountry;
    zip = normalizeZip(remainder);
    if (zip) remainder = cleanString(remainder.replace(zip, ''));
    const stateMatch = findTrailingState(remainder);
    if (stateMatch.state) {
      state = stateMatch.state;
      remainder = cleanString(removeState(remainder, stateMatch));
    }
    const split = splitStreetAndCity(remainder);
    line1 = split.line1;
    city = split.city;
  }

  return {
    line1: normalizeStreetLine(line1),
    city: titleCaseWords(city),
    state: state || '',
    zip,
  };
}

function normalizeLeadAddress(input = {}) {
  const components = parseJsonMaybe(input.components || input.addressComponents || input.address_components) || {};
  const raw = cleanString(input.raw || input.address || components.formatted);
  const parsed = parseRawAddress(raw);

  let line1 = normalizeStreetLine(input.line1 || input.addressLine1 || input.address_line1 || components.line1 || parsed.line1);
  const rawLine2 = normalizeUnitLine(
    input.line2 || input.addressLine2 || input.address_line2 || input.unit || components.line2 || components.unit
  );
  // A raw/fallback submission can carry the unit inline in line1 AND in the
  // dedicated field. Keep the DEDICATED field and strip the inline copy —
  // downstream consumers (parcel lookup, customer creation) need a street-only
  // line1 with the unit in line2, not the reverse. Compare by unit VALUE, not
  // display text: "Apt 4" inline and a "#4" field are the same unit. An
  // inline duplicate that can't be cleanly peeled falls back to dropping
  // line2 so the rendered address still never repeats it.
  const inlineSplit = splitStreetLineUnit(line1);
  let line2 = rawLine2;
  let unitConflict = false;
  if (rawLine2 && inlineSplit.unit) {
    if (unitLineValueKey(normalizeUnitLine(inlineSplit.unit)) === unitLineValueKey(rawLine2)) {
      line1 = inlineSplit.street;
    } else {
      // Inline and dedicated units DISAGREE — a contradictory service
      // address must never be stored, so the normalized shape keeps only the
      // inline value (line1 as submitted, line2 empty) and raises the flag
      // for interactive callers to fail closed on.
      unitConflict = true;
      line2 = '';
    }
  } else if (rawLine2 && line1.toLowerCase().includes(rawLine2.toLowerCase())) {
    line2 = '';
  }
  const city = titleCaseWords(input.city || components.city || parsed.city);
  const state = normalizeState(input.state || components.state || parsed.state || 'FL') || 'FL';
  const zip = normalizeZip(input.zip || components.zip || parsed.zip);
  const placeId = cleanString(input.placeId || input.googlePlaceId || input.google_place_id || components.placeId);

  const stateZip = (city || zip)
    ? [state, zip].filter(Boolean).join(' ')
    : '';
  const fullAddress = [line1, line2, city, stateZip].filter(Boolean).join(', ');

  return {
    raw,
    line1,
    line2,
    city,
    state,
    zip,
    placeId,
    fullAddress,
    unitConflict,
  };
}

// Build a single-line display address from already-parsed parts, dropping any
// empty piece so a missing zip never renders as "Sarasota, FL null" and a
// missing city never leaves a dangling comma ("123 Main St, , FL 34231").
// State + zip stay glued together ("FL 34231"); everything else is comma-joined.
function formatAddress(parts = {}) {
  const clean = (value) => (value == null ? '' : String(value).trim());
  const region = [clean(parts.state), clean(parts.zip)].filter(Boolean).join(' ');
  return [clean(parts.line1), clean(parts.city), region].filter(Boolean).join(', ');
}

module.exports = {
  normalizeLeadAddress,
  formatAddress,
  normalizeStreetLine,
  normalizeUnitLine,
  unitLineValueKey,
  splitStreetLineUnit,
  titleCaseWords,
  normalizeState,
  parseRawAddress,
  STREET_SUFFIX_ALIASES,
  UNIT_DESIGNATORS,
};
