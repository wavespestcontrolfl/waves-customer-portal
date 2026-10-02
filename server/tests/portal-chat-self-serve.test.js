// Portal chat hands the customer a working path, and a hand-off tells the
// truth. Before this: the assistant escalated every reschedule and billing
// ask, the hand-off was a queue row nobody was shown, and the reply said a
// team member had been notified (prod, 60 days to 2026-10-01: 48 of 60 portal
// chats escalated, 49 escalation rows never claimed).
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../routes/reschedule-public', () => ({ groupedVisit: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn() }));

const db = require('../models/db');
const { groupedVisit } = require('../routes/reschedule-public');
const NotificationService = require('../services/notification-service');
const { TOOLS, PORTAL_TOOLS, executeToolCall } = require('../services/ai-assistant/tools');
const assistant = require('../services/ai-assistant/assistant');

const ENV = 'PORTAL_CHAT_SELF_SERVE';

function mockUpcoming(rows) {
  const query = {
    where: jest.fn().mockReturnThis(),
    whereIn: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue(rows),
  };
  db.mockReturnValue(query);
  return query;
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env[ENV];
});
afterAll(() => { delete process.env[ENV]; });

describe('portal tools', () => {
  test('the portal gets the two button tools; every other channel keeps the original three', () => {
    expect(TOOLS.map((t) => t.name)).toEqual(['get_upcoming_services', 'get_pest_advice', 'escalate']);
    expect(PORTAL_TOOLS.map((t) => t.name)).toEqual([
      'get_upcoming_services', 'get_pest_advice', 'offer_reschedule_link', 'open_portal_section', 'escalate',
    ]);
  });

  test('offer_reschedule_link builds a button only for a visit the self-serve page will accept', async () => {
    const query = mockUpcoming([
      { id: 1, visit_id: 'v1', scheduled_date: new Date('2026-10-09T00:00:00Z'), service_type: 'Pest Control', window_start: '10:00', reschedule_token: 'tok_one' },
      { id: 2, visit_id: 'v2', scheduled_date: '2026-10-20', service_type: 'Lawn Care', window_start: '13:00', reschedule_token: 'tok_two' },
      { id: 3, visit_id: null, scheduled_date: '2026-11-01', service_type: 'Mosquito', window_start: '09:00', reschedule_token: null },
    ]);
    groupedVisit.mockImplementation(async (row) => (row.id === 2 ? 'unknown' : false));
    const actions = [];

    const result = await executeToolCall('offer_reschedule_link', {}, 'cust-1', actions);

    expect(query.where).toHaveBeenCalledWith('customer_id', 'cust-1');
    expect(actions).toEqual([{ type: 'link', label: 'Reschedule Pest Control, Oct 9', href: '/reschedule/tok_one' }]);
    expect(result.available).toBe(true);
    expect(result.visits).toEqual([expect.objectContaining({ date: '2026-10-09', type: 'Pest Control' })]);
    // The model is told a button exists, never handed the link itself.
    expect(JSON.stringify(result)).not.toContain('tok_one');
  });

  test('no movable visit tells the model to hand off, and shows no button', async () => {
    mockUpcoming([{ id: 1, visit_id: 'v1', scheduled_date: '2026-10-09', service_type: 'Pest Control', window_start: '10:00', reschedule_token: 'tok_one' }]);
    groupedVisit.mockResolvedValue(true);
    const actions = [];

    const result = await executeToolCall('offer_reschedule_link', {}, 'cust-1', actions);

    expect(result.available).toBe(false);
    expect(result.instruction).toMatch(/escalate/);
    expect(actions).toEqual([]);
  });

  test('offer_reschedule_link refuses a model-supplied customer id', async () => {
    const actions = [];
    const result = await executeToolCall('offer_reschedule_link', { customer_id: 'someone-else' }, 'cust-1', actions);
    expect(result).toEqual({ error: 'Customer scope mismatch' });
    expect(db).not.toHaveBeenCalled();
    expect(actions).toEqual([]);
  });

  test('open_portal_section shows one button per known page and nothing for an unknown one', async () => {
    const actions = [];
    expect((await executeToolCall('open_portal_section', { section: 'billing' }, 'cust-1', actions)).shown).toBe(true);
    await executeToolCall('open_portal_section', { section: 'billing' }, 'cust-1', actions);
    expect((await executeToolCall('open_portal_section', { section: 'constructor' }, 'cust-1', actions)).shown).toBe(false);
    expect(actions).toEqual([{ type: 'tab', label: 'Open Billing', tab: 'billing' }]);
  });

  test('a channel that cannot render buttons gets none', async () => {
    expect((await executeToolCall('open_portal_section', { section: 'billing' }, 'cust-1')).shown).toBe(false);
    expect((await executeToolCall('offer_reschedule_link', {}, 'cust-1')).available).toBe(false);
  });
});

describe('reschedule asks reach the model on the portal only', () => {
  test('the pill text no longer hard-escalates in portal chat; SMS and the other triggers are unchanged', () => {
    expect(assistant.checkEscalationTriggers('Reschedule my visit', 'portal_chat')).toBe(false);
    expect(assistant.checkEscalationTriggers('Reschedule my visit', 'sms')).toBe(true);
    expect(assistant.checkEscalationTriggers('I want to cancel', 'portal_chat')).toBe(true);
    expect(assistant.checkEscalationTriggers('I want a refund', 'portal_chat')).toBe(true);
  });

  test('kill switch off restores the hard escalation', () => {
    process.env[ENV] = 'off';
    expect(assistant.checkEscalationTriggers('Reschedule my visit', 'portal_chat')).toBe(true);
  });
});

describe('a portal hand-off rings the office and says only what happened', () => {
  const conversation = { id: 'conv-1', customer_id: 'cust-1', channel: 'portal_chat' };
  const customer = { id: 'cust-1', first_name: 'Jordan', last_name: 'Sample' };

  function mockEscalationDb() {
    db.mockImplementation((table) => {
      if (table === 'customers') return { where: jest.fn().mockReturnThis(), first: jest.fn().mockResolvedValue(customer) };
      if (table === 'ai_escalations') return { insert: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([{ id: 'esc-1' }]) }) };
      if (table === 'agent_sessions') return { where: jest.fn().mockReturnThis(), update: jest.fn().mockResolvedValue(1) };
      if (table === 'agent_messages') return { insert: jest.fn().mockResolvedValue([1]) };
      throw new Error(`unexpected table ${table}`);
    });
  }

  test('rings one rule-compliant bell and promises a reply', async () => {
    mockEscalationDb();
    NotificationService.notifyAdmin.mockResolvedValue({ notification: { id: 'n-1' }, deduped: false });

    const result = await assistant.escalate(conversation, 'Why was I charged twice on 2026-09-30?!', 'billing question');

    // composeAdminAlert ran for real (it throws in tests on any rule break).
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
    const [category, headline, why, opts] = NotificationService.notifyAdmin.mock.calls[0];
    expect(category).toBe('alert');
    expect(headline).toBe('Comms — Reply to a portal chat request');
    expect(why).toBe('Jordan Sample asked the portal assistant about a billing question');
    expect(opts).toEqual(expect.objectContaining({
      bell: true,
      link: '/admin/communications?thread=cust-1',
      dedupeKey: 'portal-chat-escalation:esc-1',
      detail: 'Why was I charged twice on 2026-09-30?!',
    }));
    expect(opts.metadata).toEqual(expect.objectContaining({
      severity: 'needs-you', who: 'person', doneWhen: 'customer_answered', escalationId: 'esc-1',
      subject: { type: 'customer', id: 'cust-1' },
    }));
    expect(result.teamNotified).toBe(true);
    expect(result.reply).toMatch(/I've sent this to our team/);
    expect(result.reply).not.toMatch(/connecting you/i);
  });

  test('when the bell does not ring the customer is not told anyone was notified', async () => {
    mockEscalationDb();
    NotificationService.notifyAdmin.mockRejectedValue(new Error('db down'));

    const result = await assistant.escalate(conversation, 'gate code changed', 'account change');

    expect(result.escalated).toBe(true);
    expect(result.escalationId).toBe('esc-1');
    expect(result.teamNotified).toBe(false);
    expect(result.reply).toMatch(/saved your request/);
    expect(result.reply).toMatch(/\(941\) 318-7612/);
    expect(result.reply).not.toMatch(/sent this to our team|notified/i);
  });

  test('a suppressed bell (null) is not a notification either', async () => {
    mockEscalationDb();
    NotificationService.notifyAdmin.mockResolvedValue(null);
    expect((await assistant.escalate(conversation, 'hello', 'reason')).teamNotified).toBe(false);
  });

  test('kill switch off: legacy wording, no bell, no teamNotified field', async () => {
    process.env[ENV] = 'false';
    mockEscalationDb();

    const result = await assistant.escalate(conversation, 'hello', 'reason');

    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
    expect(result.reply).toMatch(/connecting you with our team/i);
    expect(result).not.toHaveProperty('teamNotified');
  });

  test('an SMS hand-off is unchanged: no bell from here, legacy wording', async () => {
    mockEscalationDb();
    const result = await assistant.escalate({ ...conversation, channel: 'sms' }, 'hello', 'reason');
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
    expect(result.reply).toMatch(/connecting you with our team/i);
    expect(result).not.toHaveProperty('teamNotified');
  });
});
