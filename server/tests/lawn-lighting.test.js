// Lawn lighting-aware color (GATE_LAWN_LIGHTING, owner 2026-10-04): the pure
// rules. Which light reads may be compared on color, how a visit's one light is
// taken from its photos, how the stored read is found again, and the color dead
// band. Synthetic data only; no model, no database.
const lighting = require('../services/lawn-lighting');
const { CATEGORY_BAND } = require('../services/service-report/lawn-progress');

describe('the compatibility table', () => {
  const LIGHTS = lighting.LIGHTING;

  test('only these pairs may be compared on color; everything else, including unknown with itself, may not', () => {
    const allowed = [];
    for (const a of LIGHTS) for (const b of LIGHTS) if (lighting.lightsCompatible(a, b)) allowed.push(`${a}+${b}`);
    expect(allowed.sort()).toEqual([
      'full_sun+full_sun',
      'open_shade+open_shade', 'open_shade+overcast',
      'overcast+open_shade', 'overcast+overcast',
    ]);
  });

  test('it is symmetric, and mixed sun and shade, low light and unknown are never compatible, not even with themselves', () => {
    for (const a of LIGHTS) for (const b of LIGHTS) expect(lighting.lightsCompatible(a, b)).toBe(lighting.lightsCompatible(b, a));
    for (const never of ['mixed_sun_shade', 'low_light', 'unknown']) {
      for (const other of LIGHTS) expect(lighting.lightsCompatible(never, other)).toBe(false);
    }
    expect(lighting.lightsCompatible('full_sun', 'overcast')).toBe(false);
    expect(lighting.lightsCompatible(undefined, 'full_sun')).toBe(false);
  });

  test('colorComparability: a missing or unknown read on either visit is "light_unknown", two known incompatible reads are "light_differs"', () => {
    expect(lighting.colorComparability('full_sun', 'full_sun')).toEqual({ comparable: true, reason: null });
    expect(lighting.colorComparability('overcast', 'open_shade')).toEqual({ comparable: true, reason: null });
    for (const [a, b] of [[null, 'full_sun'], ['full_sun', undefined], ['unknown', 'unknown'], ['full_sun', 'unknown'], ['not_a_light', 'full_sun']]) {
      expect(lighting.colorComparability(a, b)).toEqual({ comparable: false, reason: 'light_unknown' });
    }
    expect(lighting.colorComparability('full_sun', 'overcast')).toEqual({ comparable: false, reason: 'light_differs' });
    expect(lighting.colorComparability('mixed_sun_shade', 'mixed_sun_shade')).toEqual({ comparable: false, reason: 'light_differs' });
    expect(lighting.colorComparability('low_light', 'low_light')).toEqual({ comparable: false, reason: 'light_differs' });
  });
});

describe('the color dead band', () => {
  test('is the progress engine\'s own category band (8 points on the 0-100 scale), not a second threshold', () => {
    expect(lighting.COLOR_NO_CHANGE_POINTS).toBe(8);
    expect(lighting.COLOR_NO_CHANGE_POINTS).toBe(CATEGORY_BAND);
  });
});

describe('a photo\'s light read', () => {
  test('hard shadows turn any single-light read into mixed sun and shade; a cannot-tell answer stays null', () => {
    expect(lighting.normalizeLightRead({ lighting: 'full_sun', hard_shadows: 'yes' })).toEqual({ lighting: 'full_sun', hard_shadows: true });
    expect(lighting.normalizeLightRead({ lighting: 'overcast', hard_shadows: 'no' })).toEqual({ lighting: 'overcast', hard_shadows: false });
    expect(lighting.normalizeLightRead({ lighting: 'overcast', hard_shadows: 'unknown' })).toEqual({ lighting: 'overcast', hard_shadows: null });
    expect(lighting.normalizeLightRead({ lighting: 'neon', hard_shadows: 'maybe' })).toEqual({ lighting: 'unknown', hard_shadows: null });
    expect(lighting.normalizeLightRead(undefined)).toEqual({ lighting: 'unknown', hard_shadows: null });
    expect(lighting.effectiveLight({ lighting: 'full_sun', hard_shadows: true })).toBe('mixed_sun_shade');
    expect(lighting.effectiveLight({ lighting: 'overcast', hard_shadows: true })).toBe('mixed_sun_shade');
    expect(lighting.effectiveLight({ lighting: 'full_sun', hard_shadows: false })).toBe('full_sun');
    expect(lighting.effectiveLight({ lighting: 'full_sun', hard_shadows: null })).toBe('full_sun');
    expect(lighting.effectiveLight({ lighting: 'low_light', hard_shadows: true })).toBe('low_light');
    expect(lighting.effectiveLight({ quality: 'adequate' })).toBe('unknown'); // a run from before the gate
    expect(lighting.effectiveLight(null)).toBe('unknown');
  });

  test('photoLightsFromRun: finds each photo by the run\'s index-aligned photo_ids, skips a gap, reads old rows as unknown', () => {
    const run = {
      photo_ids: ['p1', null, 'p3'],
      photo_quality: [
        { photo: 1, quality: 'adequate', issue: '', lighting: 'full_sun', hard_shadows: false },
        { photo: 2, quality: 'adequate', issue: '', lighting: 'overcast', hard_shadows: false },
        { photo: 3, quality: 'limited', issue: '' },
      ],
    };
    expect(lighting.photoLightsFromRun(run)).toEqual([
      { photoId: 'p1', photo: 1, quality: 'adequate', light: 'full_sun' },
      { photoId: 'p3', photo: 3, quality: 'limited', light: 'unknown' },
    ]);
    // jsonb may arrive as text; garbage reads as nothing
    expect(lighting.photoLightsFromRun({ photo_ids: JSON.stringify(['a']), photo_quality: JSON.stringify([{ photo: 1, quality: 'adequate', lighting: 'overcast', hard_shadows: 'no' }]) }))
      .toEqual([{ photoId: 'a', photo: 1, quality: 'adequate', light: 'overcast' }]);
    expect(lighting.photoLightsFromRun({ photo_ids: 'nope', photo_quality: 'nope' })).toEqual([]);
    expect(lighting.photoLightsFromRun(undefined)).toEqual([]);
  });
});

describe('a visit\'s one light', () => {
  const p = (light, zone, quality = 'adequate') => ({ light, zone, quality });

  test('rests on every usable photo that carries color weight: a close-up in shade or a poor photo never voids a sunny overview', () => {
    expect(lighting.visitLightFromPhotos([p('full_sun', 'front'), p('open_shade', 'close_up'), p('low_light', 'trouble'), p('overcast', 'front', 'poor')])).toBe('full_sun');
    expect(lighting.visitLightFromPhotos([p('full_sun', 'front'), p('full_sun', 'back'), p('full_sun', null), p('mixed_sun_shade', 'blade_crown')])).toBe('full_sun');
  });

  test('half-weight shots (shade, hot edge) move the color score, so they count: a sunny front beside an overcast shade photo is a mixed visit', () => {
    expect(lighting.visitLightFromPhotos([p('full_sun', 'front'), p('overcast', 'shade')])).toBe('mixed_sun_shade');
    expect(lighting.visitLightFromPhotos([p('full_sun', 'front'), p('full_sun', 'hot_edge')])).toBe('full_sun');
    expect(lighting.visitLightFromPhotos([p('full_sun', 'front'), p('unknown', 'hot_edge')])).toBe('unknown');
    // the rule follows the shot list's own weights, not a hard-coded list
    const shots = require('../services/lawn-photo-shots');
    for (const shot of shots.SHOTS) {
      const counts = lighting.visitLightFromPhotos([p('full_sun', 'front'), p('overcast', shot.key)]) !== 'full_sun';
      expect(counts).toBe(shot.areaWeight > 0);
    }
  });

  test('no usable overview photo, or any overview photo with no read, is unknown', () => {
    expect(lighting.visitLightFromPhotos([])).toBe('unknown');
    expect(lighting.visitLightFromPhotos(undefined)).toBe('unknown');
    expect(lighting.visitLightFromPhotos([p('full_sun', 'close_up'), p('full_sun', 'front', 'poor')])).toBe('unknown');
    expect(lighting.visitLightFromPhotos([p('full_sun', 'front'), p('unknown', 'back')])).toBe('unknown');
  });

  test('overcast and open shade agree as even light; sun beside shade is mixed; all low light stays low light', () => {
    expect(lighting.visitLightFromPhotos([p('overcast', 'front'), p('open_shade', 'back')])).toBe('overcast');
    expect(lighting.visitLightFromPhotos([p('open_shade', 'front'), p('open_shade', 'back')])).toBe('open_shade');
    expect(lighting.visitLightFromPhotos([p('full_sun', 'front'), p('overcast', 'back')])).toBe('mixed_sun_shade');
    expect(lighting.visitLightFromPhotos([p('full_sun', 'front'), p('mixed_sun_shade', 'back')])).toBe('mixed_sun_shade');
    expect(lighting.visitLightFromPhotos([p('low_light', 'front'), p('low_light', 'back')])).toBe('low_light');
  });
});

describe('loadVisitLights', () => {
  function fakeKnex({ runs = [], photos = [], failOn = null } = {}) {
    const log = [];
    const knex = (table) => {
      log.push(table);
      const chain = {
        whereIn: () => chain,
        where: (cond) => { log.push(cond); return chain; },
        select: async () => {
          if (failOn === table) throw new Error(`${table} down`);
          return table === 'lawn_assessment_runs' ? runs : photos;
        },
      };
      return chain;
    };
    return { knex, log };
  }

  const photos = [
    { id: 'c1', assessment_id: 'A', zone: 'front' }, { id: 'c2', assessment_id: 'A', zone: 'close_up' },
    { id: 'o1', assessment_id: 'B', zone: 'front' },
  ];
  const runs = [
    {
      assessment_id: 'A', photo_ids: ['c1', 'c2'],
      photo_quality: [
        { photo: 1, quality: 'adequate', issue: '', lighting: 'overcast', hard_shadows: 'no' },
        { photo: 2, quality: 'adequate', issue: '', lighting: 'full_sun', hard_shadows: 'yes' },
      ],
    },
    // a run from before the gate: no read on the row
    { assessment_id: 'B', photo_ids: ['o1'], photo_quality: [{ photo: 1, quality: 'adequate', issue: '' }] },
  ];

  test('one run read and one photo read for every id; a visit with no stored read is unknown', async () => {
    const { knex, log } = fakeKnex({ runs, photos });
    const lights = await lighting.loadVisitLights(knex, ['A', 'B', 'C', 'A'], { customerId: 'cust-1' });
    expect(Object.fromEntries(lights)).toEqual({ A: 'overcast', B: 'unknown', C: 'unknown' });
    expect(log.filter((entry) => typeof entry === 'string')).toEqual(['lawn_assessment_runs', 'lawn_assessment_photos']);
    expect(log.filter((entry) => typeof entry === 'object')).toEqual([{ customer_id: 'cust-1' }, { customer_id: 'cust-1' }]);
  });

  test('no ids reads nothing; no run at all reads no photos', async () => {
    const empty = fakeKnex();
    expect((await lighting.loadVisitLights(empty.knex, [null, undefined])).size).toBe(0);
    expect(empty.log).toEqual([]);
    const noRuns = fakeKnex({ runs: [], photos });
    expect(Object.fromEntries(await lighting.loadVisitLights(noRuns.knex, ['A']))).toEqual({ A: 'unknown' });
    expect(noRuns.log).toEqual(['lawn_assessment_runs']);
  });

  test('a FAILED read throws: it is never reported as an unknown light the caller could cache as healthy', async () => {
    await expect(lighting.loadVisitLights(fakeKnex({ runs, photos, failOn: 'lawn_assessment_runs' }).knex, ['A'])).rejects.toThrow('lawn_assessment_runs down');
    await expect(lighting.loadVisitLights(fakeKnex({ runs, photos, failOn: 'lawn_assessment_photos' }).knex, ['A'])).rejects.toThrow('lawn_assessment_photos down');
  });
});
