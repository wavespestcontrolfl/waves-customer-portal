/**
 * Local-opportunity prospector — PROACTIVE local link discovery.
 *
 * The deep harvest (competitor-discovery + backlink-deep-harvest) is REACTIVE: it
 * only ever surfaces a domain once a competitor already earned a link from it. The
 * highest-value local links — youth-sports sponsorships, charity-run sponsor
 * pages, chamber member directories, community calendars, local podcasts, local
 * blogs — are valuable precisely because they're UNCONTESTED (no competitor has
 * them yet), so the reactive harvest is blind to them.
 *
 * This module closes that gap. It runs a curated set of opportunity-intent queries
 * ("<city> little league sponsors", "<city> 5k run sponsors", "<city> chamber of
 * commerce member directory", "<city> community calendar", "<city> podcast") in
 * each of our markets and returns the result domains directly as PROSPECTS. The
 * existing scorer (prospect-scorer.scoreCandidates) then classifies + contact-finds
 * + lane-routes each one onto the same seo_link_prospects board the outreach drafter
 * and citation/signup runner already consume — so sponsorships/charities/podcasts
 * land in the OUTREACH lane and chambers/directories land in the SIGNUP lane, with
 * no new pipeline.
 *
 * Read-only (SERP organic lookups only — no Map Pack; these opportunities aren't
 * GBP entities). DB writes + scoring live in scripts/backlink-local-opportunities.js,
 * mirroring the competitor-discovery / backlink-deep-harvest split (this stays pure
 * and network-only so it unit-tests with an injected `dfs`).
 */

const dataforseo = require('./dataforseo');
const logger = require('../logger');
const { MARKETS } = require('./competitor-discovery');
const { normHost, inHostSet, isNationalChain, itemsOf } = require('./competitor-discovery')._internals;
const { SPOKE_SITE_KEYS } = require('../content-astro/spoke-sites');

// Opportunity-intent queries, each `tmpl(city)` → a search string, tagged with the
// kind of link it surfaces. `type` flows onto the prospect (notes + quality_signals)
// so the board shows provenance; the scorer still independently classifies the
// intent_class / lane from the landed page. Keep this list curated — every entry
// should reliably return obtainable LOCAL link targets, not platform noise.
const OPPORTUNITY_QUERIES = [
  // youth / community sports sponsorships (sponsor pages list + link sponsors)
  { type: 'sponsorship', tmpl: (c) => `${c} little league sponsors` },
  { type: 'sponsorship', tmpl: (c) => `${c} youth sports team sponsors` },
  { type: 'sponsorship', tmpl: (c) => `${c} high school sports booster sponsors` },
  // charity runs / events (sponsor + partner pages)
  { type: 'event', tmpl: (c) => `${c} 5k run sponsors` },
  { type: 'event', tmpl: (c) => `${c} charity event sponsors` },
  { type: 'event', tmpl: (c) => `${c} festival sponsors` },
  // chambers of commerce (member directory = local citation + credibility)
  { type: 'chamber', tmpl: (c) => `${c} chamber of commerce member directory` },
  // community calendars / hyperlocal listings (event + resource links)
  { type: 'community', tmpl: (c) => `${c} community calendar` },
  { type: 'community', tmpl: (c) => `${c} community organizations directory` },
  // local podcasts (guest spots → host links the guest's site)
  { type: 'podcast', tmpl: (c) => `${c} local podcast` },
  { type: 'podcast', tmpl: (c) => `Sarasota Bradenton Florida podcast guest "${c}"` },
];

// Platforms / aggregators / UGC / job boards that rank for these queries but are
// NOT obtainable contextual local link targets — you can't earn an editorial link
// by emailing facebook.com, and podcast/event PLATFORM listing pages aren't the
// show's/organizer's own linkable site. Deliberately does NOT exclude chambers,
// leagues, charities, local news, community calendars, .org/.edu booster pages, or
// city .gov calendars — those ARE the targets (this is the key difference from
// competitor-discovery's NON_COMPETITOR_HOSTS, which filters chambers/news OUT).
const PLATFORM_HOSTS = new Set([
  // social / video / UGC
  'facebook.com', 'instagram.com', 'twitter.com', 'x.com', 'tiktok.com', 'youtube.com',
  'linkedin.com', 'pinterest.com', 'reddit.com', 'nextdoor.com', 'medium.com',
  // search / retail / encyclopedia
  'google.com', 'bing.com', 'yahoo.com', 'amazon.com', 'wikipedia.org', 'apple.com',
  // big directories / review aggregators (handled by the citation lane already)
  'yelp.com', 'tripadvisor.com', 'mapquest.com', 'yellowpages.com', 'bbb.org', 'angi.com',
  'thumbtack.com', 'homeadvisor.com', 'manta.com', 'foursquare.com', 'houzz.com', 'porch.com',
  // event / ticketing PLATFORMS (we're not an organizer — no contextual link to earn)
  'eventbrite.com', 'meetup.com', 'ticketmaster.com', 'allevents.in', 'eventful.com',
  'patch.com',
  // podcast PLATFORMS (we want the show's own site, not its directory listing)
  'spotify.com', 'podcasts.apple.com', 'podchaser.com', 'listennotes.com', 'iheart.com',
  'audible.com', 'podbean.com', 'buzzsprout.com', 'castbox.fm', 'player.fm', 'deezer.com',
  // job boards / classifieds
  'indeed.com', 'ziprecruiter.com', 'glassdoor.com', 'craigslist.org', 'salary.com',
]);

// Our own properties — hub + the canonical Astro spoke fleet — never prospect ourselves.
const OWN_HOSTS = new Set(['wavespestcontrol.com', ...SPOKE_SITE_KEYS]);

// A discovered SERP result is NOT a usable opportunity if it's a platform, one of
// our own sites, or a national pest/lawn franchise (a competitor bragging about its
// own sponsorships — not a partner that would link to us).
function isExcludedHost(host, ownHosts = OWN_HOSTS) {
  if (!host || !host.includes('.')) return true;
  if (inHostSet(host, ownHosts) || host.includes('wavespestcontrol')) return true;
  if (inHostSet(host, PLATFORM_HOSTS)) return true;
  if (isNationalChain(host)) return true;
  return false;
}

/**
 * discoverLocalOpportunities → ranked candidate list. Each entry:
 *   { domain, opportunity_type, opportunity_types[], source_url, title,
 *     appearances, bestPosition, markets[], queries[] }
 * sorted by appearances (a domain surfacing across multiple markets/queries is the
 * strongest local-hub signal), then best SERP position. `dfs` is injectable for tests.
 *
 * The shape is a superset of what prospect-scorer.scoreCandidates consumes
 * ({ domain, domain_rating, source_url, sample_anchors[] }) — the CLI maps it.
 */
async function discoverLocalOpportunities({
  markets = MARKETS,
  queries = OPPORTUNITY_QUERIES,
  perQuery = 10,
  ownHosts = OWN_HOSTS,
  dfs = dataforseo,
} = {}) {
  const tally = new Map();
  const bump = (host, { market, query, type, position, url, title }) => {
    if (isExcludedHost(host, ownHosts)) return;
    const cur = tally.get(host) || {
      domain: host, appearances: 0, bestPosition: 999,
      markets: new Set(), queries: new Set(), types: new Set(),
      source_url: null, title: null, firstPosition: 999,
    };
    cur.appearances += 1;
    cur.bestPosition = Math.min(cur.bestPosition, position || 999);
    cur.markets.add(market);
    cur.queries.add(query);
    cur.types.add(type);
    // Keep the highest-ranked result's URL/title as the representative landing page
    // — it's the strongest intent signal the scorer reads (/sponsors, /members, …).
    if ((position || 999) < cur.firstPosition) {
      cur.firstPosition = position || 999;
      cur.source_url = url || cur.source_url;
      cur.title = title || cur.title;
    }
    tally.set(host, cur);
  };

  for (const m of markets) {
    for (const q of queries) {
      const keyword = q.tmpl(m.label);
      try {
        const org = itemsOf(await dfs.serpOrganic(keyword, m.location))
          .filter((i) => i.type === 'organic')
          .slice(0, perQuery);
        org.forEach((i, idx) => bump(normHost(i.domain || i.url), {
          market: m.label, query: keyword, type: q.type,
          position: i.rank_absolute || idx + 1, url: i.url, title: i.title,
        }));
      } catch (err) {
        logger.warn(`[local-opportunity] ${m.label} / "${keyword}" failed: ${err.message}`);
      }
    }
  }

  return [...tally.values()]
    .map((c) => ({
      domain: c.domain,
      // Primary type = the type of the highest-ranked appearance is ambiguous to
      // recover post-hoc; use the first inserted type as primary, keep the full set.
      opportunity_type: [...c.types][0] || 'community',
      opportunity_types: [...c.types],
      source_url: c.source_url,
      title: c.title,
      appearances: c.appearances,
      bestPosition: c.bestPosition,
      markets: [...c.markets],
      queries: [...c.queries],
    }))
    .sort((a, b) => (b.appearances - a.appearances) || (a.bestPosition - b.bestPosition));
}

module.exports = { discoverLocalOpportunities, OPPORTUNITY_QUERIES, MARKETS };
module.exports._internals = { isExcludedHost, PLATFORM_HOSTS, OWN_HOSTS };
