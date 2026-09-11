// The Agents page's Route Planner card reads the newest three planner-runs
// ledger rows. Route-quality measurement snapshots (run_type
// schedule_quality_change, one per ordinary schedule edit once
// GATE_SCHEDULE_QUALITY_MEASUREMENTS is on) share that ledger and would crowd
// out a failed or lock-skipped nightly row — the exception the card exists to
// surface (codex #4295 r6 P2). Source-level pin: the read excludes them.
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '../routes/admin-agents.js'), 'utf8');

describe('loadPlannerRunTasks reads planner runs only', () => {
  const start = src.indexOf('async function loadPlannerRunTasks');
  const fn = src.slice(start, src.indexOf('\n}\n', start));

  test('the newest-three read excludes schedule_quality_change snapshots', () => {
    expect(start).toBeGreaterThan(-1);
    const query = fn.slice(fn.indexOf("db('route_optimization_planner_runs')"), fn.indexOf('.limit(3)'));
    expect(query).toContain(".whereNot('run_type', 'schedule_quality_change')");
    expect(query).toContain(".orderBy('created_at', 'desc')");
  });

  test('the snapshot writer and the card reader name the same run_type', () => {
    const writer = fs.readFileSync(path.join(__dirname, '../services/scheduling/quality-after-change.js'), 'utf8');
    expect(writer).toContain("run_type: 'schedule_quality_change'");
  });
});
