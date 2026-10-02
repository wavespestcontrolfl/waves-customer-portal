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
const mockScheduler = { reserviceSelfServeEnabled: jest.fn(() => true), loadReserviceLaneAvailability: jest.fn() };
jest.mock('../services/reservice-scheduler', () => mockScheduler);

const db = require('../models/db');
const { portalToolsFor, executeToolCall } = require('../services/ai-assistant/tools');

const PRIMARY = { secondaryProperty: false };
let tokenRow;

beforeEach(() => {
  jest.clearAllMocks();
  mockGates.reserviceStreamline = true;
  mockScheduler.reserviceSelfServeEnabled.mockReturnValue(true);
  tokenRow = { reservice_token: 'tok_rs_1' };
  const chain = { where: jest.fn(() => chain), whereNull: jest.fn(() => chain), first: jest.fn(async () => tokenRow) };
  db.mockImplementation(() => chain);
});

const offer = (line, context = PRIMARY, actions = []) => executeToolCall('offer_reservice', { service_line: line }, 'cust-1', actions, null, context)
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
  expect(result.offered).toBe(false);
  expect(result.already_booked).toEqual({ date: 'Oct 9, 2026', window: expect.stringMatching(/10/) });
  expect(result.instruction).toMatch(/Do not offer another one/);
  expect(JSON.stringify(result)).not.toMatch(/tok_move/);
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
  ['a secondary saved-property session', { secondaryProperty: true }, () => {}],
  ['no property context at all', {}, () => {}],
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
