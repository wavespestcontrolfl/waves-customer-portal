/**
 * Shareable lawn card server pieces (GATE_REPORT_WEB_SHARE): the ONE eligibility rule (lawn line, not a
 * callback, the visit's own assessment scores 85+, a front photo), the offer built from it (+ active referral
 * program), and the front photo bytes (upright, at most 1600 px, no metadata).
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/service-report/report-data', () => ({
  loadLinkedLawnAssessment: jest.fn(),
  // The real one maps the row's category scores; here the row carries its overall score directly.
  formatLawnAssessmentScore: jest.fn((row) => (row ? { overallScore: row.overall } : null)),
}));

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

const FRONT = [{ s3_key: 'k/front.jpg', zone: 'front' }];
const lawnService = (extra = {}) => ({ id: 's1', service_type: 'Lawn Care Visit', is_callback: false, ...extra });
const assessmentRow = (overall, id = 'a1') => ({ id, overall });
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

describe('resolveShareEligibility', () => {
  beforeEach(() => { loadLinkedLawnAssessment.mockReset(); loadLinkedLawnAssessment.mockResolvedValue(assessmentRow(88)); });
  const resolve = (service = lawnService(), opts = {}) => webShare.resolveShareEligibility(service, { knex: photosKnex(FRONT), ...opts });

  test('a lawn visit at 85+ with a front photo: score, assessment id and the photo row', async () => {
    expect(await resolve()).toEqual({ score: 88, assessmentId: 'a1', photo: FRONT[0] });
    loadLinkedLawnAssessment.mockResolvedValue(assessmentRow(85));
    expect((await resolve()).score).toBe(85);
    loadLinkedLawnAssessment.mockResolvedValue(assessmentRow(91.4));
    expect((await resolve()).score).toBe(91);
  });

  test('the service line may come from the stored service_line', async () => {
    expect(await resolve({ id: 's1', service_line: 'lawn', service_type: 'Visit' })).not.toBeNull();
  });

  test('a pest (or other non-lawn) visit: null, and no assessment is read', async () => {
    expect(await resolve(lawnService({ service_line: 'pest', service_type: 'Quarterly Pest Control' }))).toBeNull();
    expect(loadLinkedLawnAssessment).not.toHaveBeenCalled();
  });

  test('a callback visit: null', async () => {
    expect(await resolve(lawnService({ is_callback: true }))).toBeNull();
    expect(loadLinkedLawnAssessment).not.toHaveBeenCalled();
  });

  test('84 and under, or no readable score: null', async () => {
    loadLinkedLawnAssessment.mockResolvedValue(assessmentRow(84));
    expect(await resolve()).toBeNull();
    loadLinkedLawnAssessment.mockResolvedValue(assessmentRow(null));
    expect(await resolve()).toBeNull();
    loadLinkedLawnAssessment.mockResolvedValue(assessmentRow(undefined));
    expect(await resolve()).toBeNull();
  });

  test('no front photo (other zone, pending upload, none): null', async () => {
    expect(await resolve(lawnService(), { knex: photosKnex([{ s3_key: 'k/back.jpg', zone: 'back' }]) })).toBeNull();
    expect(await resolve(lawnService(), { knex: photosKnex([{ s3_key: 'pending/x.jpg', zone: 'front' }]) })).toBeNull();
    expect(await resolve(lawnService(), { knex: photosKnex([]) })).toBeNull();
  });

  test('no linked assessment: null', async () => {
    loadLinkedLawnAssessment.mockResolvedValue(null);
    expect(await resolve()).toBeNull();
  });

  test('picks the first front photo in report order; only customer-visible rows of THAT assessment are read', async () => {
    const knex = photosKnex([
      { s3_key: 'k/back.jpg', zone: 'back' },
      { s3_key: 'k/front.jpg', zone: ' Front ' },
      { s3_key: 'k/front2.jpg', zone: 'front' },
    ]);
    expect((await webShare.resolveShareEligibility(lawnService(), { knex })).photo.s3_key).toBe('k/front.jpg');
    expect(knex().where).toHaveBeenCalledWith({ assessment_id: 'a1', customer_visible: true });
  });

  test('a requested assessment must be this visit\'s own assessment', async () => {
    expect((await resolve(lawnService(), { requestedAssessmentId: 'a1' })).assessmentId).toBe('a1');
    expect(await resolve(lawnService(), { requestedAssessmentId: 'someone-elses' })).toBeNull();
  });

  test('a read failure throws (callers answer their own failure)', async () => {
    loadLinkedLawnAssessment.mockRejectedValue(new Error('db down'));
    await expect(resolve()).rejects.toThrow();
  });
});

describe('buildWebShare', () => {
  beforeEach(() => { loadLinkedLawnAssessment.mockReset(); loadLinkedLawnAssessment.mockResolvedValue(assessmentRow(88)); });
  const build = (payload = {}, opts = {}) => webShare.buildWebShare(payload, lawnService(), { knex: photosKnex(FRONT), referralEngine: activeProgram, ...opts });

  test('an eligible visit: the score and the assessment it scored', async () => {
    expect(await build()).toEqual({ score: 88, assessmentId: 'a1' });
  });

  test('an internal-only payload or an ineligible visit: no offer', async () => {
    expect(await build({ internalOnly: true })).toBeNull();
    loadLinkedLawnAssessment.mockResolvedValue(assessmentRow(70));
    expect(await build()).toBeNull();
  });

  test('inactive or unreadable referral program: no offer', async () => {
    expect(await build({}, { referralEngine: { getLiveSettings: jest.fn().mockResolvedValue({ program_active: false }) } })).toBeNull();
    expect(await build({}, { referralEngine: { getLiveSettings: jest.fn().mockResolvedValue(null) } })).toBeNull();
    await expect(build({}, { referralEngine: { getLiveSettings: jest.fn().mockRejectedValue(new Error('x')) } })).rejects.toThrow();
  });

  test('the offer carries nothing but the score and the assessment id', async () => {
    expect(Object.keys(await build({ customerName: 'Pat Tester', address: '1 Main St' })).sort()).toEqual(['assessmentId', 'score']);
  });
});

describe('attachWebShare', () => {
  const onGates = { reportSimpleWebLive: () => true, reportWebShareLive: () => true };
  const service = lawnService();
  beforeEach(() => { loadLinkedLawnAssessment.mockReset(); loadLinkedLawnAssessment.mockResolvedValue(assessmentRow(95)); });

  test('gate off (or simple web off): the payload is untouched and nothing is read', async () => {
    const payload = {};
    await webShare.attachWebShare(payload, service, { reportSimpleWebLive: () => true, reportWebShareLive: () => false });
    await webShare.attachWebShare(payload, service, { reportSimpleWebLive: () => false, reportWebShareLive: () => true });
    expect('webShare' in payload).toBe(false);
    expect(loadLinkedLawnAssessment).not.toHaveBeenCalled();
  });

  test('an internal-only payload is untouched', async () => {
    const payload = { internalOnly: true };
    await webShare.attachWebShare(payload, service, onGates);
    expect('webShare' in payload).toBe(false);
  });

  test('a read failure leaves the page as it is', async () => {
    loadLinkedLawnAssessment.mockRejectedValue(Object.assign(new Error('db down'), { code: 'ECONN' }));
    const payload = {};
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
