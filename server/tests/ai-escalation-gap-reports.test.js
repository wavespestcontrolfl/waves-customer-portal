/**
 * Texting AI → gap reports (server/services/agent-gap-reports.js).
 *
 * escalate() in both ai-assistant/assistant.js and
 * ai-assistant/managed-assistant.js records a gap ONLY when
 * classifyEscalation() lands on 'ai_uncertain' — every other reason
 * (cancellation, schedule_change, complaint, billing_dispute,
 * manager_request) is staff-handled by design, not a capability gap. The
 * call is fire-and-forget: a rejected write must never affect the
 * escalation reply.
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
// — one chainable stand-in covers assistant.js and managed-assistant.js alike.
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
  ['managed-assistant.js', () => require('../services/ai-assistant/managed-assistant')],
])('%s escalate()', (_name, load) => {
  const target = load();

  beforeEach(() => jest.clearAllMocks());

  test('a message with no classification keyword (ai_uncertain) records a gap with the escalation summary text', async () => {
    await target.escalate(conversation, 'the fish are dying, what do I do', 'AI-initiated escalation: unclear ask');
    expect(mockRecordGap).toHaveBeenCalledWith({
      source: 'texting-ai',
      summary: 'AI-initiated escalation: unclear ask',
      attempted: 'Customer text: the fish are dying, what do I do',
    });
  });

  test('an empty reason falls back to the customer message as the summary', async () => {
    await target.escalate(conversation, 'the fish are dying, what do I do', '');
    expect(mockRecordGap).toHaveBeenCalledWith({
      source: 'texting-ai',
      summary: 'the fish are dying, what do I do',
      attempted: 'Customer text: the fish are dying, what do I do',
    });
  });

  test.each([
    // Phrased to avoid escalate()'s own urgent-priority keywords (cancel,
    // lawsuit, bbb, complaint, not happy, refund) — priority is orthogonal
    // to classification, and an urgent reply would also try a live Twilio
    // owner-alert send this harness does not mock.
    ['please stop service on my account'],
    ['I need to reschedule my appointment'],
    ['the service was terrible this time'],
    ['I want to dispute this charge on my card'],
    ['let me speak to your supervisor'],
  ])('a classified reason ("%s") records no gap — staff-handled by design', async (message) => {
    await target.escalate(conversation, message, 'Sensitive topic detected in customer message');
    expect(mockRecordGap).not.toHaveBeenCalled();
  });

  test('never throws when the gap write rejects', async () => {
    mockRecordGap.mockRejectedValueOnce(new Error('db down'));
    await expect(target.escalate(conversation, 'something ai_uncertain here', 'x')).resolves.toMatchObject({ escalated: true });
  });
});
