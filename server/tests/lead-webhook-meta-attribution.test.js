// Phase 2 (Meta attribution): fbclid/fbc/fbp capture + fbclid -> facebook source.

jest.mock('../models/db', () => { const db = jest.fn(); db.raw = jest.fn(); return db; });
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { _test } = require('../routes/lead-webhook');
const { buildLeadWebhookIntake, determineLeadSource } = _test;
const { SPOKE_SITES } = require('../services/content-astro/spoke-sites');

describe('buildLeadWebhookIntake — Meta click ids', () => {
  test('captures fbclid/fbc/fbp from a nested attribution object', () => {
    const intake = buildLeadWebhookIntake({
      attribution: { fbclid: 'fb.abc123', fbc: 'fb.1.171.fbclidval', fbp: 'fb.1.171.99' },
    });
    expect(intake.fbclid).toBe('fb.abc123');
    expect(intake.fbc).toBe('fb.1.171.fbclidval');
    expect(intake.fbp).toBe('fb.1.171.99');
  });

  test('captures fbclid from a top-level body field too', () => {
    const intake = buildLeadWebhookIntake({ fbclid: 'top-level-fbclid' });
    expect(intake.fbclid).toBe('top-level-fbclid');
  });

  test('defaults to empty string when absent', () => {
    const intake = buildLeadWebhookIntake({});
    expect(intake.fbclid).toBe('');
    expect(intake.fbc).toBe('');
    expect(intake.fbp).toBe('');
  });
});

describe('determineLeadSource — fbclid', () => {
  test('an fbclid with no clearer source attributes to paid facebook', () => {
    const r = determineLeadSource('', '', '', '', '', '', 'fb.click.123');
    expect(r).toMatchObject({ source: 'facebook', channel: 'paid' });
  });

  test('an _fbc cookie (no top-level fbclid) also attributes to paid facebook', () => {
    const r = determineLeadSource('', '', '', '', '', '', '', 'fb.1.171.clickid');
    expect(r).toMatchObject({ source: 'facebook', channel: 'paid', detail: 'Meta click (_fbc)' });
  });

  test('explicit utm_source=facebook still wins (and keeps its detail)', () => {
    const r = determineLeadSource('', '', 'facebook', 'cpc', 'summer', '', 'fb.click.123');
    expect(r.source).toBe('facebook');
    expect(r.channel).toBe('paid');
    expect(r.detail).toContain('summer');
  });

  test('no fbclid + no utm falls through to generic website (unchanged)', () => {
    const r = determineLeadSource('https://example.com/x', '', '', '', '', '', '');
    expect(r.source).not.toBe('facebook');
  });

  test('google cpc is unaffected by the fbclid rule ordering', () => {
    const r = determineLeadSource('', '', 'google', 'cpc', 'brand', '', '');
    expect(r.source).toBe('google_ads');
  });
});

describe('determineLeadSource — gclid (Google auto-tagging)', () => {
  const GCLID = 'CjwKCAjw3ejRBhAdEiwA';
  // args: (pageUrl, landingUrl, utmSource, utmMedium, utmCampaign, utmContent, fbclid, fbc, gclid, wbraid, gbraid)

  test('a gclid with no clearer source attributes to paid google_ads', () => {
    const r = determineLeadSource('', '', '', '', '', '', '', '', GCLID);
    expect(r).toMatchObject({ source: 'google_ads', channel: 'paid' });
  });

  test('wbraid / gbraid (iOS / web-to-app) also attribute to paid google_ads', () => {
    expect(determineLeadSource('', '', '', '', '', '', '', '', '', 'wbraid.1').source).toBe('google_ads');
    expect(determineLeadSource('', '', '', '', '', '', '', '', '', '', 'gbraid.1').source).toBe('google_ads');
  });

  test('REGRESSION: an auto-tagged gclid on a Waves page is google_ads, not waves_website', () => {
    // The exact prod bug: a paid click (gclid, no UTMs) landing on a city page was
    // classified organic waves_website. It must now read as paid Google.
    const r = determineLeadSource('https://wavespestcontrol.com/pest-control-lakewood', '', '', '', '', '', '', '', GCLID);
    expect(r.source).toBe('google_ads');
    expect(r.channel).toBe('paid');
  });

  test('explicit utm_source=google&cpc still wins (keeps richer campaign detail)', () => {
    const r = determineLeadSource('', '', 'google', 'cpc', 'brand', '', '', '', GCLID);
    expect(r.source).toBe('google_ads');
    expect(r.detail).toContain('brand');
  });

  test('a Waves page WITHOUT a click id stays organic waves_website (unchanged)', () => {
    const r = determineLeadSource('https://wavespestcontrol.com/pest-control-lakewood', '', '', '', '', '');
    expect(r.source).toBe('waves_website');
  });
});

describe('determineLeadSource — spoke fleet (single-sourced from SPOKE_SITES)', () => {
  const spokeKeys = SPOKE_SITES.filter((s) => s.group !== 'Hub').map((s) => s.key);

  test('DRIFT GUARD: every spoke in the fleet attributes to organic domain_website', () => {
    // Adding a spoke to SPOKE_SITES must auto-attribute here. If this fails, that
    // spoke's inbound form leads are silently dropping to 'Unattributed (web)'.
    expect(spokeKeys.length).toBeGreaterThanOrEqual(16);
    for (const key of spokeKeys) {
      const r = determineLeadSource(`https://www.${key}/`, '', '', '', '', '');
      expect(r).toMatchObject({ source: 'domain_website', detail: key, channel: 'organic' });
    }
  });

  test('matches on the landing URL and carries the spoke area', () => {
    const r = determineLeadSource('', 'https://www.bradentonflpestcontrol.com/', '', '', '', '');
    expect(r).toMatchObject({ source: 'domain_website', detail: 'bradentonflpestcontrol.com', area: 'Bradenton' });
  });

  test('the brand-wide lawn spoke maps to the SW Florida area', () => {
    const r = determineLeadSource('https://www.waveslawncare.com/', '', '', '', '', '');
    expect(r).toMatchObject({ source: 'domain_website', detail: 'waveslawncare.com', area: 'SW Florida' });
  });

  test('the hub is NOT treated as a spoke (resolves to waves_website)', () => {
    const r = determineLeadSource('https://www.wavespestcontrol.com/', '', '', '', '', '');
    expect(r.source).toBe('waves_website');
  });
});
