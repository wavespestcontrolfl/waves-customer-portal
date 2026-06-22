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

  test('signup-lane (citation) prospects reconcile against the HOMEPAGE, not target_page', () => {
    const citation = { link_type: 'citation', target_page: 'https://wavespestcontrol.com/wdo-inspection/' };
    // a homepage backlink — what a citation listing actually creates → matches
    expect(_test.backlinkTargetsProspect({ target_url: 'https://wavespestcontrol.com/' }, citation)).toBe(true);
    expect(_test.backlinkTargetsProspect({ target_url: 'https://www.wavespestcontrol.com' }, citation)).toBe(true);
    // a deep money-page backlink is NOT what a citation creates → must NOT match (homepage expected)
    expect(_test.backlinkTargetsProspect({ target_url: 'https://wavespestcontrol.com/wdo-inspection/' }, citation)).toBe(false);
  });

  test('expectedTargetUrl: homepage for signup-lane, target_page otherwise (one source of truth)', () => {
    expect(_test.expectedTargetUrl({ link_type: 'citation', target_page: 'https://wavespestcontrol.com/x' })).toBe('https://wavespestcontrol.com');
    expect(_test.expectedTargetUrl({ link_type: 'directory', target_page: 'https://wavespestcontrol.com/x' })).toBe('https://wavespestcontrol.com');
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
