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
const { excludeUnresolvedSendReservations } = require('./messaging/review-ask-reservation');
// The same exclusions the canonical customer-words readers use
// (completion-comms-context.js CUSTOMER_WORDS_CHANNELS).
const { isSmsReaction } = require('./sms-intent');
const { whereNotSandboxCall } = require('./voice-agent/relay-protocol');
const ContextAggregator = require('./context-aggregator');

const SUGGESTION_WINDOW_HOURS = 72;
// Same cap as call-recording-processor's pain_points slice and the column's
// 400-char contract.
const REQUEST_MAX_CHARS = 400;
// Rows read per page while scanning a source newest-first. Paging continues
// until an eligible row is found or the 72-hour window runs out, so any
// number of skipped opt-out / HELP / spam rows never hides the real message.
const SCAN_PAGE = 25;

// The two catalog rows an office booking may attach words to. rodent_trapping
// _followup is a callback too (re-service.js) but is not a customer-request
// lane (the pest/lawn pickers' chips are the only other writers).
const OFFICE_REQUEST_SERVICE_KEYS = new Set(['pest_re_service', 'lawn_re_service']);

const CALL_COLUMNS = ['id', 'call_summary', 'ai_extraction', 'ai_extraction_enriched', 'v2_extraction_status', 'processing_status', 'call_outcome', 'answered_by', 'created_at'];
const SMS_COLUMNS = ['id', 'message_body', 'message_type', 'created_at'];

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
// empty body, a tapback (it quotes a Waves text, never the customer's own
// words), a STOP / opt-in keyword or natural-language opt-out, or HELP.
function smsSuggestionText(row) {
  if (row?.message_type === 'sms_reaction' || isSmsReaction(row?.message_body)) return null;
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
  // The voice pipeline records a voicemail in processing_status, call_outcome
  // or answered_by, so all three are checked.
  if (['spam', 'voicemail', 'wrong_number'].includes(String(row.call_outcome || '').toLowerCase())) return null;
  if (String(row.answered_by || '').toLowerCase() === 'voicemail') return null;
  // Spam / misdial classifications, legacy and validated V2 (the canonical
  // call reader's rule).
  if (ContextAggregator.isExcludedCall(row)) return null;
  const extraction = parseExtraction(row.ai_extraction);
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

  // Each source names its own table literally (the sms_log reader guard,
  // tests/sms-log-general-reader-source-guard.test.js, scans for it).
  const newestEligible = async (pageQuery, kind, textOf) => {
    for (let offset = 0; ; offset += SCAN_PAGE) {
      const rows = await pageQuery()
        .orderBy([{ column: 'created_at', order: 'desc' }, { column: 'id', order: 'desc' }])
        .offset(offset)
        .limit(SCAN_PAGE);
      for (const row of rows || []) {
        const text = textOf(row);
        const at = toIso(row.created_at);
        if (text && at) return { id: String(row.id), kind, text, at };
      }
      if (!rows || rows.length < SCAN_PAGE) return null;
    }
  };

  const candidates = [
    await newestEligible(() => conn('sms_log')
      .where({ customer_id: customerId, direction: 'inbound' })
      .where('created_at', '>=', floor)
      .modify(excludeUnresolvedSendReservations)
      .select(SMS_COLUMNS), 'text', smsSuggestionText),
    await newestEligible(() => whereNotSandboxCall(conn('call_log')
      .where({ customer_id: customerId, direction: 'inbound' })
      .where('created_at', '>=', floor))
      .select(CALL_COLUMNS), 'call', callSuggestionText),
  ].filter(Boolean);
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
        .modify(excludeUnresolvedSendReservations)
        .first(SMS_COLUMNS);
      suggested = row ? smsSuggestionText(row) : null;
    } else {
      const row = await whereNotSandboxCall(conn('call_log')
        .where({ id, customer_id: customerId, direction: 'inbound' })
        .where('created_at', '>=', floor))
        .first(CALL_COLUMNS);
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
