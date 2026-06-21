// Autonomous weekly vendor price scan (PR4 of the price-scan lane). The piece that
// makes the lane actually RUN by itself: pick the products we spend the most on
// that have a SiteOne baseline, scan a competitor (DoMyOwn) for a cheaper published
// per-unit price, and stage ONE price-match draft for the SiteOne rep (Mark) in
// /admin/price-match. Nothing is emailed — a human reviews + sends the draft.
//
// Layering: this module is pure orchestration + DB. The browser I/O is injected
// (scanner.runScanMany) so the assembly + opportunity mapping stay unit-tested,
// and a missing Playwright browser degrades to a clean skip rather than a crash.

const dbModule = require('../../models/db');
const logger = require('../logger');
const { runScanMany } = require('./scanner');
const { createDraft } = require('./price-match-draft');

// How many top-spend products to scan per run. Kept modest — each is a live scrape.
const DEFAULT_LIMIT = Number(process.env.PRICE_SCAN_MAX_PRODUCTS) || 25;

// The codebase's canonical "live price" gate (see price_sync_control_layer): only
// operator-approved, active vendor_pricing rows. Critically this EXCLUDES the
// Hermes worker's `pending` rows, so an unapproved/auto-ingested URL never feeds the
// live browser and an unapproved price never becomes a SiteOne baseline.
const APPROVED_STATES = ['approved', 'auto_approved'];

// Only navigate a competitor URL we can confirm is on the expected host — a
// mis-mapped/foreign URL is dropped (the adapter then searches DoMyOwn by name).
function isDomyownUrl(url) {
  try {
    const host = new URL(String(url)).hostname.toLowerCase();
    return host === 'domyown.com' || host.endsWith('.domyown.com');
  } catch { return false; }
}

// Tolerant parse of a draft's `matches` (jsonb -> array, but accept a string too).
function parseMatches(m) {
  if (Array.isArray(m)) return m;
  if (typeof m === 'string') { try { return JSON.parse(m); } catch { return []; } }
  return [];
}

// Content key for ONE opportunity line — product + competitor URL + both prices. A
// changed price yields a new key (a genuinely new ask). Dedup is PER-MATCH, not
// per-draft, so a later {A,B} scan when {A} is already pending re-stages only B.
function matchKey(m) {
  return [
    String((m && m.product) || '').toLowerCase().trim(),
    String((m && m.competitor && m.competitor.source_url) || ''),
    Number(m && m.competitor && m.competitor.price) || 0,
    Number(m && m.baseline && m.baseline.price) || 0,
  ].join('|');
}

// Every per-match key currently awaiting review/send — so we never re-stage an ask
// the operator could send to the rep twice. (Runs serialized by runExclusive, so
// there's no concurrent-insert race against this read.)
async function activeMatchKeys(db) {
  const rows = await db('price_match_drafts').whereIn('status', ['pending', 'sending']).select('matches');
  const keys = new Set();
  for (const r of rows) for (const m of parseMatches(r.matches)) keys.add(matchKey(m));
  return keys;
}

// Look up a vendor row by case-insensitive name.
async function vendorByName(db, name) {
  return db('vendors').whereRaw('lower(name) = lower(?)', [name]).first();
}

// PURE: a baseline DB row -> { product, vendors, spend } for scanProduct/runScanMany.
// `quantity` is the pack we compare on — prefer SiteOne's own pack string, then the
// catalog container_size, then the numeric unit_size_oz. The competitor target URL
// is optional: with it the adapter scrapes the product page directly; without it the
// adapter searches the vendor by name.
function toScanSpec(row, { domyownId, domyownName, domyownUrl } = {}) {
  const quantity = row.siteone_quantity
    || row.container_size
    || (row.unit_size_oz ? `${row.unit_size_oz} oz` : null);
  const product = {
    product_id: row.id,
    name: row.name,
    productName: row.name,
    vendorProductName: row.name, // the search query when there's no direct URL
    epaReg: row.epa_reg_number || null,
    quantity,
    baseline: {
      vendor: 'SiteOne',
      price: Number(row.siteone_price),
      quantity: row.siteone_quantity || quantity,
    },
  };
  const vendors = [{
    vendor_id: domyownId,
    name: domyownName || 'DoMyOwn',
    url: domyownUrl || null,
  }];
  return { product, vendors, spend: Number(row.monthly_cost_estimate) || 0 };
}

// PURE: dedup baseline rows to one per product (caller orders by recency so the
// first row per product wins), rank by monthly spend (then SiteOne price), take the
// top `limit`, and shape each into a scan spec. `urlByProductId` is a Map of
// product_id -> DoMyOwn product URL (optional).
function assembleScanSpecs(baselineRows, urlByProductId, { limit = DEFAULT_LIMIT, domyownId, domyownName } = {}) {
  const byProduct = new Map();
  for (const r of baselineRows || []) if (!byProduct.has(r.id)) byProduct.set(r.id, r);
  const ranked = [...byProduct.values()].sort((a, b) => (
    (Number(b.monthly_cost_estimate) || 0) - (Number(a.monthly_cost_estimate) || 0)
    || (Number(b.siteone_price) || 0) - (Number(a.siteone_price) || 0)
  ));
  return ranked.slice(0, Math.max(0, limit)).map((r) => toScanSpec(r, {
    domyownId,
    domyownName,
    domyownUrl: urlByProductId ? urlByProductId.get(r.id) : null,
  }));
}

// Fetch top-spend products that have a SiteOne baseline price + their DoMyOwn URLs,
// then assemble scan specs. Wrapped so a schema surprise degrades to an empty list
// (the cron logs zero rather than crashing).
async function selectScanProducts(db, { limit = DEFAULT_LIMIT, siteoneId, domyownId, domyownName } = {}) {
  try {
    const baselineRows = await db('products_catalog as pc')
      .join('vendor_pricing as so', 'so.product_id', 'pc.id')
      .where('so.vendor_id', siteoneId)
      .andWhere('so.price', '>', 0)
      .andWhere('so.is_active', true)
      .whereIn('so.approval_status', APPROVED_STATES) // never baseline off an unapproved/pending price
      .andWhere((b) => b.where('pc.active', true).orWhereNull('pc.active'))
      .select(
        'pc.id', 'pc.name', 'pc.epa_reg_number', 'pc.formulation',
        'pc.container_size', 'pc.unit_size_oz', 'pc.monthly_cost_estimate',
        'so.price as siteone_price', 'so.quantity as siteone_quantity', 'so.unit as siteone_unit',
      )
      .orderBy('so.last_checked_at', 'desc'); // most-recent SiteOne row wins the per-product dedup

    const ids = [...new Set(baselineRows.map((r) => r.id))];
    const urlByProductId = new Map();
    if (domyownId && ids.length) {
      const dmoRows = await db('vendor_pricing')
        .where('vendor_id', domyownId)
        .andWhere('is_active', true)
        .whereIn('approval_status', APPROVED_STATES) // never hand a pending/unapproved URL to the browser
        .whereIn('product_id', ids)
        .whereNotNull('vendor_product_url')
        .select('product_id', 'vendor_product_url');
      // ...and only an on-host URL is navigated; anything else falls back to search.
      for (const d of dmoRows) {
        if (!urlByProductId.has(d.product_id) && isDomyownUrl(d.vendor_product_url)) {
          urlByProductId.set(d.product_id, d.vendor_product_url);
        }
      }
    }
    return assembleScanSpecs(baselineRows, urlByProductId, { limit, domyownId, domyownName });
  } catch (err) {
    logger.error(`[price-scan] product selection failed: ${err.message}`);
    return [];
  }
}

// PURE: a scan result -> a composeMarkEmail match, or null when it isn't a real
// opportunity. createDraft re-applies the proof / per-unit / positive-savings gates,
// so this only needs to forward the winning competitor against the SiteOne baseline.
function opportunityToMatch(product, scan) {
  const opp = scan && scan.opportunity;
  if (!opp || !opp.isOpportunity || !opp.best || !opp.baseline) return null;
  const best = opp.best;
  return {
    product: product.name,
    epaReg: product.epaReg || null,
    baseline: { vendor: opp.baseline.vendor || 'SiteOne', price: Number(opp.baseline.price), quantity: opp.baseline.quantity },
    competitor: {
      vendor: best.vendor || 'DoMyOwn',
      price: Number(best.price),
      quantity: best.quantity,
      source_url: best.source_url,
      name: best.name || null,
    },
  };
}

// Heuristic: did the batch fail because the headless browser isn't available in
// this environment (no playwright package / no chromium binary)? Then it's a clean
// skip, not an error to alarm on.
function isBrowserUnavailable(err) {
  return /playwright|chromium|browser|executable|launch|ENOENT/i.test((err && err.message) || '');
}

// Run one weekly scan. Returns a summary; never throws. deps are injectable for tests:
//   { db, scanMany, createDraft, selectSpecs, vendorByName, limit, selectOnly }
async function runWeeklyScan(opts = {}) {
  const db = opts.db || dbModule;
  const scanMany = opts.scanMany || runScanMany;
  const create = opts.createDraft || createDraft;
  const resolveVendor = opts.vendorByName || vendorByName;
  const limit = opts.limit || DEFAULT_LIMIT;

  const [siteone, domyown] = await Promise.all([resolveVendor(db, 'SiteOne'), resolveVendor(db, 'DoMyOwn')]);
  if (!siteone || !domyown) {
    logger.warn('[price-scan] weekly scan skipped — SiteOne/DoMyOwn vendor row missing');
    return { ok: false, reason: 'vendors_missing', evaluated: 0 };
  }

  const specs = opts.specs || await (opts.selectSpecs || selectScanProducts)(db, {
    limit, siteoneId: siteone.id, domyownId: domyown.id, domyownName: domyown.name,
  });

  // Verification mode: prove the selection without launching the browser.
  if (opts.selectOnly) {
    logger.info(`[price-scan] weekly scan (select-only): ${specs.length} products`);
    return { ok: true, selectOnly: true, evaluated: specs.length, products: specs.map((s) => s.product.name) };
  }
  if (!specs.length) {
    logger.info('[price-scan] weekly scan: no products with a SiteOne baseline to scan');
    return { ok: true, evaluated: 0, scanned: 0, opportunities: 0, draftId: null };
  }

  let results;
  try {
    results = await scanMany(specs, { headless: true });
  } catch (err) {
    const reason = isBrowserUnavailable(err) ? 'browser_unavailable' : 'scan_error';
    logger[reason === 'browser_unavailable' ? 'warn' : 'error'](`[price-scan] weekly scan aborted (${reason}): ${err.message}`);
    return { ok: false, reason, evaluated: specs.length };
  }

  const summary = { evaluated: specs.length, scanned: 0, opportunities: 0, errors: 0 };
  const matches = [];
  for (const r of results) {
    if (r.error) {
      summary.errors += 1;
      logger.warn(`[price-scan] scan failed for ${r.product && r.product.name}: ${r.error.message}`);
      continue;
    }
    summary.scanned += 1;
    const match = opportunityToMatch(r.product, r.scan);
    if (match) { matches.push(match); summary.opportunities += 1; }
  }

  let draftId = null;
  let includedCount = 0;
  summary.duplicates = 0;
  if (matches.length) {
    // Drop any opportunity already covered by a pending/sending draft (PER-MATCH, so
    // {A} pending + a new {A,B} scan stages only B) — a retry or next week's run
    // can't re-stage an ask the operator could send to the rep twice.
    const seen = opts.activeMatchKeys || await activeMatchKeys(db);
    const fresh = matches.filter((m) => !seen.has(matchKey(m)));
    summary.duplicates = matches.length - fresh.length;
    if (!fresh.length) {
      logger.info('[price-scan] weekly scan: all opportunities already covered by an active draft — nothing new to stage');
    } else {
      const row = await create(db, fresh);
      draftId = row ? row.id : null;
      includedCount = row ? row.included_count : 0;
    }
  }
  logger.info(`[price-scan] weekly scan: ${summary.evaluated} eval, ${summary.scanned} scanned, ${summary.opportunities} opps, ${summary.duplicates} dup, ${summary.errors} err -> draft ${draftId || 'none'} (${includedCount} items)`);
  return { ok: true, ...summary, draftId, includedCount };
}

module.exports = {
  runWeeklyScan,
  selectScanProducts,
  assembleScanSpecs,
  toScanSpec,
  opportunityToMatch,
  isBrowserUnavailable,
  isDomyownUrl,
  matchKey,
  activeMatchKeys,
  parseMatches,
  vendorByName,
  APPROVED_STATES,
  DEFAULT_LIMIT,
};
