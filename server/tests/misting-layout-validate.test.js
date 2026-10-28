const {
  MAP_HEIGHT, MAP_WIDTH, MAX_NOZZLES, validateLayoutPayload, looksLikePng, feetPerPixel, sameProperty,
} = require('../services/misting-layout-validate');

const valid = (over = {}) => ({
  address: '500 Example Court, Venice, FL',
  center: { lat: 26.95, lng: -82.4 },
  zoom: 20,
  mapWidth: MAP_WIDTH,
  mapHeight: MAP_HEIGHT,
  lines: [
    { id: 'L1', kind: 'eave', points: [{ x: 100, y: 200 }, { x: 700, y: 200 }] },
    { id: 'L2', kind: 'fence', points: [{ x: 100, y: 600 }, { x: 400, y: 600 }] },
  ],
  nozzles: [
    { x: 100, y: 200, kind: 'eave', lineIndex: 0 },
    { x: 400, y: 200, kind: 'eave', lineIndex: 0 },
    { x: 100, y: 600, kind: 'fence', lineIndex: 1 },
  ],
  risers: [{ x: 50, y: 60 }],
  pump: { x: 70, y: 80, checks: { outlet: true, level: true, dry: true, stucco: true } },
  zones: [{ kind: 'pool', x: 300, y: 300, radiusFt: 15 }],
  ...over,
});

const problem = (over, re) => expect(() => validateLayoutPayload(valid(over))).toThrow(re);

describe('validateLayoutPayload', () => {
  test('accepts a full layout and derives the counts and line length itself', () => {
    const out = validateLayoutPayload(valid({ counts: { nozzles: 999 }, nozzleCount: 999, linearFt: 5 }));
    expect(out).toMatchObject({ nozzleCount: 3, eaveCount: 2, fenceCount: 1, riserCount: 1, mapWidth: 1280, mapHeight: 960, zoom: 20 });
    // 600 px + 300 px of line at zoom 20, converted with the same math as the client.
    expect(out.linearFt).toBeCloseTo(Math.round(900 * feetPerPixel(26.95, 20) * 10) / 10, 5);
    expect(out.pump).toEqual({ x: 70, y: 80, checks: { outlet: true, level: true, dry: true, stucco: true } });
    expect(out.zones).toEqual([{ kind: 'pool', x: 300, y: 300, radiusFt: 15 }]);
  });

  test('a layout with no lines, risers or zones is fine if it has a nozzle (placed by hand) and the pump', () => {
    const out = validateLayoutPayload(valid({ lines: [], risers: [], zones: [] }));
    expect(out).toMatchObject({ riserCount: 0, linearFt: 0, pump: { x: 70, y: 80, checks: { outlet: true, level: true, dry: true, stucco: true } } });
    expect(out.nozzles.every((n) => n.lineIndex === null)).toBe(true);
  });

  test('keeps an optional manual aim on a nozzle, 0 included, wrapped to two decimals', () => {
    const out = validateLayoutPayload(valid({
      nozzles: [
        { x: 100, y: 200, kind: 'eave', lineIndex: 0, aim: 0 },
        { x: 400, y: 200, kind: 'eave', lineIndex: 0, aim: 212.456 },
        { x: 100, y: 600, kind: 'fence', lineIndex: 1, aim: '90' },
        { x: 200, y: 600, kind: 'fence', lineIndex: 1, aim: null },
        { x: 300, y: 600, kind: 'fence', lineIndex: 1, aim: 359.999 },
        { x: 350, y: 600, kind: 'fence', lineIndex: 1 },
      ],
    }));
    expect(out.nozzles.map((n) => n.aim)).toEqual([0, 212.46, 90, undefined, 0, undefined]);
    expect(Object.keys(out.nozzles[3])).not.toContain('aim');
    expect(Object.keys(out.nozzles[5])).not.toContain('aim');
  });

  test('rejects an aim that is not a heading from 0 up to 360', () => {
    [360, 361, -1, -0.01, NaN, Infinity, 'north', '', [], {}, true].forEach((aim) => {
      problem({ nozzles: [{ x: 1, y: 1, kind: 'eave', lineIndex: 0, aim }] }, /nozzles\[0\] aim must be a heading/);
    });
  });

  test('requires the pump', () => {
    problem({ pump: null }, /needs the pump placed/);
    problem({ pump: undefined }, /needs the pump placed/);
    expect(() => validateLayoutPayload(valid())).not.toThrow();
  });

  describe('the pump spot checklist (Pynamite manual)', () => {
    const pumpWith = (checks) => ({ pump: { x: 70, y: 80, ...(checks === undefined ? {} : { checks }) } });
    const all = { outlet: true, level: true, dry: true, stucco: true };

    test('needs all four checks true', () => {
      problem(pumpWith(undefined), /Confirm the pump checklist/);
      problem(pumpWith(null), /Confirm the pump checklist/);
      problem(pumpWith({}), /Confirm the pump checklist/);
      ['outlet', 'level', 'dry', 'stucco'].forEach((key) => {
        problem(pumpWith({ ...all, [key]: false }), /Confirm the pump checklist/);
        const missing = { ...all };
        delete missing[key];
        problem(pumpWith(missing), /Confirm the pump checklist/);
      });
      expect(validateLayoutPayload(valid(pumpWith(all))).pump.checks).toEqual(all);
    });

    test('rejects an unknown key, a non-boolean value and a non-object', () => {
      problem(pumpWith({ ...all, shade: true }), /unknown key: shade/);
      ['true', 1, 'yes', null, [], {}].forEach((v) => problem(pumpWith({ ...all, level: v }), /level must be true or false/));
      ['yes', true, [true]].forEach((v) => problem(pumpWith(v), /pump checks must be an object/));
    });

    test('stores only the four known keys', () => {
      expect(Object.keys(validateLayoutPayload(valid(pumpWith(all))).pump.checks).sort()).toEqual(['dry', 'level', 'outlet', 'stucco']);
    });
  });

  test('accepts bed lines, which add no nozzles and no eave or fence length, and counts every riser', () => {
    const base = validateLayoutPayload(valid());
    const out = validateLayoutPayload(valid({
      lines: [
        ...valid().lines,
        { id: 'B1', kind: 'bed', points: [{ x: 100, y: 800 }, { x: 900, y: 800 }] },
      ],
      risers: [{ x: 50, y: 60, source: 'manual' }, { x: 100, y: 800, source: 'bed' }, { x: 180, y: 800, source: 'bed' }, { x: 5, y: 5 }],
    }));
    expect(out.lines).toHaveLength(3);
    expect(out.lines[2]).toMatchObject({ id: 'B1', kind: 'bed' });
    expect(out.linearFt).toBe(base.linearFt); // the bed line's 800 px are not eave or fence feet
    expect(out).toMatchObject({ nozzleCount: 3, eaveCount: 2, fenceCount: 1, riserCount: 4 });
    expect(out.risers).toEqual([{ x: 50, y: 60, source: 'manual' }, { x: 100, y: 800, source: 'bed' }, { x: 180, y: 800, source: 'bed' }, { x: 5, y: 5 }]);
  });

  test('a bed riser keeps the bed line it stands on; a line index past the lines, or on a manual riser, is dropped', () => {
    const lines = [...valid().lines, { id: 'B1', kind: 'bed', points: [{ x: 100, y: 800 }, { x: 900, y: 800 }] }];
    const out = validateLayoutPayload(valid({
      lines,
      risers: [
        { x: 100, y: 800, source: 'bed', lineIndex: 2 },
        { x: 150, y: 800, source: 'bed', lineIndex: 9 },
        { x: 160, y: 800, source: 'bed', lineIndex: -1 },
        { x: 170, y: 800, source: 'bed', lineIndex: null },
        { x: 50, y: 60, source: 'manual', lineIndex: 2 },
      ],
    }));
    expect(out.risers).toEqual([
      { x: 100, y: 800, source: 'bed', lineIndex: 2 },
      { x: 150, y: 800, source: 'bed' },
      { x: 160, y: 800, source: 'bed' },
      { x: 170, y: 800, source: 'bed' },
      { x: 50, y: 60, source: 'manual' },
    ]);
  });

  test('a riser source is bed or manual or absent, nothing else', () => {
    ['wall', '', 1, true].forEach((source) => problem({ risers: [{ x: 1, y: 1, source }] }, /risers\[0\] source must be bed or manual/));
    expect(validateLayoutPayload(valid({ risers: [{ x: 1, y: 1, source: null }] })).risers).toEqual([{ x: 1, y: 1 }]);
  });

  test('drops a line index that points past the lines', () => {
    const out = validateLayoutPayload(valid({ lines: [], nozzles: [{ x: 1, y: 1, kind: 'eave', lineIndex: 4 }] }));
    expect(out.nozzles[0].lineIndex).toBeNull();
  });

  test('needs a payload object, a nozzle, and a real map', () => {
    expect(() => validateLayoutPayload(null)).toThrow(/JSON object/);
    expect(() => validateLayoutPayload([])).toThrow(/JSON object/);
    problem({ nozzles: [] }, /at least one nozzle/);
    problem({ center: { lat: 'north', lng: 1 } }, /latitude and longitude/);
    problem({ center: { lat: 91, lng: 1 } }, /latitude and longitude/);
    problem({ zoom: 25 }, /zoom/);
    problem({ zoom: 20.5 }, /zoom/);
    problem({ mapWidth: 640 }, /1280 by 960/);
  });

  test('rejects non-object and non-array shapes', () => {
    problem({ lines: 'nope' }, /lines must be an array/);
    problem({ nozzles: { a: 1 } }, /nozzles must be an array/);
    problem({ lines: ['x'] }, /lines\[0\] must be an object/);
    problem({ zones: [null] }, /zones\[0\] must be an object/);
  });

  test('rejects bad coordinates and points off the map', () => {
    problem({ nozzles: [{ x: 'a', y: 1, kind: 'eave' }] }, /finite x and y/);
    problem({ nozzles: [{ x: NaN, y: 1, kind: 'eave' }] }, /finite x and y/);
    problem({ nozzles: [{ x: 5000, y: 1, kind: 'eave' }] }, /outside the map/);
    problem({ risers: [{ x: 1, y: -50 }] }, /outside the map/);
    problem({ pump: { x: 1 } }, /finite x and y/);
  });

  test('clamps a point a hair outside the frame back onto it', () => {
    const out = validateLayoutPayload(valid({ nozzles: [{ x: -0.5, y: 960.8, kind: 'eave' }] }));
    expect(out.nozzles[0]).toMatchObject({ x: 0, y: 960 });
  });

  test('rejects unknown kinds and a line with fewer than two points', () => {
    problem({ nozzles: [{ x: 1, y: 1, kind: 'roof' }] }, /kind must be eave or fence/);
    problem({ nozzles: [{ x: 1, y: 1, kind: 'bed' }] }, /kind must be eave or fence/); // a bed line carries risers, never nozzles
    problem({ lines: [{ kind: 'wall', points: [{ x: 1, y: 1 }, { x: 2, y: 2 }] }] }, /kind must be eave, fence or bed/);
    problem({ lines: [{ kind: 'eave', points: [{ x: 1, y: 1 }] }] }, /at least 2 points/);
    problem({ zones: [{ kind: 'garden', x: 1, y: 1, radiusFt: 8 }] }, /known no-mist kind/);
  });

  test('bounds the counts and the zone radius', () => {
    const many = (n) => Array.from({ length: n }, (_, i) => ({ x: i % 1200, y: 10, kind: 'eave' }));
    expect(() => validateLayoutPayload(valid({ nozzles: many(MAX_NOZZLES) }))).not.toThrow();
    problem({ nozzles: many(MAX_NOZZLES + 1) }, /nozzles cannot have more than/);
    problem({ risers: Array.from({ length: 201 }, () => ({ x: 1, y: 1 })) }, /risers cannot have more than/);
    problem({ zones: Array.from({ length: 101 }, () => ({ kind: 'pool', x: 1, y: 1, radiusFt: 8 })) }, /zones cannot have more than/);
    problem({ lines: Array.from({ length: 41 }, () => ({ kind: 'eave', points: [{ x: 1, y: 1 }, { x: 2, y: 2 }] })) }, /lines cannot have more than/);
    problem({ lines: [{ kind: 'eave', points: Array.from({ length: 301 }, (_, i) => ({ x: i, y: 1 })) }] }, /points cannot have more than|cannot have more than 300/);
    problem({ zones: [{ kind: 'pool', x: 1, y: 1, radiusFt: 0 }] }, /radiusFt/);
    problem({ zones: [{ kind: 'pool', x: 1, y: 1, radiusFt: 500 }] }, /radiusFt/);
  });

  test('trims the address and caps its length; ids are capped too', () => {
    expect(validateLayoutPayload(valid({ address: `  ${'a'.repeat(400)}  ` })).address).toHaveLength(300);
    expect(validateLayoutPayload(valid({ address: '   ' })).address).toBeNull();
    expect(validateLayoutPayload(valid({ lines: [{ id: 'x'.repeat(100), kind: 'eave', points: [{ x: 1, y: 1 }, { x: 5, y: 5 }] }] })).lines[0].id).toHaveLength(40);
  });
});

describe('looksLikePng', () => {
  test('checks the bytes, not the claimed type', () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
    expect(looksLikePng(png)).toBe(true);
    expect(looksLikePng(Buffer.from('<svg></svg>'))).toBe(false);
    expect(looksLikePng(Buffer.from('GIF89a'))).toBe(false);
    expect(looksLikePng(null)).toBe(false);
    expect(looksLikePng(Buffer.alloc(0))).toBe(false);
  });
});

describe('sameProperty', () => {
  test('ignores case, spacing, punctuation and a trailing ZIP or state', () => {
    expect(sameProperty('500 Example Court, Venice, FL', '500  example court venice fl.')).toBe(true);
    expect(sameProperty('500 Example Court, Venice, FL', '500 Example Court, Venice, FL 34285')).toBe(true);
    expect(sameProperty('500 Example Court, Venice, FL 34285-1234', '500 Example Court, Venice, Florida')).toBe(true);
    expect(sameProperty('500 Example Court, Venice', '500 Example Court, Venice, FL 34285')).toBe(true);
  });
  test('a changed house number, street, direction, unit or city is another property', () => {
    expect(sameProperty('500 Example Court, Venice, FL', '501 Example Court, Venice, FL')).toBe(false);
    expect(sameProperty('500 Example Court, Venice, FL', '500 Example Court, Sarasota, FL')).toBe(false);
    expect(sameProperty('5 Example Court', '50 Example Court')).toBe(false);
    expect(sameProperty('500 Example Court', '500 Example Court East')).toBe(false);
    expect(sameProperty('500 Example Court, Venice, FL', '500 Example Court Unit 2, Venice, FL')).toBe(false);
    expect(sameProperty('500 Example Court, Venice, FL 34285', '500 Example Court, Venice, FL 34292')).toBe(true);
  });
  test('cannot judge without both addresses', () => {
    expect(sameProperty(null, '500 Example Court')).toBe(true);
    expect(sameProperty('500 Example Court', '')).toBe(true);
  });
});
