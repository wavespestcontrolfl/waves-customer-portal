/**
 * The admin booking create (POST /api/admin/schedule) is a short orchestration over named operations, not one
 * 250-line handler around a 200-line transaction callback. This pins the shape: the handler and every
 * operation extracted from it stay under a complexity budget, and the transaction callback only runs the three
 * transaction operations in order.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const FILE = path.join(__dirname, '../routes/admin-schedule.js');
const src = fs.readFileSync(FILE, 'utf8');

const EXTRACTED = [
  'bookingRequestRefusal', 'bookingWindowFromBody', 'separateProgramRefusal', 'resolveBookingProperty',
  'duplicateSeriesPreflightRefusal', 'loadLinkedEstimate', 'linkedEstimateGateRefusal', 'retiredTreeShrubRefusal',
  'linkedEstimatePreflight', 'retiredServiceRefusal', 'resolveAnnualPrepay', 'prepayDecisionFacts', 'quotedRecurringPlan',
  'overlappingPrepayTerm', 'planSeriesDates', 'planChildDates', 'planBoosterDates', 'unbillableSeriesRefusal',
  'lockBookingScope', 'insertParentRow', 'insertSeriesRows', 'insertSeriesVisit', 'runInTransactionHooks',
  'runPostInsertHooks', 'bookingResponse', 'runStampGroups', 'stampParentInsertColumns',
];

describe('admin booking create structure', () => {
  let complexity;
  beforeAll(() => {
    // ESLint loads its config through a dynamic import jest cannot run in-process: lint in a child.
    const run = spawnSync(process.execPath, [
      path.join(__dirname, '../../node_modules/eslint/bin/eslint.js'), '--rule', '{"complexity":["warn",1]}', '-f', 'json', FILE,
    ], { cwd: path.join(__dirname, '../..'), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const [result] = JSON.parse(run.stdout);
    complexity = {};
    for (const m of result.messages) {
      const hit = m.ruleId === 'complexity' && /unction '([^']+)' has a complexity of (\d+)/.exec(m.message);
      if (hit) complexity[hit[1]] = Number(hit[2]);
    }
  }, 180000);

  test('the create handler stays under 100', () => {
    expect(complexity.scheduleCreateHandler).toBeLessThan(100);
  });

  test.each(EXTRACTED)('%s stays under 20', (name) => {
    // The rule reports only above its threshold of 1, so an unreported function has complexity 1.
    expect(src).toMatch(new RegExp(`function ${name}\\(`));
    expect(complexity[name] || 1).toBeLessThan(20);
  });

  test('the booking transaction callback only orchestrates the three transaction operations, in order', () => {
    const start = src.indexOf('await db.transaction(async (trx) => {', src.indexOf('async function scheduleCreateHandler('));
    const end = src.indexOf('\n    });', start);
    const body = src.slice(start, end);
    const calls = [...body.matchAll(/await (\w+)\(trx/g)].map((m) => m[1]);
    expect(calls).toEqual(['lockBookingScope', 'insertSeriesRows', 'runInTransactionHooks']);
  });

  test('post-commit side effects run from the hook table, not inline in the handler', () => {
    const handler = src.slice(src.indexOf('async function scheduleCreateHandler('), src.indexOf("router.post('/bulk-action'"));
    expect(handler).toContain('runPostInsertHooks(bookingCtx)');
    expect(handler).not.toMatch(/sendCardOnFileLink\(/);
  });
});
