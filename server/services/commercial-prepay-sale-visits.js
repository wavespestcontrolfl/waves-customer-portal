'use strict';

const { dateOnlyString } = require('../utils/date-only');
const { etDateString } = require('../utils/datetime-et');

// Exact visits positively selected by this sale. Keep the selected row (even
// when it is a recurring child) for the promised date/window; resolving it to
// a series parent is setup-ownership work only.
async function confirmedCommercialSaleVisits(database, customerId, { adoptedExistingAppointmentId, bookedAppointmentIds = [] }) {
  const ids = [adoptedExistingAppointmentId, ...(Array.isArray(bookedAppointmentIds) ? bookedAppointmentIds : [])].filter(Boolean);
  if (!ids.length) return [];
  const visits = await database('scheduled_services').where({ customer_id: customerId })
    .whereIn('id', ids).whereNotIn('status', ['cancelled', 'canceled', 'rescheduled'])
    .whereNull('reservation_expires_at').orderBy('scheduled_date', 'asc');
  const { authoritativeServiceKey } = require('./secure-appointment-plans');
  const commercialVisits = [];
  for (const visit of visits) {
    if (await authoritativeServiceKey(database, visit) === 'commercial_rodent_bait') commercialVisits.push(visit);
  }
  return commercialVisits;
}

// A selected child identifies its series parent for the setup claim only.
// Both must belong to the customer, and the parent must still anchor a
// commercial rodent series that can consume the setup (including a cancelled
// parent whose selected child remains live).
async function confirmedCommercialRodentRoots(database, customerId, visits) {
  if (!visits.length) return [];
  const roots = await database('scheduled_services').where({ customer_id: customerId })
    .whereIn('id', visits.map((row) => row.recurring_parent_id || row.id))
    .whereNull('recurring_parent_id').whereNull('reservation_expires_at')
    .orderBy('scheduled_date', 'asc');
  const { authoritativeServiceKey, seriesCanStillConsume } = require('./secure-appointment-plans');
  const rodentRoots = [];
  for (const root of roots) {
    if (await authoritativeServiceKey(database, root) === 'commercial_rodent_bait'
      && await seriesCanStillConsume(database, root)) rodentRoots.push(root);
  }
  return rodentRoots;
}

// Resolve the occurrence and date together inside the acceptance transaction.
// The overlap guard and the eventual term use this same sale decision.
async function resolveCommercialPrepaySale(database, customerId, estimateData, opts = {}) {
  const { frozenRodentBaitSetupAmount, estimateRodentBaitIsCommercial } = require('./estimate-converter');
  if (!(frozenRodentBaitSetupAmount(estimateData) > 0)) return null;
  if (!estimateRodentBaitIsCommercial(estimateData)
    && !(await require('./secure-appointment-plans').customerHasCommercialChannel(database, customerId))) return null;
  const candidates = await confirmedCommercialSaleVisits(database, customerId, opts);
  const roots = await confirmedCommercialRodentRoots(database, customerId, candidates);
  const rootIds = new Set(roots.map((row) => String(row.id)));
  const visits = candidates.filter((row) => rootIds.has(String(row.recurring_parent_id || row.id)));
  const bookedIds = new Set((Array.isArray(opts.bookedAppointmentIds) ? opts.bookedAppointmentIds : []).map(String));
  const reservedRoots = visits.filter((row) => !row.recurring_parent_id && bookedIds.has(String(row.id)));
  const adopted = visits.filter((row) => opts.adoptedExistingAppointmentId != null
    && String(row.id) === String(opts.adoptedExistingAppointmentId));
  const selectedExisting = adopted.length || reservedRoots.length
    ? adopted : visits.filter((row) => row.recurring_parent_id);
  const first = selectedExisting[0] || reservedRoots[0];
  const termStart = dateOnlyString(first?.scheduled_date || opts.annualPrepayTermStart) || etDateString();
  return { visits, reservedRoots, selectedExisting, termStart };
}

module.exports = { resolveCommercialPrepaySale };
