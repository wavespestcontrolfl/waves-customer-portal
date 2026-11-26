'use strict';

// A later visit of a booked package (protocols audit 2026-11-26, item 4).
//
// A cockroach, flea or bed bug package can be booked up front as a short finite series: each later visit carries the first
// visit's name and key and is linked to it only by scheduled_services.recurring_parent_id, with recurring_ongoing = false on
// every row (the representation cockroach-report-v2.js cockroachProgramLineage reads for the customer report). Such a visit
// has no followup_source_service_id, so the card readers gave it the first-treatment card again, growth regulator included.
//
// isLaterPackageVisit answers "is this booked visit a later visit of such a package?" for every reader that picks a card (the
// job card, the tank search, the schedule panel's match and completion actions, the completion product defaults). They OR it
// into the follow-up flag they already pass to followupVisitMatch.
//
// The reader hands over only the visit's id and its two link columns. Everything else is read here, one way for all of them:
// the series (the first visit and every visit linked to it), each row's catalog identity (the booking snapshot, else the live
// catalog row, as on the job card) and its card.
//
// It is true only when all of these hold:
//   - the visit is finite (recurring_ongoing === false); an open-ended series uses the same link;
//   - the visit is a package service (packageStageOf): by its catalog key when it has one, whatever its name says ("Pest
//     Control Service" booked on the flea or cockroach catalog row), else by its name's program. A finite series of anything
//     else (a seasonal mosquito plan, a cancelled quarterly pest plan, an exterior roach knockdown, which has no follow-up)
//     repeats one card;
//   - an earlier visit of the series is finite, a package service of the same program, a treatment (not an inspection or a
//     scope review: the cards the program's follow-up rule replaces), dated before this visit, and not called off. With a
//     cancelled or skipped first visit, the next one is the first treatment in fact, and the one after it is a later visit
//     again. The series' first row is read the same way: moved to a date after a later row, it is the later visit.
// A read error is thrown, not answered: the caller's own error path shows no card or no defaults, never the first-treatment
// card on an unknown stage.

const { MATCH_RULES, matchServiceProtocol } = require('./protocol-matcher');

const PACKAGE_PROGRAMS = new Set(['cockroach', 'flea', 'bed_bug']);
// The catalog services sold as a package of treatments, and the program of each: the two-treatment set the booking side
// auto-books a visit 2 for (package-followup-booking.js), and the German cockroach cleanouts the cockroach visit contract lists
// beside them (visit-facts-contract.js). A known key outside this map is not a package, whatever its program: the exterior
// roach knockdown (pest_initial_palmetto_knockdown) is a cockroach card with no follow-up.
const PACKAGE_KEY_PROGRAMS = Object.freeze({
  cockroach_control: 'cockroach',
  vehicle_german_roach: 'cockroach',
  german_roach: 'cockroach',
  german_roach_initial: 'cockroach',
  flea_tick: 'flea',
  bed_bug_treatment: 'bed_bug',
});
const PACKAGE_SERVICE_KEYS = new Set(Object.keys(PACKAGE_KEY_PROGRAMS));
// A row booked before the catalog link has no key: its name decides, and the exterior knockdown card is still not a package.
const NO_FOLLOWUP_CARDS = new Set(['american_roach_exterior']);
// An earlier visit in one of these states happened or is still planned.
const VISIT_STANDS = new Set(['pending', 'confirmed', 'en_route', 'on_site', 'completed', 'complete']);

function dayOf(value) {
  if (!value) return '';
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

function keyOf(row) {
  return row.service_key_snapshot || row.catalog_service_key || null;
}

function cardOf(row, protocols) {
  return matchServiceProtocol(protocols, row.service_type, { serviceKey: keyOf(row) });
}

// { program, treatment } for a package service row, else null. `treatment`: whether the row's card is a treatment a later
// visit follows. With a key, the key names the program; the name's card is read only when it is a card of that program (a
// generic name, which the matcher reads as general pest, leaves the key's word: a treatment).
function packageStageOf(row, protocols) {
  const key = keyOf(row);
  const card = cardOf(row, protocols);
  if (key) {
    const program = PACKAGE_KEY_PROGRAMS[String(key)];
    if (!program) return null;
    return { program, treatment: card.programKey === program ? isTreatmentCard(program, card.reason) : true };
  }
  if (!PACKAGE_PROGRAMS.has(card.programKey) || NO_FOLLOWUP_CARDS.has(card.reason)) return null;
  return { program: card.programKey, treatment: isTreatmentCard(card.programKey, card.reason) };
}

// Whether a card of the program is a treatment a later visit follows: the cards its follow-up rule replaces (followupOf), the
// follow-up card itself, or any card when the rule lists none.
function isTreatmentCard(programKey, reason) {
  const followup = MATCH_RULES.find((rule) => rule.programKey === programKey && /_followup$/.test(rule.reason || ''));
  if (!followup) return false;
  return !followup.followupOf || followup.followupOf.includes(reason) || reason === followup.reason;
}

// visit: { id, recurring_parent_id, recurring_ongoing }.
async function isLaterPackageVisit(dbh, visit, { protocols = null } = {}) {
  if (!dbh || visit?.id == null || visit.recurring_ongoing !== false) return false;
  // The series is keyed by its first row: this visit's parent, or this visit itself when it is that first row.
  const seriesId = visit.recurring_parent_id || visit.id;
  const rows = await dbh('scheduled_services as ps')
    .leftJoin('services as sv', 'ps.service_id', 'sv.id')
    .where(function series() { this.where('ps.id', seriesId).orWhere('ps.recurring_parent_id', seriesId); })
    .select('ps.id', 'ps.status', 'ps.scheduled_date', 'ps.service_type', 'ps.recurring_ongoing', 'ps.service_key_snapshot', 'sv.service_key as catalog_service_key');
  const series = Array.isArray(rows) ? rows : [];
  if (series.length < 2) return false;
  const self = series.find((row) => String(row.id) === String(visit.id));
  if (!self || self.recurring_ongoing !== false) return false;
  const protocolSet = protocols || require('../config/protocols.json');
  const own = packageStageOf(self, protocolSet);
  if (!own) return false;
  const ownDay = dayOf(self.scheduled_date);
  if (!ownDay) return false;
  return series.some((row) => {
    if (String(row.id) === String(self.id) || row.recurring_ongoing !== false) return false;
    if (!VISIT_STANDS.has(String(row.status || '').toLowerCase())) return false;
    const day = dayOf(row.scheduled_date);
    if (!day || day >= ownDay) return false;
    const earlier = packageStageOf(row, protocolSet);
    return Boolean(earlier) && earlier.program === own.program && earlier.treatment;
  });
}

module.exports = { isLaterPackageVisit, PACKAGE_PROGRAMS, PACKAGE_SERVICE_KEYS };
