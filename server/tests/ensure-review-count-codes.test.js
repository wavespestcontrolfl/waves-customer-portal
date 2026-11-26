/**
 * ops/agents/ensure-review-count-codes.js — the pure planning half: which reserved review short codes a run wants.
 * (The database half is a dry-run-default insert-only script and is not run here.)
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/short-url', () => ({ resolveShortCode: jest.fn() }));

const { planRows, parseTechArgs, unusableReason } = require('../../ops/agents/ensure-review-count-codes');
const { WAVES_LOCATIONS } = require('../config/locations');
const {
  TECH_SLUG_RE, REVIEW_GEO_FALLBACK_OFFICE_ID, reviewShortCodeForOffice, reviewShortCodeForTech,
} = require('../routes/review-geo-link');

const plan = (techs = []) => planRows({
  offices: WAVES_LOCATIONS, techs, techSlugRe: TECH_SLUG_RE, fallbackOfficeId: REVIEW_GEO_FALLBACK_OFFICE_ID,
});

describe('planRows', () => {
  test('wants one code per office, the same codes the route counts on', () => {
    const rows = plan();
    expect(rows.map((r) => r.code)).toEqual(WAVES_LOCATIONS.map((l) => reviewShortCodeForOffice(l.id)));
    expect(rows.map((r) => r.target_url)).toEqual(WAVES_LOCATIONS.map((l) => l.googleReviewUrl));
  });

  test('adds one code per tech, lowercased and de-duplicated, matching the route code', () => {
    const rows = plan(['Adam', 'adam', ' maria ']);
    const techRows = rows.slice(WAVES_LOCATIONS.length);
    expect(techRows.map((r) => r.code)).toEqual([reviewShortCodeForTech('adam'), reviewShortCodeForTech('maria')]);
    // A Google review form, never /rv/<slug>: the /l/<code> alias must not loop into /rv and count twice.
    const fallbackUrl = WAVES_LOCATIONS.find((l) => l.id === REVIEW_GEO_FALLBACK_OFFICE_ID).googleReviewUrl;
    for (const row of techRows) {
      expect(row.target_url).toBe(fallbackUrl);
      expect(row.target_url).not.toMatch(/\/rv\b/);
    }
  });

  test.each([['a'], ['1adam'], ['ad_am'], ['ad am'], ['adam/x'], ['']])('a bad slug %j is refused', (bad) => {
    expect(() => plan([bad])).toThrow(/not a valid slug/);
  });
});

describe('parseTechArgs', () => {
  test('reads repeated --tech and --tech=', () => {
    expect(parseTechArgs(['--execute', '--tech', 'adam', '--tech=maria'])).toEqual(['adam', 'maria']);
  });

  test.each([['--excute'], ['--tech-adam'], ['adam'], ['--dry-run']])('an unknown argument %j is refused', (arg) => {
    expect(() => parseTechArgs(['--tech', 'adam', arg])).toThrow(/unknown argument/);
  });

  test('no flag gives none', () => {
    expect(parseTechArgs(['--execute'])).toEqual([]);
  });

  test.each([[['--tech']], [['--tech', '--execute']]])('a --tech with no value is an error: %j', (argv) => {
    expect(() => parseTechArgs(argv)).toThrow(/needs a value/);
  });
});

describe('unusableReason', () => {
  const now = Date.parse('2026-11-25T12:00:00Z');
  const form = 'https://g.page/r/x/review';
  test('a live row aimed at the planned review form is ready', () => {
    expect(unusableReason({ expires_at: null, target_url: form }, form, now)).toBeNull();
    expect(unusableReason({ expires_at: '2027-01-01T00:00:00Z', target_url: form }, form, now)).toBeNull();
  });
  test('an expired row cannot count', () => {
    expect(unusableReason({ expires_at: '2026-11-01T00:00:00Z', target_url: form }, form, now)).toBe('expired');
  });
  test.each([
    ['loops into /rv', 'https://portal.wavespestcontrol.com/rv/adam'], ['another page', 'https://example.com/'], ['empty', null],
  ])('a row whose target %s is not ready', (_label, target) => {
    expect(unusableReason({ target_url: target }, form, now)).toBe('target is not the planned review form');
  });
});
