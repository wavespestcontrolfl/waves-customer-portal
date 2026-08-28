/**
 * Assessment pin + week-plan identity: the plan rides inside the signature;
 * a pin WITHOUT a plan keeps the original payload so pins minted by the
 * previous version still verify during a rolling deploy.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
const crypto = require('crypto');
const { signAssessmentPin, verifyAssessmentPin } = require('../services/service-report/assessment-pin');

describe('assessment pin with a week-plan identity', () => {
  const token = 'tok-123';
  const assessment = '11111111-1111-4111-8111-111111111111';

  test('plan-less pins use the ORIGINAL payload and verify without a plan', () => {
    const s = signAssessmentPin(token, assessment, { nowSeconds: 1000 });
    expect(verifyAssessmentPin(token, assessment, s.signature, s.expiresAt, { nowSeconds: 1500 })).toBe(true);
    expect(verifyAssessmentPin(token, assessment, s.signature, s.expiresAt, { nowSeconds: 1500, plan: '' })).toBe(true);
    // Legacy signature shape: HMAC over token:assessment:exp (no trailing plan segment).
    const key = crypto.createHmac('sha256', process.env.REPORT_PIN_SECRET || process.env.JWT_SECRET).update('waves:report-assessment-pin:v1').digest();
    const legacy = crypto.createHmac('sha256', key).update(`${token}:${assessment}:${s.expiresAt}`).digest('hex');
    expect(s.signature).toBe(legacy);
  });

  test('a plan pin is part of the signature: tampering the plan fails verification', () => {
    const s = signAssessmentPin(token, assessment, { nowSeconds: 1000, plan: '2026-08-24T12:00:00.000Z' });
    expect(verifyAssessmentPin(token, assessment, s.signature, s.expiresAt, { nowSeconds: 1500, plan: '2026-08-24T12:00:00.000Z' })).toBe(true);
    expect(verifyAssessmentPin(token, assessment, s.signature, s.expiresAt, { nowSeconds: 1500, plan: 'none' })).toBe(false);
    expect(verifyAssessmentPin(token, assessment, s.signature, s.expiresAt, { nowSeconds: 1500 })).toBe(false);
  });
});
