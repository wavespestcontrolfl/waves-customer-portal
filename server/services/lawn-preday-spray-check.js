/**
 * Lawn pre-day spray check (lawn report rebuild P32). Staff-facing only.
 *
 * The 5:41 AM ET cron (and its hourly backstop through 3:41 PM) runs the job card's own spray check (buildSprayCheck)
 * on each of today's lawn visits' planned PRIMARY products, against the
 * Open-Meteo property forecast for the visit's arrival window. A hold on a
 * primary product writes ONE quiet `lawn_spray_hold` card to the Dispatch
 * Action Queue (dispatch_alerts) per visit per day: which product, why (the
 * measured numbers), and the plan's alternative for that step, else a move.
 *
 * What this does NOT do: ring the bell (no notifyAdmin), text or email a
 * customer, move or edit a visit, lock a visit row (an advisory sweep with a
 * FOR UPDATE on a visit made settlement fail with visit_busy), or add a rule
 * of its own to the spray check: limits come from the job card, and the
 * forecast's hourly probability feeds its existing rain rule. The card states
 * INCHES, never a percent chance, and a rain reason needs measured rain.
 *
 * Fail-open: no property pin, a forecast that is unavailable, a visit with no
 * planned primary product, or a throwing visit means no card and the sweep
 * continues. Gate off (GATE_LAWN_PREDAY_SPRAY_CHECK) = returns before any read.
 */
const db = require('../models/db');
const logger = require('./logger');
const { lawnPredaySprayCheckLive } = require('../config/feature-gates');
const { etDateString, parseETDateTime, windowDurationMinutes } = require('../utils/datetime-et');
const { OPEN_PRE_ARRIVAL_STATUSES, cardStillValid, readVisit } = require('./lawn-spray-card-validity');
const { detectServiceLine } = require('./service-report/service-line-configs');
const { fetchPropertyForecast } = require('./service-report/application-conditions');
const JobCard = require('./job-card');
const { createAlert, resolveAlert } = require('./dispatch-alerts');

const TYPE = 'lawn_spray_hold';
const SOURCE = 'lawn_preday_spray_check';
const HOUR_MS = 3600000;
// Hours of forecast fetched from the arrival hour: the spray window (4 h) and
// the longest label rain-free interval the card can quote (24 h) plus margin.
const FORECAST_HOURS = 36;
const FORECAST_TIMEOUT_MS = 4000;
const SWEEP_BUDGET_MS = Number(process.env.LAWN_PREDAY_SPRAY_CHECK_BUDGET_MS) > 0
  ? Number(process.env.LAWN_PREDAY_SPRAY_CHECK_BUDGET_MS) : 120000;
// A rain reason needs measured rain: below one hundredth of an inch the
// forecast probability alone does not make a card (rain is quantitative).
const RAIN_MIN_INCHES = 0.01;

const enabled = () => lawnPredaySprayCheckLive();

function timeLabel(windowStart) {
  const m = /^(\d{2}):(\d{2})/.exec(String(windowStart || ''));
  if (!m) return null;
  const h = Number(m[1]);
  return `${h % 12 || 12}:${m[2]} ${h < 12 ? 'AM' : 'PM'}`;
}

const trimNumber = (n) => String(Math.round(Number(n) * 100) / 100);

// Open-Meteo rows → the hourly shape buildSprayCheck reads. Temperature and
// wind are readings AT the stamp. The probability stamped S+1h describes the
// hour that STARTS at S (Open-Meteo states it for the preceding hour), so
// each row takes its next row's value; a missing next row is null (unknown),
// never a pass.
function hourlyForSprayCheck(rows) {
  const sorted = [...rows].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return sorted.map((row, i) => {
    const next = sorted[i + 1];
    const adjacent = next && Date.parse(next.at) - Date.parse(row.at) === HOUR_MS;
    return {
      startTime: row.at,
      temperatureF: row.temperature_f ?? null,
      windMph: row.wind_mph ?? null,
      rainChance: adjacent ? (next.precipitation_probability_pct ?? null) : null,
      shortForecast: null,
    };
  });
}

// Inches of rain over the label interval [arrival, arrival + hours], hours
// possibly fractional (30 min, 1.5 h). Open-Meteo stamps a value at hour S as
// the rain in the hour ENDING at S, i.e. [S-1h, S]. The rule: sum EVERY slot
// whose hour overlaps the interval, so the end rounds UP to the next slot and
// an interval shorter than an hour still reads the slot containing the
// arrival. That is the slots S with arrival < S <= ceil((arrival + hours) /
// 1h) * 1h. A partly overlapping hour counts whole (it can only over-state
// rain, never lose a hold). fetchPropertyForecast's own total counts only
// whole hours INSIDE a window, the wrong tool for a sub-hour interval.
// Null unless every counted slot has a reading.
function rainInches(rows, arrivalMs, hours) {
  const byMs = new Map(rows.map((r) => [Date.parse(r.at), r]));
  const first = Math.floor(arrivalMs / HOUR_MS) * HOUR_MS + HOUR_MS;
  const last = Math.ceil((arrivalMs + hours * HOUR_MS) / HOUR_MS) * HOUR_MS;
  let total = 0;
  for (let slot = first; slot <= last; slot += HOUR_MS) {
    const row = byMs.get(slot);
    if (!row || row.precipitation_in == null) return null;
    total += Number(row.precipitation_in);
  }
  return Math.round(total * 100) / 100;
}

// The interval as the label states it: "30 min", "1.5 h", "6 h".
const intervalLabel = (hours) => (hours < 1 ? `${Math.round(hours * 60)} min` : `${trimNumber(hours)} h`);

// One held product → its card line. `reason` is buildSprayCheck's own text
// ("under 50°F", "over 90°F", "wind over 15 mph", "rain likely inside 6 h"),
// joined with ", "; each piece is restated with the measured forecast number.
function describeHold({ product, reason, limits, forecast, rows, arrivalMs, arrivalAnchor, windowHours }) {
  const parts = [];
  const after = arrivalAnchor;
  for (const piece of String(reason || '').split(', ')) {
    if (piece.startsWith('rain')) {
      const hours = limits.rainFreeHours;
      const inches = hours != null ? rainInches(rows, arrivalMs, hours) : null;
      if (inches != null && inches >= RAIN_MIN_INCHES) parts.push({ kind: 'rain', text: `${trimNumber(inches)} in of rain forecast in the ${intervalLabel(hours)} ${after}`, inches });
    } else if (piece.startsWith('wind')) {
      if (forecast?.windMph != null) parts.push({ kind: 'wind', text: `wind forecast up to ${trimNumber(forecast.windMph)} mph in the ${windowHours} h ${after} (label limit ${trimNumber(limits.maxWindMph)} mph)`, windMph: forecast.windMph });
    } else if (piece.startsWith('under')) {
      if (forecast?.tempF?.[0] != null) parts.push({ kind: 'temperature', text: `forecast low ${trimNumber(forecast.tempF[0])}°F in the ${windowHours} h ${after} (label minimum ${trimNumber(limits.minTempF)}°F)`, lowF: forecast.tempF[0] });
    } else if (piece.startsWith('over')) {
      if (forecast?.tempF?.[1] != null) parts.push({ kind: 'temperature', text: `forecast high ${trimNumber(forecast.tempF[1])}°F in the ${windowHours} h ${after} (label maximum ${trimNumber(limits.maxTempF)}°F)`, highF: forecast.tempF[1] });
    }
  }
  return parts.length ? { productId: product.id, productName: product.name, parts } : null;
}

// The plan's alternative for the held step: another product on the SAME
// protocol line (identical `raw` text, the one step identity the resolved
// lines carry) whose own check is clear. Granular (dry) products say so.
// A fallback on a SEPARATE line ("IF >85°F → Celsius WG instead") has no step
// identity in the data (the plan engine's branchGroupId exists only for the
// May fertilizer branch and the job card's lines do not carry it), so it is
// never guessed from text: with no same-line alternative the card does not
// claim there is none, it points the dispatcher at the protocol.
function alternativeFor(heldLine, lines, verdictOf) {
  const alt = lines.find((l) => l !== heldLine && l.raw && l.raw === heldLine.raw
    && l.product.id !== heldLine.product.id && verdictOf(l.product.id) === 'ok');
  if (!alt) return null;
  return { productId: alt.product.id, productName: alt.product.name, granular: !JobCard.isTankMixable(alt.product) };
}

/**
 * The holds for one visit, or [] when nothing should hold / nothing can be
 * judged. Pure given its inputs (the context from loadVisitSprayContext and
 * a property forecast), so it is testable without a database.
 */
function holdsForVisit({ ctx, forecast }) {
  const primaryLines = ctx.lines.filter((l) => !l.source && l.selected !== false);
  if (!primaryLines.length || forecast?.status !== 'ok') return [];
  const rows = forecast.hourly || [];
  // What the card says the intervals start from, matching exactly the arrival
  // the spray check and the forecast request used (job-card sprayArrival).
  const arrivalSource = ctx.arrivalSource || (ctx.windowStart ? 'window' : 'noon');
  const arrivalAnchor = arrivalSource === 'now' ? 'from now'
    : arrivalSource === 'noon' ? 'after 12:00 PM (no arrival window booked)'
      : `after the ${timeLabel(ctx.windowStart)} arrival`;
  const sprayCheck = JobCard.buildSprayCheck({
    products: [...new Map(ctx.lines.map((l) => [l.product.id, l.product])).values()],
    hourly: hourlyForSprayCheck(rows),
    now: ctx.arrival,
    labelSources: ctx.labelSources,
  });
  const verdictFor = (id) => sprayCheck.verdicts.find((v) => v.productId === id);
  const arrivalMs = ctx.arrival.getTime();
  const holds = [];
  const seen = new Set();
  for (const line of primaryLines) {
    const verdict = verdictFor(line.product.id);
    if (verdict?.verdict !== 'hold' || seen.has(line.product.id)) continue;
    seen.add(line.product.id);
    const described = describeHold({
      product: line.product,
      reason: verdict.reason,
      limits: JobCard.sprayLimitsFor(line.product, ctx.labelSources[line.product.id]),
      forecast: sprayCheck.forecast,
      rows,
      arrivalMs,
      arrivalAnchor,
      windowHours: sprayCheck.windowHours,
    });
    if (!described) continue;
    holds.push({ ...described, alternative: alternativeFor(line, ctx.lines, (id) => verdictFor(id)?.verdict) });
  }
  return holds;
}

function cardLines(holds) {
  return holds.map((h) => {
    const why = h.parts.map((p) => p.text).join('; ');
    const next = h.alternative
      ? `The plan lists ${h.alternative.granular ? 'granular ' : ''}${h.alternative.productName} for the same step, and its check is clear.`
      : 'Check the protocol for an alternative, or move the visit.';
    return `${h.productName}: hold. ${why[0].toUpperCase()}${why.slice(1)}. ${next}`;
  });
}

// Dedupe rule: one card per visit, ET day and booked window. A prior card
// BLOCKS a new one only when it is
//   (a) still OPEN (resolved_at IS NULL), or
//   (b) resolved BY A PERSON: a dispatcher's Resolve or the queue's Clear. A
//       person's resolve writes resolved_at/resolved_by and nothing else,
//       while every system close (resolveAlert({ auto: true }): the status
//       hook, the queue-read guard, this sweep's stale cleanup) also stamps
//       payload.superseded_at. resolved_by is NOT the marker: the status hook
//       passes the transitioning actor as resolvedBy on an auto close.
// A card the system superseded does NOT block: the visit moved away and back,
// or a transient predicate failure closed it, and no person ever dismissed it.
// It is recreated only when cardStillValid is true again (the publish step
// re-reads the visit) AND the spray check still says hold; an unchanged
// visit has its open card, so a repeat run writes nothing. The advisory lock
// (a lock key, never a visit row) serializes two writers.
async function alreadyCarded(dbh, jobId, day, windowStart) {
  const row = await dbh('dispatch_alerts')
    .where({ type: TYPE, job_id: jobId })
    .whereRaw("payload->>'for_date' = ? AND payload->>'window_start' IS NOT DISTINCT FROM ?", [day, windowStart ?? null])
    .whereRaw("(resolved_at IS NULL OR payload->>'superseded_at' IS NULL)")
    .first('id');
  return Boolean(row);
}

// Open cards whose visit fails cardStillValid are superseded (system
// resolve, same stamp as the status hooks). Date and time edits have no
// single write chokepoint, so this read is the catch-all. The open cards are
// few (one per lawn visit per day); the join is read-only on visits (no row
// locks) and bounded.
const STALE_CARD_LIMIT = 1000;
async function supersedeStaleCards({ dbh, day, resolve }) {
  const open = await dbh('dispatch_alerts as a')
    .leftJoin('scheduled_services as s', 's.id', 'a.job_id')
    .where('a.type', TYPE)
    .whereNull('a.resolved_at')
    .orderBy('a.created_at', 'asc')
    .limit(STALE_CARD_LIMIT)
    .select('a.id', 'a.payload', 's.id as visit_id', 's.status as visit_status', 's.scheduled_date as visit_date', 's.window_start as visit_window');
  let count = 0;
  for (const row of open) {
    const visit = row.visit_id ? { status: row.visit_status, scheduled_date: row.visit_date, window_start: row.visit_window } : null;
    if (cardStillValid(visit, row.payload, day)) continue;
    if (await (resolve || resolveAlert)({ id: row.id, auto: true })) count += 1;
  }
  return count;
}

async function writeCard({ dbh, jobId, day, ctx, holds, deps }) {
  const payload = {
    source: SOURCE,
    for_date: day,
    // The BOOKED window: the visit identity cardStillValid and the dedupe compare.
    window_start: ctx.windowStart || null,
    interval_start: ctx.arrival.toISOString(),
    interval_from: ctx.arrivalSource || (ctx.windowStart ? 'window' : 'noon'),
    lines: cardLines(holds),
    holds: holds.map((h) => ({
      product_id: h.productId,
      product_name: h.productName,
      measured: h.parts.map(({ text, ...rest }) => rest),
      alternative: h.alternative,
    })),
  };
  // Publish: inside the per-visit advisory lock (a lock key, never a visit
  // row), re-read the visit and write only if the card is still valid for the
  // date, window and status the forecast was computed for.
  const mine = { for_date: day, window_start: ctx.windowStart || null };
  const published = await dbh.transaction(async (trx) => {
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`lawn-preday-spray-check:${jobId}:${day}`]);
    if (await alreadyCarded(trx, jobId, day, ctx.windowStart)) return { outcome: 'duplicate' };
    if (!cardStillValid(await readVisit(trx, jobId), mine, day)) return { outcome: 'stale' };
    const row = await (deps.createAlert || createAlert)({ type: TYPE, severity: 'warn', jobId, payload, trx });
    return { outcome: 'carded', id: row?.id };
  });
  if (published.outcome !== 'carded') return published.outcome;
  // The status hook (dispatch-alerts.js supersedeInvalidSprayHolds) does not
  // take our advisory lock, so one that committed between the re-read and this commit could not see the card.
  // Re-read once more now that the card is visible and supersede it if the
  // visit has moved on.
  if (!cardStillValid(await readVisit(dbh, jobId), mine, day)) {
    if (published.id) await (deps.resolveAlert || resolveAlert)({ id: published.id, auto: true });
    return 'stale';
  }
  return 'carded';
}

/**
 * "Still upcoming": the visit's arrival window has not ended. The window is
 * [start, start + its own length): start = window_start (noon when none is
 * booked, the same fallback the job card uses), length = windowDurationMinutes
 * (stored span, else estimated_duration_minutes, else 60 — the shared rule
 * the movers use). Equivalent to the schedule's own "window elapsed" notion
 * (sameDayWindowElapsed: end at or before now), so the hourly backstop runs
 * never card a morning visit that simply was not started by afternoon.
 */
function visitStillUpcoming(visit, day, now) {
  const start = parseETDateTime(`${day}T${normWindowStart(visit.window_start)}`);
  if (!Number.isFinite(start.getTime())) return false;
  const minutes = windowDurationMinutes(visit.window_start, visit.window_end, visit.estimated_duration_minutes);
  return start.getTime() + minutes * 60000 > now.getTime();
}
const normWindowStart = (v) => (/^\d{2}:\d{2}/.test(String(v || '')) ? String(v).slice(0, 5) : '12:00');

// One visit → { counter, checked, held }: the result counter it moves
// (duplicate / unavailable / stale / carded, or null), whether a forecast was judged,
// and whether a hold was found. Throws are the caller's to count.
async function checkVisit({ dbh, visit, day, now, catalog, deps }) {
  if (!visitStillUpcoming(visit, day, now)) return {};
  if (await alreadyCarded(dbh, visit.id, day, visit.window_start)) return { counter: 'duplicate' };
  const ctx = await (deps.loadContext || JobCard.loadVisitSprayContext)(visit.id, { dbh, now, catalog, deps: deps.jobCard || {} });
  if (!ctx || !ctx.isLawn || ctx.scheduledDate !== day) return {};
  if (!ctx.coords) return { counter: 'unavailable' };
  const fromMs = Math.floor(ctx.arrival.getTime() / HOUR_MS) * HOUR_MS;
  const forecast = await (deps.fetchForecast || fetchPropertyForecast)({
    latitude: ctx.coords.lat,
    longitude: ctx.coords.lng,
    from: fromMs,
    to: fromMs + FORECAST_HOURS * HOUR_MS,
    timeoutMs: FORECAST_TIMEOUT_MS,
    now: now.getTime(),
  });
  if (forecast?.status !== 'ok') return { counter: 'unavailable' };
  const holds = holdsForVisit({ ctx, forecast });
  if (!holds.length) return { checked: true };
  return { counter: await writeCard({ dbh, jobId: visit.id, day, ctx, holds, deps }), checked: true, held: true };
}

async function runSweep({ dbh = db, now = new Date(), deps = {} } = {}) {
  if (!enabled()) return { skipped: true, reason: 'gate_off' };
  const day = etDateString(now);
  const deadline = Date.now() + SWEEP_BUDGET_MS;
  const result = { considered: 0, checked: 0, held: 0, carded: 0, duplicate: 0, stale: 0, unavailable: 0, failed: 0, superseded: 0, deadline: false };
  try {
    result.superseded = await supersedeStaleCards({ dbh, day, resolve: deps.resolveAlert });
  } catch (err) {
    logger.warn(`[lawn-preday-spray-check] stale card cleanup failed: ${err.message}`);
  }
  const visits = await dbh('scheduled_services as s')
    .join('customers as c', 's.customer_id', 'c.id')
    .whereNull('c.deleted_at')
    .where('s.scheduled_date', day)
    .whereIn('s.status', OPEN_PRE_ARRIVAL_STATUSES)
    .orderBy('s.window_start', 'asc')
    .orderBy('s.id', 'asc')
    .select('s.id', 's.service_type', 's.window_start', 's.window_end', 's.estimated_duration_minutes');
  const lawnVisits = visits.filter((v) => detectServiceLine(v.service_type) === 'lawn');
  result.considered = lawnVisits.length;
  if (!lawnVisits.length) return result;

  let catalog;
  try {
    catalog = await (deps.loadCatalog || JobCard.loadCatalog)(dbh);
  } catch (err) {
    logger.warn(`[lawn-preday-spray-check] product catalog unavailable: ${err.message}`);
    return { ...result, failed: lawnVisits.length };
  }

  for (const visit of lawnVisits) {
    if (Date.now() > deadline) { result.deadline = true; break; }
    try {
      const { counter, checked, held } = await checkVisit({ dbh, visit, day, now, catalog, deps });
      if (counter) result[counter] += 1;
      if (checked) result.checked += 1;
      if (held) result.held += 1;
    } catch (err) {
      result.failed += 1;
      logger.warn(`[lawn-preday-spray-check] visit check failed: ${err.message}`);
    }
  }
  return result;
}

module.exports = { enabled, runSweep, visitStillUpcoming, supersedeStaleCards, cardStillValid, OPEN_PRE_ARRIVAL_STATUSES, holdsForVisit, cardLines, hourlyForSprayCheck, rainInches, TYPE, SOURCE, RAIN_MIN_INCHES };
