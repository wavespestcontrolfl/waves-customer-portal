'use strict';

/**
 * The lawn web report's "New sod" card (GATE_LAWN_NEW_SOD_REPORT_CARD, owner 2026-10-09).
 *
 * Decided ONCE, at completion, and frozen in structured_notes.lawnNewSod; the report renders only the frozen block
 * and never re-reads the live sod record (the office can change or clear it later):
 *
 *   freezeNewSodCard   inside the completion transaction: the sod-aware sheet context, rebuilt on the transaction,
 *                      says which hold classes kept a PLANNED line off this visit (lawn-sod-sheet.js plannedHeld).
 *                      Nothing held = nothing frozen. Secondary: a failed read freezes nothing and never fails
 *                      the visit.
 *   cardOf             the frozen block as the customer's words: a title and fixed sentences. The page prints
 *                      strings only and restates no rule.
 *   lawnNewSodPayload  the report payload key, only while the gate is live and a valid frozen block exists.
 *
 * Wording: plain and short; no label or law is cited; no large patch, fungicide, disease watch or discount.
 * Every date comes from the frozen block (computed by lawn-sod-holds.js on the visit's day).
 */

const logger = require('./logger');
const featureGates = require('../config/feature-gates');
const { monthLabel } = require('./service-report/lawn-report-v2');

const FREEZE_KEY = 'lawnNewSod';
const KIND_ORDER = Object.freeze(['fertilizer', 'weedKiller', 'preEmergent', 'dylox']);
// Kinds whose hold always ends on a date.
const DATED_KINDS = Object.freeze(['fertilizer', 'preEmergent', 'dylox']);
const YMD = /^\d{4}-\d{2}-\d{2}$/;

const COPY = Object.freeze({
  leadWhole: 'Today we held:',
  // The office's free-text name for the area is never printed: staff text does not reach the customer unscreened.
  leadPart: 'Today we held these on the new sod area:',
  restPart: 'The rest of the lawn was treated as planned.',
  swap: 'We used a fertilizer without pre-emergent in place of the usual bag.',
  close: 'Everything else ran as normal. Same visit, same price.',
});

const lowerId = (id) => String(id ?? '').toLowerCase();

function parseJsonObject(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try { return JSON.parse(value) || {}; } catch { return {}; }
}

// ── the words ───────────────────────────────────────────────────────────────

// 'Nov 2', or 'Oct 1, 2027' when the year is not the visit's year.
function dayWords(ymd, visitDay) {
  const label = monthLabel(ymd);
  return ymd.slice(0, 4) === visitDay.slice(0, 4) ? label : `${label}, ${ymd.slice(0, 4)}`;
}

const ROOTED_WORDS = 'the sod has been mowed twice and does not lift';

// One held class: what was held and when it resumes.
const HELD_WORDS = Object.freeze({
  fertilizer: (held, day) => `fertilizer until ${day(held.until)}. New sod needs 30 days to root.`,
  weedKiller: (held, day) => (held.until
    ? `weed spot spray until ${day(held.until)}, and until ${ROOTED_WORDS}.`
    : `weed spot spray until ${ROOTED_WORDS}.`),
  preEmergent: (held, day) => `pre-emergent until ${day(held.until)}, so the new runners can knit in.`,
  dylox: (held, day) => `Dylox until ${day(held.until)}, while the new sod settles in.`,
});

// The frozen block when it is whole and readable, else null (a damaged block prints no card).
function validFrozen(block) {
  if (!block || typeof block !== 'object' || block.v !== 1) return null;
  if (![block.sodLaidOn, block.visitDay].every((day) => typeof day === 'string' && YMD.test(day))) return null;
  const held = Array.isArray(block.held) ? block.held : [];
  const sound = held.length > 0 && held.every((entry) => entry && KIND_ORDER.includes(entry.kind)
    && (!DATED_KINDS.includes(entry.kind) || (typeof entry.until === 'string' && YMD.test(entry.until)))
    && (entry.until == null || (typeof entry.until === 'string' && YMD.test(entry.until))));
  return sound ? block : null;
}

/**
 * The card for a frozen block: `{ title, lead, items, rest, swap, close }` (strings; `rest` and `swap` are null when
 * they do not apply), or null when the block is missing or unreadable.
 */
function cardOf(frozenBlock) {
  const block = validFrozen(frozenBlock);
  if (!block) return null;
  const day = (ymd) => dayWords(ymd, block.visitDay);
  const part = block.covers === 'part';
  const items = KIND_ORDER.flatMap((kind) => block.held.filter((entry) => entry.kind === kind).slice(0, 1).map((entry) => HELD_WORDS[kind](entry, day)));
  return {
    title: `New sod (laid ${day(block.sodLaidOn)})`,
    lead: part ? COPY.leadPart : COPY.leadWhole,
    items,
    rest: part ? COPY.restPart : null,
    swap: block.swap ? COPY.swap : null,
    close: COPY.close,
  };
}

/** The frozen block off a record's structured notes, or null. */
function frozenNewSod(structuredNotes) {
  return validFrozen(parseJsonObject(structuredNotes)[FREEZE_KEY]);
}

/** The report payload key: only a lawn report, while the gate is live, from a valid frozen block. Absent = byte-identical payload. */
function lawnNewSodPayload({ serviceLine, structuredNotes } = {}) {
  if (serviceLine !== 'lawn' || !featureGates.lawnNewSodReportCardLive()) return {};
  const card = cardOf(parseJsonObject(structuredNotes)[FREEZE_KEY]);
  return card ? { lawnNewSod: card } : {};
}

// ── the freeze ──────────────────────────────────────────────────────────────

// What the visit held, from the sod-aware context rebuilt on `knex`, or null when nothing planned was held. Throws when
// the sod record could not be read (the caller's savepoint rolls back).
async function decideFrozen(knex, { svc, lawnFast, appliedProducts, allowGrouped }) {
  const ctx = await require('./lawn-fast-complete').buildLawnFastContext(svc.id, { knex, sodAware: true, allowGrouped });
  const sod = ctx && ctx.ok && ctx.eligible ? ctx.newSod : null;
  if (!sod) return null;
  if (sod.unavailable || !Array.isArray(sod.plannedHeld)) throw new Error('new sod record unavailable');
  // The card states what the technician's sheet held. The sheet echoes the sod record it showed (lawnFast.sod); a
  // record that changed since (date or coverage), or a sheet that sent no echo, freezes no card.
  const seen = lawnFast && lawnFast.sod;
  if (!seen || typeof seen !== 'object' || seen.laidOn !== sod.sodLaidOn || seen.covers !== sod.covers) return null;
  const applied = new Set((Array.isArray(appliedProducts) ? appliedProducts : []).map((row) => lowerId(row && row.product_id)).filter(Boolean));
  const part = sod.covers === 'part';
  // A whole-lawn class the technician applied anyway (the planned product, or another product of the same class from
  // the sheet's search) was not held.
  const appliedKinds = part ? new Set() : await require('./lawn-sod-sheet').appliedClassKinds(knex, appliedProducts);
  const held = sod.plannedHeld
    .filter((entry) => part || !(appliedKinds.has(entry.kind) || entry.productIds.some((id) => applied.has(id))))
    .map(({ kind, until, rootedCheck }) => ({ kind, until, rootedCheck }));
  if (!held.length) return null;
  const swapped = sod.swap && sod.swap.resolved === true && applied.has(lowerId(sod.swap.productId));
  return {
    v: 1,
    visitDay: ctx.visitDate,
    sodLaidOn: sod.sodLaidOn,
    covers: sod.covers,
    held,
    swap: swapped ? { name: sod.swap.name } : null,
  };
}

/**
 * Called inside the completion transaction, after the application rows are written. Freezes structured_notes.lawnNewSod
 * once (first writer wins; a resumed completion never re-freezes). Sets the in-memory `record.structured_notes` too, so
 * the later whole-object writes carry it. The work runs in a savepoint: a failed read rolls back to it and the visit
 * completes without the card. Never throws. Returns the frozen block or null.
 */
async function freezeNewSodCard(trx, { svc, record, lawnFast, isIncompleteVisit, resumingCommittedCompletion, appliedProducts, allowGrouped } = {}) {
  if (lawnFast == null || isIncompleteVisit || resumingCommittedCompletion || !featureGates.lawnNewSodReportCardLive()) return null;
  try {
    const frozen = await trx.transaction(async (sp) => {
      const block = await decideFrozen(sp, { svc, lawnFast, appliedProducts, allowGrouped });
      if (!block) return null;
      const written = await sp('service_records')
        .where({ id: record.id })
        .whereRaw(`(structured_notes::jsonb -> '${FREEZE_KEY}') IS NULL`)
        .update({ structured_notes: sp.raw("COALESCE(structured_notes::jsonb, '{}'::jsonb) || ?::jsonb", [JSON.stringify({ [FREEZE_KEY]: block })]) });
      return written ? block : null;
    });
    if (frozen) record.structured_notes = { ...parseJsonObject(record.structured_notes), [FREEZE_KEY]: frozen };
    return frozen;
  } catch (err) {
    // No driver message: it can echo SQL and bound values.
    logger.warn(`[lawn-sod-report-card] not frozen for visit ${svc && svc.id}: ${err && (err.code || err.name) || 'Error'}`);
    return null;
  }
}

module.exports = { FREEZE_KEY, COPY, cardOf, frozenNewSod, lawnNewSodPayload, freezeNewSodCard };
