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

// A device is nameable to the customer only when it FAILS CLOSED into the
// hardware bucket: no real EPA registration number AND an explicit device
// signal in the recorded facts (mechanical trap / monitoring device / "no
// pesticide" report copy). A missing or N/A EPA field alone proves nothing —
// legacy rows and EPA-exempt (25(b)) pesticides also look like that, and an
// unknown product must stay generic (codex P2 #3004).
const DEVICE_SIGNAL_RE = /\b(mechanical|snap\s*trap|live\s*trap|glue\s*(board|trap)|monitor(?:ing)?\s*(device|station|trap)|no\s+pesticide|contains\s+no\s+pesticide)\b/i;

function isNameableDevice(product = {}) {
  const reg = cleanText(product.epa_reg);
  const hasRealReg = reg && !/^n\/?a\.?$/i.test(reg) && !/^none$/i.test(reg);
  if (hasRealReg) return false;
  const signal = [
    product.active_ingredient,
    product.category,
    product.product_type,
    product.service_report_summary,
    product.precaution_summary,
  ].map(cleanText).join(' ');
  return DEVICE_SIGNAL_RE.test(signal);
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

// summary.activity is the count of STATIONS/TRAPS carrying the program's
// activity status this visit — traps with a capture recorded (trapping) or
// bait stations with consumption observed (rodent bait). It is NOT a total
// capture count (one trap can hold more than one capture — codex P1 #3004),
// so the fact names say exactly what the number is and the actual capture
// count, when recorded, arrives via the typed findings.
function stationFacts(stationSummary = null, program = null) {
  if (!stationSummary || !stationSummary.total) return null;
  const base = {
    program: program || null,
    total: stationSummary.total,
    checked: stationSummary.checked || 0,
    serviced: stationSummary.serviced || 0,
    inaccessible: stationSummary.inaccessible || 0,
  };
  if (program === 'trapping') {
    return { ...base, trapsWithCaptureRecorded: stationSummary.activity || 0 };
  }
  if (program === 'rodent') {
    return { ...base, stationsWithBaitConsumption: stationSummary.activity || 0 };
  }
  return { ...base, stationsWithActivity: stationSummary.activity || 0 };
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
  stationProgram = null,
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
    stations: stationFacts(stationSummary, stationProgram),
    devices: deviceFacts(applications),
    photoEvidence: photoFacts(photos),
    // The tech-reviewed consolidated photo analysis, when present — richer
    // grounding than the per-photo captions alone.
    photoSummary: cleanText(typedReport?.photoSummary).slice(0, 400) || null,
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
    const s = facts.stations;
    if (s.program === 'trapping') {
      const clause = s.trapsWithCaptureRecorded === 0
        ? 'no captures recorded'
        : `a capture recorded at ${s.trapsWithCaptureRecorded} trap${s.trapsWithCaptureRecorded === 1 ? '' : 's'}`;
      parts.push(`${s.checked} of ${s.total} trap${s.total === 1 ? '' : 's'} were inspected, with ${clause}.`);
    } else if (s.program === 'rodent') {
      const clause = s.stationsWithBaitConsumption === 0
        ? 'no bait consumption observed'
        : `bait consumption observed at ${s.stationsWithBaitConsumption} station${s.stationsWithBaitConsumption === 1 ? '' : 's'}`;
      parts.push(`${s.checked} of ${s.total} bait station${s.total === 1 ? '' : 's'} were inspected, with ${clause}.`);
    } else {
      parts.push(`${s.checked} of ${s.total} station${s.total === 1 ? '' : 's'} were inspected.`);
    }
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

You are given grounding facts: the technician's recap message, the report's ratified result copy, customer-labeled findings (species, traps checked), the property's rodent activity reading (a 0-5 index where lower is better), trap/station check counts, the devices and products in service, photo evidence the technician documented (captions and, when present, a reviewed photo summary), and the next scheduled rodent visit.

Rules:
- 4 to 7 short sentences in one or two short paragraphs. Plain, calm, professional language. No greeting, no headings, no markdown, no bullet lists.
- Facts only: never invent work, counts, captures, sightings, or evidence that is not in the facts. Never contradict the recap or ratified result copy.
- Write every count as a numeral, exactly as it appears in the facts. Never introduce a number that is not in the facts.
- Station counts count LOCATIONS with a status, not events: "trapsWithCaptureRecorded: 2" means a capture was recorded at 2 traps — never "2 captures". "stationsWithBaitConsumption" means that many stations showed bait consumption. Zero is stated as "no captures were recorded" / "no bait consumption was observed" — never as proof rodents are gone or the issue is resolved.
- Devices with a name in the facts (mechanical traps, monitoring devices) may be named. Products with a null name must only be described by their generic category — never guess or reconstruct a product name, and never mention chemicals, active ingredients, application rates, prices, or EPA details.
- If photo evidence is provided, briefly and calmly reference what was documented (for example, droppings observed in the attic) — it shows the customer what the service is tracking.
- If an activity reading is provided, work its meaning in naturally; when it is marked as a baseline, say this visit sets the baseline future visits will measure against.
- If a next visit is provided, close with it, including the date (and arrival window if given).
- Never say eliminated, guaranteed, pest-free, eradicated, infestation, toxic, poison, safe, or solved forever. Never blame the customer.

Return JSON: {"summary": "<the summary>"}`;

function buildUserMessage(facts) {
  return `Grounding facts:\n${JSON.stringify(facts, null, 2)}\n\nReturn only the JSON object.`;
}

// ---------------------------------------------------------------------------
// Fail-closed grounding validator (codex P1 #3004): the prompt's facts-only
// contract is ENFORCED, not just requested. Every numeral in the model's
// output must already appear somewhere in the grounding facts — a fluent
// summary that changes a trap count, invents "2 captures", or adds a made-up
// figure falls back to the deterministic copy. The prompt requires counts as
// numerals, so word-form numbers ("seven") can't smuggle counts past this;
// they'd have to match the facts' own prose to survive the ban below.
// ---------------------------------------------------------------------------
function numberTokens(text) {
  return String(text || '').match(/\d+(?:[:.,]\d+)*/g) || [];
}

// Word-form numbers are normalized to numerals BEFORE validation so "five
// traps" can't route around the numeral checks (codex round-2 P1). "one" is
// included deliberately — the partitive filter below keeps "one of the
// traps" from tripping the count check.
const WORD_NUMBER_RE = /\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\b/gi;
const WORD_NUMBER_VALUES = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20,
};

function normalizeWordNumbers(text) {
  return String(text || '').replace(WORD_NUMBER_RE, (word) => String(WORD_NUMBER_VALUES[word.toLowerCase()]));
}

function collectNumbers(set, value) {
  if (value == null) return;
  if (typeof value === 'object') {
    (Array.isArray(value) ? value : Object.values(value)).forEach((v) => collectNumbers(set, v));
    return;
  }
  numberTokens(value).forEach((token) => {
    set.add(token);
    token.split(/[:.,]/).forEach((part) => {
      set.add(part);
      set.add(String(Number(part)));
    });
  });
}

function groundedNumberSet(facts) {
  const set = new Set();
  collectNumbers(set, facts);
  return set;
}

// Numbers that may legitimately count traps/stations/devices: the station
// facts themselves plus numeric typed-finding values ("Traps checked: 7").
// Empty when nothing grounds a count — any count claim then fails closed.
function stationCountSet(facts) {
  const set = new Set();
  Object.values(facts.stations || {}).forEach((value) => {
    if (typeof value === 'number') set.add(value);
  });
  (facts.findings || []).forEach((finding) => {
    const n = Number(String(finding.value).trim());
    if (Number.isFinite(n)) set.add(n);
  });
  return set;
}

// "N traps" / "N of M stations" / "N captures" claims validated against the
// facts they describe, not the global number pool — with 7 traps and a 0-5
// activity scale, "we checked 5 traps" must NOT pass just because 5 exists
// somewhere in the facts (codex round-2 P1). Runs on word-number-normalized
// text so "five traps" is checked too; partitive phrasing without a count
// ("one of the traps") is exempt via the filler check.
const COUNT_NOUN_RE = /\b(\d+)(?:\s+(?:of|out\s+of)\s+(\d+))?((?:\s+[a-z-]+){0,2}?)\s+(traps?|stations?|devices?|captures?)\b/gi;

function contextualCountProblems(text, facts) {
  const problems = [];
  const allowed = stationCountSet(facts);
  const re = new RegExp(COUNT_NOUN_RE.source, 'gi');
  let match;
  while ((match = re.exec(text)) !== null) {
    const [, first, second, filler] = match;
    if (/\bof\b/i.test(filler || '')) continue; // "1 of the traps" — no count claimed
    for (const raw of [first, second]) {
      if (raw == null) continue;
      if (!allowed.has(Number(raw))) problems.push(`uncorroborated_count:${match[0].trim()}`);
    }
  }
  return problems;
}

// Returns the list of ungrounded claims found in the text (empty = clean).
// The global numeral check runs on the RAW text (a word-form "one" in
// harmless prose must not be flagged as an ungrounded numeral); the
// count-noun check runs on word-number-normalized text so spelled-out
// counts can't route around it.
function ungroundedClaims(rawText, facts) {
  const problems = [];
  const text = String(rawText || '');
  const allowed = groundedNumberSet(facts);
  for (const token of numberTokens(text)) {
    const grounded = allowed.has(token)
      || allowed.has(String(Number(token)))
      || token.split(/[:.,]/).every((part) => allowed.has(part) || allowed.has(String(Number(part))));
    if (!grounded) problems.push(`ungrounded_number:${token}`);
  }
  problems.push(...contextualCountProblems(normalizeWordNumbers(text), facts));
  // Capture/consumption claims must not appear positively when the facts
  // record none of that activity ("we removed a capture" with zero traps
  // flagged). Negated forms ("no captures were recorded") are fine.
  const negated = (noun) => new RegExp(`\\b(no|without|zero)\\b[^.!?]{0,40}\\b${noun}`, 'i');
  const stations = facts.stations || {};
  if (!((stations.trapsWithCaptureRecorded || 0) > 0) && /\bcaptur/i.test(text) && !negated('captur').test(text)) {
    problems.push('unsupported_capture_claim');
  }
  if (!((stations.stationsWithBaitConsumption || 0) > 0) && /\bconsum/i.test(text) && !negated('consum').test(text)) {
    problems.push('unsupported_consumption_claim');
  }
  return problems;
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
      banned.push(...ungroundedClaims(text, facts));
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
    ungroundedClaims,
    buildUserMessage,
    SYSTEM_PROMPT,
    PROMPT_VERSION,
    _cache,
  },
};
