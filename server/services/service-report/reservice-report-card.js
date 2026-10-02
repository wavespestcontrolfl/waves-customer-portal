/**
 * Re-service report card — "You told us", "What we did" and the "Still
 * seeing X? Tell us" topic on a pest/lawn callback (re-service) report.
 * Owner-approved card, 2026-09-26 (~/fast-complete-scope-20260926.md, "Card
 * rule"); PR D of that scope.
 *
 * Dark behind GATE_RESERVICE_REPORT_CARD (exact 'true', read at CALL time so
 * a Railway flip changes the next render and the next PDF cache key without
 * a deploy). Off = buildReserviceReportCard returns null, report-data adds NO
 * key to the payload, and reservice-report.js's PDF signatures are unchanged.
 * The card hangs off the reserviceReport block (GATE_RESERVICE_REPORT_COPY):
 * no block, no card.
 *
 * What it says, and why it is safe on a permanent record:
 *  - "You told us" is the customer's own booking words, FROZEN onto
 *    service_records.service_data.reserviceRequest at completion (see
 *    freezeReserviceRequest, called from complete-scheduled-service.js), never
 *    read live from scheduled_services — a later edit of the booking cannot
 *    rewrite what the report says they told us. A pre-freeze record has no
 *    frozen request, so it shows no "You told us" (never a live fallback).
 *  - The words pass the report writer's customer-words scrub
 *    (completion-comms-context scrubCustomerText: pest talk only, access
 *    details dropped, credential-shaped tokens masked) and the banned
 *    customer-copy screen before they render; the card never shows raw text.
 *    Without the scrub the words are left out (chips only), like
 *    bookedReasonBlock. Capped at MAX_REQUEST_CHARS.
 *  - Quote rule (decided HERE, from the frozen source, never by the client):
 *    'picker' and 'text' are the customer's verbatim words and are quoted;
 *    'call' is a paraphrase and reads "On your call, you mentioned …" with no
 *    quote marks; 'office' is staff-entered and reads "As reported to our
 *    office: …", never quoted. An unknown or missing source cannot pick a
 *    rule, so it shows no words.
 *  - "What we did" prints only for a PERFORMED callback (outcome 'treated').
 *    inspection_only / customer_declined / incomplete performed no (or an
 *    uncertain) application, so the card never claims "treated" for them;
 *    "You told us" may still show. Pests come from the product rows' targets,
 *    where from areas_serviced, activity from the technician's own tapped
 *    rating (never an untouched first-visit default, never a customer rating),
 *    and the safety line only when a wet application was recorded — the same
 *    helpers the fixed re-service text uses (reservice-fixed-recap.js).
 *    Products themselves stay in the report's product section.
 *  - `stillSeeing` is only the TOPIC for the "Still seeing X? Tell us" button;
 *    the client links it to the report's existing authenticated portal
 *    Schedule path when reserviceEligible. No token or URL is minted here.
 */

'use strict';

const { whereOf, pestsOf, hasLiquidApplication, SAFETY_LINE } = require('../reservice-fixed-recap');
const { pestLabels, normalizeRequestPests } = require('../reservice-request');
const ActivityIndicators = require('./activity-indicators');
const { activityScaleNames } = require('../pest-pressure/label');

const GATE_ENV = 'GATE_RESERVICE_REPORT_CARD';
function reserviceReportCardGateOn() {
  return process.env[GATE_ENV] === 'true';
}

const CARD_VERSION = 1;
const FROZEN_VERSION = 1;
// The picker box caps at 400; the card shows a shorter excerpt so the words
// stay a line or two. Cut at a word boundary with an ellipsis.
const MAX_REQUEST_CHARS = 280;
const MAX_FROZEN_CHARS = 400;
const REQUEST_SOURCES = new Set(['picker', 'text', 'call', 'office']);
const NOT_PERFORMED_OUTCOMES = new Set(['inspection_only', 'customer_declined', 'incomplete']);

const CALL_LEAD = 'On your call, you mentioned';
const OFFICE_LEAD = 'As reported to our office:';

const compact = (value) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim();

function parseMaybeJson(value) {
  if (!value) return null;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return null; }
}

function asStringArray(value) {
  const parsed = parseMaybeJson(value);
  return (Array.isArray(parsed) ? parsed : []).filter((item) => typeof item === 'string');
}

/**
 * The request as it stands on the locked scheduled_services row at
 * completion, in the shape stored under service_data.reserviceRequest. Pure.
 * Returns null for a non-callback visit or one with nothing on file, so
 * ordinary visits never carry the key.
 */
function freezeReserviceRequest(row) {
  if (!row || row.is_callback !== true) return null;
  const text = compact(row.customer_request).slice(0, MAX_FROZEN_CHARS);
  const source = REQUEST_SOURCES.has(row.customer_request_source) ? row.customer_request_source : null;
  const pests = asStringArray(row.customer_request_pests);
  if (!text && !pests.length) return null;
  return {
    version: FROZEN_VERSION,
    text: text || null,
    source: text ? source : null,
    pests,
  };
}

function readFrozenReserviceRequest(service) {
  const data = parseMaybeJson(service?.service_data);
  const frozen = data && typeof data === 'object' ? data.reserviceRequest : null;
  return frozen && typeof frozen === 'object' && Number(frozen.version) >= 1 ? frozen : null;
}

let cachedScrub;
// The report writer's customer-words scrub (the one admin-schedule hands
// bookedReasonBlock). Loaded lazily: it pulls the DB layer, which a unit test
// of the pure paths should not need. null = unavailable, and the words are
// left out rather than shown raw.
function defaultScrub() {
  if (cachedScrub === undefined) {
    try {
      cachedScrub = require('../completion-comms-context').scrubCustomerText;
    } catch {
      cachedScrub = null;
    }
    if (typeof cachedScrub !== 'function') cachedScrub = null;
  }
  return cachedScrub;
}

function capWords(text) {
  if (text.length <= MAX_REQUEST_CHARS) return text;
  const cut = text.slice(0, MAX_REQUEST_CHARS);
  const space = cut.lastIndexOf(' ');
  const base = (space > MAX_REQUEST_CHARS * 0.6 ? cut.slice(0, space) : cut).replace(/[\s.,;:!?-]+$/, '');
  return `${base}…`;
}

function lowerFirst(text) {
  // "Ants in the kitchen" -> "ants in the kitchen"; "I saw ants" and
  // "ANTS" (shouted / acronym-like) keep their case.
  return /^[A-Z][a-z]/.test(text) && !/^I(?:['’](?:m|ve|d|ll))?\b/.test(text)
    ? text[0].toLowerCase() + text.slice(1)
    : text;
}

function withPeriod(text) {
  return /[.!?…]$/.test(text) ? text : `${text}.`;
}

function scrubbedWords(raw, scrub, lane) {
  if (typeof scrub !== 'function') return '';
  let words = '';
  try {
    words = compact(scrub(compact(raw), { lane }));
  } catch {
    return '';
  }
  if (!words) return '';
  // Our own safety/timing claims never ride on the customer's behalf.
  if (ActivityIndicators.findBannedCustomerCopy(words).length) return '';
  return capWords(words);
}

// A paraphrase written ABOUT the customer ("Fire ants biting her feet", "The
// caller suspects …", "Needs a WDO inspection" — the AI call summary's usual
// voice, read from production 2026-10-01) cannot sit under "On your call,
// you mentioned" or "As reported to our office" addressed to that customer.
// Such words are left out; the pest chips still show.
// "they / them / their" are left out on purpose: in a pest complaint they
// usually mean the pests ("Ants in the kitchen; they keep coming back").
const THIRD_PERSON_RE = /\b(caller|customer|client|homeowner|tenant|she|her|hers|he|him|his)\b/i;
const SUBJECTLESS_LEAD_RE = /^(wants|needs|asked|asks|requested|requests|reports|reported|is|was|has|had|would|says|said|called)\b/i;

function readsAsAddressedToCustomer(words) {
  return !THIRD_PERSON_RE.test(words) && !SUBJECTLESS_LEAD_RE.test(words.trim());
}

function buildYouToldUs(frozen, lane, scrub) {
  if (!frozen) return null;
  let words = frozen.text && REQUEST_SOURCES.has(frozen.source) ? scrubbedWords(frozen.text, scrub, lane) : '';
  // Paraphrases only: the customer's own verbatim words are theirs to phrase.
  if (words && (frozen.source === 'call' || frozen.source === 'office') && !readsAsAddressedToCustomer(words)) words = '';
  // Canonical order, lane-valid keys only (the picker's own normalizer).
  const pests = pestLabels(normalizeRequestPests(asStringArray(frozen.pests), lane) || [], lane);
  if (!words && !pests.length) return null;
  if (!words) return { source: frozen.source || null, quoted: false, lead: null, text: null, pests };
  if (frozen.source === 'call') {
    return { source: 'call', quoted: false, lead: CALL_LEAD, text: withPeriod(lowerFirst(words)), pests };
  }
  if (frozen.source === 'office') {
    return { source: 'office', quoted: false, lead: OFFICE_LEAD, text: words, pests };
  }
  // picker / text: the customer's verbatim words.
  return { source: frozen.source, quoted: true, lead: null, text: words, pests };
}

function productRows(products) {
  return (Array.isArray(products) ? products : []).map((row) => ({
    application_method: row?.application_method ?? row?.applicationMethod,
    targets: asStringArray(row?.targets),
  }));
}

// The technician's own tap, worded on the same scale the gauge uses. An
// untouched first-visit default and a customer's own rating say nothing about
// what this visit found, so neither counts. Pest line only (lawn re-services
// carry no activity tap).
function foundActivity(service, lane, labels) {
  if (lane !== 'pest') return null;
  if (service?.client_pest_rating == null || service.client_pest_rating === '') return null;
  const rating = Number(service.client_pest_rating);
  if (!Number.isInteger(rating) || rating < 0 || rating > 5) return null;
  if (String(service.client_pest_rating_source || '').toLowerCase() !== 'technician') return null;
  // Only an explicit false proves a real tap: records completed between the
  // first-visit default (2026-09-24) and its flag column (2026-09-29) carry
  // NULL, and an untouched default must never print as a finding.
  if (service.client_pest_rating_defaulted !== false) return null;
  const name = activityScaleNames(Array.isArray(labels) ? labels : null)[rating];
  return name ? { rating, label: name.charAt(0).toUpperCase() + name.slice(1) } : null;
}

function buildWhatWeDid(service, block, { products, areas, pestPressureLabels }) {
  if (block.outcome !== 'treated' || NOT_PERFORMED_OUTCOMES.has(block.outcome)) return null;
  const rows = productRows(products);
  const pests = pestsOf(rows);
  const where = whereOf(asStringArray(areas));
  const found = foundActivity(service, block.serviceLine, pestPressureLabels);
  const safetyLine = hasLiquidApplication(rows) ? SAFETY_LINE : null;
  if (!pests.length && !where && !found && !safetyLine) return null;
  return { pests, where: where || null, found, safetyLine };
}

function stillSeeingTopic(lane, whatWeDid, youToldUs) {
  if (lane === 'lawn') return 'problem areas';
  const named = whatWeDid?.pests?.length
    ? whatWeDid.pests
    : (youToldUs?.pests || []).filter((label) => label !== 'Something else').map((label) => label.toLowerCase());
  if (named.length === 1) return named[0];
  if (named.length === 2) return `${named[0]} or ${named[1]}`;
  return 'activity';
}

/**
 * Payload block for a performed/non-performed callback, or null while the
 * gate is dark / no reserviceReport block composed. Returned whenever the
 * gate is on and the block exists — even with both sections empty — so the
 * PDF cache signature (reservice-report.js) agrees with the render.
 *
 * @param {object} service  the report's joined service_records row
 * @param {object} args
 * @param {object|null} args.block   buildReserviceReport's result
 * @param {Array} args.products      service_products rows (targets, application_method)
 * @param {Array|string} args.areas  service_records.areas_serviced
 * @param {Array} [args.pestPressureLabels] the active Pest Pressure label set
 * @param {Function} [args.scrub]    override the customer-words scrub (tests)
 */
function buildReserviceReportCard(service = {}, {
  block = null, products = [], areas = null, pestPressureLabels = null, scrub,
} = {}) {
  if (!reserviceReportCardGateOn()) return null;
  if (!block || typeof block !== 'object') return null;
  const lane = block.serviceLine === 'lawn' ? 'lawn' : 'pest';
  const youToldUs = buildYouToldUs(readFrozenReserviceRequest(service), lane, scrub === undefined ? defaultScrub() : scrub);
  const whatWeDid = buildWhatWeDid(service, { ...block, serviceLine: lane }, {
    products,
    areas: areas ?? service.areas_serviced,
    pestPressureLabels,
  });
  return {
    version: CARD_VERSION,
    youToldUs,
    whatWeDid,
    stillSeeing: stillSeeingTopic(lane, whatWeDid, youToldUs),
  };
}

module.exports = {
  CARD_VERSION,
  MAX_REQUEST_CHARS,
  CALL_LEAD,
  OFFICE_LEAD,
  reserviceReportCardGateOn,
  freezeReserviceRequest,
  readFrozenReserviceRequest,
  buildReserviceReportCard,
};
