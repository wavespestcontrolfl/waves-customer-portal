const TWILIO_NUMBERS = require('../config/twilio-numbers');

// The four dedicated GBP call-button numbers (one per Google Business
// Profile). These let a GBP-sourced call be told apart from an organic
// city-page call that shares the location number. See twilio-numbers.js.
const GBP_NUMBERS = {
  bradenton: '+19413521572',
  parrish: '+19413840224',
  sarasota: '+19414910407',
  venice: '+19414774880',
};

describe('GBP call tracking numbers', () => {
  test('all four GBP profiles have a tracking number', () => {
    expect(Object.keys(TWILIO_NUMBERS.gbpTracking).sort()).toEqual(
      ['bradenton', 'parrish', 'sarasota', 'venice']
    );
  });

  test('findByNumber tags each GBP number as gbp_tracking with a city label + location', () => {
    for (const [city, number] of Object.entries(GBP_NUMBERS)) {
      const cfg = TWILIO_NUMBERS.findByNumber(number);
      expect(cfg).toBeTruthy();
      expect(cfg.type).toBe('gbp_tracking');
      expect(cfg.label).toMatch(/^GBP — /); // this label is stamped into call_log.location
      expect(cfg.locationId).toBe(city);
      expect(cfg.gbpProfileId).toBe(city);
    }
  });

  test('getLeadSourceFromNumber returns google_business_profile per city', () => {
    for (const number of Object.values(GBP_NUMBERS)) {
      const ls = TWILIO_NUMBERS.getLeadSourceFromNumber(number);
      expect(ls.source).toBe('google_business_profile');
      expect(ls.area).toBeTruthy();
    }
  });

  test('GBP numbers are listed in portalNumbers and allNumbers', () => {
    for (const number of Object.values(GBP_NUMBERS)) {
      expect(TWILIO_NUMBERS.portalNumbers).toContain(number);
      expect(TWILIO_NUMBERS.allNumbers.some(n => n.number === number)).toBe(true);
    }
  });

  test('GBP numbers do not collide with existing location / tracking numbers', () => {
    const gbp = new Set(Object.values(GBP_NUMBERS));
    const others = TWILIO_NUMBERS.allNumbers
      .filter(n => n.type !== 'gbp_tracking')
      .map(n => n.number);
    for (const number of others) expect(gbp.has(number)).toBe(false);
  });
});
