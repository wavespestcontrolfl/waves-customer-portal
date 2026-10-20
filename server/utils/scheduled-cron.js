const nodeCron = require('node-cron');
const { AsyncLocalStorage } = require('async_hooks');
const logger = require('../services/logger');

// node-cron with every tick marked as SCHEDULED work. The same service
// entry points (SocialContentStudio.runAutonomous, Data Manager uploads,
// the manual auto-dispatch / price-scan / engagement-sync routes) are
// invoked both by cron and by HTTP handlers, and only the cron side may
// wait for a cron-lock holder slot (see cron-lock.js): an HTTP request
// parked behind the top-of-hour herd would mutate after the client gave
// up. Registering through this module — instead of node-cron directly —
// is what makes runExclusive's default correct without threading a
// request-vs-scheduled flag through every shared entry point.
const tickContext = new AsyncLocalStorage();

// node-cron 3 checks each task once a second, and with
// recoverMissedExecutions off (its default) it fires a tick only when that
// check lands inside the matching second. When the top-of-hour herd blocks
// the event loop past it, the check lands a second late and the tick is
// dropped with no log and no job_health row. On 2026-10-18 the 4:00 AM ET
// geo-grid scan and newsletter ingestion both vanished that way while the
// health cleanup at the same minute ran. Recovery fires the matching second
// late instead; node-cron still fires each occurrence at most once, and
// only seconds missed since the task's previous check (never across a
// restart) are replayed.
//
// A replay has no age limit of its own, and many bodies read their period
// from the wall clock when they run (the 23:50 month-end MRR snapshot,
// billing-day cohorts), while runExclusive measures its deadline from the
// late arrival. So a tick more than REPLAY_MAX_LATE_MS late, or one that
// crossed its calendar day in the task's own timezone, is skipped with a
// warning instead of run against the wrong period.
const REPLAY_MAX_LATE_MS = 60 * 1000;

// node-cron passes the matched time as the wall clock of the task's
// timezone, re-read as a server-local Date (TimeMatcher.apply). Read "now"
// through the same formatter so the two compare in one frame.
function wallClock(timezone) {
  if (!timezone) return () => new Date();
  const dtf = new Intl.DateTimeFormat('en-US', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23', fractionalSecondDigits: 3, timeZone: timezone,
  });
  return () => new Date(dtf.format(new Date()));
}

function staleReplay(matchedAt, now) {
  if (!(matchedAt instanceof Date) || Number.isNaN(matchedAt.getTime())) return null; // manual / init run
  // Both times are offset-free wall clocks, so a stall across a DST change
  // shifts the gap by an hour either way (01:50 EDT handled at 01:05 EST
  // reads -45 min). Any gap past the limit, either sign, is skipped: a tick
  // near a DST change may be dropped, never run late.
  const gapMs = now - matchedAt;
  if (Math.abs(gapMs) > REPLAY_MAX_LATE_MS) return `wall-clock gap ${Math.round(gapMs / 1000)}s`;
  if (now.toDateString() !== matchedAt.toDateString()) return 'crossed its calendar day';
  return null;
}

function schedule(expression, task, options) {
  const opts = { recoverMissedExecutions: true, ...options };
  const nowInZone = wallClock(opts.timezone);
  return nodeCron.schedule(
    expression,
    (...args) => {
      const stale = staleReplay(args[0], nowInZone());
      if (stale) {
        logger.warn(`[scheduled-cron] '${expression}' tick skipped: ${stale} (event loop blocked)`);
        return undefined;
      }
      return tickContext.run({ scheduled: true }, () => task(...args));
    },
    opts,
  );
}

function isScheduledTick() {
  return !!tickContext.getStore();
}

// The same marking for sweeps driven by plain timers (index.js boot
// sweeps: pdf queue, hold sweeps, wizard recovery, WDO attention…) — they
// are scheduled work too, and must wait for a holder slot like a cron
// tick rather than fail fast and silently lose the sweep.
function runAsScheduledTick(task) {
  return tickContext.run({ scheduled: true }, task);
}
function scheduleTimeout(task, ms) {
  return setTimeout(() => runAsScheduledTick(task), ms);
}
function scheduleInterval(task, ms) {
  return setInterval(() => runAsScheduledTick(task), ms);
}

module.exports = { ...nodeCron, schedule, REPLAY_MAX_LATE_MS, isScheduledTick, runAsScheduledTick, scheduleTimeout, scheduleInterval };
