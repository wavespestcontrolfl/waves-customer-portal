/**
 * The 07:05 notice's fill list (owner 2026-11-20 *b*; page "Ad Budget Rule v2", D2: the open estimates, leads and due
 * visits that fit each opening, in the 07:05 notice). This part lists open estimates. For each open block the notice
 * lists (open-blocks-alert.js), the open estimates whose first visit fits it, least added drive first. A line gives the
 * visit's length, the drive it adds and when it finishes. Staff decide whether to call the customer: nothing is held,
 * booked or sent.
 *
 * The fit is the schedule gap tool's check (scheduling/gap-candidates.js analyzeGapCandidate): the staff arrival search
 * on the technician's day as booked, with the day's schedule blocks (lunch, time off), the customer's day and time
 * rules, the technician's capability for every service the visit performs, and the van home by the route check's day
 * end (route-check.js DISPATCH_DAY_END). The estimate stands in as a new stop (estimateGapCandidate): the customer's
 * stored location, never geocoded, with the service and length its booking page offers (the page picker's service mode
 * and default selection), tried at every place in the route as the staff finder tries a new customer, and only on a day
 * the visit's own rules allow (the booking page's first-visit dates, the mowing day for every service it performs). A
 * visit fits a block when it runs inside it: from the van's arrival (or the window's start, when the van is early) to
 * the visit's end on the modeled route (its planned minutes on site). A line keeps the offered window start too
 * (`windowStart`), the hour staff would book.
 *
 * Open estimate: sent or viewed, not archived or expired, with a customer who is not an internal test contact, no visit
 * or live hold made from it, and a booking page that offers times and shows its slot picker
 * (routes/estimate-slots-public.js slotBrowseRefusal and pageSlotPicker, the two checks the texting AI and the daily
 * no-time-soon check ask). That leaves out guarantee-only renewals, commercial, parked, quote-required and invoice-only
 * estimates, and the ones whose page already shows an appointment. Nothing here is paid: no geocoding and no road times.
 */
const logger = require('../logger');
const { etDateString } = require('../../utils/datetime-et');
const { isInternalTestContact } = require('../internal-test-customers');
const { dayStopsQuery } = require('../scheduling/day-stops');
const { QUALITY_EXCLUDED_STATUSES, dayStopSelect } = require('../scheduling/day-quality');
const { estimateGapCandidate, analyzeGapCandidate } = require('../scheduling/gap-candidates');
const { loadTechStartPoints, homeFromMap } = require('../scheduling/tech-start-point');
const { dayDepartureMinutes } = require('../scheduling/departure-time');
const { DISPATCH_DAY_END } = require('./route-check');

// The newest open estimates checked each morning (9 were open on 2026-11-20).
const MAX_ESTIMATES = 40;
// The lines under one block: its best fits.
const MAX_PER_BLOCK = 3;

const toMin = (hhmm) => {
  const [h, m] = String(hhmm).slice(0, 5).split(':').map(Number);
  return h * 60 + m;
};

/**
 * The newest MAX_ESTIMATES open estimates, each with its page picker ({ estimates: [{ estimate, picker }], unread }):
 * internal test contacts, the ones a visit or live hold was made from, and the ones whose page offers no times or shows
 * no picker are left out first, so they never take a place in the count. An estimate whose page lookup fails is left
 * off, counted as unread and logged. A failed read of the estimates or their visits throws.
 */
async function openEstimates(conn, now) {
  const rows = await conn('estimates').whereIn('status', ['sent', 'viewed']).whereNull('archived_at').whereNotNull('customer_id')
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
      // to give, invoice only); else its picker's service mode and default selection, which size the visit.
      if (await page.slotBrowseRefusal(row)) continue;
      const picker = await page.pageSlotPicker(row.id);
      if (picker) out.push({ estimate: row, picker });
    } catch (err) {
      unread += 1;
      logger.warn(`[fill-list] estimate ${row.id} unread (${err.message}); left off the list`);
    }
  }
  return { estimates: out, unread };
}

/**
 * The block's best fit, or null (routeFits come least added drive first): the visit runs inside the block, from the
 * van's arrival (or the window's start, when the van is early) to its end on the modeled route (the window's length
 * when the route gave no end).
 */
function fitInside(block, routeFits) {
  for (const fit of routeFits) {
    const startMin = Math.max(toMin(fit.windowStart), toMin(fit.estimatedArrival));
    const endMin = fit.estimatedDeparture ? toMin(fit.estimatedDeparture) : startMin + toMin(fit.windowEnd) - toMin(fit.windowStart);
    if (startMin >= block.start && endMin <= block.start + block.min) {
      return { windowStart: String(fit.windowStart).slice(0, 5), startMin, endMin, length: endMin - startMin,
        addedDriveMin: Math.max(0, Math.round(fit.addedDriveMinutes)) };
    }
  }
  return null;
}

const byFit = (a, b) => a.addedDriveMin - b.addedDriveMin || a.startMin - b.startMin || a.estimateId.localeCompare(b.estimateId);

// Each check is synchronous (48 on 2026-11-20's production data, about 2 s in all, up to 0.1 s each): the list yields
// between them so the server keeps answering requests while it is built.
const yieldToLoop = () => new Promise((resolve) => { setImmediate(resolve); });

/**
 * Every listed block's day as booked (the gap tool's read: its statuses, columns and live holds) and its schedule
 * blocks: every tech_schedule_blocks row but 'available', a technician's own or everyone's (technician_id null), as
 * the staff finder reads them (arrival-route.js loadArrivalRouteContext).
 */
async function readDays(conn, blocks) {
  const out = new Map();
  for (const day of new Set(blocks.map((b) => b.day))) {
    const stops = await dayStopsQuery(conn, { dateStr: day, excludeStatuses: QUALITY_EXCLUDED_STATUSES, select: dayStopSelect(conn) })
      .whereRaw('(scheduled_services.reservation_expires_at IS NULL OR scheduled_services.reservation_expires_at > NOW())');
    const scheduleBlocks = await conn('tech_schedule_blocks').where({ date: day }).whereNot('block_type', 'available')
      .select('id', 'technician_id', 'start_time', 'end_time', 'updated_at');
    out.set(day, { stops, scheduleBlocks });
  }
  return out;
}

/**
 * The fill list for the listed blocks ({ day, techId, start, min }): byBlock[i] is block i's lines, best first, and
 * the counts the notice states. Throws when the estimates, a day's stops, the start points or the departure time cannot
 * be read. An estimate whose own reads fail is left off and counted as unread.
 */
async function fillList(conn, blocks, now) {
  const { estimates, unread } = await openEstimates(conn, now);
  const result = { checked: estimates.length + unread, fitted: 0, noLocation: 0, unread, byBlock: blocks.map(() => []) };
  const candidates = [];
  for (const { estimate, picker } of blocks.length ? estimates : []) {
    try {
      const candidate = await estimateGapCandidate(estimate, conn, picker);
      if (candidate.unavailable) result.noLocation += 1;
      else candidates.push({ estimate, candidate });
    } catch (err) {
      result.unread += 1;
      logger.warn(`[fill-list] estimate ${estimate.id} unread (${err.message}); left off the list`);
    }
  }
  if (!candidates.length) return result;
  const days = await readDays(conn, blocks);
  const homes = await loadTechStartPoints(conn, [...new Set(blocks.map((b) => b.techId))]);
  const departure = await dayDepartureMinutes(conn);
  const today = etDateString(now);
  // One ask per technician-day and estimate; each of that day's blocks takes its best fit.
  const techDays = new Map();
  blocks.forEach((block, i) => {
    const key = `${block.day}|${block.techId}`;
    techDays.set(key, [...(techDays.get(key) || []), i]);
  });
  const fitted = new Set();
  for (const indexes of techDays.values()) {
    const { day, techId } = blocks[indexes[0]];
    const { stops, scheduleBlocks } = days.get(day);
    const own = scheduleBlocks.filter((row) => row.technician_id == null || String(row.technician_id) === techId);
    for (const { estimate, candidate } of candidates) {
      if (!candidate.dayOpen(day)) continue;
      const { routeFits = [] } = analyzeGapCandidate(candidate, stops, {
        date: day, technicianId: techId, now, today, closed: false, home: homeFromMap(homes, techId),
        modeledDepartureMinutes: departure, targetReturnMinutes: DISPATCH_DAY_END, blocks: own,
      });
      await yieldToLoop();
      for (const i of indexes) {
        const fit = fitInside(blocks[i], routeFits);
        if (!fit) continue;
        fitted.add(String(estimate.id));
        result.byBlock[i].push({ estimateId: String(estimate.id), name: String(estimate.customer_name || '').trim() || null, label: candidate.label, ...fit });
      }
    }
  }
  for (const lines of result.byBlock) lines.sort(byFit).splice(MAX_PER_BLOCK);
  result.fitted = fitted.size;
  return result;
}

module.exports = { fillList, MAX_PER_BLOCK, _internals: { openEstimates, fitInside, MAX_ESTIMATES } };
