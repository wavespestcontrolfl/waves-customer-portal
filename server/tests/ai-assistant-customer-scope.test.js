jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const db = require('../models/db');
const logger = require('../services/logger');
const { TOOLS, executeToolCall } = require('../services/ai-assistant/tools');
const assistant = require('../services/ai-assistant/assistant');

describe('customer-facing AI data boundary', () => {
  beforeEach(() => jest.clearAllMocks());

  test('publishes only scheduling, knowledge, and escalation tools to the model', () => {
    expect(TOOLS.map((tool) => tool.name)).toEqual([
      'get_upcoming_services',
      'get_pest_advice',
      'escalate',
    ]);
    expect(TOOLS.map((tool) => tool.name)).not.toEqual(expect.arrayContaining([
      'lookup_customer',
      'get_billing_info',
      'get_service_history',
      'get_call_history',
    ]));
  });

  test('rejects a model attempt to override the authenticated customer ID', async () => {
    const result = await executeToolCall(
      'get_upcoming_services',
      { customer_id: 'victim-customer' },
      'authenticated-customer',
    );

    expect(result).toEqual({ error: 'Customer scope mismatch' });
    expect(db).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('blocked cross-customer'));
  });

  test('queries upcoming services only with the authenticated customer ID', async () => {
    const rows = [{
      scheduled_date: '2026-07-20',
      service_type: 'Pest Control',
      window_start: '09:00',
      window_end: '11:00',
      status: 'confirmed',
    }];
    const query = {
      where: jest.fn().mockReturnThis(),
      whereIn: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue(rows),
    };
    db.mockReturnValue(query);

    const result = await executeToolCall(
      'get_upcoming_services',
      { customer_id: 'authenticated-customer' },
      'authenticated-customer',
    );

    expect(query.where).toHaveBeenCalledWith('customer_id', 'authenticated-customer');
    expect(result.services).toEqual([expect.objectContaining({
      date: '2026-07-20',
      type: 'Pest Control',
      status: 'confirmed',
    })]);
    expect(JSON.stringify(result)).not.toMatch(/technician|notes|card|balance|phone|address/i);
  });

  test('conversation reuse is scoped by channel, identifier, and customer', async () => {
    const whereCalls = [];
    const sessionQuery = {
      where: jest.fn((...args) => {
        whereCalls.push(args);
        return sessionQuery;
      }),
      whereNull: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue({
        id: 'own-conversation',
        customer_id: 'authenticated-customer',
        channel: 'portal_chat',
        context_snapshot: { version: 2, firstName: 'Taylor' },
      }),
    };
    db.mockImplementation((table) => {
      if (table === 'agent_sessions') return sessionQuery;
      throw new Error(`Unexpected table ${table}`);
    });

    const conversation = await assistant.getOrCreateConversation(
      'portal_chat',
      'guessable-session',
      'authenticated-customer',
      '+19415550100',
    );

    expect(conversation.id).toBe('own-conversation');
    expect(whereCalls).toContainEqual([{
      channel: 'portal_chat',
      channel_identifier: 'guessable-session',
      status: 'active',
    }]);
    expect(whereCalls).toContainEqual([{ customer_id: 'authenticated-customer' }]);
  });

  test('retires legacy full-context conversations instead of reusing sensitive history', async () => {
    const legacyQuery = {
      where: jest.fn().mockReturnThis(),
      whereNull: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue({
        id: 'legacy-conversation',
        customer_id: 'authenticated-customer',
        context_snapshot: 'Taylor Customer | Gold ($99/mo) | $120 overdue',
      }),
    };
    const staleQuery = {
      where: jest.fn().mockReturnThis(),
      whereNull: jest.fn().mockReturnThis(),
      update: jest.fn().mockResolvedValue(1),
    };
    const customerQuery = {
      where: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue({ first_name: 'Taylor' }),
    };
    const insertReturning = jest.fn().mockResolvedValue([{ id: 'new-minimal-conversation' }]);
    const insertQuery = {
      insert: jest.fn().mockReturnValue({ returning: insertReturning }),
    };
    let sessionCalls = 0;
    db.mockImplementation((table) => {
      if (table === 'customers') return customerQuery;
      if (table === 'agent_sessions') {
        sessionCalls += 1;
        if (sessionCalls === 1) return legacyQuery;
        if (sessionCalls === 2) return staleQuery;
        return insertQuery;
      }
      throw new Error(`Unexpected table ${table}`);
    });

    const conversation = await assistant.getOrCreateConversation(
      'portal_chat',
      'session-1',
      'authenticated-customer',
      '+19415550100',
    );

    expect(conversation.id).toBe('new-minimal-conversation');
    expect(staleQuery.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'timeout' }));
    expect(insertQuery.insert).toHaveBeenCalledWith(expect.objectContaining({
      customer_id: 'authenticated-customer',
      context_snapshot: { version: 2, firstName: 'Taylor' },
    }));
    expect(JSON.stringify(insertQuery.insert.mock.calls)).not.toContain('$99');
    expect(JSON.stringify(insertQuery.insert.mock.calls)).not.toContain('overdue');
  });
});
