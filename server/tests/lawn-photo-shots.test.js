/**
 * Lawn photo shot list (lawn report rebuild P18, GATE_LAWN_SHOT_LIST): the
 * shared definition, the validation contract, the area weights, the hero rule
 * and the zone-weighted legacy merge. Pure and DB-free.
 */
const shots = require('../services/lawn-photo-shots');
const visit = require('../services/lawn-visit-input');
const { mergePhotoComposites } = require('../services/lawn-photo-merge');
const definition = require('../../shared/lawn-photo-shots.json');

const KEYS = ['front', 'back', 'side', 'close_up', 'blade_crown', 'hot_edge', 'shade', 'trouble'];
const photo = (zone, data = 'YQ==') => ({ data, mimeType: 'image/jpeg', ...(zone ? { zone } : {}) });

describe('shot list definition', () => {
  test('eight keys in technician order, cap 8, soft minimum 4', () => {
    expect(shots.SHOT_KEYS).toEqual(KEYS);
    expect(new Set(shots.SHOT_KEYS).size).toBe(8);
    expect(shots.SHOT_CAP).toBe(8);
    expect(shots.SHOT_MINIMUM).toBe(4);
    expect(shots.MINIMUM_SLOTS).toEqual([['front'], ['back', 'side'], ['close_up'], ['blade_crown']]);
  });

  test('every shot has a label, a one-line instruction and a customer label', () => {
    for (const shot of shots.SHOTS) {
      expect(shot.label).toBeTruthy();
      expect(shot.instruction.length).toBeGreaterThan(10);
      expect(shot.reportLabel).toBeTruthy();
      expect(shot.max).toBeGreaterThanOrEqual(1);
    }
    expect(shots.SHOTS.map((s) => s.label)).toEqual([
      'Front overview', 'Back overview', 'Side overview', 'Canopy close-up',
      'Blade and crown', 'Hot edge', 'Shadiest turf', 'Problem area',
    ]);
  });

  test('a full set (front, back, hot edge, shade, close-up, blade, 2 problem) fits the cap', () => {
    const full = ['front', 'back', 'shade', 'hot_edge', 'close_up', 'blade_crown', 'trouble', 'trouble'];
    expect(full).toHaveLength(shots.SHOT_CAP);
    expect(shots.shotCountError(full)).toBeNull();
  });

  test('the module and the shared JSON agree (the client reads the same JSON)', () => {
    expect(shots.SHOTS.map((s) => s.key)).toEqual(definition.shots.map((s) => s.key));
    expect(shots.SHOT_CAP).toBe(definition.cap);
    expect(shots.SHOT_MINIMUM).toBe(definition.minimum);
  });

  test('pairable zones are the same-spot overviews only', () => {
    expect([...shots.PAIRABLE_SHOT_ZONES].sort()).toEqual(['back', 'front', 'side']);
    expect([...shots.NON_PAIRABLE_SHOT_ZONES].sort()).toEqual(['blade_crown', 'close_up', 'hot_edge', 'shade', 'trouble']);
  });

  test('area weights: overviews 1, shade and hot edge 0.5, detail shots 0, unlabeled 1', () => {
    expect(['front', 'back', 'side'].map(shots.areaWeight)).toEqual([1, 1, 1]);
    expect(['shade', 'hot_edge'].map(shots.areaWeight)).toEqual([0.5, 0.5]);
    expect(['close_up', 'blade_crown', 'trouble'].map(shots.areaWeight)).toEqual([0, 0, 0]);
    expect([null, undefined, '', 'garage'].map(shots.areaWeight)).toEqual([1, 1, 1, 1]);
  });

  test('hero rank: front, then other overviews, then half-weight shots, then detail shots', () => {
    const ranked = ['close_up', 'shade', 'back', 'front', 'trouble', null].sort((a, b) => shots.heroRank(b) - shots.heroRank(a));
    expect(ranked[0]).toBe('front');
    expect(shots.heroRank('front')).toBeGreaterThan(shots.heroRank('back'));
    expect(shots.heroRank('back')).toBeGreaterThan(shots.heroRank('shade'));
    expect(shots.heroRank('shade')).toBeGreaterThan(shots.heroRank('close_up'));
    expect(shots.heroRank(null)).toBe(shots.heroRank('back'));
  });

  test('beatsHero: a higher rank wins outright, quality decides inside a rank', () => {
    expect(shots.beatsHero({ rank: 3, quality: 40 }, { rank: 0, quality: 95 })).toBe(true);
    expect(shots.beatsHero({ rank: 0, quality: 99 }, { rank: 3, quality: 40 })).toBe(false);
    expect(shots.beatsHero({ rank: 2, quality: 80 }, { rank: 2, quality: 70 })).toBe(true);
    expect(shots.beatsHero({ rank: 2, quality: 70 }, { rank: 2, quality: 70 })).toBe(false);
    // Gate off passes rank 0 for every photo: the plain best-quality contest, first photo wins ties.
    expect(shots.beatsHero({ rank: 0, quality: 50 }, { rank: 0, quality: -1 })).toBe(true);
    expect(shots.beatsHero({ rank: 0, quality: 60 }, { rank: 0, quality: 50 })).toBe(true);
    expect(shots.beatsHero({ rank: 0, quality: 50 }, { rank: 0, quality: 50 })).toBe(false);
  });

  test('missing minimum slots name what to shoot, and back or side both satisfy the pair', () => {
    expect(shots.missingMinimumSlots([])).toEqual(['Front overview', 'Back overview or Side overview', 'Canopy close-up', 'Blade and crown']);
    expect(shots.missingMinimumSlots(['front', 'side', 'close_up'])).toEqual(['Blade and crown']);
    expect(shots.missingMinimumSlots(['front', 'back', 'close_up', 'blade_crown'])).toEqual([]);
  });
});

describe('validateVisitPhotos with the shot list on', () => {
  const on = { shotList: true };

  test('accepts up to 8 photos, rejects 9', () => {
    const eight = Array.from({ length: 8 }, (_, i) => photo(null, `YQ${i}=`.slice(0, 2) + '=='));
    expect(visit.validateVisitPhotos(eight, on).error).toBeNull();
    expect(visit.validateVisitPhotos([...eight, photo()], on).error).toMatch(/at most 8/i);
  });

  test('accepts every shot key and returns the normalized zones', () => {
    const photos = KEYS.map((zone, i) => photo(i === 7 ? 'Trouble' : zone));
    expect(visit.validateVisitPhotos(photos, on)).toEqual({ error: null, zones: KEYS });
  });

  test('one photo per shot, two problem-area photos, three rejected', () => {
    expect(visit.validateVisitPhotos([photo('front'), photo('front')], on).error).toMatch(/only one photo can be the front/i);
    expect(visit.validateVisitPhotos([photo('back'), photo('back')], on).error).toMatch(/only one photo can be the back overview/i);
    expect(visit.validateVisitPhotos([photo('close_up'), photo('close_up')], on).error).toMatch(/only one photo can be the canopy close-up/i);
    expect(visit.validateVisitPhotos([photo('trouble'), photo('trouble')], on)).toEqual({ error: null, zones: ['trouble', 'trouble'] });
    expect(visit.validateVisitPhotos([photo('trouble'), photo('trouble'), photo('trouble')], on).error).toMatch(/at most 2 photos can be the problem area/i);
  });

  test('an unknown zone is rejected and names the eight keys', () => {
    expect(visit.validateVisitPhotos([photo('garage')], on).error).toMatch(/front, back, side, close_up, blade_crown, hot_edge, shade, trouble/);
  });

  test('untagged photos stay valid (nothing is required)', () => {
    expect(visit.validateVisitPhotos([photo()], on)).toEqual({ error: null, zones: [null] });
  });
});

describe('validateVisitPhotos with the shot list off is unchanged', () => {
  test('cap stays 6, back/side/shade are still rejected, front is still unique', () => {
    expect(visit.validateVisitPhotos(Array.from({ length: 7 }, () => photo())).error).toMatch(/at most 6/i);
    for (const zone of ['back', 'side', 'shade', 'hot_edge', 'blade_crown']) {
      expect(visit.validateVisitPhotos([photo(zone)]).error).toMatch(/front, close_up, trouble/);
      expect(visit.validateVisitPhotos([photo(zone)], { shotList: false }).error).toMatch(/front, close_up, trouble/);
    }
    expect(visit.validateVisitPhotos([photo('front'), photo('front')]).error).toMatch(/only one photo can be the front/i);
    // Gate off keeps allowing repeats of the non-front slots.
    expect(visit.validateVisitPhotos([photo('close_up'), photo('close_up')]).error).toBeNull();
  });

  test('normalizePhotoZone only widens when asked', () => {
    expect(visit.normalizePhotoZone('hot_edge')).toBeNull();
    expect(visit.normalizePhotoZone('hot_edge', { shotList: true })).toBe('hot_edge');
    expect(visit.normalizePhotoZone('Front')).toBe('front');
    expect(visit.normalizePhotoZone('garage', { shotList: true })).toBeNull();
  });
});

describe('zone vocabulary on stored rows', () => {
  test('photo types and customer labels for the new zones; the original five are unchanged', () => {
    expect(['front', 'close_up', 'trouble', 'back', 'side'].map(visit.photoTypeForZone))
      .toEqual(['front_yard', 'close_up', 'trouble_spot', 'back_yard', 'side_yard']);
    expect(['shade', 'hot_edge', 'blade_crown'].map(visit.photoTypeForZone)).toEqual(['shade_area', 'hot_edge', 'blade_crown']);
    expect(['front', 'close_up', 'trouble', 'back', 'side'].map(visit.photoZoneLabel))
      .toEqual(['Front yard', 'Close-up', 'Trouble spot', 'Back yard', 'Side yard']);
    expect(['shade', 'hot_edge', 'blade_crown'].map(visit.photoZoneLabel)).toEqual(['Shaded area', 'Sunny edge', 'Blade close-up']);
    expect(visit.photoZoneLabel('garage')).toBeNull();
  });

  test('back pairs with back, front with front, and the new detail shots never pair', () => {
    const row = (id, zone) => ({ id, zone });
    expect(visit.pairBeforeAfterPhotos([row('b1', 'back')], [row('a1', 'back')]))
      .toEqual({ before: row('b1', 'back'), after: row('a1', 'back') });
    expect(visit.pairBeforeAfterPhotos([row('b1', 'front'), row('b2', 'back')], [row('a2', 'back')]))
      .toEqual({ before: row('b2', 'back'), after: row('a2', 'back') });
    for (const zone of ['shade', 'hot_edge', 'blade_crown', 'close_up', 'trouble']) {
      expect(visit.pairBeforeAfterPhotos([row('b', zone)], [row('a', zone)])).toEqual({ before: null, after: null });
    }
  });

  test('the model-facing schema and prompt digest do not move with the shot list', () => {
    // The shot list is a request-contract and UI change only: P19 owns the prompt.
    expect(visit.PHOTO_ZONES).toEqual(['front', 'close_up', 'trouble']);
    expect(visit.PROMPT_VERSION).toBe('lawn-visit-v1');
  });
});

describe('zone-weighted legacy merge', () => {
  const result = (o) => ({ composite: { turf_density: 70, weed_coverage: 10, color_health: 7, fungal_activity: 'none', thatch_visibility: 'low', insect_damage: 'none', drought_stress: 'none', mechanical_damage: 'none', observations: '', overwatering_signal: false, ...o } });

  test('a trouble photo no longer drags the lawn score', () => {
    const results = [
      result({ turf_density: 80, weed_coverage: 5, color_health: 8 }),
      result({ turf_density: 78, weed_coverage: 6, color_health: 8 }),
      result({ turf_density: 30, weed_coverage: 60, color_health: 3 }),
    ];
    const plain = mergePhotoComposites(results);
    expect(plain.turf_density).toBe(63);
    const weighted = mergePhotoComposites(results, { zones: ['front', 'back', 'trouble'] });
    expect(weighted.turf_density).toBe(79);
    expect(weighted.weed_coverage).toBe(6);
    expect(weighted.color_health).toBe(8);
  });

  test('shade and hot edge count half, detail shots count for nothing', () => {
    const results = [
      result({ turf_density: 80 }),
      result({ turf_density: 40 }),
      result({ turf_density: 10 }),
    ];
    // (80*1 + 40*0.5 + 10*0) / 1.5 = 66.67
    expect(mergePhotoComposites(results, { zones: ['front', 'shade', 'close_up'] }).turf_density).toBe(67);
    expect(mergePhotoComposites(results, { zones: ['front', 'hot_edge', 'blade_crown'] }).turf_density).toBe(67);
  });

  test('unlabeled photos count in full', () => {
    const results = [result({ turf_density: 80 }), result({ turf_density: 60 })];
    expect(mergePhotoComposites(results, { zones: [null, null] }).turf_density).toBe(70);
    expect(mergePhotoComposites(results, { zones: [null, 'close_up'] }).turf_density).toBe(80);
  });

  test('all detail shots fall back to the plain mean (a score beats none)', () => {
    const results = [result({ turf_density: 80 }), result({ turf_density: 60 })];
    expect(mergePhotoComposites(results, { zones: ['close_up', 'trouble'] }).turf_density).toBe(70);
  });

  test('severities and the overwatering OR ignore the weights (a trouble spot still surfaces)', () => {
    const merged = mergePhotoComposites([
      result({ insect_damage: 'none', fungal_activity: 'none' }),
      result({ insect_damage: 'severe', fungal_activity: 'moderate', overwatering_signal: true }),
    ], { zones: ['front', 'trouble'] });
    expect(merged.insect_damage).toBe('severe');
    expect(merged.worst_fungal_activity).toBe('moderate');
    expect(merged.overwatering_signal).toBe(true);
  });

  test('without zones the output is identical to the plain mean (older rows, gate off)', () => {
    const results = [result({ turf_density: 80, color_health: 8.1 }), result({ turf_density: 71, color_health: 6.4 }), result({ turf_density: 30, color_health: 3 })];
    expect(mergePhotoComposites(results, undefined)).toEqual(mergePhotoComposites(results));
    expect(mergePhotoComposites(results, {})).toEqual(mergePhotoComposites(results));
  });

  test('zones stay aligned with results when a failed (null) result sits between photos', () => {
    const merged = mergePhotoComposites([result({ turf_density: 90 }), null, result({ turf_density: 10 })], { zones: ['front', undefined, 'trouble'] });
    // The null entry is skipped, its zone slot is skipped with it, and trouble counts for nothing.
    expect(merged.turf_density).toBe(90);
  });
});
