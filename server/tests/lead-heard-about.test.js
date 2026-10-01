// leads.heard_about — self-reported "How did you hear about us?" answer from
// the optional Astro quote-form question (owner-approved 2026-09-27).
// Validated against a FIXED allowlist; anything else (including free text)
// must be dropped, never stored. Companion lane to the AI-assistant referral
// classifier in lead-source-classify.js — see lead-webhook-meta-attribution's
// "AI-assistant referral" describe block for that side.

jest.mock('../models/db', () => { const db = jest.fn(); db.raw = jest.fn(); return db; });
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { _test } = require('../routes/lead-webhook');
const { sanitizeHeardAbout, sanitizeHeardAboutPrompt, buildLeadWebhookIntake } = _test;

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

// leads.heard_about_prompt — the optional "What did you ask it?" follow-up,
// kept only when the visitor picked ChatGPT or another AI assistant.
describe('heard_about_prompt — AI follow-up', () => {
  const ASK = 'best pest control in Sarasota';

  test('a valid prompt rides through for chatgpt and other_ai', () => {
    for (const heard_about of ['chatgpt', 'other_ai']) {
      const intake = buildLeadWebhookIntake({ heard_about, heard_about_prompt: ASK });
      expect(intake.heardAbout).toBe(heard_about);
      expect(intake.heardAboutPrompt).toBe(ASK);
    }
  });

  test('is stored as typed — no redaction of phone-like or name-like text', () => {
    const typed = 'is Example Pest Co at 941-555-0100 any good?';
    const intake = buildLeadWebhookIntake({ heard_about: 'chatgpt', heard_about_prompt: typed });
    expect(intake.heardAboutPrompt).toBe(typed);
  });

  test('is trimmed and whitespace-collapsed to a single printable line', () => {
    const intake = buildLeadWebhookIntake({
      heard_about: 'chatgpt',
      heard_about_prompt: '  best   pest\n\tcontrol \u0000 near me  ',
    });
    expect(intake.heardAboutPrompt).toBe('best pest control near me');
  });

  test('is capped at 500 characters', () => {
    const intake = buildLeadWebhookIntake({ heard_about: 'other_ai', heard_about_prompt: 'a'.repeat(900) });
    expect(intake.heardAboutPrompt).toHaveLength(500);
  });

  test('is dropped when heard_about is a non-AI choice', () => {
    for (const heard_about of ['google_search', 'friend_neighbor', 'other']) {
      const intake = buildLeadWebhookIntake({ heard_about, heard_about_prompt: ASK });
      expect(intake.heardAbout).toBe(heard_about);
      expect(intake.heardAboutPrompt).toBeNull();
    }
  });

  test('is dropped when heard_about is absent or invalid', () => {
    expect(buildLeadWebhookIntake({ heard_about_prompt: ASK }).heardAboutPrompt).toBeNull();
    expect(buildLeadWebhookIntake({ heard_about: 'billboard', heard_about_prompt: ASK }).heardAboutPrompt).toBeNull();
  });

  test('blank or non-string prompts resolve to null, never throw', () => {
    for (const heard_about_prompt of ['', '   ', undefined, null, 42, { a: 1 }, ['x']]) {
      expect(buildLeadWebhookIntake({ heard_about: 'chatgpt', heard_about_prompt }).heardAboutPrompt).toBeNull();
    }
  });

  test('an old client that omits the field is unaffected', () => {
    const intake = buildLeadWebhookIntake({ heard_about: 'chatgpt' });
    expect(intake.heardAbout).toBe('chatgpt');
    expect(intake.heardAboutPrompt).toBeNull();
  });

  test('sanitizeHeardAboutPrompt gates on the sanitized heardAbout key', () => {
    expect(sanitizeHeardAboutPrompt(ASK, 'chatgpt')).toBe(ASK);
    expect(sanitizeHeardAboutPrompt(ASK, 'yelp')).toBeNull();
    expect(sanitizeHeardAboutPrompt(ASK, null)).toBeNull();
  });
});
