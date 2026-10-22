/**
 * slide-offer.js — a new booking may take an occupied hour when sliding one
 * or two existing stops makes the whole day drive less (owner rulings
 * 2026-10-22). Fixture is SYNTHETIC (real customer coordinates are PII and
 * never live in the repo) but shaped like the Sat 10-24 day that prompted
 * it: a south→north line where the 11 AM stop sits far north of the 12 PM
 * one, so the new south stop only fits at 1 PM unless 11 AM slides.
 */
const { findSlideOffers, MAX_SLIDE_MINUTES } = require('../services/scheduling/slide-offer');

const LNG = -82.45;
const at = (lat) => ({ lat, lng: LNG });
const H = (h) => h * 60;
const stop = (id, lat, hour, extra = {}) => ({
  id, ...at(lat), startMin: H(hour), endMin: H(hour) + 60, expectedMinutes: 30, movable: true, ...extra,
});

// 8 Venice-ish · 9 · 10 N Venice-ish · 11 far north · 12 mid · 3 PM north.
const day = () => [
  stop('a', 27.05, 8),
  stop('b', 27.06, 9),
  stop('c', 27.14, 10),
  stop('d', 27.42, 11),
  stop('e', 27.32, 12),
  stop('f', 27.41, 15),
];

const base = {
  newStop: { ...at(27.18), expectedMinutes: 30 },
  durationMinutes: 60,
  home: at(27.30),
  dayOpen: H(8),
  dayClose: H(17),
};

let savedEnv;
beforeEach(() => {
  savedEnv = { ...process.env };
  process.env.GATE_DRIVE_TIME_CALIBRATION = 'true';
  delete process.env.SLOT_TRAVEL_BUFFER_MINUTES;
});
afterEach(() => { process.env = savedEnv; });

describe('findSlideOffers', () => {
  test('10-24 shape: offers 11 AM by sliding the far-north 11 AM stop later, beating the 1 PM plain slot', () => {
    const result = findSlideOffers({ ...base, stops: day() });
    expect(result.baseline.startMin).toBeGreaterThanOrEqual(H(13));
    const eleven = result.offers.find((o) => o.startMin === H(11));
    expect(eleven).toBeDefined();
    expect(eleven.slides).toEqual([{ id: 'd', fromStartMin: H(11), toStartMin: H(13) }]);
    expect(eleven.savedMinutes).toBeGreaterThanOrEqual(6);
    expect(eleven.savedMiles).toBeGreaterThanOrEqual(0.5);
  });

  test('the caller\'s booking-window rule applies to slid windows too (lunch block)', () => {
    const noLunch = ({ startMin, endMin }) => !(startMin < H(13) && endMin > H(12));
    const result = findSlideOffers({ ...base, stops: day(), admits: noLunch });
    for (const offer of result.offers) {
      expect(noLunch(offer)).toBe(true);
      for (const s of offer.slides) expect(noLunch({ startMin: s.toStartMin, endMin: s.toStartMin + 60 })).toBe(true);
    }
  });

  test('a stop the caller marks unmovable is never slid', () => {
    const stops = day().map((s) => (s.id === 'd' ? { ...s, movable: false } : s));
    const result = findSlideOffers({ ...base, stops });
    for (const offer of result.offers) {
      expect(offer.slides.map((s) => s.id)).not.toContain('d');
    }
  });

  test('nothing movable → no offers, baseline still reported', () => {
    const stops = day().map((s) => ({ ...s, movable: false }));
    const result = findSlideOffers({ ...base, stops });
    expect(result.reason).toBe('NOTHING_MOVABLE');
    expect(result.offers).toEqual([]);
    expect(result.baseline).not.toBeNull();
  });

  test('any coordless stop on the day → no offers (zero-drive legs would fake a saving)', () => {
    const stops = day().map((s) => (s.id === 'b' ? { ...s, lat: null, lng: null } : s));
    expect(findSlideOffers({ ...base, stops })).toMatchObject({ reason: 'COORDLESS_STOPS', offers: [] });
  });

  test('coordless new stop → no offers', () => {
    expect(findSlideOffers({ ...base, newStop: { lat: null, lng: null }, stops: day() }).reason)
      .toBe('NEW_STOP_COORDLESS');
  });

  test('never more than two slides, never past the slide cap, never before the day opens', () => {
    const result = findSlideOffers({ ...base, stops: day() });
    expect(result.offers.length).toBeGreaterThan(0);
    for (const offer of result.offers) {
      expect(offer.slides.length).toBeLessThanOrEqual(2);
      for (const s of offer.slides) {
        expect(Math.abs(s.toStartMin - s.fromStartMin)).toBeLessThanOrEqual(MAX_SLIDE_MINUTES);
        expect(s.toStartMin).toBeGreaterThanOrEqual(base.dayOpen);
      }
    }
  });

  test('slides may go earlier', () => {
    // The noon stop is far north between two south stops; the new stop is
    // south. Sliding the noon stop to 10 AM (next to the 8 AM north stop)
    // frees noon for the new stop beside its 1 PM neighbour.
    const stops = [
      stop('s8', 27.42, 8, { movable: false }),
      stop('s12', 27.42, 12),
      stop('s13', 27.05, 13, { movable: false }),
      stop('s14', 27.42, 14, { movable: false }),
      stop('s16', 27.05, 16, { movable: false }),
    ];
    const result = findSlideOffers({ ...base, stops });
    const noon = result.offers.find((o) => o.startMin === H(12));
    expect(noon.slides).toEqual([{ id: 's12', fromStartMin: H(12), toStartMin: H(10) }]);
    expect(noon.savedMinutes).toBeGreaterThanOrEqual(6);
  });

  test('no offer when the saving is under the floor', () => {
    // All stops at the same spot: no arrangement drives less than the plain slot.
    const stops = [stop('p', 27.18, 9), stop('q', 27.18, 10), stop('r', 27.18, 11)];
    const result = findSlideOffers({ ...base, stops });
    expect(result.offers).toEqual([]);
    expect(result.reason).toBe('NO_SAVING');
  });

  test('full day with no plain opening → no slide offers (no baseline to beat)', () => {
    const stops = [8, 9, 10, 11, 12, 13, 14, 15, 16].map((h, i) => stop(`s${i}`, 27.05 + i * 0.04, h));
    expect(findSlideOffers({ ...base, stops }).reason).toBe('NO_PLAIN_SLOT');
  });
});

describe('evaluation budget', () => {
  test('a dense day stops at MAX_EVALUATIONS and says so', () => {
    const { MAX_EVALUATIONS } = require('../services/scheduling/slide-offer');
    // A stop every 45 minutes (on and off the hour), the new stop beside the
    // last one so a plain 4 PM slot exists and the slide search really runs.
    const stops = Array.from({ length: 10 }, (_, i) => stop(`o${i}`, 27.05 + i * 0.04, 8, {
      startMin: H(8) + 15 + i * 45, endMin: H(8) + 45 + i * 45, expectedMinutes: 20,
    }));
    const t0 = Date.now();
    const result = findSlideOffers({
      ...base, stops, newStop: { ...at(27.41), expectedMinutes: 20 }, durationMinutes: 30,
      budget: { remaining: 500 },
    });
    expect(result.baseline).not.toBeNull();
    expect(result.truncated).toBe(true);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(MAX_EVALUATIONS).toBe(20000);
  });
});

describe('Codex r1 guards', () => {
  test('an hour that is already plainly bookable is never a slide offer', () => {
    const result = findSlideOffers({ ...base, stops: day() });
    expect(result.offers.length).toBeGreaterThan(0);
    for (const offer of result.offers) expect(offer.startMin).not.toBe(result.baseline.startMin);
  });

  test('start floor: nothing changed may start before it, and stops already past it are not slid', () => {
    const result = findSlideOffers({ ...base, stops: day(), startFloorMin: H(12) });
    expect(result.offers.find((o) => o.startMin === H(11))).toBeUndefined();
    for (const offer of result.offers) {
      expect(offer.startMin).toBeGreaterThanOrEqual(H(12));
      for (const s of offer.slides) {
        expect(s.fromStartMin).toBeGreaterThanOrEqual(H(12));
        expect(s.toStartMin).toBeGreaterThanOrEqual(H(12));
      }
    }
  });

  test('newStartFloorMin binds the new stop only', () => {
    const result = findSlideOffers({ ...base, stops: day(), newStartFloorMin: H(12) });
    for (const offer of result.offers) expect(offer.startMin).toBeGreaterThanOrEqual(H(12));
  });

  test('a changed last stop must be able to drive home by close', () => {
    // Every hour 8–3 is taken (unmovable); the 3 PM stop sits with the new
    // stop, far from home. 4–5 PM ends at close with a 40+ min drive home
    // still ahead, so there is no plain slot at all.
    const stops = [8, 9, 10, 11, 12, 13, 14].map((h) => stop(`n${h}`, 27.30, h, { movable: false }));
    stops.push(stop('far', 27.05, 15, { movable: false }));
    const result = findSlideOffers({ ...base, newStop: { ...at(27.05), expectedMinutes: 30 }, stops });
    expect(result.reason).toBe('NO_PLAIN_SLOT');
  });

  test('one budget is shared across calls and stops the later ones', () => {
    const budget = { remaining: 50 };
    const first = findSlideOffers({ ...base, stops: day(), budget });
    expect(first.truncated).toBe(true);
    expect(budget.remaining).toBeLessThanOrEqual(0);
    const second = findSlideOffers({ ...base, stops: day(), budget });
    expect(second.truncated).toBe(true);
    expect(second.offers).toEqual([]);
  });
});

describe('Codex r2 guards', () => {
  test('an off-hour stop keeps its off-hour admission rule when shifted onto the hour', () => {
    const seen = [];
    const admits = (w) => { seen.push(w); return true; };
    const stops = day().map((x) => (x.id === 'd' ? { ...x, startMin: H(11) + 15, endMin: H(12) + 15 } : x));
    findSlideOffers({ ...base, stops, admits });
    const onHourShifts = seen.filter((w) => !w.isNew && w.startMin % 60 === 0 && w.offHour);
    expect(onHourShifts.length).toBeGreaterThan(0);
    expect(seen.filter((w) => !w.isNew && !w.offHour && w.startMin % 60 !== 0)).toEqual([]);
  });

  test('the pair rule is injectable (travel-gap gate off = plain overlap)', () => {
    // Colocated back-to-back hours with no padding: the travel-gap buffer
    // (15 min) rejects every plain slot, plain overlap accepts them.
    const overlapsOnly = (a, b) => a.startMin < b.endMin && b.startMin < a.endMin;
    const stops = [stop('k', 27.30, 9, { expectedMinutes: 60 })];
    const args = {
      ...base, home: at(27.30), newStop: { ...at(27.30), expectedMinutes: 60 }, stops, dayClose: H(11),
    };
    expect(findSlideOffers(args).reason).toBe('NO_PLAIN_SLOT');
    expect(findSlideOffers({ ...args, pairViolates: overlapsOnly }).baseline).not.toBeNull();
  });

  test('three co-timed members of an unchanged grouped stop do not block the day', () => {
    const g = (id) => stop(id, 27.32, 12, { movable: false });
    const stops = [...day().filter((x) => x.id !== 'e'), g('e1'), g('e2'), g('e3')];
    const result = findSlideOffers({ ...base, stops });
    expect(result.baseline).not.toBeNull();
  });

  test('a past deadline stops the search and flags it truncated', () => {
    const result = findSlideOffers({ ...base, stops: day(), budget: { remaining: 1e9, deadline: Date.now() - 1 } });
    expect(result.truncated).toBe(true);
    expect(result.offers).toEqual([]);
  });
});

describe('Codex r3 guards', () => {
  test('every slide destination is on the hour, including for an off-hour stop', () => {
    const stops = day().map((x) => (x.id === 'd' ? { ...x, startMin: H(11) + 15, endMin: H(12) + 15 } : x));
    const seen = [];
    findSlideOffers({ ...base, stops, admits: (w) => { if (!w.isNew) seen.push(w.startMin); return true; } });
    expect(seen.length).toBeGreaterThan(0);
    for (const startMin of seen) expect(startMin % 60).toBe(0);
  });
});

describe('Codex r4 guards', () => {
  test('equal-minute plain slots tie-break on miles', () => {
    // Noon (between the stops) and 2 PM (after the last) both model 55
    // drive minutes; 2 PM is ~0.5 mi shorter, so it is the baseline.
    const stops = [
      { id: 'a', lat: 27.344, lng: -82.404, startMin: H(10), endMin: H(11), expectedMinutes: 30 },
      { id: 'b', lat: 27.288, lng: -82.424, startMin: H(13), endMin: H(14), expectedMinutes: 30 },
    ];
    const result = findSlideOffers({
      ...base, stops, newStop: { lat: 27.239, lng: -82.421, expectedMinutes: 30 },
    });
    expect(result.baseline).toMatchObject({ startMin: H(14), driveMinutes: 55 });
  });
});

describe('Codex r5 guards', () => {
  test('a changed stop may not clash with another technician\'s stop (blockers)', () => {
    const free = findSlideOffers({ ...base, stops: day() });
    expect(free.offers.find((o) => o.startMin === H(11))).toBeDefined();
    const blocked = findSlideOffers({
      ...base, stops: day(), blockers: [{ id: 'x', ...at(27.18), startMin: H(11), endMin: H(12) }],
    });
    expect(blocked.offers.find((o) => o.startMin === H(11))).toBeUndefined();
  });
});

describe('Codex r6 guards', () => {
  test('a far blocker with an own stop in between is not a travel-gap neighbour', () => {
    // Another tech's 4 PM stop ~60 mi south. The own 3 PM stop sits between
    // it and every change the 11 AM offer makes (d slides to 1 PM), so it is
    // never a travel-gap neighbour — checking it anyway (1 PM → 4 PM drive
    // ≈ the whole gap) would wrongly reject the offer.
    const blockers = [{ id: 'far', lat: 26.5, lng: -82.45, startMin: H(16), endMin: H(17), expectedMinutes: 30 }];
    const result = findSlideOffers({ ...base, stops: day(), blockers });
    expect(result.offers.find((o) => o.startMin === H(11))).toBeDefined();
  });

  test('an adjacent blocker is checked with its own expected-minutes credit', () => {
    // A blocker 10:00-11:00 beside the new stop's 11:00. Without credit
    // (expected = window) the drive can't fit; with a 30-min expected visit
    // the gap is 30 min and the short leg fits.
    const near = { id: 'nb', lat: 27.17, lng: -82.45, startMin: H(10), endMin: H(11) };
    const stops = day().filter((x) => x.id !== 'c');
    const noCredit = findSlideOffers({ ...base, stops, blockers: [near] });
    const credit = findSlideOffers({ ...base, stops, blockers: [{ ...near, expectedMinutes: 30 }] });
    expect(noCredit.offers.find((o) => o.startMin === H(11))).toBeUndefined();
    expect(credit.offers.find((o) => o.startMin === H(11))).toBeDefined();
  });
});
