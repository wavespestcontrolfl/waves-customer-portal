/**
 * Competitor discovery — find the LIVE local pest/lawn competitor set from the
 * SERPs of our markets, instead of relying on a hardcoded list. A domain that
 * ranks organically or in the Map Pack for a service query in Bradenton /
 * Sarasota / Venice / Lakewood Ranch / Parrish IS a local competitor, and is far
 * likelier to share local-partner backlinks than a random regional giant. The
 * discovered set feeds the referring-domain deep harvest.
 *
 * Read-only (SERP lookups). Directories/review aggregators, social, gov/edu, and
 * our own properties are filtered out — what remains is service businesses.
 */

const dataforseo = require('./dataforseo');
const logger = require('../logger');

// Parrish isn't in DataForSEO's named-location DB (40501 on location_name), so
// it's queried by coordinate (handled transparently by dataforseo.serpLocation).
const MARKETS = [
  { label: 'Bradenton', location: 'Bradenton,Florida,United States' },
  { label: 'Sarasota', location: 'Sarasota,Florida,United States' },
  { label: 'Venice', location: 'Venice,Florida,United States' },
  { label: 'Lakewood Ranch', location: 'Lakewood Ranch,Florida,United States' },
  { label: 'Parrish', location: '27.5743,-82.4276' },
];

const SERVICE_KEYWORDS = [
  'pest control', 'exterminator', 'lawn care', 'lawn service',
  'termite treatment', 'mosquito control', 'rodent control', 'wildlife removal',
];

// Rank for these queries but are NOT prospectable competitors: directories /
// review aggregators, social, search/retail, gov, news, publishing platforms,
// job boards, lawn/pest MARKETPLACES (lead-gen aggregators, not businesses we'd
// mine for local-partner links), and trade orgs. Matched by exact host OR suffix
// (so en.wikipedia.org, locations.trulynolen.com, scgov.net's subdomains, etc.).
const NON_COMPETITOR_HOSTS = new Set([
  // directories / review aggregators
  'yelp.com', 'angi.com', 'angieslist.com', 'thumbtack.com', 'bbb.org', 'yellowpages.com',
  'mapquest.com', 'manta.com', 'hotfrog.com', 'homeadvisor.com', 'houzz.com', 'porch.com',
  'nextdoor.com', 'expertise.com', 'threebestrated.com', 'clutch.co', 'provenexpert.com',
  'birdeye.com', 'chamberofcommerce.com', 'manateechamber.com',
  // social / search / retail / encyclopedias
  'facebook.com', 'linkedin.com', 'instagram.com', 'youtube.com', 'twitter.com', 'x.com',
  'tiktok.com', 'reddit.com', 'pinterest.com', 'google.com', 'bing.com', 'apple.com',
  'amazon.com', 'wikipedia.org', 'homedepot.com', 'lowes.com',
  // pest/lawn products & DIY retail (not service competitors)
  'domyown.com', 'getsunday.com', 'biogents.com', 'mosquitomagnet.com', 'diypestcontrol.com',
  // lead-gen marketplaces (aggregators, not local businesses)
  'lawnstarter.com', 'lawnlove.com', 'yourgreenpal.com', 'lawnguru.co', 'getlawn.com',
  // trade orgs / news / jobs / publishing platforms / county-gov-on-.net
  'pestworld.org', 'npmapestworld.org', 'npma.org', 'mosquito.org', 'indeed.com',
  'glassdoor.com', 'ziprecruiter.com', 'careerexplorer.com', 'nytimes.com',
  'sites.google.com', 'jobbersites.com', 'blogspot.com', 'wordpress.com', 'medium.com',
  'scgov.net', 'broward.org', 'mymanatee.org',
]);

// National/regional FRANCHISES — real competitors, but their backlink profiles
// are overwhelmingly national press/directories, so harvesting them is high-cost
// and low local-partner yield. Tagged (national:true), not excluded, so the
// harvest can target local independents by default and opt into these.
const NATIONAL_CHAINS = new Set([
  'orkin.com', 'terminix.com', 'trugreen.com', 'trulynolen.com', 'mosquitojoe.com',
  'mosquitosquad.com', 'lawndoctor.com', 'crittercontrol.com', 'trutechinc.com',
  'westernexterminator.com', 'pestbear.com', 'arrowservices.com', 'aaanimalcontrol.com',
  'uslawns.com', 'masseyservices.com', 'trulynolen.com', 'crittercontrolsarasota.com',
]);

// Our own properties (main + anything on the brand). Spokes are caught by the
// substring check; the discovered list is reviewed before harvest regardless.
const OWN_HOSTS = new Set(['wavespestcontrol.com']);

function normHost(v) {
  const raw = String(v || '').trim().toLowerCase();
  if (!raw) return null;
  try {
    return new URL(raw.includes('://') ? raw : `https://${raw}`).hostname.replace(/^www\./, '').replace(/^m\./, '');
  } catch {
    return raw.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/^m\./, '').replace(/\/.*$/, '') || null;
  }
}

// exact host OR registrable-suffix match against a set.
function inHostSet(host, set) {
  if (set.has(host)) return true;
  for (const x of set) { if (host.endsWith('.' + x)) return true; }
  return false;
}

function isNonCompetitor(host, ownHosts = OWN_HOSTS) {
  if (!host || !host.includes('.')) return true;
  if (ownHosts.has(host) || host.includes('wavespestcontrol')) return true;
  if (inHostSet(host, NON_COMPETITOR_HOSTS)) return true;
  if (/\.(gov|edu|mil)$/.test(host) || /\.blog$/.test(host)) return true;
  return false;
}

function isNationalChain(host) {
  return inHostSet(host, NATIONAL_CHAINS);
}

const itemsOf = (resp) => resp?.tasks?.[0]?.result?.[0]?.items || [];

/**
 * discoverCompetitors → ranked list of competitor domains seen across the local
 * SERPs, each with { domain, appearances, bestPosition, markets[], keywords[], sources[] }.
 * Sorted by appearances (then best rank). dfs is injectable for tests.
 */
async function discoverCompetitors({ markets = MARKETS, keywords = SERVICE_KEYWORDS, perQuery = 10, ownHosts = OWN_HOSTS, dfs = dataforseo } = {}) {
  const tally = new Map();
  const bump = (host, market, keyword, position, source) => {
    if (isNonCompetitor(host, ownHosts)) return;
    const cur = tally.get(host) || { domain: host, appearances: 0, bestPosition: 999, markets: new Set(), keywords: new Set(), sources: new Set() };
    cur.appearances += 1;
    cur.bestPosition = Math.min(cur.bestPosition, position || 999);
    cur.markets.add(market); cur.keywords.add(keyword); cur.sources.add(source);
    tally.set(host, cur);
  };

  for (const m of markets) {
    for (const kw of keywords) {
      try {
        const org = itemsOf(await dfs.serpOrganic(kw, m.location)).filter((i) => i.type === 'organic').slice(0, perQuery);
        org.forEach((i, idx) => bump(normHost(i.domain || i.url), m.label, kw, i.rank_absolute || idx + 1, 'organic'));
        const maps = itemsOf(await dfs.serpMaps(kw, m.location)).slice(0, perQuery);
        maps.forEach((i, idx) => bump(normHost(i.domain || i.url), m.label, kw, i.rank_absolute || idx + 1, 'maps'));
      } catch (err) {
        logger.warn(`[competitor-discovery] ${m.label} / "${kw}" failed: ${err.message}`);
      }
    }
  }

  return [...tally.values()]
    .map((c) => ({ domain: c.domain, national: isNationalChain(c.domain), appearances: c.appearances, bestPosition: c.bestPosition, markets: [...c.markets], keywords: [...c.keywords], sources: [...c.sources] }))
    // local independents first (the high-yield set), then by frequency.
    .sort((a, b) => (a.national - b.national) || (b.appearances - a.appearances) || (a.bestPosition - b.bestPosition));
}

module.exports = { discoverCompetitors, MARKETS, SERVICE_KEYWORDS };
module.exports._internals = { normHost, isNonCompetitor, isNationalChain, inHostSet, itemsOf, NON_COMPETITOR_HOSTS, NATIONAL_CHAINS, OWN_HOSTS };
