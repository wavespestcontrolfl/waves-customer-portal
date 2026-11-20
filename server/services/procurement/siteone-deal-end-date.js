'use strict';

/**
 * procurement/siteone-deal-end-date.js — the end date on each line of the Monday
 * "SiteOne deals" bell, read by Claude Haiku 5.5 (GATE_SITEONE_DEAL_AI_END_DATE, dark;
 * owner 2026-11-19 "B" on the "SiteOne Deal End Dates" scope page).
 *
 * The bell's date patterns read only the first 6,000 characters of an email and take its
 * earliest date. On the 11 real deal emails from Apr 6 to Nov 19 they were right on 6: an
 * end date in fine print past the cut, an end written in words ("ending on Thursday") and a
 * rep's time off went wrong. Here each deal email is read whole, links removed, and the model
 * answers with the end date and the email's own words for it. An answer is kept only when
 * those words are in the email, they name that day, and the day falls from the day the email
 * came to a year after it. Any miss (no API key, API error, refusal, a reply that is not the
 * JSON asked for, words not found, words for another day, a date out of range) leaves that
 * line on the date patterns.
 *
 * Spend: one Haiku call per deal email, at most MAX_READS a run, on the scheduled Monday run
 * only (the catch-up reruns use the date patterns). A read costs at most about $0.002 (20,000
 * characters in, 2,048 tokens out); the trial on the 11 emails cost $0.0002 to $0.0018 a
 * read. At about 2 deal emails a month that is under 1 cent a month; at the cap it is about
 * $0.04 a week. Every call is in the AI cost ledger (lane siteone_deal_end_date). Reads only;
 * writes nothing.
 */

const logger = require('../logger');
const MODELS = require('../../config/models');
const { ledgerCall, ledgerCallRejected } = require('../llm-dispatch-metrics');
const { anthropicText } = require('../llm/call');
const { anthropicMaxTokens, anthropicEffortConfig } = require('../llm/anthropic-wire');
const { etDateString } = require('../../utils/datetime-et');

let Anthropic = null;
try { Anthropic = require('@anthropic-ai/sdk'); } catch { Anthropic = null; }

// The whole email, read again for the deals only: SiteOne's promo text runs 8,000 to 23,000
// characters, most of it tracking links, and its HTML is 3 to 6 times the size of its text.
const BODY_TEXT_CHARS = 30000;
const BODY_HTML_CHARS = BODY_TEXT_CHARS * 6;
// What the model reads, links removed. The longest deal email in the trial was 15,215.
const MODEL_TEXT_CHARS = 20000;
// The most deals one run reads, newest first; the rest keep the date-pattern line.
const MAX_READS = 20;
// The end date must fall on or after the day the email came, and at most this many days later.
const MAX_DAYS_AHEAD = 366;
// The proof must be words (a letter, 8 characters at least, not a bare "30, 2026") and not a paragraph.
const QUOTE_MIN_CHARS = 8;
const QUOTE_MAX_CHARS = 300;

const SYSTEM_PROMPT = [
  "You read one vendor email for a pest control company's weekly list of supplier deals.",
  'Find when the offer in this email ends: the last day a buyer can get its price, discount, rebate, points or free item.',
  'Answer with JSON only, no other text: {"end_date": "YYYY-MM-DD" or null, "quote": "the exact words from the email that state that end, at most 160 characters" or null}.',
  'Not an offer end: a date the sender is away (PTO, out of office), the date an email was sent, an event or webinar date, a shipping or delivery date, the start of an offer.',
  'A price increase date counts as the end of the current price.',
  'If the email states no end, both values are null. Copy the quote character for character from the email.',
].join(' ');

const NAMED_ENTITIES = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", ndash: '\u2013', mdash: '\u2014',
  rsquo: '\u2019', lsquo: '\u2018', rdquo: '\u201d', ldquo: '\u201c', hellip: '\u2026',
  reg: '\u00ae', trade: '\u2122', copy: '\u00a9',
};
const codePoint = (n, whole) => (Number.isInteger(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : whole);
const decodeEntities = (s) => s
  .replace(/&#(\d{1,7});/g, (whole, n) => codePoint(Number(n), whole))
  .replace(/&#x([0-9a-f]{1,6});/gi, (whole, n) => codePoint(parseInt(n, 16), whole))
  .replace(/&([a-z]+);/gi, (whole, name) => NAMED_ENTITIES[name.toLowerCase()] ?? whole);

// The HTML scans below are linear on purpose: the body can be 180,000 characters, and a
// regex such as /<[^>]*>/ rescans the rest of the text from every "<" that has no ">".

// Drops each <script> or <style> block; an unclosed one ends the text.
function dropBlocks(html, tag) {
  const lower = html.toLowerCase();
  let out = '';
  let at = 0;
  for (;;) {
    const open = lower.indexOf(`<${tag}`, at);
    if (open === -1) return out + html.slice(at);
    out += `${html.slice(at, open)} `;
    const close = lower.indexOf(`</${tag}`, open);
    const end = close === -1 ? -1 : lower.indexOf('>', close);
    if (end === -1) return out;
    at = end + 1;
  }
}

// Tags out, line breaks kept (<br> and the end of a paragraph, div, row, item or heading).
const BREAK_TAG = /^(?:br\s*\/?|\/(?:p|div|tr|li|h[1-6]))\s*$/i;
function htmlText(html) {
  const body = dropBlocks(dropBlocks(html, 'script'), 'style');
  let out = '';
  let at = 0;
  for (;;) {
    const lt = body.indexOf('<', at);
    if (lt === -1) return out + body.slice(at);
    const gt = body.indexOf('>', lt);
    if (gt === -1) return out + body.slice(at, lt);
    out += body.slice(at, lt) + (BREAK_TAG.test(body.slice(lt + 1, gt)) ? '\n' : ' ');
    at = gt + 1;
  }
}

/**
 * The email as the model reads it: body_text, else body_html with tags removed (line breaks
 * kept); entities decoded, links removed, spaces and blank lines collapsed, capped.
 */
function endDateText(email) {
  const text = typeof email?.body_text === 'string' && email.body_text.trim() ? email.body_text : null;
  const raw = text ?? htmlText(typeof email?.body_html === 'string' ? email.body_html : '');
  return decodeEntities(raw)
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim()
    .slice(0, MODEL_TEXT_CHARS);
}

// Compare text the way a reader would: one space for any run of spaces, any case, and the
// usual typographic stand-ins (curly quotes, en and em dashes) equal to their plain forms.
const comparable = (s) => String(s || '')
  .normalize('NFKC')
  .replace(/[\u2010-\u2015\u2212]/g, '-')
  .replace(/[\u2018\u2019\u201b\u2032]/g, "'")
  .replace(/[\u201c\u201d\u201e\u2033]/g, '"')
  .replace(/\s+/g, ' ')
  .trim()
  .toLowerCase();
// A quote's own edges may gain or lose a period, an asterisk or quote marks.
const EDGE_MARKS = /^[\s"'.,;:!?*()-]+|[\s"'.,;:!?*()-]+$/g;

/** The first JSON object in the reply, or null. */
function parseAnswer(reply) {
  const body = String(reply || '');
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const answer = JSON.parse(body.slice(start, end + 1));
    return answer && typeof answer === 'object' && !Array.isArray(answer) ? answer : null;
  } catch {
    return null;
  }
}

const dayNumber = (iso) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / 86400000);
function isCalendarDay(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return false;
  const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return dt.getUTCFullYear() === Number(m[1]) && dt.getUTCMonth() === Number(m[2]) - 1 && dt.getUTCDate() === Number(m[3]);
}

// The quoted words must name the day. A calendar date in them must be that day (and that
// year, when they give one); with no calendar date, a weekday at most a week on, "today" /
// "tonight" or "tomorrow" must land on it. Words with no day in them prove nothing.
const NAMED_DATE = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.? ?(\d{1,2})(?:st|nd|rd|th)?\b(?:,? ?(20\d{2})\b)?/g;
const NUMERIC_DATE = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?\b/g;
const ISO_DATE = /\b(20\d{2})-(\d{2})-(\d{2})\b/g;
const MONTH_KEYS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/** Every calendar date the (comparable) words name, as { month, day, year } (year null when not given). */
function quoteDates(flat) {
  const named = [...flat.matchAll(NAMED_DATE)].map((m) => [MONTH_KEYS.indexOf(m[1].slice(0, 3)) + 1, m[2], m[3]]);
  const numeric = [...flat.matchAll(NUMERIC_DATE)].map((m) => [m[1], m[2], m[3] && m[3].length === 2 ? `20${m[3]}` : m[3]]);
  const iso = [...flat.matchAll(ISO_DATE)].map((m) => [m[2], m[3], m[1]]);
  return [...named, ...numeric, ...iso].map(([month, day, year]) => ({ month: Number(month), day: Number(day), year: year ? Number(year) : null }));
}

/** True when the words name endDate; `away` is its day count from the ET day the email came. */
function quoteNamesDay(flat, endDate, away) {
  const [year, month, day] = endDate.split('-').map(Number);
  const dates = quoteDates(flat);
  if (dates.length) return dates.some((d) => d.month === month && d.day === day && (d.year === null || d.year === year));
  const weekday = WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
  return (away <= 7 && new RegExp(`\\b${weekday}\\b`).test(flat))
    || (away === 0 && /\b(?:today|tonight)\b/.test(flat))
    || (away === 1 && /\btomorrow\b/.test(flat));
}

/**
 * Checks one parsed answer against the email. { ok: true, endDate, quote } (endDate null =
 * the email states no end), or { ok: false, reason }.
 */
function checkAnswer(answer, emailText, receivedAt) {
  if (!answer || !Object.prototype.hasOwnProperty.call(answer, 'end_date')) return { ok: false, reason: 'invalid_json' };
  // "No end" needs both values null: a quote beside a null date, or no quote key, is a malformed reply.
  if (answer.end_date === null) return answer.quote === null ? { ok: true, endDate: null, quote: null } : { ok: false, reason: 'half_null' };
  const endDate = typeof answer.end_date === 'string' ? answer.end_date.trim() : '';
  if (!isCalendarDay(endDate)) return { ok: false, reason: 'bad_date' };
  const away = dayNumber(endDate) - dayNumber(etDateString(new Date(receivedAt)));
  if (!(away >= 0 && away <= MAX_DAYS_AHEAD)) return { ok: false, reason: 'date_out_of_range' };
  const quote = typeof answer.quote === 'string' ? answer.quote.replace(/\s+/g, ' ').trim() : '';
  const flat = comparable(quote);
  // Length first: the edge trim below is quadratic on a long run of marks.
  if (flat.length > QUOTE_MAX_CHARS) return { ok: false, reason: 'no_quote' };
  const needle = flat.replace(EDGE_MARKS, '');
  if (needle.length < QUOTE_MIN_CHARS || !/[a-z]/.test(needle)) return { ok: false, reason: 'no_quote' };
  if (!comparable(emailText).includes(needle)) return { ok: false, reason: 'quote_not_found' };
  if (!quoteNamesDay(flat, endDate, away)) return { ok: false, reason: 'quote_date_mismatch' };
  return { ok: true, endDate, quote };
}

/** One model read of one email (its whole body on it). Never throws. */
async function readOne(client, email) {
  try {
    const received = new Date(email.received_at);
    const subject = String(email.subject || '').replace(/\s+/g, ' ').trim();
    const body = endDateText(email);
    if (!body && !subject) return { ok: false, reason: 'empty' };
    let response;
    try {
      response = await ledgerCall('anthropic', MODELS.DEAL_END_DATE, () => client.messages.create({
        model: MODELS.DEAL_END_DATE,
        ...anthropicEffortConfig(MODELS.DEAL_END_DATE),
        // Haiku 5.5 thinks by default and the thinking spends from this cap, so it is not sized to the reply alone.
        max_tokens: anthropicMaxTokens(MODELS.DEAL_END_DATE, 2048),
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: `Received: ${etDateString(received)} (US Eastern)\nSubject: ${subject}\n\n${body}` }],
      }), { laneId: 'siteone_deal_end_date' });
    } catch (err) {
      return { ok: false, reason: `api_${err?.status || err?.name || 'error'}` };
    }
    // The ledger files both of these as failed calls on its own.
    if (response?.stop_reason === 'refusal') return { ok: false, reason: 'refusal' };
    if (response?.stop_reason === 'max_tokens') return { ok: false, reason: 'max_tokens' };
    const read = checkAnswer(parseAnswer(anthropicText(response)), `${subject}\n${body}`, received);
    if (!read.ok) ledgerCallRejected(response, read.reason === 'invalid_json' ? 'invalid_json' : 'schema_invalid');
    return read;
  } catch (err) {
    logger.warn(`[siteone-deals] end-date read failed: ${err?.message || 'error'}`);
    return { ok: false, reason: 'error' };
  }
}

/**
 * Reads the end date of up to MAX_READS deal emails (newest first, as given). Resolves a Map
 * of email id -> { endDate, quote } for each kept answer; an email with no entry keeps the
 * date-pattern line. Never throws.
 */
async function readDealEndDates(conn, deals) {
  const found = new Map();
  const picked = (deals || []).slice(0, MAX_READS);
  if (!picked.length) return found;
  if (!Anthropic || !process.env.ANTHROPIC_API_KEY) {
    logger.warn('[siteone-deals] end dates not read by AI: no Anthropic API key');
    return found;
  }
  let bodies;
  try {
    const rows = await conn('emails')
      .select(
        'id',
        conn.raw('left(body_text, ?) as body_text', [BODY_TEXT_CHARS]),
        conn.raw('left(body_html, ?) as body_html', [BODY_HTML_CHARS]),
      )
      .whereIn('id', picked.map((email) => email.id));
    bodies = new Map(rows.map((row) => [row.id, row]));
  } catch (err) {
    logger.warn(`[siteone-deals] end dates not read by AI: email bodies not read: ${err.message}`);
    return found;
  }
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 30 * 1000, maxRetries: 0 });
  const misses = {};
  if (deals.length > picked.length) misses.over_cap = deals.length - picked.length;
  for (const email of picked) {
    const whole = bodies.get(email.id);
    const read = whole
      ? await readOne(client, { ...email, body_text: whole.body_text, body_html: whole.body_html })
      : { ok: false, reason: 'no_body' };
    if (read.ok) found.set(email.id, { endDate: read.endDate, quote: read.quote });
    else misses[read.reason] = (misses[read.reason] || 0) + 1;
  }
  const kept = Object.entries(misses).map(([reason, n]) => `${n} ${reason}`).join(', ');
  logger.info(`[siteone-deals] end dates: ${found.size} of ${deals.length} deals read by AI${kept ? `; date patterns kept for ${kept}` : ''}`);
  return found;
}

module.exports = {
  readDealEndDates,
  MAX_READS, BODY_TEXT_CHARS, BODY_HTML_CHARS, MODEL_TEXT_CHARS,
  _test: { endDateText, checkAnswer, parseAnswer, SYSTEM_PROMPT },
};
