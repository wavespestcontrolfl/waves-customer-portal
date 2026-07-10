/**
 * Signed slot offers + shared confirmation-code generator
 * (utils/slot-offer-token.js — booking-audit round 2).
 *
 * Pin: a freshly signed offer verifies; ANY field change (surface, scope,
 * date, start, technician, duration, exp) breaks the HMAC; expired and
 * far-future-forged expiries are rejected; the two carrier shapes (slotId
 * suffix for the estimate surface, standalone field for /book) round-trip;
 * the calendar round-trip rejects impossible YYYY-MM-DD strings; and the
 * confirmation-code generator keeps its ≈50-bit CSPRNG contract.
 */
const {
  SLOT_OFFER_TTL_MS,
  signSlotOffer,
  verifySlotOffer,
  appendOfferToSlotId,
  splitSignedSlotId,
  mintSlotOfferField,
  verifySlotOfferField,
  isRealCalendarDate,
  generateConfirmationCode,
} = require('../utils/slot-offer-token');

const OFFER = {
  surface: 'estimate',
  scopeId: 'estimate-123',
  date: '2027-05-20',
  startMinutes: 540,
  technicianId: 'tech-1',
  durationMinutes: 90,
};

describe('signSlotOffer / verifySlotOffer', () => {
  test('a freshly signed offer verifies', () => {
    const { exp, sig } = signSlotOffer(OFFER);
    expect(verifySlotOffer({ ...OFFER, exp }, sig)).toBe(true);
  });

  test('an unassigned (null technician) offer signs and verifies like any other', () => {
    const offer = { ...OFFER, technicianId: null };
    const { exp, sig } = signSlotOffer(offer);
    expect(verifySlotOffer({ ...offer, exp }, sig)).toBe(true);
    // …and does not verify as some tech's offer.
    expect(verifySlotOffer({ ...offer, technicianId: 'tech-1', exp }, sig)).toBe(false);
  });

  test('EVERY signed field is binding — changing any one breaks the HMAC', () => {
    const { exp, sig } = signSlotOffer(OFFER);
    const variants = [
      { surface: 'booking' }, // wrong surface
      { scopeId: 'estimate-999' }, // wrong scope
      { date: '2027-05-21' },
      { startMinutes: 600 },
      { technicianId: 'tech-2' },
      { durationMinutes: 60 },
      { exp: exp + 1 }, // expiry is inside the signed string
    ];
    for (const change of variants) {
      expect(verifySlotOffer({ ...OFFER, exp, ...change }, sig)).toBe(false);
    }
  });

  test('rejects tampered / missing signatures', () => {
    const { exp, sig } = signSlotOffer(OFFER);
    const flipped = sig.slice(0, -1) + (sig.slice(-1) === 'A' ? 'B' : 'A');
    expect(verifySlotOffer({ ...OFFER, exp }, flipped)).toBe(false);
    for (const bad of [undefined, null, '', 'nope', 42]) {
      expect(verifySlotOffer({ ...OFFER, exp }, bad)).toBe(false);
    }
  });

  test('rejects an expired offer and a forged far-future expiry', () => {
    const past = Date.now() - SLOT_OFFER_TTL_MS - 1000;
    const { exp: expiredExp, sig: expiredSig } = signSlotOffer(OFFER, past);
    expect(verifySlotOffer({ ...OFFER, exp: expiredExp }, expiredSig)).toBe(false);

    // Even a correctly SIGNED offer minted "in the future" is refused —
    // exp may never exceed now + TTL (+ small skew).
    const future = Date.now() + 365 * 24 * 3600 * 1000;
    const { exp: farExp, sig: farSig } = signSlotOffer(OFFER, future);
    expect(verifySlotOffer({ ...OFFER, exp: farExp }, farSig)).toBe(false);
  });
});

describe('estimate-surface carrier — sig+exp inside the slotId', () => {
  test('append + split round-trip; unsigned ids split to null', () => {
    const { exp, sig } = signSlotOffer(OFFER);
    const slotId = appendOfferToSlotId('2027-05-20_09-00_tech-1', { exp, sig });
    expect(splitSignedSlotId(slotId)).toEqual({
      baseSlotId: '2027-05-20_09-00_tech-1',
      exp,
      sig,
    });
    expect(splitSignedSlotId('2027-05-20_09-00_tech-1')).toBeNull();
    expect(splitSignedSlotId(null)).toBeNull();
  });
});

describe('/book-surface carrier — standalone `exp.sig` field', () => {
  const BOOKING = {
    surface: 'booking',
    scopeId: '',
    date: '2027-05-20',
    startMinutes: 540,
    technicianId: 'tech-1',
    durationMinutes: 60,
  };

  test('mint + verify round-trip', () => {
    const field = mintSlotOfferField(BOOKING);
    expect(verifySlotOfferField(BOOKING, field)).toBe(true);
  });

  test('rejects malformed fields and cross-surface replay', () => {
    for (const bad of [undefined, null, '', 'nodot', '123.', 42]) {
      expect(verifySlotOfferField(BOOKING, bad)).toBe(false);
    }
    // An ESTIMATE offer for the same tuple must not confirm a /book slot.
    const { exp, sig } = signSlotOffer({ ...BOOKING, surface: 'estimate', scopeId: 'est-1' });
    expect(verifySlotOfferField(BOOKING, `${exp}.${sig}`)).toBe(false);
  });
});

describe('isRealCalendarDate — round-trip calendar validation', () => {
  test('accepts real days, rejects impossible ones the regexes admit', () => {
    expect(isRealCalendarDate('2026-09-30')).toBe(true);
    expect(isRealCalendarDate('2028-02-29')).toBe(true); // leap year
    expect(isRealCalendarDate('2026-09-31')).toBe(false);
    expect(isRealCalendarDate('2026-02-30')).toBe(false);
    expect(isRealCalendarDate('2027-02-29')).toBe(false); // not a leap year
    expect(isRealCalendarDate('2026-13-01')).toBe(false);
    expect(isRealCalendarDate('2026-00-10')).toBe(false);
    expect(isRealCalendarDate('not-a-date')).toBe(false);
    expect(isRealCalendarDate('')).toBe(false);
    expect(isRealCalendarDate(null)).toBe(false);
  });
});

describe('generateConfirmationCode (shared CSPRNG)', () => {
  test('WPC- + 10 chars from the 32-symbol alphabet, effectively unique', () => {
    const seen = new Set();
    for (let i = 0; i < 200; i += 1) {
      const code = generateConfirmationCode();
      expect(code).toMatch(/^WPC-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{10}$/);
      seen.add(code);
    }
    expect(seen.size).toBe(200);
  });
});
