const { emailSourceEvidence, ownMailboxAddress } = require('../services/email/email-source-tag');
const { EVIDENCE_KINDS } = require('../services/lead-source-evidence');

const HUB = 'wavespestcontrol.com';
const to = (address, extra = {}) => emailSourceEvidence({ to_address: address, ...extra });

describe('emailSourceEvidence: tagged website email links', () => {
  test.each([
    ['gbp-bradenton', 'google_business', 'Google Business Profile', 'GBP — Lakewood Ranch'],
    ['gbp-parrish', 'google_business', 'Google Business Profile', 'GBP — Parrish'],
    ['gbp-sarasota', 'google_business', 'Google Business Profile', 'GBP — Sarasota'],
    ['gbp-venice', 'google_business', 'Google Business Profile', 'GBP — Venice'],
    ['gbp', 'google_business', 'Google Business Profile', 'GBP — profile website link'],
    ['gads', 'google_ads', 'Google Ads', 'Google Ads'],
    ['meta', 'meta_ads', 'Meta Ads', 'Meta Ads'],
    ['ai-chatgpt', 'chatgpt', 'ChatGPT', 'AI search'],
    ['ai-copilot', 'copilot', 'Microsoft Copilot', 'AI search'],
    ['ai', 'other_ai', 'AI referral', 'AI search'],
    ['search-google', 'organic_search', 'Organic search', 'Google'],
    ['search-bing', 'organic_search', 'Organic search', 'Bing'],
    ['search-duckduckgo', 'organic_search', 'Organic search', 'DuckDuckGo'],
    ['search-yahoo', 'organic_search', 'Organic search', 'Yahoo'],
    ['search-brave', 'organic_search', 'Organic search', 'Brave Search'],
    ['search-ecosia', 'organic_search', 'Organic search', 'Ecosia'],
    ['search', 'organic_search', 'Organic search', 'Organic search'],
    ['social-facebook', 'organic_social', 'Organic social', 'Facebook'],
    ['social-instagram', 'organic_social', 'Organic social', 'Instagram'],
    ['social-nextdoor', 'organic_social', 'Organic social', 'Nextdoor'],
    ['social-linkedin', 'organic_social', 'Organic social', 'LinkedIn'],
    ['social-x', 'organic_social', 'Organic social', 'X'],
    ['social', 'organic_social', 'Organic social', 'Organic social'],
    ['ref', 'referral', 'Referral', 'Referring website'],
    ['direct', 'direct', 'Direct', 'No referring site'],
    ['site', 'website', 'Website', 'Website'],
  ])('code %s', (code, kind, label, detailStart) => {
    const result = to(`contact+${code}_home@${HUB}`);
    expect(result).toMatchObject({ kind, label });
    expect(result.detail).toBe(`${detailStart} · email link, home page`);
    expect(EVIDENCE_KINDS.has(result.kind)).toBe(true);
    expect(result.basis).toMatch(/tagged website email link/);
    expect(result.label.length).toBeLessThanOrEqual(80);
    expect(result.detail.length).toBeLessThanOrEqual(120);
    expect(result.basis.length).toBeLessThanOrEqual(240);
  });

  test('a tag on a spoke or lawn-care domain is not read: the site tags hub links only', () => {
    expect(to('contact+gads_pest-control-bradenton-fl@palmettoexterminator.com'))
      .toMatchObject({ kind: 'website', label: 'Website', detail: 'palmettoexterminator.com' });
    expect(to('contact+site_home@waveslawncare.com'))
      .toMatchObject({ kind: 'website', label: 'Website', detail: 'waveslawncare.com' });
  });

  test('reads the display-name header form, casing and a Cc recipient', () => {
    expect(to('Waves <contact+gbp-sarasota_home@wavespestcontrol.com>').detail)
      .toBe('GBP — Sarasota · email link, home page');
    expect(to('"Waves" <Contact+GADS_Home@WavesPestControl.com>')).toMatchObject({ kind: 'google_ads' });
    expect(emailSourceEvidence({ to_address: 'a@example.test', cc_address: 'contact+meta_home@wavespestcontrol.com' }))
      .toMatchObject({ kind: 'meta_ads' });
  });

  test.each([
    ['unknown code', 'contact+bogus_home'],
    ['near-miss code', 'contact+gbp-tampa_home'],
    ['location alias, not an id', 'contact+gbp-lwr_home'],
    ['unknown engine', 'contact+search-altavista_home'],
    ['code with an extra segment', 'contact+gads-extra_home'],
    ['no page', 'contact+gads'],
    ['empty page', 'contact+gads_'],
    ['uppercase-only page is fine, underscore in page is not', 'contact+gads_my_page'],
    ['symbol in page', 'contact+gads_pa.ge'],
    ['page over 55 chars', `contact+gads_${'a'.repeat(56)}`],
    ['second plus', 'contact+gads_home+x'],
    ['another mailbox', 'info+gads_home'],
  ])('ignores %s on the main domain (null)', (name, local) => {
    expect(to(`${local}@${HUB}`)).toBeNull();
  });

  test('accepts the longest allowed page', () => {
    expect(to(`contact+gads_${'a'.repeat(55)}@${HUB}`)).toMatchObject({ kind: 'google_ads' });
  });

  test('an invalid tag on a spoke still reads as that website', () => {
    expect(to('contact+bogus_home@veniceflpestcontrol.com')).toMatchObject({ kind: 'website', detail: 'veniceflpestcontrol.com' });
  });
});

describe('emailSourceEvidence: inherited property names', () => {
  test('are not codes, and do not hide a later valid tag', () => {
    for (const code of ['constructor', 'search-constructor', 'social-constructor', 'gbp-constructor']) {
      expect(to(`contact+${code}_home@${HUB}`)).toBeNull();
    }
    expect(to(`contact+constructor_home@${HUB}, contact+gads_home@${HUB}`)).toMatchObject({ kind: 'google_ads' });
  });
});

describe('emailSourceEvidence: no tag', () => {
  test('spoke and lawn-care domains read as that website', () => {
    for (const domain of ['contact@palmettoexterminator.com', 'contact@veniceflpestcontrol.com', 'contact@waveslawncare.com']) {
      expect(to(domain)).toMatchObject({
        kind: 'website', label: 'Website', detail: domain.split('@')[1],
      });
    }
    expect(to('contact@veniceflpestcontrol.com').basis)
      .toMatch(/the address the veniceflpestcontrol\.com website shows\. It is a hint, not proof/);
  });

  test('main domain without a tag, a non-contact mailbox, a foreign domain and blanks give null', () => {
    expect(to(`contact@${HUB}`)).toBeNull();
    expect(to(`Waves <contact@${HUB}>`)).toBeNull();
    expect(to('info@palmettoexterminator.com')).toBeNull();
    expect(to('contact+gads_home@example.test')).toBeNull();
    expect(to('contact@wavespestcontrol.com.evil.test')).toBeNull();
    expect(to(null)).toBeNull();
    expect(emailSourceEvidence()).toBeNull();
  });

  test('a valid tag wins over an untagged spoke address in the same header', () => {
    expect(to('contact@palmettoexterminator.com, contact+gads_home@wavespestcontrol.com'))
      .toMatchObject({ kind: 'google_ads' });
  });
});

describe('ownMailboxAddress', () => {
  test('strips a +tag on the hub domain only', () => {
    expect(ownMailboxAddress('Contact+GBP-Sarasota_home@WavesPestControl.com')).toBe('contact@wavespestcontrol.com');
    expect(ownMailboxAddress('contact+x@palmettoexterminator.com')).toBe('contact+x@palmettoexterminator.com');
    expect(ownMailboxAddress('jane+shopping@example.test')).toBe('jane+shopping@example.test');
    expect(ownMailboxAddress(' Contact@wavespestcontrol.com ')).toBe('contact@wavespestcontrol.com');
    expect(ownMailboxAddress(null)).toBe('');
  });
});
