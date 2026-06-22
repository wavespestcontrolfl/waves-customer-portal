// Base vendor adapter. A concrete adapter is just a config object (search-URL
// builder + CSS selectors); makeAdapter wraps it with the shared Playwright flow:
//
//   resolve product URL (explicit vendor.url, else search -> first result)
//     -> goto product page
//     -> scrape a snapshot (JSON-LD blocks + DOM price/title/availability/body)
//     -> hand the snapshot to the PURE extract.js parsers
//     -> return a candidate { price, currency, availability, name, quantity,
//                             source_url, text }
//
// All the messy parsing is in extract.js (unit-tested); this file is the thin
// browser I/O around it, exercised by the live proof rather than unit tests.

const {
  offerFromSnapshot,
  extractSizeToken,
  mapAvailability,
  quantityToOz,
  verifyMatch,
  epaKey,
} = require('../extract');
const { isUnavailable } = require('../compare');
const { convertToOz } = require('../../product-costing');

// How many top-ranked search results to actually open + verify before giving up.
const MAX_SEARCH_CANDIDATES = 4;

// The oz-equivalent of the product we're scanning for, so the JSON-LD parser can
// pick the matching variant offer on a multi-size page. packSizeValue/Unit are
// STRUCTURED fields — convert them directly (canonical units like "fl_oz" don't
// survive being formatted into free text for quantityToOz). Mirrors verifyMatch.
function targetOzOf(product) {
  if (product.packSizeValue != null && product.packSizeUnit) {
    return convertToOz(product.packSizeValue, product.packSizeUnit);
  }
  return quantityToOz(product.quantity);
}

const DEFAULT_TIMEOUT = 20000;

// The keyword string a vendor search box gets. Prefer the vendor-facing product
// name, fall back to our canonical name.
function searchQuery(product) {
  return String(
    (product && (product.searchQuery || product.vendorProductName || product.productName || product.name)) || '',
  ).trim();
}

// Attributes that hold a value WITHOUT a text node, kept as TWO lists because the
// safe attributes differ by what's being read:
//   PRICE — content, value, and storefront price data-attributes (Magento
//     data-price-amount, BigCommerce/Keystone data-product-price-without-tax, bare
//     data-price). Often the price is an empty `<span data-price="89.99">`, so a
//     text-only read drops the candidate. NOT href: a price selector that resolves
//     to an anchor (`<a class="price" href="/p-89.html">`) would otherwise feed the
//     URL's digits to parsePriceText as a bogus $89.
//   AVAILABILITY — href, because schema.org marks stock state as a text-less
//     `<link itemprop="availability" href="https://schema.org/OutOfStock">`.
const PRICE_VALUE_ATTRS = ['content', 'value', 'data-price', 'data-price-amount', 'data-product-price-without-tax'];
const AVAILABILITY_VALUE_ATTRS = ['content', 'href', 'value'];

// Read an element's value from `attrs` (in order), falling back to textContent.
// Pure + node-testable; collectSnapshot inlines the same rule for the browser
// context. `el` is anything with getAttribute / textContent.
function readValue(el, attrs) {
  if (!el) return '';
  if (el.getAttribute) {
    for (const a of attrs) {
      const v = el.getAttribute(a);
      if (v) return String(v).trim();
    }
  }
  return el.textContent ? String(el.textContent).trim() : '';
}
const priceValue = (el) => readValue(el, PRICE_VALUE_ATTRS);
const availabilityValue = (el) => readValue(el, AVAILABILITY_VALUE_ATTRS);

// Runs IN THE BROWSER (page.evaluate). Must be self-contained — it only sees the
// `sel` argument, never Node scope. Collects every signal the parsers might use.
function collectSnapshot(sel) {
  // Prefer value-bearing attributes before textContent, but read DIFFERENT
  // attributes for price vs availability (see the Node-side PRICE_VALUE_ATTRS /
  // AVAILABILITY_VALUE_ATTRS — these inlined copies MUST stay in sync; that's what
  // the unit test guards). PRICE never reads href (a price anchor's
  // `/p-89.html` would parse as $89); AVAILABILITY reads href because schema.org
  // uses `<link itemprop="availability" href=".../OutOfStock">` with no text.
  // (Inlined — collectSnapshot runs in page.evaluate and can't see Node scope.)
  const PRICE_VALUE_ATTRS = ['content', 'value', 'data-price', 'data-price-amount', 'data-product-price-without-tax'];
  const AVAILABILITY_VALUE_ATTRS = ['content', 'href', 'value'];
  const readValue = (el, attrs) => {
    if (!el) return '';
    if (el.getAttribute) {
      for (const a of attrs) {
        const v = el.getAttribute(a);
        if (v) return String(v).trim();
      }
    }
    return el.textContent ? el.textContent.trim() : '';
  };
  const allText = (selectors, attrs) => (selectors || [])
    .flatMap((s) => Array.from(document.querySelectorAll(s)))
    .map((el) => readValue(el, attrs))
    .filter(Boolean);

  const jsonLd = Array.from(document.querySelectorAll('script[type="application/ld+json"]'))
    .map((s) => s.textContent || '')
    .filter(Boolean);

  const title = readValue(document.querySelector(sel.titleSelector || 'h1'), PRICE_VALUE_ATTRS)
    || (document.title || '').trim();

  const priceTexts = allText(sel.priceSelectors && sel.priceSelectors.length
    ? sel.priceSelectors
    : ['[itemprop="price"]', '.price', '.product-price', '.our-price'], PRICE_VALUE_ATTRS);

  // Collect ALL availability-selector matches, not just the first — a grouped
  // selector (Keystone's includes a generic BigCommerce field used for SKU/brand
  // rows before the stock row) would otherwise miss an out-of-stock signal.
  // Joined with a separator so mapAvailability's out-of-stock/backorder precedence
  // catches "Out of Stock" wherever it appears, without forming a false phrase
  // across element boundaries.
  const availabilityText = sel.availabilitySelector
    ? allText([sel.availabilitySelector], AVAILABILITY_VALUE_ATTRS).join(' | ')
    : '';

  // A bounded slice of body text so extract.js can hunt for an EPA reg number
  // without serializing the entire page back to Node.
  const body = (document.body && document.body.innerText) || '';

  // Size-explicit variants (Magento jsonConfig): each purchasable child carries its own
  // size label + price, which the page-level JSON-LD/title omit. Opt-in (sel.magentoVariants)
  // so only Magento adapters pay for it. Self-contained — runs in page.evaluate. Pulls
  // `optionPrices` (price per child) and joins the size label from `optionPrices[id].size`
  // or, as a fallback, from `attributes[*].options[].label` via the `index` child->option map.
  let variants = [];
  if (sel.magentoVariants) {
    for (const s of document.querySelectorAll('script[type="text/x-magento-init"], script[type="application/json"]')) {
      let parsed;
      try { parsed = JSON.parse(s.textContent || ''); } catch (e) { continue; }
      // Walk to the nested config object that holds optionPrices.
      let cfg = null;
      const stack = [parsed];
      while (stack.length && !cfg) {
        const cur = stack.pop();
        if (cur && typeof cur === 'object') {
          if (cur.optionPrices && typeof cur.optionPrices === 'object') cfg = cur;
          else for (const k in cur) if (cur[k] && typeof cur[k] === 'object') stack.push(cur[k]);
        }
      }
      if (!cfg) continue;
      for (const pid in cfg.optionPrices) {
        const op = cfg.optionPrices[pid];
        const price = op && op.finalPrice && op.finalPrice.amount;
        if (price == null) continue;
        let size = op && op.size;
        if (!size && cfg.attributes && cfg.index && cfg.index[pid]) {
          for (const aid in cfg.attributes) {
            const optId = cfg.index[pid][aid];
            const opt = ((cfg.attributes[aid] && cfg.attributes[aid].options) || [])
              .find((o) => String(o.id) === String(optId));
            if (opt && opt.label) { size = opt.label; break; }
          }
        }
        if (size != null && String(size).trim()) variants.push({ size: String(size), price: Number(price) });
      }
      if (variants.length) break;
    }
  }

  return { jsonLd, title, priceTexts, availabilityText, bodyText: body.slice(0, 4000), variants };
}

// Find the first product link on a search-results page. Returns an absolute URL
// or null. Runs the selector in the browser, resolves relative hrefs via the
// page's own location.
async function firstProductLink(page, config) {
  const sels = config.productLinkSelectors && config.productLinkSelectors.length
    ? config.productLinkSelectors
    : ['a.product-link', '.product-item a', '.product a'];
  return page.evaluate((selectors) => {
    for (const s of selectors) {
      const a = document.querySelector(s);
      if (a && a.href) return a.href;
    }
    return null;
  }, sels);
}

// Tokens to match a product against a result slug: alphanumeric, >=2 chars, with
// consecutive single letters merged so a slashed formulation code like "I/T" -> "it".
function searchTokens(product) {
  const s = (product && (product.searchQuery || product.vendorProductName || product.productName || product.name)) || '';
  const raw = String(s).toLowerCase().match(/[a-z0-9]+/g) || [];
  const merged = [];
  let run = '';
  for (const t of raw) {
    if (t.length === 1 && /[a-z]/.test(t)) { run += t; continue; } // merge consecutive single LETTERS (I/T -> it); never digits, so "2,4-D" stays 2,4,d
    if (run) { merged.push(run); run = ''; }
    merged.push(t);
  }
  if (run) merged.push(run);
  return [...new Set(merged.filter((t) => t.length >= 2))];
}

// Chemical-class words that appear in many product names but DON'T distinguish one
// product from another of the same brand (every Bifen is an "insecticide"), and which
// vendors often drop from the slug. Excluded from scoring so they can't tip a tie to
// the wrong variant; the brand token below still does the real gating.
const GENERIC_NAME_TOKENS = new Set([
  'insecticide', 'insecticides', 'termiticide', 'herbicide', 'herbicides',
  'fungicide', 'fungicides', 'miticide', 'pesticide', 'rodenticide', 'nematicide', 'fertilizer',
]);

// Alphanumeric segments of a product URL path, as a Set for EXACT-segment matching
// (so "sc" matches a "sc" segment, not a substring of "celsius"). Strips the storefront
// product-id suffix (DoMyOwn "...-p-12345.html") + extension first, so an id digit can't
// masquerade as pack-size evidence (a "5 lb" token matching the "5" of "-p-5"); the
// `-p-<id>` pattern is DoMyOwn-specific, so the strip is a harmless no-op elsewhere.
function slugSegments(href) {
  let path = String(href);
  try { path = new URL(href).pathname; } catch { /* relative/garbage — match as-is */ }
  path = path.replace(/\.html?$/i, '').replace(/-p-\d+$/i, '');
  return new Set(path.toLowerCase().match(/[a-z0-9]+/g) || []);
}

// PURE: RANK the result links by how well their URL slug matches the product, best
// first — a ranking, NOT a gate. Modern storefront search is a relevance-ranked widget
// (a "Taurus SC" search lists Talstar above Taurus), so the caller opens the top few in
// turn and lets verifyMatch (EPA / formulation / size) be the sole authority. A
// brand-token (first >=3-char name token) hit is a heavy boost so the exact product
// ranks first and the fast path verifies immediately; the most distinctive name +
// pack-size tokens then order the rest ("bifen-it" over "bifen-xts", the size-specific
// page over the generic one). Crucially, non-brand links are KEPT (ranked last), not
// discarded — a generic-equivalent listing with a DIFFERENT brand but the SAME EPA reg
// is exactly what verifyMatch is meant to accept, so it must still reach verification.
// Returns [] only for an empty input.
function rankedMatchingLinks(hrefs, product) {
  const list = (hrefs || []).filter(Boolean);
  if (!list.length) return [];
  const nameToks = searchTokens(product);
  if (!nameToks.length) return list.slice(0, 1); // no product context -> legacy first-link
  const brand = nameToks.find((t) => t.length >= 3) || nameToks[0];
  const scoreToks = nameToks.filter((t) => !GENERIC_NAME_TOKENS.has(t));
  // Keep numeric size tokens of ANY length (a single-digit pack like "5 lb" or the
  // "2"/"5" of "2.5 gal" is the differentiator between size variants); only single
  // LETTERS are dropped as noise.
  const sizeToks = [...new Set((String((product && product.quantity) || '').toLowerCase().match(/[a-z0-9]+/g) || [])
    .filter((t) => !nameToks.includes(t) && (t.length >= 2 || /\d/.test(t))))];
  const BRAND_BOOST = 1000; // brand-matched links always rank above non-brand ones
  const scored = [];
  for (const href of list) {
    const seg = slugSegments(href);
    const score = (seg.has(brand) ? BRAND_BOOST : 0)
      + scoreToks.reduce((n, t) => n + (seg.has(t) ? 1 : 0), 0)
      + sizeToks.reduce((n, t) => n + (seg.has(t) ? 1 : 0), 0);
    scored.push({ href, score });
  }
  // Stable sort by score desc — preserves widget order for ties (e.g. same-brand
  // variants we can't tell apart by slug, like Talstar P vs Talstar XTRA; or the
  // non-brand tail where an EPA-equivalent may sit).
  return scored.map((s, i) => ({ ...s, i })).sort((a, b) => (b.score - a.score) || (a.i - b.i)).map((s) => s.href);
}

// The single best slug match (the head of the ranked list), or null.
function bestMatchingLink(hrefs, product) {
  return rankedMatchingLinks(hrefs, product)[0] || null;
}

// PURE: the result links the caller should open + verify, in order. Normally the top
// `cap` ranked links. But when those are ALL brand matches and a non-brand link exists
// further down, APPEND the top non-brand link as one EXTRA candidate (budget cap+1)
// rather than replacing the last brand page — dropping a brand variant could lose the
// real size/EPA match (e.g. a Talstar-P-style variant whose distinguishing token isn't
// in the slug). The loop tries the brand matches first and only opens this extra if
// none of them verify, so a same-EPA generic equivalent still gets a shot at no cost to
// the brand candidates. Only done for products with a valid EPA reg — a different-brand
// page can be accepted solely on EPA + size, so for a non-EPA product (fertilizer/
// adjuvant) a non-brand link can never verify and isn't worth opening.
function selectSearchCandidates(hrefs, product, cap = MAX_SEARCH_CANDIDATES) {
  const ranked = rankedMatchingLinks(hrefs, product);
  if (ranked.length <= cap) return ranked;
  const picked = ranked.slice(0, cap);
  if (!epaKey(product && product.epaReg)) return picked;
  const nameToks = searchTokens(product);
  const brand = nameToks.find((t) => t.length >= 3) || nameToks[0];
  const isBrand = (href) => !!brand && slugSegments(href).has(brand);
  if (picked.every(isBrand)) {
    const topNonBrand = ranked.find((href) => !isBrand(href));
    if (topNonBrand && !picked.includes(topNonBrand)) picked.push(topNonBrand); // extra slot, not a swap
  }
  return picked;
}

// Collect every candidate result link from the page (deduped, in document order).
async function collectResultLinks(page, config) {
  const sels = config.productLinkSelectors && config.productLinkSelectors.length
    ? config.productLinkSelectors
    : ['a.product-link', '.product-item a', '.product a'];
  return page.evaluate((selectors) => {
    const seen = new Set();
    const out = [];
    for (const s of selectors) {
      for (const a of document.querySelectorAll(s)) {
        if (a && a.href && !seen.has(a.href)) { seen.add(a.href); out.push(a.href); }
      }
    }
    return out;
  }, sels);
}

function makeAdapter(config) {
  const timeout = config.timeout || DEFAULT_TIMEOUT;

  // Open ONE product URL, snapshot it, and shape a candidate (or null if no usable
  // priced offer at the target size). domcontentloaded (NOT networkidle — ad chatter
  // never settles); an optional short settle lets client-rendered prices paint.
  async function scrapeCandidate(page, vendor, product, url) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    if (config.settleMs) await page.waitForTimeout(config.settleMs);
    const sel = {
      titleSelector: config.titleSelector,
      priceSelectors: config.priceSelectors,
      availabilitySelector: config.availabilitySelector,
      magentoVariants: !!config.magentoVariants, // capture per-variant size+price (Magento jsonConfig)
    };
    const snapshot = await page.evaluate(collectSnapshot, sel);

    // Size-aware JSON-LD first; DOM fallback only when JSON-LD carried no offers
    // (offerFromSnapshot enforces the size gate so a default variant can't be
    // reported as the requested pack).
    const offer = offerFromSnapshot(snapshot, { targetOz: targetOzOf(product) });
    if (!offer || offer.price == null) return null;

    // When JSON-LD priced the offer but didn't state availability, fall back to the
    // DOM availability text — otherwise a sold-out page reports 'unknown' (which
    // compare does NOT exclude) and can rank as a savings opportunity.
    let availability = offer.availability || 'unknown';
    if (availability === 'unknown' && snapshot.availabilityText) {
      availability = mapAvailability(snapshot.availabilityText);
    }

    const name = offer.name || snapshot.title || null;
    // A variant-matched offer already knows its exact pack (offer.quantity = the variant's
    // size label); trust it over re-parsing the product name/title.
    const quantity = offer.quantity
      || (config.quantityFrom && config.quantityFrom(name, snapshot))
      || extractSizeToken(name)
      || extractSizeToken(snapshot.title);

    return {
      price: offer.price,
      currency: offer.currency || 'USD',
      availability,
      name,
      quantity,
      source_url: page.url(), // the PROOF link — exactly where the price was read
      text: snapshot.bodyText || null,
      // True when the page had multiple same-size JSON-LD offers and the winner was
      // chosen by price — verifyMatch then won't let a page-body EPA alone verify it
      // (the EPA might belong to a different product on the page).
      competing_same_size: !!offer.competingSameSize,
      price_type: config.priceType || 'public',
      // The real vendors.id (UUID) the /report worker keys on — a DB vendor row
      // provides `.id`. This is NOT the adapter slug (selectAdapterKey decides that
      // from host/name/url; the two are independent).
      vendor_id: vendor.vendor_id || vendor.id,
      vendor: vendor.name || vendor.vendor_id || vendor.id,
    };
  }

  async function fetchCandidate(page, vendor, product) {
    // Direct URL (explicit vendor.url or a builder) — one shot.
    const directUrl = vendor.url || (config.buildProductUrl && config.buildProductUrl(product, vendor));
    if (directUrl) return scrapeCandidate(page, vendor, product, directUrl);

    // Otherwise search the vendor and open the best matches.
    const searchUrl = config.buildSearchUrl ? config.buildSearchUrl(product, vendor) : null;
    if (!searchUrl) return null;
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout });
    // OPT-IN wait: only adapters whose results are injected by a client-side widget set
    // searchWaitMs (DoMyOwn's Reflektion search). For server-rendered adapters the
    // results are already in the DOM, so we must NOT block here — otherwise a no-match
    // (or a stale search path) burns the full timeout per product, adding minutes to a
    // serial multi-product run. waitForSelector returns as soon as a link appears, so a
    // successful dynamic search is still fast; only a genuine no-match waits it out.
    if (config.searchWaitMs) {
      const waitSel = (config.productLinkSelectors && config.productLinkSelectors[0]) || 'a.product-link';
      await page.waitForSelector(waitSel, { timeout: config.searchWaitMs }).catch(() => {});
    }

    // Search is fuzzy + relevance-ranked, and slug heuristics can't always tell
    // same-brand variants apart (Talstar P vs Talstar XTRA). So open the top-ranked
    // results in turn and let verifyMatch (EPA / formulation / size) pick the real
    // one — returning the first that VERIFIES rather than betting on a single link.
    const cap = config.maxSearchCandidates || MAX_SEARCH_CANDIDATES;
    const candidates = selectSearchCandidates(await collectResultLinks(page, config), product, cap);
    const wantsEpa = !!(product && product.epaReg);
    let fallback = null; // best-ranked priced page, if nothing verifies (-> precise 'unverified')
    let firstBuyable = null; // first BUYABLE name+size match lacking EPA confirmation
    let firstUnbuyable = null; // first verified match that isn't buyable (compare drops it)
    let candidateError = null; // a per-candidate nav/scrape failure, surfaced only if nothing verifies
    for (const url of candidates) {
      let cand;
      try {
        cand = await scrapeCandidate(page, vendor, product, url);
      } catch (err) {
        // A transient nav timeout / scrape failure on ONE candidate must not abort the
        // product — the real match is often the very next link (the search is fuzzy and
        // relevance-ranked). Remember the error so an all-fail run still reports
        // fetch_error, but keep trying the remaining candidates.
        candidateError = err;
        continue;
      }
      if (!cand) continue;
      if (!fallback) fallback = cand;
      const verdict = verifyMatch(
        { name: cand.name, text: cand.text, quantity: cand.quantity, competingOffers: cand.competing_same_size },
        product,
      );
      if (!verdict.matched) continue;
      const buyable = !isUnavailable(cand); // out_of_stock / backorder can't be an opportunity
      // Prefer an EPA-confirmed match — a single-letter formulation suffix the slug can't
      // encode (catalog "Talstar P" vs page "Talstar Professional") lets a sibling like
      // "Talstar XTRA" pass name+size on brand overlap alone — BUT only among BUYABLE
      // pages: an out-of-stock EPA hit gets dropped by compare, so it must never beat an
      // already-found buyable match. Ideal (EPA-ok AND buyable, or no EPA needed) wins now.
      if ((!wantsEpa || verdict.signals.epa) && buyable) return cand;
      if (buyable) { if (!firstBuyable) firstBuyable = cand; } // buyable but EPA not confirmed
      else if (!firstUnbuyable) firstUnbuyable = cand; // verified but unbuyable
    }
    // A buyable match (can actually be an opportunity) beats a verified-but-unbuyable one
    // (compare would drop it). Only these two are actual verifyMatch passes.
    const verified = firstBuyable || firstUnbuyable;
    // If NOTHING verified and a candidate threw, surface that error as a precise
    // 'fetch_error': the scan was INCOMPLETE (the candidate that timed out might have
    // been the real match), so we must not let a priced-but-unverified fallback report a
    // clean 'unverified' — that reads as "found it, no match here, don't retry" when the
    // truth is "a fetch failed, retry". Only a verified match suppresses the error.
    if (!verified && candidateError) throw candidateError;
    // A verified match wins; else the best priced page is a precise 'unverified' skip
    // (we did reach a page, it just didn't confirm).
    return verified || fallback;
  }

  return { key: config.key, config, fetchCandidate };
}

module.exports = {
  makeAdapter, collectSnapshot, firstProductLink, rankedMatchingLinks, selectSearchCandidates, bestMatchingLink, searchTokens,
  searchQuery, targetOzOf, priceValue, availabilityValue, PRICE_VALUE_ATTRS, AVAILABILITY_VALUE_ATTRS, DEFAULT_TIMEOUT,
};
