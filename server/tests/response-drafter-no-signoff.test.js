// Owner ruling 2026-09-26: customer texts are never signed ("— Adam",
// "— Waves", "Adam, Waves Pest Control"). The legacy reply drafter parks
// drafts for staff approval, so a signed draft approved as-is would go out
// signed. Pins both the template fallback and the AI prompt.

const mockDispatch = jest.fn();
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: (...args) => mockDispatch(...args) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const ResponseDrafter = require('../services/response-drafter');

const SIGNOFF = /[-–—]\s*(?:adam|waves)\b[^.!?]*$/i;
const EMOJI = /\p{Extended_Pictographic}/u;

const context = {
  customer: { firstName: 'Sam', tier: 'Gold' },
  upcomingServices: [{ type: 'Pest Control', date: '2026-10-06T14:00:00Z', window: '9-11am' }],
  billing: { outstandingBalance: 0 },
  summary: 'Synthetic customer',
  flags: [],
};

describe('response drafter — drafts carry no sign-off', () => {
  test.each([
    'SCHEDULE_INQUIRY', 'PEST_REPORT', 'SERVICE_REQUEST', 'BILLING_INQUIRY', 'CANCEL_REQUEST',
    'COMPLAINT', 'POSITIVE_FEEDBACK', 'CONFIRMATION', 'GENERAL',
  ])('the %s template has no sign-off and no emoji', (intent) => {
    const { draft } = ResponseDrafter.draftFromTemplate('synthetic inbound', context, { intent });
    expect(draft).not.toMatch(SIGNOFF);
    expect(draft).not.toMatch(EMOJI);
  });

  test('the no-schedule and balance-due variants have no sign-off either', () => {
    const noSchedule = ResponseDrafter.draftFromTemplate('when?', { ...context, upcomingServices: [] }, { intent: 'SCHEDULE_INQUIRY' });
    const balanceDue = ResponseDrafter.draftFromTemplate('bill?', { ...context, billing: { outstandingBalance: 42.5 } }, { intent: 'BILLING_INQUIRY' });
    expect(noSchedule.draft).not.toMatch(SIGNOFF);
    expect(balanceDue.draft).not.toMatch(SIGNOFF);
  });

  test('the AI draft prompt forbids signing off', async () => {
    mockDispatch.mockResolvedValue({ ok: true, text: 'Synthetic draft' });
    await ResponseDrafter.draftWithAI('synthetic inbound', context, { intent: 'GENERAL' });
    const { system } = mockDispatch.mock.calls[0][1];
    expect(system).toMatch(/Never sign off/);
    expect(system).not.toMatch(/Sign off "- Adam"/);
  });
});
