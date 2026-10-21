/**
 * Intelligence Bar — convert a lead to a customer
 * server/services/intelligence-bar/lead-convert-tools.js
 *
 * Owner ruling 2026-10-12 ("yes to all recommendations", Stage 3 purpose-built cards): a card that
 * replays a screen's own handler.
 *
 *   convert_lead — the Leads page "Convert to Customer" (POST /admin/leads/:id/convert), run through
 *                  admin-leads.js convertLeadFromBar: the same handler, in process, so every refusal
 *                  and rule is the route's own. The screen LINKS the lead to an EXISTING customer the
 *                  operator names. It creates no customer and has no duplicate check; the card does the
 *                  matching read-only (this customer's phone / email against the lead's, and other
 *                  customers that share them) so the operator sees it before approving.
 *
 * What the handler writes (leadAttribution.markConverted): the lead's status (won), converted date,
 * qualified flag, customer link and the value fields given; the ad funnel row (to booked, linked to the customer); the lead's own
 * estimate attached to the customer when it has none; a `converted` row on the lead's activity list. It
 * sends no text, email or call, books nothing, charges nothing, accepts no estimate and changes no Auto
 * Pay. The card says so.
 *
 * Always a confirm card (write-gates.js two-step), admin only, never owner-direct, platform path only,
 * dark behind GATE_IB_LEAD_CONVERT (which needs GATE_IB_PLATFORM).
 *
 *   unconfirmed -> a PREVIEW: nothing is written. Its `_version` pins what the card showed (the lead's
 *                  status and edit time, contact, links and values; the customer; the matches; the
 *                  estimate and funnel rows; the exact request body).
 *   confirmed   -> re-derives the preview and refuses with preview_changed on any drift, then runs the
 *                  handler with exactly the carded body (customer_id, the values, and the lead's status and
 *                  edit time as the page sends them as seen_status / seen_updated_at).
 */
const crypto = require('crypto');
const db = require('../../models/db');
const logger = require('../logger');
const { UUID_RE } = require('./task-context');

function leadConvertLive() {
  return require('../../config/feature-gates').ibLeadConvertLive() === true;
}

// The WaveGuard tier options the Leads page offers.
const TIERS = ['Platinum', 'Gold', 'Silver', 'Bronze', 'One-Time'];

const LEAD_CONVERT_TOOLS = [
  {
    name: 'convert_lead',
    description: `Convert ONE lead to a customer: the Leads page "Convert to Customer" button. It marks the lead won and links it to an EXISTING customer record you name; it does not create a customer (create one first with create_customer if there is none). The first call returns a PREVIEW and writes nothing: the lead, the customer it would link to, how the customer's phone and email compare with the lead's, any other customers that share them, the figures given, and exactly what changes. The operator approves on the confirmation card; the confirmed run re-checks all of it and refuses if anything changed.
Effects: the lead becomes won with the customer linked (and the monthly value, first-service value and WaveGuard tier you gave), the lead's ad funnel row moves to booked, the lead's own estimate is attached to the customer when it has none, and an activity row is added to the lead. Nothing is sent to the customer or anyone (no text, email or call), nothing is booked or charged, no estimate is accepted, and Auto Pay is not touched.
Pass lead_id. Pass customer_id when you know it; without it the call returns the customers that match the lead's phone or email and writes nothing, so ask the operator which one. Refused: lead not found, lead already converted, customer not found.
Use for: "convert this lead", "convert lead to customer", "make this lead a customer", "turn the lead into a customer", "mark this lead won and link it to the customer"`,
    input_schema: {
      type: 'object',
      properties: {
        lead_id: { type: 'string', format: 'uuid', description: 'The lead (from query_leads)' },
        customer_id: { type: 'string', format: 'uuid', description: 'The existing customer to link the lead to (from query_customers or create_customer)' },
        monthly_value: { type: 'number', description: 'Monthly value in dollars (0 to 100000), only if the operator gave one' },
        initial_service_value: { type: 'number', description: 'First-service value in dollars (0 to 1000000), only if the operator gave one' },
        waveguard_tier: { type: 'string', enum: TIERS, description: 'WaveGuard tier, only if the operator gave one' },
      },
      required: ['lead_id'],
    },
  },
];

const money = (value) => `$${(Math.round((Number(value) || 0) * 100) / 100).toFixed(2)}`;
const msOf = (value) => (value ? new Date(value).getTime() : null);
const digest = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);
const refusal = (error, code, extra = {}) => ({ error, code, ...extra });
const maskPhone = (phone) => {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length >= 4 ? `***${digits.slice(-4)}` : null;
};
const phoneKey = (phone) => String(phone || '').replace(/\D/g, '').slice(-10);
const emailKey = (email) => String(email || '').trim().toLowerCase();
const personName = (row) => [row?.first_name, row?.last_name].filter(Boolean).join(' ').trim() || row?.company_name || null;
const addressLine = (street, city, zip) => [street, city, zip].map((v) => String(v || '').trim()).filter(Boolean).join(', ') || null;

// The customers that share the lead's phone or email (the match the page leaves to the operator's eyes).
async function contactMatches(lead, { excludeId = null, limit = 6 } = {}) {
  const phone = phoneKey(lead.phone);
  const email = emailKey(lead.email);
  if (phone.length < 10 && !email) return [];
  const rows = await db('customers').whereNull('deleted_at')
    .where(function sharesContact() {
      if (phone.length >= 10) this.orWhereRaw("RIGHT(regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g'), 10) = ?", [phone]);
      if (email) this.orWhereRaw("LOWER(COALESCE(email, '')) = ?", [email]);
    })
    .modify((q) => { if (excludeId) q.whereNot('id', excludeId); })
    .orderBy('id')
    .limit(limit)
    .select('id', 'first_name', 'last_name', 'company_name', 'phone', 'email', 'address_line1', 'city', 'zip');
  return (rows || []).map((row) => ({
    id: row.id,
    name: personName(row),
    city: row.city || null,
    matched_on: [
      phone.length >= 10 && phoneKey(row.phone) === phone ? 'phone' : null,
      email && emailKey(row.email) === email ? 'email' : null,
    ].filter(Boolean),
  }));
}

// The exact body the Leads page sends, built from the call and the lead as the card read it.
function requestBody(lead, input, customerId) {
  return {
    customer_id: customerId,
    ...(input.monthly_value !== undefined ? { monthly_value: input.monthly_value } : {}),
    ...(input.initial_service_value !== undefined ? { initial_service_value: input.initial_service_value } : {}),
    ...(input.waveguard_tier !== undefined ? { waveguard_tier: input.waveguard_tier } : {}),
    seen_status: lead.status,
    seen_updated_at: lead.updated_at ? new Date(lead.updated_at).toISOString() : undefined,
  };
}

// The lead's own estimate, as markConverted's backfill (linkLeadEstimatesToCustomer) will find it.
async function estimateEffect(lead, customerId) {
  if (!lead.estimate_id) {
    return {
      state: { estimate_id: null },
      line: 'Any estimate tagged with this lead that has no customer yet is attached to the customer. The lead has no linked estimate.',
    };
  }
  const estimate = await db('estimates').where({ id: lead.estimate_id }).first('id', 'status', 'customer_id');
  if (!estimate) return { state: { estimate_id: lead.estimate_id, missing: true }, line: 'The lead’s linked estimate could not be found; none is attached.' };
  const state = { estimate_id: estimate.id, customer_id: estimate.customer_id || null, status: estimate.status || null };
  let line;
  if (!estimate.customer_id) line = `The lead’s estimate (${estimate.status || 'no status'}) has no customer yet: it is attached to this customer. It is not accepted or sent.`;
  else if (estimate.customer_id === customerId) line = 'The lead’s estimate is already on this customer.';
  else line = 'The lead’s estimate belongs to a different customer: it stays there.';
  return { state, line };
}

async function funnelRows(leadId) {
  const row = await db('ad_service_attribution').where({ lead_id: leadId }).count('* as n').first();
  return Number(row?.n) || 0;
}

// The lead (unconverted) and the customer the call names, or the refusal. Without a customer_id the
// answer is the list of customers that share the lead's contact, never a card.
async function resolveTargets(input) {
  const rawLead = String(input?.lead_id || '').trim();
  if (!UUID_RE.test(rawLead)) return refusal('A valid lead_id is required', 'invalid_target');
  const lead = await db('leads').where({ id: rawLead.toLowerCase() }).whereNull('deleted_at').first();
  if (!lead) return refusal('Lead not found', 'lead_not_found');
  const leadName = personName(lead) || 'Unnamed lead';
  if (lead.converted_at || lead.status === 'won') {
    return refusal(`${leadName} is already converted${lead.customer_id ? ' and linked to a customer' : ''}. Nothing was changed.`, 'already_converted', { lead_id: lead.id });
  }
  const badValue = [['monthly_value', 100000], ['initial_service_value', 1000000]]
    .find(([key, max]) => input[key] !== undefined && !(Number.isFinite(input[key]) && input[key] >= 0 && input[key] <= max));
  if (badValue) return refusal(`${badValue[0]} must be a dollar amount from 0 to ${badValue[1]}`, 'invalid_value');
  const rawCustomer = String(input?.customer_id || '').trim();
  if (!rawCustomer) {
    const candidates = await contactMatches(lead);
    return refusal(
      candidates.length
        ? 'Which customer is this lead? The Leads page links a lead to an existing customer. Ask the operator to pick one of these, or create the customer first.'
        : 'No customer shares this lead\u2019s phone or email. The Leads page links a lead to an existing customer: create the customer first (create_customer), then convert.',
      'customer_required',
      { lead_id: lead.id, lead_name: leadName, candidates: candidates.map((c) => ({ customer_id: c.id, name: c.name, city: c.city, matched_on: c.matched_on })) },
    );
  }
  if (!UUID_RE.test(rawCustomer)) return refusal('A valid customer_id is required', 'invalid_target');
  const customer = await db('customers').where({ id: rawCustomer.toLowerCase() }).whereNull('deleted_at').first();
  if (!customer) return refusal('Customer not found', 'customer_not_found');
  return { lead, leadName, customer };
}

const matchedOnOf = (lead, customer) => [
  phoneKey(lead.phone).length >= 10 && phoneKey(lead.phone) === phoneKey(customer.phone) ? 'phone' : null,
  emailKey(lead.email) && emailKey(lead.email) === emailKey(customer.email) ? 'email' : null,
].filter(Boolean);

function valuesGiven(body) {
  const values = [];
  if (body.monthly_value !== undefined) values.push(body.monthly_value ? `monthly value ${money(body.monthly_value)}` : 'monthly value cleared');
  if (body.initial_service_value !== undefined) values.push(body.initial_service_value ? `first-service value ${money(body.initial_service_value)}` : 'first-service value cleared');
  if (body.waveguard_tier !== undefined) values.push(`WaveGuard tier ${body.waveguard_tier}`);
  return values;
}

// Every change the handler makes, and what it does not do (the sent / money lines are the promise on the card).
function planEffects({ lead, leadName, customer, values, funnel, estimate }) {
  const funnelText = funnel
    ? `The lead\u2019s ad funnel row moves to booked and is linked to the customer (${funnel} row${funnel === 1 ? '' : 's'}; never moved backwards).`
    : 'The lead has no ad funnel row, so none moves. The funnel settlement can still rebuild one for a repeat quote-wizard lead.';
  return [
    { kind: 'customer', text: `Lead ${leadName}: status ${lead.status} \u2192 won; linked to customer ${personName(customer) || customer.id}; marked qualified; conversion date set to now${values.length ? `; ${values.join(', ')}` : ''}` },
    ...(values.length === 0 ? [{ kind: 'operational', text: 'No monthly value, first-service value or tier was given: the lead\u2019s existing figures stay as they are.' }] : []),
    { kind: 'operational', text: funnelText },
    { kind: 'operational', text: estimate.line },
    { kind: 'operational', text: 'A "converted" entry is added to the lead\u2019s activity list.' },
    { kind: 'comms', text: 'Nothing is sent: no text, email or call goes to the customer or anyone else, and no portal invite or welcome message.' },
    { kind: 'billing', text: 'No charge, invoice, deposit or estimate acceptance, no visit is booked, and Auto Pay is not touched.' },
  ];
}

function planWarnings({ lead, matchedOn, others }) {
  const warnings = [];
  if (!matchedOn.length) warnings.push('This customer\u2019s phone and email do not match the lead\u2019s. Check it is the same person.');
  if (others.length) {
    const who = others.map((o) => `${o.name || o.id}${o.city ? ` (${o.city})` : ''} on ${o.matched_on.join(' and ')}`).join('; ');
    warnings.push(`${others.length === 1 ? 'Another customer shares' : `${others.length} other customers share`} the lead\u2019s phone or email: ${who}. Make sure this is the right account.`);
  }
  if (lead.status === 'lost') warnings.push('This lead is marked lost; converting reopens it as won.');
  return warnings;
}

// Everything the card approves: a change in any of it is drift.
function versionOf({ lead, customer, others, estimate, funnel, body }) {
  return {
    lead_id: lead.id,
    status: lead.status,
    updated_at: msOf(lead.updated_at),
    converted_at: msOf(lead.converted_at),
    lead_customer_id: lead.customer_id || null,
    lead_contact: digest([lead.first_name, lead.last_name, lead.phone, lead.email, lead.address, lead.city, lead.zip]),
    lead_values: digest([lead.monthly_value, lead.initial_service_value, lead.waveguard_tier]),
    customer_id: customer.id,
    customer_contact: digest([customer.first_name, customer.last_name, customer.company_name, customer.phone, customer.email, customer.address_line1, customer.city, customer.zip]),
    others: digest(others.map((o) => o.id)),
    estimate: digest(estimate.state),
    funnel_rows: funnel,
    body: digest(body),
  };
}

async function buildPlan(input) {
  const targets = await resolveTargets(input);
  if (targets.error) return targets;
  const { lead, leadName, customer } = targets;
  const body = requestBody(lead, input, customer.id);
  const matchedOn = matchedOnOf(lead, customer);
  const others = await contactMatches(lead, { excludeId: customer.id });
  const estimate = await estimateEffect(lead, customer.id);
  const funnel = await funnelRows(lead.id);
  const values = valuesGiven(body);
  return {
    preview: true,
    tool: 'convert_lead',
    lead_id: lead.id,
    lead_name: leadName,
    lead_status: lead.status,
    lead: { phone: maskPhone(lead.phone), email: lead.email || null, address: addressLine(lead.address, lead.city, lead.zip) },
    customer_id: customer.id,
    customer_name: personName(customer) || customer.id,
    customer: { phone: maskPhone(customer.phone), email: customer.email || null, address: addressLine(customer.address_line1, customer.city, customer.zip) },
    matched_on: matchedOn.length ? matchedOn.join(' and ') : 'none',
    other_matching_customers: others.map((o) => ({ customer_id: o.id, name: o.name, city: o.city, matched_on: o.matched_on.join(' and ') })),
    values_given: values,
    effects: planEffects({ lead, leadName, customer, values, funnel, estimate }),
    warnings: planWarnings({ lead, matchedOn, others }),
    sends_to_customer: false,
    _version: versionOf({ lead, customer, others, estimate, funnel, body }),
    _body: body,
    note: 'PREVIEW ONLY \u2014 nothing was changed. Confirm converts exactly this; if anything changed it refuses.',
  };
}

// The re-derived plan when it still matches the card's pin, or the refusal.
async function verifiedPlan(input, pinned) {
  if (!pinned) return { refusal: refusal('Use the confirmation card to approve this conversion.', 'approval_required') };
  const plan = await buildPlan(input);
  if (plan.error) return { refusal: { error: `Nothing was changed: ${plan.error}`, code: plan.code, preview_changed: true } };
  if (JSON.stringify(plan._version) !== JSON.stringify(pinned)) {
    return { refusal: { error: 'The lead or the customer changed after the card was shown, so nothing was converted. Ask again for a fresh confirmation card.', code: 'preview_changed', preview_changed: true } };
  }
  return { plan };
}

async function commitConvert(input) {
  const { plan, refusal: refused } = await verifiedPlan(input, input._verified_lead_convert_version);
  if (refused) return refused;
  const { status, json } = await require('../../routes/admin-leads').convertLeadFromBar({ leadId: plan.lead_id, body: plan._body });
  const base = { lead_id: plan.lead_id, lead_name: plan.lead_name, customer_id: plan.customer_id, customer_name: plan.customer_name };
  if (status !== 200) {
    // 409: the page's own "this lead changed since the page loaded" answer; 404: the lead or customer is gone.
    return { ...base, failed: true, code: status === 409 ? 'lead_changed' : status === 404 ? 'not_found' : 'convert_refused',
      error: `The lead was not converted: ${json?.error || 'the Leads page refused it'}`, ...(status === 409 || status === 404 ? { preview_changed: true } : {}) };
  }
  const lead = json?.lead || {};
  if (lead.status !== 'won' || lead.customer_id !== plan.customer_id) {
    return { ...base, outcome_unknown: true, code: 'convert_unverified',
      error: 'The Leads page answered, but the lead does not read as won and linked to this customer. Check the lead before trying again.' };
  }
  logger.info(`[intelligence-bar:lead-convert] converted lead ${plan.lead_id} to customer ${plan.customer_id}`);
  return { ...base, success: true, status: 'won', sent_to_customer: false,
    note: `${plan.lead_name} is converted and linked to ${plan.customer_name}. Nothing was sent to anyone.` };
}

// ── card lines (authorization-contract.js) ──────────────────────

function cardLines(toolName, preview) {
  if (toolName !== 'convert_lead' || !preview || preview.preview !== true) return [];
  const lines = [
    { kind: 'customer', text: `Convert lead ${preview.lead_name} (${preview.lead_status}) → customer ${preview.customer_name}` },
    { kind: 'customer', text: `Lead: phone ${preview.lead.phone || 'none'}, email ${preview.lead.email || 'none'}, address ${preview.lead.address || 'none'}` },
    { kind: 'customer', text: `Customer: phone ${preview.customer.phone || 'none'}, email ${preview.customer.email || 'none'}, address ${preview.customer.address || 'none'}` },
    { kind: 'customer', text: `Phone / email match: ${preview.matched_on}` },
    ...(preview.warnings || []).map((text) => ({ kind: 'operational', text: `Check: ${text}` })),
    ...(preview.effects || []).map(({ kind, text }) => ({ kind, text })),
  ];
  return lines;
}

async function executeLeadConvertTool(toolName, input = {}, actionContext = {}) {
  if (!LEAD_CONVERT_TOOLS.some((t) => t.name === toolName)) return { error: `Unknown tool: ${toolName}` };
  // Admin only, like the requireAdmin Leads router; the registry refuses a technician too. The confirmed
  // run needs a positive admin flag (fail closed).
  if (actionContext?.isAdmin === false || (input.confirmed === true && actionContext?.isAdmin !== true)) {
    return refusal('Converting leads is limited to admin accounts', 'permission_denied');
  }
  if (!leadConvertLive()) return refusal('Converting a lead from the bar is switched off.', 'gate_off');
  try {
    // Only /confirm-action sets confirmed (route-derived, never a model param).
    return input.confirmed === true ? await commitConvert(input) : await buildPlan(input);
  } catch (err) {
    logger.error(`[intelligence-bar:lead-convert] ${toolName} failed (${err.code || err.name || 'error'})`);
    // A throw after an approval may follow the write: never invite a retry.
    return input.confirmed === true
      ? { outcome_unknown: true, code: 'execution_interrupted', error: 'The conversion was interrupted — it may or may not have happened. Check the lead before trying again.' }
      : { error: 'Could not prepare the lead conversion' };
  }
}

module.exports = {
  LEAD_CONVERT_TOOLS,
  executeLeadConvertTool,
  leadConvertLive,
  cardLines,
};
