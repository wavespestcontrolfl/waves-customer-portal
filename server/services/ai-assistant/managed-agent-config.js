/**
 * Waves AI Assistant — Claude Managed Agents integration
 *
 * Two components:
 *   1. Agent definition (run once via `node scripts/create-managed-agent.js`)
 *   2. Session manager Express route (replaces the old WavesAssistant tool loop)
 *
 * Architecture:
 *   SMS/Portal → Express route → creates/resumes Managed Agent session
 *   → agent streams events (including custom tool calls)
 *   → Express executes tool calls against PostgreSQL
 *   → sends results back → agent continues → final text reply
 *
 * Your existing tools.js executeToolCall() functions are reused unchanged.
 */

// ═══════════════════════════════════════════════════════════════
// AGENT DEFINITION — run once: node scripts/create-managed-agent.js
// Saves the agent_id to .env or config for the session manager
// ═══════════════════════════════════════════════════════════════

const AGENT_CONFIG = {
  name: 'waves-customer-assistant',
  description: 'Waves Pest Control customer-facing AI assistant for SMS, portal chat, and voice',
  model: 'claude-sonnet-4-6',
  system: `You are the Waves Pest Control AI assistant. You help customers with questions about their pest control and lawn care services in Southwest Florida.

PERSONALITY:
- Friendly, knowledgeable, direct — like a helpful neighbor who knows pest control
- Use the customer's first name naturally
- Keep responses concise for SMS (2-4 sentences max) or longer for portal chat
- Reference SWFL-specific conditions (sandy soil, afternoon storms, St. Augustine grass)
- Never sound robotic or corporate

WHAT YOU CAN DO:
- Answer questions about services, scheduling, products, pricing
- Look up customer accounts, upcoming services, billing
- Provide pest/lawn care advice specific to SWFL
- Send service reminders and confirmations

WHAT YOU MUST ESCALATE (use the escalate tool):
- Any request to cancel, pause, or downgrade service
- Any request to reschedule or change an appointment
- Complaints about service quality or technician behavior
- Billing disputes or refund requests
- Anything you're uncertain about
- Requests to speak with a manager/owner

ESCALATION FORMAT: When escalating, explain to the customer that you're connecting them with the team, and use the escalate tool with a clear summary of the issue.

RULES:
- Never make up service dates, prices, or technician names — always look them up
- Never promise specific times without checking availability
- If a customer asks about pricing, give the general range but note it depends on property size
- Always mention the WaveGuard tier benefits when relevant
- If you detect the customer is frustrated, acknowledge it before solving
- End every conversation with an offer to help with anything else`,

  tools: [
    // Built-in agent toolset — disable everything except web search
    // (we don't need bash/file ops for a customer chat agent)
    {
      type: 'agent_toolset_20260401',
      default_config: { enabled: false },
      configs: [
        { name: 'web_search', enabled: true },
      ],
    },

    // ── Custom tools (executed by YOUR Express backend) ────────
    {
      type: 'custom',
      name: 'lookup_customer',
      description: `Look up a customer by phone number or name. Returns account details including name, address, WaveGuard tier, monthly rate, outstanding balance, member-since date, and pipeline stage. Use this first when you need any customer information. If the customer is already identified via context, you can skip this.`,
      input_schema: {
        type: 'object',
        properties: {
          phone: { type: 'string', description: 'Customer phone number (any format — will be normalized)' },
          name: { type: 'string', description: 'Customer first name, last name, or full name' },
        },
      },
    },
    {
      type: 'custom',
      name: 'get_upcoming_services',
      description: `Get the next 5 scheduled services for a customer. Returns date, service type (pest control, lawn care, mosquito, etc.), time window, assigned technician name, and current status. Use this when a customer asks "when is my next service" or anything about upcoming appointments.`,
      input_schema: {
        type: 'object',
        properties: {
          customer_id: { type: 'string', description: 'Waves customer UUID (from lookup_customer result)' },
        },
        required: ['customer_id'],
      },
    },
    {
      type: 'custom',
      name: 'get_service_history',
      description: `Get the most recent completed services for a customer. Returns service date, service type, technician name, and technician notes (what was done, products applied, observations). Use when a customer asks "what did you do last time" or about past services.`,
      input_schema: {
        type: 'object',
        properties: {
          customer_id: { type: 'string', description: 'Waves customer UUID' },
          limit: { type: 'number', description: 'Number of records to return (default 5, max 10)' },
        },
        required: ['customer_id'],
      },
    },
    {
      type: 'custom',
      name: 'get_billing_info',
      description: `Get billing information for a customer. Returns WaveGuard tier, monthly rate, outstanding balance, last 5 payments (date, amount, status, card info), and all payment methods on file (brand, last four, default status, autopay status). Use when a customer asks about their bill, payments, balance, or card on file.`,
      input_schema: {
        type: 'object',
        properties: {
          customer_id: { type: 'string', description: 'Waves customer UUID' },
        },
        required: ['customer_id'],
      },
    },
    {
      type: 'custom',
      name: 'get_pest_advice',
      description: `Search the Waves knowledge base for SWFL-specific pest or lawn care advice. Covers common pests (palmetto bugs, ghost ants, whiteflies, chinch bugs, mole crickets), lawn issues (St. Augustine fungus, take-all root rot, dollar spot), treatment protocols, product info (Celsius WG limits, Fusilade II, Bora-Care), and seasonal guidance (nitrogen blackout June-September). Returns an answer plus source article references. Use when a customer asks about a pest, lawn problem, or treatment.`,
      input_schema: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: 'The pest, lawn issue, product, or treatment to look up' },
        },
        required: ['topic'],
      },
    },
    {
      type: 'custom',
      name: 'get_call_history',
      description: `Get recent phone call recordings and transcripts for a customer. Returns call date, direction (inbound/outbound), duration, status, outcome, whether a recording exists, and a truncated transcription. Use when you need context about recent phone interactions with this customer.`,
      input_schema: {
        type: 'object',
        properties: {
          customer_id: { type: 'string', description: 'Waves customer UUID' },
          limit: { type: 'number', description: 'Number of records (default 5)' },
        },
        required: ['customer_id'],
      },
    },
    {
      type: 'custom',
      name: 'escalate',
      description: `Escalate the conversation to a human team member. MUST be used for: cancellation or pause requests, appointment reschedules, complaints about service quality or technician behavior, billing disputes or refund requests, requests to speak to a manager or owner (Adam), and anything you're uncertain about or can't resolve with available tools. When escalating, you should still respond to the customer explaining that you're connecting them with the team.`,
      input_schema: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'Clear summary of why this needs human attention — include the customer\'s request and any relevant context' },
          priority: { type: 'string', enum: ['urgent', 'normal', 'low'], description: 'urgent = cancellation, lawsuit, BBB, complaint; normal = reschedule, billing question; low = general request' },
        },
        required: ['reason'],
      },
    },
  ],
};

module.exports = { AGENT_CONFIG };
