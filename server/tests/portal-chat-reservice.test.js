// GATE_PORTAL_CHAT_RESERVICE: pests back between visits. The server alone
// decides whether a free re-service applies, from the /reservice page's own
// availability read, for the one service line the customer named; the model
// only sees which case applies and a button the server built.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../routes/reschedule-public', () => ({ _internals: { loadById: jest.fn(), pageEligibility: jest.fn() } }));
jest.mock('../services/portal-payment-history', () => ({ listPortalPayments: jest.fn() }));
jest.mock('../services/portal-service-history', () => ({ listPortalServiceHistory: jest.fn() }));
const mockGates = { reserviceStreamline: true };
jest.mock('../config/feature-gates', () => ({ isEnabled: (name) => mockGates[name] === true }));
// The real classifier of the customer's words; only the reads are stubbed.
const mockScheduler = { reserviceSelfServeEnabled: jest.fn(() => true), loadReserviceLaneAvailability: jest.fn() };
jest.mock('../services/reservice-scheduler', () => {
  const actual = jest.requireActual('../services/reservice-scheduler');
  return {
    reportedReserviceLanes: actual.reportedReserviceLanes,
    reportedReserviceExcludedSpecialty: actual.reportedReserviceExcludedSpecialty,
    reserviceSelfServeEnabled: (...a) => mockScheduler.reserviceSelfServeEnabled(...a),
    loadReserviceLaneAvailability: (...a) => mockScheduler.loadReserviceLaneAvailability(...a),
  };
});

const db = require('../models/db');
const { _internals: reschedulePage } = require('../routes/reschedule-public');
const { portalToolsFor, executeToolCall } = require('../services/ai-assistant/tools');

const ANTS = ['The ants are back in the kitchen'];
const WEEDS = ['Weeds are coming back all over the lawn'];
const PRIMARY = { secondaryProperty: false, customerWords: ANTS };
let tokenRow;
let bookedRow;

beforeEach(() => {
  jest.clearAllMocks();
  mockGates.reserviceStreamline = true;
  mockScheduler.reserviceSelfServeEnabled.mockReturnValue(true);
  tokenRow = { reservice_token: 'tok_rs_1' };
  bookedRow = { id: 'svc-callback-1' };
  db.mockImplementation((table) => {
    const chain = { where: jest.fn(() => chain), whereNull: jest.fn(() => chain), first: jest.fn(async () => (table === 'customers' ? tokenRow : bookedRow)) };
    return chain;
  });
  reschedulePage.loadById.mockResolvedValue({ id: 'svc-callback-1' });
  reschedulePage.pageEligibility.mockResolvedValue({ ok: true });
});

const offer = (line, context = line === 'lawn' ? { ...PRIMARY, customerWords: WEEDS } : PRIMARY, actions = []) => executeToolCall('offer_reservice', { service_line: line }, 'cust-1', actions, null, context)
  .then((result) => ({ result, actions }));

test('the tool is in the set only when its gate is on, and escalate stays last', () => {
  expect(portalToolsFor({ visits: true }).map((t) => t.name)).not.toContain('offer_reservice');
  expect(portalToolsFor({ payments: true, visits: true, reservice: true }).map((t) => t.name)).toEqual([
    'get_upcoming_services', 'get_pest_advice', 'offer_reschedule_link', 'open_portal_section',
    'show_recent_payments', 'get_recent_visits', 'offer_reservice', 'escalate',
  ]);
});

test('a bookable line: a booking button the server built, and the model is told the visit is free', async () => {
  mockScheduler.loadReserviceLaneAvailability.mockResolvedValue({ eligible: ['pest', 'lawn'], open: {}, bookable: ['pest', 'lawn'], verified: true, hasRecurringPlan: true });

  const { result, actions } = await offer('pest');

  expect(mockScheduler.loadReserviceLaneAvailability).toHaveBeenCalledWith('cust-1');
  expect(actions).toEqual([{ type: 'link', label: 'Book your free pest control re-service', href: '/reservice/tok_rs_1' }]);
  expect(result.offered).toBe(true);
  expect(result.instruction).toMatch(/rodents, termites, mosquitoes/);
  expect(JSON.stringify(result)).not.toMatch(/tok_rs_1/);
});

test('a line the plan does not cover gets no button and no free offer, even when another line is bookable', async () => {
  mockScheduler.loadReserviceLaneAvailability.mockResolvedValue({ eligible: ['pest'], open: {}, bookable: ['pest'], verified: true, hasRecurringPlan: true });

  const { result, actions } = await offer('lawn');

  expect(actions).toEqual([]);
  expect(result.offered).toBe(false);
  expect(result.instruction).toMatch(/Do not offer or imply a free visit/);
  expect(result.instruction).toMatch(/pest_problem/);
});

test('a line with a re-service already booked: its date and window, a button to move it, no new offer', async () => {
  mockScheduler.loadReserviceLaneAvailability.mockResolvedValue({
    eligible: ['pest'], bookable: [], verified: true, hasRecurringPlan: true,
    open: { pest: { date: '2026-10-09', windowStart: '10:00', serviceType: 'Pest Control Re-Service', rescheduleUrl: '/reschedule/tok_move' } },
  });

  const { result, actions } = await offer('pest');

  expect(actions).toEqual([{ type: 'link', label: 'Reschedule Pest Control Re-Service, Oct 9', href: '/reschedule/tok_move' }]);
  // The reschedule page's own verdict on that very visit decides the button.
  expect(reschedulePage.loadById).toHaveBeenCalledWith('svc-callback-1');
  expect(result.instruction).toMatch(/a button to move it is shown/);
  expect(result.offered).toBe(false);
  expect(result.already_booked).toEqual({ date: 'Oct 9, 2026', window: expect.stringMatching(/10/) });
  expect(result.instruction).toMatch(/Do not offer another one/);
  expect(JSON.stringify(result)).not.toMatch(/tok_move/);
});

test.each([
  ['the reschedule page refuses the visit (notice window, grouped, inactive account)', () => { reschedulePage.pageEligibility.mockResolvedValue({ ok: false, reason: 'notice_window' }); }],
  ['the eligibility read fails', () => { reschedulePage.pageEligibility.mockRejectedValue(new Error('db down')); }],
  ['the token names no visit of this customer', () => { bookedRow = undefined; }],
])('a booked re-service the page would not move: its date, but no button: %s', async (_label, arrange) => {
  arrange();
  mockScheduler.loadReserviceLaneAvailability.mockResolvedValue({
    eligible: ['pest'], bookable: [], verified: true, hasRecurringPlan: true,
    open: { pest: { date: '2026-10-09', windowStart: '10:00', serviceType: 'Pest Control Re-Service', rescheduleUrl: '/reschedule/tok_move' } },
  });

  const { result, actions } = await offer('pest');

  expect(actions).toEqual([]);
  expect(result.already_booked.date).toBe('Oct 9, 2026');
  expect(result.instruction).not.toMatch(/button/);
});

test('an inactive customer with a booked re-service still hears about that visit (unverified read)', async () => {
  mockScheduler.loadReserviceLaneAvailability.mockResolvedValue({
    eligible: [], bookable: [], verified: false,
    open: { lawn: { date: '2026-10-12', windowStart: null, serviceType: 'Lawn Care Re-Service', rescheduleUrl: null } },
  });

  const { result, actions } = await offer('lawn');

  expect(actions).toEqual([]);
  expect(result.already_booked).toEqual({ date: 'Oct 12, 2026', window: 'TBD' });
});

test('no recurring plan: told plainly that no free re-service applies', async () => {
  mockScheduler.loadReserviceLaneAvailability.mockResolvedValue({ eligible: [], open: {}, bookable: [], verified: true, hasRecurringPlan: false });

  const { result, actions } = await offer('pest');

  expect(actions).toEqual([]);
  expect(result.on_plan).toBe(false);
  expect(result.instruction).toMatch(/no recurring plan/);
});

test.each([
  ['an unverified read (lookup failure)', { eligible: [], open: {}, bookable: [], verified: false }],
  ['a covered plan with no booking link (tokenless row)', { eligible: ['pest'], open: {}, bookable: [], linkMissing: true, verified: true, hasRecurringPlan: true }],
])('%s hands off without a free offer', async (_label, state) => {
  mockScheduler.loadReserviceLaneAvailability.mockResolvedValue(state);

  const { result, actions } = await offer('pest');

  expect(actions).toEqual([]);
  expect(result.offered).toBe(false);
  expect(result.instruction).toMatch(/Do not offer or imply a free visit/);
});

test('a token that fails the link shape gives no button', async () => {
  mockScheduler.loadReserviceLaneAvailability.mockResolvedValue({ eligible: ['pest'], open: {}, bookable: ['pest'], verified: true, hasRecurringPlan: true });
  tokenRow = { reservice_token: '../admin' };

  const { result, actions } = await offer('pest');

  expect(actions).toEqual([]);
  expect(result.offered).toBe(false);
});

test.each([
  ['a secondary saved-property session', { secondaryProperty: true, customerWords: ANTS }, () => {}],
  ['no property context at all', { customerWords: ANTS }, () => {}],
  ['GATE_RESERVICE_STREAMLINE off', PRIMARY, () => { mockGates.reserviceStreamline = false; }],
  ['GATE_RESERVICE_SELF_SERVE off', PRIMARY, () => { mockScheduler.reserviceSelfServeEnabled.mockReturnValue(false); }],
])('%s: no availability read, no button', async (_label, context, arrange) => {
  arrange();

  const { result, actions } = await offer('pest', context);

  expect(mockScheduler.loadReserviceLaneAvailability).not.toHaveBeenCalled();
  expect(actions).toEqual([]);
  expect(result.offered).toBe(false);
});

test('an unknown service line or a missing customer reads nothing', async () => {
  expect((await offer('termite')).result.offered).toBe(false);
  expect((await executeToolCall('offer_reservice', { service_line: 'pest' }, null, [], null, PRIMARY)).error).toMatch(/Authenticated customer/);
  expect(mockScheduler.loadReserviceLaneAvailability).not.toHaveBeenCalled();
});

describe('the customer\'s own words decide what is covered, not the line the model picked', () => {
  beforeEach(() => {
    mockScheduler.loadReserviceLaneAvailability.mockResolvedValue({ eligible: ['pest', 'lawn'], open: {}, bookable: ['pest', 'lawn'], verified: true, hasRecurringPlan: true });
  });

  test.each([
    ['rodents', 'I hear rats in the attic again'],
    ['termites', 'Termites are back in the garage'],
    ['mosquitoes', 'The mosquitoes are back in the yard'],
    ['a specialty riding with a covered pest', 'The ants are back and I saw a rat'],
  ])('%s: no free offer and no read, even when the model says pest', async (_label, text) => {
    const { result, actions } = await offer('pest', { secondaryProperty: false, customerWords: [text] });

    expect(mockScheduler.loadReserviceLaneAvailability).not.toHaveBeenCalled();
    expect(actions).toEqual([]);
    expect(result.offered).toBe(false);
    expect(result.instruction).toMatch(/separately priced/);
  });

  test('a report in the other line is not this line: weeds never open a free pest visit', async () => {
    const { result, actions } = await offer('pest', { secondaryProperty: false, customerWords: WEEDS });

    expect(actions).toEqual([]);
    expect(result.offered).toBe(false);
  });

  test('no customer words at all: no offer', async () => {
    const { result } = await offer('pest', { secondaryProperty: false });
    expect(result.offered).toBe(false);
    expect(mockScheduler.loadReserviceLaneAvailability).not.toHaveBeenCalled();
  });

  test('an earlier message carries the report when the latest only says yes', async () => {
    const { result, actions } = await offer('pest', { secondaryProperty: false, customerWords: ['The ants are back in the kitchen', 'yes please'] });

    expect(result.offered).toBe(true);
    expect(actions).toHaveLength(1);
  });
});
