'use strict';

/**
 * procurement/siteone-deal-end-date.js — the end date on each line of the Monday
 * "SiteOne deals" bell, read by Claude Haiku 5.5 (GATE_SITEONE_DEAL_AI_END_DATE, dark;
 * owner 2026-11-19 "B" on the "SiteOne Deal End Dates" scope page).
 *
 * The bell's date patterns read only the first 6,000 characters of an email and take its
 * earliest date. On the 11 real deal emails from Apr 6 to Nov 19 they were right on 6: an
 * end date in fine print past the cut, an end written in words ("ending on Thursday") and a
 * rep's time off went wrong. Here each deal email is read whole, links and quoted mail
 * removed, and the model answers with the end date, the email's own words for it, and whether
 * it is a price increase. An answer is kept only when those words are whole words of the
 * email, they name that day as the last day their sentence names (so not the first day of a
 * range; a date with no year is its next time on or after the day the email came), and the
 * day falls from the day the email came to a year after it. Any miss (no API key, API error,
 * refusal, a reply that is not the JSON asked for, words not found, words for another day, a
 * date out of range, words that run to a cap's cut, "no end" on an email the model did not
 * read whole, a subject over SUBJECT_CHARS) leaves that line on the date patterns.
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
const { stripQuotedHistory, NUMERIC_DATE, QUOTE_CHARS } = require('./deal-email-text');
const { HISTORY_HEADERS } = require('../email/email-strip');

let Anthropic = null;
try { Anthropic = require('@anthropic-ai/sdk'); } catch { Anthropic = null; }

// The whole email, read again for the deals only: SiteOne's promo text runs 8,000 to 23,000
// characters, most of it tracking links, and its HTML is 3 to 6 times the size of its text.
const BODY_TEXT_CHARS = 30000;
const BODY_HTML_CHARS = BODY_TEXT_CHARS * 6;
// What the model reads, links removed: the subject and the text together. The longest deal
// email in the trial was 15,215.
const MODEL_TEXT_CHARS = 20000;
// A subject is one line. One longer than this is not read at all (its line keeps the date
// patterns): a cut subject could end mid-date, "Ends May 3" of "May 30".
const SUBJECT_CHARS = 300;
// The most deals one run reads, newest first; the rest keep the date-pattern line.
const MAX_READS = 20;
// The end date must fall on or after the day the email came, and at most this many days later.
const MAX_DAYS_AHEAD = 366;
// The proof must be words (a letter, 8 characters at least, not a bare "30, 2026"), at most
// QUOTE_CHARS of them, so the bell line shows them whole.
const QUOTE_MIN_CHARS = 8;

const SYSTEM_PROMPT = [
  "You read one vendor email for a pest control company's weekly list of supplier deals.",
  'Find when the offer in this email ends: the last day a buyer can get its price, discount, rebate, points or free item.',
  'Answer with JSON only, no other text: {"end_date": "YYYY-MM-DD" or null, "quote": "the exact words from the email that state that end, at most 140 characters" or null, "price_increase": true or false}.',
  'Not an offer end: a date the sender is away (PTO, out of office), the date an email was sent, an event or webinar date, a shipping or delivery date, the start of an offer.',
  'A price increase ends the current price: then end_date is the day the new price starts and price_increase is true. Otherwise price_increase is false.',
  'If the email states no end, end_date and quote are null. Copy the quote character for character from the email.',
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

// Where the <blockquote> at `open` ends (just past its own closing tag), or -1 when it never closes.
function quoteEnd(lower, open) {
  let depth = 0;
  let nextOpen = open;
  let nextClose = lower.indexOf('</blockquote', open);
  while (nextClose !== -1) {
    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth += 1;
      nextOpen = lower.indexOf('<blockquote', nextOpen + 1);
    } else {
      depth -= 1;
      if (depth === 0) {
        const gt = lower.indexOf('>', nextClose);
        return gt === -1 ? -1 : gt + 1;
      }
      nextClose = lower.indexOf('</blockquote', nextClose + 1);
    }
  }
  return -1;
}

// Drops each <blockquote> whole, with any quote nested in it: mail clients put a quoted message
// in one, often with no "On ... wrote:" line. An unclosed one ends the text.
function dropQuotes(html) {
  const lower = html.toLowerCase();
  let out = '';
  let at = 0;
  for (;;) {
    const open = lower.indexOf('<blockquote', at);
    if (open === -1) return out + html.slice(at);
    out += `${html.slice(at, open)} `;
    at = quoteEnd(lower, open);
    if (at === -1) return out;
  }
}

// Tags out, line breaks kept (<br> and the end of a paragraph, div, row, item or heading).
const BREAK_TAG = /^(?:br\s*\/?|\/(?:p|div|tr|li|h[1-6]))\s*$/i;
function htmlText(html) {
  const body = dropQuotes(dropBlocks(dropBlocks(html, 'script'), 'style'));
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

// Links out, line ends unified, spaces and blank lines collapsed.
const flatten = (s) => s
  .replace(/https?:\/\/\S+/g, ' ')
  .replace(/\r\n?/g, '\n')
  .replace(/[ \t\u00a0]+/g, ' ')
  .replace(/ ?\n ?/g, '\n')
  .replace(/\n{2,}/g, '\n')
  .trim();

// A line that starts with ">" is quoted mail, also with no "On ... wrote:" line above it.
const QUOTED_LINE = /^>[^\n]*(?:\n|$)/gm;
// A subject that starts "Re:", "Fw:" or "Fwd:" is a reply's or forward's: the old email's subject.
const INHERITED_SUBJECT = /^(?:re|fwd?) ?:/i;

/**
 * The email as the model reads it: { subject, text, cut, partial }, or null when the subject
 * (links out, one line) runs past SUBJECT_CHARS. A reply's or forward's subject ("Re:", "Fwd:")
 * is the old email's, and its "tomorrow" was said on another day, so it is left out (''). The
 * text is body_text, else body_html with
 * tags removed (line breaks kept); entities decoded, links removed, spaces and blank lines
 * collapsed, and quoted mail dropped: reply history as the date patterns drop it, reply history
 * written inline (email-strip's HISTORY_HEADERS: "Thanks. On Apr 13, 2026 ... wrote: ..."), every
 * line that starts with ">", and in HTML every <blockquote>. It is capped at what the subject
 * leaves of MODEL_TEXT_CHARS. `cut` is true when a cap cut the end of the text: the body
 * re-read cap (unless it cut only reply history, which is dropped anyway) or the model cap.
 * `partial` is true when the model does not read all of the email: a cap cut it, the subject
 * was left out, or inline reply history, a quoted line or a <blockquote> was dropped (the date
 * patterns read those, and a <blockquote> may be a styled block of this email).
 */
function readableEmail(email) {
  const flat = flatten(String(email?.subject || '')).replace(/\n/g, ' ');
  if (flat.length > SUBJECT_CHARS) return null;
  const subject = INHERITED_SUBJECT.test(flat) ? '' : flat;
  const text = typeof email?.body_text === 'string' && email.body_text.trim() ? email.body_text : null;
  const html = typeof email?.body_html === 'string' ? email.body_html : '';
  const read = flatten(decodeEntities(text ?? htmlText(html)));
  const kept = stripQuotedHistory(read);
  // The headers are matched on the text as one line (same length), so a header wrapped onto two lines still cuts.
  const oneLine = kept.replace(/\n/g, ' ');
  const own = kept.slice(0, Math.min(...HISTORY_HEADERS.map((re) => re.exec(oneLine)?.index ?? kept.length)));
  const whole = own.replace(QUOTED_LINE, '').trim();
  const room = MODEL_TEXT_CHARS - subject.length;
  const readCut = own.length === read.length && (text !== null ? text.length >= BODY_TEXT_CHARS : html.length >= BODY_HTML_CHARS);
  const cut = readCut || whole.length > room;
  const dropped = subject !== flat || whole.length < kept.trim().length || (text === null && /<blockquote/i.test(html));
  return { subject, text: whole.slice(0, room), cut, partial: cut || dropped };
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

/**
 * The reply as one JSON object, or null. A Markdown code fence may wrap it; any other text, an
 * array or a second object is not the JSON asked for.
 */
function parseAnswer(reply) {
  let body = String(reply || '').trim();
  if (body.length > 6 && body.startsWith('```') && body.endsWith('```')) body = body.slice(0, -3).replace(/^```(?:json)?/i, '').trim();
  if (!body.startsWith('{')) return null;
  try {
    return JSON.parse(body);
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

// The quoted words must name the day. A calendar date in them must be that day, in the year
// they give, or with none in its next year on or after the day the email came; with no
// calendar date, a weekday at most a week on, "today" / "tonight" or "tomorrow" must land on
// it. Words with no day in them prove nothing.
// "March 1-30" names its closing day alone (group 3); "Mar 2 - 12/31" and "Nov 3 - 11:59 PM" do not.
const NAMED_DATE = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.? ?(\d{1,2})(?:st|nd|rd|th)?(?: ?(?:-|to|through|thru) ?(\d{1,2})(?:st|nd|rd|th)?(?![/\d:]))?\b(?:,? ?(20\d{2})\b)?/g;
const ISO_DATE = /\b(20\d{2})-(\d{2})-(\d{2})\b/g;
const MONTH_KEYS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
// The end of an offer is the last day its sentence names. A day in the words is not the end
// when a date or day word for another day follows it in the same sentence, at most RANGE_GAP
// characters on: then it may open a range ("March 1 - April 30", "11/1-11/30", "between March
// 1 and April 30", "Monday through Friday", "March 1 (Sunday) at 12:01 a.m. ET until close of
// business April 30"). A weekday that labels the day itself ("April 30 (Thursday)") is the same
// day. This leans to "not the end": a refused answer keeps the date-pattern line.
const RANGE_GAP = 48;
// A sentence ends at ". ", "! ", "? " or "; " before a letter; "a.m." and "p.m." do not end one.
const SENTENCE_END = /[.!?;] [a-z]/;
const oneSentence = (stretch) => !SENTENCE_END.test(stretch.replace(/\b([ap])\.m\./g, '$1m'));
// Beside dates, a day word names a day only as the close of a range that one of these words
// opens from the date right before it: "April 20 through Friday", "4/14 until tomorrow".
const RANGE_JOIN = /^ ?(?:-|to|through|thru|until|till) ?$/;
// A day word right after a date, with only these between, labels that date: "April 15 (Wednesday)", "4/15, Wed".
const LABEL_GAP = /^[ ,(]*$/;
// Words for a day without a date. A weekday may be cut short ("Fri.", "Tues", "Thurs").
const DAY_WORD = /\b(?:sun(?:day)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?|today|tonight|tomorrow)\b/g;

// "4/20-24" closes on the 24th, as "April 20-24" does: a closing day right after a numeric date with no year.
const NUMERIC_CLOSE = /^ ?(?:-|to|through|thru) ?(\d{1,2})(?:st|nd|rd|th)?(?![/\d:])\b/;
// A year written after a numeric date or its closing day is its year: "4/24, 2025", "4/20-24, 2025".
// It is read from 7 characters, one past ", 2025", so \b sees where the year ends.
const NUMERIC_YEAR = /^,? ?(20\d{2})\b/;

/** Each calendar date the (comparable) words name, in order: { at, end, month, day, year } (year null when not given). */
function quoteDates(text) {
  const numeric = (m) => {
    const after = m.index + m[0].length;
    const close = m[3] ? null : NUMERIC_CLOSE.exec(text.slice(after, after + 16));
    const tail = after + (close ? close[0].length : 0);
    const written = m[3] ? null : NUMERIC_YEAR.exec(text.slice(tail, tail + 7));
    const year = written ? written[1] : m[3] && (m[3].length === 2 ? `20${m[3]}` : m[3]);
    return [m, m[1], close ? close[1] : m[2], year, tail - after + (written ? written[0].length : 0)];
  };
  const found = [
    ...[...text.matchAll(NAMED_DATE)].map((m) => [m, MONTH_KEYS.indexOf(m[1].slice(0, 3)) + 1, m[3] || m[2], m[4], 0]),
    ...[...text.matchAll(NUMERIC_DATE)].map(numeric),
    ...[...text.matchAll(ISO_DATE)].map((m) => [m, m[2], m[3], m[1], 0]),
  ];
  return found
    .map(([m, month, day, year, more]) => ({ at: m.index, end: m.index + m[0].length + more, month: Number(month), day: Number(day), year: year ? Number(year) : null }))
    .sort((a, b) => a.at - b.at);
}

/** Each date and day word in the text, in order; a day word has `word` and `short`, a date has month, day and year. */
function dayMarks(text) {
  // A weekday cut short reads as its full name, so it closes a range ("Monday through Fri.") and
  // labels a date ("April 30 (Thu)"). It is `short`: it never names the end alone, as "sun" may be
  // the word ("Sun & Shade mix"). "Today", "tonight" and "tomorrow" read as themselves.
  const name = (word) => WEEKDAYS.find((w) => w.startsWith(word.slice(0, 3))) || word;
  const words = [...text.matchAll(DAY_WORD)].map((m) => {
    const word = name(m[0]);
    return { at: m.index, end: m.index + m[0].length, word, short: word !== m[0] };
  });
  return [...quoteDates(text), ...words].sort((a, b) => a.at - b.at);
}

/**
 * True when the words name endDate as the last day of their sentence; `away` is its day count
 * from the ET day the email came. `text` is a little of the email before the words, the words
 * (text.slice(wordsStart, wordsEnd)), and the email right after them, so a range the quote stops
 * short of still shows its first day as a start, and a date just before the words still has its
 * label. A date in the words decides; with none, a weekday at most a week on, "today"/"tonight"
 * or "tomorrow" must land on endDate. Beside dates, a day word counts only as a range's close.
 */
function quoteNamesDay({ text, wordsStart, wordsEnd }, endDate, away) {
  const [year, month, day] = endDate.split('-').map(Number);
  const end = Date.UTC(year, month - 1, day);
  const weekday = WEEKDAYS[new Date(end).getUTCDay()];
  const relative = { today: away === 0, tonight: away === 0, tomorrow: away === 1 };
  // A date with no year names endDate only as its next time on or after the day the email
  // came: on April 15, "April 15" is that day, never the one a year on.
  const came = new Date(end - away * 86400000);
  const comingYear = came.getUTCFullYear() + (month * 100 + day >= (came.getUTCMonth() + 1) * 100 + came.getUTCDate() ? 0 : 1);
  // Names endDate's day: its date, its weekday (also as a label), or a relative word that lands on it.
  const sameDay = (d) => (d.word
    ? d.word === weekday || relative[d.word] === true
    : d.month === month && d.day === day && (d.year ?? comingYear) === year);
  // Another date as a day: with no year, in the year that puts it nearest endDate, so a start
  // before the email came stays before ("April 13 through Friday", "Dec 28 through Friday").
  const asDay = (d) => {
    if (d.year !== null) return Date.UTC(d.year, d.month - 1, d.day);
    const nearer = (a, b) => (Math.abs(b - end) < Math.abs(a - end) ? b : a);
    return [year - 1, year + 1].map((y) => Date.UTC(y, d.month - 1, d.day)).reduce(nearer, Date.UTC(year, d.month - 1, d.day));
  };
  const marks = dayMarks(text);
  const said = marks.filter((d) => d.at >= wordsStart && d.end <= wordsEnd);
  // A weekday names a day at most a week on, and never when cut short. Beside dates in the words, a day
  // word names a day only as a range's close: a RANGE_JOIN word joins it to the date right before it,
  // and it falls after every date there ("April 20 through Friday"). So a weekday set beside a date
  // labels that date ("April 15 (Wednesday)", "Friday, May 1") and names no other day.
  const dates = said.filter((d) => !d.word);
  const afterDates = dates.every((d) => asDay(d) < end);
  const closesRange = (d) => {
    const start = dates.filter((n) => n.end <= d.at).pop();
    return start !== undefined && afterDates && RANGE_JOIN.test(text.slice(start.end, d.at));
  };
  // A day word right after a date, in the words or just before them, labels that date and names no other day.
  const labels = (d) => marks.some((n) => !n.word && n.end <= d.at && LABEL_GAP.test(text.slice(n.end, d.at)));
  const named = said.filter((d) => sameDay(d) && (!d.word || (!d.short && !labels(d) && (d.word !== weekday || away <= 7) && (!dates.length || closesRange(d)))));
  // Another day after d in its sentence. The stretch takes that day's first letter, so ". Monday" ends the sentence.
  const anotherDayAfter = (d) => marks.some((n) => n.at >= d.end && n.at - d.end <= RANGE_GAP && !sameDay(n)
    && oneSentence(text.slice(d.end, n.at + 1)));
  return named.some((d) => !anotherDayAfter(d));
}

const WORD_CHAR = /[a-z0-9]/;
// A year the email writes right after a quoted day: "April 30" + ", 2027", "5/15" + "/27".
const YEAR_AFTER = /^(?:,? ?20\d{2}\b|\/(?:\d{4}|\d{2})\b)/;
// Room after the words for another day RANGE_GAP characters on, and that day's own words.
const AFTER_CHARS = RANGE_GAP + 24;
// Room before the words for a date that a day word at their start labels: "September 30, 2026 (".
const BEFORE_CHARS = 40;

/**
 * Where the quoted words sit in the email, or null: { text, wordsStart, wordsEnd, nearEnd }: up
 * to BEFORE_CHARS of what comes before the words, the words as the email has them
 * (text.slice(wordsStart, wordsEnd)), and up to AFTER_CHARS of what follows; nearEnd when the
 * email ends before that. The words must sit at word edges ("April 3" is not in "April 30"), and a year
 * the email writes right after a quoted day joins them, so the date is checked whole.
 */
function wholeWordsInEmail(hay, needle) {
  const edge = (outside, inside) => !outside || !WORD_CHAR.test(outside) || !WORD_CHAR.test(inside);
  for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, at + 1)) {
    const end = at + needle.length;
    if (edge(hay[at - 1], needle[0]) && edge(hay[end], needle[needle.length - 1])) {
      const year = /\d$/.test(needle) ? YEAR_AFTER.exec(hay.slice(end, end + 7)) : null;
      const wordsEnd = needle.length + (year ? year[0].length : 0);
      const from = Math.max(0, at - BEFORE_CHARS);
      return { text: hay.slice(from, at + wordsEnd + AFTER_CHARS), wordsStart: at - from, wordsEnd: at - from + wordsEnd, nearEnd: at + wordsEnd + AFTER_CHARS > hay.length };
    }
  }
  return null;
}

/**
 * Checks one parsed answer against the email. { ok: true, endDate, quote, priceIncrease }
 * (endDate null = the email states no end; priceIncrease = endDate is the day a new price
 * starts, the model's reading, which a dated answer must give as a JSON true or false), or
 * { ok: false, reason }. `cut`: a cap cut the end of emailText.
 */
function checkAnswer(answer, emailText, receivedAt, cut = false) {
  if (!answer || !Object.prototype.hasOwnProperty.call(answer, 'end_date')) return { ok: false, reason: 'invalid_json' };
  // "No end" needs both values null: a quote beside a null date, or no quote key, is a malformed
  // reply. Like any answer, it needs a JSON true or false flag.
  if (answer.end_date === null) {
    if (answer.quote !== null) return { ok: false, reason: 'half_null' };
    return typeof answer.price_increase === 'boolean' ? { ok: true, endDate: null, quote: null, priceIncrease: false } : { ok: false, reason: 'bad_price_flag' };
  }
  const endDate = typeof answer.end_date === 'string' ? answer.end_date.trim() : '';
  if (!isCalendarDay(endDate)) return { ok: false, reason: 'bad_date' };
  const away = dayNumber(endDate) - dayNumber(etDateString(new Date(receivedAt)));
  if (!(away >= 0 && away <= MAX_DAYS_AHEAD)) return { ok: false, reason: 'date_out_of_range' };
  const quote = typeof answer.quote === 'string' ? answer.quote.replace(/\s+/g, ' ').trim() : '';
  // Length first: the edge trim below is quadratic on a long run of marks. The bell line shows the words whole.
  if (quote.length > QUOTE_CHARS) return { ok: false, reason: 'no_quote' };
  const flat = comparable(quote);
  const needle = flat.replace(EDGE_MARKS, '');
  if (needle.length < QUOTE_MIN_CHARS || !/[a-z]/.test(needle)) return { ok: false, reason: 'no_quote' };
  const place = wholeWordsInEmail(comparable(emailText), needle);
  if (place === null) return { ok: false, reason: 'quote_not_found' };
  // Words that run to a cut cannot be checked whole: "May 3" may have been "May 30", and a range may go on past it.
  if (cut && place.nearEnd) return { ok: false, reason: 'quote_at_cut' };
  if (!quoteNamesDay(place, endDate, away)) return { ok: false, reason: 'quote_date_mismatch' };
  // The flag picks the line's label ("price rises" or "ends"), so only a JSON true or false counts.
  if (typeof answer.price_increase !== 'boolean') return { ok: false, reason: 'bad_price_flag' };
  return { ok: true, endDate, quote, priceIncrease: answer.price_increase };
}

// The check reads the subject and the body as two sentences, so a date that ends the subject
// neither labels the body's first word ("April 15" + "Tomorrow only!") nor opens a range with it.
const FIELD_BREAK = '\n.\n';

/** One model read of one email (its whole body on it). Never throws. */
async function readOne(client, email) {
  try {
    const received = new Date(email.received_at);
    const readable = readableEmail(email);
    if (readable === null) return { ok: false, reason: 'long_subject' };
    const { subject, text: body, cut, partial } = readable;
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
    if (response.stop_reason === 'refusal') return { ok: false, reason: 'refusal' };
    if (response.stop_reason === 'max_tokens') return { ok: false, reason: 'max_tokens' };
    const read = checkAnswer(parseAnswer(anthropicText(response)), `${subject}${FIELD_BREAK}${body}`, received, cut);
    if (!read.ok) ledgerCallRejected(response, read.reason === 'invalid_json' ? 'invalid_json' : 'schema_invalid');
    // "No end" on part of an email proves nothing: the end may sit in the part a cap or the <blockquote> drop left out.
    if (read.ok && read.endDate === null && partial) return { ok: false, reason: 'no_end_in_cut_text' };
    return read;
  } catch (err) {
    logger.warn(`[siteone-deals] end-date read failed: ${err?.message || 'error'}`);
    return { ok: false, reason: 'error' };
  }
}

/**
 * Reads the end date of up to MAX_READS deal emails (newest first, as given). Resolves a Map
 * of email id -> { endDate, quote, priceIncrease } for each kept answer; an email with no entry keeps the
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
    if (read.ok) found.set(email.id, { endDate: read.endDate, quote: read.quote, priceIncrease: read.priceIncrease });
    else misses[read.reason] = (misses[read.reason] || 0) + 1;
  }
  const kept = Object.entries(misses).map(([reason, n]) => `${n} ${reason}`).join(', ');
  logger.info(`[siteone-deals] end dates: ${found.size} of ${deals.length} deals read by AI${kept ? `; date patterns kept for ${kept}` : ''}`);
  return found;
}

module.exports = {
  readDealEndDates,
  MAX_READS, BODY_TEXT_CHARS, BODY_HTML_CHARS, MODEL_TEXT_CHARS, SUBJECT_CHARS,
  _test: { readableEmail, checkAnswer, parseAnswer, SYSTEM_PROMPT },
};
