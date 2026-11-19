/**
 * Morning open-blocks notification (owner 2026-11-18: "open gaps are times when a tech is on the clock, we need to
 * try and fill these with jobs ... so we can fill the jobs with organic leads, or leads from ads"; then "shadow, but i
 * want admin notifications").
 *
 * Daily 07:05 ET (scheduler.js) it reads the close-gaps records the 04:40 re-plan wrote (day_replan_plans.close_gaps,
 * ./close-gaps.js) and raises ONE admin notification: the open time in the next 7 days that a new job could fill
 * (blocks of an hour or more inside a technician's day, 8:00 AM to 5:00 PM, with no job), the biggest block, and what
 * re-timing booked jobs would free under the rules being measured. The full list is in the row's detail.
 * It sends nothing to a customer and changes no visit.
 *
 * Which tech-days count (the booking picker's own rules): an assignable technician who is not marked absent, on a day
 * that is not a blackout day. A planned day counts on any weekday the technician already works, Sunday included.
 * Tech-days the re-plan does not plan (no stop, or one: FEWER_THAN_2_STOPS) are counted here by the booking hour grid,
 * Monday to Saturday (the picker's default days): each whole hour from 8:00 AM to 5:00 PM that no row and no schedule
 * block holds. Drive is not counted on those days. A day with an untimed stop, or with two or more stops the re-plan
 * skipped (a stop in progress or with no location), is left out.
 *
 * One row per morning (dedupe key open-blocks:<date>; a second run the same morning dedupes onto it). The row from an
 * earlier morning closes when a new one is raised, and every open one closes on a morning with no open hour left.
 */
const db = require('../../models/db');
const logger = require('../logger');
const { raiseAdminAlert } = require('../admin-alert-compose');
const { closeAdminAlertKeys, openAdminAlertKeys } = require('../admin-alert-episodes');
const { etDateString, addETDays } = require('../../utils/datetime-et');
const { SELLABLE_MIN, SLOT_MIN } = require('./close-gaps');
const { _internals: replan } = require('./index');
const { DAY_OPEN, DAY_CLOSE } = require('../auto-dispatch/candidate-slots');
const { applyAssignable, absentTechDays } = require('../technician-eligibility');
const { NOT_A_ROUTE_STOP_STATUSES } = require('../stops-ahead');
const { ARRIVAL_WINDOW_MINUTES } = require('../../utils/sms-time-format');
const { INTERNAL_TEST_CUSTOMER_IDS } = require('../internal-test-customers');
const { liveServiceOrHold } = require('../scheduling/reservation-occupancy');

const KEY_PREFIX = 'open-blocks:';
const DAYS = 7;
const RUN_FRESH_HOURS = 20;
const MAX_DETAIL_BLOCKS = 30;

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Sat Nov 21" for a YYYY-MM-DD calendar date. */
function dayLabel(day) {
  const d = new Date(`${day}T12:00:00Z`);
  return `${WEEKDAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/** "11:35 AM" for minutes from midnight (ET wall clock). */
function clock(min) {
  const h = Math.floor(min / 60);
  const m = String(min % 60).padStart(2, '0');
  return `${h % 12 === 0 ? 12 : h % 12}:${m} ${h < 12 ? 'AM' : 'PM'}`;
}

/** "3 h 25 min", "2 h", "45 min". */
function span(min) {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  if (!h) return `${m} min`;
  return m ? `${h} h ${m} min` : `${h} h`;
}

const parse = (value) => (typeof value === 'string' ? JSON.parse(value) : value);

/**
 * The day as it stands after the 04:40 run: a day the run re-timed (apply_status 'applied'; the writer writes exactly
 * the plan's changes or skips the day) is its planned figures, any other day is the day as booked.
 */
const standing = (row, rec) => (row.apply_status === 'applied' && rec.packed ? rec.packed : rec.now);

/**
 * Extra sellable minutes one tech-day would gain from the measured P1 rule, 0 when none. P1's plan is p1.packed
 * (record v2); a v1 record measured P1 on the drive-best plan (packed).
 */
function freedMin(rec) {
  const fig = rec.p1 && rec.p1.wouldAccept ? (rec.p1.packed || rec.packed) : null;
  return fig && rec.now ? Math.max(0, fig.sellableMin - rec.now.sellableMin) : 0;
}

/** New jobs a block has room for (close-gaps SLOT_MIN: a 1-hour job and the drive it adds). */
const jobsIn = (b) => Math.floor(b.min / SLOT_MIN);

/** Runs of whole free hours as open blocks, by the booking hour grid (pure). */
function hourGridBlocks(heldHours) {
  const blocks = [];
  for (let h = DAY_OPEN / 60; h < DAY_CLOSE / 60; h += 1) {
    if (heldHours.has(h)) continue;
    const last = blocks.at(-1);
    if (last && last.start + last.min === h * 60) last.min += 60;
    else blocks.push({ kind: 'hours', start: h * 60, min: 60, before: null });
  }
  return blocks;
}

/** Hours a schedule block covers (any part of the hour). */
function blockHours(block) {
  const out = [];
  for (let h = Math.floor(block.startMin / 60); h * 60 < block.endMin; h += 1) out.push(h);
  return out;
}

/** The picker's rules for which tech-days count in the next 7 days: assignable technicians, absences, blackout days. */
async function eligibility(conn, now) {
  const from = etDateString(addETDays(now, 1));
  const to = etDateString(addETDays(now, DAYS));
  const { getBlackoutDates } = require('../scheduling/blackout-dates');
  const blackout = await getBlackoutDates(from, to);
  const techs = await applyAssignable(conn('technicians')).select('technicians.id');
  const techIds = techs.map((t) => String(t.id));
  const absent = techIds.length ? await absentTechDays(conn, { dateFrom: from, dateTo: to, technicianIds: techIds }) : new Set();
  return { from, to, blackout, techIds, absent };
}

const workable = (elig, day, techId) => !elig.blackout.has(day) && elig.techIds.includes(String(techId)) && !elig.absent.has(`${techId}:${day}`);

/**
 * Open blocks of the tech-days the re-plan did not plan, by the hour grid. `planned`: the `<day>|<tech>` keys the run
 * planned. Returns [{ day, technician_id, stops, blocks }].
 */
async function unplannedDays(conn, planned, elig) {
  const { _internals: findTime } = require('../scheduling/find-time');
  const days = findTime.enumerateDates(elig.from, elig.to);
  if (!elig.techIds.length || !days.length) return [];
  // Untimed rows are read too: a day with one is left out (it is not empty), and they hold no hour.
  const rows = await conn('scheduled_services').whereBetween('scheduled_date', [elig.from, elig.to])
    .whereNotIn('status', NOT_A_ROUTE_STOP_STATUSES)
    .where(liveServiceOrHold)
    .select('id', 'technician_id', conn.raw("to_char(scheduled_date, 'YYYY-MM-DD') as day"), 'window_start', 'window_end', 'estimated_duration_minutes');
  const blocks = await conn('tech_schedule_blocks').whereBetween('date', [elig.from, elig.to]).whereNot('block_type', 'available')
    .select('technician_id', conn.raw("to_char(date, 'YYYY-MM-DD') as day"), 'start_time', 'end_time');
  const techBlind = !require('../scheduling/occupancy').techScopedConfirmActive();
  const toMin = (v) => { const [h, m] = String(v).slice(0, 5).split(':').map(Number); return h * 60 + m; };
  const out = [];
  for (const day of days) {
    const dayRows = rows.filter((r) => r.day === day);
    for (const techId of elig.techIds) {
      if (planned.has(`${day}|${techId}`) || !workable(elig, day, techId)) continue;
      const own = dayRows.filter((r) => String(r.technician_id) === String(techId));
      if (own.length >= 2 || own.some((r) => !r.window_start)) continue;
      const held = new Set([...own.flatMap((r) => replan.rowHours(r)), ...replan.blockedHoursFor(dayRows, techId, techBlind)]);
      for (const b of blocks) {
        if (b.day !== day || (b.technician_id != null && String(b.technician_id) !== String(techId))) continue;
        for (const h of blockHours({ startMin: toMin(b.start_time), endMin: toMin(b.end_time) })) held.add(h);
      }
      out.push({ day, technician_id: techId, stops: own.length, blocks: hourGridBlocks(held) });
    }
  }
  return out;
}

/** The numbers for one morning from the latest run's rows and the unplanned days (pure). */
function summarize(rows, techNames, unplanned = []) {
  const blocks = [];
  let freed = 0;
  let replayed = 0;
  let pickDiffers = 0;
  for (const row of rows) {
    const rec = parse(row.close_gaps);
    if (!rec || !rec.now) continue;
    for (const b of standing(row, rec).blocks || []) {
      if (b.min >= SELLABLE_MIN) blocks.push({ day: row.day, techId: String(row.technician_id), tech: techNames.get(String(row.technician_id)) || null, ...b });
    }
    // An applied day already has the re-plan's hours; the measured rules' gains were counted from the day as booked.
    if (row.apply_status !== 'applied') freed += freedMin(rec);
    replayed += (rec.s1 || []).length;
    pickDiffers += (rec.s1 || []).filter((s) => s.differs).length;
  }
  for (const u of unplanned) {
    const tech = techNames.get(String(u.technician_id)) || null;
    for (const b of u.blocks) blocks.push({ day: u.day, techId: String(u.technician_id), tech, grid: true, stops: u.stops, ...b });
  }
  blocks.sort((a, b) => a.day.localeCompare(b.day) || a.start - b.start);
  const biggest = blocks.reduce((best, b) => (!best || b.min > best.min ? b : best), null);
  return { blocks, totalMin: blocks.reduce((n, b) => n + b.min, 0), slots: blocks.reduce((n, b) => n + jobsIn(b), 0), biggest, freedMin: freed, replayed, pickDiffers };
}

const gridNote = (b) => (b.grid ? (b.stops ? ', 1 stop that day, drive not counted' : ', no stops booked') : '');
const jobsNote = (b) => {
  const n = jobsIn(b);
  return n ? `, room for ${n} job${n === 1 ? '' : 's'}` : ', short of a job and its drive';
};
const blockText = (b) => `${dayLabel(b.day)}${b.tech ? `, ${b.tech}` : ''}: ${clock(b.start)} to ${clock(b.start + b.min)} (${span(b.min)}${jobsNote(b)}${gridNote(b)})`;

function alertSpec(sum) {
  const hours = Math.round(sum.totalMin / 60);
  const b = sum.biggest;
  const where = `Biggest block: ${dayLabel(b.day)}, ${clock(b.start)} to ${clock(b.start + b.min)}`;
  const why = sum.freedMin >= SELLABLE_MIN
    ? `${where}; re-timing booked jobs could free ${span(sum.freedMin)} more.`
    : `${where}.`;
  return {
    area: 'Schedule',
    action: `sell ${hours} open ${hours === 1 ? 'hour' : 'hours'} in the next 7 days`,
    why,
    severity: 'needs-you',
    link: `/admin/schedule?date=${encodeURIComponent(b.day)}`,
    subject: { type: 'check', id: 'open-blocks' },
    doneWhen: 'next_morning_replaces',
    who: 'person',
  };
}

function detailText(sum) {
  const lines = [
    `Room for ${sum.slots} new job${sum.slots === 1 ? '' : 's'}: each needs ${SLOT_MIN} free minutes (a 1-hour job and its drive).`,
    'Open blocks a new job could fill (an hour or more with no job, inside 8:00 AM to 5:00 PM; blackout days and days off left out, and Sundays unless stops are already booked):',
    ...sum.blocks.slice(0, MAX_DETAIL_BLOCKS).map((b) => `- ${blockText(b)}`),
  ];
  if (sum.blocks.length > MAX_DETAIL_BLOCKS) lines.push(`- and ${sum.blocks.length - MAX_DETAIL_BLOCKS} more.`);
  if (sum.matches?.length) {
    lines.push('', 'Open estimates with a route-checked hour');
    for (const m of sum.matches) {
      lines.push(`- ${m.name || 'Estimate'} (#${m.id.slice(0, 8)}), ${dayLabel(m.date)} at ${clock(m.start)}`
        + `${m.tech ? ` with ${m.tech}` : ''}. Forecast drive change ${m.addedDriveMin > 0 ? '+' : ''}${m.addedDriveMin} min.`);
    }
  }
  lines.push(
    '',
    'Measuring only (no visit changes): re-timing booked jobs to the front of the day under the new rules would free'
      + ` ${span(sum.freedMin)} more.`,
    `New bookings from the last 24 hours, replayed: ${sum.replayed}. A block-aware picker would pick a different hour for ${sum.pickDiffers}.`,
  );
  return lines.join('\n');
}

// Keep the best feasible match per estimate. The customer-visible arrival
// promise, stored service window and simulated finish must all fit inside the
// standing opening.
function matchingHour(offers, blocks) {
  const minute = t => Number(String(t).slice(0, 2)) * 60 + Number(String(t).slice(3, 5));
  const matches = [];
  for (const offer of offers) {
    if (!Number.isFinite(offer.driveMin) || !Number.isFinite(offer.addedDriveMin)) continue;
    const start = minute(offer.start);
    const end = minute(offer.end);
    const block = blocks.find(b => b.day === offer.date && b.techId === String(offer.techId)
      && b.start <= start && end > start && start + ARRIVAL_WINDOW_MINUTES <= b.start + b.min
      && end <= b.start + b.min && offer.finishMin <= b.start + b.min);
    if (block) matches.push({ offer, block, start });
  }
  const apiRank = offer => offer.apiRank ?? Number.MAX_SAFE_INTEGER;
  matches.sort((a, b) => a.offer.addedDriveMin - b.offer.addedDriveMin || a.offer.date.localeCompare(b.offer.date)
    || apiRank(a.offer) - apiRank(b.offer));
  if (!matches.length) return null;
  const { offer, block, start } = matches[0];
  return { date: offer.date, start, tech: block.tech, techId: block.techId,
    addedDriveMin: Math.round(offer.addedDriveMin) };
}

async function matchEstimates(conn, blocks, now) {
  const { offerableEstimateSlots } = require('../../routes/estimate-slots-public')._internals;
  const { OFFER_RANK } = require('./booking-fit');
  const candidatesQuery = conn('estimates').whereIn('status', ['viewed', 'sent']).whereNull('archived_at')
    .whereNotNull('customer_id').where(q => q.whereNull('expires_at').orWhere('expires_at', '>', now));
  if (INTERNAL_TEST_CUSTOMER_IDS.length) candidatesQuery.whereNotIn('customer_id', INTERNAL_TEST_CUSTOMER_IDS);
  const candidates = await candidatesQuery.orderBy('created_at', 'desc').orderBy('id').limit(20)
    .select('id', 'customer_id', 'customer_name');
  const dates = blocks.map(b => b.day).sort();
  const dispatchWindow = { dateFrom: dates[0], dateTo: dates.at(-1), dispatchCalendar: new Map() };
  const matches = [];
  for (const estimate of candidates) {
    try {
      const result = await offerableEstimateSlots(estimate.id, estimate.customer_id, { dispatchWindow });
      const match = matchingHour(await result?.[OFFER_RANK]?.() || [], blocks);
      if (match) matches.push({ ...match, id: String(estimate.id), name: estimate.customer_name });
      if (matches.length === 5) break;
    } catch (err) {
      if (err.code !== 'COORDS_NEED_GEOCODE') logger.warn(`[open-blocks] estimate match unavailable (${err.message})`);
    }
  }
  return matches;
}

async function techNamesFor(conn, ids) {
  if (!ids.length) return new Map();
  try {
    const rows = await conn('technicians').whereIn('id', ids).select('id', 'name');
    return new Map(rows.map((r) => [String(r.id), String(r.name || '').trim().split(/\s+/)[0] || null]));
  } catch (err) {
    logger.warn(`[open-blocks] technician names unread (${err.message}); blocks listed without them`);
    return new Map();
  }
}

/**
 * The latest fresh run's plan rows for tomorrow through 7 days out (a row whose measurement failed has close_gaps null:
 * its day counts as planned but adds no blocks), or null when no fresh run has close-gaps numbers (a week where every
 * tech-day has fewer than two stops writes no plan rows at all).
 */
async function latestRows(conn, now) {
  const since = new Date(now.getTime() - RUN_FRESH_HOURS * 3600 * 1000);
  const run = await conn('day_replan_plans').whereNotNull('close_gaps').where('created_at', '>=', since)
    .orderBy('created_at', 'desc').first('run_id');
  if (!run) return null;
  return conn('day_replan_plans').where({ run_id: run.run_id })
    .whereBetween('service_date', [etDateString(addETDays(now, 1)), etDateString(addETDays(now, DAYS))])
    .select('technician_id', conn.raw("to_char(service_date, 'YYYY-MM-DD') as day"), 'close_gaps', 'apply_status');
}

async function closeEarlier(conn, keepKey) {
  const keys = (await openAdminAlertKeys(conn, KEY_PREFIX)).filter((k) => k !== keepKey);
  return closeAdminAlertKeys(conn, keys, 'next_morning_replaces', { resolution: 'A newer morning\'s open blocks replaced it.' });
}

async function runOpenBlocksAlert({ conn = db, now = new Date() } = {}) {
  const fresh = await latestRows(conn, now);
  // No fresh run: the hour-grid days are still counted; the detail says the planned days are missing.
  if (!fresh) logger.warn('[open-blocks] no fresh re-plan run with close-gaps numbers; only days with no stop or one are counted');
  const rows = fresh || [];
  // The eligibility rules filter the planned days and find the unplanned ones. Unread: the planned days are listed as
  // planned (the night run's own technicians and days) and no unplanned day is added.
  let planned = rows;
  let unplanned = [];
  let rulesRead = true;
  try {
    const elig = await eligibility(conn, now);
    planned = rows.filter((r) => workable(elig, r.day, r.technician_id));
    unplanned = await unplannedDays(conn, new Set(rows.map((r) => `${r.day}|${r.technician_id}`)), elig);
  } catch (err) {
    rulesRead = false;
    logger.warn(`[open-blocks] day rules unread (${err.message}); only the planned days are listed, unfiltered`);
  }
  const names = await techNamesFor(conn, [...new Set([...planned, ...unplanned].map((r) => String(r.technician_id)))]);
  const sum = summarize(planned, names, unplanned);
  const key = `${KEY_PREFIX}${etDateString(now)}`;
  if (!sum.biggest) {
    // "No open hour" is a finding only when the day rules were read: else nothing was measured, so the earlier rows
    // stay open and the tick fails (pre-push audit, tune PR).
    if (!rulesRead) throw new Error('open-blocks day rules unread and no planned block; earlier rows left open');
    const closed = await closeEarlier(conn, null);
    return { status: 'no_open_hours', closed, ...(fresh ? {} : { noRun: true }) };
  }
  if (rulesRead) {
    try { sum.matches = await matchEstimates(conn, sum.blocks, now); }
    catch (err) { logger.warn(`[open-blocks] estimate matches unavailable (${err.message})`); }
  }
  const posted = await raiseAdminAlert('schedule', alertSpec(sum), {
    bell: true,
    dedupeKey: key,
    detail: fresh ? detailText(sum) : `${detailText(sum)}\nThe night re-plan left no numbers this morning, so days with two or more stops are not listed.`,
    metadata: { estimateMatches: (sum.matches || []).map(({ id, date, start, techId }) => ({ id, date, start, techId })),
      openMin: sum.totalMin, slots: sum.slots, freedMin: sum.freedMin, blocks: sum.blocks.length,
      replayed: sum.replayed, pickDiffers: sum.pickDiffers },
  });
  // notifyAdmin answers null when its write fails. Then no morning row exists: keep the earlier rows open and fail
  // the tick, so job health shows it (pre-push audit, tune PR). A dedupe hit answers the open row, with its id.
  if (!posted || !posted.id) throw new Error('open-blocks row not written; earlier rows left open');
  const closed = await closeEarlier(conn, key);
  return { status: 'raised', id: posted.id, deduped: !!posted.deduped, openMin: sum.totalMin, closed, ...(fresh ? {} : { noRun: true }) };
}

module.exports = {
  runOpenBlocksAlert,
  _internals: { matchingHour, summarize, alertSpec, detailText, dayLabel, clock, span, freedMin, standing,
    hourGridBlocks, unplannedDays, eligibility, workable, KEY_PREFIX },
};
