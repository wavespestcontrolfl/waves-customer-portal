// Check → destination map for the ops-crons ingest route
// (admin-alerts-brevity scope, owner ruling 2026-09-28).

const {
  ACTIVITY_LINK, checkId, humanizeCheckId, resolveRoute, routeFor, dataHygieneHeadline, dataHygieneCounts,
} = require('../config/ops-alert-routes');

describe('checkId', () => {
  test('the part of the key before its first colon', () => {
    expect(checkId('e22-schedule-integrity:overlaps-2026-09-11')).toBe('e22-schedule-integrity');
    expect(checkId('local:data-hygiene_sweep_1_fixed_63_exceptions_0_new_')).toBe('local');
  });
  test('a key with no colon is its own id', () => {
    expect(checkId('bare-key')).toBe('bare-key');
  });
});

describe('humanizeCheckId', () => {
  test('drops a leading letter+digits code and title-cases the first word only', () => {
    expect(humanizeCheckId('e40-my-new-check')).toBe('My new check');
    expect(humanizeCheckId('c01-job-health')).toBe('Job health');
  });
  test('an id with no leading code still humanizes', () => {
    expect(humanizeCheckId('unassigned_check')).toBe('Unassigned check');
  });
  test('empty/absent falls back to a generic area', () => {
    expect(humanizeCheckId('')).toBe('Ops');
    expect(humanizeCheckId(undefined)).toBe('Ops');
  });
});

describe('routeFor — owner checks', () => {
  test.each([
    ['d15-voicemail-callbacks', 'Calls', '/admin/communications'],
    ['d19-committed-bookings', 'Schedule', '/admin/dispatch'],
    ['e22-schedule-integrity', 'Schedule', '/admin/dispatch'],
    ['b08-uncharged-collectibles', 'Billing', '/admin/invoices'],
    ['c10-membership-truth', 'Members', '/admin/customers'],
    ['d16-drafts-pipeline-aging', 'Drafts', '/admin/communications'],
  ])('%s -> owner audience, area %s, link %s', (id, area, link) => {
    const r = routeFor(`${id}:some-suffix`, 'ACT');
    expect(r).toMatchObject({ area, link, audience: 'owner' });
  });

  test('e36-property-links has no dedicated admin page yet — falls back to the Activity feed', () => {
    const r = routeFor('e36-property-links:x', 'ACT');
    expect(r).toMatchObject({ area: 'Properties', link: ACTIVITY_LINK, audience: 'owner' });
  });

  test('the data-hygiene sweep matches by regex on the FULL key (no plain check id)', () => {
    const r = routeFor('local:data-hygiene_sweep_2_fixed_66_exceptions_2_new_', 'ACT');
    expect(r).toMatchObject({ area: 'Data hygiene', link: ACTIVITY_LINK, audience: 'owner' });
    expect(typeof r.headline).toBe('function');
    expect(typeof r.counts).toBe('function');
  });
});

describe('dataHygieneCounts (admin-alerts-ring scope)', () => {
  test('parses the open backlog and the new-issue count from the subject', () => {
    expect(dataHygieneCounts('data-hygiene sweep — 3 fixed, 66 exceptions (2 new)')).toEqual({ count: 66, newCount: 2 });
  });
  test('"0 new" still parses — the ring test is what makes it go quiet', () => {
    expect(dataHygieneCounts('data-hygiene sweep — 1 fixed, 63 exceptions (0 new)')).toEqual({ count: 63, newCount: 0 });
  });
  test('a non-matching subject returns null, same as dataHygieneHeadline', () => {
    expect(dataHygieneCounts('something else entirely')).toBeNull();
  });
  test('routeFor exposes it on the data-hygiene entry, wired to the caller\'s subject', () => {
    const r = routeFor('local:data-hygiene_sweep_x', 'ACT');
    expect(r.counts('data-hygiene sweep — 1 fixed, 63 exceptions (0 new)')).toEqual({ count: 63, newCount: 0 });
  });
});

describe('routeFor — engineering checks (Activity-only)', () => {
  test.each([
    'c01-job-health', 'c19-prefs-reconciler', 'c32-gate-drift', 'c35-error-signatures',
    'd14-sms-delivery', 'd17-duplicate-sends', 'd18-suppression-sync',
  ])('%s -> engineering audience, Activity feed link', (id) => {
    const r = routeFor(`${id}:suffix`, 'FIX');
    expect(r.audience).toBe('engineering');
    expect(r.link).toBe(ACTIVITY_LINK);
  });
});

describe('routeFor — unknown checks', () => {
  test('ACT -> owner, humanized area, Activity feed', () => {
    const r = routeFor('z99-brand-new-check:x', 'ACT');
    expect(r).toEqual({ area: 'Brand new check', link: ACTIVITY_LINK, audience: 'owner', headline: null, counts: null });
  });
  test('FIX -> engineering, humanized area, Activity feed', () => {
    const r = routeFor('z99-brand-new-check:x', 'FIX');
    expect(r.audience).toBe('engineering');
  });
});

describe('resolveRoute', () => {
  test('returns null for an unmapped check', () => {
    expect(resolveRoute('nope-not-mapped')).toBeNull();
  });
});

describe('dataHygieneHeadline — real prod subjects', () => {
  test('some new issues: leads with the new count', () => {
    expect(dataHygieneHeadline('data-hygiene sweep — 3 fixed, 66 exceptions (2 new)'))
      .toBe('Data hygiene — 2 new issues, 66 open');
  });
  test('zero new: leads with "none new"', () => {
    expect(dataHygieneHeadline('data-hygiene sweep — 1 fixed, 63 exceptions (0 new)'))
      .toBe('Data hygiene — 63 open issues, none new');
  });
  test('singular counts read naturally', () => {
    expect(dataHygieneHeadline('data-hygiene sweep — 1 fixed, 1 exceptions (1 new)'))
      .toBe('Data hygiene — 1 new issue, 1 open');
  });
  test('headline stays at or under 60 chars for realistic counts', () => {
    const h = dataHygieneHeadline('data-hygiene sweep — 3 fixed, 66 exceptions (2 new)');
    expect(h.length).toBeLessThanOrEqual(60);
  });
  test('a subject that does not match the shape returns null (generic fallback applies)', () => {
    expect(dataHygieneHeadline('something else entirely')).toBeNull();
    expect(dataHygieneHeadline('')).toBeNull();
    expect(dataHygieneHeadline(undefined)).toBeNull();
  });
});
