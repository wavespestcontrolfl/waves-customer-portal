'use strict';

// A later visit of a booked package (protocols audit 2026-11-26, item 4).
//
// A cockroach, flea or bed bug package can be booked up front as a short finite series: each later visit carries the first
// visit's name and key and is linked to it only by scheduled_services.recurring_parent_id, with recurring_ongoing = false on
// both rows (the representation cockroach-report-v2.js cockroachProgramLineage reads for the customer report). Such a visit
// has no followup_source_service_id, so the card readers gave it the first-treatment card again, growth regulator included.
//
// isLaterPackageVisit answers "is this booked visit a later visit of such a package?" for every reader that picks a card (the
// job card, the tank search, the schedule panel's match and completion actions, the completion product defaults). They OR it
// into the follow-up flag they already pass to followupVisitMatch.
//
// It is true only when all of these hold:
//   - the visit's program is one sold as a package (PACKAGE_PROGRAMS). A finite series of any other program (a seasonal
//     mosquito plan, a cancelled quarterly pest plan) repeats one card and is not read;
//   - the visit and its parent are both finite (recurring_ongoing === false); an open-ended series uses the same link;
//   - the parent is the same program, was not called off, and is dated before this visit. With a cancelled or skipped
//     first visit, this visit is the first treatment in fact.
// Any read error answers false: the visit keeps the card it has today.

const { matchServiceProtocol } = require('./protocol-matcher');

const PACKAGE_PROGRAMS = new Set(['cockroach', 'flea', 'bed_bug']);
// A first visit in one of these states happened or is still planned.
const PARENT_STANDS = new Set(['pending', 'confirmed', 'en_route', 'on_site', 'completed', 'complete']);

function programOf(serviceType, serviceKey) {
  return matchServiceProtocol(null, serviceType, { serviceKey: serviceKey || null })?.programKey || null;
}

function dayOf(value) {
  if (!value) return '';
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

// visit: { id?, service_type, service_key? | service_key_snapshot?, scheduled_date?, recurring_parent_id, recurring_ongoing }.
async function isLaterPackageVisit(dbh, visit) {
  const parentId = visit?.recurring_parent_id;
  if (!dbh || !parentId || visit.recurring_ongoing !== false) return false;
  if (visit.id != null && String(visit.id) === String(parentId)) return false;
  const program = programOf(visit.service_type, visit.service_key ?? visit.service_key_snapshot);
  if (!PACKAGE_PROGRAMS.has(program)) return false;
  try {
    const parent = await dbh('scheduled_services')
      .where({ id: parentId })
      .first('id', 'status', 'scheduled_date', 'service_type', 'service_key_snapshot', 'recurring_ongoing');
    if (!parent || parent.recurring_ongoing !== false) return false;
    if (!PARENT_STANDS.has(String(parent.status || '').toLowerCase())) return false;
    if (programOf(parent.service_type, parent.service_key_snapshot) !== program) return false;
    const [own, first] = [dayOf(visit.scheduled_date), dayOf(parent.scheduled_date)];
    return Boolean(own && first) && first < own;
  } catch {
    return false;
  }
}

module.exports = { isLaterPackageVisit, PACKAGE_PROGRAMS };
