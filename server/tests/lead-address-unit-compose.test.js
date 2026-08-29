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
    expect(composeLeadAddress('100 Main St Apt 4', 'Apt 5')).toBe('100 Main St, Apt 4');
    expect(analyzeLeadAddress('100 Main St Apt 4', 'Apt 5')).toEqual({ address: '100 Main St, Apt 4', unitConflict: true });
    expect(analyzeLeadAddress('100 Main St Apt 4, Sarasota, FL 34236', 'Apt 5')).toEqual({ address: '100 Main St, Apt 4, Sarasota, FL 34236', unitConflict: true });
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
    // A numbered route's hash is the road, not a unit — no false conflict, the real unit is appended (r7 P2).
    expect(analyzeLeadAddress('123 State Road #64 Bradenton FL 34208', 'Apt 4')).toEqual({ address: '123 State Road #64 Bradenton FL 34208, Apt 4', unitConflict: false });
    expect(analyzeLeadAddress('500 Hwy #41 Venice FL 34285', 'Unit 2')).toEqual({ address: '500 Hwy #41 Venice FL 34285, Unit 2', unitConflict: false });
    expect(analyzeLeadAddress('100 Main Rd #4 Sarasota FL 34236', 'Apt 5').unitConflict).toBe(true);
    // Bldg 2 Apt 4 is a different door than Apt 4 — never collapsed into one, never stored as two.
    expect(analyzeLeadAddress('100 Main St Bldg 2 Apt 4', 'Apt 4')).toEqual({ address: '100 Main St, Bldg 2 Apt 4', unitConflict: true });
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

  test('comma-free FULL address: kept whole as the street, unit appended — never locality-split', () => {
    // Directional-vs-city is not lexically decidable ("St North, Sarasota"
    // vs "St North Port"), so this rare shape is stored whole rather than
    // risk a wrong street or place. Inline-unit dedupe / conflict detection
    // is deliberately out of scope for it.
    // …but a unit it already names is never appended twice, and a DIFFERENT
    // dedicated unit is a conflict held for read-back, never a second door.
    expect(composeLeadAddress('100 Main St Apt 4 Sarasota FL 34236', 'Apt 4')).toBe('100 Main St Apt 4 Sarasota FL 34236');
    expect(composeLeadAddress('100 Main St Apt 4 Sarasota FL 34236', '#4')).toBe('100 Main St Apt 4 Sarasota FL 34236');
    expect(composeLeadAddress('100 Main St Sarasota FL 34236', 'Apt 4')).toBe('100 Main St Sarasota FL 34236, Apt 4');
    expect(analyzeLeadAddress('100 Main St Apt 4 Sarasota FL 34236', 'Apt 5')).toEqual({ address: '100 Main St Apt 4 Sarasota FL 34236', unitConflict: true });
    expect(analyzeLeadAddress('100 Main St Bldg 2 Apt 4 Sarasota FL 34236', 'Apt 4').unitConflict).toBe(true);
    // Street words after a designator-shaped token are not units.
    expect(analyzeLeadAddress('4501 Space Coast Blvd', 'Apt 4')).toEqual({ address: '4501 Space Coast Blvd, Apt 4', unitConflict: false });
    expect(leadAddressCompareKey('4501 Spc Coast Blvd')).toBe('4501 spc coast blvd');
    expect(leadAddressCompareKey('4501 Spc Coast Blvd')).not.toBe(leadAddressCompareKey('4501 Space Coast Blvd'));
    expect(leadAddressCompareKey('100 Apartment Road')).not.toBe(leadAddressCompareKey('100 Unit Road'));
    expect(leadAddressCompareKey('4501 Space Coast Blvd')).toBe('4501 space coast blvd');
    expect(composeLeadAddress('100 Main St Apt 4 Sarasota FL 34236', null)).toBe('100 Main St Apt 4 Sarasota FL 34236');
    expect(composeLeadAddress('100 Main St North Port FL 34287', 'Apt 4')).toBe('100 Main St North Port FL 34287, Apt 4');
    expect(composeLeadAddress('100 Main St W Palm Beach FL 33401', 'Apt 4')).toBe('100 Main St W Palm Beach FL 33401, Apt 4');
    expect(composeLeadAddress('123 State Road 64 Bradenton FL 34208', 'Apt 4')).toBe('123 State Road 64 Bradenton FL 34208, Apt 4');
    // A comma-free line whose unit is the trailing pair IS understood.
    expect(composeLeadAddress('100 Main St Apt 4', 'Apt 4')).toBe('100 Main St, Apt 4');
    expect(composeLeadAddress('100 Main St N Apt 4', '#4')).toBe('100 Main St N, Apt 4');
    expect(composeLeadAddress('4501 Space Coast Blvd', 'Apt 4')).toBe('4501 Space Coast Blvd, Apt 4');
  });

  test('a trailing directional stays on the street and is never read as a city', () => {
    expect(composeLeadAddress('100 Main St N', 'Apt 4')).toBe('100 Main St N, Apt 4');
    expect(composeLeadAddress('100 Main St North', 'Apt 4')).toBe('100 Main St North, Apt 4');
    expect(composeLeadAddress('100 Main St N', null)).toBe('100 Main St N');
    expect(leadAddressTailPlace('100 Main St N')).toBeNull();
    expect(leadAddressTailPlace('100 Main St North')).toBeNull();
    expect(leadAddressCompareKey('100 Main St N')).not.toBe(leadAddressCompareKey('100 Main St'));
    const locked = { address: '100 Main St North, Apt 4', city: 'Sarasota', zip: '34236' };
    expect(reaffirmedFilledLeadFields({ address: '100 Main St North, Apt 4', city: 'Sarasota', zip: '34236' }, locked).address).toBe('100 Main St North, Apt 4');
    expect(reaffirmedFilledLeadFields({ address: composeLeadAddress('100 Main St North', '#4'), city: 'Sarasota', zip: '34236' }, locked).address).toBe('100 Main St North, Apt 4');
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

  test('a LEGACY comma-separated full address keys and places the same as its composed restatement', () => {
    const legacy = '100 Main St Apt 4, Sarasota, FL 34236';
    const composed = composeLeadAddress(legacy, 'Apt 4');
    expect(composed).toBe('100 Main St, Apt 4, Sarasota, FL 34236');
    expect(leadAddressCompareKey(legacy)).toBe(leadAddressCompareKey(composed));
    expect(leadAddressCompareKey(legacy)).toBe('100 main st|4');
    expect(leadAddressTailPlace(legacy)).toEqual({ zip: '34236', city: expect.stringMatching(/Sarasota/) });
    const locked = { address: legacy, city: null, zip: null };
    expect(reaffirmedFilledLeadFields({ address: composed, city: null, zip: null }, locked).address).toBe(legacy);
    expect(reaffirmedFilledLeadFields({ address: composeLeadAddress('100 Main St Apt 4, Bradenton, FL 34205', 'Apt 4'), city: null, zip: null }, locked).address).toBeUndefined();
    // A comma-free legacy value is stored whole and restates as itself…
    const commaFree = '100 Main St Apt 4 Sarasota FL 34236';
    expect(reaffirmedFilledLeadFields({ address: commaFree, city: null, zip: null }, { address: commaFree, city: null, zip: null }).address).toBe(commaFree);
    // …and its composed restatement (same line + dedicated "Apt 4") keys the
    // same: the street already embeds that door, so the appended unit adds
    // no identity. A DIFFERENT dedicated unit still keys differently.
    const restated = composeLeadAddress(commaFree, 'Apt 4');
    expect(restated).toBe('100 Main St Apt 4 Sarasota FL 34236');
    expect(leadAddressCompareKey(restated)).toBe(leadAddressCompareKey(commaFree));
    expect(leadAddressCompareKey(composeLeadAddress(commaFree, '#4'))).toBe(leadAddressCompareKey(commaFree));
    // A conflicting dedicated unit is dropped and flagged, never a second door.
    expect(analyzeLeadAddress(commaFree, 'Apt 5')).toEqual({ address: commaFree, unitConflict: true });
    expect(leadAddressCompareKey('100 Main St Apt 5 Sarasota FL 34236')).not.toBe(leadAddressCompareKey(commaFree));
    const lockedCF = { address: commaFree, city: 'Sarasota', zip: '34236' };
    expect(reaffirmedFilledLeadFields({ address: restated, city: 'Sarasota', zip: '34236' }, lockedCF).address).toBe(commaFree);
    expect(reaffirmedFilledLeadFields({ address: '100 Main St Apt 5 Sarasota FL 34236', city: 'Sarasota', zip: '34236' }, lockedCF).address).toBeUndefined();
    expect(reaffirmedFilledLeadFields({ address: restated, city: 'Bradenton', zip: '34205' }, lockedCF).address).toBeUndefined();
    // Every inline spelling the shared parser supports, incl. multipart.
    for (const [line, unit] of [
      ['100 Main St #4 Sarasota FL 34236', '#4'],
      ['100 Main St # 4 Sarasota FL 34236', 'Apt 4'],
      ['100 Main St Apt #4 Sarasota FL 34236', 'Unit 4'],
      ['100 Main St Bldg 2 Apt 4 Sarasota FL 34236', 'Bldg 2 Apt 4'],
      ['100 Main St Suite 200-A Sarasota FL 34236', 'Ste 200-A'],
      ['100 Main St Apt # 4 Sarasota FL 34236', 'Unit 4'],
    ]) {
      expect(leadAddressCompareKey(composeLeadAddress(line, unit))).toBe(leadAddressCompareKey(line));
    }
    // Equivalent unit spellings INSIDE the whole-line street key the same.
    const spellings = ['100 Main St Apt 4 Sarasota FL 34236', '100 Main St #4 Sarasota FL 34236', '100 Main St Unit 4 Sarasota FL 34236', '100 Main St Apt # 4 Sarasota FL 34236', '100 Main St # 4 Sarasota FL 34236'];
    for (const v of spellings) expect(leadAddressCompareKey(v)).toBe(leadAddressCompareKey(spellings[0]));
    expect(leadAddressCompareKey(spellings[0])).toBe('100 main st {u:4} sarasota fl 34236');
    expect(leadAddressCompareKey(composeLeadAddress('100 Main St #4 Sarasota FL 34236', '#4'))).toBe(leadAddressCompareKey(spellings[0]));
    expect(leadAddressCompareKey('100 Main St Apt 5 Sarasota FL 34236')).not.toBe(leadAddressCompareKey(spellings[0]));
    expect(leadAddressCompareKey('100 Main St Bldg 2 Apt 4 Sarasota FL 34236')).toBe('100 main st {u:bldg 2 unit 4} sarasota fl 34236');
    const lockedAlias = { address: '100 Main St Apt 4 Sarasota FL 34236', city: 'Sarasota', zip: '34236' };
    expect(reaffirmedFilledLeadFields({ address: composeLeadAddress('100 Main St #4 Sarasota FL 34236', '#4'), city: 'Sarasota', zip: '34236' }, lockedAlias).address).toBe(lockedAlias.address);
    // "Apt 4" against a "Bldg 2 Apt 4" line is a different door → conflict, never appended.
    expect(analyzeLeadAddress('100 Main St Bldg 2 Apt 4 Sarasota FL 34236', 'Apt 4')).toEqual({ address: '100 Main St Bldg 2 Apt 4 Sarasota FL 34236', unitConflict: true });
  });

  test('comma-free and comma-separated shapes of the same door key DIFFERENTLY (ratified scope-out) — no cross-shape ownership, no wrong-city claim', () => {
    const whole = '100 Main St Apt 4 Sarasota FL 34236';
    const comma = '100 Main St, Apt 4, Sarasota, FL 34236';
    expect(leadAddressCompareKey(whole)).not.toBe(leadAddressCompareKey(comma));
    // Neither shape records ownership over the other (exact key only — the comma-free legacy shape has no
    // delimiter that makes "same door" lexically decidable; see the note above leadAddressCompareKey).
    expect(reaffirmedFilledLeadFields({ address: comma, city: 'Sarasota', zip: '34236' }, { address: whole, city: 'Sarasota', zip: '34236' }).address).toBeUndefined();
    expect(reaffirmedFilledLeadFields({ address: whole, city: 'Sarasota', zip: '34236' }, { address: comma, city: null, zip: null }).address).toBeUndefined();
    // The SAME shape restated still reaffirms, in every spelling the canonical key equates.
    expect(reaffirmedFilledLeadFields({ address: whole, city: 'Sarasota', zip: '34236' }, { address: whole, city: 'Sarasota', zip: '34236' }).address).toBe(whole);
    expect(leadAddressCompareKey('100 Main Street N Apt 4 Sarasota FL 34236')).toBe(leadAddressCompareKey('100 Main St N #4 Sarasota FL 34236'));
    expect(leadAddressCompareKey('100 Main Street North Apt 4 Sarasota FL 34236')).toBe(leadAddressCompareKey('100 Main St North Unit 4 Sarasota FL 34236'));
    expect(leadAddressCompareKey('100 Main St #A Sarasota FL 34236')).toBe(leadAddressCompareKey('100 Main St Unit A Sarasota FL 34236'));
    expect(leadAddressCompareKey('100 Main St Apt 4 Sarasota FL 34236')).not.toBe(leadAddressCompareKey('100 Main St Apt 5 Sarasota FL 34236'));
    expect(composeLeadAddress('100 Main St #A Sarasota FL 34236', '#A')).toBe('100 Main St #A Sarasota FL 34236');
    // A comma-free WHOLE line with EMPTY city/zip columns still carries its place after the
    // inline unit — a restatement from another city must not take ownership.
    expect(leadAddressTailPlace('100 Main St Apt 4 Bradenton FL 34205')).toEqual({ zip: '34205', city: expect.stringMatching(/bradenton/i) });
    expect(leadAddressTailPlace('100 Main St Apt 4 Bradenton')).toEqual({ zip: null, city: expect.stringMatching(/bradenton/i) });
    expect(leadAddressTailPlace('100 Main St Apt 4')).toBeNull();
    expect(leadAddressTailPlace('100 Main St North Port FL 34287')).toBeNull();
    // The locality is read from the RAW line — a terminal city word that is also a street suffix is not abbreviated (r7).
    expect(leadAddressTailPlace('100 Main St Apt 4 Palm Harbor')).toEqual({ zip: null, city: expect.stringMatching(/palm harbor/i) });
    const lockedWholeNoCols = { address: '100 Main St Apt 4 Bradenton FL 34205', city: null, zip: null };
    expect(reaffirmedFilledLeadFields({ address: lockedWholeNoCols.address, city: 'Sarasota', zip: '34236' }, lockedWholeNoCols).address).toBeUndefined();
    expect(reaffirmedFilledLeadFields({ address: lockedWholeNoCols.address, city: 'Bradenton', zip: '34205' }, lockedWholeNoCols).address).toBe(lockedWholeNoCols.address);
    const lockedPalm = { address: '100 Main St Apt 4 Palm Harbor', city: null, zip: null };
    expect(reaffirmedFilledLeadFields({ address: lockedPalm.address, city: 'Sarasota', zip: null }, lockedPalm).address).toBeUndefined();
    expect(reaffirmedFilledLeadFields({ address: lockedPalm.address, city: 'Palm Harbor', zip: null }, lockedPalm).address).toBe(lockedPalm.address);
  });

  test('an overlong whole line that already names the door is bounded with the unit and place protected', () => {
    const longStreet = `100 ${'Verylongstreetname '.repeat(15)}Blvd`;
    const whole = `${longStreet} Apt 4 Sarasota FL 34236`;
    expect(whole.length).toBeGreaterThan(255);
    for (const line2 of ['Apt 4', 'Apt 5']) {
      const { address, unitConflict } = analyzeLeadAddress(whole, line2);
      expect(unitConflict).toBe(line2 === 'Apt 5');
      expect(address.length).toBeLessThanOrEqual(255);
      expect(address).toMatch(/, Apt 4, Sarasota FL 34236$/);
      expect(address.startsWith('100 Verylongstreetname')).toBe(true);
      expect(address).not.toMatch(/Apt 5/);
    }
    // Fits → kept verbatim (no reshaping of a comma-free legacy value that is within the bound).
    expect(analyzeLeadAddress('100 Main St Apt 4 Sarasota FL 34236', 'Apt 4').address).toBe('100 Main St Apt 4 Sarasota FL 34236');
  });

  test('stored place evidence is read from the UNBOUNDED tail (the clamp is write-time only)', () => {
    const longTail = `${'Somewhereville '.repeat(8)}Sarasota, FL 34236`;
    const legacy = `100 Main St, Apt 4, ${longTail}`;
    expect(leadAddressTailPlace(legacy)).toEqual({ zip: '34236', city: expect.any(String) });
    const locked = { address: legacy, city: null, zip: null };
    expect(reaffirmedFilledLeadFields({ address: '100 Main St, Apt 4', city: 'Sarasota', zip: '34236' }, locked).address).toBe(legacy);
    expect(reaffirmedFilledLeadFields({ address: '100 Main St, Apt 4', city: 'Bradenton', zip: '34205' }, locked).address).toBeUndefined();
  });

  test('conflict branch keeps the retained inline unit through the bound', () => {
    const longStreet = `100 ${'Verylongstreetname '.repeat(20)}Blvd`;
    const out = analyzeLeadAddress(`${longStreet} Apt 4`, 'Apt 5');
    expect(out.unitConflict).toBe(true);
    expect(out.address.length).toBeLessThanOrEqual(255);
    expect(out.address.endsWith(', Apt 4')).toBe(true);
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
