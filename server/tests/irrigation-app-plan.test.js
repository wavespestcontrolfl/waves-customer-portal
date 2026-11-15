jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/irrigation-week-plan', () => ({
  ...jest.requireActual('../services/irrigation-week-plan'),
  loadCurrentWeekPlan: jest.fn(),
}));
jest.mock('../services/irrigation-weekly-email', () => ({
  ...jest.requireActual('../services/irrigation-weekly-email'),
  findEligibleCustomers: jest.fn(),
}));

const { loadCurrentWeekPlan } = require('../services/irrigation-week-plan');
const { buildWeeklyEmailDecision, weeklyInputsForCustomer, findEligibleCustomers } = require('../services/irrigation-weekly-email');
const { loadCustomerWateringPlan } = require('../services/irrigation-app-plan');
const now = new Date('2026-09-07T14:05:00Z');

function fixture({ forecast = 0.3, rain = 0.6, customerInputs = {} } = {}) {
  const customer = {
    id: 'fixture-customer', first_name: 'Sample', email: 'sample@example.invalid',
    address_line1: '100 Fixture Lane', address_line2: 'Unit 1', city: 'Sarasota', zip: '34236',
    latitude: 27.3, longitude: -82.5, grass_type: 'st_augustine', turf_county: 'Sarasota',
    irrigation_run_minutes: 20, watering_days: ['Mon', 'Wed', 'Fri', 'Sun'],
    irrigation_system_type: ['spray'], irrigation_system: true,
    irrigation_inches_per_week: null, rain_sensor: false,
    ...customerInputs,
  };
  const decision = buildWeeklyEmailDecision({
    ...weeklyInputsForCustomer(customer, {
      weekEnding: '2026-09-06', weekWeather: { rainInches: rain, et0Inches: 1.6 },
      weekPlanEnabled: true, planWeekEnd: '2026-09-13', now,
    }),
    forecastRainInches: forecast, forecastEt0Inches: 1.6,
  });
  if (!decision.weekPlan) throw new Error(`Fixture produced no plan: ${decision.reason}`);
  const snapshot = JSON.parse(JSON.stringify({
    weekEnding: '2026-09-06', planAsOf: now, sentAt: now, availableAt: now,
    decisionInputs: decision.decisionInputs, plan: decision.weekPlan, restriction: decision.restriction,
  }));
  findEligibleCustomers.mockResolvedValue([customer]);
  loadCurrentWeekPlan.mockResolvedValue(snapshot);
  return { customer, snapshot, decision };
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.GATE_IRRIGATION_APP_PLAN = 'true';
  process.env.GATE_IRRIGATION_WEEK_PLAN = 'true';
  process.env.IRRIGATION_RESTRICTION_POLICY = JSON.stringify({ maxDaysPerWeek: 1, expiresOn: '2099-12-31', label: 'Synthetic test policy', hoursNote: 'on your assigned day', coverage: 'all' });
});
afterEach(() => {
  delete process.env.GATE_IRRIGATION_APP_PLAN;
  delete process.env.GATE_IRRIGATION_WEEK_PLAN;
  delete process.env.IRRIGATION_RESTRICTION_POLICY;
});

test.each([{ forecast: 0.3 }, { forecast: 1.4 }, { rain: 4, forecast: 3 }])('serves the same saved instruction and rain condition as the email (%j)', async (options) => {
  const { decision } = fixture(options);
  const result = await loadCustomerWateringPlan('fixture-customer', { now });
  expect(result).not.toBeNull();
  expect(result.instruction).toBe(decision.payload.week_plan);
  expect(result.note).toBe(decision.payload.plan_note || '');
  expect(result.summary).toBe(decision.payload.summary_line);
  expect(result.conditionalOnForecast).toBe(decision.weekPlan.conditionalOnForecast === true);
  expect(result.notificationEligible).toBe(true);
  expect(result.guides).toHaveLength(4);
  expect(result).not.toHaveProperty('decisionInputs');
  expect(result).not.toHaveProperty('home');
});

test('a positive weekly inches entry qualifies without runtime-derived numbers', async () => {
  fixture({ customerInputs: { irrigation_inches_per_week: 1, irrigation_run_minutes: null,
    watering_days: null, irrigation_system_type: null } });
  expect((await loadCustomerWateringPlan('fixture-customer', { now })).notificationEligible).toBe(true);
});

test.each([
  { irrigation_inches_per_week: 1 },
  { irrigation_inches_per_week: null, irrigation_run_minutes: null, watering_days: null,
    irrigation_system_type: null, turf_irrigation_inches_per_week: 1 },
])('an emailed move-reconfirmation plan cannot notify before portal numbers are confirmed (%j)', async (customerInputs) => {
  const { decision } = fixture({ customerInputs: { ...customerInputs,
    irrigation_home_changed_at: '2026-09-01T14:00:00Z', irrigation_confirmed_fields: [] } });
  expect(decision.shouldSend).toBe(true);
  expect(decision.weekPlan).toBeTruthy();
  const plan = await loadCustomerWateringPlan('fixture-customer', { now });
  expect(plan).not.toBeNull();
  expect(plan.notificationEligible).toBe(false);
});

test('a complete portal schedule re-confirmed for the new home qualifies', async () => {
  fixture({ customerInputs: { irrigation_home_changed_at: '2026-09-01T14:00:00Z',
    irrigation_confirmed_fields: ['irrigation_run_minutes', 'watering_days', 'irrigation_system_type'] } });
  expect((await loadCustomerWateringPlan('fixture-customer', { now })).notificationEligible).toBe(true);
});

test.each(['GATE_IRRIGATION_APP_PLAN', 'GATE_IRRIGATION_WEEK_PLAN'])('fails closed before data access when %s is disabled', async (gate) => {
  fixture();
  delete process.env[gate];
  expect(await loadCustomerWateringPlan('fixture-customer', { now })).toBeNull();
  expect(loadCurrentWeekPlan).not.toHaveBeenCalled();
});

test.each([
  { address_line2: 'Unit 2' }, { address_line1: '' },
  { irrigation_run_minutes: 35 }, { watering_days: ['Mon'] },
  { irrigation_system_type: ['rotor'] }, { grass_type: 'bahia' },
  { irrigation_inches_per_week: 1 }, { rain_sensor: true },
])('withholds changed home or watering inputs instead of creating a new recommendation (%j)', async (change) => {
  const { customer } = fixture();
  findEligibleCustomers.mockResolvedValue([{ ...customer, ...change }]);
  expect(await loadCustomerWateringPlan('fixture-customer', { now })).toBeNull();
});

test('a harmless address-format correction keeps the matched home plan', async () => {
  const { customer } = fixture();
  findEligibleCustomers.mockResolvedValue([{ ...customer, address_line1: '100 FIXTURE LANE' }]);
  expect(await loadCustomerWateringPlan('fixture-customer', { now })).not.toBeNull();
});

test('no longer eligible customers and snapshots without a known home stay hidden', async () => {
  const { snapshot } = fixture();
  findEligibleCustomers.mockResolvedValue([]);
  expect(await loadCustomerWateringPlan('fixture-customer', { now })).toBeNull();
  loadCurrentWeekPlan.mockResolvedValue({ ...snapshot, decisionInputs: { ...snapshot.decisionInputs, home: null } });
  expect(await loadCustomerWateringPlan('fixture-customer', { now })).toBeNull();
});

test('an unavailable current snapshot stays absent and storage failures propagate', async () => {
  fixture();
  loadCurrentWeekPlan.mockResolvedValue(null);
  expect(await loadCustomerWateringPlan('fixture-customer', { now })).toBeNull();
  loadCurrentWeekPlan.mockRejectedValue(new Error('snapshot unavailable'));
  await expect(loadCustomerWateringPlan('fixture-customer', { now })).rejects.toThrow('snapshot unavailable');
});

test('the app plan card carries the watering-time line the email carries (hours set in the policy)', async () => {
  process.env.IRRIGATION_RESTRICTION_POLICY = JSON.stringify({
    maxDaysPerWeek: 1, expiresOn: '2099-12-31', label: 'Synthetic test policy', hoursNote: 'on your assigned day', coverage: 'all',
    allowedHours: [{ start: '00:01', end: '04:00' }, { start: '20:00', end: '23:59' }],
  });
  const { decision } = fixture();
  const result = await loadCustomerWateringPlan('fixture-customer', { now });
  expect(decision.payload.restriction_note).toMatch(/ On your watering day, use the 12:01 to 4 AM window, not the evening one\. A lawn that stays wet all night gets more fungus\.$/);
  expect(result.restrictionNote).toBe(decision.payload.restriction_note);
});

test('hours set after Monday keep this week\'s card and add the line to it at once', async () => {
  const { decision } = fixture(); // decided under the rule without hours
  expect(decision.payload.restriction_note).not.toContain('12:01');
  process.env.IRRIGATION_RESTRICTION_POLICY = JSON.stringify({
    maxDaysPerWeek: 1, expiresOn: '2099-12-31', label: 'Synthetic test policy', hoursNote: 'on your assigned day', coverage: 'all',
    allowedHours: [{ start: '00:01', end: '04:00' }, { start: '20:00', end: '23:59' }],
  });
  const result = await loadCustomerWateringPlan('fixture-customer', { now });
  expect(result).not.toBeNull();
  expect(result.instruction).toBe(decision.payload.week_plan);
  expect(result.restrictionNote).toBe(`${decision.payload.restriction_note} On your watering day, use the 12:01 to 4 AM window, not the evening one. A lawn that stays wet all night gets more fungus.`);
});

test('the app plan card keeps today\'s note when the policy has no hours', async () => {
  const { decision } = fixture();
  const result = await loadCustomerWateringPlan('fixture-customer', { now });
  expect(result.restrictionNote).toBe(decision.payload.restriction_note);
  expect(result.restrictionNote).not.toContain('12:01');
});
