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

describe('referral phone normalization', () => {
  const { normalizePhone } = referralEngine._internals;

  test('returns canonical E.164 for valid North American numbers', () => {
    expect(normalizePhone('(941) 555-0123')).toBe('+19415550123');
    expect(normalizePhone('+1 941 555 0123')).toBe('+19415550123');
  });

  test('rejects alphabetic, too-short, and empty values', () => {
    expect(normalizePhone('abcdefg')).toBeNull();
    expect(normalizePhone('12345')).toBeNull();
    expect(normalizePhone('')).toBeNull();
  });
});
