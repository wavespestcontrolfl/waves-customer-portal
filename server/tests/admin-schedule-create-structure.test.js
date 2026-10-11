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
  'bookingContext', 'runBookingStages', 'commitBooking', 'bookingErrorResponse', 'estimateLinkFlags', 'billingStampFacts',
  'requestStage', 'customerStage', 'propertyStage', 'callBookingStage', 'linkedEstimateStage', 'annualPrepayStage',
  'visitDurationStage', 'visitWindowStage', 'technicianStage', 'visitNotesStage', 'callbackStage', 'pricingStage',
  'priceStampStage', 'seriesFactsStage', 'seriesPlanStage',
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

  test('the create handler stays under the lint limit (20)', () => {
    expect(complexity.scheduleCreateHandler || 1).toBeLessThanOrEqual(20);
  });

  test.each(EXTRACTED)('%s stays under 20', (name) => {
    // The rule reports only above its threshold of 1, so an unreported function has complexity 1.
    expect(src).toMatch(new RegExp(`function ${name}\\(`));
    expect(complexity[name] || 1).toBeLessThan(20);
  });

  test('the booking transaction callback only orchestrates the three transaction operations, in order', () => {
    const start = src.indexOf('await db.transaction(async (trx) => {', src.indexOf('async function commitBooking('));
    const end = src.indexOf('\n  });', start);
    const calls = [...src.slice(start, end).matchAll(/await (\w+)\(trx/g)].map((m) => m[1]);
    expect(calls).toEqual(['lockBookingScope', 'insertSeriesRows', 'runInTransactionHooks']);
  });

  test('the handler runs the stage table, commits, answers, and leaves side effects to the hook table', () => {
    const handler = src.slice(src.indexOf('async function scheduleCreateHandler('), src.indexOf("router.post('/bulk-action'"));
    const body = handler.slice(0, handler.indexOf('\n}\n'));
    expect(body).toContain('runBookingStages(c)');
    expect(body).toContain('commitBooking(c)');
    expect(body).toContain('setImmediate(() => runPostInsertHooks(c))');
    expect(body).not.toMatch(/sendCardOnFileLink\(|db\(|req\.body/);
  });

  test('the stage table lists every preflight stage, in the order the request meets them', () => {
    const table = src.slice(src.indexOf('const BOOKING_STAGES = ['), src.indexOf('];', src.indexOf('const BOOKING_STAGES = [')));
    const names = table.replace(/^[^\n]*\n/, '').split(',').map((n) => n.trim()).filter(Boolean);
    expect(names).toEqual([
      'requestStage', 'customerStage', 'propertyStage', 'callBookingStage', 'linkedEstimateStage', 'annualPrepayStage',
      'visitDurationStage', 'visitWindowStage', 'technicianStage', 'visitNotesStage', 'callbackStage', 'pricingStage',
      'priceStampStage', 'seriesFactsStage', 'seriesPlanStage',
    ]);
  });
});
