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

  consoleR.print(results, { verbose: FLAG.verbose });
  // The gate counts from the raw results, not the reporter — presentation
  // must never decide what blocks. severity is authoritative: a validator
  // can return pass:true with severity:'warning' (e.g. dynamic raw SQL).
  const gate = {
    critical: results.filter(r => r.severity === 'critical').length,
    warning: results.filter(r => r.severity === 'warning').length,
  };
  if (FLAG.json) {
    jsonR.write(results, FLAG.json);
    console.log(`\nJSON report → ${FLAG.json}`);
  }
  console.log(`\nRan ${results.length} checks in ${Date.now() - start}ms`);

  // Close the DB pool so the process can exit
  try { await require('../models/db').destroy(); } catch { /* ignore */ }

  if (DRY) {
    console.log(`[dry-run] ${gate.critical} critical, ${gate.warning} warnings — NOT blocking`);
    process.exit(0);
  }
  if (gate.critical > 0) {
    console.error(`[contract] ${gate.critical} critical failures — blocking deploy`);
    process.exit(1);
  }
  // Warnings block too (2026-07-16): the suite reached 0 warnings, so any
  // new one is a regression demanding an explicit decision — fix it, flag
  // sideEffects, or declare the contract in overrides/manual-contracts.js.
  // CONTRACT_ALLOW_WARNINGS=true is the local escape hatch while iterating.
  if (gate.warning > 0 && process.env.CONTRACT_ALLOW_WARNINGS !== 'true') {
    console.error(`[contract] ${gate.warning} warnings — blocking (fix, flag sideEffects, or declare in manual-contracts.js; CONTRACT_ALLOW_WARNINGS=true to bypass locally)`);
    process.exit(1);
  }
  console.log('[contract] all tools pass');
  process.exit(0);
})().catch(err => {
  console.error('[contract] runner crashed:', err);
  process.exit(2);
});
