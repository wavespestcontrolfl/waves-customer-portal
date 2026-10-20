const nodeCron = require('node-cron');
const { AsyncLocalStorage } = require('async_hooks');

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
function schedule(expression, task, options) {
  return nodeCron.schedule(
    expression,
    (...args) => tickContext.run({ scheduled: true }, () => task(...args)),
    { recoverMissedExecutions: true, ...options },
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

module.exports = { ...nodeCron, schedule, isScheduledTick, runAsScheduledTick, scheduleTimeout, scheduleInterval };
