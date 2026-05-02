/**
 * Intelligence Bar — Claude Tool Definitions & Execution
 * server/services/intelligence-bar/tools.js
 *
 * These tools give Claude direct read/write access to the Waves database
 * for natural-language admin queries. Claude picks the right tool(s)
 * based on the operator's prompt.
 */

const db = require('../../models/db');
const logger = require('../logger');
const { etDateString, addETDays } = require('../../utils/datetime-et');

// ─── TOOL DEFINITIONS (Anthropic format) ────────────────────────

const TOOLS = [
  // ── READ TOOLS ──────────────────────────────────────────────
  {
    name: 'query_customers',
    description: `Search/filter the customer database. Returns matching customers with key fields.
Use for: finding customers by attribute, missing data, filtering by city/tier/stage/tags/service type.
Supports SQL-like conditions via the filters parameter.`,
    input_schema: {
      type: 'object',
      properties: {
        filters: {
          type: 'object',
          description: 'Key-value filters. Keys: city, state, zip, tier (waveguard_tier), stage (pipeline_stage), lead_source, active (boolean), has_email (boolean), has_city (boolean), has_phone (boolean), has_address (boolean), service_type (string to match in service_records), tag (string). Use null_city, null_email, null_phone, null_address for missing data queries.',
          properties: {
            city: { type: 'string' },
            state: { type: 'string' },
            zip: { type: 'string' },
            tier: { type: 'string', enum: ['Bronze', 'Silver', 'Gold', 'Platinum', 'none'] },
            stage: { type: 'string' },
            lead_source: { type: 'string' },
            active: { type: 'boolean' },
            null_city: { type: 'boolean', description: 'true = customers with no city set' },
            null_email: { type: 'boolean', description: 'true = customers with no email set' },
            null_phone: { type: 'boolean', description: 'true = customers with no phone set' },
            null_address: { type: 'boolean', description: 'true = customers with no address set' },
            service_type: { type: 'string', description: 'Filter to customers who have this service type in their records (e.g. pest, lawn, mosquito, termite, tree)' },
            tag: { type: 'string' },
            min_health_score: { type: 'number' },
            max_health_score: { type: 'number' },
            min_monthly_rate: { type: 'number' },
            max_monthly_rate: { type: 'number' },
          },
        },
        search: { type: 'string', description: 'Free-text search across name, phone, email, address, company' },
        sort_by: { type: 'string', enum: ['name', 'city', 'monthly_rate', 'lead_score', 'last_service_date', 'health_score', 'lifetime_revenue', 'member_since'] },
        sort_dir: { type: 'string', enum: ['asc', 'desc'] },
        limit: { type: 'number', description: 'Max results (default 50, max 200)' },
      },
    },
  },
  {
    name: 'find_overdue_customers',
    description: `Find customers who are overdue for service based on their expected frequency.
service_category: "pest" (quarterly = 90 days), "lawn" (monthly = 30 days), "mosquito" (21 days), "tree_shrub" (quarterly), "termite" (annual).
overdue_days: how many days past their expected service date to flag (e.g. 0 = due now, 30 = a month overdue).
Only returns active customers with prior service history in that category.`,
    input_schema: {
      type: 'object',
      properties: {
        service_category: { type: 'string', enum: ['pest', 'lawn', 'mosquito', 'tree_shrub', 'termite', 'all'] },
        overdue_days: { type: 'number', description: 'Minimum days overdue (default 0)' },
        limit: { type: 'number' },
      },
      required: ['service_category'],
    },
  },
  {
    name: 'get_customer_detail',
    description: 'Get full detail for one customer: profile, service history, upcoming services, billing, health score, tags, notes.',
    input_schema: {
      type: 'object',
      properties: {
        customer_id: { type: 'string', description: 'Customer UUID' },
      },
      required: ['customer_id'],
    },
  },
  {
    name: 'get_schedule_view',
    description: 'Get the schedule for a date or date range. Optionally filter by technician or zone/city.',
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD (single day)' },
        date_from: { type: 'string', description: 'YYYY-MM-DD start of range' },
        date_to: { type: 'string', description: 'YYYY-MM-DD end of range' },
        technician_name: { type: 'string', description: 'Filter by tech name (e.g. Adam, Jose, Jacob)' },
        city: { type: 'string', description: 'Filter by customer city/zone' },
      },
    },
  },
  {
    name: 'query_revenue',
    description: 'Query revenue and billing data. Can filter by date range, customer, status.',
    input_schema: {
      type: 'object',
      properties: {
        date_from: { type: 'string' },
        date_to: { type: 'string' },
        customer_id: { type: 'string' },
        status: { type: 'string', enum: ['paid', 'sent', 'viewed', 'overdue', 'all'] },
        group_by: { type: 'string', enum: ['customer', 'month', 'service_type', 'none'] },
      },
    },
  },
  {
    name: 'compare_technicians',
    description: 'Compare technician performance over a date range. Shows completions, service counts, avg per day, zones covered.',
    input_schema: {
      type: 'object',
      properties: {
        date_from: { type: 'string' },
        date_to: { type: 'string' },
        tech_names: { type: 'array', items: { type: 'string' }, description: 'Tech names to compare. Omit for all techs.' },
      },
    },
  },
  {
    name: 'find_duplicates',
    description: 'Find potential duplicate customers by phone, email, or name+address.',
    input_schema: {
      type: 'object',
      properties: {
        match_on: { type: 'string', enum: ['phone', 'email', 'name_address'], description: 'Which field to check for duplicates' },
      },
      required: ['match_on'],
    },
  },

  // ── WRITE TOOLS ─────────────────────────────────────────────
  {
    name: 'update_customer',
    description: `Update one or more fields on a single customer. Updatable fields: first_name, last_name, email, phone, city, state, zip, address_line1, waveguard_tier, pipeline_stage, lead_source, monthly_rate, active, notes.
IMPORTANT: Always confirm with the operator before updating. Return what you plan to change and ask for approval.`,
    input_schema: {
      type: 'object',
      properties: {
        customer_id: { type: 'string' },
        updates: {
          type: 'object',
          description: 'Field-value pairs to update',
        },
      },
      required: ['customer_id', 'updates'],
    },
  },
  {
    name: 'bulk_update_customers',
    description: `Update a field across multiple customers at once. 
IMPORTANT: Always show the list of affected customers and ask for confirmation before executing.`,
    input_schema: {
      type: 'object',
      properties: {
        customer_ids: { type: 'array', items: { type: 'string' } },
        updates: { type: 'object', description: 'Field-value pairs to apply to all' },
      },
      required: ['customer_ids', 'updates'],
    },
  },
  {
    name: 'create_appointment',
    description: `Create a new scheduled service appointment.
service_type examples: "Pest Control", "Lawn Care Visit", "Mosquito Barrier Treatment", "Tree & Shrub Care", "Quarterly Pest Control".
time_window: "morning" (8-12), "afternoon" (12-5), or specific like "9:00 AM".`,
    input_schema: {
      type: 'object',
      properties: {
        customer_id: { type: 'string' },
        scheduled_date: { type: 'string', description: 'YYYY-MM-DD' },
        service_type: { type: 'string' },
        technician_name: { type: 'string', description: 'Optional tech name' },
        time_window: { type: 'string' },
        notes: { type: 'string' },
      },
      required: ['customer_id', 'scheduled_date', 'service_type'],
    },
  },
  {
    name: 'reschedule_appointment',
    description: 'Move an existing appointment to a new date. Keeps the same service type and customer.',
    input_schema: {
      type: 'object',
      properties: {
        appointment_id: { type: 'string' },
        new_date: { type: 'string', description: 'YYYY-MM-DD' },
        new_time_window: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['appointment_id', 'new_date'],
    },
  },
  {
    name: 'cancel_appointment',
    description: 'Cancel a scheduled appointment.',
    input_schema: {
      type: 'object',
      properties: {
        appointment_id: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['appointment_id'],
    },
  },
  {
    name: 'draft_sms',
    description: 'Draft an SMS message to send to a customer. Does NOT send immediately — returns the draft for operator approval.',
    input_schema: {
      type: 'object',
      properties: {
        customer_id: { type: 'string' },
        message: { type: 'string', description: 'SMS body text (max 320 chars for 2-segment SMS)' },
        purpose: { type: 'string', enum: ['reminder', 'follow_up', 'win_back', 'upsell', 'overdue_notice', 'custom'] },
      },
      required: ['customer_id', 'message'],
    },
  },
];


// ─── TOOL EXECUTION ─────────────────────────────────────────────

async function executeTool(toolName, input) {
  try {
    switch (toolName) {
      case 'query_customers': return await queryCustomers(input);
      case 'find_overdue_customers': return await findOverdueCustomers(input);
      case 'get_customer_detail': return await getCustomerDetail(input.customer_id);
      case 'get_schedule_view': return await getScheduleView(input);
      case 'query_revenue': return await queryRevenue(input);
      case 'compare_technicians': return await compareTechnicians(input);
      case 'find_duplicates': return await findDuplicates(input);
      case 'update_customer': return await updateCustomer(input.customer_id, input.updates);
      case 'bulk_update_customers': return await bulkUpdateCustomers(input.customer_ids, input.updates);
      case 'create_appointment': return await createAppointment(input);
      case 'reschedule_appointment': return await rescheduleAppointment(input);
      case 'cancel_appointment': return await cancelAppointment(input);
      case 'draft_sms': return await draftSms(input);
      default:
        return { error: `Unknown tool: ${toolName}` };
    }
  } catch (err) {
    logger.error(`[intelligence-bar] Tool ${toolName} failed:`, err);
    return { error: err.message };
  }
}


// ─── READ IMPLEMENTATIONS ───────────────────────────────────────

async function queryCustomers(input) {
  const { filters = {}, search, sort_by, sort_dir, limit: rawLimit } = input;
  const limit = Math.min(rawLimit || 50, 200);

  let query = db('customers')
    .select(
      'customers.id', 'customers.first_name', 'customers.last_name',
      'customers.email', 'customers.phone', 'customers.city', 'customers.state', 'customers.zip',
      'customers.address_line1', 'customers.waveguard_tier', 'customers.pipeline_stage',
      'customers.monthly_rate', 'customers.lifetime_revenue', 'customers.lead_score',
      'customers.active', 'customers.member_since', 'customers.lead_source',
      'customers.last_contact_date',
      db.raw("(SELECT MAX(service_date) FROM service_records WHERE service_records.customer_id = customers.id) as last_service_date"),
      db.raw("(SELECT MIN(scheduled_date) FROM scheduled_services WHERE scheduled_services.customer_id = customers.id AND scheduled_date >= CURRENT_DATE AND status NOT IN ('cancelled','completed')) as next_service_date"),
      db.raw("(SELECT COALESCE(overall_score, 0) FROM customer_health_scores WHERE customer_health_scores.customer_id = customers.id ORDER BY created_at DESC LIMIT 1) as health_score"),
    );

  // Apply filters
  if (filters.city) query = query.whereILike('city', `%${filters.city}%`);
  if (filters.state) query = query.where('state', filters.state);
  if (filters.zip) query = query.where('zip', filters.zip);
  if (filters.tier === 'none') query = query.whereNull('waveguard_tier');
  else if (filters.tier) query = query.where('waveguard_tier', filters.tier);
  if (filters.stage) query = query.where('pipeline_stage', filters.stage);
  if (filters.lead_source) query = query.where('lead_source', filters.lead_source);
  if (filters.active !== undefined) query = query.where('active', filters.active);
  if (filters.tag) {
    query = query.whereExists(function () {
      this.select('*').from('customer_tags').whereRaw('customer_tags.customer_id = customers.id').where('tag', filters.tag);
    });
  }

  // Null field checks
  if (filters.null_city) query = query.where(function () { this.whereNull('city').orWhere('city', ''); });
  if (filters.null_email) query = query.where(function () { this.whereNull('email').orWhere('email', ''); });
  if (filters.null_phone) query = query.where(function () { this.whereNull('phone').orWhere('phone', ''); });
  if (filters.null_address) query = query.where(function () { this.whereNull('address_line1').orWhere('address_line1', ''); });

  // Health score range
  if (filters.min_health_score || filters.max_health_score) {
    query = query.whereExists(function () {
      let sub = this.select('*').from('customer_health_scores')
        .whereRaw('customer_health_scores.customer_id = customers.id');
      if (filters.min_health_score) sub = sub.where('overall_score', '>=', filters.min_health_score);
      if (filters.max_health_score) sub = sub.where('overall_score', '<=', filters.max_health_score);
    });
  }

  // Monthly rate range
  if (filters.min_monthly_rate) query = query.where('monthly_rate', '>=', filters.min_monthly_rate);
  if (filters.max_monthly_rate) query = query.where('monthly_rate', '<=', filters.max_monthly_rate);

  // Service type filter (customers who have records of this type)
  if (filters.service_type) {
    query = query.whereExists(function () {
      this.select('*').from('service_records')
        .whereRaw('service_records.customer_id = customers.id')
        .whereILike('service_type', `%${filters.service_type}%`);
    });
  }

  // Free text search
  if (search) {
    const s = `%${search}%`;
    query = query.where(function () {
      this.whereILike('first_name', s).orWhereILike('last_name', s)
        .orWhereILike('phone', s).orWhereILike('email', s)
        .orWhereILike('address_line1', s).orWhereILike('city', s)
        .orWhereILike('company_name', s);
    });
  }

  // Sort
  const sortMap = {
    name: 'last_name', city: 'city', monthly_rate: 'monthly_rate',
    lead_score: 'lead_score', health_score: 'health_score',
    lifetime_revenue: 'lifetime_revenue', member_since: 'member_since',
  };
  const sortCol = sortMap[sort_by] || 'last_name';
  query = query.orderBy(sortCol, sort_dir === 'desc' ? 'desc' : 'asc');

  const customers = await query.limit(limit);
  const total = await db('customers').count('* as count').first();

  return {
    customers: customers.map(c => ({
      id: c.id,
      name: `${c.first_name || ''} ${c.last_name || ''}`.trim(),
      first_name: c.first_name,
      last_name: c.last_name,
      email: c.email || null,
      phone: c.phone || null,
      city: c.city || null,
      state: c.state || null,
      zip: c.zip || null,
      address: c.address_line1 || null,
      tier: c.waveguard_tier || null,
      stage: c.pipeline_stage,
      monthly_rate: parseFloat(c.monthly_rate || 0),
      lifetime_revenue: parseFloat(c.lifetime_revenue || 0),
      lead_score: c.lead_score,
      health_score: c.health_score ? parseInt(c.health_score) : null,
      active: c.active,
      member_since: c.member_since,
      last_service_date: c.last_service_date,
      next_service_date: c.next_service_date,
      last_contact_date: c.last_contact_date,
      lead_source: c.lead_source,
    })),
    total_matching: customers.length,
    total_customers: parseInt(total.count),
  };
}


async function findOverdueCustomers(input) {
  const { service_category, overdue_days = 0, limit: rawLimit } = input;
  const limit = Math.min(rawLimit || 50, 200);

  // Frequency expectations in days
  const frequencies = {
    pest: 90,        // quarterly
    lawn: 30,        // monthly
    mosquito: 21,    // every 3 weeks
    tree_shrub: 90,  // quarterly
    termite: 365,    // annual
  };

  // Service type patterns for matching
  const patterns = {
    pest: '%pest%',
    lawn: '%lawn%',
    mosquito: '%mosquito%',
    tree_shrub: '%tree%shrub%',
    termite: '%termite%',
  };

  const categories = service_category === 'all'
    ? Object.keys(frequencies)
    : [service_category];

  const results = [];

  for (const cat of categories) {
    const freq = frequencies[cat] || 90;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - freq - overdue_days);

    const customers = await db('customers')
      .select(
        'customers.id', 'customers.first_name', 'customers.last_name',
        'customers.phone', 'customers.city', 'customers.waveguard_tier',
        'customers.monthly_rate', 'customers.active',
        db.raw("(SELECT MAX(service_date) FROM service_records WHERE service_records.customer_id = customers.id AND service_type ILIKE ?) as last_service_date", [patterns[cat]]),
        db.raw("(SELECT MIN(scheduled_date) FROM scheduled_services WHERE scheduled_services.customer_id = customers.id AND scheduled_date >= CURRENT_DATE AND status NOT IN ('cancelled','completed') AND service_type ILIKE ?) as next_scheduled", [patterns[cat]]),
      )
      .where('customers.active', true)
      .whereExists(function () {
        this.select('*').from('service_records')
          .whereRaw('service_records.customer_id = customers.id')
          .whereILike('service_type', patterns[cat]);
      })
      .havingRaw("(SELECT MAX(service_date) FROM service_records WHERE service_records.customer_id = customers.id AND service_type ILIKE ?) < ?", [patterns[cat], cutoff.toISOString().split('T')[0]])
      .orderByRaw("(SELECT MAX(service_date) FROM service_records WHERE service_records.customer_id = customers.id AND service_type ILIKE ?) ASC", [patterns[cat]])
      .limit(limit);

    for (const c of customers) {
      const daysSince = c.last_service_date
        ? Math.floor((Date.now() - new Date(c.last_service_date)) / 86400000)
        : null;

      results.push({
        id: c.id,
        name: `${c.first_name || ''} ${c.last_name || ''}`.trim(),
        phone: c.phone,
        city: c.city,
        tier: c.waveguard_tier,
        monthly_rate: parseFloat(c.monthly_rate || 0),
        service_category: cat,
        expected_frequency_days: freq,
        last_service_date: c.last_service_date,
        days_since_last_service: daysSince,
        days_overdue: daysSince ? daysSince - freq : null,
        next_scheduled: c.next_scheduled,
        has_upcoming_appointment: !!c.next_scheduled,
      });
    }
  }

  results.sort((a, b) => (b.days_overdue || 0) - (a.days_overdue || 0));

  return {
    overdue_customers: results.slice(0, limit),
    total_found: results.length,
    query: { service_category, overdue_days },
  };
}


async function getCustomerDetail(customerId) {
  const customer = await db('customers').where('id', customerId).first();
  if (!customer) return { error: 'Customer not found' };

  const services = await db('service_records')
    .where('customer_id', customerId)
    .orderBy('service_date', 'desc')
    .limit(10);

  const upcoming = await db('scheduled_services')
    .where({ customer_id: customerId })
    .where('scheduled_date', '>=', etDateString())
    .whereNotIn('status', ['cancelled'])
    .orderBy('scheduled_date', 'asc')
    .limit(10);

  const invoices = await db('invoices')
    .where('customer_id', customerId)
    .orderBy('created_at', 'desc')
    .limit(5);

  const tags = await db('customer_tags').where('customer_id', customerId).select('tag');

  const health = await db('customer_health_scores')
    .where('customer_id', customerId)
    .orderBy('created_at', 'desc')
    .first();

  return {
    profile: {
      id: customer.id,
      name: `${customer.first_name} ${customer.last_name}`,
      first_name: customer.first_name,
      last_name: customer.last_name,
      email: customer.email,
      phone: customer.phone,
      address: `${customer.address_line1 || ''}, ${customer.city || ''}, ${customer.state || ''} ${customer.zip || ''}`.trim(),
      city: customer.city,
      state: customer.state,
      zip: customer.zip,
      tier: customer.waveguard_tier,
      stage: customer.pipeline_stage,
      monthly_rate: parseFloat(customer.monthly_rate || 0),
      lifetime_revenue: parseFloat(customer.lifetime_revenue || 0),
      active: customer.active,
      member_since: customer.member_since,
      lead_source: customer.lead_source,
      property_sqft: customer.property_sqft,
      lot_sqft: customer.lot_sqft,
      lawn_type: customer.lawn_type,
      notes: customer.notes,
    },
    tags: tags.map(t => t.tag),
    health_score: health ? {
      overall: health.overall_score,
      churn_risk: health.churn_risk,
      engagement: health.engagement_score,
      payment: health.payment_score,
      service: health.service_score,
    } : null,
    recent_services: services.map(s => ({
      id: s.id,
      date: s.service_date,
      type: s.service_type,
      technician: s.technician_name,
      notes: s.notes,
      status: s.status,
    })),
    upcoming_services: upcoming.map(s => ({
      id: s.id,
      date: s.scheduled_date,
      type: s.service_type,
      status: s.status,
      time_window: s.window_start ? `${s.window_start}-${s.window_end}` : null,
    })),
    recent_invoices: invoices.map(i => ({
      id: i.id,
      amount: parseFloat(i.total || 0),
      status: i.status,
      date: i.created_at,
    })),
  };
}


async function getScheduleView(input) {
  const { date, date_from, date_to, technician_name, city } = input;

  let query = db('scheduled_services')
    .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
    .leftJoin('technicians', 'scheduled_services.technician_id', 'technicians.id')
    .select(
      'scheduled_services.id', 'scheduled_services.scheduled_date',
      'scheduled_services.service_type', 'scheduled_services.status',
      'scheduled_services.window_start', 'scheduled_services.window_end',
      'scheduled_services.route_order', 'scheduled_services.notes',
      'customers.id as customer_id', 'customers.first_name', 'customers.last_name',
      'customers.city', 'customers.address_line1', 'customers.phone',
      'technicians.name as tech_name',
    )
    .whereNotIn('scheduled_services.status', ['cancelled']);

  if (date) {
    query = query.where('scheduled_services.scheduled_date', date);
  } else if (date_from && date_to) {
    query = query.whereBetween('scheduled_services.scheduled_date', [date_from, date_to]);
  } else if (date_from) {
    query = query.where('scheduled_services.scheduled_date', '>=', date_from);
  }

  if (technician_name) {
    query = query.whereILike('technicians.name', `%${technician_name}%`);
  }
  if (city) {
    query = query.whereILike('customers.city', `%${city}%`);
  }

  const appointments = await query.orderBy('scheduled_services.scheduled_date').orderByRaw('COALESCE(route_order, 999)').limit(200);

  return {
    appointments: appointments.map(a => ({
      id: a.id,
      date: a.scheduled_date,
      service_type: a.service_type,
      status: a.status,
      time_window: a.window_start || null,
      route_order: a.route_order,
      customer_id: a.customer_id,
      customer_name: `${a.first_name || ''} ${a.last_name || ''}`.trim(),
      customer_city: a.city,
      customer_address: a.address_line1,
      customer_phone: a.phone,
      technician: a.tech_name,
      notes: a.notes,
    })),
    total: appointments.length,
  };
}


async function queryRevenue(input) {
  const { date_from, date_to, customer_id, status, group_by } = input;

  let query = db('invoices')
    .leftJoin('customers', 'invoices.customer_id', 'customers.id');

  if (date_from) query = query.where('invoices.created_at', '>=', date_from);
  if (date_to) query = query.where('invoices.created_at', '<=', date_to);
  if (customer_id) query = query.where('invoices.customer_id', customer_id);
  if (status && status !== 'all') query = query.where('invoices.status', status);

  if (group_by === 'customer') {
    const rows = await query.select(
      'customers.id', 'customers.first_name', 'customers.last_name',
      db.raw('SUM(invoices.total) as total_revenue'),
      db.raw('COUNT(*) as invoice_count'),
    ).groupBy('customers.id', 'customers.first_name', 'customers.last_name')
      .orderByRaw('SUM(invoices.total) DESC').limit(50);

    return { grouped_by: 'customer', rows: rows.map(r => ({ id: r.id, name: `${r.first_name} ${r.last_name}`, total_revenue: parseFloat(r.total_revenue || 0), invoice_count: parseInt(r.invoice_count) })) };
  }

  if (group_by === 'month') {
    const rows = await query.select(
      db.raw("TO_CHAR(invoices.created_at, 'YYYY-MM') as month"),
      db.raw('SUM(invoices.total) as total_revenue'),
      db.raw('COUNT(*) as invoice_count'),
    ).groupByRaw("TO_CHAR(invoices.created_at, 'YYYY-MM')")
      .orderByRaw("TO_CHAR(invoices.created_at, 'YYYY-MM') DESC").limit(24);

    return { grouped_by: 'month', rows: rows.map(r => ({ month: r.month, total_revenue: parseFloat(r.total_revenue || 0), invoice_count: parseInt(r.invoice_count) })) };
  }

  // Default: return individual invoices
  const invoices = await query.select(
    'invoices.*', 'customers.first_name', 'customers.last_name',
  ).orderBy('invoices.created_at', 'desc').limit(100);

  const totals = await db('invoices')
    .modify(q => {
      if (date_from) q.where('created_at', '>=', date_from);
      if (date_to) q.where('created_at', '<=', date_to);
      if (status && status !== 'all') q.where('status', status);
    })
    .select(
      db.raw('SUM(total) as total_revenue'),
      db.raw('COUNT(*) as total_invoices'),
      db.raw("SUM(CASE WHEN status = 'overdue' THEN total ELSE 0 END) as overdue_amount"),
    ).first();

  return {
    invoices: invoices.map(i => ({
      id: i.id, customer: `${i.first_name} ${i.last_name}`, amount: parseFloat(i.total || 0), status: i.status, date: i.created_at,
    })),
    summary: {
      total_revenue: parseFloat(totals.total_revenue || 0),
      total_invoices: parseInt(totals.total_invoices || 0),
      overdue_amount: parseFloat(totals.overdue_amount || 0),
    },
  };
}


async function compareTechnicians(input) {
  const { date_from, date_to, tech_names } = input;
  const from = date_from || etDateString(addETDays(new Date(), -30));
  const to = date_to || etDateString();

  let query = db('service_records')
    .leftJoin('technicians', 'service_records.technician_id', 'technicians.id')
    .leftJoin('customers', 'service_records.customer_id', 'customers.id')
    .whereBetween('service_records.service_date', [from, to])
    .where('service_records.status', 'completed');

  if (tech_names && tech_names.length) {
    query = query.where(function () {
      for (const name of tech_names) {
        this.orWhereILike('technicians.name', `%${name}%`);
      }
    });
  }

  const rows = await query.select(
    'technicians.name as tech_name',
    db.raw('COUNT(*) as completed_services'),
    db.raw('COUNT(DISTINCT service_records.service_date) as days_worked'),
    db.raw('COUNT(DISTINCT customers.city) as zones_covered'),
    db.raw("string_agg(DISTINCT customers.city, ', ') as cities"),
  ).groupBy('technicians.name');

  return {
    period: { from, to },
    technicians: rows.map(r => ({
      name: r.tech_name || 'Unassigned',
      completed_services: parseInt(r.completed_services),
      days_worked: parseInt(r.days_worked),
      avg_per_day: (parseInt(r.completed_services) / Math.max(parseInt(r.days_worked), 1)).toFixed(1),
      zones_covered: parseInt(r.zones_covered),
      cities: r.cities,
    })),
  };
}


async function findDuplicates(input) {
  const { match_on } = input;

  if (match_on === 'phone') {
    const dupes = await db('customers')
      .select('phone', db.raw('COUNT(*) as count'), db.raw("string_agg(TRIM(first_name || ' ' || COALESCE(last_name, '')), ', ') as names"))
      .whereNotNull('phone').where('phone', '!=', '')
      .groupBy('phone').having(db.raw('COUNT(*)'), '>', 1)
      .orderByRaw('COUNT(*) DESC').limit(50);
    return { match_on: 'phone', duplicates: dupes };
  }

  if (match_on === 'email') {
    const dupes = await db('customers')
      .select('email', db.raw('COUNT(*) as count'), db.raw("string_agg(TRIM(first_name || ' ' || COALESCE(last_name, '')), ', ') as names"))
      .whereNotNull('email').where('email', '!=', '')
      .groupBy('email').having(db.raw('COUNT(*)'), '>', 1)
      .orderByRaw('COUNT(*) DESC').limit(50);
    return { match_on: 'email', duplicates: dupes };
  }

  if (match_on === 'name_address') {
    const dupes = await db('customers')
      .select(
        db.raw("LOWER(TRIM(first_name || ' ' || COALESCE(last_name, ''))) as full_name"),
        'address_line1',
        db.raw('COUNT(*) as count'),
        db.raw("string_agg(id::text, ', ') as ids"),
      )
      .whereNotNull('address_line1').where('address_line1', '!=', '')
      .groupByRaw("LOWER(TRIM(first_name || ' ' || COALESCE(last_name, ''))), address_line1")
      .having(db.raw('COUNT(*)'), '>', 1)
      .orderByRaw('COUNT(*) DESC').limit(50);
    return { match_on: 'name_address', duplicates: dupes };
  }

  return { error: 'Invalid match_on value' };
}


// ─── WRITE IMPLEMENTATIONS ──────────────────────────────────────

const UPDATABLE_FIELDS = {
  first_name: 'first_name', last_name: 'last_name', email: 'email',
  phone: 'phone', city: 'city', state: 'state', zip: 'zip',
  address_line1: 'address_line1', waveguard_tier: 'waveguard_tier',
  pipeline_stage: 'pipeline_stage', lead_source: 'lead_source',
  monthly_rate: 'monthly_rate', active: 'active', notes: 'notes',
};

function sanitizeUpdates(updates) {
  const clean = {};
  for (const [key, val] of Object.entries(updates)) {
    const dbCol = UPDATABLE_FIELDS[key];
    if (dbCol) clean[dbCol] = val;
  }
  clean.updated_at = new Date();
  return clean;
}

async function updateCustomer(customerId, updates) {
  const clean = sanitizeUpdates(updates);
  if (Object.keys(clean).length <= 1) return { error: 'No valid fields to update' };

  const before = await db('customers').where('id', customerId).first();
  if (!before) return { error: 'Customer not found' };

  await db('customers').where('id', customerId).update(clean);
  const after = await db('customers').where('id', customerId).first();

  const changes = {};
  for (const key of Object.keys(updates)) {
    const dbCol = UPDATABLE_FIELDS[key];
    if (dbCol && String(before[dbCol]) !== String(after[dbCol])) {
      changes[key] = { from: before[dbCol], to: after[dbCol] };
    }
  }

  logger.info(`[intelligence-bar] Updated customer ${customerId}:`, changes);

  return {
    success: true,
    customer_id: customerId,
    customer_name: `${after.first_name} ${after.last_name}`,
    changes,
  };
}


async function bulkUpdateCustomers(customerIds, updates) {
  const clean = sanitizeUpdates(updates);
  if (Object.keys(clean).length <= 1) return { error: 'No valid fields to update' };
  if (!customerIds || !customerIds.length) return { error: 'No customer IDs provided' };

  const count = await db('customers').whereIn('id', customerIds).update(clean);

  logger.info(`[intelligence-bar] Bulk updated ${count} customers:`, updates);

  return {
    success: true,
    updated_count: count,
    fields_updated: Object.keys(updates),
  };
}


async function createAppointment(input) {
  const { customer_id, scheduled_date, service_type, technician_name, time_window, notes } = input;

  const customer = await db('customers').where('id', customer_id).first();
  if (!customer) return { error: 'Customer not found' };

  // Find technician if specified
  let technician_id = null;
  if (technician_name) {
    const tech = await db('technicians').whereILike('name', `%${technician_name}%`).first();
    if (tech) technician_id = tech.id;
  }

  const [appointment] = await db('scheduled_services').insert({
    customer_id,
    scheduled_date,
    service_type,
    technician_id,
    status: 'scheduled',
    window_start: time_window || null,
    notes: notes || null,
    created_at: new Date(),
    updated_at: new Date(),
  }).returning('*');

  logger.info(`[intelligence-bar] Created appointment ${appointment.id} for ${customer.first_name} ${customer.last_name} on ${scheduled_date}`);

  return {
    success: true,
    appointment_id: appointment.id,
    customer_name: `${customer.first_name} ${customer.last_name}`,
    date: scheduled_date,
    service_type,
    technician: technician_name || 'Unassigned',
  };
}


async function rescheduleAppointment(input) {
  const { appointment_id, new_date, new_time_window, reason } = input;

  const appt = await db('scheduled_services').where('id', appointment_id).first();
  if (!appt) return { error: 'Appointment not found' };

  const customer = await db('customers').where('id', appt.customer_id).first();
  const oldDate = appt.scheduled_date;

  await db('scheduled_services').where('id', appointment_id).update({
    scheduled_date: new_date,
    window_start: new_time_window || appt.window_start,
    notes: reason ? `${appt.notes || ''}\nRescheduled: ${reason}`.trim() : appt.notes,
    updated_at: new Date(),
  });

  logger.info(`[intelligence-bar] Rescheduled appointment ${appointment_id} from ${oldDate} to ${new_date}`);

  return {
    success: true,
    appointment_id,
    customer_name: customer ? `${customer.first_name} ${customer.last_name}` : 'Unknown',
    old_date: oldDate,
    new_date,
    service_type: appt.service_type,
  };
}


async function cancelAppointment(input) {
  const { appointment_id, reason } = input;

  const appt = await db('scheduled_services').where('id', appointment_id).first();
  if (!appt) return { error: 'Appointment not found' };

  await db('scheduled_services').where('id', appointment_id).update({
    status: 'cancelled',
    notes: reason ? `${appt.notes || ''}\nCancelled: ${reason}`.trim() : appt.notes,
    updated_at: new Date(),
  });

  const customer = await db('customers').where('id', appt.customer_id).first();

  logger.info(`[intelligence-bar] Cancelled appointment ${appointment_id}`);

  return {
    success: true,
    appointment_id,
    customer_name: customer ? `${customer.first_name} ${customer.last_name}` : 'Unknown',
    date: appt.scheduled_date,
    service_type: appt.service_type,
  };
}


async function draftSms(input) {
  const { customer_id, message, purpose } = input;

  const customer = await db('customers').where('id', customer_id).first();
  if (!customer) return { error: 'Customer not found' };
  if (!customer.phone) return { error: 'Customer has no phone number on file' };

  return {
    draft: true,
    customer_id,
    customer_name: `${customer.first_name} ${customer.last_name}`,
    phone: customer.phone,
    message,
    purpose,
    char_count: message.length,
    segments: Math.ceil(message.length / 160),
    note: 'This is a DRAFT. The operator must approve before sending.',
  };
}


module.exports = { TOOLS, executeTool };
