// Pure parsing + match-verification helpers for the vendor price scanner.
// Everything here is deterministic and unit-tested — no network, no DB, no
// browser. The adapters (PR2) pull raw strings off the page with Playwright and
// hand them to these functions, so the messy parsing logic stays testable.

const { convertToOz, parsePackSize } = require('../product-costing');

// Scraped pack sizes are messy ("78 oz jug", "18 lb pail", "1/2 gal",
// "4 x 30 g"), so normalize through product-costing's robust parsePackSize
// rather than the bare-number normalizeQuantityToOz. Shares the exact
// oz-equivalent basis as the inventory pipeline. Returns null for count-based /
// unparseable packs (bait stations, traps) — never 0.
function quantityToOz(quantity) {
  const pack = parsePackSize(quantity);
  if (!pack) return null;
  const oz = convertToOz(pack.amount, pack.unit);
  return oz == null ? null : Math.round(oz * 100) / 100;
}

// Matches the /report contract enum (integrations-vendor-price-worker.js).
const AVAILABILITY = ['in_stock', 'limited', 'out_of_stock', 'backorder', 'unknown'];

// Map a schema.org availability URL/token OR free DOM text to our enum.
function mapAvailability(value) {
  const s = String(value || '').toLowerCase();
  if (!s) return 'unknown';
  // Out-of-stock first — including negated "in stock"/"available" phrasing
  // ("not in stock", "not currently available") that would otherwise fall
  // through to the positive in-stock match below and be read as available.
  if (/out[\s_-]?of[\s_-]?stock|outofstock|sold[\s_-]?out|unavailable|discontinued|not[\s_-]+(currently[\s_-]+)?(in[\s_-]?stock|available)|no[\s_-]+longer[\s_-]+available|temporarily[\s_-]+out/.test(s)) return 'out_of_stock';
  if (/back[\s_-]?order|backorder|pre[\s_-]?order|preorder/.test(s)) return 'backorder';
  if (/limited[\s_-]?availability|limitedavailability|low[\s_-]?stock|only\s+\d+\s+left/.test(s)) return 'limited';
  if (/in[\s_-]?stock|instock/.test(s)) return 'in_stock';
  return 'unknown';
}

// Parse a price string into a positive number, or null. Strict: rejects ranges,
// "call for price", empty, non-positive, and percentages. "$1,234.50" -> 1234.5.
function parsePriceText(text) {
  if (text == null) return null;
  const s = String(text).trim();
  if (!s) return null;
  // Reject discount badges ("Save 20%", "20% off") — a percentage is not a price,
  // and a DOM priceTexts array often lists the badge before the real price.
  if (/\d\s*%/.test(s)) return null;
  // Reject per-unit / unit-price snippets ("$1.22 / oz", "$1.22 per lb", "each").
  // A DOM list can show the unit price before the package price; we want the
  // package price (normalization divides by size again), so skip these.
  if (/\beach\b/i.test(s)) return null;
  if (/(?:\/|\bper\b)\s*(?:fl\.?\s*oz|ounce|oz|gallon|gal|quart|qt|pint|pt|pound|lb|liter|litre|ml|kg|gram|unit)\b/i.test(s)) return null;
  // Reject promo / reference badges ("Save $20", "$20 off", "Free shipping over
  // $50", "Was $99") — these carry a dollar amount that isn't the package price
  // and can appear before it in a DOM priceTexts list.
  if (/\b(?:save|off|discount|rebate|coupon|clearance|shipping|free|was|starting|from)\b/i.test(s)) return null;
  // Reject bare pack-size labels ("78 oz", "2.5 gal", "18 lb") — a DOM list can
  // show a size/variant label before the real price; the size is not a price.
  if (/\d\s*(?:fl\.?\s*oz|ounce|oz|gallon|gal|quart|qt|pint|pt|pound|lb|liter|litre|ml|kg|gram|g)\b/i.test(s)) return null;
  // Numbers, allowing thousands separators: "1,234.50" is one token.
  const numbers = s.match(/\d[\d,]*(?:\.\d+)?/g);
  if (!numbers || numbers.length !== 1) return null; // 0 = no price, >1 = range/ambiguous
  const n = Number(numbers[0].replace(/,/g, ''));
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100) / 100;
}

// Pull a usable price out of one JSON-LD Offer/AggregateOffer node.
function offerPrice(offer) {
  if (!offer || typeof offer !== 'object') return null;
  const raw = offer.price
    ?? offer.lowPrice
    ?? (offer.priceSpecification && offer.priceSpecification.price);
  if (raw == null) return null;
  if (typeof raw === 'number') {
    return Number.isFinite(raw) && raw > 0 ? Math.round(raw * 100) / 100 : null;
  }
  // String prices go through the strict single-token parser, so an ambiguous
  // range like "$95.00-99" or "89-95" is rejected instead of being mashed into
  // a bogus number by stripping the separators.
  return parsePriceText(raw);
}

// Parse one JSON-LD block, tolerating the raw control characters (unescaped
// newlines/tabs inside description strings) that real vendor markup ships and
// strict JSON.parse rejects. Returns null if it's genuinely unparseable.
function safeJsonParse(raw) {
  try { return JSON.parse(raw); } catch {
    try { return JSON.parse(String(raw).replace(/[\u0000-\u001F]+/g, ' ')); } catch { return null; }
  }
}

// Collect EVERY priced offer across all JSON-LD blocks as
// { price, currency, availabilityRaw, name }. The name prefers the per-offer
// name (which carries the variant size on a multi-size page, e.g.
// "Taurus SC Termiticide 78 oz."), falling back to the product node's name.
function collectJsonLdOffers(jsonLdStrings) {
  const blocks = Array.isArray(jsonLdStrings) ? jsonLdStrings : [jsonLdStrings];
  const offers = [];
  for (const raw of blocks) {
    const parsed = safeJsonParse(raw);
    if (!parsed) continue;
    const nodes = [];
    const walk = (n) => {
      if (Array.isArray(n)) { n.forEach(walk); return; }
      if (n && typeof n === 'object') {
        nodes.push(n);
        // Product JSON-LD is commonly nested under @graph or WebPage.mainEntity.
        if (Array.isArray(n['@graph'])) n['@graph'].forEach(walk);
        if (n.mainEntity) walk(n.mainEntity);
      }
    };
    walk(parsed);
    for (const node of nodes) {
      const nodeType = node['@type'];
      let list;
      if (node.offers) {
        list = Array.isArray(node.offers) ? node.offers : [node.offers];
      } else if (nodeType === 'Offer' || nodeType === 'AggregateOffer' || offerPrice(node) != null) {
        // The node IS a top-level / @graph Offer (price + itemOffered), not a
        // Product wrapping an offers array.
        list = [node];
      } else {
        continue;
      }
      const nodeName = typeof node.name === 'string' ? node.name
        : (typeof node.title === 'string' ? node.title : null);
      for (const o of list) {
        const price = offerPrice(o);
        if (price == null) continue;
        // Prefer the offer's own name (variant size), then its itemOffered.name
        // (top-level Offer pages), then the product node's name.
        const offerName = (typeof o.name === 'string' && o.name)
          || (o.itemOffered && typeof o.itemOffered.name === 'string' && o.itemOffered.name)
          || null;
        offers.push({
          price,
          currency: o.priceCurrency
            || (o.priceSpecification && o.priceSpecification.priceCurrency)
            || 'USD',
          availabilityRaw: o.availability || o.availabilityStatus || null,
          // name = display name (offer's own / itemOffered, else product node).
          // ownName = ONLY the per-offer size evidence — a nameless offer must
          // NOT inherit the product node's size, or every nameless/AggregateOffer
          // price would appear to match the requested pack size.
          name: offerName || nodeName,
          ownName: offerName,
          // AggregateOffer.lowPrice is a cheapest-variant price, not proof of any
          // one pack size — flagged so a size-specific scan won't accept it.
          aggregate: o['@type'] === 'AggregateOffer' || (o.price == null && o.lowPrice != null),
        });
      }
    }
  }
  return offers;
}

// Buyability rank for choosing among same-pool offers: a limited-stock price is
// still purchasable and must beat a sold-out one; backorder is unbuyable like
// out_of_stock (lower than 'unknown', so an unknown buyable offer wins over it).
const AVAIL_RANK = { in_stock: 3, limited: 2, unknown: 1, backorder: 0, out_of_stock: 0 };

// Choose one offer from a pool: highest buyability, then CHEAPEST among equals
// (so a sale price beats MSRP, not just whichever the page listed first).
function pickBestOffer(pool) {
  let best = null;
  let bestRank = -1;
  for (const o of pool) {
    const availability = mapAvailability(o.availabilityRaw);
    const rank = AVAIL_RANK[availability] ?? 1;
    const better = !best || rank > bestRank || (rank === bestRank && o.price < best.price);
    if (better) {
      best = { price: o.price, currency: o.currency || 'USD', availability, name: o.name };
      bestRank = rank;
    }
  }
  return best;
}

// Find the best Product/Offer across raw JSON-LD <script> strings and return
// { price, currency, availability, name } or null.
//   opts.targetOz: size-specific scan. Match ONLY on per-offer size evidence
//   (ownName). On a multi-offer page, a nameless/AggregateOffer price can't be
//   attributed to a size, so we never guess — if nothing substantiates the
//   target size we return null rather than pairing a wrong-size price with the
//   requested quantity. A single offer is the product itself, so its display
//   name (which may come from the product node) is allowed as size evidence.
// Within the chosen pool, prefers an in-stock priced offer over an out-of-stock.
function extractJsonLdOffer(jsonLdStrings, opts = {}) {
  const offers = collectJsonLdOffers(jsonLdStrings);
  if (!offers.length) return null;

  if (opts.targetOz && opts.targetOz > 0) {
    const tol = opts.sizeTolerance ?? 0.05;
    const matchesTarget = (sizeText) => {
      const oz = quantityToOz(extractSizeToken(sizeText));
      return !!oz && Math.abs(oz - opts.targetOz) / opts.targetOz <= tol;
    };
    // Trustworthy variant matches: the offer's OWN name parses to the size.
    let pool = offers.filter((o) => o.ownName && matchesTarget(o.ownName));
    if (!pool.length && offers.length === 1) {
      // Single CONCRETE offer = the whole product; its display name is the size
      // evidence. Accept if it matches the target, or carries no size at all (let
      // the downstream title/quantity check verify). An AggregateOffer lowPrice is
      // never accepted this way — it's a cheapest-variant price, not this size.
      const only = offers[0];
      if (!only.aggregate && (!extractSizeToken(only.name) || matchesTarget(only.name))) pool = offers;
    }
    return pool.length ? pickBestOffer(pool) : null;
  }

  return pickBestOffer(offers);
}

// Pull the first pack-size-looking token ("78 oz", "2.5 gal", "1/2 gal",
// "18 lb") out of a free product title, for the quantity field. Returns the raw
// substring (final parse happens via quantityToOz) or null. Longer unit spellings
// are listed first so "gallon" isn't clipped to "gal". Bare single-letter g / l
// are intentionally excluded — pesticide names are full of formulation codes
// ("Dominion 2L", "2G granular", "4F") that would misread as 2 liters / 2 grams.
const SIZE_UNITS = 'fl\\.?\\s*oz|ounce|oz|gallon|gal|quart|qt|pint|pt|pound|lb|liter|litre|ml|kg|gram';
// Multi-pack first: "4 x 78 oz", "4x30g", "2 x 2.5 gal". Returned whole ("4 x 78
// oz") so quantityToOz -> parsePackSize applies the multiplier (a 4 x 78 oz CASE
// is 312 oz, NOT a single 78 oz — critical so a case can't match a single-size
// scan). Bare g/l are allowed HERE because the "N x M unit" shape disambiguates
// them from formulation codes ("Dominion 2L", "2G").
const MULTIPACK_RE = new RegExp(`(\\d+)\\s*x\\s*(\\d+(?:\\.\\d+)?(?:\\s*\\/\\s*\\d+)?)\\s*(${SIZE_UNITS}|gram|g|l)s?\\b`, 'i');
// Mixed number: "2 1/2 gal" -> 2.5 gal. Matched whole before the fraction
// fallback, which would otherwise read just the "1/2 gal" tail (0.5 gal).
const MIXED_RE = new RegExp(`(\\d+)\\s+(\\d+\\s*\\/\\s*\\d+)\\s*(${SIZE_UNITS})s?\\b`, 'i');
const SIZE_UNIT_RE = new RegExp(`(\\d+(?:\\.\\d+)?(?:\\s*\\/\\s*\\d+)?)\\s*(${SIZE_UNITS})s?\\b`, 'i');
// Normalize a captured unit: drop the dot in "fl. oz" and collapse spaces, so
// parsePackSize (which only knows alpha/space units) can resolve it.
const cleanUnit = (u) => String(u).replace(/\./g, '').replace(/\s+/g, ' ').trim();
function extractSizeToken(text) {
  const s = String(text || '');
  const mp = s.match(MULTIPACK_RE);
  if (mp) return `${mp[1]} x ${mp[2].replace(/\s+/g, '')} ${cleanUnit(mp[3])}`.trim();
  const mx = s.match(MIXED_RE);
  if (mx) return `${mx[1]} ${mx[2].replace(/\s+/g, '')} ${cleanUnit(mx[3])}`.trim();
  const m = s.match(SIZE_UNIT_RE);
  if (!m) return null;
  return `${m[1].replace(/\s+/g, '')} ${cleanUnit(m[2])}`.trim();
}

// A non-USD currency marker: a non-$ symbol, a 3-letter ISO code (not USD), or a
// letter-prefixed dollar (C$, CA$, AU$ …; US$ / bare $ stay USD).
function hasNonUsdCurrency(s) {
  return /[€£¥₹₩₪₫₴฿]/.test(s)
    || /\b(?:EUR|GBP|CAD|AUD|JPY|CNY|CHF|MXN|NZD|HKD|SEK|NOK|DKK|BRL|INR|RUB|ZAR)\b/i.test(s)
    || /\b(?:C|CA|A|AU|NZ|HK|MX|R|S)\$/i.test(s);
}

// DOM fallback when JSON-LD has no price. `snapshot` is a small object the
// adapter builds via page.evaluate: { priceTexts: [], title, availabilityText }.
// DOM prices are assumed USD, so a text carrying a non-USD currency is skipped
// (it would otherwise be queued as a USD price, bypassing the scanner's guard).
function extractDomPrice(snapshot = {}) {
  const texts = Array.isArray(snapshot.priceTexts) ? snapshot.priceTexts : [];
  let price = null;
  for (const t of texts) {
    if (hasNonUsdCurrency(t)) continue;
    const p = parsePriceText(t);
    if (p != null) { price = p; break; }
  }
  if (price == null) return null;
  return {
    price,
    currency: 'USD',
    availability: mapAvailability(snapshot.availabilityText),
    name: typeof snapshot.title === 'string' ? snapshot.title : null,
  };
}

// Pick the offer from a scraped snapshot { jsonLd, priceTexts, title,
// availabilityText }. Size-aware JSON-LD first; fall back to a DOM price ONLY
// when the JSON-LD carried NO offers at all. If JSON-LD HAD offers but none
// substantiate opts.targetOz, return null — the structured data is authoritative
// and simply doesn't list our size, so a DOM price (almost always a different /
// default variant) must not be reported as the requested pack.
function offerFromSnapshot(snapshot = {}, opts = {}) {
  const jsonLd = snapshot.jsonLd || [];
  const ldOffer = extractJsonLdOffer(jsonLd, opts);
  if (ldOffer) return ldOffer;
  if (collectJsonLdOffers(jsonLd).length > 0) return null;
  const dom = extractDomPrice(snapshot);
  if (!dom) return null;
  // A DOM price can't be tied to a specific variant. On a size-specific scan,
  // only trust it when the page TITLE substantiates the target size — otherwise
  // a default / "starting at" price for another variant could be reported as the
  // requested pack. (The same size gate the JSON-LD path applies.)
  if (opts.targetOz && opts.targetOz > 0) {
    const tol = opts.sizeTolerance ?? 0.05;
    const titleOz = quantityToOz(extractSizeToken(dom.name));
    if (!titleOz || Math.abs(titleOz - opts.targetOz) / opts.targetOz > tol) return null;
  }
  return dom;
}

// $ per oz-equivalent, matching the inventory pipeline's basis
// (product-costing.normalizeQuantityToOz). Returns null when the pack size
// can't be parsed — never 0 (a 0 would poison best-price ordering downstream).
function deriveNormalizedUnitPrice(price, quantity) {
  const p = Number(price);
  if (!Number.isFinite(p) || p <= 0) return null;
  const oz = quantityToOz(quantity);
  if (!oz || oz <= 0) return null;
  return Math.round((p / oz) * 1e6) / 1e6;
}

function nameTokens(s) {
  return new Set(
    String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length >= 3),
  );
}
function tokenOverlap(a, b) {
  const A = nameTokens(a);
  const B = nameTokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter += 1;
  return inter / Math.min(A.size, B.size);
}

// Shared distinctive-token count + the expected name's token count. verifyMatch
// scores coverage of the EXPECTED (branded) name rather than the smaller set —
// otherwise a generic subset like "Termiticide 78 oz" scores a perfect overlap
// against "Taurus SC Termiticide" and slips past the trust gate.
function sharedTokenStats(scrapedName, expectedName) {
  const A = nameTokens(scrapedName);
  const B = nameTokens(expectedName);
  let inter = 0;
  for (const t of A) if (B.has(t)) inter += 1;
  return { inter, expectedSize: B.size };
}

// Pesticide formulation codes (SC, CS, EC, WP, 2L, XTS, I/T, …) are the short
// tokens nameTokens drops, yet they separate otherwise same-brand products
// (Taurus SC vs Taurus CS, Bifen I/T vs Bifen XTS). Collect them so verifyMatch
// can require a confirmed formulation, not just brand + generic-category overlap.
// Excludes unit abbreviations and generic category/marketing words so they're
// not treated as a formulation.
const UNIT_ABBREVS = new Set(['oz', 'ml', 'lb', 'pt', 'qt', 'fl', 'cc', 'kg', 'gm', 'gr', 'gal']);
const GENERIC_WORDS = new Set([
  'pro', 'max', 'plus', 'the', 'and', 'for', 'with', 'kit', 'new', 'bug', 'pest',
  'lawn', 'turf', 'use', 'gel', 'dry', 'wet', 'oil',
  // packaging descriptors — not a formulation ('cs' is intentionally NOT here;
  // it's the CS formulation code, e.g. Taurus CS)
  'jug', 'can', 'bag', 'box', 'pak', 'tub', 'jar', 'ea',
]);
// Single-letter formulation suffixes that genuinely separate products:
// G granular, D dust, F flowable, L liquid, W wettable (Demand CS vs Demand G).
const SINGLE_CHAR_FORM = new Set(['g', 'd', 'f', 'l', 'w']);
function formulationCodes(name) {
  const raw = String(name || '').toLowerCase();
  const codes = new Set();
  // Slashed markers like "I/T", "F/C" -> "it", "fc" (lost when slashes are
  // stripped to spaces and the letters become 1-char tokens).
  for (const m of raw.matchAll(/\b([a-z])\s*\/\s*([a-z])\b/g)) codes.add(m[1] + m[2]);
  for (const tok of raw.replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)) {
    // 2-3 char alphanumeric codes (must contain a letter), minus units / generics
    // / pure numbers (a bare size like "78" or "96" isn't a formulation).
    if (tok.length >= 2 && tok.length <= 3 && /[a-z]/.test(tok)
      && !/^\d+$/.test(tok) && !UNIT_ABBREVS.has(tok) && !GENERIC_WORDS.has(tok)) {
      codes.add(tok);
    } else if (tok.length === 1 && SINGLE_CHAR_FORM.has(tok)) {
      codes.add(tok);
    }
  }
  return codes;
}
// Normalize an EPA registration to its company-product key ("53883-279-1234" ->
// "53883-279"). The first two segments identify the product; a trailing
// distributor segment is dropped. Returns null if it isn't reg-shaped.
function epaKey(reg) {
  const segs = String(reg || '').match(/\d+/g);
  if (!segs || segs.length < 2) return null;
  if (segs[0].length < 2 || segs[0].length > 7 || segs[1].length > 4) return null;
  return `${segs[0]}-${segs[1]}`;
}

// True if any EPA-reg-shaped token in `text` has the same company-product key as
// the expected reg. Tokenizes (with boundaries) rather than concatenating every
// digit on the page, so a match can't span unrelated prices / SKUs / addresses.
function epaInText(text, expectedReg) {
  const want = epaKey(expectedReg);
  if (!want) return false;
  const tokens = String(text || '').match(/\d{2,7}-\d{1,4}(?:-\d{1,5})?/g) || [];
  return tokens.some((tok) => epaKey(tok) === want);
}

// The trust gate before believing any scraped price for a product.
// scraped:  { name, text?, quantity }
// expected: { productName, vendorProductName?, epaReg?, packSizeValue?, packSizeUnit?, quantity? }
// Returns { matched, signals:{ name, epa, packSize }, sizeKnown }.
function verifyMatch(scraped = {}, expected = {}, opts = {}) {
  const sizeTolerance = opts.sizeTolerance ?? 0.05;
  const nameThreshold = opts.nameThreshold ?? 0.5;
  const signals = { name: false, epa: false, packSize: false };

  const scrapedOz = quantityToOz(scraped.quantity);
  const expectedOz = (expected.packSizeValue != null && expected.packSizeUnit)
    ? convertToOz(expected.packSizeValue, expected.packSizeUnit)
    : quantityToOz(expected.quantity);
  const sizeKnown = !!(scrapedOz && expectedOz);
  if (sizeKnown) {
    signals.packSize = Math.abs(scrapedOz - expectedOz) / expectedOz <= sizeTolerance;
  }

  const expName = expected.vendorProductName || expected.productName || expected.name;
  if (scraped.name && expName) {
    const { inter, expectedSize } = sharedTokenStats(scraped.name, expName);
    // Coverage of the EXPECTED name (not the smaller token set), AND at least 2
    // shared distinctive tokens when the expected name has them — so a lone
    // category word ("Termiticide") can't satisfy the name signal on its own.
    // Single-token brands still match on that one brand token. Erring toward a
    // miss (no savings alert) is the safe direction vs. trusting a wrong price.
    const coverage = expectedSize ? inter / expectedSize : 0;
    signals.name = coverage >= nameThreshold && inter >= Math.min(2, expectedSize);
    // Formulation guard: if the expected name carries a formulation code that the
    // scraped name doesn't, it's a different formulation of the same brand
    // (Taurus SC vs Taurus CS) — drop the name signal so it can only verify via
    // EPA, never on brand overlap alone.
    if (signals.name) {
      const expCodes = formulationCodes(expName);
      const scrCodes = formulationCodes(scraped.name);
      if (expCodes.size && ![...expCodes].every((c) => scrCodes.has(c))) signals.name = false;
    }
  }

  if (epaKey(expected.epaReg)) {
    signals.epa = epaInText(`${scraped.name || ''} ${scraped.text || ''}`, expected.epaReg);
  }

  // With a known pack size: size must match AND (name OR epa).
  // Without a size to check: require BOTH name AND epa (stronger), so we never
  // trust a bare name-overlap that could be a different formulation/size.
  const matched = sizeKnown
    ? signals.packSize && (signals.name || signals.epa)
    : signals.name && signals.epa;

  return { matched, signals, sizeKnown };
}

module.exports = {
  AVAILABILITY,
  mapAvailability,
  parsePriceText,
  offerPrice,
  extractJsonLdOffer,
  extractDomPrice,
  offerFromSnapshot,
  extractSizeToken,
  quantityToOz,
  deriveNormalizedUnitPrice,
  tokenOverlap,
  verifyMatch,
};
