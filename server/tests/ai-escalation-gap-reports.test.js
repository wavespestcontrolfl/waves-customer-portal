/**
 * Texting AI → gap reports (server/services/agent-gap-reports.js).
 *
 * escalate() in ai-assistant/assistant.js (the live texting and
 * portal-chat assistant) records a gap ONLY when its caller passes
 * { gap: true } — the escalate tool's optional not_supported flag. classifyEscalation's keyword
 * buckets play no part. The call is fire-and-forget: a rejected write must
 * never affect the escalation reply.
 */

const mockRecordGap = jest.fn(async () => []);
jest.mock('../services/agent-gap-reports', () => ({ recordGap: (...args) => mockRecordGap(...args) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/context-aggregator', () => jest.fn().mockImplementation(() => ({})));
jest.mock('../services/ai-assistant/tools-expanded', () => ({ executeToolCall: jest.fn() }));
jest.mock('../services/ai-assistant/managed-agent-config', () => ({ AGENT_CONFIG: { model: 'assistant-model' } }));
jest.mock('../services/llm-dispatch-metrics', () => ({ recordSessionUsage: jest.fn() }));

// Both escalate() implementations run the same three queries (insert
// ai_escalations → returning, update agent_sessions, insert agent_messages)
// — one chainable stand-in covers them.
jest.mock('../models/db', () => jest.fn((table) => {
  const chain = {
    where: jest.fn(() => chain),
    update: jest.fn(async () => 1),
    insert: jest.fn(() => chain),
    returning: jest.fn(async () => [{ id: 'esc-1' }]),
  };
  if (table === 'agent_messages') chain.insert = jest.fn(async () => [1]);
  return chain;
}));

const conversation = { id: 'conv-1', customer_id: null, channel: 'portal_chat' };

describe.each([
  ['assistant.js', () => require('../services/ai-assistant/assistant')],
])('%s escalate()', (_name, load) => {
  const target = load();

  beforeEach(() => jest.clearAllMocks());

  test('a gap escalation records the escalation reason with the customer text', async () => {
    await target.escalate(conversation, 'the fish are dying, what do I do', 'Unclear ask about fish', { gap: true });
    expect(mockRecordGap).toHaveBeenCalledWith({
      source: 'texting-ai',
      summary: 'Unclear ask about fish',
      attempted: 'Customer text: the fish are dying, what do I do',
    }, undefined);
  });

  test('an empty reason falls back to the customer message as the summary', async () => {
    await target.escalate(conversation, 'the fish are dying, what do I do', '', { gap: true });
    expect(mockRecordGap).toHaveBeenCalledWith({
      source: 'texting-ai',
      summary: 'the fish are dying, what do I do',
      attempted: 'Customer text: the fish are dying, what do I do',
    }, undefined);
  });

  test('a message the keyword classifier would bucket as a staff topic still records when the caller marks it a gap', async () => {
    await target.escalate(conversation, 'change the email on my account', 'Cannot update account email', { gap: true });
    expect(mockRecordGap).toHaveBeenCalledWith(expect.objectContaining({ summary: 'Cannot update account email' }), undefined);
  });

  test.each([
    ['the fish are dying, what do I do'],
    ['I need to reschedule my appointment'],
  ])('without { gap: true } nothing is recorded ("%s")', async (message) => {
    await target.escalate(conversation, message, 'Sensitive topic detected in customer message');
    expect(mockRecordGap).not.toHaveBeenCalled();
  });

  test('never throws when the gap write rejects', async () => {
    mockRecordGap.mockRejectedValueOnce(new Error('db down'));
    await expect(target.escalate(conversation, 'something unclear here', 'x', { gap: true })).resolves.toMatchObject({ escalated: true });
  });
});

describe('assistant.js escalate tool', () => {
  test('offers an optional not_supported flag (the live texting gap signal)', () => {
    const { TOOLS } = jest.requireActual('../services/ai-assistant/tools');
    const escalate = TOOLS.find((tool) => tool.name === 'escalate');
    expect(escalate.input_schema.properties.not_supported).toMatchObject({ type: 'boolean' });
    expect(escalate.input_schema.required).toEqual(['reason']);
  });
});
