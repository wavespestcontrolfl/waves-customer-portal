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

function schedule(expression, task, options) {
  return nodeCron.schedule(
    expression,
    (...args) => tickContext.run({ scheduled: true }, () => task(...args)),
    options,
  );
}

function isScheduledTick() {
  return !!tickContext.getStore();
}

module.exports = { ...nodeCron, schedule, isScheduledTick };
