/**
 * Re-service asks (GATE_RESERVICE_ASKS, step S1 of the consolidated
 * re-service report, owner-approved 2026-11-02).
 *
 * Gathers every message in which a customer described the problem behind a
 * pest or lawn re-service: the booking words, inbound texts, calls, emails
 * from 10 days before the booking to now. A later step
 * shows them on the technician's sheet and on the report. Read-only.
 *
 * Every item passes the report writer's customer-words scrub in its
 * 'reservice' lane (completion-comms-context.js): access details dropped,
 * credential-shaped tokens masked, and only sentences about the pest or lawn
 * problem, the product used, or who in the home it affects kept. Nothing here
 * is a finding; each item says how it may be shown (quoted or paraphrased).
 */

const db = require('../models/db');
const { officeOnlyReason } = require('./reservice-office-only');
const logger = require('./logger');
const { detectServiceLine } = require('./service-report/service-line-configs');
const { excludeUnresolvedSendReservations } = require('./messaging/review-ask-reservation');
const { whereNotSandboxCall } = require('./voice-agent/relay-protocol');
const { stripQuotedAndSignature, emailPlainText } = require('./email/email-strip');
const { normalizeRequestPests, pestLabels } = require('./reservice-request');
const { smsSuggestionText, callSuggestionText, callRequestQuotes } = require('./reservice-office-request');
const { scrubCustomerText } = require('./completion-comms-context');
const { PEST_TARGET_SUGGESTIONS } = require('../config/treatment-target-vocabulary');

const ASKS_LOOKBACK_DAYS = 10;
const MAX_ITEMS = 10;
const MAX_TEXT_CHARS = 280;
// Rows read per channel (newest first); the item cap applies after the scrub.
const CHANNEL_ROW_LIMIT = 50;
const DAY_MS = 24 * 60 * 60 * 1000;

const RESERVICE_SERVICE_KEYS = new Set(['pest_re_service', 'lawn_re_service']);
const RODENT_FOLLOWUP_KEY = 'rodent_trapping_followup';
// The columns reservice-office-request.js reads for the same rows.
const SMS_COLUMNS = ['id', 'message_body', 'message_type', 'created_at'];
const CALL_COLUMNS = ['id', 'call_summary', 'ai_extraction', 'ai_extraction_enriched', 'v2_extraction_status', 'processing_status', 'call_outcome', 'answered_by', 'created_at'];

const CALL_LEAD = 'On your call, you mentioned';
const OFFICE_LEAD = 'As reported to our office:';
// What the booking flow appends to a notes line after the customer's words.
const NOTE_APPENDIX_RE = /\s+—\s+(?=Unit: |booked beside |self-booked plan |first visit reserved |auto-seeded )/;
const LEGACY_NOTE_RE = /^Re-service request(?: \([^)]*\))?: (.+)$/;

// ---------------------------------------------------------------------------
// Pure helpers

const compact = (value) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim();

function toIso(value) {
  const d = value instanceof Date ? value : new Date(value);
  return value == null || Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// A re-service: a callback, or the catalog's pest / lawn re-service key. The
// rodent trapping follow-up is a callback too but never one of these.
function isReserviceVisit(visit) {
  if (visit?.service_key === RODENT_FOLLOWUP_KEY) return false;
  return visit?.is_callback === true || RESERVICE_SERVICE_KEYS.has(visit?.service_key);
}

function laneOf(visit) {
  if (visit.service_key === 'lawn_re_service') return 'lawn';
  return detectServiceLine(visit.service_type) === 'lawn' ? 'lawn' : 'pest';
}

function normalizedWords(text) {
  return compact(text).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

// Cut at a word boundary with an ellipsis; the result never exceeds the cap.
function capWords(text, max = MAX_TEXT_CHARS) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  const base = (space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s.,;:!?-]+$/, '');
  return `${base}…`;
}

// The calendar day of a call in Eastern time ("Oct 25").
function callDay(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' });
}

function parseJson(value) {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return null; }
}

// Canonical pest names for the picker vocabulary: a whole name ("Fire ants")
// when the text names it, otherwise the family its last word names ("Ants").
// Singular and plural both match.
const singular = (word) => (/(?:mice|lice|fish)$/.test(word)
  ? word
  : word.replace(/ies$/, 'y').replace(/(ch|sh|x|o)es$/, '$1').replace(/s$/, ''));
const capitalize = (text) => text.charAt(0).toUpperCase() + text.slice(1);
const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const PEST_ALIASES = { roach: 'Cockroaches', roaches: 'Cockroaches', mouse: 'Mice' };

function buildPestIndex() {
  const names = new Map();
  const families = new Map();
  for (const target of PEST_TARGET_SUGGESTIONS) {
    for (const part of target.split(/\s*[&/()]\s*/).map((p) => p.trim()).filter(Boolean)) {
      const words = part.toLowerCase().split(/[\s-]+/);
      const head = words[words.length - 1];
      if (words.length > 1) names.set(capitalize(part), words);
      if (head.length >= 3 && !families.has(singular(head))) families.set(singular(head), capitalize(head));
    }
  }
  for (const [alias, label] of Object.entries(PEST_ALIASES)) families.set(alias, label);
  return { names, families };
}
const PEST_INDEX = buildPestIndex();

// Every spelling of one pest word: as written, its singular, and that singular's plurals, so "flies" and "fly",
// "roaches" and "roach" all match (Codex P2 on #7464: "drain flies" once matched nothing, because the singular
// "fly" plus s/es never spells "flies").
function wordForms(word) {
  const one = singular(word);
  const forms = new Set([word, one, `${one}s`]);
  if (/(?:s|x|ch|sh|o)$/.test(one)) forms.add(`${one}es`);
  if (/[^aeiou]y$/.test(one)) forms.add(`${one.slice(0, -1)}ies`);
  return `(?:${[...forms].sort((a, b) => b.length - a.length).map(escapeRe).join('|')})`;
}
const nameRe = (words) => new RegExp(`\\b${words.map((w, i) => (i === words.length - 1 ? wordForms(w) : escapeRe(w))).join('[\\s-]+')}\\b`, 'i');
const PEST_NAME_RES = [...PEST_INDEX.names].map(([label, words]) => [label, nameRe(words)]);
const PEST_FAMILY_RES = [...PEST_INDEX.families].map(([key, label]) => [label, new RegExp(`\\b${wordForms(key)}\\b`, 'i')]);

function pestsIn(text) {
  const found = [];
  const familiesNamed = new Set();
  for (const [label, re] of PEST_NAME_RES) {
    if (re.test(text)) {
      found.push(label);
      familiesNamed.add(capitalize(label.split(/[\s-]+/).pop()));
    }
  }
  for (const [label, re] of PEST_FAMILY_RES) {
    if (!familiesNamed.has(label) && re.test(text) && !found.includes(label)) found.push(label);
  }
  return found;
}

// A raw customer line to a finished item, or null when nothing relevant is
// left after the scrub. `lead` and `quoted` come from the source's rules.
// `officeOnly` (only when set) is the office-only screen's verdict on the
// ORIGINAL words: the scrub keeps pest talk only and the caps cut the tail, so
// "Ants are back. I want a refund." would reach a later screen as "Ants are
// back." (reservice-office-only.js). `screenText` is the source's whole text
// when its reader already capped `text` (a text's body, a call's quotes). It
// freezes with the item.
function buildItem({ id, source, at, text, quoted, lead = null, screenText = null }) {
  const iso = toIso(at);
  if (!iso) return null;
  const scrubbed = capWords(compact(scrubCustomerText(text, { lane: 'reservice' })));
  if (!scrubbed) return null;
  const officeOnly = officeOnlyReason(screenText || text);
  return {
    id,
    source,
    at: iso,
    text: scrubbed,
    quoted,
    lead,
    kind: scrubbed.includes('?') ? 'question' : 'problem',
    pests: pestsIn(scrubbed),
    ...(officeOnly ? { officeOnly } : {}),
  };
}

// The words a legacy booking carried only in its notes ("Self-booked. Notes:
// Re-service request: ants are back — Unit: 5").
function legacyRequestText(notes) {
  for (const segment of String(notes || '').split('\n')) {
    const line = segment.trim().replace(/^Self-booked\.\s*Notes:\s*/, '').split(NOTE_APPENDIX_RE)[0];
    const match = LEGACY_NOTE_RE.exec(line.trim());
    if (match) return compact(match[1]);
  }
  return null;
}

// The booking's own words as { source, text, quoted, lead } before the scrub,
// or null. Quote rule (owner 2026-09-26): the picker and a text are the
// customer's exact words; a call is a paraphrase and office words are staff's.
function bookingWords(visit, lane) {
  const words = compact(visit.customer_request);
  const source = visit.customer_request_source;
  if (words) {
    if (source === 'picker') return { source: 'request_form', text: words, quoted: true, lead: null };
    if (source === 'text') return { source: 'text', text: words, quoted: true, lead: null };
    if (source === 'call') return { source: 'call', text: words, quoted: false, lead: CALL_LEAD };
    if (source === 'office') return { source: 'office', text: words, quoted: false, lead: OFFICE_LEAD };
    return null;
  }
  const keys = normalizeRequestPests(parseJson(visit.customer_request_pests), lane);
  const labels = keys ? pestLabels(keys, lane) : [];
  if (labels.length) return { source: 'request_form', text: `Picked: ${labels.join(', ')}`, quoted: false, lead: null };
  if (visit.customer_request != null) return null;
  const legacy = legacyRequestText(visit.notes);
  return legacy ? { source: 'request_form', text: legacy, quoted: true, lead: null } : null;
}

// Everything over the cap goes except the booking item and the newest others.
function limitItems(items, bookingId) {
  const byTime = (a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id.localeCompare(b.id));
  const sorted = [...items].sort(byTime);
  if (sorted.length <= MAX_ITEMS) return sorted;
  const booking = sorted.find((item) => item.id === bookingId);
  const others = sorted.filter((item) => item !== booking);
  const keep = others.slice(others.length - (MAX_ITEMS - (booking ? 1 : 0)));
  return (booking ? [booking, ...keep] : keep).sort(byTime);
}

// Mail Waves sent (the SENT label or a Waves address); the query leaves it
// out and this guards the rows.
function wavesSentEmail(row) {
  const labels = Array.isArray(row?.label_ids) ? row.label_ids : [];
  return labels.includes('SENT') || /@wavespestcontrol\.com\s*>?\s*$/i.test(String(row?.from_address || ''));
}

// ---------------------------------------------------------------------------
// Channel readers. Each returns raw { id, source, at, text, quoted, lead }
// candidates; the scrub and caps happen once, in buildItem.

async function readTexts(knex, customerId, window, bookingKeys) {
  const rows = await excludeUnresolvedSendReservations(knex('sms_log')
    .where({ customer_id: customerId, direction: 'inbound' }))
    .where('created_at', '>=', window.from)
    .where('created_at', '<=', window.to)
    .select(SMS_COLUMNS)
    .orderBy('created_at', 'desc')
    .limit(CHANNEL_ROW_LIMIT);
  const candidates = [];
  for (const row of rows || []) {
    const text = smsSuggestionText(row);
    if (!text || bookingKeys.has(normalizedWords(text))) continue;
    candidates.push({ id: `text:${row.id}`, source: 'text', at: row.created_at, text, quoted: true, screenText: row.message_body });
  }
  return candidates;
}

// Inbound calls only, as the office suggestion reads them (reservice-office-request.js): on a call Waves placed, the
// extraction's 'caller' speaker is Waves, so its lines are not the customer's words.
async function readCalls(knex, customerId, window) {
  const rows = await whereNotSandboxCall(knex('call_log')
    .where({ customer_id: customerId, direction: 'inbound' })
    .where('created_at', '>=', window.from)
    .where('created_at', '<=', window.to))
    .select(CALL_COLUMNS)
    .orderBy('created_at', 'desc')
    .limit(CHANNEL_ROW_LIMIT);
  const candidates = [];
  for (const row of rows || []) {
    const text = callSuggestionText(row);
    if (!text) continue;
    candidates.push({
      id: `call:${row.id}`, source: 'call', at: row.created_at, text, quoted: false, lead: `On your call on ${callDay(row.created_at)}, you mentioned`,
      screenText: callRequestQuotes(row),
    });
  }
  return candidates;
}

async function readEmails(knex, customerId, window) {
  const rows = await knex('emails')
    .where({ customer_id: customerId })
    .where('received_at', '>=', window.from)
    .where('received_at', '<=', window.to)
    .whereRaw("NOT (COALESCE(label_ids, '[]'::jsonb) @> '[\"SENT\"]'::jsonb)")
    .whereRaw("COALESCE(from_address, '') NOT ILIKE '%@wavespestcontrol.com%'")
    .select('id', 'received_at', 'body_text', 'body_html', 'from_address', 'label_ids')
    .orderBy('received_at', 'desc')
    .limit(CHANNEL_ROW_LIMIT);
  return (rows || []).filter((row) => !wavesSentEmail(row)).map((row) => ({
    id: `email:${row.id}`, source: 'email', at: row.received_at, text: stripQuotedAndSignature(emailPlainText(row)), quoted: true,
  }));
}

// No service_requests channel (Codex P2 on #7464): that table mixes the portal form with server-written rows (the
// cancel flow's re-service request, estimate measurement reviews, promotion interest) in the same categories and
// without a source, so no column tells the customer's own words apart. A covered pest or lawn problem from the
// portal form goes to the re-service request form instead (GATE_RESERVICE_STREAMLINE), whose words are the
// booking words above.

// One failed channel logs its error code and yields nothing; the rest stand.
// A text, a call or an email names no property, so unless the account provably has ONE premises it may be about
// another one (a rental): such items stay on the sheet and the office bell but never print on this property's report
// (Codex security review on #7502; reservice-property-scope.js). An unproven account or a failed read is several.
async function accountMayHaveSeveralPremises(knex, customerId) {
  try {
    return !(await require('./reservice-property-scope').accountProvesSinglePremises(knex, customerId));
  } catch (err) {
    logger.warn(`[reservice-asks] premises proof unavailable: ${err?.code || err?.name || 'Error'}`);
    return true;
  }
}

async function safeChannel(name, read) {
  try {
    return await read();
  } catch (err) {
    logger.warn(`[reservice-asks] ${name} unavailable: ${err?.code || err?.name || 'Error'}`);
    return [];
  }
}

async function readVisit(knex, scheduledServiceId) {
  return knex('scheduled_services as ss')
    .leftJoin('services as catalog', 'catalog.id', 'ss.service_id')
    .where('ss.id', scheduledServiceId)
    .first('ss.id', 'ss.customer_id', 'ss.service_type', 'ss.is_callback', 'ss.created_at', 'ss.notes',
      'ss.customer_request', 'ss.customer_request_source', 'ss.customer_request_pests', 'catalog.service_key');
}

/**
 * Every customer message behind one re-service visit, oldest first.
 *
 * @returns {Promise<{ ok: false, reason: 'not_found'|'not_reservice' }
 *   | { ok: true, lane: 'pest'|'lawn', window: { from: string, to: string },
 *       items: object[] }>} The visit read may throw; a channel read never does.
 */
// One ask per wording, judged on the SCRUBBED text (Codex P2 on #7464): a text that repeats the booking words, or
// another channel's words, plus an off-topic sentence reads the same once the scrub drops that sentence, and a copy
// would use up the item allowance. The booking item wins, then the oldest copy.
function dedupeItems(items, bookingId) {
  const rank = (item) => (item.id === bookingId ? -Infinity : Date.parse(item.at));
  const seen = new Set();
  return [...items].sort((a, b) => rank(a) - rank(b)).filter((item) => {
    const key = normalizedWords(item.text);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function gatherReserviceAsks(scheduledServiceId, { knex = db, now = new Date() } = {}) {
  const visit = await readVisit(knex, scheduledServiceId);
  if (!visit) return { ok: false, reason: 'not_found' };
  if (!isReserviceVisit(visit)) return { ok: false, reason: 'not_reservice' };

  const lane = laneOf(visit);
  const to = now instanceof Date ? now : new Date(now);
  const bookedAt = new Date(visit.created_at);
  const anchor = Number.isNaN(bookedAt.getTime()) ? to : bookedAt;
  const window = { from: new Date(anchor.getTime() - ASKS_LOOKBACK_DAYS * DAY_MS), to };

  const booking = bookingWords(visit, lane);
  const bookingId = `booking:${visit.id}`;
  const bookingItem = booking ? buildItem({ id: bookingId, at: anchor, ...booking }) : null;
  // A text that repeats the booking words (before or after the scrub) is the
  // same ask, not a second one.
  const bookingKeys = new Set([booking && normalizedWords(booking.text), bookingItem && normalizedWords(bookingItem.text)].filter(Boolean));

  const customerId = visit.customer_id;
  const channels = customerId ? await Promise.all([
    safeChannel('sms', () => readTexts(knex, customerId, window, bookingKeys)),
    safeChannel('call', () => readCalls(knex, customerId, window)),
    safeChannel('email', () => readEmails(knex, customerId, window)),
  ]) : [];

  // `accountWide` (only when set): the visit's own booking words are this property's; the rest may not be.
  const severalProperties = customerId ? await accountMayHaveSeveralPremises(knex, customerId) : false;
  const items = [bookingItem, ...channels.flat().map(buildItem)].filter(Boolean)
    .map((item) => (severalProperties && item.id !== bookingId ? { ...item, accountWide: true } : item));
  return {
    ok: true,
    lane,
    window: { from: window.from.toISOString(), to: to.toISOString() },
    items: limitItems(dedupeItems(items, bookingId), bookingId),
  };
}

module.exports = {
  gatherReserviceAsks,
  isReserviceVisit,
  ASKS_LOOKBACK_DAYS,
  MAX_ITEMS,
  _test: {
    isReserviceVisit,
    laneOf,
    bookingWords,
    legacyRequestText,
    buildItem,
    dedupeItems,
    wordForms,
    capWords,
    callDay,
    pestsIn,
    limitItems,
    normalizedWords,
    wavesSentEmail,
  },
};
