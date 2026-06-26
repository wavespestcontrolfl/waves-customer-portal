/**
 * AI invoice summary generator.
 *
 * Powers the "Write with AI" control on the admin invoice builder. Produces a
 * short, customer-facing summary of what happened at the visit, assembled from
 * the linked service record (one-tap) plus any line items / typed input the
 * operator adds.
 *
 * Customer-facing copy → uses the VOICE tier (warm, natural), matching the
 * service-recap generator. Guardrails mirror completion-recap.js: never names
 * products / chemicals / prices, never overpromises, never invents.
 *
 * The three context sources map to the ServiceTitan-style toggles:
 *   jobSummary → service_records.technician_notes
 *   forms      → soil / lawn diagnostic readings on the service record
 *   lineItems  → the invoice line descriptions (passed from the client)
 */

const db = require('../models/db');
const MODELS = require('../config/models');
const logger = require('./logger');

const MAX_INPUT = 2000;
const MAX_SERVICE_LINES = 12;
const MAX_NOTES_OUT = 1000;

function clean(value, max) {
  if (value == null) return '';
  const s = String(value).trim();
  return max ? s.slice(0, max) : s;
}

// Normalize the client-supplied source toggles. When a service record is
// available we default every source on (true one-tap); an explicit `false`
// turns a source off.
function normalizeSources(sources = {}) {
  const s = sources && typeof sources === 'object' ? sources : {};
  return {
    jobSummary: s.jobSummary !== false,
    forms: s.forms !== false,
    lineItems: s.lineItems !== false,
  };
}

function formatServiceLines(services = []) {
  return (Array.isArray(services) ? services : [])
    .slice(0, MAX_SERVICE_LINES)
    .map((s) => {
      const description = clean(s && s.description, 160);
      const quantity = Number(s && s.quantity) || 1;
      return description ? `- ${description}${quantity > 1 ? ` x${quantity}` : ''}` : null;
    })
    .filter(Boolean);
}

// Plain-language diagnostic readings a homeowner can understand. Raw field
// codes / internal QA flags (field_flags) are intentionally excluded — they are
// not customer-facing.
function formatObservations(record = {}) {
  const obs = [];
  if (record.soil_temp != null && record.soil_temp !== '') {
    obs.push(`Soil temperature: ${record.soil_temp}°F`);
  }
  if (record.thatch_measurement != null && record.thatch_measurement !== '') {
    obs.push(`Thatch depth: ${record.thatch_measurement} in`);
  }
  if (record.soil_ph != null && record.soil_ph !== '') {
    obs.push(`Soil pH: ${record.soil_ph}`);
  }
  if (record.soil_moisture) {
    obs.push(`Soil moisture: ${clean(record.soil_moisture, 20)}`);
  }
  return obs;
}

// Pull customer-relevant context from a completed service record. Degrades
// gracefully — a missing record / bad query returns an empty context so the
// operator's typed input + line items still drive generation.
async function loadServiceContext(serviceRecordId) {
  const empty = { found: false, serviceType: '', serviceDate: '', jobSummary: '', observations: [] };
  if (!serviceRecordId) return empty;
  let record;
  try {
    record = await db('service_records').where({ id: serviceRecordId }).first();
  } catch (err) {
    logger.warn(`[invoice-ai-summary] service record lookup failed: ${err.message}`);
    return empty;
  }
  if (!record) return empty;
  return {
    found: true,
    serviceType: clean(record.service_type, 100),
    serviceDate: record.service_date ? clean(record.service_date, 40) : '',
    jobSummary: clean(record.technician_notes, MAX_INPUT),
    observations: formatObservations(record),
  };
}

function buildSummaryPrompt({ customerName, serviceLines = [], input = '', context = {}, sources } = {}) {
  const src = normalizeSources(sources);
  const blocks = [];

  if (context.serviceType || context.serviceDate) {
    const svc = [context.serviceType, context.serviceDate].filter(Boolean).join(' on ');
    blocks.push(`Service:\n${svc}`);
  }
  if (src.lineItems && serviceLines.length) {
    blocks.push(`Service lines:\n${serviceLines.join('\n')}`);
  }
  if (src.jobSummary && context.jobSummary) {
    blocks.push(`Job summary (technician notes):\n${context.jobSummary}`);
  }
  if (src.forms && context.observations && context.observations.length) {
    blocks.push(`Field observations:\n${context.observations.join('\n')}`);
  }
  if (clean(input)) {
    blocks.push(`Additional technician input:\n${clean(input, MAX_INPUT)}`);
  }

  return `Write a short customer-facing invoice summary for Waves Pest Control & Lawn Care.

Requirements:
- Plain text only.
- 2 to 4 sentences.
- Professional, friendly, and specific.
- Summarize what was done at the visit in plain language a homeowner understands.
- Use only the job context provided below.
- Do not invent products, pests, locations, guarantees, follow-up dates, prices, discounts, or payment claims.
- Never mention product names, chemical names, active ingredients, or application rates.
- Do not output raw field codes, internal flags, or measurement labels verbatim — translate readings into plain language only when meaningful to a homeowner.
- Do not say eliminated, guaranteed, pest-free, eradicated, or solved forever.
- Do not include a greeting, subject line, sign-off, markdown, or bullets.

Customer: ${clean(customerName, 160) || 'Customer'}

${blocks.join('\n\n') || '[no context provided]'}

Return only the summary text.`;
}

function hasUsableContext({ input, serviceLines, context, sources }) {
  const src = normalizeSources(sources);
  if (clean(input)) return true;
  if (src.lineItems && Array.isArray(serviceLines) && serviceLines.length) return true;
  if (context && context.found) {
    if (src.jobSummary && context.jobSummary) return true;
    if (src.forms && context.observations && context.observations.length) return true;
    if (context.serviceType) return true;
  }
  return false;
}

async function aiSummary(prompt) {
  let Anthropic;
  try {
    Anthropic = require('@anthropic-ai/sdk');
  } catch {
    return null;
  }
  if (!Anthropic || !process.env.ANTHROPIC_API_KEY) return null;
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const msg = await anthropic.messages.create({
    model: MODELS.VOICE,
    max_tokens: 320,
    messages: [{ role: 'user', content: prompt }],
  });
  return clean(msg.content?.[0]?.text || '', MAX_NOTES_OUT);
}

/**
 * Generate a customer-facing invoice summary.
 * @returns {Promise<{ notes: string, sourcesUsed: string[] } | { error: string }>}
 */
async function generateInvoiceSummary({ input, customerName, services, serviceRecordId, sources } = {}) {
  const src = normalizeSources(sources);
  const serviceLines = formatServiceLines(services);
  const context = await loadServiceContext(serviceRecordId);

  if (!hasUsableContext({ input, serviceLines, context, sources })) {
    return { error: 'Add notes, service lines, or link a completed visit first' };
  }

  const prompt = buildSummaryPrompt({ customerName, serviceLines, input, context, sources });
  const notes = await aiSummary(prompt);
  if (!notes) return { error: 'AI did not return a summary' };

  const sourcesUsed = [];
  if (context.found && src.jobSummary && context.jobSummary) sourcesUsed.push('job_summary');
  if (context.found && src.forms && context.observations.length) sourcesUsed.push('forms');
  if (src.lineItems && serviceLines.length) sourcesUsed.push('line_items');
  if (clean(input)) sourcesUsed.push('input');

  return { notes, sourcesUsed };
}

module.exports = {
  generateInvoiceSummary,
  buildSummaryPrompt,
  loadServiceContext,
  formatServiceLines,
  formatObservations,
  normalizeSources,
  hasUsableContext,
};
