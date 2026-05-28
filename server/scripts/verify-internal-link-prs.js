#!/usr/bin/env node
/**
 * Verify merged autonomous internal-link PRs against the live rendered site.
 *
 * Usage:
 *   node server/scripts/verify-internal-link-prs.js
 *   node server/scripts/verify-internal-link-prs.js --limit=5
 *   node server/scripts/verify-internal-link-prs.js --id=<task_uuid>
 *   node server/scripts/verify-internal-link-prs.js --ids=<task_uuid>,<task_uuid>
 */

const db = require('../models/db');
const executor = require('../services/content/internal-link-pr-executor');

function parseArgs(argv = process.argv.slice(2)) {
  const args = {};
  for (const item of argv) {
    if (!item.startsWith('--')) continue;
    const raw = item.slice(2);
    const eq = raw.indexOf('=');
    if (eq === -1) {
      args[raw] = true;
    } else {
      args[raw.slice(0, eq)] = raw.slice(eq + 1);
    }
  }
  return args;
}

function parseLimit(value, fallback = 10) {
  const n = Number.parseInt(value ?? fallback, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseTaskIds(args = {}) {
  const raw = args.ids || args.id || '';
  const values = String(raw)
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return values.length ? values : null;
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const result = await executor.runPostMergeVerification({
    limit: parseLimit(args.limit),
    taskIds: parseTaskIds(args),
  });
  console.log(JSON.stringify(result, null, 2));
  return result;
}

if (require.main === module) {
  main()
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => db.destroy());
}

module.exports = {
  parseArgs,
  parseLimit,
  parseTaskIds,
  main,
};
