/**
 * Rodent report — Visit Summary narrative (env-gated, additive).
 *
 * Typed rodent reports freeze the SMS-style completion recap into the Visit
 * Summary slot ("Today we completed your Rodent Trapping Service…") — the
 * summary never sees the data the rest of the report is built from. This
 * layer mirrors visit-summary-narrative.js for the RODENT report:
 * deterministic grounding facts decide WHAT can be said — the recap, the
 * typed snapshot's customer-labeled findings (species, traps checked), the
 * rodent activity reading, the trap/station check counts, the devices in
 * service, the visit's photo-evidence captions, and the next rodent-related
 * appointment — and the report-writer model composes only the PROSE. Output
 * runs through the same banned-copy screens as every other summary source;
 * any miss falls back to a deterministic summary assembled from the ratified
 * snapshot copy, so the report is always safe and complete even if the model
 * is unavailable.
 *
 * Product naming: rodent visits record mechanical traps and monitoring
 * devices alongside (sometimes) rodenticide baits. Only non-pesticide
 * hardware — no real EPA registration — may be named to the customer;
 * registered products pass through as generic context the model must never
 * name, same contract as the recap/report prompts.
 *
 * Trapping copy rule (STATION_CARD_PROGRAM_META): counts are stated
 * factually ("no captures recorded") — never absence or elimination claims.
 *
 * Generation is keyed by a hash of the grounding facts (report tokens are
 * permanent; same visit → same copy) with a process-local cache, same
 * posture as the pest narrative.
 */

const crypto = require('crypto');
const MODELS = require('../../config/models');
const logger = require('../logger');
const { dispatchWithFallback } = require('../llm/call');
const { findBannedCustomerCopy } = require('./activity-indicators');
const { validateCustomerCopy } = require('./premium-experience');
const {
  EXTRA_FORBIDDEN,
  formatNextVisitDate,
  formatArrivalWindow,
} = require('./visit-summary-narrative');

const PROMPT_VERSION = 'rodent_report_narrative_v1';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const _cache = new Map();

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

// A device is nameable to the customer only when it is plainly not a
// registered pesticide: no real EPA registration number. Rodenticide baits
// and any registered product stay generic context.
function isNameableDevice(product = {}) {
  const reg = cleanText(product.epa_reg);
  return !reg || /^n\/?a\.?$/i.test(reg) || /^none$/i.test(reg);
}

function deviceFacts(applications = []) {
  return (Array.isArray(applications) ? applications : [])
    .map((app) => {
      const product = app?.product || {};
      const name = cleanText(product.name).slice(0, 80);
      if (!name) return null;
      const nameable = isNameableDevice(product);
      return {
        // Registered products reach the model only as a generic category —
        // the name never enters the prompt, so it cannot leak into copy.
        name: nameable ? name : null,
        category: cleanText(product.category) || 'rodent control product',
        summary: nameable ? cleanText(product.service_report_summary).slice(0, 200) || null : null,
        nameable,
      };
    })
    .filter(Boolean)
    .slice(0, 8);
}

function findingFacts(typedReport = {}) {
  return (Array.isArray(typedReport?.findings) ? typedReport.findings : [])
    .map((item) => ({
      label: cleanText(item.customerLabel || item.technicianLabel),
      value: cleanText(item.customerValueLabel != null && item.customerValueLabel !== ''
        ? item.customerValueLabel
        : item.value),
    }))
    .filter((item) => item.label && item.value)
    .slice(0, 8);
}

function activityFacts(activity = null) {
  if (!activity || activity.score == null) return null;
  return {
    label: cleanText(activity.label) || 'Rodent Activity',
    levelWord: cleanText(activity.levelWord) || null,
    score: activity.score,
    maxScore: activity.maxScore || 5,
    lowerIsBetter: true,
    isBaseline: !!activity.isBaseline,
    trendWord: cleanText(activity.trendWord) || null,
  };
}

function stationFacts(stationSummary = null) {
  if (!stationSummary || !stationSummary.total) return null;
  return {
    total: stationSummary.total,
    checked: stationSummary.checked || 0,
    capturesRecorded: stationSummary.activity || 0,
    serviced: stationSummary.serviced || 0,
    inaccessible: stationSummary.inaccessible || 0,
  };
}

function photoFacts(photos = []) {
  return (Array.isArray(photos) ? photos : [])
    .map((photo) => cleanText(photo?.caption).slice(0, 240))
    .filter(Boolean)
    .slice(0, 3);
}

function groundingFacts({
  recap,
  serviceTypeDisplay,
  typedReport = null,
  activity = null,
  stationSummary = null,
  applications = [],
  photos = [],
  nextAppointment = null,
} = {}) {
  const nextVisit = nextAppointment && nextAppointment.scheduledDate
    ? {
      date: formatNextVisitDate(nextAppointment.scheduledDate),
      window: formatArrivalWindow(nextAppointment.windowStart),
      serviceType: cleanText(nextAppointment.serviceType) || null,
    }
    : null;
  return {
    recap: cleanText(recap),
    serviceTypeDisplay: cleanText(serviceTypeDisplay) || 'rodent service',
    todaysResult: typedReport?.todaysResult
      ? {
        headline: cleanText(typedReport.todaysResult.headline) || null,
        body: cleanText(typedReport.todaysResult.body) || null,
        nextStep: cleanText(typedReport.todaysResult.nextStep) || null,
      }
      : null,
    findings: findingFacts(typedReport),
    activity: activityFacts(activity),
    stations: stationFacts(stationSummary),
    devices: deviceFacts(applications),
    photoEvidence: photoFacts(photos),
    nextVisit: nextVisit && nextVisit.date ? nextVisit : null,
  };
}

// The always-safe summary, assembled only from copy that already passed a
// ratified path: the snapshot's Today's Result (or the recap), the factual
// station counts, and a plain next-visit sentence.
function deterministicSummary(facts) {
  const parts = [];
  if (facts.todaysResult?.headline) parts.push(facts.todaysResult.headline);
  if (facts.todaysResult?.body) {
    parts.push(facts.todaysResult.body);
  } else if (facts.recap) {
    parts.push(facts.recap);
  }
  if (facts.stations && facts.stations.checked > 0) {
    parts.push(`${facts.stations.checked} of ${facts.stations.total} trap${facts.stations.total === 1 ? '' : 's'} were inspected, with ${facts.stations.capturesRecorded === 0 ? 'no captures recorded' : `${facts.stations.capturesRecorded} capture${facts.stations.capturesRecorded === 1 ? '' : 's'} recorded`}.`);
  }
  if (facts.photoEvidence.length) {
    parts.push('Photos from this visit are included with this report.');
  }
  if (facts.nextVisit) {
    parts.push(facts.nextVisit.window
      ? `Your next visit is scheduled for ${facts.nextVisit.date}, arriving ${facts.nextVisit.window}.`
      : `Your next visit is scheduled for ${facts.nextVisit.date}.`);
  }
  return parts.filter(Boolean).join(' ');
}

const SYSTEM_PROMPT = `You write the Visit Summary for a Waves Pest Control rodent service report.

You are given grounding facts: the technician's recap message, the report's ratified result copy, customer-labeled findings (species, traps checked), the property's rodent activity reading (a 0-5 index where lower is better), trap/station check counts, the devices and products in service, captions of photo evidence the technician documented, and the next scheduled rodent visit.

Rules:
- 4 to 7 short sentences in one or two short paragraphs. Plain, calm, professional language. No greeting, no headings, no markdown, no bullet lists.
- Facts only: never invent work, counts, captures, sightings, or evidence that is not in the facts. Never contradict the recap or ratified result copy.
- State numbers factually (traps checked, captures recorded). A count of zero is stated as "no captures were recorded" — never as proof rodents are gone or the issue is resolved.
- Devices with a name in the facts (mechanical traps, monitoring devices) may be named. Products with a null name must only be described by their generic category — never guess or reconstruct a product name, and never mention chemicals, active ingredients, application rates, prices, or EPA details.
- If photo evidence captions are provided, briefly and calmly reference what was documented (for example, droppings observed in the attic) — it shows the customer what the service is tracking.
- If an activity reading is provided, work its meaning in naturally; when it is marked as a baseline, say this visit sets the baseline future visits will measure against.
- If a next visit is provided, close with it, including the date (and arrival window if given).
- Never say eliminated, guaranteed, pest-free, eradicated, infestation, toxic, poison, safe, or solved forever. Never blame the customer.

Return JSON: {"summary": "<the summary>"}`;

function buildUserMessage(facts) {
  return `Grounding facts:\n${JSON.stringify(facts, null, 2)}\n\nReturn only the JSON object.`;
}

// True when the copy echoes a product name the facts withheld (registered
// products) — prompt rules are enforced, not just requested. Token match on
// 4+ letter name parts, same posture as completion-recap's guard.
function echoesWithheldName(text, applications = []) {
  const hay = String(text || '').toLowerCase();
  if (!hay) return false;
  return (Array.isArray(applications) ? applications : [])
    .filter((app) => !isNameableDevice(app?.product || {}))
    .some((app) => cleanText(app?.product?.name)
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 4)
      .some((token) => hay.includes(token)));
}

/**
 * Returns the detailed Visit Summary string for a rodent typed report, or
 * the deterministic fallback. Never throws; never returns unguarded model
 * copy.
 */
async function applyRodentReportNarrative(input = {}, deps = {}) {
  const facts = groundingFacts(input);
  if (!facts.recap && !facts.todaysResult) return cleanText(input.recap);

  const fallback = deterministicSummary(facts);
  const cacheKey = crypto.createHash('sha256').update(`${PROMPT_VERSION}|${stableStringify(facts)}`).digest('hex');
  const hit = _cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  // Report prose rides the report-writer policy (Sol → Opus), same as the
  // tech-facing "Generate AI report" endpoint this summary mirrors.
  const callModel = deps.callModel
    || ((payload) => dispatchWithFallback(
      MODELS.TEXT_POLICIES.report,
      { jsonMode: true, maxTokens: 700, ...payload },
    ));

  let value = fallback;
  try {
    const res = await callModel({ system: SYSTEM_PROMPT, text: buildUserMessage(facts) });
    const text = cleanText(res && res.ok && res.json ? res.json.summary : '');
    if (text && text.length >= 80 && text.length <= 1400) {
      const banned = [
        ...findBannedCustomerCopy(text),
        ...EXTRA_FORBIDDEN.map((rx) => text.match(rx)?.[0] || null).filter(Boolean),
      ];
      if (!banned.length && !validateCustomerCopy(text)) banned.push('forbidden_language');
      if (echoesWithheldName(text, input.applications)) banned.push('withheld_product_name');
      if (!banned.length) {
        value = text;
      } else {
        logger.warn(`[rodent-narrative] output hit guard (${banned.join(', ')}); using deterministic summary`);
      }
    } else if (res && !res.ok) {
      logger.warn(`[rodent-narrative] miss (${res.reason}); using deterministic summary`);
    }
  } catch (err) {
    logger.warn(`[rodent-narrative] failed: ${err.message}; using deterministic summary`);
  }

  _cache.set(cacheKey, { at: Date.now(), value });
  if (_cache.size > 300) _cache.delete(_cache.keys().next().value);
  return value;
}

module.exports = {
  applyRodentReportNarrative,
  // exported for tests
  _test: {
    groundingFacts,
    deterministicSummary,
    deviceFacts,
    isNameableDevice,
    echoesWithheldName,
    buildUserMessage,
    SYSTEM_PROMPT,
    PROMPT_VERSION,
    _cache,
  },
};
