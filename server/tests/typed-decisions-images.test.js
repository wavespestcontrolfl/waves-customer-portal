// askPackage image rules: images ride only a package that declares imageSlots,
// only to Clef, never more than the slots. No shipped package declares
// imageSlots, so every existing package refuses images.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const mockDispatch = jest.fn();
jest.mock('../services/llm/call', () => ({ dispatch: (...a) => mockDispatch(...a), rejectCall: jest.fn() }));
jest.mock('../services/typed-decisions/packages', () => {
  const actual = jest.requireActual('../services/typed-decisions/packages');
  const pkg = actual.PACKAGES['sms_courtesy.v1'];
  const withSlots = (slots) => Object.freeze({ ...pkg, id: `photo_check_${slots}.v1`, imageSlots: slots });
  const extra = { 'photo_check_2.v1': withSlots(2), 'photo_check_0.v1': withSlots(0), 'photo_check_x.v1': Object.freeze({ ...pkg, id: 'photo_check_x.v1', imageSlots: '2' }) };
  return { ...actual, packageFor: (id) => extra[id] || actual.packageFor(id) };
});

const { askPackage } = require('../services/typed-decisions/jev');
const { PACKAGES, packageHash } = require('../services/typed-decisions/packages');
const { ROUTES } = require('../config/models');
const fixtureHashes = require('../fixtures/typed-decisions/package-hashes.json');

const STATE = { previous_waves_text: null, customer_text: 'synthetic text' };
const IMG = 'data:image/jpeg;base64,AAAA';
const OK = { ok: true, json: { is_courtesy_only: { type: 'noul', noul: 0.1 } }, servedModel: 'clef-flash' };

describe('askPackage images', () => {
  const saved = { main: process.env.GATE_TYPED_DECISIONS, clef: process.env.GATE_TYPED_DECISIONS_CLEF };
  beforeEach(() => { mockDispatch.mockReset(); mockDispatch.mockResolvedValue(OK); process.env.GATE_TYPED_DECISIONS = 'true'; process.env.GATE_TYPED_DECISIONS_CLEF = 'true'; });
  afterAll(() => {
    if (saved.main === undefined) delete process.env.GATE_TYPED_DECISIONS; else process.env.GATE_TYPED_DECISIONS = saved.main;
    if (saved.clef === undefined) delete process.env.GATE_TYPED_DECISIONS_CLEF; else process.env.GATE_TYPED_DECISIONS_CLEF = saved.clef;
  });

  test('no shipped package declares imageSlots, so each refuses images before any provider call', async () => {
    for (const pkg of Object.values(PACKAGES)) expect(pkg.imageSlots).toBeUndefined();
    const result = await askPackage('sms_courtesy.v1', STATE, { provider: 'cloudflare', images: [IMG] });
    expect(result).toMatchObject({ ok: false, reason: 'images_not_allowed', packageId: 'sms_courtesy.v1' });
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  test('a package with imageSlots still refuses Jev (typesafe) images, and an unknown-provider is not a way around it', async () => {
    expect(await askPackage('photo_check_2.v1', STATE, { images: [IMG] })).toMatchObject({ ok: false, reason: 'images_not_allowed' });
    expect(await askPackage('photo_check_2.v1', STATE, { provider: 'typesafe', images: [IMG] })).toMatchObject({ ok: false, reason: 'images_not_allowed' });
    expect(await askPackage('photo_check_2.v1', STATE, { provider: 'mystery', images: [IMG] })).toMatchObject({ ok: false, reason: 'unknown_provider' });
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  test('more images than the package has slots is refused; so is a non-positive or non-integer imageSlots', async () => {
    expect(await askPackage('photo_check_2.v1', STATE, { provider: 'cloudflare', images: [IMG, IMG, IMG] })).toMatchObject({ ok: false, reason: 'images_not_allowed' });
    expect(await askPackage('photo_check_0.v1', STATE, { provider: 'cloudflare', images: [IMG] })).toMatchObject({ ok: false, reason: 'images_not_allowed' });
    expect(await askPackage('photo_check_x.v1', STATE, { provider: 'cloudflare', images: [IMG] })).toMatchObject({ ok: false, reason: 'images_not_allowed' });
    expect(await askPackage('photo_check_2.v1', STATE, { provider: 'cloudflare', images: IMG })).toMatchObject({ ok: false, reason: 'images_not_allowed' });
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  test('Clef with a package that declares slots passes the images through the Clef route', async () => {
    const result = await askPackage('photo_check_2.v1', STATE, { provider: 'cloudflare', images: [IMG, IMG] });
    expect(result.ok).toBe(true);
    expect(mockDispatch).toHaveBeenCalledWith(ROUTES.typedDecisionClef, expect.objectContaining({ images: [IMG, IMG], laneId: 'typed_decisions_clef' }));
  });

  test('without images the dispatch payload has no images key at all (existing callers unchanged)', async () => {
    for (const images of [undefined, null, []]) {
      mockDispatch.mockClear();
      await askPackage('photo_check_2.v1', STATE, { provider: 'cloudflare', images });
      expect(Object.keys(mockDispatch.mock.calls[0][1])).not.toContain('images');
    }
    await askPackage('sms_courtesy.v1', STATE, { provider: 'cloudflare', images: [] });
    expect(Object.keys(mockDispatch.mock.calls.at(-1)[1])).not.toContain('images');
  });

  test('imageSlots changes the hash only for a package that declares it; every shipped hash is unchanged', () => {
    for (const [id, pkg] of Object.entries(PACKAGES)) expect(packageHash(pkg)).toBe(fixtureHashes[id]);
    const pkg = PACKAGES['sms_courtesy.v1'];
    expect(packageHash({ ...pkg, imageSlots: 2 })).not.toBe(packageHash(pkg));
    expect(packageHash({ ...pkg, imageSlots: 2 })).not.toBe(packageHash({ ...pkg, imageSlots: 3 }));
  });
});
