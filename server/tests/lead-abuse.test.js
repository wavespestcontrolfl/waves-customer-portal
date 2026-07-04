// Shared public-form abuse helpers used by the lead webhook, property lookup,
// and quote calculator.
const { isHoneypotTripped, resolveSubmitHost } = require('../utils/lead-abuse');

describe('isHoneypotTripped', () => {
  test('absent / null / empty / whitespace → not tripped', () => {
    expect(isHoneypotTripped({})).toBe(false);
    expect(isHoneypotTripped(null)).toBe(false);
    expect(isHoneypotTripped(undefined)).toBe(false);
    expect(isHoneypotTripped({ fax_number: null })).toBe(false);
    expect(isHoneypotTripped({ fax_number: '' })).toBe(false);
    expect(isHoneypotTripped({ fax_number: '   ' })).toBe(false);
  });

  test('any present non-empty value → tripped (string OR non-string JSON)', () => {
    expect(isHoneypotTripped({ fax_number: '18005551234' })).toBe(true);
    expect(isHoneypotTripped({ fax_number: 0 })).toBe(true);
    expect(isHoneypotTripped({ fax_number: 5 })).toBe(true);
    expect(isHoneypotTripped({ fax_number: ['x'] })).toBe(true);
    expect(isHoneypotTripped({ fax_number: { a: 1 } })).toBe(true);
    expect(isHoneypotTripped({ fax_number: true })).toBe(true);
  });
});

describe('resolveSubmitHost', () => {
  test('prefers Origin, then Referer, then body page URLs, then domain', () => {
    expect(resolveSubmitHost({ headers: { origin: 'https://www.sarasotaflpestcontrol.com/x' }, body: {} }))
      .toBe('www.sarasotaflpestcontrol.com');
    expect(resolveSubmitHost({ headers: { referer: 'https://portal.wavespestcontrol.com/quote' }, body: {} }))
      .toBe('portal.wavespestcontrol.com');
    expect(resolveSubmitHost({ headers: {}, body: { page_url: 'https://www.parrishpestcontrol.com/' } }))
      .toBe('www.parrishpestcontrol.com');
    expect(resolveSubmitHost({ headers: {}, body: { attribution: { landing_url: 'https://waveslawncare.com/' } } }))
      .toBe('waveslawncare.com');
    expect(resolveSubmitHost({ headers: {}, body: { domain: 'wavespestcontrol.com' } }))
      .toBe('wavespestcontrol.com');
  });

  test('Origin wins over the body signals', () => {
    expect(resolveSubmitHost({
      headers: { origin: 'https://www.veniceexterminator.com' },
      body: { page_url: 'https://spoofed.example.com', domain: 'spoofed.example.com' },
    })).toBe('www.veniceexterminator.com');
  });

  test('empty string when nothing usable / never throws', () => {
    expect(resolveSubmitHost({ headers: {}, body: {} })).toBe('');
    expect(resolveSubmitHost({})).toBe('');
    expect(resolveSubmitHost({ headers: { origin: 'not a url' }, body: {} })).toBe('');
  });
});
