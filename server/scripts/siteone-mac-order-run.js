/**
 * siteone-mac-order-run.js — places the open SiteOne auto-reorder requests from the owner's Mac.
 *
 * SiteOne blocks every server-side browser and takes no email orders, so the server (with
 * SITEONE_ORDER_RUNNER=mac) claims no SiteOne request; this job does, once each morning after the
 * 6:10 ET sweep, through the SAME dispatcher (claims, spend caps, ledger, bells, audit) with one
 * difference: its registry holds only the Chrome adapter (adapters/siteone-cdp.js), which drives the
 * owner's own signed-in Chrome on SITEONE_CDP_URL. It never starts or restarts Chrome: Chrome closed
 * = a run-level failure, the claim is released and the job exits 1 (the Mac wrapper rings the bell);
 * after SITEONE_MAC_STALE_HOURS the server's watchdog hands the request to the office.
 *
 * Gates and caps are the production values: the Mac wrapper runs this inside `railway run` for the
 * portal service, so GATE_AUTO_ORDER, GATE_AUTO_ORDER_SITEONE, SITEONE_BOT_DRY_RUN and the
 * AUTO_ORDER_MAX_* caps are the live ones — a gate turned off in Railway stops the Mac too.
 * Reconciliation (stale claims, bells that never landed) stays with the server's run.
 *
 * Exit: 0 = ran (orders placed, parked or nothing to do), 1 = failed (Chrome unreachable, DB, any
 * unrecorded outcome). Prints one summary line.
 *
 * Usage (from the server directory, inside the Railway env): node scripts/siteone-mac-order-run.js
 */
const logger = require('../services/logger');

const JOB = 'siteone-mac-order';

function summarize(result) {
  const results = (result && result.results) || [];
  const count = (pred) => results.filter(pred).length;
  return `${JOB}: ${count((r) => r.status === 'placed')} placed, ${count((r) => r.status === 'needs_review')} parked, ${count((r) => r.skipped)} skipped of ${results.length}${result && result.skipped ? ` (${result.skipped})` : ''}`;
}

// One environment for everything: the runner switch, the caps, the gates AND the adapter's dry-run
// and approved-account settings all come from process.env (the adapter reads it too), so a caller can
// never pair a dry-run setting here with a live one inside the adapter.
async function run({ adapters = null, runExclusive = null, dispatch = null } = {}) {
  const env = process.env;
  const { runVendorOrderDispatch, _internals: { siteoneRunsOnMac } } = require('../services/procurement/order-dispatch');
  // The switch that hands SiteOne back to the server stops the Mac too: with it unset the server's
  // own adapter owns SiteOne again, and a Mac order beside it could buy the same need twice.
  if (!siteoneRunsOnMac(env)) throw new Error(`${JOB}: SITEONE_ORDER_RUNNER is not 'mac' in the live env — the server owns SiteOne orders, nothing claimed`);
  if (!String(env.SITEONE_CDP_URL || '').trim()) throw new Error(`${JOB}: SITEONE_CDP_URL is not set (this job runs only on the Mac with Chrome on :9222)`);
  const registry = adapters || { siteone: require('../services/procurement/adapters/siteone-cdp') };
  // An unconfigured Mac (no approved account, store or pickup) is a broken job, not a hand-off: the
  // dispatcher would ring "order manually" with no macHandedOffAt stamp, and a later fixed run could
  // buy it a second time. Fail the run instead (its wrapper rings the failure bell); the server's
  // watchdog stamps and hands off the request if the Mac stays down.
  if (typeof registry.siteone.configured === 'function' && registry.siteone.configured() !== true) throw new Error(`${JOB}: the SiteOne Chrome adapter is not configured (SITEONE_CDP_URL, SITEONE_APPROVED_ACCOUNT, SITEONE_APPROVED_STORE_ID, SITEONE_APPROVED_PICKUP)`);
  const exclusive = runExclusive || require('../utils/cron-lock').runExclusive;
  const runDispatch = dispatch || runVendorOrderDispatch;
  const result = await exclusive(JOB, () => runDispatch({ adapters: registry, onlyAdapters: ['siteone'], reconcile: false, env }), { waitForSlot: false });
  if (result && result.skipped === true) throw new Error(`${JOB}: skipped (${result.reason || 'lease held'})`);
  return result;
}

if (require.main === module) {
  run()
    .then((result) => { console.log(summarize(result)); process.exitCode = 0; })
    .catch((err) => { logger.error(`${JOB} failed: ${err.message}`); console.error(`${JOB} FAILED: ${err.message}`); process.exitCode = 1; })
    // Exit explicitly: the Chrome DevTools socket is never closed by the adapter (closing it could
    // close the owner's Chrome), and an open socket would keep this process alive past its summary.
    .finally(async () => { try { await require('../models/db').destroy(); } catch { /* already closed */ } process.exit(process.exitCode || 0); });
}

module.exports = { run, summarize, JOB };
