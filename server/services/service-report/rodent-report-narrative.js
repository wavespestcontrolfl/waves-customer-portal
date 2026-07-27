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

You are given grounding facts: the technician's recap message, the report's ratified result copy, customer-labeled findings (species, traps checked), the property's rodent activity reading (a WORDING-based level — never express activity as a number, score, or ratio), trap/station check counts, the devices and products in service, photo evidence the technician documented (captions and, when present, a reviewed photo summary), and the next scheduled rodent visit.

Rules:
- 4 to 7 short sentences in one or two short paragraphs. Plain, calm, professional language. No greeting, no headings, no markdown, no bullet lists.
- Facts only: never invent work, counts, captures, sightings, or evidence that is not in the facts. Never contradict the recap or ratified result copy.
- Write every count as a numeral, exactly as it appears in the facts. Never introduce a number that is not in the facts.
- Station counts count LOCATIONS with a status, not events: "trapsWithCaptureRecorded: 2" means a capture was recorded at 2 traps — never "2 captures". "stationsWithBaitConsumption" means that many stations showed bait consumption. Zero is stated as "no captures were recorded" / "no bait consumption was observed" — never as proof rodents are gone or the issue is resolved.
- When a capture or bait consumption IS recorded, state it ONLY in the grounded generic form ("a capture was recorded at 2 traps", "bait consumption was observed at 1 station") — never invent species, rooms, or other details the facts do not carry.
- Devices with a name in the facts (mechanical traps, monitoring devices) may be named. Products with a null name must only be described by their generic category — never guess or reconstruct a product name, and never mention chemicals, active ingredients, application rates, prices, or EPA details.
- If photo evidence is provided, briefly and calmly reference what was documented (for example, droppings observed in the attic) — it shows the customer what the service is tracking.
- If an activity reading is provided, work its meaning in naturally; when it is marked as a baseline, say this visit sets the baseline future visits will measure against.
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
  const captureTotals = new Set(); // "N captures" — only a typed finding grounds this
  (facts.findings || []).forEach((finding) => {
    const n = Number(String(finding.value).trim());
    if (!Number.isFinite(n)) return;
    if (/captur/i.test(finding.label)) captureTotals.add(n);
    else if (/check|inspect/i.test(finding.label)) checked.add(n);
    else if (/trap|station|device/i.test(finding.label)) total.add(n);
  });
  return { total, checked, serviced, inaccessible, capturesAt, consumptionAt, captureTotals };
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
// still invents species/location the facts don't carry. Positive claims
// must match the fact-shaped templates below — anything freer rejects.
const ALLOWED_CAPTURE_PHRASE = /\b(?:(?:a|an|\d+)\s+)?captures?\s+(?:was\s+|were\s+)?recorded(?:\s+at\s+\d+\s+traps?)?\b/i;
const ALLOWED_CONSUMPTION_PHRASE = /\b(?:bait\s+)?consumption\s+(?:was\s+|were\s+)?observed(?:\s+at\s+\d+\s+(?:bait\s+)?stations?)?\b/i;

function clauseAround(text, index) {
  const before = text.slice(0, index);
  const start = Math.max(before.lastIndexOf('.'), before.lastIndexOf('!'), before.lastIndexOf('?'), before.lastIndexOf(';'));
  const endRel = text.slice(index).search(/[.!?;]/);
  return text.slice(start + 1, endRel === -1 ? text.length : index + endRel);
}

function unsupportedActivityClaims(text, facts) {
  const problems = [];
  const roles = factNumbers(facts);
  const captureSupported = [...roles.capturesAt, ...roles.captureTotals].some((n) => n > 0)
    || typedActivityState(facts, /captur/i).positive === true;
  const consumptionSupported = [...roles.consumptionAt].some((n) => n > 0)
    || typedActivityState(facts, /consum/i).positive === true;
  const scan = (regexes, supported, allowedPhrase, positiveProblem, negativeProblem) => {
    for (const re of regexes) {
      for (const match of String(text).matchAll(new RegExp(re.source, 'gi'))) {
        if (claimNegated(text, match.index, match[0].length)) {
          // A NEGATED claim against a positive record is just as false as
          // an invented positive: "No captures were recorded" must reject
          // when the facts record one (codex round-7 P1).
          if (supported) problems.push(negativeProblem);
          continue;
        }
        if (supported && allowedPhrase.test(clauseAround(text, match.index))) continue;
        problems.push(positiveProblem);
      }
    }
  };
  scan(CAPTURE_CLAIM_RES, captureSupported, ALLOWED_CAPTURE_PHRASE,
    'unsupported_capture_claim', 'contradicted_capture_negative');
  scan(CONSUMPTION_CLAIM_RES, consumptionSupported, ALLOWED_CONSUMPTION_PHRASE,
    'unsupported_consumption_claim', 'contradicted_consumption_negative');
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
  problems.push(...unsupportedActivityClaims(text, facts));
  problems.push(...nextVisitProblems(text, facts));
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

/**
 * Returns the detailed Visit Summary string for a rodent typed report, or
 * the deterministic fallback. Never throws; never returns unguarded model
 * copy.
 */
async function applyRodentReportNarrative(input = {}, deps = {}) {
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
    factNumbers,
    typedCaptureCount,
    buildUserMessage,
    SYSTEM_PROMPT,
    PROMPT_VERSION,
    _cache,
  },
};
