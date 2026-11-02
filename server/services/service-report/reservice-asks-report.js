/**
 * Re-service asks report — "Your re-service": the customer's report block
 * built from the frozen `service_records.service_data.reserviceAsks`
 * (step S3a of the consolidated re-service report, owner-approved 2026-11-02).
 *
 * Dark behind GATE_RESERVICE_ASKS (exact 'true', read at CALL time via
 * reserviceAsksLive(), so a Railway flip changes the next render and the next
 * PDF cache key without a deploy). The block shows only when the gate is on,
 * the record carries a version-1 reserviceAsks block, and at least one item
 * has something to show. Then report-data.js adds the `reserviceAsksReport`
 * key and DROPS today's "You told us" / "What we did" card from that payload
 * (web and PDF both read the payload). Otherwise nothing changes: no new key,
 * today's card, and the PDF signature and fence strings stay as they were.
 *
 * What the block says (all wording is fixed here, nothing is invented):
 *  - Title, a summary line, then four cards: what you told us, what we did
 *    for each, products and how they help, what to expect (with the existing
 *    "Still seeing X? Tell us" topic).
 *  - An item shows only when it has an answer, the answer is not `hidden`,
 *    and officeOnlyReason(its words) is null. An unanswered item is left out.
 *  - The office's `not_today` reason (officeNotes) is never read here, and no
 *    customer payload, page or PDF can carry it.
 *  - Every free text re-runs the complete customer-copy screen at render
 *    (customerCopyViolations): the customer's words (a failure shows the
 *    row's label and no words) and the tech's typed answer (a failure drops
 *    the row from "What we did for each").
 *  - Pest reports name no treated areas (owner 2026-10-05, hidesTreatedAreas
 *    in the client), so "Where" is lawn only.
 */
'use strict';

const featureGates = require('../../config/feature-gates');
const { customerCopyViolations } = require('./technician-report-copy');
const { officeOnlyReason } = require('../reservice-office-only');
const { pestsOf } = require('../reservice-fixed-recap');
const {
  productRows, lawnWhereOf, stillSeeingTopic, KEY_LOCATION_RE, SAFETY_CLAIM_RE, readsAsAddressedToCustomer,
} = require('./reservice-report-card');

const VERSION = 1;
const TITLE = 'Your re-service';
const ET = 'America/New_York';

const SOURCE_LABELS = {
  request_form: 'Request form', text: 'Text', call: 'Call', office: 'Office', email: 'Email',
};
const ANSWER_KINDS = new Set(['treated', 'checked_none', 'noted', 'not_today', 'answered']);
const FIXED_LINES = {
  checked_none: ['Checked', 'We checked and found no activity there today.'],
  noted: ['Noted', 'We noted this on your service record.'],
  not_today: ['Follow-up', 'We will follow up on this one.'],
};

function parseMaybeJson(value) {
  if (!value) return null;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return null; }
}

function productCopyGateOn() {
  return require('./report-product-copy').reportProductCopyGateOn();
}

function asksGateOn() {
  return typeof featureGates.reserviceAsksLive === 'function' && featureGates.reserviceAsksLive() === true;
}

function readFrozenReserviceAsks(service) {
  const data = parseMaybeJson(service?.service_data);
  const frozen = data && typeof data === 'object' ? data.reserviceAsks : null;
  if (!frozen || typeof frozen !== 'object' || Number(frozen.version) !== VERSION) return null;
  return Array.isArray(frozen.items) ? frozen : null;
}

// The items the customer's report shows, each with its answer, in frozen order.
// officeNotes is never read.
function shownEntries(frozen) {
  const answers = frozen?.answers && typeof frozen.answers === 'object' ? frozen.answers : {};
  const entries = [];
  for (const item of frozen?.items || []) {
    if (!item || typeof item !== 'object' || typeof item.text !== 'string') continue;
    const answer = Object.prototype.hasOwnProperty.call(answers, item.id) ? answers[item.id] : null;
    if (!answer || typeof answer !== 'object' || !ANSWER_KINDS.has(answer.answer)) continue;
    // The verdict frozen from the ORIGINAL words (reservice-asks.js buildItem), then the shown words themselves.
    if (item.officeOnly || officeOnlyReason(item.text)) continue;
    entries.push({ item, answer });
  }
  return entries;
}

// A performed visit only. The freeze is completed-only (complete-scheduled-service.js), and this is the render's own
// check: a record whose outcome reads as an inspection, a decline or an incomplete visit (reservice-report.js
// outcomeOf, on the report's copy block) keeps today's card, which never claims a treatment for them. No copy block
// (GATE_RESERVICE_REPORT_COPY off): the freeze rule alone decides.
const performed = (block) => !block || !block.outcome || block.outcome === 'treated';

/** True when this record's report carries the asks block (gate on, performed, v1 freeze, something to show). */
function reserviceAsksReportApplies(service, block = null) {
  if (!asksGateOn() || !performed(block)) return false;
  const frozen = readFrozenReserviceAsks(service);
  return Boolean(frozen) && shownEntries(frozen).length > 0;
}

// PDF cache-key part: '' when the block does not apply (every existing key
// stays as it was). The approved product wording gate decides whether the
// "How it helps" lines print, so it moves the key too.
function reserviceAsksPdfPart(service, block = null) {
  if (!reserviceAsksReportApplies(service, block)) return '';
  return productCopyGateOn() ? '-ras1p' : '-ras1';
}

// Same, from the payload the render ACTUALLY used (store side).
function reserviceAsksRenderedPdfPart(data) {
  if (!asksGateOn()) return '';
  const block = data?.reserviceAsksReport;
  if (!block || typeof block !== 'object') return '';
  return productCopyGateOn() ? '-ras1p' : '-ras1';
}

// Render fence part: what outside the record can change what the block prints.
function reserviceAsksFenceStamp() {
  return asksGateOn() ? `|asks:${productCopyGateOn() ? 1 : 0}` : '';
}

function naturalJoin(items) {
  if (items.length <= 1) return items[0] || '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function monthDay(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: ET });
}

function plural(count, one, many) {
  return `${count} ${count === 1 ? one : many}`;
}

function summaryLine(entries) {
  const questions = entries.filter(({ item }) => item.kind === 'question').length;
  const things = entries.length - questions;
  const told = [];
  if (things > 0) told.push(`told us about ${plural(things, 'thing', 'things')}`);
  if (questions > 0) told.push(`asked ${plural(questions, 'question', 'questions')}`);
  return `You ${told.join(' and ')}. Here is what we did for each.`;
}

function labelOf(item) {
  const date = monthDay(item.at);
  const name = item.kind === 'question' ? 'Your question' : SOURCE_LABELS[item.source];
  return [name, date].filter(Boolean).join(' · ');
}

// Today's card's egress screens, one sentence at a time (reservice-report-card.js): a sentence that says where a key,
// lockbox, remote or fob is, or that makes any pesticide-safety claim, never prints on this permanent, forwardable page.
function withoutAccessOrClaims(text) {
  return text.split(/(?<=[.!?])\s+/)
    .filter((sentence) => !KEY_LOCATION_RE.test(sentence) && !SAFETY_CLAIM_RE.test(sentence))
    .join(' ').trim();
}

// The customer's words as the card prints them, or '' (label only).
function wordsOf(item) {
  const raw = String(item.text || '').replace(/\s+/g, ' ').trim();
  if (!raw || item.printable === false) return '';
  const text = withoutAccessOrClaims(raw);
  if (!text) return '';
  const lead = typeof item.lead === 'string' ? item.lead.trim() : '';
  // A paraphrase written about the customer ("Customer says the ants are back") cannot sit under a lead addressed to
  // them; the customer's own quoted words are theirs to phrase (the card's rule).
  if (item.quoted !== true && lead && !readsAsAddressedToCustomer(text)) return '';
  const words = item.quoted === true ? `“${text}”` : (lead ? `${lead} ${text}` : text);
  return customerCopyViolations(words).length ? '' : words;
}

// Which message an answer is for: card 1's own label plus the first words that card printed, so three answers about
// ants still point at three messages ("Text · Oct 30 · “Ants are back in the kitchen”"). A message card 1 shows by
// its label only keeps the label; call and office words are never put in quotation marks.
const SUBJECT_WORDS = 6;
function subjectOf(item) {
  const label = labelOf(item);
  if (!wordsOf(item)) return label;
  const words = withoutAccessOrClaims(String(item.text || '').replace(/\s+/g, ' ').trim()).split(' ');
  const cut = words.slice(0, SUBJECT_WORDS).join(' ').replace(/[\s.,;:!?…]+$/, '');
  const short = words.length > SUBJECT_WORDS ? `${cut}…` : cut;
  return `${label} · ${item.quoted === true ? `“${short}”` : short}`;
}

// Zone letters mean nothing to a homeowner; the report's own product cards
// show zone LABELS, never the letters.
const ZONE_LETTER_RE = /^(?:zone\s*)?[a-d]\d?$/i;

function areasOf(rows, lane) {
  if (lane !== 'lawn') return '';
  const areas = [];
  for (const row of rows) {
    const raw = row.application_area ?? row.applicationArea ?? row.area;
    if (typeof raw !== 'string') continue;
    for (const part of raw.split(/[,;]/)) {
      const area = part.trim();
      if (area && !ZONE_LETTER_RE.test(area) && !areas.includes(area)) areas.push(area);
    }
  }
  const where = lawnWhereOf(areas);
  return where && customerCopyViolations(where).length === 0 ? where : '';
}

// Identity rule shared with the client (lib/product-application.js): a
// termite / rodent monitoring device or bait is a check, not a product used.
function isUsedProduct(row) {
  const identity = `${row.product_type || ''} ${row.product_category || ''} ${row.product_name || ''}`;
  const monitoring = /\b(termite|termitic\w*|rodent|rodentic\w*|rats?|mouse|mice)\b/i.test(identity);
  return !(monitoring && /station|cartridge|monitor|bait/i.test(identity));
}

function usableRows(products) {
  return (Array.isArray(products) ? products : [])
    .filter((row) => row && typeof row === 'object' && typeof row.product_name === 'string' && row.product_name.trim())
    .filter(isUsedProduct);
}

function treatedLine(answer, rows, lane) {
  const ids = new Set((Array.isArray(answer.productIds) ? answer.productIds : []).map(String));
  const used = rows.filter((row) => row.product_id != null && ids.has(String(row.product_id)));
  const names = [...new Set(used.map((row) => row.product_name.trim()))];
  if (!names.length) return 'We treated it today.';
  const where = areasOf(used, lane);
  return `We treated it with ${naturalJoin(names)}.${where ? ` Where: ${where}.` : ''}`;
}

function didRow(item, answer, rows, lane) {
  const subject = subjectOf(item);
  if (answer.answer === 'treated') return { chip: 'Treated', subject, line: treatedLine(answer, rows, lane) };
  if (answer.answer === 'answered') {
    const text = typeof answer.text === 'string' ? answer.text.replace(/\s+/g, ' ').trim() : '';
    // The tech's own sentence prints whole or not at all: a sentence the egress screens would drop drops the row.
    if (!text || withoutAccessOrClaims(text) !== text || customerCopyViolations(text).length) return null;
    return { chip: 'Answered', subject, line: text };
  }
  const fixed = FIXED_LINES[answer.answer];
  return fixed ? { chip: fixed[0], subject, line: fixed[1] } : null;
}

function productCards(rows, lane, city) {
  const cards = new Map();
  const copyOn = productCopyGateOn();
  const { reportProductCopyForApplicationProduct } = require('./report-product-copy');
  for (const row of rows) {
    const key = row.product_id != null && row.product_id !== '' ? `id:${row.product_id}` : `name:${row.product_name.trim().toLowerCase()}`;
    if (!cards.has(key)) cards.set(key, { name: row.product_name.trim(), rows: [], how: '' });
    const card = cards.get(key);
    card.rows.push(row);
    if (copyOn && !card.how) {
      const copy = reportProductCopyForApplicationProduct(row, city);
      if (copy && typeof copy.how_it_works === 'string') card.how = copy.how_it_works.trim();
    }
  }
  return [...cards.values()].map((card) => {
    const where = areasOf(card.rows, lane);
    return {
      name: card.name,
      where: where ? where.charAt(0).toUpperCase() + where.slice(1) : null,
      how: card.how || null,
    };
  });
}

/**
 * Payload block, or null (gate dark, no v1 freeze, nothing to show).
 *
 * @param {object} service  the report's joined service_records row
 * @param {object} args
 * @param {object|null} args.block   buildReserviceReport's result (expectation, outcome)
 * @param {Array} args.products      the report's service_products rows
 * @param {string} [args.city]       the visit's own city (approved product wording)
 */
function buildReserviceAsksReport(service = {}, { block = null, products = [], city } = {}) {
  if (!asksGateOn() || !performed(block)) return null;
  const frozen = readFrozenReserviceAsks(service);
  if (!frozen) return null;
  const entries = shownEntries(frozen);
  if (!entries.length) return null;
  const lane = frozen.lane === 'lawn' ? 'lawn' : 'pest';
  const rows = usableRows(products);
  const told = entries.map(({ item }) => ({ label: labelOf(item), words: wordsOf(item) || null, quoted: item.quoted === true }));
  const did = entries.map(({ item, answer }) => didRow(item, answer, rows, lane)).filter(Boolean);
  const named = block?.outcome === 'treated' ? pestsOf(productRows(rows)) : [];
  const toldPests = [...new Set(entries.flatMap(({ item }) => (Array.isArray(item.pests) ? item.pests : [])))];
  const expectation = typeof block?.expectation === 'string' && block.expectation.trim() ? block.expectation.trim() : null;
  return {
    version: VERSION,
    title: TITLE,
    lane,
    summary: summaryLine(entries),
    told,
    did,
    products: productCards(rows, lane, city),
    expectation,
    stillSeeing: stillSeeingTopic(lane, named.length ? { pests: named } : null, { pests: toldPests }),
  };
}

module.exports = {
  VERSION,
  TITLE,
  readFrozenReserviceAsks,
  reserviceAsksReportApplies,
  reserviceAsksPdfPart,
  reserviceAsksRenderedPdfPart,
  reserviceAsksFenceStamp,
  buildReserviceAsksReport,
};
