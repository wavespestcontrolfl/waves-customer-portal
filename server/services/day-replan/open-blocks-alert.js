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
 * One row per morning (dedupe key open-blocks:<date>; a second run the same morning dedupes onto it). The row from an
 * earlier morning closes when a new one is raised, and every open one closes on a morning with no open hour left.
 */
const db = require('../../models/db');
const logger = require('../logger');
const { raiseAdminAlert } = require('../admin-alert-compose');
const { closeAdminAlertKeys, openAdminAlertKeys } = require('../admin-alert-episodes');
const { etDateString, addETDays } = require('../../utils/datetime-et');
const { SELLABLE_MIN } = require('./close-gaps');

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

/** The numbers for one morning from the latest run's rows (pure). */
function summarize(rows, techNames) {
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
  blocks.sort((a, b) => a.day.localeCompare(b.day) || a.start - b.start);
  const biggest = blocks.reduce((best, b) => (!best || b.min > best.min ? b : best), null);
  return { blocks, totalMin: blocks.reduce((n, b) => n + b.min, 0), biggest, freedMin: freed, replayed, pickDiffers };
}

const blockText = (b) => `${dayLabel(b.day)}${b.tech ? `, ${b.tech}` : ''}: ${clock(b.start)} to ${clock(b.start + b.min)} (${span(b.min)})`;

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
    'Open blocks a new job could fill (an hour or more with no job, inside 8:00 AM to 5:00 PM):',
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

/** The latest fresh run's close-gaps rows for tomorrow through 7 days out, or null when no fresh run has any. */
async function latestRows(conn, now) {
  const since = new Date(now.getTime() - RUN_FRESH_HOURS * 3600 * 1000);
  const run = await conn('day_replan_plans').whereNotNull('close_gaps').where('created_at', '>=', since)
    .orderBy('created_at', 'desc').first('run_id');
  if (!run) return null;
  return conn('day_replan_plans').where({ run_id: run.run_id }).whereNotNull('close_gaps')
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
  const names = await techNamesFor(conn, [...new Set(rows.map((r) => String(r.technician_id)))]);
  const sum = summarize(rows, names);
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

module.exports = { runOpenBlocksAlert, _internals: { summarize, alertSpec, detailText, dayLabel, clock, span, freedMin, standing, KEY_PREFIX } };
