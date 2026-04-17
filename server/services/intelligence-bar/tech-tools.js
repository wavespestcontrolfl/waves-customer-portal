/**
 * Intelligence Bar — Tech Field Tools
 * server/services/intelligence-bar/tech-tools.js
 *
 * Read-only tools for field technicians. No bulk updates, no cancellations,
 * no pricing changes. Just the data a tech needs mid-route.
 */

const db = require('../../models/db');
const logger = require('../logger');
const { etDateString } = require('../../utils/datetime-et');

const TECH_TOOLS = [
  {
    name: 'get_my_route',
    description: `Get the tech's route for today or a specific date. Shows stops in order with customer names, addresses, service types, time windows, and status.
Use for: "what's my route today?", "how many stops do I have left?", "what's next?"`,
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD (default today)' },
      },
    },
  },
  {
    name: 'get_stop_details',
    description: `Get full details for a specific stop: customer info, property details, service history at this property, special notes, products used last time, gate codes, pet warnings.
Use for: "tell me about my next stop", "any notes for the Henderson property?", "what did we do there last time?"`,
    input_schema: {
      type: 'object',
      properties: {
        customer_name: { type: 'string', description: 'Customer name (partial match OK)' },
        customer_id: { type: 'string' },
        service_id: { type: 'string', description: 'Scheduled service ID' },
      },
    },
  },
  {
    name: 'get_service_history',
    description: `Get service history for a customer. Shows past services with dates, types, technician notes, products used.
Use for: "what products did we use on the Henderson property last time?", "service history for this customer", "when was their last pest treatment?"`,
    input_schema: {
      type: 'object',
      properties: {
        customer_name: { type: 'string' },
        customer_id: { type: 'string' },
        service_type: { type: 'string', description: 'Filter by type (pest, lawn, mosquito, etc.)' },
        limit: { type: 'number', description: 'How many records (default 5)' },
      },
    },
  },
  {
    name: 'get_product_info',
    description: `Look up product information: active ingredient, MOA group, label rate, mixing instructions, target pests, safety notes.
Use for: "what's the label rate for Demand CS?", "mixing ratio for Bifen IT", "what MOA group is Celsius?"`,
    input_schema: {
      type: 'object',
      properties: {
        product_name: { type: 'string' },
      },
      required: ['product_name'],
    },
  },
  {
    name: 'get_protocol',
    description: `Get the treatment protocol for a service type. Shows which products to use, application rates, order of operations, and seasonal adjustments.
Use for: "what's the protocol for quarterly pest?", "lawn care protocol for St. Augustine?", "mosquito barrier treatment steps"`,
    input_schema: {
      type: 'object',
      properties: {
        service_type: { type: 'string', description: 'pest, lawn, mosquito, termite, tree_shrub, rodent' },
        lawn_track: { type: 'string', description: 'For lawn care: A, B, C1, C2, D (grass type tracks)' },
      },
      required: ['service_type'],
    },
  },
  {
    name: 'check_customer_status',
    description: `Quick status check on a customer: tier, balance owed, last service, next service, health score, any notes/flags.
Use for: "is this customer current on payments?", "what tier is Henderson?", "any flags on this account?"`,
    input_schema: {
      type: 'object',
      properties: {
        customer_name: { type: 'string' },
        customer_id: { type: 'string' },
      },
    },
  },
  {
    name: 'search_knowledge_base',
    description: `Search the pest/lawn knowledge base for treatment advice, pest identification, or SWFL-specific guidance.
Use for: "how do I treat chinch bugs in St. Augustine?", "what causes brown patch in Bermuda?", "fire ant mound treatment protocol"`,
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_weather_conditions',
    description: `Get current weather for the service area. Shows temp, wind, rain probability — relevant for spray decisions.
Use for: "should I spray today?", "what's the wind like?", "rain probability?"`,
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
];


// ─── EXECUTION ──────────────────────────────────────────────────

async function executeTechTool(toolName, input, techContext) {
  try {
    switch (toolName) {
      case 'get_my_route': return await getMyRoute(techContext.techId, techContext.techName, input.date);
      case 'get_stop_details': return await getStopDetails(input);
      case 'get_service_history': return await getServiceHistory(input);
      case 'get_product_info': return await getProductInfo(input.product_name);
      case 'get_protocol': return await getProtocol(input);
      case 'check_customer_status': return await checkCustomerStatus(input);
      case 'search_knowledge_base': return await searchKnowledgeBase(input.query);
      case 'get_weather_conditions': return await getWeatherConditions();
      default: return { error: `Unknown tech tool: ${toolName}` };
    }
  } catch (err) {
    logger.error(`[intelligence-bar:tech] Tool ${toolName} failed:`, err);
    return { error: err.message };
  }
}


// ─── IMPLEMENTATIONS ────────────────────────────────────────────

async function getMyRoute(techId, techName, date) {
  const d = date || etDateString();

  let query = db('scheduled_services')
    .where({ 'scheduled_services.scheduled_date': d })
    .whereNotIn('scheduled_services.status', ['cancelled'])
    .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
    .select(
      'scheduled_services.id', 'scheduled_services.service_type', 'scheduled_services.status',
      'scheduled_services.window_start', 'scheduled_services.window_end',
      'scheduled_services.route_order', 'scheduled_services.notes',
      'customers.id as customer_id', 'customers.first_name', 'customers.last_name',
      'customers.address_line1', 'customers.city', 'customers.state', 'customers.zip',
      'customers.phone', 'customers.waveguard_tier', 'customers.lawn_type',
    )
    .orderByRaw('COALESCE(route_order, 999), window_start');

  // Filter to this tech if we have their ID
  if (techId) {
    query = query.where('scheduled_services.technician_id', techId);
  } else if (techName) {
    query = query.leftJoin('technicians', 'scheduled_services.technician_id', 'technicians.id')
      .whereILike('technicians.name', `%${techName}%`);
  }

  const stops = await query;
  const completed = stops.filter(s => s.status === 'completed').length;
  const nextStop = stops.find(s => s.status !== 'completed');

  return {
    date: d,
    total_stops: stops.length,
    completed,
    remaining: stops.length - completed,
    next_stop: nextStop ? {
      id: nextStop.id,
      customer: `${nextStop.first_name} ${nextStop.last_name}`,
      address: `${nextStop.address_line1}, ${nextStop.city}, ${nextStop.state} ${nextStop.zip}`,
      service_type: nextStop.service_type,
      time_window: nextStop.window_start || null,
      notes: nextStop.notes,
      tier: nextStop.waveguard_tier,
      phone: nextStop.phone,
    } : null,
    stops: stops.map((s, i) => ({
      order: s.route_order || i + 1,
      id: s.id,
      customer_id: s.customer_id,
      customer: `${s.first_name} ${s.last_name}`,
      address: `${s.address_line1}, ${s.city}`,
      service_type: s.service_type,
      status: s.status,
      time_window: s.window_start || null,
      tier: s.waveguard_tier,
      notes: s.notes,
    })),
  };
}


async function getStopDetails(input) {
  let customer;
  if (input.customer_id) {
    customer = await db('customers').where('id', input.customer_id).first();
  } else if (input.customer_name) {
    customer = await db('customers').where(function () {
      const s = `%${input.customer_name}%`;
      this.whereILike('first_name', s).orWhereILike('last_name', s)
        .orWhereRaw("first_name || ' ' || last_name ILIKE ?", [s]);
    }).first();
  } else if (input.service_id) {
    const svc = await db('scheduled_services').where('id', input.service_id).first();
    if (svc) customer = await db('customers').where('id', svc.customer_id).first();
  }

  if (!customer) return { error: 'Customer not found' };

  // Property preferences
  const prefs = await db('property_preferences').where({ customer_id: customer.id }).first();

  // Last 3 services
  const history = await db('service_records')
    .where({ customer_id: customer.id, status: 'completed' })
    .orderBy('service_date', 'desc').limit(3)
    .select('service_date', 'service_type', 'notes', 'products_used', 'technician_name');

  // Today's scheduled service
  const today = etDateString();
  const todayService = await db('scheduled_services')
    .where({ customer_id: customer.id, scheduled_date: today })
    .whereNotIn('status', ['cancelled']).first();

  return {
    customer: {
      name: `${customer.first_name} ${customer.last_name}`,
      phone: customer.phone,
      address: `${customer.address_line1}, ${customer.city}, ${customer.state} ${customer.zip}`,
      tier: customer.waveguard_tier,
      lawn_type: customer.lawn_type,
      property_sqft: customer.property_sqft,
      lot_sqft: customer.lot_sqft,
      notes: customer.notes,
    },
    property: prefs ? {
      gate_code: prefs.gate_code,
      pet_warning: prefs.pets,
      access_notes: prefs.access_notes,
      special_instructions: prefs.special_instructions,
      irrigation_day: prefs.irrigation_day,
    } : null,
    todays_service: todayService ? {
      id: todayService.id,
      service_type: todayService.service_type,
      notes: todayService.notes,
      time_window: todayService.window_start,
    } : null,
    recent_history: history.map(h => ({
      date: h.service_date,
      type: h.service_type,
      notes: h.notes,
      products: typeof h.products_used === 'string' ? JSON.parse(h.products_used || '[]') : (h.products_used || []),
      tech: h.technician_name,
    })),
  };
}


async function getServiceHistory(input) {
  const { customer_name, customer_id, service_type, limit: rawLimit } = input;
  const limit = Math.min(rawLimit || 5, 20);

  let customer;
  if (customer_id) {
    customer = await db('customers').where('id', customer_id).first();
  } else if (customer_name) {
    customer = await db('customers').where(function () {
      const s = `%${customer_name}%`;
      this.whereILike('first_name', s).orWhereILike('last_name', s)
        .orWhereRaw("first_name || ' ' || last_name ILIKE ?", [s]);
    }).first();
  }
  if (!customer) return { error: 'Customer not found' };

  let query = db('service_records').where({ customer_id: customer.id, status: 'completed' })
    .orderBy('service_date', 'desc').limit(limit);

  if (service_type) query = query.whereILike('service_type', `%${service_type}%`);

  const records = await query;

  return {
    customer: `${customer.first_name} ${customer.last_name}`,
    services: records.map(r => ({
      date: r.service_date,
      type: r.service_type,
      tech: r.technician_name,
      notes: r.notes,
      products: typeof r.products_used === 'string' ? JSON.parse(r.products_used || '[]') : (r.products_used || []),
      duration: r.labor_hours ? `${(parseFloat(r.labor_hours) * 60).toFixed(0)} min` : null,
    })),
    total_records: records.length,
  };
}


async function getProductInfo(productName) {
  const product = await db('products_catalog').whereILike('name', `%${productName}%`).first();
  if (!product) return { error: `Product "${productName}" not found` };

  return {
    name: product.name,
    category: product.category,
    active_ingredient: product.active_ingredient,
    moa_group: product.moa_group,
    formulation: product.formulation,
    container_size: product.container_size,
    default_rate: product.default_rate,
    default_unit: product.default_unit,
    sku: product.sku,
  };
}


async function getProtocol(input) {
  const { service_type, lawn_track } = input;

  try {
    const protocols = require('../../config/protocols.json');

    if (service_type === 'lawn' || service_type === 'lawn_care') {
      const track = lawn_track || 'A';
      if (protocols.lawn && protocols.lawn[track]) {
        return { protocol: protocols.lawn[track], track, type: 'lawn_care' };
      }
      return { available_tracks: Object.keys(protocols.lawn || {}), note: 'Specify a track: A (St. Augustine), B (Bermuda), C1 (Zoysia), C2 (Bahia), D (Mixed)' };
    }

    if (service_type === 'tree_shrub' || service_type === 'tree') {
      return { protocol: protocols.tree_shrub, type: 'tree_shrub' };
    }

    // For other service types, return general guidance
    return {
      type: service_type,
      note: `Specific protocol for "${service_type}" not found in protocols.json. Check the knowledge base for treatment guidance.`,
    };
  } catch {
    return { error: 'Protocols config not available' };
  }
}


async function checkCustomerStatus(input) {
  const { customer_name, customer_id } = input;

  let customer;
  if (customer_id) {
    customer = await db('customers').where('id', customer_id).first();
  } else if (customer_name) {
    customer = await db('customers').where(function () {
      const s = `%${customer_name}%`;
      this.whereILike('first_name', s).orWhereILike('last_name', s)
        .orWhereRaw("first_name || ' ' || last_name ILIKE ?", [s]);
    }).first();
  }
  if (!customer) return { error: 'Customer not found' };

  const balance = await db('invoices')
    .where({ customer_id: customer.id })
    .whereIn('status', ['sent', 'viewed', 'overdue'])
    .sum('total as owed').first();

  const health = await db('customer_health_scores')
    .where({ customer_id: customer.id })
    .orderBy('created_at', 'desc').first();

  const lastService = await db('service_records')
    .where({ customer_id: customer.id, status: 'completed' })
    .orderBy('service_date', 'desc').first();

  return {
    name: `${customer.first_name} ${customer.last_name}`,
    tier: customer.waveguard_tier || 'None',
    active: customer.active,
    balance_owed: parseFloat(balance?.owed || 0),
    health_score: health?.overall_score || null,
    churn_risk: health?.churn_risk || null,
    last_service: lastService ? { date: lastService.service_date, type: lastService.service_type } : null,
    member_since: customer.member_since,
    notes: customer.notes,
  };
}


async function searchKnowledgeBase(query) {
  // Full-text search on the wiki/knowledge base tables
  try {
    const results = await db('wiki_articles')
      .whereRaw("to_tsvector('english', title || ' ' || COALESCE(content, '')) @@ plainto_tsquery('english', ?)", [query])
      .select('id', 'title', 'category', db.raw("LEFT(content, 300) as snippet"))
      .limit(5);

    if (results.length > 0) {
      return { results: results.map(r => ({ title: r.title, category: r.category, snippet: r.snippet })) };
    }

    // Fallback to ILIKE search
    const fallback = await db('wiki_articles')
      .where(function () {
        this.whereILike('title', `%${query}%`).orWhereILike('content', `%${query}%`);
      })
      .select('id', 'title', 'category', db.raw("LEFT(content, 300) as snippet"))
      .limit(5);

    return { results: fallback.map(r => ({ title: r.title, category: r.category, snippet: r.snippet })), search_method: 'fallback' };
  } catch {
    return { results: [], note: 'Knowledge base search unavailable' };
  }
}


async function getWeatherConditions() {
  try {
    const res = await fetch('https://api.open-meteo.com/v1/forecast?latitude=27.40&longitude=-82.40&current=temperature_2m,wind_speed_10m,wind_gusts_10m,precipitation_probability,weather_code&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=America/New_York');
    if (!res.ok) return { error: 'Weather API unavailable' };
    const data = await res.json();
    const c = data.current || {};

    const windOk = (c.wind_speed_10m || 0) < 15;
    const rainOk = (c.precipitation_probability || 0) < 40;

    return {
      temperature: Math.round(c.temperature_2m || 0),
      wind_speed: Math.round(c.wind_speed_10m || 0),
      wind_gusts: Math.round(c.wind_gusts_10m || 0),
      rain_probability: c.precipitation_probability || 0,
      spray_conditions: windOk && rainOk ? 'good' : !windOk ? 'too_windy' : 'rain_likely',
      recommendation: windOk && rainOk
        ? 'Good spray conditions. Proceed normally.'
        : !windOk
          ? `Wind at ${Math.round(c.wind_speed_10m)}mph — consider delaying liquid applications or switching to granular.`
          : `${c.precipitation_probability}% rain chance — check timing. Avoid spraying if rain expected within 2 hours.`,
    };
  } catch {
    return { error: 'Could not fetch weather' };
  }
}


module.exports = { TECH_TOOLS, executeTechTool };
