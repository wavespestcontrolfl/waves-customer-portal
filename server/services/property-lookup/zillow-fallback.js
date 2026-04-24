/**
 * Zillow-via-Apify fallback for the `stories` field.
 *
 * RentCast is our primary source for structural facts, but its `features`
 * payload is inconsistent — on ~8–12% of SWFL addresses (mostly newer Parrish
 * / Lakewood Ranch builds) it returns no floor count at all. Today we silently
 * default those to 1, which under-prices pest control for every 2-story home
 * that slips through.
 *
 * This module calls an Apify-hosted Zillow scraper actor as a second-chance
 * lookup when RentCast has no stories. Zillow exposes stories in the listing's
 * Facts & Features section on virtually every detail page, so scraper coverage
 * is much higher than RentCast's here.
 *
 * Gated on `APIFY_API_TOKEN`. Fails closed — if the token is missing or the
 * call errors / times out / returns a shape we don't understand, we return
 * null and the orchestrator falls back to the existing stories=1 default plus
 * a UI "verify stories" nudge.
 *
 * Actor choice is overridable via `APIFY_ZILLOW_ACTOR_ID` (default:
 * `maxcopell~zillow-api-scraper`) so we can swap scrapers without redeploying.
 */

const APIFY_BASE = 'https://api.apify.com/v2';
const DEFAULT_ACTOR = 'maxcopell~zillow-api-scraper';
const TIMEOUT_MS = 15000;

async function lookupStoriesFromZillow(address) {
  const token = process.env.APIFY_API_TOKEN;
  if (!token) return null;
  if (!address || typeof address !== 'string' || address.trim().length < 5) return null;

  const actor = process.env.APIFY_ZILLOW_ACTOR_ID || DEFAULT_ACTOR;
  // `run-sync-get-dataset-items` runs the actor inline and returns the dataset
  // in the response — avoids a poll loop for a lookup that has to fit inside
  // the estimator's single request/response cycle.
  const url = `${APIFY_BASE}/acts/${encodeURIComponent(actor)}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // `searchQueries` is the input shape used by maxcopell/zillow-api-scraper
      // and most fork variants. If the configured actor uses a different
      // shape it will ignore these keys; extractStories will then return null
      // and the orchestrator will fall back gracefully.
      body: JSON.stringify({
        searchQueries: [address],
        maxItems: 1,
        extractionMethod: 'MAP_MARKERS',
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!resp.ok) return null;
    const items = await resp.json();
    if (!Array.isArray(items) || items.length === 0) return null;

    return extractStories(items[0]);
  } catch {
    clearTimeout(timer);
    return null;
  }
}

// Zillow payloads vary by actor and listing age. Try every shape we've seen
// before giving up. Returns a positive integer or null.
function extractStories(item) {
  if (!item || typeof item !== 'object') return null;

  const direct = [
    item.stories,
    item.numStories,
    item.storiesNumber,
    item?.resoFacts?.stories,
    item?.resoFacts?.storiesTotal,
    item?.hdpData?.homeInfo?.stories,
    item?.homeFacts?.stories,
    item?.factsAndFeatures?.stories,
  ];

  // Some actors flatten facts into an array of { factLabel, factValue }.
  const factLists = [
    item.atAGlanceFacts,
    item.factsAndFeatures,
    item?.resoFacts?.atAGlanceFacts,
  ].filter(Array.isArray);

  for (const list of factLists) {
    for (const f of list) {
      if (!f) continue;
      const label = String(f.factLabel || f.label || '').toLowerCase();
      if (label.includes('stor')) direct.push(f.factValue || f.value);
    }
  }

  for (const c of direct) {
    const n = coerceStories(c);
    if (n) return n;
  }
  return null;
}

function coerceStories(raw) {
  if (raw == null) return null;
  const n = Number(String(raw).replace(/[^\d.]/g, ''));
  if (!Number.isFinite(n) || n <= 0 || n > 10) return null;
  return Math.round(n);
}

module.exports = { lookupStoriesFromZillow };
