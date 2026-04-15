#!/usr/bin/env node
/**
 * Contract-test runner.
 *
 * Usage:
 *   node server/contract-tests/index.js            # run all validators, block on critical
 *   CONTRACT_DRY_RUN=true node server/contract-tests/index.js
 *   node server/contract-tests/index.js --list     # list discovered tools, exit
 *   node server/contract-tests/index.js --verbose  # include info-level lines
 *   node server/contract-tests/index.js --json out.json
 */

const registry = require('./registry');
const schemaV = require('./validators/schema');
const dbV = require('./validators/db-columns');
const execV = require('./validators/execute-smoke');
const shapeV = require('./validators/response-shape');
const consoleR = require('./reporters/console');
const jsonR = require('./reporters/json');

const argv = process.argv.slice(2);
const FLAG = {
  list: argv.includes('--list'),
  verbose: argv.includes('--verbose') || argv.includes('-v'),
  skipExec: argv.includes('--skip-exec'),
  json: argv.includes('--json') ? argv[argv.indexOf('--json') + 1] : null,
};
const DRY = process.env.CONTRACT_DRY_RUN === 'true';

(async () => {
  const start = Date.now();
  const tools = await registry.discover();
  console.log(`Discovered ${tools.length} tools across ${new Set(tools.map(t => t.surface)).size} surfaces:`);
  const bySurface = tools.reduce((m, t) => { m[t.surface] = (m[t.surface] || 0) + 1; return m; }, {});
  for (const [s, n] of Object.entries(bySurface)) console.log(`  ${s.padEnd(24)} ${n}`);

  if (FLAG.list) {
    for (const t of tools) console.log(`  ${t.surface.padEnd(24)} ${t.name}`);
    process.exit(0);
  }

  const validators = [schemaV, dbV];
  if (!FLAG.skipExec) validators.push(execV, shapeV);

  const results = [];
  for (const tool of tools) {
    for (const v of validators) {
      try {
        results.push(await v.run(tool));
      } catch (e) {
        results.push({
          validator: v.name || 'unknown',
          tool: tool.name,
          surface: tool.surface,
          pass: false,
          severity: 'warning',
          errors: [`validator threw: ${e.message}`],
        });
      }
    }
  }

  const summary = consoleR.print(results, { verbose: FLAG.verbose });
  if (FLAG.json) {
    jsonR.write(results, FLAG.json);
    console.log(`\nJSON report → ${FLAG.json}`);
  }
  console.log(`\nRan ${results.length} checks in ${Date.now() - start}ms`);

  // Close the DB pool so the process can exit
  try { await require('../models/db').destroy(); } catch { /* ignore */ }

  if (DRY) {
    console.log(`[dry-run] ${summary.critical} critical, ${summary.warning} warnings — NOT blocking`);
    process.exit(0);
  }
  if (summary.critical > 0) {
    console.error(`[contract] ${summary.critical} critical failures — blocking deploy`);
    process.exit(1);
  }
  console.log('[contract] all tools pass');
  process.exit(0);
})().catch(err => {
  console.error('[contract] runner crashed:', err);
  process.exit(2);
});
