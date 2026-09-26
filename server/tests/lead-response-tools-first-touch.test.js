/**
 * send_lead_response (services/lead-response-tools.js) — owner ruling
 * 2026-09-26: exactly one automated text ever reaches a new website lead.
 * The agent's personalized reply and the standard lead_auto_reply_biz reply
 * (services/lead-auto-reply.js) share ONE first-touch claim on the phone:
 *
 *   - Winning the claim (claimLeadFirstTouch → claimed:true) means this is
 *     the customer's first automated text, so it carries the same
 *     first-touch "Reply STOP to opt out." line the standard reply does.
 *   - Not winning it (a standard reply, or another run, already claimed
 *     this phone) means the STOP line already reached the customer, so the
 *     agent's message goes out unchanged.
 *   - The claim is settled (stamped with the real SID, or released) the
 *     same fail-closed way resolveLeadAutoReplyClaim always settles it —
 *     including when the send is blocked or the provider call throws.
 */

const mockMessage = jest.fn();
const mockClaim = jest.fn();
const mockResolveClaim = jest.fn();
const mockClearIntake = jest.fn();
const mockPipeline = jest.fn();
const mockBridge = jest.fn();

jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: (...args) => mockMessage(...args) }));
jest.mock('../services/lead-auto-reply', () => ({
  claimLeadFirstTouch: (...args) => mockClaim(...args),
  resolveLeadAutoReplyClaim: (...args) => mockResolveClaim(...args),
  clearServiceMenuIntakeState: (...args) => mockClearIntake(...args),
  isDeliveredSms: (result) => result?.sent === true && /^(SM|MM)/.test(String(result.providerMessageId || '')),
}));
jest.mock('../services/pipeline-manager', () => ({ onEvent: (...args) => mockPipeline(...args) }));
jest.mock('../services/lead-funnel-bridge', () => ({ bridgeLeadFunnelStage: (...args) => mockBridge(...args) }));
jest.mock('../services/short-url', () => ({}));
jest.mock('../services/pricing-authority-gate', () => ({}));
jest.mock('../services/estimate-automation-duplicates', () => ({
  blockIfAutomatedEstimateDuplicate: async () => null,
  withAutomatedEstimatePhoneLock: async (_phone, callback, { database }) => callback(database),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const mockState = {};
const mockDb = jest.fn(table => {
  const filters = {};
  const builder = {
    where: jest.fn((key, value) => {
      if (typeof key === 'function') key(builder);
      else Object.assign(filters, typeof key === 'object' ? key : { [key]: value });
      return builder;
    }),
    whereNull: jest.fn(key => { filters[key] = null; return builder; }),
    forUpdate: jest.fn(() => builder),
    forNoKeyUpdate: jest.fn(() => builder),
    first: jest.fn(async () => {
      const row = table === 'leads' ? mockState.lead : table === 'customers' ? mockState.customer : null;
      return row && Object.entries(filters).every(([key, value]) => (row[key] ?? null) === value) ? row : undefined;
    }),
    insert: jest.fn(value => {
      mockState.activity = { id: 'activity-1', ...value };
      const promise = Promise.resolve([mockState.activity]);
      return { returning: async () => [mockState.activity], then: promise.then.bind(promise), catch: promise.catch.bind(promise) };
    }),
    update: jest.fn(async value => {
      if (table === 'leads') Object.assign(mockState.lead, value);
      return 1;
    }),
  };
  return builder;
});
mockDb.transaction = jest.fn(async callback => callback(mockDb));
mockDb.raw = (sql, bindings) => ({ sql, bindings });
jest.mock('../models/db', () => mockDb);

const { executeLeadTool } = require('../services/lead-response-tools');
const context = {
  leadId: '00000000-0000-4000-8000-000000000001',
  customerId: '00000000-0000-4000-8000-000000000002',
  sessionId: 'session-1',
  toolUseId: 'tool-1',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockState.lead = { id: context.leadId, customer_id: context.customerId, phone: '+19415550100', status: 'new' };
  mockState.customer = { id: context.customerId, phone: '+19415550100', first_name: 'Sam' };
  mockState.activity = null;
  mockMessage.mockResolvedValue({ sent: true, providerMessageId: 'SM_fixture', auditLogId: 'audit-1' });
});

test('first touch: claims the phone, appends the STOP line, and stamps the claim on send', async () => {
  mockClaim.mockResolvedValue({ claimed: true, phoneDigits: '9415550100' });

  const result = await executeLeadTool('send_lead_response', { message: 'Thanks for reaching out!' }, context);

  expect(mockClaim).toHaveBeenCalledWith('+19415550100', context.customerId);
  expect(mockMessage).toHaveBeenCalledWith(expect.objectContaining({
    body: 'Thanks for reaching out!\n\nReply STOP to opt out.',
  }));
  expect(mockResolveClaim).toHaveBeenCalledWith('9415550100', { sent: true, providerMessageId: 'SM_fixture', auditLogId: 'audit-1' });
  expect(result).toMatchObject({ sent: true });
  // The personal text is what the customer answers now, not the standard
  // reply's service question — cleared at the send itself, so a later
  // session error or queue-for-review cannot leave the menu state behind.
  expect(mockClearIntake).toHaveBeenCalledWith(context.customerId);
});

test('a phone that already had its one automated text (claim not won) gets NO second text', async () => {
  mockClaim.mockResolvedValue({ claimed: false, phoneDigits: '9415550100' });

  const result = await executeLeadTool('send_lead_response', { message: 'Thanks for reaching out!' }, context);

  expect(mockMessage).not.toHaveBeenCalled();
  expect(mockResolveClaim).not.toHaveBeenCalled();
  expect(result).toMatchObject({ sent: false, blocked: true, code: 'FIRST_TOUCH_ALREADY_SENT' });
  expect(mockClearIntake).not.toHaveBeenCalled();
});

test('a success-shaped sentinel (template disabled) is NOT a delivered text — not auto_sent, claim settled on the raw result', async () => {
  mockClaim.mockResolvedValue({ claimed: true, phoneDigits: '9415550100' });
  const sentinel = { sent: true, providerMessageId: 'template-disabled', auditLogId: 'audit-2' };
  mockMessage.mockResolvedValue(sentinel);

  const result = await executeLeadTool('send_lead_response', { message: 'Hi there.' }, context);

  expect(mockResolveClaim).toHaveBeenCalledWith('9415550100', sentinel);
  expect(result).toMatchObject({ sent: false, blocked: true, code: 'NOT_DELIVERED' });
  expect(mockClearIntake).not.toHaveBeenCalled();
});

test('a blocked send still settles (releases) the first-touch claim', async () => {
  mockClaim.mockResolvedValue({ claimed: true, phoneDigits: '9415550100' });
  mockMessage.mockResolvedValue({ sent: false, blocked: true, code: 'SMS_OPTED_OUT' });

  const result = await executeLeadTool('send_lead_response', { message: 'Thanks for reaching out!' }, context);

  expect(result).toMatchObject({ sent: false, blocked: true, code: 'SMS_OPTED_OUT' });
  expect(mockResolveClaim).toHaveBeenCalledWith('9415550100', { sent: false, blocked: true, code: 'SMS_OPTED_OUT' });
});

test('a thrown provider send settles the claim on the fail-closed rules before rethrowing', async () => {
  mockClaim.mockResolvedValue({ claimed: true, phoneDigits: '9415550100' });
  const providerErr = new Error('network reset');
  mockMessage.mockRejectedValue(providerErr);

  await expect(executeLeadTool('send_lead_response', { message: 'Thanks for reaching out!' }, context)).rejects.toThrow('network reset');

  // No providerOutcome on the thrown error: ambiguous, so the settlement
  // call gets null (resolveLeadAutoReplyClaim itself decides keep/release).
  expect(mockResolveClaim).toHaveBeenCalledWith('9415550100', null);
});

test('a provider throw that DID carry an accepted providerOutcome is treated as sent — no claim release', async () => {
  mockClaim.mockResolvedValue({ claimed: true, phoneDigits: '9415550100' });
  const acceptedOutcome = { sent: true, providerMessageId: 'SM_accepted' };
  mockMessage.mockRejectedValue(Object.assign(new Error('audit unavailable'), { providerOutcome: acceptedOutcome }));

  const result = await executeLeadTool('send_lead_response', { message: 'Thanks for reaching out!' }, context);

  expect(result).toMatchObject({ sent: true });
  expect(mockResolveClaim).toHaveBeenCalledWith('9415550100', acceptedOutcome);
});
