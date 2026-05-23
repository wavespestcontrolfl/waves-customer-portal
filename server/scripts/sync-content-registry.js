#!/usr/bin/env node
/**
 * Sync the content registry read model.
 *
 * Default is dry-run. Use --commit to write content_registry rows and a
 * content_registry_sync_runs audit row. Missing ASTRO_REPO_DIR fails closed.
 */

const os = require('os');
const path = require('path');
const db = require('../models/db');
const registry = require('../services/content/content-registry');

function parseArgs(argv = process.argv.slice(2)) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      out[arg] = true;
      continue;
    }
    const raw = arg.slice(2);
    const eq = raw.indexOf('=');
    if (eq !== -1) {
      out[raw.slice(0, eq)] = raw.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[raw] = next;
      i += 1;
    } else {
      out[raw] = true;
    }
  }
  return out;
}

function boolFlag(value) {
  if (value === true) return true;
  return /^(1|true|yes|on)$/i.test(String(value || ''));
}

function resolveAstroRoot(args = {}, env = process.env) {
  const explicit = args['astro-dir'] || env.ASTRO_REPO_DIR || null;
  return {
    astroRoot: explicit || path.join(os.homedir(), 'Downloads', 'wavespestcontrol-astro'),
    usingFallback: !explicit,
  };
}

function printSummary(result) {
  const s = result.summary || {};
  console.log('');
  console.log(`Mode:                         ${result.mode}`);
  console.log(`Status:                       ${result.ok ? 'ok' : 'failed'}`);
  if (result.sync_run_id) console.log(`Sync run id:                  ${result.sync_run_id}`);
  if (!result.ok) {
    console.log(`Error:                        ${result.error || 'unknown'}`);
    return;
  }
  console.log(`Astro files scanned:          ${s.astro_files_scanned || 0}`);
  console.log(`DB blog rows scanned:         ${s.db_rows_scanned || 0}`);
  console.log(`Matched:                      ${s.matched_count || 0}`);
  console.log(`Astro-only:                   ${s.astro_only_count || 0}`);
  console.log(`DB-only:                      ${s.db_only_count || 0}`);
  console.log(`DB published missing Astro:   ${s.db_published_missing_astro_count || 0}`);
  console.log(`Conflicts:                    ${s.conflict_count || 0}`);
  console.log(`Changed since last sync:      ${s.changed_count || 0}`);
  console.log(`Errors:                       ${s.error_count || 0}`);
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const commit = boolFlag(args.commit);
  const json = boolFlag(args.json);
  const { astroRoot, usingFallback } = resolveAstroRoot(args);
  const contentType = args['content-type'] || null;

  if (commit && usingFallback) {
    const result = {
      ok: false,
      mode: 'commit',
      sync_run_id: null,
      summary: { error_count: 1 },
      error: 'ASTRO_REPO_DIR or --astro-dir is required when using --commit',
      code: 'ASTRO_ROOT_REQUIRED_FOR_COMMIT',
      rows: [],
    };
    if (json) console.log(JSON.stringify(result, null, 2));
    else printSummary(result);
    await db.destroy();
    process.exit(1);
  }

  const result = await registry.runContentRegistrySync({
    astroRoot,
    commit,
    contentType,
    database: db,
  });

  if (json) {
    console.log(JSON.stringify({
      ok: result.ok,
      mode: result.mode,
      sync_run_id: result.sync_run_id,
      summary: result.summary,
      error: result.error,
      code: result.code,
      rows: result.rows,
    }, null, 2));
  } else {
    printSummary(result);
    if (!commit && result.ok) {
      console.log('');
      console.log('Dry-run only. Re-run with --commit to write registry rows.');
    }
  }

  await db.destroy();
  if (!result.ok) process.exit(1);
}

if (require.main === module) {
  main().catch(async (err) => {
    console.error(err.stack || err.message);
    await db.destroy().catch(() => {});
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  boolFlag,
  resolveAstroRoot,
  printSummary,
  main,
};
