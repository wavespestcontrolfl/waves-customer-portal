const {
  applySensitiveSpaHeaders,
  isServiceOutlinePath,
  isLawnReportPath,
  isServiceReportPath,
} = require('../utils/sensitive-spa-headers');

const VALID_TOKEN = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const LAWN_TOKEN = '0123456789abcdef0123456789abcdef';
const REPORT_TOKEN = '0123456789abcdef0123456789abcdef';

function mockResponse() {
  return { set: jest.fn() };
}

describe('sensitive SPA document headers', () => {
  test('marks service outline token pages noindex and no-referrer', () => {
    const res = mockResponse();

    applySensitiveSpaHeaders(`/service-outlines/${VALID_TOKEN}`, res);

    expect(res.set).toHaveBeenCalledWith('X-Robots-Tag', 'noindex, nofollow, noarchive');
    expect(res.set).toHaveBeenCalledWith('Referrer-Policy', 'no-referrer');
  });

  test('does not apply service outline privacy headers to unrelated SPA pages', () => {
    const res = mockResponse();

    applySensitiveSpaHeaders('/estimate/abc123', res);

    expect(res.set).not.toHaveBeenCalled();
  });

  test('recognizes only full service outline token document paths', () => {
    expect(isServiceOutlinePath(`/service-outlines/${VALID_TOKEN}`)).toBe(true);
    expect(isServiceOutlinePath(`/service-outlines/${VALID_TOKEN}/`)).toBe(true);
    expect(isServiceOutlinePath('/service-outlines/not-a-real-token')).toBe(false);
    expect(isServiceOutlinePath('/api/service-outlines/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBe(false);
  });

  test('marks lawn-report token pages noindex, no-referrer, and no-store', () => {
    const res = mockResponse();

    applySensitiveSpaHeaders(`/lawn-report/${LAWN_TOKEN}`, res);

    expect(res.set).toHaveBeenCalledWith('X-Robots-Tag', 'noindex, nofollow, noarchive');
    expect(res.set).toHaveBeenCalledWith('Referrer-Policy', 'no-referrer');
    expect(res.set).toHaveBeenCalledWith('Cache-Control', 'no-store');
  });

  test('recognizes only full lawn-report 32-hex token document paths', () => {
    expect(isLawnReportPath(`/lawn-report/${LAWN_TOKEN}`)).toBe(true);
    expect(isLawnReportPath(`/lawn-report/${LAWN_TOKEN}/`)).toBe(true);
    expect(isLawnReportPath('/lawn-report/not-a-real-token')).toBe(false);
    expect(isLawnReportPath('/api/public/lawn-diagnostic/0123456789abcdef0123456789abcdef')).toBe(false);
  });

  test('marks customer + project post-service report shells noindex, no-referrer, no-store', () => {
    for (const reportPath of [`/report/${REPORT_TOKEN}`, '/report/project/van-lee-0123456789ab']) {
      const res = mockResponse();
      applySensitiveSpaHeaders(reportPath, res);
      expect(res.set).toHaveBeenCalledWith('X-Robots-Tag', 'noindex, nofollow, noarchive');
      expect(res.set).toHaveBeenCalledWith('Referrer-Policy', 'no-referrer');
      expect(res.set).toHaveBeenCalledWith('Cache-Control', 'no-store');
    }
  });

  test('recognizes the post-service report shells but not the API or unrelated paths', () => {
    expect(isServiceReportPath(`/report/${REPORT_TOKEN}`)).toBe(true);
    expect(isServiceReportPath(`/report/${REPORT_TOKEN}/`)).toBe(true);
    expect(isServiceReportPath('/report/project/van-lee-0123456789ab')).toBe(true);
    expect(isServiceReportPath('/report/project/van-lee-2-0123456789ab')).toBe(true);
    expect(isServiceReportPath('/report/not-a-real-token')).toBe(false);
    expect(isServiceReportPath('/api/reports/0123456789abcdef0123456789abcdef')).toBe(false);
    expect(isServiceReportPath('/reports')).toBe(false);
  });
});
