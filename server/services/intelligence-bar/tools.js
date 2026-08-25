/**
 * Intelligence Bar — Claude Tool Definitions & Execution
 * server/services/intelligence-bar/tools.js
 *
 * These tools give Claude direct read/write access to the Waves database
 * for natural-language admin queries. Claude picks the right tool(s)
 * based on the operator's prompt.
 */

const db = require('../../models/db');
const { lockCustomerComms } = require('../../utils/customer-comms-lock');
// Shared admin window rules + gated occupancy probe (scheduling/window-rules.js).
const { assertAdminAppointmentWindow, probeSlotOverlap, slotOverlapWarning } = require('../scheduling/window-rules');
const logger = require('../logger');
const { createDefaultCustomerRows } = require('../customer-default-rows');
const {
  etDateString, addETDays, validScheduleDate, sameDayWindowElapsed,
  windowDurationMinutes, deriveWindowEnd,
} = require('../../utils/datetime-et');
const { FORMER_CUSTOMER_STAGES, ALL_PIPELINE_STAGES, stageLifecycleStamps } = require('../customer-stages');
const { scheduledServiceTrackTokenExpiry } = require('../track-token-expiry');
const { formatAddress } = require('../../utils/address-normalizer');
const { EMAIL_FANOUT_DISCLOSURE } = require('../customer-email-fanout');
const { CONTACT_FANOUT_DISCLOSURE } = require('../customer-contact-fanout');
const {
  normalizeContactName,
  normalizeContactPhone,
  normalizeContactEmail,
  normalizeContactStreet,
  normalizeContactCity,
  normalizeContactStateField,
  normalizeContactZip,
  normalizeContactRecord,
  clearLineTypeOnPhoneChange,
} = require('../../utils/intake-normalize');

// ─── TOOL DEFINITIONS (Anthropic format) ────────────────────────

const TOOLS = [
  // ── READ TOOLS ──────────────────────────────────────────────
  {
    name: 'search_field_intelligence',
    description: `Search the trusted agronomic knowledge brain — the AI-maintained field-outcome wiki plus the curated knowledge base — and return matching pages with summaries, confidence, data-point counts and any OPEN contradictions. Unreviewed (red-tier) wiki pages are excluded automatically. Synthesize an answer from the returned material and cite the source slugs; mention confidence levels and surface any open contradictions explicitly.
Use for: "what do we know about large patch on zoysia", "how has K-Flow performed", "field results for Talstar P", "what works for chinch bugs in peak season".`,
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Topic, product, condition, or grass track to look up' },
      },
      required: ['query'],
    },
  },
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
    description: 'Query revenue and billing data. Can filter by date range, customer, status. customer_id must be a customer UUID (use query_customers to find it first), never a name.',
    input_schema: {
      type: 'object',
      properties: {
        date_from: { type: 'string' },
        date_to: { type: 'string' },
        customer_id: { type: 'string', format: 'uuid', description: 'Customer UUID' },
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
    name: 'create_customer',
    description: `Create a new customer record (new lead or new account). Use when the operator asks to add a customer who is not in the database yet.
Checks for an existing customer with the same phone number first — if one exists, returns that customer instead of creating a duplicate.
Your call returns a PREVIEW; the operator approves or rejects it on the confirmation card in the portal. Call ONCE per intended action — never retry, never claim completion.`,
    input_schema: {
      type: 'object',
      properties: {
        first_name: { type: 'string' },
        last_name: { type: 'string' },
        phone: { type: 'string' },
        email: { type: 'string' },
        address_line1: { type: 'string' },
        city: { type: 'string' },
        state: { type: 'string', description: 'Two-letter state code (default FL)' },
        zip: { type: 'string' },
        lead_source: { type: 'string', description: 'Where the lead came from (e.g. phone_call, domain_website, referral). Default: intelligence_bar' },
        pipeline_stage: { type: 'string', enum: ['new_lead', 'contacted', 'estimate_sent', 'estimate_viewed', 'follow_up', 'negotiating', 'won', 'active_customer'], description: 'Default: new_lead' },
        notes: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['first_name', 'phone'],
    },
  },
  {
    name: 'update_customer',
    description: `Update one or more fields on a single customer. Updatable fields: first_name, last_name, email, phone, city, state, zip, address_line1, waveguard_tier, pipeline_stage, lead_source, monthly_rate, active, notes.
Changing the email also ripples automatically: ${EMAIL_FANOUT_DISCLOSURE}. Likewise ${CONTACT_FANOUT_DISCLOSURE}. Mention the ripple when proposing an email, name, or phone change.
Billing-lane side effect: if the update gives the customer a WaveGuard membership tier plus a positive monthly_rate while no billing lane is set, billing_mode is stamped 'monthly_membership' in the same write (that is the lane such rows already bill under) and the owner is notified to verify it — mention this when proposing a tier or monthly_rate change.
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
Billing-lane side effect: any row the update leaves with a WaveGuard membership tier plus a positive monthly_rate and no billing lane gets billing_mode stamped 'monthly_membership' in the same write (the lane such rows already bill under); the stamped rows are listed in the result and the owner is notified — mention this when proposing a tier or monthly_rate change.
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
    name: 'update_property_access',
    description: `Update the STRUCTURED property-access and pet fields on a customer's property profile (the property_preferences record). Use this — not the free-text customer notes — for gate/lockbox/garage codes, pet info, parking/access details, and how a tech should keep pets safe. These fields render as their own labeled alerts on the technician's stop card (e.g. "Gate: 9292", a pet warning, a pet-securing reminder), so they are far more reliable in the field than a free-text note.

Pass ONLY the fields you want to set or change:
- neighborhood_gate_code / property_gate_code / garage_code / lockbox_code — access codes (use property_gate_code for the home/yard gate, neighborhood_gate_code for a community gate)
- parking_notes / side_gate_access / access_notes — where to park / how to get in
- pet_count (number) / pet_details (e.g. "2 indoor cats") — pets on the property
- pets_secured_plan — how the tech should keep pets safe, e.g. "keep the screen doors closed during service so the cats don't get out"
- special_instructions — any other field instruction

IMPORTANT: Always show the operator exactly what you plan to set and ask for approval before saving.`,
    input_schema: {
      type: 'object',
      properties: {
        customer_id: { type: 'string' },
        neighborhood_gate_code: { type: 'string' },
        property_gate_code: { type: 'string' },
        garage_code: { type: 'string' },
        lockbox_code: { type: 'string' },
        parking_notes: { type: 'string' },
        side_gate_access: { type: 'string' },
        access_notes: { type: 'string' },
        pet_count: { type: 'integer' },
        pet_details: { type: 'string' },
        pets_secured_plan: { type: 'string' },
        special_instructions: { type: 'string' },
      },
      required: ['customer_id'],
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
      case 'search_field_intelligence': return await searchFieldIntelligence(input);
      case 'query_customers': return await queryCustomers(input);
      case 'find_overdue_customers': return await findOverdueCustomers(input);
      case 'get_customer_detail': return await getCustomerDetail(input.customer_id);
      case 'get_schedule_view': return await getScheduleView(input);
      case 'query_revenue': return await queryRevenue(input);
      case 'compare_technicians': return await compareTechnicians(input);
      case 'find_duplicates': return await findDuplicates(input);
      case 'create_customer': return await createCustomer(input);
      case 'update_customer': return await updateCustomer(input.customer_id, input.updates);
      case 'bulk_update_customers': return await bulkUpdateCustomers(input.customer_ids, input.updates);
      case 'update_property_access': return await updatePropertyAccess(input);
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
      db.raw("(SELECT COALESCE(overall_score, 0) FROM customer_health_scores WHERE customer_health_scores.customer_id = customers.id ORDER BY scored_at DESC NULLS LAST, created_at DESC LIMIT 1) as health_score"),
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

  // Service type patterns for matching. Case-insensitive POSIX regex (~*) so the
  // lawn bucket can alternate lawn|turf — commercial lawn persists as
  // "Commercial Turf Treatment Program" in service_type, and a plain ILIKE
  // pattern can't OR the two. (~* 'pest' ≡ ILIKE '%pest%' for plain substrings.)
  const patterns = {
    pest: 'pest',
    lawn: 'lawn|turf',
    mosquito: 'mosquito',
    tree_shrub: 'tree.*shrub',
    termite: 'termite',
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
        db.raw("(SELECT MAX(service_date) FROM service_records WHERE service_records.customer_id = customers.id AND service_type ~* ?) as last_service_date", [patterns[cat]]),
        db.raw("(SELECT MIN(scheduled_date) FROM scheduled_services WHERE scheduled_services.customer_id = customers.id AND scheduled_date >= CURRENT_DATE AND status NOT IN ('cancelled','completed') AND service_type ~* ?) as next_scheduled", [patterns[cat]]),
      )
      .where('customers.active', true)
      .whereNull('customers.deleted_at')
      .whereExists(function () {
        this.select('*').from('service_records')
          .whereRaw('service_records.customer_id = customers.id')
          .whereRaw('service_type ~* ?', [patterns[cat]]);
      })
      .havingRaw("(SELECT MAX(service_date) FROM service_records WHERE service_records.customer_id = customers.id AND service_type ~* ?) < ?", [patterns[cat], cutoff.toISOString().split('T')[0]])
      .orderByRaw("(SELECT MAX(service_date) FROM service_records WHERE service_records.customer_id = customers.id AND service_type ~* ?) ASC", [patterns[cat]])
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
    .orderByRaw('scored_at DESC NULLS LAST, created_at DESC')
    .first();

  return {
    profile: {
      id: customer.id,
      name: `${customer.first_name} ${customer.last_name}`,
      first_name: customer.first_name,
      last_name: customer.last_name,
      email: customer.email,
      phone: customer.phone,
      address: formatAddress({ line1: customer.address_line1, city: customer.city, state: customer.state, zip: customer.zip }),
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
      notes: customer.crm_notes,
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


const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function queryRevenue(input) {
  const { date_from, date_to, customer_id, status, group_by } = input;

  // customer_id lands in a uuid-column comparison: name-like input from the
  // model throws a Postgres cast error and flags the tool DEGRADED in Tool
  // Health. Return a typed error instead so the model recovers by resolving
  // the customer first.
  if (customer_id && !UUID_RE.test(String(customer_id))) {
    return { error: `customer_id must be a customer UUID, got "${customer_id}". Use query_customers to look the customer up, then retry with their id.` };
  }

  let query = db('invoices')
    .leftJoin('customers', 'invoices.customer_id', 'customers.id');

  if (date_from) query = query.where('invoices.created_at', '>=', date_from);
  if (date_to) query = query.where('invoices.created_at', '<=', date_to);
  if (customer_id) query = query.where('invoices.customer_id', customer_id);
  if (status && status !== 'all') query = query.where('invoices.status', status);

  if (group_by === 'customer') {
    const rows = await query.select(
      'customers.id', 'customers.first_name', 'customers.last_name',
      db.raw('SUM(GREATEST(invoices.total - COALESCE(invoices.credit_applied, 0), 0)) as total_revenue'),
      db.raw('COUNT(*) as invoice_count'),
    ).groupBy('customers.id', 'customers.first_name', 'customers.last_name')
      .orderByRaw('SUM(GREATEST(invoices.total - COALESCE(invoices.credit_applied, 0), 0)) DESC').limit(50);

    return { grouped_by: 'customer', rows: rows.map(r => ({ id: r.id, name: `${r.first_name} ${r.last_name}`, total_revenue: parseFloat(r.total_revenue || 0), invoice_count: parseInt(r.invoice_count) })) };
  }

  if (group_by === 'month') {
    const rows = await query.select(
      db.raw("TO_CHAR(invoices.created_at, 'YYYY-MM') as month"),
      db.raw('SUM(GREATEST(invoices.total - COALESCE(invoices.credit_applied, 0), 0)) as total_revenue'),
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
      // Same customer scope as the invoice list above — without it a
      // customer-specific answer pairs one customer's invoices with
      // COMPANY-WIDE totals in the same response.
      if (customer_id) q.where('customer_id', customer_id);
      if (status && status !== 'all') q.where('status', status);
    })
    .select(
      // Amount due (total − applied account credit): a paid credit-applied invoice
      // keeps its gross total but only collected the reduced cash, so summing raw
      // total would overstate revenue by the consumed credit.
      db.raw('SUM(GREATEST(total - COALESCE(credit_applied, 0), 0)) as total_revenue'),
      db.raw('COUNT(*) as total_invoices'),
      db.raw("SUM(CASE WHEN status = 'overdue' THEN GREATEST(total - COALESCE(credit_applied, 0), 0) ELSE 0 END) as overdue_amount"),
    ).first();

  return {
    invoices: invoices.map(i => ({
      id: i.id, customer: `${i.first_name} ${i.last_name}`, amount: Math.max(0, parseFloat(i.total || 0) - parseFloat(i.credit_applied || 0)), status: i.status, date: i.created_at,
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
  monthly_rate: 'monthly_rate', active: 'active', notes: 'crm_notes',
};

function sanitizeUpdates(updates) {
  const clean = {};
  for (const [key, val] of Object.entries(updates)) {
    const dbCol = UPDATABLE_FIELDS[key];
    if (dbCol) clean[dbCol] = val;
  }
  // Operator-facing tier writes carry 'manual' provenance (migration
  // 20260728000001): a human confirming/changing a tier through the IB must
  // never leave waveguard_tier_source = 'auto' behind, or the nightly
  // auto-tier reconciler could silently undo the confirmed edit (Codex
  // #3011 r9). Clearing the tier clears provenance with it. Covers both
  // update_customer and bulk_update_customers, which share this sanitizer.
  if (clean.waveguard_tier !== undefined) {
    clean.waveguard_tier_source = clean.waveguard_tier ? 'manual' : null;
  }
  clean.updated_at = new Date();
  return clean;
}

// Subset of CUSTOMER_STAGES in routes/admin-customers.js — creation never starts
// a customer in a dead-end stage (lost, churned, dormant, at_risk).
const CREATABLE_STAGES = new Set([
  'new_lead', 'contacted', 'estimate_sent', 'estimate_viewed', 'follow_up',
  'negotiating', 'won', 'active_customer',
]);

async function createCustomer(input) {
  const firstName = normalizeContactName(String(input.first_name || '').trim());
  const lastName = normalizeContactName(String(input.last_name || '').trim()) || null;
  const phone = normalizeContactPhone(String(input.phone || '').trim());
  if (!firstName || !phone) return { error: 'first_name and phone are required' };

  const phoneDigits = phone.replace(/\D/g, '').slice(-10);
  if (phoneDigits.length < 10) return { error: 'phone must include at least 10 digits' };

  const stage = input.pipeline_stage || 'new_lead';
  if (!CREATABLE_STAGES.has(stage)) return { error: `Invalid pipeline_stage: ${stage}` };

  const email = normalizeContactEmail(input.email) || null;

  const existing = await db('customers')
    .whereNull('deleted_at')
    .where(function () {
      this.whereRaw("regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') LIKE ?", [`%${phoneDigits}`]);
      if (email) this.orWhereRaw('LOWER(email) = ?', [email]);
    })
    .orderBy('created_at', 'asc')
    .first();

  if (existing) {
    return {
      already_exists: true,
      customer_id: existing.id,
      customer_name: `${existing.first_name || ''} ${existing.last_name || ''}`.trim(),
      phone: existing.phone,
      email: existing.email,
      stage: existing.pipeline_stage,
      note: 'A customer with this phone or email already exists — no new record created. Use get_customer_detail or update_customer with this id. For a second property on the same account, use the New Customer form.',
    };
  }

  const record = {
    first_name: firstName,
    last_name: lastName,
    phone,
    email,
    address_line1: normalizeContactStreet(String(input.address_line1 || '').trim()) || null,
    city: normalizeContactCity(String(input.city || '').trim()) || null,
    state: normalizeContactStateField(String(input.state || '').trim()) || 'FL',
    zip: normalizeContactZip(String(input.zip || '').trim()) || null,
    pipeline_stage: stage,
    lead_source: String(input.lead_source || '').trim() || 'intelligence_bar',
  };

  if (input.confirmed !== true) {
    return {
      preview: true,
      would_create: record,
      note: 'PREVIEW ONLY — nothing was created. Show these details to the operator, and after they approve, call create_customer again with the same fields plus confirmed: true.',
    };
  }

  const created = await db.transaction(async (trx) => {
    const [account] = await trx('customer_accounts').insert({
      first_name: firstName,
      last_name: lastName,
      phone,
      email,
    }).returning('*');

    const [customer] = await trx('customers').insert({
      ...record,
      account_id: account.id,
      is_primary_profile: true,
      profile_label: 'Primary',
      pipeline_stage_changed_at: new Date(),
      // Created directly into a customer stage → stamp the became-a-customer date
      // (creation = conversion here) so they're counted by member_since metrics.
      ...(['active_customer', 'won', 'at_risk'].includes(record.pipeline_stage) ? { member_since: etDateString() } : {}),
      crm_notes: input.notes ? String(input.notes).trim() : null,
      active: true,
    }).returning('*');

    // Default child rows — same canonical helper as every creation path
    await createDefaultCustomerRows(trx, customer.id);

    if (Array.isArray(input.tags)) {
      for (const tag of input.tags) {
        const cleanTag = String(tag || '').trim();
        if (cleanTag) {
          await trx('customer_tags').insert({ customer_id: customer.id, tag: cleanTag }).onConflict(['customer_id', 'tag']).ignore();
        }
      }
    }

    return customer;
  });

  logger.info(`[intelligence-bar] Created customer ${created.id} (source: ${record.lead_source}, stage: ${record.pipeline_stage})`);

  return {
    success: true,
    customer_id: created.id,
    customer_name: `${created.first_name} ${created.last_name || ''}`.trim(),
    phone: created.phone,
    email: created.email,
    city: created.city,
    stage: created.pipeline_stage,
    lead_source: created.lead_source,
  };
}


async function updateCustomer(customerId, updates) {
  const clean = sanitizeUpdates(updates);
  Object.assign(clean, normalizeContactRecord(clean));
  if (Object.keys(clean).length <= 1) return { error: 'No valid fields to update' };

  const before = await db('customers').where('id', customerId).first();
  if (!before) return { error: 'Customer not found' };

  // Phone change → drop the stale line_type cache (see clearLineTypeOnPhoneChange).
  clearLineTypeOnPhoneChange(clean, before);

  // Stage change → the FULL canonical lifecycle stamps, identical to the
  // admin route (codex #3282 audit P1 — the old member_since-only handling
  // left a reactivated archived row with active=false and a stale
  // churned_at, so whereLiveCustomer never saw it): activation, churn
  // clearing/stamping, stage timestamp, and member date, in the same write.
  // Validate FIRST — a typo'd/model-invented stage must not run lifecycle
  // mutations while persisting an unsupported value.
  if (clean.pipeline_stage && !ALL_PIPELINE_STAGES.includes(clean.pipeline_stage)) {
    return { error: `Invalid pipeline stage: ${clean.pipeline_stage}` };
  }
  if (clean.pipeline_stage) {
    Object.assign(clean, stageLifecycleStamps(
      before.pipeline_stage, clean.pipeline_stage, before, { today: etDateString() },
    ));
  }

  // An address edit must stay consistent with the Customers route (PUT /:id):
  // mirror the change onto the primary customer_properties row ATOMICALLY — so a
  // unique address-index collision rolls the whole edit back with a clear error
  // instead of desyncing customers.address_* from the property's dedup key — then
  // re-geocode so the map pin and dispatch drive-time use the new location rather
  // than the old coordinates. A plain update here previously left both stale.
  //
  // Triggered on the PRESENCE of address fields, not on a diff vs the customer row.
  // A customer left stale by an earlier (pre-fix) IB edit has customers.address_*
  // already equal to the desired value while the primary property + coords still
  // point at the old address; a diff-vs-customer-row check would read false and
  // skip the heal, so re-submitting the same address could never self-repair.
  // syncPrimaryAddress is idempotent (no-ops when the property already matches), so
  // running it whenever an address is submitted is safe when nothing actually drifted.
  const merged = { ...before, ...clean };
  const addressSubmitted = ['address_line1', 'address_line2', 'city', 'state', 'zip']
    .some((f) => clean[f] !== undefined);
  let emailSync = null;
  let impliedLaneStamp = null;
  try {
    await db.transaction(async (trx) => {
      // Membership-affecting writes join the customer-comms serialization
      // (codex #3426 r6 P2): the previsit backstop sweep holds
      // `customer-comms:<id>` through its membership recheck AND the SMS
      // dispatch, so a tier/rate write that makes this customer a member
      // either commits before the sweep's in-lock recheck reads or waits
      // until after the send. Comms lock BEFORE the customers row lock
      // (customer-comms-lock.js contract).
      if (clean.waveguard_tier !== undefined || clean.monthly_rate !== undefined) {
        await lockCustomerComms(trx, customerId);
      }
      // Row lock serializes overlapping address edits (see the Customers
      // route): before/merged are re-derived from the locked row so a losing
      // concurrent editor still matches the snapshots the winner moved.
      const lockedBefore = await trx('customers').where('id', customerId).forUpdate().first() || before;
      const lockedMerged = { ...lockedBefore, ...clean };
      // Close the inferred-monthly vector (#3140 resolution): billing_mode
      // is not an IB-updatable field, so a tier/rate write that leaves the
      // row (NULL lane + real membership tier + positive rate) mints an
      // IMPLICIT monthly member the lane audits can't see. Stamp the
      // inference explicitly in the same write — identical billing behavior
      // (the resolver already infers monthly_membership) — and disclose it
      // in the result + an owner review notification below.
      impliedLaneStamp = require('../billing-lane').impliedMonthlyStampForWrite(lockedBefore, lockedMerged);
      if (impliedLaneStamp) clean.billing_mode = impliedLaneStamp;
      // Assigning an email serializes against a customer-merge UNDO
      // checking whether that address is claimed (customer-dedupe.js
      // revertMerge — customers.email has NO unique constraint, so only
      // this shared lock keeps the check honest between its read and its
      // commit). KEY DERIVATION (must stay byte-identical to
      // customer-dedupe.js and routes/admin-customers.js — extend ALL in
      // the same commit): pg_advisory_xact_lock(hashtextextended(
      //   'customer-email:' || lower(trim(<email>)), 0)).
      if (clean.email) {
        const emailLc = String(clean.email).trim().toLowerCase();
        await trx.raw(
          'SELECT pg_advisory_xact_lock(hashtextextended(?, 0))',
          [`customer-email:${emailLc}`],
        );
        // Serialization ONLY — deliberately NO claimant refusal (r23):
        // customers.email is intentionally non-unique (20260417000010 —
        // spouses/shared household addresses are supported), so an
        // operator assigning a shared address is a supported act. The undo
        // needs only this lock: its claim probe runs under the same key.
      }
      await trx('customers').where('id', customerId).update(clean);
      if (clean.monthly_rate !== undefined
        && Math.round((Number(lockedBefore?.monthly_rate) || 0) * 100)
          !== Math.round((Number(clean.monthly_rate) || 0) * 100)) {
        // Only an ACTUAL rate change invalidates per-family attribution
        // (codex #3245 r2/r6) — resetting on a same-value write would
        // replace seeded components with an unattributed blob. Gate-aware
        // error policy lives in the helper.
        await require('../plan-rate-ledger')
          .syncScalarWriteToLedger(trx, customerId, clean.monthly_rate, { source: 'ib_update' });
      }
      if (addressSubmitted) {
        await require('../customer-properties').syncPrimaryAddress(lockedMerged, trx);
        // Open leads/estimates snapshot the address at creation and never
        // re-read customers.* — sync the copies that still match the old
        // address (matching rules in the fan-out service header). Presence-
        // triggered like the mirror above, so resubmitting the same address
        // also self-heals copies left stale by a pre-fix edit.
        await require('../customer-address-fanout').propagateCustomerAddressChange({ before: lockedBefore, after: lockedMerged }, trx);
      }
      if (clean.email !== undefined) {
        // Email snapshots (leads.email, estimates.customer_email, the
        // newsletter subscription) sync too, and a CHANGED email resolves any
        // open email read-back card for this customer's calls. Diff-gated
        // inside the service — an unchanged resave is a no-op.
        emailSync = await require('../customer-email-fanout').propagateCustomerEmailChange(
          { before: lockedBefore, after: lockedMerged, source: 'Intelligence Bar update_customer' }, trx
        );
      }
      // Name and phone snapshots (leads, estimates, contracts, promoter,
      // booking recovery, automation greetings) sync too — diff-gated inside
      // the service, so an unchanged resave is a no-op.
      if (clean.first_name !== undefined || clean.last_name !== undefined) {
        await require('../customer-contact-fanout').propagateCustomerNameChange(
          { before: lockedBefore, after: lockedMerged }, trx
        );
      }
      if (clean.phone !== undefined) {
        await require('../customer-contact-fanout').propagateCustomerPhoneChange(
          { before: lockedBefore, after: lockedMerged }, trx
        );
      }
    });
  } catch (e) {
    if (e && e.code === '23505') {
      return { error: 'That address already exists as another property on this customer.' };
    }
    throw e;
  }
  // pendingConfirmation carries the DOI bearer token (the link that ACTIVATES
  // the subscription) — it is consumed here for the post-commit re-send and
  // MUST NOT ride into the tool result: everything returned below reaches
  // model context and is recorded in ib_pending_actions.result. Only the
  // numeric counts are exposed.
  const { pendingConfirmation: emailPendingConfirmation, heldNewsletterResume: emailHeldNewsletterResume, ...emailSyncCounts } = emailSync || {};
  if (emailHeldNewsletterResume) {
    // Deferred held-newsletter DOI (2026-07-30 lane) — post-commit.
    // Fire-and-forget WITH an owner (Codex #3084 r47): an unexpected
    // escape lands in a logged rejection handler, never an unhandled
    // rejection. Sanitized code only.
    require('../lead-first-touch-resume').resumeHeldNewsletterPostCommit(emailHeldNewsletterResume)
      .catch((err) => logger.error(`[ib] deferred held-newsletter resume failed: ${err.code || err.name || 'resume_failed'}`));
  }
  if (emailPendingConfirmation) {
    // The moved DOI row's confirmation went to the old typo — re-send to the
    // corrected address now that the edit is committed (same
    // fire-and-forget-with-owner contract, r47).
    require('../customer-email-fanout').resendPendingConfirmation(emailPendingConfirmation)
      .catch((err) => logger.error(`[ib] deferred DOI re-send failed: ${err.code || err.name || 'resend_failed'}`));
  }
  if (addressSubmitted) {
    // Coords may point at the old address — clear + re-geocode, then re-mirror the
    // fresh coords onto the primary property (syncPrimaryAddress nulled them).
    await db('customers').where('id', customerId).update({ latitude: null, longitude: null });
    void require('../geocoder').ensureCustomerGeocoded(customerId)
      .then((coords) => coords && require('../customer-properties').syncPrimaryCoordsFromCustomer(customerId))
      .catch(() => {});
  }
  const after = await db('customers').where('id', customerId).first();

  const changes = {};
  for (const key of Object.keys(updates)) {
    const dbCol = UPDATABLE_FIELDS[key];
    if (dbCol && String(before[dbCol]) !== String(after[dbCol])) {
      changes[key] = { from: before[dbCol], to: after[dbCol] };
    }
  }

  // notes maps to free-text crm_notes (gate codes, access details) — redact
  // it from logs while still persisting the value.
  const logChanges = changes.notes ? { ...changes, notes: '[redacted]' } : changes;
  logger.info(`[intelligence-bar] Updated customer ${customerId}:`, logChanges);

  if (impliedLaneStamp) {
    // Post-commit review card for the auto-stamped lane — the shape a
    // mis-keyed duplicate takes, so the owner eyeballs it before the next
    // dues run. Fire-and-forget; never blocks the tool result.
    try {
      const NotificationService = require('../notification-service');
      void NotificationService.notifyAdmin(
        'billing_lane_review',
        `Billing lane stamped: ${after.first_name || ''} ${after.last_name || ''}`.trim(),
        'An Intelligence Bar edit left this customer with a WaveGuard tier and a positive monthly rate but no explicit billing lane — stamped monthly_membership (the lane this combination already inferred). Verify before the next dues run; if they actually bill per application, change the lane in the profile.',
        { icon: '\u{1F4B3}', link: `/admin/customers?customerId=${customerId}`, bell: true, metadata: { customerId, stamped: impliedLaneStamp, source: 'ib_update_customer' } },
      ).catch((err) => logger.warn(`[intelligence-bar] billing-lane review notify failed for ${customerId}: ${err.message}`));
    } catch (err) {
      logger.warn(`[intelligence-bar] billing-lane review notify setup failed for ${customerId}: ${err.message}`);
    }
  }

  return {
    success: true,
    customer_id: customerId,
    customer_name: `${after.first_name} ${after.last_name}`,
    changes,
    // Disclosed commit effect (#3140): this write made the customer an
    // implied monthly member, so the lane inference was stamped explicitly.
    ...(impliedLaneStamp ? {
      billing_lane_stamped: impliedLaneStamp,
      billing_lane_note: 'This edit gave the customer a membership tier and monthly rate with no billing lane set — billing_mode was stamped monthly_membership (matching the existing inference) and the owner was notified to verify the lane.',
    } : {}),
    // Operator-visible ripple of an email change (zeros/absent = no ripple):
    // how many open lead/estimate/newsletter copies were synced and how many
    // email review cards the correction resolved.
    ...(emailSync && Object.values(emailSyncCounts).some(Boolean) ? { email_sync: emailSyncCounts } : {}),
  };
}


async function bulkUpdateCustomers(customerIds, updates) {
  const clean = sanitizeUpdates(updates);
  Object.assign(clean, normalizeContactRecord(clean));
  if (Object.keys(clean).length <= 1) return { error: 'No valid fields to update' };
  if (!customerIds || !customerIds.length) return { error: 'No customer IDs provided' };

  // A bulk phone change re-points every row's primary number → drop their
  // line_type caches (no per-row before-state here, so clear unconditionally
  // when phone is part of the update).
  if (clean.phone !== undefined) clean.line_type = null;

  // Bulk stage moves mirror the canonical stageLifecycleStamps in SQL (CASE
  // per row, since there's no per-row before-state) — codex #3282 audit P1:
  // member_since alone left bulk-reactivated archived rows with active=false
  // and stale churn stamps, invisible to whereLiveCustomer.
  //  - into a live stage: activate, clear churn stamps, member_since per the
  //    old stage (former keeps its real start, lead gets conversion date)
  //  - into past_customer: archival relabel — churn history PRESERVED
  //  - into churned: stamp churned_at only for rows not already churned
  //    (never restamp an existing churn)
  //  - other lead-stage targets: clear stale churn stamps, like the route
  //  - pipeline_stage_changed_at only bumps on rows actually changing stage
  const formerOrCurrent = ['active_customer', 'won', 'at_risk', ...FORMER_CUSTOMER_STAGES];
  let stageStamp = {};
  if (clean.pipeline_stage && !ALL_PIPELINE_STAGES.includes(clean.pipeline_stage)) {
    return { error: `Invalid pipeline stage: ${clean.pipeline_stage}` };
  }
  if (clean.pipeline_stage) {
    // IS DISTINCT FROM, not <>: legacy NULL-stage rows must still get the
    // audit stamp (NULL <> x is NULL in Postgres, silently skipping them).
    stageStamp.pipeline_stage_changed_at = db.raw(
      'CASE WHEN pipeline_stage IS DISTINCT FROM ? THEN now() ELSE pipeline_stage_changed_at END',
      [clean.pipeline_stage]);
    if (['active_customer', 'won', 'at_risk'].includes(clean.pipeline_stage)) {
      stageStamp.member_since = db.raw(
        `CASE WHEN pipeline_stage IN (${formerOrCurrent.map(() => '?').join(',')}) THEN COALESCE(member_since, ?) ELSE ? END`,
        [...formerOrCurrent, etDateString(), etDateString()]);
      stageStamp.active = true;
      stageStamp.churned_at = null;
      stageStamp.churn_reason = null;
    } else if (clean.pipeline_stage === 'churned') {
      stageStamp.churned_at = db.raw(
        "CASE WHEN pipeline_stage = 'churned' THEN churned_at ELSE ? END", [etDateString()]);
      stageStamp.churn_reason = db.raw(
        "CASE WHEN pipeline_stage = 'churned' THEN churn_reason ELSE NULL END");
    }
    // Any other non-live target (past_customer/dormant/lost/lead stages):
    // archival/lateral move — churn history preserved until a REAL
    // reactivation into a live stage (codex #3282 r3, mirrors
    // stageLifecycleStamps).
  }

  // notes maps to free-text crm_notes — redact from logs (see updateCustomer).
  const logUpdates = updates.notes !== undefined ? { ...updates, notes: '[redacted]' } : updates;

  const addressSubmitted = ['address_line1', 'address_line2', 'city', 'state', 'zip']
    .some((f) => clean[f] !== undefined);
  const emailSubmitted = clean.email !== undefined;
  if (!addressSubmitted && !emailSubmitted) {
    // One transaction for the scalar write AND every ledger reset (codex
    // #3245 r3): a partial failure must roll back all of it — otherwise
    // the scalars commit while failed/later customers keep stale
    // components a subsequent accept could restore. Only customers whose
    // rate ACTUALLY changes reset (codex r6): setting the same value a
    // customer already has must not replace their family components with
    // an unattributed blob.
    // Tier/rate writes can transition rows into the implied-monthly shape
    // (#3140 — see updateCustomer): stamp those rows' billing_mode
    // explicitly in the same transaction. Per-row decision, since each
    // row's before-state differs under one shared update payload.
    const laneStampRelevant = clean.monthly_rate !== undefined || clean.waveguard_tier !== undefined;
    const { count, laneStampIds } = await db.transaction(async (trx) => {
      let rateChangedIds = [];
      let stampIds = [];
      if (laneStampRelevant) {
        // Membership-affecting bulk writes join the customer-comms
        // serialization (codex #3426 r6 P2) — same reason as updateCustomer.
        // Comms locks BEFORE the row locks below, and in a STABLE (sorted)
        // order so two concurrent bulk writers over overlapping id sets
        // acquire in the same sequence instead of deadlocking.
        for (const cid of [...customerIds].map(String).sort()) {
          await lockCustomerComms(trx, cid);
        }
        const beforeRows = await trx('customers')
          .whereIn('id', customerIds)
          .forUpdate()
          .select('id', 'monthly_rate', 'billing_mode', 'waveguard_tier');
        if (clean.monthly_rate !== undefined) {
          const newCents = Math.round((Number(clean.monthly_rate) || 0) * 100);
          rateChangedIds = beforeRows
            .filter((row) => Math.round((Number(row.monthly_rate) || 0) * 100) !== newCents)
            .map((row) => row.id);
        }
        const { impliedMonthlyStampForWrite } = require('../billing-lane');
        stampIds = beforeRows
          .filter((row) => impliedMonthlyStampForWrite(row, { ...row, ...clean }))
          .map((row) => row.id);
      }
      const updated = await trx('customers').whereIn('id', customerIds).update({ ...clean, ...stageStamp });
      if (stampIds.length) {
        await trx('customers').whereIn('id', stampIds).update({ billing_mode: 'monthly_membership' });
      }
      if (rateChangedIds.length) {
        const PlanRateLedger = require('../plan-rate-ledger');
        for (const cid of rateChangedIds) {
          await PlanRateLedger.syncScalarWriteToLedger(trx, cid, clean.monthly_rate, { source: 'ib_bulk_update' });
        }
      }
      return { count: updated, laneStampIds: stampIds };
    });
    logger.info(`[intelligence-bar] Bulk updated ${count} customers:`, logUpdates);
    notifyBulkLaneStamps(laneStampIds);
    return {
      success: true,
      updated_count: count,
      fields_updated: Object.keys(updates),
      ...bulkLaneStampResult(laneStampIds),
    };
  }

  // A bulk ADDRESS edit takes a per-row path so every row gets the same
  // consistency treatment as a single edit (see updateCustomer): primary
  // customer_properties mirror + lead/estimate snapshot fan-out ATOMICALLY,
  // then coords cleared + re-geocoded. The old single-statement path skipped
  // all of that, leaving property dedup keys, map pins, and snapshot copies
  // pointing at the old address.
  //
  // A bulk EMAIL edit takes the per-row path too (r21): assigning an email
  // MUST serialize with a concurrent merge-undo's claim probe under the
  // shared customer-email advisory lock, re-check the live claimant under
  // it, and run the email fan-out — the single-statement path bypassed all
  // three, so a bulk edit could hand another live customer's address out
  // and leave subscriber tokens/queued copies on the old mailbox.
  let count = 0;
  const errors = [];
  const perRowLaneStampIds = [];
  for (const customerId of customerIds) {
    const before = await db('customers').where('id', customerId).first();
    if (!before) {
      errors.push({ customer_id: customerId, error: 'Customer not found' });
      continue;
    }
    let emailSync = null;
    let rowLaneStamp = null;
    try {
      await db.transaction(async (trx) => {
        // Membership-affecting writes join the customer-comms serialization
        // (codex #3426 r6 P2) — same rule as the single-edit path: comms
        // lock BEFORE this row's lock. Per-row transactions each hold one
        // key, so no cross-row ordering concern on this branch.
        if (clean.waveguard_tier !== undefined || clean.monthly_rate !== undefined) {
          await lockCustomerComms(trx, customerId);
        }
        // Same row-lock serialization as the single-edit path.
        const lockedBefore = await trx('customers').where('id', customerId).forUpdate().first() || before;
        const lockedMerged = { ...lockedBefore, ...clean };
        if (emailSubmitted && clean.email) {
          const emailLc = String(clean.email).trim().toLowerCase();
          await trx.raw(
            'SELECT pg_advisory_xact_lock(hashtextextended(?, 0))',
            [`customer-email:${emailLc}`],
          );
          // Serialization ONLY — no claimant refusal (r23): shared
          // household addresses are supported (20260417000010); see
          // updateCustomer.
        }
        // Implied-monthly stamp (#3140) — same rule as updateCustomer, but
        // decided per row against a NEW update object: `clean` is shared
        // across the loop, so mutating it would leak one row's stamp onto
        // every later row.
        rowLaneStamp = require('../billing-lane').impliedMonthlyStampForWrite(lockedBefore, lockedMerged);
        await trx('customers').where('id', customerId).update(
          rowLaneStamp ? { ...clean, ...stageStamp, billing_mode: rowLaneStamp } : { ...clean, ...stageStamp },
        );
        if (clean.monthly_rate !== undefined
          && Math.round((Number(lockedBefore?.monthly_rate) || 0) * 100)
            !== Math.round((Number(clean.monthly_rate) || 0) * 100)) {
          // Same changed-rate-only ledger sync as the other branches
          // (codex #3245 r2/r6).
          await require('../plan-rate-ledger')
            .syncScalarWriteToLedger(trx, customerId, clean.monthly_rate, { source: 'ib_bulk_update' });
        }
        if (addressSubmitted) {
          await require('../customer-properties').syncPrimaryAddress(lockedMerged, trx);
          await require('../customer-address-fanout').propagateCustomerAddressChange({ before: lockedBefore, after: lockedMerged }, trx);
        }
        if (emailSubmitted) {
          emailSync = await require('../customer-email-fanout').propagateCustomerEmailChange(
            { before: lockedBefore, after: lockedMerged, source: 'Intelligence Bar bulk_update_customers' }, trx,
          );
        }
      });
    } catch (e) {
      if (e && e.code === '23505') {
        errors.push({ customer_id: customerId, error: 'That address already exists as another property on this customer.' });
        continue;
      }
      throw e;
    }
    const { pendingConfirmation: rowPendingConfirmation, heldNewsletterResume: rowHeldNewsletterResume } = emailSync || {};
    if (rowHeldNewsletterResume) {
      // Deferred held-newsletter DOI, post-commit — same contract as the
      // single-row paths (r32: the bulk branch dropped the resume, leaving
      // corrected customers' newsletter holds parked until stale reclaim).
      require('../lead-first-touch-resume').resumeHeldNewsletterPostCommit(rowHeldNewsletterResume)
        .catch((err) => logger.error(`[ib] deferred held-newsletter resume failed (bulk): ${err.code || err.name || 'resume_failed'}`));
    }
    if (rowPendingConfirmation) {
      // Post-commit DOI re-send, exactly as the single-edit path — the
      // bearer token never rides into the tool result.
      require('../customer-email-fanout').resendPendingConfirmation(rowPendingConfirmation)
        .catch((err) => logger.error(`[ib] bulk DOI re-send failed: ${err.code || err.name || 'resend_failed'}`));
    }
    if (addressSubmitted) {
      await db('customers').where('id', customerId).update({ latitude: null, longitude: null });
      void require('../geocoder').ensureCustomerGeocoded(customerId)
        .then((coords) => coords && require('../customer-properties').syncPrimaryCoordsFromCustomer(customerId))
        .catch(() => {});
    }
    if (rowLaneStamp) perRowLaneStampIds.push(customerId);
    count += 1;
  }
  logger.info(`[intelligence-bar] Bulk updated ${count} customers (address path):`, logUpdates);
  notifyBulkLaneStamps(perRowLaneStampIds);

  return {
    success: true,
    updated_count: count,
    fields_updated: Object.keys(updates),
    ...bulkLaneStampResult(perRowLaneStampIds),
    ...(errors.length ? { errors } : {}),
  };
}

// Shared disclosure/notification for the bulk implied-monthly stamps
// (#3140): the result names every stamped row (commit effects are never
// hidden from the operator), and the owner gets one review card per bulk
// write summarizing how many rows were stamped.
function bulkLaneStampResult(stampedIds = []) {
  if (!stampedIds.length) return {};
  return {
    billing_lane_stamped_customer_ids: stampedIds,
    billing_lane_note: `${stampedIds.length} customer${stampedIds.length === 1 ? '' : 's'} gained a membership tier and monthly rate with no billing lane set — billing_mode was stamped monthly_membership (matching the existing inference) and the owner was notified to verify the lanes.`,
  };
}

function notifyBulkLaneStamps(stampedIds = []) {
  if (!stampedIds.length) return;
  try {
    const NotificationService = require('../notification-service');
    void NotificationService.notifyAdmin(
      'billing_lane_review',
      `Billing lane stamped on ${stampedIds.length} customer${stampedIds.length === 1 ? '' : 's'}`,
      'An Intelligence Bar bulk edit left these customers with a WaveGuard tier and a positive monthly rate but no explicit billing lane — billing_mode was stamped monthly_membership (the lane the combination already inferred). Verify before the next dues run; any that actually bill per application need their lane changed in the profile.',
      { icon: '\u{1F4B3}', link: '/admin/customers', bell: true, metadata: { customerIds: stampedIds, stamped: 'monthly_membership', source: 'ib_bulk_update_customers' } },
    ).catch((err) => logger.warn(`[intelligence-bar] bulk billing-lane review notify failed: ${err.message}`));
  } catch (err) {
    logger.warn(`[intelligence-bar] bulk billing-lane review notify setup failed: ${err.message}`);
  }
}


// Structured property_preferences fields the IB may set. These render as their
// own labeled alerts on the tech's dispatch stop card (see routes/admin-schedule.js).
const PROPERTY_ACCESS_FIELDS = {
  neighborhood_gate_code: 'string', property_gate_code: 'string',
  garage_code: 'string', lockbox_code: 'string',
  parking_notes: 'string', side_gate_access: 'string', access_notes: 'string',
  pet_count: 'int', pet_details: 'string', pets_secured_plan: 'string',
  special_instructions: 'string',
};

// Access/lockbox codes are sensitive — never log their values (cf. the
// crm_notes log redaction in updateCustomer).
function sanitizePropertyAccess(input) {
  const clean = {};
  for (const [key, kind] of Object.entries(PROPERTY_ACCESS_FIELDS)) {
    if (input[key] === undefined || input[key] === null) continue;
    if (kind === 'int') {
      const n = parseInt(input[key], 10);
      if (Number.isFinite(n) && n >= 0) clean[key] = n;
    } else {
      clean[key] = String(input[key]).trim();
    }
  }
  return clean;
}

// Two-step write (issue #1568): no mutation without confirmed === true, which
// only /confirm-action attaches server-side. Registered in write-gates.js.
async function updatePropertyAccess(input) {
  const customerId = input.customer_id;
  if (!customerId) return { error: 'customer_id is required' };

  const updates = sanitizePropertyAccess(input);
  if (Object.keys(updates).length === 0) {
    return { error: 'No valid property-access fields to update' };
  }

  const customer = await db('customers').where('id', customerId).first();
  const customerName = customer
    ? `${customer.first_name || ''} ${customer.last_name || ''}`.trim()
    : null;

  if (input.confirmed !== true) {
    return {
      preview: true,
      customer_id: customerId,
      customer_name: customerName,
      would_update: updates,
      note: 'PREVIEW ONLY — nothing was saved. These go on the property profile and show as labeled alerts on the tech\'s stop card. After the operator approves, this commits via the confirmation card.',
    };
  }

  if (!customer) return { error: 'Customer not found' };

  const now = new Date();
  await db('property_preferences')
    .insert({ customer_id: customerId, ...updates, updated_at: now })
    .onConflict('customer_id')
    .merge({ ...updates, updated_at: now });

  // Log only which fields changed — codes/notes are sensitive.
  logger.info(`[intelligence-bar] Updated property access for customer ${customerId}: ${Object.keys(updates).join(', ')}`);

  return {
    success: true,
    customer_id: customerId,
    customer_name: customerName,
    updated_fields: Object.keys(updates),
  };
}


// Terminal scheduled_services statuses — one-way; never movable.
const TERMINAL_APPOINTMENT_STATUSES = ['completed', 'cancelled', 'skipped', 'no_show'];
// Live tracker-lifecycle statuses — movable, but the move must rewind the
// tracker lifecycle (rebooker LIVE_LIFECYCLE_RESET) so stale arrival
// timestamps don't survive onto the new date.
const LIVE_APPOINTMENT_STATUSES = ['en_route', 'on_site'];

// scheduled_date validation is the shared strict calendar-date helper
// (datetime-et.validScheduleDate) — same rules as schedule-tools' mover, so
// an impossible date like 2099-02-31 is rejected here, not normalized by JS
// Date into a real day or passed on to a raw PG cast error.

// Parse the tool's time_window contract — "morning" (8-12), "afternoon"
// (12-5), or a specific time like "9:00 AM" / "14:30" — into an HH:MM
// window start. Returns { start } (null start when no time was given) or
// { error } for garbage input, so callers return a clear tool error instead
// of a Postgres time-cast error.
function parseTimeWindowStart(timeWindow) {
  if (timeWindow == null || String(timeWindow).trim() === '') return { start: null };
  const raw = String(timeWindow).trim().toLowerCase();
  if (raw === 'morning') return { start: '08:00' };
  if (raw === 'afternoon') return { start: '12:00' };
  const m = raw.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!m) {
    return { error: `Unrecognized time_window "${timeWindow}" — use "morning", "afternoon", or a time like "9:00 AM" or "14:30"` };
  }
  let hour = parseInt(m[1], 10);
  const minute = m[2] ? parseInt(m[2], 10) : 0;
  if (m[3] === 'pm' && hour < 12) hour += 12;
  if (m[3] === 'am' && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) {
    return { error: `Unrecognized time_window "${timeWindow}" — use "morning", "afternoon", or a time like "9:00 AM" or "14:30"` };
  }
  // Appointment windows start ON THE HOUR (owner rule — every creator
  // enforces it; Codex #3109 r33 flagged this tool as the bypass). Reject
  // rather than silently rounding: the operator asked for a specific time
  // and the model can re-ask with the corrected value.
  if (minute !== 0) {
    return { error: `Appointment windows start on the hour — got "${timeWindow}"; use e.g. "${hour > 12 ? hour - 12 : hour || 12}:00 ${hour >= 12 ? 'PM' : 'AM'}"` };
  }
  return { start: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}` };
}

// Window length + end derivation are the shared datetime-et helpers
// (windowDurationMinutes / deriveWindowEnd). deriveWindowEnd returns null on
// a midnight-crossing end instead of the old local modulo-24h wrap, which
// turned an accepted 23:30 start into a 23:30–00:30 same-day block — a
// non-positive span invisible to the overlap predicates and nonsense to the
// elapsed guard.

async function createAppointment(input) {
  const { customer_id, scheduled_date, service_type, technician_name, time_window, notes } = input;

  const dateStr = validScheduleDate(scheduled_date);
  if (!dateStr) {
    return { error: `scheduled_date must be a valid YYYY-MM-DD date that is not in the past (got "${scheduled_date}")` };
  }
  const win = parseTimeWindowStart(time_window);
  if (win.error) return { error: win.error };

  // Flat-60 convention (admin-schedule: every service call defaults to 60
  // minutes) so overlap checks see a real block, not an open-ended start.
  // deriveWindowEnd returns null when start+60 would cross midnight — the
  // old modulo wrap turned a 23:30 start into a 23:30–00:30 same-day block
  // no overlap predicate could see. Reject up front, before any DB read.
  let windowEnd = win.start ? deriveWindowEnd(win.start, 60) : null;
  if (win.start && !windowEnd) {
    return { error: 'That window would cross midnight — pick an earlier start.' };
  }
  // Shared admin window rules on the EFFECTIVE window (start + flat-60 end):
  // >= 08:00, end <= day end, on the hour. parseTimeWindowStart accepted
  // 07:00 / 20:00 and this tool persisted them directly, bypassing every
  // other creator's validator. Surfaced as the tool's error result.
  if (win.start) {
    try {
      ({ window_end: windowEnd } = assertAdminAppointmentWindow({ windowStart: win.start, windowEnd, durationMinutes: 60 }));
    } catch (err) {
      if (err?.status === 422) return { error: err.message };
      throw err;
    }
  }

  const customer = await db('customers').where('id', customer_id).first();
  if (!customer) return { error: 'Customer not found' };

  // Find technician if specified
  let technician_id = null;
  if (technician_name) {
    const tech = await db('technicians').whereILike('name', `%${technician_name}%`).first();
    if (tech) technician_id = tech.id;
  }

  // A today target whose window already elapsed in ET is unreachable — the
  // visit lands in a past window no route can serve. Same cutoff logic the
  // rebooker uses (datetime-et.sameDayWindowElapsed); a today target with no
  // specific time, or a still-future window, is still allowed.
  if (sameDayWindowElapsed(dateStr, windowEnd || win.start)) {
    return { error: 'That time has already passed today — pick a later window or a future date.' };
  }

  // status 'pending', matching the column default and every other writer —
  // 'scheduled' is not in the scheduled_services status CHECK set and threw
  // on every insert. track_token_expires_at is stamped by the INSERT trigger
  // (set_default_track_token_expiry).
  // Rung 6 (scheduling/occupancy.js ORDERING CONTRACT): comms-lock the
  // customer around the insert — this path had no transaction, and a bare
  // advisory xact lock outside one fences nothing. withCustomerCommsLock
  // opens the transaction, so the inspection-credit evidence below commits
  // inside the same fenced trx.
  // Inspection credit: an operator booking through the Intelligence Bar is
  // a REAL customer booking (Codex #3178 r5 P0), so the durable evidence
  // commits IN THE SAME TRANSACTION as the appointment (r31 P2) — a crash
  // between a bare insert and a follow-up event write left a live booking
  // the sweep refuses to infer from (bare rows can be seeders), stranding
  // any open offer. The marker runs in a savepoint, so an evidence hiccup
  // still never blocks the booking.
  let appointment;
  let overlapAdvisory = null;
  await db.transaction(async (trx) => {
    // Rung 1 (scheduling/occupancy.js ORDERING CONTRACT) — the date-wide
    // occupancy lock + tech-blind probe FIRST, before the comms key (rung
    // 6) and the insert's row locks; mirrors the lead-booking route. A hit
    // is advisory (owner ruling 2026-08-25 — staff-side saves never block
    // on schedule conflicts): the booking commits with a warning.
    if (win.start && windowEnd) {
      const overlap = await probeSlotOverlap({ trx, date: dateStr, windowStart: win.start, windowEnd });
      if (overlap.length) overlapAdvisory = slotOverlapWarning(dateStr);
    }
    // Rung 6 — the same comms fence withCustomerCommsLock provided.
    await lockCustomerComms(trx, customer_id);
    const [created] = await trx('scheduled_services').insert({
      customer_id,
      scheduled_date: dateStr,
      service_type,
      technician_id,
      status: 'pending',
      window_start: win.start,
      window_end: windowEnd,
      notes: notes || null,
      created_at: new Date(),
      updated_at: new Date(),
    }).returning('*');
    appointment = created;
    await require('../inspection-credit').markBookingForInspectionCredit(trx, {
      customerId: customer_id,
      scheduledServiceId: created.id,
      source: 'intelligence_bar',
    });
  });

  try {
    // Fast redemption post-commit, mirroring the admin-schedule/self-book
    // paths (Codex #3178 r26 P2): the marker alone leaves the credit
    // unminted until the hourly sweep, and a Charge Now / pay link sent in
    // that window collects the full amount while the credit strands
    // afterwards. Best-effort — the sweep remains the durable guarantee.
    await require('../inspection-credit').redeemInspectionCreditForBooking({
      customerId: customer_id,
      scheduledServiceId: appointment.id,
      createdBy: 'system:inspection_credit_ib_booking',
    });
  } catch { /* redemption is best-effort; the booking stands */ }

  // Register the durable confirmation/reminder row synchronously with the
  // insert, like the canonical admin create path (admin-schedule POST) —
  // without it the 72h/24h reminder cron never sees the visit. Registration
  // only: sendConfirmation:false marks the confirmation not-applicable
  // (mirroring an admin-created visit with the "Send confirmation SMS"
  // checkbox off), so no SMS goes out — sends stay operator-initiated.
  //
  // Windowless creates ("put this customer on Friday") register at the
  // canonical date+08:00 slot time — the convention the reminder DB sync
  // trigger, the self-heal sweep, and the same-slot dedup all COALESCE on —
  // but with BOTH reminder windows pre-closed (closeReminderWindows): the
  // 72h/24h texts render the appointment_time's clock time, so an armed
  // windowless row would promise "at 8:00 AM" for a time nobody chose.
  // Skipping registration instead would not help: selfHealMissingReminderRows
  // registers any row-less future visit at 08:00 ARMED within 15 minutes.
  // When a real window is later set, the sync trigger's time_changed branch
  // re-arms the windows from the real start, so reminders resume with a time
  // the operator actually picked.
  //
  // Best-effort like the admin path: a registration failure must not fail
  // the already-committed insert (registerAppointment also self-alerts).
  try {
    const AppointmentReminders = require('../appointment-reminders');
    await AppointmentReminders.registerAppointment(
      appointment.id, customer_id,
      `${dateStr}T${win.start || '08:00'}`,
      service_type, 'admin_ib',
      { sendConfirmation: false, closeReminderWindows: !win.start },
    );
  } catch (err) {
    logger.error(`[intelligence-bar] reminder registration failed for appointment ${appointment.id}: ${err.message}`);
  }

  // Ids only — customer names/phones/addresses never go to logs (PII rule).
  logger.info(`[intelligence-bar] Created appointment ${appointment.id} for customer ${customer_id} on ${dateStr}`);

  return {
    success: true,
    appointment_id: appointment.id,
    customer_name: `${customer.first_name} ${customer.last_name}`,
    date: dateStr,
    service_type,
    technician: technician_name || 'Unassigned',
    // Advisory occupancy-overlap note (gated probe) — the booking stands.
    ...(overlapAdvisory ? { warning: overlapAdvisory } : {}),
  };
}


async function rescheduleAppointment(input) {
  const { appointment_id, new_date, new_time_window, reason } = input;

  const appt = await db('scheduled_services').where('id', appointment_id).first();
  if (!appt) return { error: 'Appointment not found' };

  // Terminal rows are one-way — a completed/cancelled visit must not quietly
  // come back to life on a new date.
  if (TERMINAL_APPOINTMENT_STATUSES.includes(String(appt.status))) {
    return { error: `Cannot reschedule a ${appt.status} appointment` };
  }

  const dateStr = validScheduleDate(new_date);
  if (!dateStr) {
    return { error: `new_date must be a valid YYYY-MM-DD date that is not in the past (got "${new_date}")` };
  }
  const win = parseTimeWindowStart(new_time_window);
  if (win.error) return { error: win.error };

  const oldDate = appt.scheduled_date;

  // Preserve the original visit's window length when a new start is given.
  // Persisting only window_start against a stale window_end collapses the
  // window to zero (09:00→10:00 against a stored 10:00 end) — token expiry
  // and the audit log both read window_end, so both would break. The shared
  // deriveWindowEnd returns null when the preserved duration would carry the
  // end past midnight — reject rather than persist a wrapped, inverted block.
  const apptDuration = windowDurationMinutes(appt.window_start, appt.window_end, appt.estimated_duration_minutes);
  const newStart = win.start || appt.window_start;
  let newWindowEnd = win.start
    ? deriveWindowEnd(win.start, apptDuration)
    : appt.window_end;
  if (win.start && !newWindowEnd) {
    return { error: 'That window would cross midnight — pick an earlier start.' };
  }
  // Shared admin window rules on the EFFECTIVE window the move will persist
  // (supplied-or-stored start, derived-or-stored end, stored duration for an
  // end-less row): >= 08:00, end <= day end. A windowless row (both null)
  // moves date-only. Surfaced as the tool's error result.
  // Overlap: the CAS update below now runs inside db.transaction, so the
  // gated rung-1 lock + probe fences this move too (see below).
  // The validator also hands back the EFFECTIVE block this visit will
  // occupy. On an END-LESS row a date-only move persists end null but still
  // occupies start + estimated_duration_minutes, so the probe window below
  // is the DERIVED pair, not the persisted one — keying the probe off
  // newWindowEnd skipped the overlap check entirely on exactly those rows
  // (gate on, occupied destination, no refusal).
  let probeWindowStart = null;
  let probeWindowEnd = null;
  if (newStart || newWindowEnd) {
    try {
      const normalizedWindow = assertAdminAppointmentWindow({
        windowStart: newStart, windowEnd: newWindowEnd, durationMinutes: apptDuration,
      });
      probeWindowStart = normalizedWindow.window_start;
      probeWindowEnd = normalizedWindow.window_end;
      if (win.start) newWindowEnd = normalizedWindow.window_end;
    } catch (err) {
      if (err?.status === 422) return { error: err.message };
      throw err;
    }
  }

  const customer = await db('customers').where('id', appt.customer_id).first();

  // A today target whose effective window already elapsed in ET is unreachable
  // — moving into a past window strands the visit. Same cutoff logic as the
  // rebooker (window_end preferred, else start); a still-future today window
  // is allowed.
  if (sameDayWindowElapsed(dateStr, newWindowEnd || newStart)) {
    return { error: 'That window has already passed today — pick a later window or a future date.' };
  }

  // Moving a live (en_route/on_site) visit rewinds the tracker lifecycle the
  // same way the rebooker does, so stale arrival timestamps can't poison
  // duration capture on the new date. Lazy require: rebooker is heavy.
  const {
    LIVE_LIFECYCLE_RESET, applyLiveMoveSideEffects, applyLiveMovePostCommitEffects,
    needsLifecycleRewind, applyTrackLifecycleCas,
  } = require('../rebooker');
  const wasLive = LIVE_APPOINTMENT_STATUSES.includes(String(appt.status));
  // Rewind on stale evidence too, not just live status — see
  // needsLifecycleRewind in rebooker.js. The status flip and the history
  // append stay keyed on wasLive; an evidence-only rewind still gets the
  // post-commit tracker cleanup below (tech pointer + customer refresh)
  // without recording a status transition that never happened. Gated on
  // the DATE actually changing: a same-date window edit of a visit with
  // genuine same-day tracker state must not erase the active attempt.
  const apptDay = appt.scheduled_date instanceof Date
    ? appt.scheduled_date.toISOString().slice(0, 10)
    : (appt.scheduled_date ? String(appt.scheduled_date).slice(0, 10) : null);
  const trackRewound = !wasLive && dateStr !== apptDay && needsLifecycleRewind(appt);
  const liveReset = wasLive || trackRewound ? LIVE_LIFECYCLE_RESET : {};

  // Compare-and-swap on the OBSERVED status + schedule fields: the terminal
  // guard and the wasLive classification above came from the initial read —
  // if the visit completed (or got cancelled / went live) between that read
  // and this write, an update by id alone would apply the stale branch and
  // rewrite a terminal row back onto the schedule. Status alone also let two
  // ORDINARY moves of the same confirmed row both match — the later write
  // silently clobbered the newer date/window and logged from a stale
  // snapshot. Matching the observed scheduled_date + window_start makes the
  // later writer miss instead (knex renders a null value in the object form
  // as IS NULL — the same contract auto-dispatch's rebooker `expect` relies
  // on). window_end is in the predicate too: the UPDATE below always writes
  // it from this pre-read — verbatim on a date-only move, and via the
  // preserved-duration derivation on a timed one — so a concurrent edit that
  // only resized the END (the bulk route's explicit-end form) would otherwise
  // still match on start alone and get its end silently restored from the
  // stale snapshot. Field-level CAS is the repo's established pattern for
  // exactly this (rebooker options.expect); deliberately NOT
  // SELECT..FOR UPDATE, which would put a row lock + transaction around a
  // quick single-row mover for no added safety. updated_at stays out of the
  // predicate: knex never auto-touches it and not every mover stamps it (the
  // bulk route's UPDATE doesn't), so it isn't a reliable change marker. Zero
  // rows matched = the row changed under us; refuse instead of writing.
  const observedDate = appt.scheduled_date instanceof Date
    ? appt.scheduled_date.toISOString().slice(0, 10)
    : (appt.scheduled_date ? String(appt.scheduled_date).slice(0, 10) : null);
  // The move runs in a transaction so the occupancy probe can fence it
  // (a bare advisory xact lock outside a trx fences nothing). Rung 1 of
  // scheduling/occupancy.js's ORDERING CONTRACT — the date-wide lock + the
  // tech-blind probe — is taken FIRST, before the row write, exactly as the
  // create path above does; the moving visit excludes itself. A conflict is
  // advisory (owner ruling 2026-08-25 — staff-side saves never block on
  // schedule conflicts): the move commits and the tool result carries a
  // warning.
  let updatedRows = 0;
  let overlapAdvisory = null;
  await db.transaction(async (trx) => {
      if (probeWindowStart && probeWindowEnd) {
        const overlap = await probeSlotOverlap({
          trx,
          date: dateStr,
          windowStart: probeWindowStart,
          windowEnd: probeWindowEnd,
          excludeServiceIds: [appointment_id],
        });
        if (overlap.length) overlapAdvisory = slotOverlapWarning(dateStr);
      }
      updatedRows = await applyTrackLifecycleCas(
        trx('scheduled_services')
          .where('id', appointment_id)
          .where('status', String(appt.status))
          .where({
            scheduled_date: observedDate,
            window_start: appt.window_start ?? null,
            window_end: appt.window_end ?? null,
            // Duration pin, only when this move's window math DEPENDED on the
            // column: on a row with a start and NO end, apptDuration is the
            // estimated_duration_minutes fallback, and it sets both the
            // persisted end of a start-only move and the probed block of a
            // date-only one. A concurrent duration-only edit changes the block
            // the visit occupies, so this write must miss and surface the
            // concurrent-change error rather than land a span built on the
            // stale value — the same safeguard rebooker.js's CAS applies
            // (codex #3377 P1). A row with a real stored span never reads the
            // column, and a WINDOWLESS row (both null) has no block at all, so
            // both stay out of the predicate. (A stored end without a start is
            // 422'd by the validator above and never reaches this write.)
            ...((appt.window_start && !appt.window_end)
              ? { estimated_duration_minutes: appt.estimated_duration_minutes ?? null }
              : {}),
          }),
        // The full observed tracker/lifecycle snapshot is in the CAS: a
        // geofence/manual transition between the read and this write can
        // advance track_state, add stamps to a same-state row, or stamp an
        // SMS guard — any of it must make this miss instead of moving the
        // visit on a stale snapshot. See applyTrackLifecycleCas.
        appt,
      )
        .update({
          scheduled_date: dateStr,
          window_start: newStart,
          window_end: newWindowEnd,
          // A DATE move carries the stop into another tech-day: clear its
          // route_order (fence-or-clear contract — NULL appends after the
          // destination day's ordered run; the CAS above already makes a
          // stale-snapshot write miss). Same-day window changes keep it.
          ...(dateStr !== observedDate ? { route_order: null } : {}),
          notes: reason ? `${appt.notes || ''}\nRescheduled: ${reason}`.trim() : appt.notes,
          // Public track links live until the day after the visit — refresh onto
          // the new date, same as schedule-tools' movers. Built off the root
          // knex on purpose: it is a bound VALUE fragment, not a query — it
          // executes as part of this trx's UPDATE.
          track_token_expires_at: scheduledServiceTrackTokenExpiry(db, dateStr, newWindowEnd),
          // LIVE_LIFECYCLE_RESET clears the tracker fields but not status — a moved
          // en_route/on_site row would keep a live status on a future date. Land it
          // back on 'confirmed' in the same UPDATE, matching the rebooker's own path.
          ...(wasLive ? { status: 'confirmed' } : {}),
          ...liveReset,
          updated_at: new Date(),
        });
  });
  if (updatedRows === 0) {
    return { error: 'Appointment changed concurrently (status, date, or window) while the reschedule was pending — nothing was moved. Re-check the appointment and retry if still applicable.' };
  }

  // Rebooker-parity side effects of the live → confirmed flip above:
  // job_status_history audit row, tech_status release, customer tracker
  // refresh. Best-effort: the move is committed — a side-effect failure
  // must not report the move itself as failed.
  if (wasLive) {
    try {
      await applyLiveMoveSideEffects(db, appt);
    } catch (err) {
      logger.error(`[intelligence-bar] live-move side effects failed for ${appointment_id}: ${err.message}`);
    }
  } else if (trackRewound) {
    // No status transition happened (status was never live), so no history
    // row — but the tracker rewind still released a manual En Route tap's
    // state: free the tech pointer and refresh any open customer tracker
    // with the row's unchanged status.
    try {
      await applyLiveMovePostCommitEffects(appt, { toStatus: appt.status });
    } catch (err) {
      logger.error(`[intelligence-bar] track-rewind side effects failed for ${appointment_id}: ${err.message}`);
    }
  }

  // Audit row, matching the rebooker's reschedule_log conventions.
  // Best-effort: the move above is already committed — a log failure must
  // not report the move itself as failed.
  try {
    await db('reschedule_log').insert({
      scheduled_service_id: appointment_id,
      customer_id: appt.customer_id,
      original_date: oldDate,
      new_date: dateStr,
      reason_code: 'admin',
      initiated_by: 'admin_ib',
      original_window: appt.window_start ? `${appt.window_start}-${appt.window_end}` : null,
      new_window: newStart
        ? (newWindowEnd ? `${newStart}-${newWindowEnd}` : newStart)
        : null,
      notes: reason || null,
    });
  } catch (err) {
    logger.error(`[intelligence-bar] reschedule_log insert failed for ${appointment_id}: ${err.message}`);
  }

  logger.info(`[intelligence-bar] Rescheduled appointment ${appointment_id} from ${oldDate} to ${dateStr}`);

  return {
    success: true,
    appointment_id,
    customer_name: customer ? `${customer.first_name} ${customer.last_name}` : 'Unknown',
    old_date: oldDate,
    new_date: dateStr,
    service_type: appt.service_type,
    // Advisory occupancy-overlap note (gated probe) — the move stands.
    ...(overlapAdvisory ? { warning: overlapAdvisory } : {}),
  };
}


async function cancelAppointment(input) {
  const { appointment_id, reason } = input;

  const appt = await db('scheduled_services').where('id', appointment_id).first();
  if (!appt) return { error: 'Appointment not found' };

  // Terminal statuses are one-way (#2717) — that guard lives in the ROUTE
  // callers, not transitionJobStatus, so this tool must enforce it itself
  // (Codex r4): cancelling a completed visit would erase delivered work and
  // trigger the follow-up re-park hook for a treatment that already
  // happened. Idempotent on an already-cancelled row; every other terminal
  // state is an error, matching rescheduleAppointment above.
  if (String(appt.status) === 'cancelled') {
    // Retry of an already-committed cancellation: the post-commit re-park
    // hook may have failed transiently on the first attempt, and this early
    // return is the only path a retry reaches — re-attempt the
    // dedup-guarded re-park here, exactly like the alreadyNoShow status
    // routes (Codex r5 on PR #3091).
    {
      const { handleFollowupChildCancellation } = require('../typed-followup-obligation');
      void handleFollowupChildCancellation({ jobId: appointment_id, toStatus: 'cancelled' }).catch(() => {});
    }
    // The money seam runs on the REPLAY path too (Codex #3178 r22 P1): a
    // process exit between the committed cancellation and the post-commit
    // call below leaves this early return as the only path a retry reaches,
    // and the credited $75 would stay spendable until the hourly sweep.
    // Idempotent — the void helper skips resolved invoices and the reversal
    // finds no redeemed offer once it has already run.
    try {
      await require('../invoice').voidOpenInvoicesForCancelledService(appointment_id);
    } catch (e) {
      logger.error(`[intelligence-bar] cancel replay void sweep failed for ${appointment_id}: ${e.message}`);
    }
    return {
      success: true,
      appointment_id,
      already_cancelled: true,
      date: appt.scheduled_date,
      service_type: appt.service_type,
    };
  }
  if (TERMINAL_APPOINTMENT_STATUSES.includes(String(appt.status))) {
    return { error: `This appointment is already ${appt.status} and can't be cancelled.` };
  }

  // Route through the SHARED status writer, not a direct status update
  // (Codex r3 on PR #3091): transitionJobStatus is where the cross-cutting
  // cancellation behavior lives — the atomic racing-transition guard, the
  // job_status_history audit row, socket board updates, overdue-alert
  // auto-resolution, and the follow-up obligation re-park hook. A direct
  // UPDATE silently skipped all of it. The reason append rides the SAME
  // caller-owned transaction as the transition (Codex r5): a crash between
  // separate writes would report failure for a committed cancellation, and
  // the retry's already_cancelled return would never persist the reason.
  try {
    const { transitionJobStatus } = require('../job-status');
    await db.transaction(async (trx) => {
      await transitionJobStatus({
        jobId: appointment_id,
        fromStatus: appt.status,
        toStatus: 'cancelled',
        transitionedBy: null,
        notes: reason ? `Cancelled via Intelligence Bar: ${reason}` : 'Cancelled via Intelligence Bar',
        trx,
      });
      if (reason) {
        await trx('scheduled_services').where('id', appointment_id).update({
          notes: `${appt.notes || ''}\nCancelled: ${reason}`.trim(),
          updated_at: new Date(),
        });
      }
    });
  } catch (err) {
    if (err && err.message && err.message.includes('not in state')) {
      return { error: 'Appointment status changed while cancelling (concurrent update) — refresh and try again.' };
    }
    throw err;
  }

  // Void any still-open pre-minted invoice and reverse the inspection
  // credit IMMEDIATELY (Codex #3178 r21 P1) — the shared money seam every
  // other cancel surface runs (the reversal rides the void helper's
  // finally); without it a credited booking cancelled from the
  // Intelligence Bar left the $75 spendable until the hourly sweep.
  // Best-effort after the committed transition, same as the status routes.
  try {
    await require('../invoice').voidOpenInvoicesForCancelledService(appointment_id);
  } catch (e) {
    logger.error(`[intelligence-bar] cancel invoice void sweep failed for ${appointment_id}: ${e.message}`);
  }

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


// ── search_field_intelligence ───────────────────────────────────
// Read-only. Trusted tiers only (review_status auto/approved) — the
// exception-based review gate decides what agents may read.
//
// With GATE_HYBRID_KNOWLEDGE on, a vector+FTS+RRF pass (lane A2) runs
// alongside the lane-A1 unified search: hybrid-discovered wiki/KB pages the
// FTS lists missed (paraphrase recall) are merged in, and matches from the
// wider operational corpus (services, protocols, product labels, county
// rules, prep guides, ops rules) surface as operationalKnowledge. Gate off
// or hybrid unavailable → exactly the A1 behavior.
async function searchFieldIntelligence(input) {
  const query = String(input?.query || '').trim();
  if (!query) return { error: 'query is required' };

  const KnowledgeBridge = require('../knowledge-bridge');
  const { claudeopedia, wiki, bridged } = await KnowledgeBridge.unifiedSearch(query, { limit: 6, trustedOnly: true });

  let hybrid = null;
  const { isEnabled } = require('../../config/feature-gates');
  if (isEnabled('hybridKnowledge')) {
    try {
      hybrid = await require('../knowledge-index/hybrid-search').hybridKnowledgeSearch(query, { limit: 12 });
    } catch (err) {
      logger.warn(`[intelligence-bar] hybrid knowledge search unavailable: ${err.message}`);
    }
  }

  // Vector recall: hybrid can surface trusted wiki/KB pages whose vocabulary
  // never matches the query tokens. Fetch the ones unifiedSearch missed so
  // the sections below include them (trust gates re-applied here).
  const hybridSlugs = (source) => (hybrid?.results || []).filter((r) => r.source === source).map((r) => r.sourceId);
  const missingWikiSlugs = hybridSlugs('wiki').filter((slug) => !wiki.some((w) => w.slug === slug));
  const missingKbSlugs = hybridSlugs('kb').filter((slug) => !claudeopedia.some((k) => k.slug === slug));
  if (missingWikiSlugs.length) {
    try {
      const { TRUSTED_STATUSES } = require('../agronomic-wiki');
      const extra = await db('knowledge_entries')
        .whereIn('slug', missingWikiSlugs)
        .whereIn('review_status', TRUSTED_STATUSES)
        .select('id', 'slug', 'title', 'category', 'confidence', 'data_point_count', 'updated_at', 'kb_entry_id', 'review_tier', 'review_status');
      wiki.push(...extra.map((e) => ({ ...e, source: 'agronomic_wiki' })));
    } catch { /* vector recall is additive-only */ }
  }
  if (missingKbSlugs.length) {
    try {
      const extra = await db('knowledge_base')
        .whereIn('slug', missingKbSlugs)
        .where({ status: 'active' })
        .select('id', 'slug', 'title', 'category', 'confidence', 'updated_at', 'wiki_entry_id');
      claudeopedia.push(...extra.map((e) => ({ ...e, source: 'claudeopedia' })));
    } catch { /* vector recall is additive-only */ }
  }

  // Attach summaries/snippets — unifiedSearch returns metadata only.
  let wikiRows = wiki || [];
  try {
    const ids = wikiRows.map((w) => w.id).filter(Boolean);
    if (ids.length) {
      const summaries = await db('knowledge_entries').whereIn('id', ids).select('id', 'summary');
      const byId = Object.fromEntries(summaries.map((r) => [r.id, r.summary]));
      wikiRows = wikiRows.map((w) => ({ ...w, summary: byId[w.id] || null }));
    }
  } catch { /* summaries optional */ }

  let kbRows = claudeopedia || [];
  try {
    const kbIds = kbRows.map((k) => k.id).filter(Boolean);
    if (kbIds.length) {
      const contents = await db('knowledge_base').whereIn('id', kbIds).select('id', 'content', 'wiki_entry_id');
      const byId = Object.fromEntries(contents.map((r) => [r.id, r]));
      kbRows = kbRows.map((k) => ({
        ...k,
        snippet: (byId[k.id]?.content || '').substring(0, 500) || null,
        wiki_entry_id: byId[k.id]?.wiki_entry_id ?? null,
      }));
    }
  } catch { /* snippets optional */ }

  // Open contradictions against EVERY returned hit — wiki pages, KB rows
  // (contradictions also link by kb_entry_id), and the wiki pages that KB
  // hits mirror/link. A KB-only hit must still carry its warning.
  let openContradictions = [];
  try {
    const wikiIds = new Set(wikiRows.map((w) => w.id).filter(Boolean));
    for (const k of kbRows) if (k.wiki_entry_id) wikiIds.add(k.wiki_entry_id);
    const kbIds = kbRows.map((k) => k.id).filter(Boolean);
    if (wikiIds.size || kbIds.length) {
      openContradictions = await db('knowledge_contradictions')
        .where(function () {
          if (wikiIds.size) this.orWhereIn('wiki_entry_id', [...wikiIds]);
          if (kbIds.length) this.orWhereIn('kb_entry_id', kbIds);
        })
        .whereNotIn('status', ['resolved', 'dismissed'])
        .select('contradiction_type', 'description', 'severity', 'status');
    }
  } catch { /* table may not exist */ }

  // Operational corpus hits (hybrid only): services, protocols, product
  // labels, county fertilizer rules, prep guides, ops rules.
  const operationalKnowledge = (hybrid?.results || [])
    .filter((r) => r.source !== 'wiki' && r.source !== 'kb')
    .slice(0, 6)
    .map((r) => ({ source: r.source, ref: r.sourceId, title: r.title, snippet: r.snippet }));

  return {
    query,
    fieldIntelligence: wikiRows.map((w) => ({
      slug: w.slug,
      title: w.title,
      category: w.category,
      confidence: w.confidence,
      dataPoints: w.data_point_count,
      tier: w.review_tier,
      summary: w.summary,
    })),
    knowledgeBase: kbRows.map((k) => ({
      slug: k.slug,
      title: k.title,
      category: k.category,
      confidence: k.confidence,
      snippet: k.snippet,
    })),
    ...(operationalKnowledge.length ? { operationalKnowledge } : {}),
    ...(hybrid ? { searchMode: hybrid.usedVector ? 'hybrid' : 'hybrid_fts_only' } : {}),
    bridgedPairs: (bridged || []).length,
    openContradictions,
    note: 'fieldIntelligence = AI-maintained outcome wiki (trusted tiers only, field intelligence not label authority); knowledgeBase = curated operational knowledge; operationalKnowledge (when present) = services/protocols/product-label/county-rule/prep-guide/past-resolution matches — cite source + ref; "resolution" entries are how similar past calls/visits were actually handled (PII-redacted, recency-decayed). Cite slugs, state confidence, and surface open contradictions.',
  };
}

module.exports = { TOOLS, executeTool };
