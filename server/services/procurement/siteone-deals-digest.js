/**
 * procurement/siteone-deals-digest.js — weekly "SiteOne deals" admin bell.
 *
 * Monday 8:00 AM ET (scheduler.js) this reads the last 7 days of the contact@
 * Gmail sync (the `emails` table), keeps the mail that looks like a deal from
 * SiteOne or one of the product makers (promos, flyers, early-order programs,
 * rebates, price increases, price-match replies), and rings ONE admin bell that
 * lists each deal with its deadline and the products from our own catalog that
 * it names. Zero deals = no bell, one info line.
 *
 * A sender must also pass Gmail's SPF/DKIM check for its own domain (a typed From
 * header proves nothing), and quarantined, SPAM, TRASH or spam rows are skipped.
 *
 * Costs $0: plain string and regex rules over rows already in the database. No
 * model call, no paid API, no network. Read-only: it writes nothing but the bell.
 *
 * The bell follows docs/admin-notifications.md: it is raised through
 * raiseAdminAlert (headline and why inside the copy rules), and the one-line-
 * per-deal list lives in `detail` ("Show full text" on the bell). One bell per
 * ET week (dedupeKey siteone-deals:<Monday>), rewritten in place when a rerun
 * finds a different list.
 */
const logger = require('../logger');
const { hasAlignedAuth } = require('../email/inbox-hygiene');
const { etWeekStart, etParts, etDateString, parseETDateTime } = require('../../utils/datetime-et');

const WINDOW_DAYS = 7;
const BODY_CHARS = 6000;
// Tags inflate HTML, so the HTML excerpt is wider than the plain-text one.
const HTML_CHARS = BODY_CHARS * 4;
// The most mail one run reads. Anyone can write to the public contact@ address, so the
// query is capped; a run that reaches the cap says so (log + a line in the bell).
const MAX_CANDIDATE_ROWS = 300;
const DEADLINE_MAX_DAYS = 180;
// An offer's end date often sits in the footnote at the bottom of a promo email, past the
// excerpt above: SiteOne's promo text runs 8,000 to 23,000 chars, much of it tracking links.
// So a deal whose excerpt was cut is read once more, wider, for its deadline only. The wider
// text never feeds the deal test: widening the deal-test excerpt raised false deals in a
// replay of old SiteOne promo mail.
const DEADLINE_TEXT_CHARS = 30000;
// SiteOne's promo HTML is 3 to 6 times the size of its text part.
const DEADLINE_HTML_CHARS = DEADLINE_TEXT_CHARS * 6;
// The most deals one run reads again, newest first; the rest stay "deadline not stated".
const DEADLINE_REREAD_MAX = 20;
const MAX_PRODUCTS = 6;
const SUBJECT_CLIP = 120;
const CAP_NOTE = `Note: only the newest ${MAX_CANDIDATE_ROWS} candidate emails were read; older mail this week may be missing.`;

const SITEONE_DOMAIN = 'siteone.com';
const MAKER_DOMAINS = [
  'basf.com', 'envu.com', 'bayer.com', 'syngenta.com', 'corteva.com', 'fmc.com', 'nufarm.com',
  'albaugh.com', 'mgk.com', 'zoecon.com', 'controlsolutionsinc.com', 'quali-pro.com', 'pbigordon.com',
  'adama.com', 'amvac.com', 'liphatech.com', 'ensystex.com', 'valent.com', 'lesco.com',
];
const SENDER_DOMAINS = [SITEONE_DOMAIN, ...MAKER_DOMAINS];

// Order, cart, account, support-case and auto-reply mail is never a deal, whatever words it
// carries. A support case notice names its case number: "Case: CS0012345 has been updated."
const TRANSACTIONAL_SUBJECT = /invoice|order summary|order has been submitted|order\b.*\bis ready|shopping cart|ewallet|automatic reply|out of office|statement|payment received|password|verify your|\bcase(?:\s+number)?\s*[:#]?\s*[a-z]{0,4}\d{5,}/i;

// One entry per kind of deal word. promo/promotion share an entry, and "cash
// discount" is not also counted as "discount", so "two different deal words"
// means two different ideas.
const DEAL_WORDS = [
  /\bpromo(?:tion)?s?\b/i,
  /\bspecials?\b/i,
  /\bflyers?\b/i,
  /\bearly order\b/i,
  /\bEOP\b/i,
  /\brebates?\b/i,
  /\bprice increases?\b/i,
  /\bfloor pric(?:e|es|ing)\b/i,
  /\bcash discounts?\b/i,
  /(?<!cash )\bdiscounts?\b/i,
  /%\s*off\b/i,
  /\bsale\b/i,
  /\btrade[\s-]in\b/i,
  /\bpoints\b/i,
  /\bdeals?\b/i,
  /\boffers?\b/i,
  /\bsavings\b/i,
  /\bprice[\s-]match(?:ing)?\b/i,
];

const dealWordsIn = (text) => DEAL_WORDS.filter((re) => re.test(text)).length;

/** Lowercased domain of an address ("Name <a@b.com>" or "a@b.com"), or ''. */
function senderDomain(address) {
  const raw = String(address || '');
  const inner = raw.match(/<([^<>]*)>/);
  const addr = (inner ? inner[1] : raw).trim().toLowerCase();
  const at = addr.lastIndexOf('@');
  return at === -1 ? '' : addr.slice(at + 1).trim().replace(/[>\s.]+$/, '');
}

/** True for siteone.com, a maker domain, or a subdomain of one. siteone.com.evil.example is not. */
function isDealSenderDomain(address) {
  const d = senderDomain(address);
  return !!d && SENDER_DOMAINS.some((base) => d === base || d.endsWith(`.${base}`));
}

const decodeEntities = (s) => s
  .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
  .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'");

/** Plain text of an email, `limit` chars at most: body_text, else body_html with tags removed (line breaks kept). */
function bodyPlainText(email, limit = BODY_CHARS) {
  const text = email?.body_text;
  if (typeof text === 'string' && text.trim()) return text.slice(0, limit);
  const html = typeof email?.body_html === 'string' ? email.body_html : '';
  return decodeEntities(
    html
      .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>|<\/(p|div|tr|li|h[1-6])>/gi, '\n')
      .replace(/<[^>]*>/g, ' ')
      .replace(/[ \t]+/g, ' '),
  ).slice(0, limit);
}

// True when the excerpt the deal test read stops before the email does: the SQL left()
// reached its cap, or the plain text ran past BODY_CHARS.
function excerptIsCut(email) {
  const text = email?.body_text;
  if (typeof text === 'string' && text.trim()) return text.length >= BODY_CHARS;
  const html = typeof email?.body_html === 'string' ? email.body_html : '';
  return html.length >= HTML_CHARS || bodyPlainText(email, Infinity).length > BODY_CHARS;
}

// A From header is text the sender typed, and the Gmail sync also stores spam and
// blocked mail, so a deal needs (1) Gmail's own Authentication-Results showing the
// message authenticated as the From domain (the strict reader: Google's authserv-id,
// real method results only; missing or unreadable = no), and (2) a row the sync did
// not quarantine, label SPAM or TRASH, or classify as spam.
const HELD_LABELS = ['SPAM', 'TRASH'];
function labelsOf(email) {
  let labels = email.label_ids; // jsonb array; the driver may hand it over as a string
  if (typeof labels === 'string') {
    try { labels = JSON.parse(labels); } catch { labels = []; }
  }
  return Array.isArray(labels) ? labels : [];
}
const isHeldBack = (email) => !!email.quarantined_at
  || email.classification === 'spam'
  || labelsOf(email).some((label) => HELD_LABELS.includes(label));
const isAuthenticatedSender = (email) => isDealSenderDomain(email.from_address)
  && hasAlignedAuth(email.authentication_results, senderDomain(email.from_address), { strict: true });

/**
 * Is this email a SiteOne / maker deal? The sender must be on the list AND
 * authenticated as that domain, the row must not be held back, the mail must not be
 * transactional, and the deal-word test must pass: a deal word in the subject, OR
 * one in the body with an attachment, OR two different ones in the body.
 */
function isDealEmail(email) {
  if (!email || !isAuthenticatedSender(email) || isHeldBack(email)) return false;
  if (email.classification === 'vendor_invoice') return false;
  const subject = String(email.subject || '');
  if (TRANSACTIONAL_SUBJECT.test(subject)) return false;
  if (dealWordsIn(subject) > 0) return true;
  const hits = dealWordsIn(bodyPlainText(email));
  return (hits >= 1 && !!email.has_attachments) || hits >= 2;
}

// ---- deadlines -------------------------------------------------------------

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const MONTH_DAY = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b(?:,?\s+(20\d{2})\b)?/gi;
// m/d, m/d/yy, m/d/yyyy. Not part of a longer number or path, and not a fraction of a unit ("1/2 gal").
const NUMERIC_DATE = /(?<![\d/.])(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?(?![\d/])(?!\s*(?:oz|lbs?|gal|gallons?|inch|in\b|"|%|cups?|pt|qt|tons?|acres?|ac\b))/gi;
// An offer's validity range ("Offers valid March 1 &ndash; April 30, 2026", "valid 11/1 - 11/30",
// "Valid Nov 1-30", "between Nov 1 and Nov 30"): its first date is the day the offer opens, so
// only its end can be the deadline. A range in a deal email is taken as the offer's window. Its
// first date stays a deadline in two cases only: the text calls that date an end ("order by
// Nov 20 - Nov 25 delivery"), or the range is a rep's time off or a closed branch ("on PTO
// May 21-May 26"), where its first day is the one to order before.
const DASH = String.raw`(?:-|–|—|&ndash;|&mdash;|&#821[12];|&#x201[34];)`;
// What joins a range's two dates: a dash (SiteOne's text part keeps the HTML entity) or
// to/through/thru/until, with or without spaces or &nbsp; around it.
const RANGE_DASH = String.raw`(?:\s|&nbsp;)*(?:${DASH}|to|through|thru|until|till)(?:\s|&nbsp;)*`;
// The whole text between a range's two dates: the join, maybe a weekday after it. Also all the
// text after a range's first date when the text stops before the second ("Offer valid Nov 1 –"
// at the end of an excerpt): the range's end was cut off.
const RANGE_JOIN = new RegExp(String.raw`^${RANGE_DASH}(?:(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,?(?:\s|&nbsp;)*)?$`, 'i');
// "between Nov 1 and Nov 30": the join, and the word right before the first date.
const BETWEEN_JOIN = /^(?:\s|&nbsp;)+and(?:\s|&nbsp;)+$/i;
const BETWEEN_BEFORE = /\bbetween(?:\s|&nbsp;)+$/i;
// "Nov 1-30, 2026": the range ends on a later day of the same month.
// - With the dash right between the two numbers, the number is a day unless a quantity, %,
//   time or unit follows it ("Nov 20-25% off", "Nov 1-25-lb"), or it starts a numeric date, a
//   time or a longer number ("11/30", "3:00", "3,000").
// - With spaces or a word around the join, the number is a day only before a year or at a
//   clause's end ("Nov 1 – 30, 2026", "Nov 1 through 30.", "Nov 1 - 30 only"). A spaced number
//   with words after it is often a quantity ("Nov 1 - 2 free cases", "Nov 2 - 3 PM"), and a
//   colon, comma or period before a digit ends no clause ("Nov 2 - 3:00 PM").
const QUANTITY_WORD = String.raw`(?:%|percent|am|pm|free|off|for\s*\$|each|per|x|or more|cases?|bags?|units?|items?|pcs|pieces?|packs?|boxes?|bottles?|jugs?|pails?|cans?|pallets?|gal|gallons?|lbs?|pounds?|oz|ounces?|qts?|quarts?|pts?|pints?|tons?|acres?)`;
const TIGHT_DAY_FOLLOWER = String.raw`(?<=${DASH}\d{1,2}(?:st|nd|rd|th)?)(?![%/:.,]\d|[\s-]*${QUANTITY_WORD}(?![a-z]))`;
const SPACED_DAY_FOLLOWER = String.raw`(?=,?\s+20\d{2}\b|[^\S\n]*(?:only\b|[;!?)\]*\n]|[,:.](?!\d)|$))`;
const SAME_MONTH_END = new RegExp(String.raw`${RANGE_DASH}(?<day>\d{1,2})(?:st|nd|rd|th)?\b(?:${TIGHT_DAY_FOLLOWER}|${SPACED_DAY_FOLLOWER})(?:,?\s+(?<year>20\d{2})\b)?`, 'iy');
// "11/1 - 11/30 in stores": NUMERIC_DATE drops 11/30, as "in" also means inches. After a numeric
// date and a join, an m/d with "in" after it is the range's end when it has the same month and a
// later day. A fraction range fails that test: "1/2 - 3/4 in" changes the top number, and
// "1/8 - 1/4 in" lowers the bottom one.
const NUMERIC_END_BEFORE_IN = new RegExp(String.raw`${RANGE_DASH}(?<month>\d{1,2})\/(?<day>\d{1,2})(?:\/(?<year>\d{4}|\d{2}))?(?![\d/])(?=\s*in\b)`, 'iy');
// Words right before a date that make it an end, so no range opens on it ("ends Nov 20",
// "order by Friday, Nov 20").
const END_WORD_BEFORE = /\b(?:ends?|ending|expires?|expiring|by|before|through|thru|until|till)\b[\s:,]*(?:on\s+)?(?:(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,?\s*)?$/i;
// A rep's time off or a closed branch.
const AWAY_WORD = /\b(?:pto|ooo|out of (?:the )?office|vacation|on leave|time off|days? off|travel(?:l?ing)|closed|closure)\b|\b(?:be|i['’]m|i am|we['’]re|we are)\s+(?:out|off|away)\b/i;
// A sentence ends at . ! or ? before a space or the end of the text. A decimal point ("$24.99"),
// an ellipsis, or the period of a weekday, month or street abbreviation ("closed Mon. Nov 2")
// ends none.
const SENTENCE_END = /(?:(?<!\.|\b(?:mon|tues?|wed|thu|thur|thurs|fri|sat|sun|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec|st|ave|blvd|hwy|no|vs|etc|approx|inc|co|corp|ltd|mr|mrs|ms|dr|jr|sr))\.(?!\.)|[!?])(?=\s|$)/gi;
const QUOTED_HISTORY = [
  /^[ \t]*From:/im,
  /^[ \t>]*-{2,}[ \t]*Original Message[ \t]*-{2,}/im,
  /^[ \t>]*On\s[\s\S]{0,250}?\swrote:/im,
];

/**
 * The words around text[start, end) in its sentence, 80 chars a side at most. A range inside a
 * line reads that line only. A range alone on its line reads the lines next to it, where
 * HTML-to-text breaks put the words ("I'll be on PTO\nNov 19 - Nov 24").
 */
function sentenceAround(text, start, end) {
  const before = text.slice(Math.max(0, start - 80), start);
  const after = text.slice(end, end + 80);
  const lastEnd = [...before.matchAll(SENTENCE_END)].pop();
  const head = lastEnd ? before.slice(lastEnd.index + lastEnd[0].length) : before;
  const firstEnd = after.search(SENTENCE_END);
  const tail = firstEnd === -1 ? after : after.slice(0, firstEnd);
  const lineHead = head.slice(head.lastIndexOf('\n') + 1);
  const lineTail = tail.split('\n')[0];
  return lineHead.trim() || lineTail.trim() ? `${lineHead} ${lineTail}` : `${head} ${tail}`;
}

/** True when the range at text[start, end) opens an offer, so its first date is no deadline. */
function opensOffer(text, start, end) {
  if (END_WORD_BEFORE.test(text.slice(Math.max(0, start - 40), start))) return false;
  return !AWAY_WORD.test(sentenceAround(text, start, end));
}

/** Drops quoted reply history: everything from its first marker line on. */
function stripQuotedHistory(text) {
  let end = text.length;
  for (const re of QUOTED_HISTORY) {
    const m = re.exec(text);
    if (m && m.index < end) end = m.index;
  }
  return text.slice(0, end);
}

const pad2 = (n) => String(n).padStart(2, '0');
const isoOf = (y, m, d) => `${y}-${pad2(m)}-${pad2(d)}`;
function validYmd(y, m, d) {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}
const dayNumber = (iso) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / 86400000);

/**
 * The earliest explicit date in `text` that falls on or after receivedAt's ET date
 * and within 180 days, as YYYY-MM-DD; null when there is none. Quoted reply
 * history is ignored, and so is the day an offer's validity range opens (opensOffer).
 * A date with no year takes receivedAt's year, or the next year when that date
 * has already passed. Weekday-only phrases give null.
 */
function extractDeadline(text, receivedAt) {
  const received = receivedAt instanceof Date ? receivedAt : new Date(receivedAt);
  if (!text || Number.isNaN(received.getTime())) return null;
  const today = etDateString(received);
  const todayNum = dayNumber(today);
  const todayYear = Number(today.slice(0, 4));
  const body = stripQuotedHistory(String(text));

  const candidates = [];
  const consider = (month, day, yearText) => {
    let year;
    if (yearText) {
      year = yearText.length === 2 ? 2000 + Number(yearText) : Number(yearText);
      if (!validYmd(year, month, day)) return;
    } else {
      year = todayYear;
      if (!validYmd(year, month, day)) return;
      if (dayNumber(isoOf(year, month, day)) < todayNum) {
        year += 1;
        if (!validYmd(year, month, day)) return;
      }
    }
    const iso = isoOf(year, month, day);
    const away = dayNumber(iso) - todayNum;
    if (away >= 0 && away <= DEADLINE_MAX_DAYS) candidates.push(iso);
  };

  const dates = [
    ...Array.from(body.matchAll(MONTH_DAY), (m) => ({ m, named: true, month: MONTHS[m[1].slice(0, 3).toLowerCase()], day: Number(m[2]), year: m[3] })),
    ...Array.from(body.matchAll(NUMERIC_DATE), (m) => ({ m, named: false, month: Number(m[1]), day: Number(m[2]), year: m[3] })),
  ].sort((a, b) => a.m.index - b.m.index);
  dates.forEach((date, i) => {
    const start = date.m.index;
    const end = start + date.m[0].length;
    const next = dates[i + 1];
    const join = body.slice(end, next?.m.index);
    const joined = RANGE_JOIN.test(join) || (BETWEEN_JOIN.test(join) && BETWEEN_BEFORE.test(body.slice(Math.max(0, start - 20), start)));
    // The offer opens on this date. The range's end date counts on its own, or the text cut it off.
    if (joined && opensOffer(body, start, next ? next.m.index + next.m[0].length : body.length)) return;
    // A range end that the date list does not hold: a bare day ("Nov 1-30"), or an m/d before "in".
    const endRe = date.named ? SAME_MONTH_END : NUMERIC_END_BEFORE_IN;
    endRe.lastIndex = end;
    const rangeEnd = endRe.exec(body)?.groups ?? {};
    if (Number(rangeEnd.month ?? date.month) === date.month && Number(rangeEnd.day) > date.day && opensOffer(body, start, endRe.lastIndex)) {
      consider(date.month, Number(rangeEnd.day), rangeEnd.year || date.year);
    } else {
      consider(date.month, date.day, date.year);
    }
  });
  return candidates.length ? candidates.sort()[0] : null;
}

// ---- products --------------------------------------------------------------

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function wholeWord(phrase) {
  const body = phrase.trim().split(/\s+/).map(escapeRe).join('\\s+');
  return new RegExp(`(?<![A-Za-z0-9])${body}(?![A-Za-z0-9])`, 'i');
}

/**
 * Catalog product names that `text` names: whole-word, case-insensitive, by full
 * name (4+ chars) or by its first two words (6+ chars together, "Taurus SC 1 gal"
 * -> "Taurus SC"). Unique original names, at most six.
 */
function matchProducts(text, productNames) {
  const haystack = String(text || '');
  const found = [];
  for (const raw of productNames || []) {
    const name = String(raw || '').trim();
    if (name.length < 4 || found.includes(name)) continue;
    const words = name.split(/\s+/);
    const firstTwo = words.slice(0, 2).join(' ');
    const phrases = [name];
    if (words.length > 2 && firstTwo.length >= 6) phrases.push(firstTwo);
    if (phrases.some((p) => wholeWord(p).test(haystack))) {
      found.push(name);
      if (found.length >= MAX_PRODUCTS) break;
    }
  }
  return found;
}

// ---- the weekly run --------------------------------------------------------

const clip = (s, n) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : `${t.slice(0, n - 1).trimEnd()}…`;
};

function shortDate(date) {
  const p = etParts(date);
  return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][p.month - 1]} ${p.day}`;
}

/**
 * Each deal's deadline by email id (null = not stated), from the excerpt the deal test read.
 * A deal whose excerpt was cut takes its deadline from a wider excerpt instead, which holds
 * the footnote and any range the cut split: ONE query for up to DEADLINE_REREAD_MAX of them,
 * newest first. A failed re-read logs a warning and keeps the excerpt's deadlines.
 */
async function dealDeadlines(conn, deals) {
  const fromText = (email, text) => extractDeadline(`${email.subject || ''}\n${text}`, new Date(email.received_at));
  const deadlines = new Map(deals.map((email) => [email.id, fromText(email, bodyPlainText(email))]));
  const reread = new Map(deals.filter(excerptIsCut).slice(0, DEADLINE_REREAD_MAX).map((email) => [email.id, email]));
  if (!reread.size) return deadlines;
  try {
    const rows = await conn('emails')
      .select(
        'id',
        conn.raw('left(body_text, ?) as body_text', [DEADLINE_TEXT_CHARS]),
        conn.raw('left(body_html, ?) as body_html', [DEADLINE_HTML_CHARS]),
      )
      .whereIn('id', [...reread.keys()]);
    for (const row of rows) {
      const email = reread.get(row.id);
      if (email) deadlines.set(email.id, fromText(email, bodyPlainText(row, DEADLINE_TEXT_CHARS)));
    }
  } catch (err) {
    logger.warn(`[siteone-deals] wider deadline read failed: ${err.message}`);
  }
  return deadlines;
}

function dealLine(email, products, deadline) {
  const received = new Date(email.received_at);
  const who = clip(email.from_name, 60) || clip(email.from_address, 80);
  return [
    shortDate(received),
    who,
    clip(email.subject, SUBJECT_CLIP) || '(no subject)',
    `deadline ${deadline || 'not stated'}`,
    `your products: ${matchProducts(`${email.subject || ''}\n${bodyPlainText(email)}`, products).join(', ') || 'none named'}`,
  ].join(' · ');
}

/**
 * The candidate rows, narrowed in SQL so a mail flood to the public contact@ address
 * cannot load unbounded bodies into the worker. Every filter here is a SUPERSET of what
 * the JS checks accept (sender domain by substring, a coarse dkim/spf pass, rows not
 * obviously held back); isDealEmail stays the authority. Bodies come back as bounded
 * excerpts under their own column names. label_ids is jsonb; jsonb_exists, never the
 * "?" operator, which knex reads as a binding.
 */
function candidateEmailQuery(conn, since, now) {
  return conn('emails')
    .select(
      'id', 'from_address', 'from_name', 'subject', 'has_attachments', 'received_at', 'classification',
      'authentication_results', 'label_ids', 'quarantined_at',
      conn.raw('left(body_text, ?) as body_text', [BODY_CHARS]),
      conn.raw('left(body_html, ?) as body_html', [HTML_CHARS]),
    )
    .where('received_at', '>=', since)
    .where('received_at', '<', now)
    .where((qb) => { for (const domain of SENDER_DOMAINS) qb.orWhere('from_address', 'ilike', `%${domain}%`); })
    .where((qb) => qb.where('authentication_results', 'ilike', '%dkim=pass%').orWhere('authentication_results', 'ilike', '%spf=pass%'))
    .whereNull('quarantined_at')
    .whereRaw("COALESCE(classification, '') NOT IN ('spam', 'vendor_invoice')")
    .whereRaw("NOT jsonb_exists(COALESCE(label_ids::jsonb, '[]'::jsonb), ?)", ['SPAM'])
    .whereRaw("NOT jsonb_exists(COALESCE(label_ids::jsonb, '[]'::jsonb), ?)", ['TRASH'])
    .orderBy('received_at', 'desc')
    .limit(MAX_CANDIDATE_ROWS);
}

/**
 * Scans the last 7 days of mail, rings ONE bell when there are deals.
 * `notify` has raiseAdminAlert's shape (category, spec, opts); tests pass a fake.
 * Returns { scanned, deals, notified }.
 */
async function runSiteOneDealsDigest({ now = new Date(), db, notify } = {}) {
  const conn = db || require('../../models/db');
  const raise = notify || ((...args) => require('../admin-alert-compose').raiseAdminAlert(...args));
  const since = new Date(now.getTime() - WINDOW_DAYS * 86400000);

  const rows = await candidateEmailQuery(conn, since, now);
  const capped = rows.length >= MAX_CANDIDATE_ROWS;
  if (capped) logger.warn(`[siteone-deals] candidate cap of ${MAX_CANDIDATE_ROWS} emails reached; older mail this week was not read`);
  const scanned = rows.length;
  const deals = rows
    .filter(isDealEmail)
    .sort((a, b) => new Date(b.received_at) - new Date(a.received_at));

  if (!deals.length) {
    logger.info(`[siteone-deals] ${scanned} emails scanned, no deals this week`);
    return { scanned, deals: 0, notified: false };
  }

  let productNames = [];
  try {
    productNames = (await conn('products_catalog').where({ active: true }).select('name')).map((r) => r.name);
  } catch (err) {
    logger.warn(`[siteone-deals] product names not read: ${err.message}`);
  }

  const deadlines = await dealDeadlines(conn, deals);
  const dedupeKey = `siteone-deals:${etWeekStart(now)}`;
  const count = deals.length;
  const result = await raise('system', {
    area: 'Inventory',
    action: `review ${count} SiteOne ${count === 1 ? 'deal' : 'deals'} this week`,
    why: 'SiteOne and product-maker emails with promos, rebates or price changes; details are in the full text.',
    severity: 'needs-you',
    link: '/admin/communications#tab=email',
    subject: { type: 'check', id: dedupeKey },
    doneWhen: 'deals_reviewed',
    who: 'person',
  }, {
    // 'system' alone is suppressed under the bell policy; a deal list is a handoff.
    bell: true,
    detail: [...deals.map((e) => dealLine(e, productNames, deadlines.get(e.id))), ...(capped ? [CAP_NOTE] : [])].join('\n'),
    dedupeKey,
    refreshOnDedupe: true,
    metadata: { source: 'siteone-deals-digest', dealCount: count, emailIds: deals.map((e) => e.id) },
  });
  // The notification service resolves null when it could not save the row.
  if (!result) throw new Error('SiteOne deals bell was not saved');
  logger.info(`[siteone-deals] ${scanned} emails scanned, ${count} deals, bell sent`);
  return { scanned, deals: count, notified: true };
}

// ---- missed-tick catch-up --------------------------------------------------
// The Monday 8:00 tick (scheduler.js) can be lost: a deploy restart on that minute,
// or node-cron dropping a tick while the event loop is busy. The cron-lock records
// every finished run of the wrapped job in job_health.last_success_at, so "did this
// week's digest run" is that stamp being on or after this ET week's Monday. No new
// table. The bell's own dedupeKey (siteone-deals:<Monday>) still blocks a second bell.
const JOB_NAME = 'siteone-deals-digest';
const TICK_TIME = '08:00';

/** The instant this ET week's Monday tick is scheduled for: the end of the 7-day window. */
const scheduledTickFor = (now) => parseETDateTime(`${etWeekStart(now)}T${TICK_TIME}`);

/**
 * True when this ET week's digest has NOT finished yet. THROWS when job_health cannot
 * be read. Code that runs under the job lock must use this form: a resolved callback is
 * recorded by runExclusive as a successful run, so a read failure answered as "already
 * ran" would stamp last_success_at with nothing digested and hide the week from the
 * next catch-up tick.
 */
async function readWeekMissing({ now = new Date(), db } = {}) {
  const conn = db || require('../../models/db');
  const row = await conn('job_health').where({ job_name: JOB_NAME }).first('last_success_at');
  const weekStartMs = parseETDateTime(`${etWeekStart(now)}T00:00`).getTime();
  const ranMs = row?.last_success_at ? new Date(row.last_success_at).getTime() : NaN;
  return !(Number.isFinite(ranMs) && ranMs >= weekStartMs);
}

/**
 * Pre-lock form for the cron tick: a read failure answers false (skip, take no lock,
 * record nothing; the next tick tries again), so a database blip never makes a second run.
 */
async function weekIsMissing(opts = {}) {
  try {
    return await readWeekMissing(opts);
  } catch (err) {
    logger.warn(`[siteone-deals] catch-up check could not read job_health: ${err.message}`);
    return false;
  }
}

/**
 * Catch-up run. Reads the SAME 7-day window the Monday tick would have: it is
 * pinned to Monday 8:00 ET, not to the moment the catch-up fires. Mail that
 * arrives after Monday 8:00 falls in next week's window, so nothing is lost.
 * Meant to run inside runExclusive(JOB_NAME); it checks again under that lock, so
 * a tick that finished while this one waited for the lock is not run twice. That
 * second read throws on failure (see readWeekMissing), so the run is recorded as failed.
 */
async function runSiteOneDealsCatchUp({ now = new Date(), db, notify } = {}) {
  if (!(await readWeekMissing({ now, db }))) return { skipped: 'already_ran' };
  return runSiteOneDealsDigest({ now: scheduledTickFor(now), db, notify });
}

module.exports = {
  weekIsMissing, runSiteOneDealsCatchUp, scheduledTickFor,
  runSiteOneDealsDigest, isDealEmail, extractDeadline, matchProducts, isDealSenderDomain,
  candidateEmailQuery, MAX_CANDIDATE_ROWS, BODY_CHARS, HTML_CHARS,
  DEADLINE_TEXT_CHARS, DEADLINE_HTML_CHARS, DEADLINE_REREAD_MAX,
};
