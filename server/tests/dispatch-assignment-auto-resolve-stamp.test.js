// Source-pattern guard (house style — see admin-dispatch-rearm-reminders.js's
// "reschedule route sync->capture->emit ordering (source)" describe block):
// assignDispatchJob's DB dependency graph is large enough that driving the
// unassigned -> assigned reassignment branch through a full integration
// test is disproportionate to a one-argument fix. The behavior itself
// (auto: true actually stamps payload.superseded_at) is proven directly by
// dispatch-alerts-auto-resolve.test.js against the shared resolveAlert
// primitive this call site invokes.
//
// codex P1, pre-push audit on 925e9e977: assigning a technician to a
// previously-unassigned job resolves any open unassigned_overdue alerts for
// it as a side effect — not a dispatcher acknowledging the alert card
// itself. Without auto: true, no-show-detector.js's alreadyHasOpenAlert
// treats the resolved row as a human ack and permanently blocks a fresh
// unassigned_overdue alert if the visit is unassigned again later under
// the same tracking key.
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '../services/dispatch-assignment.js'), 'utf8');

describe('dispatch-assignment.js: reassignment clears unassigned_overdue as an automatic resolve', () => {
  test('the unassigned_overdue resolve on reassignment passes auto: true', () => {
    const blockStart = src.indexOf("type: 'unassigned_overdue', job_id: jobId");
    expect(blockStart).toBeGreaterThan(-1);
    const resolveCallStart = src.indexOf('await resolveAlert(', blockStart);
    const resolveCallEnd = src.indexOf(');', resolveCallStart);
    const resolveCall = src.slice(resolveCallStart, resolveCallEnd);
    expect(resolveCall).toContain('auto: true');
  });
});
