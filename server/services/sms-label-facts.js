'use strict';
// LABEL FACTS for the texting agent (owner ruling 2026-09-30): the agent MAY
// quote a label's rainfast and re-entry times, but only from the label of a
// product actually applied at THAT customer's visit. This module is the
// whole feature's data + wording + grounding logic:
//
//   readLastVisitLabelFacts()   DB read: the customer's most recent performed
//                               visit -> service_products -> products_catalog.
//   renderLabelFactsSection()   the per-draft facts section (gate-on only; the
//                               drafter passes it in through buildFactsBlock).
//   neutralizeGroundedTimes()   the deterministic compliance grounding: a
//                               numeric rainfast/re-entry time in a reply is
//                               allowed ONLY when the same number+unit is in
//                               that draft's LABEL FACTS section.
//
// Gate handling lives in the caller (sms-shadow-drafter): this file never
// reads GATE_SMS_REAL_ANSWERS, so gate off never reaches it.
//
// Deliberately NOT email-division/visit-products.readVisitProducts: that
// reader is `noTimeline: true` on purpose (email never states a timeline) and
// selects no label timing columns. classifyProduct is reused for the
// customer-facing type phrase and to keep adjuvants out.
const db = require('../models/db');
const logger = require('./logger');
const { classifyProduct, PRODUCT_FAMILIES } = require('./email-division/visit-products');
const { applyPerformedVisitHistoryFilter } = require('./pest-pressure/first-visit');

// Every gate-on facts block carries a LABEL FACTS header (sealed-eval contract
// marker): the full section when the last visit has verified label timing, the
// "none on file" section otherwise.
const LABEL_FACTS_MARKER = 'LABEL FACTS (';
const LABEL_FACTS_NONE_SECTION = `${LABEL_FACTS_MARKER}none on file for the last visit):
- No product timing is on file for this customer's last visit. Do not state any rainfast, drying or re-entry time. For a rain question, answer from the COMPANY FACTS rain line, plainly, with no mention of the label.
`;
// The exact shape of a rendered (non-empty) section header, for the judge's
// exact-position exemption.
const LABEL_FACTS_FILLED_HEADER_RE = /^LABEL FACTS \(from the labels of products applied at the last visit on [^()\n]{1,60}\):$/;
// Structural bounds of a rendered section (shared by the judge exemption and
// the sealed-eval exact-structure test; 255 is also the Postgres regex
// repetition ceiling the SQL twin runs under).
const LABEL_LINE_MAX = 250;
const LABEL_LINES_MAX = 20;
const escapeRegex = (t) => String(t).replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');
// Regex SOURCE (JS + Postgres ARE compatible) of a whole rendered LABEL FACTS
// section, no leading/trailing newline: the exact "none on file" section, or
// the exact header shape plus 1..20 bounded "- " lines.
const LABEL_SECTION_REGEX_SRC = `(?:${escapeRegex(LABEL_FACTS_NONE_SECTION.replace(/\n$/, ''))}|LABEL FACTS \\(from the labels of products applied at the last visit on [^()\n]{1,60}\\):(?:\n- [^\n]{1,${LABEL_LINE_MAX}}){1,${LABEL_LINES_MAX}})`;
const LABEL_FACTS_HEADER_PREFIX = 'LABEL FACTS (from the labels of products applied at the last visit on ';
const LABEL_FACTS_TIMEOUT_MS = 3000;
// Rows of the most recent service date (a customer can have a pest and a lawn
// record on the same day); never an older visit — its products are not "the
// last visit's".
const MAX_SAME_DAY_RECORDS = 5;

// Water conditioners / buffers are non-pesticide tank additives, kept out
// like adjuvants (classifyProduct already excludes surfactants/spreaders).
const WATER_CONDITIONER_RE = /water\s*condition|buffer|acidifier|\bph\b|conditioner/i;
// The catalog's generic placeholder is not a re-entry statement.
const REENTRY_PLACEHOLDER_RE = /^Follow the product label and technician service report/i;

function dayString(value) {
  if (!value) return null;
  if (value instanceof Date) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  }
  const m = String(value).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

function singleLine(text, cap) {
  return String(text || '').replace(/[\u0000-\u001F\u007F]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, cap);
}

/**
 * Read the label timing facts for the products applied at the customer's most
 * recent performed visit. Returns null when there is nothing to say (no
 * customer, no visit, no verified product with timing). Throws on DB errors —
 * the caller (fetchLabelFacts) turns those into "section omitted".
 *
 * Selection: applyPerformedVisitHistoryFilter (completed, customer-visible,
 * not a no-show/skip outcome) ordered newest first; the newest service_date
 * wins and only records on that date are read. Products come from
 * service_products joined to products_catalog on product_id. Fail closed:
 *   - unverified label (label_verified_at null) -> omitted, counted;
 *   - adjuvant / water conditioner              -> omitted;
 *   - no rainfast time and no re-entry data     -> nothing to say, omitted.
 */
async function readLastVisitLabelFacts({ customerId, conn = db } = {}) {
  if (!customerId) return null;
  const visitQuery = conn('service_records').where('service_records.customer_id', customerId);
  applyPerformedVisitHistoryFilter(visitQuery, { alias: 'service_records' });
  const visits = await visitQuery
    .orderBy([{ column: 'service_records.service_date', order: 'desc' }, { column: 'service_records.created_at', order: 'desc' }])
    .limit(MAX_SAME_DAY_RECORDS)
    .select('service_records.id', 'service_records.service_date');
  if (!visits.length) return null;
  const serviceDate = dayString(visits[0].service_date);
  if (!serviceDate) return null;
  const recordIds = visits.filter((v) => dayString(v.service_date) === serviceDate).map((v) => v.id);

  const rows = await conn('service_products as sp')
    .leftJoin('products_catalog as pc', 'pc.id', 'sp.product_id')
    .whereIn('sp.service_record_id', recordIds)
    .orderBy([{ column: 'sp.applied_at', order: 'asc' }, { column: 'sp.id', order: 'asc' }])
    .select(
      'sp.id', 'sp.product_name', 'sp.active_ingredient', 'sp.product_category',
      'pc.category as catalog_category', 'pc.product_type as catalog_product_type',
      'pc.rainfast_minutes', 'pc.rei_hours', 'pc.reentry_summary', 'pc.reentry_text', 'pc.label_verified_at',
    );

  const products = [];
  let unverified = 0;
  for (const row of rows) {
    const family = classifyProduct({
      productName: row.product_name, activeIngredient: row.active_ingredient, productCategory: row.product_category,
      catalogCategory: row.catalog_category, catalogProductType: row.catalog_product_type,
    });
    const def = PRODUCT_FAMILIES[family];
    if (!def || !def.customerVisible) continue;
    if ([row.product_category, row.catalog_category, row.catalog_product_type, row.product_name].some((c) => c && WATER_CONDITIONER_RE.test(String(c)))) continue;
    if (!row.label_verified_at) { unverified += 1; continue; }
    products.push({
      // A neutral customer-facing type ("an insecticide"), never the brand.
      phrase: def.phrase || 'a product',
      rainfastMinutes: row.rainfast_minutes == null ? null : Number(row.rainfast_minutes),
      reiHours: row.rei_hours == null ? null : Number(row.rei_hours),
      reentrySummary: row.reentry_summary || null,
      reentryText: row.reentry_text || null,
      labelVerifiedAt: row.label_verified_at,
    });
  }
  if (unverified) logger.info(`[sms-label-facts] ${unverified} applied product(s) omitted — label not verified`);
  return products.length ? { serviceDate, products, unverifiedCount: unverified } : null;
}

// Timeout wrapper + fail-safe: any error or timeout -> null (section omitted).
// Must never block drafting.
async function fetchLabelFacts({ customerId, conn = db, timeoutMs = LABEL_FACTS_TIMEOUT_MS } = {}) {
  if (!customerId) return null;
  let timer = null;
  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('label facts timeout')), timeoutMs);
    });
    return await Promise.race([readLastVisitLabelFacts({ customerId, conn }), timeout]);
  } catch (err) {
    logger.warn(`[sms-label-facts] lookup failed (${err.message}); section omitted`);
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function plural(n, unit) { return `${n} ${unit}${n === 1 ? '' : 's'}`; }

function rainfastClause(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  return `rainfast after ${minutes % 60 === 0 ? plural(minutes / 60, 'hour') : plural(minutes, 'minute')}`;
}

// Re-entry wording: the catalog's customer-facing summary; "until dry" when
// rei_hours = 0 (the residential value); else the label hours. `isBanned` is
// the drafter's own compliance screen (injected: this file must not require
// the drafter). A summary the screen rejects on its own (a "safe" claim, a
// number it does not ground) is replaced by the derived wording, then dropped.
function reentryClause(product, isBanned) {
  const summary = singleLine(product.reentrySummary || product.reentryText, 160);
  const usable = summary && !REENTRY_PLACEHOLDER_RE.test(summary) ? summary : null;
  const derived = product.reiHours == null ? null
    : (product.reiHours === 0 ? 'keep people and pets off treated areas until dry'
      : `keep people and pets off treated areas for ${plural(product.reiHours, 'hour')}`);
  for (const text of [usable, derived]) {
    if (!text) continue;
    const clause = `re-entry: ${text.replace(/[.;\s]+$/, '')}`;
    if (!isBanned || !isBanned(clause)) return clause;
  }
  return null;
}

/**
 * Render the LABEL FACTS section, '' when there is nothing to render.
 * `formatDate` is the drafter's SERVICE HISTORY date formatter, so the date in
 * the header matches SERVICE HISTORY verbatim. `isBanned(clause)` screens each
 * timing clause against the compliance guard with that clause as its own
 * grounding.
 */
function renderLabelFactsSection(labelFacts, { formatDate, isBanned } = {}) {
  if (!labelFacts || !Array.isArray(labelFacts.products) || !labelFacts.products.length) return '';
  const lines = [];
  for (const product of labelFacts.products) {
    const clauses = [rainfastClause(product.rainfastMinutes), reentryClause(product, isBanned)].filter(Boolean);
    if (!clauses.length) continue;
    const line = `- ${product.phrase}: ${clauses.join('; ')}`;
    // An over-long line would fall outside the section's exact structure: drop it (fail closed).
    if (line.length - 1 > LABEL_LINE_MAX) continue;
    if (!lines.includes(line) && lines.length < LABEL_LINES_MAX) lines.push(line);
  }
  if (!lines.length) return '';
  const date = (formatDate ? formatDate(labelFacts.serviceDate) : labelFacts.serviceDate) || labelFacts.serviceDate;
  return `${LABEL_FACTS_HEADER_PREFIX}${date}):\n${lines.join('\n')}\n`;
}

/** The LABEL FACTS section text out of a rendered facts block ('' if absent). */
function labelFactsSectionFrom(factsBlock) {
  const text = String(factsBlock || '');
  const start = text.indexOf(LABEL_FACTS_HEADER_PREFIX);
  if (start < 0) return '';
  const lines = text.slice(start).split('\n');
  const out = [lines[0]];
  for (const line of lines.slice(1)) {
    if (!line.startsWith('- ')) break;
    out.push(line);
  }
  return out.join('\n');
}

// "3 hours", "3-hour", "30 min", "1-2 hours", "1.5 hrs" (digits only: a
// spelled-out figure never grounds, so it stays banned and the reply is
// revised to digits).
const TIME_EXPR_RE = /(?<![\w.])(\d+(?:\.\d+)?)(?:\s*(?:-|–|to)\s*(\d+(?:\.\d+)?))?\s*-?\s*(minutes?|mins?|hours?|hrs?|days?)\b/gi;
function timeKey(match) {
  const unit = /^h/i.test(match[3]) ? 'h' : (/^d/i.test(match[3]) ? 'd' : 'm');
  return `${Number(match[1])}${match[2] ? `-${Number(match[2])}` : ''}${unit}`;
}
function timeKeysIn(text) {
  const keys = new Set();
  for (const m of String(text || '').matchAll(TIME_EXPR_RE)) keys.add(timeKey(m));
  return keys;
}

// The kinds of time the section grounds, read from the exact lines
// renderLabelFactsSection writes: a "rainfast ..." clause grounds a rainfast
// time, a "re-entry: ..." clause a re-entry time. Anything else in the
// section grounds nothing (fail closed).
function groundedTimeKeys(sectionText) {
  const rain = new Set();
  const reentry = new Set();
  for (const line of String(sectionText || '').split('\n')) {
    if (!line.startsWith('- ')) continue;
    const body = line.slice(2);
    const colon = body.indexOf(': ');
    if (colon < 0) continue;
    for (const clause of body.slice(colon + 2).split(';')) {
      const c = clause.trim();
      if (/^rainfast\b/i.test(c)) for (const k of timeKeysIn(c)) rain.add(k);
      else if (/^re-?entry\b/i.test(c)) for (const k of timeKeysIn(c)) reentry.add(k);
    }
  }
  return { rain, reentry };
}

const RAIN_WORD_RE = /\b(?:rain(?:s|ed|ing|fast|y)?|wash(?:es|ed|ing)?|downpour)\b/i;
// A spelled-out figure ("three hours", "an hour", "half an hour", "a couple of
// hours") states the same time as digits and never grounds.
const SPELLED_TIME_RE = /\b(?:an?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|forty-five|sixty|ninety|half(?:\s+an?)?|couple(?:\s+of)?|few)\s+(?:more\s+)?(?:minutes?|hours?|hrs?|days?)\b/gi;

// The sentence around index i (a "." between digits is a decimal point).
function sentenceAt(text, i) {
  let s = i;
  while (s > 0) {
    const ch = text[s - 1];
    if (ch === '\n' || ch === '!' || ch === '?' || (ch === '.' && !/\d/.test(text[s] || '') )) break;
    s -= 1;
  }
  let e = i;
  while (e < text.length) {
    const ch = text[e];
    if (ch === '\n' || ch === '!' || ch === '?' || (ch === '.' && !/\d/.test(text[e + 1] || ''))) break;
    e += 1;
  }
  return text.slice(s, e);
}

/**
 * The deterministic grounding: replace every numeric time in `text` that the
 * LABEL FACTS section grounds with a neutral token, so the ordinary
 * compliance screens (which ban any fixed re-entry/drying time) no longer see
 * it. A time is grounded when its number+unit is in the section AND it is
 * used as the kind of time the section states: a rainfast number only in a
 * sentence about rain, a re-entry number as a re-entry time. So "rainfast
 * after 3 hours" passes, but "the dog can go out after 3 hours" (when 3
 * hours is only the rainfast time) and "dry in 2 hours" do not.
 */
function neutralizeGroundedTimes(text, sectionText) {
  const src = String(text || '');
  const { rain, reentry } = groundedTimeKeys(sectionText);
  if (!rain.size && !reentry.size) return src;
  return src.replace(TIME_EXPR_RE, (whole, _a, _b, _u, offset) => {
    const key = timeKey([whole, _a, _b, _u]);
    const inRainSentence = RAIN_WORD_RE.test(sentenceAt(src, offset));
    const grounded = (inRainSentence && rain.has(key)) || (!inRainSentence && reentry.has(key));
    return grounded ? 'LABELTIME' : whole;
  });
}

/**
 * Rainfast is not on the drafter's older banned-copy list (which screens only
 * dry / re-entry times), so an invented "rain won't wash it off after 2 hours"
 * needs its own deterministic check: in a sentence about rain, ANY time
 * expression — digits or spelled out — must be a rainfast time the LABEL
 * FACTS section states (same number+unit). No section -> none grounded.
 */
function hasUngroundedRainTime(text, sectionText) {
  const src = String(text || '');
  const { rain } = groundedTimeKeys(sectionText);
  for (const m of src.matchAll(TIME_EXPR_RE)) {
    if (RAIN_WORD_RE.test(sentenceAt(src, m.index)) && !rain.has(timeKey(m))) return true;
  }
  for (const m of src.matchAll(SPELLED_TIME_RE)) {
    if (RAIN_WORD_RE.test(sentenceAt(src, m.index))) return true;
  }
  return false;
}

module.exports = {
  LABEL_FACTS_MARKER,
  LABEL_FACTS_FILLED_HEADER_RE,
  LABEL_LINE_MAX,
  LABEL_LINES_MAX,
  LABEL_SECTION_REGEX_SRC,
  escapeRegex,
  LABEL_FACTS_NONE_SECTION,
  hasUngroundedRainTime,
  LABEL_FACTS_HEADER_PREFIX,
  LABEL_FACTS_TIMEOUT_MS,
  readLastVisitLabelFacts,
  fetchLabelFacts,
  renderLabelFactsSection,
  labelFactsSectionFrom,
  groundedTimeKeys,
  neutralizeGroundedTimes,
};
