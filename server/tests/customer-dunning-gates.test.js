// Dunning consolidation PR 1: the customer-schedule gates ship DARK. Strict
// `=== 'true'` (no '1', 'on', 'TRUE'), read at call time; the gates-map
// entries exist for logGateStatus only. Nothing reads them yet.
const GATES = ['GATE_DUNNING_CUSTOMER_SCHEDULE_SHADOW', 'GATE_DUNNING_CUSTOMER_SCHEDULE', 'DUNNING_CUSTOMER_SCHEDULE_ALLOWLIST'];
const saved = {};

function load() {
  let mod;
  jest.isolateModules(() => { mod = require('../config/feature-gates'); });
  return mod;
}

beforeEach(() => { for (const k of GATES) { saved[k] = process.env[k]; delete process.env[k]; } });
afterEach(() => { for (const k of GATES) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

test('unset: both gates are dark and the allowlist is empty (= everyone)', () => {
  const fg = load();
  expect(fg.dunningCustomerScheduleShadowLive()).toBe(false);
  expect(fg.dunningCustomerScheduleLive()).toBe(false);
  expect(fg.dunningCustomerScheduleAllowlist()).toBeNull();
  expect(fg.gates.dunningCustomerScheduleShadow).toBe(false);
  expect(fg.gates.dunningCustomerSchedule).toBe(false);
  expect(fg.gates.dunningCustomerScheduleAllowlist).toBe(false);
});

test.each(['1', 'on', 'TRUE', 'True', 'yes', ' true', ''])('%p does not turn either gate on', (value) => {
  process.env.GATE_DUNNING_CUSTOMER_SCHEDULE_SHADOW = value;
  process.env.GATE_DUNNING_CUSTOMER_SCHEDULE = value;
  const fg = load();
  expect(fg.dunningCustomerScheduleShadowLive()).toBe(false);
  expect(fg.dunningCustomerScheduleLive()).toBe(false);
  expect(fg.gates.dunningCustomerScheduleShadow).toBe(false);
  expect(fg.gates.dunningCustomerSchedule).toBe(false);
});

test('exactly "true" turns each on, independently of the other', () => {
  process.env.GATE_DUNNING_CUSTOMER_SCHEDULE_SHADOW = 'true';
  let fg = load();
  expect(fg.dunningCustomerScheduleShadowLive()).toBe(true);
  expect(fg.dunningCustomerScheduleLive()).toBe(false);
  delete process.env.GATE_DUNNING_CUSTOMER_SCHEDULE_SHADOW;
  process.env.GATE_DUNNING_CUSTOMER_SCHEDULE = 'true';
  fg = load();
  expect(fg.dunningCustomerScheduleShadowLive()).toBe(false);
  expect(fg.dunningCustomerScheduleLive()).toBe(true);
});

test('the readers see an env change at call time (a flip needs no redeploy)', () => {
  const fg = load();
  expect(fg.dunningCustomerScheduleLive()).toBe(false);
  process.env.GATE_DUNNING_CUSTOMER_SCHEDULE = 'true';
  expect(fg.dunningCustomerScheduleLive()).toBe(true);
  process.env.GATE_DUNNING_CUSTOMER_SCHEDULE = 'false';
  expect(fg.dunningCustomerScheduleLive()).toBe(false);
});

test('the allowlist is a trimmed comma list; blanks and duplicates collapse', () => {
  process.env.DUNNING_CUSTOMER_SCHEDULE_ALLOWLIST = ' 11111111-aaaa , ,22222222-bbbb,11111111-aaaa ';
  const fg = load();
  expect([...fg.dunningCustomerScheduleAllowlist()]).toEqual(['11111111-aaaa', '22222222-bbbb']);
  expect(fg.gates.dunningCustomerScheduleAllowlist).toBe(true);
  process.env.DUNNING_CUSTOMER_SCHEDULE_ALLOWLIST = ' , ';
  expect(fg.dunningCustomerScheduleAllowlist()).toBeNull();
});

test('the allowlist alone never turns anything on', () => {
  process.env.DUNNING_CUSTOMER_SCHEDULE_ALLOWLIST = 'cust-1';
  const fg = load();
  expect(fg.dunningCustomerScheduleLive()).toBe(false);
  expect(fg.dunningCustomerScheduleShadowLive()).toBe(false);
});
