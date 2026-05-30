const {
  applySensitiveSpaHeaders,
  isServiceOutlinePath,
} = require('../utils/sensitive-spa-headers');

const VALID_TOKEN = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

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
});
