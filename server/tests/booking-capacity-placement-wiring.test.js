/**
 * Codex round 1 on PR #5231 (owner 2026-09-28): insertion offers must only
 * reach callers whose commit persists the certified route order. Only
 * createSelfBooking does that, and only while GATE_BOOK_CAPACITY_COMMIT is
 * live — so exactly the callers below pass `capacityPlacement:
 * bookInsertionOffersLive()` into buildBookingAvailability (booking.js), and
 * exactly the callers whose own commit does NOT persist a route order (the
 * voice agent — relay-booking.js/relay-tools.js insert with no route_order)
 * omit it and stay append-only.
 *
 * Public reschedule joined the certified-order group in a later change, same
 * day: its single-visit commit (SmartRebooker.reschedule → rescheduleOnce,
 * services/rebooker.js) now runs the SAME prepareArrivalCapacity /
 * verifyArrivalCapacity / persistArrivalOrder sequence createSelfBooking
 * does, gated on the caller passing `capacityPlacement: true` AND
 * bookInsertionOffersLive() read fresh at commit — so its picker
 * (buildAvailabilityForService, the one picker behind GET, find-slots, and
 * the commit route's own anti-forgery re-check) now passes
 * `capacityPlacement: bookInsertionOffersLive()` too. A big-pull-forward
 * re-anchor still commits through rescheduleSeries, which always nulls
 * route_order on a move — that call never receives capacityPlacement and
 * stays append-only. See docs/public-route-contracts.md.
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

describe('booking.js — self-serve callers build through buildFunnelAvailability (capacityPlacement: bookInsertionOffersLive())', () => {
  const src = read('../routes/booking.js');

  test('buildFunnelAvailability itself passes selfServeNotice: true and capacityPlacement: bookInsertionOffersLive()', () => {
    const call = callAfter(src, 'function buildFunnelAvailability');
    expect(call).toContain('capacityPlacement: bookInsertionOffersLive()');
    expect(call).toContain('selfServeNotice: true');
  });

  // Each of these commits (or revalidates a slot that commits) through
  // /confirm -> createSelfBooking, so they share the ONE builder above instead
  // of each restating the two flags — and the texting AI's OPEN TIMES
  // (availabilityForExistingCustomer) offers through the same one.
  test.each([
    ['GET /availability', "router.get('/availability'"],
    ['POST /find-slots', "router.post('/find-slots'"],
    ['POST /capture-intent revalidation (must match /availability and /find-slots — offer/commit parity)', "router.post('/capture-intent'"],
    ['availabilityForExistingCustomer (the texting AI\'s OPEN TIMES)', 'async function availabilityForExistingCustomer'],
  ])('%s builds through buildFunnelAvailability', (_label, anchor) => {
    const at = src.indexOf(anchor);
    expect(at).toBeGreaterThan(-1);
    const callStart = src.indexOf('buildFunnelAvailability({', at);
    expect(callStart).toBeGreaterThan(-1);
    // no raw builder call between the route's start and its funnel call
    expect(src.slice(at, callStart)).not.toContain('buildBookingAvailability(');
    // and each opts into the same online-booking arrival grace, so the texting
    // AI never offers a narrower set than the /book screens show
    expect(src.slice(callStart, src.indexOf('});', callStart))).toContain('bookArrivalGrace: true');
  });
});

test('the texting AI\'s /book lookup expands open days like the /book page\'s own request (expand=open)', () => {
  const src = read('../routes/booking.js');
  const at = src.indexOf('async function availabilityForExistingCustomer');
  const callStart = src.indexOf('buildFunnelAvailability({', at);
  expect(src.slice(callStart, src.indexOf('});', callStart))).toContain('expandOpenDays: true');
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

describe('reschedule-public.js — single-visit commit persists the certified order (owner 2026-09-28); series stays append-only', () => {
  const src = read('../routes/reschedule-public.js');

  test('buildAvailabilityForService (the ONE picker — GET, find-slots, and the commit re-check) passes capacityPlacement: bookInsertionOffersLive()', () => {
    const call = callAfter(src, 'async function buildAvailabilityForService');
    expect(call).toContain('capacityPlacement: bookInsertionOffersLive()');
  });

  test('buildAvailabilityForService never offers insertion for a row carrying a visit_id — rescheduleOnce skips certification for those (Codex r2 P1 on PR #5267)', () => {
    const call = callAfter(src, 'async function buildAvailabilityForService');
    expect(call).toContain('capacityPlacement: bookInsertionOffersLive() && !svc.visit_id');
  });

  test('the single-visit commit (SmartRebooker.reschedule) opts in with capacityPlacement: true — its own commit (rescheduleOnce) persists the certified order under this flag', () => {
    const singleIdx = src.indexOf('await SmartRebooker.reschedule(');
    expect(singleIdx).toBeGreaterThan(-1);
    const singleEnd = src.indexOf('\n        );', singleIdx);
    expect(singleEnd).toBeGreaterThan(singleIdx);
    expect(src.slice(singleIdx, singleEnd)).toContain('capacityPlacement: true');
  });

  test('the series re-anchor commit (SmartRebooker.rescheduleSeries) never sets capacityPlacement — rescheduleSeries always nulls route_order on a move, so an inserted offer there would commit unnumbered', () => {
    const seriesIdx = src.indexOf('await SmartRebooker.rescheduleSeries(');
    const singleIdx = src.indexOf('await SmartRebooker.reschedule(');
    expect(seriesIdx).toBeGreaterThan(-1);
    expect(singleIdx).toBeGreaterThan(seriesIdx);
    expect(src.slice(seriesIdx, singleIdx)).not.toContain('capacityPlacement');
  });
});

describe('voice agent — commits by inserting the row with no route_order', () => {
  test('relay-booking.js never passes capacityPlacement — stays append-only', () => {
    const src = read('../services/voice-agent/relay-booking.js');
    const call = callAfter(src, 'booking.buildBookingAvailability({');
    expect(call).not.toContain('capacityPlacement');
  });

  test('relay-tools.js never passes capacityPlacement at either call site — stays append-only', () => {
    const src = read('../services/voice-agent/relay-tools.js');
    // Two call sites (lines ~500, ~524) — check both independently rather
    // than a whole-file scan, so a future unrelated addition elsewhere in
    // this large file can't hide a wrongly-wired third call.
    const firstStart = src.indexOf('booking.buildBookingAvailability({');
    expect(firstStart).toBeGreaterThan(-1);
    const firstEnd = src.indexOf('});', firstStart);
    const secondStart = src.indexOf('booking.buildBookingAvailability({', firstEnd);
    expect(secondStart).toBeGreaterThan(firstEnd);
    const secondEnd = src.indexOf('});', secondStart);
    expect(src.slice(firstStart, firstEnd)).not.toContain('capacityPlacement');
    expect(src.slice(secondStart, secondEnd)).not.toContain('capacityPlacement');
  });
});
