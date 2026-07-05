/**
 * Pest Visit Summary — narrative enrichment (env-gated, additive).
 *
 * The legacy Visit Summary paragraph is the completion recap: generated from
 * the technician's chips + notes at completion time and frozen. It never sees
 * the data the rest of the report is built from. This layer mirrors the Lawn
 * Report V2 narrative pattern for the PEST report's summary: deterministic
 * grounding facts decide WHAT can be said — the stored recap (the tech's
 * message), the Pest Pressure trend the report already computed, the visit's
 * customer-visible findings, and the next same-line appointment — and the
 * VOICE model rewrites only the PROSE. Output is run through the shared
 * banned-copy guard; any miss falls back to the deterministic summary (recap
 * + a plain next-visit sentence), so the report is always safe and complete
 * even if the model is unavailable.
 *
 * Generation is keyed by a hash of the grounding facts, so the same visit
 * yields the same copy across re-views (report tokens are permanent), while a
 * reschedule or new pressure score produces fresh copy. Process-local cache,
 * same posture as lawn-report-narrative.
 */

const crypto = require('crypto');
const MODELS = require('../../config/models');
const logger = require('../logger');
const { callAnthropic } = require('../llm/call');
const { findBannedCustomerCopy } = require('./activity-indicators');

const PROMPT_VERSION = 'pest_visit_summary_narrative_v1';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const _cache = new Map();

// The prompt bans more words than the shared customer-copy guard covers
// (findBannedCustomerCopy catches "no infestation" but not bare
// "infestation"). Prompt rules must be ENFORCED, not just requested — same
// vocabulary as ai-summary.js FORBIDDEN_PATTERNS. \bsafe\b deliberately
// leaves "safety" alone.
const EXTRA_FORBIDDEN = [
  /\binfestations?\b/i,
  /\bdangerous\b/i,
  /\btoxic\b/i,
  /\bpoison(?:ous)?\b/i,
  /\bsafe\b/i,
];

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

// "Thursday, October 2" — date-only string formatted at UTC noon so the ET
// calendar day can't shift (same trick the report client uses).
function formatNextVisitDate(scheduledDate) {
  const raw = String(scheduledDate || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  try {
    return new Date(`${raw}T12:00:00Z`).toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC',
    });
  } catch {
    return null;
  }
}

// "8–10 AM" / "1:30–3:30 PM" from window_start. The customer-facing arrival
// window is ALWAYS window_start + 2 hours (window_end is the internal job
// block — never show). Minutes carry through: the schedule grid supports
// half-hour starts, and "1–3 PM" for a 1:30 arrival is simply wrong.
function formatArrivalWindow(windowStart) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(windowStart || ''));
  if (!m) return null;
  const startH = Number(m[1]);
  const startMin = Number(m[2]);
  if (!Number.isFinite(startH) || startH > 23 || !Number.isFinite(startMin) || startMin > 59) return null;
  const endH = (startH + 2) % 24;
  const minutes = startMin ? `:${String(startMin).padStart(2, '0')}` : '';
  const label = (h) => {
    const twelve = h % 12 === 0 ? 12 : h % 12;
    return { twelve, meridiem: h < 12 ? 'AM' : 'PM' };
  };
  const s = label(startH);
  const e = label(endH);
  return s.meridiem === e.meridiem
    ? `${s.twelve}${minutes}–${e.twelve}${minutes} ${e.meridiem}`
    : `${s.twelve}${minutes} ${s.meridiem}–${e.twelve}${minutes} ${e.meridiem}`;
}

// Only the FACTS that should drive copy. The recap is included as grounding
// (it is the tech's own message) — the model reweaves it, never contradicts it.
function groundingFacts({
  recap,
  serviceTypeDisplay,
  areasServiced = [],
  pestPressure = null,
  findings = [],
  nextAppointment = null,
} = {}) {
  const pressure = pestPressure && pestPressure.enabled && pestPressure.displayScore != null
    ? {
      displayScore: pestPressure.displayScore,
      maxScore: pestPressure.maxScore || 5,
      label: cleanText(pestPressure.label) || null,
      trend: cleanText(pestPressure.trend) || null,
      trendDelta: pestPressure.trendDelta ?? null,
      summary: cleanText(pestPressure.summary) || null,
    }
    : null;
  const visibleFindings = (Array.isArray(findings) ? findings : [])
    .map((finding) => ({
      title: cleanText(finding.title),
      severity: cleanText(finding.severity) || null,
      recommendation: cleanText(finding.recommendation) || null,
    }))
    .filter((finding) => finding.title)
    .slice(0, 3);
  const nextVisit = nextAppointment && nextAppointment.scheduledDate
    ? {
      date: formatNextVisitDate(nextAppointment.scheduledDate),
      window: formatArrivalWindow(nextAppointment.windowStart),
    }
    : null;
  return {
    recap: cleanText(recap),
    serviceTypeDisplay: cleanText(serviceTypeDisplay) || 'pest control service',
    areasServiced: (Array.isArray(areasServiced) ? areasServiced : []).map(cleanText).filter(Boolean).slice(0, 10),
    pressure,
    findings: visibleFindings,
    nextVisit: nextVisit && nextVisit.date ? nextVisit : null,
  };
}

// The always-safe summary: the tech's recap plus a plain next-visit sentence.
// Used verbatim when the model is unavailable or its output fails the guard.
function deterministicSummary(facts) {
  const parts = [facts.recap];
  if (facts.nextVisit) {
    parts.push(facts.nextVisit.window
      ? `Your next visit is scheduled for ${facts.nextVisit.date}, arriving ${facts.nextVisit.window}.`
      : `Your next visit is scheduled for ${facts.nextVisit.date}.`);
  }
  return parts.filter(Boolean).join(' ');
}

const SYSTEM_PROMPT = `You rewrite the Visit Summary paragraph for a Waves Pest Control customer service report.

You are given grounding facts: the technician's recap message, the service type, treated areas, the property's Pest Pressure reading (a 0-5 index where lower is better, with a trend vs. prior visits), customer-visible findings, and the next scheduled visit.

Rules:
- One friendly paragraph, 3 to 5 short sentences, plain language, no greeting, no headings, no markdown.
- The technician's recap is the source of truth for what happened — reweave it, never contradict it, never invent work that is not in the facts.
- If a Pest Pressure reading is provided, work its meaning in naturally (e.g. activity trending down since the last visit). Never invent a trend that is not in the facts.
- If findings are provided, you may reference at most one, briefly and calmly.
- If a next visit is provided, close with it, including the date (and arrival window if given).
- Never mention product names, chemical names, application rates, prices, or EPA details.
- Never say eliminated, guaranteed, pest-free, eradicated, infestation, toxic, poison, safe, or solved forever.
- Never blame the customer.

Return JSON: {"summary": "<the paragraph>"}`;

function buildUserMessage(facts) {
  return `Grounding facts:\n${JSON.stringify(facts, null, 2)}\n\nReturn only the JSON object.`;
}

/**
 * Returns the enriched Visit Summary string for a pest report, or the
 * deterministic fallback (recap + next-visit sentence). Never throws; never
 * returns an unguarded model string.
 */
async function applyVisitSummaryNarrative(input = {}, deps = {}) {
  const facts = groundingFacts(input);
  if (!facts.recap) return facts.recap; // nothing grounded to say — keep legacy behavior

  const fallback = deterministicSummary(facts);
  const cacheKey = crypto.createHash('sha256').update(`${PROMPT_VERSION}|${stableStringify(facts)}`).digest('hex');
  const hit = _cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  const callModel = deps.callModel
    || ((payload) => callAnthropic({ model: MODELS.VOICE, jsonMode: true, maxTokens: 400, ...payload }));

  let value = fallback;
  try {
    const res = await callModel({ system: SYSTEM_PROMPT, text: buildUserMessage(facts) });
    const text = cleanText(res && res.ok && res.json ? res.json.summary : '');
    if (text && text.length >= 40 && text.length <= 900) {
      const banned = [
        ...findBannedCustomerCopy(text),
        ...EXTRA_FORBIDDEN.map((rx) => text.match(rx)?.[0] || null).filter(Boolean),
      ];
      if (!banned.length) {
        value = text;
      } else {
        logger.warn(`[visit-summary] narrative hit banned copy (${banned.join(', ')}); using deterministic summary`);
      }
    } else if (res && !res.ok) {
      logger.warn(`[visit-summary] narrative miss (${res.reason}); using deterministic summary`);
    }
  } catch (err) {
    logger.warn(`[visit-summary] narrative failed: ${err.message}; using deterministic summary`);
  }

  _cache.set(cacheKey, { at: Date.now(), value });
  if (_cache.size > 300) _cache.delete(_cache.keys().next().value);
  return value;
}

module.exports = {
  applyVisitSummaryNarrative,
  // exported for tests
  _test: {
    groundingFacts,
    deterministicSummary,
    formatNextVisitDate,
    formatArrivalWindow,
    buildUserMessage,
    SYSTEM_PROMPT,
    PROMPT_VERSION,
    _cache,
  },
};
