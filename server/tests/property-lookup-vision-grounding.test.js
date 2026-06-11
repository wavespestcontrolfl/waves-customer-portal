const { _private } = require('../routes/property-lookup-v2');

const {
  buildParcelOverlayParam,
  buildSatelliteVisionPrompt,
  buildVisionContext,
  imageWidthFt,
  visionContextPromptBlock,
} = _private;

// ~100ft square near lat 27.5, [lng, lat] GIS ring order.
const FT = 1 / (111320 * 3.28084);
const LAT0 = 27.5;
const LNG_FT = FT / Math.cos((LAT0 * Math.PI) / 180);
function squareRing(lat, lng, sizeFt) {
  return [
    [lng, lat],
    [lng + sizeFt * LNG_FT, lat],
    [lng + sizeFt * LNG_FT, lat + sizeFt * FT],
    [lng, lat + sizeFt * FT],
    [lng, lat],
  ];
}

describe('imageWidthFt', () => {
  it('matches the Web Mercator ground resolution', () => {
    // zoom 20 at the equator: 156543.03392 / 2^20 * 640 * 3.28084 ≈ 313.5 ft
    expect(imageWidthFt(20, 0)).toBeCloseTo(313.5, 0);
    // cos(60°) = 0.5 halves the width
    expect(imageWidthFt(20, 60)).toBeCloseTo(imageWidthFt(20, 0) / 2, 1);
    // each zoom level halves the width
    expect(imageWidthFt(19, 27.5)).toBeCloseTo(imageWidthFt(20, 27.5) * 2, 1);
  });
});

describe('buildParcelOverlayParam', () => {
  it('builds a closed red path in lat,lng order', () => {
    const param = buildParcelOverlayParam([squareRing(LAT0, -82.5, 100)]);
    expect(param).toMatch(/^path=/);
    const decoded = decodeURIComponent(param.slice('path='.length));
    const segments = decoded.split('|');
    expect(segments[0]).toBe('color:0xff0000ff');
    expect(segments[1]).toBe('weight:3');
    // lat,lng order (lat first ≈ 27.5)
    expect(segments[2]).toMatch(/^27\.5/);
    // ring closed: first point repeated at the end
    expect(segments[2]).toBe(segments[segments.length - 1]);
  });

  it('uses the outer ring of a polygon with holes', () => {
    const outer = squareRing(LAT0, -82.5, 100);
    const hole = [...squareRing(LAT0 + 25 * FT, -82.5 + 25 * LNG_FT, 30)].reverse();
    const withHoles = buildParcelOverlayParam([hole, outer]);
    const onlyOuter = buildParcelOverlayParam([outer]);
    expect(withHoles).toBe(onlyOuter);
  });

  it('caps vertices at 100 and survives huge rings', () => {
    const huge = Array.from({ length: 5000 }, (_, i) => {
      const angle = (i / 5000) * 2 * Math.PI;
      return [-82.5 + Math.cos(angle) * 200 * LNG_FT, LAT0 + Math.sin(angle) * 200 * FT];
    });
    huge.push(huge[0]);
    const param = buildParcelOverlayParam([huge]);
    const points = decodeURIComponent(param.slice('path='.length)).split('|').slice(2);
    expect(points.length).toBeLessThanOrEqual(101); // ≤100 + closing point
    expect(param.length).toBeLessThan(3000);
  });

  it('returns null on missing or degenerate polygons', () => {
    expect(buildParcelOverlayParam(null)).toBeNull();
    expect(buildParcelOverlayParam([])).toBeNull();
    expect(buildParcelOverlayParam([[[1, 2], [3, 4]]])).toBeNull();
  });
});

describe('buildVisionContext', () => {
  const satellite = {
    lat: 27.5,
    lng: -82.5,
    _microCloseB64: 'x',
    _ultraCloseB64: null,
    _superCloseB64: 'x',
    _closeB64: 'x',
    _wideB64: 'x',
    _parcelOverlayApplied: true,
  };

  it('emits scale lines only for present images', () => {
    const ctx = buildVisionContext(satellite, { polygonAreaSqft: 10000 });
    expect(ctx.scaleLines.length).toBe(4);
    expect(ctx.scaleLines[0]).toContain('MICRO CLOSE');
    expect(ctx.scaleLines.some((line) => line.includes('ULTRA CLOSE'))).toBe(false);
    expect(ctx.scaleLines[0]).toMatch(/~\d+ ft across/);
    expect(ctx.hasParcelOutline).toBe(true);
    expect(ctx.parcelAreaSqft).toBe(10000);
  });

  it('handles missing satellite or parcel gracefully', () => {
    expect(buildVisionContext(null, null)).toBeNull();
    const ctx = buildVisionContext({ ...satellite, _parcelOverlayApplied: false }, null);
    expect(ctx.hasParcelOutline).toBe(false);
    expect(ctx.parcelAreaSqft).toBeNull();
  });
});

describe('vision prompt wording', () => {
  const baseCtx = {
    scaleLines: ['- CLOSE (zoom 19): ~556 ft across'],
    hasParcelOutline: true,
    parcelAreaSqft: 10043,
  };

  it('includes scale, outline rule, and turf bound when outlined', () => {
    const block = visionContextPromptBlock(baseCtx);
    expect(block).toContain('IMAGE SCALE');
    expect(block).toContain('~556 ft across');
    expect(block).toContain('outlined in RED');
    expect(block).toContain('Measure ONLY inside the red outline');
    expect(block).toContain('~10043 sq ft');
    expect(block).toContain('estimatedTurfSf MUST be below');
  });

  it('omits the outline block when the overlay was not applied', () => {
    const block = visionContextPromptBlock({ ...baseCtx, hasParcelOutline: false });
    expect(block).toContain('IMAGE SCALE');
    expect(block).not.toContain('outlined in RED');
    expect(block).not.toContain('estimatedTurfSf MUST be below');
  });

  it('is empty without context (today\'s prompt restored)', () => {
    expect(visionContextPromptBlock(null)).toBe('');
  });

  it('threads into the shared OpenAI/Gemini prompt', () => {
    const withCtx = buildSatelliteVisionPrompt('123 Main St', null, baseCtx);
    expect(withCtx).toContain('IMAGE SCALE');
    expect(withCtx).toContain('outlined in RED');
    const without = buildSatelliteVisionPrompt('123 Main St', null);
    expect(without).not.toContain('IMAGE SCALE');
    expect(without).toContain('Return ONLY valid JSON');
  });
});

describe('performPropertyLookup overlay separation', () => {
  // The vision-fetched images carry the parcel path; the client-facing URLs
  // stay clean. Heavy stubbing: geocode + 5 static-map fetches; no AI keys so
  // vision/stories are skipped.
  jest.resetModules();
  jest.mock('../services/property-lookup/ai-property-lookup', () => {
    const actual = jest.requireActual('../services/property-lookup/ai-property-lookup');
    return {
      ...actual,
      lookupPropertyFromAITrio: jest.fn(async () => ({
        formattedAddress: '2965 Rock Creek Dr, Port Charlotte, FL 33948',
        squareFootage: 1348,
        lotSize: 10043,
        propertyType: 'Single Family',
        stories: 1,
        _provider: 'charlotte_pao',
        _source: 'county',
        _parcel: {
          parcelId: '402217351013',
          county: 'Charlotte',
          polygon: [(() => {
            const FT2 = 1 / (111320 * 3.28084);
            const LNGFT2 = FT2 / Math.cos((26.99 * Math.PI) / 180);
            return [
              [-82.139, 26.9897],
              [-82.139 + 100 * LNGFT2, 26.9897],
              [-82.139 + 100 * LNGFT2, 26.9897 + 100 * FT2],
              [-82.139, 26.9897 + 100 * FT2],
              [-82.139, 26.9897],
            ];
          })()],
          polygonAreaSqft: 10043,
        },
      })),
      lookupStoriesFromAI: jest.fn(async () => null),
    };
  });

  const savedEnv = {};
  const KEYS = ['GOOGLE_MAPS_API_KEY', 'GOOGLE_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'PROPERTY_LOOKUP_PARCEL_OVERLAY'];
  const originalFetch = global.fetch;

  beforeEach(() => {
    for (const key of KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.GOOGLE_MAPS_API_KEY = 'test-maps-key';
  });

  afterEach(() => {
    global.fetch = originalFetch;
    for (const key of KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it('overlays vision fetches but keeps client URLs clean', async () => {
    const fetchedUrls = [];
    global.fetch = jest.fn(async (url) => {
      const urlText = String(url);
      fetchedUrls.push(urlText);
      if (urlText.includes('geocode')) {
        return {
          ok: true,
          json: async () => ({
            status: 'OK',
            results: [{
              formatted_address: '2965 Rock Creek Dr, Port Charlotte, FL 33948, USA',
              geometry: { location: { lat: 26.9897, lng: -82.139 }, location_type: 'ROOFTOP' },
              address_components: [],
            }],
          }),
        };
      }
      if (urlText.includes('staticmap')) {
        return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) };
      }
      throw new Error(`unexpected fetch: ${urlText}`);
    });

    const { performPropertyLookup } = require('../routes/property-lookup-v2');
    const result = await performPropertyLookup('2965 Rock Creek Dr, Port Charlotte, FL 33948');

    const staticMapFetches = fetchedUrls.filter((u) => u.includes('staticmap'));
    expect(staticMapFetches.length).toBe(5);
    expect(staticMapFetches.every((u) => u.includes('path='))).toBe(true);

    expect(result.satellite._parcelOverlayApplied).toBe(true);
    for (const key of ['microCloseUrl', 'ultraCloseUrl', 'superCloseUrl', 'closeUrl', 'wideUrl']) {
      expect(result.satellite[key]).not.toContain('path=');
    }
  });

  it('kill switch removes the overlay from vision fetches', async () => {
    process.env.PROPERTY_LOOKUP_PARCEL_OVERLAY = '0';
    const fetchedUrls = [];
    global.fetch = jest.fn(async (url) => {
      const urlText = String(url);
      fetchedUrls.push(urlText);
      if (urlText.includes('geocode')) {
        return {
          ok: true,
          json: async () => ({
            status: 'OK',
            results: [{
              formatted_address: '2965 Rock Creek Dr, Port Charlotte, FL 33948, USA',
              geometry: { location: { lat: 26.9897, lng: -82.139 }, location_type: 'ROOFTOP' },
              address_components: [],
            }],
          }),
        };
      }
      if (urlText.includes('staticmap')) {
        return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) };
      }
      throw new Error(`unexpected fetch: ${urlText}`);
    });

    const { performPropertyLookup } = require('../routes/property-lookup-v2');
    const result = await performPropertyLookup('2965 Rock Creek Dr, Port Charlotte, FL 33948');

    const staticMapFetches = fetchedUrls.filter((u) => u.includes('staticmap'));
    expect(staticMapFetches.length).toBe(5);
    expect(staticMapFetches.every((u) => !u.includes('path='))).toBe(true);
    expect(result.satellite._parcelOverlayApplied).toBe(false);
  });
});
