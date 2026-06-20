// Scanner engine: orchestrate a vendor price scan for one product. For each
// vendor it drives that vendor's adapter to fetch a candidate price, verifies
// the candidate against the product spec (verifyMatch trust gate), ranks the
// verified candidates against the SiteOne baseline (compare.findOpportunity),
// and shapes them into /report items (integrations-vendor-price-worker contract).
//
// The Playwright I/O lives in the adapters and is injected here as
// `deps.fetchCandidate`, so this orchestration — and the proof-of-price gating —
// stay pure and unit-tested. The live browser wiring is in runScan().

const { verifyMatch, deriveNormalizedUnitPrice } = require('./extract');
const { findOpportunity, isUnavailable } = require('./compare');
const { selectAdapterKey, getAdapter } = require('./adapters/registry');

// Tags every scanner-reported price so it's distinguishable from manual / feed /
// api prices downstream. Matches the worker's SOURCE_TYPE.
const SOURCE_TYPE = 'hermes_price_report';

// A scraped price is only worth landing in the review queue / emailing to Mark
// if it carries PROOF: the vendor product URL it was read from. No URL -> no ask.
function hasProof(candidate) {
  const url = candidate && candidate.source_url;
  return typeof url === 'string' && /^https?:\/\/\S+/i.test(url.trim());
}

const vendorLabel = (vendor) => (vendor && (vendor.name || vendor.vendor_id)) || 'unknown-vendor';

// Shape one VERIFIED candidate into a /report item. Returns null when the
// candidate lacks proof, a usable price, or a vendor id — so a proofless or
// junk price can never reach the review queue. PURE.
function buildReportItem(product, candidate) {
  if (!product || !candidate) return null;
  if (!hasProof(candidate)) return null;
  // USD only — the review queue + best_price are bare USD amounts, and the
  // worker rejects non-USD anyway. Never shape a non-USD price into an item.
  if ((candidate.currency || 'USD').toUpperCase() !== 'USD') return null;
  const price = Number(candidate.price);
  if (!Number.isFinite(price) || price <= 0) return null;
  const vendorId = candidate.vendor_id || candidate.vendorId;
  if (!vendorId) return null;

  const availabilityStatus = candidate.availability || candidate.availability_status || 'unknown';
  // Only buyable prices feed the best-price approval path. An out_of_stock /
  // backorder match is real but not a price to undercut to.
  if (isUnavailable({ availability_status: availabilityStatus })) return null;

  // ONLY the scraped size — never borrow product.quantity (the expected size).
  // A name+EPA match (verifyMatch sizeKnown=false) can be a different pack;
  // borrowing the expected size would fabricate a $/oz. And without a parseable
  // size we can't compute normalized_unit_price — the downstream approver then
  // falls back to TOTAL price for best-price ordering, so a sizeless price could
  // be approved as products_catalog.best_price. Don't emit it; it stays in
  // scan.verified (for the Mark email) but out of the /report approval path.
  const quantity = candidate.quantity || null;
  const normalizedUnitPrice = deriveNormalizedUnitPrice(price, quantity);
  if (normalizedUnitPrice == null) return null;

  return {
    vendor_id: vendorId,
    product_id: product.product_id || product.id || null,
    vendor_sku: candidate.vendor_sku || null,
    // The proof link. Worker stores the full URL in price_snapshots.source_url.
    source_url: candidate.source_url.trim(),
    price: Math.round(price * 100) / 100,
    currency: (candidate.currency || 'USD').toUpperCase(),
    // Public scrapers report public pricing; the logged-in Veseris adapter (PR2b)
    // overrides this to 'account'.
    price_type: candidate.price_type || 'public',
    availability_status: availabilityStatus,
    quantity,
    normalized_unit_price: normalizedUnitPrice,
    source_type: SOURCE_TYPE,
  };
}

// Scan one product across vendors. Returns verified candidates, the
// opportunity vs the SiteOne baseline, and a skip ledger (so a silently-dropped
// vendor is always explained, never invisible).
//
//   product: { name, productName, vendorProductName?, epaReg?, packSizeValue?,
//              packSizeUnit?, quantity?, product_id?, baseline? }
//   vendors: [{ vendor_id, name?, host?, url?, searchUrl? }]
//   deps.fetchCandidate(adapter, vendor, product) -> candidate | null  (injected I/O)
async function scanProduct(product, vendors, deps = {}) {
  const fetchCandidate = deps.fetchCandidate;
  if (typeof fetchCandidate !== 'function') {
    throw new Error('scanProduct requires deps.fetchCandidate (the Playwright I/O)');
  }
  const verified = [];
  const skipped = [];

  for (const vendor of vendors || []) {
    const adapter = getAdapter(selectAdapterKey(vendor));
    let candidate;
    try {
      candidate = await fetchCandidate(adapter, vendor, product);
    } catch (err) {
      skipped.push({ vendor: vendorLabel(vendor), reason: 'fetch_error', detail: err.message });
      continue;
    }
    if (!candidate) {
      skipped.push({ vendor: vendorLabel(vendor), reason: 'no_candidate' });
      continue;
    }
    // Drop non-USD before verification/opportunity so a CAD/EUR number can't be
    // ranked against the USD baseline and printed as a (false) opportunity.
    const currency = (candidate.currency || 'USD').toUpperCase();
    if (currency !== 'USD') {
      skipped.push({ vendor: vendorLabel(vendor), reason: 'non_usd', detail: currency });
      continue;
    }
    const verdict = verifyMatch(
      {
        name: candidate.name,
        text: candidate.text,
        quantity: candidate.quantity,
        // Page had competing same-size offers -> a body-only EPA can't verify alone.
        competingOffers: candidate.competing_same_size,
      },
      product,
    );
    if (!verdict.matched) {
      skipped.push({ vendor: vendorLabel(vendor), reason: 'unverified', signals: verdict.signals });
      continue;
    }
    if (!hasProof(candidate)) {
      skipped.push({ vendor: vendorLabel(vendor), reason: 'no_proof_url' });
      continue;
    }
    verified.push({
      ...candidate,
      // vendor_id = real vendors.id (UUID) for /report — supports a DB row's
      // `.id`. The adapter slug (selectAdapterKey) is separate, never used here.
      vendor_id: candidate.vendor_id || vendor.vendor_id || vendor.id,
      vendor: candidate.vendor || vendor.name || vendor.vendor_id || vendor.id,
      verdict,
    });
  }

  const opportunity = findOpportunity(product.baseline, verified);
  return { product: product.name || product.productName || null, verified, skipped, opportunity };
}

// Turn a scan result into /report items — only the verified, proof-bearing
// candidates. PURE. The caller POSTs these to integrations-vendor-price-worker.
function reportItemsFromScan(product, scan) {
  return (scan && scan.verified ? scan.verified : [])
    .map((c) => buildReportItem(product, c))
    .filter(Boolean);
}

const DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
  + 'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Live entry point: launch a headless browser and scan for real, giving each
// vendor its own page. Lazy-requires playwright so importing scanner.js (engine
// + pure helpers) never needs a browser. This is the I/O wrapper around the
// unit-tested scanProduct; the live Taurus SC proof drives it.
async function runScan(product, vendors, opts = {}) {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: opts.headless !== false });
  try {
    const context = await browser.newContext({ userAgent: opts.userAgent || DESKTOP_UA });
    const fetchCandidate = async (adapter, vendor, prod) => {
      const page = await context.newPage();
      try {
        return await adapter.fetchCandidate(page, vendor, prod);
      } finally {
        await page.close().catch(() => {});
      }
    };
    return await scanProduct(product, vendors, { fetchCandidate });
  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = {
  SOURCE_TYPE,
  hasProof,
  buildReportItem,
  scanProduct,
  reportItemsFromScan,
  runScan,
};
