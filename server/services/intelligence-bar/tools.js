const { recurringDispatchDuePatch } = require('../scheduling/recurring-dispatch-due');
/**
 * Intelligence Bar — Claude Tool Definitions & Execution
 * server/services/intelligence-bar/tools.js
 *
 * These tools give Claude direct read/write access to the Waves database
 * for natural-language admin queries. Claude picks the right tool(s)
 * based on the operator's prompt.
 */

const db = require('../../models/db');
const { lockCustomerComms, lockSmsPhone } = require('../../utils/customer-comms-lock');
// Shared admin window rules + gated occupancy probe (scheduling/window-rules.js).
const { assertAdminAppointmentWindow, probeSlotOverlap, slotOverlapWarning } = require('../scheduling/window-rules');
const logger = require('../logger');
const { applyAssignable, assertAssignableTechnician } = require('../technician-eligibility');
const { createDefaultCustomerRows } = require('../customer-default-rows');
const { isAlwaysFreeServiceType } = require('../no-cost-visit-types');
const { resolveBillingLane } = require('../billing-lane');
const { stampPrimaryLineDiscount, stampPricingRegimeMarker, capsSnapshotFromPricing } = require('../booking/visit-financial-stamps');
const { discountStackingLive } = require('../../config/feature-gates');
const {
  etDateString, addETDays, validScheduleDate, sameDayWindowElapsed, dateOnlyString,
  windowDurationMinutes, deriveWindowEnd,
} = require('../../utils/datetime-et');
const { FORMER_CUSTOMER_STAGES, ALL_PIPELINE_STAGES, stageLifecycleStamps } = require('../customer-stages');
const { scheduledServiceTrackTokenExpiry } = require('../track-token-expiry');
const { effectiveServiceAddress } = require('../stamped-address');
const { formatAddress } = require('../../utils/address-normalizer');
const { EMAIL_FANOUT_DISCLOSURE } = require('../customer-email-fanout');
const { CONTACT_FANOUT_DISCLOSURE, CONTACT_FANOUT_PHONE_HOLD_CLAUSE } = require('../customer-contact-fanout');
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
            has_email: { type: 'boolean' },
            has_city: { type: 'boolean' },
            has_phone: { type: 'boolean' },
            has_address: { type: 'boolean' },
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
        offset: { type: 'integer', minimum: 0, description: 'Continue from next_offset in the previous result' },
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
service_category: "pest" (quarterly = 90 days), "lawn" (monthly = 30 days), "mosquito" (21 days), "tree_shrub" (per customer: bi-monthly 60 days, every 6 weeks 42 days, grandfathered quarterly 90 days), "termite" (annual).
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
    description: 'Get customer profile, active saved properties, linked account profiles, and bounded pages of service history, appointments and invoices. Read coverage before claiming any source is empty.',
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
        offset: { type: 'integer', minimum: 0, description: 'Continue from next_offset' },
        date: { type: 'string', description: 'YYYY-MM-DD (single day; defaults to today ET)' },
        date_from: { type: 'string', description: 'YYYY-MM-DD start of range' },
        date_to: { type: 'string', description: 'YYYY-MM-DD end of range' },
        technician_name: { type: 'string', description: 'Filter by technician name (as shown on the schedule)' },
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
    description: 'Find potential duplicate customers by phone, email, or name+address. match_on phone also returns queue: the canonical duplicate-review queue (winner customer_id, each candidate customer_id, tier, reasons) — the ids merge_customers takes. If the queue cannot be read, queue is [] and queue_error says why; if there are more groups than fit, queue_truncated says how many were held back, and a group with more candidates than fit carries candidates_truncated.',
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
    description: `Update one or more fields on a single customer. Updatable fields: first_name, last_name, email, phone, city, state, zip, address_line1, address_line2, waveguard_tier, pipeline_stage, lead_source, monthly_rate, active, notes.
Changing the email also ripples automatically: ${EMAIL_FANOUT_DISCLOSURE}. Likewise, a name or phone change ripples: ${CONTACT_FANOUT_DISCLOSURE}; a phone change also ${CONTACT_FANOUT_PHONE_HOLD_CLAUSE}. Mention the ripple when proposing an email, name, or phone change.
Billing-lane side effect: if the update gives the customer a WaveGuard membership tier plus a positive monthly_rate while no billing lane is set, billing_mode is stamped 'monthly_membership' in the same write (that is the lane such rows already bill under) and the owner is notified to verify it — mention this when proposing a tier or monthly_rate change.
IMPORTANT: When asked to update, call this tool immediately once the required facts are known to prepare a preview. The operator approves execution on the confirmation card; do not ask for conversational permission to prepare it.`,
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
    name: 'cancel_plan',
    description: `Cancel a customer's WaveGuard plan (whole account) or one or more service families on the SAME engine the customer portal uses: pulls upcoming visits, stops recurrence, winds down billing / demotes the tier, records the cancellation case, and (by default) texts + emails the customer the same confirmation the portal sends.
Use for: "cancel Smith's plan", "cancel just the lawn care for the Garcias", "cancel Lee's plan at the end of their prepaid term".

Options:
- families: service family keys to cancel (pest_control, lawn_care, tree_shrub, mosquito, termite_bait). Omit for the whole account. The preview lists what the customer owns.
- effective_date: "now" (default) or "end_of_coverage" — the latter only for a whole-account cancel of an annual-prepay customer: covered visits through term_end stay on the calendar and the term simply does not renew.
- prepay_disposition: "end_at_term" (with end_of_coverage) or "end_now_refund" (with now — records the unused-value refund and opens an office task; nothing is refunded automatically).
- waive_late_fee: true to waive the scheduled-visit fee on pulled visits.
- send_confirmation: default true — SMS + email to the customer. false = no customer communication.
- reason_code / note: optional structured reason + free-text note recorded on the case.

The first call returns a PREVIEW (before/after facts) and nothing changes; the operator commits from the confirmation card. Only proceed after the operator has named the customer explicitly.`,
    input_schema: {
      type: 'object',
      properties: {
        customer_id: { type: 'string', format: 'uuid' },
        families: { type: 'array', items: { type: 'string' }, description: 'Service family keys to cancel; omit for the whole account' },
        effective_date: { type: 'string', enum: ['now', 'end_of_coverage'] },
        prepay_disposition: { type: 'string', enum: ['end_at_term', 'end_now_refund'] },
        waive_late_fee: { type: 'boolean' },
        send_confirmation: { type: 'boolean', description: 'Default true — SMS + email confirmation to the customer' },
        reason_code: { type: 'string', description: 'One of the cancellation reason codes (price, results_pest, results_lawn, service_experience, away, scheduling_access_communication, moving_or_property_change, no_longer_needed, service_mix, diy, competitor, hoa_or_landlord, financial_hardship, health_or_chemicals, billing_issue, unexpected_recurring, damage_or_adverse_effect, personal_circumstances, other)' },
        note: { type: 'string', description: 'Free-text note recorded on the cancellation case' },
      },
      required: ['customer_id'],
    },
  },
  {
    name: 'create_appointment',
    description: `Create a new scheduled service appointment.
service_type examples (catalog names): "Quarterly Pest Control Service", "Bi-Monthly Lawn Care Service", "Seasonal Mosquito Control Service", "Bi-Monthly Tree & Shrub Care Service", "Waves Assessment". Quarterly Tree & Shrub is retired for new sales (existing quarterly plans only).
time_window: "morning" (8-12), "afternoon" (12-5), or specific like "9:00 AM".
price: the visit price in dollars when the user states one. A stated price needs service_type to be the exact catalog name. Omit price to use the catalog price for service_type (a WaveGuard member's one-off gets the member discount); the confirmation card shows the price either way. A booking with a time sends the customer a booking confirmation (text, email or both per their settings), as the Schedule screen does. When neither exists and the customer's billing needs a price on the visit, the tool asks for one — ask the user and propose again with price. Free visit types (appointment, estimate, re-service, follow-up) never carry a price.`,
    input_schema: {
      type: 'object',
      properties: {
        customer_id: { type: 'string' },
        scheduled_date: { type: 'string', description: 'YYYY-MM-DD' },
        service_type: { type: 'string' },
        technician_name: { type: 'string', description: 'Optional tech name' },
        technician_id: { type: 'string', format: 'uuid', description: 'Exact technician id — use after an ambiguous name match' },
        time_window: { type: 'string' },
        notes: { type: 'string' },
        customer_request: { type: 'string', description: 'Re-service visits only ("Pest Control Re-Service" / "Lawn Care Re-Service"): why the customer asked for it, as the user told you (e.g. "ants back in the kitchen since the weekend"). The technician sees it on the job card as why the visit was booked. Put the reason HERE, not in notes. Omit when the user gave no reason; never invent one.' },
        price: { type: 'number', exclusiveMinimum: 0, maximum: 100000, description: 'Visit price in dollars, only when the user states one' },
      },
      required: ['customer_id', 'scheduled_date', 'service_type'],
    },
  },
  {
    name: 'get_recent_completions',
    description: `The most recently completed visits, newest first — resolves "the customer we just finished" and "what did we complete today". Returns customer, service, technician, and completion time.
Use for: "build the report for the customer we just finished", "who did we finish today?", "what was the last completed stop?"`,
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'Max results (default 5, max 20)' },
        days: { type: 'integer', description: 'Look back this many ET calendar days including today (default 2 = today + yesterday, max 30)' },
      },
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
    description: 'Cancel ONE appointment through a confirmation card that shows its exact effects (customer name, date, and any comms/tech notice) before anything changes. Only BARE visits qualify: no invoice of any kind on record (any status), no inspection-credit offer tied to it, no prepayment or prepaid plan coverage, no saved card, card request, fee agreement or card hold of any status, no plan make-up visit, not a follow-up visit, not part of a grouped visit — and only while cancelling from the bar is enabled. When the tool refuses, relay the reason and point the operator to the Dispatch screen; never say a visit was cancelled until the card is confirmed.',
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

// actionContext (route-derived, never model-supplied): { technicianId,
// isAdmin, confirmed } — only writes that must record WHO committed read it.
// Both halves of find_duplicates(phone) are capped at the same number: the
// raw phone grouping and the canonical queue built from findDuplicateGroups,
// whose own query has no cap (codex #4348 r11 P2).
const DUPLICATE_QUEUE_LIMIT = 50;
// Per-group cap on the candidates find_duplicates returns: one normalized
// phone shared by many imported / placeholder / business records would
// otherwise emit every member and exhaust the next model round's context
// even with the group count capped (codex #4348 r14 P2).
const DUPLICATE_CANDIDATE_LIMIT = 10;

async function executeTool(toolName, input, actionContext = {}) {
  try {
    switch (toolName) {
      case 'search_field_intelligence': return await searchFieldIntelligence(input);
      case 'query_customers': return await queryCustomers(input, actionContext.readCustomerIds);
      case 'find_overdue_customers': return await findOverdueCustomers(input);
      case 'get_customer_detail': return await getCustomerDetail(input.customer_id);
      case 'get_schedule_view': return await getScheduleView(input, actionContext.readCustomerIds);
      case 'query_revenue': return await queryRevenue(input);
      case 'compare_technicians': return await compareTechnicians(input);
      case 'find_duplicates': return await findDuplicates(input);
      case 'create_customer': return await createCustomer(input);
      case 'update_customer': return await updateCustomer(input.customer_id, input.updates, input._ib_customer_version,
        Object.prototype.hasOwnProperty.call(input, '_ib_notes_before') ? { value: input._ib_notes_before } : null);
      case 'bulk_update_customers': return await bulkUpdateCustomers(input.customer_ids, input.updates);
      case 'update_property_access': return await updatePropertyAccess(input);
      case 'cancel_plan': return await cancelPlan(input, actionContext);
      case 'create_appointment': return await createAppointment(input, actionContext);
      case 'get_recent_completions': return await getRecentCompletions(input);
      case 'reschedule_appointment': return await rescheduleAppointment(input, actionContext);
      case 'cancel_appointment': return await cancelAppointment(input, actionContext);
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

async function queryCustomers(input, readCustomerIds = []) {
  const { filters = {}, search, sort_by, sort_dir, limit: rawLimit = 50 } = input;
  const limit = Math.max(1, Math.min(Math.trunc(rawLimit), 200));
  const offset = Math.max(0, Math.trunc(input.offset || 0));

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
    )
    // Soft-deleted rows never surface here: get_customer_detail and the
    // update path already refuse them, so listing one sends the operator
    // (and the model) chasing a record no other tool will touch.
    .whereNull('customers.deleted_at');

  const supportedFilters = new Set(Object.keys(TOOLS.find(t => t.name === 'query_customers').input_schema.properties.filters.properties));
  const unsupported = Object.keys(filters).filter(key => !supportedFilters.has(key));
  if (unsupported.length) return { error: `Unsupported customer filters: ${unsupported.join(', ')}` };

  // Table-driven exact filters keep the public names and DB columns aligned.
  for (const [key, column] of Object.entries({ state: 'state', zip: 'zip', stage: 'pipeline_stage', lead_source: 'lead_source', active: 'active' })) {
    if (filters[key] != null) query = query.where(column, filters[key]);
  }
  if (filters.city) query = query.whereILike('city', `%${filters.city}%`);
  if (filters.tier === 'none') query = query.whereNull('waveguard_tier');
  else if (filters.tier) query = query.where('waveguard_tier', filters.tier);
  if (filters.tag) {
    query = query.whereExists(function () {
      this.select('*').from('customer_tags').whereRaw('customer_tags.customer_id = customers.id').where('tag', filters.tag);
    });
  }

  for (const [field, column] of Object.entries({ email: 'email', city: 'city', phone: 'phone', address: 'address_line1' })) {
    if (filters[`null_${field}`]) query = query.whereRaw("NULLIF(??, '') IS NULL", [column]);
    const hasValue = filters[`has_${field}`];
    if (typeof hasValue === 'boolean') query = query.whereRaw("(NULLIF(??, '') IS NOT NULL) = ?", [column, hasValue]);
  }

  // Health score range
  const latestHealth = '(SELECT overall_score FROM customer_health_scores WHERE customer_health_scores.customer_id = customers.id ORDER BY scored_at DESC NULLS LAST, created_at DESC LIMIT 1)';
  for (const [key, expression, comparison] of [
    ['min_health_score', latestHealth, '>='], ['max_health_score', latestHealth, '<='],
    ['min_monthly_rate', 'monthly_rate', '>='], ['max_monthly_rate', 'monthly_rate', '<='],
  ]) {
    if (filters[key] != null) query = query.whereRaw(`${expression} ${comparison} ?`, [filters[key]]);
  }

  // Service type filter (customers who have records of this type)
  if (filters.service_type) {
    query = query.whereExists(function () {
      this.select('*').from('service_records')
        .whereRaw('service_records.customer_id = customers.id')
        .whereILike('service_type', `%${filters.service_type}%`);
    });
  }

  // Free text search
  // Inside a customer-scoped task every customer list — searched, filtered or
  // bare — may only return that customer; a genuinely unscoped request
  // arrives with an empty scope and stays broad.
  if (readCustomerIds.length) query = query.whereIn('customers.id', readCustomerIds);
  if (search) {
    const s = `%${search}%`;
    query = query.where(function () {
      this.whereILike('first_name', s).orWhereILike('last_name', s)
        .orWhereRaw("TRIM(first_name || ' ' || COALESCE(last_name, '')) ILIKE ?", [s])
        .orWhereILike('phone', s).orWhereILike('email', s)
        .orWhereILike('address_line1', s).orWhereILike('city', s)
        .orWhereILike('company_name', s);
    });
  }

  // Sort
  const sortMap = {
    name: 'last_name', city: 'city', monthly_rate: 'monthly_rate',
    lead_score: 'lead_score', health_score: 'health_score',
    lifetime_revenue: 'lifetime_revenue', member_since: 'member_since', last_service_date: 'last_service_date',
  };
  const sortCol = sortMap[sort_by] || 'last_name';
  query = query.orderBy(sortCol, sort_dir);

  const matched = await query.clone().clearSelect().clearOrder().count('* as count').first();
  const customers = await query.orderBy('customers.id').limit(limit).offset(offset);
  const total = await db('customers').whereNull('deleted_at').count('* as count').first();

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
    total_matching: Number(matched.count),
    returned_count: customers.length,
    has_more: offset + customers.length < Number(matched.count),
    next_offset: offset + customers.length < Number(matched.count) ? offset + customers.length : null,
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
    tree_shrub: 42,  // catalog-key floor only; the SQL prefilter uses the shortest cadence a plan line can run at (below)
    termite: 365,    // annual
  };
  // T&S runs at the customer's own cadence (6x default, 9x upsell,
  // grandfathered 4x) — read from their ACTIVE recurring T&S plan, falling
  // back to their latest completed T&S service_type (codex r13: history lags
  // a plan switch until the first new-cadence visit completes).
  // Catalog identity first: engine-converted plans keep the generic
  // "Tree & Shrub" label while linking the cadence-specific service_id.
  const TREE_SHRUB_KEY_INTERVAL = { tree_shrub_quarterly: 90, tree_shrub_6week: 42, tree_shrub_program: 60 };
  const tsKeySql = Object.keys(TREE_SHRUB_KEY_INTERVAL).map(() => '?').join(', ');
  // The active-plan lookups read OWNERSHIP statuses (an open 'rescheduled'
  // row is still the customer's plan — service-library's
  // terminalHistoryStatuses, the list the holder gate and the picker read;
  // codex r26 on #4786). Last-visit history reads service_records, not
  // scheduled_services statuses.
  const PLAN_TERMINAL_STATUSES = require('../service-library').terminalHistoryStatuses();
  const terminalSql = PLAN_TERMINAL_STATUSES.map(() => '?').join(', ');
  // The live plan line's OWN recurrence outranks its catalog default (codex
  // r28/r29 on #4786): a tree_shrub_program row customized to every 42 days
  // is due at 42, not the row's 60, and a semiannual one at 180. Every
  // supported pattern resolves through the seeder's own recurrence table
  // (intervalDaysForPattern: custom / bare interval, month patterns, day-gap
  // patterns); only a pattern it cannot place falls back to the catalog key,
  // then the label.
  const { intervalDaysForPattern } = require('../recurring-appointment-seeder');
  const planIntervalDays = (plan) => {
    if (!plan) return null;
    return intervalDaysForPattern(plan.recurring_pattern, plan.recurring_interval_days)
      || TREE_SHRUB_KEY_INTERVAL[plan.service_key] || null;
  };
  // A Feb–Oct seasonal plan runs monthly in season and skips Nov–Jan: it
  // is due on the scheduler's next seasonal occurrence after the last visit,
  // on the series' own nth-weekday anchors (codex r33/r34 on #4786), so an
  // October visit is not overdue until its February slot.
  const { nextSeasonalFebOctDue } = require('../recurring-appointment-seeder');
  const seasonalFebOctGapDays = (lastServiceDate, plan) => {
    if (!lastServiceDate) return 30;
    const last = dateOnlyString(lastServiceDate);
    const due = nextSeasonalFebOctDue(last, { nth: plan?.recurring_nth, weekday: plan?.recurring_weekday });
    const gap = due ? Math.round((Date.parse(`${due}T00:00:00Z`) - Date.parse(`${last}T00:00:00Z`)) / 86400000) : NaN;
    return Number.isFinite(gap) && gap > 0 ? gap : 30;
  };
  const treeShrubIntervalDays = (serviceType, plan) => {
    const fromPlan = planIntervalDays(plan);
    if (fromPlan) return fromPlan;
    const t = String(serviceType || '').toLowerCase();
    if (/quarterly/.test(t)) return 90;
    if (/6\s*weeks?|six\s*weeks?/.test(t)) return 42;
    return 60;
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
    const baseFreq = frequencies[cat] || 90;
    // The prefilter boundary on the same Eastern calendar the per-customer
    // filter below uses, INCLUSIVE: a customer served exactly
    // baseFreq + overdue_days days ago is due today (codex r23 on #4786).
    // T&S plan lines run at any supported recurrence (daily is the shortest —
    // codex r30 on #4786), so the prefilter must not drop a row the
    // per-customer cadence check below can mark overdue.
    const prefilterDays = cat === 'tree_shrub' ? intervalDaysForPattern('daily') : baseFreq;
    const cutoffEt = etDateString(addETDays(new Date(), -(prefilterDays + overdue_days)));

    let customersQuery = db('customers')
      .select(
        'customers.id', 'customers.first_name', 'customers.last_name',
        'customers.phone', 'customers.city', 'customers.waveguard_tier',
        'customers.monthly_rate', 'customers.active',
        db.raw("(SELECT MAX(service_date) FROM service_records WHERE service_records.customer_id = customers.id AND service_type ~* ?) as last_service_date", [patterns[cat]]),
        db.raw("(SELECT service_type FROM service_records WHERE service_records.customer_id = customers.id AND service_type ~* ? ORDER BY service_date DESC LIMIT 1) as last_service_type", [patterns[cat]]),
        // The plan row is matched to its catalog row by id, key snapshot or
        // label (service-library's holder identity predicates — an ID-less
        // legacy row still resolves its cadence, codex r25 on #4786). A row
        // no catalog row claims but whose label is a T&S plan ("Tree & Shrub
        // Care" booked quarterly) is the plan too: its service_key is null
        // and its own recurrence decides the cadence (codex r35 on #4786).
        // Only a row with NO catalog match takes that path, so a label that
        // names some other catalog row never reads as T&S.
        // The plan row's catalog key AND its own recurrence, as one JSON
        // value (the line's cadence outranks the catalog default — codex r28).
        db.raw(`(SELECT row_to_json(plan) FROM (
          SELECT services.service_key, scheduled_services.scheduled_date,
              scheduled_services.recurring_pattern, scheduled_services.recurring_interval_days,
              scheduled_services.recurring_nth, scheduled_services.recurring_weekday
            FROM scheduled_services
            LEFT JOIN services ON ${require('../service-library').HOLDER_VISIT_IS_SERVICE_SQL}
            WHERE scheduled_services.customer_id = customers.id
              AND (services.service_key IN (${tsKeySql}) OR (services.id IS NULL AND scheduled_services.service_type ~* ?))
              AND scheduled_services.is_recurring = true AND scheduled_services.status NOT IN (${terminalSql})
          UNION ALL
          -- Plan carried as an add-on line of a combined recurring visit (a
          -- one_time add-on line is not a plan — service-library's
          -- ADDON_LINE_IS_PLAN_SQL, codex r18 on #4786). A line with no
          -- pattern of its own rides the parent's, whatever its interval
          -- column says (lineDueOnRecurringDate — codex r30).
          SELECT services.service_key, scheduled_services.scheduled_date,
              CASE WHEN scheduled_service_addons.recurring_pattern IS NULL
                THEN scheduled_services.recurring_pattern ELSE scheduled_service_addons.recurring_pattern END AS recurring_pattern,
              CASE WHEN scheduled_service_addons.recurring_pattern IS NULL
                THEN scheduled_services.recurring_interval_days ELSE scheduled_service_addons.recurring_interval_days END AS recurring_interval_days,
              scheduled_services.recurring_nth, scheduled_services.recurring_weekday
            FROM scheduled_service_addons
            JOIN scheduled_services ON scheduled_services.id = scheduled_service_addons.scheduled_service_id
            LEFT JOIN services ON ${require('../service-library').HOLDER_ADDON_IS_SERVICE_SQL}
            WHERE scheduled_services.customer_id = customers.id
              AND (services.service_key IN (${tsKeySql}) OR (services.id IS NULL AND scheduled_service_addons.service_name ~* ?))
              AND scheduled_services.is_recurring = true AND scheduled_services.status NOT IN (${terminalSql})
              AND ${require('../service-library').ADDON_LINE_IS_PLAN_SQL}
        ) plan ORDER BY plan.scheduled_date ASC LIMIT 1) as active_plan`, [
          ...Object.keys(TREE_SHRUB_KEY_INTERVAL), patterns.tree_shrub, ...PLAN_TERMINAL_STATUSES,
          ...Object.keys(TREE_SHRUB_KEY_INTERVAL), patterns.tree_shrub, ...PLAN_TERMINAL_STATUSES,
        ]),
        db.raw(`(SELECT service_type FROM scheduled_services WHERE scheduled_services.customer_id = customers.id AND service_type ~* ? AND is_recurring = true AND status NOT IN (${terminalSql}) ORDER BY scheduled_date ASC LIMIT 1) as active_plan_service_type`, [patterns[cat], ...PLAN_TERMINAL_STATUSES]),
        db.raw("(SELECT MIN(scheduled_date) FROM scheduled_services WHERE scheduled_services.customer_id = customers.id AND scheduled_date >= CURRENT_DATE AND status NOT IN ('cancelled','completed') AND service_type ~* ?) as next_scheduled", [patterns[cat]]),
      )
      .where('customers.active', true)
      .whereNull('customers.deleted_at')
      .whereExists(function () {
        this.select('*').from('service_records')
          .whereRaw('service_records.customer_id = customers.id')
          .whereRaw('service_type ~* ?', [patterns[cat]]);
      })
      // A WHERE, not a HAVING: the query has no GROUP BY, and Postgres
      // rejects HAVING over plain columns ("customers.id must appear in the
      // GROUP BY clause"), which failed this tool for every category.
      .whereRaw("(SELECT MAX(service_date) FROM service_records WHERE service_records.customer_id = customers.id AND service_type ~* ?) <= ?", [patterns[cat], cutoffEt])
      // customers.id breaks last-service-date ties so the paged read below
      // sees each row exactly once (codex r21 on #4786).
      .orderByRaw("(SELECT MAX(service_date) FROM service_records WHERE service_records.customer_id = customers.id AND service_type ~* ?) ASC, customers.id ASC", [patterns[cat]]);
    // T&S: the 42-day prefilter admits not-yet-due 60/90-day customers, and
    // they sort oldest-first — ANY SQL cap would let them crowd out a truly
    // overdue 6-week customer with a newer last visit (codex r11/r19 on
    // #4786). Page through every prefiltered row, filter per customer, and
    // let the final slice below apply the limit; total_found stays exact.
    const pageSize = cat === 'tree_shrub' ? 500 : limit;
    const customers = [];
    for (let offset = 0; ; offset += pageSize) {
      const page = await customersQuery.clone().limit(pageSize).offset(offset);
      customers.push(...page);
      if (cat !== 'tree_shrub' || page.length < pageSize) break;
    }

    // Days on the Eastern calendar (codex r21 on #4786): service_date is a
    // date-only column, so the count is between two calendar days — never
    // Date.now() in the process's UTC clock, which runs a day ahead of the
    // office every evening and returned a 60/90-day customer a day early.
    const todayEt = etDateString();
    const calendarDaysSince = (dateOnly) => Math.round(
      (Date.parse(`${todayEt}T00:00:00Z`) - Date.parse(`${dateOnlyString(dateOnly)}T00:00:00Z`)) / 86400000,
    );
    for (const c of customers) {
      const daysSince = c.last_service_date ? calendarDaysSince(c.last_service_date) : null;
      if (daysSince != null && Number.isNaN(daysSince)) continue;
      const activePlan = typeof c.active_plan === 'string' ? JSON.parse(c.active_plan) : c.active_plan;
      const freq = cat === 'tree_shrub'
        ? (activePlan?.recurring_pattern === 'seasonal_feb_oct'
          ? seasonalFebOctGapDays(c.last_service_date, activePlan)
          : treeShrubIntervalDays(c.active_plan_service_type || c.last_service_type, activePlan))
        : baseFreq;
      if (daysSince != null && daysSince < freq + overdue_days) continue;

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
  const customer = await db('customers').where('id', customerId).whereNull('deleted_at').first();
  if (!customer) return { error: 'Customer not found' };

  const services = await db('service_records')
    .where('customer_id', customerId)
    .orderBy('service_date', 'desc')
    .limit(10);

  const upcoming = await db('scheduled_services')
    .where({ customer_id: customerId })
    .where('scheduled_date', '>=', etDateString())
    .whereNotIn('status', ['cancelled', 'completed', 'skipped'])
    .orderBy('scheduled_date', 'asc')
    .limit(10);

  const invoices = await db('invoices')
    .where('customer_id', customerId)
    .orderBy('created_at', 'desc')
    .limit(5);

  const propertyCoverage = {};
  const properties = await require('../customer-properties').listProperties(customerId)
    .then(rows => { propertyCoverage.properties = 'complete'; return rows; })
    .catch(() => { propertyCoverage.properties = 'unavailable'; return null; });
  const accountProperties = customer.account_id ? await db('customers')
    .where({ account_id: customer.account_id }).whereNull('deleted_at').whereNot({ id: customerId })
    .select('id', 'profile_label', 'address_line1', 'address_line2', 'city', 'state', 'zip')
    .then(rows => { propertyCoverage.linked_profiles = 'complete'; return rows; })
    .catch(() => { propertyCoverage.linked_profiles = 'unavailable'; return null; }) : [];

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
      address: formatAddress(effectiveServiceAddress({}, customer)),
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
    properties,
    account_properties: accountProperties,
    coverage: { ...propertyCoverage, service_history: 'latest 10', upcoming_services: 'next 10', invoices: 'latest 5' },
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
      property_id: s.property_id || null,
      service_address: formatAddress(effectiveServiceAddress(s, customer)),
      location_provenance: s.service_address_line1 ? 'appointment_snapshot' : 'account_fallback',
    })),
    recent_invoices: invoices.map(i => ({
      id: i.id,
      amount: parseFloat(i.total || 0),
      status: i.status,
      date: i.created_at,
    })),
  };
}


// readCustomerIds: a customer-scoped task confines the schedule to its
// resolved customers so a date-wide read cannot expose other customers'
// names, phones, addresses or notes to the model.
async function getScheduleView(input, readCustomerIds = []) {
  const { date = (!input.date_from && !input.date_to ? etDateString() : undefined), date_from, date_to, technician_name, city } = input;
  const offset = Math.max(0, Math.trunc(input.offset || 0));

  let query = db('scheduled_services')
    .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
    .leftJoin('technicians', 'scheduled_services.technician_id', 'technicians.id')
    .select(
      'scheduled_services.id', 'scheduled_services.scheduled_date',
      'scheduled_services.service_type', 'scheduled_services.status',
      'scheduled_services.window_start', 'scheduled_services.window_end',
      'scheduled_services.route_order', 'scheduled_services.notes',
      'scheduled_services.service_address_line1', 'scheduled_services.service_address_line2',
      'scheduled_services.service_address_city', 'scheduled_services.service_address_state', 'scheduled_services.service_address_zip',
      'customers.address_line2', 'customers.state', 'customers.zip',
      'customers.id as customer_id', 'customers.first_name', 'customers.last_name',
      'customers.city', 'customers.address_line1', 'customers.phone',
      'technicians.name as tech_name',
    )
    .whereNotIn('scheduled_services.status', ['cancelled']);
  if (readCustomerIds.length) query = query.whereIn('scheduled_services.customer_id', readCustomerIds);

  if (date) {
    query = query.where('scheduled_services.scheduled_date', date);
  } else if (date_from && date_to) {
    query = query.whereBetween('scheduled_services.scheduled_date', [date_from, date_to]);
  } else if (date_from) {
    query = query.where('scheduled_services.scheduled_date', '>=', date_from);
  }

  if (date_to && !date && !date_from) query = query.where('scheduled_services.scheduled_date', '<=', date_to);

  if (technician_name) {
    query = query.whereILike('technicians.name', `%${technician_name}%`);
  }
  if (city) {
    query = query.whereRaw('COALESCE(scheduled_services.service_address_city, customers.city) ILIKE ?', [`%${city}%`]);
  }

  const fetched = await query.orderBy('scheduled_services.scheduled_date').orderByRaw('COALESCE(route_order, 999)').orderBy('scheduled_services.id').limit(201).offset(offset);
  const appointments = fetched.slice(0, 200);

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
      customer_city: effectiveServiceAddress(a, a).city,
      customer_address: formatAddress(effectiveServiceAddress(a, a)),
      customer_phone: a.phone,
      technician: a.tech_name,
      notes: a.notes,
    })),
    returned_count: appointments.length,
    has_more: fetched.length > 200,
    next_offset: fetched.length > 200 ? offset + 200 : null,
    date: date || null,
    coverage: readCustomerIds.length ? 'Requested date range for the task customer only; cancelled appointments excluded'
      : 'Requested date range; cancelled appointments excluded',
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
      .whereNull('deleted_at').whereNotNull('phone').where('phone', '!=', '')
      .groupBy('phone').having(db.raw('COUNT(*)'), '>', 1)
      .orderByRaw('COUNT(*) DESC').limit(DUPLICATE_QUEUE_LIMIT);
    // The canonical duplicate queue (customer-dedupe.js findDuplicateGroups:
    // normalized phones, pickWinner, tiers, reasons) — the ids and
    // winner/loser roles merge_customers needs; the raw grouping above
    // matches the stored string only.
    // queue is always an array; a failed queue read is reported beside it
    // in queue_error so callers never branch on the shape of one field.
    let queue = [];
    let queueError = null;
    let queueTruncated = null;
    try {
      const { findDuplicateGroups } = require('../customer-dedupe');
      const groups = await findDuplicateGroups();
      const name = (row) => `${row.first_name || ''} ${row.last_name || ''}`.trim() || 'Unnamed customer';
      // findDuplicateGroups has no cap of its own, so this payload grows
      // with the customer base and lands in a model context (codex #4348
      // r11 P2). Capped at the same 50 the raw grouping above uses, with
      // the truncation stated rather than silent — the queue is a worklist
      // the model walks pair by pair, so the top of it is what matters.
      const capped = groups.slice(0, DUPLICATE_QUEUE_LIMIT);
      if (groups.length > capped.length) {
        queueTruncated = { returned: capped.length, total: groups.length, note: `Showing the first ${capped.length} of ${groups.length} duplicate groups — work these, then call find_duplicates again.` };
      }
      queue = capped.map((g) => {
        const candidates = g.candidates.slice(0, DUPLICATE_CANDIDATE_LIMIT)
          .map((c) => ({ customer_id: c.loser.id, name: name(c.loser), tier: c.tier, reasons: c.reasons }));
        const group = { phone: g.phone10 || null, winner: { customer_id: g.winner.id, name: name(g.winner) }, candidates };
        if (g.candidates.length > candidates.length) {
          group.candidates_truncated = { returned: candidates.length, total: g.candidates.length, note: `Showing the first ${candidates.length} of ${g.candidates.length} candidates in this group — merge these, then call find_duplicates again.` };
        }
        return group;
      });
    } catch (err) {
      queueError = `duplicate queue unavailable: ${err.message}`;
    }
    return { match_on: 'phone', duplicates: dupes, queue, ...(queueTruncated ? { queue_truncated: queueTruncated } : {}), ...(queueError ? { queue_error: queueError } : {}) };
  }

  if (match_on === 'email') {
    const dupes = await db('customers')
      .select('email', db.raw('COUNT(*) as count'), db.raw("string_agg(TRIM(first_name || ' ' || COALESCE(last_name, '')), ', ') as names"))
      .whereNull('deleted_at').whereNotNull('email').where('email', '!=', '')
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
      .whereNull('deleted_at').whereNotNull('address_line1').where('address_line1', '!=', '')
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
  // address_line2 accepted (GH r19 P2): the fan-out and its disclosure
  // already treat a unit-only edit as an address change — omitting it here
  // made a unit-only card fail as no-valid-fields and silently dropped the
  // unit from combined updates.
  address_line1: 'address_line1', address_line2: 'address_line2', waveguard_tier: 'waveguard_tier',
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
    // codex #5196 P1-A: fence this admin-UI mint against
    // call-booking-link-text.js's phone-locked handoff (same lockSmsPhone
    // key/namespace) — the FIRST statement of this transaction, nothing
    // else held before it, so no lock-order inversion risk (see
    // routes/admin-customers.js ensureCustomerAccount's lockPhone comment
    // for the full contract this mirrors).
    await lockSmsPhone(trx, phone);
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


async function updateCustomer(customerId, updates, expectedVersion, notesPin = null) {
  const clean = sanitizeUpdates(updates);
  Object.assign(clean, normalizeContactRecord(clean));
  if (Object.keys(clean).length <= 1) return { error: 'No valid fields to update' };

  const before = await db('customers').where('id', customerId).first();
  if (!before) return { error: 'Customer not found' };
  // A customer merged/soft-deleted during the card's pending window must
  // not be edited back to life — the proposal-time resolution was the only
  // live check before this (GH r9 P1).
  if (before.deleted_at) {
    return { error: 'This customer record is no longer live (deleted or merged since the card was shown) — nothing was updated.', preview_changed: true };
  }

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
  // `active` is an IB-updatable field: a churn write must never let a
  // payload's active=true ride over churnGuardForRow's disarm in the same
  // UPDATE (pre-push audit P1 on 1e776e385e) — cancelled-account admission
  // (auth.js isCancelledCustomerRow) is keyed on active=false + churned.
  if (clean.pipeline_stage === 'churned') delete clean.active;
  // ADMIN-BUG-R10 (round 3): the churn guard + billing wind-down run INSIDE
  // the transaction below, after the row lock and the expectedVersion
  // check — churnGuardForRow's own disarm write bumps customers.updated_at,
  // so running it here (before the version compare) would disarm billing
  // and then reject the churn as stale against its own write (pre-push
  // audit P1). See the guard block in the transaction.
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
  // Codex #4715 r4 P2: captured from the guard call inside the transaction
  // below so the RESULT built after commit can tell a full wind-down apart
  // from a rail-only repair (railsRepairedOnly) — declared outside the
  // transaction's arrow function since its own `decision` const is local to
  // that scope.
  let churnRepairDecision = null;
  try {
    await db.transaction(async (trx) => {
      // Membership-affecting writes join the customer-comms serialization
      // (codex #3426 r6 P2): the previsit backstop sweep holds
      // `customer-comms:<id>` through its membership recheck AND the SMS
      // dispatch, so a tier/rate write that makes this customer a member
      // either commits before the sweep's in-lock recheck reads or waits
      // until after the send. Comms lock BEFORE the customers row lock
      // (customer-comms-lock.js contract).
      // Prefs advisory lock FIRST (global order: prefs advisory → comms →
      // customers row, same as the Customers route and the bulk branch) —
      // comms-then-prefs here was the AB-BA half of a deadlock with any
      // path holding prefs and waiting on comms/rows (codex #3565
      // gh-r38/r42).
      await trx.raw(
        'SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))',
        ['property-preferences', String(customerId)],
      );
      if (clean.waveguard_tier !== undefined || clean.monthly_rate !== undefined) {
        await lockCustomerComms(trx, customerId);
      }
      // Row lock serializes overlapping address edits (see the Customers
      // route): before/merged are re-derived from the locked row so a losing
      // concurrent editor still matches the snapshots the winner moved.
      const lockedBefore = await trx('customers').where('id', customerId).forUpdate().first();
      // Liveness re-asserted on the LOCKED row (GH r10 P1): the preflight
      // deleted_at check above ran unlocked, so a merge/soft-delete that
      // commits between it and this row lock must still refuse — never
      // edit a merged-away profile back to life.
      if (!lockedBefore || lockedBefore.deleted_at) {
        const err = new Error('customer_no_longer_live');
        err.customerNoLongerLive = true;
        throw err;
      }
      if (expectedVersion) {
        // Compare Postgres' full-precision version while holding the same row
        // lock as the domain write; JS Date equality loses microseconds.
        const current = await trx('customers').where('id', customerId).first(trx.raw('updated_at::text AS version'));
        if (current.version !== expectedVersion) {
          const err = new Error('Customer changed since this action was prepared. Review a fresh proposal.');
          err.previewChanged = true;
          throw err;
        }
      }
      // A notes edit replaces the field, and not every notes writer bumps
      // updated_at (Customer 360, the call processor's append), so the notes
      // the proposal showed are compared by value on the locked row
      // (Codex r3 on #5675).
      if (notesPin && clean.crm_notes !== undefined && (lockedBefore.crm_notes ?? null) !== (notesPin.value ?? null)) {
        const err = new Error('This customer\'s notes changed since this action was prepared. Review a fresh proposal.');
        err.previewChanged = true;
        throw err;
      }
      // ADMIN-BUG-R10 (round 3): runs on EVERY write of pipeline_stage=
      // 'churned' — including a re-save on an already-churned row — so a
      // pre-fix residue row self-heals. Refuses (naming what's still live)
      // rather than silently repointing the account into a still-billing
      // churn label; otherwise churnGuardForRow winds billing down itself
      // through the canonical cancellation-processor.js write, on THIS
      // transaction, after the version check above — a refusal rolls the
      // whole thing back, and the disarm's updated_at bump can never
      // invalidate the version this same action was prepared against.
      if (clean.pipeline_stage === 'churned') {
        const { churnGuardOrRepair, describeLiveVisit } = require('../customer-lifecycle-guard');
        const decision = await churnGuardOrRepair(trx, customerId, lockedBefore);
        churnRepairDecision = decision;
        if (decision.blocked) {
          const err = new Error(decision.liveVisit
            ? `Cannot mark Churned: ${describeLiveVisit(decision.liveVisit)}. Use "Cancel plan…" to wind down billing and visits together, then mark Churned.`
            : decision.liveTerm
              ? 'Cannot mark Churned: this customer still has an active prepay term. Use "Cancel plan…" to wind down billing and coverage together, then mark Churned.'
              : `Cannot mark Churned: this customer ${decision.error}.`);
          err.previewChanged = true;
          throw err;
        }
      }
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
      // Every assigned address (primary and service-contact slots) takes the
      // key — utils/customer-comms-lock.js lockAssignedCustomerEmails.
      await require('../../utils/customer-comms-lock').lockAssignedCustomerEmails(trx, clean);
      if (clean.email) {
        // Serialization ONLY — deliberately NO claimant refusal (r23):
        // customers.email is intentionally non-unique (20260417000010 —
        // spouses/shared household addresses are supported), so an
        // operator assigning a shared address is a supported act. The undo
        // needs only this lock: its claim probe runs under the same key.
      }
      await trx('customers').where('id', customerId).update(clean);
      // Coords cleared atomically with the address/move-stamp write — never
      // the former home's lat/lng beside the new address (codex #3565 gh-r46).
      if (addressSubmitted) {
        await trx('customers').where('id', customerId).update({ latitude: null, longitude: null });
      }
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
    if (e?.previewChanged) return { error: e.message, preview_changed: true };
    if (e && e.customerNoLongerLive) {
      return { error: 'This customer record is no longer live (deleted or merged since the card was shown) — nothing was updated.', preview_changed: true };
    }
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
    // lat/lng were cleared inside the update transaction (gh-r46) —
    // re-geocode with an address/coord CAS, mirror the fresh coords onto the
    // primary property, then refresh affected route-quality warnings.
    void require('../geocoder').regeocodeCustomerAddressGuarded(customerId)
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
    // Churn billing disarm disclosure (GitHub Codex #4684 r4): reaching this
    // return with clean.pipeline_stage === 'churned' means churnGuardForRow
    // ran INSIDE the committed transaction and did NOT block (a block throws
    // and returns an error above instead) — so the wind-down always ran.
    // Names what happened rather than leaving the confirm card's disclosure
    // as the only place the operator ever sees it.
    // `message` is what the completed card actually renders (Codex #4715
    // r1 P2 — PendingActionsCard reads warning/error/message on an ordinary
    // result; the structured fields above are invisible without it).
    // Codex #4715 r4 P2: churnGuardOrRepair's `railsRepairedOnly` means the
    // row was ALREADY churned with customer-level billing already off — it
    // skipped disarmCustomerBillingFields entirely and only repaired the
    // independent saved-method Auto Pay / armed-retry rails. Reporting
    // `billing_wound_down: true` there is a false positive (customers.active/
    // autopay_enabled/next_charge_date were never touched this write) —
    // split the two effects so the receipt matches what actually ran, and
    // keep the copy consistent with the confirmation card's own repeat-save
    // sentence (authorization-contract.js: "an already-churned customer
    // whose billing is already off is not re-checked — only saved-method
    // Auto Pay and armed retries are repaired").
    ...(clean.pipeline_stage === 'churned' ? (churnRepairDecision?.railsRepairedOnly ? {
      billing_wound_down: false,
      rails_repaired: true,
      billing_wound_down_fields: ['payment_methods.autopay_enabled', 'payments.next_retry_at'],
      message: 'Already churned — customer billing was already off, so only saved-method Auto Pay and armed retries were repaired.',
    } : {
      billing_wound_down: true,
      billing_wound_down_fields: ['active', 'autopay_enabled', 'next_charge_date', 'payment_methods.autopay_enabled', 'payments.next_retry_at'],
      message: 'Billing wound down: Auto Pay off (customer + saved methods), next charge date and armed retries cleared.',
    }) : {}),
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
  // `active` is an IB-updatable field: a churn write must never let a
  // payload's active=true ride over churnGuardForRow's disarm in the same
  // UPDATE (pre-push audit P1 on 1e776e385e) — cancelled-account admission
  // (auth.js isCancelledCustomerRow) is keyed on active=false + churned.
  if (clean.pipeline_stage === 'churned') delete clean.active;
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
      stageStamp.churn_episode_id = null;
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
    const { count, laneStampIds, skippedRows, churnWoundDownCount, railsRepairedCount } = await db.transaction(async (trx) => {
      let rateChangedIds = [];
      let stampIds = [];
      if (laneStampRelevant) {
        // Membership-affecting bulk writes join the customer-comms
        // serialization (codex #3426 r6 P2) — same reason as updateCustomer.
        // Comms locks FIRST, over the FULL approved id set in a STABLE
        // (sorted) order, BEFORE the customers row locks below (GH r10
        // P1): taking the row locks first inverted the documented order
        // (customer-comms-lock.js) and deadlocked against a concurrent
        // single-customer membership write already holding the advisory
        // lock while waiting on a row this transaction held. Locking an
        // id that turns out dead below is harmless — the advisory key
        // serializes nothing for an absent row.
        for (const cid of [...customerIds].map(String).sort()) {
          await lockCustomerComms(trx, cid);
        }
      }
      // The card promised EVERY listed customer transitions or is reported
      // (GH r9 P1): resolve the live pinned set under row locks — AFTER
      // the comms locks above — so a customer deleted/merged while the
      // card was pending surfaces as a warning instead of silently
      // shrinking a single whereIn UPDATE.
      const liveRows = await trx('customers')
        .whereIn('id', customerIds)
        .forUpdate()
        .whereNull('deleted_at')
        .select('id', 'first_name', 'last_name', 'pipeline_stage', 'active', 'autopay_enabled', 'next_charge_date');
      const liveIds = new Set(liveRows.map((r) => String(r.id)));
      const skipped = customerIds
        .filter((cid) => !liveIds.has(String(cid)))
        .map((cid) => ({ customer_id: String(cid) }));
      let targetIds = [...liveIds];
      // ADMIN-BUG-R10 (round 3): a bulk stage move into Churned used to
      // CASE-stamp only churned_at/churn_reason for every targeted row,
      // leaving active/autopay/next_charge_date live — the same money leak
      // as the single-customer writers. Runs on EVERY targeted row,
      // including one ALREADY churned (not gated on a stage transition), so
      // a bulk re-save of Churned self-heals pre-fix residue rows too. Rows
      // with a live future visit, an active prepay term, or an unpaid
      // pending prepay invoice are excluded here and reported back (same
      // contract as a deleted/merged row above); churnGuardForRow winds the
      // rest down itself through the canonical cancellation-processor.js
      // write as it checks them — no separate post-update pass needed.
      // Codex #4715 r4 P2: rows where churnGuardOrRepair reports
      // railsRepairedOnly (already churned, customer-level billing already
      // off) — counted separately from a real wind-down below, since they
      // never touched active/autopay_enabled/next_charge_date this write.
      const railsRepairedOnlyIds = [];
      if (clean.pipeline_stage === 'churned') {
        const { churnGuardOrRepair } = require('../customer-lifecycle-guard');
        const liveRowById = new Map(liveRows.map((r) => [String(r.id), r]));
        const blocked = [];
        for (const cid of targetIds) {
          // Already-churned rows with customer-level billing already wound
          // down get the rail-only repair (see churnGuardOrRepair) — a bulk
          // re-label must not 409 customers who already followed the
          // "Cancel plan…" advice.
          const decision = await churnGuardOrRepair(trx, cid, liveRowById.get(String(cid)));
          if (decision.blocked) {
            // Tagged (pre-push audit P1) so the RESULT can tell a churn
            // refusal apart from a deleted/merged skip — the per-row bulk
            // branch below already carries this same tag on its `errors`.
            blocked.push({ customer_id: cid, error: decision.error, churn_blocked: true });
          } else if (decision.railsRepairedOnly) {
            railsRepairedOnlyIds.push(cid);
          }
        }
        if (blocked.length) {
          const blockedIds = new Set(blocked.map((b) => b.customer_id));
          targetIds = targetIds.filter((id) => !blockedIds.has(String(id)));
          skipped.push(...blocked);
        }
      }
      // churnGuardForRow (above) already ran and disarmed billing for every
      // remaining targetId before either return below — its own disarm is
      // unconditional-if-not-blocked, independent of the stage UPDATE that
      // follows — so the count is fixed here, not derived from `updated`.
      // railsRepairedOnlyIds rows are excluded from churnWoundDownCount
      // (Codex #4715 r4 P2): they never had customer-level billing touched
      // this write, only the independent saved-method rails.
      const railsRepairedCount = clean.pipeline_stage === 'churned' ? railsRepairedOnlyIds.length : 0;
      const churnWoundDownCount = clean.pipeline_stage === 'churned' ? targetIds.length - railsRepairedCount : 0;
      if (!targetIds.length) return { count: 0, laneStampIds: [], skippedRows: skipped, churnWoundDownCount, railsRepairedCount };
      if (laneStampRelevant) {
        const beforeRows = await trx('customers')
          .whereIn('id', targetIds)
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
      const updated = await trx('customers').whereIn('id', targetIds).update({ ...clean, ...stageStamp });
      if (stampIds.length) {
        await trx('customers').whereIn('id', stampIds).update({ billing_mode: 'monthly_membership' });
      }
      if (rateChangedIds.length) {
        const PlanRateLedger = require('../plan-rate-ledger');
        for (const cid of rateChangedIds) {
          await PlanRateLedger.syncScalarWriteToLedger(trx, cid, clean.monthly_rate, { source: 'ib_bulk_update' });
        }
      }
      return { count: updated, laneStampIds: stampIds, skippedRows: skipped, churnWoundDownCount, railsRepairedCount };
    });
    logger.info(`[intelligence-bar] Bulk updated ${count} customers:`, logUpdates);
    notifyBulkLaneStamps(laneStampIds);
    if (!count && skippedRows.length) {
      return { error: 'None of the approved customers could be updated (deleted/merged since the card was pending, or still billing/scheduled for a churn move) — nothing was updated.', skipped_customers: skippedRows };
    }
    // Codex #4715 r1 P2: the completed card renders `message`. Codex #4715
    // r2 P2: on a PARTIAL update the card renders `warning` FIRST and hides
    // `message` entirely — so a wind-down sentence appended only to
    // `message` would silently disappear whenever skipped rows are also
    // present. Built once and appended to `warning` below (as well as kept
    // in `message`) so the operator sees it either way.
    // Codex #4715 r4 P2: a rail-only repair (already-churned rows whose
    // customer-level billing was already off) is a different effect than a
    // real wind-down — reported as its own sentence, never folded into the
    // wound-down count.
    const woundDownParts = [];
    if (churnWoundDownCount) woundDownParts.push(`Billing wound down for ${churnWoundDownCount} customer(s): Auto Pay off (customer + saved methods), next charge date and armed retries cleared.`);
    if (railsRepairedCount) woundDownParts.push(`${railsRepairedCount} customer(s) were already churned — only saved-method Auto Pay and armed retries were repaired.`);
    const woundDownMessage = woundDownParts.length ? woundDownParts.join(' ') : null;
    return {
      success: true,
      updated_count: count,
      fields_updated: Object.keys(updates),
      ...bulkLaneStampResult(laneStampIds),
      // Skipped rows surface on the card, never a silent Done (same
      // contract as the per-row address/email path; GH r9 P1). Each skipped
      // row's own `error` (when present) says why — no longer live, or (for
      // a churn move) still billing/scheduled.
      // Codex #4715 pre-push audit P1: the card renders only `warning`, so a
      // churn refusal's actionable reason (the "use Cancel plan…" instruction
      // from churnGuardOrRepair's `error`) must ride in `warning` too — not
      // just in skipped_customers, which the card never reads. Mirrors the
      // per-row bulk branch's own warning below.
      ...(skippedRows.length ? {
        skipped_customers: skippedRows,
        warning: (() => {
          const churnBlocked = skippedRows.filter((r) => r.churn_blocked);
          const other = skippedRows.length - churnBlocked.length;
          const parts = [];
          if (churnBlocked.length) parts.push(`${churnBlocked.length} refused (${churnBlocked.map((r) => r.error).join('; ')})`);
          if (other) parts.push(`${other} no longer live`);
          return `${skippedRows.length} approved customer(s) were NOT updated — ${parts.join('; ')}.${woundDownMessage ? ` ${woundDownMessage}` : ''}`;
        })(),
      } : {}),
      // Churn billing disarm disclosure (GitHub Codex #4684 r4) — how many
      // of the approved rows actually went through churnGuardForRow's
      // wind-down (a blocked row lands in skipped_customers instead).
      ...(woundDownMessage ? {
        billing_wound_down_count: churnWoundDownCount,
        rails_repaired_count: railsRepairedCount,
        message: woundDownMessage,
      } : {}),
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
  let churnWoundDownCount = 0;
  // Codex #4715 r4 P2: rows where churnGuardOrRepair only repaired the
  // saved-method rails (already churned, customer-level billing already
  // off) — reported separately from churnWoundDownCount below.
  let railsRepairedCount = 0;
  const geocodedCustomerIds = new Set();
  let qualityRefreshTimer = null;
  for (const customerId of customerIds) {
    const before = await db('customers').where('id', customerId).first();
    if (!before) {
      errors.push({ customer_id: customerId, error: 'Customer not found' });
      continue;
    }
    // Same live-customer bar as every other IB customer writer (pre-push
    // r11 P1): a soft-deleted/merged row must not be edited, fanned out,
    // or emailed by the per-row branch.
    if (before.deleted_at) {
      errors.push({ customer_id: customerId, error: 'Customer record is no longer live (deleted or merged)' });
      continue;
    }
    let emailSync = null;
    let rowLaneStamp = null;
    let rowRailsRepairedOnly = false;
    try {
      await db.transaction(async (trx) => {
        // Membership-affecting writes join the customer-comms serialization
        // (codex #3426 r6 P2) — same rule as the single-edit path: comms
        // lock BEFORE this row's lock. Per-row transactions each hold one
        // key, so no cross-row ordering concern on this branch.
        // Prefs advisory lock FIRST (global order: prefs advisory → comms →
        // customers row) — an address row in the bulk update reaches the
        // fan-out's move stamp (codex #3565 gh-r39).
        await trx.raw(
          'SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))',
          ['property-preferences', String(customerId)],
        );
        if (clean.waveguard_tier !== undefined || clean.monthly_rate !== undefined) {
          await lockCustomerComms(trx, customerId);
        }
        // Same row-lock serialization AND locked liveness re-assert as the
        // single-edit path (GH r10 / pre-push r11 P1).
        const lockedBefore = await trx('customers').where('id', customerId).forUpdate().first();
        if (!lockedBefore || lockedBefore.deleted_at) {
          const err = new Error('customer_no_longer_live');
          err.customerNoLongerLive = true;
          throw err;
        }
        const lockedMerged = { ...lockedBefore, ...clean };
        // ADMIN-BUG-R10 (round 3): a bulk edit that combines a churn move
        // with an address/email field takes THIS per-row branch instead of
        // the fast CASE path above, and this branch has its own per-row
        // before-state (lockedBefore) — so it gets the identical guard, via
        // the same shared helper, rather than silently skipping it. Runs on
        // EVERY write of pipeline_stage='churned' (not gated on
        // lockedBefore.pipeline_stage !== 'churned'), so a re-save of
        // Churned combined with an address/email edit self-heals a pre-fix
        // residue row too. churnGuardForRow winds billing down itself
        // through the canonical cancellation-processor.js write.
        if (clean.pipeline_stage === 'churned') {
          const { churnGuardOrRepair } = require('../customer-lifecycle-guard');
          const decision = await churnGuardOrRepair(trx, customerId, lockedBefore);
          if (decision.blocked) {
            const err = new Error(decision.error);
            err.churnBlocked = true;
            throw err;
          }
          rowRailsRepairedOnly = !!decision.railsRepairedOnly;
        }
        await require('../../utils/customer-comms-lock').lockAssignedCustomerEmails(trx, clean);
        if (emailSubmitted && clean.email) {
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
          // Coords cleared atomically with the address/move-stamp write (gh-r46).
          await trx('customers').where('id', customerId).update({ latitude: null, longitude: null });
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
      if (e && e.customerNoLongerLive) {
        errors.push({ customer_id: customerId, error: 'Customer record is no longer live (deleted or merged)' });
        continue;
      }
      if (e && e.churnBlocked) {
        errors.push({ customer_id: customerId, error: e.message, churn_blocked: true });
        continue;
      }
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
      // Coalesce coordinate commits for one second from the first success.
      // A stalled sibling or later row error cannot hold successful IDs back;
      // a late completion starts a fresh window. The edit response stays detached.
      void require('../geocoder').regeocodeCustomerAddressGuarded(
        customerId,
        { scheduleQualityCustomerIds: geocodedCustomerIds },
      ).then(() => {
        if (qualityRefreshTimer || !geocodedCustomerIds.size) return;
        qualityRefreshTimer = setTimeout(() => {
          qualityRefreshTimer = null;
          const customerIds = [...geocodedCustomerIds];
          geocodedCustomerIds.clear();
          void require('../scheduling/quality-after-change').refreshScheduleQualityAfterChange({ customerIds })
            .catch((err) => logger.error(`[ib] deferred bulk route-quality refresh failed: ${err.code || err.name || 'refresh_failed'}`));
        }, 1000);
        qualityRefreshTimer.unref();
      }).catch(() => null);
    }
    if (rowLaneStamp) perRowLaneStampIds.push(customerId);
    // Reaching here means the per-row transaction committed — a blocked
    // churnGuardForRow throws churnBlocked above and lands in `errors`
    // instead. Codex #4715 r4 P2: a railsRepairedOnly row (already churned,
    // customer-level billing already off) never touched active/
    // autopay_enabled/next_charge_date this write — counted separately from
    // a real wind-down.
    if (clean.pipeline_stage === 'churned') {
      if (rowRailsRepairedOnly) railsRepairedCount += 1;
      else churnWoundDownCount += 1;
    }
    count += 1;
  }
  logger.info(`[intelligence-bar] Bulk updated ${count} customers (address path):`, logUpdates);
  notifyBulkLaneStamps(perRowLaneStampIds);

  // Codex #4715 r1 P2: the completed card renders `message`. Codex #4715 r2
  // P2: on a PARTIAL update the card renders `warning` FIRST and hides
  // `message` entirely — appended to `warning` below (as well as kept in
  // `message`) so the operator sees it either way.
  const woundDownParts = [];
  if (churnWoundDownCount) woundDownParts.push(`Billing wound down for ${churnWoundDownCount} customer(s): Auto Pay off (customer + saved methods), next charge date and armed retries cleared.`);
  if (railsRepairedCount) woundDownParts.push(`${railsRepairedCount} customer(s) were already churned — only saved-method Auto Pay and armed retries were repaired.`);
  const woundDownMessage = woundDownParts.length ? woundDownParts.join(' ') : null;
  return {
    success: true,
    updated_count: count,
    fields_updated: Object.keys(updates),
    ...bulkLaneStampResult(perRowLaneStampIds),
    ...(errors.length ? {
      errors,
      // The confirm card renders `warning` — a partial bulk update must never
      // read as a clean Done (W0B).
      // Churn refusals carry their own actionable reason (GitHub Codex
      // #4684 r6 P2) — the card renders only `warning`, so "no longer
      // resolved" must not paper over a "use Cancel plan…" instruction.
      // The wind-down sentence (Codex #4715 r2 P2) is appended last — the
      // card hides `message` whenever `warning` is also present.
      warning: (() => {
        const churnBlocked = errors.filter((e) => e.churn_blocked);
        const other = errors.length - churnBlocked.length;
        const parts = [];
        if (churnBlocked.length) parts.push(`${churnBlocked.length} refused (${churnBlocked.map((e) => e.error).join('; ')})`);
        if (other) parts.push(`${other} no longer resolved at commit`);
        return `${errors.length} of ${count + errors.length} customers were NOT updated — ${parts.join('; ')}; ${count} updated.${woundDownMessage ? ` ${woundDownMessage}` : ''}`;
      })(),
    } : {}),
    // Churn billing disarm disclosure (GitHub Codex #4684 r4) — same
    // contract as the fast CASE path above.
    ...(woundDownMessage ? {
      billing_wound_down_count: churnWoundDownCount,
      rails_repaired_count: railsRepairedCount,
      message: woundDownMessage,
    } : {}),
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


// cancel_plan (cancel-flow C3) — the admin Cancel plan service behind the
// #1568 trust boundary: unconfirmed = the server-computed preview (no
// writes); confirmed (attached ONLY by /confirm-action) = commit with the
// operator recorded as the actor. Same shape the Customer 360 dialog uses.
function cancelPlanServiceInput(input) {
  return {
    families: Array.isArray(input.families) ? input.families : [],
    effectiveDate: input.effective_date || 'now',
    prepayDisposition: input.prepay_disposition || null,
    waiveLateFee: input.waive_late_fee === true,
    sendConfirmation: input.send_confirmation !== false,
    reasonCode: input.reason_code || null,
    note: input.note || '',
    // Pinned at proposal time by the pending-action layer; the commit
    // refuses (preview_changed) when the live facts no longer match it.
    previewFingerprint: input._approved_cancel_plan_fingerprint || null,
  };
}

async function cancelPlan(input, actionContext = {}) {
  const customerId = input.customer_id;
  if (!customerId) return { error: 'customer_id is required' };
  const AdminCancellation = require('../admin-cancellation');
  const serviceInput = cancelPlanServiceInput(input);

  // BOTH confirmation signals, or it's a preview: /confirm-action is the
  // only caller that attaches input.confirmed AND actionContext.confirmed
  // (route-derived, never client params) — so a params-level confirmed
  // smuggled through /execute or the model loop still previews (same
  // posture as the estimate tools' actionContext.confirmed gate). This is
  // never preview-only: UI confirmation is STRUCTURAL (W0B — no env value
  // restores model-loop writes), cancel_plan is registered in
  // write-gates.js, so every commit arrives via a pending action's
  // /confirm-action.
  if (input.confirmed !== true || actionContext.confirmed !== true) {
    let preview;
    try {
      preview = await AdminCancellation.previewCancelPlan({ customerId, ...serviceInput });
    } catch (err) {
      if (err && err.code) return { error: err.message, code: err.code };
      throw err;
    }
    // An UNEXECUTABLE preview is a tool failure, not a card: proposePendingWrite
    // only treats `error` as failure, so a card for an ineligible account or
    // an unsupported scope would deterministically fail on Confirm and
    // consume a pending action (deferred P2 from #3666 r32).
    if (!preview.eligible) {
      return { error: 'There is no active plan, recurring service, or upcoming visit on this account to cancel.', code: 'nothing_to_cancel' };
    }
    if (preview.scopedSupported === false) {
      const why = preview.scopeError === 'scope_not_owned'
        ? 'That service is not on the plan any more.'
        : preview.scopeError === 'scoped_covers_prepaid'
          ? 'Upcoming visits in that selection are covered by the annual prepay term — cancel the whole plan, or leave the covered service in place.'
          : 'The services that would stay cannot be priced from the plan-rate ledger — cancel the whole plan, or repair the ledger first.';
      return { error: why, code: preview.scopeError || 'scoped_unsupported' };
    }
    const impact = preview.impact || {};
    return {
      preview: true,
      customer_id: customerId,
      customer_name: preview.customer.name,
      eligible: preview.eligible,
      repair_retry: preview.repairRetry === true,
      whole_account: preview.wholeAccount,
      scope: preview.scopeLabels,
      scoped_supported: preview.scopedSupported,
      scope_error: preview.scopeError,
      owned_families: (impact.families || []).map((f) => ({ key: f.key, label: f.label, upcoming_visits: f.upcomingVisits, next_visit: f.nextVisitDate })),
      visits_to_pull: impact.visitsCancelled ?? null,
      next_visit_cancelled: impact.nextVisitCancelled || null,
      tier_before: impact.tierBefore || null,
      tier_after: impact.tierAfter || null,
      monthly_before: impact.accountMonthlyBefore ?? null,
      monthly_after: impact.accountMonthlyAfter ?? null,
      open_balance: impact.openBalance ?? null,
      termite_retrieval: impact.termiteRental === true,
      effective_date: preview.effectiveDate,
      effective_on: preview.effectiveOn,
      prepay: preview.prepay,
      // Scheduled-visit fee exposure on the pulled visits (both card fee
      // lanes) — the confirmation card must show the fee-or-waive choice
      // before the money-moving commit; unresolved = fee may apply.
      visit_fees: preview.visitFees,
      // Per-application repricing of surviving visits (scoped, per-visit
      // billing lane) — charge changes the confirmation card must show.
      per_app_changes: Array.isArray(impact.perAppChanges) ? impact.perAppChanges : [],
      waive_late_fee: preview.waiveLateFee,
      send_confirmation: preview.sendConfirmation,
      confirmation_channels: preview.confirmationChannels,
      preview_fingerprint: preview.previewFingerprint,
      reason_code: preview.reasonCode,
      note: preview.note || null,
      note_to_operator: 'PREVIEW ONLY — nothing was cancelled. The operator commits from the confirmation card; the customer is texted and emailed only if send_confirmation stays on.',
    };
  }

  try {
    const outcome = await AdminCancellation.commitCancelPlan({
      customerId,
      ...serviceInput,
      actor: { type: 'ib', userId: actionContext.technicianId || null },
    });
    logger.info(`[intelligence-bar] cancel_plan committed for customer ${customerId} (request ${outcome.requestId}, processed=${outcome.processed})`);
    return {
      success: true,
      customer_id: customerId,
      request_id: outcome.requestId,
      processed: outcome.processed,
      visits_pulled: outcome.visitsPulled,
      scope: outcome.scope,
      remaining: outcome.remaining,
      tier_before: outcome.tierBefore,
      tier_after: outcome.tierAfter,
      effective_date: outcome.effectiveDate,
      late_fee_waived: outcome.lateFeeWaived,
      prepay_disposition: outcome.prepayDisposition,
      ...(outcome.refund ? { refund: outcome.refund } : {}),
      confirmation_channels: outcome.confirmationChannels,
      ...(outcome.errors.length ? {
        // review_alert_failed IS the alert write failing — claiming an
        // alert was raised in exactly that case sends the operator to rely
        // on follow-up that will never come (same truth rule as the dialog).
        warning: `Auto-processing did not fully complete (${outcome.errors.join(', ')})`
          + (outcome.errors.includes('review_alert_failed')
            ? ' — the office review alert could NOT be raised; flag the office manually.'
            : ' — an office review alert was raised.'),
      } : {}),
    };
  } catch (err) {
    if (err && err.code) return { error: err.message, code: err.code };
    throw err;
  }
}

// Terminal scheduled_services statuses — one-way; never movable. Shared
// with the route's proposal guard via proposal-pins (codex r7 on #3648).
const { TERMINAL_APPOINTMENT_STATUSES } = require('./proposal-pins');
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

// Recency resolver for "the customer we just finished": completed visits,
// newest first. The close-out moment is completion EVIDENCE only, in
// preference order: the completed transition in job_status_history
// (transitionJobStatus inserts it in the completion trx; the retired
// legacy status-log table's evidence was migrated into it) →
// ss.completed_at. Never ss.updated_at
// (touched by unrelated edits — an old visit would outrank the actual
// latest completion) and never completed_at first (the tracker can
// backdate it to an older service DAY, see admin-dispatch
// BACKFILL_RECORD_END_FIELDS). A completed row with NO completion evidence
// at all is omitted rather than mis-ranked.
const CLOSED_OUT_AT_SQL = `COALESCE(
  (SELECT MAX(jsh.transitioned_at) FROM job_status_history jsh
    WHERE jsh.job_id = ss.id AND jsh.to_status = 'completed'),
  ss.completed_at)`;

async function getRecentCompletions(input = {}) {
  // Floor defensively even though the schema says integer — a fractional
  // limit binds into Postgres's integer LIMIT and errors, and a fractional
  // days would be reported unchanged in days_searched (codex P2 on #3633).
  const limit = Math.min(Math.max(Math.floor(Number(input.limit)) || 5, 1), 20);
  const days = Math.min(Math.max(Math.floor(Number(input.days)) || 2, 1), 30);
  // ET calendar-day cutoff (not a rolling 24h window): "today" must mean the
  // America/New_York service day, so days=1 never leaks yesterday-evening
  // completions into a morning query. timestamptz AT TIME ZONE ET → ::date
  // is the house pattern for ET day comparison.
  const cutoffEtDay = etDateString(addETDays(new Date(), -(days - 1)));
  const rows = await db('scheduled_services as ss')
    .join('customers as c', 'c.id', 'ss.customer_id')
    .leftJoin('technicians as t', 't.id', 'ss.technician_id')
    .where('ss.status', 'completed')
    .whereRaw(`${CLOSED_OUT_AT_SQL} IS NOT NULL`)
    .whereRaw(`(${CLOSED_OUT_AT_SQL} AT TIME ZONE 'America/New_York')::date >= ?::date`, [cutoffEtDay])
    .orderByRaw(`${CLOSED_OUT_AT_SQL} DESC`)
    .limit(limit)
    .select(
      'ss.id', 'ss.customer_id', 'c.first_name', 'c.last_name',
      'ss.service_type', 'ss.scheduled_date',
      db.raw(`${CLOSED_OUT_AT_SQL} as closed_out_at`),
      't.name as technician_name',
    );
  return {
    completions: rows.map(r => ({
      scheduled_service_id: r.id,
      customer_id: r.customer_id,
      customer: `${r.first_name} ${r.last_name || ''}`.trim(),
      service_type: r.service_type,
      scheduled_date: r.scheduled_date,
      completed_at: r.closed_out_at,
      technician: r.technician_name || null,
    })),
    total: rows.length,
    days_searched: days,
  };
}

// A technician name match must be UNIQUE among active technicians before an
// appointment binds to it (mirrors comms-tools resolveCustomer). Returns a
// row, null (no match), or { error, ambiguous, candidates }. The error
// string is persisted in tool-health telemetry, so it carries no typed name;
// the candidates array holds the detail and only reaches the operator.
async function resolveTechnicianByName(name) {
  const matches = await applyAssignable(db('technicians').whereILike('technicians.name', `%${name}%`))
    .limit(2);
  if (matches.length > 1) {
    return {
      error: 'Multiple technicians match that name. Ask the operator which one, then retry with technician_id.',
      ambiguous: true,
      candidates: matches.map(t => ({ id: t.id, name: t.name })),
    };
  }
  return matches[0] || null;
}

// The catalog's WaveGuard member discounts, by their stable keys — never
// inferred from shared attributes, so an unrelated Bronze promotion can
// never pose as one. The discount engine's own eligibility then picks the
// row that fits this service. The free-WDO member row is left out: a WDO
// inspection bills from its project's inspection fee, which never reads the
// visit's price, so a $0 booking would still be invoiced (owner 2026-09-27:
// WDO stays out until that fee honors the member perk).
const MEMBER_DISCOUNT_KEYS = ['waveguard_member'];

// Live recurring coverage: the "or recurring customers" half of the owner's
// rule (2026-09-27), through the canonical lifecycle in
// waveguard-existing-services.js (callbacks and one-time sources excluded,
// in-progress rows across ET midnight kept, inactive customers rejected) —
// the customer's live recurring obligation ROWS being non-empty, not the
// owned-keys set: a palm-injection or termite-bond plan is a live recurring
// plan that maps to no ownership family (Codex r5, r7). A catalog-join
// failure fails CLOSED (no automatic discount).
// The customer's live recurring obligation rows (the canonical lifecycle in
// waveguard-existing-services). On the locked recheck (conn is the booking
// transaction) they are share-locked and re-read (Codex r10, r11): a series
// cancel that ends them concurrently either commits first — and the re-read
// drops them — or waits for this booking. Locks are taken in the series
// writers' own order (admin-dispatch.js: scheduled_date, window_start, id)
// so the two paths can never deadlock. Throws on a loader failure.
async function liveRecurringObligationRows(customerId, conn = db) {
  const { loadLiveRecurringObligationRows, TERMINAL_STATUSES } = require('../waveguard-existing-services');
  const rows = await loadLiveRecurringObligationRows(conn, customerId);
  if (!Array.isArray(rows) || rows.length === 0) return [];
  if (conn === db) return rows;
  const locked = await conn('scheduled_services')
    .whereIn('id', rows.map((r) => r.id))
    .whereNotIn('status', TERMINAL_STATUSES)
    .orderBy(['scheduled_date', 'window_start', 'id'])
    .forShare()
    .select('id');
  const live = new Set((Array.isArray(locked) ? locked : []).map((r) => r.id));
  return rows.filter((r) => live.has(r.id));
}

async function hasLiveRecurringCoverage(customerId, conn = db) {
  try {
    return (await liveRecurringObligationRows(customerId, conn)).length > 0;
  } catch (err) {
    logger.warn(`[intelligence-bar] live recurring obligation read failed for customer ${customerId}; treating as no live recurring coverage: ${err.message}`);
    return false;
  }
}

// Live recurring coverage counts toward the "or recurring customers" member
// floor only for an ACTIVE customer (Codex r2 on #5093, P1) — a churned
// account (active === false) can carry a stale future recurring row no one
// closed out, and that row must not grant a member discount. Mirrors
// isActivePlanCustomer / loadActiveRecurringServiceRows's own active===false
// fail-closed guard (waveguard-existing-services.js:70-77, 151-155). Every
// caller of the recurring-coverage evidence (the member line discount AND
// the mosquito ladder default) goes through this, not the raw row query.
async function activeCustomerHasLiveRecurringCoverage(customer, conn = db) {
  if (!customer?.id || customer.active === false) return false;
  return hasLiveRecurringCoverage(customer.id, conn);
}

// The WaveGuard member discount a member's one-off catalog visit carries
// (owner 2026-09-27: "members or recurring customers get 15% off"): the
// first member row the discount engine finds eligible — for a member by
// tier or monthly rate, or for a customer with live recurring coverage,
// which meets the same Bronze floor the engine opens for recurring
// coverage (the only extra query, run only when the plain check fails).
// Returns { row, recurringCustomer } or null.
async function memberOneOffDiscount({ customer, catalogRow, listPrice, conn = db }) {
  // An inactive customer is no member, whatever tier a cancellation left on
  // the row (the wind-down gate can retain it) — isActivePlanCustomer's rule.
  if (!customer || customer.active === false) return null;
  // WDO bills from the project's inspection fee, not the visit (see
  // MEMBER_DISCOUNT_KEYS) — a line discount here would promise what the
  // invoice ignores.
  if (catalogRow.service_key === 'wdo_inspection') return null;
  const rows = await conn('discounts')
    .whereIn('discount_key', MEMBER_DISCOUNT_KEYS)
    .where({ is_active: true, show_in_invoices: true })
    .orderBy('priority', 'asc')
    .orderBy('id', 'asc')
    .select('*');
  if (!Array.isArray(rows) || !rows.length) return null;
  const DiscountEngine = require('../discount-engine');
  // The same catalog exclusion the Schedule screen's own appointment-level
  // discount already enforces (admin-schedule.js lineExcludedFromPercentDiscount,
  // POLICY.md 155-163) — Codex r2 on #5093, P1: the generic waveguard_member
  // row carries no service filter, so without this guard an excluded service
  // (bed bug, Bora-Care, pre-slab, termite bond, rodent bait, ...) would get
  // 15% off through this AUTOMATIC application, which no operator picked and
  // no service-scoped filter caught. A row is skipped only when it is BOTH a
  // percentage type AND the booked service is excluded — the WDO free perk
  // (waveguard_member_wdo, also `percentage`) survives because wdo_inspection
  // itself is not an excluded family.
  const {
    lineExcludedFromPercentDiscount, isPercentDiscountType,
    assertPercentExclusionCatalogReady, primePercentDiscountExclusions,
  } = require('../../routes/admin-schedule');
  // The in-router calculators get this catalog primed for free (the
  // admin-schedule router awaits primePercentDiscountExclusions before any
  // handler runs, then calls assertPercentExclusionCatalogReady synchronously)
  // — this path has no such middleware, so without awaiting the prime here a
  // variant key excluded ONLY via the catalog's engine_keys link (e.g.
  // bed_bug_treatment, not a literal WAVEGUARD family key) would resolve
  // against an empty/stale catalog and wrongly qualify for the automatic
  // 15% (Codex r3 on #5093, P1: "first booking after boot"). Await the same
  // prime the middleware runs, then assert the same readiness the
  // calculators do — fail closed (refuse the automatic discount lookup)
  // rather than price it against a catalog that never loaded.
  // Only the unlocked pass refreshes: the prime reads on the global pool, and
  // the locked recheck already holds a transaction connection (a small pool
  // could stall both). Readiness never lapses once loaded, so the locked pass
  // just asserts it.
  if (conn === db) await primePercentDiscountExclusions();
  assertPercentExclusionCatalogReady();
  const serviceExcluded = lineExcludedFromPercentDiscount(catalogRow.service_key || null);
  const context = { subtotal: listPrice, serviceKey: catalogRow.service_key || null, serviceCategory: catalogRow.category || null };
  const firstEligible = async (recurringMembershipBooking) => {
    for (const row of rows) {
      if (serviceExcluded && isPercentDiscountType(row.discount_type)) continue;
      const failures = await DiscountEngine.manualEligibilityFailures(row, customer, { ...context, recurringMembershipBooking }, conn);
      if (!failures.length) return row;
    }
    return null;
  };
  const byMembership = await firstEligible(false);
  if (byMembership) return { row: byMembership, recurringCustomer: false };
  if (!(await activeCustomerHasLiveRecurringCoverage(customer, conn))) return null;
  const byRecurring = await firstEligible(true);
  return byRecurring ? { row: byRecurring, recurringCustomer: true } : null;
}

// The booking's price, the way a Schedule-screen booking gets one (owner
// 2026-09-27: the Intelligence Bar books like the Schedule screen, it does
// not send the operator there). Both paths run the Schedule POST's own
// buildAppointmentPricing: an operator-stated price is the primary line
// price; with none, the price the Schedule screen pre-fills for the named
// catalog service (the one-time mosquito lot ladder, else the catalog price
// range minimum, else its base price). The catalog row resolves through
// resolveBookingCatalogRow — one identity or a refusal, never a guess: a
// price must come from the service the operator named. A free visit type
// (appointment / estimate / re-service / follow-up) never carries a price —
// completion never bills one. Returns { price, source, catalogRow, pricing }
// or { error }.
// The one catalog row a booking names, or an ambiguity. An exact name (with
// the rename-bridging candidates) or a service key identifies a row; a short
// name only counts when exactly ONE active row carries it. The live catalog
// shares "Lawn Care" across five services and "Mosquito" across a recurring
// and a one-time row, and a first match there prices — and bills — the
// wrong service (the fail-closed rule of catalog-shortname-ambiguity.test.js).
function resolveBookingCatalogRow(services, serviceType) {
  const norm = (v) => String(v || '').trim().toLowerCase();
  const { serviceNameCandidates } = require('../service-completion-profiles');
  for (const candidate of serviceNameCandidates(serviceType)) {
    const want = norm(candidate);
    const hits = services.filter((s) => norm(s.name) === want || norm(s.service_key) === want);
    if (hits.length === 1) return { row: hits[0] };
    if (hits.length > 1) return { ambiguous: hits };
  }
  const byShortName = services.filter((s) => s.short_name && norm(s.short_name) === norm(serviceType));
  if (byShortName.length === 1) return { row: byShortName[0] };
  if (byShortName.length > 1) return { ambiguous: byShortName };
  return { row: null };
}

async function ibBookingPricing({ customer, serviceType, statedPrice, conn = db }) {
  const services = await conn('services').where({ is_active: true })
    .select('id', 'name', 'short_name', 'service_key', 'base_price', 'price_range_min', 'category', 'billing_type');
  const match = resolveBookingCatalogRow(Array.isArray(services) ? services : [], serviceType);
  if (match.ambiguous) {
    const names = match.ambiguous.map((r) => r.name).join(', ');
    return { error: `"${serviceType}" names several catalog services (${names}) — use the exact service name and propose again. Nothing was booked.` };
  }
  const catalogRow = match.row;
  const stated = statedPrice !== undefined && statedPrice !== null;
  if (isAlwaysFreeServiceType(serviceType)) {
    if (stated) {
      return { error: `"${serviceType}" is a free visit type — completion never bills it, so it cannot carry a price. Book it without one, or name the billable service. Nothing was booked.` };
    }
    return { price: null, source: null, catalogRow, pricing: null };
  }
  // A price rides a real catalog service, as on the Schedule screen (its
  // modal prices only a picked catalog row) — never an invented service
  // type with a null service_id, the shape AGENTS.md bars for bookings.
  if (stated && !catalogRow) {
    return { error: `"${serviceType}" is not a catalog service, so the price has nothing to attach to. Use the service's exact catalog name and propose again. Nothing was booked.` };
  }
  if (!catalogRow) return { price: null, source: null, catalogRow: null, pricing: null };
  // A dues-billed member's PLAN service carries no catalog default: the
  // Schedule POST strips the price and create-invoice stamps from a member's
  // recurring series (memberSeriesCovered — monthly lane, no payer), and
  // completion prices a non-recurring visit out of dues coverage, so a
  // defaulted price here would invoice a plan visit on top of the dues. An
  // operator-stated price still stands: an extra visit they chose to bill.
  //
  // "Dues-covered" requires actually OWNING the booked row's service family
  // (Codex round 5, P2) — the billing_type/mode/payer check above only says
  // this customer is a dues member on SOME recurring plan, not that THIS
  // catalog row is that plan. A lawn-only member booking a one-off pest
  // visit is not dues coverage for pest — it is a one-off extra, priced at
  // catalog less the member 15% like any other one-off member booking below.
  // Ownership is the families of the customer's live recurring obligation
  // rows (the canonical lifecycle, share-locked on the locked recheck like
  // the discount evidence — Codex r11) against the booked row's OWN family
  // (ownershipKeysForRow) — never a fresh approximation. Only a POSITIVE ownership match is dues coverage (Codex
  // r6): a row with no ownership family (a termite bond is recurring and
  // priced, yet owns no family) prices as a one-off, shown on the card; a
  // failed ownership read refuses rather than guess either way.
  if (!stated && catalogRow.billing_type === 'recurring' && !customer?.payer_id
    && resolveBillingLane(customer).mode === 'monthly_membership') {
    const { ownershipKeysForRow } = require('../waveguard-existing-services');
    const bookedFamilyKeys = ownershipKeysForRow({ service_key: catalogRow.service_key, service_name: catalogRow.name });
    let duesCovered = false;
    if (bookedFamilyKeys.length && customer?.id) {
      try {
        const owned = new Set();
        for (const row of await liveRecurringObligationRows(customer.id, conn)) ownershipKeysForRow(row).forEach((k) => owned.add(k));
        duesCovered = bookedFamilyKeys.some((key) => owned.has(key));
      } catch (err) {
        logger.warn(`[intelligence-bar] live recurring ownership read failed for monthly-lane customer ${customer.id}: ${err.message}`);
        return { error: 'Could not read which plan services this member owns, so whether their dues cover this visit is unknown. Try again in a moment, or state the price. Nothing was booked.' };
      }
    }
    if (duesCovered) {
      return { price: null, source: null, catalogRow, pricing: null };
    }
    // Not owned: falls through as an ordinary one-off catalog booking, which
    // picks up the member discount below exactly like any other one-off.
  }
  // The Schedule modal's own pre-fill for a picked catalog line
  // (CreateAppointmentModal addServiceFromCatalog), sent as the line price:
  // blank for the one-time mosquito line, so the server's lot ladder prices
  // it; otherwise the price range minimum, else the base price. A $0
  // default is no price here (unpriced is NULL, never $0), and the
  // billable-amount gate below decides.
  const catalogDefault = catalogRow.service_key === 'mosquito_one_time'
    ? undefined
    : (catalogRow.price_range_min ?? catalogRow.base_price ?? undefined);
  // Lazy: the route module is large and requires services that require this
  // module (same avoid-a-route-load-cycle pattern as schedule-tools).
  const { buildAppointmentPricing } = require('../../routes/admin-schedule');
  // A member's one-off visit carries the member discount, as a line
  // discount through the same builder a picked discount rides on the
  // Schedule screen. This tool books ONE non-recurring visit, so any
  // catalog-priced visit here is a one-off (a dues member's plan visit
  // already returned unpriced above). Not for a stated price (the
  // operator's own number) or the one-time mosquito line (its lot ladder
  // already prices members as recurring customers).
  const memberDiscount = !stated && Number(catalogDefault) > 0
    ? await memberOneOffDiscount({ customer, catalogRow, listPrice: Number(catalogDefault), conn })
    : null;
  // The mosquito ladder's OWN "or recurring customers" floor (Codex r2 on
  // #5093, P1): mosquitoOneTimeDefaultPrice (admin-schedule.js) only ORs in
  // whatever recurringMembershipBooking carries — a tierless customer whose
  // ONLY qualifying evidence is live recurring coverage never reaches
  // memberOneOffDiscount above (mosquito's catalogDefault is `undefined`,
  // so `Number(catalogDefault) > 0` is false), so without this the ladder
  // silently prices them at the flat nonmember rate. hasMembership is
  // checked first so the extra query only runs when it's actually needed.
  const { hasMembership } = require('../project-completion');
  const mosquitoRecurringOverride = !stated && catalogRow.service_key === 'mosquito_one_time' && !hasMembership(customer)
    ? await activeCustomerHasLiveRecurringCoverage(customer, conn)
    : false;
  const pricing = await buildAppointmentPricing({
    serviceRecord: catalogRow,
    serviceType,
    serviceId: catalogRow.id,
    primaryLinePrice: stated ? statedPrice : catalogDefault,
    ...(memberDiscount ? { primaryLineDiscount: { discountId: memberDiscount.row.id } } : {}),
    // The builder re-checks the discount's eligibility; a recurring
    // customer's Bronze floor rides the same recurring-coverage flag — ORed
    // with the mosquito ladder's own override above so a tierless recurring
    // customer's one-time mosquito line prices at the member rate too.
    recurringMembershipBooking: !!memberDiscount?.recurringCustomer || mosquitoRecurringOverride,
    customer,
    // The locked recheck (create_appointment's commit-time re-derivation)
    // must read the discount row and its eligibility on the SAME trx as the
    // locked customer row, not a racing global-db read (Codex r2 on #5093,
    // P2) — conn defaults to db, so the unlocked preflight pass is unchanged.
    conn,
  });
  // A $0 price is no price at all.
  const priced = Number(pricing.finalPrice) > 0;
  if (!priced) return { price: null, source: null, catalogRow, pricing: null };
  return { price: Number(pricing.finalPrice), source: stated ? 'stated' : 'catalog', catalogRow, pricing };
}

// A discounted booking's line-discount columns and pricing-regime marker,
// through the same shared stamps the Schedule create writes. Only a
// discounted booking pays for the column read.
async function bookingDiscountStamps(trx, pricing) {
  if (!pricing?.primaryDiscount) return {};
  const cols = await trx('scheduled_services').columnInfo();
  const stamps = {};
  stampPrimaryLineDiscount(stamps, pricing, cols);
  if (discountStackingLive()) stampPricingRegimeMarker(stamps, cols, capsSnapshotFromPricing(pricing));
  return stamps;
}

// Cent-exact comparison of two booking prices (null = no price).
function sameBookingPrice(a, b) {
  if (a == null || b == null) return a == null && b == null;
  return Math.round(Number(a) * 100) === Math.round(Number(b) * 100);
}

// The discount identity + terms a booking's pricing carries, in the same
// shape the proposal pins (Codex r2 on #5093, P1): the card shows the GROSS
// list price and the discount's name/percent, but the executor previously
// compared only the NET _booking_price and the service id — a discount
// that changed (a different row, a re-typed percent, a deactivated preset
// swapped for another that nets the same dollars) could commit a visit the
// card never actually showed. null when the booking carries no discount.
function bookingDiscountFingerprint(booking) {
  const discount = booking?.pricing?.primaryDiscount || null;
  return {
    listPrice: discount ? Number(booking.pricing.primaryBase) : null,
    discountId: discount?.discountId ?? null,
    discountName: discount?.discountName ?? null,
    discountType: discount?.discountType ?? null,
    discountAmount: discount ? Number(discount.discountAmount) : null,
  };
}

// True when two fingerprints (or a fingerprint and the proposal's pinned
// fields) name the SAME discount at the SAME terms on the SAME gross price.
// discountName rides the comparison too (Codex r3 on #5093, P2): id/type/
// amount alone miss a preset RENAMED between the proposal read and the
// locked recheck (resolveLineDiscount re-reads the row fresh each pass) —
// the card would show the old name while the stamped line_discount_name
// carries the new one, an undisclosed drift the id/type/amount match alone
// would let through.
function sameBookingDiscount(a, b) {
  return sameBookingPrice(a.listPrice, b.listPrice)
    && String(a.discountId || '') === String(b.discountId || '')
    && String(a.discountName || '') === String(b.discountName || '')
    && String(a.discountType || '') === String(b.discountType || '')
    && sameBookingPrice(a.discountAmount, b.discountAmount);
}

const BOOKING_PRICE_CHANGED_ERROR = 'This visit\'s price or catalog service changed since the card was shown — nothing was booked. Ask again for a fresh confirmation card.';

// ADMIN-BUG-R12: a booking must never complete with no invoice when the
// customer's billing needs a number on the visit (per-visit and one-time
// lanes, annual prepay, per-application with no fee on file, a member with
// no monthly rate, a legacy row with no membership tier). The verdict is the
// Schedule screen's own billable-amount booking gate — one classifier, never
// a local lane list — so dues-covered members, per-application customers
// with a fee, free-by-design visit types, and every PRICED booking pass.
// Returns the model-facing refusal, or null when the booking bills or is free.
function ibBookingBillingRefusal(customer, serviceType, price) {
  const { recurringWithoutBillableAmount } = require('../../routes/admin-schedule');
  const priced = Number(price) > 0;
  // Below its recurring early return, the gate asks a question that does not
  // depend on recurrence: would completing a visit at this price, for this
  // customer, cut an invoice (or be dues-covered, or free by design)? Asked
  // for ONE visit with the stamps this insert writes: a priced booking
  // carries create_invoice_on_complete (the Schedule modal's own default), an
  // unpriced one carries neither, and no callback marker or typed one-time
  // profile (that mint trigger needs a price, and a priced booking already
  // mints through the create-invoice stamp).
  const verdict = recurringWithoutBillableAmount({
    isRecurring: true,
    recurringFloorPrice: priced ? price : 0,
    customer,
    createInvoiceOnComplete: priced,
    typedOneTimeBilling: false,
    isCallback: false,
    serviceType,
  });
  if (!verdict) return null;
  const orFee = verdict.fix?.perApplicationFee ? ', or set a per-application fee on the customer profile' : '';
  return `This visit needs a price: "${serviceType}" has no catalog price, and nothing in this customer's billing would invoice it. Ask the user for the visit price and propose the booking again with price${orFee}. Nothing was booked.`;
}

// Why the customer booked a re-service (scheduled_services.customer_request,
// migration 20260927100000): the operator's words for it, saved exactly as the
// Schedule screen's "Customer's words" box saves typed words — trimmed, capped,
// source 'office' (never a quote; the operator relayed it). Same gate and same
// two catalog rows as that box (reservice-office-request.js). Returns
// { text } to stamp, null when no reason was given, or { error } when a reason
// was given for a visit that cannot carry one — refused rather than dropped,
// so words the card showed are never silently lost.
function ibBookingCustomerRequest(rawRequest, catalogRow) {
  const reserviceOfficeRequest = require('../reservice-office-request');
  const text = reserviceOfficeRequest.cleanRequestText(rawRequest);
  if (!text) return null;
  const { isEnabled } = require('../../config/feature-gates');
  if (!isEnabled('reserviceOfficeRequest')
    || !reserviceOfficeRequest.isOfficeRequestServiceKey(catalogRow?.service_key)) {
    return { error: 'customer_request is saved only on a Pest Control Re-Service or Lawn Care Re-Service visit — nothing was booked. Propose the booking again with the reason in notes instead, or without it.' };
  }
  return { text };
}

// Proposal-time twin for the confirm-card route: the same price and billing
// verdict the executor asks at commit, so the card shows the price the
// booking will carry and a booking that would be refused never reaches a
// card. A read error THROWS (the caller fails the proposal closed); a missing
// customer returns null — the route's own customer pin refuses that case.
async function ibBookingProposal(customerId, serviceType, statedPrice, customerRequest) {
  const customer = await db('customers').where({ id: customerId }).first();
  if (!customer) return null;
  const booking = await ibBookingPricing({ customer, serviceType, statedPrice });
  if (booking.error) return { error: booking.error };
  const refusal = ibBookingBillingRefusal(customer, serviceType, booking.price);
  if (refusal) return { error: refusal };
  const request = ibBookingCustomerRequest(customerRequest, booking.catalogRow);
  if (request?.error) return { error: request.error };
  const discount = booking.pricing?.primaryDiscount || null;
  return {
    price: booking.price,
    source: booking.source,
    serviceId: booking.catalogRow?.id || null,
    serviceName: booking.catalogRow?.name || null,
    // The reason exactly as the insert will save it (trimmed, capped), so
    // the card shows the saved words; null when none was given.
    customerRequest: request?.text || null,
    listPrice: discount ? Number(booking.pricing.primaryBase) : null,
    discountName: discount?.discountName || null,
    discountPercent: discount && discount.discountType === 'percentage' ? Number(discount.discountAmount) : null,
    // The discount's own identity/terms (Codex r2 on #5093, P1) — carried
    // so the route can pin them alongside _booking_price/_booking_service_id
    // and the executor can refuse a commit whose discount drifted from what
    // this exact card showed (a different row, a re-typed percent, or a
    // preset swapped for one that happens to net the same dollars).
    discountId: discount?.discountId || null,
    discountType: discount?.discountType || null,
    discountAmount: discount ? Number(discount.discountAmount) : null,
  };
}

async function createAppointment(input, actionContext = {}) {
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
  // Retired-for-sale catalog rows (quarterly T&S) book only for a customer
  // already on that plan — the shared admin write gate (codex r13 on #4786).
  const notHeldRetired = await require('../service-library').retiredServicesNotHeldBy({
    customerId: customer_id, serviceTypes: [service_type],
  });
  if (notHeldRetired.length) {
    return { error: `${notHeldRetired.map((r) => r.name).join(', ')} is retired for new sales and this customer is not on that plan — nothing was booked.` };
  }
  // Same live-customer bar as update_customer (GH r9 P1): a profile
  // merged/soft-deleted while the card was pending must not receive a new
  // appointment after its records were repointed.
  if (customer.deleted_at) {
    return { error: 'This customer record is no longer live (deleted or merged since the card was shown) — nothing was booked.', preview_changed: true };
  }
  // The visit's price: the operator's stated price, else the Schedule
  // screen's catalog default. The card showed exactly this price (or none)
  // through the proposal's pins, so drift since then refuses — a booking
  // never carries a price the operator did not approve. A call with no pins
  // (never proposed through a card) may only book unpriced.
  const booking = await ibBookingPricing({ customer, serviceType: service_type, statedPrice: input.price });
  if (booking.error) return { error: booking.error };
  const approvedPrice = input._booking_price === undefined ? null : input._booking_price;
  const approvedServiceId = input._booking_service_id === undefined
    ? (booking.catalogRow?.id || null) : input._booking_service_id;
  // The discount identity/terms the card pinned (Codex r2 on #5093, P1) — a
  // call with no pins (never proposed through a card) approved no discount,
  // so it matches only a booking that also carries none.
  const approvedDiscount = {
    listPrice: input._booking_list_price === undefined ? null : input._booking_list_price,
    discountId: input._booking_discount_id === undefined ? null : input._booking_discount_id,
    discountName: input._booking_discount_name === undefined ? null : input._booking_discount_name,
    discountType: input._booking_discount_type === undefined ? null : input._booking_discount_type,
    discountAmount: input._booking_discount_amount === undefined ? null : input._booking_discount_amount,
  };
  if (!sameBookingPrice(approvedPrice, booking.price)
    || String(approvedServiceId || '') !== String(booking.catalogRow?.id || '')
    || !sameBookingDiscount(approvedDiscount, bookingDiscountFingerprint(booking))) {
    return { error: BOOKING_PRICE_CHANGED_ERROR, preview_changed: true };
  }
  // Refused before any lock or write when the visit could never bill
  // (ADMIN-BUG-R12); re-asserted on the locked row inside the booking
  // transaction below, since this read is unlocked.
  const billingRefusal = ibBookingBillingRefusal(customer, service_type, booking.price);
  if (billingRefusal) return { error: billingRefusal };
  // Why the customer booked (re-service rows only). The catalog row is the
  // one the price check above just pinned against the card, and the locked
  // re-read below refuses if it changed, so this verdict holds at the insert.
  const customerRequest = ibBookingCustomerRequest(input.customer_request, booking.catalogRow);
  if (customerRequest?.error) return { error: customerRequest.error };

  // Resolve the technician BEFORE any write. The old `.first()` on an
  // unordered ILIKE silently picked an arbitrary tech on multiple matches,
  // and a no-match silently created the visit UNASSIGNED — both surprises
  // the operator never approved. A pinned technician_id (set at proposal
  // time so the confirmation card names the tech) resolves by immutable id.
  let technician_id = null;
  let resolvedTechnicianName = null;
  if (input.technician_id) {
    // Same active bar as name resolution — a model-provided id, or a tech
    // deactivated during the confirmation window, must not take new visits.
    const tech = await resolveActiveTechnicianById(input.technician_id);
    if (!tech) return { error: 'Technician not found or no longer assignable' };
    technician_id = tech.id;
    resolvedTechnicianName = tech.name;
  } else if (technician_name) {
    const tech = await resolveTechnicianByName(technician_name);
    if (!tech) return { error: 'No technician matches that name — nothing was created. Retry with a corrected name, a technician_id, or omit the technician to leave the visit unassigned.' };
    if (tech.error) return tech;
    technician_id = tech.id;
    resolvedTechnicianName = tech.name;
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
  try {
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
    // Credit advisory lock BEFORE the customer row lock (pre-push r10 P1):
    // offer creation (recordInspectionCreditOffer) takes the credit lock
    // first and its offer INSERT then needs an FK key-share on this
    // customer row — row-lock-first here was the AB-BA half of a deadlock.
    // One consistent order: comms → credit advisory → customer row. The
    // later projection re-acquires the same xact-scoped key, a no-op.
    if (input._inspection_credit_amount !== undefined) {
      await require('../inspection-credit').lockInspectionCreditCustomer(trx, customer_id);
    }
    // Liveness re-asserted under the fence (GH r10 P1): the deleted_at
    // preflight above ran outside this transaction, so a merge/soft-delete
    // committing in between must abort the booking — never insert onto a
    // merged-away profile. Row-locked so the recheck holds through the
    // insert (comms lock before row lock, per the documented order).
    const lockedCustomer = await trx('customers')
      .where('id', customer_id).whereNull('deleted_at').forUpdate().first();
    if (!lockedCustomer) {
      const err = new Error('customer_no_longer_live');
      err.customerNoLongerLive = true;
      throw err;
    }
    // Price and billing verdict on the LOCKED row (ADMIN-BUG-R12): a lane,
    // rate, fee, lot-size or catalog edit committed since the preflight must
    // neither change the approved price nor slip an unbillable visit
    // through. The customer row stays locked through the insert, so both
    // hold for the row this booking writes against.
    const lockedBooking = await ibBookingPricing({
      customer: lockedCustomer, serviceType: service_type, statedPrice: input.price, conn: trx,
    });
    if (lockedBooking.error || !sameBookingPrice(lockedBooking.price, booking.price)
      || String(lockedBooking.catalogRow?.id || '') !== String(booking.catalogRow?.id || '')
      || !sameBookingDiscount(bookingDiscountFingerprint(lockedBooking), bookingDiscountFingerprint(booking))) {
      const err = new Error('booking_price_changed');
      err.bookingPriceChanged = true;
      throw err;
    }
    const lockedBillingRefusal = ibBookingBillingRefusal(lockedCustomer, service_type, lockedBooking.price);
    if (lockedBillingRefusal) {
      const err = new Error('booking_unbillable');
      err.bookingUnbillable = lockedBillingRefusal;
      throw err;
    }
    // Re-asserted FOR SHARE on the writing trx: the name/id resolution above
    // ran before this transaction opened.
    await assertAssignableTechnician(technician_id, { conn: trx, date: dateStr });
    const discountStamps = await bookingDiscountStamps(trx, lockedBooking.pricing);
    const [created] = await trx('scheduled_services').insert({
      customer_id,
      // Sole-active-property anchor for the visit-group stamp below —
      // see customer-properties.soleActivePropertyId (GH codex r3).
      property_id: await require('../customer-properties').soleActivePropertyId(customer_id, trx),
      scheduled_date: dateStr,
      service_type,
      technician_id,
      status: 'pending',
      window_start: win.start,
      window_end: windowEnd,
      notes: notes || null,
      ...(customerRequest ? {
        customer_request: customerRequest.text,
        customer_request_source: 'office',
      } : {}),
      // The catalog link and the price exactly as the Schedule POST stamps
      // them: service_id + key/category snapshots, and for a priced visit
      // estimated_price, the primary line's gross, and the create-invoice
      // flag its booking modal always sends.
      ...(lockedBooking.catalogRow ? {
        service_id: lockedBooking.catalogRow.id,
        service_key_snapshot: lockedBooking.catalogRow.service_key || null,
        service_category_snapshot: lockedBooking.catalogRow.category || null,
      } : {}),
      ...(lockedBooking.price != null ? {
        estimated_price: lockedBooking.price,
        primary_line_price: lockedBooking.pricing.primaryBase,
        create_invoice_on_complete: true,
      } : {}),
      ...discountStamps,
      created_at: new Date(),
      updated_at: new Date(),
    }).returning('*');
    appointment = created;
    // Visit groups (visit-group-scope.md §2): stamp at scheduling —
    // gate-checked + best-effort + self-refusing inside maybeGroupRow
    // (savepoint on the trx; a grouping failure never poisons the booking;
    // the IB write-gate confirm boundary is upstream and unaffected).
    await require('../visit-groups').maybeGroupRow(created.id, { database: trx, createdBy: 'dispatch' });
    // W0B authorization pin: a card-confirmed booking is approved as
    // credit-FREE (credit-bearing bookings are refused at proposal). Verify
    // inside the booking transaction — if an open credit appeared since the
    // card, abort before the marker/redemption can consume it undisclosed.
    if (input._inspection_credit_amount !== undefined) {
      // Customer-scoped credit lock shared with offer creation: an offer
      // being recorded concurrently either commits BEFORE this projection
      // (and the mismatch aborts the booking) or waits until this booking
      // has committed with its event (and is redeemed by the next booking,
      // exactly as the card said). No READ COMMITTED blind spot remains.
      // COMPLETE offer set, gate-paused offers included (pre-push P0 + GH
      // r19 P1 reconciliation): the proposal refuses whenever ANY offer
      // exists, so this locked re-check must see the same full set — a
      // paused offer appearing since the card aborts rather than being
      // stamped over (which would orphan it) or minted later (which the
      // card never approved).
      await require('../inspection-credit').lockInspectionCreditCustomer(trx, customer_id);
      const projected = await require('../inspection-credit').projectRedeemableOfferAmount(customer_id, { dbh: trx, includePaused: true });
      const live = Number(projected?.amount ?? projected) || 0;
      if (live !== Number(input._inspection_credit_amount)) {
        const err = new Error('booking_credit_changed');
        err.previewChanged = true;
        throw err;
      }
    }
    // The booking event is a FACT the credit rails require ("this customer
    // booked") — never skipped, even for a card-approved credit-free
    // booking: an offer committed concurrently would otherwise lose its
    // proof forever (silent permanent credit loss). The credit-free
    // promise is enforced by the customer-scoped credit lock taken above,
    // which offer creation shares.
    await require('../inspection-credit').markBookingForInspectionCredit(trx, {
      customerId: customer_id,
      scheduledServiceId: created.id,
      // A card-approved credit-free booking stamps the dedicated source:
      // its event proves "this customer booked" but is NEVER adoptable by
      // an offer serialized after it (pre-push P0 on #3648 r7 — the
      // recovery path backdates offer created_at to the promise moment, so
      // a late offer's timestamp can sort BEFORE this booking and the
      // sweep would mint against a booking whose card said no credit; the
      // late offer now redeems on the NEXT booking instead, the ratified
      // r6b contract).
      // Safe unconditionally: the locked full-set check above guarantees
      // ZERO open offers (paused included) existed when a card-approved
      // booking reaches this stamp — no promise can be orphaned by it.
      source: input._inspection_credit_amount !== undefined
        ? require('../inspection-credit').CREDIT_FREE_CARD_EVENT_SOURCE
        : 'intelligence_bar',
    });
  });
  } catch (err) {
    if (err && err.customerNoLongerLive) {
      return { error: 'This customer record is no longer live (deleted or merged since the card was shown) — nothing was booked.', preview_changed: true };
    }
    if (err && err.bookingUnbillable) {
      return { error: err.bookingUnbillable, preview_changed: true };
    }
    if (err && err.bookingPriceChanged) {
      return { error: BOOKING_PRICE_CHANGED_ERROR, preview_changed: true };
    }
    if (err && err.previewChanged) {
      return {
        error: 'This customer\'s inspection credit changed after the card was shown — nothing was booked. Ask again for a fresh confirmation card.',
        preview_changed: true,
      };
    }
    throw err;
  }

  // Tech-facing "new visit" card (tech-visit-notifications.js): this writer
  // inserts the assigned row itself, bypassing assignDispatchJob, so it tells
  // the tech itself. Queued FIRST after commit, before the awaited redemption
  // and reminder steps, so a reassignment seconds after creation cannot
  // overtake it in the visit's notice queue. Best-effort, never awaited;
  // gate-dark; silent when the operator IS the tech.
  if (technician_id) {
    void require('../tech-visit-notifications').notifyTechVisitChange({
      visitId: appointment.id, kind: 'assigned', technicianId: technician_id, actorId: actionContext.technicianId || null,
      snapshot: { date: dateStr, windowStart: win.start || null, windowEnd: windowEnd || null },
    });
  }

  // Card-confirmed bookings are approved credit-free (W0B): skip ONLY the
  // immediate redemption so this Confirm can never mint credit — an offer
  // created after the card is applied by the hourly sweep, the documented
  // ambient path. Reminder registration below still runs (codex r5 P1: an
  // earlier early-return here silently skipped it).
  if (input._inspection_credit_amount === undefined) {
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
  }

  // Register the durable confirmation/reminder row synchronously with the
  // insert, like the canonical admin create path (admin-schedule POST) —
  // without it the 72h/24h reminder cron never sees the visit. The booking
  // confirmation text goes out exactly as a Schedule-screen booking's does
  // (owner 2026-09-27): registered deferred here, sent after the result is
  // built (below), and the card discloses it.
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
  let reminderWarning = null;
  // Set only when the visit turned terminal (cancelled/completed/skipped/
  // no_show) in the window between the insert commit and registration
  // finishing — same race window admin-schedule.js:~1468-1488 covers for
  // spawned visits (Codex r3 on #5093, P1: this create path registers a
  // reminder post-commit too, and had no equivalent recheck).
  let visitWentTerminal = false;
  // Set only when the visit's status is 'rescheduled' after registration
  // (P2, round 5): cancelSpawnedReminderIfVisitTerminal correctly treats
  // 'rescheduled' as NON-terminal (the reminder must stay armed for the
  // rebook — the coverage module's own terminal list excludes it), but a
  // visit awaiting rebooking is not a visit to send "see you then" for
  // either. Read once, after registration, on db — same status this
  // customer-portal reschedule flow just committed.
  let visitNotLive = false;
  const AppointmentReminders = require('../appointment-reminders');
  try {
    // The Schedule create's own options: fromCommittedRow reads the time
    // from the committed row, and a windowless booking's row is a
    // non-delivering placeholder (it never texts an 08:00 nobody chose).
    const registered = await AppointmentReminders.registerAppointment(
      appointment.id, customer_id,
      `${dateStr}T${win.start || '08:00'}`,
      service_type, 'admin_ib',
      { sendConfirmation: true, deferConfirmation: true, closeReminderWindows: !win.start, fromCommittedRow: true },
    );
    // registerAppointment reports its own failures as null (it alerts and
    // never rejects) — the same partial failure as a throw.
    if (!registered) throw new Error('registerAppointment returned no reminder row');
    // Reuse the canonical spawned-visit recheck (admin-schedule.js) rather
    // than a parallel copy: it re-reads the visit's current status and, if
    // terminal, cancels the fresh reminder row itself — the same cleanup a
    // series cancel landing in this window gets on every other registration
    // path.
    const { cancelSpawnedReminderIfVisitTerminal } = require('../../routes/admin-schedule');
    visitWentTerminal = await cancelSpawnedReminderIfVisitTerminal(db, appointment.id, 'intelligence-bar');
    if (!visitWentTerminal) {
      // Best-effort, like the terminal recheck above: a lookup failure here
      // must not turn into a spurious reminder-registration warning (the
      // registration itself succeeded) — it only means the confirmation send
      // proceeds exactly as it did before this check existed.
      try {
        // Any not-live status vetoes the send (Codex r9): 'rescheduled' keeps
        // its reminder armed, and a terminal status the recheck above could
        // not act on (a transient read failure there) must still never get
        // a "see you then".
        const { TERMINAL_STATUSES } = require('../waveguard-existing-services');
        const visitNow = await db('scheduled_services').where({ id: appointment.id }).first('status');
        visitNotLive = TERMINAL_STATUSES.includes(String(visitNow?.status || '').toLowerCase());
        // Persist the veto: a row left with its confirmation pending would
        // be sent later by the recovery sweep. The reminders stay armed.
        if (visitNotLive) {
          await db('appointment_reminders')
            .where({ scheduled_service_id: appointment.id, confirmation_sent: false })
            .update({ confirmation_sent: true, confirmation_sent_at: new Date() });
        }
      } catch (statusErr) {
        logger.warn(`[intelligence-bar] post-registration rescheduled-status check failed for appointment ${appointment.id}: ${statusErr.message}`);
      }
    }
  } catch (err) {
    logger.error(`[intelligence-bar] reminder registration failed for appointment ${appointment.id}: ${err.message}`);
    // Surfaced on the confirm card as a partial-failure warning (W0B): the
    // booking stands, but the promised reminder rows did not register.
    reminderWarning = 'Booked, but reminder registration failed — no 72h/24h reminder rows exist for this visit yet; the reminder sync/alert rail will retry or the office adds them manually.';
  }

  // Ids only — customer names/phones/addresses never go to logs (PII rule).
  logger.info(`[intelligence-bar] Created appointment ${appointment.id} for customer ${customer_id} on ${dateStr}`);

  // The booking confirmation text, deferred past the result exactly as the
  // Schedule create defers it (the landline lookup + send are slow). A
  // failed registration has no row to send from, so nothing is attempted;
  // neither does a visit that turned terminal in the registration window —
  // sending "see you then" for an already-cancelled/completed visit is
  // exactly what the recheck above exists to prevent — nor one that instead
  // turned 'rescheduled' (awaiting rebooking): the reminder stays armed, but
  // "see you then" for a visit with no settled time is exactly as wrong.
  if (!reminderWarning && !visitWentTerminal && !visitNotLive) {
    setImmediate(async () => {
      try {
        await AppointmentReminders.sendConfirmation(appointment.id);
      } catch (err) {
        logger.error(`[intelligence-bar] booking confirmation failed for appointment ${appointment.id}: ${err.message}`);
      }
    });
  }

  // One `warning` key — both the reminder failure and the occupancy advisory
  // must survive when they coincide (the card renders result.warning).
  const warnings = [reminderWarning, overlapAdvisory].filter(Boolean);
  return {
    success: true,
    ...(warnings.length ? { warning: warnings.join(' ') } : {}),
    appointment_id: appointment.id,
    customer_name: `${customer.first_name} ${customer.last_name}`,
    date: dateStr,
    service_type,
    price: appointment.estimated_price != null ? Number(appointment.estimated_price) : null,
    // The RESOLVED tech's canonical name — never the raw input, which can be
    // absent on an id-only retry or disagree with the id it rode in with.
    technician: resolvedTechnicianName || 'Unassigned',
  };
}


async function rescheduleAppointment(input, actionContext = {}) {
  const { appointment_id, new_date, new_time_window, reason } = input;

  const appt = await db('scheduled_services').where('id', appointment_id).first();
  // W0B pin (codex r4): assert the approved snapshot against THIS read —
  // the same row the move's CAS is based on — so a visit that changed
  // between the route preflight and here refuses instead of becoming the
  // executor's new baseline.
  if (appt && input._appointment_fingerprint) {
    const { normalizeAppointmentPin, appointmentPinFingerprint } = require('./proposal-pins');
    if (appointmentPinFingerprint(normalizeAppointmentPin(appt)) !== String(input._appointment_fingerprint)) {
      return {
        error: 'This visit changed after the card was shown — nothing was moved. Ask again for a fresh confirmation card.',
        preview_changed: true,
      };
    }
  }
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
  // Collective series moves (GATE_ADMIN_COLLECTIVE_MOVE): this tool moves ONE
  // row directly and cannot shift the sister visits, so with the gate on a
  // DATE move of a cadence visit is refused rather than silently applied
  // per-visit (refuse-don't-drop — the same contract update-details keeps
  // for gated scopes). The Intelligence Bar series path (preview card +
  // rebooker choke point + series effects) lands in the follow-up PR.
  {
    const { collectiveMoveGateOn } = require('../rebooker');
    const oldDateStr = oldDate instanceof Date ? oldDate.toISOString().slice(0, 10) : String(oldDate || '').slice(0, 10);
    if (collectiveMoveGateOn() && appt.is_recurring === true && dateStr !== oldDateStr) {
      return {
        error: 'This visit is part of a recurring plan — with collective moves on, its future visits follow every date move. Move it from Dispatch or the Edit appointment modal for now; Intelligence Bar series moves arrive in a follow-up. Nothing was changed.',
        code: 'COLLECTIVE_MOVE_REQUIRED',
      };
    }
  }

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
  // The technician on the COMMITTED row (the CAS does not pin technician_id,
  // so the pre-read `appt` may name a tech who was swapped out meanwhile).
  let committedTechId = null;
  let overlapAdvisory = null;
  await db.transaction(async (trx) => {
      // Rung 1 (date-wide occupancy) FIRST, then the stop lock (codex
      // #3609 r30 P2): probeSlotOverlap's ordering contract puts the
      // occupancy lock before any narrower lock, and the other IB date
      // mover (schedule-tools) acquires occupancy and then waits on this
      // same stop lock — taking them in the opposite order here could
      // form an occupancy↔stop deadlock between two staff actions.
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
      // Grouped/frozen refusal under the stop lock (codex #3609 r29 P1):
      // this tool writes the row directly — a grouped member moved alone
      // would strand its siblings and parent at the old stop. Throws an
      // operational 409 the executor surfaces as the tool error.
      await require('../visit-groups').assertRowMovableAlone(trx, appointment_id, appt.visit_id);
      const committed = await applyTrackLifecycleCas(
        trx('scheduled_services')
          .where('id', appointment_id)
          .where('status', String(appt.status))
          .where({
            scheduled_date: observedDate,
            window_start: appt.window_start ?? null,
            window_end: appt.window_end ?? null,
            // Observed membership is part of the CAS (codex r29): a row
            // grouped since the read misses instead of moving alone.
            visit_id: appt.visit_id ?? null,
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
          ...recurringDispatchDuePatch(appt, { scheduled_date: dateStr, window_start: newStart }),
          window_start: newStart,
          window_end: newWindowEnd,
          // A DATE move carries the stop into another tech-day: clear its
          // route_order (fence-or-clear contract — NULL appends after the
          // destination day's ordered run; the CAS above already makes a
          // stale-snapshot write miss). Same-day window changes keep it.
          ...(dateStr !== observedDate ? { route_order: null } : {}),
          // A this-visit-only DATE move of a cadence row is a deliberate
          // exception to its series (rebooker.dateExceptionStamp).
          ...(dateStr !== observedDate ? require('../rebooker').dateExceptionStamp(appt, 'admin_ib') : {}),
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
        })
        .returning(['id', 'technician_id']);
      updatedRows = committed.length;
      committedTechId = committed[0]?.technician_id || null;
  });
  if (updatedRows === 0) {
    return { error: 'Appointment changed concurrently (status, date, or window) while the reschedule was pending — nothing was moved. Re-check the appointment and retry if still applicable.' };
  }
  // Tech-facing notice (tech-visit-notifications.js): this writer moves the
  // row itself, so it tells the holder itself. Post-commit, best-effort,
  // never awaited; the operator's own move stays silent.
  if (committedTechId) {
    void require('../tech-visit-notifications').notifyVisitRescheduled({
      visitId: appt.id,
      technicianId: committedTechId,
      actorId: actionContext.technicianId || null,
      previous: { date: observedDate, windowStart: appt.window_start, windowEnd: appt.window_end },
      snapshot: { date: dateStr, windowStart: newStart, windowEnd: newWindowEnd },
    });
  }

  // Rebooker-parity side effects of the live → confirmed flip above:
  // job_status_history audit row, tech_status release, customer tracker
  // refresh. Best-effort: the move is committed — a side-effect failure
  // must not report the move itself as failed, but the card promised the
  // release, so a failure surfaces as a warning, never a bare Done
  // (GH r9 P1).
  let lifecycleWarning = null;
  if (wasLive) {
    try {
      await applyLiveMoveSideEffects(db, appt);
    } catch (err) {
      logger.error(`[intelligence-bar] live-move side effects failed for ${appointment_id}: ${err.message}`);
      lifecycleWarning = 'The move committed, but releasing the technician/tracker state failed — check the tech pointer and lifecycle history for this visit.';
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
      lifecycleWarning = 'The move committed, but the stale-tracker cleanup failed — check the tech pointer for this visit.';
    }
  }

  // Audit row, matching the rebooker's reschedule_log conventions.
  // Best-effort: the move above is already committed — a log failure must
  // not report the move itself as failed, but the card disclosed the audit
  // append (GH r16 P2), so it surfaces as a warning, never a bare Done.
  let auditWarning = null;
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
    auditWarning = "The move committed, but the reschedule audit entry could not be written — this move is missing from the visit's reschedule history.";
  }

  logger.info(`[intelligence-bar] Rescheduled appointment ${appointment_id} from ${oldDate} to ${dateStr}`);

  // Visit-group seam (visit-group-scope.md §2; codex #3590 r11): this
  // writer moves the date/window directly (not via the rebooker), so it
  // repairs grouped membership itself. Runs LAST, after every query this
  // tool issues for its own result. Best-effort, no-op for ungrouped rows —
  // but for a GROUPED row the card promised the detach/dissolve, so a
  // failed repair surfaces as a warning, never a bare Done (GH r14 P2).
  let groupWarning = null;
  try {
    await require('../visit-groups').handleChildStopChanged(appointment_id);
  } catch (vgErr) {
    logger.warn(`[intelligence-bar] visit-group seam failed for ${appointment_id}: ${vgErr.message}`);
    if (appt.visit_id) {
      groupWarning = 'The move committed, but repairing grouped-visit membership failed — the visit may still list this service at the old stop; re-check the visit on the schedule.';
    }
  }

  return {
    success: true,
    appointment_id,
    customer_name: customer ? `${customer.first_name} ${customer.last_name}` : 'Unknown',
    old_date: oldDate,
    new_date: dateStr,
    service_type: appt.service_type,
    // ONE warning key (card renders result.warning only): advisory overlap
    // note + lifecycle-cleanup + group-repair + audit-append failures
    // COMBINE, never overwrite.
    ...(overlapAdvisory || lifecycleWarning || groupWarning || auditWarning
      ? { warning: [overlapAdvisory, lifecycleWarning, groupWarning, auditWarning].filter(Boolean).join(' ') }
      : {}),
  };
}


// Owner ruling 2026-09-28, "bare visits only" (supersedes the earlier
// "simple visits only" wording this message carried): a bare visit has no
// invoice, no inspection-credit offer, and is neither a follow-up child nor
// grouped — nothing this card would need to void, reverse, or disclose a
// group/follow-up side effect for. Anything else cancels from Dispatch.
const CARD_CANCEL_REFUSED_MESSAGE = 'This visit has a saved card or card request on file, a saved-card fee agreement, a prepayment or prepaid plan coverage, an invoice of any kind on record, an inspection-credit offer tied to it, a plan make-up visit, is a follow-up visit, or is part of a grouped visit, so it can only be cancelled from the Dispatch screen. Nothing was changed.';

async function cancelAppointment(input, actionContext = {}) {
  const { appointment_id, reason } = input;

  const appt = await db('scheduled_services').where('id', appointment_id).first();
  if (!appt) return { error: 'Appointment not found' };

  // Terminal statuses are one-way (#2717) — that guard lives in the ROUTE
  // callers, not transitionJobStatus, so this tool must enforce it itself
  // (Codex r4): cancelling a completed visit would erase delivered work and
  // trigger the follow-up re-park hook for a treatment that already
  // happened. Idempotent on an already-cancelled row; every other terminal
  // state is an error, matching rescheduleAppointment above.
  if (String(appt.status) === 'cancelled' && input._frozen_cancellation_impact) {
    // A card confirm whose visit was cancelled ELSEWHERE since the card was
    // shown (Codex round 6 P1): the replay below would run follow-through
    // for effects the card never approved. The bar's own card cancel has no
    // post-commit money obligations to retry (bare visits only; the shared
    // status-writer seam runs them), so refuse as stale — never replay.
    return {
      error: 'This visit was already cancelled since the card was shown — nothing was changed.',
      preview_changed: true,
    };
  }
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
    // call below leaves this early return as the only path a retry reaches.
    // The SHARED follow-through (PR #3496 audit: this tool was the one
    // cancel surface with NO card-fee hook — a cancelled visit's hold
    // stayed silently 'held' and in-window fees never charged) bundles
    // both card rails + the invoice void/credit reversal, and every step
    // is idempotent, so the replay re-runs it safely.
    // The fee rails must judge their windows at the COMMITTED cancellation
    // instant, not this retry's clock (pre-push r7 P0). The timestamp
    // LOOKUP is isolated from the follow-through call (uncapped r19 P1):
    // a failed lookup must degrade to the fail-free waived run, never
    // skip the money obligations entirely. Real transitions only (r8 P0):
    // a cancelled→cancelled audit row carries a LATER instant.
    let cancelledAtReplay = null;
    try {
      const hist = await db('job_status_history')
        .where({ job_id: appointment_id, to_status: 'cancelled' })
        .whereNot('from_status', 'cancelled')
        .orderBy('transitioned_at', 'desc')
        .first('transitioned_at');
      cancelledAtReplay = hist?.transitioned_at || null;
    } catch (lookupErr) {
      logger.warn(`[intelligence-bar] cancel replay instant lookup failed for ${appointment_id}: ${lookupErr.message} — fee legs will be waived (fail free)`);
    }
    try {
      const { runVisitCancellationFollowThrough } = require('../visit-cancellation-followthrough');
      const { NO_SHOW_FEE_MAX_AGE_MS } = require('../estimate-card-holds');
      // TWO clocks (uncapped r20 P0): the audited instant decides whether
      // the cancel was originally in-window, but a replay of a STALE
      // cancellation (older than the fee rails' own freshness bound,
      // judged by the REAL clock) must never charge weeks later — waive.
      const staleReplay = cancelledAtReplay
        && (Date.now() - new Date(cancelledAtReplay).getTime()) > NO_SHOW_FEE_MAX_AGE_MS;
      // Owner ruling 2026-09-28, "bare visits only": a card-confirmed cancel
      // is now, by construction, always a visit with NO invoice, NO
      // inspection-credit offer, and NO card fee rail — there is nothing
      // for a PINNED, scoped follow-through to do that this UNPINNED call
      // wouldn't already find empty. Run it exactly like every other
      // cancel caller (Dispatch included); no pinnedEffects.
      if (cancelledAtReplay && !staleReplay) {
        await runVisitCancellationFollowThrough({ targetIds: [appointment_id], source: 'intelligence-bar', now: new Date(cancelledAtReplay) });
      } else {
        logger.warn(`[intelligence-bar] cancel replay for ${appointment_id} is ${staleReplay ? 'stale' : 'missing an audited transition time'} — fee legs waived (fail free)`);
        await runVisitCancellationFollowThrough({ targetIds: [appointment_id], source: 'intelligence-bar', waiveFee: true });
      }
    } catch (e) {
      logger.error(`[intelligence-bar] cancel replay follow-through failed for ${appointment_id}: ${e.message}`);
    }
    // Counted-plan reseed on the replay too (Codex #4814 r7 P1): a first
    // reseed that failed without its stamp gets its retry here, like the
    // other post-commit obligations this branch replays. Idempotent. A
    // card-confirmed cancel never reseeds: the card only confirms visits
    // that cannot add a make-up visit (cancelMayReseedPlan).
    if (!input._frozen_cancellation_impact) {
      await require('../recurring-series-cancel-reseed').runPostCancelSeriesReseed({
        db, serviceId: appointment_id, source: 'intelligence-bar-cancel-replay',
      });
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

  // Exact-effect confirm (W0B / PR A of the cancel-pinned-effects lane): a
  // pending action proposed against a frozen impact snapshot (fee, invoices,
  // inspection-credit — see appointment-cancel-impact.js) pins it on
  // `_frozen_cancellation_impact`. Recompute the SAME snapshot fresh, right
  // before committing anything, and refuse if state moved since the
  // operator approved the card — never settle a different verdict than what
  // was shown. No frozen pin (every caller today — the route refuses
  // cancel_appointment before any pending action can carry one; see
  // CANCEL_NOT_CARD_CONFIRMABLE_MESSAGE in admin-intelligence-bar.js) means
  // this check is a no-op.
  if (input._frozen_cancellation_impact) {
    const { computeCancelAppointmentImpact, cancelImpactsMatch } = require('../appointment-cancel-impact');
    let freshImpact;
    try {
      freshImpact = await computeCancelAppointmentImpact(appointment_id, { actorId: actionContext.technicianId || null });
    } catch (err) {
      logger.warn(`[intelligence-bar] cancel impact unavailable for ${appointment_id}: ${err.message}`);
      return { error: 'The cancellation effects (late-cancel fee, invoices, or inspection credit) could not be verified right now — nothing was changed. Try again in a moment.' };
    }
    if (!cancelImpactsMatch(freshImpact, input._frozen_cancellation_impact)) {
      return { error: 'The cancellation effects (late-cancel fee, invoices, or inspection credit) changed since this was proposed — nothing was changed. Ask again for a fresh preview.' };
    }
    // Owner ruling 2026-09-28: the bar cancels bare visits only.
    if ((freshImpact?.card_cancel_refusals || []).length) {
      return { error: CARD_CANCEL_REFUSED_MESSAGE };
    }
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
      // Exact-effect confirm, INSIDE the mutation transaction (Codex round-3
      // P1a): the pre-check above (input._frozen_cancellation_impact
      // block) reads OUTSIDE any lock — a same-day reschedule (window or
      // customer change, status unchanged) that commits in the gap between
      // that read and this transaction's own lock would slip through
      // undetected, since transitionJobStatus's own atomic guard only
      // checks fromStatus, never the full identity. Lock the row FIRST —
      // a reschedule racing to commit AFTER this point blocks on the lock
      // until this transaction resolves, and one that already committed
      // BEFORE it is caught by the fingerprint recompute below — then
      // refuse before transitioning anything if the SAME whole-row
      // fingerprint (appointment-cancel-impact.js's computeRowFingerprint
      // — every scheduled_services column bar its own tiny denylist, the
      // identical fingerprint computed at proposal time) no longer matches
      // what the operator approved. Replaces the earlier hand-picked
      // normalizeAppointmentPin/appointmentPinFingerprint identity subset
      // (proposal-pins.js) — rounds 2 through 4 of review each found one
      // more column that subset missed (identity, then property, then
      // recurrence flags, then the window label, then visit_id); pinning
      // the whole row closes that class of gap structurally.
      if (input._frozen_cancellation_impact) {
        // The shared scheduled-invoice lock chain (mint advisory lock →
        // customer KEY SHARE → visit row FOR UPDATE), not a bare row lock
        // (Codex round 6 P1): InvoiceService.create fences scheduled-service
        // mints with the advisory lock, and a row lock does not protect the
        // ABSENCE of invoice rows — joining the same protocol, in the same
        // order, makes the no-invoice check below hold through the status
        // transition in this trx.
        const { acquireScheduledMintLockChain } = require('../scheduled-invoice-mint');
        const lockedRow = await acquireScheduledMintLockChain(trx, { scheduledServiceId: appointment_id, visitColumns: ['*'] });
        if (!lockedRow) throw new Error('__cancel_target_missing__');
        const { computeRowFingerprint } = require('../appointment-cancel-impact');
        if (computeRowFingerprint(lockedRow) !== input._frozen_cancellation_impact.identity_fingerprint) {
          throw new Error('__cancel_identity_drift__');
        }
        // Explicit reseed-eligibility recheck FROM THE LOCKED ROW (Codex
        // round-4 P1): the whole-row fingerprint match above already
        // implies this (recurring_parent_id/is_callback/followup_included/
        // is_recurring are all part of the pinned row, unlike the identity
        // subset this replaced), but a card-approved cancel refuses on the
        // committed row's OWN eligibility verdict rather than only on
        // fingerprint equality — the same discipline as the grouped-visit
        // check below, decided on the row that is about to be transitioned,
        // not inferred from a hash.
        const { cancelMayReseedPlan } = require('../recurring-series-cancel-reseed');
        if (cancelMayReseedPlan(lockedRow)) {
          throw new Error('__cancel_card_refused__');
        }
        // Grouped-visit refusal, same discipline (Codex round-4 P2): the
        // proposal/pre-check already refuse a grouped visit via
        // card_cancel_refusals ('grouped_visit'), so a frozen pin can only
        // reach here already ungrouped — this is the same belt-and-
        // suspenders recheck on the row that will actually commit.
        if (lockedRow.visit_id) {
          throw new Error('__cancel_card_refused__');
        }
        // NOT a follow-up child, same discipline (owner ruling 2026-09-28,
        // "bare visits only"). followup_source_service_id is a plain
        // scheduled_services column, so the whole-row fingerprint match
        // above already implies this — rechecked explicitly anyway on the
        // row about to be transitioned, not only inferred from a hash.
        if (lockedRow.followup_source_service_id) {
          throw new Error('__cancel_card_refused__');
        }
        // NO invoice or inspection-credit offer of any kind, re-verified
        // UNDER THIS LOCK — neither lives on scheduled_services, so the
        // fingerprint match above cannot catch one created in the gap
        // between the pre-check (outside any lock) and this lock.
        //
        // Verified against inspection-credit.js's redeemSpecificOffer,
        // which is the only writer that could mint a credit against THIS
        // visit concurrently (redeemed_scheduled_service_id = bookingId):
        // inside its own transaction it (1) UPDATEs the offer to 'redeemed'
        // (uncommitted so far), THEN (2) SELECTs this SAME scheduled_services
        // row FOR UPDATE to re-verify the booking is still live before it
        // mints, all in ONE transaction. Two lock orderings, both safe:
        //   - We acquire this row's lock first: their step (2) blocks on
        //     us. Our read of inspection_credit_offers here (read
        //     committed) cannot see their still-uncommitted step (1), so we
        //     find nothing and proceed — but once we commit (status →
        //     'cancelled'), their blocked SELECT unblocks, reads that
        //     committed status, and their own NON_LIVE_APPOINTMENT_STATUSES
        //     guard throws — rolling back their WHOLE transaction, step (1)
        //     included. The offer is never actually redeemed.
        //   - They acquire this row's lock first: our own lockedRow read
        //     above (trx('scheduled_services')...forUpdate()) blocks until
        //     THEIR transaction resolves. If their liveness check passes
        //     (we haven't cancelled anything yet — we're blocked), they
        //     mint and commit; our lock then acquires and our read here
        //     (now past their commit) sees the redeemed offer and refuses.
        //     If their check fails for some other reason, they roll back
        //     and we see nothing, same as above.
        // Either way, a credit can never end up minted against a visit this
        // transaction goes on to cancel.
        const { anyInvoiceLinkedToVisit } = require('../invoice');
        if (await anyInvoiceLinkedToVisit(trx, appointment_id).first('id')) {
          throw new Error('__cancel_card_refused__');
        }
        const { anyInspectionCreditOfferForVisit } = require('../inspection-credit');
        if (await anyInspectionCreditOfferForVisit(trx, appointment_id).first('id')) {
          throw new Error('__cancel_card_refused__');
        }
        // Legacy unstamped-address fallback (Codex round-5 P2): a row with
        // no stamped service_address_* shows the CUSTOMER's primary address
        // on the card (appointment-cancel-impact.js#effectiveAddress) — a
        // `customers` column the whole-row fingerprint above (deliberately
        // scheduled_services-only) can never cover. Re-read it FOR SHARE
        // under this SAME lock and refuse if it moved since the frozen
        // proposal; the identity fingerprint itself stays row-only.
        if (!lockedRow.service_address_line1 && lockedRow.customer_id) {
          const { legacyAddressFingerprint } = require('../appointment-cancel-impact');
          const liveCustomer = await trx('customers').where('id', lockedRow.customer_id).forShare()
            .first('address_line1', 'address_line2', 'city', 'state', 'zip');
          const liveFingerprint = legacyAddressFingerprint({
            line1: liveCustomer?.address_line1, line2: liveCustomer?.address_line2,
            city: liveCustomer?.city, state: liveCustomer?.state, zip: liveCustomer?.zip,
          });
          if (liveFingerprint !== input._frozen_cancellation_impact.legacy_address_fingerprint) {
            throw new Error('__cancel_identity_drift__');
          }
        }
        // Card-fee rails (Codex round 7 P1): a hold accepted or a /secure
        // capture committed since the proposal lives outside the row
        // fingerprint. Re-read under this lock (their writers lock the same
        // visit row) and refuse on any change — the unpinned follow-through
        // must never charge a fee the card said did not exist.
        // Prepaid coverage (Codex round 9 P1): estimate-level deposits and
        // prepay invoices live outside the row fingerprint — re-run the
        // canonical readers on this trx under the lock (the deposit-ledger
        // lock is taken after the visit lock, the same order the schedule's
        // price path uses).
        const { prepaidCommitmentReason } = require('../appointment-cancel-impact');
        const { cardRailRows } = require('../appointment-cancel-impact');
        if (await prepaidCommitmentReason(trx, lockedRow) || (await cardRailRows(trx, appointment_id)).length > 0) {
          throw new Error('__cancel_card_refused__');
        }
        const { cardRailFingerprint } = require('../appointment-cancel-impact');
        if (await cardRailFingerprint(trx, appointment_id) !== input._frozen_cancellation_impact.card_rail_fingerprint) {
          throw new Error('__cancel_identity_drift__');
        }
      }
      await transitionJobStatus({
        jobId: appointment_id,
        fromStatus: appt.status,
        toStatus: 'cancelled',
        // The acting staff row: audit attribution on the history row, and
        // the actor the tech-facing cancel notice (job-status.js) keeps
        // silent for — an operator cancelling their own visit gets no card.
        transitionedBy: actionContext.technicianId || null,
        notes: reason ? `Cancelled via Intelligence Bar: ${reason}` : 'Cancelled via Intelligence Bar',
        // Owner ruling 2026-09-28, "bare visits only": every check above
        // (proposal-side and, again, under this lock) guarantees this visit
        // has no invoice and no inspection-credit offer at all — there is
        // nothing left for a scoped, pinned money seam to protect against
        // racing. The shared status writer's own UNPINNED
        // voidOpenInvoicesForCancelledService post-commit seam
        // (job-status.js#maybeReparkFollowupObligation) now runs exactly as
        // it would for a Dispatch cancel — no skip.
        trx,
      });
      if (reason) {
        await trx('scheduled_services').where('id', appointment_id).update({
          // SQL-side concat against the LIVE column (Codex round-1 P1): a
          // JS-side `${appt.notes || ''}` read from BEFORE this transaction
          // opened would overwrite a note a concurrent writer appended in
          // between. concat_ws + NULLIF drop the separator entirely when
          // notes is still empty, matching the old `.trim()`'s leading-
          // newline behavior without reading a stale value.
          notes: trx.raw("concat_ws(E'\\n', NULLIF(notes, ''), ?::text)", [`Cancelled: ${reason}`]),
          updated_at: new Date(),
        });
      }
    });
  } catch (err) {
    if (err && err.message === '__cancel_identity_drift__') {
      return { error: 'The cancellation effects (late-cancel fee, invoices, or inspection credit) changed since this was proposed — nothing was changed. Ask again for a fresh preview.' };
    }
    if (err && err.message === '__cancel_target_missing__') {
      return { error: 'Appointment not found — nothing was changed.' };
    }
    if (err && err.message === '__cancel_card_refused__') {
      return { error: CARD_CANCEL_REFUSED_MESSAGE };
    }
    // The visit went cancelled / no_show / skipped between the initial read
    // and the lock chain, which refuses a never-ran visit (Codex round-10
    // P2): a stale card, not an invoice error.
    if (err && err.code === 'SCHEDULED_VISIT_NOT_LIVE') {
      return { error: 'This visit was cancelled or closed since the card was shown — nothing was changed.', preview_changed: true };
    }
    if (err && err.message && err.message.includes('not in state')) {
      return { error: 'Appointment status changed while cancelling (concurrent update) — refresh and try again.' };
    }
    throw err;
  }

  // Run the SHARED cancellation follow-through every other cancel surface
  // runs (PR #3496 audit closed this gap): both card fee rails — the
  // one-time hold (charge in-window / release-or-park otherwise) and the
  // /secure appointment-card fee — plus the invoice void + inspection-
  // credit reversal (Codex #3178 r21 P1). Best-effort after the committed
  // transition, same as the status routes; waiveFee is not offered by this
  // tool, matching the admin routes' default (an operator who means to
  // waive uses the dispatch UI's waive control).
  try {
    // ONE authoritative instant for the fee rails on BOTH the initial and
    // replay paths (pre-push r9 P0): the audited transition timestamp the
    // transaction just committed. The lookup is ISOLATED (uncapped r19
    // P1): its failure degrades to the fail-free waived run — the money
    // obligations always run.
    let cancelledAtCommit = null;
    try {
      const hist = await db('job_status_history')
        .where({ job_id: appointment_id, to_status: 'cancelled' })
        .whereNot('from_status', 'cancelled')
        .orderBy('transitioned_at', 'desc')
        .first('transitioned_at');
      cancelledAtCommit = hist?.transitioned_at || null;
    } catch (lookupErr) {
      logger.warn(`[intelligence-bar] cancellation instant lookup failed for ${appointment_id}: ${lookupErr.message} — fee legs will be waived (fail free)`);
    }
    const { runVisitCancellationFollowThrough } = require('../visit-cancellation-followthrough');
    const { NO_SHOW_FEE_MAX_AGE_MS } = require('../estimate-card-holds');
    // Same two-clock guard as the replay path (uncapped r20 P0): should
    // this post-commit call itself be delayed past the freshness bound,
    // it must waive rather than charge stale.
    const staleCommit = cancelledAtCommit
      && (Date.now() - new Date(cancelledAtCommit).getTime()) > NO_SHOW_FEE_MAX_AGE_MS;
    if (cancelledAtCommit && !staleCommit) {
      await runVisitCancellationFollowThrough({ targetIds: [appointment_id], source: 'intelligence-bar', now: new Date(cancelledAtCommit) });
    } else {
      logger.warn(`[intelligence-bar] cancellation instant for ${appointment_id} is ${staleCommit ? 'stale' : 'missing'} — fee legs waived (fail free)`);
      await runVisitCancellationFollowThrough({ targetIds: [appointment_id], source: 'intelligence-bar', waiveFee: true });
    }
  } catch (e) {
    logger.error(`[intelligence-bar] cancel follow-through failed for ${appointment_id}: ${e.message}`);
  }
  // Counted-plan reseed (owner ruling 2026-09-24): a single-visit cancel
  // inside a 9-application plan adds one back at the end of the series.
  // Gated, failure-isolated, post-commit.
  // A card-confirmed cancel never reseeds (see the replay branch above).
  if (!input._frozen_cancellation_impact) {
    await require('../recurring-series-cancel-reseed').runPostCancelSeriesReseed({
      db, serviceId: appointment_id, source: 'intelligence-bar-cancel',
    });
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
        // A stale embedding can still name a row an admin has since switched
        // off (active=false, status still 'active'); NULL counts as on.
        .whereRaw('active IS NOT FALSE')
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
  // labels, county fertilizer rules, prep guides, ops rules, species catalog.
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
    note: 'fieldIntelligence = AI-maintained outcome wiki (trusted tiers only, field intelligence not label authority); knowledgeBase = curated operational knowledge; operationalKnowledge (when present) = services/protocols/product-label/county-rule/prep-guide/past-resolution/species-catalog matches — cite source + ref; "species" (customer copy) and "species_tech" (tech notes) entries are the owner-approved, UF/IFAS-cited species catalog and win any disagreement with the wiki or knowledge base on what an organism is, its verdict, or its safety; "resolution" entries are how similar past calls/visits were actually handled (PII-redacted, recency-decayed). Cite slugs, state confidence, and surface open contradictions.',
  };
}

// Id-supplied path shares the same active bar as name resolution; used by
// proposal-time pinning so a model-provided uuid still yields a NAMED tech
// on the confirmation card.
async function resolveActiveTechnicianById(id) {
  return applyAssignable(db('technicians').where('technicians.id', id)).first();
}

module.exports = {
  TOOLS, executeTool, resolveTechnicianByName, resolveActiveTechnicianById, UPDATABLE_FIELDS, ibBookingProposal,
  // Shared with routes/admin-intelligence-bar.js's proposePendingWrite (PR B
  // of the ib-cancel-pinned-effects lane): the proposal-time refusal for a
  // non-simple visit reuses this exact wording rather than a second copy.
  CARD_CANCEL_REFUSED_MESSAGE,
};
