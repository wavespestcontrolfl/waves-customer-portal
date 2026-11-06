// GATE_DAY_ONLY_PROMISE part A: services/time-promise.js, the stable API the later parts (senders, customer screens,
// AI context, office booking box) call. Pure truth tables, the metadata pass-through proof, and the 24.25 h cutoff
// pinned to the reminder sender's own boundary. Synthetic data only.
jest.mock('../models/db', () => {
  const insert = jest.fn(() => ({ returning: jest.fn(async () => [{ id: 'audit-1' }]) }));
  const db = jest.fn(() => ({ insert }));
  db.insert = insert;
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const fs = require('fs');
const path = require('path');
const gates = require('../config/feature-gates');
const db = require('../models/db');
const timePromise = require('../services/time-promise');
const toldVisits = require('../services/auto-dispatch/told-visits');

const { DAY_PROMISE_META, DAY_PROMISE_CUTOFF_HOURS, shouldPromiseDayOnly, showHourFor, dayOnlyPromiseOn } = timePromise;
const NOW = new Date('2026-11-10T09:00:00Z');
const HOUR = 3600000;
const at = (hours) => new Date(NOW.getTime() + hours * HOUR);

afterEach(() => { delete process.env.GATE_DAY_ONLY_PROMISE; });

describe('the gate reader', () => {
  test('dark by default; only exactly "true" turns it on, read at call time', () => {
    expect(gates.dayOnlyPromiseLive()).toBe(false);
    expect(dayOnlyPromiseOn()).toBe(false);
    for (const v of ['', 'false', '1', 'on', 'TRUE', 'yes']) {
      process.env.GATE_DAY_ONLY_PROMISE = v;
      expect(gates.dayOnlyPromiseLive()).toBe(false);
      expect(dayOnlyPromiseOn()).toBe(false);
    }
    process.env.GATE_DAY_ONLY_PROMISE = 'true';
    expect(gates.dayOnlyPromiseLive()).toBe(true);
    expect(dayOnlyPromiseOn()).toBe(true);
    delete process.env.GATE_DAY_ONLY_PROMISE;
    expect(dayOnlyPromiseOn()).toBe(false);
  });

  test('the reader is exported on its own line, the boot log has an entry, the header documents it', () => {
    const src = fs.readFileSync(path.join(__dirname, '../config/feature-gates.js'), 'utf8');
    expect(src).toMatch(/^module\.exports\.dayOnlyPromiseLive = dayOnlyPromiseLive;$/m);
    expect(src).toMatch(/^ \*   GATE_DAY_ONLY_PROMISE=true /m);
    expect(gates.gates.dayOnlyPromise).toBe(false);
  });

  test('an unreadable gate is off', () => {
    jest.isolateModules(() => {
      jest.doMock('../config/feature-gates', () => { throw new Error('boom'); });
      expect(require('../services/time-promise').dayOnlyPromiseOn()).toBe(false);
    });
    jest.dontMock('../config/feature-gates');
  });
});

describe('shouldPromiseDayOnly', () => {
  const ok = { startAt: at(50), now: NOW, reminder24hEnabled: true, customerPicked: false, level: 'none', gateOn: true };
  const call = (over = {}) => shouldPromiseDayOnly({ ...ok, ...over });

  test('true when every condition holds', () => {
    expect(call()).toBe(true);
    expect(call({ level: 'day' })).toBe(true);
    expect(call({ level: undefined, reminder24hEnabled: undefined, customerPicked: undefined })).toBe(true);
  });

  test('each condition flipping alone makes it false', () => {
    expect(call({ gateOn: false })).toBe(false);
    expect(call({ gateOn: undefined })).toBe(false); // an unset gate reads the real gate, which is off
    expect(call({ startAt: at(10) })).toBe(false); // inside the cutoff
    expect(call({ reminder24hEnabled: false })).toBe(false);
    expect(call({ customerPicked: true })).toBe(false);
    expect(call({ level: 'hour' })).toBe(false);
  });

  test('the cutoff: exactly 24.25 h is inside (false); a hair beyond is day-only', () => {
    expect(DAY_PROMISE_CUTOFF_HOURS).toBe(24.25);
    expect(call({ startAt: at(24.25) })).toBe(false);
    expect(call({ startAt: new Date(at(24.25).getTime() + 1) })).toBe(true);
    expect(call({ startAt: at(24) })).toBe(false);
    expect(call({ startAt: at(72) })).toBe(true);
  });

  test('a windowless or invalid time is false (today\'s windowless copy stays)', () => {
    for (const startAt of [null, undefined, '', 'not a time', NaN, new Date('nope')]) expect(call({ startAt })).toBe(false);
    expect(call({ startAt: undefined, now: undefined })).toBe(false);
  });

  test('a past time is false; ISO strings and Date objects both work', () => {
    expect(call({ startAt: at(-5) })).toBe(false);
    expect(call({ startAt: at(50).toISOString() })).toBe(true);
  });

  test('gateOn defaults to the real gate, read at call time', () => {
    const { gateOn, ...withoutGate } = ok;
    expect(gateOn).toBe(true);
    expect(shouldPromiseDayOnly(withoutGate)).toBe(false);
    process.env.GATE_DAY_ONLY_PROMISE = 'true';
    expect(shouldPromiseDayOnly(withoutGate)).toBe(true);
  });
});

describe('showHourFor', () => {
  const call = (over = {}) => showHourFor({ level: 'none', startAt: at(50), now: NOW, gateOn: true, ...over });

  test('gate off: always the hour (today)', () => {
    expect(call({ gateOn: false })).toBe(true);
    expect(call({ gateOn: false, level: 'day' })).toBe(true);
    expect(call({ gateOn: undefined, level: 'day' })).toBe(true); // real gate, off
  });

  test('gate on, far out, level none or day: only the day (false)', () => {
    expect(call()).toBe(false);
    expect(call({ level: 'day' })).toBe(false);
  });

  test('an hour promise always shows the hour', () => {
    expect(call({ level: 'hour' })).toBe(true);
  });

  test('inside the cutoff the hour shows; the boundary is inclusive', () => {
    expect(call({ startAt: at(10) })).toBe(true);
    expect(call({ startAt: at(24.25) })).toBe(true);
    expect(call({ startAt: new Date(at(24.25).getTime() + 1) })).toBe(false);
    expect(call({ startAt: at(-1) })).toBe(true);
  });

  test('a missing start is the screen\'s own windowless rendering (true); an invalid one is too', () => {
    expect(call({ startAt: null })).toBe(true);
    expect(call({ startAt: undefined })).toBe(true);
    expect(call({ startAt: 'not a time' })).toBe(true);
  });

  test('gateOn defaults to the real gate, read at call time', () => {
    process.env.GATE_DAY_ONLY_PROMISE = 'true';
    expect(showHourFor({ level: 'day', startAt: at(50), now: NOW })).toBe(false);
  });
});

describe('DAY_PROMISE_META', () => {
  test('is frozen and carries exactly the two keys', () => {
    expect(Object.isFrozen(DAY_PROMISE_META)).toBe(true);
    expect(DAY_PROMISE_META).toEqual({ window_unknown: true, promise_level: 'day' });
  });

  test('through the real audit row builder the stored metadata keeps promise_level and drops rendered_slot_ms', async () => {
    const { persistAudit } = require('../services/messaging/audit');
    await persistAudit({
      input: {
        to: '+15555550100', body: 'x', purpose: 'appointment', audience: 'customer', channel: 'sms', appointmentId: 'visit-1',
        renderedSlotMs: Date.parse('2026-11-12T14:00:00Z'), promisedWindowUnknown: DAY_PROMISE_META.window_unknown === true,
        metadata: { original_message_type: 'appointment_confirmation', scheduled_service_id: 'visit-1', ...DAY_PROMISE_META },
      },
      validatorsPassed: [], validatorsFailed: [], blockedBy: null, providerOutcome: null,
    });
    const row = db.insert.mock.calls[0][0];
    expect(row.metadata.promise_level).toBe('day');
    expect(row.metadata).not.toHaveProperty('rendered_slot_ms');
    // Control: a send that quotes a window records its slot.
    db.insert.mockClear();
    await persistAudit({
      input: { to: '+15555550100', body: 'x', purpose: 'appointment', audience: 'customer', channel: 'sms', appointmentId: 'visit-1', renderedSlotMs: 1760000000000, metadata: {} },
      validatorsPassed: [], validatorsFailed: [], blockedBy: null, providerOutcome: null,
    });
    expect(db.insert.mock.calls[0][0].metadata.rendered_slot_ms).toBe(1760000000000);
  });

  test('the reminder sender drops the slot for window_unknown, and the detector reads the marker', () => {
    const reminders = fs.readFileSync(path.join(__dirname, '../services/appointment-reminders.js'), 'utf8');
    expect(reminders).toMatch(/const windowUnknown = metaExtra\.window_unknown === true;/);
    expect(reminders).toMatch(/if \(windowUnknown\) delete recordedMeta\.rendered_slot_ms;/);
    const detector = fs.readFileSync(path.join(__dirname, '../services/no-show-detector.js'), 'utf8');
    expect(detector).toMatch(/promise_level === 'day'/);
  });
});

describe('DAY_PROMISE_CUTOFF_HOURS matches the 24-hour reminder boundary', () => {
  test('the reminder sender\'s reminder72hStillReachable draws its line at the same 24.25 hours', () => {
    const reminders = fs.readFileSync(path.join(__dirname, '../services/appointment-reminders.js'), 'utf8');
    const fn = reminders.match(/function reminder72hStillReachable[\s\S]*?\n}\n/)[0];
    expect(fn).toContain(`> ${DAY_PROMISE_CUTOFF_HOURS}`);
    expect(reminders).toMatch(/hoursUntil > 24\.25 && hoursUntil <= 72\.25/);
    expect(reminders).toMatch(/hoursUntil > 0 && hoursUntil <= 24\.25/);
  });
});

test('loadPromiseLevels is re-exported from told-visits', () => {
  expect(timePromise.loadPromiseLevels).toBe(toldVisits.loadPromiseLevels);
});
