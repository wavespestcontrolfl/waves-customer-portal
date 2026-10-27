// Catch-up decision for the weekly price scan: pure, driven by the job_health row.
const {
  decidePriceScanCatchUp,
  CATCH_UP_WINDOW_MS,
  STALLED_RUNNING_MS,
  MIN_GAP_AFTER_FINISH_MS,
  MAX_CONSECUTIVE_FAILURES,
} = require('../services/price-scan/catch-up');

const NOW = Date.parse('2026-10-26T14:20:00Z');
const ago = (ms) => new Date(NOW - ms);
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

const failedRow = (over = {}) => ({
  last_status: 'failed',
  last_started_at: ago(4 * HOUR),
  last_finished_at: ago(3 * HOUR),
  consecutive_failures: 1,
  ...over,
});

describe('decidePriceScanCatchUp', () => {
  test('no row, or no usable start time: no rerun', () => {
    expect(decidePriceScanCatchUp(null, NOW)).toEqual({ run: false, reason: 'no_row' });
    expect(decidePriceScanCatchUp(undefined, NOW).run).toBe(false);
    expect(decidePriceScanCatchUp({ last_status: 'failed', last_started_at: null }, NOW)).toEqual({ run: false, reason: 'no_start_time' });
    expect(decidePriceScanCatchUp({ last_status: 'failed', last_started_at: 'garbage' }, NOW).run).toBe(false);
  });

  test('a failed run that started inside 24 h reruns', () => {
    expect(decidePriceScanCatchUp(failedRow(), NOW)).toEqual({ run: true, reason: 'failed_recently' });
    expect(decidePriceScanCatchUp(failedRow({ last_started_at: ago(CATCH_UP_WINDOW_MS - MIN) }), NOW).run).toBe(true);
  });

  test('accepts ISO strings from the database as well as Dates', () => {
    const row = failedRow({ last_started_at: ago(4 * HOUR).toISOString(), last_finished_at: ago(3 * HOUR).toISOString() });
    expect(decidePriceScanCatchUp(row, NOW).run).toBe(true);
  });

  test('a failed run older than 24 h does not rerun', () => {
    expect(decidePriceScanCatchUp(failedRow({ last_started_at: ago(CATCH_UP_WINDOW_MS + MIN) }), NOW)).toEqual({ run: false, reason: 'too_old' });
  });

  test('a start time in the future never reruns', () => {
    expect(decidePriceScanCatchUp(failedRow({ last_started_at: new Date(NOW + HOUR) }), NOW).run).toBe(false);
  });

  test('a success or a clean skip never reruns', () => {
    expect(decidePriceScanCatchUp(failedRow({ last_status: 'success', consecutive_failures: 0 }), NOW)).toEqual({ run: false, reason: 'healthy' });
  });

  test('a failure that ended a few minutes ago waits for the next pass (rolling deploy)', () => {
    const row = failedRow({ last_started_at: ago(30 * MIN), last_finished_at: ago(MIN_GAP_AFTER_FINISH_MS - MIN) });
    expect(decidePriceScanCatchUp(row, NOW)).toEqual({ run: false, reason: 'too_soon' });
    expect(decidePriceScanCatchUp({ ...row, last_finished_at: ago(MIN_GAP_AFTER_FINISH_MS + MIN) }, NOW).run).toBe(true);
  });

  test('a failed row with no finish time (settled after a dead process) still reruns', () => {
    expect(decidePriceScanCatchUp(failedRow({ last_finished_at: null }), NOW).run).toBe(true);
  });

  test('stops after three failed reruns in a row', () => {
    for (let n = 1; n <= MAX_CONSECUTIVE_FAILURES; n += 1) {
      expect(decidePriceScanCatchUp(failedRow({ consecutive_failures: n }), NOW).run).toBe(true);
    }
    expect(decidePriceScanCatchUp(failedRow({ consecutive_failures: MAX_CONSECUTIVE_FAILURES + 1 }), NOW)).toEqual({ run: false, reason: 'attempts_exhausted' });
    expect(decidePriceScanCatchUp(failedRow({ consecutive_failures: null }), NOW).run).toBe(false);
  });

  test('a run still marked running after 3 h (killed before it recorded) reruns', () => {
    const row = { last_status: 'running', last_started_at: ago(STALLED_RUNNING_MS + MIN), last_finished_at: null, consecutive_failures: 0 };
    expect(decidePriceScanCatchUp(row, NOW)).toEqual({ run: true, reason: 'stalled_running' });
  });

  test('a run marked running for under 3 h is a normal 80-minute scan: leave it', () => {
    const row = { last_status: 'running', last_started_at: ago(80 * MIN), consecutive_failures: 0 };
    expect(decidePriceScanCatchUp(row, NOW)).toEqual({ run: false, reason: 'healthy' });
    expect(decidePriceScanCatchUp({ ...row, last_started_at: ago(STALLED_RUNNING_MS - MIN) }, NOW).run).toBe(false);
  });

  test('a stalled running row older than 24 h or past the failure cap does not rerun', () => {
    const base = { last_status: 'running', last_started_at: ago(STALLED_RUNNING_MS + HOUR), consecutive_failures: 0 };
    expect(decidePriceScanCatchUp({ ...base, last_started_at: ago(CATCH_UP_WINDOW_MS + MIN) }, NOW).run).toBe(false);
    expect(decidePriceScanCatchUp({ ...base, consecutive_failures: 4 }, NOW).run).toBe(false);
  });
});
