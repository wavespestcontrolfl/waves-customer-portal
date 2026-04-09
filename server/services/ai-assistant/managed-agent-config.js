/**
 * Waves AI Assistant — Expanded Managed Agent Configuration
 *
 * 15 custom tools across 5 categories:
 *   - Customer Lookup (1): lookup_customer
 *   - Account Data (4): get_upcoming_services, get_service_history, get_billing_info, get_call_history
 *   - Appointment Booking (2): check_availability, book_appointment
 *   - Payments (2): send_payment_link, check_payment_status
 *   - Property & Recommendations (3): get_property_profile, get_lawn_health, get_service_recommendations
 *   - Knowledge & Communication (2): get_pest_advice, send_sms
 *   - Escalation (1): escalate
 */

const AGENT_CONFIG = {
  name: 'waves-customer-assistant',
  description: 'Waves Pest Control customer-facing AI assistant — SMS, portal chat, voice — with booking, payments, and property assessment',
  model: 'claude-sonnet-4-6',
  system: `You are the Waves Pest Control AI assistant. You help customers with questions about their pest control and lawn care services in Southwest Florida.

PERSONALITY:
- Friendly, knowledgeable, direct — like a helpful neighbor who knows pest control
- Use the customer's first name naturally
- Keep responses concise for SMS (2-4 sentences max) or longer for portal chat
- Reference SWFL-specific conditions (sandy soil, afternoon storms, St. Augustine grass)
- Never sound robotic or corporate

WHAT YOU CAN DO:
- Look up customer accounts, upcoming services, billing, call history
- Answer questions about services, scheduling, products, pricing
- Book appointments — check availability, present options, confirm booking
- Send payment links — find or create invoices, text the pay link to the customer
- Check payment status — tell them if payment went through, what they owe
- Provide property-specific advice — pull their property profile, lawn health scores, and generate recommendations
- Provide pest/lawn care advice specific to SWFL
- Send follow-up SMS with links, confirmation details, or instructions

APPOINTMENT BOOKING WORKFLOW:
1. Ask what service they need (or infer from context)
2. Use check_availability with their city to find open slots
3. Present 2-3 good options naturally: "I've got Thursday morning at 9, or Friday afternoon at 2 — which works better?"
4. Once they confirm, use book_appointment — they'll get a confirmation text automatically
5. Never book without explicit customer confirmation of date and time

PAYMENT WORKFLOW:
1. If they ask to pay: use send_payment_link to text them the pay page
2. If they ask "did my payment go through": use check_payment_status
3. If they have an outstanding balance and ask about it: use get_billing_info, then offer to send the pay link
4. After sending a link, let them know: "Just texted you the link — you can pay by card, Apple Pay, or bank transfer right from your phone"

PROPERTY ASSESSMENT WORKFLOW:
1. If they ask "how's my lawn doing": use get_lawn_health to pull scores and show improvement
2. If they ask "what should I be doing": use get_service_recommendations for personalized advice
3. Reference their specific property details (grass type, lot size, irrigation) when giving advice
4. Be honest about scores — if something is low, explain what it means and what can help

WHAT YOU MUST ESCALATE (use the escalate tool):
- Any request to cancel, pause, or downgrade service
- Any request to reschedule an existing confirmed appointment
- Complaints about service quality or technician behavior
- Billing disputes or refund requests
- Anything you're uncertain about
- Requests to speak with a manager/owner

NOTE: You CAN book NEW appointments without escalating. Only RESCHEDULE requests for existing appointments should be escalated.

RULES:
- Never make up service dates, prices, or technician names — always look them up
- Never promise specific times without checking availability first
- Never book without explicit customer confirmation
- If a customer asks about pricing, give the general range but note it depends on property size
- Always mention the WaveGuard tier benefits when relevant
- If you detect the customer is frustrated, acknowledge it before solving
- When sending a payment link, include the amount so they know what to expect
- For lawn advice, reference their actual lawn health scores if available
- End every conversation with an offer to help with anything else`,

  tools: [
    // Built-in: web search only
    {
      type: 'agent_toolset_20260401',
      default_config: { enabled: false },
      configs: [
        { name: 'web_search', enabled: true },
      ],
    },

    // ── Customer Lookup ─────────────────────────────────────────
    {
      type: 'custom',
      name: 'lookup_customer',
      description: `Look up a customer by phone number or name. Returns account details including name, address, WaveGuard tier, monthly rate, outstanding balance, member-since date, and pipeline stage. Use this first when you need any customer information. If the customer is already identified via context, you can skip this.`,
      input_schema: {
        type: 'object',
        properties: {
          phone: { type: 'string', description: 'Customer phone number (any format)' },
          name: { type: 'string', description: 'Customer first name, last name, or full name' },
        },
      },
    },

    // ── Account Data ────────────────────────────────────────────
    {
      type: 'custom',
      name: 'get_upcoming_services',
      description: `Get the next 5 scheduled services for a customer. Returns date, service type, time window, assigned technician, and status. Use when a customer asks "when is my next service" or about upcoming appointments.`,
      input_schema: {
        type: 'object',
        properties: { customer_id: { type: 'string', description: 'Waves customer UUID' } },
        required: ['customer_id'],
      },
    },
    {
      type: 'custom',
      name: 'get_service_history',
      description: `Get recent completed services. Returns service date, type, technician name, and tech notes. Use when they ask "what did you do last time" or about past services.`,
      input_schema: {
        type: 'object',
        properties: {
          customer_id: { type: 'string', description: 'Waves customer UUID' },
          limit: { type: 'number', description: 'Number of records (default 5, max 10)' },
        },
        required: ['customer_id'],
      },
    },
    {
      type: 'custom',
      name: 'get_billing_info',
      description: `Get billing info: WaveGuard tier, monthly rate, outstanding balance, last 5 payments, and payment methods on file. Use when they ask about their bill, payments, balance, or card.`,
      input_schema: {
        type: 'object',
        properties: { customer_id: { type: 'string', description: 'Waves customer UUID' } },
        required: ['customer_id'],
      },
    },
    {
      type: 'custom',
      name: 'get_call_history',
      description: `Get recent phone call recordings and transcripts. Use when you need context about recent phone interactions.`,
      input_schema: {
        type: 'object',
        properties: {
          customer_id: { type: 'string', description: 'Waves customer UUID' },
          limit: { type: 'number', description: 'Number of records (default 5)' },
        },
        required: ['customer_id'],
      },
    },

    // ── Appointment Booking ─────────────────────────────────────
    {
      type: 'custom',
      name: 'check_availability',
      description: `Check available appointment slots for a customer's city over the next 14 days. Returns dates with open time slots — only shows slots when a tech is already working in their zone that day. Present 2-3 natural options rather than listing everything. Requires the customer's city.`,
      input_schema: {
        type: 'object',
        properties: {
          city: { type: 'string', description: "Customer's city: Bradenton, Lakewood Ranch, Sarasota, Venice, North Port, Parrish, Port Charlotte" },
          estimate_id: { type: 'string', description: 'Optional estimate ID to link the booking to' },
        },
        required: ['city'],
      },
    },
    {
      type: 'custom',
      name: 'book_appointment',
      description: `Book a confirmed appointment. Creates the service on the dispatch board, sends confirmation SMS to the customer with a code, and notifies Adam. CRITICAL: Always check_availability first and get explicit customer confirmation before booking. Never book speculatively.`,
      input_schema: {
        type: 'object',
        properties: {
          customer_id: { type: 'string', description: 'Waves customer UUID' },
          date: { type: 'string', description: 'YYYY-MM-DD format' },
          start_time: { type: 'string', description: 'HH:MM 24-hour format' },
          customer_notes: { type: 'string', description: 'Any notes from the customer' },
          estimate_id: { type: 'string', description: 'Optional linked estimate' },
        },
        required: ['customer_id', 'date', 'start_time'],
      },
    },

    // ── Payments ────────────────────────────────────────────────
    {
      type: 'custom',
      name: 'send_payment_link',
      description: `Send a tap-to-pay invoice link via SMS. Finds the most recent unpaid invoice, or creates a new one if you provide amount and description. Customer gets a text with a link to pay by card, Apple Pay, Google Pay, or bank transfer. Returns the pay URL and invoice details.`,
      input_schema: {
        type: 'object',
        properties: {
          customer_id: { type: 'string', description: 'Waves customer UUID' },
          invoice_id: { type: 'string', description: 'Existing invoice ID (optional)' },
          amount: { type: 'number', description: 'Amount in dollars (only for new invoice)' },
          description: { type: 'string', description: 'What the payment is for (only for new invoice)' },
        },
        required: ['customer_id'],
      },
    },
    {
      type: 'custom',
      name: 'check_payment_status',
      description: `Check payment status of an invoice. Returns status (draft/sent/paid/overdue), amount, due date, and payment details. Defaults to most recent invoice if no ID given.`,
      input_schema: {
        type: 'object',
        properties: {
          customer_id: { type: 'string', description: 'Waves customer UUID' },
          invoice_id: { type: 'string', description: 'Specific invoice ID (optional)' },
        },
        required: ['customer_id'],
      },
    },

    // ── Property & Recommendations ──────────────────────────────
    {
      type: 'custom',
      name: 'get_property_profile',
      description: `Get the full property profile: square footage, lot size, grass type, plus preferences (gate codes, pets, irrigation, HOA, scheduling preferences, chemical sensitivities, special instructions). Use when you need property context for advice.`,
      input_schema: {
        type: 'object',
        properties: { customer_id: { type: 'string', description: 'Waves customer UUID' } },
        required: ['customer_id'],
      },
    },
    {
      type: 'custom',
      name: 'get_lawn_health',
      description: `Get lawn health scores: turf density, weed suppression, fungus control, thatch level, color health, overall score (0-100). Shows latest vs initial baseline and improvement over time. Use when they ask "how is my lawn doing."`,
      input_schema: {
        type: 'object',
        properties: { customer_id: { type: 'string', description: 'Waves customer UUID' } },
        required: ['customer_id'],
      },
    },
    {
      type: 'custom',
      name: 'get_service_recommendations',
      description: `Generate personalized recommendations based on property, active services, lawn health, service history, and seasonal pest pressure. Returns recommended add-ons, treatment adjustments, seasonal advice, and WaveGuard upgrade opportunities. Use when they ask "what else should I be doing" or when you notice gaps.`,
      input_schema: {
        type: 'object',
        properties: { customer_id: { type: 'string', description: 'Waves customer UUID' } },
        required: ['customer_id'],
      },
    },

    // ── Knowledge & Communication ───────────────────────────────
    {
      type: 'custom',
      name: 'get_pest_advice',
      description: `Search the Waves knowledge base for SWFL-specific pest or lawn care advice. Covers pests, lawn issues, treatment protocols, product info, and seasonal guidance. Returns an answer plus source references.`,
      input_schema: {
        type: 'object',
        properties: { topic: { type: 'string', description: 'Pest, lawn issue, product, or treatment to look up' } },
        required: ['topic'],
      },
    },
    {
      type: 'custom',
      name: 'send_sms',
      description: `Send a follow-up SMS to the customer. Use for supplementary info (links, confirmation details, instructions) — NOT for the main reply. Keep under 320 chars.`,
      input_schema: {
        type: 'object',
        properties: {
          customer_id: { type: 'string', description: 'Waves customer UUID' },
          message: { type: 'string', description: 'SMS text (under 320 chars)' },
        },
        required: ['customer_id', 'message'],
      },
    },

    // ── Escalation ──────────────────────────────────────────────
    {
      type: 'custom',
      name: 'escalate',
      description: `Escalate to a human. MUST use for: cancellations, existing appointment reschedules, complaints, billing disputes, refund requests, manager requests, anything uncertain. You CAN book NEW appointments without escalating.`,
      input_schema: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'Clear summary of why this needs human attention' },
          priority: { type: 'string', enum: ['urgent', 'normal', 'low'] },
        },
        required: ['reason'],
      },
    },
  ],
};

module.exports = { AGENT_CONFIG };
