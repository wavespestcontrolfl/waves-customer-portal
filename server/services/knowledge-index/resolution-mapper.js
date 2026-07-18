/**
 * Resolution-artifact mappers — NO LLM. Everything here reshapes structure
 * the pipelines already produced (call extraction schema 1.x, triage/route
 * rows, service findings, report AI summaries) into a searchable artifact:
 * { question, situation, resolution, outcome, systems, occurredAt }.
 *
 * Redaction: the same double-pass as the voice-corpus miner —
 * agent-decision-training redactText (context names + structured PII) then
 * the content engine's pii-redactor (heuristic self-introductions, spouses,
 * tenants). Staff names stay, per house rule.
 */

const { redactText } = require('../agent-decision-training');
const { redact: redactPii } = require('../content/pii-redactor');

const DISPOSITION_TEXT = {
  booked: 'Booked the service on the call',
  callback_task_created: 'Created a callback task',
  lead_response_flow_triggered: 'Routed to the lead-response flow',
  existing_customer_routed: 'Routed to the existing-customer flow',
  estimate_send: 'Sent an estimate',
  cancellation_processed: 'Processed the cancellation',
  complaint_escalated: 'Escalated the complaint',
  vendor_logged: 'Logged as a vendor/partner contact',
  voicemail_processed: 'Processed the voicemail',
};

// Dispositions that carry no reusable knowledge. no_action_needed is the
// disposition layer's dead-air/silence/sub-threshold-noise bucket.
const SKIP_DISPOSITIONS = new Set(['spam_discarded', 'wrong_number_closed', 'no_action_needed']);
const SKIP_NATURES = new Set(['spam_solicitation', 'robocall', 'wrong_number', 'silent_or_noise']);

const clean = (v) => String(v || '').trim();

// Severity is an ordered scale, not alphabetical ('medium' > 'high' in a
// string sort). Unknown labels rank lowest.
const SEVERITY_RANK = ['info', 'low', 'minor', 'moderate', 'medium', 'high', 'severe', 'critical'];
function maxSeverityOf(findings) {
  let best = null;
  let bestRank = -1;
  for (const f of findings) {
    const sev = clean(f.severity).toLowerCase();
    if (!sev) continue;
    const rank = SEVERITY_RANK.indexOf(sev);
    if (rank > bestRank || (best === null && rank === -1)) { best = sev; bestRank = rank; }
  }
  return best;
}

function redact(text, contexts = []) {
  const value = clean(text);
  if (!value) return '';
  // redactText exact-matches names from context.customer.* (nested) — a flat
  // context is a silent no-op for the name pass; the pii-redactor heuristic
  // alone misses single-name references ("Spoke with Jane"). Multiple name
  // contexts run sequentially (linked customer + extracted caller can be
  // different people).
  const list = Array.isArray(contexts) ? contexts : [contexts];
  let out = value;
  for (const c of list) out = redactText(out, { customer: c });
  return redactPii(out).text;
}

// V2 extractions store pests_observed as objects ({ pest_type, ... });
// older shapes used plain strings. Normalize both to names.
function pestNames(list) {
  return (Array.isArray(list) ? list : [])
    .map((p) => (typeof p === 'string' ? p : clean(p?.pest_type || p?.name)))
    .map(clean)
    .filter(Boolean);
}

function parseEnriched(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return null; }
}

function renderQuestion(extraction) {
  const nature = clean(extraction.call_nature).replace(/_/g, ' ');
  const sr = extraction.service_request || {};
  const parts = [];
  if (sr.primary_service_category) parts.push(clean(sr.primary_service_category).replace(/_/g, ' '));
  const pests = pestNames(sr.pests_observed);
  if (pests.length) parts.push(`pests: ${pests.join(', ')}`);
  if (sr.service_intent) parts.push(`intent: ${clean(sr.service_intent).replace(/_/g, ' ')}`);
  if (sr.urgency) parts.push(`urgency: ${clean(sr.urgency)}`);
  const detail = parts.length ? ` — ${parts.join('; ')}` : '';
  return `${nature || 'customer call'}${detail}`;
}

/**
 * mapCall({ call, extraction, triageNotes, finalAction, context }) → artifact | null
 *  call: call_log row (id, customer_id, created_at, call_summary)
 *  extraction: parsed ai_extraction_enriched (persisted schema)
 *  triageNotes: [{ reason_code, resolution_note }] for the call
 *  finalAction: route_decisions.final_action_taken (latest), optional
 *  context: { first_name, last_name, phone } for name redaction
 */
function mapCall({ call, extraction: rawExtraction, triageNotes = [], finalAction = null, context = {} }) {
  const extraction = parseEnriched(rawExtraction);
  if (!extraction) return null;

  // call_log.disposition is the TERMINAL outcome production stamped (layered
  // spam verdict, whether a booking actually happened). When a terminal
  // disposition exists it OVERRIDES the model's spam-ish labels — the
  // disposition layer deliberately routes model-flagged spam to lead-response
  // unless independent signals agree, so a stamped real outcome must map even
  // if V2 said is_spam/robocall. Model labels only gate never-stamped rows.
  const terminal = clean(call.disposition);
  const recommended = clean(extraction.recommended_disposition);
  if (terminal) {
    if (SKIP_DISPOSITIONS.has(terminal)) return null;
  } else {
    if (extraction.meta?.is_spam) return null;
    if (SKIP_NATURES.has(clean(extraction.call_nature))) return null;
    if (SKIP_DISPOSITIONS.has(recommended)) return null;
  }

  // Prospect calls often have no linked customers row — the extraction's own
  // caller name is then the only redaction context available.
  const caller = extraction.caller || {};
  const secondaries = [extraction.secondary_contact, ...(Array.isArray(extraction.secondary_contacts) ? extraction.secondary_contacts : [])]
    .filter(Boolean)
    .map((sc) => ({ first_name: sc.first_name, last_name: sc.last_name, customer_name: sc.name }));
  const nameContexts = [context, { first_name: caller.first_name, last_name: caller.last_name }, ...secondaries]
    .filter((c) => c && (clean(c.first_name) || clean(c.last_name) || clean(c.customer_name)));

  const summary = clean(extraction.meta?.call_summary || call.call_summary);
  if (!summary) return null;

  // Only PRODUCTION signals resolve: the terminal disposition stamp, the
  // route decision's action actually taken, and closed triage notes. The
  // model's recommended_disposition is a suggestion — it rides outcome
  // metadata but never renders as something Waves did.
  const resolutionParts = [];
  if (terminal) {
    resolutionParts.push(DISPOSITION_TEXT[terminal] || `Outcome: ${terminal.replace(/_/g, ' ')}`);
  }
  if (finalAction && finalAction !== terminal) resolutionParts.push(`Action taken: ${clean(finalAction).replace(/_/g, ' ')}`);
  for (const note of triageNotes) {
    if (clean(note.resolution_note)) resolutionParts.push(`Triage (${note.reason_code}): ${redact(note.resolution_note, nameContexts)}`);
  }
  if (!resolutionParts.length) return null; // nothing resolved — no knowledge to keep

  const sr = extraction.service_request || {};
  const systems = [
    clean(extraction.call_nature),
    clean(sr.primary_service_category),
    ...(Array.isArray(sr.secondary_categories) ? sr.secondary_categories : []),
    ...pestNames(sr.pests_observed),
  ].map(clean).filter(Boolean);

  return {
    source: 'call',
    sourceId: call.id,
    customerId: call.customer_id || null,
    question: redact(renderQuestion(extraction), nameContexts),
    situation: redact(summary, nameContexts),
    resolution: resolutionParts.join('. '),
    outcome: {
      disposition: terminal || null,
      recommendedDisposition: recommended || null,
      finalAction: finalAction || null,
      triageReasonCodes: triageNotes.map((n) => n.reason_code).filter(Boolean),
    },
    systems: [...new Set(systems)],
    occurredAt: call.created_at,
  };
}

/**
 * mapVisit({ record, findings, structuredRecommendations, aiSummary, context })
 *   → artifact | null
 *  record: service_records row (id, customer_id, service_date, service_type,
 *          technician_notes)
 *  findings: [{ category, severity, title, detail, recommendation }]
 *  structuredRecommendations: string[] from
 *          service_records.structured_notes.protocol.recommendations —
 *          ordinary completions store tech-entered recommendations there,
 *          not on findings rows
 *  aiSummary: service_report_ai_summaries.summary_json (optional)
 */
function mapVisit({ record, findings = [], structuredRecommendations = [], aiSummary = null, context = {} }) {
  const recommendations = [
    // Finding titles are free-form tech observations — redact them like any
    // other text; only the category label is a controlled value.
    ...findings
      .filter((f) => clean(f.recommendation))
      .map((f) => `${redact(f.title, context) || clean(f.category)}: ${redact(f.recommendation, context)}`),
    ...(Array.isArray(structuredRecommendations) ? structuredRecommendations : [])
      .map((r) => redact(r, context))
      .filter(Boolean),
  ];
  if (!recommendations.length) return null; // no reusable recommendation — skip

  const situationParts = [];
  for (const f of findings) {
    if (clean(f.detail)) situationParts.push(`${clean(f.category)}${f.severity ? ` (${f.severity})` : ''}: ${redact(f.detail, context)}`);
  }
  if (clean(record.technician_notes)) situationParts.push(redact(record.technician_notes, context));
  const summaryText = clean(aiSummary && typeof aiSummary === 'object' ? aiSummary.summary || aiSummary.narrative : '');
  if (summaryText) situationParts.push(redact(summaryText, context));

  const serviceType = clean(record.service_type).replace(/_/g, ' ') || 'service';
  return {
    source: 'visit',
    sourceId: record.id,
    customerId: record.customer_id || null,
    question: `${serviceType} visit — findings and recommendations`,
    situation: situationParts.join('\n') || null,
    resolution: recommendations.join('\n'),
    outcome: {
      findingCategories: [...new Set(findings.map((f) => clean(f.category)).filter(Boolean))],
      maxSeverity: maxSeverityOf(findings),
    },
    systems: [...new Set([serviceType, ...findings.map((f) => clean(f.category))].filter(Boolean))],
    occurredAt: record.service_date || record.created_at,
  };
}

module.exports = { mapCall, mapVisit, renderQuestion, DISPOSITION_TEXT };
