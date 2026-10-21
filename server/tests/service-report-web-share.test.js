/**
 * Shareable lawn card server pieces (GATE_REPORT_WEB_SHARE): the offer rule
 * (lawn, score 85+, front photo, active referral program, no callback) and the
 * front photo bytes (upright, at most 1600 px, no metadata).
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/service-report/report-data', () => ({ loadLinkedLawnAssessment: jest.fn() }));

const sharp = require('sharp');
const { loadLinkedLawnAssessment } = require('../services/service-report/report-data');
const webShare = require('../services/service-report/web-share');

function photosKnex(rows) {
  const q = {
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    select: jest.fn().mockResolvedValue(rows),
  };
  return jest.fn(() => q);
}

const lawnPayload = (score, extra = {}) => ({ serviceLine: 'lawn', reportV2: { snapshot: { overallScore: score } }, ...extra });
const activeProgram = { getLiveSettings: jest.fn().mockResolvedValue({ program_active: true }) };

describe('webShareEnabled', () => {
  test('needs both gates, and a partial gates module reads as off', () => {
    expect(webShare.webShareEnabled({ reportSimpleWebLive: () => true, reportWebShareLive: () => true })).toBe(true);
    expect(webShare.webShareEnabled({ reportSimpleWebLive: () => true, reportWebShareLive: () => false })).toBe(false);
    expect(webShare.webShareEnabled({ reportSimpleWebLive: () => false, reportWebShareLive: () => true })).toBe(false);
    expect(webShare.webShareEnabled({ reportSimpleWebLive: () => true })).toBe(false);
    expect(webShare.webShareEnabled({})).toBe(false);
  });
});

describe('findShareFrontPhoto', () => {
  beforeEach(() => loadLinkedLawnAssessment.mockResolvedValue({ id: 'a1' }));

  test('picks the first front photo in the report order, only customer-visible rows are read', async () => {
    const knex = photosKnex([
      { s3_key: 'k/back.jpg', zone: 'back' },
      { s3_key: 'k/front.jpg', zone: ' Front ' },
      { s3_key: 'k/front2.jpg', zone: 'front' },
    ]);
    const row = await webShare.findShareFrontPhoto({ id: 's1' }, { knex });
    expect(row.s3_key).toBe('k/front.jpg');
    expect(knex().where).toHaveBeenCalledWith({ assessment_id: 'a1', customer_visible: true });
  });

  test('no front photo, a pending upload, or no assessment = null', async () => {
    expect(await webShare.findShareFrontPhoto({ id: 's1' }, { knex: photosKnex([{ s3_key: 'k/back.jpg', zone: 'back' }]) })).toBeNull();
    expect(await webShare.findShareFrontPhoto({ id: 's1' }, { knex: photosKnex([{ s3_key: 'pending/x.jpg', zone: 'front' }]) })).toBeNull();
    loadLinkedLawnAssessment.mockResolvedValue(null);
    expect(await webShare.findShareFrontPhoto({ id: 's1' }, { knex: photosKnex([]) })).toBeNull();
  });
});

describe('buildWebShare', () => {
  const knex = photosKnex([{ s3_key: 'k/front.jpg', zone: 'front' }]);
  beforeEach(() => loadLinkedLawnAssessment.mockResolvedValue({ id: 'a1' }));
  const build = (payload, opts = {}) => webShare.buildWebShare(payload, { id: 's1' }, { knex, referralEngine: activeProgram, ...opts });

  test('85 and up with a front photo: the score is offered', async () => {
    expect(await build(lawnPayload(85))).toEqual({ score: 85 });
    expect(await build(lawnPayload(91.4))).toEqual({ score: 91 });
  });

  test('84 and under: no offer', async () => {
    expect(await build(lawnPayload(84))).toBeNull();
    expect(await build(lawnPayload(null))).toBeNull();
    expect(await build({ serviceLine: 'lawn' })).toBeNull();
  });

  test('not a lawn report, an internal-only report or a callback visit: no offer', async () => {
    expect(await build(lawnPayload(95, { serviceLine: 'pest' }))).toBeNull();
    expect(await build(lawnPayload(95, { internalOnly: true }))).toBeNull();
    expect(await build(lawnPayload(95, { isCallback: true }))).toBeNull();
  });

  test('no front photo: no offer', async () => {
    expect(await build(lawnPayload(95), { knex: photosKnex([{ s3_key: 'k/back.jpg', zone: 'back' }]) })).toBeNull();
  });

  test('inactive or unreadable referral program: no offer', async () => {
    expect(await build(lawnPayload(95), { referralEngine: { getLiveSettings: jest.fn().mockResolvedValue({ program_active: false }) } })).toBeNull();
    expect(await build(lawnPayload(95), { referralEngine: { getLiveSettings: jest.fn().mockResolvedValue(null) } })).toBeNull();
    await expect(build(lawnPayload(95), { referralEngine: { getLiveSettings: jest.fn().mockRejectedValue(new Error('x')) } })).rejects.toThrow();
  });

  test('the offer carries nothing but the score', async () => {
    expect(Object.keys(await build(lawnPayload(90, { customerName: 'Pat Tester', address: '1 Main St' })))).toEqual(['score']);
  });
});

describe('attachWebShare', () => {
  const onGates = { reportSimpleWebLive: () => true, reportWebShareLive: () => true };
  const service = { id: 's1' };
  beforeEach(() => { loadLinkedLawnAssessment.mockReset(); loadLinkedLawnAssessment.mockResolvedValue({ id: 'a1' }); });

  test('gate off (or simple web off): the payload is untouched and nothing is read', async () => {
    const payload = lawnPayload(95);
    await webShare.attachWebShare(payload, service, { reportSimpleWebLive: () => true, reportWebShareLive: () => false });
    await webShare.attachWebShare(payload, service, { reportSimpleWebLive: () => false, reportWebShareLive: () => true });
    expect('webShare' in payload).toBe(false);
    expect(loadLinkedLawnAssessment).not.toHaveBeenCalled();
  });

  test('an internal-only payload is untouched', async () => {
    const payload = lawnPayload(95, { internalOnly: true });
    await webShare.attachWebShare(payload, service, onGates);
    expect('webShare' in payload).toBe(false);
  });

  test('a read failure leaves the page as it is', async () => {
    loadLinkedLawnAssessment.mockRejectedValue(Object.assign(new Error('db down'), { code: 'ECONN' }));
    const payload = lawnPayload(95);
    await expect(webShare.attachWebShare(payload, service, onGates)).resolves.toBeUndefined();
    expect('webShare' in payload).toBe(false);
  });
});

describe('readSharePhoto', () => {
  test('returns an upright JPEG, at most 1600 px, with no EXIF or GPS', async () => {
    const source = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: '#3a7d2c' } })
      .withExif({ IFD0: { Copyright: 'Pat Tester 1 Main St' } })
      .jpeg()
      .toBuffer();
    expect((await sharp(source).metadata()).exif).toBeTruthy();
    const out = await webShare.readSharePhoto({ s3_key: 'k/front.jpg' }, { photoService: { getPhotoBuffer: jest.fn().mockResolvedValue({ buffer: source }) } });
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe('jpeg');
    expect(Math.max(meta.width, meta.height)).toBe(1600);
    expect(meta.exif).toBeUndefined();
  });

  test('a small photo is not enlarged', async () => {
    const source = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#fff' } }).jpeg().toBuffer();
    const out = await webShare.readSharePhoto({ s3_key: 'k' }, { photoService: { getPhotoBuffer: async () => ({ buffer: source }) } });
    expect((await sharp(out).metadata()).width).toBe(800);
  });
});
