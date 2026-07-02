/**
 * Marketing-attribution fresh-start floor.
 *
 * The four hub city-page tracking numbers were also the GBP-listed lines until
 * the dedicated per-profile GBP tracking numbers went live 2026-06-28, and
 * per-source monthly costs were only corrected 2026-07-01 — so attribution
 * windows reaching before the baseline average known-wrong history into the
 * Marketing Attribution card. The floor clips every window (period presets AND
 * custom ?from= lookbacks) at the baseline.
 */

const fs = require('fs');
const path = require('path');

const {
  DEFAULT_ATTRIBUTION_FRESH_START,
  resolveAttributionFreshStart,
  applyAttributionFreshStart,
} = require('../utils/attribution-fresh-start');

describe('resolveAttributionFreshStart', () => {
  test('defaults to 2026-07-01 (GBP split live 6/28 + costs corrected 7/1)', () => {
    expect(resolveAttributionFreshStart(undefined)).toBe('2026-07-01');
    expect(DEFAULT_ATTRIBUTION_FRESH_START).toBe('2026-07-01');
  });

  test('accepts a valid override date', () => {
    expect(resolveAttributionFreshStart('2026-08-15')).toBe('2026-08-15');
  });

  test('empty env disables the floor', () => {
    expect(resolveAttributionFreshStart('')).toBeNull();
  });

  test('malformed values fail open (no floor)', () => {
    expect(resolveAttributionFreshStart('yesterday')).toBeNull();
    expect(resolveAttributionFreshStart('2026-7-1')).toBeNull();
    expect(resolveAttributionFreshStart('2026-07-01T00:00')).toBeNull();
  });

  test('a non-existent calendar date fails open instead of rolling over', () => {
    // Date.UTC rolls 2026-02-30 over to Mar 2; the round-trip guard must
    // reject it so a typoed env cannot apply a silently-wrong March cutoff.
    expect(resolveAttributionFreshStart('2026-02-30')).toBeNull();
    expect(resolveAttributionFreshStart('2026-13-01')).toBeNull();
  });
});

describe('applyAttributionFreshStart', () => {
  const win = { from: '2026-01-01', to: '2026-07-02', label: 'Year to Date' };

  test('floors a window that reaches before the baseline and labels the clip', () => {
    const floored = applyAttributionFreshStart(win, '2026-07-01');
    expect(floored.from).toBe('2026-07-01');
    expect(floored.to).toBe('2026-07-02');
    expect(floored.freshStart).toBe('2026-07-01');
    expect(floored.label).toBe('Year to Date (data since 2026-07-01)');
    // input window is not mutated
    expect(win.from).toBe('2026-01-01');
  });

  test('leaves a window starting on/after the baseline untouched', () => {
    const mtd = { from: '2026-07-01', to: '2026-07-02', label: 'Month to Date' };
    expect(applyAttributionFreshStart(mtd, '2026-07-01')).toBe(mtd);
    const later = { from: '2026-07-02', to: '2026-07-02', label: 'Today' };
    expect(applyAttributionFreshStart(later, '2026-07-01')).toBe(later);
  });

  test('no-op when the floor is disabled or the window is malformed', () => {
    expect(applyAttributionFreshStart(win, null)).toBe(win);
    expect(applyAttributionFreshStart(null, '2026-07-01')).toBeNull();
    expect(applyAttributionFreshStart({ to: '2026-07-02' }, '2026-07-01')).toEqual({ to: '2026-07-02' });
  });

  test('also clips an explicit custom lookback (?from=) — pre-baseline data is known-wrong under any window', () => {
    const custom = { from: '2026-06-01', to: '2026-07-02', label: 'Since 2026-06-01' };
    const floored = applyAttributionFreshStart(custom, '2026-07-01');
    expect(floored.from).toBe('2026-07-01');
    expect(floored.label).toBe('Since 2026-06-01 (data since 2026-07-01)');
  });

  test('a label-less window (the reconciliation script shape) clips + stamps without minting a bogus label', () => {
    const bare = { from: '2026-01-01', to: '2026-07-02' };
    const floored = applyAttributionFreshStart(bare, '2026-07-01');
    expect(floored.from).toBe('2026-07-01');
    expect(floored.freshStart).toBe('2026-07-01');
    expect(floored.label).toBeUndefined();
  });
});

// Route wiring guards (house style — see attribution-funnel-wiring.test.js):
// pin the floor inside resolveAttributionWindow so a refactor can't silently
// drop it from the three attribution endpoints that share the resolver.
describe('admin-dashboard attribution window wiring', () => {
  const src = fs.readFileSync(path.join(__dirname, '../routes/admin-dashboard.js'), 'utf8');

  test('resolves the floor once at module scope from the env-driven helper', () => {
    expect(src).toMatch(/const ATTRIBUTION_FRESH_START = resolveAttributionFreshStart\(\)/);
  });

  test('every attribution window passes through the floor', () => {
    expect(src).toMatch(/return applyAttributionFreshStart\(win, ATTRIBUTION_FRESH_START\)/);
  });
});

// The prod reconciliation script mirrors the widget's windows by hand, so it
// must carry the same floor or its ytd/wtd counts stop reconciling with the
// dashboard (Codex P3 on #2265). "all" intentionally stays raw.
describe('dump-unmapped-call-numbers script wiring', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '../scripts/dump-unmapped-call-numbers.js'),
    'utf8',
  );

  test('shares the env-driven floor helper', () => {
    expect(src).toMatch(/const ATTRIBUTION_FRESH_START = resolveAttributionFreshStart\(\)/);
  });

  test('every non-"all" window passes through the floor', () => {
    expect(src).toMatch(/return applyAttributionFreshStart\(win, ATTRIBUTION_FRESH_START\)/);
    expect(src).toMatch(/if \(period === 'all'\) return null/);
  });
});
