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
const inventory = require('../inventory-operations');

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

    const msg = await anthropic.messages.create({
      model: MODELS.FLAGSHIP,
      max_tokens: 2000,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{ role: 'user', content: prompt }],
    });

    // Handle tool use loop
    let currentMsg = msg;
    let responseText = '';
    let loops = 0;
    while (loops < 8) {
      for (const block of currentMsg.content) {
        if (block.type === 'text') responseText += block.text;
      }
      if (currentMsg.stop_reason !== 'tool_use') break;
      loops++;
      const toolUseBlocks = currentMsg.content.filter(b => b.type === 'tool_use');
      const toolResults = toolUseBlocks.map(tb => ({
        type: 'tool_result', tool_use_id: tb.id,
        content: 'Search completed. Provide final JSON response.',
      }));
      currentMsg = await anthropic.messages.create({
        model: MODELS.FLAGSHIP,
        max_tokens: 2000,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [
          { role: 'user', content: prompt },
          { role: 'assistant', content: currentMsg.content },
          { role: 'user', content: toolResults },
        ],
      });
    }

    // Parse JSON
    let parsed;
    try {
      const clean = responseText.replace(/```json|```/g, '').trim();
      const jsonMatch = clean.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(jsonMatch ? jsonMatch[0] : clean);
    } catch {
      return { success: true, raw_response: responseText, note: 'AI returned non-JSON. See raw_response.' };
    }

    // Create approval queue entries
    let approvalsCreated = 0;
    if (parsed.results && parsed.results.length > 0) {
      for (const result of parsed.results) {
        const vendor = vendors.find(v => v.name.toLowerCase() === result.vendor?.toLowerCase());
        if (!vendor || !result.price) continue;
        try {
          await db('price_approvals').insert({
            product_id: product.id, vendor_id: vendor.id,
            new_price: result.price, new_quantity: result.quantity || product.container_size,
            source_url: result.url || null, status: 'pending',
          });
          approvalsCreated++;
        } catch (insertErr) {
          if (!insertErr.message?.includes('duplicate') && !insertErr.message?.includes('unique')) {
            logger.warn(`[intelligence-bar:procurement] Price approval insert failed: ${insertErr.message}`);
          }
        }
      }
    }

    logger.info(`[intelligence-bar:procurement] Price lookup for ${product.name}: ${parsed.results?.length || 0} results, ${approvalsCreated} approvals created`);

    return {
      success: true,
      product: product.name,
      results: parsed.results || [],
      cheapest: parsed.cheapest,
      summary: parsed.summary,
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

// Inventory noun slots come from the current operator request, never a model
// selector, note body, attachment, or transcript. Keep formulation punctuation
// intact: `10% SC` and `20% SC` are different products.
async function resolveInventoryWriteTarget({ toolName, prompt, pageData = {}, preview }) {
  const { targetClause, UUID_RE } = require('./task-context');
  // A colon/quote can be part of a catalog identity. Never turn a qualified
  // product into the shorter base product by applying the contact-body split.
  // The anchored inventory grammar below excludes communication/note intents.
  const clause = String(toolName === 'update_restock_request' ? targetClause(prompt, true) : prompt)
    .trim().replace(/^(?:(?:please|can you|could you|would you)\s+)+/i, '');
  const unavailable = { error: 'Choose the exact product or restock request for this action.', code: 'target_clarification_required' };
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
  if (!selected) return unavailable;
  let name = selected.replace(/\s+(?:to\s+(?:the\s+)?(?:restock|reorder)\s+list|that\s+(?:physically\s+)?arrived|on the shelf)[.!]?$/i, '').trim();
  let literal = null;
  const deadline = toolName === 'create_restock_request' && name.match(/^(.+?)\s+(?:before|by)\s+(?:(?:this|next)\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow|\d{4}-\d{2}-\d{2})[.!]?$/i);
  if (deadline) {
    // A deadline-looking suffix can still belong to a complete catalog name.
    // Only split it after that lookup misses, and never drop the preview date.
    literal = await resolveProduct({ product_name: name });
    if (!literal.product && !literal.candidates) {
      if (!preview.needed_by) return unavailable;
      name = deadline[1].trim();
      literal = null;
    }
  }
  const deictic = /^(?:this|that|current|selected|viewed|open)\s+product$/i.test(name);
  const productId = deictic && inventoryPage ? pageData.productId || pageData.product_id || query.get('productId')
    : name.replace(/^product\s+/i, '');
  const selector = UUID_RE.test(String(productId || '')) ? { product_id: productId } : { product_name: name };
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
