/**
 * Data Hygiene Agent — orchestrator.
 *
 * Current responsibilities:
 *
 *   1. Reap stale 'running' rows older than 2 hours so a missed close never
 *      permanently blocks future scans.
 *   2. Open a data_hygiene_runs row with status='running'.
 *   3. Honor the database-backed run lock (P8) — if a concurrent run is
 *      already 'running', the partial unique index `one_running_data_hygiene_scan`
 *      raises a unique-violation; catch it, write a status='lock_busy' row,
 *      and surface a structured result the caller (route or cron) can
 *      translate into a 409.
 *   4. Mark the run 'ok' (or 'failed' on uncaught error) in a finally block.
 *
 * Phase 1 executes deterministic normalizers only. Phase 1.5 plugs in the
 * call_log.ai_extraction bootstrap; Phase 3 plugs in cross-record backfill +
 * conversation/call linking; Phase 3.5 plugs in dedupe; Phase 4 plugs in the
 * LLM extractors.
 *
 * Public API:
 *
 *   runScan({ mode, phases, triggeredBy }) → { run_id, status, lock_busy }
 *
 *     mode         'cron' | 'manual' | 'bootstrap' | 'dry_run'
 *     phases       e.g. ['normalization']; Phase 1 supports deterministic
 *                  normalization and records unsupported phase names as skipped
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
const { reapStuckRuns } = require('./reaper');
const {
  normalizationCandidatesForCustomer,
  normalizationCandidatesForCustomerAccount,
} = require('./normalizers');
const {
  upsertProposal,
  stalePendingNormalizationForResource,
} = require('./proposal-store');

const SCANNER_VERSION = 'phase1-normalization-v1';
const BATCH_SIZE = 500;

const VALID_MODES = ['cron', 'manual', 'bootstrap', 'dry_run'];
const SUPPORTED_PHASES = new Set(['normalization']);

async function runScan({ mode, phases = [], triggeredBy = null } = {}) {
  if (!VALID_MODES.includes(mode)) {
    throw new Error(`runScan: invalid mode '${mode}' — must be one of ${VALID_MODES.join(', ')}`);
  }

  const requestedPhases = Array.isArray(phases) && phases.length ? phases : ['normalization'];

  await reapStuckRuns();

  let runId = null;
  try {
    const [row] = await db('data_hygiene_runs')
      .insert({
        mode,
        triggered_by: triggeredBy,
        phases: JSON.stringify(requestedPhases),
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
            phases: JSON.stringify(requestedPhases),
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
  const counts = createCounts(requestedPhases);
  try {
    logger.info(`[data-hygiene] scan ${mode} (run_id=${runId}) starting phases: ${requestedPhases.join(', ')}`);

    for (const phase of requestedPhases) {
      if (!SUPPORTED_PHASES.has(phase)) {
        counts.skipped_phases.push(phase);
        logger.info(`[data-hygiene] scan ${mode} (run_id=${runId}) skipped unsupported Phase 1 phase: ${phase}`);
        continue;
      }

      if (phase === 'normalization') {
        const phaseCounts = await runNormalizationPhase({
          runId,
          dryRun: mode === 'dry_run',
        });
        mergeCounts(counts, phaseCounts);
      }
    }

    logger.info(
      `[data-hygiene] scan ${mode} (run_id=${runId}) completed: ` +
      `${counts.created} created, ${counts.would_create} dry-run candidates, ` +
      `${counts.duplicates} duplicates, ${counts.staled} staled, ${counts.errors} errors`
    );
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
          counts: JSON.stringify(counts),
        });
    } catch (updateErr) {
      // If we cannot close the run row, log it loudly. The next runScan()
      // call reaps stale rows older than two hours before acquiring the
      // database-backed run lock.
      logger.error(`[data-hygiene] failed to close run ${runId}: ${updateErr.message}`);
    }
  }

  return { run_id: runId, status: finalStatus, lock_busy: false };
}

async function runNormalizationPhase({ runId, dryRun = false }) {
  const counts = createCounts(['normalization']);
  await scanCustomers({ runId, counts, dryRun });
  await scanCustomerAccounts({ runId, counts, dryRun });
  return counts;
}

async function scanCustomers({ runId, counts, dryRun }) {
  let lastId = null;
  while (true) {
    const query = db('customers')
      .select('id', 'first_name', 'last_name', 'email', 'phone', 'state', 'zip')
      .orderBy('id', 'asc')
      .limit(BATCH_SIZE);
    if (lastId) query.where('id', '>', lastId);

    const rows = await query;
    if (!rows.length) break;

    for (const row of rows) {
      counts.scanned.customers += 1;
      await handleRow({
        runId,
        counts,
        dryRun,
        row,
        candidates: normalizationCandidatesForCustomer(row),
        resource_type: 'customer',
        resource_id: row.id,
        currentValues: {
          first_name: row.first_name,
          last_name: row.last_name,
          email: row.email,
          phone: row.phone,
          state: row.state,
          zip: row.zip,
        },
      });
    }

    lastId = rows[rows.length - 1].id;
    if (rows.length < BATCH_SIZE) break;
  }
}

async function scanCustomerAccounts({ runId, counts, dryRun }) {
  let lastId = null;
  while (true) {
    const query = db('customer_accounts')
      .select('id', 'first_name', 'last_name', 'email', 'phone')
      .orderBy('id', 'asc')
      .limit(BATCH_SIZE);
    if (lastId) query.where('id', '>', lastId);

    const rows = await query;
    if (!rows.length) break;

    for (const row of rows) {
      counts.scanned.customer_accounts += 1;
      await handleRow({
        runId,
        counts,
        dryRun,
        row,
        candidates: normalizationCandidatesForCustomerAccount(row),
        resource_type: 'customer_account',
        resource_id: row.id,
        currentValues: {
          first_name: row.first_name,
          last_name: row.last_name,
          email: row.email,
          phone: row.phone,
        },
      });
    }

    lastId = rows[rows.length - 1].id;
    if (rows.length < BATCH_SIZE) break;
  }
}

async function handleRow({
  runId,
  counts,
  dryRun,
  candidates,
  resource_type,
  resource_id,
  currentValues,
}) {
  try {
    if (dryRun) {
      for (const candidate of candidates) {
        counts.would_create += 1;
        increment(counts.by_source, candidate.source);
        increment(counts.by_rule, candidate.rule_id);
        increment(counts.by_tier, candidate.tier);
      }
      return;
    }

    for (const candidate of candidates) {
      const result = await upsertProposal(candidate, { run_id: runId });
      if (result.inserted) {
        counts.created += 1;
        increment(counts.by_source, candidate.source);
        increment(counts.by_rule, candidate.rule_id);
        increment(counts.by_tier, candidate.tier);
      } else {
        counts.duplicates += 1;
      }
    }

    const staled = await stalePendingNormalizationForResource({
      resource_type,
      resource_id,
      currentValues,
    });
    counts.staled += staled;
  } catch (err) {
    counts.errors += 1;
    logger.error(`[data-hygiene] normalization row failed (${resource_type}:${resource_id}): ${err.message}`);
  }
}

function createCounts(phases = []) {
  return {
    phases,
    created: 0,
    would_create: 0,
    duplicates: 0,
    staled: 0,
    auto_applied: 0,
    errors: 0,
    skipped_phases: [],
    scanned: {
      customers: 0,
      customer_accounts: 0,
    },
    by_source: {},
    by_rule: {},
    by_tier: {},
  };
}

function mergeCounts(target, source) {
  target.created += source.created || 0;
  target.would_create += source.would_create || 0;
  target.duplicates += source.duplicates || 0;
  target.staled += source.staled || 0;
  target.auto_applied += source.auto_applied || 0;
  target.errors += source.errors || 0;
  target.skipped_phases.push(...(source.skipped_phases || []));
  target.scanned.customers += source.scanned?.customers || 0;
  target.scanned.customer_accounts += source.scanned?.customer_accounts || 0;
  mergeMap(target.by_source, source.by_source);
  mergeMap(target.by_rule, source.by_rule);
  mergeMap(target.by_tier, source.by_tier);
}

function mergeMap(target, source = {}) {
  for (const [key, value] of Object.entries(source)) {
    target[key] = (target[key] || 0) + value;
  }
}

function increment(target, key) {
  target[key] = (target[key] || 0) + 1;
}

module.exports = {
  runScan,
  reapStuckRuns,
  SCANNER_VERSION,
  runNormalizationPhase,
};
