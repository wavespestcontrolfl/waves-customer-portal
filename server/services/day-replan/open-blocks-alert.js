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
const { SELLABLE_MIN } = require('./close-gaps');
const { _internals: replan } = require('./index');
const { DAY_OPEN, DAY_CLOSE } = require('../auto-dispatch/candidate-slots');
const { applyAssignable, absentTechDays } = require('../technician-eligibility');
const { NOT_A_ROUTE_STOP_STATUSES } = require('../stops-ahead');

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

/** Extra sellable minutes one tech-day would gain from a measured rule (the larger of P1 and P2), 0 when none. */
function freedMin(rec) {
  const base = rec.now ? rec.now.sellableMin : 0;
  const gains = [0];
  if (rec.p1 && rec.p1.wouldAccept && rec.packed) gains.push(rec.packed.sellableMin - base);
  const p2 = rec.p2;
  if (p2 && p2.packed && (p2.driveRuleAccepts || (p2.pack && p2.pack.wouldAccept))) gains.push(p2.packed.sellableMin - base);
  return Math.max(...gains);
}

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
    .where((q) => q.whereNull('reservation_expires_at').orWhereRaw('reservation_expires_at > NOW()'))
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
      if (b.min >= SELLABLE_MIN) blocks.push({ day: row.day, tech: techNames.get(String(row.technician_id)) || null, ...b });
    }
    // An applied day already has the re-plan's hours; the measured rules' gains were counted from the day as booked.
    if (row.apply_status !== 'applied') freed += freedMin(rec);
    replayed += (rec.s1 || []).length;
    pickDiffers += (rec.s1 || []).filter((s) => s.differs).length;
  }
  for (const u of unplanned) {
    const tech = techNames.get(String(u.technician_id)) || null;
    for (const b of u.blocks) blocks.push({ day: u.day, tech, grid: true, stops: u.stops, ...b });
  }
  blocks.sort((a, b) => a.day.localeCompare(b.day) || a.start - b.start);
  const biggest = blocks.reduce((best, b) => (!best || b.min > best.min ? b : best), null);
  return { blocks, totalMin: blocks.reduce((n, b) => n + b.min, 0), biggest, freedMin: freed, replayed, pickDiffers };
}

const gridNote = (b) => (b.grid ? (b.stops ? ', 1 stop that day, drive not counted' : ', no stops booked') : '');
const blockText = (b) => `${dayLabel(b.day)}${b.tech ? `, ${b.tech}` : ''}: ${clock(b.start)} to ${clock(b.start + b.min)} (${span(b.min)}${gridNote(b)})`;

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
    'Open blocks a new job could fill (an hour or more with no job, inside 8:00 AM to 5:00 PM; blackout days and days off left out, and Sundays unless stops are already booked):',
    ...sum.blocks.slice(0, MAX_DETAIL_BLOCKS).map((b) => `- ${blockText(b)}`),
  ];
  if (sum.blocks.length > MAX_DETAIL_BLOCKS) lines.push(`- and ${sum.blocks.length - MAX_DETAIL_BLOCKS} more.`);
  lines.push(
    '',
    'Measuring only (no visit changes): re-timing booked jobs to the front of the day under the new rules would free'
      + ` ${span(sum.freedMin)} more.`,
    `New bookings from the last 24 hours, replayed: ${sum.replayed}. A block-aware picker would pick a different hour for ${sum.pickDiffers}.`,
  );
  return lines.join('\n');
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
 * its day counts as planned but adds no blocks), or null when no fresh run has close-gaps numbers.
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
  const rows = await latestRows(conn, now);
  if (!rows) {
    logger.warn('[open-blocks] no fresh re-plan run with close-gaps numbers; nothing raised');
    return { status: 'no_run' };
  }
  // The eligibility rules filter the planned days and find the unplanned ones. Unread: the planned days are listed as
  // planned (the night run's own technicians and days) and no unplanned day is added.
  let planned = rows;
  let unplanned = [];
  try {
    const elig = await eligibility(conn, now);
    planned = rows.filter((r) => workable(elig, r.day, r.technician_id));
    unplanned = await unplannedDays(conn, new Set(rows.map((r) => `${r.day}|${r.technician_id}`)), elig);
  } catch (err) {
    logger.warn(`[open-blocks] day rules unread (${err.message}); only the planned days are listed, unfiltered`);
  }
  const names = await techNamesFor(conn, [...new Set([...planned, ...unplanned].map((r) => String(r.technician_id)))]);
  const sum = summarize(planned, names, unplanned);
  const key = `${KEY_PREFIX}${etDateString(now)}`;
  if (!sum.biggest) {
    const closed = await closeEarlier(conn, null);
    return { status: 'no_open_hours', closed };
  }
  const posted = await raiseAdminAlert('schedule', alertSpec(sum), {
    bell: true,
    dedupeKey: key,
    detail: detailText(sum),
    metadata: { openMin: sum.totalMin, freedMin: sum.freedMin, blocks: sum.blocks.length, replayed: sum.replayed, pickDiffers: sum.pickDiffers },
  });
  const closed = await closeEarlier(conn, key);
  return { status: 'raised', id: posted?.id || null, deduped: !!posted?.deduped, openMin: sum.totalMin, closed };
}

module.exports = {
  runOpenBlocksAlert,
  _internals: { summarize, alertSpec, detailText, dayLabel, clock, span, freedMin, standing, hourGridBlocks, unplannedDays, eligibility, workable, KEY_PREFIX },
};
