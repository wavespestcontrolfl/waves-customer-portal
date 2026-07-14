// #2717 server hardening: terminal visit statuses are one-way. Both status
// routes (admin-dispatch, admin-schedule) consult this helper BEFORE any
// transition machinery, so a stale board on a second device can never flip
// a completed/cancelled/skipped visit into a contradictory terminal state.
// no_show is deliberately NOT covered here — the routes keep their bespoke
// already_no_show / no_show_wrong_route blocks with pre-existing codes.
const { evaluateTerminalTransition } = require('../services/job-status');

describe('evaluateTerminalTransition', () => {
  test('completed → cancelled conflicts (the two-device compliance flip)', () => {
    expect(evaluateTerminalTransition('completed', 'cancelled')).toEqual({
      conflict: true,
      status: 'completed',
    });
  });

  test('cancelled → confirmed conflicts (no un-cancel flow exists)', () => {
    expect(evaluateTerminalTransition('cancelled', 'confirmed')).toEqual({
      conflict: true,
      status: 'cancelled',
    });
  });

  test('skipped → completed conflicts', () => {
    expect(evaluateTerminalTransition('skipped', 'completed')).toEqual({
      conflict: true,
      status: 'skipped',
    });
  });

  test('cancelled → completed conflicts (stale CompletionPanel submit after another dispatcher cancelled)', () => {
    // The /complete submit path consults this guard too (Codex round-2 P1)
    // — the PUT /status guard alone left completion submits able to flip a
    // cancelled/skipped visit back to completed and run the full completion
    // machinery.
    expect(evaluateTerminalTransition('cancelled', 'completed')).toEqual({
      conflict: true,
      status: 'cancelled',
    });
  });

  test('re-sending the same terminal status passes through — retries must rerun the route\'s idempotent post-commit effects', () => {
    expect(evaluateTerminalTransition('completed', 'completed')).toBeNull();
    expect(evaluateTerminalTransition('cancelled', 'cancelled')).toBeNull();
    expect(evaluateTerminalTransition('skipped', 'skipped')).toBeNull();
  });

  test('status comparison is case-insensitive', () => {
    expect(evaluateTerminalTransition('Completed', 'COMPLETED')).toBeNull();
    expect(evaluateTerminalTransition('COMPLETED', 'cancelled')).toEqual({
      conflict: true,
      status: 'completed',
    });
  });

  test.each(['pending', 'confirmed', 'rescheduled', 'en_route', 'on_site'])(
    'active status %s passes through untouched',
    (from) => {
      expect(evaluateTerminalTransition(from, 'cancelled')).toBeNull();
    },
  );

  test('no_show passes through — the routes own its bespoke guards', () => {
    expect(evaluateTerminalTransition('no_show', 'cancelled')).toBeNull();
  });

  test('missing/empty fromStatus passes through', () => {
    expect(evaluateTerminalTransition(null, 'cancelled')).toBeNull();
    expect(evaluateTerminalTransition('', 'cancelled')).toBeNull();
    expect(evaluateTerminalTransition(undefined, 'cancelled')).toBeNull();
  });
});
