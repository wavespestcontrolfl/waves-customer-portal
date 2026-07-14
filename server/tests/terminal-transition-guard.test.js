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

  test('re-sending the same terminal status is idempotent, not a conflict', () => {
    expect(evaluateTerminalTransition('completed', 'completed')).toEqual({
      idempotent: true,
      status: 'completed',
    });
    expect(evaluateTerminalTransition('cancelled', 'cancelled')).toEqual({
      idempotent: true,
      status: 'cancelled',
    });
    expect(evaluateTerminalTransition('skipped', 'skipped')).toEqual({
      idempotent: true,
      status: 'skipped',
    });
  });

  test('status comparison is case-insensitive', () => {
    expect(evaluateTerminalTransition('Completed', 'COMPLETED')).toEqual({
      idempotent: true,
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
