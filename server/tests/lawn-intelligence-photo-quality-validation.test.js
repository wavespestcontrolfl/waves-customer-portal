// lawn-intelligence.js assessPhotoQuality's dispatchWithFallback validate
// hook (Codex reviewer finding on #4884): sharpness / lawn_coverage_pct /
// lighting are documented 0-100 (PHOTO_QUALITY_SCHEMA) but only typed
// `integer` in the JSON schema — an out-of-range value (e.g. 900, or a
// negative number) previously passed straight through into the weighted
// score and could win/lose is_best_photo on a bogus number. Fixed with a
// validate hook requiring each of the three to be an integer in [0,100].
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../config/models', () => ({ TEXT_POLICIES: { visionAnalysis: { name: 'visionAnalysis' } } }));
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn() }));
jest.mock('../utils/datetime-et', () => ({ etDateString: jest.fn() }));
jest.mock('../services/sms-template-renderer', () => ({ renderRequiredSmsTemplate: jest.fn() }));
jest.mock('../services/lawn-visit-runs', () => ({}));

const { dispatchWithFallback } = require('../services/llm/call');
const { assessPhotoQuality } = require('../services/lawn-intelligence');

beforeEach(() => jest.clearAllMocks());

async function capturedValidate() {
  dispatchWithFallback.mockResolvedValue({ ok: true, json: { sharpness: 80, lawn_coverage_pct: 70, lighting: 60, issues: [], usable: true } });
  await assessPhotoQuality('base64data', 'image/jpeg');
  const [, , options] = dispatchWithFallback.mock.calls[0];
  return options.validate;
}

describe('assessPhotoQuality dispatchWithFallback validate hook', () => {
  test('rejects an out-of-range sharpness/coverage/lighting (e.g. 900)', async () => {
    const validate = await capturedValidate();
    expect(validate({ json: { sharpness: 900, lawn_coverage_pct: 70, lighting: 60, usable: true } })).toBe('schema_invalid');
    expect(validate({ json: { sharpness: 80, lawn_coverage_pct: 900, lighting: 60, usable: true } })).toBe('schema_invalid');
    expect(validate({ json: { sharpness: 80, lawn_coverage_pct: 70, lighting: 900, usable: true } })).toBe('schema_invalid');
  });

  test('rejects a negative value', async () => {
    const validate = await capturedValidate();
    expect(validate({ json: { sharpness: -5, lawn_coverage_pct: 70, lighting: 60, usable: true } })).toBe('schema_invalid');
  });

  test('accepts a fractional in-range value (only the rounded score is stored)', async () => {
    const validate = await capturedValidate();
    expect(validate({ json: { sharpness: 80.5, lawn_coverage_pct: 70, lighting: 60, usable: true } })).toBeNull();
  });

  test('accepts the full in-range boundary (0 and 100)', async () => {
    const validate = await capturedValidate();
    expect(validate({ json: { sharpness: 0, lawn_coverage_pct: 100, lighting: 0, usable: true } })).toBeNull();
    expect(validate({ json: { sharpness: 100, lawn_coverage_pct: 0, lighting: 100, usable: false } })).toBeNull();
  });

  test('an out-of-range answer fails open (never wins is_best_photo on a bogus score)', async () => {
    dispatchWithFallback.mockResolvedValue({ ok: false, reason: 'schema_invalid' });
    const result = await assessPhotoQuality('base64data', 'image/jpeg');
    expect(result).toEqual({ passed: true, score: 50, issues: [] });
  });

  test('an in-range answer still scores and passes normally', async () => {
    dispatchWithFallback.mockResolvedValue({ ok: true, json: { sharpness: 80, lawn_coverage_pct: 70, lighting: 60, issues: [], usable: true } });
    const result = await assessPhotoQuality('base64data', 'image/jpeg');
    expect(result.passed).toBe(true);
    expect(result.score).toBe(Math.round(80 * 0.4 + 70 * 0.35 + 60 * 0.25));
  });
});
