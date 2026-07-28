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

// v2: the narrative covers EVERY typed specialty report (cockroach, bed
// bug, termite bait, rodent… on the V1 report surface; WDO renders on the
// project-report surface and is out of scope) — the prompt generalized from rodent-
// only wording (owner ask 2026-07-27, second lane). File name kept (no
// renames); rodent remains a thin alias over the same engine.
const PROMPT_VERSION = 'typed_report_narrative_v2';
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
        // Service-neutral fallback: this engine serves every typed line
        // now, and the catalog category is nullable — a cockroach or
        // termite report must never describe its product as rodent
        // control (codex P2 #3007).
        category: cleanText(product.category) || 'treatment product',
        summary: nameable ? cleanText(product.service_report_summary).slice(0, 200) || null : null,
        nameable,
      };
    })
    .filter(Boolean)
    .slice(0, 8);
}

// Chemical/compliance fields (termite products_used, EPA registration,
// percent solution…) never reach the prompt or grounding corpus — the
// system prompt withholds product names/rates/EPA details, and a manually
// entered legacy product value wouldn't match the applications-based echo
// guard (codex P2 #3007 r6). The typed card still renders these on the
// report itself.
const CHEMICAL_FINDING_LABEL_RE = /\b(products?|epa|registration|percent|solution|active\s+ingredients?|rates?|concentration|chemicals?)\b/i;

function findingFacts(typedReport = {}) {
  return (Array.isArray(typedReport?.findings) ? typedReport.findings : [])
    .filter((item) => !CHEMICAL_FINDING_LABEL_RE.test(String(item.customerLabel || item.technicianLabel || ''))
      && !CHEMICAL_FINDING_LABEL_RE.test(String(item.fieldKey || '').replace(/_/g, ' ')))
    .map((item) => ({
      label: cleanText(item.customerLabel || item.technicianLabel),
      value: cleanText(item.customerValueLabel != null && item.customerValueLabel !== ''
        ? item.customerValueLabel
        : item.value),
    }))
    .filter((item) => item.label && item.value)
    // WDO and other long typed schemas carry their core inspection fields
    // (live activity, evidence, damage, treatment) well past slot 8 — a
    // tight positional cap fed the narrative only administrative metadata
    // (codex P2 #3007 r4). 24 covers every current schema with prompt room
    // to spare.
    .slice(0, 24);
}

// Words only — the raw score/maxScore NEVER enter the facts. The customer-
// copy contract (activity-indicators.js) forbids the numeric score in
// customer copy, and the ActivityCard deliberately leads with wording; a
// model fed "3 out of 5" will echo it (codex round-5 P2).
function activityFacts(activity = null) {
  if (!activity || activity.score == null) return null;
  return {
    label: cleanText(activity.label) || 'Rodent Activity',
    levelWord: cleanText(activity.levelWord) || null,
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
  reportTypeLabel = null,
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
    serviceTypeDisplay: cleanText(serviceTypeDisplay) || 'service visit',
    reportTypeLabel: cleanText(reportTypeLabel || typedReport?.reportTypeLabel || typedReport?.typeLabel) || null,
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

// The typed snapshot's own activity record ("Captures: 2", "Bait
// consumption: Moderate"), when the tech recorded one — the only source
// that may ground a positive total or a zero claim. `positive` is null
// when no finding exists, true for a positive count or non-"none" text,
// false for 0/none.
function typedActivityState(facts, labelRe) {
  const finding = (facts.findings || []).find((item) => labelRe.test(item.label));
  if (!finding) return { present: false, count: null, positive: null };
  const raw = String(finding.value).trim();
  const n = Number(raw);
  if (Number.isFinite(n)) return { present: true, count: n, positive: n > 0 };
  return { present: true, count: null, positive: !/^(none|no\b|n\/a)/i.test(raw) };
}

function typedCaptureCount(facts) {
  const state = typedActivityState(facts, /captur/i);
  return state.count;
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
      // Capture wording is sourced from the records that actually carry it:
      // pins flagged on the map ground "at N traps"; otherwise the typed
      // Captures finding grounds a total or the zero claim. Zero is NEVER
      // inferred from map statuses alone — a positive typed capture count
      // with no flagged pin is a permitted state (trapCaptureConflict only
      // rejects the reverse), and claiming "no captures" against it would
      // contradict the ratified Today's Result (codex round-3 P1).
      const typedCaptures = typedActivityState(facts, /captur/i);
      let clause = null;
      if (s.trapsWithCaptureRecorded > 0) {
        clause = `a capture recorded at ${s.trapsWithCaptureRecorded} trap${s.trapsWithCaptureRecorded === 1 ? '' : 's'}`;
      } else if (typedCaptures.count > 0) {
        clause = `${typedCaptures.count} capture${typedCaptures.count === 1 ? '' : 's'} recorded`;
      } else if (typedCaptures.positive === true) {
        clause = 'captures recorded'; // typed positive without a count
      } else if (typedCaptures.positive === false) {
        clause = 'no captures recorded';
      }
      parts.push(`${s.checked} of ${s.total} trap${s.total === 1 ? '' : 's'} were inspected${clause ? `, with ${clause}` : ''}.`);
    } else if (s.program === 'rodent') {
      // Same sourcing rule as captures (codex round-7 P1, mirroring the
      // round-3 trapping fix): a zero-consumption claim is grounded only in
      // the typed bait-consumption finding — a positive typed record with
      // no activity-status pin is a permitted state
      // (rodentConsumptionConflict rejects only the inverse), so pin
      // statuses alone never produce "no bait consumption observed".
      const typedConsumption = typedActivityState(facts, /consum/i);
      let clause = null;
      if (s.stationsWithBaitConsumption > 0) {
        clause = `bait consumption observed at ${s.stationsWithBaitConsumption} station${s.stationsWithBaitConsumption === 1 ? '' : 's'}`;
      } else if (typedConsumption.positive === true) {
        clause = 'bait consumption observed';
      } else if (typedConsumption.positive === false) {
        clause = 'no bait consumption observed';
      }
      parts.push(`${s.checked} of ${s.total} bait station${s.total === 1 ? '' : 's'} were inspected${clause ? `, with ${clause}` : ''}.`);
    } else {
      // Generic station programs (termite bait): a positive activity-status
      // count is map-recorded fact and renders; zero adds no claim (the
      // typed report's ratified copy owns absence wording — codex P2 #3007).
      const activityClause = s.stationsWithActivity > 0
        ? `, with activity observed at ${s.stationsWithActivity} station${s.stationsWithActivity === 1 ? '' : 's'}`
        : '';
      parts.push(`${s.checked} of ${s.total} station${s.total === 1 ? '' : 's'} were inspected${activityClause}.`);
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

const SYSTEM_PROMPT = `You write the Visit Summary for a Waves Pest Control & Lawn Care service report.

You are given grounding facts: the technician's recap message, the report type, the report's ratified result copy, customer-labeled findings (target pest, areas noted, work completed), the property's activity reading (a WORDING-based level — never express activity as a number, score, or ratio), trap/bait-station check counts when the program uses them, the devices and products in service, photo evidence the technician documented (captions and, when present, a reviewed photo summary), and the next scheduled visit.

Rules:
- 4 to 7 short sentences in one or two short paragraphs. Plain, calm, professional language. No greeting, no headings, no markdown, no bullet lists.
- Facts only: never invent work, counts, captures, sightings, locations, or evidence that is not in the facts. Never contradict the recap or ratified result copy.
- When the findings tag specific pests (e.g. German cockroaches, roof rats, subterranean termites), name the main one(s) in plain language — never a pest that is not tagged.
- Write every count as a numeral, exactly as it appears in the facts. Never introduce a number that is not in the facts.
- Station counts count LOCATIONS with a status, not events: "trapsWithCaptureRecorded: 2" means a capture was recorded at 2 traps — never "2 captures". "stationsWithBaitConsumption" means that many stations showed bait consumption. Zero is stated as "no captures were recorded" / "no bait consumption was observed" — never as proof the pests are gone or the issue is resolved.
- When a capture or bait consumption IS recorded, state it ONLY in the grounded generic form ("a capture was recorded at 2 traps", "bait consumption was observed at 1 station") — never invent species, rooms, or other details the facts do not carry.
- Devices with a name in the facts (mechanical traps, monitoring devices) may be named. Products with a null name must only be described by their generic category — never guess or reconstruct a product name, and never mention chemicals, active ingredients, application rates, prices, or EPA details.
- If photo evidence is provided, briefly and calmly reference what was documented — it shows the customer what the service is tracking.
- If an activity reading is provided, work its meaning in naturally; when it is marked as a baseline, say this visit sets the baseline future visits will measure against.
- If the ratified result copy recommends a follow-up window or care instructions, carry them faithfully — never change the timing or drop the instruction.
- If a next visit is provided, close with it, copying the date and arrival window EXACTLY as given in the facts — never restate, recompute, or reformat them.
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
const WORD_NUMBER_RE = /\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand)\b/gi;
const WORD_NUMBER_VALUES = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
  seventy: 70, eighty: 80, ninety: 90, hundred: 100, thousand: 1000,
};

function normalizeWordNumbers(text) {
  return String(text || '')
    .replace(WORD_NUMBER_RE, (word) => String(WORD_NUMBER_VALUES[word.toLowerCase()]))
    // recombine compound word-numbers the word pass split — hyphenated
    // ("twenty-one" → "20-1") AND space-separated ("twenty one" → "20 1")
    // — so they can't slip a smaller grounded digit past the count
    // validators (codex P2 r3 + P1 r8)
    .replace(/\b(\d+)[-\s](\d)\b/g, (full, tens, ones) => (Number(tens) >= 20 && Number(tens) % 10 === 0
      ? String(Number(tens) + Number(ones))
      : full));
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

// Per-role fact mapping (codex round-3/round-4 P1): every count claim
// validates against the fact it DESCRIBES — checked can't corroborate a
// roster claim, inaccessible can't corroborate an inspected claim,
// trapsWithCaptureRecorded can't corroborate "2 traps were inspected", and
// the roster size can't corroborate "7 captures were recorded". Shared
// pools would let the model swap customer-facing facts.
function factNumbers(facts) {
  const s = facts.stations || {};
  const roleSet = (value) => new Set(typeof value === 'number' ? [value] : []);
  const total = roleSet(s.total);
  const checked = roleSet(s.checked);
  const serviced = roleSet(s.serviced);
  const inaccessible = roleSet(s.inaccessible);
  const capturesAt = roleSet(s.trapsWithCaptureRecorded); // "a capture recorded at N traps"
  const consumptionAt = roleSet(s.stationsWithBaitConsumption); // "consumption observed at N stations"
  const activityAt = roleSet(s.stationsWithActivity); // "activity observed at N stations" (termite bait)
  const captureTotals = new Set(); // "N captures" — only a typed finding grounds this
  // Typed station findings route to their ROLE, never the roster pool —
  // "Stations with activity: 2" must not let "2 stations on the property"
  // pass as a roster claim (codex P1 #3007 r5).
  (facts.findings || []).forEach((finding) => {
    const n = Number(String(finding.value).trim());
    if (!Number.isFinite(n)) return;
    const label = String(finding.label);
    if (/captur/i.test(label)) captureTotals.add(n);
    else if (/consum/i.test(label)) consumptionAt.add(n);
    else if (/activit/i.test(label)) activityAt.add(n);
    else if (/inaccess/i.test(label)) inaccessible.add(n);
    else if (/servic/i.test(label)) serviced.add(n);
    else if (/check|inspect/i.test(label)) checked.add(n);
    else if (/trap|station|device|total/i.test(label)) total.add(n);
  });
  return { total, checked, serviced, inaccessible, capturesAt, consumptionAt, activityAt, captureTotals };
}

// "N traps" / "N of M stations" claims validated per noun, role, and
// context — with 7 total, 5 checked, 2 inaccessible, "2 traps were
// inspected" must fail even though 2 is a real (inaccessible) count. Runs
// on word-number-normalized text so "five traps" is checked too; partitive
// phrasing without a count ("one of the traps") is exempt via the filler
// check.
const PLACE_NOUN_RE = /\b(\d+)(?:\s+(?:of|out\s+of)\s+(\d+))?((?:\s+[a-z-]+){0,2}?)\s+(traps?|stations?|devices?)\b/gi;
const CAPTURE_COUNT_RE = /\b(\d+)\s+captures?\b/gi;

function contextualCountProblems(text, facts) {
  const problems = [];
  const roles = factNumbers(facts);
  const placeRe = new RegExp(PLACE_NOUN_RE.source, 'gi');
  let match;
  while ((match = placeRe.exec(text)) !== null) {
    const [full, first, second, filler] = match;
    if (/\bof\b/i.test(filler || '')) continue; // "1 of the traps" — no count claimed
    // The surrounding context decides WHICH fact this count claims: capture
    // and consumption cues sit BEFORE the number ("a capture recorded at 2
    // traps"); role verbs bind tighter when they TRAIL the noun ("2 traps
    // were not accessible" must not inherit an "inspected" from the
    // previous clause), so the trailing window is consulted first.
    const lead = text.slice(Math.max(0, match.index - 30), match.index);
    const trail = text.slice(match.index + full.length, match.index + full.length + 30);
    const roleFrom = (str) => {
      if (/inspect|check/i.test(str)) return roles.checked;
      if (/servic/i.test(str)) return roles.serviced;
      if (/access/i.test(str)) return roles.inaccessible;
      return null;
    };
    let allowed;
    if (/captur/i.test(lead)) allowed = roles.capturesAt;
    else if (/consum/i.test(lead)) allowed = roles.consumptionAt;
    // "termite activity was observed at 2 stations" — the activity-status
    // location count on termite bait maps (codex P2 #3007)
    else if (/activit/i.test(lead)) allowed = roles.activityAt;
    // bare roster claims ("your 7 traps") fall through to the roster size
    else allowed = roleFrom(trail) || roleFrom(lead) || roles.total;
    if (!allowed.has(Number(first))) problems.push(`uncorroborated_count:${full.trim()}`);
    // the "of M" half is always the roster size
    if (second != null && !roles.total.has(Number(second))) problems.push(`uncorroborated_count:${full.trim()}`);
  }
  const capRe = new RegExp(CAPTURE_COUNT_RE.source, 'gi');
  while ((match = capRe.exec(text)) !== null) {
    if (!roles.captureTotals.has(Number(match[1]))) problems.push(`uncorroborated_count:${match[0].trim()}`);
  }
  // Totality quantifiers claim counts without digits (codex round-7 P1):
  // "All traps were inspected" asserts checked === total, "both" asserts a
  // roster of exactly 2 — on a partially-checked roster these are false
  // and must not slip past the digit-anchored validator above. Quantified
  // mentions with no role verb ("all the traps around your home") claim
  // nothing and pass.
  const s = facts.stations || {};
  const totalityRe = /\b(all|both|every|each)\b(?:\s+of)?(?:\s+(?:the|your|our))?((?:\s+[a-z-]+){0,2}?)\s+(traps?|stations?|devices?)\b/gi;
  while ((match = totalityRe.exec(text)) !== null) {
    const quantifier = match[1].toLowerCase();
    const lead = text.slice(Math.max(0, match.index - 30), match.index);
    const trail = text.slice(match.index + match[0].length, match.index + match[0].length + 30);
    // VERB forms only — the bare noun "service" appears in harmless roster
    // references ("the service covers all of the traps") and must not read
    // as a serviced-count claim.
    const totalityRole = (str) => {
      if (/\binspect\w*|\bcheck\w*/i.test(str)) return s.checked;
      if (/\bservic(?:ed|ing)\b/i.test(str)) return s.serviced;
      if (/\baccess/i.test(str)) return s.inaccessible;
      return null;
    };
    const roleValue = totalityRole(trail) ?? totalityRole(lead);
    if (roleValue == null) continue; // no role claimed — roster reference only
    const ok = typeof s.total === 'number'
      && roleValue === s.total
      && (quantifier !== 'both' || s.total === 2);
    if (!ok) problems.push(`uncorroborated_totality:${match[0].trim()}`);
  }
  // Post-nominal totality (codex round-8 P1): "The traps were all
  // inspected" places the quantifier after the noun and dodges the
  // noun-first pattern above. Same role rules, verb required in the same
  // clause segment.
  const postNominalRe = /\b(traps?|stations?|devices?)\b[^.!?;,]{0,25}?\b(all|both|each|every)\b[^.!?;,]{0,25}?\b(inspect\w*|check\w*|servic(?:ed|ing)|access\w*)/gi;
  while ((match = postNominalRe.exec(text)) !== null) {
    const quantifier = match[2].toLowerCase();
    const verb = match[3];
    const roleValue = /^(inspect|check)/i.test(verb)
      ? s.checked
      : (/^servic/i.test(verb) ? s.serviced : s.inaccessible);
    const ok = typeof s.total === 'number'
      && roleValue === s.total
      && (quantifier !== 'both' || s.total === 2);
    if (!ok) problems.push(`uncorroborated_totality:${match[0].trim()}`);
  }
  return problems;
}

// Capture/consumption mentions are judged PER CLAIM (codex round-4 P1): the
// negation must sit in the claim's own clause — "No droppings were
// observed, but we removed a capture from the garage" is a positive capture
// claim regardless of the unrelated negative earlier in the sentence. A
// claim is negated when a negator appears within the ~30 chars before the
// token WITHOUT an intervening clause break (.,!?; or a contrastive
// conjunction), or when the token itself is followed by "not/never/none"
// ("captures were not recorded"). Positive claims are supported by capture
// locations on the map OR a positive typed capture finding.
function claimNegated(text, index, tokenLength) {
  let lead = text.slice(Math.max(0, index - 30), index);
  const breakMatch = [...lead.matchAll(/[.!?;]|\b(?:but|however|yet)\b/gi)].pop();
  if (breakMatch) lead = lead.slice(breakMatch.index + breakMatch[0].length);
  if (/\b(no|not|without|zero|none|never)\b/i.test(lead)) return true;
  const tail = text.slice(index + tokenLength, index + tokenLength + 25);
  return /^\S*\s+(?:were|was|are|is)?\s*(?:not|never|none)\b/i.test(tail);
}

// Synonym coverage (codex round-5 P1): "we caught a rat", "a rodent was
// removed", "bait was eaten" claim the same events without the captur/
// consum stems, so each family scans its equivalent wording. Removal only
// counts when a rodent noun sits nearby — "we removed debris" is not a
// capture claim.
const RODENT_NOUN = '(?:rats?|rodents?|mouse|mice)';
const CAPTURE_CLAIM_RES = [
  /\bcaptur\w*/gi,
  /\bcaught\b/gi,
  /\bcatch(?:es|ing)?\b/gi,
  /\btrapped\b/gi,
  new RegExp(`\\bremov\\w*[^.!?]{0,25}\\b${RODENT_NOUN}\\b`, 'gi'),
  new RegExp(`\\b${RODENT_NOUN}\\b[^.!?]{0,25}\\bremov\\w*`, 'gi'),
];
const CONSUMPTION_CLAIM_RES = [
  /\bconsum\w*/gi,
  /\beaten\b/gi,
  /\bbait\s+take\b/gi,
  /\bfe(?:d|eding)\s+on\b/gi,
];

// Even SUPPORTED events only publish as grounded generic statements (codex
// round-6 P1): with a capture on record, "we caught a rat in the kitchen"
// still invents species/location the facts don't carry. The templates are
// ANCHORED over the whole comma-delimited clause (codex round-8 P1) — "a
// capture was recorded in the kitchen" contains the safe substring but the
// invented location suffix must fail the match, so the clause may carry
// only an optional leading connective and an optional trailing time-frame
// phrase around the grounded statement.
const CLAIM_TAIL = '(?:\\s+(?:today|this\\s+visit|on\\s+(?:this|today’s|today\'s)\\s+visit|during\\s+(?:this|the)\\s+visit))?';
const ALLOWED_CAPTURE_PHRASE = new RegExp(`^(?:(?:and|with|plus)\\s+)?(?:(?:a|an|\\d+)\\s+)?captures?\\s+(?:was\\s+|were\\s+)?recorded(?:\\s+at\\s+\\d+\\s+traps?)?${CLAIM_TAIL}$`, 'i');
const ALLOWED_CONSUMPTION_PHRASE = new RegExp(`^(?:(?:and|with|plus)\\s+)?(?:bait\\s+)?consumption\\s+(?:was\\s+|were\\s+)?observed(?:\\s+at\\s+\\d+\\s+(?:bait\\s+)?stations?)?${CLAIM_TAIL}$`, 'i');

// Comma included: the template anchors over the smallest clause, so "…were
// inspected, with a capture recorded at 2 traps" isolates the claim.
function clauseAround(text, index) {
  const before = text.slice(0, index);
  const start = Math.max(before.lastIndexOf('.'), before.lastIndexOf('!'), before.lastIndexOf('?'), before.lastIndexOf(';'), before.lastIndexOf(','));
  const endRel = text.slice(index).search(/[.!?;,]/);
  return text.slice(start + 1, endRel === -1 ? text.length : index + endRel).trim();
}

function unsupportedActivityClaims(text, facts) {
  const problems = [];
  const roles = factNumbers(facts);
  const stations = facts.stations || {};
  const captureState = typedActivityState(facts, /captur/i);
  const consumptionState = typedActivityState(facts, /consum/i);
  const captureSupported = [...roles.capturesAt, ...roles.captureTotals].some((n) => n > 0)
    || captureState.positive === true;
  const consumptionSupported = [...roles.consumptionAt].some((n) => n > 0)
    || consumptionState.positive === true;
  // A NEGATIVE claim needs explicit zero EVIDENCE (codex round-8 P1): a
  // typed zero/"None" finding, or a station map that recorded the status
  // with zero flagged locations. With neither, "no captures were recorded"
  // asserts something nothing recorded and rejects.
  const captureZeroRecorded = captureState.positive === false
    || typeof stations.trapsWithCaptureRecorded === 'number';
  const consumptionZeroRecorded = consumptionState.positive === false
    || typeof stations.stationsWithBaitConsumption === 'number';
  const scan = (regexes, supported, zeroRecorded, allowedPhrase, positiveProblem, negativeProblem, ungroundedNegative) => {
    for (const re of regexes) {
      for (const match of String(text).matchAll(new RegExp(re.source, 'gi'))) {
        if (claimNegated(text, match.index, match[0].length)) {
          // A NEGATED claim against a positive record is just as false as
          // an invented positive: "No captures were recorded" must reject
          // when the facts record one (codex round-7 P1).
          if (supported) problems.push(negativeProblem);
          else if (!zeroRecorded) problems.push(ungroundedNegative);
          continue;
        }
        if (supported && allowedPhrase.test(clauseAround(text, match.index))) continue;
        problems.push(positiveProblem);
      }
    }
  };
  scan(CAPTURE_CLAIM_RES, captureSupported, captureZeroRecorded, ALLOWED_CAPTURE_PHRASE,
    'unsupported_capture_claim', 'contradicted_capture_negative', 'ungrounded_capture_negative');
  scan(CONSUMPTION_CLAIM_RES, consumptionSupported, consumptionZeroRecorded, ALLOWED_CONSUMPTION_PHRASE,
    'unsupported_consumption_claim', 'contradicted_consumption_negative', 'ungrounded_consumption_negative');
  return problems;
}

// Next-visit copy is validated as TEXT, not just numerals (codex round-4
// P1): "8–10 PM" contains only grounded numbers but contradicts an 8–10 AM
// appointment. Any arrival-window or month-day mention in the output must
// match the grounded next visit exactly (weekday too, when written); with
// no grounded next visit, mentioning either rejects.
const WINDOW_TEXT_RE = /\b\d{1,2}(?::\d{2})?\s*(?:AM|PM)?\s*[–—-]\s*\d{1,2}(?::\d{2})?\s*(?:AM|PM)\b/gi;
const MONTH_NAMES = 'January|February|March|April|May|June|July|August|September|October|November|December';
const WEEKDAY_NAMES = 'Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday';
const DATE_TEXT_RE = new RegExp(`\\b(?:(${WEEKDAY_NAMES}),?\\s+)?(${MONTH_NAMES})\\s+(\\d{1,2})\\b`, 'gi');

function normalizeWindowText(value) {
  return String(value || '').replace(/[–—-]/g, '–').replace(/\s+/g, ' ').trim().toUpperCase();
}

function nextVisitProblems(text, facts) {
  const problems = [];
  const expected = facts.nextVisit;
  const expectedWindow = expected?.window ? normalizeWindowText(expected.window) : null;
  for (const match of String(text).matchAll(new RegExp(WINDOW_TEXT_RE.source, 'gi'))) {
    if (!expectedWindow || normalizeWindowText(match[0]) !== expectedWindow) {
      problems.push(`ungrounded_window:${match[0].trim()}`);
    }
  }
  const expectedDate = expected?.date
    ? new RegExp(`^(?:(${WEEKDAY_NAMES}),?\\s+)?(${MONTH_NAMES})\\s+(\\d{1,2})$`, 'i').exec(String(expected.date).trim())
    : null;
  for (const match of String(text).matchAll(new RegExp(DATE_TEXT_RE.source, 'gi'))) {
    const [, weekday, month, day] = match;
    const ok = expectedDate
      && month.toLowerCase() === expectedDate[2].toLowerCase()
      && Number(day) === Number(expectedDate[3])
      && (!weekday || !expectedDate[1] || weekday.toLowerCase() === expectedDate[1].toLowerCase());
    if (!ok) problems.push(`ungrounded_date:${match[0].trim()}`);
  }
  // STANDALONE weekday mentions count too (codex round-6 P1): "your next
  // visit is Tuesday" contradicts a Monday appointment without ever
  // matching the month-day pattern. Every weekday word in the output must
  // be the grounded visit's weekday.
  const expectedWeekday = expectedDate && expectedDate[1] ? expectedDate[1].toLowerCase() : null;
  for (const match of String(text).matchAll(new RegExp(`\\b(${WEEKDAY_NAMES})\\b`, 'gi'))) {
    if (!expectedWeekday || match[1].toLowerCase() !== expectedWeekday) {
      problems.push(`ungrounded_weekday:${match[1]}`);
    }
  }
  // STANDALONE clock times too (codex round-8 P1): "at 8 PM" reformats the
  // grounded 8–10 AM range into a wrong single time whose numeral is
  // grounded. Range mentions are removed first (the window check above
  // already judged them); every remaining clock time must be one of the
  // grounded window's boundaries, meridiem included.
  const allowedTimes = new Set();
  if (expectedWindow) {
    const win = /^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?\s*–\s*(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/.exec(expectedWindow);
    if (win) {
      const endMeridiem = win[6];
      const startMeridiem = win[3] || endMeridiem;
      allowedTimes.add(`${Number(win[1])}:${win[2] || '00'} ${startMeridiem}`);
      allowedTimes.add(`${Number(win[4])}:${win[5] || '00'} ${endMeridiem}`);
    }
  }
  const withoutRanges = String(text).replace(new RegExp(WINDOW_TEXT_RE.source, 'gi'), ' ');
  for (const match of withoutRanges.matchAll(/\b(\d{1,2})(?::(\d{2}))?\s*(AM|PM)\b/gi)) {
    const normalized = `${Number(match[1])}:${match[2] || '00'} ${match[3].toUpperCase()}`;
    if (!allowedTimes.has(normalized)) problems.push(`ungrounded_time:${match[0].trim()}`);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Domain-term grounding (codex P1 #3007): with the engine generalized to
// every typed line, the facts-only contract must cover PEST NAMES,
// TREATMENT ACTIONS, and LOCATIONS — a bed-bug report whose model output
// claims "German cockroaches in the attic" or "gel bait was applied" must
// fall back even though no numeral, banned word, or product name appears.
// Each recognized term in the OUTPUT must match somewhere in the grounding
// facts (JSON-serialized, normalized); `out` finds the claim, `corpus`
// checks the facts. Fail-closed: an unmatched term rejects the summary.
// ---------------------------------------------------------------------------
const DOMAIN_TERMS = [
  // pests
  { kind: 'pest', out: /\b(?:cock)?roach(?:es)?\b/i, corpus: /\b(?:cock)?roach/ },
  { kind: 'pest', out: /\bbed\s*bugs?\b/i, corpus: /\bbed\s*bug/ },
  { kind: 'pest', out: /\btermites?\b/i, corpus: /\btermite/ },
  { kind: 'pest', out: /\brodents?\b/i, corpus: /\brodent/ },
  { kind: 'pest', out: /\brats?\b/i, corpus: /\brat\b|\brats\b/ },
  { kind: 'pest', out: /\bmice\b|\bmouse\b/i, corpus: /\bmice\b|\bmouse\b/ },
  { kind: 'pest', out: /\bants?\b/i, corpus: /\bants?\b/ },
  { kind: 'pest', out: /\bspiders?\b/i, corpus: /\bspider/ },
  { kind: 'pest', out: /\bwasps?\b/i, corpus: /\bwasp/ },
  { kind: 'pest', out: /\bmosquito(?:es)?\b/i, corpus: /\bmosquito/ },
  { kind: 'pest', out: /\bfleas?\b/i, corpus: /\bflea/ },
  { kind: 'pest', out: /\bticks?\b/i, corpus: /\btick/ },
  { kind: 'pest', out: /\bsilverfish\b/i, corpus: /\bsilverfish/ },
  { kind: 'pest', out: /\bearwigs?\b/i, corpus: /\bearwig/ },
  { kind: 'pest', out: /\bcrickets?\b/i, corpus: /\bcricket/ },
  { kind: 'pest', out: /\bbeetles?\b/i, corpus: /\bbeetle/ },
  { kind: 'pest', out: /\bscorpions?\b/i, corpus: /\bscorpion/ },
  { kind: 'pest', out: /\bbees?\b/i, corpus: /\bbees?\b/ },
  { kind: 'pest', out: /\bhornets?\b/i, corpus: /\bhornet/ },
  { kind: 'pest', out: /\byellow\s*jackets?\b/i, corpus: /\byellow\s*jacket/ },
  { kind: 'pest', out: /\bsnails?\b|\bslugs?\b/i, corpus: /\bsnail|\bslug/ },
  { kind: 'pest', out: /\bnests?\b/i, corpus: /\bnest/ },
  // species QUALIFIERS (codex P1 #3007 r3): the family term alone must not
  // ground a different species — German cockroaches recorded, "American
  // cockroaches" claimed, must reject. Each qualifier grounds only itself.
  { kind: 'species', out: /\bgerman\b/i, corpus: /\bgerman/ },
  { kind: 'species', out: /\bamerican\b/i, corpus: /\bamerican/ },
  { kind: 'species', out: /\bsmoky[-\s]?brown\b/i, corpus: /\bsmoky\s?brown/ },
  { kind: 'species', out: /\boriental\b/i, corpus: /\boriental/ },
  { kind: 'species', out: /\bbrown[-\s]?banded\b/i, corpus: /\bbrown\s?banded/ },
  { kind: 'species', out: /\broof\s+rats?\b/i, corpus: /\broof\s+rat/ },
  { kind: 'species', out: /\bnorway\b/i, corpus: /\bnorway/ },
  { kind: 'species', out: /\bsubterranean\b/i, corpus: /\bsubterranean/ },
  { kind: 'species', out: /\bdrywood\b/i, corpus: /\bdrywood/ },
  { kind: 'species', out: /\bdampwood\b/i, corpus: /\bdampwood/ },
  { kind: 'species', out: /\bformosan\b/i, corpus: /\bformosan/ },
  // wildlife species (wildlife_trapping typed schema — codex P1 #3007 r2):
  // the narrative must never swap the recorded animal
  { kind: 'pest', out: /\braccoons?\b/i, corpus: /\braccoon/ },
  { kind: 'pest', out: /\bo?possums?\b/i, corpus: /\bo?possum/ },
  { kind: 'pest', out: /\bsquirrels?\b/i, corpus: /\bsquirrel/ },
  { kind: 'pest', out: /\barmadillos?\b/i, corpus: /\barmadillo/ },
  { kind: 'pest', out: /\bbats?\b/i, corpus: /\bbats?\b/ },
  { kind: 'pest', out: /\bbirds?\b/i, corpus: /\bbirds?\b/ },
  { kind: 'pest', out: /\bsnakes?\b/i, corpus: /\bsnake/ },
  { kind: 'pest', out: /\biguanas?\b/i, corpus: /\biguana/ },
  { kind: 'pest', out: /\bcoyotes?\b/i, corpus: /\bcoyote/ },
  // palm/plant specialty organisms and diseases (palm_injection typed
  // schema — codex P1 #3007 r8): grounded like any pest, and their
  // negative findings drive zero states
  { kind: 'pest', out: /\bganoderma\b/i, corpus: /\bganoderma/ },
  { kind: 'pest', out: /\bconks?\b/i, corpus: /\bconk/ },
  { kind: 'pest', out: /\bweevils?\b/i, corpus: /\bweevil/ },
  { kind: 'pest', out: /\bmites?\b/i, corpus: /\bmites?\b/ },
  { kind: 'pest', out: /\bscale\s+insects?\b/i, corpus: /\bscale/ },
  { kind: 'pest', out: /\bwhitefl(?:y|ies)\b/i, corpus: /\bwhitefl/ },
  { kind: 'pest', out: /\baphids?\b/i, corpus: /\baphid/ },
  { kind: 'pest', out: /\bmealybugs?\b/i, corpus: /\bmealybug/ },
  { kind: 'pest', out: /\bthrips\b/i, corpus: /\bthrips/ },
  { kind: 'pest', out: /\bfusarium\b/i, corpus: /\bfusarium/ },
  { kind: 'pest', out: /\bbud\s+rot\b/i, corpus: /\bbud\s+rot/ },
  { kind: 'pest', out: /\blethal\s+(?:bronzing|yellowing)\b/i, corpus: /\blethal\s+(?:bronzing|yellowing)/ },
  // treatment actions
  { kind: 'action', out: /\bgel\s*bait/i, corpus: /\bgel\s*bait/ },
  { kind: 'action', out: /\bbait(?:s|ed|ing)?\b/i, corpus: /\bbait/ },
  { kind: 'action', out: /\bgrowth\s+regulator/i, corpus: /\bgrowth\s+regulator/ },
  { kind: 'action', out: /\bcracks?\s*(?:and|&)\s*crevices?/i, corpus: /\bcrack\w*\s+(?:and\s+)?crevice/ },
  { kind: 'action', out: /\bflush[-\s]?out\b/i, corpus: /\bflush\s*out/ },
  { kind: 'action', out: /\bexclusion\b/i, corpus: /\bexclusion/ },
  { kind: 'action', out: /\bsanitation\b/i, corpus: /\bsanitation/ },
  { kind: 'action', out: /\bdust(?:ed|ing)?\b/i, corpus: /\bdust/ },
  { kind: 'action', out: /\bfog(?:ged|ging)?\b/i, corpus: /\bfog/ },
  { kind: 'action', out: /\bspray(?:ed|ing)?\b/i, corpus: /\bspray/ },
  { kind: 'action', out: /\bheat\s+treat/i, corpus: /\bheat\s+treat/ },
  { kind: 'action', out: /\bsteam(?:ed|ing)?\b/i, corpus: /\bsteam/ },
  { kind: 'action', out: /\bvacuum/i, corpus: /\bvacuum/ },
  { kind: 'action', out: /\bencasements?\b/i, corpus: /\bencasement/ },
  { kind: 'action', out: /\binject/i, corpus: /\binject/ },
  { kind: 'action', out: /\bgranular\b/i, corpus: /\bgranular/ },
  { kind: 'action', out: /\bbarrier\b/i, corpus: /\bbarrier/ },
  { kind: 'action', out: /\btraps?\b|\btrapped\b|\btrapping\b/i, corpus: /\btrap/ },
  { kind: 'action', out: /\bmonitors?\b|\bmonitoring\b/i, corpus: /\bmonitor/ },
  // locations
  { kind: 'location', out: /\bkitchens?\b/i, corpus: /\bkitchen/ },
  { kind: 'location', out: /\bbath(?:room)?s?\b/i, corpus: /\bbath/ },
  { kind: 'location', out: /\bbedrooms?\b/i, corpus: /\bbedroom/ },
  { kind: 'location', out: /\battics?\b/i, corpus: /\battic/ },
  { kind: 'location', out: /\bgarages?\b/i, corpus: /\bgarage/ },
  { kind: 'location', out: /\blaundry\b/i, corpus: /\blaundry/ },
  { kind: 'location', out: /\bpantry\b/i, corpus: /\bpantry/ },
  { kind: 'location', out: /\bclosets?\b/i, corpus: /\bcloset/ },
  { kind: 'location', out: /\bbasements?\b/i, corpus: /\bbasement/ },
  { kind: 'location', out: /\bcrawl\s*space/i, corpus: /\bcrawl\s*space/ },
  { kind: 'location', out: /\blanai\b/i, corpus: /\blanai/ },
  { kind: 'location', out: /\bpatios?\b/i, corpus: /\bpatio/ },
  { kind: 'location', out: /\bpools?\b/i, corpus: /\bpool/ },
  { kind: 'location', out: /\bdriveways?\b/i, corpus: /\bdriveway/ },
  { kind: 'location', out: /\bperimeters?\b/i, corpus: /\bperimeter/ },
  { kind: 'location', out: /\bfoundations?\b/i, corpus: /\bfoundation/ },
  { kind: 'location', out: /\beaves\b|\bsoffits?\b/i, corpus: /\beaves\b|\bsoffit/ },
  { kind: 'location', out: /\bdishwashers?\b/i, corpus: /\bdishwasher/ },
  { kind: 'location', out: /\brefrigerators?\b|\bfridge\b/i, corpus: /\brefrigerator|\bfridge/ },
  { kind: 'location', out: /\bstoves?\b|\bovens?\b/i, corpus: /\bstove|\boven/ },
  { kind: 'location', out: /\bsinks?\b/i, corpus: /\bsink/ },
  { kind: 'location', out: /\bbaseboards?\b/i, corpus: /\bbaseboard/ },
  { kind: 'location', out: /\bwall\s*voids?\b/i, corpus: /\bwall\s*void/ },
  { kind: 'location', out: /\bstations?\b/i, corpus: /\bstation/ },
  { kind: 'location', out: /\bfence\b/i, corpus: /\bfence/ },
];

// A finding whose VALUE is negative ("Monitors placed: No") must not
// ground its label's action — the label alone would promote a declined
// action into completed work (codex P1 #3007 r2). Negative-valued findings
// are excluded from the domain corpus entirely.
const NEGATIVE_FINDING_VALUE_RE = /^(?:no\b|none\b|not\b|0(?:\.0*)?$|n\/a\b|false\b)/i;
const NEGATED_SENTENCE_RE = /\b(no|not|none|never|without)\b/i;

// Prose blocks contribute only their AFFIRMATIVE sentences to the corpus —
// "No live roach activity was observed" must not ground a positive "live
// roaches were observed" claim (codex P1 #3007 r4).
function affirmativeSentences(block) {
  return String(block || '')
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => sentence.trim() && !NEGATED_SENTENCE_RE.test(sentence))
    .join(' ');
}

function domainCorpus(facts) {
  const positiveFacts = {
    ...facts,
    recap: affirmativeSentences(facts.recap),
    todaysResult: facts.todaysResult
      ? {
        headline: affirmativeSentences(facts.todaysResult.headline),
        body: affirmativeSentences(facts.todaysResult.body),
        nextStep: affirmativeSentences(facts.todaysResult.nextStep),
      }
      : null,
    findings: (facts.findings || []).filter(
      (finding) => !NEGATIVE_FINDING_VALUE_RE.test(String(finding.value).trim()),
    ),
  };
  return ` ${JSON.stringify(positiveFacts).toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;
}

// Explicit zero-state contradiction guard (codex P1 #3007 r4): the service
// LABEL legitimately grounds the pest family ("Cockroach Control Service"),
// so corpus filtering alone can't stop "live roaches were observed today"
// on a report whose ratified copy says none were. Any NEGATED ratified
// sentence naming a pest term rejects model sentences that assert an
// observation of that same pest positively.
const OBSERVATION_RE = /\b(observed|noted|seen|found|documented|present|active|visible|spotted|detected)\b/i;

function contradictedZeroStates(text, facts) {
  const problems = [];
  const pestTerms = DOMAIN_TERMS.filter((term) => term.kind === 'pest' || term.kind === 'species');
  // Negative-valued FINDINGS carry zero states too (codex P1 #3007 r7):
  // "Live roaches observed: No" negates the sighting even when no
  // headline/body sentence spells it out.
  const negativeFindings = (facts.findings || [])
    .filter((finding) => NEGATIVE_FINDING_VALUE_RE.test(String(finding.value).trim()))
    .map((finding) => `${finding.label} ${finding.value}`);
  const ratified = [facts.todaysResult?.headline, facts.todaysResult?.body, facts.recap]
    .flatMap((block) => String(block || '').split(/(?<=[.!?])\s+/))
    .filter((sentence) => NEGATED_SENTENCE_RE.test(sentence))
    .concat(negativeFindings);
  if (!ratified.length) return problems;
  let zeroStatePests = pestTerms.filter((term) => ratified.some((sentence) => term.out.test(sentence)));
  // Generic zero states ("No active signs observed during today's
  // service.") name no pest — the report's IDENTITY supplies it, so a
  // zero-activity bed-bug report still rejects "live bed bugs were found"
  // (codex P1 #3007 r8). Only a generic ACTIVITY negation triggers the
  // inference; an unrelated negative finding ("Monitors placed: No") on a
  // positive-activity report must not.
  if (!zeroStatePests.length) {
    const genericZeroState = ratified.some((sentence) => /\bno\b[^.!?]*\b(signs?|activity|evidence)\b/i.test(sentence));
    if (genericZeroState) {
      const identity = `${facts.serviceTypeDisplay || ''} ${facts.reportTypeLabel || ''}`;
      zeroStatePests = pestTerms.filter((term) => term.out.test(identity));
    }
  }
  if (!zeroStatePests.length) return problems;
  // Clause scope (codex P1 #3007 r5): "No concerns were reported, but live
  // roaches were observed" carries the contradiction in its second clause —
  // a negator elsewhere in the sentence must not shield it.
  const clauses = String(text)
    .split(/(?<=[.!?])\s+/)
    .flatMap((sentence) => sentence.split(/[,;]|\b(?:but|however|yet|although|though)\b/i));
  for (const clause of clauses) {
    if (NEGATED_SENTENCE_RE.test(clause)) continue;
    if (!OBSERVATION_RE.test(clause)) continue;
    for (const term of zeroStatePests) {
      if (term.out.test(clause)) {
        problems.push('contradicted_zero_state');
        break;
      }
    }
  }
  return problems;
}

// ACTION terms ground only against completed-work evidence — affirmative
// findings/ratified copy, devices, photo evidence — never the service or
// report LABEL: "Termite Bait Station" in the title must not prove "we
// baited the stations" on a visit whose Bait-replaced finding says No
// (codex P1 #3007 r5). Pest/species/location terms keep the full corpus
// (the label legitimately grounds the pest family).
function actionCorpus(facts) {
  const workFacts = {
    findings: (facts.findings || []).filter(
      (finding) => !NEGATIVE_FINDING_VALUE_RE.test(String(finding.value).trim()),
    ),
    recap: affirmativeSentences(facts.recap),
    todaysResult: facts.todaysResult
      ? {
        headline: affirmativeSentences(facts.todaysResult.headline),
        body: affirmativeSentences(facts.todaysResult.body),
        nextStep: affirmativeSentences(facts.todaysResult.nextStep),
      }
      : null,
    devices: facts.devices,
    photoSummary: facts.photoSummary,
    photoEvidence: facts.photoEvidence,
  };
  return ` ${JSON.stringify(workFacts).toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;
}

function ungroundedDomainTerms(text, facts) {
  const problems = [];
  const corpus = domainCorpus(facts);
  const actions = actionCorpus(facts);
  for (const term of DOMAIN_TERMS) {
    const match = String(text).match(new RegExp(term.out.source, 'i'));
    if (match && !term.corpus.test(term.kind === 'action' ? actions : corpus)) {
      problems.push(`ungrounded_${term.kind}:${match[0].toLowerCase()}`);
    }
  }
  return problems;
}

// Typed COUNT findings get role validation of their own (codex P1 #3007
// r2): "Palms serviced: 1" must reject "27 palms were serviced" even when
// 27 is grounded elsewhere (a next-visit date). Every numeral followed
// (within a word) by a noun that appears in a numeric finding's label must
// equal that finding's value. Trap/station/device/capture nouns are
// excluded — the station role validator owns them.
const ROLE_VALIDATED_NOUN_STEMS = new Set(['trap', 'station', 'device', 'capture']);

function typedCountRoles(facts) {
  const map = new Map(); // noun stem -> Set of grounded values
  (facts.findings || []).forEach((finding) => {
    const n = Number(String(finding.value).trim());
    if (!Number.isFinite(n)) return;
    String(finding.label).toLowerCase().split(/[^a-z]+/)
      .filter((word) => word.length >= 4)
      .forEach((word) => {
        const stem = word.replace(/s$/, '');
        if (ROLE_VALIDATED_NOUN_STEMS.has(stem)) return;
        if (!map.has(stem)) map.set(stem, new Set());
        map.get(stem).add(n);
      });
  });
  return map;
}

function typedCountProblems(text, facts) {
  const problems = [];
  const rolesByNoun = typedCountRoles(facts);
  if (!rolesByNoun.size) return problems;
  for (const match of String(text).matchAll(/\b(\d+)((?:\s+[a-z-]+){1,2})/gi)) {
    const value = Number(match[1]);
    for (const word of match[2].trim().toLowerCase().split(/\s+/)) {
      const stem = word.replace(/s$/, '');
      if (!rolesByNoun.has(stem)) continue;
      if (!rolesByNoun.get(stem).has(value)) {
        problems.push(`uncorroborated_count:${match[1]} ${word}`);
      }
      break; // first mapped noun decides the role for this numeral
    }
  }
  return problems;
}

// Action–location PAIRING (codex P1 #3007 r7): "we sprayed the kitchen"
// must not pass just because a perimeter spray grounds "spray" and a
// kitchen ACTIVITY finding grounds "kitchen" — a sentence that claims an
// action at a location requires some single completed-work fact recording
// them together. Work facts = affirmative ratified sentences, positive
// findings (label+value), and device entries.
function completedWorkStrings(facts) {
  const strings = [];
  const norm = (value) => ` ${String(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;
  [facts.recap, facts.todaysResult?.headline, facts.todaysResult?.body, facts.todaysResult?.nextStep]
    .forEach((block) => String(block || '').split(/(?<=[.!?])\s+/).forEach((sentence) => {
      if (sentence.trim() && !NEGATED_SENTENCE_RE.test(sentence)) strings.push(norm(sentence));
    }));
  (facts.findings || []).forEach((finding) => {
    if (!NEGATIVE_FINDING_VALUE_RE.test(String(finding.value).trim())) {
      strings.push(norm(`${finding.label} ${finding.value}`));
    }
  });
  (facts.devices || []).forEach((device) => {
    strings.push(norm(`${device.name || ''} ${device.category || ''} ${device.summary || ''}`));
  });
  return strings;
}

function unpairedActionLocations(text, facts) {
  const problems = [];
  const actionTerms = DOMAIN_TERMS.filter((term) => term.kind === 'action');
  const locationTerms = DOMAIN_TERMS.filter((term) => term.kind === 'location');
  const work = completedWorkStrings(facts);
  for (const sentence of String(text).split(/(?<=[.!?])\s+/)) {
    const actions = actionTerms.filter((term) => term.out.test(sentence));
    if (!actions.length) continue;
    const locations = locationTerms.filter((term) => term.out.test(sentence));
    if (!locations.length) continue;
    // EVERY action×location pair asserted by the sentence must co-occur in
    // one work fact (codex P1 #3007 r8): with "sprayed the kitchen" and
    // "baited the bathroom" on record, the swapped "we sprayed the bathroom
    // and baited the kitchen" must fail — per-location some-action matching
    // let each location borrow the other clause's action. Fail-closed: a
    // true compound sentence whose pairs weren't recorded together falls
    // back to deterministic copy.
    const everyPairGrounded = actions.every((action) => locations.every(
      (location) => work.some((fact) => action.corpus.test(fact) && location.corpus.test(fact)),
    ));
    if (!everyPairGrounded) problems.push('unpaired_action_location');
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
  // Word-form numbers hit the GLOBAL check too (codex P1 #3007 r4):
  // "follow up in twenty days" carries no raw digit, but 20 must still be
  // grounded. The bare word "one" is exempt when no digit 1 was written —
  // harmless prose ("one of the traps") is not a numeric claim.
  const rawDigits = new Set(numberTokens(text));
  // "one" is exempt only in its partitive idiom ("one of the traps") — a
  // bare "one day"/"one treatment" is a numeric claim and validates like
  // any digit (codex P1 #3007 r5).
  const bareOne = /\bone\b(?!\s+of\b)/i.test(text);
  for (const token of numberTokens(normalizeWordNumbers(text))) {
    if (token === '1' && !rawDigits.has('1') && !bareOne) continue;
    const grounded = allowed.has(token)
      || allowed.has(String(Number(token)))
      || token.split(/[:.,]/).every((part) => allowed.has(part) || allowed.has(String(Number(part))));
    if (!grounded) problems.push(`ungrounded_number:${token}`);
  }
  problems.push(...contextualCountProblems(normalizeWordNumbers(text), facts));
  problems.push(...unsupportedActivityClaims(text, facts));
  problems.push(...nextVisitProblems(text, facts));
  problems.push(...ungroundedDomainTerms(text, facts));
  problems.push(...typedCountProblems(normalizeWordNumbers(text), facts));
  problems.push(...contradictedZeroStates(text, facts));
  problems.push(...unpairedActionLocations(text, facts));
  // Score-ratio phrasing ("3 out of 5", "3/5") is banned outright: the
  // customer-copy contract keeps raw activity scores out of prose (the
  // facts no longer carry them, and grounded numerals like a day-of-month
  // must not be composable into a fake reading — codex round-5 P2).
  for (const match of String(text).matchAll(/\b\d+\s*(?:out\s+of|\/)\s*\d+\b/gi)) {
    problems.push(`score_ratio_phrasing:${match[0].trim()}`);
  }
  return problems;
}

// True when the copy echoes a product name the facts withheld (registered
// products) — prompt rules are enforced, not just requested. Token match on
// 4+ letter name parts, same posture as completion-recap's guard. Generic
// vocabulary is exempt (codex round-5 P2): "Contrac Blox Rodenticide" must
// not make a compliant "a rodenticide was used" summary fail — only the
// DISTINCTIVE tokens of the name are withheld, never words that are also
// the product's permitted generic category or common product-class terms.
const GENERIC_PRODUCT_TOKENS = new Set([
  'rodenticide', 'insecticide', 'herbicide', 'fungicide', 'bait', 'baits',
  'trap', 'traps', 'station', 'stations', 'block', 'blocks', 'rodent',
  'rodents', 'control', 'pest', 'granular', 'liquid', 'concentrate',
  'spray', 'dust', 'weather', 'resistant', 'soft', 'grain', 'place',
  'packs', 'pack',
]);

function echoesWithheldName(text, applications = []) {
  const hay = String(text || '').toLowerCase();
  if (!hay) return false;
  return (Array.isArray(applications) ? applications : [])
    .filter((app) => !isNameableDevice(app?.product || {}))
    .some((app) => {
      const categoryTokens = new Set(cleanText(app?.product?.category).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
      return cleanText(app?.product?.name)
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((token) => token.length >= 4
          && !GENERIC_PRODUCT_TOKENS.has(token)
          && !categoryTokens.has(token))
        .some((token) => hay.includes(token));
    });
}

// Sentences the ratified copy marks as customer OBLIGATIONS — imperative
// care markers in the typed body — plus every next-step sentence. These are
// the pieces an accepted narrative must carry verbatim (appended when it
// doesn't); dedup by exact string so body-embedded next-step copy appends
// once.
// Broad by design (codex P1 #3007 r4): expectation/monitoring copy
// ("Continue monitoring and contact us if activity returns") is as
// mandatory as an imperative — an over-wide match only appends a ratified
// sentence the narrative skipped, never loses one.
const CARE_SENTENCE_RE = /\b(please|keep|avoid|do not|don't|wash|vacuum|stay off|leave|allow|continue|contact|monitor(?:ing)?|watch|expect(?:ed)?|call|reach out|schedule|recommend(?:ed)?|follow[-\s]?up|return(?:s)?)\b/i;

function mandatoryCareCopy(todaysResult) {
  const sentences = [];
  const split = (block) => String(block || '').split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  split(todaysResult?.body).forEach((sentence) => {
    if (CARE_SENTENCE_RE.test(sentence)) sentences.push(sentence);
  });
  sentences.push(...split(todaysResult?.nextStep));
  return [...new Set(sentences)];
}

/**
 * Returns the detailed Visit Summary string for a typed specialty report
 * (rodent, cockroach, bed bug, termite bait, … — V1 surface only; WDO is
 * project-report territory), or the deterministic
 * fallback. Never throws; never returns unguarded model copy.
 */
async function applyTypedReportNarrative(input = {}, deps = {}) {
  const facts = groundingFacts(input);
  if (!facts.recap && !facts.todaysResult) return cleanText(input.recap);

  const fallback = deterministicSummary(facts);
  // Withheld (registered) product names never enter the facts, so two
  // reports with different withheld products would otherwise share a cache
  // entry — and a summary that cleared the echo guard for one could be
  // served to the other without rerunning it (codex round-4 P2). Their
  // identity joins the key WITHOUT joining the prompt.
  const withheldSig = (Array.isArray(input.applications) ? input.applications : [])
    .filter((app) => !isNameableDevice(app?.product || {}))
    .map((app) => cleanText(app?.product?.name).toLowerCase())
    .filter(Boolean)
    .sort()
    .join('|');
  const cacheKey = crypto.createHash('sha256').update(`${PROMPT_VERSION}|${stableStringify(facts)}|withheld:${withheldSig}`).digest('hex');
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
        // Care-instruction preservation is ENFORCED, not requested (codex
        // P1 r2 + P2 r3): on the Pest V2 override surface the narrative
        // replaces the ratified body, so BOTH the next-step copy and any
        // mandatory care sentences embedded in the ratified body (flea
        // cooperation/aftercare etc.) must survive verbatim. Sentences the
        // narrative only paraphrased are appended in ratified form (the
        // client's containment rule then renders each once, in the body).
        for (const sentence of mandatoryCareCopy(facts.todaysResult)) {
          if (!value.includes(sentence)) value = `${value} ${sentence}`.trim();
        }
      } else {
        logger.warn(`[typed-narrative] output hit guard (${banned.join(', ')}); using deterministic summary`);
      }
    } else if (res && !res.ok) {
      logger.warn(`[typed-narrative] miss (${res.reason}); using deterministic summary`);
    }
  } catch (err) {
    logger.warn(`[typed-narrative] failed: ${err.message}; using deterministic summary`);
  }

  _cache.set(cacheKey, { at: Date.now(), value });
  if (_cache.size > 300) _cache.delete(_cache.keys().next().value);
  return value;
}

module.exports = {
  applyTypedReportNarrative,
  // Back-compat alias — the rodent refresh (GATE_RODENT_REPORT_REFRESH)
  // shipped against this name; same engine.
  applyRodentReportNarrative: applyTypedReportNarrative,
  // exported for tests
  _test: {
    groundingFacts,
    deterministicSummary,
    deviceFacts,
    isNameableDevice,
    echoesWithheldName,
    ungroundedClaims,
    factNumbers,
    typedCaptureCount,
    buildUserMessage,
    SYSTEM_PROMPT,
    PROMPT_VERSION,
    _cache,
  },
};
