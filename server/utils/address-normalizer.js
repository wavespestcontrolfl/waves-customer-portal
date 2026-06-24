const DIRECTIONALS = new Set(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']);
const CITY_PREFIX_TOKENS = new Set(['st', 'lake', 'key', 'ridge']);
const UNIT_DESIGNATORS = new Set([
  'apt', 'apartment', 'bldg', 'building', 'fl', 'floor', 'lot', 'spc',
  'space', 'ste', 'suite', 'unit',
]);
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
    const rawPossibleUnit = parts[1].split(' ')[0].replace(/[.,]/g, '').toLowerCase();
    const possibleUnit = rawPossibleUnit.replace(/^#/, '');
    const hasUnitPart = rawPossibleUnit.startsWith('#') || UNIT_DESIGNATORS.has(possibleUnit);
    line1 = hasUnitPart ? `${parts[0]} ${parts[1]}` : parts[0];
    city = hasUnitPart ? parts[2] : parts[1];
    const stateZip = parts.slice(hasUnitPart ? 3 : 2).join(' ');
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

  const line1 = normalizeStreetLine(input.line1 || input.addressLine1 || input.address_line1 || components.line1 || parsed.line1);
  const city = titleCaseWords(input.city || components.city || parsed.city);
  const state = normalizeState(input.state || components.state || parsed.state || 'FL') || 'FL';
  const zip = normalizeZip(input.zip || components.zip || parsed.zip);
  const placeId = cleanString(input.placeId || input.googlePlaceId || input.google_place_id || components.placeId);

  const stateZip = (city || zip)
    ? [state, zip].filter(Boolean).join(' ')
    : '';
  const fullAddress = [line1, city, stateZip].filter(Boolean).join(', ');

  return {
    raw,
    line1,
    city,
    state,
    zip,
    placeId,
    fullAddress,
  };
}

module.exports = {
  normalizeLeadAddress,
  normalizeStreetLine,
  titleCaseWords,
  normalizeState,
  parseRawAddress,
  STREET_SUFFIX_ALIASES,
};
