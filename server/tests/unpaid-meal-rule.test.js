const { unpaidMealUnits } = require('../utils/unpaid-meal');
const { payrollUnits } = require('../utils/payroll-units');
const {
  UNPAID_MEAL_MIN_BREAK_MINUTES,
  AUTO_LUNCH_SHIFT_THRESHOLD_MINUTES,
  AUTO_LUNCH_MINUTES,
} = require('../constants/staff-time');

// Minutes in, payroll units (hundredths of a minute) through the rule.
const u = (minutes) => payrollUnits(minutes);
const unpaid = ({ shift, breaks = [], noLunch = false, enabled = true }) => unpaidMealUnits({
  totalShiftUnits: u(shift),
  breakDurationUnits: breaks.map(u),
  noLunch,
  enabled,
});

describe('unpaid meal rule (GATE_AUTO_LUNCH)', () => {
  test('constants are 30 / 360 / 30', () => {
    expect(UNPAID_MEAL_MIN_BREAK_MINUTES).toBe(30);
    expect(AUTO_LUNCH_SHIFT_THRESHOLD_MINUTES).toBe(360);
    expect(AUTO_LUNCH_MINUTES).toBe(30);
  });

  test('a day of exactly 6 hours or less takes no auto lunch', () => {
    expect(unpaid({ shift: 360 })).toBe(0n);
    expect(unpaid({ shift: 240 })).toBe(0n);
  });

  test('a day over 6 hours takes 30 minutes', () => {
    expect(unpaid({ shift: 360.01 })).toBe(u(30));
    expect(unpaid({ shift: 630 })).toBe(u(30));
  });

  test('no_lunch skips the auto lunch', () => {
    expect(unpaid({ shift: 630, noLunch: true })).toBe(0n);
  });

  test('a recorded 45-minute break is the unpaid meal, not 45 plus 30', () => {
    expect(unpaid({ shift: 630, breaks: [45] })).toBe(u(45));
  });

  test('a recorded 30-minute break counts as the meal', () => {
    expect(unpaid({ shift: 630, breaks: [30] })).toBe(u(30));
    expect(unpaid({ shift: 200, breaks: [30] })).toBe(u(30));
  });

  test('a recorded meal still applies when no_lunch is set', () => {
    expect(unpaid({ shift: 630, breaks: [45], noLunch: true })).toBe(u(45));
  });

  test('a 20-minute break stays paid and the auto lunch still applies', () => {
    expect(unpaid({ shift: 630, breaks: [20] })).toBe(u(30));
    expect(unpaid({ shift: 300, breaks: [20] })).toBe(0n);
    expect(unpaid({ shift: 630, breaks: [29.99] })).toBe(u(30));
  });

  test('several breaks: only the ones of 30 minutes or more add up', () => {
    expect(unpaid({ shift: 630, breaks: [15, 20, 35] })).toBe(u(35));
    expect(unpaid({ shift: 720, breaks: [30, 40, 10] })).toBe(u(70));
    expect(unpaid({ shift: 720, breaks: [15, 15, 15] })).toBe(u(30));
  });

  test('gate off is always zero', () => {
    expect(unpaid({ shift: 630, enabled: false })).toBe(0n);
    expect(unpaid({ shift: 630, breaks: [45], enabled: false })).toBe(0n);
    expect(unpaidMealUnits({ totalShiftUnits: u(630), breakDurationUnits: [u(45)] })).toBe(0n);
  });

  test('the unpaid meal never exceeds the shift', () => {
    expect(unpaid({ shift: 20, breaks: [45] })).toBe(u(20));
    expect(unpaid({ shift: 0, breaks: [45] })).toBe(0n);
    expect(unpaid({ shift: 0 })).toBe(0n);
    expect(unpaid({ shift: 400, breaks: [500] })).toBe(u(400));
  });

  test('works in integer hundredths with no float drift', () => {
    expect(unpaid({ shift: 630.07, breaks: [30.01] })).toBe(3001n);
    expect(typeof unpaid({ shift: 630 })).toBe('bigint');
  });
});
