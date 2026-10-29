/**
 * The shared scheduled-text writer (services/scheduled-sms-queue.js) refuses in ONE fixed order, which is the
 * Communications page's own order (the route moved into the writer unchanged; the Intelligence Bar calls it too).
 * One request breaks every guard at once; each step fixes the guard that just answered, so the next one must answer.
 * A reordered or dropped entry in SCHEDULE_GUARDS changes which message the operator sees first and fails here.
 * Final step: with every guard passed the writer reaches the transaction, so no guard sits after a write.
 * No database: every collaborator is a stub.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../models/db', () => {
  const mockDb = jest.fn(() => ({ where: () => ({ whereNull: () => ({ first: async () => mockDb.customer }) }) }));
  mockDb.customer = undefined;
  mockDb.transaction = jest.fn(async () => { throw new Error('REACHED_TRANSACTION'); });
  return mockDb;
});
jest.mock('../services/sms-suggest-mode', () => ({ markSuggestionScheduled: jest.fn(), parkThreadSuggestions: jest.fn(), lockSuggestThread: jest.fn() }));
jest.mock('../services/sms-auto-send', () => ({ hasActiveAutoSendClaim: jest.fn() }));
jest.mock('../services/sms-gratitude-context', () => ({ gratitudeClaimsPossible: jest.fn(() => false) }));
jest.mock('../services/sms-unanswered-reply', () => ({ unansweredClaimsPossible: jest.fn(() => false) }));
jest.mock('../utils/recruiting-thread-scope', () => ({ isRecruitingPhone: jest.fn(async () => true) }));
jest.mock('../services/street-level-hold', () => ({
  linkedVisitIdsFrom: (ids) => (Array.isArray(ids) ? ids : []),
  isStreetLevelHoldVisit: jest.fn(async () => true),
  HOLD_REFUSAL: 'Office must confirm the address first. This booking is waiting on an address check before it can be dispatched.',
}));
jest.mock('../services/composer-customer-links', () => ({
  autopayLinkSendCheck: jest.fn(async () => ({ present: false })),
  immediateOnlyLinkSendCheck: jest.fn(async () => ({ present: false })),
}));
jest.mock('../services/scheduler', () => ({ purposeForScheduledMessageType: (type) => type }));

const db = require('../models/db');
const { scheduleCustomerSms } = require('../services/scheduled-sms-queue');

const APPLICANT = 'Applicant texts are not scheduled here — send now from the recruiting queue or the reply box';
const REVIEW_LINK = 'Review request links can only go on an immediate send — send now, or remove the review link before scheduling';
const PHONE = '+19415550123';
const FUTURE = '2099-01-05T10:00';

test('the writer refuses in the page\'s order: each fix exposes exactly the next guard', async () => {
  const hooks = {
    recruitingReplyContext: jest.fn(async () => ({ applicant: true })),
    findSingleCustomerForPhone: jest.fn(async () => null),
    verifyAgentDecisionForSend: jest.fn(async () => null),
  };
  const state = {
    actor: { techRole: 'technician', technicianId: 'tech-1' },
    input: {
      to: undefined,
      body: 'Review us at https://portal.wavespestcontrol.com/rate/abcdefgh12345',
      scheduledFor: 'not a date',
      customerId: 'cust-1',
      fromNumber: '+19415550001',
      messageType: 'marketing',
      translationTrialId: 7,
      linkedVisitIds: ['visit-1'],
      agentDecisionId: 'decision-1',
      agentDraft: true,
    },
  };
  // [what the next step fixes, the answer that fix lets through to]
  const steps = [
    [() => { state.actor = { techRole: 'admin', technicianId: 'admin-1' }; }, 409, 'A suggested reply in the customer\'s language can only be sent now, not scheduled.'],
    [() => { delete state.input.translationTrialId; }, 400, 'to, body, scheduledFor required'],
    [() => { state.input.to = PHONE; }, 409, APPLICANT],
    [() => { hooks.recruitingReplyContext.mockResolvedValue(null); }, 404, 'customerId not found'],
    [() => { db.customer = { id: 'cust-1', phone: '+19415550999' }; }, 400, 'to must match the selected customer phone'],
    [() => { db.customer = { id: 'cust-1', phone: PHONE }; }, 409, require('../services/street-level-hold').HOLD_REFUSAL],
    // A selected, matching customer is explicit context; without one the active applicant phone is refused.
    [() => { delete state.input.linkedVisitIds; delete state.input.customerId; }, 409, APPLICANT],
    [() => { require('../utils/recruiting-thread-scope').isRecruitingPhone.mockResolvedValue(false); }, 400, 'marketing/retention sends are not allowed on this endpoint'],
    [() => { delete state.input.messageType; }, 400, REVIEW_LINK],
    [() => { state.input.body = 'A plain synthetic text.'; }, 400, 'invalid scheduledFor'],
    [() => { state.input.scheduledFor = '2001-01-05T10:00'; }, 400, 'scheduledFor must be in the future'],
    [() => { state.input.scheduledFor = FUTURE; }, 400, 'fromNumber must be a Waves Twilio number'],
    [() => { delete state.input.fromNumber; }, 409, 'This Agent Review draft was just handled elsewhere — refresh the thread before scheduling.'],
  ];

  const answer = async () => scheduleCustomerSms(state.input, state.actor, hooks);
  expect(await answer()).toEqual({ status: 403, body: { error: 'Admin access required' } });
  for (const [fix, status, error] of steps) {
    fix();
    const out = await answer();
    expect({ status: out.status, error: out.body.error }).toEqual({ status, error });
  }
  // The street-level hold also answers with its code (the step above checked its wording).
  state.input.customerId = 'cust-1';
  state.input.linkedVisitIds = ['visit-1'];
  expect((await answer()).body).toMatchObject({ code: 'street_level_hold' });
  delete state.input.linkedVisitIds;

  // Every guard passed: the next thing the writer does is open its transaction (nothing was written before it).
  hooks.verifyAgentDecisionForSend.mockResolvedValue({ id: 'decision-1', suggested_message: 'A plain synthetic text.' });
  expect(db.transaction).not.toHaveBeenCalled();
  await expect(answer()).rejects.toThrow('REACHED_TRANSACTION');
  expect(db.transaction).toHaveBeenCalledTimes(1);
});
