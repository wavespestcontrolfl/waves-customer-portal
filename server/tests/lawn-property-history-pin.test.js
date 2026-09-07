const { signAssessmentPin, verifyAssessmentPin, assessmentPinHistory } = require('../services/service-report/assessment-pin');
const { serviceReportViewerUrl } = require('../services/service-report/pdf-puppeteer');

describe('history fingerprint through the existing signed assessment transport', () => {
  const previous = process.env.REPORT_PIN_SECRET;
  const history = 'a'.repeat(40);
  beforeAll(() => { process.env.REPORT_PIN_SECRET = 'fixture-only-history-pin-secret'; });
  afterAll(() => {
    if (previous === undefined) delete process.env.REPORT_PIN_SECRET;
    else process.env.REPORT_PIN_SECRET = previous;
  });

  test('history, report, assessment, expiry and week plan are authenticated together', () => {
    const pin = signAssessmentPin('token-a', 'assessment-a', { history, plan: 'none', nowSeconds: 100 });
    expect(assessmentPinHistory(pin.signature)).toBe(history);
    const verify = (signature = pin.signature, token = 'token-a', plan = 'none') => verifyAssessmentPin(token, 'assessment-a', signature, pin.expiresAt, { nowSeconds: 101, plan });
    expect(verify()).toBe(true);
    expect(verify(pin.signature.replace(history, 'b'.repeat(40)))).toBe(false);
    expect(verify(pin.signature.split('.')[2])).toBe(false);
    expect(verify(pin.signature, 'token-b')).toBe(false);
    expect(verify(pin.signature, 'token-a', '')).toBe(false);
    expect(verifyAssessmentPin('token-a', 'assessment-a', pin.signature, pin.expiresAt, { nowSeconds: pin.expiresAt, plan: 'none' })).toBe(false);
  });

  test('old signatures still verify and require no history', () => {
    const pin = signAssessmentPin('token-a', 'assessment-a', { nowSeconds: 100 });
    expect(pin.signature).toMatch(/^[a-f0-9]{64}$/);
    expect(assessmentPinHistory(pin.signature)).toBeNull();
    expect(verifyAssessmentPin('token-a', 'assessment-a', pin.signature, pin.expiresAt, { nowSeconds: 101 })).toBe(true);
  });

  test('the browser URL needs no new client-forwarded parameter', () => {
    const url = new URL(serviceReportViewerUrl('token-a', null, 'pdf', { pinnedLawnAssessmentId: 'assessment-a', pinnedLawnHistoryIdentity: history }));
    expect([...url.searchParams.keys()].sort()).toEqual(['aexp', 'asig', 'assessment', 'mode']);
    expect(assessmentPinHistory(url.searchParams.get('asig'))).toBe(history);
    expect(verifyAssessmentPin('token-a', 'assessment-a', url.searchParams.get('asig'), url.searchParams.get('aexp'))).toBe(true);
  });
});
