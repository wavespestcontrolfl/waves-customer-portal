/**
 * Yard pressure calendar: a derived view of the species catalog. The level
 * rule, the combined-row max, the October output the owner approved in the
 * mockup, the grass filter, trend flags and the overlay-vs-catalog guard.
 */

const catalog = require('../services/species-catalog');
const { buildYardCalendar, LEVEL_LABELS, _overlaySlugs } = require('../services/pest-forecast/landscape-calendar');

const byId = (cal, id) => cal.items.find((i) => i.id === id);

describe('level rule (derived from catalog months)', () => {
  // take-all root rot: active Apr-Oct, peak Jun-Aug (not all-year)
  test.each([
    [6, 3, 'Peak season'],
    [4, 2, 'In season'],
    [10, 2, 'In season'],
    [11, 0, 'Off season'],
    [1, 0, 'Off season'],
  ])('take-all month %i -> level %i', (month, level, label) => {
    const item = byId(buildYardCalendar({ month }), 'take-all-root-rot');
    expect(item.level).toBe(level);
    expect(item.levelLabel).toBe(label);
  });

  test('all-year entry is Low year-round outside its peak', () => {
    // sod webworm: active all 12 months, peak Sep-Nov
    expect(byId(buildYardCalendar({ month: 3 }), 'sod-webworm')).toMatchObject({ level: 1, levelLabel: 'Low year-round' });
    expect(byId(buildYardCalendar({ month: 9 }), 'sod-webworm')).toMatchObject({ level: 3, levelLabel: 'Peak season' });
  });

  test('every item levels array matches the catalog rule for every month', () => {
    const cal = buildYardCalendar({ month: 1 });
    const slugsOf = { nutsedge: ['yellow-nutsedge', 'purple-nutsedge'], 'winter-weeds': ['cudweed'] };
    for (const item of cal.items) {
      const entries = (slugsOf[item.id] || [item.id]).map((s) => catalog.getEntry(s));
      item.levels.forEach((lv, i) => {
        const m = i + 1;
        const expected = Math.max(...entries.map((e) => {
          if (e.peak_months.includes(m)) return 3;
          if (e.active_months.includes(m)) return new Set(e.active_months).size === 12 ? 1 : 2;
          return 0;
        }));
        expect(lv).toBe(expected);
      });
    }
  });

  test('levelLabel and level agree with LEVEL_LABELS', () => {
    for (const item of buildYardCalendar({ month: 5 }).items) {
      expect(item.levelLabel).toBe(LEVEL_LABELS[item.level]);
      expect(item.levels).toHaveLength(12);
    }
  });
});

describe('combined rows take the max of their members', () => {
  test('nutsedge and winter weeds match catalog members', () => {
    const yn = catalog.getEntry('yellow-nutsedge');
    const pn = catalog.getEntry('purple-nutsedge');
    const nut = byId(buildYardCalendar({ month: 6 }), 'nutsedge');
    expect(nut.level).toBe(3);
    expect(yn.peak_months.includes(6) || pn.peak_months.includes(6)).toBe(true);
    // UF/IFAS EP569: both nutsedges grow in all seasons in Florida, most in
    // summer (owner 2026-10-02): low year-round, May-Sep peak.
    expect(nut.levels).toEqual([1, 1, 1, 1, 3, 3, 3, 3, 3, 1, 1, 1]);
    expect(byId(buildYardCalendar({ month: 1 }), 'winter-weeds').levels).toEqual([3, 3, 3, 2, 0, 0, 0, 0, 0, 2, 2, 3]);
  });
});

describe('October output (approved mockup)', () => {
  const oct = buildYardCalendar({ month: 10 });

  test('lawn peaks, large patch off, take-all in season, chinch low', () => {
    for (const id of ['sod-webworm', 'white-grub', 'fall-armyworm', 'mole-cricket']) expect(byId(oct, id).level).toBe(3);
    expect(byId(oct, 'large-patch').level).toBe(0);
    expect(byId(oct, 'take-all-root-rot').level).toBe(2);
    expect(byId(oct, 'chinch-bug').level).toBe(1);
  });

  test('shape: header, 23 items, plan ahead, catalog-derived fields', () => {
    expect(oct).toMatchObject({ month: 10, grass: 'all', area: 'Southwest Florida', reviewedAt: '2026-09-30' });
    expect(oct.items).toHaveLength(23);
    expect(oct.planAhead).toHaveLength(2);
    expect(oct.planAhead[0]).toMatch(/^Large patch starts in November/);
    expect(byId(oct, 'sod-webworm')).toMatchObject({
      category: 'lawn', serviceLine: 'lawn', link: '/pest-identifier/sod-webworm/', infoOnly: false,
    });
    expect(byId(oct, 'ganoderma-butt-rot')).toMatchObject({ infoOnly: true, serviceLine: 'none', link: null });
    expect(byId(oct, 'citrus-greening').infoOnly).toBe(true);
    expect(byId(oct, 'gray-leaf-spot').lookAlike).toBeNull();
  });

  test('every item has the contract keys', () => {
    for (const item of oct.items) {
      expect(Object.keys(item).sort()).toEqual([
        'category', 'grassKeys', 'hosts', 'id', 'infoOnly', 'level', 'levelLabel', 'levels',
        'link', 'lookAlike', 'name', 'serviceLine', 'sign', 'trend',
      ]);
      expect(['lawn', 'shrub', 'weed']).toContain(item.category);
    }
  });

  test('plan ahead exists for October and November only', () => {
    expect(buildYardCalendar({ month: 11 }).planAhead).toEqual(['Winter weeds are still in the pre-emergent window.']);
    expect(buildYardCalendar({ month: 4 }).planAhead).toEqual([]);
  });
});

describe('grass filter', () => {
  test('sta keeps St. Augustine lawn items and all non-lawn items', () => {
    const cal = buildYardCalendar({ month: 10, grass: 'sta' });
    const lawn = cal.items.filter((i) => i.category === 'lawn').map((i) => i.id);
    expect(lawn).toEqual(expect.arrayContaining(['chinch-bug', 'large-patch', 'gray-leaf-spot', 'white-grub']));
    expect(lawn).not.toContain('mole-cricket');
    expect(cal.items.filter((i) => i.category !== 'lawn')).toHaveLength(15);
    expect(cal.grass).toBe('sta');
  });

  test('bah drops chinch bug, take-all and large patch; zoy keeps large patch', () => {
    const bah = buildYardCalendar({ month: 10, grass: 'bah' }).items.map((i) => i.id);
    expect(bah).toContain('mole-cricket');
    for (const id of ['chinch-bug', 'take-all-root-rot', 'large-patch']) expect(bah).not.toContain(id);
    expect(buildYardCalendar({ month: 10, grass: 'zoy' }).items.map((i) => i.id)).toContain('large-patch');
  });

  test('all and missing grass apply no filter', () => {
    expect(buildYardCalendar({ month: 10, grass: 'all' }).items).toHaveLength(23);
    expect(buildYardCalendar({ month: 10 }).items).toHaveLength(23);
  });
});

describe('trend', () => {
  const t = (month, id) => byId(buildYardCalendar({ month }), id).trend;

  test('peak_next_month when the level rises to peak', () => {
    expect(t(8, 'sod-webworm')).toBe('peak_next_month'); // Aug low -> Sep peak
    expect(t(5, 'take-all-root-rot')).toBe('peak_next_month'); // May in season -> Jun peak
  });

  test('starts_next_month when the level rises but not to peak', () => {
    expect(t(3, 'take-all-root-rot')).toBe('starts_next_month'); // Mar off -> Apr in season
    expect(t(10, 'large-patch')).toBe('starts_next_month'); // Oct off -> Nov in season
  });

  test('easing_next_month when peak drops', () => {
    expect(t(11, 'sod-webworm')).toBe('easing_next_month'); // Nov peak -> Dec low
    expect(t(9, 'take-all-root-rot')).toBe('easing_next_month'); // Sep peak -> Oct in season
  });

  test('null when steady or falling from below peak', () => {
    expect(t(9, 'sod-webworm')).toBeNull(); // peak -> peak
    expect(t(4, 'sod-webworm')).toBeNull(); // low -> low
    expect(t(10, 'take-all-root-rot')).toBeNull(); // in season -> off is not "easing"
  });

  test('December wraps to January', () => {
    expect(t(12, 'large-patch')).toBeNull(); // peak -> peak across the year end
    expect(t(12, 'winter-weeds')).toBeNull();
    expect(t(1, 'aphid')).toBe('peak_next_month'); // Jan low -> Feb peak
  });
});

describe('input validation', () => {
  test.each([0, 13, 1.5, '10', null, NaN])('rejects month %p', (month) => {
    expect(() => buildYardCalendar({ month })).toThrow(RangeError);
  });
  test('rejects missing options and unknown grass', () => {
    expect(() => buildYardCalendar()).toThrow(RangeError);
    expect(() => buildYardCalendar({ month: 3, grass: 'centipede' })).toThrow(RangeError);
  });
  test('returns fresh objects: mutating one result cannot change the next', () => {
    const a = buildYardCalendar({ month: 10 });
    a.items[0].levels[0] = 99;
    a.items.length = 0;
    const b = buildYardCalendar({ month: 10 });
    expect(b.items).toHaveLength(23);
    expect(b.items[0].levels[0]).not.toBe(99);
  });
});

describe('overlay vs catalog guard', () => {
  test('every overlay slug exists in the catalog and is owner approved', () => {
    const slugs = _overlaySlugs();
    expect(slugs.length).toBeGreaterThanOrEqual(24);
    for (const slug of slugs) {
      const entry = catalog.getEntry(slug);
      expect(entry).toBeTruthy();
      expect(entry.review.status).toBe('owner_approved');
      expect(catalog.isApproved(entry)).toBe(true);
    }
  });

  test('a missing or unapproved slug is left out with a warning, never a load crash', () => {
    const real = require('../services/species-catalog');
    for (const mode of ['missing', 'unapproved']) {
      jest.isolateModules(() => {
        jest.doMock('../services/species-catalog', () => ({
          ...real,
          getEntry: (slug) => (slug === 'white-grub' && mode === 'missing' ? null : real.getEntry(slug)),
          isApproved: (entry) => (mode === 'unapproved' && entry.slug === 'white-grub' ? false : real.isApproved(entry)),
        }));
        const warn = jest.fn();
        jest.doMock('../services/logger', () => ({ warn, info: jest.fn(), error: jest.fn(), debug: jest.fn() }));
        const mod = require('../services/pest-forecast/landscape-calendar');
        const ids = mod.buildYardCalendar({ month: 10 }).items.map((i) => i.id);
        expect(ids).not.toContain('white-grub');
        expect(ids).toContain('sod-webworm');
        expect(warn).toHaveBeenCalledWith(expect.stringMatching(mode === 'missing' ? /"white-grub".*not found/ : /"white-grub".*not owner_approved/));
      });
    }
    jest.dontMock('../services/species-catalog');
    jest.dontMock('../services/logger');
  });
});
