/**
 * Event-source health — zero-yield detection + failure escalation.
 *
 * The starvation this guards against: 15 of 25 enabled sources had
 * NEVER produced an event while reporting last_pull_status='success',
 * and 5 more sat at 11–47 consecutive failures with no escalation.
 */

const {
  FAILURE_ALERT_THRESHOLD,
  ZERO_YIELD_ALERT_THRESHOLD,
  REPING_EVERY_RUNS,
  yieldTrackingUpdateFor,
  classifyUnhealthySources,
  formatSourceHealthLines,
} = require('../services/event-source-health');

describe('event-source-health yieldTrackingUpdateFor', () => {
  test('a yielding pull resets the zero-yield streak and stamps last_nonzero_yield_at', () => {
    const u = yieldTrackingUpdateFor(12);
    expect(u.last_yield_count).toBe(12);
    expect(u.consecutive_zero_yields).toBe(0);
    expect(u.last_nonzero_yield_at).toBeDefined();
  });

  test('an empty pull increments the streak in SQL and does NOT touch last_nonzero_yield_at', () => {
    const u = yieldTrackingUpdateFor(0);
    expect(u.last_yield_count).toBe(0);
    expect(u.last_nonzero_yield_at).toBeUndefined();
    // increment must be a raw expression (server-side +1), not a literal
    const sql = u.consecutive_zero_yields.toSQL().sql.toLowerCase();
    expect(sql).toContain('consecutive_zero_yields + 1');
  });

  test('non-numeric yield counts behave as zero', () => {
    const u = yieldTrackingUpdateFor(undefined);
    expect(u.last_yield_count).toBe(0);
    expect(u.last_nonzero_yield_at).toBeUndefined();
  });
});

describe('event-source-health classifyUnhealthySources', () => {
  const src = (over = {}) => ({
    name: 'Test Source', enabled: true, consecutive_failures: 0, consecutive_zero_yields: 0, ...over,
  });

  test('healthy sources classify empty', () => {
    const r = classifyUnhealthySources([src(), src({ consecutive_zero_yields: 3 }), src({ consecutive_failures: 2 })]);
    expect(r.failing).toHaveLength(0);
    expect(r.zeroYield).toHaveLength(0);
    expect(r.alerting).toHaveLength(0);
  });

  test('failures at threshold alert; zero-yield at threshold alerts', () => {
    const failing = src({ name: 'F', consecutive_failures: FAILURE_ALERT_THRESHOLD });
    const empty = src({ name: 'Z', consecutive_zero_yields: ZERO_YIELD_ALERT_THRESHOLD });
    const r = classifyUnhealthySources([failing, empty]);
    expect(r.failing.map((s) => s.name)).toEqual(['F']);
    expect(r.zeroYield.map((s) => s.name)).toEqual(['Z']);
    expect(r.alerting.map((s) => s.name).sort()).toEqual(['F', 'Z']);
  });

  test('past threshold but off the weekly re-ping cadence: unhealthy but not alerting', () => {
    const r = classifyUnhealthySources([
      src({ name: 'F', consecutive_failures: FAILURE_ALERT_THRESHOLD + 1 }),
      src({ name: 'Z', consecutive_zero_yields: ZERO_YIELD_ALERT_THRESHOLD + 2 }),
    ]);
    expect(r.failing).toHaveLength(1);
    expect(r.zeroYield).toHaveLength(1);
    expect(r.alerting).toHaveLength(0);
  });

  test('long-broken sources re-alert on the weekly cadence (incl. pre-existing breakage)', () => {
    // e.g. threshold 3 + 7 = 10, +14 = 17 …
    const again = FAILURE_ALERT_THRESHOLD + REPING_EVERY_RUNS;
    const r = classifyUnhealthySources([src({ name: 'F', consecutive_failures: again })]);
    expect(r.alerting.map((s) => s.name)).toEqual(['F']);
  });

  test('a hard-failing source is not double-counted as zero-yield', () => {
    const both = src({
      name: 'B',
      consecutive_failures: FAILURE_ALERT_THRESHOLD,
      consecutive_zero_yields: ZERO_YIELD_ALERT_THRESHOLD,
    });
    const r = classifyUnhealthySources([both]);
    expect(r.failing).toHaveLength(1);
    expect(r.zeroYield).toHaveLength(0);
  });

  test('disabled sources are ignored', () => {
    const r = classifyUnhealthySources([
      src({ enabled: false, consecutive_failures: 47 }),
    ]);
    expect(r.failing).toHaveLength(0);
    expect(r.alerting).toHaveLength(0);
  });
});

describe('event-source-health formatSourceHealthLines', () => {
  test('names each source with its streak; first line of last_error only, truncated', () => {
    const lines = formatSourceHealthLines({
      failing: [{ name: 'Charlotte PAC', consecutive_failures: 47, last_error: 'getaddrinfo ENOTFOUND charlottepac.com\nat lookup...' }],
      zeroYield: [{ name: 'City of Venice', consecutive_zero_yields: 9 }],
    });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('Charlotte PAC: 47 consecutive failed pulls');
    expect(lines[0]).toContain('ENOTFOUND');
    expect(lines[0]).not.toContain('at lookup');
    expect(lines[1]).toBe('- City of Venice: pulls succeed but 0 events for 9 runs');
  });
});

describe('event_sources_unhealthy notification trigger', () => {
  test('is registered with high priority in the newsletter category', () => {
    const { listTriggers } = require('../services/notification-triggers');
    const t = listTriggers().find((x) => x.key === 'event_sources_unhealthy');
    expect(t).toBeDefined();
    expect(t.priority).toBe('high');
  });
});

describe('newsletter formatPreflightReport — source health section', () => {
  const { formatPreflightReport } = require('../services/newsletter-autopilot');
  const report = { hardFailures: ['Eligible fresh approved events: 0 / required 5'], warnings: [] };

  test('includes a Source health section when lines are provided', () => {
    const body = formatPreflightReport(report, '2026-06-11', ['- The Gabber: 13 consecutive failed pulls']);
    expect(body).toContain('Source health:');
    expect(body).toContain('- The Gabber: 13 consecutive failed pulls');
    // section sits before Next actions
    expect(body.indexOf('Source health:')).toBeLessThan(body.indexOf('Next actions:'));
  });

  test('omits the section (and stays backward compatible) without lines', () => {
    const body = formatPreflightReport(report, '2026-06-11');
    expect(body).not.toContain('Source health:');
    expect(body).toContain('Next actions:');
  });
});
