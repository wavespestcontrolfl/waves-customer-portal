jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const db = require('../models/db');
const logger = require('../services/logger');
const assistant = require('../services/ai-assistant/assistant');

// Live case 2026-08-25: the escalate tool's model-written reason exceeded
// agent_sessions.escalation_reason varchar(255); the UPDATE threw, bubbled to
// processMessage's outer catch, and the customer got the generic error
// fallback instead of the escalation confirmation. Once the ai_escalations
// row exists, bookkeeping failures must not eat the reply.
describe('escalate resilience', () => {
  beforeEach(() => jest.clearAllMocks());

  const conversation = {
    id: 'conv-1',
    customer_id: null,
    channel: 'portal_chat',
  };

  function mockDb({ sessionUpdateError, messageInsertError } = {}) {
    db.mockImplementation((table) => {
      if (table === 'ai_escalations') {
        return {
          insert: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([{ id: 'esc-1' }]),
          }),
        };
      }
      if (table === 'agent_sessions') {
        return {
          where: jest.fn().mockReturnThis(),
          update: jest.fn(() => sessionUpdateError
            ? Promise.reject(sessionUpdateError)
            : Promise.resolve(1)),
        };
      }
      if (table === 'agent_messages') {
        return {
          insert: jest.fn(() => messageInsertError
            ? Promise.reject(messageInsertError)
            : Promise.resolve([1])),
        };
      }
      throw new Error(`unexpected table ${table}`);
    });
  }

  test('returns the escalation reply even when the session bookkeeping update fails', async () => {
    mockDb({ sessionUpdateError: new Error('value too long for type character varying(255)') });

    const result = await assistant.escalate(conversation, 'We got a new dog', 'x'.repeat(400));

    expect(result.escalated).toBe(true);
    expect(result.escalationId).toBe('esc-1');
    expect(result.reply).toMatch(/connecting you with our team/i);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Failed to mark session escalated'),
      expect.objectContaining({ conversationId: 'conv-1' }),
    );
  });

  test('returns the escalation reply even when saving the reply transcript fails', async () => {
    mockDb({ messageInsertError: new Error('insert failed') });

    const result = await assistant.escalate(conversation, 'hello', 'reason');

    expect(result.escalated).toBe(true);
    expect(result.reply).toMatch(/connecting you with our team/i);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Failed to save escalation reply'),
      expect.objectContaining({ conversationId: 'conv-1' }),
    );
  });

  test('happy path still marks the session escalated', async () => {
    mockDb();

    const result = await assistant.escalate(conversation, 'hello', 'reason');

    expect(result.escalated).toBe(true);
    expect(logger.error).not.toHaveBeenCalled();
  });
});
