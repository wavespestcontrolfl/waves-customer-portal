'use strict';
// LABEL FACTS for the texting agent (owner ruling 2026-09-30): the agent MAY
// quote a label's rainfast and re-entry times, but only from the label of a
// product actually applied at THAT customer's visit. This module is the
// whole feature's data + wording + grounding logic:
//
//   readLastVisitLabelFacts()   DB read: the customer's most recent performed
//                               visit -> service_products + the label facts
//                               frozen on the visit's service record.
//   renderLabelFactsSection()   the per-draft facts section (gate-on only; the
//                               drafter passes it in through buildFactsBlock).
//                               Each line is ONE exact customer-safe sentence.
//   stripLabelSentences() +     the deterministic compliance guard (the EXACT-
//   hasUngroundedLabelClaim()   SENTENCE CONTRACT): label timing reaches a
//                               customer only by copying a rendered sentence
//                               word for word. The sentences are stripped from
//                               the reply and ANY label-context timing or
//                               clearance claim left over is held.
//   labelFactsSendBlockReason() the send-time recheck of a delayed reply: the
//                               reply guard on the FINAL body (an edited sentence
//                               is no longer authorized) plus the visit recheck.
//   looksNonEnglish()           the label sentences are English: a text in another
//                               language gets none on file, and the guard holds
//                               non-English timing vocabulary (nonEnglishTimingWords).
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
const REENTRY_PLACEHOLDER_RE = /^follow the product label and technician service report[^.]*\.?$/i;

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
// value. Trust a frozen 0 only when the frozen summary itself says a plain until dry.
function frozenReiHours(frozen) {
  const hours = frozen.reentryHours == null ? null : Number(frozen.reentryHours);
  if (hours !== 0) return hours;
  const parsed = parseReentryText(frozen.reentrySummary);
  return parsed && parsed.kind === 'until_dry' ? 0 : null;
}

// One service_products row -> a customer-visible verified product, 'unverified'
// (counted, omitted) or null (adjuvant / water conditioner / not
// customer-visible). `frozen` is the product's snapshot facts (frozenFactsFor),
// or null. The unverified check runs FIRST, so nothing can be hidden by being
// (re)classified as an adjuvant: an applied product with no verified frozen
// label always counts and voids the visit's figures. Classification reads
// completion-time data only (the frozen facts' category / productType and the
// service_products row written at completion), never the live catalog row
// (its category can be edited after the visit).
function productFromRow(row, frozen) {
  const f = frozen || {};
  if (!f.labelVerifiedAt) return 'unverified';
  const family = classifyProduct({
    productName: row.product_name, activeIngredient: row.active_ingredient, productCategory: row.product_category,
    catalogCategory: f.category, catalogProductType: f.productType,
  });
  const def = PRODUCT_FAMILIES[family];
  if (!def || !def.customerVisible) return null;
  if ([row.product_category, f.category, f.productType, row.product_name].some((c) => c && WATER_CONDITIONER_RE.test(String(c)))) return null;
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
    .whereIn('sp.service_record_id', recordIds)
    .orderBy([{ column: 'sp.applied_at', order: 'asc' }, { column: 'sp.id', order: 'asc' }])
    .select(
      'sp.id', 'sp.service_record_id', 'sp.product_id', 'sp.product_name', 'sp.active_ingredient', 'sp.product_category',
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
// A re-entry text is understood ONLY in these accepted shapes (an allowlist):
//   [lead] [plain until-dry | ONE plain duration in digits] [.]
// where the lead is a plain keep-off / do-not-enter / safe-for phrase. Anything
// else - a second clause, "or", "for pets", "watered in", "unless", a range, a
// spelled or vague figure, children, at least ... - is not understood, so the
// re-entry is unknown. The whole text is read (no truncation).
const REENTRY_SUBJECT_SRC = 'people\\s+and\\s+pets|pets\\s+and\\s+people|people|persons|pets|everyone';
const REENTRY_AREA_SRC = '(?:the\\s+)?(?:treated\\s+)?(?:areas?|lawn|grass|yard|surfaces?)';
const REENTRY_LEAD_SRC = `(?:(?:keep|stay)\\s+(?:(?:${REENTRY_SUBJECT_SRC})\\s+)?(?:off|out\\s+of)(?:\\s+${REENTRY_AREA_SRC})?|(?:do\\s+not|don't)\\s+(?:re-?enter|enter)(?:\\s+${REENTRY_AREA_SRC})?|(?:safe|ok|okay)\\s+for\\s+(?:${REENTRY_SUBJECT_SRC})|re-?entry(?:\\s+(?:is\\s+)?(?:allowed|permitted))?|wait)`;
const REENTRY_UNTIL_DRY_SRC = "(?:until|once|when)\\s+(?:(?:it(?:\\s+is|'s|\\s+has)?|the\\s+(?:spray|treatment|application|product|areas?|surfaces?)\\s+(?:is|are|has|have))\\s+)?(?:(?:completely|fully|thoroughly)\\s+)?(?:dry|dried)";
const REENTRY_DURATION_SRC = '(?:for\\s+)?(\\d+(?:\\.\\d+)?)\\s*(hours?|hrs?|minutes?|mins?|days?)(?:\\s+after\\s+(?:the\\s+)?(?:application|spraying|treatment))?';
const REENTRY_SHAPE_RE = new RegExp(`^(?:${REENTRY_LEAD_SRC})?\\s*(?:(${REENTRY_UNTIL_DRY_SRC})|${REENTRY_DURATION_SRC})?\\s*\\.?$`, 'i');
const HOURS_PER_UNIT = { m: 1 / 60, h: 1, d: 24 };
// { kind: 'none' } (no statement / the catalog placeholder), { kind: 'until_dry' },
// { kind: 'hours', hours }, or null (not an accepted shape: unknown).
function parseReentryText(text) {
  const t = singleLine(canonText(text), Infinity);
  if (!t || REENTRY_PLACEHOLDER_RE.test(t)) return { kind: 'none' };
  const m = REENTRY_SHAPE_RE.exec(t);
  // belt and braces: the generic quantity matchers (digits, spelled, vague) must find exactly what the shape did
  const stated = [...t.matchAll(new RegExp(TIME_EXPR_RE.source, 'gi'))].length + [...t.matchAll(new RegExp(SPELLED_QTY_RE.source, 'gi'))].length;
  if (!m) return null;
  if (m[1]) return stated === 0 ? { kind: 'until_dry' } : null;
  if (m[2]) return stated === 1 ? { kind: 'hours', hours: Number(m[2]) * HOURS_PER_UNIT[m[3][0].toLowerCase()] } : null;
  return stated === 0 ? { kind: 'none' } : null;
}
// Re-entry level per product, in hours: a positive frozen figure stands only when
// every text the product carries says the same figure or nothing; 0 (the
// residential value, "until dry") only when no text states a duration; a null
// figure only from a plain until-dry text. Anything else is unknown, and one
// unknown product makes the whole-visit re-entry unstatable (line omitted).
function reentryLevelHours(product) {
  const parsed = [product.reentrySummary, product.reentryText].filter(Boolean).map(parseReentryText);
  if (parsed.includes(null)) return null;
  const figures = parsed.filter((x) => x.kind === 'hours');
  const untilDry = parsed.some((x) => x.kind === 'until_dry');
  if (Number.isFinite(product.reiHours) && product.reiHours > 0) {
    return !untilDry && figures.every((x) => Math.abs(x.hours - product.reiHours) < 1e-9) ? product.reiHours : null;
  }
  if (product.reiHours === 0) return figures.length ? null : 0;
  return untilDry && !figures.length ? 0 : null;
}
// { hours, untilDry } for the whole visit, or null when ANY product's re-entry
// is unknown. `untilDry` with hours > 0 is the mixed case (a fixed figure on
// one product, "until dry" on another): stated as "at least N hours AND until
// dry, whichever is later", never as just the hour figure. (A single product
// never carries both: a figure whose own text says "until dry" is unknown.)
function wholeVisitReentry(products) {
  const levels = products.map(reentryLevelHours);
  if (!levels.length || levels.some((l) => l == null)) return null;
  const hours = Math.max(...levels);
  const untilDry = hours === 0 || levels.some((l) => l === 0);
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
// A COMPLETE copy of an authorized sentence: the whole sentence including its
// terminal period, starting at a word boundary and followed only by the end of
// the text or whitespace and a NEW sentence (not a lowercase continuation).
// "... for 4 hours or less.", "... for 4 hours, unless it rains." and
// "... for 4 hours. or so" are therefore not copies and are never stripped.
// Copying, stripping and the send-time recheck all use this one matcher.
// A fragment that reopens the copied sentence ("... for 4 hours. Or sooner.",
// ". At the latest.", ". Unless it rains.") is a modifier, so it is no new sentence.
const MODIFIER_FRAGMENT_RE = /^(?:or|unless|at\s+(?:the\s+)?(?:most|least|latest|earliest)|max|maybe|perhaps|roughly|approx\w*|give\s+or\s+take|sooner|earlier|though|but|however|usually|typically|sometimes|depending|weather)\b/i;
const copyEndsCleanly = (rest) => rest === '' || (/^\s+(?![a-z])/.test(rest) && !MODIFIER_FRAGMENT_RE.test(rest.trim()));
// [{ start, end }] over `canon` (canonText output).
function completeCopies(canon, sentence) {
  const out = [];
  for (const m of canon.matchAll(new RegExp(escapeRegex(canonText(sentence)), 'gi'))) {
    const end = m.index + m[0].length;
    if ((m.index === 0 || !/[\p{L}\p{N}]/u.test(canon[m.index - 1])) && copyEndsCleanly(canon.slice(end))) out.push({ start: m.index, end });
  }
  return out;
}
const copiesSentence = (reply, sentence) => completeCopies(canonText(reply), sentence).length > 0;

/** The rendered sentences of `sectionText` that `reply` copies completely and verbatim (case-insensitive after canonText). */
function labelSentencesCopiedIn(reply, sectionText) {
  return labelSentencesIn(sectionText).filter((s) => copiesSentence(reply, s.text));
}

/**
 * `text` (canonText-normalized) with every complete verbatim copy of a LABEL
 * FACTS sentence replaced by a clause break, so what remains is exactly the
 * part of the reply the guard must judge. Every other screen reads this same remainder.
 */
function stripLabelSentences(text, sectionText) {
  let out = canonText(text);
  for (const s of labelSentencesIn(sectionText)) {
    for (const { start, end } of completeCopies(out, s.text).reverse()) out = `${out.slice(0, start)} ; labelsentence ; ${out.slice(end)}`;
  }
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
const REENTRY_MOVE_RE = /\b(?:go|goes|going|come|comes|coming|get|gets|getting|be|is|are|let|lets|letting|head|heads|heading)\b[^.!?\n]{0,20}\b(?:back\s+(?:out|outside|inside|in|on)|out\s+(?:on|to)|outside|outdoors|in\s+the\s+(?:yard|lawn|grass|garden|backyard))\b|(?<!\bus\s+(?:to\s+)?)\b(?:go|goes|going|gone|come|comes|coming|let|lets|letting)\s+(?:\w+\s+){0,2}?out\b(?!\s+of\b)|\bon\s+(?:it|the\s+(?:lawn|grass|yard|treated))\b/;
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
// Staff named INSIDE a post-treatment time anchor ("after we leave", "once we're done", "when the tech finishes")
// is a time reference, not the subject who moves, so it never makes a clause staff-led: "they can go out
// after we leave" is a re-entry permission. ("before we arrive" is not stripped: that is pre-visit access.)
const STAFF_TIME_ANCHOR_RE = /\b(?:after|once|when|whenever|as\s+soon\s+as|until|till|following)\s+(?:we|i|the\s+(?:tech(?:nician)?|team|crew)|our\s+\w+)(?:'ve|'re|'m|\s+(?:are|have|has|is|get|got))?\s+(?:leave|leaves|left|finish|finishes|finished|done|through|spray|sprays|sprayed|treat|treats|treated|wrap|wraps|wrapped|complete|completes|completed|apply|applies|applied|go|gone|head|headed|out)\b/g;
const withoutTimeAnchors = (clause) => clause.replace(STAFF_TIME_ANCHOR_RE, ' ');
const staffSubjectIn = (clause) => STAFF_SUBJECT_RE.test(withoutTimeAnchors(clause));
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
      staffCarry = staffSubjectIn(clause) && !LABEL_CONTEXT_RE.test(clause) && SCHEDULING_VERB_RE.test(clause);
    }
  }
  return out;
}

// Positive scheduling shapes for a quantity in a clause with NO label-context word.
function isSchedulingClause(clause, { staffCarry, clock, sentence = clause }) {
  if (LABEL_CONTEXT_RE.test(clause)) return false;
  if (BUSINESS_RE.test(clause)) return true;
  // staff subject, then a scheduling verb, then the quantity ("we'll be back out in a couple of days")
  if ((staffSubjectIn(clause) || staffCarry) && SCHEDULING_VERB_RE.test(clause)) return true;
  // "your next visit is in 3 weeks", "the arrival window is 2 hours"
  if (SCHEDULING_SUBJECT_RE.test(clause)) return true;
  // a clock time beside a scheduling word ("between 8 and 10 AM", "Thursday at 2 PM"), but never "until/by N"
  // (the whole sentence supplies the scheduling word and must itself carry no label context)
  if (clock && SCHEDULE_WORD_RE.test(sentence) && !LABEL_CONTEXT_RE.test(sentence) && !/\b(?:until|till|by)\b/.test(clause)) return true;
  return false;
}

// PRE-visit access guidance ("keep your dogs inside before we arrive", "gate unlocked so the tech can get
// to the yard") is scheduling logistics, not a re-entry claim. It needs an explicit pre-visit phrase in the
// sentence AND nothing post-treatment: no after/until/dry/rest-of-the-day wording, no quantity.
const PRE_VISIT_PHRASE_RE = /\bfor\s+(?:the|our|your)\s+(?:visit|appointment|service|treatment\s+visit)\b|\bwhile\s+(?:we|i|the\s+\w+|our\s+\w+)\s+(?:is|are|will\s+be|'re)\s+(?:there|here|on\s+site|on\s+the\s+property|working|servicing)\b|\bso\s+(?:we|i|the\s+\w+|our\s+\w+)\s+(?:can|could|will)\s+(?:get|reach|access|walk|enter|work)\b|\bgate\s+(?:is\s+|stays\s+|left\s+)?unlocked\b|\bunlock(?:ed)?\s+the\s+gate\b/;
const POST_TREATMENT_SIGNAL_RE = /\b(?:after\w*|until|till|til|once|then|again|later|tonight|tomorrow|rest\s+of|remainder|following|dr(?:y|ies|ied|ying)|treated|applied|application|wet|damp|overnight|all\s+(?:day|night)|hours?|days?|minutes?)\b/;
function isPreVisitAccess(sentence) {
  return (ACCESS_RE.test(withoutTimeAnchors(sentence)) || PRE_VISIT_PHRASE_RE.test(sentence)) && !POST_TREATMENT_SIGNAL_RE.test(sentence) && !hasDuration(sentence) && !hasClockTime(sentence);
}

const RAIN_REASSURE_RE = /\b(?:won'?t|will\s+not|doesn'?t|does\s+not|wouldn'?t|would\s+not|can'?t|cannot|shouldn'?t|should\s+not)\s+(?:\w+\s+){0,2}?(?:affect|hurt|harm|matter|damage|ruin|undo|change|impact|wash|remove|rinse|dilute|bother|be\s+(?:an?\s+)?(?:issue|problem|concern|worry))\b|\b(?:don'?t\s+worry|no\s+need\s+to\s+worry|nothing\s+to\s+worry|not\s+to\s+worry|(?:isn'?t|is\s+not|not)\s+(?:an?\s+)?(?:issue|problem|concern|worry))\b/;
// The facts one clause is judged on. `sched(clock)` is the positive-scheduling
// shape check for this clause, with or without a clock time beside it.
function clauseFacts({ clause, staffCarry, sentence, question, replyContext, replyDryCondition }) {
  const being = BEING_RE.test(clause);
  // a results timeline ("7 to 10 days", "a couple of weeks") is no duration claim
  // unless the clause carries label context (people, pets, dry, rain, stay-off, wait...)
  const duration = LABEL_CONTEXT_NO_RAIN_RE.test(clause) ? hasDuration(clause) : hasShortDuration(clause);
  return {
    c: clause, sentence, question, replyContext, replyDryCondition, being,
    staffLed: (staffSubjectIn(clause) || staffCarry) && !being,
    duration,
    clock: hasClockTime(clause),
    rain: RAIN_WORD_RE.test(clause),
    rainSentence: RAIN_WORD_RE.test(sentence),
    preVisit: isPreVisitAccess(sentence),
    sched: (clock) => isSchedulingClause(clause, { staffCarry, clock, sentence }),
  };
}

const NOT_BEFORE_RE = /\bnot\s+(?:before|until|till)\b/;
const WAIT_RE = /\bwait(?:ing)?\b/;
const DRY_QUICKLY_RE = /\bby\s+the\s+time\b|\b(?:quick(?:ly)?|fast|rapidly|shortly|in\s+no\s+time|within)\b/;
const DAY_CLEARANCE_RE = /\b(?:tonight|tomorrow|today|this\s+(?:evening|afternoon|morning))\b(?:'s)?\s+(?:is\s+|will\s+be\s+|should\s+be\s+)?(?:fine|ok|okay|good|safe|clear)\b/;
const BARE_UNIT_RE = /\b(?:hours|minutes|mins|hrs|overnight)\b/;
const BARE_LONG_UNIT_RE = /\b(?:days|nights|weeks)\b/;
const BOOKED_DAY_QUALIFIER_RE = /\b(?:by|until|till|after|once|when|now|already|later|then|soon)\b/;
const noAccessNoStaff = (x) => !x.staffLed && !ACCESS_RE.test(withoutTimeAnchors(x.c)) && !x.preVisit;

// A clause is a label claim when ANY rule holds, evaluated in order. A clause
// with a duration or a clock time is decided by scheduling alone (first rule,
// decisive); a question asks and does not claim, so it stops the rules that
// follow it.
const CLAIM_RULES_BEFORE_QUESTION = [
  { name: 'rainfast or until-dry wording', test: (x) => RAINFAST_RE.test(x.c) || UNTIL_DRY_HOLD_RE.test(x.c) },
  { name: 're-entry / stay-off wording', test: (x) => REENTRY_TOPIC_RE.test(x.c) && !x.preVisit },
  { name: 'until a time that is not scheduling', test: (x) => UNTIL_TIME_RE.test(x.c) && !x.sched(true) },
  { name: 'give it time', test: (x) => GIVE_IT_RE.test(x.c) && !x.staffLed },
  { name: 're-entry movement', test: (x) => REENTRY_MOVE_RE.test(x.c) && noAccessNoStaff(x) },
  { name: 'takes a while to dry', test: (x) => TAKES_A_WHILE_RE.test(x.c) && DRY_RE.test(x.c) },
  { name: 'a wait that is not for staff', test: (x) => WAIT_RE.test(x.c) && !x.staffLed && !WAIT_ALLOWED_RE.test(x.c) },
  // rain: "rain is fine / not a concern / don't worry / won't matter" needs the dried-and-bonded condition
  {
    name: 'rain clearance or reassurance',
    test: (x) => (!x.replyDryCondition || CLEARANCE_TIMING_RE.test(x.c))
      && ((x.rain && CLEARANCE_STATE_RE.test(x.c)) || (x.rainSentence && RAIN_REASSURE_RE.test(x.c))),
  },
];
const CLAIM_RULES_AFTER_QUESTION = [
  // people / pets, or a lawn activity, with permission, a directive or a movement word
  {
    name: 'people, pets or an activity with permission, a directive or a movement',
    test: (x) => (x.being || ACTIVITY_RE.test(x.c)) && (PERMISSION_RE.test(x.c) || DIRECTIVE_RE.test(x.c) || MOVEMENT_RE.test(x.c)) && noAccessNoStaff(x),
  },
  { name: 'people or pets beside drying', test: (x) => x.being && DRY_RE.test(x.c) },
  // "it will be dry by tonight / after lunch / by the time you get home": a drying time in other words
  { name: 'a drying time in other words', test: (x) => DRY_RE.test(x.c) && (CLEARANCE_TIMING_RE.test(x.c) || DRY_QUICKLY_RE.test(x.c)) && !x.staffLed },
  // "tonight is fine", "tomorrow should be good": a day named as the clearance
  { name: 'a day named as the clearance', test: (x) => x.replyContext && DAY_CLEARANCE_RE.test(x.c) && !x.staffLed },
  { name: 'a place cleared for use', test: (x) => PLACE_CLEARANCE_RE.test(x.c) && !x.staffLed },
  // "not before evening", "not until Thursday": a wait in other words
  { name: 'not before / until', test: (x) => NOT_BEFORE_RE.test(x.c) && !x.staffLed && !x.sched(true) },
  // a bare unit beside label wording: "dries in hours", "off for days"
  { name: 'a bare unit beside label wording', test: (x) => LABEL_CONTEXT_NO_RAIN_RE.test(x.c) && BARE_UNIT_RE.test(x.c) && !x.sched(false) },
  { name: 'days beside stay-off wording', test: (x) => STAY_OFF_CONTEXT_RE.test(x.c) && BARE_LONG_UNIT_RE.test(x.c) && !x.sched(false) },
  // "they can go outside as soon as it's dry": a movement with permission, in a reply about drying / rain / pets
  {
    name: 'a movement with permission in a label-context reply',
    test: (x) => x.replyContext && (PERMISSION_RE.test(x.c) || DIRECTIVE_RE.test(x.c)) && MOVEMENT_RE.test(x.c) && noAccessNoStaff(x),
  },
  // "you're good", "all clear": only with a label-context sentence, or a "now / tomorrow / later" qualifier,
  // and never when the sentence is plainly about a booked day ("you're all set for Thursday").
  {
    name: 'pronoun clearance',
    test: (x) => PRONOUN_CLEARANCE_RE.test(x.c)
      && (x.replyContext || CLEARANCE_TIMING_RE.test(x.c) || hasDuration(x.c))
      && !(SCHEDULE_WORD_RE.test(x.sentence) && !BOOKED_DAY_QUALIFIER_RE.test(x.sentence)),
  },
];
const holds = (rules, x) => rules.some((r) => r.test(x));

// An explicit clock time ("9:00 AM - 11:00 AM", "at 2 PM") with no label-context word in its clause is an
// appointment offer, not timing: it does not decide the clause and the ordinary rules still read it.
// A relative anchor ("by 5", "after 3:30 pm", "around 3", "5ish") is never plain: it can be a drying time.
const ANCHORED_CLOCK_RE = /\b(?:by|until|till|til|after|before|around|about|through|past)\s+(?:1[0-2]|[1-9])(?::[0-5]\d)?(?:\s*[ap]\.?m\.?)?(?!\d)|\b\d{1,2}ish\b|\b(?:by|until|till|before|after)\s+(?:noon|midnight)\b/g;
// Clearance wording beside a time ("it will be ready at 2 PM", "fine at 3:30") stays a claim unless the clause is a
// question or plainly offers / books a time ("how about", "between", "open", "works", "appointment", "arrive").
const CLEARANCE_ANY_RE = new RegExp([PERMISSION_RE, CLEARANCE_STATE_RE, PRONOUN_CLEARANCE_RE, PLACE_CLEARANCE_RE].map((re) => re.source).join('|'));
const OFFER_CUE_RE = /\b(?:how\s+about|between|open|openings?|available|slots?|works?|appointments?|visits?|arriv\w+|stop\s+by|see\s+you|come|book(?:ed|ing)?|schedule[ds]?|windows?)\b/;
const isPlainClockOffer = (x) => x.clock && !x.duration && !LABEL_CONTEXT_RE.test(x.c)
  && hasClockTime(x.c.replace(ANCHORED_CLOCK_RE, ' '))
  && (x.question || !CLEARANCE_ANY_RE.test(x.c) || OFFER_CUE_RE.test(x.c));

function clauseIsLabelClaim(input) {
  const x = clauseFacts(input);
  if (x.duration || (x.clock && !isPlainClockOffer(x))) return !x.sched(x.clock && !x.duration);
  if (holds(CLAIM_RULES_BEFORE_QUESTION, x)) return true;
  return !x.question && holds(CLAIM_RULES_AFTER_QUESTION, x);
}

/**
 * True when the remainder of a reply (`strippedText`, see stripLabelSentences)
 * still makes a label-context timing or clearance claim. Label timing is
 * given only by copying a LABEL FACTS sentence, so nothing else may claim it.
 */
function hasUngroundedLabelClaim(strippedText) {
  const text = canonText(strippedText).toLowerCase();
  // The clause rules are English: another language's timing words are held outright.
  if (nonEnglishTimingWords(text)) return true;
  // The reply as a whole is about label timing when it copied a sentence or
  // mentions drying, rain, pets or a stay-off anywhere.
  const replyContext = /labelsentence/.test(text) || LABEL_CONTEXT_RE.test(text);
  // "a treatment needs to dry and bond ... after that it holds up" / "once dried, rain is fine"
  const replyDryCondition = DRY_CONDITIONAL_RE.test(text) || /\bneeds?\s+to\s+dry\b/.test(text);
  return clausesOf(text).some((c) => clauseIsLabelClaim({ ...c, replyContext, replyDryCondition }));
}

// ---- Other languages ------------------------------------------------------
// The label sentences and every clause rule above are ENGLISH. A reply (or a
// question) in Spanish, Portuguese or French would slip past them, so the guard
// also holds the timing / re-entry / rain vocabulary of those languages, and a
// text that looks non-English gets the none-on-file section (no sentence to copy).
const stripMarks = (text) => String(text || '').normalize('NFD').replace(/\p{M}/gu, '');
const foreignWords = (list) => new RegExp(`(?<![\\p{L}])(?:${list})(?![\\p{L}])`, 'iu');
// [{ language, re }]: time units, pets / people, rain, drying, going out, waiting, lawn.
// Compared after accents are removed and case folded (dias = días, nino = niño).
const NON_ENGLISH_TIMING_VOCAB = [
  { language: 'es', re: foreignWords('horas?|minutos?|dias?|semanas?|noches?|madrugada|mascotas?|perros?|gatos?|ninos?|ninas?|familia|lluvia|llover|llueve|lloviendo|mojad[oa]s?|seco|seca|secos|secas|secar|secarse|seque|sequen|secado|seguro|segura|seguros|seguras|caminar|jugar|pisar|regar|tormentas?|aguacero|afuera|fuera|salir|salgan|salga|esperar|espere|esperen|espera|esperan|antes\\s+de|hasta\\s+que|cesped|pasto|grama|jardin|rociado|aplicacion|tratamiento|reingreso|entrar|volver') },
  { language: 'pt', re: foreignWords('horas?|minutos?|dias?|semanas?|noites?|animais|criancas?|chuva|chover|chove|molhad[oa]s?|secar|seco|seca|secou|esperar|espere|aguarde|aguardar|gramado|grama|quintal|tratamento|aplicacao|sair|saiam') },
  { language: 'fr', re: foreignWords('heures?|jours?|semaines?|nuits?|animaux|chiens?|enfants?|pluie|pleuvoir|pleut|seche|secher|sechent|attendre|attendez|dehors|sortir|gazon|pelouse|traitement') },
];
// Everyday non-English words that are not English words: one is enough. The WEAK
// ones (common in short non-English text, rare in English) need two.
const NON_ENGLISH_STRONG_RE = foreignWords('hola|gracias|buenos|buenas|cuando|cuanto|puedo|pueden|puede|quiero|quisiera|tengo|por\\s+favor|senora|senor|ustedes|usted|obrigad[oa]|voce|nao|bonjour|merci|bonsoir|vous|nous|donde|manana|saludos');
const NON_ENGLISH_WEAK_RE = new RegExp('(?<![\\p{L}])(?:de|la|el|los|las|que|un|una|por|para|con|su|sus|es|esta|estan|del|al|muy|como|pero|tiene|tambien|uma|com|est|une|les|des|pour|avec)(?![\\p{L}])', 'giu');
const NON_ENGLISH_MARKS_RE = /[\u00BF\u00A1]/;
// A script this guard cannot read at all (Cyrillic, Arabic, CJK ...): unverifiable, so held.
const UNREADABLE_SCRIPT_RE = /[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u;
function looksNonEnglish(text) {
  const raw = String(text || '');
  if (NON_ENGLISH_MARKS_RE.test(raw)) return true;
  if (UNREADABLE_SCRIPT_RE.test(raw)) return true;
  const t = stripMarks(canonText(raw).toLowerCase());
  if (NON_ENGLISH_STRONG_RE.test(t)) return true;
  return (t.match(NON_ENGLISH_WEAK_RE) || []).length >= 2 || NON_ENGLISH_TIMING_VOCAB.some((v) => v.re.test(t));
}
// The greeting "buenos dias" says no timing; everything else in the table is held.
const NON_ENGLISH_GREETING_RE = /(?<![\p{L}])buen(?:os|as)\s+(?:dias|noches)(?![\p{L}])/giu;
function nonEnglishTimingWords(text) {
  const t = stripMarks(canonText(text).toLowerCase()).replace(NON_ENGLISH_GREETING_RE, ' ');
  return UNREADABLE_SCRIPT_RE.test(t) || NON_ENGLISH_TIMING_VOCAB.some((v) => v.re.test(t));
}

// ---- The reply guard on a final body -------------------------------------
// "Safe once dry" with the technician confirming timing is the one sanctioned
// idiom: it carries no timing modifier, so it is swapped for a neutral token
// before the guard reads the reply (unless it names a time: "safe once dry in 30 minutes").
const SANCTIONED_SAFE_RE = /(?<![\w-])safe\s+(?:once|when|after)\s+(?:it(?:'s| is| has)?\s+)?dr(?:y|ied|ying)\b(?!\s*[-\u2013\u2014,]?\s*(?:in|within|after|by|around|about|roughly|approximately|~)\s*(?:about\s+|around\s+)?\d)/i;
// The confirmation must be the AFFIRMATIVE sanctioned clause ("your technician
// will confirm the timing"), ending its sentence or trailing only "at the
// visit" / "for your yard". A negated or hedged form ("cannot confirm timing",
// "may not", "unsure") is not the idiom, and neither is any negation or hedge
// in the sentence that carries the idiom or the clause.
const CONFIRM_TIMING_RE = /(?<![\w'-])(?:(?:your|the|our)\s+(?:technician|tech|office|team)|we)\s+(?:will\s+)?confirms?\s+(?:the\s+|your\s+)?timing(?:\s+(?:at|during|for|on)\s+(?:the|your)\s+(?:visit|appointment|yard|next\s+visit|service))?\s*(?:[.!]|$)/i;
const NEGATION_HEDGE_RE = /\b(?:not|no|never|nothing|nobody|cannot|without|unable|unsure|uncertain|unclear|unknown|may|might|maybe|perhaps|possibly|probably|hopefully|depends?|depending|but|however|unless|although|though|except|neither|nor|hardly|barely)\b|\bcan\s+not\b|n't\b/i;
function sanctionSafeOnceDry(text) {
  const t = String(text || '');
  const canon = canonText(t);
  if (!SANCTIONED_SAFE_RE.test(t) || !CONFIRM_TIMING_RE.test(canon)) return t;
  const hedged = canon.split(/(?<=[.!?])\s+/).some((sentence) => (SANCTIONED_SAFE_RE.test(sentence) || CONFIRM_TIMING_RE.test(sentence)) && NEGATION_HEDGE_RE.test(sentence));
  return hedged ? t : t.replace(SANCTIONED_SAFE_RE, ' SANCTIONED_IDIOM ');
}

/** True when `body` claims label timing beyond the sentences of `sectionText` (its own copies, verbatim, are fine). */
function replyClaimsUngroundedLabelTiming(body, sectionText) {
  return hasUngroundedLabelClaim(stripLabelSentences(sanctionSafeOnceDry(body), sectionText));
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
 * delayed-send checks. Two steps:
 *   1. The reply guard runs on the FINAL body, whatever a reviewer did to it:
 *      the snapshot's own sentences (verbatim) are the only authorized label
 *      timing, so an edited sentence, a figure typed in, or a claim added
 *      around a copy is held ('label_facts_unauthorized_claim'). With no
 *      snapshot the authorized set is empty.
 *   2. A body that still copies a snapshotted sentence must still be backed by
 *      the customer's CURRENT latest performed visit: same visit date, same
 *      service records, same sentence. A newer visit, a visit today, a changed
 *      label or any lookup error refuses. A body with no snapshotted sentence
 *      left needs no visit read.
 * Returns null when it may go out, else a short reason.
 */
async function labelFactsSendBlockReason({ snapshot, body, conn = db, today } = {}) {
  const sentences = snapshot && Array.isArray(snapshot.sentences) ? snapshot.sentences : [];
  if (replyClaimsUngroundedLabelTiming(body, sentences.map((s) => `- ${s}`).join('\n'))) return 'label_facts_unauthorized_claim';
  const present = sentences.filter((s) => copiesSentence(body, s));
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
const FUTURE_VISIT_RE = /\b(?:tomorrow|tonight|upcoming|scheduled|next\s+(?:visit|treatment|service|spray|spraying|application|time|week|month|appointment|round|one|apt)|your\s+next|this\s+(?:coming|upcoming)|when\s+(?:you|y'?all|ya|the\s+(?:tech|technician|guy|man|team)|he|she|they|we|adam)\s+(?:come|comes|coming|get|gets|getting|are|is|arrive|arrives|show|swing|stop|spray|treat|do)|(?:coming|swinging|stopping)\s+(?:out|by)|before\s+(?:you|the\s+(?:tech|technician))\s+(?:come|comes|arrive)|will\s+(?:be\s+)?(?:spray|treat|apply)\w*|going\s+to\s+(?:spray|treat|apply)|plan(?:ning)?\s+to\s+(?:spray|treat|apply)|in\s+(?:a\s+)?(?:few|couple|\d+)\s+(?:days|weeks)|later\s+this)\b/;
const OLDER_VISIT_RE = /\b(?:previous|prior|earlier|before\s+that|last\s+(?:week|month|year|quarter|spring|summer|fall|winter)|(?:weeks?|months?|years?)\s+ago|a\s+while\s+(?:ago|back)|the\s+(?:other|first)\s+time|two\s+visits?\s+ago|second\s+to\s+last)\b/;

function isoAddDays(iso, days) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

const YESTERDAY_RE = /\byesterday\b/g;
const DAYS_AGO_RE = /\b(\d{1,3}|a|one|two|three|four|five|six|seven)\s+days?\s+ago\b/g;
const DAYS_AGO_WORDS = { a: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7 };
const MONTH_SRC = MONTH_NAMES.map((n) => n.slice(0, 3)).join('|');
// Day-first dates ("29 September 2025") need a real month word: "5 decisions" is no date.
const MONTH_WORD_SRC = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
// An optional year after a month-name date: "2025", ", 2025" or "'25" (a bare two-digit number is an hour count, not a year).
const YEAR_TAIL_SRC = "(?:\\s*,?\\s*(?:((?:19|20)\\d{2})\\b|['\u2019](\\d{2})\\b))?";
const MONTH_DATE_RE = new RegExp(`\\b(${MONTH_SRC})[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b${YEAR_TAIL_SRC}`, 'g');
const DAY_MONTH_DATE_RE = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_WORD_SRC})\\b\\.?${YEAR_TAIL_SRC}`, 'g');
const NUMERIC_DATE_RE = /(?<![\d/])(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?(?![\d/])/g;
const DASHED_DATE_RE = /(?<![\d./-])(\d{1,2})[-.](\d{1,2})[-.](\d{2}|\d{4})(?![\d/-])/g;
const ISO_DATE_RE = /(?<![\d-])(\d{4})-(\d{2})-(\d{2})(?![\d-])/g;
const FUTURE_OR_OLDER_RE = new RegExp(`${FUTURE_VISIT_RE.source}|${OLDER_VISIT_RE.source}`, 'g');
const yearOf = (m, vy) => (m ? (m.length === 2 ? 2000 + Number(m) : Number(m)) : vy);
const monthNumber = (name) => MONTH_NAMES.findIndex((n) => n.startsWith(name.slice(0, 3))) + 1;
// True when month/day/year (year undefined = the visit's own) name a date other than the visit's.
const otherYmd = (v, month, day, year) => month !== v.month || day !== v.day || yearOf(year, v.year) !== v.year;
// Year captured after a month-name date: a four-digit year (group a) or an apostrophe'd two-digit one (group b).
const tailYear = (a, b) => a || b;

// Every way a message can point at a visit: a pattern, and a resolver that says
// whether ONE match names a visit other than the facts' own. The message refers
// to another visit when any match of any pattern does. `v` = { date, today,
// weekday, sinceVisit, year, month, day }.
const VISIT_REFERENCES = [
  { re: FUTURE_OR_OLDER_RE, differs: () => true },
  // "yesterday" / "N days ago" resolve against today and must land on the visit date
  { re: YESTERDAY_RE, differs: (m, v) => isoAddDays(v.today, -1) !== v.date },
  { re: DAYS_AGO_RE, differs: (m, v) => isoAddDays(v.today, -(DAYS_AGO_WORDS[m[1]] ?? Number(m[1]))) !== v.date },
  // a weekday name: only the visit's own weekday, and only when the visit was within the last 6 days
  {
    re: WEEKDAY_ABBR_RE,
    differs: (m, v) => {
      const name = WEEKDAYS.find((w) => w.startsWith(m[1].slice(0, 3)));
      return !name || name !== v.weekday || v.sinceVisit < 0 || v.sinceVisit > 6;
    },
  },
  // an explicit date ("Sep 29", "September 29th", "9/29", "9/29/26") must be the visit's date
  // (a year written after the date must match too: "September 29, 2025" is not the 2026 visit)
  { re: MONTH_DATE_RE, differs: (m, v) => otherYmd(v, monthNumber(m[1]), Number(m[2]), tailYear(m[3], m[4])) },
  { re: DAY_MONTH_DATE_RE, differs: (m, v) => otherYmd(v, monthNumber(m[2]), Number(m[1]), tailYear(m[3], m[4])) },
  { re: NUMERIC_DATE_RE, differs: (m, v) => otherYmd(v, Number(m[1]), Number(m[2]), m[3]) },
  { re: DASHED_DATE_RE, differs: (m, v) => otherYmd(v, Number(m[1]), Number(m[2]), m[3]) },
  { re: ISO_DATE_RE, differs: (m, v) => otherYmd(v, Number(m[2]), Number(m[3]), m[1]) },
];

/**
 * The facts a draft may render for `inboundText`: null (none on file) when the
 * text points at another visit or is not in English (the sentences are English).
 */
function labelFactsForInbound(labelFacts, inboundText) {
  if (!labelFacts) return null;
  return inboundRefersToOtherVisit(inboundText, labelFacts.serviceDate) || looksNonEnglish(inboundText) ? null : labelFacts;
}

/**
 * True when the inbound message refers to a visit other than the facts'
 * visit (`visitDate`, YYYY-MM-DD, `today` the ET date). Errs toward true.
 */
function inboundRefersToOtherVisit(inboundText, visitDate, today = etDateString()) {
  const text = canonText(inboundText).toLowerCase();
  if (!text || !/^\d{4}-\d{2}-\d{2}$/.test(String(visitDate || ''))) return false;
  const visit = new Date(`${visitDate}T12:00:00Z`);
  const [year, month, day] = visitDate.split('-').map(Number);
  const v = {
    date: visitDate, today, weekday: WEEKDAYS[visit.getUTCDay()], year, month, day,
    sinceVisit: Math.round((new Date(`${today}T12:00:00Z`) - visit) / 86400000),
  };
  return VISIT_REFERENCES.some((ref) => [...text.matchAll(ref.re)].some((m) => ref.differs(m, v)));
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
  sanctionSafeOnceDry,
  replyClaimsUngroundedLabelTiming,
  looksNonEnglish,
  nonEnglishTimingWords,
  labelFactsForInbound,
};
