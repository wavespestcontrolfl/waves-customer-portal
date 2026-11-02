// Shared rules for negative keywords (owner plan A, 2026-11-02). The ads advisor
// uses them now to decide which add_negative suggestions may carry a value;
// the Google write and the owner's word list reuse them later. Pure functions,
// no database and no network.

// A negative must never block the searches Waves pays to win.
const PROTECTED_BRAND_TERMS = ['waves', 'near me'];

const SERVICE_WORDS = [
  'pest', 'pests', 'bug', 'bugs', 'termite', 'termites', 'rodent', 'rodents',
  'rat', 'rats', 'mouse', 'mice', 'mosquito', 'mosquitoes', 'lawn', 'lawns',
  'ant', 'ants', 'roach', 'roaches', 'cockroach', 'cockroaches', 'bee', 'bees',
  'wasp', 'wasps', 'hornet', 'hornets', 'spider', 'spiders', 'flea', 'fleas',
  'tick', 'ticks', 'bed bug', 'bed bugs', 'bedbug', 'bedbugs',
  'exterminator', 'exterminators', 'extermination', 'fumigation', 'tent',
  'weed', 'weeds', 'fertilizer', 'grass', 'sod', 'chinch', 'grub', 'grubs',
  'mole cricket', 'whitefly',
];

const CITIES = [
  'venice', 'north port', 'sarasota', 'bradenton', 'lakewood ranch',
  'port charlotte', 'punta gorda', 'englewood', 'nokomis', 'osprey', 'parrish',
  'palmetto', 'ellenton', 'myakka', 'rotonda', 'siesta key', 'longboat key',
  'laurel', 'south venice',
];

// Competitors' names. Never a protected word (the owner may block one on his
// own list, e.g. "orkin"), but the advisor never proposes one: a competitor
// block is the owner's call, not a suggestion.
const COMPETITOR_NAMES = [
  'orkin', 'terminix', 'trugreen', 'tru green', 'hometeam', 'home team',
  'turner', 'nozzle nolen', 'truly nolen', 'massey', 'aptive', 'rentokil',
  'hawx', 'bulwark', 'lawn doctor', 'weed man',
];

const MAX_NEGATIVE_LENGTH = 80;
const MAX_NEGATIVE_WORDS = 4;

// lowercase, trimmed, single spaces. Returns null when the text cannot be a
// Google negative keyword we are willing to send.
function normalizeNegative(text) {
  if (typeof text !== 'string') return null;
  const out = text.replace(/[‘’]/g, "'").toLowerCase().trim().replace(/\s+/g, ' ');
  if (!out || out.length > MAX_NEGATIVE_LENGTH) return null;
  if (!/^[\p{L}\p{N} &']+$/u.test(out)) return null;
  if (out.split(' ').length > MAX_NEGATIVE_WORDS) return null;
  return out;
}

// Whole-word / whole-phrase containment on a lenient normalization (any
// punctuation becomes a space), so "Waves!" and "pest-control" are still seen.
function spaced(text) {
  return ` ${String(text || '').toLowerCase().replace(/[‘’]/g, "'")
    .replace(/[^\p{L}\p{N}&']+/gu, ' ').trim()} `;
}

function firstMatch(haystack, list) {
  return list.find((entry) => haystack.includes(` ${entry} `)) || null;
}

// null when the text is safe to block; otherwise a short reason.
function protectedReason(text) {
  const haystack = spaced(text);
  const brand = firstMatch(haystack, PROTECTED_BRAND_TERMS);
  if (brand) return `contains "${brand}"`;
  const service = firstMatch(haystack, SERVICE_WORDS);
  if (service) return `contains the service word "${service}"`;
  const city = firstMatch(haystack, CITIES);
  if (city) return `contains the city "${city}"`;
  return null;
}

// The competitor's name the text contains, or null.
function competitorName(text) {
  return firstMatch(spaced(text), COMPETITOR_NAMES);
}

module.exports = {
  PROTECTED_BRAND_TERMS,
  COMPETITOR_NAMES,
  SERVICE_WORDS,
  CITIES,
  MAX_NEGATIVE_LENGTH,
  MAX_NEGATIVE_WORDS,
  normalizeNegative,
  protectedReason,
  competitorName,
};
