/**
 * Declared lead timeline ("When do you want this handled?") — the visitor's
 * own answer on the marketing-site quote forms, shared by the two public
 * intake routes (POST /api/leads and POST /api/public/estimator/property-lookup).
 *
 * The declared value is persisted verbatim in extracted_data.timeline and
 * mapped onto leads.urgency (the column LeadsPage already badges and the AI
 * triage already writes). A declared timeline is the customer's word, so it
 * WINS over the triage's prose guess — the triage only sets urgency when no
 * timeline was declared (lead-webhook.js).
 */

// Canonical values, in priority order. The forms send these keys.
const TIMELINE_VALUES = ['now', 'this_week', 'this_month', 'browsing'];

// Form-friendly aliases → canonical. Anything else is ignored (null), never
// guessed: an unknown string must not become an urgency.
const TIMELINE_ALIASES = {
  now: 'now',
  asap: 'now',
  today: 'now',
  urgent: 'now',
  this_week: 'this_week',
  week: 'this_week',
  this_month: 'this_month',
  month: 'this_month',
  browsing: 'browsing',
  just_browsing: 'browsing',
  pricing: 'browsing',
  just_pricing: 'browsing',
};

// leads.urgency vocabulary — mirrors lead-triage.js ("urgent" | "high" |
// "normal" | "low") so the LeadsPage badge colours apply unchanged.
const URGENCY_FOR_TIMELINE = {
  now: 'urgent',
  this_week: 'high',
  this_month: 'normal',
  browsing: 'low',
};

function normalizeTimeline(raw) {
  if (raw === null || raw === undefined) return null;
  const key = String(raw).trim().toLowerCase().replace(/[\s-]+/g, '_');
  return TIMELINE_ALIASES[key] || null;
}

function urgencyForTimeline(timeline) {
  return URGENCY_FOR_TIMELINE[timeline] || null;
}

module.exports = { TIMELINE_VALUES, normalizeTimeline, urgencyForTimeline };
