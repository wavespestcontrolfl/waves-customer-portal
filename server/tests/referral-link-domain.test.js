const referralEngine = require('../services/referral-engine');

describe('referral link domain normalization', () => {
  test('moves public website referral bases to the portal redirect route', () => {
    const { normalizeReferralBaseUrl, referralLinkForCode } = referralEngine._internals;

    expect(normalizeReferralBaseUrl('https://wavespestcontrol.com/r/')).toBe('https://portal.wavespestcontrol.com/r/');
    expect(normalizeReferralBaseUrl('https://www.wavespestcontrol.com/r')).toBe('https://portal.wavespestcontrol.com/r/');
    expect(referralLinkForCode('WAVES-J4KM', 'https://wavespestcontrol.com/r/')).toBe('https://portal.wavespestcontrol.com/r/WAVES-J4KM');
  });

  test('repairs stored promoter links that still point at the public site', () => {
    expect(referralEngine.getPromoterReferralLink(
      {
        referral_code: 'WAVES-J4KM',
        referral_link: 'https://wavespestcontrol.com/r/WAVES-J4KM',
      },
      { base_url: 'https://wavespestcontrol.com/r/' },
    )).toBe('https://portal.wavespestcontrol.com/r/WAVES-J4KM');
  });

  test('does not return a bare referral route when a promoter has no code', () => {
    expect(referralEngine.getPromoterReferralLink(
      { referral_code: '', referral_link: '' },
      { base_url: 'https://wavespestcontrol.com/r/' },
    )).toBe('https://portal.wavespestcontrol.com');

    expect(referralEngine.getPromoterReferralLink(
      { referral_code: '', referral_link: 'https://wavespestcontrol.com/r/WAVES-J4KM' },
      { base_url: 'https://wavespestcontrol.com/r/' },
    )).toBe('https://portal.wavespestcontrol.com/r/WAVES-J4KM');
  });
});
