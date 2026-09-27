/**
 * Intelligence Bar — Procurement & Inventory Tools
 * server/services/intelligence-bar/procurement-tools.js
 *
 * Gives Claude access to the product catalog (~154 products, 23 vendors),
 * vendor pricing comparison, AI price research, approval queue,
 * margin analysis, protocol-product mappings, and physical stock tracking
 * (on-hand quantities, movement ledger, restock queue).
 *
 * Stock writes (adjust_stock, create_restock_request, update_restock_request)
 * are #1568 two-step tools: unconfirmed calls return a preview and mutate
 * nothing; only /confirm-action attaches confirmed server-side.
 */

const db = require('../../models/db');
const logger = require('../logger');
const MODELS = require('../../config/models');
const { anthropicMaxTokens, anthropicEffortConfig } = require('../llm/anthropic-wire');
const inventory = require('../inventory-operations');
const { ledgerCall, ledgerCallRejected } = require('../llm-dispatch-metrics');

const PROCUREMENT_TOOLS = [
  {
    name: 'query_products',
    description: `Search the product catalog. Filter by name, category, active ingredient, pricing status. 
Categories: insecticide, herbicide, fungicide, fertilizer, IGR, bait, rodenticide, adjuvant, surfactant, equipment.
Use for: "what products do we have?", "show me all herbicides", "which products need pricing?"`,
    input_schema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Search by name or active ingredient' },
        category: { type: 'string', description: 'Filter by product category' },
        needs_pricing: { type: 'boolean', description: 'true = only unpriced products' },
        has_best_price: { type: 'boolean', description: 'true = only products with a best price set' },
        sort: { type: 'string', enum: ['name', 'price', 'category'] },
        limit: { type: 'number' },
      },
    },
  },
  {
    name: 'query_vendors',
    description: `List vendors with their product counts, pricing coverage, and scrape status.
Use for: "which vendors do we use?", "how many products does SiteOne carry?", "which vendors need scraping?"`,
    input_schema: {
      type: 'object',
      properties: {
        active_only: { type: 'boolean', description: 'Only active vendors (default true)' },
        type: { type: 'string', description: 'Filter by vendor type: primary, online, distributor, regional, manufacturer_direct' },
      },
    },
  },
  {
    name: 'compare_vendor_pricing',
    description: `Compare prices for a specific product across all vendors. Shows each vendor's price, price per oz (per unit for count-based products such as stations or traps), and identifies the cheapest.
Use for: "compare SiteOne vs LESCO on Bifen IT", "where's the cheapest Demand CS?", "pricing breakdown for Prodiamine"`,
    input_schema: {
      type: 'object',
      properties: {
        product_name: { type: 'string', description: 'Product name to compare (partial match OK)' },
        product_id: { type: 'string', format: 'uuid', description: 'Or use exact product UUID' },
      },
      // Server-side only: tool-definition.js strips top-level combinators from
      // the copy sent to Anthropic (the API rejects them); the registry's
      // validator still enforces it.
      anyOf: [{ required: ['product_name'] }, { required: ['product_id'] }],
    },
  },
  {
    name: 'find_cheapest_vendor',
    description: `Find the cheapest vendor for one or more products. Returns best price and savings vs. next cheapest.
Use for: "cheapest source for pre-emergent?", "best deal on all our herbicides?"`,
    input_schema: {
      type: 'object',
      properties: {
        category: { type: 'string', description: 'Find cheapest across an entire category' },
        product_names: { type: 'array', items: { type: 'string' }, description: 'Specific product names' },
      },
    },
  },
  {
    name: 'run_price_lookup',
    description: `Trigger the AI Price Research Agent to search the web for current vendor prices on a product. Uses Claude + web search to find real prices, then routes results through the approval queue.
This is an async operation — results go to the approval queue for review.
Use for: "find current prices for Demand CS", "price check Bifen IT across all vendors", "research prices on Celsius WG"`,
    input_schema: {
      type: 'object',
      properties: {
        product_name: { type: 'string', description: 'Product to price-check' },
        vendor_names: { type: 'array', items: { type: 'string' }, description: 'Optional: only check these vendors' },
      },
      required: ['product_name'],
    },
  },
  {
    name: 'get_approval_queue',
    description: `Get the price approval queue. Shows pending, approved, and rejected price changes.
Use for: "any pending approvals?", "what's in the approval queue?", "show me rejected prices"`,
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['pending', 'approved', 'rejected', 'all'], description: 'Filter by status (default: pending)' },
        limit: { type: 'number' },
      },
    },
  },
  {
    name: 'approve_price',
    description: `Approve or reject a price from the approval queue. ALWAYS ask for confirmation before executing.
Use for: "approve that SiteOne price", "reject the Amazon price for Demand CS"`,
    input_schema: {
      type: 'object',
      properties: {
        approval_id: { type: 'string', description: 'Price approval UUID' },
        action: { type: 'string', enum: ['approve', 'reject'] },
        notes: { type: 'string' },
      },
      required: ['approval_id', 'action'],
    },
  },
  {
    name: 'analyze_margins',
    description: `Analyze product cost margins by service type. Shows estimated cost-per-service, revenue-per-service, and margin percentages.
Use for: "what are our margins?", "cost breakdown for pest control service", "which services have the best margins?"`,
    input_schema: {
      type: 'object',
      properties: {
        service_type: { type: 'string', description: 'Filter by service type: pest, lawn, mosquito, termite, tree_shrub' },
      },
    },
  },
  {
    name: 'get_price_trends',
    description: `Show price history and trends for a product. Tracks how vendor prices have changed over time.
Use for: "has Bifen IT gotten more expensive?", "price trend for Demand CS", "any prices went up recently?"`,
    input_schema: {
      type: 'object',
      properties: {
        product_name: { type: 'string' },
        days_back: { type: 'number', description: 'How far back to look (default 90)' },
      },
    },
  },
  {
    name: 'get_unpriced_summary',
    description: `Get a summary of all products that still need pricing: count by category, estimated impact, priority recommendations.
Use for: "what still needs pricing?", "how many products are unpriced?", "what should we price next?"`,
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'query_stock',
    description: `Check physical stock on hand. Shows on-hand quantity, inventory unit, low-stock threshold, and whether the product is stock-tracked. Products with no on-hand value are UNTRACKED — completion-flow deduction skips them until a first count is logged with adjust_stock.
Use for: "how much Bifen do we have?", "what's low on stock?", "which products aren't stock-tracked yet?"`,
    input_schema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Search by product name or active ingredient' },
        category: { type: 'string', description: 'Filter by product category' },
        low_stock_only: { type: 'boolean', description: 'true = only tracked products at or below their low-stock threshold' },
        untracked_only: { type: 'boolean', description: 'true = only products with no on-hand value (not stock-tracked yet)' },
        limit: { type: 'number' },
      },
    },
  },
  {
    name: 'get_stock_movements',
    description: `Show the stock movement ledger for one product: usage deducted at service completion, restocks received, manual corrections, damaged/lost write-offs. Each entry has quantity, before/after stock, cost, and service/customer context.
Use for: "where did the Talstar go?", "when did we last restock Prodiamine?", "show stock history for Demand CS"`,
    input_schema: {
      type: 'object',
      properties: {
        product_name: { type: 'string', description: 'Product name (partial match OK)' },
        product_id: { type: 'string', format: 'uuid', description: 'Or exact product UUID' },
        days_back: { type: 'number', description: 'Only movements from the last N days' },
        limit: { type: 'number', description: 'Max entries (default 20, max 100)' },
      },
    },
  },
  {
    name: 'get_restock_queue',
    description: `List restock requests (the shopping/purchase queue). Default shows active requests (open + ordered).
Use for: "what's on the restock list?", "anything ordered but not received?", "show cancelled restock requests"`,
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['open', 'ordered', 'active', 'received', 'cancelled', 'all'], description: 'Filter by status (default: active = open + ordered)' },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
        request_id: { type: 'string', format: 'uuid', description: 'Optional exact request ID. Use status all to recover a closed request.' },
      },
    },
  },
  {
    name: 'adjust_stock',
    description: `Record a physical stock change: a restock (adds), a correction (physical count — use set_total to log "we have X on the shelf"), or damaged/lost stock (removes). Your call returns a preview; the operator confirms in the UI before anything is written. Logging a first count for an untracked product turns stock tracking ON for it — completion flows then deduct and can block on insufficient stock, so counts must be real.
Use for: "we have 64 oz of Bifen on the shelf", "add the 2 gallons I bought today", "write off the spilled bag of Prodiamine"`,
    input_schema: {
      type: 'object',
      properties: {
        product_name: { type: 'string', description: 'Product name (partial match OK)' },
        product_id: { type: 'string', format: 'uuid', description: 'Or exact product UUID' },
        movement_type: { type: 'string', enum: ['restock', 'correction', 'damaged_lost'], description: 'restock = stock purchased/added; correction = physical count fix (signed quantity or set_total); damaged_lost = write-off' },
        quantity: { type: 'number', description: 'Amount to add (restock), remove (damaged_lost), or signed delta (correction)' },
        set_total: { type: 'number', description: 'Correction only: set the absolute on-hand amount (what is physically on the shelf). Pass this OR quantity, not both.' },
        unit: { type: 'string', description: 'Unit of the entered amount (fl_oz, gal, qt, oz, lb, g, kg...). Defaults to the product inventory unit; required for a first count.' },
        lot_number: { type: 'string' },
        reason: { type: 'string', description: 'Why the physical stock count changed' },
        note: { type: 'string' },
      },
      required: ['movement_type'],
    },
  },
  {
    name: 'create_restock_request',
    description: `Save an open restock request. This does not place a vendor order or increase stock. Resolve the exact product/formulation and inventory unit first; use saved catalog fields and the stock/forecast readers. Include a requested deadline as needed_by in YYYY-MM-DD form. Your call returns a preview; the operator confirms in the UI.
Use for: "put Bifen on the restock list", "request 2 lb of Prodiamine before Tuesday"`,
    input_schema: {
      type: 'object',
      properties: {
        product_name: { type: 'string', description: 'Product name (partial match OK)' },
        product_id: { type: 'string', format: 'uuid', description: 'Or exact product UUID' },
        quantity: { type: 'number', description: 'How much to order' },
        unit: { type: 'string', description: 'Unit of the requested amount. Defaults to the product inventory unit.' },
        priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
        vendor: { type: 'string', description: 'Where to buy. Defaults to the product best-price vendor.' },
        needed_by: { type: 'string', format: 'date', description: 'YYYY-MM-DD deadline' },
        allow_duplicate: { type: 'boolean', description: 'Only true when staff explicitly request another manual request for this same product; never duplicates an automatic reorder.' },
        reason: { type: 'string' },
      },
      required: ['quantity'],
    },
  },
  {
    name: 'update_restock_request',
    description: `Record a staff action on a restock request: mark_ordered (staff already placed the order; this tool does not buy), receive (arrived — ADDS the stock and logs a restock movement), or cancel. Your call returns a preview; the operator confirms in the UI. Use get_restock_queue first to find the request id.
Use for: "I ordered the Bifen", "the SiteOne order arrived", "cancel that Prodiamine request"`,
    input_schema: {
      type: 'object',
      properties: {
        request_id: { type: 'string', format: 'uuid', description: 'Restock request UUID (from get_restock_queue)' },
        action: { type: 'string', enum: ['mark_ordered', 'receive', 'cancel'] },
        quantity: { type: 'number', description: 'Receive only: actual amount received, if different from requested' },
        unit: { type: 'string', description: 'Receive only: unit of the received amount' },
        note: { type: 'string' },
      },
      required: ['request_id', 'action'],
    },
  },
];


// ─── EXECUTION ──────────────────────────────────────────────────

async function executeProcurementTool(toolName, input, actionContext = {}) {
  try {
    switch (toolName) {
      case 'query_products': return await queryProducts(input);
      case 'query_vendors': return await queryVendors(input);
      case 'compare_vendor_pricing': return await compareVendorPricing(input);
      case 'find_cheapest_vendor': return await findCheapestVendor(input);
      case 'run_price_lookup': return await runPriceLookup(input);
      case 'get_approval_queue': return await getApprovalQueue(input);
      case 'approve_price': return await approvePrice(input);
      case 'analyze_margins': return await analyzeMargins(input);
      case 'get_price_trends': return await getPriceTrends(input);
      case 'get_unpriced_summary': return await getUnpricedSummary();
      case 'query_stock': return await queryStock(input);
      case 'get_stock_movements': return await getStockMovements(input);
      case 'get_restock_queue': return await getRestockQueue(input, actionContext);
      case 'adjust_stock': return await adjustStock(input, actionContext);
      case 'create_restock_request': return await createRestockRequest(input, actionContext);
      case 'update_restock_request': return await updateRestockRequest(input, actionContext);
      default: return { error: `Unknown procurement tool: ${toolName}` };
    }
  } catch (err) {
    logger.error(`[intelligence-bar:procurement] Tool ${toolName} failed:`, err);
    return { error: err.message, code: err.code, preview_changed: err.code === 'preview_changed' };
  }
}


// ─── IMPLEMENTATIONS ────────────────────────────────────────────

async function queryProducts(input) {
  const { search, category, needs_pricing, has_best_price, sort = 'name', limit: rawLimit } = input;
  const limit = Math.min(rawLimit || 50, 200);

  let query = db('products_catalog');
  if (search) query = query.where(function () {
    this.whereILike('name', `%${search}%`).orWhereILike('active_ingredient', `%${search}%`);
  });
  if (category) query = query.whereILike('category', `%${category}%`);
  if (needs_pricing === true) query = query.where('needs_pricing', true);
  if (has_best_price === true) query = query.where('best_price', '>', 0);

  const products = await query.orderBy(sort === 'price' ? 'best_price' : 'name').limit(limit);

  return {
    products: products.map(p => ({
      id: p.id,
      name: p.name,
      category: p.category,
      active_ingredient: p.active_ingredient,
      moa_group: p.moa_group,
      container_size: p.container_size,
      formulation: p.formulation,
      best_price: p.best_price ? parseFloat(p.best_price) : null,
      best_vendor: p.best_vendor,
      needs_pricing: p.needs_pricing,
      cost_per_unit: p.cost_per_unit ? parseFloat(p.cost_per_unit) : null,
    })),
    total: products.length,
  };
}


async function queryVendors(input) {
  const { active_only = true, type } = input;

  let query = db('vendors')
    .select('vendors.*',
      db.raw('(SELECT COUNT(*) FROM vendor_pricing WHERE vendor_pricing.vendor_id = vendors.id) as product_count'),
      db.raw('(SELECT COUNT(*) FROM vendor_pricing WHERE vendor_pricing.vendor_id = vendors.id AND is_best_price = true) as best_price_count'),
    );
  if (active_only) query = query.where('vendors.active', true);
  if (type) query = query.where('vendors.type', type);

  const vendors = await query.orderByRaw('(SELECT COUNT(*) FROM vendor_pricing WHERE vendor_pricing.vendor_id = vendors.id) DESC');

  return {
    vendors: vendors.map(v => ({
      id: v.id,
      name: v.name,
      type: v.type,
      website: v.website,
      product_count: parseInt(v.product_count || 0),
      best_price_wins: parseInt(v.best_price_count || 0),
      scraping_enabled: v.price_scraping_enabled,
      last_scrape: v.last_scrape_at,
      last_scrape_status: v.last_scrape_status,
      active: v.active,
    })),
    total: vendors.length,
  };
}


// Per-oz comparison basis (codex GH r3 P1): raw pack prices mislead when
// pack sizes differ — rank vendor rows exactly like recalcBestPrice
// (landed per-oz when present, else sticker per-oz; unrankable rows last,
// ties by raw price). Uses the router's exported primitives so the
// comparison can never drift from the canonical writer.
// Eligibility mirror of recalcBestPrice (r3-push P1): recommendations must
// never surface pending/rejected/inactive/expired or unpriced rows.
function eligibleVendorRows(qb) {
  return qb
    .whereRaw('COALESCE(vendor_pricing.price_amount, vendor_pricing.price) > 0')
    .where('vendor_pricing.is_active', true)
    .whereIn('vendor_pricing.approval_status', ['approved', 'auto_approved'])
    .where(function unexpired() {
      this.whereNull('vendor_pricing.expires_at').orWhere('vendor_pricing.expires_at', '>', new Date());
    });
}

function rankVendorRows(rows, product) {
  // The canonical writer's scoring, verbatim (Codex #3974 r1 P1): per-oz when
  // a measured row exists, per-UNIT for count-based products, raw price only
  // when nothing scales — so the IB can never name a different winner than
  // the catalog. Entries keep { row, perOz, rank, price }; rank is on the
  // chosen basis (null when unrankable) and unrankable rows sort last.
  const adminInventoryRoute = require('../../routes/admin-inventory');
  return adminInventoryRoute.scoreVendorRows(rows, product);
}

// The basis a ranking was decided on, in words the model can repeat (Codex
// #3974 r2 P2): a count-based product's spread is dollars per UNIT, not per oz.
const BASIS_TEXT = {
  oz: 'per-oz unit cost (landed when known)',
  count: 'per-unit cost for a count-based product (landed when shipping/tax are known)',
  raw: 'raw pack price (no comparable size on the rows)',
};
const basisUnit = (mode) => (mode === 'count' ? 'unit' : 'oz');

async function compareVendorPricing(input) {
  const { product_name, product_id } = input;

  let product;
  if (product_id) {
    product = await db('products_catalog').where('id', product_id).first();
  } else {
    product = await db('products_catalog').whereILike('name', `%${product_name}%`).first();
  }
  if (!product) return { error: `Product "${product_name}" not found` };

  const rows = await eligibleVendorRows(db('vendor_pricing').where('product_id', product.id))
    .join('vendors', 'vendor_pricing.vendor_id', 'vendors.id')
    .select('vendor_pricing.*', 'vendors.name as vendor_name', 'vendors.website');

  // Ordered by UNIT cost, not raw pack price — a $40/32 oz offer must not
  // present as "cheaper" than a $50/64 oz one.
  const { mode, ranked } = rankVendorRows(rows, product);
  const cheapest = ranked.length > 0 ? ranked[0] : null;
  // The spread runs to the last COMPARABLE vendor (Codex #3974 r3 P2): an
  // incompatible row (rank null) sits last by design and must not null it.
  const comparable = ranked.filter((r) => r.rank != null);
  const dearest = comparable.length > 1 ? comparable[comparable.length - 1] : null;
  const spread = cheapest?.rank != null && dearest ? dearest.rank - cheapest.rank : 0;

  return {
    product: {
      id: product.id, name: product.name, category: product.category,
      container_size: product.container_size, active_ingredient: product.active_ingredient,
      current_best_price: product.best_price ? parseFloat(product.best_price) : null,
      current_best_vendor: product.best_vendor,
    },
    vendor_prices: ranked.map(({ row: p, perOz, perUnit, rankPerUnit }) => ({
      vendor: p.vendor_name,
      price: parseFloat(p.price_amount ?? p.price ?? 0),
      quantity: p.quantity,
      price_per_oz: perOz != null ? Math.round(perOz * 10000) / 10000 : null,
      price_per_unit: perUnit != null ? Math.round(perUnit * 10000) / 10000 : null,
      // Landed per-unit (shipping / tax on the current price) is what a
      // count-mode winner was chosen on (Codex #3974 r3 P2).
      landed_price_per_unit: rankPerUnit != null ? Math.round(rankPerUnit * 10000) / 10000 : null,
      landed_price_per_oz: (() => {
        const adminInventoryRoute2 = require('../../routes/admin-inventory');
        return adminInventoryRoute2.storedUnitCostPerOz(p.landed_unit_price, p.unit_normalized);
      })(),
      is_best: p.is_best_price,
      url: p.vendor_product_url,
      last_checked: p.last_checked_at,
    })),
    cheapest_vendor: cheapest?.row.vendor_name,
    cheapest_price: cheapest ? parseFloat(cheapest.row.price_amount ?? cheapest.row.price ?? 0) : null,
    cheapest_price_per_oz: cheapest?.perOz != null ? Math.round(cheapest.perOz * 10000) / 10000 : null,
    cheapest_price_per_unit: cheapest?.perUnit != null ? Math.round(cheapest.perUnit * 10000) / 10000 : null,
    cheapest_landed_price_per_unit: cheapest?.rankPerUnit != null ? Math.round(cheapest.rankPerUnit * 10000) / 10000 : null,
    price_range: spread > 0 ? `$${spread.toFixed(4)}/${basisUnit(mode)} spread across ${ranked.length} vendors` : null,
    vendor_count: ranked.length,
    comparison_basis: BASIS_TEXT[mode],
  };
}


async function findCheapestVendor(input) {
  const { category, product_names } = input;

  let products;
  if (product_names && product_names.length) {
    products = await db('products_catalog').where(function () {
      for (const name of product_names) {
        this.orWhereILike('name', `%${name}%`);
      }
    });
  } else if (category) {
    products = await db('products_catalog').whereILike('category', `%${category}%`).where('best_price', '>', 0);
  } else {
    products = await db('products_catalog').where('best_price', '>', 0).orderBy('best_price', 'desc').limit(20);
  }

  const results = [];
  for (const p of products) {
    const rows = await eligibleVendorRows(db('vendor_pricing').where('product_id', p.id))
      .join('vendors', 'vendor_pricing.vendor_id', 'vendors.id')
      .select('vendor_pricing.*', 'vendors.name as vendor_name');

    // Same basis as compareVendorPricing (GH r3 P1) — per oz, or per unit
    // for a count-based product (Codex #3974 r2 P2).
    const scored = rankVendorRows(rows, p);
    const ranked = scored.ranked.slice(0, 3);
    const savingsKey = scored.mode === 'count' ? 'savings_per_unit_vs_next' : 'savings_per_oz_vs_next';
    const asEntry = (r) => (r ? {
      vendor: r.row.vendor_name,
      price: parseFloat(r.row.price_amount ?? r.row.price ?? 0),
      price_per_oz: r.perOz != null ? Math.round(r.perOz * 10000) / 10000 : null,
      price_per_unit: r.perUnit != null ? Math.round(r.perUnit * 10000) / 10000 : null,
      landed_price_per_unit: r.rankPerUnit != null ? Math.round(r.rankPerUnit * 10000) / 10000 : null,
    } : null);
    results.push({
      product: p.name,
      category: p.category,
      container_size: p.container_size,
      cheapest: asEntry(ranked[0]),
      runner_up: asEntry(ranked[1]),
      // Savings on the SAME basis the ranking used (r16-push P1): rank is
      // landed per-oz when known — sticker deltas could go negative under
      // heavy shipping despite a correct winner.
      comparison_basis: BASIS_TEXT[scored.mode],
      [savingsKey]: ranked.length >= 2 && ranked[0].rank != null && ranked[1].rank != null
        ? Math.round((ranked[1].rank - ranked[0].rank) * 10000) / 10000
        : null,
    });
  }

  return { results, total: results.length, comparison_basis: 'per-oz unit cost (landed when known); per-unit for count-based products — see each result' };
}


async function runPriceLookup(input) {
  const { product_name, vendor_names } = input;

  // Find the product
  const product = await db('products_catalog').whereILike('name', `%${product_name}%`).first();
  if (!product) return { error: `Product "${product_name}" not found in catalog` };

  // Find vendor IDs if names specified
  let vendorIds;
  if (vendor_names && vendor_names.length) {
    const vendors = await db('vendors').where(function () {
      for (const name of vendor_names) {
        this.orWhereILike('name', `%${name}%`);
      }
    });
    vendorIds = vendors.map(v => v.id);
  }

  // Call the existing AI price lookup endpoint internally
  try {
    const fetch = require('node-fetch') || global.fetch;
    const baseUrl = process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
      : `http://localhost:${process.env.PORT || 3000}`;

    // Instead of HTTP call, invoke the logic directly
    const Anthropic = require('@anthropic-ai/sdk');
    if (!process.env.ANTHROPIC_API_KEY) {
      return { error: 'ANTHROPIC_API_KEY not set — cannot run price research' };
    }

    const vendors = vendorIds
      ? await db('vendors').whereIn('id', vendorIds).where({ active: true })
      : await db('vendors').where({ active: true });

    const vendorList = vendors.map(v => `${v.name} (${v.website || 'no site'})`).join(', ');

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const prompt = `You are a procurement research agent. Find current prices for:
PRODUCT: ${product.name}
CONTAINER SIZE: ${product.container_size || 'standard'}
VENDORS: ${vendorList}

Search vendor websites for exact prices. Return JSON only:
{"product":"${product.name}","results":[{"vendor":"Name","price":99.99,"quantity":"32 oz","url":"https://...","pricePerOz":3.12}],"cheapest":"Vendor","summary":"Brief findings"}`;

    const msg = await ledgerCall('anthropic', MODELS.FLAGSHIP, () => anthropic.messages.create({
      model: MODELS.FLAGSHIP,
      ...anthropicEffortConfig(MODELS.FLAGSHIP),
      max_tokens: anthropicMaxTokens(MODELS.FLAGSHIP, 2000),
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{ role: 'user', content: prompt }],
    }), { laneId: 'ib_tools' });

    // Handle tool use loop. Every fetched turn's text is read before the cap
    // is checked — the old `while (loops < 8)` exited right after fetching
    // the 9th turn, so a final answer arriving there was never read and the
    // valid call was failed as invalid_json (Codex r15 on #4884).
    let currentMsg = msg;
    let responseText = '';
    let loops = 0;
    for (;;) {
      for (const block of currentMsg.content) {
        if (block.type === 'text') responseText += block.text;
      }
      if (currentMsg.stop_reason !== 'tool_use' || loops >= 8) break;
      loops++;
      const toolUseBlocks = currentMsg.content.filter(b => b.type === 'tool_use');
      const toolResults = toolUseBlocks.map(tb => ({
        type: 'tool_result', tool_use_id: tb.id,
        content: 'Search completed. Provide final JSON response.',
      }));
      currentMsg = await ledgerCall('anthropic', MODELS.FLAGSHIP, () => anthropic.messages.create({
        model: MODELS.FLAGSHIP,
        ...anthropicEffortConfig(MODELS.FLAGSHIP),
        max_tokens: anthropicMaxTokens(MODELS.FLAGSHIP, 2000),
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [
          { role: 'user', content: prompt },
          { role: 'assistant', content: currentMsg.content },
          { role: 'user', content: toolResults },
        ],
      }), { laneId: 'ib_tools' });
    }

    // Still asking for tools at the cap: the model never gave its answer.
    const exhausted = currentMsg.stop_reason === 'tool_use';
    if (exhausted) ledgerCallRejected(currentMsg, 'tool_loop_exhausted');

    // Parse JSON
    let parsed;
    try {
      const clean = responseText.replace(/```json|```/g, '').trim();
      const jsonMatch = clean.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(jsonMatch ? jsonMatch[0] : clean);
    } catch {
      if (!exhausted) ledgerCallRejected(currentMsg, 'invalid_json');
      return { success: true, raw_response: responseText, note: 'AI returned non-JSON. See raw_response.' };
    }

    // Only usable results are queued or handed back to the Intelligence Bar
    // (which would otherwise present an invented vendor's price); a missing
    // or partially unusable `results` fails the row (Codex r8, r14, r15 on
    // #4884). readPriceLookupReply is admin-inventory.js's ai-price-lookup
    // route's own read of the identical reply shape; shared, not duplicated.
    const { readPriceLookupReply } = require('../../routes/admin-inventory');
    const reply = readPriceLookupReply(parsed, vendors);
    if (!exhausted && !reply.complete) ledgerCallRejected(currentMsg, 'schema_invalid');

    // Create approval queue entries
    let approvalsCreated = 0;
    for (const result of reply.usable) {
      try {
        await db('price_approvals').insert({
          product_id: product.id, vendor_id: result.vendor.id,
          new_price: result.price, new_quantity: result.quantity || product.container_size,
          source_url: result.url, status: 'pending',
        });
        approvalsCreated++;
      } catch (insertErr) {
        if (!insertErr.message?.includes('duplicate') && !insertErr.message?.includes('unique')) {
          logger.warn(`[intelligence-bar:procurement] Price approval insert failed: ${insertErr.message}`);
        }
      }
    }

    logger.info(`[intelligence-bar:procurement] Price lookup for ${product.name}: ${reply.results.length} results, ${approvalsCreated} approvals created`);

    return {
      success: true,
      product: product.name,
      results: reply.results,
      cheapest: reply.cheapest,
      summary: reply.summary,
      approvals_created: approvalsCreated,
      note: approvalsCreated > 0 ? `${approvalsCreated} prices sent to approval queue` : 'No prices found to queue',
    };
  } catch (err) {
    return { error: `Price lookup failed: ${err.message}` };
  }
}


async function getApprovalQueue(input) {
  const { status = 'pending', limit: rawLimit } = input;
  const limit = Math.min(rawLimit || 30, 100);

  let query = db('price_approvals')
    .join('products_catalog', 'price_approvals.product_id', 'products_catalog.id')
    .join('vendors', 'price_approvals.vendor_id', 'vendors.id')
    .select('price_approvals.*', 'products_catalog.name as product_name',
      'products_catalog.category', 'products_catalog.best_price as current_best',
      'products_catalog.unit_size_oz as catalog_unit_size_oz',
      'vendors.name as vendor_name')
    .orderBy('price_approvals.created_at', 'desc');

  if (status !== 'all') query = query.where('price_approvals.status', status);

  const approvals = await query.limit(limit);

  return {
    approvals: approvals.map(a => ({
      id: a.id,
      product: a.product_name,
      category: a.category,
      vendor: a.vendor_name,
      new_price: parseFloat(a.new_price || 0),
      old_price: a.old_price ? parseFloat(a.old_price) : null,
      current_best: a.current_best ? parseFloat(a.current_best) : null,
      change_pct: a.price_change_pct ? parseFloat(a.price_change_pct) : null,
      // Per-oz basis (GH r3 P1): best_price is now scaled to the catalog
      // container, so a raw comparison against a differently sized pack
      // lies. null = not derivable (unknown), never a raw-price guess.
      is_better_than_current: (() => {
        if (!a.current_best) return true;
        const adminInventoryRoute = require('../../routes/admin-inventory');
        const newOz = adminInventoryRoute.quantityToOz(a.new_quantity);
        const unitOz = parseFloat(a.catalog_unit_size_oz);
        if (!newOz || !(unitOz > 0)) return null;
        return (parseFloat(a.new_price) / newOz) < (parseFloat(a.current_best) / unitOz);
      })(),
      quantity: a.new_quantity,
      source_url: a.source_url,
      status: a.status,
      created: a.created_at,
    })),
    total: approvals.length,
    status_filter: status,
  };
}


async function approvePrice(input) {
  const { approval_id, action, notes } = input;

  const approval = await db('price_approvals').where('id', approval_id).first();
  if (!approval) return { error: 'Approval not found' };
  // W0B pin (codex r4): the card's fingerprint is asserted on the SAME row
  // this executor hands to applyPriceApproval — an edited/re-vendored
  // approval refuses here instead of applying values the card never showed.
  if (input._approval_fingerprint) {
    const { priceApprovalFingerprint } = require('./proposal-pins');
    if (priceApprovalFingerprint(approval) !== String(input._approval_fingerprint)) {
      return {
        error: 'This price approval changed after the card was shown — nothing was applied. Ask again for a fresh confirmation card.',
        preview_changed: true,
      };
    }
  }

  if (action === 'approve') {
    // ONE atomic approval writer (codex r4-push P1): the shared
    // applyPriceApproval claims the still-pending row, applies the vendor
    // price with the approved-field refresh, records history, and runs the
    // canonical best-price recalculation in a single transaction — the old
    // inline sequence here decided the approval BEFORE the pricing writes,
    // so a failure left a decided approval with partial state, and a stale
    // AI action could overwrite a concurrently rejected approval.
    const adminInventoryRoute = require('../../routes/admin-inventory');
    const applied = await adminInventoryRoute.applyPriceApproval(approval, 'intelligence_bar', {
      notes, historySource: 'ai_approved',
    });
    if (!applied) {
      return { error: 'Approval was already decided by another reviewer — refresh the queue' };
    }

    const product = await db('products_catalog').where('id', approval.product_id).first();
    return { success: true, action: 'approved', product: product?.name, price: parseFloat(approval.new_price) };
  }

  if (action === 'reject') {
    const claimed = await db('price_approvals').where({ id: approval_id, status: 'pending' }).update({
      status: 'rejected', reviewed_by: 'intelligence_bar', reviewed_at: new Date(), notes,
    });
    if (!claimed) return { error: 'Approval was already decided by another reviewer — refresh the queue' };
    return { success: true, action: 'rejected', approval_id };
  }

  return { error: 'Invalid action' };
}


async function analyzeMargins(input) {
  const { service_type } = input;

  // Get products with pricing, grouped by category
  const products = await db('products_catalog')
    .where('best_price', '>', 0)
    .select('name', 'category', 'best_price', 'best_vendor', 'container_size', 'cost_per_unit', 'cost_unit')
    .orderBy('category');

  const byCategory = {};
  products.forEach(p => {
    const cat = p.category || 'uncategorized';
    if (!byCategory[cat]) byCategory[cat] = { products: [], total_cost: 0 };
    byCategory[cat].products.push({
      name: p.name, price: parseFloat(p.best_price), vendor: p.best_vendor,
      container: p.container_size, cost_per_unit: p.cost_per_unit ? parseFloat(p.cost_per_unit) : null,
    });
    byCategory[cat].total_cost += parseFloat(p.best_price || 0);
  });

  // Estimate per-service costs (rough — based on typical product usage)
  const serviceCosts = {
    pest_control: { labor: 35 * 0.5, products: 8, avg_revenue: 125 },
    lawn_care: { labor: 35 * 0.75, products: 15, avg_revenue: 89 },
    mosquito: { labor: 35 * 0.5, products: 12, avg_revenue: 79 },
    termite: { labor: 35 * 2, products: 45, avg_revenue: 350 },
    tree_shrub: { labor: 35 * 0.75, products: 20, avg_revenue: 125 },
  };

  const margins = Object.entries(serviceCosts).map(([service, costs]) => {
    const totalCost = costs.labor + costs.products;
    const margin = costs.avg_revenue - totalCost;
    const marginPct = Math.round((margin / costs.avg_revenue) * 100);
    return {
      service, labor_cost: costs.labor, product_cost: costs.products,
      total_cost: totalCost, avg_revenue: costs.avg_revenue,
      margin, margin_pct: marginPct,
    };
  });

  if (service_type) {
    const filtered = margins.filter(m => m.service.includes(service_type));
    return { margins: filtered, by_category: byCategory };
  }

  return {
    margins: margins.sort((a, b) => b.margin_pct - a.margin_pct),
    by_category: Object.entries(byCategory).map(([cat, data]) => ({
      category: cat, product_count: data.products.length, total_catalog_cost: data.total_cost,
    })),
    total_products_priced: products.length,
  };
}


async function getPriceTrends(input) {
  const { product_name, days_back = 90 } = input;

  const product = await db('products_catalog').whereILike('name', `%${product_name}%`).first();
  if (!product) return { error: `Product "${product_name}" not found` };

  const since = new Date(Date.now() - days_back * 86400000).toISOString();

  // Check approved price changes
  const priceChanges = await db('price_approvals')
    .where('product_id', product.id)
    .where('status', 'approved')
    .where('created_at', '>=', since)
    .join('vendors', 'price_approvals.vendor_id', 'vendors.id')
    .select('price_approvals.*', 'vendors.name as vendor_name')
    .orderBy('price_approvals.created_at');

  // Current pricing across vendors
  const currentPrices = await db('vendor_pricing')
    .where('product_id', product.id)
    .join('vendors', 'vendor_pricing.vendor_id', 'vendors.id')
    .select('vendors.name as vendor', 'vendor_pricing.price', 'vendor_pricing.previous_price', 'vendor_pricing.last_checked_at')
    .orderBy('vendor_pricing.price');

  return {
    product: product.name,
    current_best: product.best_price ? parseFloat(product.best_price) : null,
    current_vendor: product.best_vendor,
    current_prices: currentPrices.map(p => ({
      vendor: p.vendor,
      price: parseFloat(p.price || 0),
      previous: p.previous_price ? parseFloat(p.previous_price) : null,
      change: p.previous_price ? parseFloat(p.price) - parseFloat(p.previous_price) : null,
      last_checked: p.last_checked_at,
    })),
    price_history: priceChanges.map(c => ({
      vendor: c.vendor_name,
      old_price: c.old_price ? parseFloat(c.old_price) : null,
      new_price: parseFloat(c.new_price),
      change_pct: c.price_change_pct ? parseFloat(c.price_change_pct) : null,
      date: c.created_at,
    })),
    days_analyzed: days_back,
  };
}


async function getUnpricedSummary() {
  const unpriced = await db('products_catalog')
    .where('needs_pricing', true)
    .select('name', 'category', 'active_ingredient', 'container_size')
    .orderBy('category');

  const byCategory = {};
  unpriced.forEach(p => {
    const cat = p.category || 'uncategorized';
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(p.name);
  });

  const totalProducts = await db('products_catalog').count('* as c').first();
  const pricedCount = await db('products_catalog').where('needs_pricing', false).count('* as c').first();

  return {
    total_unpriced: unpriced.length,
    total_products: parseInt(totalProducts?.c || 0),
    priced: parseInt(pricedCount?.c || 0),
    coverage_pct: parseInt(totalProducts?.c || 0) > 0
      ? Math.round(parseInt(pricedCount?.c || 0) / parseInt(totalProducts?.c || 0) * 100) : 0,
    by_category: Object.entries(byCategory).map(([cat, products]) => ({
      category: cat, count: products.length, products,
    })),
    recommendation: unpriced.length > 20
      ? 'High number of unpriced products. Consider running a bulk price check on the highest-priority categories first.'
      : unpriced.length > 0
        ? `${unpriced.length} products need pricing. Run individual lookups or a targeted bulk check.`
        : 'All products are priced!',
  };
}


// ─── STOCK TRACKING ─────────────────────────────────────────────

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function stockFields(p) {
  const onHand = toNumber(p.inventory_on_hand);
  const threshold = toNumber(p.low_stock_threshold);
  return {
    on_hand: onHand,
    unit: p.inventory_unit || null,
    low_stock_threshold: threshold,
    tracked: onHand != null,
    // Zero/negative on-hand is low even without a threshold — products
    // seeded via adjust_stock start with no threshold set, and completion
    // deduction can still block them as out of stock.
    low_stock: onHand != null && (onHand <= 0 || (threshold != null && onHand <= threshold)),
  };
}

// Resolve product_id / product_name input to exactly one catalog row.
// Ambiguous names return the candidates instead of guessing.
async function resolveProduct(input) {
  if (input.product_id) {
    const product = await db('products_catalog').where('id', input.product_id).first();
    return product ? { product } : { error: 'Product not found' };
  }
  const name = String(input.product_name || '').trim();
  if (!name) return { error: 'product_name or product_id is required' };
  const exact = await db('products_catalog').whereRaw('lower(btrim(name)) = ?', [name.toLowerCase()]).limit(2);
  if (exact.length === 1) return { product: exact[0] };
  const literal = name.replace(/[\\%_]/g, '\\$&');
  const matches = exact.length ? exact : await db('products_catalog').whereILike('name', `%${literal}%`).limit(6);
  if (!matches.length) return { error: `Product "${name}" not found in catalog` };
  if (matches.length > 1) {
    return {
      error: `Multiple products match "${name}" — retry with product_id`,
      candidates: matches.map(inventory.productIdentity),
    };
  }
  return { product: matches[0] };
}

// ─── OPERATOR-NAMED PRODUCT FALLBACK ────────────────────────────
//
// The rigid grammar below only recognizes a handful of phrasings ("add <qty>
// <unit> of <name>", "restock <name>", ...). Real voice-typed operator
// prompts routinely miss it ("we just bought a thing of Taurus... I think
// it's 78 ounces"). When the grammar can't extract a target at all, this
// fallback still requires the OPERATOR's own words (this turn, or their own
// recent prior turns on the same thread — never an assistant turn, tool
// result, attachment, or note) to name exactly the product already sitting
// in the preview. It never widens WHO can name a target, only HOW casually
// they can say it.
//
// Generic catalog vocabulary is never distinctive enough, alone, to ground a
// target — "lesco" and "control" show up in dozens of active product names,
// so a bare mention proves nothing about which one an operator meant. Real
// product identity words (Taurus, Alpine, Bifen, ...) are never on this list.
const GENERIC_PRODUCT_WORDS = new Set([
  'insecticide', 'insecticides', 'termiticide', 'termiticides', 'fungicide', 'fungicides',
  'herbicide', 'herbicides', 'fertilizer', 'fertilizers', 'granular', 'granules', 'liquid',
  'liquids', 'concentrate', 'concentrated', 'professional', 'control', 'bait', 'baits',
  'gel', 'station', 'stations', 'spray', 'sprays', 'pest', 'lawn', 'turf', 'plus', 'with',
  'and', 'bottle', 'bottles', 'jug', 'jugs', 'bag', 'bags', 'gallon', 'gallons', 'ounce',
  'ounces', 'lesco', 'product', 'products', 'inventory', 'stock', 'shelf', 'purchase',
  'purchased', 'chemical', 'chemicals', 'vendor', 'restock', 'reorder', 'order', 'shipment',
]);

// A name token can ground a target only when it is long enough to be a real
// identity word, not a bare number, and not generic catalog vocabulary.
// Whether it is actually distinctive (unique to one active product) is
// decided fresh per call in productsNamedIn — a later catalog addition can
// only ever remove a token's distinctiveness, never silently invent one.
function isCandidateToken(token) {
  return token.length >= 4 && !/^[0-9]+$/.test(token) && !GENERIC_PRODUCT_WORDS.has(token);
}


// Spoken percent (Codex round-2 P2): "20 percent"/"per cent"/"pct" is the
// same concentration qualifier as "20%" — a voice-typed "We bought Southern
// Ag Copper 20 percent" must conflict with a "27.15%" catalog row exactly
// like "20%" would. Spelled-out numbers ("twenty percent", "twenty seven
// percent") count too; percentWordsToValue converts the ones this regex can
// capture (one..twenty, thirty..ninety, and a tens+ones compound).
const PERCENT_WORD_RE = '(?:%|percent\\b|per\\s+cent\\b|pct\\b)';
const NUMBER_WORD_ONES = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const NUMBER_WORD_TENS = ['twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const PERCENT_NUMBER_WORD_ALT = `(?:${NUMBER_WORD_TENS.join('|')})(?:[\\s-]+(?:${NUMBER_WORD_ONES.slice(0, 9).join('|')}))?|${NUMBER_WORD_ONES.join('|')}`;
const PERCENT_NUMBER_WORDS_TO_VALUE = Object.fromEntries([
  ...NUMBER_WORD_ONES.map((word, i) => [word, i + 1]),
  ...NUMBER_WORD_TENS.map((word, i) => [word, (i + 2) * 10]),
]);
// "twenty seven" → 27; a lone tens or ones word converts directly; anything
// else (a malformed compound the regex still matched loosely) yields null —
// never counted as a concentration rather than guessed at.
function percentWordsToValue(phrase) {
  const words = phrase.toLowerCase().trim().split(/[\s-]+/);
  if (words.length === 1) return PERCENT_NUMBER_WORDS_TO_VALUE[words[0]] ?? null;
  const [tens, ones] = words;
  const tensValue = PERCENT_NUMBER_WORDS_TO_VALUE[tens];
  const onesValue = PERCENT_NUMBER_WORDS_TO_VALUE[ones];
  return tensValue != null && tensValue >= 20 && tensValue % 10 === 0 && onesValue != null && onesValue < 10
    ? tensValue + onesValue : null;
}

// The codebase treats "10% SC" and "20% SC" as different products — ANY
// match (full catalog name, alias, or distinctive token) must not ignore a
// concentration or formulation qualifier that sits immediately BEFORE or
// AFTER the matched span in the operator's RAW text (a qualifier INSIDE the
// span is already accounted for — matching the name/alias string at all
// proves it's consistent). This is the ONE place that check happens —
// qualifierConflict, called from every match branch in productsNamedIn.
//
// Closed formulation-code set; single letters (F, G, L) are too ambiguous in
// free text to trust. "AS" (aqueous suspension) is deliberately left out —
// it's an ordinary English word ("Taurus AS to add...", a real production
// prompt) and a code this collision-prone is not worth the false positives.
// "FL" is left out for the same reason: "fl oz" (fluid ounces) is the most
// common unit phrase in these prompts, and "fl" sitting right next to a
// match would otherwise misread as the FL code every time. "ME" is left out
// too: "get me Taurus SC" puts the word "me" right before the name. Sorted
// longest-first so "WDG"/"WSG" are never shadowed by the shorter "WG".
const FORMULATION_CODES = ['SC', 'SE', 'EC', 'EW', 'CS', 'WG', 'WDG', 'WSG', 'WP', 'WSP',
  'SG', 'SL', 'SP', 'DF', 'DG', 'GR', 'TC', 'RTU']
  .sort((a, b) => b.length - a.length);
const FORMULATION_CODE_ALT = FORMULATION_CODES.join('|');
// A qualifier is adjacent to a match when only punctuation or whitespace
// (any non-alphanumeric run: commas, colons, quotes, parentheses, ...) sits
// between them, checked in both directions (qualifiersFollowing /
// qualifiersPreceding). "Taurus SC: 20%" and "Taurus SC (20%)" both carry
// the qualifier. A bare number with no '%'/"percent" is still not a
// concentration on its own ("Taurus 78 ounces") — but a bare STRENGTH number
// immediately followed by a formulation code IS a qualifier ("Armada 20 WDG"
// against a "Armada 50 WDG" catalog row): the middle alternative below
// captures the number and the code as one pair, checked together in
// qualifierConflict. Groups: 1 = digit concentration, 2 = spelled-out
// concentration (converted via percentWordsToValue), 3+4 = a bare strength
// number + formulation code pair, 5 = a bare formulation code alone.
const QUALIFIER_AFTER_RE = new RegExp(
  `^[^a-zA-Z0-9]*(?:(\\d+(?:\\.\\d+)?)\\s*${PERCENT_WORD_RE}|(${PERCENT_NUMBER_WORD_ALT})\\s*(?:percent\\b|per\\s+cent\\b|pct\\b)|(\\d+(?:\\.\\d+)?)\\s*(${FORMULATION_CODE_ALT})\\b|(${FORMULATION_CODE_ALT})\\b)`, 'i',
);
// Reading backward, a qualifier must also START on a word boundary: the
// code "SE" must not be read out of "Please", nor "1.5%" out of "21.5%".
// Same group layout as QUALIFIER_AFTER_RE.
const QUALIFIER_BEFORE_RE = new RegExp(
  `(?:(?<![\\d.])(\\d+(?:\\.\\d+)?)\\s*${PERCENT_WORD_RE}|\\b(${PERCENT_NUMBER_WORD_ALT})\\s*(?:percent\\b|per\\s+cent\\b|pct\\b)|(?<![\\d.])(\\d+(?:\\.\\d+)?)\\s*(${FORMULATION_CODE_ALT})\\b|\\b(${FORMULATION_CODE_ALT})\\b)[^a-zA-Z0-9]*$`, 'i',
);

function escapeRegExpLiteral(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Every place in the RAW operator text where this whole-word phrase (the full
// catalog name's words, an alias's own words, or a single distinctive token)
// occurs. Punctuation/whitespace may separate the phrase's own words,
// mirroring containsWholeWords' tolerance. Returns [{ start, end }, ...].
// Between a digit and a letter (either order, inside a word or between two
// words) a separator is optional, so a catalog "Barricade 65WG" matches a
// spoken "65 WG" and an "Armada 50 WDG" matches "50WDG". So is it between
// two single letters ("Bifen I/T" matches "Bifen IT"). Elsewhere words still
// need a separator between them.
const DIGIT_LETTER_BOUNDARY = /(?<=\d)(?=[a-z])|(?<=[a-z])(?=\d)/i;
function phrasePattern(words) {
  return words.map((word, i) => {
    const inner = word.split(DIGIT_LETTER_BOUNDARY).map(escapeRegExpLiteral).join('[^a-zA-Z0-9]*');
    if (i === 0) return inner;
    // Two single letters in a row ("I/T") also match spoken compact ("IT").
    const boundary = /\d$/.test(words[i - 1]) !== /^\d/.test(word) || (words[i - 1].length === 1 && word.length === 1);
    return `${boundary ? '[^a-zA-Z0-9]*' : '[^a-zA-Z0-9]+'}${inner}`;
  }).join('');
}
function findPhraseSpansInRawText(rawText, words) {
  const pattern = phrasePattern(words);
  return [...rawText.matchAll(new RegExp(`\\b${pattern}\\b`, 'gi'))]
    .map((match) => ({ start: match.index, end: match.index + match[0].length }));
}

// The concentration(s)/formulation code(s)/number+code pair(s) immediately
// trailing `fromIndex`, reading forward. Raw text, so '%' survives
// (normalizeForMatch drops it).
function qualifiersFollowing(rawText, fromIndex) {
  let rest = rawText.slice(fromIndex);
  const concentrations = [];
  const formulations = [];
  const numberCodes = [];
  let step = QUALIFIER_AFTER_RE.exec(rest);
  while (step) {
    if (step[1] !== undefined) concentrations.push(Number(step[1]));
    else if (step[2] !== undefined) { const value = percentWordsToValue(step[2]); if (value != null) concentrations.push(value); }
    else if (step[3] !== undefined) numberCodes.push({ number: Number(step[3]), code: step[4].toUpperCase() });
    else formulations.push(step[5].toUpperCase());
    rest = rest.slice(step[0].length);
    step = QUALIFIER_AFTER_RE.exec(rest);
  }
  return { concentrations, formulations, numberCodes };
}

// The concentration(s)/formulation code(s)/number+code pair(s) immediately
// preceding `toIndex`, reading backward (each found qualifier must reach
// all the way to `toIndex` through only separator characters — mirrors
// qualifiersFollowing).
function qualifiersPreceding(rawText, toIndex) {
  let rest = rawText.slice(0, toIndex);
  const concentrations = [];
  const formulations = [];
  const numberCodes = [];
  let step = QUALIFIER_BEFORE_RE.exec(rest);
  while (step) {
    if (step[1] !== undefined) concentrations.push(Number(step[1]));
    else if (step[2] !== undefined) { const value = percentWordsToValue(step[2]); if (value != null) concentrations.push(value); }
    else if (step[3] !== undefined) numberCodes.push({ number: Number(step[3]), code: step[4].toUpperCase() });
    else formulations.push(step[5].toUpperCase());
    rest = rest.slice(0, step.index);
    step = QUALIFIER_BEFORE_RE.exec(rest);
  }
  return { concentrations, formulations, numberCodes };
}

// Does a match of `words` (any match type — full name, alias, or a single
// distinctive token) conflict with `productNameRaw`, given qualifiers found
// immediately before or after the matched span in the RAW text? No qualifier
// captured at all ⇒ never a conflict (e.g. "Taurus" alone, or "Taurus 78
// ounces" — a bare number is not a concentration). Any qualifier captured
// must ALL appear in the product's own catalog name — a formulation code as
// a normalized whole token, a concentration as an exact numeric match against
// the percent numbers in the name's raw text — or it's a conflict. The ONE
// chokepoint for this check; every productsNamedIn match branch calls it.
// `phrases` is every phrase the text names this product by (see
// productsNamedIn), each already carrying its own body-region-filtered
// `spans` (a note/message body mention was never "named" in the first place,
// so it's never checked for a qualifier either). Every surviving occurrence
// of each phrase is checked: "We have Taurus SC on the shelf. We bought
// Taurus SC 20%" conflicts on its second mention even though the first is
// clean.
// `identityNames` are the product's catalog name and its registered aliases:
// a qualifier in any of them is part of the product's identity ("Velista
// WDG" is a registered alias of "Velista").
//
// An N-P-K fertilizer analysis (three 1-2 digit numbers, each with an
// optional one-decimal fraction, joined by -, –, —, or / with optional
// spaces around the separators) is an identity qualifier exactly like a
// concentration or formulation code — a seeded alias "K-Flow" mapping to
// "LESCO K-Flow 0-0-25" must not ground "We bought K-Flow 0-0-20". Checked
// over the WHOLE raw text, not just adjacent to a matched span, because the
// analysis reads as the product's own identity wherever it sits in the
// sentence ("K-Flow — we bought 0-0-20 of it" is still a mismatch).
//
// A REAL analysis uses the SAME separator twice ("0-0-25", "0/0/20") — a
// mixed number like "1-1/2" (gallons) uses TWO DIFFERENT separators ("-"
// then "/") and must never read as one (Codex round-13 P2: "We bought
// Taurus SC, 1-1/2 gallons" misread "1-1/2" as an analysis and refused a
// product with no analysis in its identity at all). \1 backreferences the
// first separator so the second must match it exactly. –/— are normalized
// to a plain "-" first (each is one code unit, same as "-", so match
// indices against the original text are unaffected) so "0–0—25" still
// reads as one analysis with the separator repeated, rather than as two
// different separators that would now fail the backreference.
const ANALYSIS_RE = /\b\d{1,2}(?:\.\d)?\s*([-/])\s*\d{1,2}(?:\.\d)?\s*\1\s*\d{1,2}(?:\.\d)?\b/g;
function normalizeAnalysis(raw) {
  return String(raw).replace(/\s+/g, '').replace(/[–—/]/g, '-');
}
// A deadline date is not an analysis (Codex round-12 P2: "Please buy two
// bottles of Taurus SC by 9/27/26" refused as an 9-27-26 mismatch). A triple
// counts as a date only when a date word introduces it AND it reads as a
// real month/day — "10-10-10" is a common fertilizer grade, so a bare
// date-shaped triple ("Lesco, the 10-10-10") stays an identity qualifier.
const DATE_CUE_BEFORE_RE = /\b(?:by|on|for|before|after|until|till|due|from|since|dated)\s+$/i;
function isCuedDate(text, match) {
  const [month, day] = match[0].split(/\s*[-–—/]\s*/).map(Number);
  const realMonthDay = Number.isInteger(month) && Number.isInteger(day) && month >= 1 && month <= 12 && day >= 1 && day <= 31;
  return realMonthDay && DATE_CUE_BEFORE_RE.test(text.slice(0, match.index));
}
function analysesIn(text) {
  const raw = String(text);
  // Normalize –/— to a plain "-" (same code-unit length, so match.index
  // still lines up with `raw` for isCuedDate's look-back) before matching,
  // so the backreference reads a triple that mixes dash STYLES ("0–0—25")
  // as one repeated separator rather than two different ones.
  const normalized = raw.replace(/[–—]/g, '-');
  return [...normalized.matchAll(ANALYSIS_RE)].filter((m) => !isCuedDate(raw, m)).map((m) => normalizeAnalysis(m[0]));
}
function qualifierConflict(rawText, phrases, identityNames) {
  const { normalizeForMatch } = require('../purchase-receipts/product-matcher');
  const nameTokens = new Set(identityNames.flatMap((name) => normalizeForMatch(name).split(' ')));
  const nameConcentrations = identityNames.flatMap((name) => [...String(name).matchAll(/(\d+(?:\.\d+)?)\s*%/g)].map((m) => Number(m[1])));
  const nameAnalyses = new Set(identityNames.flatMap((name) => analysesIn(name)));
  // An analysis only matters for a product whose OWN identity (catalog name
  // or a registered alias) names one (Codex round-13 P2): with no analysis
  // anywhere in its identity, nameAnalyses is empty and no analysis-shaped
  // text in the operator's words can ever conflict with it — a plain
  // "Taurus SC" (no analysis) is never refused by a date, a mixed number,
  // or anything else analysis-shaped sitting anywhere in the sentence.
  const analysisConflict = nameAnalyses.size > 0 && analysesIn(rawText).some((analysis) => !nameAnalyses.has(analysis));
  return analysisConflict || phrases.some((phrase) => phrase.spans.some((span) => {
    const before = qualifiersPreceding(rawText, span.start);
    const after = qualifiersFollowing(rawText, span.end);
    const formulations = [...before.formulations, ...after.formulations];
    const concentrations = [...before.concentrations, ...after.concentrations];
    const numberCodes = [...before.numberCodes, ...after.numberCodes];
    return !formulations.every((code) => nameTokens.has(code.toLowerCase()))
      || !concentrations.every((n) => nameConcentrations.includes(n))
      // "65 WG" or "65WG" in the text agrees with either "65 WG" or "65WG" in
      // the catalog name.
      || !numberCodes.every((nc) => (nameTokens.has(String(nc.number)) && nameTokens.has(nc.code.toLowerCase()))
        || nameTokens.has(`${nc.number}${nc.code.toLowerCase()}`));
  }));
}

// ─── CLOSED-VOCABULARY RESIDUAL RULE ────────────────────────────
//
// Every prose heuristic tried here — proximity/capitalization, a purchase-
// cue-word regex, a note/message-body detector, a negation detector — chased
// one more failing pre-push-audit prompt without ever converging. Replaced
// with ONE structural rule: a text grounds product P only when, after
// removing every RAW occurrence of P's own name/alias/distinctive-token
// mentions from the text, EVERY remaining word is a number or belongs to a
// small, closed, documented vocabulary (CLOSED_VOCAB). A leftover word
// outside that vocabulary — "used", "unlisted", "chemical", "adjustments",
// "instead", "not", "notes", "customer" — is content the fallback can't
// read, so the text grounds nothing rather than guess at what it means.
// This is what isBareFollowUp ("1 bottle", "78 ounces", "Yes") and
// productsNamedIn's naming check both reduce to; see isClosedVocabResidual.
//
// Deliberately NOT in the vocabulary: not, no, instead, rather, except, but,
// used, before, notes, note, text, message, saying, customer, and every
// other content word — a leftover instance of any of these already refuses
// the text, with no need for its own special-cased detector ("We used
// Taurus SC before, but bought Unlisted Chemical today; add 2 jugs of that
// to inventory" refuses because "used"/"but"/"unlisted"/"chemical" all
// survive removing the one genuine "Taurus SC" mention).
// The one closed, documented list of discourse/politeness filler words —
// spread into CLOSED_VOCAB below (so a leftover filler word never blocks
// the residual rule) AND used to build LEADING_FILLER_RE further down (see
// isQuestion), so the two can never drift apart again. Codex round-11 P2:
// "please" was in CLOSED_VOCAB but missing from the old hand-maintained
// LEADING_FILLER_RE, so "Please, did we receive..." read as a statement.
// Deliberately excludes modal/auxiliary verbs (can, could, would, will, do,
// did, have, has, had, is, are, was, were) — those carry real grammatical
// signal for REQUEST_START_RE / QUESTION_START_RE / the aux-inversion check
// and must never be stripped as if they were content-free filler.
// "question" is NOT here: announcing one ("Quick question, we received two
// bottles of Taurus SC") makes the whole prompt a question (see
// QUESTION_WORD_RE), and it must never count as a neutral closed-vocabulary
// word either.
const FILLER_WORDS = [
  'please', 'pls', 'plz', 'kindly', 'hey', 'hi', 'hello', 'ok', 'okay',
  'so', 'and', 'also', 'um', 'uh', 'well', 'oh', 'yeah', 'yes', 'alright',
  'now', 'just', 'quick',
];
const CLOSED_VOCAB = new Set([
  // pronouns/determiners
  'i', 'we', 'you', 'it', 'its', 's', 'this', 'that', 'these', 'those',
  // contraction fragments once the apostrophe is dropped ("we've", "we're",
  // "we'll", "I'm", "we'd"); "n't" leaves "didn"/"don", which stay outside
  're', 've', 'll', 'm', 'd',
  'a', 'an', 'the', 'some', 'more', 'another', 'our', 'your', 'my', 'me', 'us', 'them', 'they',
  // discourse/politeness filler (the shared FILLER_WORDS list above)
  ...FILLER_WORDS,
  // auxiliaries (grammatical, never filler — kept out of FILLER_WORDS)
  'can', 'could', 'would', 'will', 'go', 'ahead', 'do', 'did',
  'is', 'was', 'are', 'were', 'be', 'been', 'have', 'has', 'had', 'got', 'get', 'think', 'guess',
  // prepositions/conjunctions
  'of', 'to', 'in', 'into', 'for', 'on', 'at', 'as', 'and', 'with', 'from', 'by', 'up',
  // purchase/stock words
  'add', 'added', 'adding', 'bought', 'buy', 'purchase', 'purchased', 'picked', 'pick',
  'received', 'receive', 'restock', 'restocked', 'reorder', 'reordered', 'order', 'ordered',
  'log', 'logged', 'record', 'recorded', 'put', 'count', 'stock', 'inventory', 'shelf',
  'delivered', 'arrived', 'came',
  // quantity words
  ...NUMBER_WORD_ONES, ...NUMBER_WORD_TENS, 'hundred', 'dozen', 'half', 'quarter', 'couple', 'few', 'several',
  // units/containers
  'oz', 'ounce', 'ounces', 'fl', 'fluid', 'gal', 'gallon', 'gallons', 'qt', 'quart', 'quarts',
  'pt', 'pint', 'pints', 'lb', 'lbs', 'pound', 'pounds', 'g', 'gram', 'grams', 'kg', 'ml', 'l',
  'liter', 'liters', 'each', 'item', 'items', 'bottle', 'bottles', 'jug', 'jugs', 'bag', 'bags',
  'case', 'cases', 'box', 'boxes', 'pail', 'pails', 'can', 'cans', 'container', 'containers',
  'tube', 'tubes', 'pack', 'packs', 'thing', 'things', 'unit', 'units', 'bucket', 'buckets',
  // spoken concentration (a percent is a unit for a number, same as "oz" —
  // needed alongside qualifierConflict's own spoken-percent support so a
  // clean "20 percent" mention doesn't strand "percent" as content)
  'percent', 'pct', 'per', 'cent',
  // time
  'today', 'yesterday', 'tonight', 'morning',
]);

// Every RAW word (lowercased, non-alphanumeric runs collapsed to a
// separator) in `rawText`, once the character ranges in `spans` are blanked
// out. `spans` are exactly the matched occurrences of the product mention(s)
// under test — nothing else is ever removed.
function residualWords(rawText, spans) {
  // UTF-16 code units, the same units the regex span offsets count in (an
  // emoji before the name would otherwise shift every blanked position).
  const chars = rawText.split('');
  for (const span of spans) {
    for (let i = span.start; i < span.end; i++) chars[i] = ' ';
  }
  return chars.join('').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
}

// Every leftover word must be a number or in CLOSED_VOCAB. An empty residual
// (the whole text was the removed span(s), or nothing was removed and the
// text was already all-vocabulary) trivially passes.
function isClosedVocabResidual(rawText, spans = []) {
  return residualWords(rawText, spans).every((word) => /^[0-9]+(?:\.[0-9]+)?$/.test(word) || CLOSED_VOCAB.has(word));
}

// A prior operator turn — or the current prompt — may only stand in for
// naming a product when it names NONE of them (checked by the caller via
// productsNamedIn before calling this) and every one of its own words is a
// number or in CLOSED_VOCAB: a genuine bare follow-up ("1 bottle", "78
// ounces", "Yes", "add it"). "we got a new jug of Unlisted Chemical" is NOT
// bare — "unlisted"/"chemical" survive — so it must stand on its own, never
// borrowing a name from an earlier turn.
// A strength or formulation in a follow-up ("20%", "20 percent", "SC") is
// about WHICH product, so it can't borrow one from an earlier turn: the
// borrowed product's own qualifiers were never checked against it.
const FOLLOW_UP_QUALIFIER_RE = new RegExp(`%|\\b(?:percent|pct|per\\s+cent)\\b|(?:\\b|\\d)(?:${FORMULATION_CODE_ALT})\\b`, 'i');
function isBareFollowUp(text) {
  // At least one word: a reply of only punctuation ("?", "...") says nothing
  // and never borrows a product from an earlier turn. An N-P-K analysis is
  // an identity qualifier like a percent or a formulation code: "0-0-20"
  // after "K-Flow 0-0-25" corrects the product, so it never borrows it — and
  // as a turn the look-back meets, it stops the look-back instead of being
  // skipped (2026-09-27 pre-push audit). A cued date isn't an analysis.
  return residualWords(text, []).length > 0 && isClosedVocabResidual(text)
    && !FOLLOW_UP_QUALIFIER_RE.test(text) && analysesIn(text).length === 0;
}

// Which ACTIVE catalog products does operator text name? A product is named
// by its full catalog name, one of its product_aliases, or a name token that
// belongs to it ALONE across the active catalog — each matched as whole
// words (never a substring of a longer word), searched over the FULL raw
// text. A product is actually NAMED only when, after every one of its own
// mention spans is removed, the CLOSED_VOCAB residual rule passes (see
// above) — this is what replaces targetClause (which stripped a real catalog
// name's own punctuation, e.g. an alias like "Premium: Dispatch wetting
// agent" or 'We bought "Taurus SC"') and every prior prose heuristic.
// Returns { named, conflict }: `named` is a Set of product ids (0 = nothing
// named, 1 = grounded, 2+ = ambiguous — the caller refuses rather than
// guessing); `conflict` is true when a match (of ANY type — full name,
// alias, or token) was disqualified by a concentration/formulation qualifier
// sitting immediately before or after the matched span that doesn't match
// that product's own catalog name (e.g. "Taurus SC 20%" or "20% Taurus SC"
// naming only a plain "Taurus SC" catalog row, or "Taurus 20% SC" naming
// only a "Taurus 10% SC" row) — a conflict never grounds, on this text or
// any other (see resolveByOperatorGrounding). See qualifierConflict for the
// one check every match type routes through.
const NOUN_POSITION_UNITS = 'fl\\s*oz|oz|ounces?|gal(?:lons?)?|gals|qts?|quarts?|pts?|pints?|lbs?|pounds?|g|grams?|kg|ml|l|liters?'
  + '|each|items?|bottles?|jugs?|bags?|cases?|box(?:es)?|pails?|cans?|containers?|tubes?|packs?|things?|units?|buckets?';
// A spoken quantity: a/an, hundred, dozen, or a number word including tens+ones
// compounds ("twenty one"), the same forms the percent parser reads.
const NOUN_POSITION_NUMBER_WORDS = `a|an|hundred|dozen|${PERCENT_NUMBER_WORD_ALT}`;
const NOUN_POSITION_BEFORE_RE = new RegExp('(?:\\bof'
  + `|(?:\\b\\d+(?:\\.\\d+)?|\\b(?:${NOUN_POSITION_NUMBER_WORDS}))\\s*(?:${NOUN_POSITION_UNITS})(?:\\s+of)?`
  + ')[^a-zA-Z0-9]*$', 'i');
// Also a noun position: right after a purchase word when a quantity follows
// ("we bought Taurus, eleven ounces"). "We received the dispatch today" has
// no quantity after it, so the shipment reading wins and it names nothing.
const PURCHASE_BEFORE_RE = /\b(?:bought|purchased|got|received|restocked|reordered|ordered|add|added|picked\s+up)(?:\s+(?:a|an|the|some|more|another))?[^a-zA-Z0-9]*$/i;
const QUANTITY_AFTER_RE = new RegExp(`^[^a-zA-Z0-9]*(?:\\d+(?:\\.\\d+)?|(?:${NOUN_POSITION_NUMBER_WORDS}))\\s*(?:${NOUN_POSITION_UNITS})\\b`, 'i');
function inNounPosition(rawText, start, end) {
  const before = rawText.slice(Math.max(0, start - 40), start);
  if (NOUN_POSITION_BEFORE_RE.test(before)) return true;
  return PURCHASE_BEFORE_RE.test(before) && QUANTITY_AFTER_RE.test(rawText.slice(end, end + 40));
}

async function productsNamedIn(rawText) {
  const named = new Set();
  let conflict = false;
  if (!rawText) return { named, conflict };
  const { normalizeForMatch } = require('../purchase-receipts/product-matcher');
  const products = await db('products_catalog').where({ active: true }).select('id', 'name');
  const aliasRows = await db('product_aliases as pa')
    .join('products_catalog as pc', 'pc.id', 'pa.product_id')
    .where('pc.active', true)
    .select('pa.alias_name', 'pa.product_id');

  // A token shared by 2+ active products' names proves nothing on its own.
  const tokenOwners = new Map(); // normalized token -> Set(productId)
  for (const p of products) {
    for (const token of normalizeForMatch(p.name).split(' ')) {
      if (!isCandidateToken(token)) continue;
      if (!tokenOwners.has(token)) tokenOwners.set(token, new Set());
      tokenOwners.get(token).add(p.id);
    }
  }

  for (const p of products) {
    const nameNorm = normalizeForMatch(p.name);
    // Every match type routes through the same qualifierConflict chokepoint
    // — a full-name match is NOT exempt: "Taurus SC 20%" matches the full
    // name "Taurus SC", but the trailing "20%" still has to agree with the
    // catalog row (see qualifierConflict's own doc for why a qualifier
    // INSIDE the matched span needs no separate check).
    // Every phrase that could name this product (full name, each alias,
    // each distinctive token) is checked for its RAW occurrences.
    // A name or alias that normalizes to nothing (whitespace or punctuation
    // only) would build an empty pattern matching every word boundary.
    const phraseWords = [
      nameNorm.split(' '),
      ...aliasRows.filter((a) => a.product_id === p.id).map((a) => normalizeForMatch(a.alias_name).split(' ')),
      ...nameNorm.split(' ').filter((token) => isCandidateToken(token) && tokenOwners.get(token)?.size === 1).map((token) => [token]),
    ].filter((words) => words.join('') !== '');
    const phrases = phraseWords
      .map((words) => ({ single: words.length === 1, spans: findPhraseSpansInRawText(rawText, words) }))
      .filter((phrase) => phrase.spans.length > 0);
    if (!phrases.length) continue;
    // Named only by a lone word (a distinctive token or a one-word alias):
    // that word must stand where a product name stands (inNounPosition): after
    // "of" or a quantity ("a jug of Taurus", "78 oz Taurus"), or after a
    // purchase word with a quantity following ("bought Taurus, eleven
    // ounces"). A verb use ("Can you dispatch this order?") or a common noun
    // ("We received the dispatch today") names nothing.
    if (phrases.every((phrase) => phrase.single)
      && !phrases.some((phrase) => phrase.spans.some((span) => inNounPosition(rawText, span.start, span.end)))) continue;
    // The residual rule: remove every one of THIS product's own mention
    // spans (every match type combined — a full-name match and its own
    // token match cover the same ground) and require the rest of the text
    // to be closed-vocabulary. Not naming (continue, no conflict) when it
    // fails — insufficient/unreadable evidence, never a reason to block a
    // prior-turn fallback the way a genuine qualifier conflict does.
    const allSpans = phrases.flatMap((phrase) => phrase.spans);
    if (!isClosedVocabResidual(rawText, allSpans)) continue;
    const identityNames = [p.name, ...aliasRows.filter((a) => a.product_id === p.id).map((a) => a.alias_name)];
    if (qualifierConflict(rawText, phrases, identityNames)) { conflict = true; continue; }
    named.add(p.id);
  }
  return { named, conflict };
}

// Does the operator's own text (this prompt, or — only when this prompt
// names nothing AND is a bare follow-up — their own recent prior turns)
// ground the preview's product? Returns { productId } (allow),
// { mismatch: true } (a different single product was named —
// target_relationship_mismatch), or null (no grounding found; the caller
// keeps its original clarification refusal, which also covers "named 2+
// products"). Called only where the grammar found no target at all.
// The fallback's words must ask for the tool's own operation. Each text
// reads as ONE operation, in this order of precedence:
// - arrival or completed-purchase words (bought, received, arrived...) mean
//   a receipt, even beside the noun "order" ("The Taurus SC order arrived;
//   add two bottles");
// - otherwise ordering words (order, reorder, restock, buy) mean an order
//   ("please buy Taurus SC", "add Taurus to the reorder list");
// - otherwise recording words (add, log, record, put) mean a receipt.
// adjust_stock needs a receipt and grounds only a restock preview (never a
// count or a write-off); create_restock_request needs an order.
const ARRIVAL_WORDS = new Set(['bought', 'purchased', 'picked', 'received', 'restocked', 'delivered', 'arrived', 'came', 'got']);
const ORDER_WORDS = new Set(['order', 'ordered', 'reorder', 'reordered', 'restock', 'buy']);
const RECORDING_WORDS = new Set(['receive', 'add', 'added', 'adding', 'put', 'log', 'logged', 'record', 'recorded']);
// The verb "purchase" asks for an order ("please purchase two bottles"); the
// noun after a determiner ("we added your purchase") names nothing.
const PURCHASE_VERB_RE = /(?<!\b(?:your|our|the|a|this|that|my|their)\s)\bpurchase\b/;
function textOperation(text) {
  const { normalizeForMatch } = require('../purchase-receipts/product-matcher');
  const normalized = normalizeForMatch(text);
  const words = normalized.split(' ');
  if (words.some((word) => ARRIVAL_WORDS.has(word))) return 'receipt';
  if (words.some((word) => ORDER_WORDS.has(word)) || PURCHASE_VERB_RE.test(normalized)) return 'order';
  return words.some((word) => RECORDING_WORDS.has(word)) ? 'receipt' : null;
}

// A question asks to read, never to write: "Did we receive two bottles of
// Taurus SC?" grounds nothing. Polite requests ("Can you add...", "Could
// you add...?") are not questions.
const QUESTION_START_RE = /^\s*(?:did|do|does|have|has|had|is|are|was|were|how|what|when|where|why|who|which|any)\b/i;
const REQUEST_START_RE = /^\s*(?:please\s+)?(?:can|could|would|will)\s+you\b/i;
// Leading greetings and fillers ("Hey, did we receive...", "Please, did we
// receive...") are skipped before the question-start check. Built from the
// single shared FILLER_WORDS list (see its own doc comment above
// CLOSED_VOCAB) so a word added there is automatically stripped here too —
// any punctuation/whitespace may separate a run of several filler words
// ("um so please, have we received...").
const LEADING_FILLER_RE = new RegExp(`^\\s*(?:(?:${FILLER_WORDS.join('|')})\\b[\\s,.:;!-]*)+`, 'i');
// A clause boundary a question can start fresh after ("Taurus SC — did we
// receive two bottles" is a question even though it doesn't start with
// one). Also used to re-run the filler strip + question-start check at the
// head of every clause, not just the whole text's own head.
const CLAUSE_SPLIT_RE = /[,;:.!?]+|[-–—]+/;
// A non-modal auxiliary immediately followed by its subject, ANYWHERE in
// the text — not just at a clause head — is a spoken-question inversion
// regardless of where it lands ("two bottles of Taurus SC did we receive
// them"). Modals (can/could/would/will) are deliberately excluded: "can
// you"/"could you" stay requests, never questions (REQUEST_START_RE).
const AUX_INVERSION_RE = /\b(?:did|do|does|have|has|had)(?:n['’]?t)?\s+(?:we|you|they|i)\b/i;
// The operator announcing a question anywhere ("quick question", "I have a
// question") makes the prompt a question, whatever its grammar.
const QUESTION_WORD_RE = /\bquestions?\b/i;
function isQuestion(text) {
  const raw = String(text || '');
  // A polite REQUEST ("Can you add...", "Could you add...?") is never a
  // question even when it ends with '?' or contains an aux-inversion
  // elsewhere — checked once against the whole text (after its own leading
  // filler is stripped), exactly as before.
  if (REQUEST_START_RE.test(raw.replace(LEADING_FILLER_RE, ''))) return false;
  const clauses = raw.split(CLAUSE_SPLIT_RE)
    .map((clause) => clause.replace(LEADING_FILLER_RE, '').trim())
    .filter(Boolean);
  if (clauses.some((clause) => QUESTION_START_RE.test(clause))) return true;
  if (AUX_INVERSION_RE.test(raw) || QUESTION_WORD_RE.test(raw)) return true;
  return /\?\s*$/.test(raw);
}

// A statement about the FUTURE, ability, or obligation is not a write
// instruction — exactly like a question, it describes something rather
// than asking for it to be done now (Codex round-13 P2: "We will receive
// two bottles of Taurus SC today" and "We can receive two bottles of
// Taurus SC" both grounded a restock card for a shipment that hasn't
// arrived; base-form "receive" reads as a receipt with no tense check at
// all). A subject pronoun immediately followed by a modal verb, or its
// contraction, is a modal statement: "we will", "we can", "we'll" (curly
// or straight apostrophe), and the apostrophe-less "we ll" normalizeForMatch
// leaves once it collapses "we'll" to two words. The pronoun must come
// FIRST — "Can you ...?"/"Could you ...?" are requests (REQUEST_START_RE
// already reads them as non-questions) and must keep grounding, and this
// order requirement is exactly why they never match here either. A bare
// "can"/"cans" naming a container unit ("two cans of Taurus SC") never
// matches: nothing here reads "can" unless a subject pronoun sits directly
// before it.
const MODAL_WORD_ALT = 'can|could|would|will|shall|should|may|might|must';
const MODAL_STATEMENT_RE = new RegExp(
  `\\b(?:i|we|you|they|he|she|it)\\b(?:['’]?\\s*(?:ll|d)\\b|\\s+(?:${MODAL_WORD_ALT})\\b)`,
  'i',
);
// An infinitive write ("have to receive", "are to receive", "got to
// receive") is the same future/obligation statement spelled without a
// modal verb: an obligation-carrying verb (have/has/had/am/is/are/was/
// were/got) immediately before "to <write verb>". Requiring that lead-in —
// never a bare "to <verb>" anywhere in the text — matters: real
// ungrammatical voice-typed prompts routinely drop an ordinary "to add"
// into a sentence with no obligation sense at all ("...a thing of Taurus
// as to add this to your inventory..." must still ground).
const INFINITIVE_OBLIGATION_LEAD_ALT = 'have|has|had|am|is|are|was|were|got';
const INFINITIVE_WRITE_VERB_ALT = 'receive|add|put|log|record|restock|buy|order|reorder|purchase';
const INFINITIVE_WRITE_RE = new RegExp(
  `\\b(?:${INFINITIVE_OBLIGATION_LEAD_ALT})\\s+to\\s+(?:${INFINITIVE_WRITE_VERB_ALT})\\b`,
  'i',
);
// The one check every operator-grounding gate uses in place of a bare
// isQuestion: a question, a modal statement, or an infinitive write are all
// read-only or future/hypothetical, never a write instruction right now.
function isNotAnInstruction(text) {
  const raw = String(text || '');
  return isQuestion(raw) || MODAL_STATEMENT_RE.test(raw) || INFINITIVE_WRITE_RE.test(raw);
}
// `texts` run newest first: the current prompt, any bare turns the look-back
// skipped, then the turn that named the product. The newest text with an
// operation decides, so "It arrived, one bottle" after "Order Taurus SC" is
// a receipt, and so is "1 bottle" after "We ordered Taurus SC" then "It
// arrived".
function operationMatches(toolName, texts, preview) {
  const operation = texts.map(textOperation).find(Boolean) || null;
  if (toolName === 'adjust_stock') {
    return operation === 'receipt' && (preview.movement_type == null || preview.movement_type === 'restock');
  }
  return toolName === 'create_restock_request' && operation === 'order';
}

const TARGET_UNAVAILABLE = Object.freeze({ error: 'Choose the exact product or restock request for this action.', code: 'target_clarification_required' });

async function resolveByOperatorGrounding(prompt, preview, actorId, threadId, { observedSeq = null, toolName = null } = {}) {
  const grounded = await groundOperatorNamedProduct(prompt, preview, actorId, threadId, { observedSeq, toolName });
  if (grounded?.productId) return { productId: grounded.productId };
  return grounded?.mismatch ? { ...TARGET_UNAVAILABLE, code: 'target_relationship_mismatch' } : TARGET_UNAVAILABLE;
}

async function groundOperatorNamedProduct(prompt, preview, actorId, threadId, { observedSeq, toolName }) {
  if (!preview?.product?.id || isNotAnInstruction(prompt)) return null;
  // `texts` are the operator's words the grounding rests on (this prompt,
  // plus the prior turn that named the product): they must also ask for the
  // same operation as the tool (operationMatches).
  // `result` is productsNamedIn's { named, conflict } for one text. A
  // conflict or 2+ products refuses; exactly one grounds when it is the
  // preview's product and the words ask for this tool's operation.
  const decide = (result, texts) => {
    if (result.conflict || result.named.size !== 1) return null;
    const [id] = result.named;
    if (id !== preview.product.id) return { mismatch: true };
    return operationMatches(toolName, texts, preview) ? { productId: id } : null;
  };
  // Naming comes from the operator's FULL raw text via the closed-vocabulary
  // residual rule (productsNamedIn) — never targetClause, which also strips
  // identity punctuation from a real catalog name/alias ("We bought Premium:
  // Dispatch wetting agent", a seeded alias; 'We bought "Taurus SC"').
  // "Add notes for this customer: Request 2 lb of Taurus SC" still names
  // nothing ("notes"/"customer" are leftover content words, outside
  // CLOSED_VOCAB). Qualifier conflicts are checked across the same spans, so
  // a concentration after a colon ("Taurus SC: 20%") still refuses.
  const current = await productsNamedIn(prompt);
  // A prompt that names anything (or carries a conflict) stands on its own.
  if (current.conflict || current.named.size) return decide(current, [prompt]);
  // A stale tab never grounds off turns it never saw (two tabs on one
  // thread): observedSeq is the requesting tab's own tail seq, from the
  // route's thread_seq. Without one there is no prior-turn grounding at all.
  if (!isBareFollowUp(prompt) || !Number.isInteger(observedSeq)) return null;
  const IbThreads = require('./threads');
  // Newest first and resolved ONE AT A TIME, never concatenated: a turn
  // ending "...Demand" and the next-older turn beginning "CS..." must never
  // combine into a phantom "Demand CS".
  const turns = await IbThreads.recentOperatorTurns(actorId, threadId, { limit: 3, maxAgeMinutes: 30, maxSeq: observedSeq });
  const skipped = [];
  for (const turn of turns) {
    // A question, modal statement, or infinitive write never authorizes a
    // write, even as the turn a "Yes" answers: the look-back stops at it.
    if (isNotAnInstruction(turn)) return null;
    const turnResult = await productsNamedIn(turn);
    if (turnResult.conflict || turnResult.named.size) return decide(turnResult, [prompt, ...skipped, turn]);
    // Named nothing. Only a bare reply ("yes", "1 bottle") has no opinion
    // and may be skipped; any other turn ("Actually use Unlisted Chemical
    // instead") may be a correction this catalog can't read, so the scan
    // stops rather than reach past it to an older product.
    if (!isBareFollowUp(turn)) return null;
    skipped.push(turn);
  }
  return null;
}

// Inventory noun slots come from the current operator request, never a model
// selector, note body, attachment, or transcript. Keep formulation punctuation
// intact: `10% SC` and `20% SC` are different products.
async function resolveInventoryWriteTarget({ toolName, prompt, pageData = {}, preview, actorId, threadId, threadSeq }) {
  const { targetClause, UUID_RE } = require('./task-context');
  // A colon/quote can be part of a catalog identity. Never turn a qualified
  // product into the shorter base product by applying the contact-body split.
  // The anchored inventory grammar below excludes communication/note intents.
  const clause = String(toolName === 'update_restock_request' ? targetClause(prompt, true) : prompt)
    .trim().replace(/^(?:(?:please|can you|could you|would you)\s+)+/i, '');
  const unavailable = TARGET_UNAVAILABLE;
  const inventoryPage = /^\/admin\/inventory(?:[/?]|$)/.test(pageData.route || '');
  const query = new URLSearchParams(typeof pageData.search === 'string' ? pageData.search : '');
  const quantity = '(?:[0-9]+(?:\\.[0-9]+)?|one|two|three|four|five|six|seven|eight|nine|ten|zero)';
  const unit = '(?:lb|lbs|pounds?|oz|ounces?|fl_oz|fluid ounces?|gal|gallons?|liters?|ml|grams?|kg|each|items?|bottles?|bags?|containers?|cases?|jugs?)';
  if (toolName === 'update_restock_request') {
    const requestClause = clause.replace(new RegExp(`^receive\\s+(?:the\\s+)?(?:${quantity}\\s+${unit}(?:\\s+that arrived)?|(?:actual\\s+)?(?:packaged\\s+)?shipment)\\s+for\\s+`, 'i'), 'receive ');
    const referenceMatch = requestClause.match(/^(?:mark|record|cancel|receive)\s+(?:(this|that|current|selected|viewed|open|the)\s+)?(?:restock\s+)?request(?:\s+([0-9a-f-]{36}))?(?:\s+as\s+(?:ordered|received|cancelled))?[.!]?$/i);
    if (referenceMatch) {
      const reference = referenceMatch[2] || (referenceMatch[1] && referenceMatch[1].toLowerCase() !== 'the' && inventoryPage
        ? pageData.requestId || pageData.request_id || query.get('requestId') : null);
      if (!UUID_RE.test(String(reference || '')) || reference.toLowerCase() !== preview.request?.id) return unavailable;
      return { productId: preview.product.id, requestId: preview.request.id };
    }
    // Named request selectors also retain the complete product identity.
    const namedClause = String(prompt).trim().replace(/^(?:(?:please|can you|could you|would you)\s+)+/i, '');
    const productName = namedClause.match(/^(?:mark|record|cancel|receive)\s+(?:the\s+)?restock request for\s+(.+?)(?:\s+as\s+(?:ordered|received|cancelled))?$/i)?.[1]
      || namedClause.match(/^I ordered (?:the\s+)?(.+)$/i)?.[1]
      || namedClause.match(/^cancel (?:that|the)\s+(.+?)\s+request$/i)?.[1];
    if (!productName) return unavailable;
    const resolved = await resolveProduct({ product_name: productName });
    if (resolved.error) return { ...resolved, code: 'target_clarification_required' };
    const { requests } = await require('../inventory-restock-queue').listRestockRequests({
      productId: resolved.product.id, status: 'active', limit: 2,
    });
    if (requests.length !== 1 || requests[0].id !== preview.request?.id || resolved.product.id !== preview.product?.id) return unavailable;
    return { productId: preview.product.id, requestId: preview.request.id };
  }
  if (toolName === 'create_restock_request' && preview.allow_duplicate === true
    && !/^(?:save|create)\s+another\s+(?:(?:restock|reorder)\s+)?request\s+for\s+/i.test(clause)) {
    return { error: 'Explicitly request another restock request to create a duplicate.', code: 'duplicate_intent_required' };
  }
  // Grammar found no interpretable product reference at all: fall back to
  // whether the OPERATOR's own words name exactly the product already
  // sitting in the preview. Each call site states its own policy on prior
  // turns — see resolveByOperatorGrounding. `threadSeq` (the caller's
  // observed thread tail) rides along on every call so a stale tab never
  // reads prior turns it never saw.
  const amount = `(?:the\\s+)?${quantity}\\s+${unit}\\s+of\\s+`;
  const patterns = [
    /^write off the (?:spilled|damaged) (?:bag|bottle|container|case|jug) of\s+(.+)$/i,
    new RegExp(`^(?:add|record|request|receive|write off)\\s+${amount}(.+)$`, 'i'),
    new RegExp(`^(?:save|create)\\s+(?:a|an|another|the)\\s+(?:(?:restock|reorder)\\s+)?request\\s+for\\s+${amount}(.+)$`, 'i'),
    /^(?:set\s+)?(?:the\s+)?(?:physical\s+)?shelf count for\s+(.+?)\s+(?:is|to)\s+.+$/i,
    new RegExp(`^we have\\s+${amount}(.+?)\\s+on the shelf$`, 'i'),
    /^(?:put|add)\s+(.+?)\s+(?:on|to)\s+(?:the\s+)?(?:restock|reorder)\s+list$/i,
    /^(?:restock|reorder)\s+(.+)$/i,
  ];
  const selected = patterns.map(pattern => clause.match(pattern)?.[1]).find(Boolean);
  // No pattern matched at all, so the operator named no target the grammar
  // can read: this is the one place the free-phrasing fallback runs (and,
  // for a bare follow-up like "1 bottle", recent operator turns).
  if (!selected) return resolveByOperatorGrounding(prompt, preview, actorId, threadId, { observedSeq: threadSeq, toolName });
  // A trailing destination ("… to inventory", "… into our stock") names
  // where the stock goes, not the product: "add two bottles of Taurus SC to
  // inventory" must look up "Taurus SC" (the grammar captured the whole
  // remainder, so the lookup failed and asked the operator to clarify).
  let name = selected.replace(/\s+(?:to\s+(?:the\s+)?(?:restock|reorder)\s+list|(?:to|into)\s+(?:the\s+|our\s+)?(?:inventory|stock)|that\s+(?:physically\s+)?arrived|on the shelf)[.!]?$/i, '').trim();
  let literal = null;
  const deadline = toolName === 'create_restock_request' && name.match(/^(.+?)\s+(?:before|by)\s+(?:(?:this|next)\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow|\d{4}-\d{2}-\d{2})[.!]?$/i);
  if (deadline) {
    // A deadline-looking suffix can still belong to a complete catalog name.
    // Only split it after that lookup misses, and never drop the preview date.
    literal = await resolveProduct({ product_name: name });
    if (!literal.product && !literal.candidates) {
      // A missing/unresolvable deadline is not a product-identity problem —
      // no grounding fallback here at all, operator-named or otherwise.
      if (!preview.needed_by) return unavailable;
      name = deadline[1].trim();
      literal = null;
    }
  }
  const deictic = /^(?:this|that|current|selected|viewed|open)\s+product$/i.test(name);
  const productId = deictic && inventoryPage ? pageData.productId || pageData.product_id || query.get('productId')
    : name.replace(/^product\s+/i, '');
  const selector = UUID_RE.test(String(productId || '')) ? { product_id: productId } : { product_name: name };
  // The grammar found an explicit target here (a page deictic, or a named
  // selector below). When that target can't be resolved, the operator asked
  // for something specific the catalog doesn't show, so they are asked to
  // clarify; the free-phrasing fallback never substitutes another mention
  // ("Restock Unlisted Chemical instead of Taurus SC").
  if (deictic && !selector.product_id) return unavailable;
  const resolved = literal || await resolveProduct(selector);
  if (resolved.error) return { ...resolved, code: 'target_clarification_required' };
  if (resolved.product.id !== preview.product?.id) return { ...unavailable, code: 'target_relationship_mismatch' };
  return { productId: resolved.product.id };
}

async function queryStock(input) {
  const { search, category, low_stock_only, untracked_only, limit: rawLimit } = input;
  const limit = Math.min(rawLimit || 50, 200);

  let query = db('products_catalog');
  if (search) {
    query = query.where(function () {
      this.whereILike('name', `%${search}%`).orWhereILike('active_ingredient', `%${search}%`);
    });
  }
  if (category) query = query.whereILike('category', `%${category}%`);
  if (low_stock_only === true) {
    query = query.whereNotNull('inventory_on_hand').where(function () {
      this.where('inventory_on_hand', '<=', 0)
        .orWhereRaw('(low_stock_threshold is not null and inventory_on_hand <= low_stock_threshold)');
    });
  }
  if (untracked_only === true) query = query.whereNull('inventory_on_hand');

  const products = await query.orderBy('name').limit(limit);

  let totals = null;
  try {
    const row = await db('products_catalog')
      .select(
        db.raw('count(*) as total'),
        db.raw('count(inventory_on_hand) as tracked'),
        db.raw('count(*) filter (where inventory_on_hand is not null and (inventory_on_hand <= 0 or (low_stock_threshold is not null and inventory_on_hand <= low_stock_threshold))) as low_stock'),
      )
      .first();
    totals = {
      total_products: parseInt(row?.total || 0),
      tracked: parseInt(row?.tracked || 0),
      untracked: parseInt(row?.total || 0) - parseInt(row?.tracked || 0),
      low_stock: parseInt(row?.low_stock || 0),
    };
  } catch (err) {
    logger.warn(`[intelligence-bar:procurement] stock totals query failed: ${err.message}`);
  }

  return {
    products: products.map(p => ({
      id: p.id,
      name: p.name,
      category: p.category,
      container_size: p.container_size,
      ...stockFields(p),
    })),
    total: products.length,
    catalog_summary: totals,
    note: 'Untracked products (on_hand null) are invisible to completion-flow deduction until a first count is logged with adjust_stock.',
  };
}

async function getStockMovements(input) {
  const resolved = await resolveProduct(input);
  if (resolved.error) return resolved;
  const { product } = resolved;
  const limit = Math.min(input.limit || 20, 100);

  let query = db('product_inventory_movements as pim')
    .leftJoin('customers as c', 'pim.customer_id', 'c.id')
    .leftJoin('service_records as sr', 'pim.service_record_id', 'sr.id')
    .where('pim.product_id', product.id)
    .select('pim.*', 'c.first_name', 'c.last_name', 'sr.service_type', 'sr.service_date')
    .orderBy('pim.created_at', 'desc')
    .limit(limit);
  if (input.days_back) {
    query = query.where('pim.created_at', '>=', new Date(Date.now() - input.days_back * 86400000));
  }
  const rows = await query;

  return {
    product: { id: product.id, name: product.name, ...stockFields(product) },
    movements: rows.map(r => ({
      id: r.id,
      type: r.movement_type,
      quantity: toNumber(r.quantity),
      unit: r.unit,
      stock_before: toNumber(r.stock_before),
      stock_after: toNumber(r.stock_after),
      cost_used: toNumber(r.cost_used),
      customer: `${r.first_name || ''} ${r.last_name || ''}`.trim() || null,
      service_type: r.service_type || null,
      service_date: r.service_date || null,
      lot_number: r.lot_number || null,
      date: r.created_at,
    })),
    total: rows.length,
  };
}

async function getRestockQueue(input, actionContext) {
  const status = input.status || 'active';
  const { requests } = await require('../inventory-restock-queue').listRestockRequests({
    status, limit: input.limit || 50, showSpend: actionContext.isAdmin === true, requestId: input.request_id,
  });
  return { requests: requests.map(row => ({
    id: row.id, product_id: row.productId, product: row.productName, category: row.productCategory,
    status: row.status, priority: row.priority, requested_quantity: row.requestedQuantity, unit: row.unit,
    current_stock: row.liveStock, inventory_unit: row.inventoryUnit, vendor: row.vendor,
    vendor_sku: row.vendorSku, vendor_product_url: row.vendorProductUrl, order: row.order,
    needed_by: row.neededBy, reason: row.reason, source: row.source, created: row.createdAt,
  })), total: requests.length, status_filter: status,
  note: 'Request status records staff workflow. The separate order field is the actual known vendor-order state.' };
}

// The only approval authority is the server execution context and its fresh
// preview version. Model fields cannot supply actor or approval credentials.
function inventoryWriteOptions(input, actionContext, source) {
  if (!actionContext.isAdmin || !input._verified_inventory_version) {
    throw Object.assign(new Error('A fresh administrator confirmation is required'), { code: 'approval_required' });
  }
  return { actorId: actionContext.technicianId, expectedVersion: input._verified_inventory_version, source };
}

async function adjustStock(input, actionContext) {
  const resolved = await resolveProduct(input);
  if (resolved.error) return resolved;
  const fields = { movementType: input.movement_type, quantity: input.quantity, setTotal: input.set_total,
    unit: input.unit, lotNumber: input.lot_number, reason: input.reason, note: input.note };
  if (!actionContext.confirmed) return inventory.previewStockAdjustment(resolved.product.id, fields);
  const result = await inventory.adjustStock(resolved.product.id, fields,
    inventoryWriteOptions(input, actionContext, 'intelligence_bar_adjust_stock'));
  return { success: true, state: 'completed', product: inventory.productIdentity(result.product),
    movement_type: result.movement.movement_type, stock_before: toNumber(result.movement.stock_before),
    stock_after: toNumber(result.movement.stock_after), change: toNumber(result.movement.metadata.delta),
    unit: result.movement.unit, movement_id: result.movement.id, verification: result.verification,
    receipt: { label: 'Stock updated', summary: `${result.product.name}: ${toNumber(result.movement.stock_after)} ${result.movement.unit} on hand.`, href: result.href } };
}

async function createRestockRequest(input, actionContext) {
  const resolved = await resolveProduct(input);
  if (resolved.error) return resolved;
  const fields = { requestedQuantity: input.quantity, unit: input.unit, priority: input.priority || 'normal',
    vendor: input.vendor, neededBy: input.needed_by, reason: input.reason, allowDuplicate: input.allow_duplicate };
  if (!actionContext.confirmed) return inventory.previewRestockRequest(resolved.product.id, fields);
  const result = await inventory.createRestockRequest(resolved.product.id, fields,
    inventoryWriteOptions(input, actionContext, 'intelligence_bar'));
  const row = result.restockRequest;
  if (result.existing) return { success: false, blocked: true, code: 'request_exists',
    error: 'An active restock request already exists. Review that request before continuing.',
    existing_request: { id: row.id, product_id: row.product_id, status: row.status, source: row.source, requested_quantity: toNumber(row.requested_quantity), unit: row.unit } };
  return { success: true, state: 'completed', existing: result.existing,
    request: { id: row.id, product_id: row.product_id, product: resolved.product.name, status: row.status,
      requested_quantity: toNumber(row.requested_quantity), unit: row.unit, priority: row.priority, vendor: row.vendor, needed_by: row.needed_by },
    verification: result.verification,
    receipt: { label: 'Restock request saved',
      summary: `${resolved.product.name}: ${toNumber(row.requested_quantity)} ${row.unit}; request ${row.status}. No vendor order was submitted.`, href: result.href } };
}

async function updateRestockRequest(input, actionContext) {
  const fields = { action: input.action, quantity: input.quantity, unit: input.unit, note: input.note };
  if (!actionContext.confirmed) return inventory.previewRestockAction(input.request_id, fields);
  const result = await inventory.updateRestockRequest(input.request_id, fields,
    inventoryWriteOptions(input, actionContext, 'intelligence_bar_restock_receive'));
  const labels = { mark_ordered: 'Recorded as ordered', receive: 'Stock received', cancel: 'Request canceled' };
  const summary = result.movement
    ? `${toNumber(result.movement.quantity)} ${result.movement.unit} received; ${toNumber(result.movement.stock_after)} ${result.movement.unit} on hand.`
    : { mark_ordered: 'Recorded the staff-placed order. Stock is unchanged.', cancel: 'The restock request is closed. No vendor order was canceled.' }[input.action];
  return { success: true, state: 'completed', request_id: result.request.id, product_id: result.request.product_id,
    status: result.request.status, verification: result.verification,
    ...(result.movement ? { movement_id: result.movement.id, stock_before: toNumber(result.movement.stock_before),
      added: toNumber(result.movement.quantity), stock_after: toNumber(result.movement.stock_after), unit: result.movement.unit } : {}),
    receipt: { label: labels[input.action], summary, href: result.href } };
}

module.exports = { PROCUREMENT_TOOLS, executeProcurementTool, resolveInventoryWriteTarget };
