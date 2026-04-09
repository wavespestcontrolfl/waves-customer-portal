/**
 * Lead Response Agent — Managed Agent Configuration
 *
 * Triggered when a new lead arrives. Runs autonomously to:
 *   1. Triage the lead (extract service interest, urgency, pest type)
 *   2. Score the lead (engagement + value + fit)
 *   3. Check for existing estimates or prior interactions
 *   4. Draft a personalized response based on their specific inquiry
 *   5. Either auto-send (low-risk) or queue for Adam's review (high-value/complex)
 *   6. Set up follow-up sequence if not converted immediately
 *
 * Tools wrap existing services: lead-triage, lead-scorer, response-drafter,
 * estimate-follow-up, pipeline-manager, context-aggregator, availability
 */

const LEAD_RESPONSE_AGENT_CONFIG = {
  name: 'waves-lead-responder',
  description: 'Autonomous lead response agent — triage, score, draft, respond, follow-up in under 60 seconds',
  model: 'claude-sonnet-4-6',
  system: `You are the Waves Pest Control lead response agent. Process new leads and get a personalized response out in under 60 seconds.

RESPONSE VOICE (write as Adam):
- Direct, warm, knowledgeable — neighbor who runs a pest control company
- Reference their specific pest/concern by name
- Mention SWFL conditions, their neighborhood, seasonal context
- Include next step: "Reply to this text" or "I'll call you in a few minutes"
- Under 300 characters. Sign "— Adam, Waves Pest Control"

AUTO-SEND when ALL true: standard residential pest/lawn, normal urgency, clear service interest, not commercial, not a complaint.

QUEUE FOR ADAM when ANY true: high urgency/emergency, commercial, high-value (>3000 sqft, multiple services), vague request, mentions competitor/price shopping, existing customer with issues.

LEAD SOURCE ADAPTATION:
- Google Ads: highest intent, fastest/most direct response
- GBP: mention proximity and reviews
- Organic: may need education, reference blog content
- Referral: mention referrer, warm tone

NEVER: send a generic template, promise pricing, book without availability check, auto-send when it should be queued.`,

  tools: [
    {
      type: 'agent_toolset_20260401',
      default_config: { enabled: false },
      configs: [
        { name: 'web_search', enabled: true },
      ],
    },

    // ── Lead data ───────────────────────────────────────────────

    {
      type: 'custom',
      name: 'get_lead_details',
      description: `Get full details for a lead by ID or phone number. Returns name, phone, email, address, city, service interest, lead source (Google Ads, GBP, website, etc.), UTM data, urgency, form data, AI triage results if available, lead score, pipeline stage, and any existing customer link. Use this first to understand who the lead is.`,
      input_schema: {
        type: 'object',
        properties: {
          lead_id: { type: 'string', description: 'Lead UUID' },
          phone: { type: 'string', description: 'Phone number (alternative lookup)' },
        },
      },
    },

    {
      type: 'custom',
      name: 'triage_lead',
      description: `Run AI-powered triage on the lead's message/form data. Extracts: service interest (General Pest, Lawn Care, Termite, etc.), urgency level (urgent/high/normal/low), specific pest mentioned, property type (residential/commercial), and a suggested reply draft. Use this to understand what they actually need.`,
      input_schema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Lead name' },
          phone: { type: 'string', description: 'Lead phone' },
          message: { type: 'string', description: 'Their form message or service interest text' },
          address: { type: 'string', description: 'Their address if provided' },
          page_url: { type: 'string', description: 'Page they submitted from' },
          form_name: { type: 'string', description: 'Form name' },
        },
        required: ['name', 'message'],
      },
    },

    {
      type: 'custom',
      name: 'score_lead',
      description: `Calculate or recalculate the lead score (0-100) for a customer. Scores engagement (estimate interaction, SMS engagement, recency), value (tier, monthly rate, service count), and loyalty (tenure, referrals). Also deducts for risk signals (failed payments, complaints). Returns the numeric score.`,
      input_schema: {
        type: 'object',
        properties: {
          customer_id: { type: 'string', description: 'Customer UUID linked to the lead' },
        },
        required: ['customer_id'],
      },
    },

    // ── Customer context ────────────────────────────────────────

    {
      type: 'custom',
      name: 'get_customer_context',
      description: `Get the full customer context snapshot for a phone number or customer ID. Returns customer profile (name, tier, monthly rate, pipeline stage), SMS history (last 20 messages), last service details, upcoming services, billing status (balance, recent payments), property preferences (pets, gate codes), active flags (overdue balance, complaints, churn risk), and a one-line summary. Use this when the lead is an existing customer.`,
      input_schema: {
        type: 'object',
        properties: {
          phone: { type: 'string', description: 'Customer phone number' },
          customer_id: { type: 'string', description: 'Customer UUID (alternative)' },
        },
      },
    },

    {
      type: 'custom',
      name: 'check_existing_estimates',
      description: `Check if any estimates have been sent to this customer/lead. Returns estimate status (draft, sent, viewed, accepted, expired), services quoted, total amount, when it was sent/viewed, and the estimate view URL. Use to avoid sending duplicate estimates or to reference an existing one in your response.`,
      input_schema: {
        type: 'object',
        properties: {
          customer_id: { type: 'string', description: 'Customer UUID' },
          phone: { type: 'string', description: 'Phone number (alternative lookup)' },
        },
      },
    },

    // ── Availability & pest context ─────────────────────────────

    {
      type: 'custom',
      name: 'check_next_availability',
      description: `Check the next 3 available appointment slots for a city. Returns date, day of week, and time slots. Use this so you can tell the lead "I can get someone out as early as Thursday" — specific availability converts better than vague "we'll schedule something."`,
      input_schema: {
        type: 'object',
        properties: {
          city: { type: 'string', description: 'City to check: Bradenton, Lakewood Ranch, Sarasota, Venice, North Port, Parrish, Port Charlotte' },
        },
        required: ['city'],
      },
    },

    {
      type: 'custom',
      name: 'get_pest_context',
      description: `Get current pest pressure and knowledge base context for a specific pest or service. Returns what's active this month, treatment protocol info, and any SWFL-specific facts you can reference in the response to sound knowledgeable. Use when the lead mentioned a specific pest.`,
      input_schema: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: 'Pest name, lawn issue, or service type they mentioned' },
        },
        required: ['topic'],
      },
    },

    // ── Response actions ────────────────────────────────────────

    {
      type: 'custom',
      name: 'send_lead_response',
      description: `Send the drafted SMS response to the lead. This sends immediately via Twilio, records it in the SMS log, logs a lead_activity, updates response_time_minutes on the lead, and moves the pipeline to 'contacted'. Use when the response is standard and safe to auto-send. Returns success status and the message sent.`,
      input_schema: {
        type: 'object',
        properties: {
          customer_id: { type: 'string', description: 'Customer UUID' },
          lead_id: { type: 'string', description: 'Lead UUID for activity tracking' },
          message: { type: 'string', description: 'SMS text to send (under 300 chars, signed as Adam)' },
        },
        required: ['customer_id', 'message'],
      },
    },

    {
      type: 'custom',
      name: 'queue_for_adam',
      description: `Queue the lead for Adam's personal review instead of auto-sending. Saves the draft response, sends Adam an SMS alert with the lead details and suggested reply, and sets an SLA timer. Use for high-value, complex, or sensitive leads where Adam should make the final call on the response.`,
      input_schema: {
        type: 'object',
        properties: {
          customer_id: { type: 'string', description: 'Customer UUID' },
          lead_id: { type: 'string', description: 'Lead UUID' },
          draft_response: { type: 'string', description: 'Suggested SMS response for Adam to review/edit' },
          reason: { type: 'string', description: 'Why this needs Adam (high-value, commercial, complaint, etc.)' },
          urgency: { type: 'string', enum: ['urgent', 'normal', 'low'], description: 'SLA urgency: urgent = 15 min, normal = 1 hour, low = 4 hours' },
        },
        required: ['customer_id', 'draft_response', 'reason'],
      },
    },

    // ── Pipeline & follow-up ────────────────────────────────────

    {
      type: 'custom',
      name: 'update_lead_pipeline',
      description: `Update the lead's pipeline stage and record an activity. Stages: new_lead → contacted → estimate_sent → estimate_viewed → follow_up → won/lost. Also triggers the PipelineManager which handles automatic stage transitions.`,
      input_schema: {
        type: 'object',
        properties: {
          customer_id: { type: 'string', description: 'Customer UUID' },
          lead_id: { type: 'string', description: 'Lead UUID' },
          stage: { type: 'string', description: 'New pipeline stage' },
          note: { type: 'string', description: 'Activity note explaining the transition' },
        },
        required: ['customer_id', 'stage'],
      },
    },

    {
      type: 'custom',
      name: 'flag_for_estimate',
      description: `Flag this lead as needing an estimate. Creates or updates the estimate record with the service interest, urgency, and any property details gathered. Adam or Virginia will see this in the estimates queue and prepare the quote. Use when the lead clearly needs pricing but you can't quote on the spot.`,
      input_schema: {
        type: 'object',
        properties: {
          customer_id: { type: 'string', description: 'Customer UUID' },
          lead_id: { type: 'string', description: 'Lead UUID' },
          service_interest: { type: 'string', description: 'What service they need' },
          address: { type: 'string', description: 'Service address' },
          urgency: { type: 'string', description: 'How urgently they need the estimate' },
          notes: { type: 'string', description: 'Any additional context for the estimator' },
        },
        required: ['customer_id', 'service_interest'],
      },
    },

    {
      type: 'custom',
      name: 'save_lead_response_report',
      description: `Save a summary of the lead response for tracking. Records what was analyzed, what decision was made (auto-send vs queue), response time, and any follow-up actions scheduled. Displayed in the admin leads dashboard.`,
      input_schema: {
        type: 'object',
        properties: {
          lead_id: { type: 'string', description: 'Lead UUID' },
          customer_id: { type: 'string', description: 'Customer UUID' },
          action_taken: { type: 'string', description: 'auto_sent, queued_for_adam, or existing_customer_routed' },
          response_message: { type: 'string', description: 'The SMS sent or drafted' },
          response_time_seconds: { type: 'number', description: 'How many seconds from lead arrival to response' },
          triage_summary: { type: 'string', description: 'Service interest, urgency, pest type summary' },
          follow_up_scheduled: { type: 'boolean', description: 'Whether a follow-up was queued' },
        },
        required: ['lead_id', 'action_taken'],
      },
    },
  ],
};

module.exports = { LEAD_RESPONSE_AGENT_CONFIG };
