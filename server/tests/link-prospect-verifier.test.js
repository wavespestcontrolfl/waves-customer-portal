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

  test('normalizes comparable URLs consistently', () => {
    expect(_test.normalizeComparableUrl('https://www.wavespestcontrol.com/wdo-inspection/'))
      .toBe('wavespestcontrol.com/wdo-inspection');
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
    // A child path must NOT count as a homepage backlink.
    expect(_test.matchesTargetUrl('wavespestcontrol.com/pest-control-bradenton-fl/', root)).toBe(false);
    expect(_test.matchesTargetUrl('wavespestcontrol.com/wdo-inspection', root)).toBe(false);
  });
});
