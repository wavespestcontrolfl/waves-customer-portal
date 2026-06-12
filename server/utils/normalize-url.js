// Canonical fleet domain list — search-console-v2.js imports this for the
// daily GSC sync, so keep it complete. Order matters: hubs first, because
// syncAllDomains walks the list in order and hub data must land even if a
// later spoke property errors mid-loop.
const NETWORK_DOMAINS = [
  'wavespestcontrol.com', 'waveslawncare.com',
  'bradentonflpestcontrol.com', 'palmettoflpestcontrol.com', 'parrishpestcontrol.com',
  'sarasotaflpestcontrol.com', 'veniceflpestcontrol.com', 'northportflpestcontrol.com',
  'bradentonflexterminator.com', 'palmettoexterminator.com', 'parrishexterminator.com',
  'sarasotaflexterminator.com', 'veniceexterminator.com',
  'bradentonfllawncare.com', 'parrishfllawncare.com', 'sarasotafllawncare.com', 'venicelawncare.com',
];

const HUB_DOMAINS = new Set(['wavespestcontrol.com', 'waveslawncare.com']);

function normalizeUrl(url) {
  return String(url || '')
    .trim()
    .toLowerCase()
    .replace(/\?.*$/, '')
    .replace(/#.*$/, '')
    .replace(/\/$/, '')
    .replace(/^https?:\/\/(www\.)?/, '');
}

function urlLookupVariants(rawUrl) {
  const normalized = normalizeUrl(rawUrl);
  if (!normalized) return [];
  const withoutWww = normalized.replace(/^www\./, '');
  const withWww = withoutWww ? `www.${withoutWww}` : normalized;
  const bases = [...new Set([normalized, withoutWww, withWww].filter(Boolean))];
  return [...new Set(bases.flatMap((u) => [
    u,
    `${u}/`,
    `https://${u}`,
    `https://${u}/`,
    `http://${u}`,
    `http://${u}/`,
  ]))];
}

function extractDomain(url) {
  const normalized = normalizeUrl(url);
  return normalized.split('/')[0] || '';
}

function classifyDomainRole(domain) {
  const d = extractDomain(domain);
  if (HUB_DOMAINS.has(d)) return 'hub';
  if (NETWORK_DOMAINS.includes(d)) return 'spoke';
  return 'hub'; // default for unknown — treat as hub
}

const CITY_PATTERNS = {
  bradenton: /bradenton/i,
  sarasota: /sarasota/i,
  venice: /venice/i,
  parrish: /parrish/i,
  lakewood_ranch: /lakewood[\s-]*ranch/i,
  palmetto: /palmetto/i,
  north_port: /north[\s-]*port/i,
  port_charlotte: /port[\s-]*charlotte/i,
};

const SERVICE_PATTERNS = {
  pest: /pest[\s-]*control|exterminator|bug|insect|ant|spider|cockroach|roach/i,
  termite: /termite/i,
  rodent: /rodent|rat|mouse|mice|rat[\s-]*exclusion/i,
  mosquito: /mosquito/i,
  lawn: /lawn|grass|turf|weed|fertiliz/i,
  tree_shrub: /tree|shrub|palm|ornamental/i,
  specialty: /bed[\s-]*bug|flea|tick|wasp|bee|hornet|fire[\s-]*ant/i,
};

function inferCityFromUrl(url) {
  const normalized = normalizeUrl(url);
  for (const [city, pattern] of Object.entries(CITY_PATTERNS)) {
    if (pattern.test(normalized)) return city;
  }
  return null;
}

function inferServiceFromUrl(url) {
  const normalized = normalizeUrl(url);
  for (const [service, pattern] of Object.entries(SERVICE_PATTERNS)) {
    if (pattern.test(normalized)) return service;
  }
  return null;
}

function classifyPageType(url) {
  const normalized = normalizeUrl(url);
  const path = normalized.replace(/^[^/]*/, ''); // strip domain

  if (!path || path === '' || path === '/') return 'homepage';
  if (/^\/blog\b/.test(path)) return 'blog';
  if (/^\/waveguard\b/.test(path)) return 'waveguard';
  if (/^\/pest-control-calculator\b/.test(path)) return 'landing';
  if (/^\/pest-control-quote\b/.test(path)) return 'landing';
  if (/^\/estimate\b/.test(path)) return 'landing';
  if (/^\/contact\b/.test(path)) return 'landing';

  const hasCity = inferCityFromUrl(path) !== null;
  const hasService = inferServiceFromUrl(path) !== null;
  if (hasCity && hasService) return 'city-service';
  if (hasCity) return 'city';
  if (hasService) return 'service';

  return 'other';
}

module.exports = {
  NETWORK_DOMAINS,
  HUB_DOMAINS,
  normalizeUrl,
  urlLookupVariants,
  extractDomain,
  classifyDomainRole,
  inferCityFromUrl,
  inferServiceFromUrl,
  classifyPageType,
};
