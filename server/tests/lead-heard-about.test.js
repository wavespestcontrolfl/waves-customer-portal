// leads.heard_about — self-reported "How did you hear about us?" answer from
// the optional Astro quote-form question (owner-approved 2026-09-27).
// Validated against a FIXED allowlist; anything else (including free text)
// must be dropped, never stored. Companion lane to the AI-assistant referral
// classifier in lead-source-classify.js — see lead-webhook-meta-attribution's
// "AI-assistant referral" describe block for that side.

jest.mock('../models/db', () => { const db = jest.fn(); db.raw = jest.fn(); return db; });
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { _test } = require('../routes/lead-webhook');
const { sanitizeHeardAbout, buildLeadWebhookIntake } = _test;

describe('sanitizeHeardAbout — fixed allowlist', () => {
  const ALLOWED = [
    'google_search', 'google_maps', 'chatgpt', 'other_ai',
    'facebook_instagram', 'nextdoor', 'yelp', 'friend_neighbor',
    'truck_yard_sign', 'other',
  ];

  test('accepts every allowlisted key verbatim', () => {
    for (const key of ALLOWED) {
      expect(sanitizeHeardAbout(key)).toBe(key);
    }
  });

  test('is case/whitespace tolerant on an otherwise-valid key', () => {
    expect(sanitizeHeardAbout(' ChatGPT ')).toBe('chatgpt');
    expect(sanitizeHeardAbout('GOOGLE_SEARCH')).toBe('google_search');
  });

  test('drops an unrecognized key rather than storing it', () => {
    expect(sanitizeHeardAbout('tiktok')).toBeNull();
    expect(sanitizeHeardAbout('radio_ad')).toBeNull();
  });

  test('drops free text — never stores a customer-typed sentence', () => {
    expect(sanitizeHeardAbout('a friend told me about you guys')).toBeNull();
    expect(sanitizeHeardAbout('<script>alert(1)</script>')).toBeNull();
  });

  test('drops empty/absent values (unknown stays unknown, not a guess)', () => {
    expect(sanitizeHeardAbout('')).toBeNull();
    expect(sanitizeHeardAbout(undefined)).toBeNull();
    expect(sanitizeHeardAbout(null)).toBeNull();
  });

  test('drops a non-allowlisted-shaped payload rather than throwing', () => {
    expect(sanitizeHeardAbout(42)).toBeNull();
    expect(sanitizeHeardAbout({ foo: 'bar' })).toBeNull();
  });
});

describe('buildLeadWebhookIntake — heardAbout wiring', () => {
  test('a valid heard_about rides through as intake.heardAbout', () => {
    const intake = buildLeadWebhookIntake({ heard_about: 'chatgpt' });
    expect(intake.heardAbout).toBe('chatgpt');
  });

  test('an invalid heard_about resolves to null (never a guess, never stored)', () => {
    const intake = buildLeadWebhookIntake({ heard_about: 'billboard' });
    expect(intake.heardAbout).toBeNull();
  });

  test('an absent heard_about resolves to null', () => {
    const intake = buildLeadWebhookIntake({});
    expect(intake.heardAbout).toBeNull();
  });

  test('heardAbout is independent of leadSource — an AI-assistant referral with no self-reported answer is still null here', () => {
    const intake = buildLeadWebhookIntake({
      attribution: { utm: { source: 'chatgpt.com' }, landing_url: 'https://wavespestcontrol.com/' },
    });
    expect(intake.leadSource.source).toBe('ai_assistant');
    expect(intake.heardAbout).toBeNull();
  });
});
