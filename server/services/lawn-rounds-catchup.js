'use strict';

// Lawn 9x rounds: the spring pre-emergent catch-up for a NEW customer (owner 2026-10-29, PR 4b of the rounds build).
//
// A rounds series joins the calendar where it finds it. A customer whose first visit lands in round 3 (Mar 15 to Apr 23) missed rounds 1
// and 2, the two rounds that carry the spring pre-emergent, and round 3's bag is a 24-0-11 feeding with no pre-emergent in it. When that
// first visit finds no pre-emergent (dithiopyr or prodiamine) on the lawn's application ledger since Jan 1 of its year, the plan adds ONE
// extra selected line: Dimension 2EW at 0.5 fl oz per 1,000 sq ft, hose, 1 gal carrier, the row of the March window. It has no nitrogen, so
// round 3 stays at 1.0 lb N. Round 4 reads May, where Tetrino is applied alone: no catch-up there, nor in any other round.
//
// This file holds the whole decision and the line's shape; the plan, the tank sheet, the brief and the report only call it. A catch-up
// that cannot be applied (the yearly cap, an unlinked or inactive product) is dropped with a warning and never blocks the visit.
const { LAWN_ROUNDS_9 } = require('./lawn-rounds');
const { roundStepForPlan } = require('./lawn-program');
const { etCalendarDayOf } = require('../utils/datetime-et');
const logger = require('./logger');

const CATCH_UP_ROUND = 3;
// The March window's pre-emergent row: the catch-up's own dose, carrier and gates.
const CATCH_UP_MONTH = 3;
const CATCH_UP_PRODUCT = /dimension\s+2ew/i;
const CATCH_UP_LABEL = 'Spring pre-emergent catch-up for a new customer';
const CATCH_UP_NOTE = 'This lawn has had no pre-emergent this year and this is its first visit, so it also gets the spring pre-emergent: Dimension 2EW, 0.5 fl oz per 1,000 sq ft, hose, 1 gal carrier. It adds no nitrogen.';
const CATCH_UP_NOTE_KEY = 'roundsCatchUp';
const CATCH_UP_UNAVAILABLE_CODE = 'lawn_rounds_catchup_unavailable';
// The pre-emergents the owner named for the check. A lawn with either applied this year already has its spring pre-emergent.
const CATCH_UP_HISTORY_INGREDIENTS = Object.freeze(['dithiopyr', 'prodiamine']);
const NOT_COUNTED_STATUSES = Object.freeze(['cancelled']);

// The March window's row the catch-up is: Dimension 2EW, a pre-emergent (never a bermuda removal row).
function isCatchUpRow(row) {
  if (!row || row.gates?.bermudaRemoval) return false;
  return row.role === 'pre_emergent' && (CATCH_UP_PRODUCT.test(String(row.product_name || '')) || CATCH_UP_PRODUCT.test(String(row.catalog_product_name || '')));
}

// A recipe line of the March step that is the catch-up's own: its primary line for Dimension 2EW.
const catchUpRecipeLine = (marchVisit) => String(marchVisit?.primary || '').split('\n').find((line) => CATCH_UP_PRODUCT.test(line.split(' — ')[0])) || null;

// Does this visit's round take the catch-up at all (before any database read)? True only for a rounds visit dated in round 3, while v13
// is live (the round map names v13 steps; roundStepForPlan).
function takesCatchUpRound(service) {
  return roundStepForPlan(service)?.round === CATCH_UP_ROUND && service?.recurring_pattern === LAWN_ROUNDS_9;
}

// Is this visit the first of its series: no EARLIER non-cancelled visit in the same series (the root row and every child that names it as
// its parent). `service` needs id and scheduled_date; recurring_parent_id is read when the row does not carry it.
async function isFirstVisitOfSeries(knex, service, day) {
  const parentId = 'recurring_parent_id' in service
    ? service.recurring_parent_id
    : (await knex('scheduled_services').where({ id: service.id }).first('recurring_parent_id'))?.recurring_parent_id;
  const rootId = parentId || service.id;
  const earlier = await knex('scheduled_services')
    .where(function inSeries() { this.where('id', rootId).orWhere('recurring_parent_id', rootId); })
    .whereNot('id', service.id)
    .whereNotIn('status', NOT_COUNTED_STATUSES)
    .where('scheduled_date', '<', day)
    .first('id');
  return !earlier;
}

// Has the lawn had a pre-emergent (dithiopyr or prodiamine) applied from Jan 1 of the visit's year through the visit's day? The ledger
// (property_application_history) rows of the treated property, this visit's own rows left out (a plan rebuilt after the catch-up was
// recorded must not read it as history). The same scope every limit reader uses (application-limits scopeHistoryToTreatment).
async function hasPreEmergentThisYear(knex, service, day) {
  const limits = require('./application-limits');
  const query = knex('property_application_history as pah')
    .leftJoin('products_catalog as pc', 'pah.product_id', 'pc.id')
    .where('pah.customer_id', service.customer_id)
    .where('pah.application_date', '>=', `${day.slice(0, 4)}-01-01`)
    .where('pah.application_date', '<=', day)
    .whereNull('pah.retracted_at')
    .where(function isPreEmergent() {
      for (const ingredient of CATCH_UP_HISTORY_INGREDIENTS) {
        const like = `%${ingredient}%`;
        this.orWhereRaw('pc.active_ingredient ILIKE ?', [like]).orWhereRaw('pah.active_ingredient ILIKE ?', [like]);
      }
    });
  limits.scopeHistoryToTreatment(query, knex, { propertyId: service.property_id || null, excludeScheduledServiceId: service.id }, 'pah');
  return !!(await query.first('pah.id'));
}

// The decision: does this visit get the catch-up line. Cheap checks first, so no other visit reads anything: a rounds visit in round 3,
// the first of its series, with no pre-emergent on the ledger this year. `strict` throws a failed read (the tank sheet's and the plan's
// strict callers); otherwise a failed read is "no catch-up" (a missed catch-up is caught by the office, an unwanted one is a wrong
// application).
async function catchUpWanted(knex, service, { strict = false } = {}) {
  if (!service?.id || !service.customer_id || !takesCatchUpRound(service)) return false;
  try {
    const day = etCalendarDayOf(service.scheduled_date);
    if (!day) return false;
    if (!(await isFirstVisitOfSeries(knex, service, day))) return false;
    return !(await hasPreEmergentThisYear(knex, service, day));
  } catch (err) {
    if (strict) throw err;
    // No driver message: it can echo SQL and bound values.
    logger.warn(`[lawn-rounds-catchup] decision unavailable for visit ${service.id}: ${err?.code || err?.name || 'Error'}`);
    return false;
  }
}

// The catch-up's recipe line, from the track's March step (the plan parses it as any other recipe line), marked and selected. [] when the
// visit did not qualify (`wanted` false) or the track's March step has no Dimension 2EW line.
function catchUpLines(track, parseLines, wanted = true) {
  const line = wanted ? catchUpRecipeLine(track?.visits?.find((visit) => visit.month === 'Mar')) : null;
  return line ? parseLines(line, 'conditional').map((item) => ({ ...item, roundsCatchUp: true })) : [];
}

// The round a plan, a sheet or a completion carries (roundStep): the same fields, plus `catchUp` while the visit carries the catch-up.
const roundStepFields = (roundStep, catchUp) => (catchUp ? { ...roundStep, catchUp: true } : roundStep);

// The plan's own field naming the catch-up, only while it is planned.
const planField = (kept) => (kept ? { roundsCatchUp: { active: true, label: CATCH_UP_LABEL, note: CATCH_UP_NOTE } } : {});

const isCatchUpItem = (item) => item?.roundsCatchUp === true;

// The line is selected: it is applied whenever the visit qualified.
const selectCatchUp = (items) => items.map((item) => (isCatchUpItem(item) && !item.selected ? { ...item, selected: true, selectionReason: 'rounds_catchup' } : item));

const unavailableWarning = (why) => ({
  code: CATCH_UP_UNAVAILABLE_CODE, severity: 'warning',
  message: `${CATCH_UP_LABEL}: not planned on this visit (${why}). The visit goes ahead without it; the office can book it as its own visit.`,
});

// Settle the line after the limits were read. `rowOf(item)` is the line's staged row, `cappedIds` the products at a hard limit. A line that
// has no active product, no staged row that calculates, or is capped leaves with a WARNING; the visit's other lines and the plan are never
// touched (the same shape as bermuda removal's settleStep, but never a block). Returns { items, warnings, dropped }.
function settleCatchUp(items, { rowOf, calculates, cappedIds = new Set() }) {
  const lines = items.filter(isCatchUpItem);
  if (!lines.length) return { items, warnings: [], dropped: [] };
  const dropped = [];
  const warnings = [];
  for (const item of lines) {
    const row = item.product ? rowOf(item) : null;
    let why = null;
    if (!item.product) why = 'the product is not in the catalog';
    else if (item.product.active === false) why = `${item.product.name} is inactive`;
    else if (!row) why = 'the protocol row is not linked to the product';
    else if (!calculates(row)) why = 'the protocol row has no rate';
    else if (cappedIds.has(String(item.product.id))) why = 'a yearly application limit is reached';
    if (why) { dropped.push(item); warnings.push(unavailableWarning(why)); }
  }
  return { items: items.filter((item) => !dropped.includes(item)), warnings, dropped };
}

// The catch-up is a hose pass at its own row's carrier (1 gal per 1,000 sq ft), whatever rig the round's spreader visit names; every other
// line keeps `fallback`.
const carrierFor = (item, row, fallback) => (isCatchUpItem(item) && Number(row?.carrierGalPer1000) > 0 ? Number(row.carrierGalPer1000) : fallback);

// The line's note, in the shape every reader of a line's gateNotes already shows (the plan panel, the tank sheet, the completion sheet).
const catchUpNotes = (item) => (isCatchUpItem(item) ? [{ key: CATCH_UP_NOTE_KEY, severity: 'note', text: `${CATCH_UP_LABEL}. ${CATCH_UP_NOTE}` }] : []);

// The label fields a plan or sheet line of the catch-up carries.
const catchUpLineFields = (item) => (isCatchUpItem(item) ? { roundsCatchUp: true, roundsCatchUpLabel: CATCH_UP_LABEL, roundsCatchUpNote: CATCH_UP_NOTE } : {});

module.exports = {
  CATCH_UP_ROUND, CATCH_UP_MONTH, CATCH_UP_LABEL, CATCH_UP_NOTE, CATCH_UP_UNAVAILABLE_CODE,
  isCatchUpRow, isCatchUpItem, takesCatchUpRound, catchUpWanted, catchUpLines, selectCatchUp, settleCatchUp, catchUpLineFields, catchUpNotes, roundStepFields, planField, carrierFor,
  isFirstVisitOfSeries, hasPreEmergentThisYear,
};
