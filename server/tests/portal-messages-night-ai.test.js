// GATE_PORTAL_MESSAGES_NIGHT_AI, the parts that need no database: the gate reads strictly at call time, the
// assistant's hold seam files nothing (and only when a caller sets it), the thread's turn has its four tools
// (stay_silent answers only there), and the message type SQL in portal-inbox.js matches the one
// portal-messages.js writes.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
process.env.ANTHROPIC_API_KEY = 'test-key';

const fs = require('fs');
const path = require('path');

// Any database use is a failure: the hold seam and the tool holds must touch nothing.
const mockDbUse = jest.fn();
jest.mock('../models/db', () => {
  const handler = { apply: () => { mockDbUse('call'); throw new Error('database used'); }, get: (_, key) => { if (key === 'then') return undefined; mockDbUse(String(key)); throw new Error('database used'); } };
  return new Proxy(function db() {}, handler);
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('@anthropic-ai/sdk', () => jest.fn());

const gates = require('../config/feature-gates');
const NightAi = require('../services/portal-messages-night-ai');
const PortalMessages = require('../services/portal-messages');
const assistant = require('../services/ai-assistant/assistant');
const { THREAD_TOOLS, executeToolCall } = require('../services/ai-assistant/tools');

afterEach(() => { delete process.env.GATE_PORTAL_MESSAGES_NIGHT_AI; mockDbUse.mockClear(); });

describe('GATE_PORTAL_MESSAGES_NIGHT_AI', () => {
  it('is dark unless exactly true, read at call time', () => {
    expect(gates.portalMessagesNightAiLive()).toBe(false);
    for (const value of ['1', 'TRUE', 'yes', 'false', '']) {
      process.env.GATE_PORTAL_MESSAGES_NIGHT_AI = value;
      expect(gates.portalMessagesNightAiLive()).toBe(false);
    }
    process.env.GATE_PORTAL_MESSAGES_NIGHT_AI = 'true';
    expect(gates.portalMessagesNightAiLive()).toBe(true);
    delete process.env.GATE_PORTAL_MESSAGES_NIGHT_AI;
    expect(gates.portalMessagesNightAiLive()).toBe(false);
  });

  it('needs the portal messages, the Portal tab and Ask Waves on as well', () => {
    const keep = { ...process.env };
    try {
      process.env.GATE_PORTAL_MESSAGES_NIGHT_AI = 'true';
      process.env.GATE_PORTAL_MESSAGES = 'true';
      process.env.GATE_PORTAL_INBOX = 'true';
      expect(NightAi.enabled()).toBe(true);
      process.env.PORTAL_CHAT_SELF_SERVE = 'off';
      expect(NightAi.enabled()).toBe(false);
      delete process.env.PORTAL_CHAT_SELF_SERVE;
      process.env.GATE_PORTAL_INBOX = 'false';
      expect(NightAi.enabled()).toBe(false);
      process.env.GATE_PORTAL_INBOX = 'true';
      process.env.GATE_PORTAL_MESSAGES = 'false';
      expect(NightAi.enabled()).toBe(false);
    } finally {
      for (const key of ['GATE_PORTAL_MESSAGES_NIGHT_AI', 'GATE_PORTAL_MESSAGES', 'GATE_PORTAL_INBOX', 'PORTAL_CHAT_SELF_SERVE']) {
        if (keep[key] === undefined) delete process.env[key]; else process.env[key] = keep[key];
      }
    }
  });
});

describe('the hand-off sentence and the message type', () => {
  it('is one exported constant the owner can change', () => {
    expect(NightAi.HAND_OFF_REPLY).toBe('Thanks for your message. A member of our team will answer here after 8 AM.');
    expect(NightAi.HAND_OFF_REPLY).not.toMatch(/Waves Pest Control/);
  });

  it('portal-inbox.js repeats the message type portal-messages.js writes', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'services', 'portal-inbox.js'), 'utf8');
    expect(source).toContain(`const AI_TYPE_SQL = \`'${PortalMessages.AI_MESSAGE_TYPE}'\`;`);
  });

  it('an unreadable time is not after hours', () => {
    expect(NightAi.isAfterHours('not a date')).toBe(false);
  });

  it('the same message always names the same turn request id, a uuid', () => {
    const id = NightAi.turnRequestId('11111111-2222-4333-8444-555555555555');
    expect(id).toBe(NightAi.turnRequestId('11111111-2222-4333-8444-555555555555'));
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(id).not.toBe(NightAi.turnRequestId('11111111-2222-4333-8444-555555555556'));
  });
});

describe('the assistant\'s hold seam', () => {
  const conversation = { id: 'conv-1', channel: 'portal_chat', customer_id: 'cust-1' };

  it('files nothing, rings nothing and returns the decision when the caller holds the hand-off', async () => {
    const turn = { holdHandOff: true };
    const result = await assistant.escalate(conversation, 'The tech broke my plant', 'Complaint', { turn, topic: 'complaint', open: true });
    expect(result).toEqual({ reply: '', conversationId: 'conv-1', escalated: true, handOffHeld: true, reason: 'Complaint', topic: 'complaint' });
    expect(mockDbUse).not.toHaveBeenCalled();
  });

  it('is off for every other turn: a turn without the flag still files (it reaches the database)', async () => {
    await expect(assistant.escalate(conversation, 'Help', 'Reason', { turn: {} })).rejects.toThrow();
    await expect(assistant.escalate(conversation, 'Help', 'Reason')).rejects.toThrow();
    expect(mockDbUse).toHaveBeenCalled();
  });
});

describe('the assistant\'s history seam', () => {
  it('returns the history a caller supplied on the turn without reading the private transcript', async () => {
    const supplied = [{ role: 'user', content: 'thread text' }];
    expect(await assistant.buildHistory('conv-1', { newest: true, turn: { threadHistory: supplied } })).toBe(supplied);
    expect(mockDbUse).not.toHaveBeenCalled();
    await expect(assistant.buildHistory('conv-1', { newest: true, turn: {} })).rejects.toThrow();
    expect(mockDbUse).toHaveBeenCalled();
  });
});

describe('the Messages thread\'s tools', () => {
  it('are exactly the four of the thread lane', () => {
    expect(THREAD_TOOLS.map((tool) => tool.name)).toEqual(['get_upcoming_services', 'offer_reschedule_link', 'stay_silent', 'escalate']);
  });

  it('stay_silent answers only on the Messages thread\'s turn, and touches no database', async () => {
    expect(await executeToolCall('stay_silent', { why: 'thanks' }, 'cust-1', null, null, { thread: true })).toEqual({ silent: true, why: 'thanks' });
    expect(await executeToolCall('stay_silent', { why: 'thanks' }, 'cust-1', null, null, {})).toEqual({ error: 'Unknown tool: stay_silent' });
    expect(await executeToolCall('stay_silent', { why: 'thanks' }, 'cust-1', [], [], { open: true, thread: false })).toEqual({ error: 'Unknown tool: stay_silent' });
    expect(mockDbUse).not.toHaveBeenCalled();
  });
});
