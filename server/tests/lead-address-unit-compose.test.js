/**
 * leads.address is a single free-text column — the unit captured in
 * address_line2 must be composed into it, or the lead card, pipeline card, and
 * estimate prefill (LeadsTabs → params.address) all drop the caller's unit
 * while the customer row keeps it (prod, 2026-08-29).
 */

jest.mock('node-cron', () => ({ schedule: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/twilio', () => ({}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn(() => true),
  logGateStatus: jest.fn(),
}));

const { composeLeadAddress, analyzeLeadAddress, reaffirmedFilledLeadFields, leadAddressCompareKey, leadAddressTailPlace } = require('../services/call-recording-processor')._test;

describe('composeLeadAddress', () => {
  test('appends the unit to the street', () => {
    expect(composeLeadAddress('100 Main St', 'Apt 4')).toBe('100 Main St, Apt 4');
    expect(composeLeadAddress('100 Main St', '#4')).toBe('100 Main St, #4');
  });

  test('street alone when no unit', () => {
    expect(composeLeadAddress('100 Main St', null)).toBe('100 Main St');
    expect(composeLeadAddress('100 Main St', '   ')).toBe('100 Main St');
  });

  test('no line2: an inline-only unit and a place tail are parsed and protected', () => {
    expect(composeLeadAddress('100 Main St Apt 4', null)).toBe('100 Main St, Apt 4');
    expect(composeLeadAddress('100 Main St Apt 4, Sarasota, FL 34236', null)).toBe('100 Main St, Apt 4, Sarasota, FL 34236');
    const longStreet = `100 ${'Verylongstreetname '.repeat(20)}Blvd`;
    const out = composeLeadAddress(`${longStreet} Apt 4, Sarasota, FL 34236`, null);
    expect(out.length).toBeLessThanOrEqual(255);
    expect(out.endsWith(', Apt 4, Sarasota, FL 34236')).toBe(true);
  });

  test('null when no street (fill-if-empty guard upstream never writes a bare unit)', () => {
    expect(composeLeadAddress('', 'Apt 4')).toBeNull();
    expect(composeLeadAddress(null, null)).toBeNull();
  });

  test('does not duplicate a unit the street already embeds', () => {
    expect(composeLeadAddress('100 Main St Apt 4', 'Apt 4')).toBe('100 Main St, Apt 4');
    expect(composeLeadAddress('100 Main St #4', 'Unit 4')).toBe('100 Main St, #4');
    expect(composeLeadAddress('100 Main St # 4', 'Apt 4')).toBe('100 Main St, # 4');
    expect(composeLeadAddress('100 Main St Suite 200-A', 'Suite 200-A')).toBe('100 Main St, Suite 200-A');
    expect(composeLeadAddress('100 Main St Apt # 4', 'Unit 4')).toBe('100 Main St, Apt # 4');
  });

  test('conflicting inline and dedicated units: keep the street line, drop the dedicated unit, flag it', () => {
    expect(composeLeadAddress('100 Main St Apt 4', 'Apt 5')).toBe('100 Main St Apt 4');
    expect(analyzeLeadAddress('100 Main St Apt 4', 'Apt 5')).toEqual({ address: '100 Main St Apt 4', unitConflict: true });
    expect(analyzeLeadAddress('100 Main St Apt 4, Sarasota, FL 34236', 'Apt 5')).toEqual({ address: '100 Main St Apt 4, Sarasota, FL 34236', unitConflict: true });
    // Same door in another notation is NOT a conflict.
    expect(analyzeLeadAddress('100 Main St Apt 4', '#4')).toEqual({ address: '100 Main St, Apt 4', unitConflict: false });
    expect(analyzeLeadAddress('100 Main St', 'Apt 4').unitConflict).toBe(false);
    expect(analyzeLeadAddress('100 Main St Apt 4', null).unitConflict).toBe(false);
  });

  test('multipart and structural designators dedupe through the shared unit parser', () => {
    expect(composeLeadAddress('100 Main St Bldg 2 Apt 4', 'Bldg 2 Apt 4')).toBe('100 Main St, Bldg 2 Apt 4');
    expect(composeLeadAddress('100 Main St Floor 2', 'Fl 2')).toBe('100 Main St, Floor 2');
    expect(composeLeadAddress('100 Main St Lot 7', 'Lot 7')).toBe('100 Main St, Lot 7');
    expect(composeLeadAddress('100 Main St Space 12', 'Spc 12')).toBe('100 Main St, Space 12');
    // Bldg 2 Apt 4 is a different door than Apt 4 — never collapsed into one, never stored as two.
    expect(analyzeLeadAddress('100 Main St Bldg 2 Apt 4', 'Apt 4')).toEqual({ address: '100 Main St Bldg 2 Apt 4', unitConflict: true });
    // Designator words inside a street name are not a unit.
    expect(composeLeadAddress('4501 Space Coast Blvd', 'Apt 4')).toBe('4501 Space Coast Blvd, Apt 4');
  });

  test('multi-letter unit identifiers dedupe (PH1)', () => {
    expect(composeLeadAddress('100 Main St Unit PH1', 'Unit PH1')).toBe('100 Main St, Unit PH1');
    expect(composeLeadAddress('100 Main St', 'PH1')).toBe('100 Main St, Unit PH1');
  });

  test('a full-address line1 keeps its place tail through the rebuild', () => {
    expect(composeLeadAddress('100 Main St, Apt 4, Sarasota, FL 34236', 'Apt 4')).toBe('100 Main St, Apt 4, Sarasota, FL 34236');
    expect(composeLeadAddress('100 Main St Apt 4, Sarasota, FL 34236', '#4')).toBe('100 Main St, Apt 4, Sarasota, FL 34236');
    expect(composeLeadAddress('100 Main St, Sarasota, FL 34236', 'Apt 4')).toBe('100 Main St, Apt 4, Sarasota, FL 34236');
    expect(composeLeadAddress('100 Main St, Sarasota, FL 34236', null)).toBe('100 Main St, Sarasota, FL 34236');
  });

  test('a BARE unit gains its designator so the parser and ownership key see it', () => {
    expect(composeLeadAddress('100 Main St', '4B')).toBe('100 Main St, Unit 4B');
    expect(composeLeadAddress('100 Main St', '102')).toBe('100 Main St, Unit 102');
    expect(composeLeadAddress('100 Main St Apt 4', '4')).toBe('100 Main St, Apt 4');
    expect(leadAddressCompareKey('100 Main St, Unit 4B')).toBe('100 main st|4b');
    const locked = { address: '100 Main St, Unit 4B', city: 'Sarasota', zip: '34236' };
    expect(reaffirmedFilledLeadFields({ address: composeLeadAddress('100 Main St', '4B'), city: 'Sarasota', zip: '34236' }, locked).address).toBe('100 Main St, Unit 4B');
  });

  test('comma-free full-address fallback: locality is split before the unit is deduped', () => {
    expect(composeLeadAddress('100 Main St Apt 4 Sarasota FL 34236', 'Apt 4')).toBe('100 Main St, Apt 4, Sarasota FL 34236');
    expect(composeLeadAddress('100 Main St Apt 4 Sarasota FL 34236', '#4')).toBe('100 Main St, Apt 4, Sarasota FL 34236');
    expect(composeLeadAddress('100 Main St Sarasota FL 34236', 'Apt 4')).toBe('100 Main St, Apt 4, Sarasota FL 34236');
    expect(composeLeadAddress('100 Main St Bldg 2 Apt 4 Sarasota FL 34236', 'Bldg 2 Apt 4')).toBe('100 Main St, Bldg 2 Apt 4, Sarasota FL 34236');
    expect(analyzeLeadAddress('100 Main St Apt 4 Sarasota FL 34236', 'Apt 5')).toEqual({ address: '100 Main St Apt 4, Sarasota FL 34236', unitConflict: true });
    expect(composeLeadAddress('100 Main St Apt 4 Sarasota FL 34236', null)).toBe('100 Main St, Apt 4, Sarasota FL 34236');
    // Street names that carry a suffix word mid-line are not split.
    expect(composeLeadAddress('4501 Space Coast Blvd', 'Apt 4')).toBe('4501 Space Coast Blvd, Apt 4');
  });

  test('a runaway place tail never crowds the street out of the bound', () => {
    const out = composeLeadAddress(`100 Main St, ${'Somewhere '.repeat(40)}`, 'Apt 4');
    expect(out.length).toBeLessThanOrEqual(255);
    expect(out.startsWith('100 Main St, Apt 4, Somewhere')).toBe(true);
  });

  test('bounded to the leads.address varchar(255) — street trims, unit tail survives', () => {
    const longStreet = `100 ${'Verylongstreetname '.repeat(20)}Blvd`;
    expect(longStreet.length).toBeGreaterThan(255);
    const out = composeLeadAddress(longStreet, 'Apt 4');
    expect(out.length).toBeLessThanOrEqual(255);
    expect(out.endsWith(', Apt 4')).toBe(true);
    expect(composeLeadAddress(longStreet, null).length).toBeLessThanOrEqual(255);
    // An overlong unit is clamped to 100 (same as the customer insert) so
    // the street is never dropped for the tail.
    const longUnit = `Suite ${'A'.repeat(300)}`;
    const clamped = composeLeadAddress('100 Main St', longUnit);
    expect(clamped.length).toBeLessThanOrEqual(255);
    expect(clamped.startsWith('100 Main St, Suite ')).toBe(true);
    // An EMBEDDED unit on an over-long street is the protected tail too.
    const embedded = composeLeadAddress(`${longStreet} Apt 4`, 'Apt 4');
    expect(embedded.length).toBeLessThanOrEqual(255);
    expect(embedded.endsWith(', Apt 4')).toBe(true);
  });
});


describe('leadAddressCompareKey', () => {
  test('equivalent unit notations key the same', () => {
    const k = leadAddressCompareKey('100 Main St, Apt 4');
    expect(k).toBe('100 main st|4');
    expect(leadAddressCompareKey('100 Main St #4')).toBe(k);
    expect(leadAddressCompareKey('100 Main St, Unit 4')).toBe(k);
    expect(leadAddressCompareKey('100 Main Street Apt #4')).toBe(k);
  });

  test('fan-out city/state tail does not change the key', () => {
    expect(leadAddressCompareKey('100 Main St, Apt 4, Sarasota, FL 34236')).toBe('100 main st|4');
  });

  test('different door or different street keys differently', () => {
    expect(leadAddressCompareKey('100 Main St, Apt 5')).not.toBe(leadAddressCompareKey('100 Main St, Apt 4'));
    expect(leadAddressCompareKey('100 Main St, Bldg 2 Apt 4')).not.toBe(leadAddressCompareKey('100 Main St, Apt 4'));
    expect(leadAddressCompareKey('101 Main St, Apt 4')).not.toBe(leadAddressCompareKey('100 Main St, Apt 4'));
    expect(leadAddressCompareKey('100 Main St')).not.toBe(leadAddressCompareKey('100 Main St, Apt 4'));
  });

  test('empty for no street', () => {
    expect(leadAddressCompareKey(null)).toBe('');
    expect(leadAddressCompareKey('   ')).toBe('');
  });
});

describe('reaffirmedFilledLeadFields — address', () => {
  test('a restated unit in another notation reaffirms the lead\'s CURRENT value', () => {
    const locked = { address: '100 Main St, Apt 4' };
    expect(reaffirmedFilledLeadFields({ address: '100 Main St, #4' }, locked)).toEqual({ address: '100 Main St, Apt 4' });
    expect(reaffirmedFilledLeadFields({ address: '100 Main St, Unit 4' }, locked)).toEqual({ address: '100 Main St, Apt 4' });
  });

  test('a different unit or street claims nothing', () => {
    const locked = { address: '100 Main St, Apt 4' };
    expect(reaffirmedFilledLeadFields({ address: '100 Main St, Apt 5' }, locked)).toEqual({});
    expect(reaffirmedFilledLeadFields({ address: '100 Main St' }, locked)).toEqual({});
  });

  test('same street+unit in a DIFFERENT place claims no address ownership (place corroboration)', () => {
    const locked = { address: '100 Main St, Apt 4', city: 'Sarasota', zip: '34236' };
    expect(reaffirmedFilledLeadFields({ address: '100 Main St, #4', city: 'Bradenton', zip: '34205' }, locked).address).toBeUndefined();
    // ZIP is the discriminator when both sides have one.
    expect(reaffirmedFilledLeadFields({ address: '100 Main St, #4', city: 'Sarasota', zip: '34211' }, locked).address).toBeUndefined();
    // City-only compare when no ZIP compare is possible.
    expect(reaffirmedFilledLeadFields({ address: '100 Main St, #4', city: 'Bradenton', zip: null }, { address: '100 Main St, Apt 4', city: 'Sarasota', zip: null }).address).toBeUndefined();
    // A call that names no place cannot corroborate a lead that does.
    expect(reaffirmedFilledLeadFields({ address: '100 Main St, #4', city: null, zip: null }, locked).address).toBeUndefined();
    // The fan-out's city/ZIP tail inside the address string counts too.
    expect(reaffirmedFilledLeadFields({ address: '100 Main St, #4', city: 'Sarasota', zip: '34211' }, { address: '100 Main St, Apt 4, Sarasota, FL 34236', city: null, zip: null }).address).toBeUndefined();
  });

  test('same street+unit in the SAME place reaffirms', () => {
    const locked = { address: '100 Main St, Apt 4', city: 'Sarasota', zip: '34236' };
    expect(reaffirmedFilledLeadFields({ address: '100 Main St, #4', city: 'Sarasota', zip: '34236' }, locked).address).toBe('100 Main St, Apt 4');
    expect(reaffirmedFilledLeadFields({ address: '100 Main St, #4', city: 'Sarasota', zip: null }, locked).address).toBe('100 Main St, Apt 4');
    // Postal-city aliases (Lakewood Ranch / Bradenton share a ZIP): ZIP wins.
    expect(reaffirmedFilledLeadFields({ address: '100 Main St, #4', city: 'Lakewood Ranch', zip: '34211' }, { address: '100 Main St, Apt 4', city: 'Bradenton', zip: '34211' }).address).toBe('100 Main St, Apt 4');
    // A place-less lead is corroborated by anything.
    expect(reaffirmedFilledLeadFields({ address: '100 Main St, #4', city: 'Sarasota', zip: '34236' }, { address: '100 Main St, Apt 4' }).address).toBe('100 Main St, Apt 4');
  });

  test('place evidence is read from the supplied composed address when city/zip fields are empty', () => {
    const locked = { address: '100 Main St, Apt 4, Sarasota, FL 34236', city: 'Sarasota', zip: '34236' };
    expect(reaffirmedFilledLeadFields({ address: '100 Main St, Apt 4, Sarasota, FL 34236', city: null, zip: null }, locked).address).toBe(locked.address);
    expect(reaffirmedFilledLeadFields({ address: '100 Main St, Apt 4, Bradenton, FL 34205', city: null, zip: null }, locked).address).toBeUndefined();
    // Explicit fields still win over the tail.
    expect(reaffirmedFilledLeadFields({ address: '100 Main St, Apt 4, Sarasota, FL 34236', city: 'Bradenton', zip: '34205' }, locked).address).toBeUndefined();
  });

  test('a floor unit (Fl 2) is a unit, not a city, for place corroboration', () => {
    expect(leadAddressTailPlace('100 Main St, Fl 2')).toBeNull();
    expect(leadAddressTailPlace('100 Main St, Fl 2, Sarasota, FL 34236')).toEqual({ zip: '34236', city: expect.stringMatching(/Sarasota/) });
    expect(leadAddressTailPlace('100 Main St')).toBeNull();
    const locked = { address: '100 Main St, Fl 2', city: 'Sarasota', zip: '34236' };
    expect(reaffirmedFilledLeadFields({ address: '100 Main St, Fl 2', city: 'Sarasota', zip: '34236' }, locked).address).toBe('100 Main St, Fl 2');
    expect(reaffirmedFilledLeadFields({ address: '100 Main St, Floor 2', city: 'Sarasota', zip: '34236' }, locked).address).toBe('100 Main St, Fl 2');
    expect(reaffirmedFilledLeadFields({ address: '100 Main St, Fl 2', city: 'Bradenton', zip: '34205' }, locked).address).toBeUndefined();
  });

  test('exact case-insensitive match still reaffirms', () => {
    expect(reaffirmedFilledLeadFields({ address: '100 main st, apt 4' }, { address: '100 Main St, Apt 4' })).toEqual({ address: '100 Main St, Apt 4' });
    expect(reaffirmedFilledLeadFields({ address: '100 main st, apt 4', city: 'Sarasota', zip: '34236' }, { address: '100 Main St, Apt 4', city: 'Sarasota', zip: '34236' }).address).toBe('100 Main St, Apt 4');
  });

  test('an EXACT string in a different place claims nothing either', () => {
    const locked = { address: '100 Main St, Apt 4', city: 'Sarasota', zip: '34236' };
    expect(reaffirmedFilledLeadFields({ address: '100 Main St, Apt 4', city: 'Bradenton', zip: '34205' }, locked).address).toBeUndefined();
    expect(reaffirmedFilledLeadFields({ address: '100 Main St, Apt 4', city: 'Sarasota', zip: '34211' }, locked).address).toBeUndefined();
    expect(reaffirmedFilledLeadFields({ address: '100 Main St, Apt 4', city: null, zip: null }, locked).address).toBeUndefined();
    // Non-address fields keep the plain literal compare.
    expect(reaffirmedFilledLeadFields({ email: 'A@B.com', city: 'Bradenton' }, { email: 'a@b.com', city: 'Sarasota' })).toEqual({ email: 'a@b.com' });
  });
});
