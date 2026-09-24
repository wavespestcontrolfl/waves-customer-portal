'use strict';

const ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'SHADOW_DRAFT_VERIFY',
  'SHADOW_FEWSHOT',
  'SHADOW_VOICE_PROFILE',
];

describe('live-webhook gratitude drafter boundary', () => {
  let priorEnv;

  beforeEach(() => {
    priorEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    delete process.env.ANTHROPIC_API_KEY;
    process.env.SHADOW_DRAFT_VERIFY = 'true';
    process.env.SHADOW_FEWSHOT = 'false';
    process.env.SHADOW_VOICE_PROFILE = 'false';
    jest.resetModules();
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (priorEnv[key] === undefined) delete process.env[key];
      else process.env[key] = priorEnv[key];
    }
    jest.resetModules();
  });

  async function runDraft(draftPayload, overrides = {}) {
    const { deliveryMode = 'auto_send', ...requestOverrides } = overrides;
    const insertedRows = [];
    const mockDb = jest.fn((table) => {
      if (table !== 'message_drafts') throw new Error(`unexpected table: ${table}`);
      return {
        insert: jest.fn((row) => {
          insertedRows.push(row);
          return { returning: jest.fn(async () => [{ id: 'draft-gratitude-1' }]) };
        }),
      };
    });
    const providerCreate = jest.fn(() => {
      throw new Error('provider client must not be called directly');
    });
    const Anthropic = jest.fn(() => ({ messages: { create: providerCreate } }));
    const dispatchWithFallback = jest.fn(async () => ({
      ok: true,
      text: JSON.stringify(draftPayload),
      model: 'fixture-model',
    }));
    const createDeepMessage = jest.fn(async () => ({
      content: [{ type: 'text', text: JSON.stringify({ supported: true, violations: [] }) }],
    }));
    const maybeAutoSend = jest.fn(async () => ({ sent: true }));
    const publishSuggestion = jest.fn(async () => 'decision-should-not-exist');
    const supersedeStaleSuggestions = jest.fn(async () => 1);
    const resolveDeliveryMode = jest.fn(async () => deliveryMode);
    const autoSendActionsSafe = jest.fn((actions) => (
      Array.isArray(actions) && actions.every((action) => action?.type === 'none')
    ));

    jest.doMock('../models/db', () => mockDb);
    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
    jest.doMock('../services/context-aggregator', () => ({
      getContextForCustomer: jest.fn(async () => ({
        summary: 'Synthetic account context',
        flags: [],
        smsHistory: [],
        customer: { billingLane: null },
        billing: { outstandingBalance: 0, recentPayments: [] },
      })),
      getFullCustomerContext: jest.fn(() => {
        throw new Error('phone lookup must not run for a matched webhook customer');
      }),
      authorizedDuesCents: jest.fn(() => []),
    }));
    jest.doMock('../services/llm/call', () => ({ dispatchWithFallback }));
    jest.doMock('../services/llm/deep', () => ({ createDeepMessage }));
    jest.doMock('@anthropic-ai/sdk', () => Anthropic);
    jest.doMock('../services/sms-auto-send', () => ({
      autoSendActionsSafe,
      maybeAutoSend,
    }));
    jest.doMock('../services/sms-suggest-mode', () => ({
      AUTO_SEND_MODE: 'auto_send',
      SUGGESTED_STATUS: 'suggested',
      resolveDeliveryMode,
      publishSuggestion,
      supersedeStaleSuggestions,
      hasRedactionPlaceholder: jest.fn(() => false),
      hasPriceQuote: jest.fn(() => false),
    }));
    jest.doMock('../services/comms-lint', () => ({
      lintComms: jest.fn(() => ({ pass: true, failures: [] })),
      toFlags: jest.fn(() => []),
    }));

    const { draftShadowReply } = require('../services/sms-shadow-drafter');
    const { GRATITUDE_INTENT, GRATITUDE_POLICY_VERSION } = require('../services/sms-gratitude');
    const id = await draftShadowReply({
      inboundMessage: 'Thanks!',
      fromPhone: '+15550000001',
      customer: { id: 'customer-fixture-1', first_name: 'Casey' },
      smsLogId: 'sms-fixture-1',
      intent: { intent: 'general_customer_sms_needs_review', confidence: 0.4 },
      source: 'live_webhook',
      hasMedia: false,
      ...requestOverrides,
    });

    return {
      id,
      insertedRows,
      GRATITUDE_INTENT,
      GRATITUDE_POLICY_VERSION,
      dispatchWithFallback,
      createDeepMessage,
      providerCreate,
      maybeAutoSend,
      publishSuggestion,
      supersedeStaleSuggestions,
      resolveDeliveryMode,
    };
  }

  function expectNoWebhookDelivery(result) {
    expect(result.maybeAutoSend).not.toHaveBeenCalled();
    expect(result.publishSuggestion).not.toHaveBeenCalled();
    expect(result.supersedeStaleSuggestions).not.toHaveBeenCalled();
    expect(result.providerCreate).not.toHaveBeenCalled();
  }

  test('persists a verified live-webhook gratitude reply as provenance-stamped shadow only', async () => {
    const result = await runDraft({
      reply: 'Our pleasure, Casey!',
      intended_actions: [{ type: 'none' }],
      missing_info: null,
    });

    expect(result.id).toBe('draft-gratitude-1');
    expect(result.resolveDeliveryMode).toHaveBeenCalledWith(expect.objectContaining({
      intent: result.GRATITUDE_INTENT,
      reply: 'Our pleasure, Casey!',
    }));
    expect(result.dispatchWithFallback).toHaveBeenCalledTimes(1);
    expect(result.createDeepMessage).toHaveBeenCalledTimes(1);
    expect(result.insertedRows).toHaveLength(1);

    const stored = result.insertedRows[0];
    expect(stored).toMatchObject({
      sms_log_id: 'sms-fixture-1',
      customer_id: 'customer-fixture-1',
      inbound_message: 'Thanks!',
      draft_response: 'Our pleasure, Casey!',
      intent: result.GRATITUDE_INTENT,
      intent_confidence: 1,
      status: 'shadow',
      model: 'fixture-model',
      prompt_version: 'house_voice_v11',
    });
    expect(JSON.parse(stored.intended_actions)).toEqual({
      actions: [{ type: 'none' }],
      missing_info: null,
      verify: { passes: 1, converged: true },
      voice_profile_version: null,
      gratitude: {
        source: 'live_webhook',
        policy_version: result.GRATITUDE_POLICY_VERSION,
        actions_verified_safe: true,
        verifier_enabled: true,
      },
    });
    expectNoWebhookDelivery(result);
  });

  test('records unknown raw actions as unsafe even after sanitizing them away, and never delivers', async () => {
    const result = await runDraft({
      reply: 'Our pleasure, Casey!',
      intended_actions: [{ type: 'cancel_service' }],
      missing_info: null,
    });

    const metadata = JSON.parse(result.insertedRows[0].intended_actions);
    expect(metadata.actions).toEqual([]);
    expect(metadata.verify).toEqual({ passes: 1, converged: true });
    expect(metadata.gratitude).toEqual({
      source: 'live_webhook',
      policy_version: result.GRATITUDE_POLICY_VERSION,
      actions_verified_safe: false,
      verifier_enabled: true,
    });
    expectNoWebhookDelivery(result);
  });

  test('persists a no-reply gratitude draft as shadow without verification or delivery', async () => {
    const result = await runDraft({
      reply: '',
      intended_actions: [{ type: 'none', note: 'no reply warranted' }],
      missing_info: null,
    });

    expect(result.insertedRows[0]).toMatchObject({
      draft_response: '',
      intent: result.GRATITUDE_INTENT,
      status: 'shadow',
    });
    const metadata = JSON.parse(result.insertedRows[0].intended_actions);
    expect(metadata.verify).toEqual({ passes: 1, converged: true });
    expect(metadata.gratitude.actions_verified_safe).toBe(true);
    expect(result.createDeepMessage).not.toHaveBeenCalled();
    expectNoWebhookDelivery(result);
  });

  test.each([
    ['a non-live source', { source: 'historical_replay' }],
    ['an inbound attachment', { hasMedia: true }],
  ])('%s cannot receive live gratitude provenance', async (_label, boundary) => {
    const result = await runDraft({
      reply: 'A regular draft.',
      intended_actions: [{ type: 'none' }],
      missing_info: null,
    }, { ...boundary, deliveryMode: 'shadow' });

    const stored = result.insertedRows[0];
    expect(stored.intent).toBe('general_customer_sms_needs_review');
    expect(JSON.parse(stored.intended_actions)).not.toHaveProperty('gratitude');
    expectNoWebhookDelivery(result);
  });
});
