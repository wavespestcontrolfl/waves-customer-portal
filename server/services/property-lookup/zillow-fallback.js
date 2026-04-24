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
 * `maxcopell~zillow-api-scraper`) and timeout via `APIFY_ZILLOW_TIMEOUT_MS`
 * (default 45s — Apify actor cold-starts can run 30s+, 15s was too tight).
 *
 * All logs are prefixed `[zillow-fallback]` so they're greppable in Railway.
 */

const logger = require('../logger');

const APIFY_BASE = 'https://api.apify.com/v2';
const DEFAULT_ACTOR = 'maxcopell~zillow-api-scraper';
const DEFAULT_TIMEOUT_MS = 45000;

async function lookupStoriesFromZillow(address) {
  const token = process.env.APIFY_API_TOKEN;
  if (!token) {
    logger.info('[zillow-fallback] skipped — APIFY_API_TOKEN not set');
    return null;
  }
  if (!address || typeof address !== 'string' || address.trim().length < 5) {
    logger.warn('[zillow-fallback] skipped — address missing or too short');
    return null;
  }

  const actor = process.env.APIFY_ZILLOW_ACTOR_ID || DEFAULT_ACTOR;
  const timeoutMs = Number(process.env.APIFY_ZILLOW_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  // `run-sync-get-dataset-items` runs the actor inline and returns the dataset
  // in the response — avoids a poll loop for a lookup that has to fit inside
  // the estimator's single request/response cycle.
  const url = `${APIFY_BASE}/acts/${encodeURIComponent(actor)}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const t0 = Date.now();

  logger.info('[zillow-fallback] calling Apify', { actor, timeoutMs, address: address.slice(0, 80) });

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

    if (!resp.ok) {
      const bodyText = await resp.text().catch(() => '');
      logger.warn('[zillow-fallback] non-OK response', {
        status: resp.status,
        elapsedMs: Date.now() - t0,
        bodySnippet: bodyText.slice(0, 300),
      });
      return null;
    }

    const items = await resp.json();
    if (!Array.isArray(items) || items.length === 0) {
      logger.warn('[zillow-fallback] empty dataset', {
        elapsedMs: Date.now() - t0,
        itemsType: Array.isArray(items) ? 'array' : typeof items,
      });
      return null;
    }

    const stories = extractStories(items[0]);
    if (stories) {
      logger.info('[zillow-fallback] got stories', {
        stories,
        elapsedMs: Date.now() - t0,
        itemCount: items.length,
      });
    } else {
      // Log the shape of the first item so we can see what the actor returned
      // and update extractStories() if the field is in a place we don't check.
      logger.warn('[zillow-fallback] actor returned items but no stories field recognized', {
        elapsedMs: Date.now() - t0,
        itemCount: items.length,
        firstItemKeys: Object.keys(items[0] || {}).slice(0, 40),
      });
    }
    return stories;
  } catch (err) {
    clearTimeout(timer);
    const aborted = err?.name === 'AbortError';
    logger.warn(`[zillow-fallback] ${aborted ? 'timed out' : 'errored'}`, {
      elapsedMs: Date.now() - t0,
      timeoutMs,
      message: err?.message || String(err),
    });
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
