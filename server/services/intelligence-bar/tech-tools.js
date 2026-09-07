/**
 * Intelligence Bar — Tech Field Tools
 * server/services/intelligence-bar/tech-tools.js
 *
 * Read-only tools for field technicians. No bulk updates, no cancellations,
 * no pricing changes. Just the data a tech needs mid-route.
 */

const db = require('../../models/db');
const logger = require('../logger');
const { etDateString, addETDays } = require('../../utils/datetime-et');
const { effectiveServiceAddress } = require('../stamped-address');
const { TERMINAL_APPOINTMENT_STATUSES } = require('./proposal-pins');
const { formatAddress } = require('../../utils/address-normalizer');
const { getProtocol: readProtocol } = require('../protocol-reader');
const { openInvoiceFacts } = require('../visit-context/balance');

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
        service_type: { type: 'string', description: 'pest, lawn, mosquito, termite, tree_shrub, rodent, palm_injection, cockroach, or bed_bug' },
        lawn_track: { type: 'string', description: 'For lawn: st_augustine, bermuda, zoysia, bahia (legacy A/B, C1, C2, D are accepted)' },
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

// A technician may only read customers on their OWN CURRENT route. Admin/
// unscoped callers (no techId) are unrestricted. Customer-reading tech tools
// take a customer_id/name straight from the caller, so without this a
// technician could enumerate any customer's address, CRM notes, and gate/
// lockbox codes. This is the canonical current-assignment policy from
// admin-customers.js (PR #2847): a real assignment must be non-terminal and
// dated within the ET access window — a cancelled visit or a years-old
// completion never authorizes access.
const TECH_ACCESS_DEAD_STATUSES = ['cancelled', 'canceled', 'rescheduled', 'skipped', 'no_show'];
const TECH_ACCESS_WINDOW_DAYS = 7;

// The customer_ids currently on this technician's route: a non-terminal
// scheduled visit dated within the ET access window. Bounded by the tech's
// route (~dozens), so it is safe to constrain the customer lookup with it.
async function assignedCustomerIds(techId) {
  const cutoff = etDateString(addETDays(new Date(), -TECH_ACCESS_WINDOW_DAYS));
  const rows = await db('scheduled_services')
    .distinct('customer_id')
    .where('technician_id', techId)
    .whereNotIn('status', TECH_ACCESS_DEAD_STATUSES)
    .where('scheduled_date', '>=', cutoff);
  return rows.map((r) => r.customer_id);
}

// Resolve the customer a tech tool is asking about, returning one only if the
// caller is authorized to read it. The assignment constraint is applied IN SQL
// (whereIn the technician's assigned ids) with a LIMIT-1 .first(), so a caller-
// controlled name wildcard can't load the whole customers table and a name that
// matches several customers still resolves to the technician's own. Admin/
// unscoped callers (no techId) are unrestricted. Returns null → generic
// "not found".
async function resolveAuthorizedCustomer(input, techId) {
  let ids = null;
  if (techId) {
    ids = await assignedCustomerIds(techId);
    if (ids.length === 0) return null;
  }
  const scoped = (q) => (techId ? q.whereIn('id', ids) : q);

  if (input.customer_id) {
    return (await scoped(db('customers').where('id', input.customer_id)).first()) || null;
  }
  if (input.customer_name) {
    const s = `%${input.customer_name}%`;
    return (await scoped(db('customers').where(function () {
      this.whereILike('first_name', s).orWhereILike('last_name', s)
        .orWhereRaw("TRIM(first_name || ' ' || COALESCE(last_name, '')) ILIKE ?", [s]);
    })).first()) || null;
  }
  if (input.service_id) {
    const svc = await db('scheduled_services').where('id', input.service_id).first();
    if (!svc) return null;
    return (await scoped(db('customers').where('id', svc.customer_id)).first()) || null;
  }
  return null;
}

async function executeTechTool(toolName, input, techContext) {
  try {
    const techId = techContext?.techId || null;
    switch (toolName) {
      case 'get_my_route': return await getMyRoute(techContext.techId, techContext.techName, input.date);
      case 'get_stop_details': return await getStopDetails(input, techId);
      case 'get_service_history': return await getServiceHistory(input, techId);
      case 'get_product_info': return await getProductInfo(input.product_name);
      case 'get_protocol': return await getProtocol(input);
      case 'check_customer_status': return await checkCustomerStatus(input, techId);
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
      'customers.address_line1', 'customers.address_line2', 'customers.city', 'customers.state', 'customers.zip',
      'scheduled_services.service_address_line1', 'scheduled_services.service_address_line2',
      'scheduled_services.service_address_city', 'scheduled_services.service_address_state', 'scheduled_services.service_address_zip',
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
  const remainingStops = stops.filter(s => !TERMINAL_APPOINTMENT_STATUSES.includes(s.status));
  const nextStop = remainingStops[0];

  return {
    date: d,
    total_stops: stops.length,
    completed,
    remaining: remainingStops.length,
    next_stop: nextStop ? {
      id: nextStop.id,
      customer: `${nextStop.first_name} ${nextStop.last_name}`,
      address: formatAddress(effectiveServiceAddress(nextStop, nextStop)),
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
      address: formatAddress(effectiveServiceAddress(s, s)),
      service_type: s.service_type,
      status: s.status,
      time_window: s.window_start || null,
      tier: s.waveguard_tier,
      notes: s.notes,
    })),
  };
}


async function getStopDetails(input, techId = null) {
  // Resolves only a customer this technician is authorized to read; an
  // unauthorized or missing match both return the generic not-found below so a
  // technician can't probe for customers assigned to someone else.
  const customer = await resolveAuthorizedCustomer(input, techId);
  if (!customer) return { error: 'Customer not found' };

  // Last 3 services
  const history = await db('service_records')
    .where({ customer_id: customer.id, status: 'completed' })
    .orderBy('service_date', 'desc').limit(3)
    .select('service_date', 'service_type', 'notes', 'products_used', 'technician_name');

  // Today's scheduled service — tech callers see only THEIR visit for this
  // customer (the same-day row can belong to another technician); admin/
  // unscoped callers (no techId) stay unrestricted.
  const today = etDateString();
  // Dead rows (rescheduled/skipped/no-show/canceled) are not a live visit —
  // they must neither display as today's service nor release access codes.
  const todayQuery = db('scheduled_services')
    .where({ customer_id: customer.id, scheduled_date: today })
    .whereNotIn('status', TECH_ACCESS_DEAD_STATUSES);
  if (techId) todayQuery.where('technician_id', techId);
  // A caller asking about a SPECIFIC stop gets that stop — with several
  // live services today an unordered .first() could ground the answer
  // (facts, notes, alerts) in a sibling service.
  if (input.service_id) todayQuery.where('id', input.service_id);
  const todayService = await todayQuery.first();
  let addressService = todayService;
  if (input.service_id && !addressService) {
    const requested = db('scheduled_services').where({ id: input.service_id, customer_id: customer.id })
      .whereNotIn('status', TECH_ACCESS_DEAD_STATUSES);
    if (techId) requested.where('technician_id', techId);
    addressService = await requested.first();
    if (!addressService) return { error: 'Customer not found' };
  }


  // Access/property facts follow the same GATE_VISIT_FACTS policy as the
  // visit brief (GET /:id/visit-brief): gate on, the shared fail-soft access
  // block is the source and codes ride a PER-VISIT answer — no live visit
  // today, no codes. The raw property_preferences dump below (gate off)
  // predates the gate and bypassed it.
  let property = null;
  const PrevisitBrief = require('../previsit-brief');
  if (PrevisitBrief.visitFactsGateEnabled()) {
    if (todayService) {
      let facts = null;
      try {
        facts = await PrevisitBrief.deterministicVisitFacts(todayService);
      } catch { facts = null; }
      // Re-verify the assignment AFTER the facts queries (same race the
      // visit-brief route closes, Codex P1 on #3638): they run outside
      // the scoped fetch above, so a dispatch reassignment during them
      // would otherwise hand the stale authorized snapshot to the former
      // technician. Ownership KNOWN lost mid-request → withhold the WHOLE
      // answer (customer, notes, history), not just the codes — same as
      // the visit-brief route's post-facts recheck, and INDEPENDENT of
      // whether the facts read succeeded (a facts failure must not skip
      // the only post-read ownership check). A facts FAILURE with
      // ownership intact stays fail-soft: property null, rest intact.
      // Admin callers (no techId) skip the recheck.
      if (techId) {
        const stillOwned = !!(await db('scheduled_services')
          .where({
            id: todayService.id,
            technician_id: techId,
            customer_id: customer.id,
            scheduled_date: today,
          })
          .whereNotIn('status', TECH_ACCESS_DEAD_STATUSES)
          .first('id'));
        if (!stillOwned) return { error: 'Customer not found' };
      }
      property = facts ? facts.access : null;
    }
  } else {
    const prefs = await db('property_preferences').where({ customer_id: customer.id }).first();
    property = prefs ? {
      neighborhood_gate_code: prefs.neighborhood_gate_code,
      property_gate_code: prefs.property_gate_code,
      garage_code: prefs.garage_code,
      lockbox_code: prefs.lockbox_code,
      parking_notes: prefs.parking_notes,
      side_gate_access: prefs.side_gate_access,
      access_notes: prefs.access_notes,
      pet_count: prefs.pet_count,
      pet_details: prefs.pet_details,
      pets_secured_plan: prefs.pets_secured_plan,
      special_instructions: prefs.special_instructions,
    } : null;
  }

  return {
    customer: {
      name: `${customer.first_name} ${customer.last_name}`,
      phone: customer.phone,
      address: formatAddress(effectiveServiceAddress(addressService || {}, customer)),
      tier: customer.waveguard_tier,
      lawn_type: customer.lawn_type,
      property_sqft: customer.property_sqft,
      lot_sqft: customer.lot_sqft,
      notes: customer.crm_notes,
    },
    property,
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


async function getServiceHistory(input, techId = null) {
  const { service_type, limit: rawLimit } = input;
  const limit = Math.min(rawLimit || 5, 20);

  const customer = await resolveAuthorizedCustomer(input, techId);
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

  // Label/SDS-derived safety fields so the model states grounded PPE / re-entry
  // instead of recalling them from training memory. Null fields are omitted so
  // the model doesn't read a blank as "none required".
  const safety = {
    signal_word: product.signal_word || undefined,
    ppe: product.ppe_text || undefined,
    reentry: product.reentry_text || product.reentry_summary || undefined,
    // Only surface a positive REI as a number. rei_hours = 0 is the residential
    // "until sprays have dried" value, NOT "0 hours" — exposing the bare 0 to the
    // model would read as an immediate re-entry. The until-dry meaning is carried
    // by `reentry` text instead.
    rei_hours: product.rei_hours > 0 ? product.rei_hours : undefined,
    rainfast_minutes: product.rainfast_minutes != null ? product.rainfast_minutes : undefined,
    // irrigation_required records only whether watering-in is REQUIRED. A false
    // value means "not required" — NOT "prohibited" (many liquid fertilizers are
    // seeded false yet benefit from watering in). Never turn it into a do-not-
    // water instruction the label doesn't back; the customer report path makes
    // the same call. irrigation_notes carries any real label nuance.
    watering_in: product.irrigation_required === true
      ? 'Water in after application'
      : (product.irrigation_notes
          ? String(product.irrigation_notes)
          : (product.irrigation_required === false
              ? 'Watering-in not required per the label'
              : undefined)),
    epa_reg_number: product.epa_reg_number || product.epa_registration_number || undefined,
    label_url: product.label_url || undefined,
    sds_url: product.sds_url || undefined,
  };

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
    safety,
  };
}


async function getProtocol(input) {
  try {
    return readProtocol(input);
  } catch {
    return { error: 'Protocols config not available' };
  }
}


async function checkCustomerStatus(input, techId = null) {
  const customer = await resolveAuthorizedCustomer(input, techId);
  if (!customer) return { error: 'Customer not found' };

  // Shared feed-grade balance (visit-context/balance.js). The previous inline
  // query omitted the payer_id exclusion, so third-party-billed AR showed up
  // here as the homeowner's balance.
  const openInvoices = await openInvoiceFacts(customer.id, { db });

  const health = await db('customer_health_scores')
    .where({ customer_id: customer.id })
    .orderByRaw('scored_at DESC NULLS LAST, created_at DESC').first();

  const lastService = await db('service_records')
    .where({ customer_id: customer.id, status: 'completed' })
    .orderBy('service_date', 'desc').first();

  return {
    name: `${customer.first_name} ${customer.last_name}`,
    tier: customer.waveguard_tier || 'None',
    active: customer.active,
    balance_owed: openInvoices.balance,
    health_score: health?.overall_score || null,
    churn_risk: health?.churn_risk || null,
    last_service: lastService ? { date: lastService.service_date, type: lastService.service_type } : null,
    member_since: customer.member_since,
    notes: customer.crm_notes,
  };
}


async function searchKnowledgeBase(query) {
  // Trusted knowledge only — same gate the admin field-intelligence tool
  // uses, so red wiki pages awaiting review never reach a tech answer.
  try {
    const KnowledgeBridge = require('../knowledge-bridge');
    const { claudeopedia, wiki } = await KnowledgeBridge.unifiedSearch(query, { limit: 5, trustedOnly: true });

    // unifiedSearch returns metadata only — attach snippets.
    const kbIds = (claudeopedia || []).map((r) => r.id).filter(Boolean);
    const kbSnippets = kbIds.length
      ? await db('knowledge_base').whereIn('id', kbIds).select('id', db.raw('LEFT(content, 300) as snippet'))
      : [];
    const kbSnippetById = Object.fromEntries(kbSnippets.map((r) => [r.id, r.snippet]));

    const wikiIds = (wiki || []).map((r) => r.id).filter(Boolean);
    const wikiRows = wikiIds.length
      ? await db('knowledge_entries').whereIn('id', wikiIds).select('id', 'summary', db.raw('LEFT(content, 300) as snippet'))
      : [];
    const wikiById = Object.fromEntries(wikiRows.map((r) => [r.id, r]));

    // Interleave the two corpora (wiki first — field outcomes lead, matching
    // the admin tool's presentation) so a populated KB can never push every
    // wiki hit past the cap, and vice versa.
    const wikiResults = (wiki || []).map((r) => ({ title: r.title, category: r.category, snippet: wikiById[r.id]?.summary || wikiById[r.id]?.snippet || null }));
    const kbResults = (claudeopedia || []).map((r) => ({ title: r.title, category: r.category, snippet: kbSnippetById[r.id] || null }));
    const results = [];
    for (let i = 0; results.length < 5 && (i < wikiResults.length || i < kbResults.length); i++) {
      if (i < wikiResults.length) results.push(wikiResults[i]);
      if (results.length < 5 && i < kbResults.length) results.push(kbResults[i]);
    }

    return { results };
  } catch {
    return { results: [], note: 'Knowledge base search unavailable' };
  }
}


async function getWeatherConditions() {
  try {
    // Hard 6s budget: a hanging weather API must degrade to the error shape,
    // not dangle the tool — in the field that hang is a tech staring at a
    // spinner, and in CI it blows the contract smoke's 10s budget and reds
    // the whole server check (2026-08-01).
    const res = await fetch('https://api.open-meteo.com/v1/forecast?latitude=27.40&longitude=-82.40&current=temperature_2m,wind_speed_10m,wind_gusts_10m,precipitation_probability,weather_code&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=America/New_York', {
      signal: AbortSignal.timeout(6000),
    });
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
