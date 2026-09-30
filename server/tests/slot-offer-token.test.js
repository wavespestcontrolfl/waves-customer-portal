/**
 * Signed slot offers + shared confirmation-code generator
 * (utils/slot-offer-token.js — booking-audit round 2).
 *
 * Pin: a freshly signed offer verifies; ANY field change (surface, scope,
 * service, location, date, start, technician, duration, exp) breaks the HMAC;
 * expired and far-future-forged expiries are rejected; the two carrier shapes
 * (slotId suffix for the estimate surface, standalone field for /book) round-trip;
 * the calendar round-trip rejects impossible YYYY-MM-DD strings; and the
 * confirmation-code generator keeps its ≈50-bit CSPRNG contract.
 */
const {
  SLOT_OFFER_TTL_MS,
  CAPACITY_OFFER_POLICY,
  BOOK_INSERTION_OFFER_POLICY,
  BOOK_ARRIVAL_GRACE_OFFER_POLICY,
  bookOfferPolicy,
  splitSlotOfferField,
  slotOfferFieldGrace,
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
  test('the scheduling policy is bound into the signature: a capacity offer never verifies as legacy and vice versa', () => {
    const legacy = signSlotOffer(OFFER);
    const capacity = signSlotOffer({ ...OFFER, policy: CAPACITY_OFFER_POLICY }, legacy.exp - SLOT_OFFER_TTL_MS);
    expect(capacity.exp).toBe(legacy.exp);
    expect(capacity.sig).not.toBe(legacy.sig);
    expect(verifySlotOffer({ ...OFFER, exp: legacy.exp, policy: CAPACITY_OFFER_POLICY }, capacity.sig)).toBe(true);
    expect(verifySlotOffer({ ...OFFER, exp: legacy.exp }, capacity.sig)).toBe(false);
    expect(verifySlotOffer({ ...OFFER, exp: legacy.exp, policy: CAPACITY_OFFER_POLICY }, legacy.sig)).toBe(false);
  });

  test('an omitted or empty policy leaves the legacy canonical string unchanged', () => {
    const now = Date.now();
    const plain = signSlotOffer(OFFER, now);
    expect(signSlotOffer({ ...OFFER, policy: undefined }, now).sig).toBe(plain.sig);
    expect(signSlotOffer({ ...OFFER, policy: '' }, now).sig).toBe(plain.sig);
    expect(signSlotOffer({ ...OFFER, policy: null }, now).sig).toBe(plain.sig);
  });

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
      { serviceKey: 'pest_control' }, // v2: service scope (signed as '')
      { locationKey: '27.34,-82.53' }, // v2: location scope (signed as '')
      { date: '2027-05-21' },
      { startMinutes: 600 },
      { technicianId: 'tech-2' },
      { durationMinutes: 60 },
      { arrivalGrace: 90 }, // v3: self-serve arrival grace (signed as 0)
      { exp: exp + 1 }, // expiry is inside the signed string
    ];
    for (const change of variants) {
      expect(verifySlotOffer({ ...OFFER, exp, ...change }, sig)).toBe(false);
    }
  });

  test('v2 scope fields (serviceKey/locationKey) sign, verify, and bind', () => {
    const scoped = { ...OFFER, serviceKey: 'pest_control', locationKey: '27.34,-82.53' };
    const { exp, sig } = signSlotOffer(scoped);
    expect(verifySlotOffer({ ...scoped, exp }, sig)).toBe(true);
    // Tamper either scope field → HMAC fails.
    expect(verifySlotOffer({ ...scoped, serviceKey: 'termite', exp }, sig)).toBe(false);
    expect(verifySlotOffer({ ...scoped, locationKey: '26.99,-82.10', exp }, sig)).toBe(false);
    // …and dropping them back to the '' defaults fails too (no aliasing).
    expect(verifySlotOffer({ ...OFFER, exp }, sig)).toBe(false);
  });

  test("omitted scope fields default to '' — explicit-empty and absent sign identically (estimate-surface compat)", () => {
    const { exp, sig } = signSlotOffer(OFFER); // no serviceKey/locationKey at all
    expect(verifySlotOffer({ ...OFFER, serviceKey: '', locationKey: '', exp }, sig)).toBe(true);
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

describe('BOOK_INSERTION_OFFER_POLICY — /book mid-route insertion offers (Codex round 2, PR #5231)', () => {
  const BOOKING = {
    surface: 'booking', scopeId: '', serviceKey: 'pest_control', locationKey: '27.34,-82.53',
    date: '2027-05-20', startMinutes: 540, technicianId: 'tech-1', durationMinutes: 60,
  };

  test('a field minted WITH the policy verifies only WITH the same policy', () => {
    const field = mintSlotOfferField({ ...BOOKING, policy: BOOK_INSERTION_OFFER_POLICY });
    expect(verifySlotOfferField({ ...BOOKING, policy: BOOK_INSERTION_OFFER_POLICY }, field)).toBe(true);
    // Minted tagged, verified untagged (the gate flipped off after mint) — mismatch.
    expect(verifySlotOfferField(BOOKING, field)).toBe(false);
  });

  test('a field minted WITHOUT the policy verifies only WITHOUT it', () => {
    const field = mintSlotOfferField(BOOKING);
    expect(verifySlotOfferField(BOOKING, field)).toBe(true);
    // Minted untagged, verified tagged (the gate flipped on after mint) — mismatch.
    expect(verifySlotOfferField({ ...BOOKING, policy: BOOK_INSERTION_OFFER_POLICY }, field)).toBe(false);
  });

  test('distinct from CAPACITY_OFFER_POLICY — one policy tag never redeems for the other', () => {
    const field = mintSlotOfferField({ ...BOOKING, policy: BOOK_INSERTION_OFFER_POLICY });
    expect(verifySlotOfferField({ ...BOOKING, policy: CAPACITY_OFFER_POLICY }, field)).toBe(false);
  });
});

// Frozen reference implementation of origin/main's PRE-arrival-grace v2
// canonical string + carrier shape (Codex round 3 on #5314: the estimate
// surface's v2/v3 split must be genuinely bidirectional with the code that
// shipped before this whole lane, not just internally self-consistent).
// Deliberately NOT imported from the module under test — a real second
// implementation of the exact algorithm origin/main signs with, so a
// regression in the module's own "ungraced = v2" branch shows up as a
// mismatch here instead of both sides drifting together. Mirrors
// slot-offer-token.js's OFFER_KEY derivation exactly (same env, same
// fallback chain) so both sides derive the identical key.
const crypto = require('crypto');
const MAIN_OFFER_KEY = crypto.createHash('sha256')
  .update(`waves:slot-offer:v1:${process.env.JWT_SECRET || process.env.BOOKING_CAPTURE_SECRET || 'waves-booking-capture-dev'}`)
  .digest();
function mainCanonicalOfferStringV2(payload = {}) {
  return [
    'waves-slot-offer.v2',
    String(payload.surface || ''),
    String(payload.scopeId ?? ''),
    String(payload.serviceKey ?? ''),
    String(payload.locationKey ?? ''),
    String(payload.date || ''),
    String(Number(payload.startMinutes)),
    String(payload.technicianId || ''),
    String(Number(payload.durationMinutes)),
    String(Number(payload.exp)),
    ...(payload.policy ? [String(payload.policy)] : []),
  ].join('|');
}
function mainSignSlotOffer(payload, now = Date.now()) {
  const exp = now + SLOT_OFFER_TTL_MS;
  const sig = crypto.createHmac('sha256', MAIN_OFFER_KEY)
    .update(mainCanonicalOfferStringV2({ ...payload, exp }))
    .digest('base64url');
  return { exp, sig };
}
function mainAppendOfferToSlotId(slotId, { exp, sig }) {
  return `${slotId}.${exp}.${sig}`;
}

describe('estimate-surface carrier — sig+exp[+arrivalGrace] inside the slotId (v2/v3 backward compat, Codex round 3 on #5314)', () => {
  test('an UNGRACED offer (no arrivalGrace / 0) mints the EXACT v2 shape — byte-for-byte identical to origin/main\'s minting for the same inputs', () => {
    const now = Date.now();
    const mainOffer = mainSignSlotOffer(OFFER, now);
    const newOffer = signSlotOffer(OFFER, now); // no arrivalGrace at all
    expect(newOffer.exp).toBe(mainOffer.exp);
    expect(newOffer.sig).toBe(mainOffer.sig); // identical HMAC — same canonical string
    const mainSlotId = mainAppendOfferToSlotId('2027-05-20_09-00_tech-1', mainOffer);
    const newSlotId = appendOfferToSlotId('2027-05-20_09-00_tech-1', newOffer);
    expect(newSlotId).toBe(mainSlotId); // identical wire shape too — 2 dots, no grace segment

    const newOfferZero = signSlotOffer({ ...OFFER, arrivalGrace: 0 }, now); // explicit 0, same result
    expect(newOfferZero.sig).toBe(mainOffer.sig);
  });

  test('a v2 token MINTED BY ORIGIN/MAIN\'S CODE verifies under the new code (an in-flight offer straddling this deploy)', () => {
    const now = Date.now();
    const mainOffer = mainSignSlotOffer(OFFER, now);
    const mainSlotId = mainAppendOfferToSlotId('2027-05-20_09-00_tech-1', mainOffer);
    const split = splitSignedSlotId(mainSlotId);
    expect(split).toEqual({
      baseSlotId: '2027-05-20_09-00_tech-1', exp: mainOffer.exp, arrivalGrace: 0, sig: mainOffer.sig,
    });
    expect(verifySlotOffer({ ...OFFER, exp: split.exp, arrivalGrace: split.arrivalGrace }, split.sig)).toBe(true);
  });

  test('a graced offer signs a genuinely different HMAC than an ungraced one for the SAME tuple+exp — arrivalGrace really is bound in, only for v3', () => {
    const now = Date.now();
    const ungraced = signSlotOffer(OFFER, now);
    const graced = signSlotOffer({ ...OFFER, arrivalGrace: 90 }, now);
    expect(graced.exp).toBe(ungraced.exp); // same expiry clock
    expect(graced.sig).not.toBe(ungraced.sig); // different signed string (v3 vs v2)
    // And origin/main's v2-only computation for the same tuple+exp matches
    // the UNGRACED signature, never the graced one — confirming the graced
    // signature is not just "some other v2 string" but the genuine v3 shape.
    expect(mainSignSlotOffer(OFFER, now).sig).toBe(ungraced.sig);
    expect(mainSignSlotOffer(OFFER, now).sig).not.toBe(graced.sig);
  });

  test('append + split round-trip (no arrivalGrace given): the v2 shape, unsigned ids split to null', () => {
    const { exp, sig } = signSlotOffer(OFFER);
    const slotId = appendOfferToSlotId('2027-05-20_09-00_tech-1', { exp, sig });
    expect(splitSignedSlotId(slotId)).toEqual({
      baseSlotId: '2027-05-20_09-00_tech-1',
      exp,
      arrivalGrace: 0,
      sig,
    });
    expect(splitSignedSlotId('2027-05-20_09-00_tech-1')).toBeNull();
    expect(splitSignedSlotId(null)).toBeNull();
  });

  // Self-serve arrival grace (owner ruling 2026-09-28, Codex round 2 on
  // #5314): the grace value rides in CLEARTEXT (round-trips exactly) but is
  // ALSO bound into the HMAC — tampering the cleartext segment alone must
  // fail verification, not just silently change what reserveSlot reads back.
  test('a non-zero arrivalGrace round-trips exactly (v3 shape) and is bound into the signature', () => {
    const offer = signSlotOffer({ ...OFFER, arrivalGrace: 90 });
    const slotId = appendOfferToSlotId('2027-05-20_09-00_tech-1', { ...offer, arrivalGrace: 90 });
    expect((slotId.match(/\./g) || []).length).toBe(3); // base.exp.grace.sig
    const split = splitSignedSlotId(slotId);
    expect(split.arrivalGrace).toBe(90);
    expect(verifySlotOffer({ ...OFFER, exp: split.exp, arrivalGrace: split.arrivalGrace }, split.sig)).toBe(true);
    // A client that edits the cleartext segment to claim a higher grace than
    // was actually signed must fail verification, not silently succeed with
    // the tampered number.
    const tampered = slotId.replace(`.${split.exp}.90.`, `.${split.exp}.120.`);
    const tamperedSplit = splitSignedSlotId(tampered);
    expect(tamperedSplit.arrivalGrace).toBe(120);
    expect(verifySlotOffer(
      { ...OFFER, exp: tamperedSplit.exp, arrivalGrace: tamperedSplit.arrivalGrace }, tamperedSplit.sig,
    )).toBe(false);
  });

  test('a non-zero arrivalGrace never verifies against a different (or missing) grace — EVERY signed field binding, extended', () => {
    const { exp, sig } = signSlotOffer({ ...OFFER, arrivalGrace: 90 });
    expect(verifySlotOffer({ ...OFFER, exp, arrivalGrace: 90 }, sig)).toBe(true);
    expect(verifySlotOffer({ ...OFFER, exp, arrivalGrace: 30 }, sig)).toBe(false);
    expect(verifySlotOffer({ ...OFFER, exp }, sig)).toBe(false); // omitted defaults to 0, not 90
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

describe('BOOK_ARRIVAL_GRACE_OFFER_POLICY + the graced /book field (GATE_BOOK_ARRIVAL_GRACE, owner-approved 2026-09-29)', () => {
  const BOOKING = {
    surface: 'booking', scopeId: '', serviceKey: 'pest_control', locationKey: '27.34,-82.53',
    date: '2027-05-20', startMinutes: 540, technicianId: 'tech-1', durationMinutes: 60,
  };
  const GRACED = { ...BOOKING, policy: BOOK_ARRIVAL_GRACE_OFFER_POLICY };

  test('bookOfferPolicy: the grace tag supersedes the insertion tag; otherwise exactly the old mapping', () => {
    expect(bookOfferPolicy({ insertion: true, graceLive: true })).toBe(BOOK_ARRIVAL_GRACE_OFFER_POLICY);
    expect(bookOfferPolicy({ insertion: false, graceLive: true })).toBe(BOOK_ARRIVAL_GRACE_OFFER_POLICY);
    expect(bookOfferPolicy({ insertion: true, graceLive: false })).toBe(BOOK_INSERTION_OFFER_POLICY);
    expect(bookOfferPolicy({ insertion: true })).toBe(BOOK_INSERTION_OFFER_POLICY);
    expect(bookOfferPolicy({ insertion: false, graceLive: false })).toBeUndefined();
    expect(bookOfferPolicy()).toBeUndefined();
    expect(BOOK_ARRIVAL_GRACE_OFFER_POLICY).not.toBe(BOOK_INSERTION_OFFER_POLICY);
  });

  test('a graced field is `<exp>.<grace>.<sig>`, verifies, and reads its grace back', () => {
    const field = mintSlotOfferField({ ...GRACED, arrivalGrace: 90 });
    expect(field.split('.')).toHaveLength(3);
    expect(splitSlotOfferField(field)).toMatchObject({ arrivalGrace: 90 });
    expect(verifySlotOfferField(GRACED, field)).toBe(true);
    expect(slotOfferFieldGrace(field)).toBe(90);
  });

  test('an ungraced field (grace 0 / omitted / negative) is the EXACT `<exp>.<sig>` shape and signature this function always produced', () => {
    const now = 1_800_000_000_000;
    const legacy = mintSlotOfferField(BOOKING, now);
    for (const arrivalGrace of [undefined, 0, -5, NaN, null]) {
      expect(mintSlotOfferField({ ...BOOKING, arrivalGrace }, now)).toBe(legacy);
    }
    expect(legacy.split('.')).toHaveLength(2);
    expect(slotOfferFieldGrace(legacy)).toBe(0);
    expect(splitSlotOfferField(legacy)).toMatchObject({ arrivalGrace: 0 });
  });

  test('the cleartext grace is bound into the HMAC: changing, adding or stripping it fails verification', () => {
    const [exp, grace, sig] = mintSlotOfferField({ ...GRACED, arrivalGrace: 90 }).split('.');
    expect(grace).toBe('90');
    expect(verifySlotOfferField(GRACED, [exp, '91', sig].join('.'))).toBe(false);
    expect(verifySlotOfferField(GRACED, [exp, '0', sig].join('.'))).toBe(false);
    expect(verifySlotOfferField(GRACED, [exp, sig].join('.'))).toBe(false); // stripped
    const ungraced = mintSlotOfferField(GRACED).split('.');
    expect(verifySlotOfferField(GRACED, [ungraced[0], '90', ungraced[1]].join('.'))).toBe(false); // added
  });

  test('a caller-supplied payload.arrivalGrace cannot vouch for a field: the field itself decides', () => {
    const ungraced = mintSlotOfferField(GRACED);
    expect(verifySlotOfferField({ ...GRACED, arrivalGrace: 90 }, ungraced)).toBe(true);
    const graced = mintSlotOfferField({ ...GRACED, arrivalGrace: 90 });
    expect(verifySlotOfferField({ ...GRACED, arrivalGrace: 0 }, graced)).toBe(true);
  });

  test('the grace policy and the insertion policy never redeem for one another, with or without a grace segment', () => {
    const graced = mintSlotOfferField({ ...GRACED, arrivalGrace: 90 });
    expect(verifySlotOfferField({ ...BOOKING, policy: BOOK_INSERTION_OFFER_POLICY }, graced)).toBe(false);
    expect(verifySlotOfferField(BOOKING, graced)).toBe(false);
    const insertion = mintSlotOfferField({ ...BOOKING, policy: BOOK_INSERTION_OFFER_POLICY });
    expect(verifySlotOfferField(GRACED, insertion)).toBe(false);
  });

  test('malformed fields never parse', () => {
    for (const bad of [undefined, null, '', 'abc', '123', '123.', '.abc', '1.2.3.4', 'x.y.z', 42, '12.-3.sig']) {
      expect(splitSlotOfferField(bad)).toBeNull();
      expect(verifySlotOfferField(GRACED, bad)).toBe(false);
      expect(slotOfferFieldGrace(bad)).toBe(0);
    }
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
