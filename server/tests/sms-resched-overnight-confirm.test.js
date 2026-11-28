'use strict';

/**
 * Owner rulings 2026-11-02 & 2026-11-27 (resched A):
 * When a customer replies by SMS to accept an offered reschedule slot, the
 * standard Waves confirmation text goes out immediately (even overnight) for
 * the account holder, while delayed reconciler retries and automated/non-customer
 * moves stay inside the 8 AM–8 PM ET quiet-hours fence.
 */

const fs = require('fs');
const path = require('path');

const GATE = 'GATE_SMS_SEND_WINDOW';
const OLD_GATE = process.env[GATE];

function loadCheckSendWindowWithGateOn() {
  process.env[GATE] = 'true';
  let mod;
  jest.isolateModules(() => {
    mod = require('../services/messaging/validators/send-window');
  });
  return mod.checkSendWindow;
}

afterEach(() => {
  if (OLD_GATE === undefined) delete process.env[GATE];
  else process.env[GATE] = OLD_GATE;
});

describe('resched A: customer-initiated SMS reschedule confirmation window', () => {
  // 2026-11-28T03:30:00Z = 10:30 PM ET (outside 8 AM–8 PM ET send window)
  const OVERNIGHT_ET = new Date('2026-11-28T03:30:00Z');

  test('overnight appointment_rescheduled text is allowed when customerInitiated is true', () => {
    const checkSendWindow = loadCheckSendWindowWithGateOn();
    const result = checkSendWindow({
      channel: 'sms',
      audience: 'customer',
      purpose: 'appointment_confirmation',
      entryPoint: 'appointment_reminders',
      customerInitiated: true,
    }, null, null, OVERNIGHT_ET);
    expect(result.ok).toBe(true);
  });

  test('overnight appointment_rescheduled text stays held when customerInitiated is false', () => {
    const checkSendWindow = loadCheckSendWindowWithGateOn();
    const result = checkSendWindow({
      channel: 'sms',
      audience: 'customer',
      purpose: 'appointment_confirmation',
      entryPoint: 'appointment_reminders',
      customerInitiated: false,
    }, null, null, OVERNIGHT_ET);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('QUIET_HOURS_HOLD');
    expect(result.deferred).toBe(true);
  });

  test('delayed series reconciler retries do NOT bypass quiet hours (only explicit live customerInitiated:true does)', () => {
    const src = fs.readFileSync(path.join(__dirname, '../routes/admin-dispatch.js'), 'utf8');
    const seriesStart = src.indexOf('async function applySeriesMoveEffects(');
    const seriesEnd = src.indexOf("router.get('/:serviceId/series-move-preview'", seriesStart);
    const seriesBlock = src.slice(seriesStart, seriesEnd);
    expect(seriesBlock).toContain('customerInitiated: customerInitiated === true,');
    expect(seriesBlock).not.toContain('CUSTOMER_SERIES_SURFACES');

    const reconcileStart = src.indexOf('async function reconcileSeriesMoveEffects(');
    expect(reconcileStart).toBeGreaterThan(-1);
    const reconcileEnd = src.indexOf("router.get('/:serviceId/series-move-preview'", reconcileStart);
    const reconcileBlock = src.slice(reconcileStart, reconcileEnd);
    expect(reconcileBlock).toContain('applySeriesMoveEffects(');
    expect(reconcileBlock).not.toContain('customerInitiated: true');
    expect(reconcileBlock).not.toContain('customerInitiatedPhone');

    const apptSrc = fs.readFileSync(path.join(__dirname, '../services/appointment-reminders.js'), 'utf8');
    expect(apptSrc).toContain('contactIsCustomerInitiated(sendOptions, contact.phone, customer.phone, primaryPhone)');
    expect(apptSrc).toContain('sameCanonicalUsE164(contactPhone, primaryPhoneRaw)');
    expect(apptSrc).toContain('sameCanonicalUsE164(contactPhone, sendOptions.customerInitiatedPhone)');
  });
});
