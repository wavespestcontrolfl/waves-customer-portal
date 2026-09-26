// The delayed lead fallback (sent after the Lead Response agent, up to a
// minute after the form) dispatches inside the customer's comms lock with
// the customer row locked, after re-checking that the customer still exists
// and still has the phone the webhook captured. A refusal is a not-sent
// block, which releases the first-touch claim. The immediate reply (agent
// off) keeps today's plain send.

let mockCustomerRow = null;
let mockLeads = [];
const mockSend = jest.fn();
const mockLockCalls = [];

jest.mock('../models/db', () => {
  const tableChain = (table) => {
    const chain = {
      where: jest.fn(() => chain),
      whereIn: jest.fn(() => chain),
      whereNull: jest.fn(() => chain),
      whereNotNull: jest.fn(() => chain),
      whereRaw: jest.fn(() => chain),
      forNoKeyUpdate: jest.fn(() => { chain.locked = true; return chain; }),
      first: jest.fn(async () => (table === 'customers' ? mockCustomerRow : null)),
      select: jest.fn(async () => (table === 'leads' ? mockLeads : [])),
      insert: jest.fn(() => chain),
      onConflict: jest.fn(() => chain),
      ignore: jest.fn(() => chain),
      returning: jest.fn(async () => ['9415551234']),
      update: jest.fn(async () => 1),
      del: jest.fn(async () => 1),
    };
    return chain;
  };
  const db = jest.fn(tableChain);
  db.__tableChain = tableChain;
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/sms-template-renderer', () => ({ renderRequiredSmsTemplate: async () => 'Hello Sam! Waves Pest Control here.' }));
jest.mock('../utils/customer-comms-lock', () => ({
  withSmsConsentLock: async (_db, key, fn) => {
    mockLockCalls.push(key);
    const db = require('../models/db');
    const trx = jest.fn(db.__tableChain);
    return fn(trx);
  },
}));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: (...args) => mockSend(...args),
  normalizeRecipient: phone => phone,
  classifyDeliveryCertainty: outcome => (outcome?.deliveryOutcome === 'not_sent' ? 'not_sent' : 'unknown'),
}));

const { recipientStillCurrent, delayedLeadReplyStillEligible, sendLeadAutoReplyOnce } = require('../services/lead-auto-reply');
const { resolveLeadAutoReplyClaim } = require('../services/lead-auto-reply');

const args = {
  customer: { id: 'cust-1' },
  phoneFormatted: '+19415551234',
  firstName: 'Sam',
  location: { id: 'loc-1' },
  leadSource: { source: 'website' },
};

beforeEach(() => {
  mockSend.mockReset();
  mockLockCalls.length = 0;
  mockCustomerRow = { phone: '(941) 555-1234', lead_intake_status: 'awaiting_service' };
  mockLeads = [{ status: 'new', deleted_at: null }];
});

describe('recipientStillCurrent', () => {
  test('same customer, same phone → ok', async () => {
    await expect(recipientStillCurrent('cust-1', '9415551234')).resolves.toEqual({ ok: true });
  });

  test('phone corrected by staff in the meantime → refused', async () => {
    mockCustomerRow = { phone: '+19415559999' };
    await expect(recipientStillCurrent('cust-1', '9415551234')).resolves.toMatchObject({ ok: false, code: 'LEAD_SUBJECT_CHANGED' });
  });

  test('customer deleted in the meantime → refused', async () => {
    mockCustomerRow = undefined;
    await expect(recipientStillCurrent('cust-1', '9415551234')).resolves.toMatchObject({ ok: false, code: 'LEAD_SUBJECT_CHANGED' });
  });
});

describe('sendLeadAutoReplyOnce({ revalidateRecipient })', () => {
  test('the delayed fallback dispatches inside the comms lock after a locked re-check', async () => {
    const dispatch = jest.fn(async () => ({ ok: true }));
    mockSend.mockImplementation(async (input) => {
      const verdict = await input.withSmsHandoff(dispatch);
      return verdict.ok ? { sent: true, providerMessageId: 'SMabc' } : { sent: false, blocked: true, deliveryOutcome: 'not_sent', code: verdict.code };
    });

    await sendLeadAutoReplyOnce({ ...args, revalidateRecipient: true });

    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({ entryPoint: 'lead_webhook_auto_reply', withSmsHandoff: expect.any(Function) }));
    expect(mockLockCalls).toEqual([{ phone: '+19415551234', customerId: 'cust-1' }]);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  test('a phone changed before the handoff → no dispatch, refused', async () => {
    mockCustomerRow = { phone: '+19415559999' };
    const dispatch = jest.fn();
    let verdict;
    mockSend.mockImplementation(async (input) => {
      verdict = await input.withSmsHandoff(dispatch);
      return { sent: false, blocked: true, deliveryOutcome: 'not_sent', code: verdict.code };
    });

    await sendLeadAutoReplyOnce({ ...args, revalidateRecipient: true });

    expect(dispatch).not.toHaveBeenCalled();
    expect(verdict).toMatchObject({ ok: false, code: 'LEAD_SUBJECT_CHANGED' });
  });

  test('the immediate reply (agent off) keeps the plain send, no handoff', async () => {
    mockSend.mockResolvedValue({ sent: true, providerMessageId: 'SMabc' });

    await sendLeadAutoReplyOnce(args);

    expect(mockSend.mock.calls[0][0]).not.toHaveProperty('withSmsHandoff');
    expect(mockLockCalls).toEqual([]);
  });
});

describe('delayedLeadReplyStillEligible', () => {
  test('untouched lead → ok', async () => {
    await expect(delayedLeadReplyStillEligible('cust-1', '9415551234')).resolves.toEqual({ ok: true });
  });

  test.each(['estimate_drafted'])('customer already replied (intake %s) → refused', async (status) => {
    mockCustomerRow = { phone: '+19415551234', lead_intake_status: status };
    await expect(delayedLeadReplyStillEligible('cust-1', '9415551234')).resolves.toMatchObject({ ok: false, code: 'LEAD_CONVERSATION_STARTED' });
  });

  test.each([
    ['contacted by staff', [{ status: 'contacted', deleted_at: null }]],
    ['lost', [{ status: 'lost', deleted_at: null }]],
    ['deleted', [{ status: 'new', deleted_at: new Date() }]],
  ])('lead %s → refused', async (_label, leads) => {
    mockLeads = leads;
    await expect(delayedLeadReplyStillEligible('cust-1', '9415551234')).resolves.toMatchObject({ ok: false, code: 'LEAD_NO_LONGER_PRE_CONTACT' });
  });

  test('no lead row at all (lead insert failed) → still ok', async () => {
    mockLeads = [];
    await expect(delayedLeadReplyStillEligible('cust-1', '9415551234')).resolves.toEqual({ ok: true });
  });
});

describe('a rejected send still settles the claim', () => {
  test('a refused or failed locked handoff throw releases the claim via its tagged not_sent outcome', async () => {
    const err = Object.assign(new Error('handoff failed'), { providerOutcome: { sent: false, deliveryOutcome: 'not_sent' } });
    mockSend.mockRejectedValue(err);
    const db = require('../models/db');
    db.mockClear();

    await expect(sendLeadAutoReplyOnce({ ...args, revalidateRecipient: true })).rejects.toBe(err);

    const delCalls = db.mock.results.filter((r, i) => db.mock.calls[i][0] === 'lead_auto_reply_sends').map(r => r.value.del.mock.calls.length);
    expect(delCalls.some(n => n > 0)).toBe(true);
  });
});
