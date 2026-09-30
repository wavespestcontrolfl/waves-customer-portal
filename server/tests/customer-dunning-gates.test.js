// Dunning consolidation PR 1: the customer-schedule gates ship DARK. Strict
// `=== 'true'` (no '1', 'on', 'TRUE'), read at call time; the gates-map
// entries exist for logGateStatus only. Nothing reads them yet.
const GATES = ['GATE_DUNNING_CUSTOMER_SCHEDULE_SHADOW', 'GATE_DUNNING_CUSTOMER_SCHEDULE', 'DUNNING_CUSTOMER_SCHEDULE_ALLOWLIST', 'GATE_DUNNING_LADDER_90', 'GATE_PAY_INCLUDE_BALANCE'];
const prereqsOn = () => { process.env.GATE_DUNNING_LADDER_90 = 'true'; process.env.GATE_PAY_INCLUDE_BALANCE = 'true'; };
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
  prereqsOn();
  process.env.GATE_DUNNING_CUSTOMER_SCHEDULE_SHADOW = value;
  process.env.GATE_DUNNING_CUSTOMER_SCHEDULE = value;
  const fg = load();
  expect(fg.dunningCustomerScheduleShadowLive()).toBe(false);
  expect(fg.dunningCustomerScheduleLive()).toBe(false);
  expect(fg.gates.dunningCustomerScheduleShadow).toBe(false);
  expect(fg.gates.dunningCustomerSchedule).toBe(false);
});

test('exactly "true" turns each on, independently of the other', () => {
  prereqsOn();
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
  prereqsOn();
  const fg = load();
  expect(fg.dunningCustomerScheduleLive()).toBe(false);
  process.env.GATE_DUNNING_CUSTOMER_SCHEDULE = 'true';
  expect(fg.dunningCustomerScheduleLive()).toBe(true);
  process.env.GATE_DUNNING_CUSTOMER_SCHEDULE = 'false';
  expect(fg.dunningCustomerScheduleLive()).toBe(false);
});

const U1 = '11111111-aaaa-4aaa-8aaa-111111111111';
const U2 = '22222222-bbbb-4bbb-8bbb-222222222222';

test('the allowlist is a trimmed comma list of uuids; blanks, case and duplicates collapse', () => {
  process.env.DUNNING_CUSTOMER_SCHEDULE_ALLOWLIST = ` ${U1.toUpperCase()} , ,${U2},${U1} `;
  const fg = load();
  expect([...fg.dunningCustomerScheduleAllowlist()]).toEqual([U1, U2]);
  expect(fg.gates.dunningCustomerScheduleAllowlist).toBe(true);
});

test('unset or whitespace-only = no allowlist (null = everyone)', () => {
  const fg = load();
  expect(fg.dunningCustomerScheduleAllowlist()).toBeNull();
  process.env.DUNNING_CUSTOMER_SCHEDULE_ALLOWLIST = '   ';
  expect(fg.dunningCustomerScheduleAllowlist()).toBeNull();
  expect(fg.dunningCustomerScheduleAllowlistStatus()).toEqual({ configured: false, valid: [], invalidCount: 0 });
});

test.each([' , ', ',', 'not-a-uuid', '12345, abc'])('configured but no valid id (%p) = an EMPTY set (nobody), never everyone', (value) => {
  process.env.DUNNING_CUSTOMER_SCHEDULE_ALLOWLIST = value;
  const fg = load();
  const set = fg.dunningCustomerScheduleAllowlist();
  expect(set).toBeInstanceOf(Set);
  expect(set.size).toBe(0);
});

test('a malformed id is dropped and only COUNTED; the valid ones still stand', () => {
  process.env.DUNNING_CUSTOMER_SCHEDULE_ALLOWLIST = `${U1}, 11111111-aaaa ,zzz`;
  const fg = load();
  expect([...fg.dunningCustomerScheduleAllowlist()]).toEqual([U1]);
  expect(fg.dunningCustomerScheduleAllowlistStatus()).toEqual({ configured: true, valid: [U1], invalidCount: 2 });
});

describe('logGateStatus reports the allowlist state', () => {
  let logSpy;
  beforeEach(() => { logSpy = jest.spyOn(console, 'log').mockImplementation(() => {}); });
  afterEach(() => logSpy.mockRestore());
  const lines = () => logSpy.mock.calls.map((c) => String(c[0])).join('\n');

  test('configured but empty says nobody; malformed entries are counted, never printed', async () => {
    process.env.DUNNING_CUSTOMER_SCHEDULE_ALLOWLIST = 'oops-secret-looking-value, another';
    load().logGateStatus();
    expect(lines()).toContain('configured but has no valid ids → nobody');
    expect(lines()).toContain('ignored 2 malformed entries');
    expect(lines()).not.toContain('oops');
    expect(lines()).not.toContain('secret');
    expect(lines()).not.toContain('another');
  });

  test('valid ids are never printed either, only their count', () => {
    process.env.DUNNING_CUSTOMER_SCHEDULE_ALLOWLIST = `${U1},bad`;
    load().logGateStatus();
    expect(lines()).toContain('allowlist: 1 customer(s)');
    expect(lines()).toContain('ignored 1 malformed entry');
    expect(lines()).not.toContain(U1);
    expect(lines()).not.toContain('bad');
  });

  test('a valid list is counted; unset prints nothing extra', () => {
    process.env.DUNNING_CUSTOMER_SCHEDULE_ALLOWLIST = `${U1},${U2}`;
    load().logGateStatus();
    expect(lines()).toContain('allowlist: 2 customer(s)');
    logSpy.mockClear();
    delete process.env.DUNNING_CUSTOMER_SCHEDULE_ALLOWLIST;
    load().logGateStatus();
    expect(lines()).not.toContain('allowlist');
  });
});

describe.each([
  ['GATE_DUNNING_LADDER_90 off', () => { process.env.GATE_PAY_INCLUDE_BALANCE = 'true'; }],
  ['the pay-page balance gate off', () => { process.env.GATE_DUNNING_LADDER_90 = 'true'; }],
  ['both prerequisites off', () => {}],
  ['a prerequisite set to a non-"true" value', () => { process.env.GATE_DUNNING_LADDER_90 = '1'; process.env.GATE_PAY_INCLUDE_BALANCE = 'true'; }],
])('fail closed: %s', (_label, arrange) => {
  test('neither the shadow nor the live reader is on even with its own gate "true"', () => {
    arrange();
    process.env.GATE_DUNNING_CUSTOMER_SCHEDULE_SHADOW = 'true';
    process.env.GATE_DUNNING_CUSTOMER_SCHEDULE = 'true';
    const fg = load();
    expect(fg.dunningCustomerSchedulePrereqsLive()).toBe(false);
    expect(fg.dunningCustomerScheduleShadowLive()).toBe(false);
    expect(fg.dunningCustomerScheduleLive()).toBe(false);
  });
});

test('both prerequisites on: the readers follow their own gate', () => {
  prereqsOn();
  const fg = load();
  expect(fg.dunningCustomerSchedulePrereqsLive()).toBe(true);
  expect(fg.dunningCustomerScheduleShadowLive()).toBe(false);
  expect(fg.dunningCustomerScheduleLive()).toBe(false);
});

test('the ladder prerequisite is read at call time (turning it off closes an open reader)', () => {
  prereqsOn();
  process.env.GATE_DUNNING_CUSTOMER_SCHEDULE = 'true';
  const fg = load();
  expect(fg.dunningCustomerScheduleLive()).toBe(true);
  delete process.env.GATE_DUNNING_LADDER_90;
  expect(fg.dunningCustomerScheduleLive()).toBe(false);
});

test('the allowlist alone never turns anything on', () => {
  prereqsOn();
  process.env.DUNNING_CUSTOMER_SCHEDULE_ALLOWLIST = 'cust-1';
  const fg = load();
  expect(fg.dunningCustomerScheduleLive()).toBe(false);
  expect(fg.dunningCustomerScheduleShadowLive()).toBe(false);
});
