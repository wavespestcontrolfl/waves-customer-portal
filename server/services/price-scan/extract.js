// Pure parsing + match-verification helpers for the vendor price scanner.
// Everything here is deterministic and unit-tested — no network, no DB, no
// browser. The adapters (PR2) pull raw strings off the page with Playwright and
// hand them to these functions, so the messy parsing logic stays testable.

const { normalizeQuantityToOz, convertToOz } = require('../product-costing');

// Matches the /report contract enum (integrations-vendor-price-worker.js).
const AVAILABILITY = ['in_stock', 'limited', 'out_of_stock', 'backorder', 'unknown'];

// Map a schema.org availability URL/token OR free DOM text to our enum.
function mapAvailability(value) {
  const s = String(value || '').toLowerCase();
  if (!s) return 'unknown';
  if (/out[\s_-]?of[\s_-]?stock|outofstock|sold[\s_-]?out|unavailable|discontinued/.test(s)) return 'out_of_stock';
  if (/back[\s_-]?order|backorder|pre[\s_-]?order|preorder/.test(s)) return 'backorder';
  if (/limited[\s_-]?availability|limitedavailability|low[\s_-]?stock|only\s+\d+\s+left/.test(s)) return 'limited';
  if (/in[\s_-]?stock|instock/.test(s)) return 'in_stock';
  return 'unknown';
}

// Parse a price string into a positive number, or null. Strict: rejects ranges,
// "call for price", empty, and non-positive. "$1,234.50" -> 1234.5.
function parsePriceText(text) {
  if (text == null) return null;
  const s = String(text).trim();
  if (!s) return null;
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
  const n = typeof raw === 'number' ? raw : Number(String(raw).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

function readOffer(node) {
  const offers = node && node.offers;
  if (!offers) return null;
  const list = Array.isArray(offers) ? offers : [offers];
  for (const o of list) {
    const price = offerPrice(o);
    if (price != null) {
      return {
        price,
        currency: o.priceCurrency
          || (o.priceSpecification && o.priceSpecification.priceCurrency)
          || null,
        availability: o.availability || o.availabilityStatus || null,
      };
    }
  }
  return null;
}

// Given an array of raw JSON-LD <script> string contents, find the best
// Product/Offer and return { price, currency, availability, name } or null.
// Prefers an in-stock priced offer over an out-of-stock one.
function extractJsonLdOffer(jsonLdStrings) {
  const blocks = Array.isArray(jsonLdStrings) ? jsonLdStrings : [jsonLdStrings];
  let best = null;
  for (const raw of blocks) {
    let parsed;
    try { parsed = JSON.parse(raw); } catch { continue; }
    const nodes = [];
    const walk = (n) => {
      if (Array.isArray(n)) { n.forEach(walk); return; }
      if (n && typeof n === 'object') {
        nodes.push(n);
        if (Array.isArray(n['@graph'])) n['@graph'].forEach(walk);
      }
    };
    walk(parsed);
    for (const node of nodes) {
      const offer = readOffer(node);
      if (!offer) continue;
      const cand = {
        price: offer.price,
        currency: offer.currency || 'USD',
        availability: mapAvailability(offer.availability),
        name: typeof node.name === 'string' ? node.name
          : (typeof node.title === 'string' ? node.title : null),
      };
      if (!best) best = cand;
      else if (best.availability !== 'in_stock' && cand.availability === 'in_stock') best = cand;
    }
  }
  return best;
}

// DOM fallback when JSON-LD has no price. `snapshot` is a small object the
// adapter builds via page.evaluate: { priceTexts: [], title, availabilityText }.
function extractDomPrice(snapshot = {}) {
  const texts = Array.isArray(snapshot.priceTexts) ? snapshot.priceTexts : [];
  let price = null;
  for (const t of texts) { const p = parsePriceText(t); if (p != null) { price = p; break; } }
  if (price == null) return null;
  return {
    price,
    currency: 'USD',
    availability: mapAvailability(snapshot.availabilityText),
    name: typeof snapshot.title === 'string' ? snapshot.title : null,
  };
}

// $ per oz-equivalent, matching the inventory pipeline's basis
// (product-costing.normalizeQuantityToOz). Returns null when the pack size
// can't be parsed — never 0 (a 0 would poison best-price ordering downstream).
function deriveNormalizedUnitPrice(price, quantity) {
  const p = Number(price);
  if (!Number.isFinite(p) || p <= 0) return null;
  const oz = normalizeQuantityToOz(quantity);
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
const digitsOnly = (s) => String(s || '').replace(/[^0-9]/g, '');

// The trust gate before believing any scraped price for a product.
// scraped:  { name, text?, quantity }
// expected: { productName, vendorProductName?, epaReg?, packSizeValue?, packSizeUnit?, quantity? }
// Returns { matched, signals:{ name, epa, packSize }, sizeKnown }.
function verifyMatch(scraped = {}, expected = {}, opts = {}) {
  const sizeTolerance = opts.sizeTolerance ?? 0.05;
  const nameThreshold = opts.nameThreshold ?? 0.5;
  const signals = { name: false, epa: false, packSize: false };

  const scrapedOz = normalizeQuantityToOz(scraped.quantity);
  const expectedOz = (expected.packSizeValue != null && expected.packSizeUnit)
    ? convertToOz(expected.packSizeValue, expected.packSizeUnit)
    : normalizeQuantityToOz(expected.quantity);
  const sizeKnown = !!(scrapedOz && expectedOz);
  if (sizeKnown) {
    signals.packSize = Math.abs(scrapedOz - expectedOz) / expectedOz <= sizeTolerance;
  }

  const expName = expected.vendorProductName || expected.productName || expected.name;
  if (scraped.name && expName) {
    signals.name = tokenOverlap(scraped.name, expName) >= nameThreshold;
  }

  const expEpa = digitsOnly(expected.epaReg);
  if (expEpa && expEpa.length >= 5) {
    const hay = digitsOnly(`${scraped.name || ''} ${scraped.text || ''}`);
    signals.epa = hay.includes(expEpa);
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
  deriveNormalizedUnitPrice,
  tokenOverlap,
  verifyMatch,
};
