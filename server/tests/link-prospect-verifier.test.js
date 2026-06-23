const { _test } = require('../services/seo/link-prospect-verifier');

describe('link prospect verifier target matching', () => {
  test('matches backlinks only when they target the intended prospect page', () => {
    const prospect = {
      target_page: 'https://wavespestcontrol.com/wdo-inspection/',
    };

    expect(_test.backlinkTargetsProspect({
      target_url: 'https://www.wavespestcontrol.com/wdo-inspection/',
    }, prospect)).toBe(true);

    expect(_test.backlinkTargetsProspect({
      target_url: 'https://wavespestcontrol.com/wdo-inspection?utm_source=partner',
    }, prospect)).toBe(true);

    expect(_test.backlinkTargetsProspect({
      target_url: 'https://wavespestcontrol.com/wdo-inspection#form',
    }, prospect)).toBe(true);

    expect(_test.backlinkTargetsProspect({
      target_url: 'https://wavespestcontrol.com/',
    }, prospect)).toBe(false);

    expect(_test.backlinkTargetsProspect({
      target_url: 'https://wavespestcontrol.com/pest-control-bradenton-fl/',
    }, prospect)).toBe(false);
  });

  test('runner-cited rows (quality_signals.cited_homepage) reconcile against the HOMEPAGE, not target_page', () => {
    const runnerCitation = { link_type: 'citation', target_page: 'https://wavespestcontrol.com/wdo-inspection/', quality_signals: { cited_homepage: true } };
    // a homepage backlink — what the runner's citation actually creates → matches
    expect(_test.backlinkTargetsProspect({ target_url: 'https://wavespestcontrol.com/' }, runnerCitation)).toBe(true);
    expect(_test.backlinkTargetsProspect({ target_url: 'https://www.wavespestcontrol.com' }, runnerCitation)).toBe(true);
    expect(_test.backlinkTargetsProspect({ target_url: 'https://wavespestcontrol.com/wdo-inspection/' }, runnerCitation)).toBe(false);
  });

  test('a MANUAL directory row (same link_type, no cited_homepage flag) still verifies against its money page', () => {
    const manual = { link_type: 'directory', target_page: 'https://wavespestcontrol.com/wdo-inspection/' }; // no quality_signals flag
    expect(_test.backlinkTargetsProspect({ target_url: 'https://wavespestcontrol.com/wdo-inspection/' }, manual)).toBe(true);
    expect(_test.backlinkTargetsProspect({ target_url: 'https://wavespestcontrol.com/' }, manual)).toBe(false);
  });

  test('expectedTargetUrl: homepage ONLY when cited_homepage is flagged; else target_page', () => {
    expect(_test.expectedTargetUrl({ link_type: 'citation', target_page: 'https://wavespestcontrol.com/x', quality_signals: { cited_homepage: true } })).toBe('https://wavespestcontrol.com');
    expect(_test.expectedTargetUrl({ link_type: 'directory', target_page: 'https://wavespestcontrol.com/x' })).toBe('https://wavespestcontrol.com/x'); // manual directory → money page
    expect(_test.expectedTargetUrl({ link_type: 'editorial', target_page: 'https://wavespestcontrol.com/wdo' })).toBe('https://wavespestcontrol.com/wdo');
  });

  test('normalizes comparable URLs consistently', () => {
    expect(_test.normalizeComparableUrl('https://www.wavespestcontrol.com/wdo-inspection/'))
      .toBe('wavespestcontrol.com/wdo-inspection');
  });

  test('source URL reconcile SQL does not contain raw question-mark regex placeholders', () => {
    expect(_test.SOURCE_URL_COMPARABLE_SQL).not.toContain('?');
    expect(_test.SOURCE_URL_COMPARABLE_SQL).toContain("'^https://'");
    expect(_test.SOURCE_URL_COMPARABLE_SQL).toContain("'^http://'");
  });

  test('matches target URLs with true URL boundaries only', () => {
    const expected = 'wavespestcontrol.com/wdo-inspection';
    expect(_test.matchesTargetUrl('wavespestcontrol.com/wdo-inspection?utm=1', expected)).toBe(true);
    expect(_test.matchesTargetUrl('wavespestcontrol.com/wdo-inspection#form', expected)).toBe(true);
    expect(_test.matchesTargetUrl('wavespestcontrol.com/wdo-inspection/subpage', expected)).toBe(true);
    expect(_test.matchesTargetUrl('wavespestcontrol.com/wdo-inspection-extra', expected)).toBe(false);
  });

  test('root/homepage target does not match arbitrary subpages', () => {
    const root = _test.normalizeComparableUrl('https://wavespestcontrol.com/'); // -> 'wavespestcontrol.com'
    expect(_test.matchesTargetUrl('wavespestcontrol.com', root)).toBe(true);
    expect(_test.matchesTargetUrl('wavespestcontrol.com?utm=1', root)).toBe(true);
    expect(_test.matchesTargetUrl('wavespestcontrol.com#form', root)).toBe(true);
    // Homepage hit with the slash retained before a query/fragment (stripUrl only
    // trims trailing slashes) must still match.
    expect(_test.matchesTargetUrl('wavespestcontrol.com/?utm=1', root)).toBe(true);
    expect(_test.matchesTargetUrl('wavespestcontrol.com/#form', root)).toBe(true);
    // A child path must NOT count as a homepage backlink.
    expect(_test.matchesTargetUrl('wavespestcontrol.com/pest-control-bradenton-fl/', root)).toBe(false);
    expect(_test.matchesTargetUrl('wavespestcontrol.com/wdo-inspection', root)).toBe(false);
  });
});

describe('link prospect verifier — domain + quality helpers', () => {
  test('comparableDomain reduces any host form to a bare registrable host', () => {
    expect(_test.comparableDomain('https://www.ShowMySites.com/path')).toBe('showmysites.com');
    expect(_test.comparableDomain('marketinginternetdirectory.com')).toBe('marketinginternetdirectory.com');
    expect(_test.comparableDomain('http://sub.example.org:8080/x')).toBe('sub.example.org');
    expect(_test.comparableDomain('')).toBe('');
  });

  test('parseQuality accepts object, json string, or null and never throws', () => {
    expect(_test.parseQuality(null)).toEqual({});
    expect(_test.parseQuality({ pending: true })).toEqual({ pending: true });
    expect(_test.parseQuality('{"omega_submitted":"x"}')).toEqual({ omega_submitted: 'x' });
    expect(_test.parseQuality('not json')).toEqual({});
  });

  test('parseQuality returns a fresh copy (mutation-safe)', () => {
    const src = { a: 1 };
    const out = _test.parseQuality(src);
    out.b = 2;
    expect(src).toEqual({ a: 1 });
  });
});

describe('reconcileByDomain temporal guard (homepage-cited false-promote fix)', () => {
  test('comparableFirstSeen normalizes a Date (date column) to its stored calendar day, no tz shift', () => {
    // pg returns a `date` column as a Date at UTC midnight → the stored calendar day
    expect(_test.comparableFirstSeen({ first_seen: new Date('2026-06-22T00:00:00.000Z') })).toBe('2026-06-22');
  });
  test('comparableFirstSeen normalizes a string (text column) by taking the date head', () => {
    expect(_test.comparableFirstSeen({ first_seen: '2026-06-22' })).toBe('2026-06-22');
    expect(_test.comparableFirstSeen({ first_seen: '2026-06-22T13:00:00Z' })).toBe('2026-06-22');
  });
  test('comparableFirstSeen returns null for missing / invalid', () => {
    expect(_test.comparableFirstSeen({})).toBeNull();
    expect(_test.comparableFirstSeen({ first_seen: new Date('nope') })).toBeNull();
  });
  test('placementFloorEt = ET calendar date of (submitted_at − 1 day)', () => {
    // 2026-06-22T23:42:57Z → −1d → 2026-06-21T23:42:57Z → 19:42 EDT → 2026-06-21
    expect(_test.placementFloorEt('2026-06-22T23:42:57.000Z')).toBe('2026-06-21');
    expect(_test.placementFloorEt('garbage')).toBeNull();
    expect(_test.placementFloorEt(undefined)).toBeNull();
  });
  test('firstSeenOnOrAfter excludes a pre-existing (older) link, includes a post-submission one', () => {
    const floor = '2026-06-21';
    expect(_test.firstSeenOnOrAfter({ first_seen: '2026-05-01' }, floor)).toBe(false); // old listing → NOT our placement
    expect(_test.firstSeenOnOrAfter({ first_seen: '2026-08-15' }, floor)).toBe(true);  // discovered weeks later → ours
    expect(_test.firstSeenOnOrAfter({ first_seen: '2026-06-21' }, floor)).toBe(true);  // exactly at the floor → included
  });
  test('firstSeenOnOrAfter excludes an unknown first_seen (cannot prove it post-dates submission)', () => {
    expect(_test.firstSeenOnOrAfter({ first_seen: null }, '2026-06-21')).toBe(false);
  });
  test('firstSeenOnOrAfter does not tighten when there is no floor (no usable submitted_at)', () => {
    expect(_test.firstSeenOnOrAfter({ first_seen: '2000-01-01' }, null)).toBe(true);
  });
});
