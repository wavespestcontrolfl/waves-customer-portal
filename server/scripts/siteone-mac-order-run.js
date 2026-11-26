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
 * Database: Railway's DATABASE_URL for the portal is a private host the Mac cannot reach. The Mac
 * wrapper (outside the repo) sets DATABASE_URL to DATABASE_PUBLIC_URL before this script starts, and
 * fails the run (exit 1, the failure bell) when no public URL is in the env.
 *
 * Usage (from the server directory, inside the Railway env, DATABASE_URL = the public URL):
 *   node scripts/siteone-mac-order-run.js
 */
const logger = require('../services/logger');

const { execFile } = require('child_process');
const path = require('path');

const JOB = 'siteone-mac-order';

// The Mac inherits Railway's variables once, at launch. A switch the owner turns off while a run is
// in checkout must still stop it: before every cap check the adapter asks for (cart, review, and the
// final claim check right before the click) the LIVE values are read again from Railway. Off, changed
// or unreadable = a run-level stop: the claim is released, nothing is clicked, the job fails (its
// wrapper rings) and tomorrow's run follows the switches as they are then.
const ON = (v) => ['1', 'true', 'on'].includes(String(v || '').toLowerCase());
function readLiveRailwayVars() {
  const env = { ...process.env };
  delete env.RAILWAY_TOKEN; // the portal service's own token is not the CLI login (2026-10-21)
  return new Promise((resolve, reject) => {
    execFile('railway', ['variables', '--service', 'waves-customer-portal', '--kv'], { cwd: path.resolve(__dirname, '..', '..'), env, timeout: 20000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(new Error(`live Railway variables unreadable: ${String(err.message).slice(0, 80)}`));
      const vars = {};
      for (const line of String(stdout).split('\n')) { const i = line.indexOf('='); if (i > 0) vars[line.slice(0, i)] = line.slice(i + 1); }
      return resolve(vars);
    });
  });
}
function liveStopReason(live, launch) {
  if (!ON(live.GATE_AUTO_ORDER) || !ON(live.GATE_AUTO_ORDER_SITEONE)) return 'an auto-order gate is off now';
  if (String(live.SITEONE_ORDER_RUNNER || '').trim().toLowerCase() !== 'mac') return 'SITEONE_ORDER_RUNNER is no longer mac';
  // The caps the reservation enforces are the launch values; a cap changed since launch (lowered or
  // raised) stops the run rather than reserve against a limit the owner has replaced.
  // Exact strings, no trimming: the adapter decides dry run by an exact match, so any edit counts.
  for (const k of ['SITEONE_BOT_DRY_RUN', 'SITEONE_CART_ISOLATED', 'AUTO_ORDER_MAX_PER_ORDER_CENTS', 'AUTO_ORDER_MAX_MONTHLY_CENTS']) {
    if (String(live[k] ?? '') !== String(launch[k] ?? '')) return `${k} changed since launch`;
  }
  return null;
}
function withLiveSwitches(adapter, { readLive = readLiveRailwayVars, launch = process.env } = {}) {
  return {
    ...adapter,
    place: (args, opts) => adapter.place({
      ...args,
      beforeSubmit: async (cents) => {
        const reason = liveStopReason(await readLive(), launch);
        if (reason) { const e = new Error(`${JOB}: stopped — ${reason}`); e.runLevel = true; throw e; }
        return args.beforeSubmit(cents);
      },
    }, opts),
  };
}

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
  const registry = adapters || { siteone: withLiveSwitches(require('../services/procurement/adapters/siteone-cdp')) };
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

module.exports = { run, summarize, JOB, withLiveSwitches, liveStopReason };
