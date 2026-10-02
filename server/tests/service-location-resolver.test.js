/**
 * Customer location line (config/locations.js resolveServiceLocation, used by
 * services/twilio.js deriveOutboundNumber under GATE_SMS_LINE_ADDRESS_FALLBACK).
 *
 * The contract: a customer whose city maps today keeps the exact line
 * resolveLocation(city) gives them — no one changes lines mid-conversation.
 * Only a blank/unmapped city falls through ZIP → geocode → default.
 */
jest.mock('twilio', () => jest.fn(() => ({ messages: { create: jest.fn() } })));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const {
  CITY_TO_LOCATION,
  resolveLocation,
  resolveServiceLocation,
} = require('../config/locations');

// Near the Venice office — nearest-office math picks venice.
const NEAR_VENICE = { latitude: 27.09, longitude: -82.41 };

describe('resolveServiceLocation', () => {
  test('every mapped city resolves exactly like resolveLocation, whatever the ZIP/geocode say', () => {
    for (const city of Object.keys(CITY_TO_LOCATION)) {
      expect(resolveServiceLocation({ city, zip: '34286', ...NEAR_VENICE }).id)
        .toBe(resolveLocation(city).id);
    }
  });

  test('does not inherit the review-routing overrides', () => {
    // Review routing sends Longboat Key to bradenton and lets ZIP 34243
    // outrank a "Sarasota" city; the location line must not move either.
    expect(resolveServiceLocation({ city: 'Longboat Key' }).id).toBe('sarasota');
    expect(resolveServiceLocation({ city: 'Sarasota', zip: '34243' }).id).toBe('sarasota');
  });

  test('blank city falls through to the ZIP', () => {
    expect(resolveServiceLocation({ city: '', zip: '34286' }).id).toBe('venice');
    expect(resolveServiceLocation({ zip: '34221-1234' }).id).toBe('parrish');
    expect(resolveServiceLocation({ zip: 'FL 34219' }).id).toBe('parrish');
  });

  test('unmapped city falls through to the ZIP, then the geocode', () => {
    expect(resolveServiceLocation({ city: 'Somewhere Else', zip: '34286' }).id).toBe('venice');
    expect(resolveServiceLocation({ city: 'Somewhere Else', ...NEAR_VENICE }).id).toBe('venice');
    expect(resolveServiceLocation({ city: 'Somewhere Else', latitude: '27.09', longitude: '-82.41' }).id)
      .toBe('venice');
  });

  test('no usable address resolves to the default office, never the office nearest (0,0)', () => {
    expect(resolveServiceLocation({}).id).toBe('bradenton');
    expect(resolveServiceLocation({ latitude: null, longitude: null }).id).toBe('bradenton');
    expect(resolveServiceLocation({ latitude: '', longitude: '' }).id).toBe('bradenton');
    expect(resolveServiceLocation({ zip: '99999' }).id).toBe('bradenton');
    // Sentinel / out-of-range / far-away geocodes are not usable.
    expect(resolveServiceLocation({ latitude: 0, longitude: 0 }).id).toBe('bradenton');
    expect(resolveServiceLocation({ latitude: 999, longitude: 999 }).id).toBe('bradenton');
    // Wrapped angles: haversine would put these ~0 mi from an office.
    expect(resolveServiceLocation({ latitude: 27.09, longitude: -82.41 + 360 }).id).toBe('bradenton');
    expect(resolveServiceLocation({ latitude: 27.09 + 360, longitude: -82.41 }).id).toBe('bradenton');
    expect(resolveServiceLocation({ city: 'Miami', latitude: 25.76, longitude: -80.19 }).id).toBe('bradenton');
  });
});

describe('deriveOutboundNumber + GATE_SMS_LINE_ADDRESS_FALLBACK', () => {
  const ORIGINAL = process.env.GATE_SMS_LINE_ADDRESS_FALLBACK;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.GATE_SMS_LINE_ADDRESS_FALLBACK;
    else process.env.GATE_SMS_LINE_ADDRESS_FALLBACK = ORIGINAL;
  });

  const TwilioService = require('../services/twilio');
  const TWILIO_NUMBERS = require('../config/twilio-numbers');
  const unmapped = { id: 'c1', city: '', zip: '34286', ...NEAR_VENICE };
  const mapped = { id: 'c2', city: 'Palmetto', zip: '34286', ...NEAR_VENICE };

  test('gate off: blank city keeps the Bradenton default (today\'s behavior)', async () => {
    delete process.env.GATE_SMS_LINE_ADDRESS_FALLBACK;
    expect(await TwilioService.deriveOutboundNumber({ customer: unmapped }))
      .toBe(TWILIO_NUMBERS.getOutboundNumber('bradenton'));
  });

  test('gate on: blank city resolves by ZIP to the Venice line', async () => {
    process.env.GATE_SMS_LINE_ADDRESS_FALLBACK = 'true';
    expect(await TwilioService.deriveOutboundNumber({ customer: unmapped }))
      .toBe(TWILIO_NUMBERS.getOutboundNumber('venice'));
  });

  test('a mapped city gets the same line with the gate on or off', async () => {
    delete process.env.GATE_SMS_LINE_ADDRESS_FALLBACK;
    const off = await TwilioService.deriveOutboundNumber({ customer: mapped });
    process.env.GATE_SMS_LINE_ADDRESS_FALLBACK = 'true';
    const on = await TwilioService.deriveOutboundNumber({ customer: mapped });
    expect(on).toBe(off);
    expect(on).toBe(TWILIO_NUMBERS.getOutboundNumber('parrish'));
  });

  test('an explicit customerLocationId still wins', async () => {
    process.env.GATE_SMS_LINE_ADDRESS_FALLBACK = 'true';
    expect(await TwilioService.deriveOutboundNumber({ customerLocationId: 'sarasota', customer: unmapped }))
      .toBe(TWILIO_NUMBERS.getOutboundNumber('sarasota'));
  });
});

describe('home line (GATE_HOME_LINE)', () => {
  const ORIGINAL = process.env.GATE_HOME_LINE;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.GATE_HOME_LINE;
    else process.env.GATE_HOME_LINE = ORIGINAL;
  });

  const { homeLineLocationId } = require('../config/locations');
  const { addressKey } = require('../services/customer-property-address-keys');
  const TwilioService = require('../services/twilio');
  const TWILIO_NUMBERS = require('../config/twilio-numbers');
  const address = { address_line1: '100 Main St', city: 'Palmetto', zip: '34221' };
  // Stamped Venice for this exact address (e.g. under an older city map).
  const stamped = { id: 'c3', ...address, home_line_location_id: 'venice', home_line_address_key: addressKey(address) };

  test('a stamp for the current address wins over what the address resolves to today', () => {
    expect(resolveServiceLocation(stamped).id).toBe('parrish');
    expect(homeLineLocationId(stamped)).toBe('venice');
  });

  test('a stamp for an older address is ignored: the new address decides', () => {
    expect(homeLineLocationId({ ...stamped, address_line1: '9 Other Rd' })).toBe('parrish');
  });

  test('no stamp, an unknown office id, or a missing key falls back to the address', () => {
    expect(homeLineLocationId(address)).toBe('parrish');
    expect(homeLineLocationId({ ...stamped, home_line_location_id: 'tampa' })).toBe('parrish');
    expect(homeLineLocationId({ ...stamped, home_line_address_key: null })).toBe('parrish');
  });

  test('gate on: a known customer gets the home line even when a caller passes an office', async () => {
    process.env.GATE_HOME_LINE = 'true';
    expect(await TwilioService.deriveOutboundNumber({ customerLocationId: 'sarasota', customer: stamped }))
      .toBe(TWILIO_NUMBERS.getOutboundNumber('venice'));
  });

  test('gate on: with no customer, the passed office still decides (leads)', async () => {
    process.env.GATE_HOME_LINE = 'true';
    expect(await TwilioService.deriveOutboundNumber({ customerLocationId: 'sarasota' }))
      .toBe(TWILIO_NUMBERS.getOutboundNumber('sarasota'));
  });

  test('gate off: byte-identical to before (passed office wins, stamp ignored)', async () => {
    delete process.env.GATE_HOME_LINE;
    expect(await TwilioService.deriveOutboundNumber({ customerLocationId: 'sarasota', customer: stamped }))
      .toBe(TWILIO_NUMBERS.getOutboundNumber('sarasota'));
    expect(await TwilioService.deriveOutboundNumber({ customer: stamped }))
      .toBe(TWILIO_NUMBERS.getOutboundNumber('parrish'));
  });
});

describe('homeLineOfficeId / matchServiceLocation (no default office)', () => {
  const { homeLineOfficeId, homeLineLocationId, matchServiceLocation } = require('../config/locations');
  const { addressKey } = require('../services/customer-property-address-keys');

  test('null when no city, ZIP or nearby geocode names an office', () => {
    expect(matchServiceLocation({})).toBeNull();
    expect(matchServiceLocation({ city: 'Orlando', zip: '32801' })).toBeNull();
    expect(matchServiceLocation({ latitude: 0, longitude: 0 })).toBeNull();
    expect(homeLineOfficeId({ city: '' })).toBeNull();
  });

  test('resolveServiceLocation and homeLineLocationId keep the default-office fallback', () => {
    expect(resolveServiceLocation({}).id).toBe('bradenton');
    expect(homeLineLocationId({})).toBe('bradenton');
  });

  test('a matched office or a current stamp is returned as-is', () => {
    expect(matchServiceLocation({ zip: '34219' }).id).toBe('parrish');
    expect(matchServiceLocation(NEAR_VENICE).id).toBe('venice');
    const address = { address_line1: '1 A St', city: '' };
    expect(homeLineOfficeId({ ...address, home_line_location_id: 'sarasota', home_line_address_key: addressKey(address) })).toBe('sarasota');
  });
});
