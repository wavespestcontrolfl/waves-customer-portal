/**
 * SMS reply-drafting model split (owner directive 2026-07-05):
 *   default auto-reply draft              → ROUTES.smsDraftDefault (GPT-5.6 Luna)
 *   save-the-sale (cancel/complaint/issue) → ROUTES.smsDraftSaveSale (Claude Sonnet 5)
 *   tone rewrite (/rewrite-sms)            → ROUTES.smsToneRewrite (Claude Sonnet 5)
 * Every routed lane falls back to the opposite provider on a miss.
 */

jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.schema = { hasTable: jest.fn(async () => true) };
  return fn;
});

jest.mock('../services/llm/call', () => ({
  dispatchWithFallback: jest.fn(),
}));

const { dispatchWithFallback } = require('../services/llm/call');
const MODELS = require('../config/models');
const {
  generateDraftOnce,
  draftRouteFor,
} = require('../services/sms-shadow-drafter');

const DRAFT_JSON = JSON.stringify({
  reply: 'Hello! Happy to help with that.',
  intended_actions: [],
  missing_info: null,
});

beforeEach(() => {
  dispatchWithFallback.mockReset();
});

describe('route selection', () => {
  // No literal model IDs here (registry rule): defaults live in
  // config/models.js and are env-overridable; the contract under test is the
  // route WIRING — which registry const each lane reads and which provider
  // serves it.
  test('routes are wired to the registry consts per the owner directive', () => {
    expect(MODELS.ROUTES.smsDraftDefault).toEqual({ provider: 'openai', model: MODELS.OPENAI_SMS_DRAFT });
    expect(MODELS.ROUTES.smsDraftSaveSale).toEqual({ provider: 'anthropic', model: MODELS.SMS_SONNET });
    expect(MODELS.ROUTES.smsToneRewrite).toEqual({ provider: 'anthropic', model: MODELS.SMS_SONNET });
  });

  test('save-the-sale intents route to Sonnet; everything else to the mini default', () => {
    // Triage intent names
    expect(draftRouteFor({ intentName: 'customer_issue_needs_review' })).toBe(MODELS.ROUTES.smsDraftSaveSale);
    // Legacy webhook intent labels
    expect(draftRouteFor({ intentName: 'COMPLAINT' })).toBe(MODELS.ROUTES.smsDraftSaveSale);
    expect(draftRouteFor({ intentName: 'CANCEL_REQUEST' })).toBe(MODELS.ROUTES.smsDraftSaveSale);
    // Default lane
    expect(draftRouteFor({ intentName: 'SCHEDULE_INQUIRY' })).toBe(MODELS.ROUTES.smsDraftDefault);
    expect(draftRouteFor({ intentName: 'GENERAL' })).toBe(MODELS.ROUTES.smsDraftDefault);
    expect(draftRouteFor({})).toBe(MODELS.ROUTES.smsDraftDefault);
  });

  test('complaint TEXT routes to save-the-sale even when the intent label says scheduling', () => {
    // The upstream router classifies service scheduling before customer
    // triage, so complaints carrying a time word arrive with a scheduling
    // intent label — the message text must still pull them onto Sonnet.
    expect(draftRouteFor({
      intentName: 'service_scheduling_window_reply',
      inboundMessage: 'Good morning! Sadly I still have spiders.. killed a second one this week yesterday..',
    })).toBe(MODELS.ROUTES.smsDraftSaveSale);
    expect(draftRouteFor({
      intentName: 'service_scheduling_window_reply',
      inboundMessage: 'Hello what happened this morning',
    })).toBe(MODELS.ROUTES.smsDraftSaveSale);
    expect(draftRouteFor({
      intentName: 'GENERAL',
      inboundMessage: 'I want to cancel my service',
    })).toBe(MODELS.ROUTES.smsDraftSaveSale);
    // Cancellation verb variants — an active scheduling thread can label
    // these service_scheduling_window_reply via the time word, so the text
    // match is the only thing pulling them onto the Sonnet lane.
    for (const msg of [
      'I canceled tomorrow morning',
      'I cancelled tomorrow morning',
      'I am cancelling my Tuesday appointment',
      'canceling service, please confirm',
    ]) {
      expect(draftRouteFor({ intentName: 'service_scheduling_window_reply', inboundMessage: msg }))
        .toBe(MODELS.ROUTES.smsDraftSaveSale);
    }
    // A clean scheduling reply stays on the default lane
    expect(draftRouteFor({
      intentName: 'service_scheduling_window_reply',
      inboundMessage: 'Tuesday morning works great for us',
    })).toBe(MODELS.ROUTES.smsDraftDefault);
  });
});

describe('generateDraftOnce', () => {
  const client = { messages: { create: jest.fn() } };

  beforeEach(() => {
    client.messages.create.mockReset();
  });

  test('routed success: draft comes from the routed model', async () => {
    dispatchWithFallback.mockResolvedValue({ ok: true, text: DRAFT_JSON, model: MODELS.OPENAI_SMS_DRAFT });

    const result = await generateDraftOnce(client, 'system', 'user content', MODELS.ROUTES.smsDraftDefault);

    expect(dispatchWithFallback).toHaveBeenCalledWith(
      {
        primary: MODELS.ROUTES.smsDraftDefault,
        fallback: MODELS.TEXT_POLICIES.fastStructured.fallback,
      },
      expect.objectContaining({ system: 'system', text: 'user content', jsonMode: false }),
      expect.objectContaining({ validate: expect.any(Function) }),
    );
    expect(result.model).toBe(MODELS.OPENAI_SMS_DRAFT);
    expect(result.parsed.reply).toBe('Hello! Happy to help with that.');
    expect(client.messages.create).not.toHaveBeenCalled();
  });

  test('dispatches whatever route it is given (save-the-sale lane)', async () => {
    dispatchWithFallback.mockResolvedValue({ ok: true, text: DRAFT_JSON, model: MODELS.SMS_SONNET });

    const result = await generateDraftOnce(client, 'system', 'user content', MODELS.ROUTES.smsDraftSaveSale);

    expect(dispatchWithFallback).toHaveBeenCalledWith(
      {
        primary: MODELS.ROUTES.smsDraftSaveSale,
        fallback: MODELS.TEXT_POLICIES.highStakes.fallback,
      },
      expect.any(Object),
      expect.objectContaining({ validate: expect.any(Function) }),
    );
    expect(result.model).toBe(MODELS.SMS_SONNET);
  });

  test('routed miss is returned from the opposite-provider fallback', async () => {
    dispatchWithFallback.mockResolvedValue({
      ok: true,
      text: DRAFT_JSON,
      model: MODELS.TEXT_POLICIES.fastStructured.fallback.model,
      fallbackUsed: true,
    });

    const result = await generateDraftOnce(client, 'system', 'user content', MODELS.ROUTES.smsDraftDefault);

    expect(result.model).toBe(MODELS.TEXT_POLICIES.fastStructured.fallback.model);
    expect(result.parsed.reply).toBe('Hello! Happy to help with that.');
  });

  test('unparseable primary output is replaced by valid fallback output', async () => {
    dispatchWithFallback.mockResolvedValue({
      ok: true,
      text: DRAFT_JSON,
      model: MODELS.TEXT_POLICIES.fastStructured.fallback.model,
      fallbackUsed: true,
    });

    const result = await generateDraftOnce(client, 'system', 'user content', MODELS.ROUTES.smsDraftDefault);

    expect(result.model).toBe(MODELS.TEXT_POLICIES.fastStructured.fallback.model);
  });

  test('both paths unusable returns null', async () => {
    dispatchWithFallback.mockResolvedValue({ ok: false, reason: 'all_providers_failed' });

    const result = await generateDraftOnce(client, 'system', 'user content', MODELS.ROUTES.smsDraftDefault);

    expect(result).toBeNull();
  });
});
