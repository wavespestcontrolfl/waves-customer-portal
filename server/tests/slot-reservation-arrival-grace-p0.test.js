/**
 * Self-serve arrival grace P0 (owner ruling 2026-09-28, Codex round 2 on
 * #5314): "a hold is certified ONCE, at reserve." Before this fix,
 * commitReservation re-read SELF_SERVE_ARRIVAL_GRACE_MINUTES live at accept
 * time — so a hold reserved at grace 90 with an 80-minute delay would fail
 * acceptance if the setting was lowered to 30 in between, even though the
 * hold was validly reserved and its route order already persisted.
 *
 * Fix, two parts:
 *   1. commitReservation NEVER applies a grace bound at all — it keeps only
 *      verifyArrivalCapacity's existing 120-minute arrival promise, exactly
 *      like origin/main. Source-checked here (no DB needed): a live rewrite
 *      that reintroduces arrivalGraceMinutes there is caught immediately.
 *   2. reserveSlot applies the EXACT grace that certified the offer — read
 *      back from the signed slotId's own cleartext arrivalGrace segment
 *      (utils/slot-offer-token.js), never a fresh live env read — so a
 *      grace change between OFFER and RESERVE never affects an in-flight
 *      offer either.
 *
 * Codex round 3: the first cut of part 2 bumped the slotId's canonical
 * string and wire shape UNCONDITIONALLY, so an ungraced (grace 0) offer —
 * every offer before this lane existed, and the overwhelming majority
 * afterward — broke at deploy, mid-checkout, for real customers. Fixed to
 * be per-offer opt-in: an ungraced offer signs/appends the EXACT v2 shape
 * origin/main always produced (see slot-offer-token.test.js for the
 * byte-for-byte comparison); only a genuinely graced offer takes the new
 * v3 shape. Covered here too, end to end through the same reconstruction
 * reserveSlot's own verifySlotOffer call makes.
 */
const fs = require('fs');
const path = require('path');
const { signSlotOffer, appendOfferToSlotId, verifySlotOffer } = require('../utils/slot-offer-token');

// Balance parens from a `verifyArrivalCapacity(` occurrence to its matching
// close — same approach as verify-arrival-capacity-grace-callers-guard.test.js.
function callSpanAt(source, callAt) {
  const needle = 'verifyArrivalCapacity(';
  let depth = 1;
  let i = callAt + needle.length;
  for (; i < source.length && depth > 0; i++) {
    if (source[i] === '(') depth++;
    else if (source[i] === ')') depth--;
  }
  return source.slice(callAt, i);
}

describe('source guard: commitReservation never re-applies a grace bound', () => {
  const src = fs.readFileSync(path.join(__dirname, '../services/slot-reservation.js'), 'utf8');

  test('commitReservation\'s verifyArrivalCapacity call carries no arrivalGraceMinutes key (and is marked GRACE-EXEMPT immediately above it)', () => {
    const fnStart = src.indexOf('async function commitReservation(');
    expect(fnStart).toBeGreaterThan(-1);
    // The one verifyArrivalCapacity call inside commitReservation.
    const callAt = src.indexOf('verifyArrivalCapacity(', fnStart);
    expect(callAt).toBeGreaterThan(-1);
    const callSpan = callSpanAt(src, callAt);
    expect(callSpan).not.toMatch(/arrivalGraceMinutes\s*:/);
    // The reason lives on the statement just above the call, not inside its
    // own argument object (slot-reservation.js's marker style).
    const precedingComment = src.slice(Math.max(0, callAt - 700), callAt);
    expect(precedingComment).toContain('GRACE-EXEMPT');
  });

  test('reserveSlot\'s verifyArrivalCapacity call uses the offer\'s OWN parsed grace, never a fresh live read', () => {
    const fnStart = src.indexOf('async function reserveSlot(');
    const fnEnd = src.indexOf('async function commitReservation(');
    expect(fnStart).toBeGreaterThan(-1);
    expect(fnEnd).toBeGreaterThan(fnStart);
    const fn = src.slice(fnStart, fnEnd);
    const callAt = fn.indexOf('verifyArrivalCapacity(preparedCapacity, {');
    expect(callAt).toBeGreaterThan(-1);
    const callSpan = callSpanAt(fn, callAt);
    expect(callSpan).toMatch(/arrivalGraceMinutes\s*:\s*offerArrivalGrace/);
    // (No live-re-read check needed here — the next test proves
    // selfServeArrivalGraceMinutes isn't even imported in this file.)
  });

  test('selfServeArrivalGraceMinutes is not IMPORTED in slot-reservation.js — reserveSlot/commitReservation both read the token, never the env, for this decision', () => {
    // The one `require('./scheduling/policy')` import line never
    // destructures selfServeArrivalGraceMinutes (a bare mention in a comment
    // explaining WHY is fine and expected — this checks the import only).
    const importLine = src.match(/const\s*{[^}]*}\s*=\s*require\(['"]\.\/scheduling\/policy['"]\);/)?.[0] || '';
    expect(importLine).not.toBe('');
    expect(importLine).not.toContain('selfServeArrivalGraceMinutes');
  });
});

describe('reserveSlot applies the grace baked into the offer token, not a live re-read', () => {
  // parseSlotId is not exported directly, but splitSignedSlotId (which it
  // wraps) is — this proves the round-trip parseSlotId depends on.
  const { splitSignedSlotId } = require('../utils/slot-offer-token');

  test('an offer signed under grace 90 carries arrivalGrace 90 through the wire, regardless of what the env reads later', () => {
    const offer = signSlotOffer({
      surface: 'estimate', scopeId: 'est-1', date: '2027-06-01',
      startMinutes: 600, technicianId: 'tech-1', durationMinutes: 60, arrivalGrace: 90,
    });
    const slotId = appendOfferToSlotId('2027-06-01_10-00_tech-1', { ...offer, arrivalGrace: 90 });
    const parsed = splitSignedSlotId(slotId);
    expect(parsed.arrivalGrace).toBe(90);
    // Simulates "the env changed to grace 30 (or was unset) between offer
    // and reserve" — parseSlotId's own output is unaffected either way,
    // since it never reads the env, only the token.
  });

  test('an offer signed with no grace (0) carries 0 through the wire', () => {
    const offer = signSlotOffer({
      surface: 'estimate', scopeId: 'est-1', date: '2027-06-01',
      startMinutes: 600, technicianId: 'tech-1', durationMinutes: 60,
    });
    const slotId = appendOfferToSlotId('2027-06-01_10-00_tech-1', offer);
    expect(splitSignedSlotId(slotId).arrivalGrace).toBe(0);
  });

  // Codex round 3 on #5314: the FIRST cut of this fix bumped the canonical
  // string and slotId shape unconditionally, so an ungraced (grace 0) offer
  // — the overwhelming common case, and the ONLY case before this lane
  // existed — broke at deploy, mid-checkout, for real customers. An ungraced
  // offer must verify exactly as it did on origin/main: the 2-segment
  // `<base>.<exp>.<sig>` shape, reconstructed and checked the same way
  // reserveSlot's own verifySlotOffer call does.
  test('an ungraced offer keeps the origin/main 2-segment shape and verifies through the exact reserveSlot reconstruction', () => {
    const payload = {
      surface: 'estimate', scopeId: 'est-1', date: '2027-06-01',
      startMinutes: 600, technicianId: 'tech-1', durationMinutes: 60,
    };
    const offer = signSlotOffer(payload); // no arrivalGrace at all
    const slotId = appendOfferToSlotId('2027-06-01_10-00_tech-1', offer);
    expect((slotId.match(/\./g) || []).length).toBe(2); // base.exp.sig — no grace segment
    const parsed = splitSignedSlotId(slotId);
    expect(parsed).toEqual({
      baseSlotId: '2027-06-01_10-00_tech-1', exp: offer.exp, arrivalGrace: 0, sig: offer.sig,
    });
    // The exact reconstruction reserveSlot's own verifySlotOffer call makes.
    expect(verifySlotOffer({ ...payload, exp: parsed.exp, arrivalGrace: parsed.arrivalGrace }, parsed.sig)).toBe(true);
  });
});

// Codex r3 P2 (#5314): a graced offer minted before ET midnight for
// "tomorrow" becomes same-day after midnight; same-day picks never get
// grace, so reserveSlot must refuse it (the customer refreshes into a
// grace-0 offer) instead of applying the signed grace.
describe('reserveSlot refuses a graced offer whose date is now today', () => {
  const src = fs.readFileSync(path.join(__dirname, '../services/slot-reservation.js'), 'utf8');
  test('the past-date guard also rejects date === today when the offer carries grace', () => {
    expect(src).toMatch(/if \(date === todayEt && offerArrivalGrace > 0\) return 'graced offer is now same-day';/);
    expect(src).toMatch(/const dateRefusal = slotDateRefusal\(date, todayEt, offerArrivalGrace\);/);
  });
  test('the refusal happens before any capacity verification runs', () => {
    const guardAt = src.indexOf('const dateRefusal = slotDateRefusal(date, todayEt, offerArrivalGrace);');
    const reserveVerifyAt = src.indexOf('arrivalGraceMinutes: offerArrivalGrace');
    expect(guardAt).toBeGreaterThan(-1);
    expect(reserveVerifyAt).toBeGreaterThan(guardAt);
  });
});
