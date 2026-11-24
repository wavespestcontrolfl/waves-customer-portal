// The shared stale-stuck-visit rule (owner 2026-10-30) behind both cancel
// paths' customer confirmation: the admin Cancel plan path and the portal
// self-cancel. The route suites prove each caller's wiring; this pins the
// edges both rely on.
const { onlyStaleVisitErrorsLeft } = require('../services/cancellation-stale-visit-verdict');

const churned = (errors, staleIds) => ({ ok: false, churned: true, errors, staleInProgressVisitIds: staleIds });

describe('onlyStaleVisitErrorsLeft', () => {
  test('a churned run whose only errors are earlier-day stuck visits counts as wound down', () => {
    expect(onlyStaleVisitErrorsLeft(churned(['in_progress_visit:a', 'in_progress_visit:b'], ['a', 'b']))).toBe(true);
  });

  test('a scoped wind-down follows the same rule', () => {
    expect(onlyStaleVisitErrorsLeft({ ok: false, churned: false, scopedWoundDown: true,
      errors: ['in_progress_visit:a'], staleInProgressVisitIds: ['a'] })).toBe(true);
  });

  test('a visit live today, or any other error, is not covered', () => {
    expect(onlyStaleVisitErrorsLeft(churned(['in_progress_visit:a', 'in_progress_visit:today'], ['a']))).toBe(false);
    expect(onlyStaleVisitErrorsLeft(churned(['in_progress_visit:a', 'stop_recurrence'], ['a']))).toBe(false);
  });

  test('a run that did not wind the plan down is not covered', () => {
    expect(onlyStaleVisitErrorsLeft({ ok: false, churned: false, errors: ['in_progress_visit:a'], staleInProgressVisitIds: ['a'] })).toBe(false);
    expect(onlyStaleVisitErrorsLeft(null)).toBe(false);
  });

  test('no errors, or no stale list, is false: a clean run is the caller\'s own verdict', () => {
    expect(onlyStaleVisitErrorsLeft(churned([], []))).toBe(false);
    expect(onlyStaleVisitErrorsLeft({ ok: false, churned: true, errors: ['in_progress_visit:a'] })).toBe(false);
  });

  test('the caller\'s own error list wins over the processor\'s (the admin path adds its steps\' errors)', () => {
    const result = churned(['in_progress_visit:a'], ['a']);
    expect(onlyStaleVisitErrorsLeft(result, ['in_progress_visit:a', 'case_write'])).toBe(false);
    expect(onlyStaleVisitErrorsLeft(result, ['in_progress_visit:a'])).toBe(true);
  });
});
