// codex #4912 r2 P2: the promotion-readiness audit must derive contactPhone
// the same way production does (resolveCallContactPhone), not a raw
// to_phone/from_phone branch — a lead-webhook-auto-bridge outbound call's
// to_phone is the STAFF cell, and the real customer leg lives in bridge
// metadata. Getting this wrong makes the audit treat the staff number as
// callerAni and over-count auto-routable calls.
//
// The script itself refuses to run (see promotion-readiness-disabled.test.js)
// pending #4437 follow-up, but its module.exports.contactPhoneForCall is a
// pure helper reachable without exercising main() — requiring the module
// must not exit the test process (require.main guard).
const { contactPhoneForCall } = require('../scripts/v2-promotion-readiness');

describe('v2-promotion-readiness contactPhoneForCall', () => {
  test('a bridge call with valid metadata resolves to the customer leg, never the staff cell', () => {
    const row = {
      direction: 'outbound',
      source: 'lead-webhook-auto-bridge',
      to_phone: '+19415550001', // staff cell dialed by the bridge
      from_phone: '+19415550099',
      metadata: JSON.stringify({ type: 'lead_auto_bridge', leadPhone: '+19415551234' }),
    };
    expect(contactPhoneForCall(row)).toBe('+19415551234');
  });

  test('a bridge call with missing metadata resolves to no contact phone, NOT the staff cell', () => {
    const row = {
      direction: 'outbound',
      source: 'lead-webhook-auto-bridge',
      to_phone: '+19415550001',
      from_phone: '+19415550099',
      // metadata absent entirely
    };
    const resolved = contactPhoneForCall(row);
    expect(resolved).not.toBe('+19415550001');
    expect(resolved).toBeFalsy();
  });

  test('a bridge call with malformed (unparseable) metadata JSON also resolves to no contact phone', () => {
    const row = {
      direction: 'outbound',
      source: 'lead-webhook-auto-bridge',
      to_phone: '+19415550001',
      from_phone: '+19415550099',
      metadata: '{not valid json',
    };
    const resolved = contactPhoneForCall(row);
    expect(resolved).not.toBe('+19415550001');
    expect(resolved).toBeFalsy();
  });

  test('an ordinary outbound call (not a bridge) still resolves to the dialed customer number', () => {
    const row = {
      direction: 'outbound',
      source: 'call',
      to_phone: '+19415559999',
      from_phone: '+19415550099',
    };
    expect(contactPhoneForCall(row)).toBe('+19415559999');
  });

  test('an inbound call resolves to the caller ANI as before', () => {
    const row = {
      direction: 'inbound',
      source: 'call',
      to_phone: '+19415550099',
      from_phone: '+19415551234',
    };
    expect(contactPhoneForCall(row)).toBe('+19415551234');
  });
});
