/**
 * Photo privacy shadow (services/typed-decisions/photo-privacy-shadow.js):
 * gate handling, what Clef is asked, what is recorded. No provider, no database.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const mockAsk = jest.fn();
jest.mock('../services/typed-decisions/jev', () => ({ askPackage: (...a) => mockAsk(...a) }));
const mockRecord = jest.fn();
jest.mock('../services/typed-decisions/shadow-recorder', () => ({ recordDecisions: (...a) => mockRecord(...a) }));

const sharp = require('sharp');
const { shadowSocialPostPhoto } = require('../services/typed-decisions/photo-privacy-shadow');
const { PACKAGES } = require('../services/typed-decisions/packages');
const { isFittedImage } = require('../services/typed-decisions/image-budget');
const { socialPostSubjectHash, socialPostCaption } = require('../services/typed-decisions/subject-hash');

const GATES = ['GATE_TYPED_DECISIONS', 'GATE_TYPED_DECISIONS_CLEF', 'GATE_PHOTO_PRIVACY'];
const before = Object.fromEntries(GATES.map((g) => [g, process.env[g]]));
afterAll(() => { for (const g of GATES) { if (before[g] === undefined) delete process.env[g]; else process.env[g] = before[g]; } });

const POST_ID = '33333333-3333-4333-8333-333333333333';
const IMAGE = 'https://cdn.example.test/tech-field-abc.jpg';
const CAPTIONS = { instagram: 'Lawn day.', facebook: '  Lawn treatment in Bradenton today.  ' };
let photoData;
beforeAll(async () => {
  photoData = (await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 20, g: 120, b: 40 } } }).jpeg().toBuffer()).toString('base64');
});
const answers = () => Object.fromEntries(Object.keys(PACKAGES['photo_privacy.v1'].questions).map((id) => [id, { p: 0.02, yes: false, confident: true }]));
const input = (over = {}) => ({ postId: POST_ID, imageUrl: IMAGE, photoData, captions: CAPTIONS, ...over });

beforeEach(() => {
  mockAsk.mockReset(); mockRecord.mockReset();
  process.env.GATE_TYPED_DECISIONS = 'true';
  process.env.GATE_TYPED_DECISIONS_CLEF = 'true';
  process.env.GATE_PHOTO_PRIVACY = 'shadow';
  mockAsk.mockResolvedValue({ ok: true, answers: answers(), servedModel: 'clef-flash', packageId: 'photo_privacy.v1', provider: 'cloudflare' });
  mockRecord.mockResolvedValue({ recorded: 6, passedOver: 0, sampled: {} });
});

describe('gates', () => {
  test.each([
    ['unset', () => { delete process.env.GATE_PHOTO_PRIVACY; }],
    ['true (not a mode)', () => { process.env.GATE_PHOTO_PRIVACY = 'true'; }],
    ['act (not built)', () => { process.env.GATE_PHOTO_PRIVACY = 'act'; }],
    ['shadow with the Clef leg off', () => { delete process.env.GATE_TYPED_DECISIONS_CLEF; }],
    ['shadow with typed decisions off', () => { delete process.env.GATE_TYPED_DECISIONS; }],
  ])('GATE_PHOTO_PRIVACY %s: nothing is asked or recorded', async (_name, arrange) => {
    arrange();
    expect(await shadowSocialPostPhoto(input())).toEqual({ asked: 0, recorded: 0, failed: 0, skipped: 'gate_off' });
    expect(mockAsk).not.toHaveBeenCalled();
    expect(mockRecord).not.toHaveBeenCalled();
  });
});

describe('shadow', () => {
  test('one photo goes to Clef only, with the fixed state, and six answers are recorded against the post', async () => {
    expect(await shadowSocialPostPhoto(input())).toEqual({ asked: 1, recorded: 6, failed: 0 });
    expect(mockAsk).toHaveBeenCalledTimes(1);
    const [packageId, state, opts] = mockAsk.mock.calls[0];
    expect(packageId).toBe('photo_privacy.v1');
    // the first platform in the fixed order, trimmed
    expect(state).toEqual({ surface: 'social', caption: 'Lawn treatment in Bradenton today.' });
    expect(opts.provider).toBe('cloudflare');
    expect(opts.images).toHaveLength(1);
    expect(isFittedImage(opts.images[0])).toBe(true);

    const [record] = mockRecord.mock.calls[0];
    expect(record).toMatchObject({ capability: 'photo_privacy', provider: 'cloudflare', subjectType: 'social_post', subjectId: POST_ID });
    expect(record.subjectHash).toBe(socialPostSubjectHash({ imageUrl: IMAGE, captions: CAPTIONS }));
    // the publish path has no image check: its answer to every question was "no"
    expect(record.baselines).toEqual(Object.fromEntries(Object.keys(PACKAGES['photo_privacy.v1'].questions).map((id) => [id, { production: false }])));
    // ids and answers only: no image bytes or caption reach the recorder
    expect(JSON.stringify(record)).not.toContain(photoData.slice(0, 40));
    expect(JSON.stringify({ ...record, pkg: undefined })).not.toContain('Bradenton');
  });

  test('the digest matches what the review route rebuilds from the stored row (JSON text)', () => {
    const stored = JSON.stringify(CAPTIONS);
    expect(socialPostCaption(stored)).toBe('Lawn treatment in Bradenton today.');
    expect(socialPostSubjectHash({ imageUrl: IMAGE, captions: stored })).toBe(socialPostSubjectHash({ imageUrl: IMAGE, captions: CAPTIONS }));
    expect(socialPostSubjectHash({ imageUrl: 'https://cdn.example.test/other.jpg', captions: CAPTIONS })).not.toBe(socialPostSubjectHash({ imageUrl: IMAGE, captions: CAPTIONS }));
    expect(socialPostCaption('not json')).toBe('');
    expect(socialPostCaption(null)).toBe('');
  });

  test.each([
    ['no post row', { postId: null }],
    ['photo not hosted', { imageUrl: null }],
    ['no photo', { photoData: '' }],
  ])('%s: skipped before any provider call', async (_name, over) => {
    expect(await shadowSocialPostPhoto(input(over))).toMatchObject({ asked: 0, skipped: 'no_photo' });
    expect(mockAsk).not.toHaveBeenCalled();
  });

  test('bytes that are not an image are skipped, never sent', async () => {
    const out = await shadowSocialPostPhoto(input({ photoData: Buffer.from('not an image').toString('base64') }));
    expect(out).toMatchObject({ asked: 0, recorded: 0 });
    expect(out.skipped).toMatch(/^image_/);
    expect(mockAsk).not.toHaveBeenCalled();
  });

  test('a failed Clef call records nothing', async () => {
    mockAsk.mockResolvedValue({ ok: false, reason: 'error' });
    expect(await shadowSocialPostPhoto(input())).toEqual({ asked: 1, recorded: 0, failed: 1 });
    expect(mockRecord).not.toHaveBeenCalled();
  });

  test('a write the recorder passed over counts as failed', async () => {
    mockRecord.mockResolvedValue({ recorded: 0, skipped: 'gate_off' });
    expect(await shadowSocialPostPhoto(input())).toEqual({ asked: 1, recorded: 0, failed: 1 });
  });
});
