/**
 * Portfolio selector (owner spec 2026-07-28). Pure: floor enforcement,
 * caps, coverage repair, alternates, ET weekend math, never-pad rule.
 */

const {
  selectPortfolio,
  effectiveScore,
  isWeekend,
  unmetConstraints,
} = require('../services/newsletter-portfolio');

// Week of Tue 2026-08-04 → Mon 2026-08-10 (EDT). Times chosen mid-day ET.
const DAY = {
  tue: '2026-08-04T18:00:00Z',
  wed: '2026-08-05T18:00:00Z',
  thu: '2026-08-06T18:00:00Z',
  fri: '2026-08-07T22:00:00Z',
  sat: '2026-08-08T18:00:00Z',
  sun: '2026-08-09T18:00:00Z',
  // Friday 8 PM ET = Saturday 00:00 UTC — the UTC-shift trap.
  friEvening: '2026-08-08T00:00:00Z',
};

let seq = 0;
function ev(overrides = {}) {
  seq += 1;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    title: `Event ${seq}`,
    admin_status: 'approved',
    editorial_score: 80,
    start_at: DAY.sat,
    region_zone: `zone-${seq % 5}`,
    venue_name: `Venue ${seq}`,
    source_id: `source-${seq % 6}`,
    family_friendly: true,
    is_free: false,
    price_text: 'Ticketed',
    novelty_type: 'one_time',
    audience_tags: ['family'],
    score_breakdown: { family_status: 'confirmed', penalty_flags: [] },
    ...overrides,
  };
}

describe('effective score provenance', () => {
  test('scored rows use their score; starred unscored rows are hero-grade; manual unscored rows sit at the floor', () => {
    expect(effectiveScore(ev({ editorial_score: 91 }))).toBe(91);
    expect(effectiveScore(ev({ editorial_score: null, admin_status: 'featured' }))).toBe(88);
    expect(effectiveScore(ev({ editorial_score: null }))).toBe(75);
  });
});

describe('ET weekend math', () => {
  test('a Friday-evening event stored as Saturday-midnight UTC is still a Friday weekend event', () => {
    expect(isWeekend(ev({ start_at: DAY.friEvening }))).toBe(true);
    expect(isWeekend(ev({ start_at: DAY.tue }))).toBe(false);
    expect(isWeekend(ev({ start_at: null }))).toBe(false);
  });
});

describe('the editorial floor is absolute', () => {
  test('sub-floor events never enter — not for count, not for constraints', () => {
    const strong = [ev({ editorial_score: 90 }), ev({ editorial_score: 85 }), ev({ editorial_score: 82 })];
    const weak = [ev({ editorial_score: 74 }), ev({ editorial_score: 60 })];
    const result = selectPortfolio([...strong, ...weak]);
    expect(result.selected.map((e) => e.id)).toEqual(expect.arrayContaining(strong.map((e) => e.id)));
    for (const w of weak) expect(result.selected.map((e) => e.id)).not.toContain(w.id);
    // Below MIN the shortfall is REPORTED, never padded.
    expect(result.selected.length).toBe(3);
    expect(result.unmet.join(' ')).toContain('editorial floor');
  });
});

describe('caps', () => {
  test('at most 2 per venue and 3 per zone', () => {
    const sameVenue = [1, 2, 3, 4].map((i) => ev({ venue_name: 'Same Hall', editorial_score: 95 - i, source_id: `s-${i}`, region_zone: `z-${i}` }));
    const sameZone = [1, 2, 3, 4, 5].map((i) => ev({ region_zone: 'tampa', editorial_score: 85 - i, source_id: `t-${i}` }));
    const result = selectPortfolio([...sameVenue, ...sameZone]);
    const venueCount = result.selected.filter((e) => e.venue_name === 'Same Hall').length;
    const zoneCount = result.selected.filter((e) => e.region_zone === 'tampa').length;
    expect(venueCount).toBeLessThanOrEqual(2);
    expect(zoneCount).toBeLessThanOrEqual(3);
  });
});

describe('portfolio coverage', () => {
  // A rich, diverse pool: plenty of weekend/family/parents/free/hero/novel
  // candidates across 4 zones.
  function richPool() {
    return [
      ev({ editorial_score: 92, start_at: DAY.fri, region_zone: 'manatee', novelty_type: 'inaugural' }),
      ev({ editorial_score: 90, start_at: DAY.sat, region_zone: 'tampa', audience_tags: ['family'] }),
      ev({ editorial_score: 86, start_at: DAY.sat, region_zone: 'pinellas', is_free: true }),
      ev({ editorial_score: 85, start_at: DAY.sun, region_zone: 'sarasota', audience_tags: ['parents_night'], family_friendly: false }),
      ev({ editorial_score: 84, start_at: DAY.fri, region_zone: 'tampa', audience_tags: ['parents_night'], family_friendly: false }),
      ev({ editorial_score: 83, start_at: DAY.thu, region_zone: 'pinellas' }),
      ev({ editorial_score: 82, start_at: DAY.sat, region_zone: 'manatee' }),
      ev({ editorial_score: 81, start_at: DAY.wed, region_zone: 'sarasota' }),
      ev({ editorial_score: 80, start_at: DAY.sun, region_zone: 'tampa' }),
      ev({ editorial_score: 79, start_at: DAY.tue, region_zone: 'pinellas' }),
      ev({ editorial_score: 78, start_at: DAY.fri, region_zone: 'sarasota' }),
      ev({ editorial_score: 77, start_at: DAY.sat, region_zone: 'manatee' }),
    ];
  }

  test('selects the target count with all coverage minimums met and 2 ranked alternates', () => {
    const result = selectPortfolio(richPool());
    expect(result.selected.length).toBe(8);
    expect(result.unmet).toEqual([]);
    expect(result.stats.weekendCount).toBeGreaterThanOrEqual(4);
    expect(result.stats.weekendDays.length).toBeGreaterThanOrEqual(2);
    expect(result.stats.zones.length).toBeGreaterThanOrEqual(3);
    expect(result.stats.familyCount).toBeGreaterThanOrEqual(2);
    expect(result.stats.parentsCount).toBeGreaterThanOrEqual(2);
    expect(result.stats.freeCount).toBeGreaterThanOrEqual(1);
    expect(result.stats.heroCount).toBeGreaterThanOrEqual(1);
    expect(result.alternates.length).toBe(2);
    // Alternates are floor-passing and rank right behind the selection.
    for (const alt of result.alternates) {
      expect(effectiveScore(alt)).toBeGreaterThanOrEqual(75);
      expect(result.selected.map((e) => e.id)).not.toContain(alt.id);
    }
    expect(result.stats.lowestSelectedScore).toBeGreaterThanOrEqual(75);
  });

  test('repairs an unmet weekend minimum by trading a weaker weekday pick', () => {
    // Top scores are all midweek; weekend events sit lower but above floor.
    const pool = [
      ev({ editorial_score: 95, start_at: DAY.tue }),
      ev({ editorial_score: 94, start_at: DAY.wed }),
      ev({ editorial_score: 93, start_at: DAY.thu }),
      ev({ editorial_score: 92, start_at: DAY.tue }),
      ev({ editorial_score: 91, start_at: DAY.wed }),
      ev({ editorial_score: 90, start_at: DAY.thu }),
      ev({ editorial_score: 89, start_at: DAY.tue }),
      ev({ editorial_score: 88, start_at: DAY.wed }),
      ev({ editorial_score: 80, start_at: DAY.fri }),
      ev({ editorial_score: 79, start_at: DAY.sat }),
      ev({ editorial_score: 78, start_at: DAY.sun }),
      ev({ editorial_score: 77, start_at: DAY.sat }),
    ];
    const result = selectPortfolio(pool);
    expect(result.stats.weekendCount).toBeGreaterThanOrEqual(4);
    expect(result.stats.weekendDays.length).toBeGreaterThanOrEqual(2);
    expect(result.stats.lowestSelectedScore).toBeGreaterThanOrEqual(75);
  });

  test('a thin week ships what qualifies and names the shortfalls', () => {
    const pool = [
      ev({ editorial_score: 90, start_at: DAY.tue, region_zone: 'tampa' }),
      ev({ editorial_score: 85, start_at: DAY.wed, region_zone: 'tampa', venue_name: 'Same', source_id: 'x' }),
      ev({ editorial_score: 84, start_at: DAY.thu, region_zone: 'tampa', venue_name: 'Same', source_id: 'x' }),
      ev({ editorial_score: 60, start_at: DAY.sat }),
    ];
    const result = selectPortfolio(pool);
    expect(result.selected.length).toBeLessThan(5);
    expect(result.unmet.length).toBeGreaterThan(0);
    expect(result.selected.every((e) => effectiveScore(e) >= 75)).toBe(true);
  });
});

describe('unmetConstraints helper', () => {
  test('empty selection reports every minimum', () => {
    expect(unmetConstraints([]).length).toBeGreaterThanOrEqual(6);
  });
});

describe('rankAlternates', () => {
  const { rankAlternates } = require('../services/newsletter-portfolio');

  test('ranks against the FINAL lineup — a locked event never doubles as its own replacement', () => {
    const locked = ev({ editorial_score: 90 });
    const nextBest = ev({ editorial_score: 84 });
    const third = ev({ editorial_score: 80 });
    const subFloor = ev({ editorial_score: 60 });
    const alts = rankAlternates([locked, nextBest, third, subFloor], [locked.id]);
    expect(alts.map((a) => a.id)).toEqual([nextBest.id, third.id]);
  });
});

describe('seeded (operator) picks', () => {
  const { selectPortfolio: sp } = require('../services/newsletter-portfolio');

  test('caps apply to the COMBINED lineup — two preferred same-venue events block further same-venue supplements', () => {
    const preferred = [
      ev({ venue_name: 'Same Hall', editorial_score: 76, region_zone: 'z1', source_id: 'a' }),
      ev({ venue_name: 'Same Hall', editorial_score: 76, region_zone: 'z2', source_id: 'b' }),
    ];
    const supplements = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => ev({
      venue_name: i <= 2 ? 'Same Hall' : `Other ${i}`,
      editorial_score: 95 - i,
      region_zone: `z-${i % 4}`,
      source_id: `s-${i}`,
    }));
    const result = sp([...preferred, ...supplements], { seeded: preferred });
    const sameVenue = result.selected.filter((e) => e.venue_name === 'Same Hall');
    // The two operator picks stay; the selector adds ZERO more from that venue.
    expect(sameVenue.map((e) => e.id).sort()).toEqual(preferred.map((e) => e.id).sort());
    // Operator picks lead in their original order.
    expect(result.selected.slice(0, 2).map((e) => e.id)).toEqual(preferred.map((e) => e.id));
  });

  test('seeded picks are never swapped out by repair passes', () => {
    const preferred = [ev({ editorial_score: 75, start_at: DAY.tue })];
    const pool = [6, 7, 8, 9, 10, 11, 12, 13].map((i) => ev({ editorial_score: 90 - i, start_at: DAY.sat, region_zone: `z-${i % 4}` }));
    const result = sp([...preferred, ...pool], { seeded: preferred });
    expect(result.selected.map((e) => e.id)).toContain(preferred[0].id);
  });
});
