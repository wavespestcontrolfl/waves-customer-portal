const TWILIO_NUMBERS = require('../config/twilio-numbers');

const FB = '+19418775491';   // Facebook Ads call-extension tracking number
const GADS = '+19412691697'; // Google Ads — regression guard

describe('Facebook Ads call tracking number', () => {
  test('facebookAdsPest is registered with source=facebook', () => {
    const fb = TWILIO_NUMBERS.paidTracking.facebookAdsPest;
    expect(fb).toBeTruthy();
    expect(fb.number).toBe(FB);
    expect(fb.source).toBe('facebook');
  });

  test('findByNumber tags the FB number as type=facebook (not google_ads)', () => {
    const cfg = TWILIO_NUMBERS.findByNumber(FB);
    expect(cfg).toBeTruthy();
    expect(cfg.type).toBe('facebook'); // stamped into call_log.numberType
    expect(cfg.trackingId).toBe('facebookAdsPest');
    expect(cfg.locationId).toBe('bradenton');
  });

  test('getLeadSourceFromNumber returns source=facebook', () => {
    expect(TWILIO_NUMBERS.getLeadSourceFromNumber(FB).source).toBe('facebook');
  });

  test('Google Ads number is unchanged by the paid-source generalization', () => {
    expect(TWILIO_NUMBERS.findByNumber(GADS).type).toBe('google_ads');
    expect(TWILIO_NUMBERS.getLeadSourceFromNumber(GADS).source).toBe('google_ads');
  });

  test('FB number appears in allNumbers with its platform type', () => {
    const row = TWILIO_NUMBERS.allNumbers.find(n => n.number === FB);
    expect(row).toBeTruthy();
    expect(row.type).toBe('facebook');
  });
});
