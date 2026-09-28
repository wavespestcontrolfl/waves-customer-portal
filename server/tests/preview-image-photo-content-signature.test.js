/**
 * GATE_REPORT_PHOTO_CONTENT + the chosen photo's identity must join the SMS
 * preview cache key (owner pre-push P1, 2026-09-27) — otherwise flipping the
 * gate, or the eligible photo set changing, could keep serving a preview
 * built under the OLD state.
 */
const {
  computeSmsPreviewInputHash,
} = require('../services/service-report/preview-image');

describe('computeSmsPreviewInputHash — photo-content gate + photo-set identity', () => {
  const baseInputs = {
    recordId: 'record-1',
    token: 'token-1',
    dynamicContext: { pressureTrend: { customerSummary: 'steady' } },
    currentPressureIndexOverride: null,
  };

  test('same inputs (including the same photoContentSignature) → same identity', () => {
    const a = computeSmsPreviewInputHash({ ...baseInputs, photoContentSignature: '-pgon-ph2-abcd1234' });
    const b = computeSmsPreviewInputHash({ ...baseInputs, photoContentSignature: '-pgon-ph2-abcd1234' });
    expect(a).toBe(b);
  });

  test('gate off vs on (bare flip, same photo set otherwise) → different identity', () => {
    const gateOff = computeSmsPreviewInputHash({ ...baseInputs, photoContentSignature: '' });
    const gateOn = computeSmsPreviewInputHash({ ...baseInputs, photoContentSignature: '-pgon-ph1-aaaa1111' });
    expect(gateOff).not.toBe(gateOn);
  });

  test('gate on, photo set changes (added/removed/reordered row) → different identity', () => {
    const twoPhotos = computeSmsPreviewInputHash({ ...baseInputs, photoContentSignature: '-pgon-ph2-abcd1234' });
    const threePhotos = computeSmsPreviewInputHash({ ...baseInputs, photoContentSignature: '-pgon-ph3-ef567890' });
    expect(twoPhotos).not.toBe(threePhotos);
  });

  test('a bare gate-off render (default signature) never moves relative to the pre-feature identity', () => {
    // A caller that omits photoContentSignature entirely (legacy shape, or
    // the gate simply off) defaults to '' — same identity as an explicit
    // gate-off call, never a stray unique value.
    const omitted = computeSmsPreviewInputHash({ ...baseInputs });
    const explicitOff = computeSmsPreviewInputHash({ ...baseInputs, photoContentSignature: '' });
    expect(omitted).toBe(explicitOff);
  });

  test('every other input held constant, only recordId differs → different identity (sanity: the hash is not constant-folded)', () => {
    const one = computeSmsPreviewInputHash({ ...baseInputs, recordId: 'record-1', photoContentSignature: '-pgon-ph1-aaaa1111' });
    const two = computeSmsPreviewInputHash({ ...baseInputs, recordId: 'record-2', photoContentSignature: '-pgon-ph1-aaaa1111' });
    expect(one).not.toBe(two);
  });
});

describe('buildAndStoreSmsPreviewImage — wires the gate + photo-set signature into the lookup/store key', () => {
  let reportPhotoContentLive;
  let reportPhotoSetPdfSignature;

  beforeEach(() => {
    jest.resetModules();
    jest.doMock('../config', () => ({ s3: { bucket: 'test-bucket', region: 'us-east-1' } }));
    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
    jest.doMock('@aws-sdk/client-s3', () => ({
      S3Client: jest.fn().mockImplementation(() => ({ send: jest.fn().mockResolvedValue({}) })),
      PutObjectCommand: jest.fn(),
    }));
    jest.doMock('../config/feature-gates', () => ({
      reportPhotoContentLive: jest.fn(),
    }));
    jest.doMock('../services/service-report/photo-set-signature', () => ({
      reportPhotoSetPdfSignature: jest.fn(),
    }));
    jest.doMock('../services/service-report/pdf', () => ({
      launchBrowser: jest.fn().mockRejectedValue(new Error('render path not exercised by this test')),
      serviceReportViewerUrl: jest.fn(() => 'https://example.test/report/token-1?mode=sms_preview'),
    }));

    reportPhotoContentLive = require('../config/feature-gates').reportPhotoContentLive;
    reportPhotoSetPdfSignature = require('../services/service-report/photo-set-signature').reportPhotoSetPdfSignature;
  });

  afterEach(() => jest.dontMock('../config/feature-gates'));

  async function capturedLookupWhereArgs({ gateOn, photoSetSignature }) {
    reportPhotoContentLive.mockReturnValue(gateOn);
    reportPhotoSetPdfSignature.mockResolvedValue(photoSetSignature);
    const { buildAndStoreSmsPreviewImage } = require('../services/service-report/preview-image');
    const lookupChain = { where: jest.fn().mockReturnThis(), first: jest.fn().mockResolvedValue(null) };
    const knex = jest.fn(() => lookupChain);
    // The render path itself throws (launchBrowser rejects) — buildAndStoreSmsPreviewImage
    // propagates that, but the lookup `where(...)` call (what we're asserting on)
    // happens BEFORE the render, so it's already captured.
    await buildAndStoreSmsPreviewImage({
      recordId: 'record-1', token: 'token-1', dynamicContext: {}, knex,
    }).catch(() => null);
    return lookupChain.where.mock.calls[0][0];
  }

  test('gate off → photo-set signature is never read (no extra query), lookup key carries no photo signature', async () => {
    const whereArgs = await capturedLookupWhereArgs({ gateOn: false, photoSetSignature: '-ph1-aaaa1111' });
    expect(reportPhotoSetPdfSignature).not.toHaveBeenCalled();
    expect(whereArgs.input_hash).toBe(require('../services/service-report/preview-image').computeSmsPreviewInputHash({
      recordId: 'record-1', token: 'token-1', dynamicContext: {}, currentPressureIndexOverride: undefined, photoContentSignature: '',
    }));
  });

  test('gate on → the photo-set signature is read and folded into the lookup key', async () => {
    const whereArgs = await capturedLookupWhereArgs({ gateOn: true, photoSetSignature: '-ph2-abcd1234' });
    expect(reportPhotoSetPdfSignature).toHaveBeenCalledWith('record-1', expect.anything());
    expect(whereArgs.input_hash).toBe(require('../services/service-report/preview-image').computeSmsPreviewInputHash({
      recordId: 'record-1', token: 'token-1', dynamicContext: {}, currentPressureIndexOverride: undefined, photoContentSignature: '-pgon-ph2-abcd1234',
    }));
  });

  test('gate on vs off (otherwise identical inputs) → different lookup keys', async () => {
    const off = await capturedLookupWhereArgs({ gateOn: false, photoSetSignature: '-ph2-abcd1234' });
    const on = await capturedLookupWhereArgs({ gateOn: true, photoSetSignature: '-ph2-abcd1234' });
    expect(off.input_hash).not.toBe(on.input_hash);
  });
});
