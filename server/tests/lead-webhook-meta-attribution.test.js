// Phase 2 (Meta attribution): fbclid/fbc/fbp capture + fbclid -> facebook source.

jest.mock('../models/db', () => { const db = jest.fn(); db.raw = jest.fn(); return db; });
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { _test } = require('../routes/lead-webhook');
const { buildLeadWebhookIntake, determineLeadSource } = _test;

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
