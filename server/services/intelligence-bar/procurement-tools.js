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
const { describeInventoryConversion, unitDefinition } = require('../inventory-units');

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
    description: `Compare prices for a specific product across all vendors. Shows each vendor's price, price-per-oz, and identifies the cheapest.
Use for: "compare SiteOne vs LESCO on Bifen IT", "where's the cheapest Demand CS?", "pricing breakdown for Prodiamine"`,
    input_schema: {
      type: 'object',
      properties: {
        product_name: { type: 'string', description: 'Product name to compare (partial match OK)' },
        product_id: { type: 'string', description: 'Or use exact product UUID' },
      },
      required: ['product_name'],
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
        product_id: { type: 'string', description: 'Or exact product UUID' },
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
        limit: { type: 'number' },
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
        product_id: { type: 'string', description: 'Or exact product UUID' },
        movement_type: { type: 'string', enum: ['restock', 'correction', 'damaged_lost'], description: 'restock = stock purchased/added; correction = physical count fix (signed quantity or set_total); damaged_lost = write-off' },
        quantity: { type: 'number', description: 'Amount to add (restock), remove (damaged_lost), or signed delta (correction)' },
        set_total: { type: 'number', description: 'Correction only: set the absolute on-hand amount (what is physically on the shelf). Pass this OR quantity, not both.' },
        unit: { type: 'string', description: 'Unit of the entered amount (fl_oz, gal, qt, oz, lb, g, kg...). Defaults to the product inventory unit; required for a first count.' },
        lot_number: { type: 'string' },
        reason: { type: 'string', description: 'Why — e.g. "garage shelf count 2026-07-04"' },
      },
      required: ['movement_type'],
    },
  },
  {
    name: 'create_restock_request',
    description: `Add a product to the restock queue (a purchase to make). Your call returns a preview; the operator confirms in the UI.
Use for: "put Bifen on the shopping list", "order 2 bags of Prodiamine before Tuesday"`,
    input_schema: {
      type: 'object',
      properties: {
        product_name: { type: 'string', description: 'Product name (partial match OK)' },
        product_id: { type: 'string', description: 'Or exact product UUID' },
        quantity: { type: 'number', description: 'How much to order' },
        unit: { type: 'string', description: 'Unit of the requested amount. Defaults to the product inventory unit.' },
        priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
        vendor: { type: 'string', description: 'Where to buy. Defaults to the product best-price vendor.' },
        needed_by: { type: 'string', description: 'YYYY-MM-DD deadline' },
        reason: { type: 'string' },
      },
      required: ['quantity'],
    },
  },
  {
    name: 'update_restock_request',
    description: `Act on a restock request: mark_ordered (placed the order), receive (arrived — ADDS the stock and logs a restock movement), or cancel. Your call returns a preview; the operator confirms in the UI. Use get_restock_queue first to find the request id.
Use for: "I ordered the Bifen", "the SiteOne order arrived", "cancel that Prodiamine request"`,
    input_schema: {
      type: 'object',
      properties: {
        request_id: { type: 'string', description: 'Restock request UUID (from get_restock_queue)' },
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

async function executeProcurementTool(toolName, input) {
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
      case 'get_restock_queue': return await getRestockQueue(input);
      case 'adjust_stock': return await adjustStock(input);
      case 'create_restock_request': return await createRestockRequest(input);
      case 'update_restock_request': return await updateRestockRequest(input);
      default: return { error: `Unknown procurement tool: ${toolName}` };
    }
  } catch (err) {
    logger.error(`[intelligence-bar:procurement] Tool ${toolName} failed:`, err);
    return { error: err.message };
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


async function compareVendorPricing(input) {
  const { product_name, product_id } = input;

  let product;
  if (product_id) {
    product = await db('products_catalog').where('id', product_id).first();
  } else {
    product = await db('products_catalog').whereILike('name', `%${product_name}%`).first();
  }
  if (!product) return { error: `Product "${product_name}" not found` };

  const pricing = await db('vendor_pricing')
    .where('product_id', product.id)
    .join('vendors', 'vendor_pricing.vendor_id', 'vendors.id')
    .select('vendor_pricing.*', 'vendors.name as vendor_name', 'vendors.website')
    .orderBy('vendor_pricing.price');

  const cheapest = pricing.length > 0 ? pricing[0] : null;
  const mostExpensive = pricing.length > 0 ? pricing[pricing.length - 1] : null;
  const savings = cheapest && mostExpensive && pricing.length > 1
    ? parseFloat(mostExpensive.price) - parseFloat(cheapest.price)
    : 0;

  return {
    product: {
      id: product.id, name: product.name, category: product.category,
      container_size: product.container_size, active_ingredient: product.active_ingredient,
      current_best_price: product.best_price ? parseFloat(product.best_price) : null,
      current_best_vendor: product.best_vendor,
    },
    vendor_prices: pricing.map(p => ({
      vendor: p.vendor_name,
      price: parseFloat(p.price || 0),
      quantity: p.quantity,
      price_per_oz: p.price_per_oz ? parseFloat(p.price_per_oz) : null,
      is_best: p.is_best_price,
      url: p.vendor_product_url,
      last_checked: p.last_checked_at,
    })),
    cheapest_vendor: cheapest?.vendor_name,
    cheapest_price: cheapest ? parseFloat(cheapest.price) : null,
    price_range: savings > 0 ? `$${savings.toFixed(2)} spread across ${pricing.length} vendors` : null,
    vendor_count: pricing.length,
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
    const prices = await db('vendor_pricing')
      .where('product_id', p.id)
      .join('vendors', 'vendor_pricing.vendor_id', 'vendors.id')
      .select('vendors.name as vendor', 'vendor_pricing.price', 'vendor_pricing.quantity')
      .orderBy('vendor_pricing.price').limit(3);

    results.push({
      product: p.name,
      category: p.category,
      container_size: p.container_size,
      cheapest: prices[0] ? { vendor: prices[0].vendor, price: parseFloat(prices[0].price) } : null,
      runner_up: prices[1] ? { vendor: prices[1].vendor, price: parseFloat(prices[1].price) } : null,
      savings_vs_next: prices.length >= 2 ? parseFloat(prices[1].price) - parseFloat(prices[0].price) : 0,
    });
  }

  return { results, total: results.length };
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
      is_better_than_current: a.current_best ? parseFloat(a.new_price) < parseFloat(a.current_best) : true,
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

  if (action === 'approve') {
    // Update the approval
    await db('price_approvals').where('id', approval_id).update({
      status: 'approved', reviewed_by: 'intelligence_bar', reviewed_at: new Date(), notes,
    });

    // Update vendor pricing
    const existing = await db('vendor_pricing')
      .where({ product_id: approval.product_id, vendor_id: approval.vendor_id }).first();

    if (existing) {
      await db('vendor_pricing').where('id', existing.id).update({
        previous_price: existing.price, price: approval.new_price,
        quantity: approval.new_quantity || existing.quantity,
        source: 'ai_approved', last_checked_at: new Date(), updated_at: new Date(),
      });
    } else {
      await db('vendor_pricing').insert({
        product_id: approval.product_id, vendor_id: approval.vendor_id,
        price: approval.new_price, quantity: approval.new_quantity,
        source: 'ai_approved', last_checked_at: new Date(),
      });
    }

    // Check if this is the new best price
    const allPrices = await db('vendor_pricing').where('product_id', approval.product_id).orderBy('price');
    if (allPrices.length > 0) {
      const best = allPrices[0];
      await db('vendor_pricing').where('product_id', approval.product_id).update({ is_best_price: false });
      await db('vendor_pricing').where('id', best.id).update({ is_best_price: true });
      const bestVendor = await db('vendors').where('id', best.vendor_id).first();
      await db('products_catalog').where('id', approval.product_id).update({
        best_price: best.price, best_vendor: bestVendor?.name, needs_pricing: false,
      });
    }

    const product = await db('products_catalog').where('id', approval.product_id).first();
    return { success: true, action: 'approved', product: product?.name, price: parseFloat(approval.new_price) };
  }

  if (action === 'reject') {
    await db('price_approvals').where('id', approval_id).update({
      status: 'rejected', reviewed_by: 'intelligence_bar', reviewed_at: new Date(), notes,
    });
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

function round4(n) {
  return Number(n.toFixed(4));
}

function stockFields(p) {
  const onHand = toNumber(p.inventory_on_hand);
  const threshold = toNumber(p.low_stock_threshold);
  return {
    on_hand: onHand,
    unit: p.inventory_unit || null,
    low_stock_threshold: threshold,
    tracked: onHand != null,
    low_stock: onHand != null && threshold != null && onHand <= threshold,
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
  const matches = await db('products_catalog').whereILike('name', `%${name}%`).limit(6);
  if (!matches.length) return { error: `Product "${name}" not found in catalog` };
  if (matches.length > 1) {
    const exact = matches.find(m => String(m.name).toLowerCase() === name.toLowerCase());
    if (exact) return { product: exact };
    return {
      error: `Multiple products match "${name}" — retry with product_id`,
      candidates: matches.map(m => ({ id: m.id, name: m.name, category: m.category })),
    };
  }
  return { product: matches[0] };
}

// Shared math for adjust_stock: entered amount → delta in the product's
// inventory unit. Run once for the preview and again inside the confirmed
// transaction against the locked row — preview numbers are never trusted.
function computeStockChange(product, { movementType, qty, setTotal, unit }) {
  const enteredUnit = unit || product.inventory_unit;
  if (!enteredUnit) {
    return { error: 'This product has no inventory unit yet — pass unit (fl_oz, gal, qt, oz, lb, g, kg...)' };
  }
  if (!unitDefinition(enteredUnit)) {
    return { error: `Unsupported unit "${enteredUnit}". Supported: fl_oz, gal, qt, pt, ml, l, oz, lb, g, kg` };
  }
  const inventoryUnit = product.inventory_unit || enteredUnit;
  const stockBefore = toNumber(product.inventory_on_hand) ?? 0;

  let conversionConfidence = 'exact_unit';
  let conversionNote = null;
  const convertMagnitude = (amount) => {
    const conv = describeInventoryConversion(amount, enteredUnit, inventoryUnit);
    if (!conv.convertible || conv.amount == null) {
      return { error: `Cannot convert ${enteredUnit} to the product's inventory unit (${inventoryUnit})` };
    }
    conversionConfidence = conv.confidence;
    if (conv.confidence !== 'exact_unit') {
      conversionNote = `${amount} ${enteredUnit} = ${conv.amount} ${inventoryUnit}`
        + (conv.confidence === 'converted_ambiguous_oz' ? ' (ambiguous oz — verify weight vs volume)' : '');
    }
    return { amount: conv.amount };
  };

  let delta;
  if (setTotal != null) {
    let totalInInventoryUnit = 0;
    if (setTotal > 0) {
      const conv = convertMagnitude(setTotal);
      if (conv.error) return conv;
      totalInInventoryUnit = conv.amount;
    }
    delta = round4(totalInInventoryUnit - stockBefore);
    if (delta === 0) return { error: `Stock is already ${stockBefore} ${inventoryUnit} — nothing to adjust` };
  } else {
    const conv = convertMagnitude(Math.abs(qty));
    if (conv.error) return conv;
    delta = (movementType === 'damaged_lost' || qty < 0) ? -conv.amount : conv.amount;
  }

  return {
    stockBefore,
    stockAfter: round4(stockBefore + delta),
    delta,
    inventoryUnit,
    enteredUnit,
    conversionConfidence,
    conversionNote,
  };
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
    query = query.whereNotNull('inventory_on_hand').whereNotNull('low_stock_threshold')
      .whereRaw('inventory_on_hand <= low_stock_threshold');
  }
  if (untracked_only === true) query = query.whereNull('inventory_on_hand');

  const products = await query.orderBy('name').limit(limit);

  let totals = null;
  try {
    const row = await db('products_catalog')
      .select(
        db.raw('count(*) as total'),
        db.raw('count(inventory_on_hand) as tracked'),
        db.raw('count(*) filter (where inventory_on_hand is not null and low_stock_threshold is not null and inventory_on_hand <= low_stock_threshold) as low_stock'),
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

async function getRestockQueue(input) {
  const status = String(input.status || 'active').toLowerCase();
  const limit = Math.min(input.limit || 50, 200);

  let query = db('product_restock_requests as prr')
    .leftJoin('products_catalog as pc', 'prr.product_id', 'pc.id')
    .select('prr.*', 'pc.name as product_name', 'pc.category as product_category',
      'pc.inventory_on_hand', 'pc.inventory_unit', 'pc.best_vendor')
    .orderByRaw("case prr.priority when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end")
    .orderByRaw('prr.needed_by asc nulls last')
    .orderBy('prr.created_at', 'desc')
    .limit(limit);
  if (status !== 'all') query = query.whereIn('prr.status', status === 'active' ? ['open', 'ordered'] : [status]);

  const rows = await query;
  return {
    requests: rows.map(r => ({
      id: r.id,
      product: r.product_name,
      category: r.product_category,
      status: r.status,
      priority: r.priority,
      requested_quantity: toNumber(r.requested_quantity),
      unit: r.unit,
      current_stock: toNumber(r.inventory_on_hand),
      inventory_unit: r.inventory_unit,
      vendor: r.vendor || r.best_vendor || null,
      needed_by: r.needed_by,
      reason: r.reason,
      source: r.source,
      created: r.created_at,
    })),
    total: rows.length,
    status_filter: status,
  };
}

async function adjustStock(input) {
  const movementType = input.movement_type;
  if (!['restock', 'correction', 'damaged_lost'].includes(movementType)) {
    return { error: 'movement_type must be restock, correction, or damaged_lost' };
  }
  const qty = toNumber(input.quantity);
  const setTotal = toNumber(input.set_total);
  if (qty == null && setTotal == null) return { error: 'quantity or set_total is required' };
  if (qty != null && setTotal != null) return { error: 'Pass quantity or set_total, not both' };
  if (setTotal != null && movementType !== 'correction') return { error: 'set_total is only valid with movement_type "correction"' };
  if (setTotal != null && setTotal < 0) return { error: 'set_total cannot be negative' };
  if (qty === 0) return { error: 'quantity cannot be zero' };
  if (qty != null && qty < 0 && movementType !== 'correction') {
    return { error: 'quantity must be positive for restock and damaged_lost' };
  }

  const resolved = await resolveProduct(input);
  if (resolved.error) return resolved;
  const { product } = resolved;

  const change = computeStockChange(product, { movementType, qty, setTotal, unit: input.unit });
  if (change.error) return change;

  if (input.confirmed !== true) {
    const threshold = toNumber(product.low_stock_threshold);
    return {
      preview: true,
      tool: 'adjust_stock',
      product: { id: product.id, name: product.name, category: product.category },
      movement_type: movementType,
      was_untracked: toNumber(product.inventory_on_hand) == null,
      stock_before: change.stockBefore,
      change: change.delta,
      stock_after: change.stockAfter,
      unit: change.inventoryUnit,
      ...(change.conversionNote ? { conversion: change.conversionNote } : {}),
      ...(change.stockAfter < 0 ? { warning: 'This takes stock NEGATIVE — double-check the numbers before confirming.' } : {}),
      ...(change.stockAfter >= 0 && threshold != null && change.stockAfter <= threshold
        ? { low_stock_after: true } : {}),
    };
  }

  return db.transaction(async (trx) => {
    const fresh = await trx('products_catalog').where('id', product.id).forUpdate().first();
    if (!fresh) return { error: 'Product not found' };
    const locked = computeStockChange(fresh, { movementType, qty, setTotal, unit: input.unit });
    if (locked.error) return locked;

    await trx('products_catalog').where('id', fresh.id).update({
      inventory_on_hand: locked.stockAfter,
      inventory_unit: locked.inventoryUnit,
      updated_at: new Date(),
    });

    const [movement] = await trx('product_inventory_movements').insert({
      product_id: fresh.id,
      movement_type: movementType,
      quantity: Math.abs(locked.delta),
      unit: locked.inventoryUnit,
      stock_before: locked.stockBefore,
      stock_after: locked.stockAfter,
      lot_number: input.lot_number || null,
      metadata: {
        source: 'intelligence_bar_adjust_stock',
        reason: input.reason || null,
        delta: locked.delta,
        setTotal: setTotal != null ? setTotal : null,
        enteredQuantity: qty != null ? qty : setTotal,
        enteredUnit: locked.enteredUnit,
        conversionConfidence: locked.conversionConfidence,
      },
    }).returning('*');

    return {
      success: true,
      product: { id: fresh.id, name: fresh.name },
      movement_type: movementType,
      stock_before: locked.stockBefore,
      change: locked.delta,
      stock_after: locked.stockAfter,
      unit: locked.inventoryUnit,
      movement_id: movement?.id || null,
    };
  });
}

async function createRestockRequest(input) {
  const qty = toNumber(input.quantity);
  if (qty == null || qty <= 0) return { error: 'quantity must be a positive number' };
  const priority = input.priority || 'normal';
  if (!['low', 'normal', 'high', 'urgent'].includes(priority)) {
    return { error: 'priority must be low, normal, high, or urgent' };
  }
  let neededBy = null;
  if (input.needed_by) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(input.needed_by))) return { error: 'needed_by must be YYYY-MM-DD' };
    neededBy = input.needed_by;
  }

  const resolved = await resolveProduct(input);
  if (resolved.error) return resolved;
  const { product } = resolved;

  const unit = input.unit || product.inventory_unit;
  if (!unit) return { error: 'unit is required — this product has no inventory unit set' };
  if (!unitDefinition(unit)) return { error: `Unsupported unit "${unit}". Supported: fl_oz, gal, qt, pt, ml, l, oz, lb, g, kg` };

  const vendor = input.vendor || product.best_vendor || null;
  const currentStock = toNumber(product.inventory_on_hand);

  if (input.confirmed !== true) {
    return {
      preview: true,
      tool: 'create_restock_request',
      product: { id: product.id, name: product.name, category: product.category },
      requested_quantity: qty,
      unit,
      priority,
      vendor,
      needed_by: neededBy,
      current_stock: currentStock,
      reason: input.reason || null,
    };
  }

  const [request] = await db('product_restock_requests').insert({
    product_id: product.id,
    status: 'open',
    priority,
    requested_quantity: qty,
    unit,
    current_stock: currentStock,
    vendor,
    needed_by: neededBy,
    reason: input.reason || null,
    source: 'intelligence_bar',
    created_by_name: 'Intelligence Bar',
  }).returning('*');

  return {
    success: true,
    request: {
      id: request?.id || null,
      product: product.name,
      status: 'open',
      requested_quantity: qty,
      unit,
      priority,
      vendor,
      needed_by: neededBy,
    },
  };
}

async function updateRestockRequest(input) {
  const action = String(input.action || '').toLowerCase();
  if (!['mark_ordered', 'receive', 'cancel'].includes(action)) {
    return { error: 'action must be mark_ordered, receive, or cancel' };
  }
  if (!input.request_id) return { error: 'request_id is required — get_restock_queue shows the ids' };

  const request = await db('product_restock_requests').where('id', input.request_id).first();
  if (!request) return { error: 'Restock request not found' };
  if (request.status === 'received' || request.status === 'cancelled') {
    return { error: `This request is already ${request.status} — no further actions allowed` };
  }
  const product = await db('products_catalog').where('id', request.product_id).first();
  if (!product) return { error: 'Product for this request not found' };

  let receivePlan = null;
  if (action === 'receive') {
    const qty = toNumber(input.quantity) ?? toNumber(request.requested_quantity);
    const enteredUnit = input.unit || request.unit || product.inventory_unit;
    if (!qty || qty <= 0 || !enteredUnit) return { error: 'Receive quantity and unit are required' };
    const inventoryUnit = product.inventory_unit || enteredUnit;
    const received = describeInventoryConversion(qty, enteredUnit, inventoryUnit);
    if (!received.convertible || received.amount == null) {
      return { error: `Cannot convert receive unit ${enteredUnit} to inventory unit ${inventoryUnit}` };
    }
    const stockBefore = toNumber(product.inventory_on_hand) ?? 0;
    receivePlan = { enteredQuantity: qty, enteredUnit, stockBefore, stockAfter: round4(stockBefore + received.amount), amount: received.amount };
  }

  if (input.confirmed !== true) {
    return {
      preview: true,
      tool: 'update_restock_request',
      request: {
        id: request.id,
        product: product.name,
        status: request.status,
        requested_quantity: toNumber(request.requested_quantity),
        unit: request.unit,
      },
      action,
      new_status: action === 'mark_ordered' ? 'ordered' : action === 'cancel' ? 'cancelled' : 'received',
      ...(receivePlan ? {
        stock_before: receivePlan.stockBefore,
        adds: receivePlan.amount,
        stock_after: receivePlan.stockAfter,
        unit: product.inventory_unit || receivePlan.enteredUnit,
      } : {}),
    };
  }

  const result = await db.transaction(async (trx) => {
    if (action === 'mark_ordered') {
      await trx('product_restock_requests').where('id', request.id).update({ status: 'ordered', updated_at: new Date() });
      return { success: true, request_id: request.id, product: product.name, status: 'ordered' };
    }
    if (action === 'cancel') {
      await trx('product_restock_requests').where('id', request.id).update({
        status: 'cancelled', closed_at: new Date(), updated_at: new Date(),
      });
      return { success: true, request_id: request.id, product: product.name, status: 'cancelled' };
    }

    // receive — recompute against the locked product row, never the preview
    const fresh = await trx('products_catalog').where('id', request.product_id).forUpdate().first();
    if (!fresh) return { error: 'Product not found' };
    const inventoryUnit = fresh.inventory_unit || receivePlan.enteredUnit;
    const received = describeInventoryConversion(receivePlan.enteredQuantity, receivePlan.enteredUnit, inventoryUnit);
    if (!received.convertible || received.amount == null) {
      return { error: `Cannot convert receive unit ${receivePlan.enteredUnit} to inventory unit ${inventoryUnit}` };
    }
    const stockBefore = toNumber(fresh.inventory_on_hand) ?? 0;
    const stockAfter = round4(stockBefore + received.amount);

    await trx('products_catalog').where('id', fresh.id).update({
      inventory_on_hand: stockAfter,
      inventory_unit: inventoryUnit,
      updated_at: new Date(),
    });
    const [movement] = await trx('product_inventory_movements').insert({
      product_id: fresh.id,
      movement_type: 'restock',
      quantity: received.amount,
      unit: inventoryUnit,
      stock_before: stockBefore,
      stock_after: stockAfter,
      metadata: {
        source: 'intelligence_bar_restock_receive',
        restockRequestId: request.id,
        note: input.note || null,
        enteredQuantity: receivePlan.enteredQuantity,
        enteredUnit: receivePlan.enteredUnit,
        conversionConfidence: received.confidence,
      },
    }).returning('*');
    await trx('product_restock_requests').where('id', request.id).update({
      status: 'received', closed_at: new Date(), updated_at: new Date(),
    });

    return {
      success: true,
      request_id: request.id,
      product: fresh.name,
      status: 'received',
      stock_before: stockBefore,
      added: received.amount,
      stock_after: stockAfter,
      unit: inventoryUnit,
      movement_id: movement?.id || null,
    };
  });

  if (result.success && action === 'receive') {
    // Same WaveGuard-readiness recheck the admin receive endpoint runs —
    // non-fatal, the stock is already committed.
    try {
      const adminInventoryRoute = require('../../routes/admin-inventory');
      if (typeof adminInventoryRoute.syncLawnReadinessAfterRestock === 'function') {
        result.readiness_recheck = await adminInventoryRoute.syncLawnReadinessAfterRestock();
      }
    } catch (recheckErr) {
      logger.warn(`[intelligence-bar:procurement] restock readiness recheck failed: ${recheckErr.message}`);
      result.readiness_recheck = { error: recheckErr.message };
    }
  }
  return result;
}

module.exports = { PROCUREMENT_TOOLS, executeProcurementTool };
