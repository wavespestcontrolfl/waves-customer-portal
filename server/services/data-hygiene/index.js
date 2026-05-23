/**
 * Data Hygiene Agent — orchestrator (Phase 0 skeleton).
 *
 * This file is intentionally minimal in Phase 0. Its only responsibilities
 * for the first ship are:
 *
 *   1. Open a data_hygiene_runs row with status='running'.
 *   2. Honor the database-backed run lock (P8) — if a concurrent run is
 *      already 'running', the partial unique index `one_running_data_hygiene_scan`
 *      raises a unique-violation; catch it, write a status='lock_busy' row,
 *      and surface a structured result the caller (route or cron) can
 *      translate into a 409.
 *   3. Mark the run 'ok' (or 'failed' on uncaught error) in a finally block.
 *
 * No scanner phases execute yet. Phase 1 plugs in deterministic normalizers;
 * Phase 1.5 plugs in the call_log.ai_extraction bootstrap; Phase 3 plugs in
 * cross-record backfill + conversation/call linking; Phase 3.5 plugs in
 * dedupe; Phase 4 plugs in the LLM extractors.
 *
 * Public API:
 *
 *   runScan({ mode, phases, triggeredBy }) → { run_id, status, lock_busy }
 *
 *     mode         'cron' | 'manual' | 'bootstrap' | 'dry_run'
 *     phases       e.g. ['normalization'] — informational in Phase 0; later
 *                  phases consult this list to decide which scanners to run
 *     triggeredBy  technicians.id when mode === 'manual'; otherwise null
 *
 *     Returns the run row id, the final status, and a lock_busy flag the
 *     caller (admin route) maps to HTTP 409.
 *
 * The scanner_version is currently a literal 'v1'. When the scanner gains
 * real rules in Phase 1 this should switch to reading the deployed git sha so
 * a row in data_hygiene_runs is traceable to a specific deploy.
 */
const db = require('../../models/db');
const logger = require('../logger');

const SCANNER_VERSION = 'v1';

const VALID_MODES = ['cron', 'manual', 'bootstrap', 'dry_run'];

async function runScan({ mode, phases = [], triggeredBy = null } = {}) {
  if (!VALID_MODES.includes(mode)) {
    throw new Error(`runScan: invalid mode '${mode}' — must be one of ${VALID_MODES.join(', ')}`);
  }

  let runId = null;
  try {
    const [row] = await db('data_hygiene_runs')
      .insert({
        mode,
        triggered_by: triggeredBy,
        phases: JSON.stringify(phases),
        status: 'running',
        counts: '{}',
        scanner_version: SCANNER_VERSION,
      })
      .returning(['id']);
    runId = row.id;
  } catch (err) {
    // P8: partial unique index on (1) WHERE status='running' makes a second
    // concurrent INSERT fail with a unique-violation. Translate to a
    // bookkeeping row so ops can see the contention in the Runs tab.
    if (err && err.code === '23505') {
      try {
        const [lockRow] = await db('data_hygiene_runs')
          .insert({
            mode,
            triggered_by: triggeredBy,
            phases: JSON.stringify(phases),
            status: 'lock_busy',
            counts: '{}',
            scanner_version: SCANNER_VERSION,
            finished_at: db.fn.now(),
          })
          .returning(['id']);
        logger.info(`[data-hygiene] scan ${mode} skipped — another run is in progress (lock_busy row ${lockRow.id})`);
        return { run_id: lockRow.id, status: 'lock_busy', lock_busy: true };
      } catch (lockWriteErr) {
        logger.error(`[data-hygiene] failed to record lock_busy row: ${lockWriteErr.message}`);
        return { run_id: null, status: 'lock_busy', lock_busy: true };
      }
    }
    throw err;
  }

  let finalStatus = 'ok';
  let errorMessage = null;
  try {
    // Phase 0: no-op. Phase 1+ dispatch normalizers/backfill/link/dedupe/
    // extraction here based on `phases`, accumulating counts as they run.
    logger.info(`[data-hygiene] scan ${mode} (run_id=${runId}) — Phase 0 skeleton, no rules wired yet`);
  } catch (err) {
    finalStatus = 'failed';
    errorMessage = err.message || String(err);
    logger.error(`[data-hygiene] scan ${mode} (run_id=${runId}) failed: ${errorMessage}`);
  } finally {
    try {
      await db('data_hygiene_runs')
        .where({ id: runId })
        .update({
          status: finalStatus,
          finished_at: db.fn.now(),
          error_message: errorMessage,
        });
    } catch (updateErr) {
      // If we cannot close the run row, log it loudly — the partial unique
      // index will block the next scan until an ops watchdog reaps stuck
      // rows (finished_at IS NULL AND started_at < now() - interval '2 hours').
      logger.error(`[data-hygiene] failed to close run ${runId}: ${updateErr.message}`);
    }
  }

  return { run_id: runId, status: finalStatus, lock_busy: false };
}

module.exports = { runScan, SCANNER_VERSION };
