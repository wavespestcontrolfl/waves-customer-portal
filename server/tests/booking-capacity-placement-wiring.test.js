/**
 * Codex round 1 on PR #5231 (owner 2026-09-28): insertion offers must only
 * reach callers whose commit persists the certified route order. Only
 * createSelfBooking does that, and only while GATE_BOOK_CAPACITY_COMMIT is
 * live — so exactly the callers below pass `capacityPlacement:
 * bookInsertionOffersLive()` into buildBookingAvailability (booking.js), and
 * the caller whose own commit does NOT persist a route order (public
 * reschedule — SmartRebooker clears route_order on a move) omits it and
 * stays append-only.
 *
 * The voice agent (owner 2026-09-28, same day) earns the wiring too, once
 * its OWN commit (relay-booking.js's commitVoiceBooking) also
 * prepares/locks/verifies/persists the certified route order — see
 * voice-relay-booking-insertion.test.js for that commit-side behavior.
 *

 * Round 2 (Codex P1, same PR): bookCapacityCommitLive() alone wasn't the
 * right condition either — it doesn't also require GATE_SCHEDULING_CAPACITY,
 * the gate that actually turns on whole-route insertion in the first place.
 * Renamed to bookInsertionOffersLive() = bookCapacityCommitLive() &&
 * capacityEnabled() (routes/booking.js), exported via _internals, and every
 * caller below switched to it.
 *
 * Source-level assertions on each call's own text, mirroring the existing
 * pattern for asserting WHERE/HOW a call is wired rather than re-running the
 * whole route (booking-capacity-commit.test.js, which reads routes/booking.js
 * the same way). buildBookingAvailability's own pass-through of whatever
 * capacityPlacement value it's given, and the signed policy tag its mint
 * attaches, are behavioral tests in booking-availability-insertion.test.js;
 * the commit-side verify of that tag is in booking-confirm-signed-offer
 * .test.js.
 */
const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8');

// The buildBookingAvailability call immediately following `anchor` in
// `src`, sliced up to its closing `});` (bounded — these are all short,
// single-purpose calls).
function callAfter(src, anchor) {
  const at = src.indexOf(anchor);
  expect(at).toBeGreaterThan(-1);
  const callStart = src.indexOf('buildBookingAvailability({', at);
  expect(callStart).toBeGreaterThan(-1);
  const callEnd = src.indexOf('});', callStart);
  expect(callEnd).toBeGreaterThan(callStart);
  return src.slice(callStart, callEnd);
}

describe('booking.js — bookInsertionOffersLive() is bookCapacityCommitLive() AND capacityEnabled()', () => {
  test('the reader itself is exported and computes the AND, not just bookCapacityCommitLive() alone', () => {
    const { bookInsertionOffersLive } = require('../routes/booking')._internals;
    expect(typeof bookInsertionOffersLive).toBe('function');
    const gates = require('../config/feature-gates');
    const policy = require('../services/scheduling/policy');
    const savedCommit = process.env.GATE_BOOK_CAPACITY_COMMIT;
    const savedCapacity = process.env.GATE_SCHEDULING_CAPACITY;
    try {
      for (const [commit, capacity, expected] of [
        ['true', 'true', true], ['true', 'false', false], ['false', 'true', false], ['false', 'false', false],
      ]) {
        process.env.GATE_BOOK_CAPACITY_COMMIT = commit;
        process.env.GATE_SCHEDULING_CAPACITY = capacity;
        expect(gates.bookCapacityCommitLive()).toBe(commit === 'true');
        expect(policy.capacityEnabled()).toBe(capacity === 'true');
        expect(bookInsertionOffersLive()).toBe(expected);
      }
    } finally {
      if (savedCommit === undefined) delete process.env.GATE_BOOK_CAPACITY_COMMIT;
      else process.env.GATE_BOOK_CAPACITY_COMMIT = savedCommit;
      if (savedCapacity === undefined) delete process.env.GATE_SCHEDULING_CAPACITY;
      else process.env.GATE_SCHEDULING_CAPACITY = savedCapacity;
    }
  });
});

describe('booking.js — self-serve callers pass capacityPlacement: bookInsertionOffersLive()', () => {
  const src = read('../routes/booking.js');

  test('GET /availability — commits through /confirm -> createSelfBooking', () => {
    const call = callAfter(src, "router.get('/availability'");
    expect(call).toContain('capacityPlacement: bookInsertionOffersLive()');
  });

  test('POST /find-slots — same /confirm -> createSelfBooking commit as /availability', () => {
    const call = callAfter(src, "router.post('/find-slots'");
    expect(call).toContain('capacityPlacement: bookInsertionOffersLive()');
  });

  test('POST /capture-intent revalidation — must match /availability and /find-slots (offer/commit parity)', () => {
    const call = callAfter(src, "router.post('/capture-intent'");
    expect(call).toContain('capacityPlacement: bookInsertionOffersLive()');
  });
});

describe('reservice-public.js — commits through createSelfBooking (callbackVisit)', () => {
  test('buildAvailabilityForCustomer passes capacityPlacement: bookInsertionOffersLive()', () => {
    const src = read('../routes/reservice-public.js');
    const call = callAfter(src, 'async function buildAvailabilityForCustomer');
    expect(call).toContain('capacityPlacement:');
    expect(call).toContain('bookInsertionOffersLive()');
  });
});

describe('inspection-public.js — commits through createSelfBooking (phase 2)', () => {
  test('buildAvailabilityForLead passes capacityPlacement: bookInsertionOffersLive()', () => {
    const src = read('../routes/inspection-public.js');
    const call = callAfter(src, 'async function buildAvailabilityForLead');
    expect(call).toContain('capacityPlacement:');
    expect(call).toContain('bookInsertionOffersLive()');
  });
});

describe('reschedule-public.js — commits through SmartRebooker, which clears route_order on a move', () => {
  test('buildAvailabilityForService never passes capacityPlacement — stays append-only', () => {
    const src = read('../routes/reschedule-public.js');
    const call = callAfter(src, 'async function buildAvailabilityForService');
    expect(call).not.toContain('capacityPlacement');
  });
});

describe('voice agent — commitVoiceBooking now persists a certified route order too (owner 2026-09-28)', () => {
  test('relay-booking.js revalidateSlot passes capacityPlacement: bookInsertionOffersLive() (read once, reused on its own returned result — Codex P1 offer/commit parity)', () => {
    const src = read('../services/voice-agent/relay-booking.js');
    // Read once into a local (not inlined) so revalidateSlot's OWN
    // returned result (capacityPlacement below) reports exactly what the
    // build actually used — see commitVoiceBooking's offeredWithInsertion.
    expect(src).toContain('const capacityPlacement = booking.bookInsertionOffersLive();');
    const call = callAfter(src, 'booking.buildBookingAvailability({');
    expect(call).toContain('capacityPlacement,');
  });

  test('relay-tools.js passes capacityPlacement: bookInsertionOffersLive() at both call sites', () => {
    const src = read('../services/voice-agent/relay-tools.js');
    // Two call sites (the `when` NL-window build and the soonest-windows
    // build) — check both independently rather than a whole-file scan, so a
    // future unrelated addition elsewhere in this large file can't hide a
    // wrongly-wired third call.
    const firstStart = src.indexOf('booking.buildBookingAvailability({');
    expect(firstStart).toBeGreaterThan(-1);
    const firstEnd = src.indexOf('});', firstStart);
    const secondStart = src.indexOf('booking.buildBookingAvailability({', firstEnd);
    expect(secondStart).toBeGreaterThan(firstEnd);
    const secondEnd = src.indexOf('});', secondStart);
    expect(src.slice(firstStart, firstEnd)).toContain('capacityPlacement: booking.bookInsertionOffersLive()');
    expect(src.slice(secondStart, secondEnd)).toContain('capacityPlacement: booking.bookInsertionOffersLive()');
  });
});
