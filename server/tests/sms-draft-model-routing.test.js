/**
 * SMS reply-drafting model split (owner directive 2026-07-05):
 *   default auto-reply draft              → ROUTES.smsDraftDefault (GPT-5.4-mini)
 *   save-the-sale (cancel/complaint/issue) → ROUTES.smsDraftSaveSale (Claude Sonnet 5)
 *   tone rewrite (/rewrite-sms)            → ROUTES.smsToneRewrite (Claude Sonnet 5)
 * Every routed lane falls back to the original Claude call on a miss.
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
  dispatch: jest.fn(),
}));

const { dispatch } = require('../services/llm/call');
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
  dispatch.mockReset();
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

  test('routed success: draft comes from the routed model, no Claude fallback call', async () => {
    dispatch.mockResolvedValue({ ok: true, text: DRAFT_JSON, model: MODELS.OPENAI_SMS_DRAFT });

    const result = await generateDraftOnce(client, 'system', 'user content', MODELS.ROUTES.smsDraftDefault);

    expect(dispatch).toHaveBeenCalledWith(
      MODELS.ROUTES.smsDraftDefault,
      expect.objectContaining({ system: 'system', text: 'user content', jsonMode: false }),
    );
    expect(result.model).toBe(MODELS.OPENAI_SMS_DRAFT);
    expect(result.parsed.reply).toBe('Hello! Happy to help with that.');
    expect(client.messages.create).not.toHaveBeenCalled();
  });

  test('dispatches whatever route it is given (save-the-sale lane)', async () => {
    dispatch.mockResolvedValue({ ok: true, text: DRAFT_JSON, model: MODELS.SMS_SONNET });

    const result = await generateDraftOnce(client, 'system', 'user content', MODELS.ROUTES.smsDraftSaveSale);

    expect(dispatch).toHaveBeenCalledWith(MODELS.ROUTES.smsDraftSaveSale, expect.any(Object));
    expect(result.model).toBe(MODELS.SMS_SONNET);
  });

  test('routed miss (no key / provider error) falls back to FLAGSHIP via the Anthropic client', async () => {
    dispatch.mockResolvedValue({ ok: false, reason: 'no_key' });
    client.messages.create.mockResolvedValue({ content: [{ type: 'text', text: DRAFT_JSON }] });

    const result = await generateDraftOnce(client, 'system', 'user content', MODELS.ROUTES.smsDraftDefault);

    expect(client.messages.create).toHaveBeenCalledWith(
      expect.objectContaining({ model: MODELS.FLAGSHIP }),
    );
    expect(result.model).toBe(MODELS.FLAGSHIP);
    expect(result.parsed.reply).toBe('Hello! Happy to help with that.');
  });

  test('routed output unparseable falls back to FLAGSHIP', async () => {
    dispatch.mockResolvedValue({ ok: true, text: 'not json at all', model: MODELS.OPENAI_SMS_DRAFT });
    client.messages.create.mockResolvedValue({ content: [{ type: 'text', text: DRAFT_JSON }] });

    const result = await generateDraftOnce(client, 'system', 'user content', MODELS.ROUTES.smsDraftDefault);

    expect(result.model).toBe(MODELS.FLAGSHIP);
  });

  test('both paths unusable returns null', async () => {
    dispatch.mockResolvedValue({ ok: false, reason: 'error' });
    client.messages.create.mockResolvedValue({ content: [{ type: 'text', text: 'still not json' }] });

    const result = await generateDraftOnce(client, 'system', 'user content', MODELS.ROUTES.smsDraftDefault);

    expect(result).toBeNull();
  });
});
