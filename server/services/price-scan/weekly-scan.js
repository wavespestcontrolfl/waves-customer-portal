// Autonomous weekly vendor price scan (price-scan lane). The piece that makes the
// lane RUN by itself: pick the products we spend the most on that have a SiteOne
// baseline, scan the public competitors we have adapters for (DoMyOwn / Solutions /
// Keystone) for a cheaper published per-unit price, and stage ONE price-match draft
// for the SiteOne rep (Mark) in /admin/price-match. Nothing is emailed — a human
// reviews + sends the draft.
//
// Layering: this module is pure orchestration + DB. The browser I/O is injected
// (scanner.runScanMany) so the assembly + opportunity mapping stay unit-tested, and
// a missing Playwright browser degrades to a clean skip rather than a crash.

const dbModule = require('../../models/db');
const logger = require('../logger');
const { runScanMany } = require('./scanner');
const { createDraft } = require('./price-match-draft');
const { selectAdapterKey } = require('./adapters/registry');
const { quantityToOz } = require('./extract');
const { getVendorLoginCredentials } = require('../vendor-credentials');

// A pack size is only usable if it normalizes to oz — that's exactly what verifyMatch's
// size gate and the per-unit ($/oz) comparison need. In practice vendor_pricing.quantity
// is often the catalog placeholder "Each (1)" (the real size lives in
// products_catalog.container_size / unit_size_oz; the unit is split into
// vendor_pricing.unit), and a count like "1 station" is a device, not a measure. None of
// those can be compared, so they must NOT shadow a real size column. Returns the trimmed
// string when it parses, else null.
function realPackSize(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return null;
  return quantityToOz(s) != null ? s : null;
}

// How many top-spend products to scan per run. Kept modest — each product is scraped
// across every scrapable vendor, so this bounds total live page loads.
const DEFAULT_LIMIT = Number(process.env.PRICE_SCAN_MAX_PRODUCTS) || 25;

// The codebase's canonical "live price" gate (see price_sync_control_layer): only
// operator-approved, active vendor_pricing rows. Critically this EXCLUDES the Hermes
// worker's `pending` rows, so an unapproved/auto-ingested URL never feeds the live
// browser and an unapproved price never becomes a SiteOne baseline.
const APPROVED_STATES = ['approved', 'auto_approved'];

// The storefronts we have a bespoke, search-capable adapter for. A vendor is only scanned
// if it's price_scraping_enabled AND resolves to one of these; everything else falls to the
// generic adapter (direct URL, no search), so it's not driven autonomously. Veseris is a
// LOGIN adapter — it additionally needs decrypted credentials attached (see LOGIN_ADAPTER_KEYS).
const SCRAPABLE_ADAPTER_KEYS = ['domyown', 'solutions', 'keystone', 'veseris'];

// Adapters that authenticate before scraping (account pricing). For these, the weekly scan
// decrypts the vendor's stored credentials and attaches them to the scan spec.
const LOGIN_ADAPTER_KEYS = new Set(['veseris']);

const hostOf = (url) => {
  try { return new URL(String(url)).hostname.toLowerCase(); } catch { return null; }
};
const baseHost = (h) => String(h || '').toLowerCase().replace(/^www\./, '');

// A scraped URL is only navigated if it's actually on the vendor's own host — a
// mis-mapped/foreign URL is dropped (the adapter then searches that vendor by name).
// `vendorWebsite` may be a full URL or a bare host.
function isOnHost(url, vendorWebsite) {
  const h = baseHost(hostOf(url));
  const e = baseHost(hostOf(vendorWebsite) || vendorWebsite);
  if (!h || !e) return false;
  return h === e || h.endsWith(`.${e}`);
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

// The competitor vendors to scan: price_scraping_enabled + active + backed by one of
// our bespoke adapters. DB-driven, so toggling vendors is a flag flip, not a deploy.
async function scrapableVendors(db) {
  const rows = await db('vendors')
    .where('price_scraping_enabled', true)
    .andWhere((b) => b.where('active', true).orWhereNull('active'))
    .select('id', 'name', 'website');
  return rows.filter((v) => SCRAPABLE_ADAPTER_KEYS.includes(selectAdapterKey({ name: v.name, url: v.website })));
}

// PURE: a baseline DB row + the competitor vendor list -> { product, vendors, spend }
// for scanProduct/runScanMany. `quantity` is the pack we compare on — prefer
// SiteOne's own pack string, then catalog container_size, then numeric unit_size_oz.
// Each vendor's URL (host-validated, optional) is looked up in urlByVendorId; without
// one the adapter searches that vendor by name.
function toScanSpec(row, vendors = [], urlByVendorId = null) {
  // Prefer SiteOne's own pack, but only when it's a REAL size — "Each (1)" must fall
  // through to the structured catalog size (container_size, then unit_size_oz) instead of
  // shadowing it, otherwise the scanner can't size-match or compute $/oz.
  const siteonePack = realPackSize(row.siteone_quantity);
  const quantity = siteonePack
    || realPackSize(row.container_size)
    || (row.unit_size_oz ? `${Number(row.unit_size_oz)} oz` : null);
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
      quantity: siteonePack || quantity,
    },
  };
  const vlist = (vendors || []).map((v) => ({
    vendor_id: v.id,
    name: v.name,
    url: (urlByVendorId && urlByVendorId.get && urlByVendorId.get(v.id)) || null,
  }));
  return { product, vendors: vlist, spend: Number(row.monthly_cost_estimate) || 0 };
}

// Attach decrypted login credentials to the spec vendors that use a login adapter (Veseris).
// Resolves each vendor's creds ONCE (cached by vendor_id). A vendor with no usable creds is
// left without — base.js then skips it cleanly (login_required) rather than scraping a gated,
// unpriced session. Injectable getCreds for tests.
async function attachLoginCredentials(db, specs, deps = {}) {
  const getCreds = deps.getVendorLoginCredentials || getVendorLoginCredentials;
  const cache = new Map();
  for (const spec of specs || []) {
    for (const v of (spec.vendors || [])) {
      if (!LOGIN_ADAPTER_KEYS.has(selectAdapterKey({ name: v.name, url: v.url }))) continue;
      if (!cache.has(v.vendor_id)) {
        let creds = null;
        try { creds = await getCreds(db, v.vendor_id); } catch (err) { creds = null; }
        cache.set(v.vendor_id, creds);
      }
      const creds = cache.get(v.vendor_id);
      if (creds && creds.password && (creds.username || creds.email)) v.credentials = creds;
    }
  }
}

// PURE: dedup baseline rows to one per product (caller orders by recency so the first
// row per product wins), rank by monthly spend (then SiteOne price), take the top
// `limit`, and shape each into a scan spec. `urlByProduct` is a Map of
// product_id -> Map(vendor_id -> url).
function assembleScanSpecs(baselineRows, urlByProduct, { limit = DEFAULT_LIMIT, vendors = [] } = {}) {
  const byProduct = new Map();
  for (const r of baselineRows || []) if (!byProduct.has(r.id)) byProduct.set(r.id, r);
  const ranked = [...byProduct.values()].sort((a, b) => (
    (Number(b.monthly_cost_estimate) || 0) - (Number(a.monthly_cost_estimate) || 0)
    || (Number(b.siteone_price) || 0) - (Number(a.siteone_price) || 0)
  ));
  return ranked.slice(0, Math.max(0, limit)).map((r) => toScanSpec(
    r, vendors, urlByProduct && urlByProduct.get ? urlByProduct.get(r.id) : null,
  ));
}

// Fetch top-spend products that have an APPROVED SiteOne baseline + each scrapable
// vendor's APPROVED, on-host product URL, then assemble scan specs. Wrapped so a
// schema surprise degrades to an empty list (the cron logs zero rather than crashing).
async function selectScanProducts(db, { limit = DEFAULT_LIMIT, siteoneId, vendors = [] } = {}) {
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
    const vendorById = new Map((vendors || []).map((v) => [v.id, v]));
    const vendorIds = [...vendorById.keys()];
    const urlByProduct = new Map(); // product_id -> Map(vendor_id -> url)
    if (vendorIds.length && ids.length) {
      const rows = await db('vendor_pricing')
        .whereIn('vendor_id', vendorIds)
        .andWhere('is_active', true)
        .whereIn('approval_status', APPROVED_STATES) // never hand a pending/unapproved URL to the browser
        .whereIn('product_id', ids)
        .whereNotNull('vendor_product_url')
        .select('product_id', 'vendor_id', 'vendor_product_url');
      for (const r of rows) {
        const v = vendorById.get(r.vendor_id);
        if (!v || !isOnHost(r.vendor_product_url, v.website)) continue; // per-vendor host validation
        if (!urlByProduct.has(r.product_id)) urlByProduct.set(r.product_id, new Map());
        const pm = urlByProduct.get(r.product_id);
        if (!pm.has(r.vendor_id)) pm.set(r.vendor_id, r.vendor_product_url);
      }
    }
    return assembleScanSpecs(baselineRows, urlByProduct, { limit, vendors });
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
      vendor: best.vendor || 'competitor',
      price: Number(best.price),
      quantity: best.quantity,
      source_url: best.source_url,
      name: best.name || null,
    },
  };
}

// Aggregate per-vendor outcomes across a batch — verified candidates vs skip reasons
// — so a 0-opportunity run is explainable ("DoMyOwn matched 3, none cheaper" vs
// "Solutions matched 0 — search isn't resolving" vs "Keystone blocked").
function tallyBreakdown(results) {
  const vendors = {};
  let productsMatched = 0;
  let verifiedTotal = 0;
  const bump = (name) => { vendors[name] = vendors[name] || { verified: 0, skipped: {} }; return vendors[name]; };
  for (const r of results || []) {
    if (!r || r.error) continue;
    const scan = r.scan || {};
    const verified = scan.verified || [];
    const skipped = scan.skipped || [];
    if (verified.length) productsMatched += 1;
    for (const v of verified) { bump(v.vendor || 'unknown').verified += 1; verifiedTotal += 1; }
    for (const s of skipped) { const b = bump(s.vendor || 'unknown'); b.skipped[s.reason] = (b.skipped[s.reason] || 0) + 1; }
  }
  return { vendors, productsMatched, verifiedTotal };
}

// Heuristic: did the batch fail because the headless browser isn't available in this
// environment (no playwright package / no chromium binary)? Then it's a clean skip,
// not an error to alarm on.
function isBrowserUnavailable(err) {
  return /playwright|chromium|browser|executable|launch|ENOENT/i.test((err && err.message) || '');
}

// Run one weekly scan. Returns a summary; never throws. deps are injectable for tests:
//   { db, scanMany, createDraft, selectSpecs, scrapableVendors, vendorByName, specs,
//     vendors, activeMatchKeys, limit, selectOnly }
async function runWeeklyScan(opts = {}) {
  const db = opts.db || dbModule;
  const scanMany = opts.scanMany || runScanMany;
  const create = opts.createDraft || createDraft;
  const resolveVendor = opts.vendorByName || vendorByName;
  const limit = opts.limit || DEFAULT_LIMIT;

  const siteone = await resolveVendor(db, 'SiteOne');
  if (!siteone) {
    logger.warn('[price-scan] weekly scan skipped — SiteOne vendor row missing');
    return { ok: false, reason: 'vendors_missing', evaluated: 0 };
  }
  const vendors = opts.vendors || await (opts.scrapableVendors || scrapableVendors)(db);
  if (!vendors.length) {
    logger.warn('[price-scan] weekly scan skipped — no scrapable competitor vendors enabled');
    return { ok: false, reason: 'no_scrapable_vendors', evaluated: 0 };
  }

  const specs = opts.specs || await (opts.selectSpecs || selectScanProducts)(db, { limit, siteoneId: siteone.id, vendors });

  // Verification mode: prove the selection without launching the browser.
  if (opts.selectOnly) {
    logger.info(`[price-scan] weekly scan (select-only): ${specs.length} products x ${vendors.length} vendors (${vendors.map((v) => v.name).join(', ')})`);
    return { ok: true, selectOnly: true, evaluated: specs.length, vendors: vendors.map((v) => v.name), products: specs.map((s) => s.product.name) };
  }
  if (!specs.length) {
    logger.info('[price-scan] weekly scan: no products with an approved SiteOne baseline to scan');
    return { ok: true, evaluated: 0, scanned: 0, opportunities: 0, draftId: null, vendors: vendors.map((v) => v.name) };
  }

  // Decrypt + attach login credentials for any login-adapter vendors (Veseris account pricing).
  await (opts.attachLoginCredentials || attachLoginCredentials)(db, specs, opts);

  let results;
  try {
    results = await scanMany(specs, { headless: true });
  } catch (err) {
    const reason = isBrowserUnavailable(err) ? 'browser_unavailable' : 'scan_error';
    logger[reason === 'browser_unavailable' ? 'warn' : 'error'](`[price-scan] weekly scan aborted (${reason}): ${err.message}`);
    return { ok: false, reason, evaluated: specs.length };
  }

  const summary = { evaluated: specs.length, scanned: 0, opportunities: 0, errors: 0, duplicates: 0 };
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

  // Per-vendor diagnostics — makes a 0-opportunity run interpretable.
  const breakdown = tallyBreakdown(results);
  summary.productsMatched = breakdown.productsMatched;
  summary.verifiedTotal = breakdown.verifiedTotal;
  summary.vendorBreakdown = breakdown.vendors;

  let draftId = null;
  let includedCount = 0;
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
  logger.info(`[price-scan] weekly scan: ${summary.evaluated} eval, ${summary.scanned} scanned, ${summary.productsMatched} matched, ${summary.opportunities} opps, ${summary.duplicates} dup, ${summary.errors} err -> draft ${draftId || 'none'} (${includedCount} items); per-vendor=${JSON.stringify(summary.vendorBreakdown)}`);
  return { ok: true, ...summary, draftId, includedCount };
}

module.exports = {
  runWeeklyScan,
  selectScanProducts,
  assembleScanSpecs,
  toScanSpec,
  opportunityToMatch,
  tallyBreakdown,
  isBrowserUnavailable,
  isOnHost,
  attachLoginCredentials,
  LOGIN_ADAPTER_KEYS,
  scrapableVendors,
  matchKey,
  activeMatchKeys,
  parseMatches,
  vendorByName,
  SCRAPABLE_ADAPTER_KEYS,
  APPROVED_STATES,
  DEFAULT_LIMIT,
};
