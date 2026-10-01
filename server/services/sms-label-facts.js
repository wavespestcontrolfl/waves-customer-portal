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
const LABEL_FACTS_STATEMENT_TIMEOUT_MS = 2500;
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

// A performed record that proves no application (see readLastVisitLabelFacts): an inspection service whose type names no treatment.
const TREATMENT_WORD_RE = /\b(?:treat\w*|spray\w*|application|control|plan|program|service\s+plan|barrier|bait\w*|fertiliz\w*|lawn|pest)\b/i;
function inspectionServiceRe() {
  try {
    return require('./supplies-consumption').INSPECTION_SERVICE_RE || /\binspection\b/i;
  } catch {
    return /\binspection\b/i; // (the same rule, if that module cannot be loaded here)
  }
}
function isNonApplicationRecord(record) {
  const type = String((record && record.service_type) || '');
  return inspectionServiceRe().test(type) && !TREATMENT_WORD_RE.test(type);
}

// A visit AFTER (or on the same date as) the facts' own visit that the record chain has not caught up with: a scheduled visit
// marked completed with no completed service record linked to it (scheduled_service_id), or one left open (confirmed / en route /
// on site / in progress) on a date up to today. Either can be a newer application whose label the last performed record does
// not describe, so the facts' visit is not "the last visit": none on file. (The visit-today case above stays as it was.)
async function hasUnrecordedVisitSince(conn, customerId, serviceDate, today) {
  const scheduled = await conn('scheduled_services')
    .where('customer_id', customerId)
    .where('scheduled_date', '>=', serviceDate)
    .where('scheduled_date', '<=', today)
    .whereNotIn('status', ['cancelled', 'skipped', 'no_show', 'rescheduled'])
    .select('id', 'status', 'scheduled_date');
  if (!scheduled.length) return false;
  if (scheduled.some((r) => r.status !== 'completed')) return true;
  const records = await conn('service_records')
    .where('customer_id', customerId)
    .where('status', 'completed')
    .where('service_date', '>=', serviceDate)
    .select('scheduled_service_id');
  const recorded = new Set(records.filter((r) => r.scheduled_service_id != null).map((r) => String(r.scheduled_service_id).toLowerCase()));
  return scheduled.some((r) => r.id == null || !recorded.has(String(r.id).toLowerCase()));
}

// The applied product's report facts FROZEN at completion
// (service_data.reportIdentitySnapshot.productFacts, keyed by canonical
// product id; complete-scheduled-service.js + pest-recap.js write it from
// approvedReportProductFacts). Timing is read ONLY from here, never from the
// live products_catalog row, so a later catalog edit cannot rewrite what a
// past visit's label said. null = no verified snapshot for this product (no
// snapshot on the record, product absent from it, or not approved at
// completion): fail closed.
const normalizedName = (name) => String(name || '').replace(/\s+/g, ' ').trim().toLowerCase();
function frozenFactsFor(row, snapshot, allSnapshots = [snapshot]) {
  const map = snapshot && snapshot.productFacts && typeof snapshot.productFacts === 'object' ? snapshot.productFacts : null;
  if (!map) return null;
  const id = canonicalProductId(row.product_id);
  let facts = null;
  if (id) {
    facts = Object.prototype.hasOwnProperty.call(map, id) ? map[id] : null;
  } else {
    // service_products.product_id is ON DELETE SET NULL: fall back to the frozen name, as the report does -
    // but names are not unique, so only when EXACTLY ONE frozen entry across the visit's snapshots carries
    // this name (and it is on this record); none or several leaves the product unverified.
    // A NULL entry (a product not approved at completion) is keyed by id only and keeps no name, so it could be exactly this deleted
    // product: an approved product of the same name must not lend its timing to it. Any null / non-object entry anywhere in the visit's
    // snapshots therefore leaves every product_id-less row unverifiable (fail closed).
    const name = normalizedName(row.product_name);
    const named = (m) => Object.values(m || {}).filter((f) => f && typeof f === 'object' && normalizedName(f.name) === name);
    const hasUnnamedEntry = (m) => Object.values(m || {}).some((f) => !f || typeof f !== 'object');
    const anyUnnamed = allSnapshots.some((snap) => hasUnnamedEntry(snap && snap.productFacts));
    const total = name && !anyUnnamed ? allSnapshots.reduce((n, snap) => n + named(snap && snap.productFacts).length, 0) : 0;
    const own = name && total === 1 ? named(map) : [];
    facts = own.length === 1 ? own[0] : null;
  }
  return facts && typeof facts === 'object' ? facts : null;
}

// The snapshot writes rei_hours through Number(), so a catalog NULL (unknown)
// is frozen as 0, indistinguishable from the residential "0 = until dry"
// value. Trust a frozen 0 only when the frozen summary itself says a plain until dry.
// null for no figure; the number for 0 or a finite positive figure; NaN for anything else (negative, NaN, Infinity, non-numeric text):
// an invalid frozen figure is unknown and must never fall through to a sentinel.
function validFigure(value) {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : Number.NaN;
}
function frozenReiHours(frozen) {
  const hours = validFigure(frozen.reentryHours);
  if (hours !== 0) return hours; // (null stays null; an invalid figure stays NaN)
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
  // An adjuvant / water conditioner (or an unclassified family) is never NAMED to the customer, but a VERIFIED one still
  // constrains the whole visit's timing (a 12 h surfactant beside a 4 h insecticide): it stays in the aggregation and, with
  // no frozen figure (the snapshot has no "no restriction" value), fails the visit's line closed like any other product.
  const additive = !def || !def.customerVisible
    || [row.product_category, f.category, f.productType, row.product_name].some((c) => c && WATER_CONDITIONER_RE.test(String(c)));
  return {
    additive,
    // A neutral customer-facing type ("an insecticide"), never the brand.
    phrase: (def && def.phrase) || 'a product',
    // a negative / NaN / non-finite frozen figure is no figure (unknown), never a value to aggregate
    rainfastMinutes: validFigure(f.rainfastMinutes),
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
  // ONE consistent read: the newest performed date, the stale-visit guards and the products must all come from the same snapshot, or a
  // visit that lands between two queries leaves the facts describing a visit that is no longer the last one. A connection that can open
  // transactions (knex) reads inside a REPEATABLE READ, READ ONLY transaction; any other connection is re-checked after the read
  // (the newest date and both guards must still hold, else none on file).
  // A connection that is ALREADY a transaction (the provider-boundary recheck runs on the send handoff's own trx, Codex #5416 r31)
  // takes the re-check path too: a nested transaction() is only a savepoint, which cannot raise the outer READ COMMITTED isolation,
  // and its SET LOCAL statement_timeout would outlive the savepoint and bind the rest of the handoff's transaction.
  if (typeof conn.transaction === 'function' && conn.isTransaction !== true) {
    return conn.transaction(async (trx) => {
      // The server cancels a slow read itself (a JS-side timeout cannot release the pooled connection); the 3 s race in fetchLabelFacts stays the outer guard.
      if (typeof trx.raw === 'function') await trx.raw(`SET LOCAL statement_timeout = '${LABEL_FACTS_STATEMENT_TIMEOUT_MS}ms'`);
      return readLastVisitLabelFactsOnce({ customerId, conn: trx, today });
    }, { isolationLevel: 'repeatable read', readOnly: true });
  }
  const facts = await readLastVisitLabelFactsOnce({ customerId, conn, today });
  if (!facts) return null;
  return await isStillTheLastVisit({ customerId, conn, today, serviceDate: facts.serviceDate, recordIds: facts.recordIds }) ? facts : null;
}

// After a read on a connection without snapshot isolation: is the facts' date still the newest performed date, and is there still no
// visit today and no unrecorded later visit?
async function isStillTheLastVisit({ customerId, conn, today, serviceDate, recordIds = [] }) {
  const performed = () => conn('service_records')
    .where('service_records.customer_id', customerId)
    .where('service_records.status', 'completed')
    .whereRaw(
      `COALESCE(service_records.structured_notes->>'visitOutcome', '') NOT IN (${NON_PERFORMED_VISIT_OUTCOMES.map(() => '?').join(', ')})`,
      NON_PERFORMED_VISIT_OUTCOMES,
    );
  // ORDER (Codex #5416 r33): on READ COMMITTED each statement sees every commit made before it starts, so the newest-date read
  // goes LAST. A visit that commits while the guards run is then seen by it (a newer date or a new record refuses); one that commits after it
  // lands after this final read, at the send itself. Read first, a visit committing between it and the guards would pass both.
  if (await hasVisitToday(conn, customerId, today)) return false;
  if (await hasMultipleProperties(conn, customerId)) return false;
  if (await hasUnrecordedVisitSince(conn, customerId, serviceDate, today)) return false;
  // ONE final statement (Codex #5416 r34): every performed record on or after the visit date. Any later date, or any record on
  // the same date beyond the ones the facts were read from (a second visit landing that day), refuses.
  const since = await performed()
    .where('service_records.service_date', '>=', serviceDate)
    .select('service_records.id', 'service_records.service_date');
  if (!Array.isArray(since) || since.some((r) => dateOnlyString(r.service_date) !== serviceDate)) return false;
  return JSON.stringify(since.map((r) => String(r.id)).sort()) === JSON.stringify([...recordIds].map(String).sort());
}

// A customer with more than one active property (a home and a rental, say) cannot be answered from "the latest visit": the
// question may be about the other property, whose visit applied different products (Codex #5416 r32). None on file, so a
// person answers; resolving the referenced property is a later change.
async function hasMultipleProperties(conn, customerId) {
  const rows = await conn('customer_properties').where({ customer_id: customerId, active: true }).select('customer_properties.id');
  return Array.isArray(rows) && rows.length > 1;
}

async function readLastVisitLabelFactsOnce({ customerId, conn, today }) {

  if (await hasVisitToday(conn, customerId, today)) return null;
  if (await hasMultipleProperties(conn, customerId)) return null;

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
  if (await hasUnrecordedVisitSince(conn, customerId, serviceDate, today)) return null;
  const visits = await performed()
    .where('service_records.service_date', serviceDate)
    .select('service_records.id', 'service_records.structured_notes', 'service_records.service_data', 'service_records.service_type');
  if (!visits.length || visits.some((v) => serviceRecordSuppressesCustomerArtifacts(v))) return null;
  const recordIds = visits.map((v) => v.id);
  const snapshotByRecord = new Map(visits.map((v) => [String(v.id), readReportIdentitySnapshot({ service_data: v.service_data })]));

  const rows = await conn('service_products as sp')
    .whereIn('sp.service_record_id', recordIds)
    .orderBy([{ column: 'sp.applied_at', order: 'asc' }, { column: 'sp.id', order: 'asc' }])
    .select(
      'sp.id', 'sp.service_record_id', 'sp.product_id', 'sp.product_name', 'sp.active_ingredient', 'sp.product_category',
    );

  // Every performed record on the date must be represented by product evidence, or the aggregate covers only a subset of what was
  // applied. The one exception is a record that proves no application: an inspection service (the codebase's own rule, supplies-consumption's
  // INSPECTION_SERVICE_RE: "a scheduled inspection (no application)"), and only when its service type names no treatment. Any other
  // productless record - including one with no service type at all - means none on file.
  const representedRecords = new Set(rows.map((r) => String(r.service_record_id)));
  if (visits.some((v) => !representedRecords.has(String(v.id)) && !isNonApplicationRecord(v))) return null;

  const products = [];
  let unverified = 0;
  for (const row of rows) {
    const p = productFromRow(row, frozenFactsFor(row, snapshotByRecord.get(String(row.service_record_id)) || null, [...snapshotByRecord.values()]));
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
// Only a subject that covers BOTH people and pets is accepted; a text naming only people or only pets (or "everyone")
// is not the whole-visit statement the sentence makes, so it is unknown. An unscoped lead ("keep off treated areas") is accepted.
const REENTRY_SUBJECT_SRC = 'people\\s+and\\s+pets|pets\\s+and\\s+people|people\\s+or\\s+pets|pets\\s+or\\s+people|people,\\s*pets|humans\\s+and\\s+(?:animals|pets)|people\\s+and\\s+animals|everyone\\s+including\\s+pets';
const REENTRY_AREA_SRC = '(?:the\\s+)?(?:treated\\s+)?(?:areas?|lawn|grass|yard|surfaces?|turf)';
const REENTRY_OFF_SRC = '(?:off|out\\s+of|away\\s+from)';
// Seeded wordings (the catalog's reentry_summary / reentry_text): "Keep people and pets off treated areas until dry.", "Do not allow people or pets
// to enter the treated area until sprays have dried.", "People and pets stay off treated turf until sprays have dried.", "No re-entry to treated turf
// until the sprays have dried." - a plain lead over an until-dry or ONE duration and nothing else.
const REENTRY_LEAD_SRC = `(?:(?:keep|stay)\\s+(?:(?:${REENTRY_SUBJECT_SRC})\\s+)?${REENTRY_OFF_SRC}(?:\\s+${REENTRY_AREA_SRC})?|(?:${REENTRY_SUBJECT_SRC})\\s+(?:(?:are\\s+)?kept|stay|remain|(?:must|should)\\s+stay|are\\s+to\\s+stay)\\s+${REENTRY_OFF_SRC}(?:\\s+${REENTRY_AREA_SRC})?|(?:do\\s+not|don't)\\s+(?:allow\\s+(?:${REENTRY_SUBJECT_SRC})\\s+(?:to\\s+)?)?(?:re-?enter|enter|on|onto|walk\\s+on)(?:\\s+${REENTRY_AREA_SRC})?|no\\s+(?:re-?entry|entry)\\s+(?:to|into|onto)\\s+${REENTRY_AREA_SRC}|(?:safe|ok|okay)\\s+for\\s+(?:${REENTRY_SUBJECT_SRC})|re-?entry(?:\\s+(?:is\\s+)?(?:allowed|permitted))?|wait)`;
const REENTRY_DRY_SUBJECT_SRC = '(?:the\\s+)?(?:(?:sprays?|treatments?|applications?|products?)(?:\\s+solution)?|treated\\s+(?:areas?|surfaces?|lawn|turf)|areas?|surfaces?|lawn|turf)';
const REENTRY_UNTIL_DRY_SRC = `(?:until|once|when)\\s+(?:(?:it(?:\\s+is|'s|\\s+has)?|they(?:\\s+are|\\s+have)|${REENTRY_DRY_SUBJECT_SRC}\\s+(?:is|are|has|have))\\s+)?(?:(?:completely|fully|thoroughly)\\s+)?(?:dry|dried)`;
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
  // an invalid frozen figure (negative, NaN, Infinity) is unknown: never the until-dry sentinel
  if (product.reiHours != null && !(Number.isFinite(product.reiHours) && product.reiHours >= 0)) return null;
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
// Input caps (the guards run regexes over customer / model text): anything past these is never truncated and passed - a reply
// past MAX_REPLY_CHARS is held, an inbound (or thread row) past MAX_INBOUND_CHARS is treated as unverified / another visit.
const MAX_REPLY_CHARS = 2000;
const MAX_INBOUND_CHARS = 1000;
const overCap = (text, max) => String(text ?? '').length > max;
const inboundOverCap = (inbound) => (Array.isArray(inbound) ? inbound : [inbound]).some((t) => overCap(t, MAX_INBOUND_CHARS));

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
// A copy is authorized only as its own sentence with nothing framing it: it starts the text, follows a sentence
// end (or a plain "Hi Jane," greeting) - never a colon or other lead-in ("This is false: ...", "Old info: ...") -
// and the two sentences on each side carry no meta or negation vocabulary ("Ignore this.", "Just kidding.",
// "That is outdated.", "Not anymore."). Draft, snapshot and send time all use this one matcher.
const META_FRAME_RE = /\b(?:false|untrue|not\s+(?:true|correct|accurate|right|apply|valid)|isn'?t\s+(?:true|correct|accurate|right)|ignore|disregard|do(?:n'?t|\s+not)\s+follow|does(?:n'?t|\s+not)\s+apply|outdated|out\s+of\s+date|old\s+info|wrong|incorrect|kidding|joking|not\s+anymore|no\s+longer|actually|scratch\s+that|correction|used\s+to|mistake|never\s*mind|forget\s+(?:that|this|it)|however|but|although|except|unless)\b/i;
const OWN_SENTENCE_START_RE = /(?:^|[.!?]|(?:labelsentence\w*|companysentence)\s*;)\s*$|(?:^|[.!?]\s*)(?:hi|hello|hey|thanks|thank\s+you)\b[^.!?:;]{0,30},\s*$/i;
const SENTENCE_GAP_RE = /(?<=[.!?])\s+/;
function standsAlone(before, after) {
  if (!OWN_SENTENCE_START_RE.test(before)) return false;
  const near = [...before.split(SENTENCE_GAP_RE).slice(-2), ...after.split(SENTENCE_GAP_RE).slice(0, 2)];
  return !near.some((sentence) => META_FRAME_RE.test(sentence));
}
// [{ start, end }] over `canon` (canonText output).
function completeCopies(canon, sentence) {
  const out = [];
  for (const m of canon.matchAll(new RegExp(escapeRegex(canonText(sentence)), 'gi'))) {
    const end = m.index + m[0].length;
    if ((m.index === 0 || !/[\p{L}\p{N}]/u.test(canon[m.index - 1])) && copyEndsCleanly(canon.slice(end)) && standsAlone(canon.slice(0, m.index), canon.slice(end))) out.push({ start: m.index, end });
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
  if (overCap(text, MAX_REPLY_CHARS)) return canonText(text); // (never truncated: hasUngroundedLabelClaim holds it)
  let out = canonText(text);
  for (const s of labelSentencesIn(sectionText)) {
    // the marker keeps the copy's KIND (labelsentencereentry / labelsentencerainfast) so a rainfast copy never answers a pet question
    const marker = s.kind === 'reentry' ? 'labelsentencereentry' : 'labelsentencerainfast';
    for (const { start, end } of completeCopies(out, s.text).reverse()) out = `${out.slice(0, start)} ; ${marker} ; ${out.slice(end)}`;
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
// (a single word each: "twenty-one" is TENS then ONES through the sequence below - an optional TENS+ONES pair here made the two
// readings overlap, and a long run of "twenty-one-" backtracked exponentially)
const NUM_WORD_SRC = `(?:${TENS_SRC}|${ONES_SRC}|hundred)`;
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
// Neither duration pattern can match without a digit (TIME_EXPR_RE) or a time word (every TIME_UNIT_SRC / VAGUE_WHOLE_SRC
// alternative contains one of these stems): such a clause skips both, keeping a reply of hundreds of short clauses linear and cheap.
const DURATION_PREFILTER_RE = /\d|sec|min|hour|hr|day|night|week|morning/i;
function durationsIn(clause) {
  if (!DURATION_PREFILTER_RE.test(clause)) return [];
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
// Moisture that is not rain but is asked about / reassured about the same way ("will the morning dew affect the treatment?", "dew won't hurt it").
const MOISTURE_WORD_SRC = 'dew|dewy|condensation|moisture|fog|foggy|mist|misty|humidity|humid\\w*';
const MOISTURE_WORD_RE = new RegExp(`\\b(?:${MOISTURE_WORD_SRC})\\b`);
const RAIN_WORD_RE = /\b(?:rain(?:s|ed|ing|fall|y|fast)?|rain-fast|showers?|storms?|thunderstorms?|downpours?|sprinklers?|irrigation|drizzle)\b/;
const RAINFAST_RE = /\brain[-\s]?(?:fast|proof|resistant)\b|\bweather[-\s]?(?:proof|resistant)\b|\bwater[-\s]?(?:proof|resistant)\b|\bwash(?:es|ed|ing)?\s+(?:it\s+|this\s+|that\s+|them\s+|the\s+\w+\s+)?(?:off|away|out)\b|\bwashed\s+off\b/;
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
    // a question stops the answer rules ONLY when it genuinely asks the customer for information ("Do you have pets?");
    // "Isn't it safe by now?" / "Go ahead?" are answers in question form and are judged like statements
    const question = /\?/.test(parts[i + 1] || '') && isClarificationQuestion(sentence);
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
// "Pressure washing won't affect the treatment.", "Washing won't hurt it.", "Hosing it down is fine.": a wash-family verb beside the treatment (or "it" / "them" /
// "this" / "that", or a treated surface) is a rain claim in other words.
const WASH_VERB_OUT_RE = /\b(?:rins(?:e|es|ed|ing)|wash(?:es|ed|ing)?|(?:pressure|power)[-\s]?wash\w*|hos(?:e|es|ed|ing)|spray(?:s|ed|ing)?\s+down|wip(?:e|es|ed|ing)\s+(?:down|off)|mop(?:s|ped|ping)?)\b/;
const WASH_OBJECT_OUT_RE = /\b(?:treatment|treatments|treated|spray|sprayed|application|applied|product|products|granules?|fertilizer|it|them|this|that|those|lawn|grass|yard|patio|deck|driveway|surfaces?)\b/;
const washesTreatment = (text) => WASH_VERB_OUT_RE.test(text) && WASH_OBJECT_OUT_RE.test(text);
// The sentence-level facts are the same for every clause of a sentence: computed once per sentence, not once per clause (a
// 2,000-character sentence of ~700 short clauses re-scanned the whole sentence per clause - quadratic, CI timing test r35).
let sentenceFactsMemo = { sentence: null, facts: null };
function sentenceLevelFacts(sentence) {
  if (sentenceFactsMemo.sentence !== sentence) {
    sentenceFactsMemo = {
      sentence,
      facts: {
        rainSentence: RAIN_WORD_RE.test(sentence) || MOISTURE_WORD_RE.test(sentence) || washesTreatment(sentence),
        preVisit: isPreVisitAccess(sentence),
      },
    };
  }
  return sentenceFactsMemo.facts;
}
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
    rain: RAIN_WORD_RE.test(clause) || MOISTURE_WORD_RE.test(clause) || washesTreatment(clause),
    ...sentenceLevelFacts(sentence),
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
// "The treatment is set / bonded / absorbed / sealed / locked in" is a rain claim in other words (allowed only inside the
// reply's own dry-and-bond condition, like the COMPANY FACTS rain line).
const TREATMENT_STATE_RE = /\b(?:treatment|spray|application|product|granules?|fertilizer|it|everything)\b[^.?!]{0,25}\b(?:is|are|has|have|was|were|'s)\s+(?:now\s+|already\s+|fully\s+|completely\s+|all\s+|been\s+)*(?:set(?:\s+in)?|bonded|absorbed|locked\s+in|sealed|cured|soaked\s+in|sunk\s+in)\b/;
// Permission to go / use, stated to the customer's side: (you / they / the kids / the family / everyone / pets / dogs, or feel free / it's fine
// to) + a permission modal + any verb + an immediacy adverb ("You may return now.", "They're free to come in whenever.", "Feel free to head
// back anytime.", an imperative like "Go back inside now."). Contact / billing / scheduling actions are excluded by verb or object ("you can
// reply anytime", "you can pay online anytime", "you can book now"). Every gap is bounded.
const PERMISSION_ADVERB_SRC = 'now|anytime|any\\s+time|whenever|right\\s+away|immediately|at\\s+this\\s+point|already|today|tonight';
const PERMISSION_SUBJECT_SRC = "you|they|everyone|everybody|the\\s+(?:kids|children|family|dogs?|pets?)|your\\s+(?:kids|children|family|dogs?|pets?|cats?)|kids|children|pets|dogs|cats";
const PERMISSION_NOW_RE = new RegExp(
  `\\b(?:(?:${PERMISSION_SUBJECT_SRC})(?:\\s+(?:can|may|could)|\\s+are\\s+(?:free|welcome|allowed|good)\\s+to|'re\\s+(?:free|welcome|allowed|good)\\s+to)|(?:it(?:'s|\\s+is)\\s+fine\\s+to|feel\\s+free\\s+to))\\s+(?:\\w+\\s+){0,6}?(?:${PERMISSION_ADVERB_SRC})\\b`
  // (an imperative counts only with a going-in / going-out particle or a plainly re-entry verb: "Go back inside now.", not "Come by today." or "Get a free inspection today.")
  + `|^(?:please\\s+)?(?:(?:go|come|head|move|get)\\s+(?:back|in|inside|indoors|out|outside|outdoors)|enter|re-?enter|return|walk|step|play|sit|swim)\\b(?:\\s+\\w+){0,5}?\\s+(?:${PERMISSION_ADVERB_SRC})\\b`);
const SERVICE_ACTION_RE = /\b(?:call|text|reply|respond|reach|contact|email|message|chat|talk|ask|tell|pay|paying|book|reschedule|schedule|cancel|view|check|log|sign|access|download|see\s+your|portal|app|online|link|website|invoice|bill|receipt|report|account|estimate|quote|appointment|card|payment|phone)\b|\b(?:swing|stop|come|drop|pop)\s+by\b/;
const CLAIM_RULES_AFTER_QUESTION = [
  { name: 'permission to go / use now', test: (x) => PERMISSION_NOW_RE.test(x.c) && !SERVICE_ACTION_RE.test(x.c) && !x.staffLed },
  { name: 'a treatment stated as set / bonded / absorbed / sealed', test: (x) => TREATMENT_STATE_RE.test(x.c) && !x.replyDryCondition },
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
  if (overCap(strippedText, MAX_REPLY_CHARS)) return true;
  const text = canonText(strippedText).toLowerCase();
  // The clause rules are English: another language's timing words are held outright.
  // (a verbatim COMPANY FACTS sentence is owner-approved English, however few function words it has)
  if (nonEnglishTimingWords(text) || hasUnsupportedLanguage(markCompanySentences(canonText(strippedText)))) return true;
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
  if (overCap(text, MAX_INBOUND_CHARS)) return true;
  const raw = String(text || '');
  if (NON_ENGLISH_MARKS_RE.test(raw)) return true;
  if (UNREADABLE_SCRIPT_RE.test(raw)) return true;
  const t = stripMarks(canonText(raw).toLowerCase());
  if (NON_ENGLISH_STRONG_RE.test(t)) return true;
  return (t.match(NON_ENGLISH_WEAK_RE) || []).length >= 2 || NON_ENGLISH_TIMING_VOCAB.some((v) => v.re.test(t));
}
// ---- Unsupported languages ------------------------------------------------
// The clause rules are English and the vocabulary table covers es / pt / fr. Another Latin-script language (German,
// Italian, Dutch, Haitian Creole ...) would slip past both, so a sentence is held on POSITIVE evidence only: its
// function words hit an unsupported profile at least once and more often than the supported ones (en / es / pt / fr),
// or it carries an unsupported language's timing / re-entry / rain vocabulary. Terse English with no function words at
// all ("Perimeter granules applied around foundation.") shows no evidence and is never held. Non-Latin scripts are held
// by UNREADABLE_SCRIPT_RE above.
const wordList = (list) => new Set(list.split(/\s+/));
const SUPPORTED_PROFILES = {
  en: wordList('im ive dont cant wont didnt isnt thats youre theyre the and is are to of you your for will we it that this with can be on in at have our they not if as or so from by but do i my me us an a how what when where why about there here would could should was were has had am please thanks thank'),
  es: wordList('el la los las de del que y en un una es son por para con su sus se lo al muy pero como esta estan tiene puede le mi tu si ya hay ser'),
  pt: wordList('o a os as de do da dos das que e em um uma sao por para com seu sua se nao muito mas como esta estao tem pode meu voce ja ser'),
  fr: wordList('le la les des du de un une et est sont pour avec votre vos ne pas que qui dans sur ce cette il elle nous vous mon ma mes je tu ils elles ou'),
};
const UNSUPPORTED_PROFILES = {
  de: wordList('der das und ist nicht ein eine mit von zu den dem des sich auf fur sie ich wir im nach auch nur wenn bitte danke sind wird werden konnen kann durfen'),
  it: wordList('gli di sono nel della dei degli sul piu dopo tenga aspetti puo possono'),
  ht: wordList('nan pou ak pa mwen nou kap ki gen kenbe'),
  nl: wordList('het een niet voor zijn maar ook deze wordt kunnen'),
  tl: wordList('ang ng mga sa na ay po kailan puwede puwedeng pwede lumabas hintay maghintay oras araw aso pusa ulan dalawang'),
};
// timing / re-entry / rain words of the unsupported languages, whatever else the sentence says
const UNSUPPORTED_TIMING_RE = /(?<![\p{L}])(?:stunden?|minuten|tage|tagen|wochen|hunde?|kinder|haustiere|regen|rasen|warten|trocken|nass|drau(?:ss|ß)en|ore|minuti|giorni|settimane|cani|bambini|animali|pioggia|prato|aspettare|asciutto|fuori|uur|dagen|weken|honden|kinderen|gras|wachten|droog|buiten|edtan|minit|jou|chen|timoun|lapli|gazon|tann|sek|deyo|oras|araw|aso|pusa|ulan|lumabas|maghintay|hintay|puwede|puwedeng|pwede)(?![\p{L}])/iu;
const countHits = (words, set) => words.filter((w) => set.has(w)).length;
const bestHits = (words, profiles) => Math.max(...Object.values(profiles).map((set) => countHits(words, set)));
function sentenceIsUnsupportedLanguage(sentence) {
  const plain = stripMarks(sentence.toLowerCase());
  if (UNSUPPORTED_TIMING_RE.test(plain)) return true;
  const words = wordsOf(plain);
  const unsupported = bestHits(words, UNSUPPORTED_PROFILES);
  return unsupported >= 1 && unsupported > bestHits(words, SUPPORTED_PROFILES);
}
/** True when some sentence of `text` shows positive evidence of an unsupported (unreadable to the guards) language. */
function hasUnsupportedLanguage(text) {
  if (overCap(text, MAX_REPLY_CHARS)) return true;
  return String(text || '').split(/[.!?\n;]+/).some(sentenceIsUnsupportedLanguage);
}
/** False only on positive evidence of an unsupported language: terse English stays English (used for the inbound). */
const isVerifiablyEnglish = (text) => !hasUnsupportedLanguage(text);

// ---- Unverified inbound language ------------------------------------------
// The drafter answers in the customer's language, and the guards read only en / es / pt / fr. An inbound of two or
// more words whose letters or words cannot be tied to those four - a letter outside ASCII and the es / pt / fr
// diacritics (Polish ą ę ł ś ..., Czech, Turkish, Hungarian), or no function word / common SMS word of any of them at
// all ("Kiedy psy mogą wyjść?") - is UNVERIFIED: LABEL FACTS none on file, both label kinds asked (so only allowlisted
// sentence types answer), and 'unverified_language' recorded in the snapshot's asked list. The REPLY check stays
// evidence-based so terse English is never held.
const ALLOWED_DIACRITICS = 'áàâãçéèêëíîïñóôõœæùúûüÿ';
// An inbound is handled as English only when nothing says otherwise: the topic matchers and the reply guards are English,
// so a Spanish / Portuguese / French inbound ("\u00bfPueden salir los perros ahora?") or an unverified / unsupported one takes the
// same fail-closed path as Polish (label facts none on file, both kinds asked, only allowlisted sentence types answer).
function isEnglishInbound(inbound) {
  if (inboundOverCap(inbound)) return false;
  const current = Array.isArray(inbound) ? inbound[0] : inbound;
  // a pure reaction quotes OUR message: the quote is not the customer's language (the 2026-10-01 sweep held such reactions as foreign)
  if (isPureReaction(canonText(current))) return true;
  return !(isUnverifiedLanguageInbound(inbound) || looksNonEnglish(current) || hasUnsupportedLanguage(current));
}
const SMS_CORE_WORDS = wordList('when can is are ok okay thanks thank yes no dog dogs cat cats pet pets kid kids child children baby lawn yard grass rain rains outside inside out in spray sprayed spraying treatment treated visit service technician tech now today tomorrow tonight yesterday safe dry wet wash washed water watering mow mowing sprinkler sprinklers walk play swim hours hour minutes minute days day week home appointment schedule reschedule pest bugs ants roaches termites weeds fertilizer wait yet still again back go going please hi hello hey good morning afternoon evening price cost pay paid invoice bill estimate quote question help need want know tell time late early soon sure done finished complete works work fine great perfect sounds see then monday tuesday wednesday thursday friday saturday sunday okay yep yeah nope pool patio deck garage gate fence bee bees wasp wasps mice rats rat mouse any update updates pls plz thx ty call text email send sent whats hows wheres coming come came leave left open closed confirm confirmed cancel free busy available options option name address phone number');
// Common English words beyond the function words and SMS core (contractions split at the apostrophe: "don't" -> don).
const ENGLISH_COMMON = wordList('be have do say get make go know take see come think look want give use find tell ask work seem feel try leave call keep let begin help show hear play run move live believe bring happen write provide sit stand lose pay meet include continue set learn change lead understand watch follow stop create speak read allow add spend grow open walk win offer remember love consider appear buy wait serve die send expect build stay fall cut reach kill remain suggest raise pass sell require report decide pull time year people way day man thing woman life child world school state family student group country problem hand part place case week company system program question government number night point home water room mother area money story fact month lot right study book eye job word business issue side kind head house service friend father power hour game line end member law car city community name president team minute idea body information back parent face level office door health person art war history party result change morning reason research girl guy moment air teacher force education good new first last long great little own other old right big high different small large next early young important few public bad same able sure clear full free hot cold late low wet dry fine ready safe nice happy sorry busy open real best better worse most more less enough much many every each both any some such only just even still also very too quite really already always never often sometimes usually maybe probably actually again then there here now today tomorrow yesterday tonight soon later ago away out up down off over under around before after during until since while because though although if unless whether once twice yes yeah yep nope okay ok thanks thank please hello hi hey bye welcome sorry excuse dont doesnt didnt isnt arent wasnt werent wont cant couldnt wouldnt shouldnt havent hasnt hadnt im ive ill id youre youve youll thats whats hows wheres whos theres heres lets gonna wanna gotta lemme pls plz thx ty idk btw asap tho cuz cause don doesn didn isn aren wasn weren won couldn wouldn shouldn haven hasn hadn ll ve re pest pests bug bugs ant ants roach roaches cockroach cockroaches termite termites spider spiders mosquito mosquitoes mosquitos flea fleas tick ticks rodent rodents mouse mice rat rats wasp wasps hornet hornets bee bees honeybee honeybees snake snakes squirrel squirrels raccoon raccoons lizard lizards palmetto silverfish earwig earwigs cricket crickets moth moths beetle beetles grub grubs chinch weevil nest nests hive infestation infested swarm droppings trap traps bait baits lawn lawns grass sod turf yard yards backyard frontyard garden gardens weed weeds fertilizer fertilize fertilizing sprinkler sprinklers irrigation zone zones mow mowed mowing mower trim trimmed trimming palm palms tree trees shrub shrubs hedge hedges bush bushes flower flowers plant plants mulch dirt soil patio deck porch lanai cage screen pool pools garage driveway sidewalk walkway fence gate gates roof attic crawlspace foundation slab kitchen bathroom bedroom closet laundry living dining basement window windows door doors wall walls floor floors ceiling baseboard baseboards sink cabinet cabinets outlet vent vents pipe pipes drain outside inside outdoors indoors exterior interior perimeter front rear side corner entry entrance treatment treatments treat treated treating spray sprays sprayed spraying apply applied applying application applications product products granule granules granular liquid dust dusted residue label labels schedule scheduled scheduling reschedule rescheduled reschedules cancel canceled cancelled booking book booked appointment appointments visit visits visited technician technicians tech techs crew team teammate manager owner staff someone anyone everyone customer customers account plan plans membership renew renewal contract warranty guarantee guaranteed service services quarterly monthly annual annually yearly weekly bimonthly initial recurring onetime one invoice invoices bill billing balance payment payments paid pay paying card cards cash check checks receipt refund refunded charge charged price prices pricing cost costs quote quotes estimate estimates free discount deposit autopay email emails text texts texted texting phone phones number address street avenue road drive lane court zip city county name morning mornings afternoon afternoons evening evenings night nights weekend weekends monday tuesday wednesday thursday friday saturday sunday mon tue tues wed thu thur thurs fri sat sun january february march april may june july august september october november december jan feb mar apr jun jul aug sep sept oct nov dec spring summer fall autumn winter season seasonal rain rainy rained raining rains shower showers storm storms stormy thunderstorm thunderstorms weather forecast humid humidity drizzle downpour hurricane tropical sunny cloudy windy heat hot cool degrees wash washed washing rinse rinsed flood flooded flooding puddle puddles damp soaked soak soaking wet moist dry dried drying set cure cured sink sank absorb absorbed dog dogs puppy puppies cat cats kitten kittens pet pets animal animals bird birds chicken chickens horse horses fish rabbit rabbits kid kids child children baby babies toddler toddlers teen teens family neighbor neighbors neighbour guest guests visitor visitors elderly grandma grandpa grandkids parents husband wife son daughter mom dad brother sister home house apartment condo townhouse villa unit building business commercial restaurant store shop hoa community gated code gate lockbox key keys lock locked unlocked open closed access available availability opening openings slot slots window windows arrival arrive arrives arrived arriving eta route en late early ontime on time sooner quickly asap urgent emergency problem problems issue issues concern concerns complaint worry worried question questions answer answers update updates news info details detail reply respond response confirm confirmed confirmation remind reminder note notes message messages voicemail photo photos picture pictures video attach attached link links website online app portal login password receive received got sent forward forwarded missed missing lost found broken fixed fix repair damaged damage stain stains smell smells odor noise noises sound sounds heard saw seen noticed notice notices spotted spot spots patch patches brown yellow green thin dead alive live living crawling flying biting bites bite itchy swollen sting stings stung allergic allergy asthma sick baby pregnant medication medical doctor vet vets hospital toxic poison poisonous chemical chemicals organic natural eco friendly harmful harm hurt safe unsafe dangerous risk nothing something anything everything nobody somebody anybody nowhere somewhere anywhere everywhere whatever whenever wherever however whoever whichever who whom whose which what where when why how than then so if or nor yet not no nor per via plus minus about above across against along among behind below beneath beside between beyond despite except inside into like near onto outside past through throughout toward towards underneath upon within without adam waves benetti virginia pleasure owe owed recorded delivered report reports guide prep portal awesome perfect wonderful amazing appreciate appreciated helpful helped quick fast slow earlier latest newer older previous following original another others else own instead rather perhaps already ahead along apart aside besides beyond whole half double single couple dozen bunch lots plenty piece pieces kind sort type thing things stuff way ways place places case cases side sides turn turns chance reason reasons idea ideas plan matter matters trouble mind wish hope hoped guess bet sounds sound looks look looked seems seemed feels felt gets got getting goes went gone comes came coming takes took taken makes made making gives gave given says said tells told asks asked keeps kept lets puts put runs ran walks walked plays played waits waited stays stayed leaves left calls called sends sent texts texted pays paid works worked using used needs needed wants wanted thinks thought knows knew sees saw seen finds found begins began ends ended starts started stops stopped tries tried moves moved lives lived turns turned shows showed shown happens happened holds held brings brought sits sat stands stood loses lost meets met learns learned changes changed lasts lasted checking checked checks calling covered cover covers include includes included including user users approved approve approves proactive outreach date dates human humans thread threads body bodies reply replies truth manual manually review reviews fallback content contents source sources template templates queue queued caller callers ordinary legacy cutoff attention requiring require required different suggestion suggestions suggest suggested push pending draft drafts caption captions photo context canonical persistence pattern patterns proposed proposal change expected effect effects validation exam windows state states fact facts dispatch dispatched meaning mean means meant read reads reading write writes wrote written speak spoke spoken talk talked talking chat chatted conversation discuss discussed mention mentioned explain explained describe described ask asking answering wondering wonder curious interested interest looking searching search searched hoping trying tried getting waiting needing wanting thinking planning starting finishing finished done doing going staying leaving arriving showing sending receiving paying booking cancelling rescheduling scheduling confirming checking calling texting emailing help helping helped thanks thank thankful grateful glad pleased happy unhappy upset angry mad annoyed frustrated disappointed confused surprised worried nervous scared afraid careful carefully quickly slowly easily hardly really actually basically literally seriously honestly obviously apparently supposedly hopefully luckily unfortunately finally suddenly recently lately currently normally usually typically generally mostly mainly especially particularly specifically exactly clearly certainly definitely probably possibly perhaps maybe whatever anyway anyways though however meanwhile otherwise instead besides plus also too either neither both whether while whereas although unless until unlike including excluding regarding concerning according depending following considering given based due unable able ready willing sure certain positive negative correct wrong true false real fake actual exact proper right left okay alright fine great good bad better best worse worst nice cool sweet lovely beautiful ugly pretty terrible awful horrible fantastic excellent outstanding decent fair average normal regular usual typical common rare unusual strange weird odd funny serious silly crazy insane huge tiny massive giant enormous little medium extra overall entire whole full empty fresh stale raw ripe ready hurry rush quick slow easy hard soft loud quiet busy free lazy tired sleepy awake asleep hungry thirsty sick healthy fit strong weak rich poor cheap costly expensive worth valuable useful useless helpful harmful safe risky dangerous careful reckless clean dirty neat messy tidy wet dry hot cold warm cool chilly freezing boiling burning bright dim dark light heavy thin thick fat skinny long short tall wide narrow deep shallow high low big small large old new young all he she him her his hers its their theirs them these those been being were was am is are has have had having does did done doing would could should might must shall may will can cannot ought whom whose that this myself yourself himself herself itself ourselves themselves mine yours ours i me my we us our you your they it and the of to in for on with at by from as into onto up out off over under again further once here there when where why how all both each few more most other some such no nor not only own same so than too very can just should now second third fourth fifth sixth seventh eighth ninth tenth zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty thirty forty fifty sixty seventy eighty ninety hundred thousand million dozen half quarter couple pair single double next last previous final middle top bottom left right center centre upper lower inner outer main major minor general special specific certain particular possible impossible likely unlikely necessary available similar simple easy hard difficult tough quiet loud bright dark heavy light thick thin deep shallow wide narrow tall short strong weak rich poor cheap expensive fair sweet sour bitter fresh clean dirty messy neat tidy wild tame close far near nearby distant local main whole entire complete partial total extra additional spare rest remaining several various numerous multiple lots plenty enough less least fewer fewest anymore anyway anyhow besides otherwise therefore thus hence meanwhile finally eventually recently currently previously formerly lately nowadays sometime somehow someday somewhat almost nearly mostly mainly partly barely hardly scarcely simply merely truly surely certainly definitely absolutely exactly precisely roughly approximately about around per each every either neither')
// Everyday words the 2026-10-01 prod sweep found missing (texts held as "not English" for them alone), and #5520 r5's "everybody".
const ENGLISH_EXTRA = wordList('everybody everyone everything soap dish dishes impressed impress reimburse reimbursed reimbursement lol lmao omg haha digit digits cert certificate certificates permit permits inspection inspections inspector inspect shine growth llc inc company property management vendor credentials referral referrals rentals rental manor loop via east west north south ranch effective residence home homes');
let englishLexiconCache = null;
function englishLexicon() {
  if (!englishLexiconCache) {
    englishLexiconCache = new Set([...SUPPORTED_PROFILES.en, ...SMS_CORE_WORDS, ...ENGLISH_COMMON, ...ENGLISH_EXTRA]);
    // the domain words the owner approved (COMPANY FACTS, product-free) are English by construction
    for (const fact of require('./sms-company-facts').COMPANY_FACTS) for (const w of wordsOf(stripMarks(fact.toLowerCase()))) englishLexiconCache.add(w);
  }
  return englishLexiconCache;
}
// a token is known English when it, or the stem of a regular inflection of it (plural, past, -ing, -ly, -er), is in the lexicon
function englishKnown(word) {
  const lex = englishLexicon();
  if (lex.has(word)) return true;
  const stems = [/s$/, /es$/, /ed$/, /d$/, /ing$/, /ly$/, /er$/, /ers$/, /ies$/].map((re) => (re.test(word) ? word.replace(re, '') : null)).filter(Boolean);
  return stems.some((stem) => stem.length > 2 && (lex.has(stem) || lex.has(`${stem}e`) || lex.has(`${stem}y`) || lex.has(stem.slice(0, -1))));
}
// English by PROPORTION, not by one shared word: a code-switched "Kailan puwedeng lumabas ang aso after treatment?" has two English
// tokens in seven and is unverified. Tokens are letters only, two or more of them (numbers, URLs, emoji and one-letter words drop out).
// Follow-up to #5416 (prod sweep: 29 of 30 flags were English): what is not language never counts against a text - a reaction
// ("Liked “See you Tuesday”"), a name or other capitalized word after the first word of a sentence, and an address
// (the words after a house number up to its street word). A text of three tokens or fewer is held only on POSITIVE evidence:
// a function word of a language the guards cannot read ("Dlaczego nie"), never an unknown English word ("No growth").
const ENGLISH_SHARE = 0.6;
const REACTION_RE = /^\s*(?:(?:liked|loved|disliked|laughed\s+at|emphasi[sz]ed|questioned|removed\s+an?\s+\w+\s+from|reacted\s+\S+\s+to)\s+[\u201c\u2018"'][\s\S]*$|reacted\s+\S+\s+to\s+(?:an?\s+)?(?:image|photo|picture|video|message|attachment|sticker|gif)\s*$)/i;
// A reaction with nothing typed after the quote it reacts to (a truncated quote with no closing mark is still pure).
function isPureReaction(text) {
  if (!REACTION_RE.test(text)) return false;
  const open = text.search(/[\u201c\u2018"']/);
  if (open < 0) return true; // a reaction to an image / video carries no quote
  const closer = { '\u201c': '\u201d', '\u2018': '\u2019', '"': '"', "'": "'" }[text[open]];
  // the FIRST matching closing mark ends the quote (a truncated quote with none is still pure); any letters after it are the customer's own text
  const close = text.indexOf(closer, open + 1);
  return close < 0 || !/\p{L}/u.test(text.slice(close + 1));
}
const STREET_WORDS = wordList('st street rd road dr drive ln lane ave avenue blvd boulevard ct court cir circle pl place ter terrace way pkwy parkway hwy highway trl trail loop run cv cove pt point sq square apt ste suite unit');
// Function / timing words of languages the guards cannot read, beyond the profiles above (Polish, Vietnamese without diacritics).
const EXTRA_FOREIGN_WORDS = wordList('nie czy jest sie kiedy dlaczego mozna moge moga prosze dziekuje dzien dobry dwie godziny godzin godzine poczekaj czekac psy pies dzieci deszcz trawnik juz tylko khi nao cho the ngoai sau xit thuoc toi hoi tre em choi tren duoc khong bao lau');
let foreignWordSetCache = null;
function foreignWordSet() {
  if (!foreignWordSetCache) {
    const lex = englishLexicon();
    foreignWordSetCache = new Set();
    for (const set of [SUPPORTED_PROFILES.es, SUPPORTED_PROFILES.pt, SUPPORTED_PROFILES.fr, ...Object.values(UNSUPPORTED_PROFILES), EXTRA_FOREIGN_WORDS]) {
      for (const w of set) if (w.length > 1 && !lex.has(w)) foreignWordSetCache.add(w);
    }
  }
  return foreignWordSetCache;
}
// The tokens that can speak for the text's language: lower-cased, accents removed, with names and addresses left out.
function languageTokens(text, { keepNames = false } = {}) {
  // Title Case or ALL CAPS text is not a run of names: when nearly every word after the first is capitalized, every word counts
  // ("Hi this is Marisol Quintanilla" stays a name; "Can The Dogs Go Out Now" does not).
  const rest = (stripMarks(text).match(/[A-Za-z]{2,}/g) || []).slice(1);
  const keepCapitalized = keepNames || (rest.length > 0 && rest.filter((w) => /^[A-Z]/.test(w)).length >= 0.8 * rest.length);
  // contractions are one word ("i'm" -> "im", "don\u2019t" -> "dont"), as the lexicon spells them
  const raws = text.replace(/(\p{L})['\u2019](\p{L})/gu, '$1$2').split(/\s+/).filter(Boolean);
  // An address is a house number followed, within four words, by a street word ("4821 Weatherby Oaks Cir"): only those words are
  // skipped. A number with no street word after it ("2 godziny wystarczy?", "2 hours later") leaves every word counted.
  const skip = new Set();
  raws.forEach((raw, i) => {
    if (!/^\d+[a-z]?[,.]?$/i.test(raw)) return;
    for (let j = i + 1; j <= i + 4 && j < raws.length; j++) {
      const word = stripMarks(raws[j]).toLowerCase().replace(/[^a-z]/g, '');
      if (STREET_WORDS.has(word)) {
        for (let k = i + 1; k <= j; k++) skip.add(k);
        // the address tail: a unit ("apt 102"), then up to three capitalized city / state words or a zip ("Oak Bluff FL 34000")
        let k = j + 1;
        if (k < raws.length && /^(?:apt|unit|ste|suite|#)\.?$/i.test(raws[k])) { skip.add(k); k += 1; if (k < raws.length && /^#?\d+\w?[,.]?$/.test(raws[k])) { skip.add(k); k += 1; } }
        for (let n = 0; n < 4 && k < raws.length && (/^[A-Z][a-z]*[,.?!]?$/.test(raws[k]) || /^[A-Z]{2}[,.?!]?$/.test(raws[k]) || /^\d{5}(?:-\d{4})?[,.?!]?$/.test(raws[k])); n += 1, k += 1) skip.add(k);
        break;
      }
    }
  });
  const tokens = [];
  let sentenceStart = true;
  raws.forEach((raw, i) => {
    const endsSentence = /[.!?]["\u201d\u2019')]*$/.test(raw);
    if (skip.has(i)) { sentenceStart = endsSentence; return; }
    // a number glued to a word ("2godziny", "4hrs") still contributes the word; a bare number contributes nothing
    // (an ordinal's suffix - "4th", "21st" - is part of the number)
    for (const word of stripMarks(raw.replace(/^\d+(?:st|nd|rd|th)\b/i, '').replace(/^[\d.,:/#-]+/, '')).match(/[A-Za-z]+/g) || []) {
      const lower = word.toLowerCase();
      const capitalized = /^[A-Z]/.test(word);
      if (!((capitalized && !sentenceStart && !keepCapitalized) || lower.length < 2)) tokens.push(lower);
      sentenceStart = false;
    }
    if (endsSentence) sentenceStart = true;
  });
  return tokens;
}
// Is this lower-cased token a capitalized word (a name) in the original text?
const isNameToken = (original, w) => new RegExp(`(?<![\\p{L}])${w.charAt(0).toUpperCase()}${w.slice(1)}(?![\\p{L}])`, 'u').test(stripMarks(original));
function isUnverifiedLanguageInbound(inbound) {
  if (inboundOverCap(Array.isArray(inbound) ? inbound[0] : inbound)) return true;
  const original = canonText(Array.isArray(inbound) ? inbound[0] : inbound).replace(/https?:\/\/\S+|www\.\S+|\S+@\S+/g, ' ');
  const text = original.toLowerCase();
  if (wordsOf(stripMarks(text)).length < 2) return false;
  if ([...text.matchAll(/\p{L}/gu)].some(([ch]) => !/[a-z]/.test(ch) && !ALLOWED_DIACRITICS.includes(ch))) return true;
  if (isPureReaction(original)) return false;
  // Names leave the count only when the rest is plainly English: one unknown lowercase word beside a name puts every word back
  // ("Hi Fido kimehet most kerlek please?" is judged on all six words, #5520 r4; "Hi this is Marisol Quintanilla" stays English).
  const withoutNames = languageTokens(original);
  const tokens = withoutNames.every(englishKnown) ? withoutNames : languageTokens(original, { keepNames: true });
  if (!tokens.length) return false;
  const foreign = foreignWordSet();
  const lowerAll = languageTokens(original, { keepNames: true });
  // A statement made only of capitalized words with no foreign word and no question ("Jane Example") is a name, not a language.
  if (!/[?]/.test(original) && lowerAll.length <= 3 && lowerAll.every((w) => isNameToken(original, w)) && !lowerAll.some((w) => foreign.has(w))) return false;
  // (also held: a short text with no known English word at all, "Pot iesi?" - a language on no list, which the reply guards cannot read)
  if (tokens.length <= 3) {
    // A short text is judged on ALL its words, capitalized ones included (#5520 r3): leaving a name out of two or three words
    // lets one English word carry a foreign verb ("Can Fido mehet?"). Names in the lexicon ("Hey Adam") still read as English.
    const all = languageTokens(original, { keepNames: true });
    if (all.some((w) => foreign.has(w))) return true;
    const knownShort = all.filter(englishKnown).length;
    // A short text that asks a label question must be ALL known words: one unknown word beside "outside" is exactly where a
    // foreign question hides ("Kutyak mehetnek outside?", #5520 r2). Any other short text needs half ("No growth" stays English).
    const asksLabel = askedKindsOf(text).kinds.length > 0 || askedKindsOf(text).elliptical;
    return asksLabel ? knownShort < all.length : knownShort * 2 < all.length;
  }
  const known = tokens.filter(englishKnown).length;
  return known / tokens.length < ENGLISH_SHARE;
}

// The greeting "buenos dias" says no timing; everything else in the table is held.
const NON_ENGLISH_GREETING_RE = /(?<![\p{L}])buen(?:os|as)\s+(?:dias|noches)(?![\p{L}])/giu;
function nonEnglishTimingWords(text) {
  if (overCap(text, MAX_REPLY_CHARS)) return true;
  const t = stripMarks(canonText(text).toLowerCase()).replace(NON_ENGLISH_GREETING_RE, ' ');
  return UNREADABLE_SCRIPT_RE.test(t) || NON_ENGLISH_TIMING_VOCAB.some((v) => v.re.test(t));
}

// ---- The reply guard on a final body -------------------------------------
// "Safe once dry" with the technician confirming timing is the one sanctioned
// idiom: it carries no timing modifier, so it is swapped for a neutral token
// before the guard reads the reply (unless it names a time: "safe once dry in 30 minutes").
const SANCTIONED_SAFE_RE = /(?<![\w-])safe\s+(?:once|when|after)\s+(?:it(?:'s| is| has)?\s+)?dr(?:y|ied|ying)\b(?!\s*[-\u2013\u2014,]?\s*(?:in|within|after|by|around|about|roughly|approximately|~)\s*(?:about\s+|around\s+)?\d)/i;
// Only the TECHNICIAN sanctions the idiom (owner rule: "safe once dry" + the technician confirming timing): an office / team / "we"
// confirmation is an ordinary hand-off and never makes "safe once dry" pass.
// The confirmation must be the AFFIRMATIVE sanctioned clause ("your technician
// will confirm the timing"), ending its sentence or trailing only "at the
// visit" / "for your yard". A negated or hedged form ("cannot confirm timing",
// "may not", "unsure") is not the idiom, and neither is any negation or hedge
// in the sentence that carries the idiom or the clause.
// (the real-answers prompt's follow-up deadline - the exact SLA_PHRASES of sms-followup-sla - may trail the confirmation)
// The follow-up deadline phrases (the exact SLA_PHRASES of sms-followup-sla) are read when first needed, not at module load: a consumer that
// mocks or partially loads that module (or loads this one first) must not break the import. Missing phrases mean no deadline tail is
// accepted (stricter: fail closed).
function slaPhrases() {
  try {
    const phrases = require('./sms-followup-sla').SLA_PHRASES;
    return Array.isArray(phrases) ? phrases : [];
  } catch {
    return [];
  }
}
let confirmTimingRe = null;
function confirmTimingRegExp() {
  if (!confirmTimingRe) {
    const phrases = slaPhrases();
    const deadline = phrases.length ? `(?:\\s+(?:${phrases.map((p) => escapeRegex(p).replace(/ /g, '\\s+')).join('|')}))?` : '';
    confirmTimingRe = new RegExp(`(?<![\\w'-])(?:your|the|our)\\s+(?:technician|tech)\\s+(?:will\\s+)?confirms?\\s+(?:the\\s+|your\\s+)?timing(?:\\s+(?:at|during|for|on)\\s+(?:the|your)\\s+(?:visit|appointment|yard|next\\s+visit|service))?${deadline}\\s*(?:[.!]|$)`, 'i');
  }
  return confirmTimingRe;
}
const NEGATION_HEDGE_RE = /\b(?:not|no|never|nothing|nobody|cannot|without|unable|unsure|uncertain|unclear|unknown|may|might|maybe|perhaps|possibly|probably|hopefully|depends?|depending|but|however|unless|although|though|except|neither|nor|hardly|barely)\b|\bcan\s+not\b|n't\b/i;
function sanctionSafeOnceDry(text) {
  if (overCap(text, MAX_REPLY_CHARS)) return String(text || ''); // (not sanctioned; the reply guard holds an over-long reply)
  const t = String(text || '');
  const canon = canonText(t);
  if (!SANCTIONED_SAFE_RE.test(t) || !confirmTimingRegExp().test(canon)) return t;
  const hedged = canon.split(/(?<=[.!?])\s+/).some((sentence) => (SANCTIONED_SAFE_RE.test(sentence) || confirmTimingRegExp().test(sentence)) && NEGATION_HEDGE_RE.test(sentence));
  return hedged ? t : t.replace(SANCTIONED_SAFE_RE, ' SANCTIONED_IDIOM ');
}

// ---- What the customer asked, and answering it without the sentence -------
// A reply like "It's okay." / "Yes, they can." / "No, not yet." carries no label word, so the clause
// rules cannot see it. When the INBOUND asks a label kind (re-entry: people, pets, going out, watering,
// mowing, safe; rain: rain, wash off, sprinklers), the reply may answer it only with the authorized
// sentence, "safe once dry" + the technician confirming, the COMPANY FACTS rain line, or a hand-off.
const ASKED_QUESTION_RE = /\?|(?:^|[.!\n]\s*)(?:can|could|will|would|should|may|is|are|do|does|when|how|what|which|ok|okay)\b|\b(?:wondering|want\s+to\s+know|need\s+to\s+know|curious)\b/;
const ASKED_REENTRY_RE = new RegExp([BEING_RE.source, ACTIVITY_RE.source, REENTRY_TOPIC_RE.source, DRY_RE.source, /\bsafe\b|\bgo\s+(?:out|outside|back)\b|\blet\s+\w+\s+out\b/.source].join('|'));
// Structural re-entry topic: someone (people / pets / kids, or "we / I / you / my / our") plus somewhere outdoors, or an outdoor
// activity beside either ("can we use the backyard now?", "ok to mow?", "can we grill outside tonight", "the lanai / pool deck").
const OUTDOOR_PLACE_RE = /\b(?:yard|backyard|front\s+yard|lawn|grass|patio|pool(?:\s+deck)?|deck|porch|lanai|garden|driveway|outside|outdoors?|treated\s+areas?|play\s+area|playset|sod|turf)\b/;
const OUTDOOR_ACTIVITY_RE = /\b(?:use|using|go|going|play|playing|sit|sitting|walk|walking|let\s+\w+\s+out|mow|mowing|water|watering|garden|gardening|grill|grilling|swim|swimming|barbecue|bbq)\b/;
const ASKER_RE = new RegExp(BEING_RE.source + "|\\b(?:we|i|you|us|our|my|me|they|them|he|she|kids?|family)\\b");
// Indoor re-entry ("can we go back inside?", "ok to come back in?", "is the kitchen safe", "can we sleep in the bedroom tonight",
// "can I let the cat back in"): someone + an entry verb, or someone + an indoor place with a question / ok / entry word, or an
// indoor place with a question / ok word. Staff going in ("can you come inside to spray", "the tech will come inside") is access,
// not re-entry. Every alternative is a plain word list with bounded gaps.
const INDOOR_PLACE_RE = /\b(?:inside|indoors?|house|home|rooms?|bedrooms?|kitchen|living\s+room|garage|attic|crawlspace|basement|bathroom|closet|cabinets?|pantry|baseboards?|floors?|carpets?|couch|furniture|nursery)\b/;
const ENTRY_RE = /\b(?:re-?enter|enter|return\s+(?:home|inside|indoors|in|to\s+(?:the\s+|our\s+|my\s+)?(?:house|home|yard|lawn|property))|come\s+home|(?:get|head|move|be)\s+back\s+(?:home|in|inside|indoors|to\s+(?:the\s+|our\s+|my\s+)?(?:house|home|yard|lawn|property))|(?:go|come|get|walk|move)\s+(?:back\s+)?(?:in|inside|indoors)(?!\s+(?:\d|(?:a|an)\s+(?:few|couple|week|month|day|hour)|(?:one|two|three|four|five|six|seven|eight|nine|ten|a)\s+(?:days?|weeks?|months?|hours?)|the\s+(?:morning|afternoon|evening)))|let\s+(?:\w+\s+){0,2}?(?:back\s+)?(?:in|inside|indoors)|sleep(?:ing)?\s+in|stay(?:ing)?\s+in|use\s+the\s+(?:kitchen|bathroom|bedroom|room|garage|basement|attic))\b/;
const STAFF_ENTRY_RE = /\b(?:you|(?:the|our|your)\s+(?:tech|technician|guy|team|crew)|tech|technician|someone)\s+(?:will\s+|can\s+|could\s+|should\s+|would\s+|need\s+to\s+|have\s+to\s+|to\s+)?(?:come|go|get|enter|walk)\s+(?:in|inside|indoors|into|back)\b/;
const OK_WORD_RE = /\b(?:safe|ok|okay|fine|ready|usable|clear|allowed)\b/;
// ("you" is not the one going in: "do you spray inside the house?" is a question about the service)
const INDOOR_ASKER_RE = new RegExp(BEING_RE.source + "|\\b(?:we|i|us|our|my|me|they|them|he|she|kids?|family)\\b");
// ("do I need to be home / here for the appointment?" is pre-visit access, not re-entry)
const BE_HOME_ACCESS_RE = /\b(?:(?:need|have|got|supposed|required)\s+to|(?:should|must|do)\s+(?:i|we))\s+(?:to\s+)?be\s+(?:here|home|inside|there)\b/;
// Deictic indoor stay ("can we sleep here tonight?", "is it okay to stay here?", "can the kids stay home today", "ok to be here?"): a being subject
// (or an ok word) with a question shape. A plain statement ("we will be home Tuesday") and "will you be here Tuesday?" (no being subject) are not.
const DEICTIC_STAY_RE = /\b(?:sleep(?:ing)?|stay(?:ing)?|be|being|live|living|remain(?:ing)?)\s+(?:in\s+here|here|at\s+home|home)\b/;
// Permission-entry forms ("are we allowed back in?", "is it safe to go back", "are we clear to go in", "ok to come back in"): an allowed / ok /
// cleared / safe word + (to) + back / in / inside / home / go in / return. With a being subject, or with the explicit going-in verb.
const PERMISSION_ENTRY_WORD_SRC = 'allowed|permitted|ok|okay|cleared?|good|fine|safe';
const PERMISSION_ENTRY_RE = new RegExp(`\\b(?:${PERMISSION_ENTRY_WORD_SRC})\\s+(?:to\\s+)?(?:(?:go|come|get|head|move)\\s+)?(?:back(?:\\s+(?:in|inside|indoors|home))?|in|inside|indoors|home|return)\\b(?!\\s+(?:in\\s+the\\s+(?:morning|afternoon|evening)|the\\s+(?:morning|afternoon|evening)|on\\b|at\\b|by\\b|around\\b|next\\b|tomorrow|\\d|(?:mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?|sun)))`);
const PERMISSION_GO_BACK_RE = new RegExp(`\\b(?:${PERMISSION_ENTRY_WORD_SRC})\\s+to\\s+(?:go|come|get|head|move)\\s+(?:back|in|inside|indoors)\\b`);
// Bare "come back" forms ("can we come back now?", "ok to come back?", "when can we get back", "can we go back yet"): a being / first-person
// subject (or an ok word), a question / ok / now / yet shape, the going verb ending the clause or followed only by an immediacy word, and NO
// scheduling object ("come back Tuesday", "come back in two weeks for the follow-up", "come back to check", "get back to you" are not).
const BARE_BACK_RE = /\b(?:come|go|get|head|move|be)\s+back(?=\s*(?:[?!.,;]|$)|\s+(?:now|yet|today|tonight|already|soon|safely|anytime|any\s+time|right\s+away)\b)/;
const BARE_BACK_SCHEDULING_RE = /\b(?:appointments?|schedul\w*|reschedul\w*|to\s+check|follow-?ups?|estimates?|quotes?|inspections?|tomorrow|next|(?:mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?|sun)(?:day)?s?)\b/;
const BARE_BACK_SHAPE_RE = /\b(?:now|yet)\b/;
const asksBareBackEntry = (text) => BARE_BACK_RE.test(text) && !BARE_BACK_SCHEDULING_RE.test(text) && !STAFF_ENTRY_RE.test(text) && !BE_HOME_ACCESS_RE.test(text)
  && (INDOOR_ASKER_RE.test(text) || OK_WORD_RE.test(text)) && (ASKED_QUESTION_RE.test(text) || OK_WORD_RE.test(text) || BARE_BACK_SHAPE_RE.test(text));
const asksIndoorReentry = (text) => !STAFF_ENTRY_RE.test(text) && !BE_HOME_ACCESS_RE.test(text) && (
  asksBareBackEntry(text)
  || (PERMISSION_ENTRY_RE.test(text) && INDOOR_ASKER_RE.test(text))
  || PERMISSION_GO_BACK_RE.test(text)
  ||
  (DEICTIC_STAY_RE.test(text) && ASKED_QUESTION_RE.test(text) && (INDOOR_ASKER_RE.test(text) || OK_WORD_RE.test(text)))
  ||
  (ENTRY_RE.test(text) && (INDOOR_ASKER_RE.test(text) || OK_WORD_RE.test(text)))
  || (INDOOR_PLACE_RE.test(text) && INDOOR_ASKER_RE.test(text) && (ASKED_QUESTION_RE.test(text) || OK_WORD_RE.test(text)))
  || (INDOOR_PLACE_RE.test(text) && OK_WORD_RE.test(text) && ASKED_QUESTION_RE.test(text)));
const asksReentryStructurally = (text) => asksIndoorReentry(text) || (ASKER_RE.test(text) && OUTDOOR_PLACE_RE.test(text)) || (OUTDOOR_ACTIVITY_RE.test(text) && (OUTDOOR_PLACE_RE.test(text) || BEING_RE.test(text)))
  || (OUTDOOR_PLACE_RE.test(text) && (ASKED_QUESTION_RE.test(text) || /\b(?:safe|ok|okay|fine|ready|usable|clear)\b/.test(text)));
// Weather-only wording ("will this weather affect the treatment?", "the wet grass ok?", "humid today, will it still work?")
// asks the rain kind when it has a question shape or a treatment / spray / application / work / effect context.
const WEATHER_WORD_RE = /\b(?:weather|wet|dew|dewy|condensation|moisture|fog|foggy|mist|misty|storm\w*|forecast\w*|humid\w*|humidity|drizzl\w*|pour(?:s|ed|ing)?|downpour\w*|sprinkl\w*|damp|soaked|soaking|showers?|rain\w*)\b/;
const TREATMENT_CONTEXT_RE = /\b(?:treatment|treated|spray|sprayed|spraying|application|applied|product|granules?|fertilizer|work|works|working|effect|affect|affected)\b/;
const ASKED_RAIN_RE = new RegExp([RAIN_WORD_RE.source, RAINFAST_RE.source, /\bwater(?:ing)?\s+in\b/.source].join('|'));
const asksWeather = (text) => WEATHER_WORD_RE.test(text) && (ASKED_QUESTION_RE.test(text) || TREATMENT_CONTEXT_RE.test(text));
// "should I keep the dogs in when you arrive?" asks about access, not re-entry.
const ASKED_ACCESS_RE = /\b(?:when|before|while|as)\s+(?:you|y'?all|we|the\s+(?:tech|technician|guy|team))\s+(?:arrive|arrives|come|comes|get|gets|show|stop|are\s+here|is\s+here)\b/;

// A short follow-up with no topic word ("is it ok now?", "what about now", "and outside?") asks whatever the
// thread was about; with nothing classifiable in the thread it is treated as asking both kinds (fail closed).
// A BARE first-person modal follow-up (Codex #5416 r30: "Can we now?", "Can I now?", "Are we allowed now?") is elliptical too: the
// whole message is the modal plus a closed vocabulary of re-entry / timing words, so "can I clean the grill now?" stays its own question.
const FIRST_PERSON_FOLLOWUP_RE = /^(?:(?:so|ok|okay|but)\s+)?(?:can|could|may|should|are|am)\s+(?:we|i)\b(?:\s+(?:now|yet|then|today|tonight|too|also|still|go|be|allowed|ok|okay|good|fine|safe|to|out|outside|inside|in|back|there|it|on|walk|wait|let|the|dogs?|kids?|pets?|cats?|them|again|already|please|pls|plz|just|maybe|really))*[\s?.!]*$/;
const ELLIPTICAL_RE = /^and\s+\w+|^(?:(?:so|ok|okay|but)\s+)?(?:(?:what|how)\s+about|is\s+(?:it|that|this|everyone|everybody)|are\s+they|can\s+(?:they|he|she|it)|will\s+(?:it|that)|now|then|outside|inside|out)\b/;
const NOT_ELLIPTICAL_RE = new RegExp([BUSINESS_RE.source, SCHEDULE_WORD_RE.source, /\b(?:arrive|arrives|come|coming|call|text|schedule|reschedule|appointment|book|booking|visit|pay|price|cost|service)\b/.source].join('|'));
function isEllipticalInbound(text) {
  // (a bare "can we come back now?" is a short follow-up too: it carries the thread's kinds and visit references, though "come" is a NOT_ELLIPTICAL word)
  return text.split(/\s+/).length <= 8 && (asksBareBackEntry(text) || FIRST_PERSON_FOLLOWUP_RE.test(text) || (ELLIPTICAL_RE.test(text) && !NOT_ELLIPTICAL_RE.test(text)));
}

// No question shape is required for a topic: "tell me when my dogs can go outside" asks re-entry as much as a
// "?" does, so any label-topic vocabulary counts (over-holding a mere mention of the dogs is accepted: fail closed).
// Only explicit pre-visit access wording is exempt. A follow-up with no topic word needs a question shape to count.
// Watering ("can I water the lawn now?", "is it ok to water?", "when can I run the sprinklers", "can I turn the irrigation back on")
// in a timing / permission / treatment / weather context asks BOTH kinds (the rain-fast time and the keep-off time both bear on it);
// general watering advice with none of that ("what days should I water my lawn?", "how often should I water") asks no label kind,
// so the approved COMPANY FACTS watering answer is what answers it.
const WATERING_RE = /\b(?:water(?:ing)?(?=\s+(?:the|my|our|it|them|in|down|early|daily|twice|every|once|more|less|again|now|today|tonight|tomorrow|yet|lawn|grass|yard|plants?|garden|sod)\b|\s*[?!.]|\s*$)|to\s+water\b|sprinklers?|irrigat\w+|hose|turn(?:ing)?\s+(?:the\s+)?(?:water|sprinklers?|irrigation)\s+(?:back\s+)?on|run(?:ning)?\s+the\s+(?:sprinklers?|irrigation|water))\b/;
const WATERING_CONTEXT_RE = /\b(?:now|yet|ok|okay|safe|fine|when|can\s+(?:i|we)|may\s+(?:i|we)|allowed|how\s+long|after|before|until|till|today|tonight|tomorrow|already|still|treatment|treated|spray|sprayed|spraying|application|applied|fertilizer|fertilized|granules?|product|wait|hold\s+off|again|back\s+on)\b/;
const WATERING_WEATHER_RE = /\b(?:dew|dewy|fog|foggy|mist|misty|moisture|condensation|rain\w*|showers?|storms?|stormy|forecast\w*|drizzl\w*|downpour\w*|weather|humid\w*|wet|soaked)\b|\bwash(?:es|ed)?\s+(?:it\s+)?(?:off|away)\b/;
const OTHER_REENTRY_TOPIC_RE = new RegExp(BEING_RE.source + '|\\b(?:walk|walking|play|playing|mow|mowing|swim|swimming|sit|sitting|enter|inside|indoors)\\b');
// Rinsing / washing / hosing / wiping / mopping / cleaning a TREATED SURFACE ("can I rinse the lawn now?", "ok to pressure wash the driveway?", "can I wipe
// down the baseboards?") is the same question as watering: the rain-fast time and the keep-off time both bear on it. A timing / permission context is
// required (same as watering); with no treated surface ("can I wash my car tomorrow?") it asks no kind.
const CLEANING_SURFACE_SRC = 'lawn|grass|yard|patio|deck|driveway|porch|lanai|walkway|sidewalk|pavers?|siding|fence|furniture|baseboards?|floors?|carpets?|cabinets?|counters?|countertops?|windows?|sills?|walls?|screens?|cage|pool\\s+deck|treated\\s+(?:areas?|surfaces?)|surfaces?|house|home';
const CLEANING_RE = new RegExp(`\\b(?:rins(?:e|es|ed|ing)|wash(?:es|ed|ing)?|(?:pressure|power)[-\\s]?wash\\w*|hos(?:e|es|ed|ing)\\s+(?:off|down)|spray(?:s|ed|ing)?\\s+down|wip(?:e|es|ed|ing)\\s+(?:down|off)|mop(?:s|ped|ping)?|clean(?:s|ed|ing)?)\\b(?:\\s+[\\w'-]+){0,4}?\\s+(?:${CLEANING_SURFACE_SRC})\\b`);
// A wash-family verb tied to the TREATMENT itself ("will pressure washing affect the treatment?", "will hosing affect the spray?", "can I pressure wash after the
// application?") asks the rain kind whatever surface is named (or none): washing is what rain does to a treatment.
const WASH_VERB_RE = /\b(?:rins(?:e|es|ed|ing)|wash(?:es|ed|ing)?|(?:pressure|power)[-\s]?wash\w*|hos(?:e|es|ed|ing)|spray(?:s|ed|ing)?\s+down|wip(?:e|es|ed|ing)\s+(?:down|off)|mop(?:s|ped|ping)?)\b/;
const WASH_TREATMENT_RE = /\b(?:treatment|treatments|treated|spray|sprayed|spraying|application|applications|applied|product|products|granules?|fertilizer|fertilized|effect|affect|affected|affects)\b/;
function cleaningKinds(text) {
  if (CLEANING_RE.test(text) && (WATERING_CONTEXT_RE.test(text) || WATERING_WEATHER_RE.test(text))) return ['reentry', 'rain'];
  return WASH_VERB_RE.test(text) && WASH_TREATMENT_RE.test(text) ? ['rain'] : null;
}
// Whether watering will hurt the treatment ("Will the sprinklers weaken it?", "does irrigation affect the spray?") is the rain-fast question
// in other words (Codex #5416 r34), not general watering advice. A generic noun (problem / issue / matter) counts only when it is tied
// to the treatment, and so does every effect verb ("will the sprinklers be a problem for the treatment?", "will they weaken it?"); "Sprinkler issue in
// zone 2" and "will the sprinklers hurt my new plants?" are not about the treatment (#5520 r2).
const WATERING_EFFECT_OBJECT_SRC = '(?:treatment|treated|spray\\w*|application|applied|product|granules?|fertiliz\\w*|it|that)';
// Effectiveness wording is about the treatment whatever its grammar ("make it less effective", "affect how well it works", "whether it
// works", #5520 r4).
// A sentence that starts another subject: an explicit switch, or a pest product / pest named as what is (in)effective.
const TOPIC_SWITCH_RE = /\b(?:separately|unrelated|another\s+(?:question|thing)|different\s+(?:question|topic)|also|bait|baits|traps?|granules?\s+for|ants?|roach(?:es)?|termites?|mosquito\w*|fleas?|ticks?)\b/;
const WATERING_EFFECTIVENESS_RE = /\b(?:less\s+effective|effectiveness|(?:how\s+well|whether|if)\s+(?:it|the\s+(?:treatment|spray|product|application))\s+(?:still\s+)?works?|stop\s+(?:it\s+)?(?:from\s+)?working)\b/;
const WATERING_EFFECT_RE = new RegExp(`\\b(?:(?:weaken\\w*|affect\\w*|hurt\\w*|harm\\w*|ruin\\w*|undo\\w*|dilut\\w*|impact\\w*|reduc\\w*|cancel\\w*|mess(?:es|ed)?\\s+(?:up|with)|interfer\\w*\\s+with|(?:have|has)\\s+an?\\s+effect\\s+on)\\s+(?:the\\s+|my\\s+|our\\s+|your\\s+|this\\s+)?|(?:a\\s+)?(?:problem|issue|matter|bother)\\s+(?:for|with|to)\\s+(?:the\\s+|my\\s+|our\\s+|your\\s+|this\\s+)?)${WATERING_EFFECT_OBJECT_SRC}\\b`);
function wateringKinds(text) {
  if (!WATERING_RE.test(text)) return cleaningKinds(text);
  const context = WATERING_CONTEXT_RE.test(text) || WATERING_WEATHER_RE.test(text);
  if (context) return ['reentry', 'rain'];
  // a re-entry topic beside the watering ("will the sprinklers hurt the dogs if they walk on it?") goes to the general classifier first
  if (OTHER_REENTRY_TOPIC_RE.test(text)) return null;
  // the effect / effectiveness wording must be in the SAME sentence as the watering (#5520 r5: "My sprinkler is broken. Separately,
  // is the ant bait less effective in winter?" is not about watering)
  // The NEXT sentence counts too when it points back at the watering ("The sprinklers ran. Will that make it less effective?") and does
  // not switch topic ("Separately, ...", or a subject of its own such as "the ant bait").
  const sentences = text.split(/[.!?;]+/);
  const effectIn = (sentence) => WATERING_EFFECT_RE.test(sentence) || WATERING_EFFECTIVENESS_RE.test(sentence);
  const pointsBack = (sentence) => /\b(?:it|that|this|they|them)\b/.test(sentence) && !TOPIC_SWITCH_RE.test(sentence);
  return sentences.some((sentence, i) => WATERING_RE.test(sentence)
    && (effectIn(sentence) || (i + 1 < sentences.length && pointsBack(sentences[i + 1]) && effectIn(sentences[i + 1])))) ? ['rain'] : [];
}

function askedKindsOf(inboundText) {
  const text = canonText(inboundText).toLowerCase();
  if (!text) return { kinds: [], elliptical: false };
  if (ASKED_ACCESS_RE.test(text) && !POST_TREATMENT_SIGNAL_RE.test(text)) return { kinds: [], elliptical: false };
  const watering = wateringKinds(text); // ([] for general watering advice, both kinds in a timing context, null when not about watering)
  if (watering) return { kinds: watering, elliptical: false };
  return { kinds: [(ASKED_REENTRY_RE.test(text) || asksReentryStructurally(text)) && 'reentry', (ASKED_RAIN_RE.test(text) || asksWeather(text)) && 'rain'].filter(Boolean), elliptical: ASKED_QUESTION_RE.test(text) && isEllipticalInbound(text) };
}

/**
 * ['reentry' | 'rain'] the inbound message asks about. With an array (the customer's recent messages, the
 * CURRENT one first) an ELLIPTICAL current message ("is it okay now?") inherits the thread's kinds; a
 * self-contained current message classifies on its own. [] = no label question; an elliptical current
 * message with nothing classifiable anywhere in the thread asks both.
 */
function askedLabelKinds(inbound) {
  if (inboundOverCap(inbound)) return ['reentry', 'rain', 'unverified_language'];
  if (!isEnglishInbound(inbound)) return ['reentry', 'rain', 'unverified_language'];
  const reads = (Array.isArray(inbound) ? inbound : [inbound]).map(askedKindsOf);
  const sources = reads[0]?.elliptical ? reads : reads.slice(0, 1);
  const kinds = ['reentry', 'rain'].filter((k) => sources.some((r) => r.kinds.includes(k)));
  return !kinds.length && reads[0]?.elliptical ? ['reentry', 'rain'] : kinds;
}

/** True when the current (first) message is a short follow-up that only makes sense with the thread. */
function inboundIsElliptical(inbound) {
  return askedKindsOf(Array.isArray(inbound) ? inbound[0] : inbound).elliptical;
}

const ANSWER_LEAD_RE = /^(?:yes|no|yeah|yep|yup|nope|sure|ok|okay|fine|alright|absolutely|definitely|certainly|of\s+course|correct|right|go\s+ahead|not\s+yet)\b/;
const ANSWER_BODY_RE = new RegExp([
  /\b(?:go\s+ahead|you'?re\s+good|you\s+are\s+good|not\s+yet|(?:they|you|he|she|everyone|everybody|it)\s+(?:can|could|may)|(?:it'?s|it\s+is|that'?s|that\s+is|is|are|be)\s+(?:safe|ok|okay|fine|good|alright)|hold\s+off|wait|all\s+clear|good\s+to\s+go)\b/.source,
  PRONOUN_CLEARANCE_RE.source, PLACE_CLEARANCE_RE.source, DAY_CLEARANCE_RE.source,
].join('|'));
// Short Spanish / Portuguese / French answer words (accents removed before matching) count as answer force too, so a send
// with no stored inbound still holds "S\u00ed, claro." / "Oui." / "Ainda n\u00e3o." like "Yes, sure."
const FOREIGN_ANSWER_RE = /^(?:si|claro|vale|por\s+supuesto|adelante|listo|no\s+todavia|sim|pode|oui|bien\s+sur|d'accord|allez-y|pas\s+encore|ainda\s+nao|nao|non(?=[\s,.!?]|$))\b|\b(?:por\s+supuesto|adelante|bien\s+sur|d'accord|allez-y|pas\s+encore|ainda\s+nao|no\s+todavia)\b/;
const hasAnswerForce = (text) => ANSWER_LEAD_RE.test(text) || ANSWER_BODY_RE.test(text) || FOREIGN_ANSWER_RE.test(stripMarks(text));

// ALLOWLIST: once a label question was asked, EVERY non-question sentence of the reply (copy or no copy) must be
// one of these types; anything else - "Go for it!", "Feel free", "Absolutely", "No worries, let them out" -
// is held without having to name it.
const wordsOf = (text) => text.match(/[a-z]+/g) || [];
const allIn = (words, set) => words.every((w) => set.has(w));
const wordSet = (list) => new Set(list.split(/\s+/));
// (a) an authorized copy (stripLabelSentences left its marker)
const isCopyMarker = (sentence) => /^labelsentence(?:reentry|rainfast)$/.test(sentence);
// (b) the sanctioned "safe once dry" (sanctionSafeOnceDry left its token), optionally with the technician confirming timing
const SANCTIONED_SENTENCE_RE = /^(?:(?:(?:it|that|this|they|everything)(?:'s|'re|\s+(?:is|are|will\s+be))|(?:pets|people|kids|dogs)(?:\s+and\s+(?:pets|people|kids|dogs))?\s+(?:are|will\s+be))\s+)?sanctioned_idiom\s*[,;-]?\s*(?:and\s+)?(?:(?:your|the|our)\s+(?:technician|tech)\s+(?:will\s+)?confirms?\s+(?:the\s+|your\s+)?timing(?:\s+(?:at|during|for|on)\s+(?:the|your)\s+(?:visit|appointment|yard|next\s+visit|service))?)?$/;
const isSanctionedSentence = (sentence) => SANCTIONED_SENTENCE_RE.test(sentence);
// (c) the COMPANY FACTS rain line, for a rain question (pre-marked before the sentences are split)
const COMPANY_RAIN_LINE_TEXT_RE = /treatment needs to dry and bond/i;
const COMPANY_RAIN_LINE_RE = /(?:a|the)\s+treatment\s+needs\s+to\s+dry\s+and\s+bond\s+to\s+surfaces\s*[;,.]?\s*(?:and\s+)?after\s+that,?\s+it\s+holds\s+up\s+to\s+weather/g;
const isCompanyLine = (sentence) => sentence === 'companyline';
// (g) a verbatim, complete-sentence copy of a sentence of the static COMPANY FACTS section (the rain line is (c),
// kept to rain questions); a "Label: text" line is copyable as the whole line or as its text. The section is
// static, so draft and send time read the same list. A company sentence never authorizes an answer-shaped add-on:
// each sentence of the reply is judged on its own.
const isCompanySentence = (sentence) => sentence === 'companysentence';
let companySentenceCache = null;
function companyFactSentences() {
  if (!companySentenceCache) {
    const facts = require('./sms-company-facts').COMPANY_FACTS;
    const out = new Set();
    for (const fact of facts) {
      for (const sentence of fact.split(/(?<=[.!?])\s+/)) {
        out.add(sentence);
        const text = /^[A-Z][^:.]{0,40}:\s+(.+)$/.exec(sentence);
        if (text) out.add(text[1]);
      }
    }
    companySentenceCache = [...out].filter((sentence) => !COMPANY_RAIN_LINE_TEXT_RE.test(sentence));
  }
  return companySentenceCache;
}
// the copyable company sentences of `canon` (canonText output) replaced by a marker, longest first
function markCompanySentences(canon) {
  let out = canon;
  for (const sentence of [...companyFactSentences()].sort((a, b) => b.length - a.length)) {
    for (const { start, end } of completeCopies(out, sentence).reverse()) out = `${out.slice(0, start)} ; companysentence ; ${out.slice(end)}`;
  }
  return out;
}
// (d) a hand-off: a staff subject, a deferral verb, and nothing but neutral words (an interjection lead is peeled
// first and never counts toward the neutral words)
const DEFERRAL_LEAD_RE = /^(?:sure|ok|okay|absolutely|of\s+course|happy\s+to\s+help)(?:[,!]|\s[-–—])?\s+/;
const DEFERRAL_SUBJECT_RE = /^(?:i'll|we'll|i\s+will|we\s+will|i\s+can|we\s+can|i|we|let\s+me|let\s+us|the\s+office|our\s+office|your\s+technician|the\s+technician|our\s+technician|a\s+teammate|someone|our\s+team|the\s+team|a\s+manager|the\s+owner)\b/;
const DEFERRAL_VERB_RE = /\b(?:confirm|confirms|check|follow\s+up|get\s+back|look\s+into|find\s+out|reach\s+out|verify|ask|text\s+you|call\s+you|let\s+you\s+know|have\s+an?\s+(?:answer|update))\b/;
const DEFERRAL_WORDS = wordSet('i ll we let me us to the our your a an office technician tech team teammate someone manager owner dispatch will would can have has be confirm confirms check follow up get back look into find out reach verify ask text call you know with on about that this it timing time details shortly soon today later as possible right away and more info information then just quickly at visit appointment next for what happened morning issue concern an answer update');
const isDeferral = (sentence) => {
  const body = sentence.replace(DEFERRAL_LEAD_RE, '');
  return DEFERRAL_SUBJECT_RE.test(body) && DEFERRAL_VERB_RE.test(body) && !hasAnswerForce(body.replace(DEFERRAL_SUBJECT_RE, ' ')) && allIn(wordsOf(body), DEFERRAL_WORDS);
};
// (e) a sign-off SENTENCE, matched whole (a bag of neutral words would let "thanks, it is good" through)
const SIGNOFF_SENTENCE_RE = new RegExp('^(?:'
  + "(?:thanks|thank\\s+you)(?:\\s+(?:so|very)\\s+much)?(?:\\s+for\\s+(?:reaching\\s+out|contacting\\s+(?:us|waves(?:\\s+pest\\s+control)?)|your\\s+(?:message|patience|question)|asking|letting\\s+us\\s+know|the\\s+question))?"
  + '|(?:good|great)\\s+question|happy\\s+to\\s+help|glad\\s+to\\s+help|hope\\s+(?:this|that)\\s+helps'
  + '|have\\s+a\\s+(?:great|good|wonderful|nice|lovely)\\s+(?:day|evening|weekend|one|afternoon|morning)|take\\s+care|talk\\s+soon|best(?:\\s+regards)?|regards'
  + "|(?:please\\s+)?(?:let\\s+us\\s+know|don'?t\\s+hesitate\\s+to\\s+(?:reach\\s+out|contact\\s+us|ask))(?:\\s+if\\s+you\\s+(?:have|need)\\s+(?:any\\s+)?(?:other\\s+|more\\s+|further\\s+)?(?:questions|anything(?:\\s+else)?|help))?"
  + ')$');
const isSignoffSentence = (sentence) => SIGNOFF_SENTENCE_RE.test(sentence);
// A leading salutation, thanks or "great question" and a trailing thanks / sign-off are PEELED off first; what is
// left is classified on its own, so nothing rides through on a friendly prefix or suffix. A sentence made only of
// such pieces passes (nothing remains).
const NAME_SEP_SRC = '\\s*[,!\\u2013\\u2014-]+\\s*';
const LEADERS_RE = new RegExp('^(?:'
  + `(?:(?:hi|hello|hey|hiya|greetings)(?:\\s+there)?(?:\\s+[a-z]+)?|good\\s+(?:morning|afternoon|evening)(?:\\s+[a-z]+)?)${NAME_SEP_SRC}`
  + `|(?:thanks|thank\\s+you)(?:\\s+(?:so|very)\\s+much)?(?:\\s+for\\s+(?:reaching\\s+out|contacting\\s+us|your\\s+message|letting\\s+us\\s+know))?${NAME_SEP_SRC}`
  + `|(?:good|great)\\s+question${NAME_SEP_SRC})`);
const GREETING_ONLY_RE = /^(?:(?:hi|hello|hey|hiya|greetings)(?:\s+there)?(?:\s+[a-z]+)?|good\s+(?:morning|afternoon|evening)(?:\s+[a-z]+)?)$/;
const TRAILERS_RE = /(?:\s*[,;–—-]+\s*|\s+)(?:thanks|thank\s+you(?:\s+(?:so|very)\s+much)?|have\s+a\s+(?:great|good|wonderful|nice|lovely)\s+(?:day|evening|weekend|one)|take\s+care|talk\s+soon)\s*$/;
// An apology opener ("So sorry about that", "I am sorry for the trouble", "I apologize for the delay", "apologies") is peeled like a
// greeting, with or without punctuation after it: what follows is judged on its own ("Sorry feel free to use it." is held), and an
// apology-only sentence passes only because nothing remains.
const APOLOGY_LEAD_RE = /^(?:(?:(?:i\s+am|i'm|we\s+are|we're)\s+)?(?:(?:so|very|really|truly)\s+)*sorry(?:\s+(?:about|for)\s+(?:that|this|the\s+(?:trouble|inconvenience|wait|delay|confusion)|any\s+(?:trouble|inconvenience)))?|(?:our\s+)?apologies|i\s+apologi[sz]e(?:\s+for\s+(?:that|this|the\s+(?:trouble|inconvenience|wait|delay|confusion)))?)(?:\s*[,!\u2013\u2014-]+\s*|\s+|$)/;
function peelFriendlyEnds(sentence, info = {}) {
  let rest = sentence.trim();
  for (let i = 0; i < 4; i += 1) {
    const withoutApology = rest.replace(APOLOGY_LEAD_RE, '');
    if (withoutApology !== rest) info.apology = true;
    const next = withoutApology.replace(LEADERS_RE, '').replace(TRAILERS_RE, '').trim();
    if (next === rest) break;
    rest = next;
  }
  return rest;
}
// An empathy clause after an apology ("I am sorry the spiders are back.") is not an answer: it must start with a plain report word,
// and carry no answer force, label word, duration or clock. It is allowed ONLY behind a peeled apology.
const EMPATHY_CLAUSE_RE = /^(?:that|this|the|to\s+hear|to\s+learn|you\s+had|you\s+have\s+had|it\s+took|it\s+was|we\s+missed|we\s+were)\b/;
const isEmpathyClause = (rest) => EMPATHY_CLAUSE_RE.test(rest) && !hasAnswerForce(rest) && !LABEL_CONTEXT_RE.test(rest) && !hasDuration(rest) && !hasClockTime(rest);
// (f) off-topic scheduling / billing with no answer force and no label word, clause by clause
const isOffTopicScheduling = (sentence) => {
  const clauses = clausesOf(sentence);
  return clauses.length > 0 && clauses.every((c) => !hasAnswerForce(c.clause)
    && isSchedulingClause(c.clause, { staffCarry: c.staffCarry, clock: hasClockTime(c.clause), sentence: c.sentence }));
};
// The content types, the first five being the ones the unknown-question path also trusts.
const CONTENT_SENTENCE_TYPES = [isCopyMarker, isSanctionedSentence, isCompanyLine, isCompanySentence, isDeferral, isSignoffSentence, isOffTopicScheduling];
const isAllowedSentence = (sentence) => {
  if (GREETING_ONLY_RE.test(sentence.trim())) return true;
  const info = {};
  const rest = peelFriendlyEnds(sentence, info);
  return rest === '' || CONTENT_SENTENCE_TYPES.some((allowed) => allowed(rest)) || (info.apology === true && isEmpathyClause(rest));
};

// A QUESTION sentence is exempt from the answer checks only when it genuinely asks the CUSTOMER for information: a
// wh-question, a "can / could / would you + request", "do / did / are / have you" or "is that the ...", with no
// answer force, clearance word, duration or label claim once friendly ends are peeled. Every other sentence ending in
// "?" ("Sure, why not?", "Go ahead?", "Wouldn't that be fine?", "Isn't it safe by now?") is judged like a statement.
const SCHEDULE_PROPOSAL_Q_RE = /^(?:is|does|would|how\s+about|what\s+about|can\s+we\s+do)\b/;
const CLARIFY_HEAD_RE = /^(?:(?:what|which|where|who|how\s+many|how\s+much)\b|when\s+(?:would|do|did|are)\s+you\b|(?:can|could|would|will)\s+you\s+(?:please\s+)?(?:send|share|tell|let|confirm|provide|give|text|call|email|reply)\b|(?:do|did|are|have)\s+you\b|is\s+(?:that|this)\s+the\b|is\s+there\b)/;
function isClarificationQuestion(sentence) {
  const q = peelFriendlyEnds(String(sentence || '').trim());
  // proposing an appointment time to the customer ("Is 2 PM ok?", "Does Tuesday 9-11 work?") asks for their answer
  if (SCHEDULE_PROPOSAL_Q_RE.test(q) && (hasClockTime(q) || SCHEDULE_WORD_RE.test(q)) && !LABEL_CONTEXT_RE.test(q) && !BEING_RE.test(q)) return true;
  return CLARIFY_HEAD_RE.test(q) && !hasAnswerForce(q) && !CLEARANCE_STATE_RE.test(q) && !hasDuration(q) && !hasClockTime(q) && !RAINFAST_RE.test(q) && !UNTIL_DRY_HOLD_RE.test(q);
}

// The non-question sentences of a stripped reply (stripLabelSentences output, sanctioned idiom swapped out),
// with the COMPANY FACTS rain line pre-marked for a rain question.
function replySentences(strippedText, asked) {
  const text = markCompanySentences(canonText(strippedText)).toLowerCase();
  const parts = (asked.includes('rain') ? text.replace(COMPANY_RAIN_LINE_RE, ' . companyline . ') : text).split(/([!?\n;]+|\.(?!\d))/);
  const out = [];
  for (let i = 0; i < parts.length; i += 2) {
    const sentence = parts[i].trim();
    if (sentence && !(/\?/.test(parts[i + 1] || '') && isClarificationQuestion(sentence))) out.push(sentence);
  }
  return out;
}

/**
 * True when a label question was asked (`asked` from askedLabelKinds) and the stripped reply holds a
 * sentence that is not an allowed type. With `asked` === null (the question is unknown: no snapshot, no
 * stored inbound) only an answer-shaped sentence that is not a hand-off / sanctioned / company line is held.
 */
function answersAskedLabelQuestion(strippedText, asked) {
  if (overCap(strippedText, MAX_REPLY_CHARS)) return true;
  if (asked === null) {
    return replySentences(strippedText, ['rain']).some((sentence) => hasAnswerForce(sentence.replace(WAIT_ALLOWED_RE, ' ')) && !CONTENT_SENTENCE_TYPES.slice(0, 5).some((allowed) => allowed(peelFriendlyEnds(sentence))));
  }
  if (!Array.isArray(asked) || !asked.length) return false;
  const sentences = replySentences(strippedText, asked);
  if (sentences.some((sentence) => !isAllowedSentence(sentence))) return true;
  return copiesDoNotAnswerAskedKinds(sentences, asked);
}

// A copy answers only the kind it is: with any copy in the reply, every ASKED kind (reentry / rain) needs a copy of that kind,
// or the reply must contain an approved hand-off (other kinds' copies may then stand, but never as the answer).
const COPY_KIND_MARKERS = { reentry: 'labelsentencereentry', rain: 'labelsentencerainfast' };
function copiesDoNotAnswerAskedKinds(sentences, asked) {
  const present = new Set(sentences.filter(isCopyMarker));
  if (!present.size) return false;
  const missing = asked.filter((kind) => COPY_KIND_MARKERS[kind] && !present.has(COPY_KIND_MARKERS[kind]));
  return missing.length > 0 && !sentences.some((sentence) => isDeferral(peelFriendlyEnds(sentence)));
}

/** True when `body` claims label timing beyond the sentences of `sectionText` (its own copies, verbatim, are fine), or answers a label question in `asked` without one. */
// A hand-off carries the follow-up deadline the real-answers prompt requires ("... within the hour", "... by 9 AM this
// morning", "... by 9 AM tomorrow morning" - the exact SLA_PHRASES sms-followup-sla owns). The phrase is a trailing modifier
// of a hand-off / confirm clause ONLY: it is peeled off that sentence before the guards read it (so its duration or clock is
// never read as a label time), and never makes any other sentence pass ("Go ahead within the hour." keeps the phrase and is held).
function stripHandoffDeadlines(text) {
  if (overCap(text, MAX_REPLY_CHARS)) return String(text || '');
  const SLA_PHRASES = slaPhrases();
  return String(text || '').split(/([.!?\n]+)/).map((piece, i) => {
    if (i % 2) return piece;
    const lower = piece.trim().toLowerCase();
    const phrase = SLA_PHRASES.find((p) => lower.endsWith(p.toLowerCase()));
    if (!phrase) return piece;
    // (the base keeps its own case: a lowercased sentence would stop the copy before it from being a complete copy)
    const base = canonText(piece).replace(new RegExp(`[\\s,;-]*(?:and\\s+)?${escapeRegex(phrase)}$`, 'i'), '').trim();
    return isHandoffBase(base.toLowerCase()) ? ` ${base}` : piece;
  }).join('');
}
const isHandoffBase = (base) => isDeferral(peelFriendlyEnds(base)) || /^(?:.*\s)?sanctioned_idiom\b[^.]*\bconfirms?\s+(?:the\s+|your\s+)?timing$/.test(base);

function replyClaimsUngroundedLabelTiming(body, sectionText, asked = []) {
  if (overCap(body, MAX_REPLY_CHARS)) return true;
  const stripped = stripLabelSentences(stripHandoffDeadlines(sanctionSafeOnceDry(body)), sectionText);
  return hasUngroundedLabelClaim(stripped) || answersAskedLabelQuestion(stripped, asked);
}

// ---- Send-time recheck ---------------------------------------------------
// What a decision persists (input_snapshot.label_facts_snapshot) when its
// final reply copies a LABEL FACTS sentence: which customer and visit the
// figures came from and exactly which sentences went out.
function labelFactsSnapshotFor({ labelFacts, reply, sectionText, asked = [] }) {
  const copied = labelSentencesCopiedIn(reply, sectionText).map((s) => s.text);
  if (!copied.length || !labelFacts) return null;
  return {
    customer_id: labelFacts.customerId ?? null,
    visit_date: labelFacts.serviceDate,
    record_ids: Array.isArray(labelFacts.recordIds) ? labelFacts.recordIds.map(String).sort() : [],
    sentences: copied,
    // which label kinds the customer asked (a snapshot without this key predates it: unknown)
    asked,
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
// The label kinds the customer asked, for the send-time answer check: the snapshot's own record, else the
// decision's stored inbound text, else unknown (null: only an answer-shaped reply is then held).
function askedForSend(snapshot, inbound) {
  if (snapshot && Array.isArray(snapshot.asked)) return snapshot.asked;
  return typeof inbound === 'string' || Array.isArray(inbound) ? askedLabelKinds(inbound) : null;
}

async function labelFactsSendBlockReason({ snapshot, body, inbound, conn = db, today } = {}) {
  const sentences = snapshot && Array.isArray(snapshot.sentences) ? snapshot.sentences : [];
  if (replyClaimsUngroundedLabelTiming(body, sentences.map((s) => `- ${s}`).join('\n'), askedForSend(snapshot, inbound))) return 'label_facts_unauthorized_claim';
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
// A COUNTED visit reference ("three visits ago", "2 treatments back", "a couple services before") is never the latest one.
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const WEEKDAY_SRC = '(?:sun|mon|tues?|wed|thu(?:rs?)?|fri|sat)(?:day|nesday|rsday|urday)?';
// A COUNTED weekday ("two Tuesdays ago", "2 Tuesdays ago", "a few Tuesdays ago", "a couple Tuesdays back", "the Tuesday before that", "every other Tuesday") is
// never one resolvable day: another visit, read before the bare-weekday rule.
const COUNTED_WEEKDAY_RE = new RegExp(`\\b(?:(?:\\d{1,2}|one|two|three|four|five|six|seven|eight|a\\s+few|a\\s+couple(?:\\s+of)?|several|some|many|a\\s+number\\s+of)\\s+${WEEKDAY_SRC}s\\s+(?:ago|back|before|earlier|prior)|the\\s+${WEEKDAY_SRC}\\s+before(?:\\s+(?:that|last|then))?|(?:every\\s+)?other\\s+${WEEKDAY_SRC}s?|${WEEKDAY_SRC}s\\s+(?:ago|back))\\b`, 'g');
const QUALIFIED_WEEKDAY_RE = new RegExp(`\\b(?:(?:next|this|coming|following|upcoming|every|each|last|past|previous)\\s+${WEEKDAY_SRC}|${WEEKDAY_SRC}\\s+(?:after\\s+next|before\\s+last))\\b`, 'g');
const WEEKDAY_ABBR_RE = /\b(sun|mon|tues?|wed|thu(?:rs?)?|fri|sat)(?:day|nesday|rsday|urday)?s?\b/g;
const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const FUTURE_VISIT_RE = /\b(?:tomorrow|tonight|upcoming|scheduled|next\s+(?:visit|treatment|service|spray|spraying|application|time|week|month|appointment|round|one|apt)|your\s+next|this\s+(?:coming|upcoming)|when\s+(?:you|y'?all|ya|the\s+(?:tech|technician|guy|man|team)|he|she|they|we|adam)\s+(?:come|comes|coming|get|gets|getting|are|is|arrive|arrives|show|swing|stop|spray|treat|do)|(?:coming|swinging|stopping)\s+(?:out|by)|before\s+(?:you|the\s+(?:tech|technician))\s+(?:come|comes|arrive)|will\s+(?:be\s+)?(?:spray|treat|apply)\w*|going\s+to\s+(?:spray|treat|apply)|plan(?:ning)?\s+to\s+(?:spray|treat|apply)|in\s+(?:a\s+)?(?:few|couple|\d+)\s+(?:days|weeks)|later\s+this)\b/;
const OLDER_VISIT_RE = /\b(?:(?:(?:the\s+)?(?:very\s+)?(?:first|initial|original|second|third|fourth|fifth|(?<![\d/-])[1-5](?:st|nd|rd|th))|last[-\s]but[-\s]one)\s+(?:\w+\s+)?(?:treatment|service|visit|application|spray|spraying|round|appointment|one)|the\s+one\s+before|(?:treatment|service|visit|application|spray|spraying|one|time)\s+before\s+(?:that|last)|previous|prior|earlier(?!\s+(?:today|this\s+(?:morning|afternoon|evening))\b)|before\s+that|last\s+(?:week|month|year|quarter|spring|summer|fall|winter)|(?:weeks?|months?|years?)\s+ago|a\s+while\s+(?:ago|back)|the\s+(?:other|first)\s+time|(?:\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|(?:a\s+)?few|(?:a\s+)?couple(?:\s+of)?|several|some|many|a\s+number\s+of)\s+(?:visits?|services?|treatments?|applications?|sprays?|sprayings?|rounds?|appointments?)\s+(?:ago|back|before|earlier(?!\s+(?:today|this\s+(?:morning|afternoon|evening))\b)|prior)|second\s+to\s+last)\b/;

function isoAddDays(iso, days) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

const YESTERDAY_RE = /\byesterday\b/g;
// Same-day references ("today", "this morning", "earlier today", "just now", "a few hours ago") mean the ET date `today`.
const SAME_DAY_RE = /\btoday(?:'s)?\b|\bthis\s+(?:morning|afternoon|evening)\b|\bjust\s+now\b|\b(?:an?|one|two|three|four|five|six|\d{1,2}|a\s+few|a\s+couple(?:\s+of)?|several|some)\s+(?:hours?|hrs?|minutes?|mins?)\s+ago\b/g;
// Compound relatives come BEFORE the bare "yesterday": "the day before yesterday" is two days ago; "the other day", "a couple / few days ago",
// "a day or two ago" and "night before last" are not one resolvable day, so they always name another visit.
const DAY_BEFORE_YESTERDAY_RE = /\b(?:the\s+)?day\s+before\s+(?:yesterday|last)\b/g;
const NIGHT_BEFORE_LAST_RE = /\b(?:the\s+)?night\s+before\s+(?:last|yesterday)\b|(?<!\bday\s+)\bbefore\s+yesterday\b|\bthe\s+other\s+(?:day|night)\b|\b(?:a\s+)?(?:couple|few|several|some|many)(?:\s+of)?\s+(?:days?|nights?)\s+(?:ago|back)\b|\b(?:a\s+)?(?:day|night)\s+or\s+(?:two|so)\s+(?:ago|back)\b/g;
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
// A hyphen / dot month-day with no year ("the 8-15 treatment", "on 8-15", "8.15 visit", "08-15"): a date only with a visit word after it or
// on / from / since / the / that / of / for before it, and never a time window ("8-10 AM"), a count ("2-3 hours", "1-2 days"), a price ("$8.15") or a
// fragment of a longer number. Resolved like the slash form (the visit's own year): the month and day must be the visit's.
const DASH_DAY_TAIL_SRC = "(?![\\d/.-])(?!\\s*(?:am|pm|a\\.m|p\\.m|o'?clock|hours?|hrs?|h\\b|days?|weeks?|wks?|months?|years?|yrs?|minutes?|mins?|times|x\\b|%|percent|to\\b|or\\b|-|gallons?|feet|ft|inches|lbs?|oz|pounds?|dollars?|bucks))";
const DASH_DATE_LEAD_RE = new RegExp(`(?<![\\d$#/.,:-])\\b(?:on|from|since|the|that|of|for)\\s+(\\d{1,2})[-.](\\d{1,2})${DASH_DAY_TAIL_SRC}`, 'g');
const DASH_DATE_TRAIL_RE = new RegExp(`(?<![\\d$#/.,:-])(\\d{1,2})[-.](\\d{1,2})(?![\\d/.-])\\s+(?:(?:pest|lawn|tree)\\s+)?(?:visit|treatment|service|spray|spraying|application|appointment|round)\\b`, 'g');
const validMonthDay = (m, d) => m >= 1 && m <= 12 && d >= 1 && d <= 31;
const ISO_DATE_RE = /(?<![\d-])(\d{4})-(\d{2})-(\d{2})(?![\d-])/g;
// A month or season named on its own ("the May treatment", "back in August", "last spring"). "may" is a verb
// as often as a month, so it is read from the original-case text and only as "May" with a visit word or a
// preposition/determiner before it. A season is ambiguous, so it always names another visit.
const MONTH_ALONE_RE = /\b(jan(?:uary)?|feb(?:ruary)?|march|apr(?:il)?|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/g;
const MAY_ALONE_RE = /\b(?:(?:in|back\s+in|since|during|last|that|the|this|from|early|late|mid)\s+May\b|May\s+(?:treatment|visit|service|spray|spraying|application|appointment)\b)/g;
// lowercase "may": a month only right before a visit noun, or after a preposition / determiner and NOT followed by a verb
// or pronoun ("that may be", "in may rain ...", "you may", "may i", "it may rain" stay verbs)
const MAY_LOWER_RE = /\b(?:(?:in|back\s+in|since|during|last|that|the|this|from|early|late|mid)\s+may\b(?!\s+(?:be|not|have|has|had|need|want|take|help|cause|affect|rain|also|still|just|even|include|require|depend|vary|change|make|get|go|come|see|use|apply|wash|hold|i|it|they|he|she|the|a|an|your|my|our)\b)|(?<!\b(?:you|we|i|they|he|she|it|who|that|which)\s+)may\s+(?:treatment|visit|service|spray|spraying|application|appointment)\b)/g;
const SEASON_RE = /\b(?:last|this|the|in|during|early|late|next|every|that|past|previous)\s+(?:spring|summer|fall|autumn|winter)(?:time)?\b/g;
// A year named on its own ("my 2025 treatment", "back in 2024", "the 2025 spray"): only with a preposition or
// determiner before it, or a visit word after it, so prices, house numbers, phone / zip fragments and "2025 hours"
// never count. "last year" is in OLDER_VISIT_RE. A year other than the visit's is another visit.
const STREET_WORD_SRC = 'st|street|ave|avenue|blvd|boulevard|rd|road|dr|drive|ln|lane|way|ct|court|cir|circle|pl|place|pkwy|hwy|trl|trail|sq|square|hours?|minutes?|days?|dollars?|percent|feet|ft|gallons?';
const YEAR_AFTER_WORD_RE = new RegExp(`\\b(?:in|back\\s+in|since|during|from|my|the|that|of|your|this|early|late)\\s+(20\\d{2})\\b(?![-/.,:]?\\d)(?!\\s+(?:\\w+\\s+)?(?:${STREET_WORD_SRC})\\b)`, 'g');
const YEAR_BEFORE_VISIT_RE = /(?<![\d$#/.,:-])\b(20\d{2})\s+(?:(?:pest|lawn|tree|spring|summer|fall|winter)\s+)?(?:treatment|visit|service|spray|spraying|application|appointment|round)\b/g;
const FUTURE_OR_OLDER_RE = new RegExp(`${FUTURE_VISIT_RE.source}|${OLDER_VISIT_RE.source}`, 'g');
const yearOf = (m, vy) => (m ? (m.length === 2 ? 2000 + Number(m) : Number(m)) : vy);
const monthNumber = (name) => MONTH_NAMES.findIndex((n) => n.startsWith(name.slice(0, 3))) + 1;
// True when month/day/year (year undefined = the visit's own) name a date other than the visit's.
const otherYmd = (v, month, day, year) => month !== v.month || day !== v.day || yearOf(year, v.year) !== v.year;
// Year captured after a month-name date: a four-digit year (group a) or an apostrophe'd two-digit one (group b).
const tailYear = (a, b) => a || b;

// The patterns whose meaning depends on the day the message was sent.
const RELATIVE_REFERENCES = [COUNTED_WEEKDAY_RE, YESTERDAY_RE, DAY_BEFORE_YESTERDAY_RE, NIGHT_BEFORE_LAST_RE, SAME_DAY_RE, DAYS_AGO_RE, QUALIFIED_WEEKDAY_RE, WEEKDAY_ABBR_RE];

// Every way a message can point at a visit: a pattern, and a resolver that says
// whether ONE match names a visit other than the facts' own. The message refers
// to another visit when any match of any pattern does. `v` = { date, today,
// weekday, sinceVisit, year, month, day }.
const VISIT_REFERENCES = [
  { re: FUTURE_OR_OLDER_RE, differs: () => true },
  // "yesterday" / "N days ago" resolve against today and must land on the visit date
  { re: DAY_BEFORE_YESTERDAY_RE, differs: (m, v) => isoAddDays(v.today, -2) !== v.date },
  { re: NIGHT_BEFORE_LAST_RE, differs: () => true },
  // (the "yesterday" of "the day before yesterday" is the compound's, read above)
  { re: YESTERDAY_RE, differs: (m, v) => !/\b(?:day|night)\s+before\s+$|\bbefore\s+$/.test(m.input.slice(0, m.index)) && isoAddDays(v.today, -1) !== v.date },
  { re: SAME_DAY_RE, differs: (m, v) => v.today !== v.date },
  { re: DAYS_AGO_RE, differs: (m, v) => isoAddDays(v.today, -(DAYS_AGO_WORDS[m[1]] ?? Number(m[1]))) !== v.date },
  // a QUALIFIED weekday ("next Friday", "this Friday", "this coming Friday", "the following Friday", "Friday after next",
  // "every Friday", "last Tuesday's", "past / previous Tuesday", "Tuesday before last") is future or ambiguous: another
  // visit. Only a bare weekday reaches the 6-day rule below.
  { re: COUNTED_WEEKDAY_RE, differs: () => true },
  { re: QUALIFIED_WEEKDAY_RE, differs: () => true },
  // a weekday name: only the visit's own weekday, and only when the visit was within the last 6 days
  {
    re: WEEKDAY_ABBR_RE,
    differs: (m, v) => {
      const name = WEEKDAYS.find((w) => w.startsWith(m[1].slice(0, 3)));
      // (a bare weekday that is TODAY's weekday, with the visit today, could as well mean a week ago: ambiguous)
      return !name || name !== v.weekday || v.sinceVisit < 1 || v.sinceVisit > 6;
    },
  },
  // an explicit date ("Sep 29", "September 29th", "9/29", "9/29/26") must be the visit's date
  { re: MONTH_ALONE_RE, differs: (m, v) => monthNumber(m[1]) !== v.month },
  { re: MAY_ALONE_RE, raw: true, differs: (m, v) => v.month !== 5 },
  { re: MAY_LOWER_RE, differs: (m, v) => v.month !== 5 },
  { re: SEASON_RE, differs: () => true },
  { re: YEAR_AFTER_WORD_RE, differs: (m, v) => Number(m[1]) !== v.year },
  { re: YEAR_BEFORE_VISIT_RE, differs: (m, v) => Number(m[1]) !== v.year },
  // (a year written after the date must match too: "September 29, 2025" is not the 2026 visit)
  { re: MONTH_DATE_RE, differs: (m, v) => otherYmd(v, monthNumber(m[1]), Number(m[2]), tailYear(m[3], m[4])) },
  { re: DAY_MONTH_DATE_RE, differs: (m, v) => otherYmd(v, monthNumber(m[2]), Number(m[1]), tailYear(m[3], m[4])) },
  { re: NUMERIC_DATE_RE, differs: (m, v) => otherYmd(v, Number(m[1]), Number(m[2]), m[3]) },
  { re: DASHED_DATE_RE, differs: (m, v) => otherYmd(v, Number(m[1]), Number(m[2]), m[3]) },
  // (an impossible month / day, like "13-45", is no date)
  { re: DASH_DATE_LEAD_RE, differs: (m, v) => validMonthDay(Number(m[1]), Number(m[2])) && otherYmd(v, Number(m[1]), Number(m[2])) },
  { re: DASH_DATE_TRAIL_RE, differs: (m, v) => validMonthDay(Number(m[1]), Number(m[2])) && otherYmd(v, Number(m[1]), Number(m[2])) },
  { re: ISO_DATE_RE, differs: (m, v) => otherYmd(v, Number(m[2]), Number(m[3]), m[1]) },
];

/**
 * The facts a draft may render for `inboundText`: null (none on file) when the
 * text points at another visit or is not in English (the sentences are English).
 */
function labelFactsForInbound(labelFacts, inbound, today = etDateString(), renderedTexts = [], inboundDates = []) {
  const renderedText = (r) => (r && typeof r === 'object' ? r.text : r);
  if (labelFacts && (inboundOverCap(inbound) || inboundOverCap(renderedTexts.map(renderedText)))) return null;
  if (!labelFacts) return null;
  const texts = Array.isArray(inbound) ? inbound : [inbound];
  // A historical row's relative words ("you sprayed yesterday", "this morning", "3 days ago", "Friday") mean the day the row was SENT, so a row
  // with a known timestamp resolves them against its own ET date and one with an unknown / unparseable timestamp (null) cannot be resolved at
  // all: a relative reference in it names another visit. The CURRENT message (index 0) and a row given without a date resolve against `today`.
  const rowToday = (date) => { const d = date instanceof Date ? date : new Date(date ?? NaN); return Number.isNaN(d.getTime()) ? null : etDateString(d); };
  // a short follow-up ("is it okay now?") is about whatever the thread was, so the thread's visit references count too;
  // and every earlier message the model is SHOWN (`renderedTexts`, any age) is read for a visit reference as well
  const refs = [
    ...(inboundIsElliptical(texts) ? texts : texts.slice(0, 1)).map((text, i) => ({ text, today: i > 0 && i < inboundDates.length ? rowToday(inboundDates[i]) : today })),
    ...renderedTexts.map((r) => (r && typeof r === 'object' ? { text: r.text, today: rowToday(r.date) } : { text: r, today })),
  ];
  const otherVisit = refs.some((r) => inboundRefersToOtherVisit(r.text, labelFacts.serviceDate, r.today));
  return otherVisit || looksNonEnglish(texts[0]) || !isVerifiablyEnglish(texts[0]) || isUnverifiedLanguageInbound(texts) ? null : labelFacts;
}

/**
 * True when the inbound message refers to a visit other than the facts'
 * visit (`visitDate`, YYYY-MM-DD, `today` the ET date). Errs toward true.
 */
function inboundRefersToOtherVisit(inboundText, visitDate, today = etDateString()) {
  if (overCap(inboundText, MAX_INBOUND_CHARS)) return true;
  const text = canonText(inboundText).toLowerCase();
  if (!text || !/^\d{4}-\d{2}-\d{2}$/.test(String(visitDate || ''))) return false;
  const visit = new Date(`${visitDate}T12:00:00Z`);
  const [year, month, day] = visitDate.split('-').map(Number);
  const rawText = canonText(inboundText);
  // `today` null = the message's own date is unknown: a relative reference (yesterday, today, this morning, N days / hours ago, a weekday)
  // cannot be resolved, so it names another visit; with none present nothing below reads `today`.
  if (today === null) {
    if (RELATIVE_REFERENCES.some((re) => [...text.matchAll(re)].length)) return true;
    today = visitDate;
  }
  const v = {
    date: visitDate, today, weekday: WEEKDAYS[visit.getUTCDay()], year, month, day,
    sinceVisit: Math.round((new Date(`${today}T12:00:00Z`) - visit) / 86400000),
  };
  return VISIT_REFERENCES.some((ref) => [...(ref.raw ? rawText : text).matchAll(ref.re)].some((m) => ref.differs(m, v)));
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
  stripHandoffDeadlines,
  askedLabelKinds,
  inboundIsElliptical,
  answersAskedLabelQuestion,
  looksNonEnglish,
  hasUnsupportedLanguage,
  isVerifiablyEnglish,
  isUnverifiedLanguageInbound,
  isEnglishInbound,
  nonEnglishTimingWords,
  labelFactsForInbound,
  parseReentryText,
};
