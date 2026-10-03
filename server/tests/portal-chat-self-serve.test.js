// Portal chat hands the customer a working path, and a hand-off tells the
// truth. Before this: the assistant escalated every reschedule and billing
// ask, the hand-off was a queue row nobody was shown, and the reply said a
// team member had been notified (prod, 60 days to 2026-10-01: 48 of 60 portal
// chats escalated, 49 escalation rows never claimed).
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../routes/reschedule-public', () => ({
  _internals: { loadById: jest.fn(async (id) => ({ id })), pageEligibility: jest.fn() },
}));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn() }));

const db = require('../models/db');
const { loadById, pageEligibility } = require('../routes/reschedule-public')._internals;
const NotificationService = require('../services/notification-service');
const { TOOLS, PORTAL_TOOLS, executeToolCall } = require('../services/ai-assistant/tools');
const assistant = require('../services/ai-assistant/assistant');

const ENV = 'PORTAL_CHAT_SELF_SERVE';

function mockUpcoming(rows) {
  const query = {
    where: jest.fn().mockReturnThis(),
    whereIn: jest.fn().mockReturnThis(),
    whereNotNull: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    // One page of twelve per call, like the real query.
    offset: jest.fn(async (n) => rows.slice(n, n + 12)),
  };
  db.mockReturnValue(query);
  return query;
}

beforeEach(() => {
  jest.clearAllMocks();
  loadById.mockImplementation(async (id) => ({ id }));
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

  test('offer_reschedule_link builds a button only for a visit the reschedule page itself accepts', async () => {
    const query = mockUpcoming([
      { id: 1, scheduled_date: new Date('2026-10-09T00:00:00Z'), service_type: 'Pest Control', window_start: '10:00', reschedule_token: 'tok_one' },
      { id: 2, scheduled_date: '2026-10-20', service_type: 'Lawn Care', window_start: '13:00', reschedule_token: 'tok_two' },
      { id: 3, scheduled_date: '2026-10-21', service_type: 'Termite', window_start: '08:00', reschedule_token: 'tok_three' },
      { id: 4, scheduled_date: '2026-10-22', service_type: 'Rodent', window_start: '08:00', reschedule_token: 'tok_four' },
    ]);
    // The page's own verdicts: inside the move notice window, awaiting
    // dispatch review, and an unreadable check all mean no button.
    pageEligibility.mockImplementation(async (svc) => {
      if (svc.id === 2) return { ok: false, reason: 'self_serve_notice' };
      if (svc.id === 3) return { ok: false, reason: 'pending_review' };
      if (svc.id === 4) throw new Error('lookup failed');
      return { ok: true };
    });
    const actions = [];

    const result = await executeToolCall('offer_reschedule_link', {}, 'cust-1', actions);

    expect(query.where).toHaveBeenCalledWith('customer_id', 'cust-1');
    expect(query.whereIn).toHaveBeenCalledWith('status', ['pending', 'confirmed', 'rescheduled']);
    // A legacy visit with no token never reaches the check.
    expect(query.whereNotNull).toHaveBeenCalledWith('reschedule_token');
    expect(loadById.mock.calls.map(([id]) => id)).toEqual([1, 2, 3, 4]);
    expect(actions).toEqual([{ type: 'link', label: 'Reschedule Pest Control, Oct 9', href: '/reschedule/tok_one' }]);
    expect(result.available).toBe(true);
    expect(result.visits).toEqual([expect.objectContaining({ date: '2026-10-09', type: 'Pest Control' })]);
    // The model is told a button exists, never handed the link itself.
    expect(JSON.stringify(result)).not.toContain('tok_one');
  });

  test('visits the page refuses do not hide a later one it accepts, and buttons stop at three', async () => {
    const query = mockUpcoming(Array.from({ length: 8 }, (_, i) => ({
      id: i + 1, scheduled_date: `2026-10-${String(10 + i).padStart(2, '0')}`, service_type: 'Pest Control', window_start: '10:00', reschedule_token: `tok_${i + 1}`,
    })));
    pageEligibility.mockImplementation(async (svc) => ({ ok: svc.id > 3 }));
    const actions = [];

    const result = await executeToolCall('offer_reschedule_link', {}, 'cust-1', actions);

    expect(actions.map((a) => a.href)).toEqual(['/reschedule/tok_4', '/reschedule/tok_5', '/reschedule/tok_6']);
    expect(result.visits).toHaveLength(3);
    // Stops checking once three buttons exist.
    expect(loadById).toHaveBeenCalledTimes(6);
  });

  test('a full page of refused visits does not hide a movable one on the next page', async () => {
    const query = mockUpcoming(Array.from({ length: 14 }, (_, i) => ({
      id: i + 1, scheduled_date: '2026-10-10', service_type: 'Pest Control', window_start: '10:00', reschedule_token: `tok_${i + 1}`,
    })));
    pageEligibility.mockImplementation(async (svc) => (svc.id === 13 ? { ok: true } : { ok: false, reason: 'grouped' }));
    const actions = [];

    const result = await executeToolCall('offer_reschedule_link', {}, 'cust-1', actions);

    expect(query.offset.mock.calls.map(([n]) => n)).toEqual([0, 12]);
    expect(actions.map((a) => a.href)).toEqual(['/reschedule/tok_13']);
    expect(result.available).toBe(true);
  });

  test('visits at more than one property carry the street on the button', async () => {
    mockUpcoming([
      { id: 1, scheduled_date: '2026-10-09', service_type: 'Pest Control', window_start: '10:00', reschedule_token: 'tok_one' },
      { id: 2, scheduled_date: '2026-10-09', service_type: 'Pest Control', window_start: '13:00', reschedule_token: 'tok_two' },
    ]);
    loadById.mockImplementation(async (id) => ({ id, address_line1: id === 1 ? '100 Example Ave' : '200 Sample Ct' }));
    pageEligibility.mockResolvedValue({ ok: true });
    const actions = [];

    const result = await executeToolCall('offer_reschedule_link', {}, 'cust-1', actions);

    expect(actions.map((a) => a.label)).toEqual([
      'Reschedule Pest Control, Oct 9, 100 Example Ave',
      'Reschedule Pest Control, Oct 9, 200 Sample Ct',
    ]);
    // The street is on the button only. Nothing the model receives carries it.
    expect(JSON.stringify(result)).not.toMatch(/Example Ave|Sample Ct/);
    expect(result.instruction).toMatch(/each naming its property/);
  });

  test('every button a tool reports as shown is in the reply, whatever came before it', async () => {
    const actions = [];
    for (const section of ['billing', 'upcoming_visits', 'service_reports', 'plan', 'documents', 'referrals']) {
      expect((await executeToolCall('open_portal_section', { section }, 'cust-1', actions)).shown).toBe(true);
    }
    mockUpcoming([1, 2, 3].map((id) => ({ id, scheduled_date: `2026-10-1${id}`, service_type: 'Pest Control', window_start: '10:00', reschedule_token: `tok_${id}` })));
    pageEligibility.mockResolvedValue({ ok: true });

    const result = await executeToolCall('offer_reschedule_link', {}, 'cust-1', actions);

    expect(result.visits).toHaveLength(3);
    expect(actions.filter((a) => a.type === 'link')).toHaveLength(3);
    expect(actions).toHaveLength(9);
  });

  test('no movable visit tells the model to hand off, and shows no button', async () => {
    mockUpcoming([{ id: 1, scheduled_date: '2026-10-09', service_type: 'Pest Control', window_start: '10:00', reschedule_token: 'tok_one' }]);
    pageEligibility.mockResolvedValue({ ok: false, reason: 'grouped' });
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
    NotificationService.notifyAdmin.mockResolvedValue({ id: 'n-1', category: 'alert', deduped: false });

    const result = await assistant.escalate(conversation, 'Why was I charged twice on 2026-09-30?!', 'billing question', { topic: 'billing' });

    // composeAdminAlert ran for real (it throws in tests on any rule break).
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
    const [category, headline, why, opts] = NotificationService.notifyAdmin.mock.calls[0];
    expect(category).toBe('alert');
    expect(headline).toBe('Comms — Reply to a portal chat request');
    expect(why).toBe('Jordan Sample asked the portal assistant about a billing question');
    expect(opts).toEqual(expect.objectContaining({
      bell: true,
      link: '/admin/customers?customerId=cust-1',
      dedupeKey: 'portal-chat-escalation:esc-1',
      detail: 'Why was I charged twice on 2026-09-30?!',
    }));
    expect(opts.metadata).toEqual(expect.objectContaining({
      severity: 'needs-you', who: 'person', doneWhen: 'customer_answered', escalationId: 'esc-1',
      subject: { type: 'customer', id: 'cust-1' },
      // The relevance sweep reads the topic (an add_service bell closes on an estimate).
      topic: 'billing',
    }));
    expect(result.teamNotified).toBe(true);
    expect(result.reply).toMatch(/I've sent this to our team/);
    expect(result.reply).not.toMatch(/connecting you/i);
  });

  test('the bell names the topic the hand-off carried, never a keyword guess, and keeps the whole message', async () => {
    mockEscalationDb();
    NotificationService.notifyAdmin.mockResolvedValue({ id: 'n-1', deduped: false });
    // "change" would read as a schedule change to the legacy keyword classifier.
    const long = `Please change my email to a new one. ${'More detail. '.repeat(250)}`;

    await assistant.escalate(conversation, long, 'email change', { topic: 'account_change' });
    await assistant.escalate(conversation, 'something odd', 'unclear');

    const calls = NotificationService.notifyAdmin.mock.calls;
    expect(calls[0][2]).toBe('Jordan Sample asked the portal assistant about an account change');
    expect(calls[0][3].detail).toBe(long);
    expect(long.length).toBeGreaterThan(3000);
    expect(calls[1][2]).toBe('Jordan Sample asked the portal assistant about a request it could not handle');
  });

  test('when the bell does not ring the customer is not told anyone was notified', async () => {
    mockEscalationDb();
    NotificationService.notifyAdmin.mockRejectedValue(new Error('db down'));

    const result = await assistant.escalate(conversation, 'gate code changed', 'account change');

    expect(result.escalated).toBe(true);
    expect(result.escalationId).toBe('esc-1');
    expect(result.teamNotified).toBe(false);
    expect(result.reply).toMatch(/saved your request/);
    // The general support line, not a location's own number.
    expect(result.reply).toMatch(/\(941\) 297-5749/);
    expect(result.reply).not.toMatch(/sent this to our team|notified/i);
  });

  test.each([
    ['a failed write', null],
    ['a withheld bell (demo account)', { id: null, suppressed: true }],
  ])('%s is not a notification', async (_name, returned) => {
    mockEscalationDb();
    NotificationService.notifyAdmin.mockResolvedValue(returned);
    const result = await assistant.escalate(conversation, 'hello', 'reason');
    expect(result.teamNotified).toBe(false);
    expect(result.reply).toMatch(/saved your request/);
  });

  test('a bell already standing for this hand-off counts as notified', async () => {
    mockEscalationDb();
    NotificationService.notifyAdmin.mockResolvedValue({ id: 'n-1', deduped: true });
    expect((await assistant.escalate(conversation, 'hello', 'reason')).teamNotified).toBe(true);
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
