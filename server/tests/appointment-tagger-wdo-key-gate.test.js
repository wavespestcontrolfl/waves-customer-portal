// Codex round (07-18, P3): triggerWDOPrep gated the AI brief on
// ANTHROPIC_API_KEY alone, so in OpenAI-only environments the deepAnalysis
// OpenAI fallback was unreachable and every WDO brief silently fell back to
// the deterministic template. The gate is EITHER provider key —
// dispatchWithFallback owns the per-provider no_key miss.

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn() }));
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn() }));
jest.mock('../services/property-lookup/ai-property-lookup', () => ({
  lookupPropertyFromAITrio: jest.fn(async () => null),
}));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/new-recurring-welcome-sms', () => ({
  sendNewRecurringWelcome: jest.fn(async () => ({ sent: false })),
  isNewRecurringSignupCandidate: jest.fn(async () => false),
}));
jest.mock('../services/sms-template-renderer', () => ({ renderSmsTemplate: jest.fn(async () => null) }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => false) }));

const db = require('../models/db');
const { dispatchWithFallback } = require('../services/llm/call');
const tagger = require('../services/appointment-tagger');

function chain() {
  const c = {
    where: jest.fn(() => c),
    update: jest.fn(async () => 1),
    insert: jest.fn(async () => 1),
  };
  return c;
}

const service = {
  id: 'svc-wdo-1',
  customer_id: 'cust-wdo-1',
  address_line1: '100 Unit Test Way',
  city: 'Venice',
  zip: '34285',
  first_name: 'Test',
  last_name: 'Fixture',
  scheduled_date: '2026-07-20',
};

describe('triggerWDOPrep provider-key gate', () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...OLD_ENV };
    db.mockImplementation(() => chain());
  });

  afterAll(() => {
    process.env = OLD_ENV;
  });

  test('OpenAI-only environment reaches the AI brief path', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-unit-test';
    dispatchWithFallback.mockResolvedValue({
      ok: true,
      json: { risk_score: 'Low', top_3_priorities: ['perimeter'] },
      model: 'unit-test-model-id',
    });

    await tagger.triggerWDOPrep({ ...service });

    expect(dispatchWithFallback).toHaveBeenCalledTimes(1);
  });

  test('Anthropic-only environment still reaches the AI brief path', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-unit-test';
    delete process.env.OPENAI_API_KEY;
    dispatchWithFallback.mockResolvedValue({
      ok: true,
      json: { risk_score: 'Low', top_3_priorities: ['perimeter'] },
      model: 'unit-test-model-id',
    });

    await tagger.triggerWDOPrep({ ...service });

    expect(dispatchWithFallback).toHaveBeenCalledTimes(1);
  });

  test('no provider key at all → deterministic template, no AI dispatch', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;

    await tagger.triggerWDOPrep({ ...service });

    expect(dispatchWithFallback).not.toHaveBeenCalled();
  });
});
