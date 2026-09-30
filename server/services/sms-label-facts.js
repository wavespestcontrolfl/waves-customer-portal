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
const LABEL_LINE_MAX = 160;
const LABEL_LINES_MAX = 2; // the longest rainfast + the longest re-entry, nothing else
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

// VISIT-LEVEL, CONSERVATIVE values only (pre-push audit P1). A visit can apply
// several products (a lawn product and a pest spray, different areas); a
// per-product line invites quoting one product's time for another's area, and
// per-number grounding cannot tell them apart. So the section states at most
// TWO figures, each true of the whole visit: the LONGEST re-entry and the
// LONGEST rainfast time (only when EVERY product has one) across the verified customer-visible products, named
// as such and never per product or area.
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
  return [product.reentrySummary, product.reentryText].some((t) => t && (STATED_DURATION_RE.test(String(t)) || new RegExp(SPELLED_TIME_RE.source, 'i').test(String(t))));
}
function reentryLevelHours(product) {
  if (Number.isFinite(product.reiHours) && product.reiHours > 0) return product.reiHours;
  if (product.reiHours === 0) return statesOwnDuration(product) ? null : 0;
  const summary = singleLine(product.reentrySummary || product.reentryText, 160);
  return summary && UNTIL_DRY_RE.test(summary) && !REENTRY_PLACEHOLDER_RE.test(summary) && !statesOwnDuration(product) ? 0 : null;
}
const WHOLE_VISIT_LABEL = 'Whole visit (the longest across every product applied)';
function wholeVisitReentryClause(products, isBanned) {
  const levels = products.map(reentryLevelHours);
  if (!levels.length || levels.some((l) => l == null)) return null;
  const hours = Math.max(...levels);
  const clause = `re-entry: keep people and pets off treated areas ${hours === 0 ? 'until dry' : `for ${plural(hours, 'hour')}`}`;
  return !isBanned || !isBanned(clause) ? clause : null;
}
// Same all-known rule as re-entry: ONE product without a rainfast time makes
// the whole-visit figure unstatable (the longest of the known ones would
// understate it), so the line is omitted and the COMPANY FACTS rain line applies.
function wholeVisitRainfastClause(products) {
  const minutes = products.map((p) => p.rainfastMinutes);
  if (!minutes.length || minutes.some((m) => !Number.isFinite(m) || m <= 0)) return null;
  return rainfastClause(Math.max(...minutes));
}

/**
 * Render the LABEL FACTS section, '' when there is nothing to render.
 * `formatDate` is the drafter's SERVICE HISTORY date formatter, so the date in
 * the header matches SERVICE HISTORY verbatim. `isBanned(clause)` screens each
 * timing clause against the compliance guard with that clause as its own
 * grounding. Fail closed: a visit with ANY applied product whose label is not
 * verified (`unverifiedCount`) states nothing, since that product's own times
 * are unknown and a "whole visit" figure would understate them.
 */
function renderLabelFactsSection(labelFacts, { formatDate, isBanned } = {}) {
  if (!labelFacts || !Array.isArray(labelFacts.products) || !labelFacts.products.length) return '';
  if (labelFacts.unverifiedCount > 0) return '';
  const lines = [];
  const rain = wholeVisitRainfastClause(labelFacts.products);
  const reentry = wholeVisitReentryClause(labelFacts.products, isBanned);
  if (rain) lines.push(`- ${WHOLE_VISIT_LABEL}: ${rain}`);
  if (reentry) lines.push(`- ${WHOLE_VISIT_LABEL}: ${reentry}`);
  if (!lines.length) return '';
  const date = (formatDate ? formatDate(labelFacts.serviceDate) : labelFacts.serviceDate) || labelFacts.serviceDate;
  return `${LABEL_FACTS_HEADER_PREFIX}${date}):\n${lines.join('\n')}\n`;
}

/** The LABEL FACTS section text out of a rendered facts block ('' if absent). */
function labelFactsSectionFrom(factsBlock) {
  // Exact-structure lookup only (never a header substring): see
  // sms-company-facts.exactLabelFactsSection.
  return require('./sms-company-facts').exactLabelFactsSection(factsBlock);
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
  return { text: text.slice(s, e), start: s };
}

// A clock time: "2 PM", "2:30", "14:00", "noon", "midnight", "by 5", "until 5".
// A bare "by/until/till N" is a clock time unless a unit follows ("by 5 hours").
const CLOCK_TIME_RE = /(?<![\w.:])(?:(?:1[0-2]|0?[1-9])(?::[0-5]\d)?\s*(?:a\.?m\.?|p\.?m\.?)(?![a-z])|(?:[01]?\d|2[0-3]):[0-5]\d(?!\d)|noon\b|midnight\b|(?:by|until|till)\s+(?:1[0-2]|[1-9])(?![\d:]|\.\d|\s*(?:-|–|to)\s*\d|\s*(?:%|percent|minutes?|mins?|hours?|hrs?|days?|weeks?|inch|inches|feet|ft|gallons?|oz|ounces?|times|treatments?|people|pets?|dogs?|kids?)\b))/gi;

// Which KIND of label time a duration is, from the words it is grammatically
// attached to: within a short span of the duration itself, in the same
// clause, a rainfast / wash-off / rain word (rain kind), a re-entry / stay-off /
// go-back-out / wait word (re-entry kind) or a dry / drying word (dry kind);
// the nearest wins. A duration next to an arrival, window, appointment or
// "we'll be back" word is scheduling ('schedule'); a duration with no
// trigger at all is null.
//
// The labels give a re-entry time and a rainfast time, never a "dry" time, so
// the dry kind is grounded by nothing.
const RAIN_TRIGGER_RE = /\brain[-\s]?fast\b|\bwash(?:es|ed|ing)?\s+(?:it\s+|this\s+|that\s+|them\s+)?(?:off|away|out)\b/gi;
// Ordinary rain wording counts only when directly connected to the duration
// (no comma between them): "Rain is fine after 2 hours", "if it rains within
// 2 hours" - but not "we'll be there in 2 hours, rain is expected".
const RAIN_WORD_TRIGGER_RE = /\b(?:rain(?:s|ed|ing|fall|y)?|showers?|storms?|thunderstorms?|downpours?|sprinklers?|irrigation)\b/gi;
const REENTRY_TRIGGER_RE = /\bre-?entr(?:y|ies)\b|\bre-?enter(?:ing)?\b|\b(?:stay|stays|staying|stayed|keep|keeps|keeping|kept)\b[^.!?\n]{0,25}\boff\b|\b(?:stay|stays|staying|keep|keeps|keeping)\s+(?:out|away|inside|indoors)\b|\bwait(?:ing)?\b|\b(?:go|goes|going|come|comes|coming|get|gets|getting|be|is|are|let|lets|letting)\b[^.!?\n]{0,20}\b(?:back\s+(?:out|outside|inside|in|on)|out\s+(?:on|to)|outside|on\s+(?:it|the\s+(?:lawn|grass|yard|treated)))\b|\b(?:walk|play|sit|lie|run)(?:ing)?\s+on\b|\bthe\s+(?:kids?|children|dogs?|cats?|pets?|pups?)\s+(?:out|outside|back)\b|\bgood\s+to\s+go\b/gi;
const DRY_TRIGGER_RE = /\bdr(?:y|ies|ied|ying)\b/gi;
const SCHEDULE_BEFORE_RE = /\b(?:arriv\w*|arrival|be\s+there|be\s+out|be\s+by|come\s+(?:by|out)|coming\s+(?:by|out)|stop(?:ping)?\s+by|between|eta|scheduled?|appointment|technician\s+(?:will|is)|tech\s+(?:will|is))\b[^.!?\n]{0,25}$|\b(?:we|i|tech(?:nician)?|team)(?:'ll|'re|\s+will|\s+can|\s+are|\s+would)?\s+(?:be\s+|come\s+|coming\s+|get\s+)?back(?:\s+(?:out|by|over))?\b[^.!?\n]{0,15}$/i;
const SCHEDULE_AFTER_RE = /^[^.!?\n]{0,6}\b(?:window|arrival|appointment)\b/i;
const TRIGGER_SPAN_BEFORE = 45;
const TRIGGER_SPAN_AFTER = 40;
// Distance from the duration to the nearest match of `re` in the same clause.
// `clause` cuts the text at commas as well as semicolons.
function nearestTrigger(re, beforeRaw, afterRaw, { clause = false } = {}) {
  const cut = clause ? /[,;:—–]/ : /;/;
  const beforeParts = beforeRaw.split(cut);
  const before = beforeParts[beforeParts.length - 1];
  const after = afterRaw.split(cut)[0];
  let best = Infinity;
  const g = new RegExp(re.source, 'gi');
  for (let m = g.exec(before); m; m = g.exec(before)) best = Math.min(best, before.length - (m.index + m[0].length));
  const a = new RegExp(re.source, 'i').exec(after);
  if (a) best = Math.min(best, a.index);
  return best;
}
function timeKind(src, index, length) {
  const { text: sentence, start } = sentenceAt(src, index);
  const rel = index - start;
  const before = sentence.slice(Math.max(0, rel - TRIGGER_SPAN_BEFORE), rel);
  const after = sentence.slice(rel + length, rel + length + TRIGGER_SPAN_AFTER);
  if (SCHEDULE_BEFORE_RE.test(sentence.slice(Math.max(0, rel - 30), rel)) || SCHEDULE_AFTER_RE.test(sentence.slice(rel + length))) return 'schedule';
  const d = {
    dry: nearestTrigger(DRY_TRIGGER_RE, before, after),
    rain: Math.min(nearestTrigger(RAIN_TRIGGER_RE, before, after), nearestTrigger(RAIN_WORD_TRIGGER_RE, before, after, { clause: true })),
    reentry: nearestTrigger(REENTRY_TRIGGER_RE, before, after),
  };
  const best = Math.min(d.dry, d.rain, d.reentry);
  if (best === Infinity) return null;
  // ties: the stricter kind (dry grounds nothing) wins
  return d.dry === best ? 'dry' : (d.rain === best ? 'rain' : 'reentry');
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
    const kind = timeKind(src, offset, whole.length);
    // Only a duration classified as that kind may consume that kind's keys: a
    // null / schedule duration ("give it 4 hours", "the tech arrives in 4
    // hours") is left visible to the older compliance screens.
    const grounded = (kind === 'rain' && rain.has(key)) || (kind === 'reentry' && reentry.has(key));
    return grounded ? 'LABELTIME' : whole;
  });
}

/**
 * The older banned-copy lists screen only dry / re-entry phrasing, so an
 * invented time in other words ("rain won't wash it off after 2 hours", "keep
 * the kids off for 6 hours") needs its own deterministic check. A duration
 * counts only when it is grammatically the rainfast / drying / re-entry /
 * stay-off time (see timeKind: attached to those words, never an arrival,
 * window or scheduling time), and then it must be a figure the LABEL FACTS
 * section states for that kind (same number+unit). Spelled-out figures never
 * ground. No section -> none grounded.
 */
function hasUngroundedLabelTime(text, sectionText) {
  const src = String(text || '');
  const { rain, reentry } = groundedTimeKeys(sectionText);
  for (const m of src.matchAll(TIME_EXPR_RE)) {
    const key = timeKey(m);
    const k = timeKind(src, m.index, m[0].length);
    if (k === 'dry') return true; // no label states a drying time
    if (k === 'rain' && !rain.has(key)) return true;
    if (k === 'reentry' && !reentry.has(key)) return true;
    // no trigger at all: a figure that is only ever the RAINFAST time must not
    // be used as some other time ("give it 2 hours and the pups are good to go")
    if (k === null && rain.has(key) && !reentry.has(key)) return true;
  }
  for (const m of src.matchAll(SPELLED_TIME_RE)) {
    const k = timeKind(src, m.index, m[0].length);
    if (k && k !== 'schedule') return true;
  }
  // Label facts are durations, so no clock time ("after 2 PM", "by 5", "until
  // noon") is groundable: one attached to rain / drying / re-entry wording is held.
  for (const m of src.matchAll(CLOCK_TIME_RE)) {
    const k = timeKind(src, m.index, m[0].length);
    if (k && k !== 'schedule') return true;
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
  hasUngroundedLabelTime,
  LABEL_FACTS_HEADER_PREFIX,
  LABEL_FACTS_TIMEOUT_MS,
  readLastVisitLabelFacts,
  fetchLabelFacts,
  renderLabelFactsSection,
  labelFactsSectionFrom,
  groundedTimeKeys,
  neutralizeGroundedTimes,
};
