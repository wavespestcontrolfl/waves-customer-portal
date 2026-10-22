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
    // The new stop sits near home. Plainly it lands at 11 between two south
    // stops and the day backtracks; sliding the 4 PM south stop to 2 PM lets
    // the new stop take 3 PM, the day's last stop before home.
    const stops = [
      stop('s8', 27.32, 8, { movable: false }),
      stop('s9', 27.05, 9, { movable: false }),
      stop('s10', 27.18, 10, { movable: false }),
      stop('s16', 27.18, 16),
    ];
    const result = findSlideOffers({ ...base, newStop: { ...at(27.32), expectedMinutes: 30 }, stops });
    const three = result.offers.find((o) => o.startMin === H(15));
    expect(three.slides).toEqual([{ id: 's16', fromStartMin: H(16), toStartMin: H(14) }]);
    expect(three.savedMinutes).toBeGreaterThanOrEqual(6);
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
  test('a dense off-hour day stops at MAX_EVALUATIONS and says so', () => {
    const { MAX_EVALUATIONS } = require('../services/scheduling/slide-offer');
    // Ten off-hour stops: 45 pairs × 16² shifts × ~9 starts ≫ the budget.
    const stops = Array.from({ length: 10 }, (_, i) => stop(`o${i}`, 27.05 + i * 0.04, 8, {
      startMin: H(8) + 15 + i * 45, endMin: H(8) + 45 + i * 45, expectedMinutes: 20,
    }));
    const t0 = Date.now();
    // New stop beside the last stop, so a plain 4 PM slot exists and the
    // slide search really runs.
    const result = findSlideOffers({
      ...base, stops, newStop: { ...at(27.41), expectedMinutes: 20 }, durationMinutes: 30,
    });
    expect(result.baseline).not.toBeNull();
    expect(result.truncated).toBe(true);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(MAX_EVALUATIONS).toBe(20000);
  });
});
