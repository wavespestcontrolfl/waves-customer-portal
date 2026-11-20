/**
 * The 07:05 notice's fill list (owner 2026-11-20 *b*; page "Ad Budget Rule v2", D2: the open estimates, leads and due
 * visits that fit each opening, in the 07:05 notice; owner 2026-11-20 *1a 2a*, page "Fill List Choices": which leads
 * and plan visits). For each open block the notice lists (open-blocks-alert.js), the work that fits it: open estimates,
 * leads and booked plan visits that could move up; the best fit of each kind, then the next best, least added drive
 * first (pickLines). A line gives the visit's length, the drive it adds and when it finishes; a plan visit's line also
 * names the day and hour the move would leave open. Staff decide whether to call the customer: nothing is held, booked,
 * moved or sent.
 *
 * The fit is the schedule gap tool's check (scheduling/gap-candidates.js analyzeGapCandidate): the staff arrival search
 * on the technician's day as booked, with the day's schedule blocks (lunch, time off), the customer's day and time
 * rules, the technician's capability for every service the visit performs, and the van home by the route check's day
 * end (route-check.js DISPATCH_DAY_END). Each candidate is a new stop on that day, tried at every place in the route as
 * the staff finder tries a new customer, and only on a day its own rules allow (`dayOpen`). A visit fits a block when it
 * runs inside it: from the van's arrival (or the window's start, when the van is early) to the visit's end on the
 * modeled route (its planned minutes on site). A line keeps the offered window start too (`windowStart`), the hour staff
 * would book.
 *
 * Open estimate (estimateGapCandidate): sent or viewed, not archived or expired, with a customer who is not an internal
 * test contact, no visit or live hold made from it, and a booking page that offers times and shows its slot picker
 * (routes/estimate-slots-public.js slotBrowseRefusal and pageSlotPicker, the two checks the texting AI and the daily
 * no-time-soon check ask). That leaves out guarantee-only renewals, commercial, parked, quote-required and invoice-only
 * estimates, and the ones whose page already shows an appointment. The visit is the one the booking page offers.
 *
 * Lead (owner *1a*, leadGapCandidate): new or contacted, from the last LEAD_DAYS days, not commercial, with a customer
 * record, no open estimate, no estimate or live visit since it came in, that asked for a Waves Assessment or an
 * inspection. It is listed as that visit (leadVisit), at the length the Leads screen's Schedule button books, at the
 * customer's stored location. Any other ask needs a price first.
 *
 * Plan visit (owner *2a*, movableVisits): a booked and placed recurring visit may move up to MOVE_UP_DAYS days
 * earlier. It is loaded and checked as the gap tool checks a saved visit (loadGapCandidate and analyzeGapCandidate: the
 * customer's rules, the series' other dates and due date, a paused or stopped plan, a visit locked from moves, a series'
 * first visit) on the days before its own, with its add-on services in the capability, plan hold and mowing-day rules
 * (planVisitCandidate). Left out: a visit whose 24-hour reminder will not go out (owner 2026-11-07 lock), and one that
 * shares its day with another live visit of the same customer (a move would split that visit). Every booked customer
 * was told a day: staff call first. A staff move of a plan visit moves its later visits too, as every staff date move
 * of a plan visit does (rebooker.js movesAsSeries, GATE_ADMIN_COLLECTIVE_MOVE; a lawn round one-off moves alone), and
 * the move screen says so before the move commits (SeriesMoveNotice.jsx). The list only suggests the move.
 *
 * Rain (owner 2026-11-19 D3: "the rain rules decide which jobs qualify"): with the rain note's NWS hours (`outlooks`,
 * rain-note.js; the 07:05 notice passes them), only rain-safe work runs in rain hours. A job that is not (rain-fit.js
 * rainFitFor other than 'prefer': spray, lawn, exclusion and other outside work, or work of no known class) takes its
 * least-drive fit in a block that is not in rain; with none, it is left out of that block and counted. Rain is the
 * booking rain rule (isWetWindow): a chance of RAIN_PCT or more in any hour from the booked row's start to
 * RAIN_AFTER_HOURS after its end (or after the modeled departure, when that is later), at the forecast point nearest
 * the job's stored location (rainArea). Unknown weather is kept: no forecast for the area, no wet hour but an hour
 * without a reading, or a day past the horizon. A rain-safe job (every service on RAIN_OK_KEYS: assessments,
 * inspections, rodent checks) stays and its line says it runs in rain hours. A job's services are named as the screen
 * that books or moves it names them (`rainServices`: an estimate as the estimate page does, a lead's visit by its
 * catalog key, a plan visit by its stored rows) and classified as those screens classify them (rain-fit.js
 * withCatalogKeys, then rainFitFor). They are read only for a job in an area with rain; a class that cannot be read
 * keeps the job out of rain hours.
 *
 * Nothing here is paid: no geocoding and no road times.
 */
const db = require('../../models/db');
const logger = require('../logger');
const { etDateString } = require('../../utils/datetime-et');
const { dateOnlyString } = require('../../utils/date-only');
const { isInternalTestContact } = require('../internal-test-customers');
const { isAssessmentServiceRow } = require('../assessment-booking');
const { dayStopsQuery } = require('../scheduling/day-stops');
const { QUALITY_EXCLUDED_STATUSES, dayStopSelect } = require('../scheduling/day-quality');
const {
  estimateGapCandidate, leadGapCandidate, loadGapCandidate, planFamilies, planHoldsFor, deactivatedFor, analyzeGapCandidate,
  catalogKeyById,
} = require('../scheduling/gap-candidates');
const { bookedVisitOrLiveHold } = require('../scheduling/reservation-occupancy');
const { LAWN_ROUNDS_9, roundsRowMoveIsOneOff } = require('../lawn-rounds');
const { clampDateToSeason } = require('../recurring-appointment-seeder');
const { loadTechStartPoints, homeFromMap } = require('../scheduling/tech-start-point');
const { dayDepartureMinutes } = require('../scheduling/departure-time');
const { shiftDateStr } = require('../auto-dispatch/dates');
const { isUnplacedDueDate } = require('../auto-dispatch/move-rules');
const mowingDays = require('../auto-dispatch/mowing-days');
const { rainFitFor, isWetWindow, withCatalogKeys, RAIN_PCT } = require('../scheduling/rain-fit');
const { ZONE_COORDS } = require('../scheduling/forecast-zones');
const { loadReminderOffIds } = require('../auto-dispatch/reminder-off');
const { NOT_A_ROUTE_STOP_STATUSES } = require('../stops-ahead');
const { DISPATCH_DAY_END } = require('./route-check');

// The newest open estimates checked each morning (9 were open on 2026-11-20).
const MAX_ESTIMATES = 40;
const OPEN_ESTIMATE_STATUSES = ['sent', 'viewed'];
// Leads (owner 2026-11-20 *1a*): the open ones from the last 30 days (7 asked for a look on 2026-11-20).
const LEAD_DAYS = 30;
const MAX_LEADS = 40;
const OPEN_LEAD_STATUSES = ['new', 'contacted'];
// Plan visits (owner 2026-11-20 *2a*): a booked visit moves up at most 7 days. The nearest ones first (67 plan visits
// were booked 2 to 14 days out on 2026-11-20).
const MOVE_UP_DAYS = 7;
const MAX_VISITS = 60;
// The lines under one block: its best fits.
const MAX_PER_BLOCK = 3;

const toMin = (hhmm) => {
  const [h, m] = String(hhmm).slice(0, 5).split(':').map(Number);
  return h * 60 + m;
};
// A visit's booked hour in minutes, or null for a date-only visit.
const startMin = (row) => (row.window_start ? toMin(row.window_start) : null);
const fullName = (row) => [row.first_name, row.last_name].map((p) => String(p || '').trim()).filter(Boolean).join(' ') || null;
const testContact = (row, customerId) => isInternalTestContact({ customerId, firstName: row.first_name, lastName: row.last_name,
  email: row.email, phone: row.phone });
// Live visit rows: not cancelled, skipped, a no-show or rescheduled (stops-ahead.js; a NULL status is a live row), and a
// booked visit or live hold as the scheduler counts them (reservation-occupancy.js: staff can book a held visit without
// clearing its expiry).
const liveRows = (query) => query.where((q) => q.whereNull('status').orWhereNotIn('status', NOT_A_ROUTE_STOP_STATUSES))
  .where(bookedVisitOrLiveHold);

/**
 * The newest MAX_ESTIMATES open estimates, each with its page picker ({ estimates: [{ estimate, picker }], unread }):
 * internal test contacts, the ones a visit or live hold was made from, and the ones whose page offers no times or shows
 * no picker are left out first, so they never take a place in the count. An estimate whose page lookup fails is left
 * off, counted as unread and logged. A failed read of the estimates or their visits throws.
 */
async function openEstimates(conn, now) {
  const rows = await conn('estimates').whereIn('status', OPEN_ESTIMATE_STATUSES).whereNull('archived_at').whereNotNull('customer_id')
    .where((q) => q.whereNull('expires_at').orWhere('expires_at', '>', now))
    .orderBy('created_at', 'desc').select('*');
  const open = rows.filter((row) => {
    const [firstName, ...rest] = String(row.customer_name || '').trim().split(/\s+/);
    return !isInternalTestContact({ customerId: row.customer_id, firstName, lastName: rest.join(' '), email: row.customer_email, phone: row.customer_phone });
  });
  if (!open.length) return { estimates: [], unread: 0 };
  const taken = await conn('scheduled_services').whereIn('source_estimate_id', open.map((row) => row.id)).whereNot('status', 'cancelled')
    .where((q) => q.whereNull('reservation_expires_at').orWhere('reservation_expires_at', '>', now))
    .pluck('source_estimate_id');
  const takenIds = new Set(taken.map(String));
  const page = require('../../routes/estimate-slots-public')._internals;
  const out = [];
  let unread = 0;
  for (const row of open) {
    if (out.length + unread >= MAX_ESTIMATES) break;
    if (takenIds.has(String(row.id))) continue;
    try {
      // The page's own answer: no times to offer (a refusal), or no picker (an appointment already scheduled, a quote
      // to give, invoice only); else its picker's service mode and default selection, which size the visit. Both
      // checks and the visit read this one row, so they judge one revision of the estimate.
      if (await page.slotBrowseRefusal(row)) continue;
      const picker = await page.pageSlotPicker(row.id, { row });
      if (picker) out.push({ estimate: row, picker });
    } catch (err) {
      unread += 1;
      logger.warn(`[fill-list] estimate ${row.id} unread (${err.message}); left off the list`);
    }
  }
  return { estimates: out, unread };
}

/**
 * The visit a lead asked for when it is a look staff can book now (owner 2026-11-20 *1a*), or null: the first part of
 * the lead's ask (service_interest; a multi-service ask joins its parts with " + ") that names a Waves Assessment, or an
 * inspection on the Leads screen's service list. `catalog`: the rows its Schedule button offers (active and sellable);
 * an inspection is a row the catalog files under 'inspection', named with or without its " Service" ending. A bare
 * "Inspection" is the assessment, as the Leads screen names it (utils/lead-service-display.js). The stored text alone
 * names the ask, as on the Leads screen (routes/admin-leads.js serviceDisplayFor): a staff edit changes the text but
 * keeps leads.service_key, so the key can name a service the lead no longer asks for. Pure.
 */
function leadVisit(serviceInterest, catalog) {
  const assessment = catalog.find(isAssessmentServiceRow) || null;
  const inspections = catalog.filter((row) => row.category === 'inspection' && !isAssessmentServiceRow(row));
  const parts = String(serviceInterest || '').split(/\s+\+\s+/).map((part) => part.trim().toLowerCase()).filter(Boolean);
  for (const part of parts) {
    if (/^waves assessment\b/.test(part) || part === 'inspection') {
      if (assessment) return assessment;
      continue;
    }
    const row = inspections.find((r) => [part, `${part} service`].includes(String(r.name || '').trim().toLowerCase()));
    if (row) return row;
  }
  return null;
}

/**
 * The open leads that asked for a look, newest first, at most MAX_LEADS ({ leads: [{ lead, visit }] }): new or
 * contacted, from the last LEAD_DAYS days, not deleted, not commercial, with a live customer record and no estimate on
 * the lead, that asked for a Waves Assessment or an inspection (leadVisit). Each customer once, by its newest such lead.
 * Left out first, so they never take a place: internal test contacts; a customer with an open estimate (sent or viewed,
 * not archived or expired: it is on the estimate list) or an estimate made since the lead came in, archived or not (the
 * quote happened); a customer with a live visit or hold on or after the day the lead came in (it is booked or was
 * served). An older closed estimate (an earlier job) and a cancelled, skipped, no-show or rescheduled visit never hide a
 * new ask. A failed read throws.
 */
async function openLeads(conn, now) {
  const since = new Date(now.getTime() - LEAD_DAYS * 24 * 3600 * 1000);
  const rows = await conn('leads').join('customers', 'customers.id', 'leads.customer_id')
    .whereNull('leads.deleted_at').whereNull('customers.deleted_at').whereIn('leads.status', OPEN_LEAD_STATUSES)
    .where('leads.created_at', '>=', since).whereNull('leads.estimate_id')
    .where((q) => q.whereNull('leads.is_commercial').orWhere('leads.is_commercial', false))
    .orderBy('leads.created_at', 'desc')
    .select('leads.id', 'leads.customer_id', 'leads.first_name', 'leads.last_name', 'leads.email', 'leads.phone',
      'leads.service_interest', 'leads.created_at', 'customers.latitude', 'customers.longitude');
  if (!rows.length) return { leads: [] };
  const { services: catalog } = await require('../service-library').getServices({ isActive: true, sellable: true, limit: 500 });
  const seen = new Set();
  const asked = [];
  for (const lead of rows) {
    const visit = leadVisit(lead.service_interest, catalog);
    if (!visit || seen.has(String(lead.customer_id)) || testContact(lead, lead.customer_id)) continue;
    seen.add(String(lead.customer_id));
    asked.push({ lead, visit });
  }
  if (!asked.length) return { leads: [] };
  const ids = [...seen];
  const estimates = await conn('estimates').whereIn('customer_id', ids).select('customer_id', 'status', 'created_at', 'expires_at', 'archived_at');
  const visits = await liveRows(conn('scheduled_services').whereIn('customer_id', ids)).select('customer_id', 'scheduled_date');
  const open = (e) => !e.archived_at && OPEN_ESTIMATE_STATUSES.includes(e.status) && (!e.expires_at || new Date(e.expires_at) > now);
  const quoted = (lead) => estimates.some((e) => String(e.customer_id) === String(lead.customer_id)
    && (open(e) || new Date(e.created_at) >= new Date(lead.created_at)));
  const cameIn = (lead) => etDateString(new Date(lead.created_at));
  const visited = (lead) => visits.some((v) => String(v.customer_id) === String(lead.customer_id) && dateOnlyString(v.scheduled_date) >= cameIn(lead));
  return { leads: asked.filter(({ lead }) => !quoted(lead) && !visited(lead)).slice(0, MAX_LEADS) };
}

/**
 * A booked plan visit as a gap candidate, or null when the gap tool refuses it (loadGapCandidate: locked or excluded, a
 * stopped or lapsed plan, an inactive customer) or when a move changed it between the scan and this read (its day, its
 * hour, or its placement: the line would name a day or hour the visit no longer holds). A new stop, open only on the
 * days up to MOVE_UP_DAYS before its own:
 * - a lawn round visit only where the move stays a one-off (lawn-rounds.js roundsRowMoveIsOneOff: inside its round and
 *   at most 7 days from its regular date; any other move shifts its series);
 * - a seasonal visit only in its season (recurring-appointment-seeder.js clampDateToSeason keeps the date: no seasonal
 *   mosquito visit from November to January).
 * The gap tool checks the capability of the visit's first service only, so the technician also needs it for each family
 * of a combined catalog row, the visit's own or an add-on's (pest + termite bait: each family classified by name,
 * technician-capabilities.js categoriesForServices), and for each add-on service (`addOns`: scheduled_service_addons
 * rows, as the rain pass reads them). The add-ons' plan holds and the mowing-day rule apply too, as for every service an
 * estimate's visit performs. A failed read throws.
 */
async function planVisitCandidate(conn, row, day, addOns) {
  const loaded = await loadGapCandidate(row.id, conn);
  if (loaded.unavailable) return null;
  if (dateOnlyString(loaded.service.scheduled_date) !== day || startMin(loaded.service) !== startMin(row)
    || isUnplacedDueDate(loaded.service)) return null;
  const extra = addOns.filter((a) => String(a.scheduled_service_id) === String(row.id))
    .map((a) => ({ service_type: a.service_name, service_id: a.service_id, service_key_snapshot: a.service_key_snapshot }));
  const extraFamilies = [];
  for (const addOn of extra) extraFamilies.push(await planFamilies(conn, addOn));
  const combined = [loaded.families, ...extraFamilies].filter((families) => families.length > 1).flat()
    .map((family) => ({ service_type: family.replace(/_/g, ' ') }));
  const checks = [...combined, ...extra];
  const deactivated = checks.length ? [...new Set([...loaded.deactivated, ...await deactivatedFor(conn, checks)])] : loaded.deactivated;
  const holds = extra.length ? [...loaded.holds, ...await planHoldsFor(conn, loaded.service.customer_id, extraFamilies.flat())] : loaded.holds;
  const mowing = mowingDays.unitRule(loaded.preferences, [loaded.service, ...extra]);
  const earliest = shiftDateStr(day, -MOVE_UP_DAYS);
  const pattern = loaded.service.recurring_pattern;
  const oneOff = pattern === LAWN_ROUNDS_9 ? (date) => roundsRowMoveIsOneOff(loaded.service, date) : () => true;
  return { ...loaded, deactivated, holds, prospective: true, label: loaded.service.service_type || row.service_type,
    // Its stored services (the row and its add-ons), as the move screens name them (rain-fit.js storedVisitServices): the
    // key snapshot, else the catalog key of its service id, else the name. Read only when the rain rule needs them.
    rainServices: () => Promise.all([loaded.service, ...extra].map(async (svc) => ({
      name: svc.service_type, serviceKey: svc.service_key_snapshot || await catalogKeyById(conn, svc.service_id) }))),
    dayOpen: (date) => date >= earliest && date < day && oneOff(date) && clampDateToSeason(pattern, date) === date
      && !mowingDays.blocksLive(date, mowing) };
}

/**
 * The booked plan visits that could move up into a listed block (owner 2026-11-20 *2a*), nearest first: recurring, not
 * a re-service, pending or confirmed, not a hold (a row that carries a hold timestamp is left out, as the gap tool
 * refuses it: loadGapCandidate; none was booked on 2026-11-20), booked after the first listed day and at most MOVE_UP_DAYS after the
 * last, placed (a due date with no time yet is the night dispatch's to place: move-rules.js isUnplacedDueDate), and not
 * an internal test contact's. Left out first, and counted: a visit whose 24-hour reminder will not go out (owner
 * 2026-11-07 lock: the senders' own rule, auto-dispatch/reminder-off.js), and one that shares its day with another live
 * visit of the same customer (a move would split that visit). The rest are checked as the gap tool checks a saved visit
 * (planVisitCandidate), at most MAX_VISITS, a refused one too; one whose own reads fail is counted as unread and logged.
 * A failed read of the visits, their reminders or their add-ons throws.
 */
async function movableVisits(conn, blocks) {
  const days = blocks.map((b) => b.day).sort();
  const from = shiftDateStr(days[0], 1);
  const to = shiftDateStr(days[days.length - 1], MOVE_UP_DAYS);
  const rows = (await conn('scheduled_services').join('customers', 'customers.id', 'scheduled_services.customer_id')
    .where('scheduled_services.is_recurring', true)
    .where((q) => q.whereNull('scheduled_services.is_callback').orWhere('scheduled_services.is_callback', false))
    .whereIn('scheduled_services.status', ['pending', 'confirmed']).whereNull('scheduled_services.reservation_expires_at')
    .whereBetween('scheduled_services.scheduled_date', [from, to])
    .orderBy('scheduled_services.scheduled_date').orderBy('scheduled_services.window_start').orderBy('scheduled_services.id')
    .select('scheduled_services.id', 'scheduled_services.customer_id', 'scheduled_services.property_id', 'scheduled_services.scheduled_date',
      'scheduled_services.window_start', 'scheduled_services.recurring_dispatch_due_date', 'scheduled_services.service_type',
      'customers.first_name', 'customers.last_name', 'customers.email', 'customers.phone'))
    .filter((row) => !isUnplacedDueDate(row) && !testContact(row, row.customer_id));
  const counts = { checked: 0, fitted: 0, remindersOff: 0, sharedDay: 0, unread: 0 };
  if (!rows.length) return { visits: [], counts };
  const ids = [...new Set(rows.map((row) => String(row.customer_id)))];
  const sameDay = await liveRows(conn('scheduled_services').whereIn('customer_id', ids).whereBetween('scheduled_date', [from, to]))
    .select('id', 'customer_id', 'scheduled_date');
  const onDay = new Map();
  for (const row of sameDay) {
    const key = `${row.customer_id}|${dateOnlyString(row.scheduled_date)}`;
    onDay.set(key, (onDay.get(key) || 0) + 1);
  }
  const off = await loadReminderOffIds(conn, rows);
  const addOns = await conn('scheduled_service_addons').whereIn('scheduled_service_id', rows.map((row) => row.id))
    .select('scheduled_service_id', 'service_id', 'service_name', 'service_key_snapshot');
  const visits = [];
  for (const row of rows) {
    const day = dateOnlyString(row.scheduled_date);
    if (off.has(String(row.id))) { counts.remindersOff += 1; continue; }
    if ((onDay.get(`${row.customer_id}|${day}`) || 0) > 1) { counts.sharedDay += 1; continue; }
    if (counts.checked >= MAX_VISITS) break;
    counts.checked += 1;
    try {
      const candidate = await planVisitCandidate(conn, row, day, addOns);
      if (candidate) visits.push({ row, day, candidate });
    } catch (err) {
      counts.unread += 1;
      logger.warn(`[fill-list] plan visit ${row.id} unread (${err.message}); left off the list`);
    }
  }
  return { visits, counts };
}

/**
 * The block's best fit that `keep` keeps, or null (routeFits come least added drive first): the visit runs inside the
 * block, from the van's arrival (or the window's start, when the van is early) to its end on the modeled route (the
 * window's length when the route gave no end). `length` is the visit as booked (its window: the catalog length);
 * `onSiteMin` is the route plan's minutes on site, which can be shorter (owner 2026-11-19: the visit row is 1 hour, the
 * plan keeps its own minutes).
 */
function fitInside(block, routeFits, keep = () => true) {
  for (const fit of routeFits) {
    const length = toMin(fit.windowEnd) - toMin(fit.windowStart);
    const startMin = Math.max(toMin(fit.windowStart), toMin(fit.estimatedArrival));
    const endMin = fit.estimatedDeparture ? toMin(fit.estimatedDeparture) : startMin + length;
    if (startMin >= block.start && endMin <= block.start + block.min) {
      const inside = { windowStart: String(fit.windowStart).slice(0, 5), startMin, endMin, length, onSiteMin: endMin - startMin,
        addedDriveMin: Math.max(0, Math.round(fit.addedDriveMinutes)) };
      if (keep(inside)) return inside;
    }
  }
  return null;
}

/**
 * The rain note's forecast area nearest a job's stored location (forecast-zones.js ZONE_COORDS, the day board's points),
 * or null without a location. Straight-line nearness on the map; no road times.
 */
function rainArea(service) {
  const lat = Number(service?.lat);
  const lng = Number(service?.lng);
  if (service?.lat == null || service?.lng == null || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const across = Math.cos((lat * Math.PI) / 180);
  let nearest = null;
  let best = Infinity;
  for (const [zone, point] of Object.entries(ZONE_COORDS)) {
    const d = (point.lat - lat) ** 2 + ((point.lng - lng) * across) ** 2;
    if (d < best) {
      nearest = zone;
      best = d;
    }
  }
  return nearest;
}

const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

/**
 * A job's rain verdict for one fit, by its rain rule (`rule`: its area's hours and its rainFitFor class, null when the
 * class could not be read): when the fit would run in rain, 'in' for rain-safe work ('prefer') and 'out' for any other
 * job; null otherwise (dry, unknown, or no rule). The hours are the booked row's, as the booking ranking reads a slot
 * (customer-rain-rank.js slotRainTierOf: its window), to the modeled departure when the work runs past the row's end.
 */
function rainVerdict(rule, day, fit, today) {
  if (!rule) return null;
  const end = Math.max(toMin(fit.windowStart) + fit.length, fit.endMin);
  const wet = isWetWindow(rule.hours, { date: day, start_time: fit.windowStart, end_time: hhmm(end) }, today);
  if (wet !== true) return null;
  return rule.fit === 'prefer' ? 'in' : 'out';
}

/**
 * Each job's rain rule (`{ hours, fit }`), for a job whose area's NWS hours hold rain (RAIN_PCT or more in some hour):
 * those hours and its services' rain class, read once as the screens that book or move it read one (rain-fit.js
 * withCatalogKeys; the rule has no gate of its own, so it always reads). A job in a dry area, or with no forecast, has
 * none. A class that cannot be read (its services, or one catalog identity: never its name alone) is null: that job
 * stays out of rain hours, and the others go on.
 */
async function rainRules(conn, candidates, outlooks) {
  const rules = new Map();
  if (!outlooks) return rules;
  for (const { kind, id, candidate } of candidates) {
    const hours = outlooks[rainArea(candidate.service)];
    if (!Array.isArray(hours) || !hours.some((h) => Number(h?.rainChance) >= RAIN_PCT)) continue;
    let fit = null;
    try {
      fit = rainFitFor(await withCatalogKeys(await candidate.rainServices(), conn, { gate: null, strict: true }));
    } catch (err) {
      logger.warn(`[fill-list] ${kind} ${id}: rain class unread (${err.message}); kept out of rain hours`);
    }
    rules.set(candidate, { hours, fit });
  }
  return rules;
}

const KINDS = ['estimate', 'lead', 'visit'];
const byFit = (a, b) => a.addedDriveMin - b.addedDriveMin || a.startMin - b.startMin || a.id.localeCompare(b.id);

/**
 * A block's lines, at most MAX_PER_BLOCK, least added drive first: the best fit of each kind (an open estimate, a lead,
 * a plan visit), then the next best fits of any kind (page "Fill List Choices": one way to fill the block per line,
 * "least added drive first"). So no kind hides another: the nearer open estimates never push out a lead or a plan visit.
 */
function pickLines(lines) {
  const ranked = [...lines].sort(byFit);
  const firsts = KINDS.map((kind) => ranked.find((line) => line.kind === kind)).filter(Boolean);
  return [...firsts, ...ranked.filter((line) => !firsts.includes(line))].slice(0, MAX_PER_BLOCK).sort(byFit);
}

// Each check is synchronous (252 on 2026-11-20's production data: 8 s of CPU in all, up to 0.15 s each; plan visits
// make 174 of them): the list yields between them so the server keeps answering requests while it is built.
const yieldToLoop = () => new Promise((resolve) => { setImmediate(resolve); });

/**
 * Every listed block's day as booked (the gap tool's statuses and columns) and its schedule blocks: every
 * tech_schedule_blocks row but 'available', a technician's own or everyone's (technician_id null), as the staff finder
 * reads them (arrival-route.js loadArrivalRouteContext). A stop is a booked visit or live hold as the staff finder's
 * saved route counts it (arrival-route.js loadSavedRouteContext, reservation-occupancy.js bookedVisitOrLiveHold): a
 * booked row that kept its hold timestamp is a booked stop.
 */
async function readDays(conn, blocks) {
  const out = new Map();
  for (const day of new Set(blocks.map((b) => b.day))) {
    const rows = await dayStopsQuery(conn, { dateStr: day, excludeStatuses: QUALITY_EXCLUDED_STATUSES, select: dayStopSelect(conn) })
      .where(bookedVisitOrLiveHold);
    const stops = rows.map((row) => (row.customer_id != null && row.reservation_expires_at != null ? { ...row, reservation_expires_at: null } : row));
    const scheduleBlocks = await conn('tech_schedule_blocks').where({ date: day }).whereNot('block_type', 'available')
      .select('id', 'technician_id', 'start_time', 'end_time', 'updated_at');
    out.set(day, { stops, scheduleBlocks });
  }
  return out;
}

/**
 * Every candidate the list checks: [{ kind, id, name, candidate, from? }] and the counts per kind. An estimate or a lead
 * with no stored location is counted, one whose own reads fail is counted as unread and logged.
 */
async function readCandidates(conn, blocks, now, estimates, result) {
  const candidates = [];
  for (const { estimate, picker } of estimates) {
    try {
      const candidate = await estimateGapCandidate(estimate, conn, picker);
      if (candidate.unavailable) result.noLocation += 1;
      else candidates.push({ kind: 'estimate', id: String(estimate.id), name: String(estimate.customer_name || '').trim() || null, candidate });
    } catch (err) {
      result.unread += 1;
      logger.warn(`[fill-list] estimate ${estimate.id} unread (${err.message}); left off the list`);
    }
  }
  const { leads } = await openLeads(conn, now);
  result.leads.checked = leads.length;
  for (const { lead, visit } of leads) {
    try {
      const candidate = await leadGapCandidate(lead, visit, conn);
      if (candidate.unavailable) result.leads.noLocation += 1;
      else candidates.push({ kind: 'lead', id: String(lead.id), name: fullName(lead), candidate });
    } catch (err) {
      result.leads.unread += 1;
      logger.warn(`[fill-list] lead ${lead.id} unread (${err.message}); left off the list`);
    }
  }
  const { visits, counts } = await movableVisits(conn, blocks);
  Object.assign(result.visits, counts);
  for (const { row, day, candidate } of visits) {
    candidates.push({ kind: 'visit', id: String(row.id), name: fullName(row), candidate,
      from: { day, start: startMin(row) } });
  }
  return candidates;
}

/**
 * The fill list for the listed blocks ({ day, techId, start, min }): byBlock[i] is block i's lines, best first, and
 * the counts the notice states: `checked`, `fitted`, `noLocation`, `unread` for the open estimates, `leads` and
 * `visits` for the others, and `rain` (`checked`: the rain rule ran; `leftOut`: the jobs left out of an opening in
 * rain). `outlooks`: the rain note's NWS hours by area, or null (no rain rule). A line in rain hours carries `inRain`.
 * Throws when the estimates, the leads, the plan visits or their reminders, a day's stops, the
 * start points or the departure time cannot be read. Built on the module database only: the page's checks and the
 * catalog read it (estimate-slots-public.js, service-library.js), and the 07:05 job passes it (scheduler.js
 * runOpenBlocksAlert()), so every read sees the same rows; another connection (a transaction) throws.
 */
async function fillList(conn, blocks, now, { outlooks = null } = {}) {
  if (conn !== db) throw new Error('the fill list reads the main database only');
  const { estimates, unread } = await openEstimates(conn, now);
  const result = { checked: estimates.length + unread, fitted: 0, noLocation: 0, unread,
    leads: { checked: 0, fitted: 0, noLocation: 0, unread: 0 },
    visits: { checked: 0, fitted: 0, remindersOff: 0, sharedDay: 0, unread: 0 },
    rain: { checked: !!outlooks, leftOut: 0 },
    byBlock: blocks.map(() => []) };
  if (!blocks.length) return result;
  const candidates = await readCandidates(conn, blocks, now, estimates, result);
  if (!candidates.length) return result;
  const days = await readDays(conn, blocks);
  const homes = await loadTechStartPoints(conn, [...new Set(blocks.map((b) => b.techId))]);
  const departure = await dayDepartureMinutes(conn);
  const today = etDateString(now);
  // One ask per technician-day and candidate; each of that day's blocks takes its best fit.
  const techDays = new Map();
  blocks.forEach((block, i) => {
    const key = `${block.day}|${block.techId}`;
    techDays.set(key, [...(techDays.get(key) || []), i]);
  });
  const fitted = { estimate: new Set(), lead: new Set(), visit: new Set() };
  const rainOf = await rainRules(conn, candidates, outlooks);
  const rainLeftOut = new Set();
  for (const indexes of techDays.values()) {
    const { day, techId } = blocks[indexes[0]];
    const { stops, scheduleBlocks } = days.get(day);
    const own = scheduleBlocks.filter((row) => row.technician_id == null || String(row.technician_id) === techId);
    for (const { kind, id, name, candidate, from } of candidates) {
      if (!candidate.dayOpen(day)) continue;
      const { routeFits = [] } = analyzeGapCandidate(candidate, stops, {
        date: day, technicianId: techId, now, today, closed: false, home: homeFromMap(homes, techId),
        modeledDepartureMinutes: departure, targetReturnMinutes: DISPATCH_DAY_END, blocks: own,
      });
      await yieldToLoop();
      const rule = rainOf.get(candidate);
      for (const i of indexes) {
        // The best fit the rain rule keeps: an outdoor job whose best fit runs in rain takes the next one in the block;
        // when every fit in the block runs in rain, the job is left out of it and counted.
        let rain = null;
        const fit = fitInside(blocks[i], routeFits, (inside) => (rain = rainVerdict(rule, day, inside, today)) !== 'out');
        if (!fit && rain === 'out') rainLeftOut.add(`${kind}:${id}`);
        if (!fit) continue;
        fitted[kind].add(id);
        result.byBlock[i].push({ kind, id, name, label: candidate.label, ...fit, ...(from ? { from } : {}),
          ...(rain === 'in' ? { inRain: true } : {}) });
      }
    }
  }
  result.byBlock = result.byBlock.map(pickLines);
  result.fitted = fitted.estimate.size;
  result.leads.fitted = fitted.lead.size;
  result.visits.fitted = fitted.visit.size;
  result.rain.leftOut = rainLeftOut.size;
  return result;
}

module.exports = {
  fillList, MAX_PER_BLOCK, MOVE_UP_DAYS,
  _internals: { openEstimates, openLeads, leadVisit, movableVisits, fitInside, pickLines, rainArea, rainVerdict, MAX_ESTIMATES, MAX_LEADS, MAX_VISITS, LEAD_DAYS },
};
