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
 * Gate: GATE_SITEONE_DEALS_DIGEST (feature-gates.js `siteOneDealsDigest`,
 * checked by the cron before this runs). The module itself does not read it, so
 * the admin can still call it by hand from a script.
 *
 * The bell follows docs/admin-notifications.md: it is raised through
 * raiseAdminAlert (headline and why inside the copy rules), and the one-line-
 * per-deal list lives in `detail` ("Show full text" on the bell). One bell per
 * ET week (dedupeKey siteone-deals:<Monday>), rewritten in place when a rerun
 * finds a different list.
 */
const logger = require('../logger');
const { hasAlignedAuth } = require('../email/inbox-hygiene');
const { etWeekStart, etParts, etDateString } = require('../../utils/datetime-et');

const WINDOW_DAYS = 7;
const BODY_CHARS = 6000;
// Tags inflate HTML, so the HTML excerpt is wider than the plain-text one.
const HTML_CHARS = BODY_CHARS * 4;
// The most mail one run reads. Anyone can write to the public contact@ address, so the
// query is capped; a run that reaches the cap says so (log + a line in the bell).
const MAX_CANDIDATE_ROWS = 300;
const DEADLINE_MAX_DAYS = 180;
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

// Order, cart, account and auto-reply mail is never a deal, whatever words it carries.
const TRANSACTIONAL_SUBJECT = /invoice|order summary|order has been submitted|order\b.*\bis ready|shopping cart|ewallet|automatic reply|out of office|statement|payment received|password|verify your/i;

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

/** Plain text of an email: body_text, else body_html with tags removed (line breaks kept). */
function bodyPlainText(email) {
  const text = email?.body_text;
  if (typeof text === 'string' && text.trim()) return text.slice(0, BODY_CHARS);
  const html = typeof email?.body_html === 'string' ? email.body_html : '';
  return decodeEntities(
    html
      .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>|<\/(p|div|tr|li|h[1-6])>/gi, '\n')
      .replace(/<[^>]*>/g, ' ')
      .replace(/[ \t]+/g, ' '),
  ).slice(0, BODY_CHARS);
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
const QUOTED_HISTORY = [
  /^[ \t]*From:/im,
  /^[ \t>]*-{2,}[ \t]*Original Message[ \t]*-{2,}/im,
  /^[ \t>]*On\s[\s\S]{0,250}?\swrote:/im,
];

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
 * history is ignored. A date with no year takes receivedAt's year, or the next
 * year when that date has already passed. Weekday-only phrases give null.
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

  for (const m of body.matchAll(MONTH_DAY)) consider(MONTHS[m[1].slice(0, 3).toLowerCase()], Number(m[2]), m[3]);
  for (const m of body.matchAll(NUMERIC_DATE)) consider(Number(m[1]), Number(m[2]), m[3]);
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

function dealLine(email, products) {
  const received = new Date(email.received_at);
  const who = clip(email.from_name, 60) || clip(email.from_address, 80);
  const deadline = extractDeadline(`${email.subject || ''}\n${bodyPlainText(email)}`, received);
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
    detail: [...deals.map((e) => dealLine(e, productNames)), ...(capped ? [CAP_NOTE] : [])].join('\n'),
    dedupeKey,
    refreshOnDedupe: true,
    metadata: { source: 'siteone-deals-digest', dealCount: count, emailIds: deals.map((e) => e.id) },
  });
  // The notification service resolves null when it could not save the row.
  if (!result) throw new Error('SiteOne deals bell was not saved');
  logger.info(`[siteone-deals] ${scanned} emails scanned, ${count} deals, bell sent`);
  return { scanned, deals: count, notified: true };
}

module.exports = {
  runSiteOneDealsDigest, isDealEmail, extractDeadline, matchProducts, isDealSenderDomain,
  candidateEmailQuery, MAX_CANDIDATE_ROWS, BODY_CHARS, HTML_CHARS,
};
