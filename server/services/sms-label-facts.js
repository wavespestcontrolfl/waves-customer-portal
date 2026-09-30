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
//                               Each line is ONE exact customer-safe sentence.
//   stripLabelSentences() +     the deterministic compliance guard (the EXACT-
//   hasUngroundedLabelClaim()   SENTENCE CONTRACT): label timing reaches a
//                               customer only by copying a rendered sentence
//                               word for word. The sentences are stripped from
//                               the reply and ANY label-context timing or
//                               clearance claim left over is held.
//   labelFactsSendBlockReason() the send-time recheck of a delayed reply.
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
const { NON_PERFORMED_VISIT_OUTCOMES } = require('./pest-pressure/first-visit');
const { serviceRecordSuppressesCustomerArtifacts } = require('./pest-pressure/history-filter');
const { readReportIdentitySnapshot, canonicalProductId } = require('./service-report/report-identity-snapshot');
const { dateOnlyString } = require('../utils/date-only');
const { etDateString } = require('../utils/datetime-et');

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
const LABEL_LINE_MAX = 240;
const LABEL_LINES_MAX = 2; // one rainfast sentence + one re-entry sentence, nothing else
const escapeRegex = (t) => String(t).replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');
// Regex SOURCE (JS + Postgres ARE compatible) of a whole rendered LABEL FACTS
// section, no leading/trailing newline: the exact "none on file" section, or
// the exact header shape plus 1..20 bounded "- " lines.
const LABEL_SECTION_REGEX_SRC = `(?:${escapeRegex(LABEL_FACTS_NONE_SECTION.replace(/\n$/, ''))}|LABEL FACTS \\(from the labels of products applied at the last visit on [^()\n]{1,60}\\):(?:\n- [^\n]{1,${LABEL_LINE_MAX}}){1,${LABEL_LINES_MAX}})`;
const LABEL_FACTS_HEADER_PREFIX = 'LABEL FACTS (from the labels of products applied at the last visit on ';
const LABEL_FACTS_TIMEOUT_MS = 3000;
const WATER_CONDITIONER_RE = /water\s*condition|buffer|acidifier|\bph\b|conditioner/i;
// The catalog's generic placeholder is not a re-entry statement.
const REENTRY_PLACEHOLDER_RE = /^Follow the product label and technician service report/i;

function singleLine(text, cap) {
  return String(text || '').replace(/[\u0000-\u001F\u007F]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, cap);
}

// A visit TODAY (live scheduled visit, an unfinished record, or a completed
// visit whose service record has not landed yet) means "the last visit" is
// stale for any question about today's application. Each completed scheduled
// service is matched to a completed service record BY ITS OWN ID
// (service_records.scheduled_service_id): one landed record never vouches for
// another completed visit that has none yet.
async function hasVisitToday(conn, customerId, today) {
  const liveToday = await conn('scheduled_services')
    .where({ customer_id: customerId, scheduled_date: today })
    .whereNotIn('status', ['cancelled', 'skipped', 'no_show', 'rescheduled'])
    .select('id', 'status');
  const recordsToday = await conn('service_records')
    .where({ customer_id: customerId, service_date: today })
    .select('status', 'scheduled_service_id');
  if (liveToday.some((r) => r.status !== 'completed')) return true;
  if (recordsToday.some((r) => r.status !== 'completed')) return true;
  const recorded = new Set(recordsToday
    .filter((r) => r.scheduled_service_id != null)
    .map((r) => String(r.scheduled_service_id).toLowerCase()));
  return liveToday.some((r) => r.id == null || !recorded.has(String(r.id).toLowerCase()));
}

// The applied product's report facts FROZEN at completion
// (service_data.reportIdentitySnapshot.productFacts, keyed by canonical
// product id; complete-scheduled-service.js + pest-recap.js write it from
// approvedReportProductFacts). Timing is read ONLY from here, never from the
// live products_catalog row, so a later catalog edit cannot rewrite what a
// past visit's label said. null = no verified snapshot for this product (no
// snapshot on the record, product absent from it, or not approved at
// completion): fail closed.
function frozenFactsFor(row, snapshot) {
  const map = snapshot && snapshot.productFacts && typeof snapshot.productFacts === 'object' ? snapshot.productFacts : null;
  if (!map) return null;
  const id = canonicalProductId(row.product_id);
  let facts = null;
  if (id) {
    facts = Object.prototype.hasOwnProperty.call(map, id) ? map[id] : null;
  } else {
    // service_products.product_id is ON DELETE SET NULL: fall back to the
    // frozen name, as the report does.
    const name = String(row.product_name || '').trim().toLowerCase();
    facts = name ? (Object.values(map).find((f) => f && String(f.name || '').trim().toLowerCase() === name) || null) : null;
  }
  return facts && typeof facts === 'object' ? facts : null;
}

// The snapshot writes rei_hours through Number(), so a catalog NULL (unknown)
// is frozen as 0, indistinguishable from the residential "0 = until dry"
// value. Trust a frozen 0 only when the frozen summary itself says until dry.
function frozenReiHours(frozen) {
  const hours = frozen.reentryHours == null ? null : Number(frozen.reentryHours);
  if (hours !== 0) return hours;
  const summary = String(frozen.reentrySummary || '');
  return UNTIL_DRY_RE.test(summary) && !REENTRY_PLACEHOLDER_RE.test(summary) ? 0 : null;
}

// One joined row -> a customer-visible verified product, 'unverified' (counted,
// omitted) or null (adjuvant / water conditioner / not customer-visible).
// `frozen` is the product's snapshot facts (frozenFactsFor), or null.
function productFromRow(row, frozen) {
  const f = frozen || {};
  const catalogCategory = f.category || row.catalog_category;
  const catalogProductType = f.productType || row.catalog_product_type;
  const family = classifyProduct({
    productName: row.product_name, activeIngredient: row.active_ingredient, productCategory: row.product_category,
    catalogCategory, catalogProductType,
  });
  const def = PRODUCT_FAMILIES[family];
  if (!def || !def.customerVisible) return null;
  if ([row.product_category, catalogCategory, catalogProductType, row.product_name].some((c) => c && WATER_CONDITIONER_RE.test(String(c)))) return null;
  if (!f.labelVerifiedAt) return 'unverified';
  return {
    // A neutral customer-facing type ("an insecticide"), never the brand.
    phrase: def.phrase || 'a product',
    rainfastMinutes: f.rainfastMinutes == null ? null : Number(f.rainfastMinutes),
    reiHours: frozenReiHours(f),
    reentrySummary: f.reentrySummary || null,
    reentryText: null,
    labelVerifiedAt: f.labelVerifiedAt,
  };
}

/**
 * Read the label timing facts for the products applied at the customer's most
 * recent PERFORMED visit. Returns null when there is nothing to say. Throws on
 * DB errors — the caller (fetchLabelFacts) turns those into "section omitted".
 *
 * Selection (never searches backward):
 *   1. the newest service_date of a completed, performed record (no
 *      no-show/skip/inspection-only outcome), REGARDLESS of report posture;
 *   2. ALL of that date's performed records, no cap;
 *   3. if any of them is suppressed from customer artifacts (typedReportDelivery
 *      other than auto_send), that visit is not usable -> none on file, and an
 *      older visit is never substituted;
 *   4. a customer with a visit TODAY (a live scheduled visit, a completed visit
 *      whose service record has not landed, or an unfinished record) gets none
 *      on file: the last visit's figures must never answer about today's
 *      application.
 * Products come from service_products; their label TIMING is read from the
 * facts frozen at completion on each record (service_data.reportIdentitySnapshot
 * .productFacts, see frozenFactsFor), never the live catalog. Fail closed: a
 * product with no verified snapshot is omitted and counted (so the whole visit
 * is none on file), an adjuvant / water conditioner is omitted.
 */
async function readLastVisitLabelFacts({ customerId, conn = db, today = etDateString() } = {}) {
  if (!customerId) return null;

  if (await hasVisitToday(conn, customerId, today)) return null;

  const performed = () => conn('service_records')
    .where('service_records.customer_id', customerId)
    .where('service_records.status', 'completed')
    .whereRaw(
      `COALESCE(service_records.structured_notes->>'visitOutcome', '') NOT IN (${NON_PERFORMED_VISIT_OUTCOMES.map(() => '?').join(', ')})`,
      NON_PERFORMED_VISIT_OUTCOMES,
    );
  const newest = await performed().max('service_records.service_date as service_date').first();
  const serviceDate = dateOnlyString(newest && newest.service_date);
  if (!serviceDate) return null;
  const visits = await performed()
    .where('service_records.service_date', serviceDate)
    .select('service_records.id', 'service_records.structured_notes', 'service_records.service_data');
  if (!visits.length || visits.some((v) => serviceRecordSuppressesCustomerArtifacts(v))) return null;
  const recordIds = visits.map((v) => v.id);
  const snapshotByRecord = new Map(visits.map((v) => [String(v.id), readReportIdentitySnapshot({ service_data: v.service_data })]));

  const rows = await conn('service_products as sp')
    .leftJoin('products_catalog as pc', 'pc.id', 'sp.product_id')
    .whereIn('sp.service_record_id', recordIds)
    .orderBy([{ column: 'sp.applied_at', order: 'asc' }, { column: 'sp.id', order: 'asc' }])
    .select(
      'sp.id', 'sp.service_record_id', 'sp.product_id', 'sp.product_name', 'sp.active_ingredient', 'sp.product_category',
      'pc.category as catalog_category', 'pc.product_type as catalog_product_type',
    );

  const products = [];
  let unverified = 0;
  for (const row of rows) {
    const p = productFromRow(row, frozenFactsFor(row, snapshotByRecord.get(String(row.service_record_id)) || null));
    if (p === 'unverified') unverified += 1;
    else if (p) products.push(p);
  }
  if (unverified) logger.info(`[sms-label-facts] ${unverified} applied product(s) omitted — label not verified`);
  return products.length ? { customerId, serviceDate, recordIds: recordIds.map(String).sort(), products, unverifiedCount: unverified } : null;
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

function rainfastDuration(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  return minutes % 60 === 0 ? plural(minutes / 60, 'hour') : plural(minutes, 'minute');
}

// VISIT-LEVEL, CONSERVATIVE values only (pre-push audit P1). A visit can apply
// several products (a lawn product and a pest spray, different areas); a
// per-product line invites quoting one product's time for another's area. So
// the section states at most TWO facts, each true of the whole visit: the
// LONGEST re-entry and the LONGEST rainfast time (only when EVERY product has
// one) across the verified customer-visible products, never per product or area.
//
// Re-entry level per product, in hours: rei_hours > 0 -> that many hours;
// rei_hours = 0 (the residential value) or a summary that says "until dry" ->
// 0 (the shortest, "until dry"); anything else is unknown, and one unknown
// product makes the whole-visit re-entry unstatable (line omitted).
const UNTIL_DRY_RE = /\buntil\b[^.]{0,30}\bdr(?:y|ied)\b/i;
// A summary/text that states its own duration (a number, a spelled-out figure,
// overnight, next day, weeks) makes rei_hours = 0 untrustworthy: unknown.
const STATED_DURATION_RE = /\d\s*-?\s*(?:minutes?|mins?|hours?|hrs?|days?|weeks?)\b|\bovernight\b|\bnext\s+day\b|\bweeks?\b/i;
function statesOwnDuration(product) {
  return [product.reentrySummary, product.reentryText].some((t) => t && (STATED_DURATION_RE.test(String(t)) || new RegExp(SPELLED_QTY_RE.source, 'i').test(String(t))));
}
function reentryLevelHours(product) {
  if (Number.isFinite(product.reiHours) && product.reiHours > 0) return product.reiHours;
  if (product.reiHours === 0) return statesOwnDuration(product) ? null : 0;
  const summary = singleLine(product.reentrySummary || product.reentryText, 160);
  return summary && UNTIL_DRY_RE.test(summary) && !REENTRY_PLACEHOLDER_RE.test(summary) && !statesOwnDuration(product) ? 0 : null;
}
// A product with a fixed hour figure whose own label text ALSO says "until dry".
function figureAlsoUntilDry(product) {
  const summary = singleLine(product.reentrySummary || product.reentryText, 160);
  return Boolean(summary) && UNTIL_DRY_RE.test(summary) && !REENTRY_PLACEHOLDER_RE.test(summary);
}
// { hours, untilDry } for the whole visit, or null when ANY product's re-entry
// is unknown. `untilDry` with hours > 0 is the mixed case (a fixed figure on
// one product, "until dry" on another): stated as "at least N hours AND until
// dry, whichever is later", never as just the hour figure.
function wholeVisitReentry(products) {
  const levels = products.map(reentryLevelHours);
  if (!levels.length || levels.some((l) => l == null)) return null;
  const hours = Math.max(...levels);
  const untilDry = hours === 0 || levels.some((l) => l === 0) || products.some((p, i) => levels[i] > 0 && figureAlsoUntilDry(p));
  return { hours, untilDry };
}
// Same all-known rule as re-entry: ONE product without a rainfast time makes
// the whole-visit figure unstatable (the longest of the known ones would
// understate it), so the sentence is omitted and the COMPANY FACTS rain line applies.
function wholeVisitRainfastMinutes(products) {
  const minutes = products.map((p) => p.rainfastMinutes);
  if (!minutes.length || minutes.some((m) => !Number.isFinite(m) || m <= 0)) return null;
  return Math.max(...minutes);
}

// ---- The exact-sentence contract ----------------------------------------
// LABEL FACTS renders, per kind, ONE exact customer-safe sentence naming the
// visit date. Label timing may reach a customer ONLY by copying such a
// sentence word for word; the reply guard strips those sentences and holds
// anything label-like that is left.
const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function shortVisitDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  return m && SHORT_MONTHS[Number(m[2]) - 1] ? `${SHORT_MONTHS[Number(m[2]) - 1]} ${Number(m[3])}` : null;
}
const SENTENCE_LEAD = 'For the products applied at your ';
const SENTENCE_LEAD_TAIL = ' visit, the label says ';
const REENTRY_CLAUSE = 'to keep people and pets off treated areas ';
const RAIN_CLAUSE = "rain won't wash it off after ";
// The exact shape of a rendered sentence (kind is read from it).
const REENTRY_SENTENCE_RE = /^For the products applied at your [A-Z][a-z]{2} \d{1,2} visit, the label says to keep people and pets off treated areas (?:until dry|for \d+(?:\.\d+)? hours?|for at least \d+(?:\.\d+)? hours? and until it is dry, whichever is later)\.$/;
const RAIN_SENTENCE_RE = /^For the products applied at your [A-Z][a-z]{2} \d{1,2} visit, the label says rain won't wash it off after \d+(?:\.\d+)? (?:hours?|minutes?)\.$/;

/** [{ kind: 'rainfast' | 'reentry', text }] the sentences this visit's facts support ([] = none on file). */
function labelFactsSentences(labelFacts) {
  if (!labelFacts || !Array.isArray(labelFacts.products) || !labelFacts.products.length) return [];
  if (labelFacts.unverifiedCount > 0) return [];
  const date = shortVisitDate(labelFacts.serviceDate);
  if (!date) return [];
  const lead = `${SENTENCE_LEAD}${date}${SENTENCE_LEAD_TAIL}`;
  const out = [];
  const rain = rainfastDuration(wholeVisitRainfastMinutes(labelFacts.products));
  if (rain) out.push({ kind: 'rainfast', text: `${lead}${RAIN_CLAUSE}${rain}.` });
  const re = wholeVisitReentry(labelFacts.products);
  if (re) {
    const tail = re.hours === 0 ? 'until dry'
      : (re.untilDry ? `for at least ${plural(re.hours, 'hour')} and until it is dry, whichever is later` : `for ${plural(re.hours, 'hour')}`);
    out.push({ kind: 'reentry', text: `${lead}${REENTRY_CLAUSE}${tail}.` });
  }
  return out;
}

/**
 * Render the LABEL FACTS section, '' when there is nothing to render.
 * `formatDate` is the drafter's SERVICE HISTORY date formatter, so the date in
 * the header matches SERVICE HISTORY verbatim. Fail closed: a visit with ANY
 * applied product whose label is not verified (`unverifiedCount`) states
 * nothing, since that product's own times are unknown and a "whole visit"
 * figure would understate them.
 */
function renderLabelFactsSection(labelFacts, { formatDate } = {}) {
  const sentences = labelFactsSentences(labelFacts);
  if (!sentences.length) return '';
  const date = (formatDate ? formatDate(labelFacts.serviceDate) : labelFacts.serviceDate) || labelFacts.serviceDate;
  return `${LABEL_FACTS_HEADER_PREFIX}${date}):\n${sentences.map((s) => `- ${s.text}`).join('\n')}\n`;
}

/** The LABEL FACTS section text out of a rendered facts block ('' if absent). */
function labelFactsSectionFrom(factsBlock) {
  // Exact-structure lookup only (never a header substring): see
  // sms-company-facts.exactLabelFactsSection.
  return require('./sms-company-facts').exactLabelFactsSection(factsBlock);
}

// The rendered sentences of a section (only lines of the exact rendered shape).
function labelSentencesIn(sectionText) {
  const out = [];
  for (const line of String(sectionText || '').split('\n')) {
    if (!line.startsWith('- ')) continue;
    const text = line.slice(2);
    if (REENTRY_SENTENCE_RE.test(text)) out.push({ kind: 'reentry', text });
    else if (RAIN_SENTENCE_RE.test(text)) out.push({ kind: 'rainfast', text });
  }
  return out;
}

/** Which kinds of label sentence a section carries: { rain, reentry }. */
function groundedLineKinds(sectionText) {
  const sentences = labelSentencesIn(sectionText);
  return { rain: sentences.some((s) => s.kind === 'rainfast'), reentry: sentences.some((s) => s.kind === 'reentry') };
}

// Whitespace, curly quotes, width forms and zero-width characters folded, so a
// reply cannot dodge (or forge) a verbatim match with typography.
function canonText(text) {
  return String(text || '').normalize('NFKC')
    .replace(/[‘’‛′`´]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[​-‍⁠﻿]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
const sentenceCore = (text) => canonText(text).replace(/\.+$/, '');

/** The rendered sentences of `sectionText` that `reply` copies verbatim (case-insensitive after canonText). */
function labelSentencesCopiedIn(reply, sectionText) {
  const body = canonText(reply).toLowerCase();
  return labelSentencesIn(sectionText).filter((s) => body.includes(sentenceCore(s.text).toLowerCase()));
}

/**
 * `text` (canonText-normalized) with every verbatim copy of a LABEL FACTS
 * sentence replaced by a clause break, so what remains is exactly the part of
 * the reply the guard must judge. Every other screen reads this same remainder.
 */
function stripLabelSentences(text, sectionText) {
  let out = canonText(text);
  for (const s of labelSentencesIn(sectionText)) out = out.replace(new RegExp(escapeRegex(sentenceCore(s.text)), 'gi'), ' ; labelsentence ; ');
  return out;
}

// ---- Time quantities -----------------------------------------------------
// "3 hours", "3-hour", "30 min", "1-2 hours", "1.5 hrs", "2h" (digits).
const TIME_EXPR_RE = /(?<![\w./\u2044])(\d+(?:\.\d+)?)(?:\s*(?:-|–|to|or)\s*(\d+(?:\.\d+)?))?\s*-?\s*(minutes?|mins?|hours?|hrs?|h|days?)\b/gi;
// Every quantity a reply can attach to a time unit, not a whitelist of
// numbers: a spelled number word (zero-nineteen, the tens with an optional
// hyphen/space unit, hundred), an "a"/"an", a fraction or "half", a range, and
// the vague quantities (a couple, a few, several, a day or two, overnight, the
// next day). Digits are matched by TIME_EXPR_RE above; this covers the rest.
const ONES_SRC = 'zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen';
const TENS_SRC = 'twenty|thirty|forty|fourty|fifty|sixty|seventy|eighty|ninety';
const NUM_WORD_SRC = `(?:(?:${TENS_SRC})(?:[-\\s]+(?:${ONES_SRC}))?|${ONES_SRC}|hundred)`;
const NUM_SEQ_SRC = `${NUM_WORD_SRC}(?:[-\\s]+(?:and\\s+)?${NUM_WORD_SRC})*`;
const FRACTION_SRC = '(?:\\d+\\s*[\\/\\u2044]\\s*\\d+|[\\u00BC-\\u00BE\\u2150-\\u215E])';
const QTY_SRC = `(?:${NUM_SEQ_SRC}(?:[-\\s]+and[-\\s]+a[-\\s]+half)?|(?:\\d+\\s*)?${FRACTION_SRC}|half(?:\\s+an?)?|an?\\s+half|(?:an?\\s+)?(?:couple|few|several|handful|bunch|dozen|number|lot|ton|load)(?:\\s+of)?(?:\\s+more)?|(?:some|many|multiple|numerous|countless|plenty\\s+of|quite\\s+a\\s+few|a\\s+good\\s+few|a\\s+lot\\s+of)|an?)`;
const TIME_UNIT_SRC = '(?:seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|nights?|weeks?)';
const VAGUE_WHOLE_SRC = '(?:overnight|over\\s+night|(?:the\\s+)?next\\s+(?:day|morning)|all\\s+(?:day|night)|an?\\s+(?:day|night|hour|week)\\s+(?:or\\s+(?:two|three|so|more)|and\\s+a\\s+half))';
const SPELLED_QTY_RE = new RegExp(`(?<![\\w-])(?:${VAGUE_WHOLE_SRC}|(${QTY_SRC})(?:\\s*(?:-|\\u2013|to|or)\\s*(${QTY_SRC}))?[\\s-]*(?:(?:more|full|whole|entire|good|solid|short|long|few|extra|additional)\\s+)*(${TIME_UNIT_SRC}))\\b`, 'gi');
// A clock time: "2 PM", "2:30", "14:00", "noon", "midnight", "by 5", "until 5".
// A bare "by/until/till N" is a clock time unless a unit follows ("by 5 hours").
const CLOCK_TIME_RE = /(?<![\w.:])(?:(?:1[0-2]|0?[1-9])(?::[0-5]\d)?\s*(?:a\.?m\.?|p\.?m\.?)(?![a-z])|(?:[01]?\d|2[0-3]):[0-5]\d(?!\d)|\b(?:1[0-2]|[1-9])ish\b|(?:at|around|about|after|before)\s+(?:1[0-2]|[1-9])(?::[0-5]\d)?(?=\s*(?:ish\b|o'clock|[.,;!?]|$)|\s+(?:today|tonight|tomorrow|this|on)\b)|noon\b|midnight\b|(?:by|until|till)\s+(?:1[0-2]|[1-9])(?![\d:]|\.\d|\s*(?:-|–|to)\s*\d|\s*(?:%|percent|minutes?|mins?|hours?|hrs?|days?|weeks?|inch|inches|feet|ft|gallons?|oz|ounces?|times|treatments?|people|pets?|dogs?|kids?)\b))/i;
// Label timing is minutes and hours (a day at most); a pest-results timeline
// ("7 to 10 days", "a couple of weeks") is not, so a clause whose EVERY
// duration is weeks, or three-plus days, is not a duration claim - unless the
// clause has label context (checked by the caller).
const LONG_QTY_WORD_RE = /^(?:three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|several|a\s+few|few|a\s+couple\s+of|couple\s+of|a\s+couple|couple)\b/;
function durationsIn(clause) {
  const out = [];
  for (const m of clause.matchAll(new RegExp(TIME_EXPR_RE.source, 'gi'))) {
    const top = Number(m[2] ?? m[1]);
    out.push(/^(?:w)/i.test(m[3]) ? 'long' : (/^d/i.test(m[3]) && top >= 3 ? 'long' : 'short'));
  }
  for (const m of clause.matchAll(new RegExp(SPELLED_QTY_RE.source, 'gi'))) {
    if (out.length && /\d/.test(m[0])) continue; // already counted by the digit pass
    const unit = m[3] || '';
    const qty = String(m[2] || m[1] || '').trim();
    out.push(/^weeks?$/i.test(unit) ? 'long' : (/^days?$/i.test(unit) && LONG_QTY_WORD_RE.test(qty) ? 'long' : 'short'));
  }
  return out;
}
const hasDuration = (clause) => durationsIn(clause).length > 0;
const hasShortDuration = (clause) => durationsIn(clause).includes('short');
const hasClockTime = (clause) => CLOCK_TIME_RE.test(clause);

// ---- The reply guard -----------------------------------------------------
// After the verbatim sentences are stripped, the remainder of a reply is
// judged clause by clause (a clause ends at , ; : a sentence end, a dash or a
// linking word). Label timing is never legitimately in the remainder, so ANY
// of these in a clause is held:
//   - a duration (digits, spelled, vague) or a clock time, unless the clause
//     is positively scheduling (staff subject + scheduling verb, a scheduling
//     noun + copula, business hours, billing/plan/guarantee terms) AND has no
//     label-context word (people, pets, dry, rain, stay-off, wait, water, mow...);
//   - "rainfast", "wash it off", "until dry", re-entry / stay-off wording;
//   - clearance or permission wording in a re-entry or rain context ("can go
//     back out now", "safe for pets now", "it's rainfast now", "fine to water").
// The sanctioned none-on-file idiom ("safe once dry" + the technician
// confirming timing) and the COMPANY FACTS rain line are not claims; the
// drafter rewrites the former before calling this and the latter carries none
// of the above.
const RAIN_WORD_RE = /\b(?:rain(?:s|ed|ing|fall|y|fast)?|rain-fast|showers?|storms?|thunderstorms?|downpours?|sprinklers?|irrigation|drizzle)\b/;
const RAINFAST_RE = /\brain[-\s]?fast\b|\bwash(?:es|ed|ing)?\s+(?:it\s+|this\s+|that\s+|them\s+|the\s+\w+\s+)?(?:off|away|out)\b|\bwashed\s+off\b/;
const UNTIL_DRY_HOLD_RE = /\b(?:until|till|til|unless|before)\b[^.]{0,40}\bdr(?:y|ies|ied|ying)\b/;
const DRY_RE = /\bdr(?:y|ies|ied|ying)\b|\bto\s+set\b|\b(?:cure[sd]?|curing|bond(?:s|ed|ing)?|settle[sd]?|settling|soak(?:s|ed|ing)?|absorb(?:s|ed|ing)?|sink(?:s|ing)?\s+in)\b/;
const DRY_CONDITIONAL_RE = /\b(?:once|after|when|as\s+long\s+as|provided|if|since)\b[^.]{0,40}\b(?:dr(?:y|ies|ied|ying)|bond(?:s|ed)?|cure[sd]?)\b/;
const REENTRY_TOPIC_RE = /\bre-?entr(?:y|ies)\b|\bre-?enter(?:ing)?\b|\b(?:stay|stays|staying|stayed|keep|keeps|keeping|kept)\b[^.]{0,25}\b(?:off|out|away|inside|indoors)\b|\b(?:off|away\s+from)\s+(?:of\s+)?(?:the\s+|your\s+|those\s+|any\s+)?(?:lawn|grass|yard|turf|treated|area|areas|surface|surfaces|patio|deck|lanai|garden|sod)\b|\b(?:walk|play|sit|lie|run|step|stand)(?:ing)?\s+(?:on|in|across|through|over)\b|\bgood\s+to\s+go\b|\bwait(?:ing)?\b[^.]{0,20}\b(?:until|till|before|for\s+(?:it|them|the\s+(?:lawn|treatment|application|product|spray|area|grass|yard|surface|surfaces)))\b|\bhold\s+off\b|\bsit\s+tight\b|\b(?:can|could|may|will|should)\s+be\s+(?:used|walked|played|entered|accessed|mowed|watered|enjoyed)\b|\b(?:use|using)\s+(?:the\s+|your\s+)?(?:lawn|yard|grass|patio|deck|lanai|garden|pool|area|outdoors?)\b|\bavoid(?:ing)?\b[^.]{0,20}\b(?:area|areas|lawn|grass|yard|turf|treated|surfaces?|sod|patio|deck|lanai|garden|it)\b/;
// "go back out", "let them out", "be back outside": a re-entry movement (staff scheduling is excluded by the caller)
const REENTRY_MOVE_RE = /\b(?:go|goes|going|come|comes|coming|get|gets|getting|be|is|are|let|lets|letting|head|heads|heading)\b[^.!?\n]{0,20}\b(?:back\s+(?:out|outside|inside|in|on)|out\s+(?:on|to)|outside|outdoors)\b|\bon\s+(?:it|the\s+(?:lawn|grass|yard|treated))\b/;
const BEING_RE = /\b(?:pets?|dogs?|cats?|pups?|puppies|kittens?|animals?|kids?|children|child|toddlers?|babies|baby|people|persons?|family|families|everyone|everybody|anybody|nobody|folks|anyone|humans?|grandkids?|guests?|visitors?|neighbou?rs?|horses?|birds?|chickens?)\b/;
const ACTIVITY_RE = /\b(?:water(?:ing|ed)?|mow(?:ing|ed)?|irrigat\w*|sprinklers?|swim(?:ming)?|walk(?:ing)?|play(?:ing)?|garden(?:ing)?|weed(?:ing)?|edging|trim(?:ming)?)\b/;
const PERMISSION_RE = /\b(?:can|could|may|might|able|allowed|allow|permitted|ok|okay|alright|fine|safe|good|clear|cleared|free|ready|welcome|all\s+set|no\s+problem|not\s+a\s+(?:problem|concern|issue|worry)|no\s+need|no\s+worries|isn'?t\s+a\s+(?:problem|concern|issue))\b/;
// The state words of PERMISSION_RE without the modals (rain "can delay us" is not a clearance).
const CLEARANCE_STATE_RE = /\b(?:ok|okay|alright|fine|safe|good|clear|cleared|ready|all\s+set|no\s+problem|not\s+a\s+(?:problem|concern|issue|worry)|no\s+worries|isn'?t\s+a\s+(?:problem|concern|issue))\b/;
const DIRECTIVE_RE = /\b(?:keep|kept|keeping|stay|stays|staying|avoid|avoiding|wait|waiting|hold|holding|leave)\b/;
const MOVEMENT_RE = /\b(?:out|outside|outdoors?|inside|indoors?|back|off|onto|on\s+(?:it|the|your|that|this)|in\s+the\s+(?:yard|lawn|grass|garden|backyard))\b/;
// Telling a customer where the pets are when the tech arrives is access, not re-entry.
const ACCESS_RE = /\b(?:when|before|while|as)\s+(?:we|i|our\s+\w+|the\s+\w+|your\s+\w+)\s+(?:arrive|arrives|get|gets|come|comes|are|is|show|shows|stop|stops|head|pull)\b/;
// Pronoun clearance with no noun: "you're good", "it's fine", "all clear", "you'll be okay".
const PRONOUN_CLEARANCE_RE = /\b(?:you|it|they|everything|that|all|things|we|he|she|everyone|everybody|nobody)(?:'s|'re|'ll|'d|\s+(?:is|are|will|would|should|could|can|may|might|shall))?(?:\s+(?:be|been|get|stay|look))?\s+(?:all\s+)?(?:good|fine|ok|okay|safe|clear|set|free|ready)\b|\bin\s+the\s+clear\b|\bgreen\s+light\b/;
// A place cleared for use: "the lawn will be ready", "the yard is fine".
const PLACE_CLEARANCE_RE = /\b(?:yard|lawn|grass|turf|patio|deck|lanai|garden|pool|area|areas|surfaces?|treated\s+\w+)(?:'s)?\s+(?:is|are|will\s+be|should\s+be|would\s+be|'ll\s+be|be)\s+(?:all\s+)?(?:ready|good|fine|ok|okay|safe|clear|usable|dry)\b/;
const CLEARANCE_TIMING_RE = /\b(?:in\s+the\s+(?:morning|evening|afternoon)|lunchtime|dinnertime|bedtime|now|already|right\s+away|immediately|straight\s+away|at\s+once|then|later|soon|tomorrow|tonight|today|(?:this|next)\s+(?:morning|afternoon|evening|night|day|weekend)|(?:after|by|before|around|until|till)\s+(?:lunch|dinner|breakfast|noon|midnight|work|school|dark|sunset|sundown|sunrise|morning|evening|afternoon|night|that|then|tomorrow|tonight))\b/;
// "give it a bit", "let it dry / sit / set", "allow it time": a wait in other words.
const GIVE_IT_RE = /\b(?:give|giving|gave|allow|allowing|let|letting|leave|leaving)\s+(?:it|them|that|this|the\s+\w+)\s+(?:a\s+(?:bit|while|little|day|moment|minute|hour)|some\s+time|time|enough\s+time|plenty\s+of\s+time|overnight|dry|sit|set|settle|cure|rest|(?:\S+\s+){0,3}?(?:seconds?|minutes?|mins?|hours?|hrs?|days?|nights?|weeks?))\b/;
const TAKES_A_WHILE_RE = /\b(?:takes?|needs?|requires?|will\s+take|just\s+needs?)\s+(?:\S+\s+){0,2}?(?:a\s+while|some\s+time|a\s+bit|a\s+little|time|a\s+moment|a\s+half\s+day)\b/;
const WAIT_ALLOWED_RE = /\bwait(?:ing)?\s+(?:for|to\s+hear|on)\s+(?:us|our|my|a|an|the)?\s*(?:call|text|tech(?:nician)?|team|office|reply|message|email|confirmation|response|estimate|quote|invoice|link|update|callback)\b/;
const UNTIL_TIME_RE = /\b(?:until|till|til|through)\s+(?:tomorrow|tonight|morning|evening|noon|later|then|the\s+(?:morning|evening|next\s+day|weekend)|this\s+(?:evening|afternoon|weekend)|(?:mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?|sun)(?:day)?)\b/;
// Staff / scheduling language.
const STAFF_SUBJECT_RE = /\b(?:we|we'll|we're|we've|we'd|i|i'll|i'm|i've|our\s+(?:team|tech(?:nician)?s?|crew|office|dispatcher)|(?:the|a|your)\s+(?:tech(?:nician)?|team|crew|office|teammate|dispatcher|specialist)|tech(?:nician)?s?|teammates?|someone|somebody|dispatch|manager|owner|supervisor|coordinator|representative|rep|staff|specialist|scheduler|customer\s+service|support|adam)\b/;
const SCHEDULING_VERB_RE = /\b(?:be|arrive|arrives|arriving|come|comes|coming|stop|stops|stopping|swing|swings|swinging|head|heads|reach|reaches|call|calls|text|texts|email|emails|follow|follows|circle|circles|hear|respond|reply|get\s+back|getting\s+back|return|returns|show\s+up|drop\s+by|dispatch|send|visit|schedule|reschedule|contact|touch\s+base|check\s+(?:in|back|on))\b/;
// the scheduling noun IS the subject: "your next visit is in 3 weeks", "the arrival window is 2 hours"
const SCHEDULING_SUBJECT_RE = /\b(?:appointments?|visits?|windows?|arrivals?|follow-?ups?|callbacks?|inspections?|estimates?|quotes?|next\s+service|tech(?:nician)?)\s+(?:\w+\s+){0,2}?(?:is|are|was|will\s+be|starts?|runs?|lasts?|takes?|comes?|arrives?)\b/;
const SCHEDULE_WORD_RE = /\b(?:mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?|sun)(?:day)?s?\b|\b(?:tomorrow|tonight|next\s+(?:week|month|visit)|this\s+(?:week|weekend|morning|afternoon)|between|slot|opening|available|availability|window|arrival|arrive|arrives|appointments?)\b/;
const BUSINESS_RE = /\b(?:invoice|balance|payment|pay|paid|due|price|pricing|plan|membership|renew\w*|contract|guarantee[sd]?|warranty|cancel\w*|billing|bill|charge[sd]?|refund\w*|credit|autopay|subscription|re-?service|re-?treat\w*|callbacks?|open|opens|closed|closes|hours\s+of\s+operation|office\s+hours|business\s+hours|quote|estimate)\b/;
// Words that make a clause label-context: a quantity next to any of these is
// never scheduling, whoever the subject is.
const LABEL_CONTEXT_PARTS = [
  BEING_RE.source, ACTIVITY_RE.source, DRY_RE.source, REENTRY_TOPIC_RE.source, RAINFAST_RE.source,
  /\b(?:wait(?:ing)?|hold|sits?|sitting|treated|sprayed|applied|application|reapply|off|stay|keep|kept|safe|unsafe|toxic|residue|wet|damp|soaked)\b/.source,
];
const LABEL_CONTEXT_RE = new RegExp([...LABEL_CONTEXT_PARTS, RAIN_WORD_RE.source].join('|'));
// weather alone ("if rain is forecast in the next few days we'll reschedule") is no label context for a LONG span
const LABEL_CONTEXT_NO_RAIN_RE = new RegExp(LABEL_CONTEXT_PARTS.join('|'));

const STAY_OFF_CONTEXT_RE = new RegExp([BEING_RE.source, REENTRY_TOPIC_RE.source, DRY_RE.source, /\b(?:off|stay|keep|kept|wait)\b/.source].join('|'));
const CLAUSE_LINK_RE = /\s+(?:and|but|so|then|which|because|since|plus|though|although|whereas)\s+/;
// [{ clause, staffCarry, sentence, question }] for `text` (already lowercase).
function clausesOf(text) {
  // "8 and 10 AM" / "2 to 3 hours" stay one clause; a decimal point is not a sentence end.
  const prepared = text
    .replace(/(\d(?::\d\d)?\s*(?:[ap]\.?m\.?)?)\s+(?:and|through|to)\s+(?=\d)/g, '$1 - ')
    .replace(/\b([ap])\.m\./g, '$1m');
  const out = [];
  const parts = prepared.split(/([!?\n]+|\.(?!\d))/);
  for (let i = 0; i < parts.length; i += 2) {
    const sentence = parts[i];
    const question = /\?/.test(parts[i + 1] || '');
    let staffCarry = false;
    for (const raw of sentence.split(/[,;]+|:(?=\s|$)|\u2014|\s--\s/).flatMap((part) => part.split(CLAUSE_LINK_RE))) {
      const clause = raw.trim();
      if (!clause) continue;
      out.push({ clause, staffCarry, sentence, question });
      // a staff subject carries onto the NEXT clause of the same sentence only
      // while this clause is itself clean scheduling.
      staffCarry = STAFF_SUBJECT_RE.test(clause) && !LABEL_CONTEXT_RE.test(clause) && SCHEDULING_VERB_RE.test(clause);
    }
  }
  return out;
}

// Positive scheduling shapes for a quantity in a clause with NO label-context word.
function isSchedulingClause(clause, { staffCarry, clock, sentence = clause }) {
  if (LABEL_CONTEXT_RE.test(clause)) return false;
  if (BUSINESS_RE.test(clause)) return true;
  // staff subject, then a scheduling verb, then the quantity ("we'll be back out in a couple of days")
  if ((STAFF_SUBJECT_RE.test(clause) || staffCarry) && SCHEDULING_VERB_RE.test(clause)) return true;
  // "your next visit is in 3 weeks", "the arrival window is 2 hours"
  if (SCHEDULING_SUBJECT_RE.test(clause)) return true;
  // a clock time beside a scheduling word ("between 8 and 10 AM", "Thursday at 2 PM"), but never "until/by N"
  // (the whole sentence supplies the scheduling word and must itself carry no label context)
  if (clock && SCHEDULE_WORD_RE.test(sentence) && !LABEL_CONTEXT_RE.test(sentence) && !/\b(?:until|till|by)\b/.test(clause)) return true;
  return false;
}

const RAIN_REASSURE_RE = /\b(?:won'?t|will\s+not|doesn'?t|does\s+not|wouldn'?t|would\s+not|can'?t|cannot|shouldn'?t|should\s+not)\s+(?:\w+\s+){0,2}?(?:affect|hurt|harm|matter|damage|ruin|undo|change|impact|wash|remove|rinse|dilute|bother|be\s+(?:an?\s+)?(?:issue|problem|concern|worry))\b|\b(?:don'?t\s+worry|no\s+need\s+to\s+worry|nothing\s+to\s+worry|not\s+to\s+worry|(?:isn'?t|is\s+not|not)\s+(?:an?\s+)?(?:issue|problem|concern|worry))\b/;
function clauseIsLabelClaim({ clause: c, staffCarry, sentence, question, replyContext, replyDryCondition }) {
  const being = BEING_RE.test(c);
  const staffLed = (STAFF_SUBJECT_RE.test(c) || staffCarry) && !being;
  // a results timeline ("7 to 10 days", "a couple of weeks") is no duration claim
  // unless the clause carries label context (people, pets, dry, rain, stay-off, wait...)
  const duration = LABEL_CONTEXT_NO_RAIN_RE.test(c) ? hasDuration(c) : hasShortDuration(c);
  const clock = hasClockTime(c);
  if (duration || clock) return !isSchedulingClause(c, { staffCarry, clock: clock && !duration, sentence });
  if (RAINFAST_RE.test(c) || UNTIL_DRY_HOLD_RE.test(c)) return true;
  if (REENTRY_TOPIC_RE.test(c)) return true;
  if (UNTIL_TIME_RE.test(c) && !isSchedulingClause(c, { staffCarry, clock: true, sentence })) return true;
  if (GIVE_IT_RE.test(c) && !staffLed) return true;
  if (REENTRY_MOVE_RE.test(c) && !staffLed && !ACCESS_RE.test(c)) return true;
  if (TAKES_A_WHILE_RE.test(c) && DRY_RE.test(c)) return true;
  if (/\bwait(?:ing)?\b/.test(c) && !staffLed && !WAIT_ALLOWED_RE.test(c)) return true;
  // rain: "rain is fine / not a concern / don't worry / won't matter" needs the dried-and-bonded condition
  const rain = RAIN_WORD_RE.test(c);
  const rainSentence = RAIN_WORD_RE.test(sentence);
  if ((!replyDryCondition || CLEARANCE_TIMING_RE.test(c))
    && ((rain && CLEARANCE_STATE_RE.test(c)) || (rainSentence && RAIN_REASSURE_RE.test(c)))) return true;
  if (question) return false; // a question asks, it does not claim
  // people / pets, or a lawn activity, with permission, a directive or a movement word
  if ((being || ACTIVITY_RE.test(c)) && (PERMISSION_RE.test(c) || DIRECTIVE_RE.test(c) || MOVEMENT_RE.test(c)) && !staffLed && !ACCESS_RE.test(c)) return true;
  if (being && DRY_RE.test(c)) return true;
  // "it will be dry by tonight / after lunch / by the time you get home": a drying time in other words
  if (DRY_RE.test(c) && (CLEARANCE_TIMING_RE.test(c) || /\bby\s+the\s+time\b|\b(?:quick(?:ly)?|fast|rapidly|shortly|in\s+no\s+time|within)\b/.test(c)) && !staffLed) return true;
  // "tonight is fine", "tomorrow should be good": a day named as the clearance
  if (replyContext && /\b(?:tonight|tomorrow|today|this\s+(?:evening|afternoon|morning))\b(?:'s)?\s+(?:is\s+|will\s+be\s+|should\s+be\s+)?(?:fine|ok|okay|good|safe|clear)\b/.test(c) && !staffLed) return true;
  if (PLACE_CLEARANCE_RE.test(c) && !staffLed) return true;
  // "not before evening", "not until Thursday": a wait in other words
  if (/\bnot\s+(?:before|until|till)\b/.test(c) && !staffLed && !isSchedulingClause(c, { staffCarry, clock: true, sentence })) return true;
  // a bare unit beside label wording: "dries in hours", "off for days"
  if (LABEL_CONTEXT_NO_RAIN_RE.test(c) && /\b(?:hours|minutes|mins|hrs|overnight)\b/.test(c) && !isSchedulingClause(c, { staffCarry, clock: false, sentence })) return true;
  if (STAY_OFF_CONTEXT_RE.test(c) && /\b(?:days|nights|weeks)\b/.test(c) && !isSchedulingClause(c, { staffCarry, clock: false, sentence })) return true;
  // "they can go outside as soon as it's dry": a movement with permission, in a reply that is about drying / rain / pets
  if (replyContext && (PERMISSION_RE.test(c) || DIRECTIVE_RE.test(c)) && MOVEMENT_RE.test(c) && !staffLed && !ACCESS_RE.test(c)) return true;
  // "you're good", "all clear": only with a label-context sentence, or a "now / tomorrow / later" qualifier,
  // and never when the sentence is plainly about a booked day ("you're all set for Thursday").
  if (PRONOUN_CLEARANCE_RE.test(c)
    && (replyContext || CLEARANCE_TIMING_RE.test(c) || hasDuration(c))
    && !(SCHEDULE_WORD_RE.test(sentence) && !/\b(?:by|until|till|after|once|when|now|already|later|then|soon)\b/.test(sentence))) return true;
  return false;
}

/**
 * True when the remainder of a reply (`strippedText`, see stripLabelSentences)
 * still makes a label-context timing or clearance claim. Label timing is
 * given only by copying a LABEL FACTS sentence, so nothing else may claim it.
 */
function hasUngroundedLabelClaim(strippedText) {
  const text = canonText(strippedText).toLowerCase();
  // The reply as a whole is about label timing when it copied a sentence or
  // mentions drying, rain, pets or a stay-off anywhere.
  const replyContext = /labelsentence/.test(text) || LABEL_CONTEXT_RE.test(text);
  // "a treatment needs to dry and bond ... after that it holds up" / "once dried, rain is fine"
  const replyDryCondition = DRY_CONDITIONAL_RE.test(text) || /\bneeds?\s+to\s+dry\b/.test(text);
  return clausesOf(text).some((c) => clauseIsLabelClaim({ ...c, replyContext, replyDryCondition }));
}

// ---- Send-time recheck ---------------------------------------------------
// What a decision persists (input_snapshot.label_facts_snapshot) when its
// final reply copies a LABEL FACTS sentence: which customer and visit the
// figures came from and exactly which sentences went out.
function labelFactsSnapshotFor({ labelFacts, reply, sectionText }) {
  const copied = labelSentencesCopiedIn(reply, sectionText).map((s) => s.text);
  if (!copied.length || !labelFacts) return null;
  return {
    customer_id: labelFacts.customerId ?? null,
    visit_date: labelFacts.serviceDate,
    record_ids: Array.isArray(labelFacts.recordIds) ? labelFacts.recordIds.map(String).sort() : [],
    sentences: copied,
  };
}

/**
 * Send-time revalidation, the same refuse-don't-rewrite shape as the other
 * delayed-send checks. A body that still copies a snapshotted sentence must
 * still be backed by the customer's CURRENT latest performed visit: same
 * visit date, same service records, and the same sentence. A newer visit, a
 * visit today (the today guard now fires), a changed label or any lookup error
 * refuses. A body with no snapshotted sentence (edited out) needs no check.
 * Returns null when it may go out, else a short reason.
 */
async function labelFactsSendBlockReason({ snapshot, body, conn = db, today } = {}) {
  const sentences = snapshot && Array.isArray(snapshot.sentences) ? snapshot.sentences : [];
  if (!sentences.length) return null;
  const text = canonText(body).toLowerCase();
  const present = sentences.filter((s) => text.includes(sentenceCore(s).toLowerCase()));
  if (!present.length) return null;
  if (!snapshot.customer_id) return 'label_facts_recheck_no_customer';
  let current;
  try {
    current = await readLastVisitLabelFacts({ customerId: snapshot.customer_id, conn, ...(today ? { today } : {}) });
  } catch (err) {
    logger.warn(`[sms-label-facts] send-time recheck failed (${err.message}); refusing`);
    return 'label_facts_recheck_failed';
  }
  if (!current) return 'label_facts_no_longer_current';
  const same = current.serviceDate === snapshot.visit_date
    && JSON.stringify(current.recordIds) === JSON.stringify([...(snapshot.record_ids || [])].map(String).sort());
  if (!same) return 'label_facts_visit_changed';
  const nowTexts = labelFactsSentences(current).map((s) => s.text);
  return present.every((s) => nowTexts.includes(s)) ? null : 'label_facts_changed';
}

// ---- Which visit is the customer asking about? ---------------------------
// LABEL FACTS speaks for the customer's LATEST performed visit. A message that
// points at a different visit (a future one, or an older one) gets the none-on-file
// section instead. Conservative: anything ambiguous reads as a different visit.
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const WEEKDAY_ABBR_RE = /\b(sun|mon|tues?|wed|thu(?:rs?)?|fri|sat)(?:day|nesday|rsday|urday)?s?\b/g;
const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const FUTURE_VISIT_RE = /\b(?:tomorrow|tonight|upcoming|scheduled|next\s+(?:visit|treatment|service|spray|spraying|application|time|week|month|appointment|round|one|apt)|your\s+next|this\s+(?:coming|upcoming)|when\s+(?:you|y'?all|ya|the\s+(?:tech|technician|guy|man|team)|he|she|they|we|adam)\s+(?:come|comes|coming|get|gets|getting|are|is|arrive|arrives|show|swing|stop|spray|treat|do|did)|(?:coming|swinging|stopping)\s+(?:out|by)|before\s+(?:you|the\s+(?:tech|technician))\s+(?:come|comes|arrive)|will\s+(?:be\s+)?(?:spray|treat|apply)\w*|going\s+to\s+(?:spray|treat|apply)|plan(?:ning)?\s+to\s+(?:spray|treat|apply)|in\s+(?:a\s+)?(?:few|couple|\d+)\s+(?:days|weeks)|later\s+this)\b/;
const OLDER_VISIT_RE = /\b(?:previous|prior|earlier|before\s+that|last\s+(?:week|month|year|quarter|spring|summer|fall|winter)|(?:weeks?|months?|years?)\s+ago|a\s+while\s+(?:ago|back)|the\s+(?:other|first)\s+time|two\s+visits?\s+ago|second\s+to\s+last)\b/;

function isoAddDays(iso, days) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/**
 * True when the inbound message refers to a visit other than the facts' visit
 * (`visitDate`, YYYY-MM-DD, `today` the ET date). Errs toward true.
 */
function inboundRefersToOtherVisit(inboundText, visitDate, today = etDateString()) {
  const text = canonText(inboundText).toLowerCase();
  if (!text || !/^\d{4}-\d{2}-\d{2}$/.test(String(visitDate || ''))) return false;
  if (FUTURE_VISIT_RE.test(text) || OLDER_VISIT_RE.test(text)) return true;
  const visit = new Date(`${visitDate}T12:00:00Z`);
  const sinceVisit = Math.round((new Date(`${today}T12:00:00Z`) - visit) / 86400000);
  // "yesterday" / "N days ago" resolve against today and must land on the visit date
  if (/\byesterday\b/.test(text) && isoAddDays(today, -1) !== visitDate) return true;
  for (const m of text.matchAll(/\b(\d{1,3}|a|one|two|three|four|five|six|seven)\s+days?\s+ago\b/g)) {
    const words = { a: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7 };
    const n = words[m[1]] ?? Number(m[1]);
    if (isoAddDays(today, -n) !== visitDate) return true;
  }
  // a weekday name: only the visit's own weekday, and only when the visit was within the last 6 days
  for (const m of text.matchAll(WEEKDAY_ABBR_RE)) {
    const name = WEEKDAYS.find((w) => w.startsWith(m[1].slice(0, 3)));
    if (!name || name !== WEEKDAYS[visit.getUTCDay()] || sinceVisit < 0 || sinceVisit > 6) return true;
  }
  // an explicit date ("Sep 29", "September 29th", "9/29", "9/29/26") must be the visit's date
  const [vy, vmo, vday] = visitDate.split('-').map(Number);
  for (const m of text.matchAll(new RegExp(`\\b(${MONTH_NAMES.map((n) => n.slice(0, 3)).join('|')})[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'g'))) {
    if (MONTH_NAMES.findIndex((n) => n.startsWith(m[1])) + 1 !== vmo || Number(m[2]) !== vday) return true;
  }
  for (const m of text.matchAll(/(?<![\d/])(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?(?![\d/])/g)) {
    const yr = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : vy;
    if (Number(m[1]) !== vmo || Number(m[2]) !== vday || yr !== vy) return true;
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
  LABEL_FACTS_HEADER_PREFIX,
  LABEL_FACTS_TIMEOUT_MS,
  readLastVisitLabelFacts,
  fetchLabelFacts,
  renderLabelFactsSection,
  labelFactsSentences,
  labelFactsSectionFrom,
  labelSentencesIn,
  labelSentencesCopiedIn,
  groundedLineKinds,
  stripLabelSentences,
  hasUngroundedLabelClaim,
  labelFactsSnapshotFor,
  labelFactsSendBlockReason,
  inboundRefersToOtherVisit,
};
