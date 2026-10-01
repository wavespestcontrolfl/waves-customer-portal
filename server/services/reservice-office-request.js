/**
 * Office-booked re-service "Customer's words" (GATE_RESERVICE_OFFICE_REQUEST).
 *
 * The New Appointment modal, on a pest/lawn re-service, suggests what the
 * customer last told us — their latest INBOUND text or call note from the
 * last 72 hours — and lets staff drop it into an editable box. What staff
 * save lands in scheduled_services.customer_request / customer_request_source
 * (migration 20260927100000).
 *
 * Owner ruling 2026-09-26: exact words may be quoted, a call paraphrase is
 * shown without quotes. So the source is decided HERE, never by the client:
 * the client names the suggestion it used (id + kind), the server re-reads
 * that row, and 'text' / 'call' survive only when the saved words equal the
 * suggestion exactly. Everything else (typed, edited, a forged or stale or
 * another customer's suggestion id) is 'office'.
 */

const { detectSmsOptCommand, detectHelp } = require('./messaging/opt-out-detector');

const SUGGESTION_WINDOW_HOURS = 72;
// Same cap as call-recording-processor's pain_points slice and the column's
// 400-char contract.
const REQUEST_MAX_CHARS = 400;
// Newest rows scanned per source — a handful of skipped opt-out / empty rows
// must not hide the real message behind them.
const SCAN_LIMIT = 10;

// The two catalog rows an office booking may attach words to. rodent_trapping
// _followup is a callback too (re-service.js) but is not a customer-request
// lane (the pest/lawn pickers' chips are the only other writers).
const OFFICE_REQUEST_SERVICE_KEYS = new Set(['pest_re_service', 'lawn_re_service']);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

function isOfficeRequestServiceKey(serviceKey) {
  return !!serviceKey && OFFICE_REQUEST_SERVICE_KEYS.has(String(serviceKey));
}

// Trimmed, line endings normalized, capped. null when nothing is left.
function cleanRequestText(value) {
  const text = String(value == null ? '' : value).replace(/\r\n?/g, '\n').trim().slice(0, REQUEST_MAX_CHARS).trim();
  return text || null;
}

function windowFloor(now) {
  return new Date(now - SUGGESTION_WINDOW_HOURS * 3600 * 1000);
}

// An inbound text's words, or null when it is not something to suggest: an
// empty body, a STOP / opt-in keyword or natural-language opt-out, or HELP.
function smsSuggestionText(row) {
  const text = cleanRequestText(row?.message_body);
  if (!text) return null;
  if (detectSmsOptCommand(text).action) return null;
  if (detectHelp(text).help) return null;
  return text;
}

function parseExtraction(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try { return JSON.parse(value) || {}; } catch { return {}; }
}

// A call note's words: the extraction's pain_points when present, else the
// call summary. Spam / voicemail rows carry no customer words.
function callSuggestionText(row) {
  if (!row) return null;
  if (['spam', 'voicemail'].includes(String(row.processing_status || '').toLowerCase())) return null;
  if (String(row.call_outcome || '').toLowerCase() === 'spam') return null;
  const extraction = parseExtraction(row.ai_extraction);
  if (extraction.is_spam === true) return null;
  return cleanRequestText(extraction.pain_points) || cleanRequestText(row.call_summary);
}

function toIso(value) {
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// The newest suggestion for this customer — latest inbound text or call note
// within 72 hours, whichever is newer — or null. Read-only; only that
// customer's own sms_log / call_log rows are ever consulted.
async function pickSuggestion(conn, customerId, { now = Date.now() } = {}) {
  if (!customerId) return null;
  const floor = windowFloor(now);

  const smsRows = await conn('sms_log')
    .where({ customer_id: customerId, direction: 'inbound' })
    .where('created_at', '>=', floor)
    .orderBy('created_at', 'desc')
    .limit(SCAN_LIMIT)
    .select('id', 'message_body', 'created_at');
  const callRows = await conn('call_log')
    .where({ customer_id: customerId })
    .where('created_at', '>=', floor)
    .orderBy('created_at', 'desc')
    .limit(SCAN_LIMIT)
    .select('id', 'call_summary', 'ai_extraction', 'processing_status', 'call_outcome', 'created_at');

  const candidates = [];
  for (const row of smsRows || []) {
    const text = smsSuggestionText(row);
    const at = toIso(row.created_at);
    if (text && at) { candidates.push({ id: String(row.id), kind: 'text', text, at }); break; }
  }
  for (const row of callRows || []) {
    const text = callSuggestionText(row);
    const at = toIso(row.created_at);
    if (text && at) { candidates.push({ id: String(row.id), kind: 'call', text, at }); break; }
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => new Date(b.at) - new Date(a.at));
  return candidates[0];
}

// What to store for the staff-saved words: { text, source } or null when
// there is nothing to save. `source` is 'text' / 'call' only when the client
// named a suggestion that (a) belongs to this customer, (b) is an inbound
// row inside the 72-hour window, and (c) yields exactly these words;
// otherwise 'office'. A failed lookup also lands on 'office' — the safe
// direction (never quoted).
async function resolveCustomerRequest(conn, customerId, input, { now = Date.now() } = {}) {
  const text = cleanRequestText(input?.text);
  if (!text) return null;
  const kind = input?.suggestionKind;
  const id = input?.suggestionId;
  if ((kind !== 'text' && kind !== 'call') || !isUuid(id)) {
    return { text, source: 'office' };
  }
  try {
    const floor = windowFloor(now);
    let suggested = null;
    if (kind === 'text') {
      const row = await conn('sms_log')
        .where({ id, customer_id: customerId, direction: 'inbound' })
        .where('created_at', '>=', floor)
        .first('id', 'message_body', 'created_at');
      suggested = row ? smsSuggestionText(row) : null;
    } else {
      const row = await conn('call_log')
        .where({ id, customer_id: customerId })
        .where('created_at', '>=', floor)
        .first('id', 'call_summary', 'ai_extraction', 'processing_status', 'call_outcome', 'created_at');
      suggested = row ? callSuggestionText(row) : null;
    }
    return { text, source: suggested && suggested === text ? kind : 'office' };
  } catch {
    return { text, source: 'office' };
  }
}

module.exports = {
  SUGGESTION_WINDOW_HOURS,
  REQUEST_MAX_CHARS,
  OFFICE_REQUEST_SERVICE_KEYS,
  isUuid,
  isOfficeRequestServiceKey,
  cleanRequestText,
  smsSuggestionText,
  callSuggestionText,
  pickSuggestion,
  resolveCustomerRequest,
};
