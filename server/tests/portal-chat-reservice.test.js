// GATE_PORTAL_CHAT_RESERVICE: pests back between visits. The server alone
// decides whether a free re-service applies: what is covered is read from the
// customer's own words, and what is bookable is the /reservice page's own
// verdict for the customer's token. The model only sees which case applies
// and a button the server built.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../routes/reschedule-public', () => ({ _internals: { TOKEN_RE: /^[a-f0-9]{64}$/, loadById: jest.fn(), pageEligibility: jest.fn() } }));
const mockPage = { TOKEN_RE: /^[a-f0-9]{64}$/, pageLaneState: jest.fn(), reserviceLocationReviewRequired: jest.fn() };
jest.mock('../routes/reservice-public', () => ({ _internals: mockPage }));
jest.mock('../services/portal-payment-history', () => ({ listPortalPayments: jest.fn() }));
jest.mock('../services/portal-service-history', () => ({ listPortalServiceHistory: jest.fn() }));
const mockGates = { reserviceStreamline: true };
jest.mock('../config/feature-gates', () => ({ isEnabled: (name) => mockGates[name] === true }));
// The real classifier of the customer's words; only the switch is stubbed.
const mockSelfServe = jest.fn(() => true);
const mockOpen = jest.fn();
jest.mock('../services/reservice-scheduler', () => {
  const actual = jest.requireActual('../services/reservice-scheduler');
  return {
    reportedReserviceLanes: actual.reportedReserviceLanes,
    reportedReserviceExcludedSpecialty: actual.reportedReserviceExcludedSpecialty,
    isActivePestReport: actual.isActivePestReport,
    reserviceSelfServeEnabled: (...a) => mockSelfServe(...a),
    openReserviceCallbacks: (...a) => mockOpen(...a),
  };
});

const db = require('../models/db');
const { _internals: reschedulePage } = require('../routes/reschedule-public');
const { portalToolsFor, executeToolCall } = require('../services/ai-assistant/tools');

const ANTS = 'The ants are back in the kitchen';
const WEEDS = 'Weeds are coming back all over the lawn';
const PRIMARY = { secondaryProperty: false, customerMessage: ANTS };
const CUSTOMER = { id: 'cust-1', latitude: 27.4, longitude: -82.5 };
const BOOKED_PEST = { date: '2026-10-09', windowStart: '10:00', serviceType: 'Pest Control Re-Service', rescheduleUrl: '/reschedule/cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc' };
// The page's verdict: lanes the plan holds (with any open re-service) and the bookable ones.
const pageState = (lanes, extra = {}) => ({
  customer: CUSTOMER,
  laneCatalog: {},
  lanes: Object.entries(lanes).map(([key, alreadyBooked]) => ({ key, label: key, alreadyBooked })),
  bookableLanes: Object.entries(lanes).filter(([, booked]) => !booked).map(([key]) => key),
  ...extra,
});
let tokenRow;
let bookedRow;

beforeEach(() => {
  jest.clearAllMocks();
  mockGates.reserviceStreamline = true;
  mockSelfServe.mockReturnValue(true);
  tokenRow = { reservice_token: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' };
  bookedRow = { id: 'svc-callback-1' };
  db.mockImplementation((table) => {
    const chain = { where: jest.fn(() => chain), whereNull: jest.fn(() => chain), first: jest.fn(async () => (table === 'customers' ? tokenRow : bookedRow)) };
    return chain;
  });
  mockPage.pageLaneState.mockResolvedValue(pageState({ pest: null, lawn: null }));
  mockPage.reserviceLocationReviewRequired.mockResolvedValue(false);
  mockOpen.mockResolvedValue({});
  reschedulePage.loadById.mockResolvedValue({ id: 'svc-callback-1' });
  reschedulePage.pageEligibility.mockResolvedValue({ ok: true });
});

const offer = (line, context = line === 'lawn' ? { ...PRIMARY, customerMessage: WEEDS } : PRIMARY, actions = []) => executeToolCall('offer_reservice', { service_line: line }, 'cust-1', actions, null, context)
  .then((result) => ({ result, actions }));

test('the tool is in the set only when its gate is on, and escalate stays last', () => {
  expect(portalToolsFor({ visits: true }).map((t) => t.name)).not.toContain('offer_reservice');
  expect(portalToolsFor({ payments: true, visits: true, reservice: true }).map((t) => t.name)).toEqual([
    'get_upcoming_services', 'get_pest_advice', 'offer_reschedule_link', 'open_portal_section',
    'show_recent_payments', 'get_recent_visits', 'offer_reservice', 'escalate',
  ]);
});

test('a lane the page would book: a booking button the server built, and the model is told the visit is free', async () => {
  const { result, actions } = await offer('pest');

  expect(mockPage.pageLaneState).toHaveBeenCalledWith('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  expect(mockPage.reserviceLocationReviewRequired).toHaveBeenCalledWith(CUSTOMER);
  expect(actions).toEqual([{ type: 'link', label: 'Book your free re-service', href: '/reservice/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }]);
  expect(result.offered).toBe(true);
  expect(result.instruction).toMatch(/rodents, termites, mosquitoes/);
  // The page computes open times on its own load; the offer never promises one.
  expect(result.instruction).toMatch(/Do not say whether times are open or promise a time/);
  expect(result.instruction).not.toMatch(/pick a time/);
  expect(JSON.stringify(result)).not.toMatch(/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/);
});

test('a second offer call in one turn adds no second button', async () => {
  const actions = [];
  const context = { secondaryProperty: false, customerMessage: 'The ants are back and weeds are coming back all over the lawn' };

  await executeToolCall('offer_reservice', { service_line: 'pest' }, 'cust-1', actions, null, context);
  await executeToolCall('offer_reservice', { service_line: 'lawn' }, 'cust-1', actions, null, context);

  expect(actions).toEqual([{ type: 'link', label: 'Book your free re-service', href: '/reservice/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }]);
});

test.each([
  ['the open re-service read fails', () => mockOpen.mockRejectedValue(new Error('db down'))],
  ['the page holds no lane at all (no plan, inactive, or no catalog row)', () => mockPage.pageLaneState.mockResolvedValue(pageState({}))],
  ['the page holds only the other lane', () => mockPage.pageLaneState.mockResolvedValue(pageState({ lawn: null }))],
  ['the page knows no such token', () => mockPage.pageLaneState.mockResolvedValue(null)],
  ['the page read fails', () => mockPage.pageLaneState.mockRejectedValue(new Error('db down'))],
  ['the token loads another customer', () => mockPage.pageLaneState.mockResolvedValue({ ...pageState({ pest: null }), customer: { id: 'cust-other' } })],
  ['the address is held for staff review (the page shows no times)', () => mockPage.reserviceLocationReviewRequired.mockResolvedValue(true)],
  ['the address review read fails', () => mockPage.reserviceLocationReviewRequired.mockRejectedValue(new Error('db down'))],
  ['the customer has no token', () => { tokenRow = { reservice_token: null }; }],
  ['the token fails the link shape', () => { tokenRow = { reservice_token: '../admin' }; }],
  ['the token is link-safe but not the page\'s format (a 404 there)', () => { tokenRow = { reservice_token: 'tok_imported_1' }; }],
  ['the token read fails', () => { tokenRow = Promise.reject(new Error('db down')); tokenRow.catch(() => {}); }],
])('%s: no button and no free offer', async (_label, arrange) => {
  arrange();

  const { result, actions } = await offer('pest');

  expect(actions).toEqual([]);
  expect(result.offered).toBe(false);
  expect(result.instruction).toMatch(/Do not offer or imply a free visit/);
  expect(result.instruction).toMatch(/pest_problem/);
});

test('a re-service already booked in the line: its date and window, a button to move it, no new offer', async () => {
  mockOpen.mockResolvedValue({ pest: BOOKED_PEST });

  const { result, actions } = await offer('pest');

  expect(actions).toEqual([{ type: 'link', label: 'Reschedule Pest Control Re-Service, Oct 9', href: '/reschedule/cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc' }]);
  // The reschedule page's own verdict on that very visit decides the button.
  expect(reschedulePage.loadById).toHaveBeenCalledWith('svc-callback-1');
  expect(result.offered).toBe(false);
  expect(result.already_booked).toEqual({ date: 'Oct 9, 2026', window: expect.stringMatching(/10/) });
  expect(result.instruction).toMatch(/Do not offer another one/);
  expect(result.instruction).toMatch(/a button to move it is shown/);
  expect(JSON.stringify(result)).not.toMatch(/cccccccc/);
});

test('a re-service booked while the plan covered the line still shows after coverage changed', async () => {
  mockOpen.mockResolvedValue({ pest: BOOKED_PEST });
  mockPage.pageLaneState.mockResolvedValue(pageState({}));

  const { result } = await offer('pest');

  expect(result.already_booked.date).toBe('Oct 9, 2026');
  expect(mockPage.pageLaneState).not.toHaveBeenCalled();
});

test.each([
  ['the reschedule page refuses the visit (notice window, grouped, inactive account)', () => { reschedulePage.pageEligibility.mockResolvedValue({ ok: false, reason: 'notice_window' }); }],
  ['the eligibility read fails', () => { reschedulePage.pageEligibility.mockRejectedValue(new Error('db down')); }],
  ['the token names no visit of this customer', () => { bookedRow = undefined; }],
  ['the booked visit\'s token is not the reschedule route\'s format (a 404 there)', () => { mockOpen.mockResolvedValue({ pest: { ...BOOKED_PEST, rescheduleUrl: '/reschedule/tok_imported' } }); }],
  ['the booked visit has no reschedule link', () => { mockOpen.mockResolvedValue({ pest: { ...BOOKED_PEST, rescheduleUrl: null } }); }],
  ['the booked visit lookup fails', () => { bookedRow = Promise.reject(new Error('db down')); bookedRow.catch(() => {}); }],
])('a booked re-service the page would not move: its date, but no button: %s', async (_label, arrange) => {
  mockOpen.mockResolvedValue({ pest: BOOKED_PEST });
  arrange();

  const { result, actions } = await offer('pest');

  expect(actions).toEqual([]);
  expect(result.already_booked.date).toBe('Oct 9, 2026');
  expect(result.instruction).not.toMatch(/button/);
});

test.each([
  ['a secondary saved-property session', { secondaryProperty: true, customerMessage: ANTS }, () => {}],
  ['no property context at all', { customerMessage: ANTS }, () => {}],
  ['GATE_RESERVICE_STREAMLINE off', PRIMARY, () => { mockGates.reserviceStreamline = false; }],
  ['GATE_RESERVICE_SELF_SERVE off', PRIMARY, () => { mockSelfServe.mockReturnValue(false); }],
])('%s: no page read, no button', async (_label, context, arrange) => {
  arrange();

  const { result, actions } = await offer('pest', context);

  expect(mockPage.pageLaneState).not.toHaveBeenCalled();
  expect(actions).toEqual([]);
  expect(result.offered).toBe(false);
});

test('an unknown service line or a missing customer reads nothing', async () => {
  expect((await offer('termite')).result.offered).toBe(false);
  expect((await executeToolCall('offer_reservice', { service_line: 'pest' }, null, [], null, PRIMARY)).error).toMatch(/Authenticated customer/);
  expect(mockPage.pageLaneState).not.toHaveBeenCalled();
});

describe('the customer\'s own message this turn decides what is covered, not the line the model picked', () => {
  test.each([
    ['a follow-up with no report of its own', 'yes please'],
    ['a resolution', 'The ants are gone now'],
  ])('%s opens nothing: an earlier report is never carried forward', async (_label, text) => {
    const { result } = await offer('pest', { secondaryProperty: false, customerMessage: text });
    expect(result.offered).toBe(false);
    expect(mockPage.pageLaneState).not.toHaveBeenCalled();
  });

  test.each([
    ['rodents', 'I hear rats in the attic again'],
    ['termites', 'Termites are back in the garage'],
    ['mosquitoes', 'The mosquitoes are back in the yard'],
    ['a specialty riding with a covered pest', 'The ants are back and I saw a rat'],
  ])('%s: no free offer and no page read, even when the model says pest', async (_label, text) => {
    const { result, actions } = await offer('pest', { secondaryProperty: false, customerMessage: text });

    expect(mockPage.pageLaneState).not.toHaveBeenCalled();
    expect(actions).toEqual([]);
    expect(result.offered).toBe(false);
    expect(result.instruction).toMatch(/separately priced/);
  });

  test('a report in the other line is not this line: weeds never open a free pest visit', async () => {
    const { result, actions } = await offer('pest', { secondaryProperty: false, customerMessage: WEEDS });

    expect(actions).toEqual([]);
    expect(result.offered).toBe(false);
  });

  test.each([
    ['a coverage question', 'Do you cover ants?'],
    ['a general lawn question', 'Tell me about lawn care'],
  ])('%s names a line but reports nothing: no offer', async (_label, text) => {
    const { result, actions } = await offer(text.includes('lawn') ? 'lawn' : 'pest', { secondaryProperty: false, customerMessage: text });

    expect(mockPage.pageLaneState).not.toHaveBeenCalled();
    expect(actions).toEqual([]);
    expect(result.offered).toBe(false);
  });

  test.each([
    'Weeds are coming back all over the lawn',
    'the grass is looking bad again',
  ])('pest only for now: a lawn report opens nothing, even under the lawn line: %s', async (text) => {
    const { result, actions } = await offer('lawn', { secondaryProperty: false, customerMessage: text });

    expect(result.offered).toBe(false);
    expect(actions).toEqual([]);
    expect(mockPage.pageLaneState).not.toHaveBeenCalled();
  });

  test('a lawn report never opens a pest offer', async () => {
    const { result } = await offer('pest', { secondaryProperty: false, customerMessage: 'weeds all over my lawn' });
    expect(result.offered).toBe(false);
  });

  
  

  test('no customer words at all: no offer', async () => {
    const { result } = await offer('pest', { secondaryProperty: false });
    expect(result.offered).toBe(false);
    expect(mockPage.pageLaneState).not.toHaveBeenCalled();
  });

  });
