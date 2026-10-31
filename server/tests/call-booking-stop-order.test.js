/**
 * Phone agent stop order (GATE_CALL_BOOKING_STOP_ORDER, owner 2026-10-26
 * "go d"): a fresh call-pipeline booking numbers its technician's day
 * through the staff writer (placeMovedVisit), so the tech app and the board
 * list it in its place instead of after every numbered stop.
 *
 * The helper is unit-tested; the call site sits inline in
 * processCallRecording's booking transaction, so its placement is pinned by
 * source shape, as call-recording-processor-callback-hold-source.test.js
 * does for that function's other inline decision points.
 */
const fs = require('fs');
const path = require('path');

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/twilio-numbers', () => ({
  isInternalNumber: jest.fn(() => false),
  isOwnedNumber: jest.fn(() => false),
  findByNumber: jest.fn(() => null),
  getLeadSourceFromNumber: jest.fn(() => ({ source: 'phone_call' })),
}));
jest.mock('../services/scheduling/arrival-route', () => ({
  ...jest.requireActual('../services/scheduling/arrival-route'),
  placeMovedVisit: jest.fn(async () => ['stop-a', 'svc-1', 'stop-b']),
}));

const { placeMovedVisit } = require('../services/scheduling/arrival-route');
const { placeCallBookingInRoute } = require('../services/call-recording-processor')._test;

describe('placeCallBookingInRoute', () => {
  const trx = { isTransaction: true };
  const created = { id: 'svc-1', technician_id: 'tech-1', window_start: '10:00:00' };

  beforeEach(() => placeMovedVisit.mockClear());
  afterEach(() => { delete process.env.GATE_CALL_BOOKING_STOP_ORDER; });

  test('gate on: the booked visit goes to the staff writer on the booking transaction, marked as a phone call', async () => {
    process.env.GATE_CALL_BOOKING_STOP_ORDER = 'true';
    await expect(placeCallBookingInRoute(trx, created)).resolves.toEqual(['stop-a', 'svc-1', 'stop-b']);
    expect(placeMovedVisit).toHaveBeenCalledTimes(1);
    expect(placeMovedVisit).toHaveBeenCalledWith(trx, { serviceId: 'svc-1', source: 'phone_call' });
  });

  test('gate on, a street-level pending row: its address waits on the office, so the day keeps its numbers', async () => {
    process.env.GATE_CALL_BOOKING_STOP_ORDER = 'true';
    await expect(placeCallBookingInRoute(trx, created, { streetLevelPending: true })).resolves.toBeNull();
    expect(placeMovedVisit).not.toHaveBeenCalled();
  });

  test('gate off (default): no stop order is written', async () => {
    await expect(placeCallBookingInRoute(trx, created)).resolves.toBeNull();
    expect(placeMovedVisit).not.toHaveBeenCalled();
  });
});

// GATE_ROUTE_CHECK_AUTO_SAVES (owner 2026-10-29, Route Check Everywhere 2b): the
// umbrella places a call booking through the shared auto-save helper, once.
describe('placeCallBookingInRoute with GATE_ROUTE_CHECK_AUTO_SAVES', () => {
  const trx = { isTransaction: true };
  const created = { id: 'svc-1', technician_id: 'tech-1', window_start: '10:00:00' };
  const autoOn = () => { process.env.GATE_ROUTE_CHECK_AUTO_SAVES = 'true'; process.env.GATE_ADMIN_ARRIVAL_WINDOWS = 'true'; };

  beforeEach(() => placeMovedVisit.mockClear());
  afterEach(() => {
    delete process.env.GATE_CALL_BOOKING_STOP_ORDER;
    delete process.env.GATE_ROUTE_CHECK_AUTO_SAVES;
    delete process.env.GATE_ADMIN_ARRIVAL_WINDOWS;
  });

  test('on, the stop-order gate off: placed once on the booking transaction, marked as a call booking, cache roads only', async () => {
    autoOn();
    await expect(placeCallBookingInRoute(trx, created)).resolves.toEqual(['stop-a', 'svc-1', 'stop-b']);
    expect(placeMovedVisit).toHaveBeenCalledTimes(1);
    expect(placeMovedVisit).toHaveBeenCalledWith(trx, { serviceId: 'svc-1', staffSave: true, source: 'call_booking' });
  });

  test('on WITH the stop-order gate: still one placement, the stop-order gate\'s own (phone_call), never a second', async () => {
    autoOn();
    process.env.GATE_CALL_BOOKING_STOP_ORDER = 'true';
    await placeCallBookingInRoute(trx, created);
    expect(placeMovedVisit).toHaveBeenCalledTimes(1);
    expect(placeMovedVisit).toHaveBeenCalledWith(trx, { serviceId: 'svc-1', source: 'phone_call' });
  });

  test('on, a street-level pending row: its address waits on the office, so nothing is placed', async () => {
    autoOn();
    await expect(placeCallBookingInRoute(trx, created, { streetLevelPending: true })).resolves.toBeNull();
    expect(placeMovedVisit).not.toHaveBeenCalled();
  });

  test('on without the arrival-window route check: nothing is placed', async () => {
    process.env.GATE_ROUTE_CHECK_AUTO_SAVES = 'true';
    await expect(placeCallBookingInRoute(trx, created)).resolves.toBeNull();
    expect(placeMovedVisit).not.toHaveBeenCalled();
  });

  test('on, a throwing placement: resolves null, the booking is not failed', async () => {
    autoOn();
    placeMovedVisit.mockRejectedValueOnce(new Error('route boom'));
    await expect(placeCallBookingInRoute(trx, created)).resolves.toBeNull();
  });
});

describe('the fresh call booking calls it, and only there', () => {
  const src = fs.readFileSync(path.join(__dirname, '../services/call-recording-processor.js'), 'utf8');
  const CALL = 'await placeCallBookingInRoute(trx, created, { streetLevelPending });';

  test('once, at the end of the fresh-insert branch, before it returns the created row', () => {
    expect(src.split(CALL).length - 1).toBe(1);
    const at = src.indexOf(CALL);
    const branch = src.slice(src.lastIndexOf('if (created) {', at), at);
    expect(branch).toContain('followUpCreated = await ensureCallFollowUpVisit(created, { fresh: true });');
    expect(src.slice(at + CALL.length).trimStart().startsWith('return created;')).toBe(true);
  });
});
