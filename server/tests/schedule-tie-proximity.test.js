// Schedule tie-proximity (owner ruling 2026-09-26, GATE_SCHEDULE_TIE_PROXIMITY):
// when two stops on a tech's day start within 30 minutes of each other, the
// one closer to the previous stop shows first — booking order must not
// matter. Pure-helper coverage only; the route wiring (admin-schedule.js)
// just calls this and is exercised through the client tie-break tests +
// manual gate-off inspection (see PR notes).
//
// Deterministic geometry: HQ at the origin, plain Euclidean "miles" (not the
// production haversine formula), and drive minutes == miles (identity) — the
// point is to prove the SELECTION algorithm (greedy nearest-to-previous
// within a 30-minute tie window), not to re-derive the calibrated/legacy
// estimator, which route-optimizer.test.js already covers.
jest.mock('../services/route-optimizer', () => ({
  HQ: { lat: 0, lng: 0 },
  haversine: (lat1, lng1, lat2, lng2) => Math.sqrt((lat1 - lat2) ** 2 + (lng1 - lng2) ** 2),
  milesToDriveMinutes: (miles) => miles,
}));

const {
  orderStopsByTieProximity, stampTieProximityDisplayOrder, parseWindowStartMinutes, TIE_WINDOW_MINUTES,
} = require('../services/schedule-tie-proximity');

function stop(id, { windowStart = null, lat = null, lng = null } = {}) {
  return { id, windowStart, lat, lng };
}

function ids(result) {
  return result.map((s) => s.id);
}

describe('schedule-tie-proximity', () => {
  it('is a 30-minute tie window', () => {
    expect(TIE_WINDOW_MINUTES).toBe(30);
  });

  describe('parseWindowStartMinutes', () => {
    it('parses HH:MM and HH:MM:SS (Postgres time) alike', () => {
      expect(parseWindowStartMinutes('08:00')).toBe(480);
      expect(parseWindowStartMinutes('08:00:00')).toBe(480);
      expect(parseWindowStartMinutes('12:30:00')).toBe(750);
    });

    it('returns null for no window start or unparseable input', () => {
      expect(parseWindowStartMinutes(null)).toBeNull();
      expect(parseWindowStartMinutes(undefined)).toBeNull();
      expect(parseWindowStartMinutes('')).toBeNull();
      expect(parseWindowStartMinutes('not a time')).toBeNull();
    });
  });

  describe('orderStopsByTieProximity', () => {
    it('real example: Bradenton (previous stop) → both 12:00, Lakewood Ranch (near) beats Palmetto (far), regardless of booking order', () => {
      const bradenton = { lat: 0, lng: 0 }; // previous stop's position
      const palmetto = stop('palmetto', { windowStart: '12:00:00', lat: 10, lng: 1 }); // far (~30 min)
      const lakewoodRanch = stop('lwr', { windowStart: '12:00:00', lat: 3, lng: 1 }); // near (~15 min)

      // Booked Palmetto first — booking order must not matter.
      const result = orderStopsByTieProximity([palmetto, lakewoodRanch], { origin: bradenton });
      expect(ids(result)).toEqual(['lwr', 'palmetto']);
      expect(result[0].displayOrder).toBe(0);
      expect(result[1].displayOrder).toBe(1);
    });

    it('three-way tie: each pick is nearest to the PREVIOUSLY PICKED stop, not nearest to the origin', () => {
      // Distance-from-origin (HQ, (0,0)) order is p1(~2.24) < p2(~3.16) <
      // p3(~4.47), which would sort p1,p2,p3 — but p2 sits far from p1
      // (dist 5) while p3, though farther from the origin, sits close to p1
      // (dist 3). Greedy (nearest to whichever stop was just picked)
      // therefore goes p1 -> p3 -> p2, proving each pick re-anchors on the
      // PREVIOUS pick rather than re-sorting by distance from the origin.
      const p1 = stop('p1', { windowStart: '09:00', lat: 2, lng: 1 });
      const p2 = stop('p2', { windowStart: '09:00', lat: -3, lng: 1 });
      const p3 = stop('p3', { windowStart: '09:00', lat: 2, lng: 4 });

      const result = orderStopsByTieProximity([p1, p2, p3]);
      expect(ids(result)).toEqual(['p1', 'p3', 'p2']);
    });

    it('11:30 (far) vs 12:00 (near): the near stop is within the 30-minute tie window, so it jumps ahead', () => {
      const farAt1130 = stop('far-1130', { windowStart: '11:30', lat: 100, lng: 1 });
      const nearAt1200 = stop('near-1200', { windowStart: '12:00', lat: 1, lng: 2 });

      // origin (previous stop / HQ) is at (0,0) — nearAt1200 is much closer.
      const result = orderStopsByTieProximity([farAt1130, nearAt1200]);
      expect(ids(result)).toEqual(['near-1200', 'far-1130']);
    });

    it('11:00 vs 12:00: more than 30 minutes apart, so no jump even though the later stop is nearer', () => {
      const at1100 = stop('at-1100', { windowStart: '11:00', lat: 100, lng: 1 }); // far, but earliest
      const nearAt1200 = stop('near-1200', { windowStart: '12:00', lat: 1, lng: 2 }); // near, but > 30 min later

      const result = orderStopsByTieProximity([at1100, nearAt1200]);
      expect(ids(result)).toEqual(['at-1100', 'near-1200']);
    });

    it('a stop exactly 30 minutes after the anchor is still a tie (inclusive boundary)', () => {
      const anchor = stop('anchor', { windowStart: '09:00', lat: 100, lng: 1 });
      const nearAt930 = stop('near-930', { windowStart: '09:30', lat: 1, lng: 2 });

      const result = orderStopsByTieProximity([anchor, nearAt930]);
      expect(ids(result)).toEqual(['near-930', 'anchor']);
    });

    it('a stop 31 minutes after the anchor is NOT a tie', () => {
      const anchor = stop('anchor', { windowStart: '09:00', lat: 100, lng: 1 });
      const nearAt931 = stop('near-931', { windowStart: '09:31', lat: 1, lng: 2 });

      const result = orderStopsByTieProximity([anchor, nearAt931]);
      expect(ids(result)).toEqual(['anchor', 'near-931']);
    });

    it('ungeocoded stops in a tie group go after every geocoded one, keeping their own relative order', () => {
      const ungeocodedA = stop('ungeo-a', { windowStart: '09:00', lat: null, lng: null }); // earliest start (anchor)
      const ungeocodedB = stop('ungeo-b', { windowStart: '09:10', lat: null, lng: null });
      const geocoded = stop('geo', { windowStart: '09:20', lat: 5, lng: 1 }); // later start, but geocoded

      const result = orderStopsByTieProximity([ungeocodedA, ungeocodedB, geocoded]);
      // Geocoded wins the group despite NOT being the earliest start; the two
      // ungeocoded stops keep their original relative order after it.
      expect(ids(result)).toEqual(['geo', 'ungeo-a', 'ungeo-b']);
    });

    it('the first stop of the day measures from HQ (default origin) when none is passed', () => {
      const near = stop('near', { windowStart: '08:00', lat: 1, lng: 2 });
      const far = stop('far', { windowStart: '08:00', lat: 50, lng: 1 });

      const result = orderStopsByTieProximity([far, near]); // no origin passed -> HQ (0,0)
      expect(ids(result)).toEqual(['near', 'far']);
    });

    it('stops without any window start stay at the end, in their original relative order', () => {
      const timed = stop('timed', { windowStart: '09:00', lat: 1, lng: 1 });
      const untimedFirst = stop('untimed-1', { windowStart: null, lat: 2, lng: 1 });
      const untimedSecond = stop('untimed-2', { windowStart: null, lat: 3, lng: 1 });

      const result = orderStopsByTieProximity([untimedFirst, timed, untimedSecond]);
      expect(ids(result)).toEqual(['timed', 'untimed-1', 'untimed-2']);
    });

    it('does not mutate the input stops', () => {
      const original = stop('a', { windowStart: '09:00', lat: 1, lng: 1 });
      orderStopsByTieProximity([original]);
      expect(original.displayOrder).toBeUndefined();
    });

    it('returns an empty array for no stops', () => {
      expect(orderStopsByTieProximity([])).toEqual([]);
    });
  });
});

describe('stampTieProximityDisplayOrder (day + week feed wiring)', () => {
  // Synthetic points: prev at the same spot, near ~5 mi east, far ~20 mi
  // east (HQ-independent: prev is picked first on start time alone).
  const prevPt = { lat: 27.40, lng: -82.60 };
  const nearPt = { lat: 27.40, lng: -82.52 };
  const farPt = { lat: 27.40, lng: -82.28 };

  test('week shape: coords from raw rows, displayOrder per tech, booking order ignored', () => {
    const payloads = [
      { id: 'a-prev', technicianId: 't1', windowStart: '11:00' },
      { id: 'a-far', technicianId: 't1', windowStart: '12:00' },
      { id: 'b-only', technicianId: 't2', windowStart: '12:00' },
      { id: 'a-near', technicianId: 't1', windowStart: '12:00' },
      { id: 'unassigned', technicianId: null, windowStart: '12:00' },
    ];
    const rows = [
      { id: 'a-prev', visit_lat: prevPt.lat, visit_lng: prevPt.lng },
      { id: 'a-far', visit_lat: farPt.lat, visit_lng: farPt.lng },
      { id: 'b-only', visit_lat: farPt.lat, visit_lng: farPt.lng },
      { id: 'a-near', visit_lat: nearPt.lat, visit_lng: nearPt.lng },
      { id: 'unassigned', visit_lat: nearPt.lat, visit_lng: nearPt.lng },
    ];
    stampTieProximityDisplayOrder(payloads, rows);
    const byId = Object.fromEntries(payloads.map((p) => [p.id, p]));
    expect(byId['a-prev'].displayOrder).toBe(0);
    expect(byId['a-near'].displayOrder).toBe(1);
    expect(byId['a-far'].displayOrder).toBe(2);
    expect(byId['b-only'].displayOrder).toBe(0);
    expect('displayOrder' in byId.unassigned).toBe(false);
    // Payloads keep their shape: no coordinates leak into the week response.
    expect('lat' in byId['a-near']).toBe(false);
    expect(payloads.map((p) => p.id)).toEqual(['a-prev', 'a-far', 'b-only', 'a-near', 'unassigned']);
  });

  test('day shape: payloads carry lat/lng themselves', () => {
    const payloads = [
      { id: 'prev', technicianId: 't1', windowStart: '11:00', ...prevPt },
      { id: 'far', technicianId: 't1', windowStart: '12:00', ...farPt },
      { id: 'near', technicianId: 't1', windowStart: '12:00', ...nearPt },
    ];
    stampTieProximityDisplayOrder(payloads);
    expect(payloads.map((p) => [p.id, p.displayOrder])).toEqual([['prev', 0], ['far', 2], ['near', 1]]);
  });
});
